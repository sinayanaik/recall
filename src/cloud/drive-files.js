// The six things this app does to a file in the reader's Drive.
//
// Everything here goes through driveFetch, which is the only place a Drive URL
// and a bearer token are put together. That is partly tidiness and mostly the
// test seam: CI has no network and no Google account, so every check that
// touches a paper replaces this one function — the same way the storage client
// is stubbed in tools/handwriting-check.mjs.
//
// ── What this module promises its callers ──────────────────────────────────
//
// The same contract storage-urls.js states for signatures, for the same reason:
// the Document surface asks for a paper on every open, and a reader whose
// device already holds the bytes must never be shown an error about a cloud
// they did not ask about. So a read that cannot be answered returns null, a
// list that cannot be read returns an empty array, and nothing here throws for
// a condition the app can simply carry on without. Uploads are the exception —
// an upload that failed has to say so, because the caller records it and tells
// the reader the paper is only on this device.

import { DRIVE_SCOPE, driveToken, driveTokenExpiringSoon, forgetDriveToken, requestDriveToken } from "./drive-client.js?v=__BUILD__";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";

export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

// Visible in the reader's own Drive, deliberately. An appDataFolder would be
// tidier — hidden, un-clutterable — but it would also mean the papers are
// somewhere the person who owns them cannot see, which is the opposite of what
// "the files are in YOUR Drive" was supposed to buy. A folder they can open,
// search and back up themselves is the whole point.
export const DRIVE_FOLDER_NAME = "Recall Documents";

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

export const DRIVE_LIST_PAGE = 100;

// ── The one door ────────────────────────────────────────────────────────────

// Replaced wholesale by the checks. Everything below calls this and nothing
// below calls fetch.
let transport = (url, init) => fetch(url, init);

export function setDriveTransport(fn) {
  transport = typeof fn === "function" ? fn : ((url, init) => fetch(url, init));
}

export function resetDriveTransport() {
  transport = (url, init) => fetch(url, init);
}

// A Drive request with a live token on it.
//
// Retries exactly one class of failure: a 401. A token can expire between the
// check and the send — an upload legitimately runs for minutes — and the fix is
// a new token rather than a message to the reader. Anything else is returned as
// it came, because this layer cannot know whether its caller wants to retry a
// 429 or give up.
export async function driveFetch(url, { retryAuth = true, ...init } = {}) {
  let token = driveToken();
  if (!token || driveTokenExpiringSoon()) token = await requestDriveToken({ interactive: false });
  if (!token) throw Object.assign(new Error("NO_DRIVE_TOKEN"), { authFailed: true });
  const send = (bearer) => transport(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${bearer}` }
  });
  let response = await send(token);
  if (response.status === 401 && retryAuth) {
    // The held token is definitively wrong, not merely old — drop it so the
    // next caller does not send it again, then ask for one more.
    forgetDriveToken();
    const fresh = await requestDriveToken({ interactive: false });
    if (fresh) response = await send(fresh);
  }
  return response;
}

// Turns a non-2xx into an Error carrying the flag uploadDocument's retry loop
// reads. A 401/403 is not worth retrying — the credential or the grant is
// wrong, and four more attempts change neither.
async function driveError(response, what) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message || "";
  } catch {
    // A non-JSON error body tells us nothing the status code did not.
  }
  const error = new Error(detail || `${what} failed (HTTP ${response.status})`);
  error.status = response.status;
  error.authFailed = response.status === 401 || response.status === 403;
  // Drive says "storageQuotaExceeded" for a full account, which is a different
  // conversation from a transient refusal and must not be retried into it.
  error.quotaExceeded = /storageQuota/i.test(detail);
  return error;
}

// ── The folder ──────────────────────────────────────────────────────────────

// Cached for this tab only, and never trusted across one. The folder is found
// by SEARCHING rather than by remembering an id, because a second device has
// never seen the id and must still land in the same folder — and because a
// reader who deletes the folder must get a new one rather than a wall of 404s.
let folderIdCache = "";

export function forgetDriveFolder() {
  folderIdCache = "";
}

export async function ensureDriveFolder() {
  if (folderIdCache) return folderIdCache;
  const q = `name='${DRIVE_FOLDER_NAME}' and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`;
  const found = await driveFetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
  if (found.ok) {
    const body = await found.json();
    const id = body?.files?.[0]?.id;
    if (id) {
      folderIdCache = id;
      return id;
    }
  } else if (found.status !== 404) {
    throw await driveError(found, "find the Recall folder");
  }
  const created = await driveFetch(`${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: DRIVE_FOLDER_MIME })
  });
  if (!created.ok) throw await driveError(created, "create the Recall folder");
  const body = await created.json();
  folderIdCache = body?.id || "";
  return folderIdCache;
}

