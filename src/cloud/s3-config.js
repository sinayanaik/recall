// Where the reader's own S3-compatible bucket is configured.
//
// ── Why the papers moved off Google Drive ──────────────────────────────────
//
// Drive was chosen because an OAuth Client ID is public by design, and that
// reasoning still holds. What it did not survive was contact with the consent
// screen. A Google Cloud project starts in "Testing" publishing status, which
// admits only a hand-listed set of testers and turns every other reader away
// with "has not completed the Google verification process" — Error 403,
// access_denied — and the fix for that is a Cloud Console setting nobody can
// reach from inside this app.
//
// Publishing the project clears it. But even a published app still needs a
// Google session and a consent popup, and the silent re-auth that was supposed
// to make the popup a once-ever event (prompt: "none") depends on third-party
// cookies, which Safari, Firefox in strict mode and every private window
// refuse. So the popup comes back, per session, for ever. A reader opening a
// paper should not be negotiating with an identity provider.
//
// An S3-compatible bucket has no session and no consent screen. The reader
// pastes four values once, and every request after that is signed locally from
// those values — offline-capable, popup-free, and identical on every device
// that holds them. Cloudflare R2 gives 10GB and charges nothing for egress;
// Backblaze B2 and anything else speaking S3 work the same way.
//
// ── The part Drive was right about, and this gives up ──────────────────────
//
// drive-client.js said it plainly: a service-account key or an API secret
// sitting in localStorage on a static site "is the one thing this app has never
// asked anybody to do". This asks it. That is a real cost and it is not worth
// dressing up — so the panel says so, and the README's setup tells the reader
// to mint a token scoped to ONE bucket with Object Read & Write and nothing
// else. Scoped that way the worst a leaked key reaches is the papers it was
// minted for, which is the same blast radius drive.file had.
//
// What it buys back is that there is no bearer token to expire, no popup to
// block, no verification queue, and nothing to renew. The credential is as
// durable as the reader's own notes.

export const S3_CONFIG_STORAGE_KEY = "recall:s3Config";

// R2 ignores the region but still requires one in the signature; "auto" is what
// Cloudflare's own tooling sends. B2 wants its real one (us-west-004 and
// friends), so it stays a field rather than a constant.
export const S3_DEFAULT_REGION = "auto";

// Presigned URLs are minted per request and used immediately. Fifteen minutes
// is not for the reader's benefit — it covers a slow upload whose URL was
// signed before the bytes started moving, and matches UPLOAD_TIMEOUT_MS in
// pdf-store.js so that a signature never expires mid-transfer.
export const S3_URL_TTL_SECONDS = 15 * 60;

function cleanEndpoint(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  // A reader pastes what the dashboard shows them, which may or may not carry a
  // scheme and may well carry the bucket on the end. Both are recoverable here;
  // neither is recoverable once it is inside a signature, because a bad host
  // fails as an opaque CORS error with nothing in it to read.
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

// A bucket name, not a path. The leading and trailing slashes a dashboard
// copy-paste tends to bring are stripped rather than signed.
function cleanBucket(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

export function loadS3Config() {
  try {
    const raw = localStorage.getItem(S3_CONFIG_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed) return null;
    const config = {
      endpoint: cleanEndpoint(parsed.endpoint),
      bucket: cleanBucket(parsed.bucket),
      region: String(parsed.region || "").trim() || S3_DEFAULT_REGION,
      accessKeyId: String(parsed.accessKeyId || "").trim(),
      secretAccessKey: String(parsed.secretAccessKey || "").trim()
    };
    return isCompleteS3Config(config) ? config : null;
  } catch {
    return null;
  }
}

// All four or nothing. A partially filled record is not a usable credential and
// pretending otherwise only moves the failure to the first upload, where it
// costs the reader an import instead of a form.
export function isCompleteS3Config(config) {
  return Boolean(config?.endpoint && config?.bucket && config?.accessKeyId && config?.secretAccessKey);
}

export function saveS3Config({ endpoint, bucket, region, accessKeyId, secretAccessKey }) {
  const config = {
    endpoint: cleanEndpoint(endpoint),
    bucket: cleanBucket(bucket),
    region: String(region || "").trim() || S3_DEFAULT_REGION,
    accessKeyId: String(accessKeyId || "").trim(),
    secretAccessKey: String(secretAccessKey || "").trim()
  };
  localStorage.setItem(S3_CONFIG_STORAGE_KEY, JSON.stringify(config));
  return config;
}

export function clearS3Config() {
  localStorage.removeItem(S3_CONFIG_STORAGE_KEY);
}

export function isS3Configured() {
  return Boolean(loadS3Config());
}

// Signing needs HMAC-SHA256, which lives on crypto.subtle, which a page served
// over plain http does not have. sha256() in pdf-store.js already documents
// this hazard and degrades to "" for it; here there is nothing to degrade to,
// so it is reported as its own condition rather than as a broken bucket.
export function canSignS3Requests() {
  return Boolean(globalThis.crypto?.subtle);
}

// True when this device could actually reach the bucket right now. The same
// question canReachDrive() answered, minus the token — which is the entire
// point of the change.
export function canReachS3() {
  return isS3Configured() && canSignS3Requests();
}

// The CORS policy the bucket needs, pre-filled with wherever this copy of
// Recall is served from.
//
// This cannot be applied from here, and the chicken-and-egg is worth stating
// once: PutBucketCors is itself an S3 call, so the browser would have to make a
// cross-origin request to install the very policy that would allow it. It is
// refused before it is sent. The reader pastes this into the bucket's dashboard
// once, and the connection test below knows how to recognise its absence.
export function s3CorsPolicy(origin = globalThis.location?.origin || "") {
  return [{
    AllowedOrigins: [origin],
    AllowedMethods: ["GET", "PUT", "DELETE", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600
  }];
}
