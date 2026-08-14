// Boot: work out whether there is a project, a session and a library, and show
// the right screen.
//
// Order matters here. Storage has to be open before any deck can be read, and
// the escaped-math repair has to run before a deck can be opened — it used to
// run at module scope, which after the move to IndexedDB meant it ran against
// an empty cache, repaired nothing, and marked itself done forever.

import { showCard } from "./cards/card-view.js?v=__BUILD__";
import { explicitLogout, getCachedSession, setExplicitLogout } from "./cloud/auth.js?v=__BUILD__";
import { PENDING_STYLE_KEY } from "./cloud/style-sync.js?v=__BUILD__";
import { initSupabaseClient, isSignedIn, loadSupabaseConfig, setSignedIn, supabaseClient, waitForSupabaseLibrary } from "./cloud/supabase-client.js?v=__BUILD__";
import { deckStorageKey, themeStorageKey } from "./core/constants.js?v=__BUILD__";
import { warmDeferredLibraries } from "./core/lib-loader.js?v=__BUILD__";
import { pruneOrphanedDeckSnapshots, runEscapedMathRepair } from "./library/local-library.js?v=__BUILD__";
import { checkProjectHealth, state } from "./main.js?v=__BUILD__";
import { discardNotesEditingForDeckSwap } from "./notes/notes-view.js?v=__BUILD__";
import { installManifestLink, markUpdateAvailableInMenu, registerServiceWorker } from "./pwa/service-worker-client.js?v=__BUILD__";
import { clearBrowserPersistence } from "./storage/deck-snapshot.js?v=__BUILD__";
import { clearAllDeckSnapshots, initDeckStorage, requestPersistentStorage } from "./storage/deck-store.js?v=__BUILD__";
import { LAST_BG_SYNC_PROBLEM_KEY, LAST_GLOBAL_SYNC_ERROR_KEY, LAST_GLOBAL_SYNC_KEY, LOCAL_DECKS_INDEX_KEY, LOCAL_DECK_TOMBSTONES_KEY, MISSING_DECK_WATCH_KEY, reportBackgroundSyncProblem } from "./storage/keys.js?v=__BUILD__";
import { refreshSyncIndicatorBaseline, setSyncIndicator } from "./sync/indicator.js?v=__BUILD__";
import { reconcileAllDecks } from "./sync/reconcile.js?v=__BUILD__";
import { showAuthenticatedUI, showLibraryFailedScreen, showLoginScreen, showSetupScreen } from "./ui/boot-screens.js?v=__BUILD__";
import { setStatus, showToast } from "./ui/feedback.js?v=__BUILD__";
import { applyActiveStyleSettings, loadLocalStyleSettings, setStyleProfiles, setStyleStatus } from "./ui/style-settings.js?v=__BUILD__";
import { renderThemeMenu, setTheme } from "./ui/theme.js?v=__BUILD__";

export let appInitialized = false;

// Setter: an imported binding is read-only, and the setup-screen retry path in main.js marks the app started.
export function setAppInitialized(value) {
  appInitialized = value;
}

export function initAppForUser() {
  clearBrowserPersistence();
  setStyleProfiles(loadLocalStyleSettings());
  applyActiveStyleSettings({ force: true });
  renderThemeMenu();
  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem(themeStorageKey);
  } catch (error) {
    console.warn("Could not read saved theme", error);
  }
  setTheme(savedTheme || "dark-amoled");
  setStatus("");
  // Start on a clean home screen each load — the last-open deck is no longer
  // auto-restored (only credentials, the saved "My Decks" library, and styles persist).
  showCard();
  setStyleStatus("Local style");
  installManifestLink();
  registerServiceWorker();
  // One-time-per-boot cleanup of snapshots orphaned by a since-fixed race in
  // pullCloudDeckToLibrary (concurrent tabs reconciling the same cloud deck
  // could each mint a different local id; the loser's snapshot was never
  // referenced by the index again and leaked in storage forever). Safe to
  // run regardless of connectivity — it only looks at already-persisted data.
  pruneOrphanedDeckSnapshots().catch((error) => console.warn("Could not prune orphaned deck snapshots", error));
  // Mirror every cloud deck onto this device (and push anything newer locally)
  // so the PWA has a full, up-to-date offline library. Runs in the background.
  if (navigator.onLine) {
    setTimeout(() => reconcileAllDecks({ explicit: false }), 1200);
    // Once per account, well after the sync has had its turn. A project that
    // never had supabase_setup.sql fully applied otherwise announces itself only
    // as things quietly not working — and the person who would have to fix it is
    // the same person who is about to conclude the app is broken.
    setTimeout(() => announceProjectHealthOnce(), 6000);
  }
}

