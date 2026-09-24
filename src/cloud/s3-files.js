// The six things this app does to a paper in the reader's bucket.
//
// Everything goes through s3Fetch, which is the only place a presigned URL and
// the network meet. That is partly tidiness and mostly the test seam: CI has no
// network and no bucket, so every check that touches a paper replaces this one
// function — the same arrangement drive-files.js used and for the same reason.
//
// ── What this module promises its callers ──────────────────────────────────
//
// Unchanged from the Drive module, because the Document surface asking for it
// has not changed: a read that cannot be answered returns null, a list that
// cannot be read returns an empty array, and nothing here throws for a
// condition the app can carry on without — a reader whose device already holds
// the bytes must never see an error about a cloud they did not ask about.
// Uploads are the exception. An upload that failed has to say so, because the
// caller records the result and tells the reader the paper is on this device
// and nowhere else.
//
// ── What is simply gone, compared with Drive ───────────────────────────────
//
// • No folder. ensureDriveFolder searched by name on every cold call, because
//   a second device had never seen the id. A bucket has no folders; a key with
//   slashes in it is one string.
// • No resumable upload. Drive's multipart path tapped out at 5MB and the
//   resumable one needed a Location header that CORS often hid. S3 takes 5GB in
//   a single PUT, and MAX_DOCUMENT_BYTES is 100MB.
// • No metadata round trip. Drive stamped appProperties so a lost id could be
//   found again; here the content hash IS the key, so the question "is this
//   already uploaded?" is one HEAD rather than a query.
// • No 401 retry. There is no token to expire — see s3-config.js.

import {
  S3_URL_TTL_SECONDS, canReachS3, canSignS3Requests, loadS3Config
} from "./s3-config.js?v=__BUILD__";
import { CLOUD_LIST_TIMEOUT_MS, CLOUD_TIMEOUT_MS, withRetry, withTimeout } from "./net.js?v=__BUILD__";
import { presignS3Url } from "./s3-sign.js?v=__BUILD__";

// Objects are listed a thousand at a time, which is the S3 maximum and covers
// any realistic library in one round trip.
export const S3_LIST_PAGE = 1000;

// Everything Recall writes lives under one prefix, so a reader can point this
// at a bucket they already use for something else and still find their papers —
// and so the Storage panel can total them without counting anything else.
export const S3_PREFIX = "recall";

// ── The one door ────────────────────────────────────────────────────────────

// Named s3Transport rather than `transport` because drive-files.js already
// owns that name at top level, and tools/module-symbols.mjs resolves
// cross-module references by name — two modules declaring the same one makes
// every reference to it ambiguous.
let s3Transport = (url, init) => fetch(url, init);

export function setS3Transport(fn) {
  s3Transport = typeof fn === "function" ? fn : ((url, init) => fetch(url, init));
}

export function resetS3Transport() {
  s3Transport = (url, init) => fetch(url, init);
}

// A request against the bucket, signed for this one call.
//
// URLs are minted per request rather than cached. A presigned URL is a bearer
// credential for one object and one verb, and drive-client.js made the argument
// already: a signature is only safe because it expires, and that protection
// survives exactly as long as nobody writes it down. This one lives for the
// duration of a fetch.
export async function s3Fetch(method, key, { query = {}, body = null, headers = {} } = {}) {
  const config = loadS3Config();
  if (!config) throw Object.assign(new Error("NO_STORAGE"), { authFailed: true });
  if (!canSignS3Requests()) throw Object.assign(new Error("NO_STORAGE"), { authFailed: true, insecureContext: true });
  const url = await presignS3Url(config, { method, key, query, expiresIn: S3_URL_TTL_SECONDS });
  return s3Transport(url, { method, body, headers });
}

