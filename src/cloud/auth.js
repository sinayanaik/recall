// Sign in, sign up, sign out — against the user's own Supabase project.
//
// Nothing here may assume a healthy backend: every install points at a
// different project, so a failure has to say WHICH half went wrong. "Couldn't
// load the sign-in library" and "your project is misconfigured" send the user
// to opposite places, and conflating them once offered a button that would
// have deleted a perfectly good project.

import { supabaseClient } from "./supabase-client.js?v=__BUILD__";
import { LAST_USER_STORAGE_KEY, PENDING_STYLE_KEY, withTimeout } from "../main.js?v=__BUILD__";

// Reads the session straight from local storage — no network — so a user who
// has signed in at least once can keep using the app while offline.
export async function getCachedSession() {
  if (!supabaseClient) return null;
  try {
    const { data } = await supabaseClient.auth.getSession();
    return data?.session ?? null;
  } catch (error) {
    console.warn("Could not read cached session", error);
    return null;
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
    const { data, error } = await supabaseClient.auth.getSession();
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
