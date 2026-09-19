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

// One PUT. Returns the key it wrote, and throws if it did not — the caller
// records the result, so a silent failure here would mean a deck pointing at
// nothing.
export async function uploadS3File(file, { pdfId, sha256 }) {
  const key = s3DocumentKey({ pdfId, sha256 });
  // Without a hash there is no key, and a fabricated one would be an object
  // nothing could ever find again. pdf-store hashes before it uploads; this is
  // the guard for the path where crypto.subtle was missing and it could not.
  if (!key) throw Object.assign(new Error("NO_DOCUMENT_HASH"), { authFailed: true });
  let response;
  try {
    response = await s3Fetch("PUT", key, {
      body: file,
      // Not a signed header — only `host` is signed — so the bucket takes it as
      // the object's stored type without it affecting the signature. It is what
      // makes the object open as a PDF if the reader ever fetches it directly.
      headers: { "Content-Type": "application/pdf" }
    });
  } catch (error) {
    if (error?.message === "NO_STORAGE") throw error;
    throw s3NetworkError(error, "The upload");
  }
  if (!response.ok) throw await s3Error(response, "The upload");
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
  if (doc.querySelector("parsererror")) return { files: [], token: "" };
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

export async function listS3Files() {
  const out = [];
  if (!canReachS3()) return out;
  try {
    let token = "";
    for (;;) {
      const query = { "list-type": "2", prefix: `${S3_PREFIX}/`, "max-keys": String(S3_LIST_PAGE) };
      if (token) query["continuation-token"] = token;
      const response = await s3Fetch("GET", "", { query });
      if (!response.ok) break;
      const { files, token: next } = parseListing(await response.text());
      out.push(...files);
      token = next;
      if (!token) break;
    }
  } catch (error) {
    console.warn("Could not list the documents in the bucket", error);
  }
  return out;
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
// the four failure modes apart. Ordered by how early they fail:
//
//   not configured → cannot sign (plain http) → blocked (CORS) → refused (keys)
//
// A LIST rather than a PUT, deliberately. It proves the endpoint, the bucket
// name, the region, both halves of the credential and the CORS policy, and it
// writes nothing into a bucket the reader has not yet decided to keep using.
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
  if (response.ok) return { ok: true, reason: "" };
  const error = await s3Error(response, "The test request");
  if (response.status === 403) {
    return { ok: false, reason: "The bucket refused the key — check the access key, the secret and that the token can read this bucket." };
  }
  if (response.status === 404) {
    return { ok: false, reason: "That bucket does not exist at this endpoint — check the bucket name and the endpoint." };
  }
  return { ok: false, reason: error.message };
}
