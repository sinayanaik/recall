// Sign in, sign up, sign out — against the user's own Supabase project.
//
// Nothing here may assume a healthy backend: every install points at a
// different project, so a failure has to say WHICH half went wrong. "Couldn't
// load the sign-in library" and "your project is misconfigured" send the user
// to opposite places, and conflating them once offered a button that would
// have deleted a perfectly good project.

import { LAST_USER_STORAGE_KEY } from "../boot.js?v=__BUILD__";
import { withTimeout } from "./net.js?v=__BUILD__";
import { PENDING_STYLE_KEY } from "./style-sync.js?v=__BUILD__";
import { hasRememberedSession, supabaseClient } from "./supabase-client.js?v=__BUILD__";

// How long boot will wait for a session before carrying on without one.
// Much shorter than AUTH_TIMEOUT_MS because of what is on the other side of it:
// this call sits on the boot path with nothing painted, so every second here is
// a second of blank screen, and the fallback is not an error — it is "start
// offline", which this app is built to do.
export const SESSION_RESTORE_TIMEOUT_MS = 8000;

// Kept for the callers that only ever ask "is there a session to use right
// now" — where a null genuinely does mean "carry on without one". Anything
// that decides whether to SHOW THE LOGIN SCREEN must use getSessionOutcome()
// instead, so it can tell a sign-out apart from a failed refresh.
export async function getCachedSession() {
  return (await getSessionOutcome()).session;
}

// The session, for a caller that must not hang waiting for one.
//
// This is NOT a pure local read, despite what the older name suggested.
// getSession() returns the stored session as-is while the access token is
// live, but the moment that token has expired it goes to the network to
// refresh it — see the identical call in verifiedCloudUserId below, which has
// been wrapped in a timeout for exactly that reason since long before this one
// was. Unwrapped, on a connection that accepts and then answers nothing (a
// captive portal, a dead cell), it never settled — and it is awaited by
// bootApp() before ANY screen has been shown, so the app sat on a blank page
// indefinitely. Hence the timeout; hence, too, "unknown" below, because a
// timeout has to mean something other than "signed out".
//
// The session, as one of THREE answers — because the caller's response to the
// third is the opposite of its response to the second.
//
//   • "session"    -> a live session; the token is good
//   • "signed-out" -> no session AND nothing remembered on this device. This
//                     is the only answer that may show the login wall.
//   • "unknown"    -> the check timed out, threw, or came back empty while a
//                     session record is still sitting in storage. The refresh
//                     could not be completed right now; that is a network fact,
//                     not a statement about who the user is.
//
// getCachedSession() below cannot express the difference: every one of those
// failures leaves it returning `null`, so a launch on a slow or captive
// connection, or one where the refresh token had lapsed, looked exactly like a
// deliberate sign-out — and the app dutifully asked for the password again.
// That is the "it makes me log in every time I open it" report.
export async function getSessionOutcome() {
  if (!supabaseClient) return { status: "unknown", session: null };
  try {
    const { data, error } = await withTimeout(
      supabaseClient.auth.getSession(),
      SESSION_RESTORE_TIMEOUT_MS,
      "restore session"
    );
    const session = data?.session ?? null;
    if (session?.user) return { status: "session", session };
    // An error from getSession is never a sign-out — it is the refresh having
    // failed. Only an unambiguously empty store is.
    if (error) return { status: "unknown", session: null };
    return { status: hasRememberedSession() ? "unknown" : "signed-out", session: null };
  } catch (error) {
    console.warn("Could not read cached session", error);
    return { status: "unknown", session: null };
  }
}

