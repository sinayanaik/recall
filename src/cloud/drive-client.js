// Where the reader's own Google Drive is configured, and the token the Drive
// API is called with.
//
// ── Why the papers moved off Supabase Storage ──────────────────────────────
//
// The free tier gives a project 1GB of file storage, and PDFs are the only
// thing in this app big enough to threaten it: one paper outweighs a hundred
// figures, and MAX_DOCUMENT_BYTES is 100MB, so ten large papers could spend the
// whole allowance on their own. Images are kilobytes and stay where they are.
//
// Drive was picked over the alternatives for one property each: it is 15GB
// rather than 1GB or 5GB, it needs no billing account, the files land in the
// reader's OWN Drive rather than a bucket belonging to someone else's project,
// and — the part that decided it — there is no secret to keep. An OAuth Client
// ID is public by design. Every other candidate wanted either a service-account
// key or an API secret sitting in localStorage on a static site, which is the
// one thing this app has never asked anybody to do.
//
// ── Why the token is never written down ────────────────────────────────────
//
// An access token is a bearer credential for the reader's whole Drive, and
// storage-urls.js already makes this argument about signed URLs: a signature
// "leaked in a screenshot or a shared devtools log is not a permanent grant"
// only because it expires. A Drive token expires in an hour, which is the same
// protection — but only if it is not copied somewhere that outlives the tab. So
// it lives in a module-local variable and nowhere else.
//
// Losing it on reload costs nothing. getDocument tries the device copy FIRST
// (see pdf-store.js), so the reader opens their paper either way; the token is
// only needed for a file this device has never held, and minting a new one is a
// silent round trip when a Google session exists.
//
// ── Why none of this happens at boot ───────────────────────────────────────
//
// bootApp opens this device's own decks before the Supabase session is even
// confirmed, deliberately, so that a lapsed token is not a blank page. Adding a
// second network dependency to that path would undo it. Drive is therefore
// connected lazily — on the first upload, or when the Storage panel is opened —
// and until then every function here answers "no" rather than waiting.

import { loadScriptOnce } from "../core/lib-loader.js?v=__BUILD__";

// Google serves this one itself and versions it on their side; it is the one
// script in this repo that CANNOT be vendored, which is why it is loaded the
// same deferred way Mermaid and pdf.js are rather than from vendor/.
export const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";

// Only files this app created. The narrowest scope that can do the job, and
// non-sensitive, which is what spares every install Google's verification
// process — a security assessment is not a reasonable thing to ask of somebody
// who just wants to read a paper on their phone. It is also why a PDF the
// reader moves or renames in Drive by hand still opens (the grant follows the
// file, not its name) while one they DELETE is honestly gone.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const DRIVE_CONFIG_STORAGE_KEY = "recall:driveConfig";

// Renewed this far before the token actually expires. An upload is the longest
// thing here by a wide margin — UPLOAD_TIMEOUT_MS is fifteen minutes — so a
// token with four minutes left is not worth starting one with.
export const DRIVE_TOKEN_RENEW_MS = 10 * 60 * 1000;

