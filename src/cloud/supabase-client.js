// Where the user's own Supabase project is configured, and the client built
// from it. Every install brings its own project, so nothing here may assume a
// good schema, a reachable host, or a live session.

// Supabase config is stored in localStorage — no hardcoded credentials.
// Users enter their own project URL and anon key on first launch.
export const SUPABASE_CONFIG_STORAGE_KEY = "flashcards_supabase_config";

export function loadSupabaseConfig() {
  try {
    const raw = localStorage.getItem(SUPABASE_CONFIG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSupabaseConfig(url, key) {
  localStorage.setItem(SUPABASE_CONFIG_STORAGE_KEY, JSON.stringify({ url: url.trim(), key: key.trim() }));
}

export function clearSupabaseConfig() {
  localStorage.removeItem(SUPABASE_CONFIG_STORAGE_KEY);
}

export let supabaseClient = null;

// Tracks whether a real user session is active, so background auto-sync only
// fires for signed-in users (and never tries to push while logged out).
export let isSignedIn = false;

// Setters, because an imported binding is READ-ONLY in the importing module:
// `isSignedIn = true` in main.js is not a silent no-op, it is an early
// SyntaxError that stops the whole module graph from instantiating. Both of
// these are written from the auth flow (sign-in, sign-out, session recovery,
// "change project"), which lives elsewhere, so they need a way in.
//
// Reads stay as plain imports — a live binding, so every reader sees the
// current value the moment it changes, exactly as the shared script scope did.
export function setSupabaseClient(client) {
  supabaseClient = client;
}

// ── "Can this device sign a storage URL yet?" is a STATE, not an instant ────
//
// The images bucket is private, so every rendered <img> needs a signature minted
// against a live session (src/cloud/storage-urls.js). But bootApp opens this
// device's own decks BEFORE the session is confirmed — deliberately, so a lapsed
// token is not a blank page (see the "Local first, cloud second" block in
// src/boot.js) — and the notes render inside that window. Read as an instant,
// `isSignedIn` is false there, nothing can be signed, and every image in the
// note is left holding a canonical URL the private bucket answers 400 to.
//
// On the device that UPLOADED the image that is invisible: its bytes are in the
// service worker's cache under exactly that canonical URL (cacheUploadedImageOffline),
// so the un-signed src is served from cache. On every other device it is a
// permanent broken-image placeholder — which is the whole of "the picture shows
// where I added it and nowhere else".
//
// So the state is published, in two parts:
//
//   • isSigningPending() — the session question has been ASKED and not yet
//     answered. "I cannot sign" means nothing while this is true, and in
//     particular it is not evidence that an image is broken.
//   • onSigningReadyChange() — the answer, whichever way it went. Anything that
//     gave up because it could not sign yet gets told, and tries again.
//
// Both are here rather than in boot.js because this module is a leaf: the
// render path (storage-urls.js) and the broken-image path (images/broken.js)
// already import from it, and neither can import boot without a cycle.
const signingReadyListeners = new Set();

// Returns an unsubscribe, so a caller with a lifetime shorter than the page's
// (a modal, a view) can let go without leaking into this set.
export function onSigningReadyChange(listener) {
  if (typeof listener !== "function") return () => {};
  signingReadyListeners.add(listener);
  return () => signingReadyListeners.delete(listener);
}

function publishSigningState() {
  // Never let one listener's failure stop the others, and never let it throw
  // back into the auth flow that published the change.
  for (const listener of [...signingReadyListeners]) {
    try {
      listener(isSignedIn);
    } catch (error) {
      console.warn("A signing-readiness listener failed", error);
    }
  }
}

// Open from the first line of the module, because the very first render can
// happen before boot has even asked. Closed by the first setSignedIn of any
// kind, by setSigningPending(false) on the paths that end without one (a device
// with no config, an offline confirm that returns early), and — as a floor no
// forgotten path can drop through — by the timer below.
let signingPending = true;

export function isSigningPending() {
  return signingPending;
}

// Slightly longer than SESSION_RESTORE_TIMEOUT_MS in cloud/auth.js, which is
// what actually bounds the wait: this is the backstop for a path that never
// reports at all, not a second deadline for the one that does. Deliberately not
// imported from there — auth.js imports this module, and the cycle would cost
// more than the duplicated number.
export const SIGNING_PENDING_MAX_MS = 20000;

export function setSigningPending(value) {
  const next = Boolean(value);
  if (signingPending === next) return;
  signingPending = next;
  publishSigningState();
}

setTimeout(() => setSigningPending(false), SIGNING_PENDING_MAX_MS);

export function setSignedIn(value) {
  const next = Boolean(value);
  const changed = isSignedIn !== next;
  isSignedIn = next;
  // An answer either way closes the question, so a sign-out is as much a
  // resolution as a sign-in: the images that were waiting to hear should stop
  // waiting and be judged on what they can actually load.
  const wasPending = signingPending;
  signingPending = false;
  if (changed || wasPending) publishSigningState();
}

// Returns a REASON, not a boolean. The two failures it used to conflate need
// opposite responses: "no-config" is a first run and the setup form is correct;
// "no-library" is a configured device whose CDN fetch for supabase-js failed,
// and showing that user the setup form tells them their project is missing when
// it isn't — then offers them a button that deletes it. The developer never saw
// this because localhost keeps the script warm and unregisters the worker.
export function initSupabaseClient() {
  const config = loadSupabaseConfig();
  if (!config?.url || !config?.key) return "no-config";
  if (!window.supabase) return "no-library";
  try {
    // Options passed explicitly, where this used to pass none at all.
    //
    // The v2 defaults happen to be the ones this app needs — but "happen to be"
    // is the problem: session persistence and automatic token refresh are load
    // -bearing here (an offline launch reads the stored session; a phone that
    // has been in a pocket for a week needs the refresh), and a supabase-js
    // bump changing either would present as "sync just stopped working" with
    // nothing in this repo to point at. Writing them down makes that a diff.
    supabaseClient = window.supabase.createClient(config.url, config.key, {
      auth: {
        // The stored session is what makes an offline launch possible at all.
        persistSession: true,
        // And this is what stops an hour-old tab silently becoming unable to
        // sync. Recall additionally refreshes by hand when a request comes back
        // with an expired token (see refreshSessionOnce); this is the ambient
        // half that means it usually never has to.
        autoRefreshToken: true,
        // Left ON: handleSignup sets emailRedirectTo, so a confirmation link
        // comes back to this page carrying the session in the URL, and turning
        // this off would silently break account creation on every project with
        // Supabase's default "Confirm email" enabled.
        detectSessionInUrl: true
        // storageKey is deliberately NOT set. It is tempting — scoping it to
        // the project would stop two installs on one origin sharing a session —
        // but the key is where the CURRENT session lives, so changing it does
        // not migrate anything: it makes every already-signed-in user's session
        // unreadable, and the first load after the release signs them all out.
        // A one-off mass sign-out is a real cost; two projects on one origin is
        // a scenario nobody has.
      }
    });
  } catch (error) {
    // A malformed URL or key that passed the setup form's shape check can throw
    // here. Treated as "no client" rather than allowed to abort boot.
    console.warn("Could not create the Supabase client", error);
    supabaseClient = null;
    return "no-library";
  }
  preconnectToStorageOrigin(config.url);
  return "ok";
}

// index.html can only preconnect to cdn.jsdelivr.net — every user brings their
// own Supabase project, so the storage origin isn't known until the config is
// read. Without this the first image of a session pays DNS + TLS on top of its
// download, which is exactly the request the reader is waiting on.
export function preconnectToStorageOrigin(url) {
  try {
    const origin = new URL(url).origin;
    if (document.querySelector(`link[rel="preconnect"][href="${CSS.escape(origin)}"]`)) return;
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  } catch {
    // A malformed configured URL is already handled above; nothing to warm.
  }
}

// supabase-js is a blocking <script> before this file, so if it were coming at
// all it would already be here — except when the browser gave up on it early,
// or a slow CDN answered after the parser moved on. Cheap to keep looking for a
// few seconds before declaring failure, and free when it's already loaded.
export async function waitForSupabaseLibrary(timeoutMs = 8000) {
  if (window.supabase) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (window.supabase) return true;
  }
  return false;
}

// Re-fetch supabase-js by hand. The original <script> has already failed and
// will not retry itself, so "Try again" has to actually go and get it — a bare
// location.reload() would re-run the same blocked request through the same
// blocked path and look identical to doing nothing.
export function reloadSupabaseLibrary() {
  return new Promise((resolve) => {
    if (window.supabase) return resolve(true);
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.2";
    script.async = true;
    script.onload = () => resolve(Boolean(window.supabase));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

// Is there a sign-in remembered on THIS device, answered without a network?
//
// supabase-js persists the session in localStorage under `sb-<ref>-auth-token`
// (the ref is the project's subdomain — see storageKey above, which is
// deliberately left at that default). Reading it directly is the only way to
// tell apart the two states getSession() collapses into `null`:
//
//   • nobody has ever signed in here / they signed out  -> the key is absent
//   • somebody IS signed in, but the token could not be refreshed just now
//     (offline, captive portal, a slow project, a rotated refresh token)
//
// The second is not a sign-out, and treating it as one is what threw people
// back to the login wall on launch after launch. Nothing is validated here —
// an expired token still counts. The question this answers is "is this a
// remembered install?", not "may this request read the database"; only
// verifiedCloudUserId() may decide the latter.
export function readStoredSessionRecord() {
  const config = loadSupabaseConfig();
  if (!config?.url) return null;
  let ref = "";
  try {
    ref = new URL(config.url).hostname.split(".")[0];
  } catch {
    return null;
  }
  if (!ref) return null;
  try {
    const raw = localStorage.getItem(`sb-${ref}-auth-token`);
    if (!raw) return null;
    return { raw };
  } catch (error) {
    // Storage can throw outright in a partitioned/blocked context. "Can't tell"
    // is not "signed out", so the safe answer is the one that keeps the app
    // open — but there is genuinely nothing to report here.
    console.warn("Could not read the stored session record", error);
    return null;
  }
}

// Has this device ever completed a sign-in that was never explicitly undone?
//
// Either record answers yes, and the second one is the point: supabase-js
// deletes its own the moment it gives up on a refresh, and this question is
// asked by the code that decides whether to show the login wall. Answering "no"
// there because a refresh failed is the bug — see SESSION_BACKUP_STORAGE_KEY.
export function hasRememberedSession() {
  return Boolean(readStoredSessionRecord() || readSessionBackup());
}

// ── A refresh token of our own, kept beside supabase-js's ──────────────────
//
// readStoredSessionRecord above answers "is this a remembered install?" out of
// supabase-js's own key — which works right up to the moment supabase-js
// DELETES that key. It does exactly that when a refresh fails in a way it reads
// as final: `refresh_token_not_found`, an `Already Used` rotation race between
// two tabs or a PWA resuming into one, a 5xx from a project that was asleep. The
// session record is gone, `hasRememberedSession()` says no, and from that point
// on this device is indistinguishable from one nobody ever signed in on — so the
// next launch shows the wall, and the launch after that, and nothing on the
// device can put it right except typing the password again.
//
// That is the whole of "it logs me out for no reason". The session was never
// revoked; the one thing that could have re-established it was thrown away
// because a refresh failed once.
//
// So a copy of the refresh token is kept here, under our own key, and it is the
// input to restoreSessionFromBackup() in ./auth.js. Nothing reads it as proof of
// anything — a token in storage is not a session, and only verifiedCloudUserId()
// may decide what a request runs as. It is a way BACK, tried against the
// project, whose answer is authoritative either way: a session, or a refusal
// naming the token, which is the one case that clears this record.
//
// Cleared on an explicit sign-out (handleLogout), and scoped to the project ref
// so that "change Supabase project" cannot hand one project's token to another.
export const SESSION_BACKUP_STORAGE_KEY = "recall:session-backup-v1";

// The configured project's ref, or "". Shared by both readers below rather than
// derived twice, since the two must agree about which project a record belongs
// to or the scoping is decorative.
function configuredProjectRef() {
  const config = loadSupabaseConfig();
  if (!config?.url) return "";
  try {
    return new URL(config.url).hostname.split(".")[0] || "";
  } catch {
    return "";
  }
}

// Called wherever a live session is SEEN — the auth listener's every event, and
// getSessionOutcome — rather than only at sign-in. supabase-js rotates the
// refresh token on every refresh and fires TOKEN_REFRESHED when it does, so a
// backup written once at sign-in would be a token that has since been spent, and
// spending it twice is the "Already Used" failure this exists to recover from.
export function rememberSessionForRecovery(session) {
  const refreshToken = session?.refresh_token;
  if (!refreshToken) return;
  const ref = configuredProjectRef();
  if (!ref) return;
  try {
    localStorage.setItem(SESSION_BACKUP_STORAGE_KEY, JSON.stringify({
      ref,
      userId: session?.user?.id ? String(session.user.id) : "",
      refreshToken: String(refreshToken),
      // The refresh token and nothing else. An access token is short-lived, is
      // already in supabase-js's own record, and is not an input to the one
      // call that spends this (refreshSession) — so keeping a second copy of a
      // bearer credential in storage would buy nothing at all.
      at: Date.now()
    }));
  } catch (error) {
    // Quota, or a private window. Losing this costs a sign-in, never data.
    console.warn("Could not remember the session for recovery", error);
  }
}

export function readSessionBackup() {
  const ref = configuredProjectRef();
  if (!ref) return null;
  try {
    const raw = localStorage.getItem(SESSION_BACKUP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.refreshToken || parsed.ref !== ref) return null;
    return parsed;
  } catch (error) {
    console.warn("Could not read the remembered session", error);
    return null;
  }
}

export function clearSessionBackup() {
  try { localStorage.removeItem(SESSION_BACKUP_STORAGE_KEY); } catch (_) {}
}