// ── Upload ──────────────────────────────────────────────────────────────────

// The metadata half of every upload.
//
// appProperties is the part that matters most and is easiest to mistake for
// decoration. meta.pdfs merges by WHOLE RECORD, last writer wins (see
// mergeRecordsById in src/sync/diff.js) — it does not merge fields — so a device
// that rewrites its copy of a PDF record for any reason at all can carry away
// the driveId with it. Stamping the deck id, the pdf id and the content hash
// onto the file itself means that is recoverable rather than terminal:
// findDriveFileByProperties reads them back and getDocument writes the id
// into meta again. A last-writer-wins store needs a way home, not just a
// careful writer.
export function driveFileMetadata({ name, folderId, deckId, pdfId, sha256 }) {
  const appProperties = {};
  if (deckId) appProperties.recallDeckId = String(deckId);
  if (pdfId) appProperties.recallPdfId = String(pdfId);
  if (sha256) appProperties.recallSha256 = String(sha256);
  const metadata = { name: name || "document.pdf", mimeType: "application/pdf" };
  if (folderId) metadata.parents = [folderId];
  if (Object.keys(appProperties).length) metadata.appProperties = appProperties;
  return metadata;
}

// Built as a Blob rather than a string, which is not a style choice: the file
// is up to MAX_DOCUMENT_BYTES — 100MB — and concatenating that into a
// JavaScript string would materialise it twice in memory as UTF-16 before a
// byte left the device. A Blob references the bytes where they already are.
export function multipartUploadBody(metadata, file, boundary) {
  return new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
    file,
    `\r\n--${boundary}--\r\n`
  ]);
}

function uploadBoundary() {
  const rand = crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `recall-${rand}`;
}

// One request, metadata and bytes together. Returns the new file's id.
export async function uploadDriveFileMultipart(file, metadata) {
  const boundary = uploadBoundary();
  const response = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,size`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipartUploadBody(metadata, file, boundary)
  });
  if (!response.ok) throw await driveError(response, "upload the document");
  const body = await response.json();
  return body?.id || "";
}

// Two requests: one to open a session, one to send the bytes to the URL it
// answers with.
//
// Google recommends this above 5MB and a paper is routinely larger, so it is
// tried first — but it hangs on reading the `Location` response header, and
// whether Drive exposes that header through CORS is the one thing about this
// design that could not be established from outside a real account. So a
// missing Location is NOT an error: it means this browser cannot see the
// session URI, and the caller falls back to multipart, which needs no header at
// all. Returns "" to say exactly that.
export async function uploadDriveFileResumable(file, metadata) {
  const init = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,size`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "application/pdf",
      "X-Upload-Content-Length": String(file.size)
    },
    body: JSON.stringify(metadata)
  });
  if (!init.ok) throw await driveError(init, "start the upload");
  const session = init.headers?.get?.("Location") || "";
  if (!session) return "";
  const sent = await transport(session, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: file
  });
  if (!sent.ok) throw await driveError(sent, "upload the document");
  const body = await sent.json();
  return body?.id || "";
}

// The one the rest of the app calls. Resumable where the browser can drive it,
// multipart everywhere else, and the caller never has to know which happened.
export async function uploadDriveFile(file, { name, deckId, pdfId, sha256 }) {
  const folderId = await ensureDriveFolder();
  const metadata = driveFileMetadata({ name, folderId, deckId, pdfId, sha256 });
  if (file.size > 5 * 1024 * 1024) {
    const id = await uploadDriveFileResumable(file, metadata);
    if (id) return id;
  }
  return uploadDriveFileMultipart(file, metadata);
}

// ── Read ────────────────────────────────────────────────────────────────────