export function loadDriveConfig() {
  try {
    const raw = localStorage.getItem(DRIVE_CONFIG_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.clientId ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDriveConfig(clientId) {
  localStorage.setItem(DRIVE_CONFIG_STORAGE_KEY, JSON.stringify({ clientId: String(clientId || "").trim() }));
}

// Forgets the Client ID AND the live token. Used by "disconnect Drive", which
// has to do both: leaving the token behind would keep this tab uploading to an
// account the reader has just said they are done with.
export function clearDriveConfig() {
  localStorage.removeItem(DRIVE_CONFIG_STORAGE_KEY);
  forgetDriveToken();
}

export function isDriveConfigured() {
  return Boolean(loadDriveConfig()?.clientId);
}

// ── The token ───────────────────────────────────────────────────────────────

let accessToken = "";

let accessTokenExpiresAt = 0;

let tokenClient = null;

let tokenClientId = "";

// One in-flight request at a time. A deck with four PDFs opening at once would
// otherwise ask Google for four tokens, and the last three would be thrown
// away — or worse, each pop a consent window.
let pendingToken = null;

export function forgetDriveToken() {
  accessToken = "";
  accessTokenExpiresAt = 0;
  pendingToken = null;
}

// The token this device is holding, or "" — never a promise, never a throw.
// Callers that can wait use requestDriveToken instead.
export function driveToken() {
  if (!accessToken) return "";
  if (Date.now() >= accessTokenExpiresAt) return "";
  return accessToken;
}

// True when the token has one, but not much. Read before an upload starts, so a
// fifteen-minute transfer is not begun on a credential with four minutes left.
export function driveTokenExpiringSoon() {
  if (!accessToken) return true;
  return Date.now() + DRIVE_TOKEN_RENEW_MS >= accessTokenExpiresAt;
}

async function ensureTokenClient() {
  const config = loadDriveConfig();
  if (!config?.clientId) return null;
  // A changed Client ID has to build a new client: the old one is bound to the
  // old id and would keep asking the wrong project for permission.
  if (tokenClient && tokenClientId === config.clientId) return tokenClient;
  if (!(await loadScriptOnce(GIS_SCRIPT_URL))) return null;
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2?.initTokenClient) return null;
  tokenClientId = config.clientId;
  tokenClient = oauth2.initTokenClient({
    client_id: config.clientId,
    scope: DRIVE_SCOPE,
    // Both are replaced per request in requestDriveToken. initTokenClient
    // insists on a callback at construction, so these are the placeholders that
    // keep it from throwing before the real ones are installed.
    callback: () => {},
    error_callback: () => {}
  });
  return tokenClient;
}

// A token, or "".
//
// `interactive: false` is the silent path — Google reissues without a prompt
// when the reader still has a session and has already granted the scope, which
// is the overwhelmingly common case and the reason this can be called from
// anywhere without putting a window in somebody's face. It is also why failure
// here is not an error: "no token, silently" is the correct answer for a device
// that is signed out, and the caller falls back to the device copy.
//
// `interactive: true` is reserved for something the reader just asked for — the
// Connect button, or an upload they started — because a popup nobody asked for
// is blocked by the browser anyway.
export async function requestDriveToken({ interactive = false } = {}) {
  const live = driveToken();
  if (live && !driveTokenExpiringSoon()) return live;
  if (pendingToken) return pendingToken;
  pendingToken = (async () => {
    const client = await ensureTokenClient();
    if (!client) return "";
    return new Promise((resolve) => {
      let settled = false;
      const finish = (token) => {
        if (settled) return;
        settled = true;
        resolve(token);
      };
      client.callback = (response) => {
        if (!response?.access_token) return finish("");
        accessToken = response.access_token;
        // expires_in is seconds, and is trimmed by a minute so a token is never
        // handed to a request that will outlive it by a rounding error.
        accessTokenExpiresAt = Date.now() + (Number(response.expires_in || 3600) - 60) * 1000;
        announceDriveReady();
        finish(accessToken);
      };
      client.error_callback = (error) => {
        // A SILENT attempt that fails is the expected answer for a device with
        // no Google session, and getDocument makes one every time it reaches
        // for a paper this device does not hold. Logging it would put a warning
        // in the console on every open, for a state the app handles by design.
        // The reader closing a consent window they did ask for is a decision
        // rather than a fault, and is not logged either.
        if (interactive && error?.type !== "popup_closed") {
          console.warn("Could not get a Drive token", error);
        }
        finish("");
      };
      try {
        client.requestAccessToken({ prompt: interactive ? "" : "none" });
      } catch (error) {
        console.warn("Could not ask for a Drive token", error);
        finish("");
      }
    });
  })().finally(() => { pendingToken = null; });
  return pendingToken;
}

// ── "Can this device reach Drive yet?" is a STATE, not an instant ───────────
//
// The same shape, and for the same reason, as canSignStorageUrls and the
// signing-readiness machine in supabase-client.js. A token is minted
// asynchronously and the Document surface renders before it lands, so a reader
// asked as an INSTANT is told "this paper is not in the cloud" during a window
// where the truthful answer is "not yet known". Published as a state instead,
// so the one view that cares can re-ask when the answer arrives.
export function canReachDrive() {
  return Boolean(isDriveConfigured() && driveToken() && navigator.onLine);
}

// Configured, online, and simply has not been asked yet. The reader should be
// shown a waiting state rather than a refusal.
export function isDriveTokenPending() {
  return Boolean(isDriveConfigured() && navigator.onLine && !driveToken());
}

const readyListeners = new Set();

export function onDriveReadyChange(fn) {
  readyListeners.add(fn);
  return () => readyListeners.delete(fn);
}

function announceDriveReady() {
  readyListeners.forEach((fn) => {
    try {
      fn(canReachDrive());
    } catch (error) {
      // One bad listener must not stop the others being told.
      console.warn("A Drive readiness listener threw", error);
    }
  });
}

// Called by the Connect button, and by the first upload. Returns whether Drive
// is usable afterwards, so the caller can say something useful if it is not.
export async function connectDrive({ interactive = true } = {}) {
  if (!isDriveConfigured()) return false;
  const token = await requestDriveToken({ interactive });
  return Boolean(token);
}