// The health check as a background nudge rather than a screen the user has to
// go and find. Runs once per account per project: the answer only changes when
// somebody runs SQL, so repeating it on every launch would be a network call
// that exists to say the same thing forever.
export const HEALTH_CHECKED_KEY = "recall:projectHealthCheckedFor";

export async function announceProjectHealthOnce() {
  let marker = null;
  const config = loadSupabaseConfig();
  const userId = (() => {
    try { return localStorage.getItem(LAST_USER_STORAGE_KEY); } catch { return null; }
  })();
  if (!config?.url || !userId) return;
  const signature = `${config.url}::${userId}`;
  try { marker = localStorage.getItem(HEALTH_CHECKED_KEY); } catch (_) {}
  if (marker === signature) return;

  let results;
  try {
    results = await checkProjectHealth();
  } catch (error) {
    console.warn("Background project health check failed", error);
    return;
  }
  // Don't remember a run that couldn't reach the project — it proved nothing,
  // and marking it done would suppress the real check forever.
  if (results.some((r) => r.status === "skip")) return;
  if (results.length === 1 && results[0].status === "fail") return;

  try { localStorage.setItem(HEALTH_CHECKED_KEY, signature); } catch (_) {}

  const broken = results.filter((r) => r.status === "fail" || r.status === "warn");
  if (!broken.length) return;
  showToast(
    `Your Supabase project needs attention — ${broken[0].label.toLowerCase()}. See ☰ → App Info.`,
    "error"
  );
  markUpdateAvailableInMenu();
}

// The on-device deck library is a mirror of ONE account's cloud data. If a
// different account signs in on this device, the previous user's local decks
// must not survive — the next reconcile would push them straight into the new
// account's cloud (and the old tombstones would suppress the new user's own
// decks). The previous user's data is safe in their own cloud account.
export const LAST_USER_STORAGE_KEY = "flashcards_last_user_id";

export async function ensureLocalLibraryOwner(userId) {
  if (!userId) return;
  try {
    const previous = localStorage.getItem(LAST_USER_STORAGE_KEY);
    if (previous && previous !== String(userId)) {
      await clearAllDeckSnapshots();
      localStorage.removeItem(LOCAL_DECKS_INDEX_KEY);
      localStorage.removeItem(LOCAL_DECK_TOMBSTONES_KEY);
      // Observations about the previous account's decks say nothing about this
      // one's, and a stale entry is a head start toward deleting a deck.
      localStorage.removeItem(MISSING_DECK_WATCH_KEY);
      localStorage.removeItem(LAST_GLOBAL_SYNC_KEY);
      localStorage.removeItem(LAST_GLOBAL_SYNC_ERROR_KEY);
      localStorage.removeItem(LAST_BG_SYNC_PROBLEM_KEY);
      // Unscoped, unlike the quick-note queues, so it would be replayed by
      // whoever signs in next — uploading one account's style into another's
      // row on a shared device.
      localStorage.removeItem(PENDING_STYLE_KEY);
      localStorage.removeItem(deckStorageKey);
      // Persisted state was cleared but the OPEN DECK was not: state.deckId,
      // masterCards and notes survived the switch in memory, so the next
      // autosave filed the previous account's deck into this one's library and
      // the next reconcile pushed it to their cloud.
      state.localDeckId = null;
      state.deckId = null;
      state.masterCards = [];
      // Nothing repaints on this path, so the setViewMode net never runs — the
      // raw editor would sit there still holding the PREVIOUS account's note,
      // ready to be typed back into whatever this account opens first.
      discardNotesEditingForDeckSwap();
      state.notes = "";
      console.log("Cleared local deck library — different account signed in.");
    }
    localStorage.setItem(LAST_USER_STORAGE_KEY, String(userId));
  } catch (error) {
    console.warn("Could not verify local library owner", error);
  }
}

// The other half of the offline-SIGNED_OUT forgiveness in setupAuthListener.
// Being lenient about a refresh that failed with no network is only correct if
// something tries again once there IS a network — otherwise `isSignedIn` stays
// false, autoSyncTick and reconcileAllDecks both bail on it without a word, and
// the app goes on looking signed in while never syncing again until a reload.
// That is the shape of "sync just stopped working" for a phone that spent a
// week in a pocket.
export let sessionRecoveryInFlight = false;