// Turns a refusal into an Error carrying the flags uploadDocument's retry loop
// reads (see pdf-store.js). A 403 is the interesting one: from a bucket it
// means the key is wrong or the token lacks the permission, and neither
// improves on the fourth attempt.
export async function s3Error(response, what) {
  let detail = "";
  try {
    // S3 errors are XML, and the useful part is one element. Parsing it
    // properly would mean a DOMParser for one string; the code is enough to
    // name the problem, and the message is what the reader is shown.
    const text = await response.text();
    detail = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || "";
  } catch {
    // A body that cannot be read tells us nothing the status did not.
  }
  const error = new Error(detail ? `${what} failed (${detail})` : `${what} failed (HTTP ${response.status})`);
  error.status = response.status;
  error.authFailed = response.status === 401 || response.status === 403;
  // A bucket that is full, or an account past its plan. Not a transient
  // refusal, and not worth three more attempts.
  error.quotaExceeded = /QuotaExceeded|EntityTooLarge|AccountProblem/i.test(detail);
  return error;
}

// A failed fetch, as opposed to a refused one.
//
// This is the error the reader is most likely to actually hit, and the one the
// browser is least helpful about. A cross-origin request the bucket has no CORS
// policy for is refused by the BROWSER, before the response is handed over, so
// the app sees a TypeError with no status, no body and no headers — literally
// indistinguishable from the network being down.
//
// The one thing that separates them is navigator.onLine. If the device believes
// it has a connection and the fetch still failed without ever producing a
// response, the policy is the overwhelmingly likely explanation, and saying so
// is far more use than "network error" to somebody who has just pasted four
// values and is wondering which one is wrong.
export function s3NetworkError(error, what) {
  const likelyCors = navigator.onLine !== false && error instanceof TypeError;
  const wrapped = new Error(likelyCors
    ? `${what} was blocked before it was sent — the bucket's CORS policy probably does not allow this site`
    : `${what} failed — ${error?.message || "no connection"}`);
  wrapped.corsLikely = likelyCors;
  wrapped.authFailed = likelyCors;
  return wrapped;
}

// ── Keys ────────────────────────────────────────────────────────────────────

// recall/<pdfId>/<sha256>.pdf
//
// Content-addressed, which buys three things at once. Re-uploading the same
// bytes overwrites the same object instead of making a second copy, so a retry
// or an interrupted migration costs storage nothing. "Has this already gone
// up?" becomes a HEAD on a key the caller can compute, with no index to consult
// and no query to get wrong. And a record whose sha256 has changed — a notebook
// regenerated, a paper replaced — names a different object by construction,
// which is the same test documentEntryMatches applies on the device.
//
// Scoped by pdfId rather than content alone so that a delete removes one
// record's copy. Two decks holding genuinely identical bytes keep one object
// each, which costs a duplicate and avoids "Remove from cloud" on one paper
// silently emptying another.
export function s3DocumentKey({ pdfId, sha256 }) {
  const id = String(pdfId || "").replace(/[^A-Za-z0-9_-]/g, "") || "unfiled";
  const hash = String(sha256 || "").replace(/[^a-f0-9]/gi, "");
  if (!hash) return "";
  return `${S3_PREFIX}/${id}/${hash}.pdf`;
}

// ── Write ───────────────────────────────────────────────────────────────────

// One PUT of any object. Returns nothing and throws if the bucket did not take
// it — every caller records the result somewhere, so a silent failure here
// would mean a record pointing at nothing.
//
// The headers are not signed — only `host` is — so the bucket stores them as
// the object's own metadata without them touching the signature. Content-Type
// is what makes a paper open as a PDF and a figure render as a picture if
// either is ever fetched directly; Cache-Control is what lets a browser keep an
// image whose key, like every key here, never names different bytes.
export async function putS3Object(key, body, { contentType = "application/octet-stream", cacheControl = "" } = {}) {
  const headers = { "Content-Type": contentType };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  let response;
  try {
    response = await s3Fetch("PUT", key, { body, headers });
  } catch (error) {
    if (error?.message === "NO_STORAGE") throw error;
    throw s3NetworkError(error, "The upload");
  }
  if (!response.ok) throw await s3Error(response, "The upload");
}

