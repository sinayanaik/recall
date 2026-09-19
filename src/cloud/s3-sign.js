// AWS Signature Version 4, as much of it as a browser needs to talk to a
// bucket. No imports, no network, no app state — everything here is a pure
// function of its arguments and the clock, which is what makes it testable
// against AWS's own published vectors in tools/s3-sign-check.mjs.
//
// ── Why the signature goes in the QUERY STRING ─────────────────────────────
//
// SigV4 can be carried either in an Authorization header or presigned into the
// URL. The header form is the one every server-side SDK uses and it is the
// wrong one here, for a reason that has nothing to do with cryptography:
//
// A request carrying Authorization and x-amz-content-sha256 is never a simple
// CORS request. The browser sends OPTIONS first and will not send the real
// request until the bucket answers it allowing both header names. A presigned
// URL signs only `host`, so a GET carries no custom headers at all — and a GET
// with no custom headers IS a simple request, with no preflight, one round trip
// instead of two, on the path that runs every time a paper is opened.
//
// PUT and DELETE still preflight, because the method alone is enough to require
// it; nothing can be done about that and the bucket's CORS policy covers it.
// But reads — the common case, the one the reader waits on — go direct.
//
// The second reason is UNSIGNED-PAYLOAD. Header-form SigV4 wants a SHA-256 of
// the body in the canonical request, so uploading a 100MB paper would mean
// hashing 100MB before a single byte moved. Presigning declares the payload
// unsigned by construction. The transport is still TLS; what is given up is
// proof that the body was not altered in flight, which TLS was already
// providing.

export const S3_ALGORITHM = "AWS4-HMAC-SHA256";

const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

function sigBytes(text) {
  return new TextEncoder().encode(text);
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", sigBytes(text)));
}

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : sigBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, sigBytes(message)));
}

// AWS's encoding rule, which is NOT encodeURIComponent.
//
// The unreserved set is exactly A-Z a-z 0-9 - _ . ~ and everything else is
// percent-encoded with UPPERCASE hex. encodeURIComponent agrees on most of it
// but leaves !'()* alone, and a key containing an apostrophe — a paper filed
// under its author's name, say — would then be signed one way and requested
// another, producing a SignatureDoesNotMatch that is impossible to read back
// from the error.
export function s3UriEncode(value, { encodeSlash = true } = {}) {
  return String(value).replace(/[^A-Za-z0-9\-_.~]/g, (char) => {
    if (char === "/" && !encodeSlash) return char;
    return Array.from(sigBytes(char), (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  });
}

// Sorted by the ENCODED key, then the encoded value, because that is the order
// the signature is computed over and the order the server will recompute it in.
export function canonicalQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [s3UriEncode(key), s3UriEncode(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

// YYYYMMDDTHHMMSSZ and its YYYYMMDD prefix, which are the only two time formats
// SigV4 speaks.
export function amzDates(now = new Date()) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

// AWS4<secret> → date → region → service → aws4_request. Four chained HMACs,
// each keyed by the output of the last, so the final key is usable only for one
// day, one region and one service.
export async function signingKey({ secretAccessKey, dateStamp, region, service }) {
  const dateKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

// The general form, taking a host and an already-built path. Kept separate from
// presignS3Url below so that the AWS test vectors — which are virtual-hosted
// style, where this app is path-style — can drive exactly this code rather than
// a re-implementation of it that might agree with the vector and disagree with
// the bucket.
export async function presignRequest({
  origin,
  path,
  method = "GET",
  region,
  service = "s3",
  accessKeyId,
  secretAccessKey,
  expiresIn = 900,
  query = {},
  now = new Date()
}) {
  if (!crypto?.subtle) throw Object.assign(new Error("NO_SUBTLE_CRYPTO"), { insecureContext: true });
  const { host } = new URL(origin);
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  // The caller's own query parameters (list-type, prefix, …) are signed
  // alongside the X-Amz-* ones. Omitting them would sign a different request
  // from the one sent, which the server notices.
  const params = {
    ...query,
    "X-Amz-Algorithm": S3_ALGORITHM,
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.floor(expiresIn))),
    "X-Amz-SignedHeaders": "host"
  };
  const search = canonicalQuery(params);

  // The path is encoded per SEGMENT: the slashes that separate a key's folders
  // are structure and stay, everything inside them is data and is encoded.
  const canonicalUri = s3UriEncode(path, { encodeSlash: false });
  const canonicalRequest = [
    method,
    canonicalUri,
    search,
    `host:${host}\n`,
    "host",
    UNSIGNED_PAYLOAD
  ].join("\n");

  const stringToSign = [S3_ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const key = await signingKey({ secretAccessKey, dateStamp, region, service });
  const signature = toHex(await hmac(key, stringToSign));

  return `${origin}${canonicalUri}?${search}&X-Amz-Signature=${signature}`;
}

// Path-style, which is what an account-level endpoint wants: the reader pastes
// https://<account>.r2.cloudflarestorage.com and the bucket is the first
// segment. Virtual-hosted style would need the bucket folded into the hostname,
// which a pasted endpoint cannot be relied on to have.
export function presignS3Url(config, { method = "GET", key = "", query = {}, expiresIn = 900, now = new Date() } = {}) {
  return presignRequest({
    origin: config.endpoint,
    path: key ? `/${config.bucket}/${key}` : `/${config.bucket}`,
    method,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expiresIn,
    query,
    now
  });
}
