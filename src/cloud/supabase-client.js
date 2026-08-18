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

export function setSignedIn(value) {
  isSignedIn = value;
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