// One PUT. Returns the key it wrote, and throws if it did not — the caller
// records the result, so a silent failure here would mean a deck pointing at
// nothing.
export async function uploadS3File(file, { pdfId, sha256 }) {
  const key = s3DocumentKey({ pdfId, sha256 });
  // Without a hash there is no key, and a fabricated one would be an object
  // nothing could ever find again. pdf-store hashes before it uploads; this is
  // the guard for the path where crypto.subtle was missing and it could not.
  if (!key) throw Object.assign(new Error("NO_DOCUMENT_HASH"), { authFailed: true });
  await putS3Object(key, file, { contentType: "application/pdf" });
  return key;
}

// ── Read ────────────────────────────────────────────────────────────────────

// The bytes, or null. Null covers every reason a paper might not come back —
// nothing configured, deleted from the bucket by hand, offline, a key rotated —
// because the caller's next move is the same for all of them: use the device
// copy, and failing that ask the reader to re-attach the file.
//
// This is the request that carries no custom headers and so needs no preflight;
// see the header of s3-sign.js for why that shaped the whole signing choice.
export async function downloadS3File(key) {
  if (!key) return null;
  try {
    const response = await s3Fetch("GET", key);
    if (!response.ok) {
      if (response.status !== 404) console.warn("Could not download the document from the bucket", response.status);
      return null;
    }
    return await response.blob();
  } catch (error) {
    console.warn("Could not download the document from the bucket", error);
    return null;
  }
}

// Is this exact object already there? Replaces findDriveFileByProperties: the
// hash is in the key, so existence IS the proof, and a false answer costs one
// upload rather than a duplicate.
export async function headS3File(key) {
  if (!key) return false;
  try {
    const response = await s3Fetch("HEAD", key);
    return response.ok;
  } catch (error) {
    console.warn("Could not look for the document in the bucket", error);
    return false;
  }
}

// The object's size, as the bucket reports it — for the checks that come before
// anything is DELETED somewhere else. "Is it there" is not enough for those:
// a PUT cut short can leave an object that exists and is not the file, and the
// whole point of the check is that the copy about to become the only copy is
// the complete one.
//
// Three answers, and they are kept apart on purpose:
//   { exists: true,  size, answered: true }   the bucket says so
//   { exists: false, answered: true }         the bucket says it is not there
//   { exists: false, answered: false }        nobody could ask (offline, CORS,
//                                             a refusal) — which is NOT "absent"
// A caller deciding whether to delete a second copy treats the last as "no".
//
// Content-Length is a CORS-safelisted response header, so a HEAD from the page
// can read it without the bucket exposing anything. A provider that answers a
// HEAD without it gets asked once more through a listing, whose <Size> is the
// same number from the bucket's own index.
export async function statS3File(key) {
  if (!key) return { exists: false, size: 0, answered: true };
  let response;
  try {
    response = await withRetry(
      () => withTimeout(s3Fetch("HEAD", key), CLOUD_TIMEOUT_MS, "check the bucket"),
      { label: "check the bucket" }
    );
  } catch (error) {
    console.warn("Could not look for the object in the bucket", error);
    return { exists: false, size: 0, answered: false };
  }
  if (response.status === 404) return { exists: false, size: 0, answered: true };
  if (!response.ok) return { exists: false, size: 0, answered: false, status: response.status };
  const header = response.headers?.get?.("Content-Length");
  const length = header === null || header === undefined || header === "" ? NaN : Number(header);
  if (Number.isFinite(length)) return { exists: true, size: length, answered: true };
  const listed = (await listS3Objects(key)).find((file) => file.key === key);
  return listed
    ? { exists: true, size: listed.size, answered: true }
    : { exists: true, size: -1, answered: true };
}

// True only when the bucket holds exactly `bytes` bytes under `key`. The test
// every "the other copy may now go" decision is made on.
export async function s3FileHasSize(key, bytes) {
  const stat = await statS3File(key);
  return Boolean(stat.exists && stat.size >= 0 && Number(bytes) >= 0 && stat.size === Number(bytes));
}