// Proof that the requests this sync is about to make will actually carry THIS
// user's identity — not just that the app once saw a session (`isSignedIn`).
//
// This is the single most destructive failure mode the app has. Every table is
// RLS-scoped to `auth.uid()`, so a request that reaches Supabase without a valid
// user token is not rejected: it succeeds and matches nothing. The reconcile
// then reads an empty deck list as "every deck was deleted on another device",
// deletes the local library, and (before the change alongside this one) wrote
// tombstones for all of it — losing the user's decks on every device at once.
//
// `isSignedIn` cannot rule that out. It's a boolean set from a CACHED session,
// so it stays true after a refresh token expires or a refresh fails. getSession()
// is the check that matters: it refreshes an expired access token when it can,
// and returns null when it can't — which is precisely "your next query would run
// as nobody". No network cost in the common case (a live token is returned from
// local storage as-is).
export async function verifiedCloudUserId() {
  if (!supabaseClient) return null;
  try {
    // BOUNDED, like every other cloud call. getSession() reads local storage in
    // the common case, but when the access token has expired it goes to the
    // network to refresh it — and that call is supabase-js's, with no timeout of
    // ours on it. On a connection that accepts and then answers nothing (the
    // exact failure withTimeout exists for) it never settles, and because this
    // is the first thing reconcileAllDecks awaits, the whole sync stops here:
    // reconcileInFlight stays true forever, the button sits on its first label,
    // and no later sync can start. A timeout is read as "couldn't confirm the
    // sign-in", which is already a safe, handled outcome — the sync is skipped
    // and every local deck is left alone.
    const { data, error } = await withTimeout(
      supabaseClient.auth.getSession(),
      AUTH_TIMEOUT_MS,
      "confirm sign-in"
    );
    if (error) return null;
    const session = data?.session;
    // An access token that has already expired means the queries below would go
    // out unauthenticated (or be rejected outright). getSession normally
    // refreshes it for us; if it handed one back anyway, don't trust it.
    if (!session?.user?.id || !session?.access_token) return null;
    if (session.expires_at && Number(session.expires_at) * 1000 <= Date.now()) return null;
    return String(session.user.id);
  } catch (error) {
    console.warn("Could not verify the signed-in user", error);
    return null;
  }
}

export let explicitLogout = false;

// Setter, because an imported binding is read-only in the importing module and
// the auth listener in main.js clears this flag after reading it. Same shape,
// and the same reason, as setSignedIn in cloud/supabase-client.js.
export function setExplicitLogout(value) {
  explicitLogout = value;
}

// Is this the sign-in having lapsed, rather than anything the user did wrong?
//
// Shared with the sync path (see describeSyncFailure) because the two surfaces
// were reporting the same event in two different, equally unhelpful ways. Both
// of these are ordinary — an access token lives about an hour, and a phone that
// spent a week in a pocket comes back to a refresh that has to happen — and
// neither said so. The user saw the provider's own words instead: "JWT expired",
// "invalid JWT", "Invalid Refresh Token: Already Used". None of those name a
// thing anybody can act on, and all of them read like the app is broken.
//
// PGRST301 is PostgREST's code for a request whose JWT did not verify; the
// GoTrue shapes cover the refresh itself failing.
export function isSessionExpiredError(error) {
  if (error?.code === "PGRST301") return true;
  const message = String(error?.message || error || "");
  return /\bjwt\b|token is expired|invalid claim|bad_jwt|refresh[_ ]token[_ ]not[_ ]found|invalid refresh token|already used/i
    .test(message);
}

// What to say when the sign-in has lapsed. One sentence, in both places it can
// happen, and it always ends by saying the decks are safe — because the first
// thing this failure makes anybody wonder is whether their data went with it.
export const SESSION_EXPIRED_MESSAGE =
  "Your sign-in expired — sign in again. Your decks are safe on this device.";

// Raw provider strings were shown verbatim, which is fine for "Invalid login
// credentials" and useless for the rest. "Failed to fetch" reads like a bug in
// the app; "Invalid API key" is a truthful message about a cause the user has no
// reason to connect to the key they pasted on a different screen. The sync path
// already translates the network case (see writeStyleToCloud) — this is the same
// judgement applied where people actually hit it.
export function describeAuthError(error) {
  const message = String(error?.message || error || "Something went wrong");
  if (!navigator.onLine || /failed to fetch|networkerror|load failed|timed out/i.test(message)) {
    return "Couldn't reach your Supabase project — check your connection, then try again.";
  }
  // Before the API-key check below, which "invalid JWT" would otherwise not
  // reach but which a rotated legacy anon key can be mistaken for.
  if (isSessionExpiredError(error)) return SESSION_EXPIRED_MESSAGE;
  if (/invalid api key/i.test(message)) {
    return "This project's anon key isn't valid. Use “Change Supabase project” below and paste it again.";
  }
  if (/email not confirmed/i.test(message)) {
    return "This email hasn't been confirmed yet — check your inbox for the confirmation link.";
  }
  if (/email logins are disabled|signups not allowed|signup is disabled/i.test(message)) {
    return "This Supabase project has email sign-in turned off. Enable it under Authentication → Providers → Email.";
  }
  return message;
}

