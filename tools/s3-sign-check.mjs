// Is the signature right?
//
//   node tools/s3-sign-check.mjs
//
// This is the highest-value check in the S3 change and the cheapest to run,
// because of how a wrong signature FAILS. The bucket rejects it with
// SignatureDoesNotMatch — and the browser, having been refused a cross-origin
// response, hands the app an opaque TypeError with no status and no body. From
// inside Recall a bad signer is indistinguishable from a missing CORS policy,
// a typo in the endpoint, or a dead network. The only place the truth is
// legible is here, before a browser is involved at all.
//
// Two independent ways of being sure, because they fail differently:
//
//   • THE PUBLISHED VECTOR. AWS documents a complete presigned GET — fixed
//     key, fixed secret, fixed timestamp, and the exact signature it must
//     produce. Reproducing that string proves the whole chain (canonical
//     request, string to sign, four-step key derivation) against an authority
//     outside this repo. A vector cannot drift; if this line ever changes,
//     the signer broke.
//   • AN INDEPENDENT IMPLEMENTATION. The vector covers one simple key with no
//     awkward characters. The cases that actually bite — a paper filed under
//     an author's apostrophe, a space, an accent, a nested key, extra query
//     parameters needing to sort among the X-Amz-* ones — have no published
//     answer. So they are computed a second time here using node:crypto's
//     createHmac and createHash, written from the specification rather than
//     from src/cloud/s3-sign.js, and the two must agree. Sharing no code with
//     the module under test is the entire point: a mistake would have to be
//     made twice, in two different styles, to pass.
//
// ── Why plain Node ───────────────────────────────────────────────────────
//
// s3-sign.js imports nothing — no app modules, no DOM, no `?v=__BUILD__`
// stamp — precisely so this check needs no staging directory and no stub
// browser. It runs the real file. Node 18+ provides globalThis.crypto.subtle,
// which is the only thing the module asks of its host.

import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { presignRequest, presignS3Url, s3UriEncode, canonicalQuery, amzDates } =
  await import(pathToFileURL(path.join(ROOT, "src/cloud/s3-sign.js")).href);

const results = [];
let failures = 0;