// ── Delete ──────────────────────────────────────────────────────────────────

// A 404 counts as success — the object is not there, which is what was asked
// for. S3 has no trash, so this genuinely gives the space back.
export async function deleteS3File(key) {
  if (!key) return false;
  try {
    const response = await s3Fetch("DELETE", key);
    return response.ok || response.status === 204 || response.status === 404;
  } catch (error) {
    console.warn("Could not delete the document from the bucket", error);
    return false;
  }
}

// ── Accounting, for the Storage panel ───────────────────────────────────────

// ListObjectsV2 answers in XML. DOMParser is already in the page and is the
// only correct way to read it — a regex over a document containing a key with
// an ampersand in it would be wrong in exactly the case that is hardest to
// notice.
function parseListing(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) return { files: [], token: "", unreadable: true };
  const files = Array.from(doc.querySelectorAll("Contents")).map((node) => {
    const key = node.querySelector("Key")?.textContent || "";
    return {
      key,
      // The pdfId the key was filed under, which is what lets the panel match
      // an object back to a paper. recall/<pdfId>/<sha>.pdf
      pdfId: key.split("/")[1] || "",
      size: Number(node.querySelector("Size")?.textContent || 0),
      modifiedTime: node.querySelector("LastModified")?.textContent || null
    };
  });
  const truncated = doc.querySelector("IsTruncated")?.textContent === "true";
  return { files, token: truncated ? (doc.querySelector("NextContinuationToken")?.textContent || "") : "" };
}

// Every object under one prefix, a thousand at a time. Resolves the objects,
// or — with `strict` — null when any page could not be read in full, for the
// callers that must not mistake "the listing failed" for "the bucket is
// empty". Those are the ones about to delete something, or to decide that an
// upload did not land; a short list there is data loss, not a smaller number.
// Each page is bounded by the ordinary cloud timeout, so a stalled request
// cannot hold a panel's busy state for ever.
export async function listS3Objects(prefix, { strict = false } = {}) {
  const out = [];
  if (!canReachS3()) return strict ? null : out;
  try {
    let token = "";
    for (;;) {
      const query = { "list-type": "2", prefix, "max-keys": String(S3_LIST_PAGE) };
      if (token) query["continuation-token"] = token;
      // A single dropped connection on one page used to fail the whole
      // listing. Retried like every other idempotent cloud read (net.js) —
      // an HTTP-level refusal (see !response.ok below) is left alone; only a
      // request that never got an answer is replayed. A wider budget and an
      // extra attempt than the defaults, same reasoning as listStorageObjects
      // in image-storage.js: on a bucket with many thousands of objects a
      // page can legitimately take longer than an ordinary read.
      const response = await withRetry(
        () => withTimeout(s3Fetch("GET", "", { query }), CLOUD_LIST_TIMEOUT_MS, "list the bucket"),
        { tries: 3, baseMs: 1000, label: "list the bucket" }
      );
      if (!response.ok) {
        if (strict) return null;
        break;
      }
      const { files, token: next, unreadable } = parseListing(await response.text());
      if (unreadable && strict) return null;
      out.push(...files);
      token = next;
      if (!token) break;
    }
  } catch (error) {
    console.warn("Could not list the bucket", error);
    if (strict) return null;
  }
  return out;
}

// The papers — everything under recall/. Figures live under a prefix of their
// own (see src/cloud/s3-images.js), so this never has to page past them.
export async function listS3Files() {
  return listS3Objects(`${S3_PREFIX}/`);
}

// { count, bytes } for what Recall has put in the bucket.
//
// There is no quota endpoint to ask — S3 has no equivalent of Drive's
// /about?fields=storageQuota, and a plan's allowance lives in the provider's
// dashboard rather than in the API. So the panel shows what Recall is using and
// says where to look for the rest, which is the honest version of the number
// driveQuota was showing.
export async function s3Usage() {
  const files = await listS3Files();
  return { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), files };
}