// The bytes, or null. Null covers every reason a paper might not come back —
// no token, deleted in Drive by hand, offline, the grant revoked — because the
// caller's next move is the same for all of them: use the device copy, and
// failing that ask the reader to re-attach the file.
export async function downloadDriveFile(fileId) {
  if (!fileId) return null;
  try {
    const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
    if (!response.ok) {
      if (response.status !== 404) console.warn("Could not download the document from Drive", response.status);
      return null;
    }
    return await response.blob();
  } catch (error) {
    console.warn("Could not download the document from Drive", error);
    return null;
  }
}

// The way home when a merge has taken a driveId off a record. See
// driveFileMetadata for why this exists at all.
export async function findDriveFileByProperties({ deckId, pdfId, sha256 }) {
  const clauses = ["trashed=false"];
  if (deckId) clauses.push(`appProperties has { key='recallDeckId' and value='${deckId}' }`);
  if (pdfId) clauses.push(`appProperties has { key='recallPdfId' and value='${pdfId}' }`);
  if (sha256) clauses.push(`appProperties has { key='recallSha256' and value='${sha256}' }`);
  // Enough to name ONE file, or nothing. The content hash alone is enough —
  // it is the identity of the exact bytes the highlights were measured
  // against, which is the same test documentEntryMatches applies. Deck id
  // alone is not: it matches every paper in the deck, and handing back an
  // arbitrary one of them is worse than admitting it does not know.
  if (!sha256 && !(deckId && pdfId)) return "";
  try {
    const q = clauses.join(" and ");
    const response = await driveFetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
    if (!response.ok) return "";
    const body = await response.json();
    return body?.files?.[0]?.id || "";
  } catch (error) {
    console.warn("Could not look for the document in Drive", error);
    return "";
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

// Permanent, and deliberately so: files.delete skips the trash, which is what
// makes "Remove from cloud" actually give the reader their quota back rather
// than move the problem thirty days into the future. A 404 counts as success —
// the file is not there, which is what was asked for.
export async function deleteDriveFile(fileId) {
  if (!fileId) return false;
  try {
    const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
    return response.ok || response.status === 404;
  } catch (error) {
    console.warn("Could not delete the document from Drive", error);
    return false;
  }
}

// ── Accounting, for the Storage panel ───────────────────────────────────────

export async function listDriveFiles() {
  const out = [];
  try {
    const folderId = await ensureDriveFolder();
    if (!folderId) return out;
    let pageToken = "";
    for (;;) {
      const q = `'${folderId}' in parents and trashed=false`;
      const params = new URLSearchParams({
        q,
        fields: "nextPageToken,files(id,name,size,modifiedTime,appProperties)",
        pageSize: String(DRIVE_LIST_PAGE)
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await driveFetch(`${DRIVE_API}/files?${params}`);
      if (!response.ok) break;
      const body = await response.json();
      (body?.files || []).forEach((row) => out.push({
        id: row.id,
        name: row.name || "",
        // Drive sends size as a string, and omits it entirely for the folder
        // types this query cannot return anyway.
        size: Number(row.size || 0),
        modifiedTime: row.modifiedTime || null,
        deckId: row.appProperties?.recallDeckId || null,
        pdfId: row.appProperties?.recallPdfId || null
      }));
      pageToken = body?.nextPageToken || "";
      if (!pageToken) break;
    }
  } catch (error) {
    console.warn("Could not list the documents in Drive", error);
  }
  return out;
}

// { limit, usage, usageInDrive } in bytes, or null.
//
// Worth showing next to the Supabase figure because the 15GB is shared with
// Gmail and Photos: a reader whose uploads start failing has usually not filled
// it with papers, and the panel is the only place that can say so.
export async function driveQuota() {
  try {
    const response = await driveFetch(`${DRIVE_API}/about?fields=storageQuota`);
    if (!response.ok) return null;
    const body = await response.json();
    const quota = body?.storageQuota;
    if (!quota) return null;
    return {
      // Absent on an unlimited (Workspace) account, which is not an error.
      limit: quota.limit ? Number(quota.limit) : 0,
      usage: Number(quota.usage || 0),
      usageInDrive: Number(quota.usageInDrive || 0)
    };
  } catch (error) {
    console.warn("Could not read the Drive quota", error);
    return null;
  }
}

export { DRIVE_SCOPE };
