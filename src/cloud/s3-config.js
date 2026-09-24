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
// "Once" means once per ACCOUNT now, not once per device. The values used to
// stay in the localStorage of whichever device they were typed into, so a
// phone that had never been given them read every paper as missing — the
// upload had worked, the bucket was full of papers, and the second device
// simply had no way to ask for them. They now ride the reader's own Supabase
// row as well (src/cloud/s3-config-sync.js); this module is still the only
// place a request reads them from, so signing never waits on the network.
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
//
// Syncing it widens who can read it by exactly one party: whoever administers
// the Supabase project. For the usual install that is the reader themselves.
// Row Level Security keeps every other account's session away from the row.

export const S3_CONFIG_STORAGE_KEY = "recall:s3Config";

// Written when the reader presses Forget, and read by the sync: a key that is
// simply absent cannot tell "never set up here" from "deliberately removed",
// and only the second should clear the other devices. Without it, the next
// device to sync would find an empty account and helpfully push its own copy
// straight back up.
export const S3_FORGOTTEN_STORAGE_KEY = "recall:s3ConfigForgotten";

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

// The five values a signature is made from, cleaned, and nothing else. The
// bookkeeping the sync keeps beside them (when, whose, tested or not) never
// reaches the signer or the cloud row.
export function cleanS3Config(value) {
  return {
    endpoint: cleanEndpoint(value?.endpoint),
    bucket: cleanBucket(value?.bucket),
    region: String(value?.region || "").trim() || S3_DEFAULT_REGION,
    accessKeyId: String(value?.accessKeyId || "").trim(),
    secretAccessKey: String(value?.secretAccessKey || "").trim()
  };
}

function readStoredJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function loadS3Config() {
  const parsed = readStoredJson(S3_CONFIG_STORAGE_KEY);
  if (!parsed) return null;
  const config = cleanS3Config(parsed);
  return isCompleteS3Config(config) ? config : null;
}

function isoMs(value) {
  const ms = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

// Everything the sync needs to decide which side is newer, in one read.
//
//   config       the usable credential, or null
//   updatedAt    when it was saved or adopted, in ms — 0 for a record written
//                before any of this existed, which loses to any cloud row
//   ownerId      the account it was saved under ("" if nobody was signed in)
//   verified     true once Save and test passed, false while it has not, and
//                null for a legacy record nobody can vouch for either way
//   forgottenAt  when Forget was pressed here, in ms, or 0
export function readS3ConfigRecord() {
  const stored = readStoredJson(S3_CONFIG_STORAGE_KEY);
  const forgotten = readStoredJson(S3_FORGOTTEN_STORAGE_KEY);
  const config = stored ? cleanS3Config(stored) : null;
  return {
    config: config && isCompleteS3Config(config) ? config : null,
    updatedAt: isoMs(stored?.updatedAt),
    ownerId: String(stored?.ownerId || forgotten?.ownerId || ""),
    verified: typeof stored?.verified === "boolean" ? stored.verified : null,
    forgottenAt: isoMs(forgotten?.at)
  };
}

// All four or nothing. A partially filled record is not a usable credential and
// pretending otherwise only moves the failure to the first upload, where it
// costs the reader an import instead of a form.
export function isCompleteS3Config(config) {
  return Boolean(config?.endpoint && config?.bucket && config?.accessKeyId && config?.secretAccessKey);
}

// `verified` starts false for a typed-in config and is set by
// markS3ConfigVerified once the connection test passes: the sync refuses to
// publish an untested one, so a typo made on one device cannot break the
// others. A config adopted FROM the cloud arrives verified, because it was
// only ever pushed after passing.
export function saveS3Config(values, { updatedAt = Date.now(), ownerId = "", verified = false } = {}) {
  const config = cleanS3Config(values);
  localStorage.setItem(S3_CONFIG_STORAGE_KEY, JSON.stringify({
    ...config,
    updatedAt: new Date(isoMs(updatedAt) || Date.now()).toISOString(),
    ownerId: String(ownerId || ""),
    verified: Boolean(verified)
  }));
  // A save supersedes an earlier Forget on this device.
  try { localStorage.removeItem(S3_FORGOTTEN_STORAGE_KEY); } catch { /* nothing to clear */ }
  return config;
}

// Leaves `updatedAt` alone: passing the test does not make the values any
// newer, it only makes them fit to publish. `verified` false records a test
// that FAILED, for a legacy record the sync had to test for itself.
export function markS3ConfigVerified(ownerId = "", verified = true) {
  const stored = readStoredJson(S3_CONFIG_STORAGE_KEY);
  if (!stored) return;
  localStorage.setItem(S3_CONFIG_STORAGE_KEY, JSON.stringify({
    ...stored,
    ownerId: String(ownerId || stored.ownerId || ""),
    verified: Boolean(verified)
  }));
}

// Stamps the account a legacy or signed-out config belongs to, once the sync
// has claimed it, so a different account signing in later on this device can
// tell the credential is not theirs to publish.
export function setS3ConfigOwner(ownerId) {
  const stored = readStoredJson(S3_CONFIG_STORAGE_KEY);
  if (!stored || !ownerId) return;
  localStorage.setItem(S3_CONFIG_STORAGE_KEY, JSON.stringify({ ...stored, ownerId: String(ownerId) }));
}

// Forget. With `tombstone` (the default, and what the panel's button means)
// the removal is remembered so the sync can carry it to every other device;
// without, the keys are simply dropped from this one — what the sync does when
// the account says they were forgotten elsewhere, or belong to somebody else.
export function clearS3Config({ at = Date.now(), ownerId = "", tombstone = true } = {}) {
  const previousOwner = readStoredJson(S3_CONFIG_STORAGE_KEY)?.ownerId || "";
  localStorage.removeItem(S3_CONFIG_STORAGE_KEY);
  try {
    if (tombstone) {
      localStorage.setItem(S3_FORGOTTEN_STORAGE_KEY, JSON.stringify({
        at: new Date(isoMs(at) || Date.now()).toISOString(),
        ownerId: String(ownerId || previousOwner || "")
      }));
    } else {
      localStorage.removeItem(S3_FORGOTTEN_STORAGE_KEY);
    }
  } catch { /* storage full — the keys themselves are gone either way */ }
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