// ── The connection test ─────────────────────────────────────────────────────
//
// What "Save and test" runs, and the only place in the app that tries to tell
// the failure modes apart. Ordered by how early they fail:
//
//   not configured → cannot sign (plain http) → blocked (CORS) → refused (keys)
//   → can read but cannot WRITE
//
// A LIST first. It proves the endpoint, the bucket name, the region and both
// halves of the credential, and it writes nothing.
//
// ...and then a WRITE, because a LIST proves less than it looks like it does.
// It is a GET with no custom headers: a simple CORS request, sent with no
// preflight at all. An upload is a PUT carrying Content-Type, which the
// browser will not send until an OPTIONS preflight says both the method and
// the header are allowed. So a CORS policy that allowed only GET, or a token
// minted read-only, passed this test, printed "Bucket connected" — and then
// failed every single upload, leaving each paper on the device it was
// imported on. That is how "it says connected but nothing syncs" happened.
//
// The probe object lives at the bucket root, outside the recall/ prefix, so
// if its delete is refused it is never counted as a paper.
export const S3_PROBE_KEY = ".recall-connection-test";

export async function testS3Connection() {
  if (!loadS3Config()) return { ok: false, reason: "Fill in all four values first." };
  if (!canSignS3Requests()) {
    return { ok: false, reason: "This page is not on https, so it cannot sign bucket requests." };
  }
  let response;
  try {
    response = await s3Fetch("GET", "", { query: { "list-type": "2", "max-keys": "1" } });
  } catch (error) {
    return { ok: false, reason: s3NetworkError(error, "The test request").message, corsLikely: true };
  }
  if (response.ok) return testS3Write();
  const error = await s3Error(response, "The test request");
  if (response.status === 403) {
    return { ok: false, reason: "The bucket refused the key — check the access key, the secret and that the token can read this bucket." };
  }
  if (response.status === 404) {
    return { ok: false, reason: "That bucket does not exist at this endpoint — check the bucket name and the endpoint." };
  }
  return { ok: false, reason: error.message };
}

// The write half of the test: PUT a few bytes exactly the way an upload does,
// then DELETE them. Returns the same { ok, reason } shape, plus `warning` when
// everything that matters works and only the delete was refused.
async function testS3Write() {
  const origin = globalThis.location?.origin || "this site";
  let put;
  try {
    put = await s3Fetch("PUT", S3_PROBE_KEY, {
      body: new Blob(["recall connection test"], { type: "application/pdf" }),
      // The same header a real upload sends, so the same preflight is asked.
      headers: { "Content-Type": "application/pdf" }
    });
  } catch (error) {
    if (error?.message === "NO_STORAGE") return { ok: false, reason: "Fill in all four values first." };
    const blocked = s3NetworkError(error, "The upload test");
    return {
      ok: false,
      corsLikely: blocked.corsLikely,
      reason: blocked.corsLikely
        ? `Reading works, but uploads are blocked — the bucket's CORS policy has to allow PUT and the Content-Type header from ${origin}. Press Copy the CORS policy and paste it in again.`
        : blocked.message
    };
  }
  if (!put.ok) {
    const error = await s3Error(put, "The upload test");
    if (put.status === 401 || put.status === 403) {
      return { ok: false, reason: "The key can read this bucket but not write to it — give the token Object Read & Write." };
    }
    return { ok: false, reason: error.message };
  }
  let removed = false;
  try {
    const del = await s3Fetch("DELETE", S3_PROBE_KEY);
    removed = del.ok || del.status === 204 || del.status === 404;
  } catch {
    removed = false;
  }
  return removed
    ? { ok: true, reason: "" }
    : {
      ok: true,
      reason: "",
      warning: `Uploads work, but the bucket refused a delete — removing a paper from the cloud will not free space. Allow DELETE in the CORS policy and the token. (A tiny ${S3_PROBE_KEY} file was left in the bucket.)`
    };
}