async function must(name, fn) {
  let detail;
  try {
    detail = await fn();
  } catch (error) {
    detail = `threw: ${error?.message || error}`;
  }
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

function signatureOf(url) {
  return new URL(url).searchParams.get("X-Amz-Signature") || "";
}

// ── The independent implementation ────────────────────────────────────────
//
// Written from the SigV4 specification against node:crypto. It shares not one
// line with the module under test, which is what makes an agreement between
// them evidence rather than a tautology.
function referenceEncode(value, encodeSlash = true) {
  let out = "";
  for (const byte of Buffer.from(String(value), "utf8")) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char)) out += char;
    else if (char === "/" && !encodeSlash) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function referencePresign({ origin, path: resource, method, region, accessKeyId, secretAccessKey, expiresIn, query, now }) {
  const host = new URL(origin).host;
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const pairs = Object.entries({
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host"
  }).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [referenceEncode(k), referenceEncode(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const search = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalUri = referenceEncode(resource, false);
  const canonical = `${method}\n${canonicalUri}\n${search}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  let key = createHmac("sha256", `AWS4${secretAccessKey}`).update(dateStamp).digest();
  key = createHmac("sha256", key).update(region).digest();
  key = createHmac("sha256", key).update("s3").digest();
  key = createHmac("sha256", key).update("aws4_request").digest();
  return createHmac("sha256", key).update(stringToSign).digest("hex");
}

// ── The published vector ──────────────────────────────────────────────────
//
// From AWS's "Authenticating Requests: Using Query Parameters" worked example:
// a presigned GET of test.txt in examplebucket, valid for 24 hours, signed at
// midnight on 24 May 2013 in us-east-1. Virtual-hosted style — the bucket is
// in the hostname — which is why presignRequest takes a host and a path
// instead of building one from a config: the vector drives the very same code
// the app does, rather than a sibling of it.
const VECTOR = {
  origin: "https://examplebucket.s3.amazonaws.com",
  path: "/test.txt",
  method: "GET",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  expiresIn: 86400,
  now: new Date("2013-05-24T00:00:00Z")
};
const VECTOR_SIGNATURE = "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";

await must("AWS's published presigned-GET vector reproduces exactly", async () => {
  const url = await presignRequest(VECTOR);
  const got = signatureOf(url);
  return got === VECTOR_SIGNATURE || `expected ${VECTOR_SIGNATURE}, got ${got}`;
});

await must("the vector's URL carries every parameter the server recomputes over", async () => {
  const params = new URL(await presignRequest(VECTOR)).searchParams;
  const wanted = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    "X-Amz-Date": "20130524T000000Z",
    "X-Amz-Expires": "86400",
    "X-Amz-SignedHeaders": "host"
  };
  for (const [key, value] of Object.entries(wanted)) {
    if (params.get(key) !== value) return `${key} was ${params.get(key)}, expected ${value}`;
  }
  return true;
});

// ── The cases with no published answer ────────────────────────────────────
//
// Every one of these is a key or a query a real library produces, and every
// one of them encodes differently from the last. They are checked against the
// reference implementation above rather than against a string pasted from a
// previous run, so a change in behaviour shows up as a disagreement instead of
// quietly rewriting its own expectation.
const AWKWARD = [
  ["a plain nested key", "/papers/recall/abc123/deadbeef.pdf", {}],
  ["an apostrophe", "/papers/O'Neill's review.pdf", {}],
  ["a space", "/papers/two words.pdf", {}],
  ["the characters encodeURIComponent leaves alone", "/papers/!'()*.pdf", {}],
  ["an accent", "/papers/Ampère.pdf", {}],
  ["a plus and an equals", "/papers/a+b=c.pdf", {}],
  ["a listing, whose parameters sort among the X-Amz ones", "/bucket", { "list-type": "2", prefix: "recall/", "max-keys": "1000" }],
  ["a continuation token carrying slashes and padding", "/bucket", { "list-type": "2", "continuation-token": "1/abc+def==" }],
  ["an empty parameter, which must be dropped from both", "/bucket", { "list-type": "2", prefix: "" }]
];

for (const [label, resource, query] of AWKWARD) {
  await must(`independent agreement — ${label}`, async () => {
    const args = {
      origin: "https://abc123.r2.cloudflarestorage.com",
      path: resource,
      method: "GET",
      region: "auto",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresIn: 900,
      query,
      now: new Date("2026-09-19T12:34:56Z")
    };
    const mine = signatureOf(await presignRequest(args));
    const theirs = referencePresign(args);
    return mine === theirs || `module ${mine} ≠ reference ${theirs}`;
  });
}

await must("every method signs differently", async () => {
  const base = { ...VECTOR, expiresIn: 900 };
  const seen = new Map();
  for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
    const signature = signatureOf(await presignRequest({ ...base, method }));
    if (seen.has(signature)) return `${method} signed the same as ${seen.get(signature)}`;
    if (signature !== referencePresign({ ...base, method, query: {} })) return `${method} disagreed with the reference`;
    seen.set(signature, method);
  }
  return true;
});

// ── The encoder, on its own ───────────────────────────────────────────────
await must("s3UriEncode encodes what encodeURIComponent does not", () => {
  const got = s3UriEncode("!'()*");
  return got === "%21%27%28%29%2A" || `got ${got}`;
});

await must("s3UriEncode leaves the unreserved set alone", () => {
  const unreserved = "AZaz09-_.~";
  return s3UriEncode(unreserved) === unreserved || `got ${s3UriEncode(unreserved)}`;
});

await must("s3UriEncode uses uppercase hex", () => {
  const got = s3UriEncode(" ");
  return got === "%20" || `got ${got}`;
});

await must("a path's separators survive, its contents do not", () => {
  const got = s3UriEncode("/recall/a b/c.pdf", { encodeSlash: false });
  return got === "/recall/a%20b/c.pdf" || `got ${got}`;
});

await must("a key containing a slash is encoded when it is a value, not a path", () => {
  const got = s3UriEncode("1/abc");
  return got === "1%2Fabc" || `got ${got}`;
});

await must("canonicalQuery sorts by the encoded key", () => {
  const got = canonicalQuery({ b: "2", a: "1", "X-Amz-Date": "z" });
  return got === "X-Amz-Date=z&a=1&b=2" || `got ${got}`;
});

await must("canonicalQuery drops empty values rather than signing them", () => {
  return canonicalQuery({ a: "1", b: "", c: null, d: undefined }) === "a=1" || "an empty value was signed";
});

await must("amzDates produces the two formats SigV4 accepts", () => {
  const { amzDate, dateStamp } = amzDates(new Date("2026-09-19T12:34:56.789Z"));
  if (amzDate !== "20260919T123456Z") return `amzDate was ${amzDate}`;
  return dateStamp === "20260919" || `dateStamp was ${dateStamp}`;
});

// ── The config-shaped wrapper ─────────────────────────────────────────────
await must("presignS3Url puts the bucket in the path, not the hostname", async () => {
  const url = await presignS3Url(
    {
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "recall-papers",
      region: "auto",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    },
    { method: "PUT", key: "recall/abc/def.pdf", now: new Date("2026-09-19T00:00:00Z") }
  );
  const parsed = new URL(url);
  if (parsed.host !== "abc123.r2.cloudflarestorage.com") return `host was ${parsed.host}`;
  return parsed.pathname === "/recall-papers/recall/abc/def.pdf" || `path was ${parsed.pathname}`;
});

await must("a bucket-level URL omits the trailing slash a key would add", async () => {
  const url = await presignS3Url(
    {
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "recall-papers",
      region: "auto",
      accessKeyId: "AKIA",
      secretAccessKey: "secret"
    },
    { query: { "list-type": "2" }, now: new Date("2026-09-19T00:00:00Z") }
  );
  return new URL(url).pathname === "/recall-papers" || `path was ${new URL(url).pathname}`;
});

// ── The host it cannot run on ─────────────────────────────────────────────
//
// A page served over plain http has no crypto.subtle, and the failure must be
// its own named condition rather than a TypeError from inside the signer —
// storage-panel.js tells the reader "needs https" on the strength of this flag.
await must("no crypto.subtle is reported as its own condition", async () => {
  // Node defines globalThis.crypto as a getter, so it is swapped by
  // redefining the property rather than by assigning to it — the plain
  // assignment throws, which would pass this check for the wrong reason.
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true, writable: true });
  try {
    await presignRequest(VECTOR);
    return "it signed without crypto.subtle";
  } catch (error) {
    return error?.insecureContext === true || `threw ${error?.message} without the flag`;
  } finally {
    Object.defineProperty(globalThis, "crypto", real);
  }
});

console.log("── s3 signing ──");
for (const [ok, name, detail] of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
// The shape tools/check.mjs reads a result off — see its footer. Anything else
// is reported as "no result line" however many assertions passed.
console.log(`\n  ${results.length} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