// Refresh the access token once, by hand.
//
// isTransientCloudError deliberately refuses to retry a coded PostgREST error,
// and it is right to: replaying a request with the same expired token just
// fails again. But the fix for THIS error is not to replay it — it is to get a
// new token first, which nothing did, so a token that lapsed mid-sync aborted
// the whole run and every run after it until the user happened to reload.
//
// Bounded like every other auth call. Returns whether there is now a usable
// session; the caller decides whether to re-run its phase.
export async function refreshSessionOnce() {
  if (!supabaseClient || !navigator.onLine) return false;
  try {
    const { data, error } = await withTimeout(
      supabaseClient.auth.refreshSession(),
      AUTH_TIMEOUT_MS,
      "refresh sign-in"
    );
    if (error) return false;
    return Boolean(data?.session?.access_token);
  } catch (error) {
    console.warn("Could not refresh the session", error);
    return false;
  }
}

// Every cloud data call is wrapped in withTimeout; these three never were, and
// they are the ones a user is actively waiting on. On a network that accepts a
// connection and then answers nothing — the exact failure the service worker's
// whole design exists for — the promise never settles, so the submit button
// stays disabled with no error and no spinner, and only a reload recovers.
export const AUTH_TIMEOUT_MS = 20000;

export async function handleLogin(email, password) {
  const { data, error } = await withTimeout(
    supabaseClient.auth.signInWithPassword({ email, password }),
    AUTH_TIMEOUT_MS,
    "sign in"
  );
  if (error) throw error;
  return data.user;
}

// Returns what actually happened, because "no error" does not mean "signed in".
// With Supabase's default "Confirm email" ON — a dashboard setting the app can't
// see and that supabase_setup.sql only mentions in a closing comment — signUp
// resolves with a user and a NULL session and no error at all. The old code
// returned data.user, the caller treated that as success, no auth event fired,
// and the button simply re-enabled: pressing "Create Account" did visibly
// nothing. Supabase also deliberately obfuscates an already-registered address
// by returning a fake user with an empty `identities` array, which looked
// identical.
export async function handleSignup(email, password) {
  const { data, error } = await withTimeout(
    supabaseClient.auth.signUp({
      email,
      password,
      // Without this, a confirmation mail points at the project's dashboard Site
      // URL, which defaults to http://localhost:3000 — a dead page on the
      // user's own machine. Sending them back where they signed up from is the
      // only value that's right for every deployment.
      options: { emailRedirectTo: location.href.split("#")[0] }
    }),
    AUTH_TIMEOUT_MS,
    "create account"
  );
  if (error) throw error;

  if (data?.session) return { outcome: "signed-in", user: data.user };
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { outcome: "already-registered", user: data.user };
  }
  return { outcome: "confirm-email", user: data?.user || null };
}

export async function handleLogout() {
  explicitLogout = true;
  // The signed-in uid outlives the session unless it is cleared here: it is
  // what styleSettingsRowId() and getQuickNotesDeckId() resolve against, so
  // leaving it behind pointed the next account's style row and quick-notes deck
  // at the previous user.
  try { localStorage.removeItem(LAST_USER_STORAGE_KEY); } catch (_) {}
  // Unscoped and replayed on the next reconcile by whoever is signed in then —
  // on a shared device that uploaded one user's style into another's row. The
  // quick-note queues are deck-scoped and self-discard; this one never was.
  try { localStorage.removeItem(PENDING_STYLE_KEY); } catch (_) {}
  if (supabaseClient) {
    try {
      await withTimeout(supabaseClient.auth.signOut(), AUTH_TIMEOUT_MS, "sign out");
    } catch (error) {
      // Offline sign-out still clears the local session below via the listener.
      console.warn("Sign-out network call failed (continuing locally)", error);
    }
  }
}