export async function recoverSessionIfPossible() {
  if (sessionRecoveryInFlight) return;
  if (isSignedIn || !supabaseClient || !navigator.onLine) return;
  if (!loadSupabaseConfig()) return;
  sessionRecoveryInFlight = true;
  try {
    // getSession() refreshes an expired access token when the refresh token is
    // still good, which is exactly the case this exists for.
    const session = await getCachedSession();
    if (session?.user) {
      setSignedIn(true);
      await ensureLocalLibraryOwner(session.user.id);
      showAuthenticatedUI();
      if (!appInitialized) {
        setAppInitialized(true);
        initAppForUser();
      }
      refreshSyncIndicatorBaseline();
      return;
    }
    // Genuinely signed out, and now demonstrably online — so say so instead of
    // leaving the app in a state that looks signed in and syncs nothing.
    if (!document.getElementById("loginOverlay")?.hidden) return; // already there
    setSyncIndicator("signedout");
    reportBackgroundSyncProblem(
      "signed-out",
      "Signed out — sign in again to resume syncing. Your decks are safe on this device."
    );
  } catch (error) {
    console.warn("Session recovery attempt failed", error);
  } finally {
    sessionRecoveryInFlight = false;
  }
}

export let authListenerSubscription = null;

export function setupAuthListener() {
  if (authListenerSubscription) {
    authListenerSubscription.unsubscribe();
    authListenerSubscription = null;
  }
  const { data } = supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (session?.user) {
      setSignedIn(true);
      await ensureLocalLibraryOwner(session.user.id);
      showAuthenticatedUI();
      if (!appInitialized) {
        setAppInitialized(true);
        initAppForUser();
      }
    } else if (event === "SIGNED_OUT") {
      setSignedIn(false);
      const wasExplicit = explicitLogout;
      // Reset unconditionally. It used to be cleared only past the offline
      // guard below, so one sign-out attempt made while offline left it true for
      // the life of the page — and the next failed refresh, which should have
      // been forgiven, then threw the user out of their offline decks.
      setExplicitLogout(false);
      // Only drop to the login screen for a real sign-out. A failed token
      // refresh while offline also emits SIGNED_OUT — ignore it so the user
      // isn't locked out of their offline decks. recoverSessionIfPossible()
      // picks this back up when the connection returns; without it the session
      // stayed dead and every subsequent sync no-opped in silence.
      if (!wasExplicit && !navigator.onLine) return;
      setAppInitialized(false);
      showLoginScreen();
    }
  });
  authListenerSubscription = data.subscription;
}

export async function bootApp() {
  // Before anything reads a deck: set up the IndexedDB-backed deck store
  // (and migrate any pre-existing localStorage snapshots into it) so every
  // downstream readDeckSnapshot/writeDeckSnapshot call sees a consistent
  // picture from the very first render. requestPersistentStorage is
  // best-effort and doesn't need to block boot; the math repair DOES need to
  // finish before any deck can be opened, so it's awaited.
  await initDeckStorage();
  requestPersistentStorage();
  await runEscapedMathRepair();

  let status = initSupabaseClient();

  // A configured device whose library didn't arrive gets one patient retry
  // before being told anything: the script is a blocking tag, so if it is merely
  // slow rather than blocked it will land within this window.
  if (status === "no-library" && loadSupabaseConfig()) {
    if (await waitForSupabaseLibrary()) status = initSupabaseClient();
  }

  if (status === "no-config") {
    showSetupScreen();
    return;
  }
  if (status !== "ok") {
    // Deliberately NOT the setup screen. See initSupabaseClient.
    showLibraryFailedScreen();
    return;
  }

  setupAuthListener();

  // Use the cached session (local, no network) so offline / flaky-network loads
  // still let a signed-in user reach their decks instead of the login wall.
  const session = await getCachedSession();
  if (session?.user) {
    setSignedIn(true);
    await ensureLocalLibraryOwner(session.user.id);
    showAuthenticatedUI();
    if (!appInitialized) {
      setAppInitialized(true);
      initAppForUser();
    }
    // Only on the signed-in path: the setup, library-failed and login screens
    // have no diagrams to draw, no archives to write and nothing to paste into.
    warmDeferredLibraries();
  } else {
    showLoginScreen();
  }
}
