// Boot: work out whether there is a project, a session and a library, and show
// the right screen.
//
// Order matters here. Storage has to be open before any deck can be read, and
// the escaped-math repair has to run before a deck can be opened — it used to
// run at module scope, which after the move to IndexedDB meant it ran against
// an empty cache, repaired nothing, and marked itself done forever.

import { showCard } from "./cards/card-view.js?v=__BUILD__";
import { explicitLogout, getCachedSession, getSessionOutcome, setExplicitLogout } from "./cloud/auth.js?v=__BUILD__";
import { forgetSignedUrls } from "./cloud/storage-urls.js?v=__BUILD__";
import { PENDING_STYLE_KEY } from "./cloud/style-sync.js?v=__BUILD__";
import { initSupabaseClient, isSignedIn, loadSupabaseConfig, setSignedIn, setSigningPending, supabaseClient, waitForSupabaseLibrary } from "./cloud/supabase-client.js?v=__BUILD__";
import { deckStorageKey, themeStorageKey } from "./core/constants.js?v=__BUILD__";
import { warmDeferredLibraries } from "./core/lib-loader.js?v=__BUILD__";
import { state } from "./core/state.js?v=__BUILD__";
import { discardIndexBatch, pruneOrphanedDeckSnapshots, readLocalDeckIndex, runEscapedMathRepair } from "./library/local-library.js?v=__BUILD__";
import { discardNotesEditingForDeckSwap } from "./notes/notes-view.js?v=__BUILD__";
import { forgetAllReadingPositions } from "./notes/reading-position.js?v=__BUILD__";
import { checkProjectHealth } from "./pwa/app-info.js?v=__BUILD__";
import { updateOnlineIndicator } from "./pwa/online.js?v=__BUILD__";
import { installManifestLink, markUpdateAvailableInMenu, registerServiceWorker } from "./pwa/service-worker-client.js?v=__BUILD__";
import { clearBrowserPersistence } from "./storage/deck-snapshot.js?v=__BUILD__";
import { clearAllDeckSnapshots, initDeckStorage, requestPersistentStorage } from "./storage/deck-store.js?v=__BUILD__";
import { LAST_BG_SYNC_PROBLEM_KEY, LAST_GLOBAL_SYNC_ERROR_KEY, LAST_GLOBAL_SYNC_KEY, LOCAL_DECKS_INDEX_KEY, LOCAL_DECK_TOMBSTONES_KEY, MISSING_DECK_WATCH_KEY, reportBackgroundSyncProblem } from "./storage/keys.js?v=__BUILD__";
import { refreshSyncIndicatorBaseline, setSignedOutChip, setSyncIndicator } from "./sync/indicator.js?v=__BUILD__";
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

// Every trace of the on-device library: the snapshots, the index, and each
// piece of bookkeeping that only means anything ALONGSIDE that library.
//
// Extracted rather than written twice. The two callers — an account switch and
// an explicit sign-out — must remove exactly the same things, and the failure
// mode of them drifting is silent and delayed: a leftover tombstone suppresses
// a deck the next account legitimately owns, a leftover missing-deck
// observation is a head start toward deleting one, and a leftover deck body in
// memory gets filed into whichever library is open next.
//
// Deliberately NOT touched: the Supabase config, the saved style, the theme,
// and the image outbox. None of them is deck data — and on a sign-out the user
// is very often about to sign straight back into the same project.
export async function resetLocalLibrary() {
  await clearAllDeckSnapshots();
  // Before the removal, not after: a sync in flight may be holding a batched
  // copy of the index in memory, and flushing it afterwards would write the
  // previous account's library straight back over this.
  discardIndexBatch();
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
  // Reading positions describe the decks that were just removed, and each one
  // carries a snippet of the note's own text.
  forgetAllReadingPositions();
  // A signed storage URL is a bearer token for one account's private objects,
  // and the bag survives a reload by design (see SIGNED_URL_CACHE_KEY). Leaving
  // it behind on an account switch or a sign-out would leave the previous
  // account's figures and papers readable to whoever signs in next — which is
  // what forgetSignedUrls was written for, and it had no caller.
  forgetSignedUrls();
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
}

// Returns whether it actually cleared the library. The caller needs to know
// because the check no longer always runs before the app is on screen: the
// offline-first boot path opens the library first and confirms the account
// behind it, so a reset can now happen with the previous account's decks
// already painted, and nothing else repaints on this path.
export async function ensureLocalLibraryOwner(userId) {
  if (!userId) return false;
  try {
    const previous = localStorage.getItem(LAST_USER_STORAGE_KEY);
    if (previous && previous !== String(userId)) {
      await resetLocalLibrary();
      console.log("Cleared local deck library — different account signed in.");
      localStorage.setItem(LAST_USER_STORAGE_KEY, String(userId));
      return true;
    }
    localStorage.setItem(LAST_USER_STORAGE_KEY, String(userId));
  } catch (error) {
    console.warn("Could not verify local library owner", error);
  }
  return false;
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
      setSignedOutChip(false);
      refreshSyncIndicatorBaseline();
      return;
    }
    // Genuinely signed out, and now demonstrably online — so say so instead of
    // leaving the app in a state that looks signed in and syncs nothing.
    if (!document.getElementById("loginOverlay")?.hidden) return; // already there
    setSignedOutChip(true);
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
      setSignedOutChip(false);
    } else if (event === "SIGNED_OUT") {
      setSignedIn(false);
      const wasExplicit = explicitLogout;
      // Reset unconditionally. It used to be cleared only past the offline
      // guard below, so one sign-out attempt made while offline left it true for
      // the life of the page — and the next failed refresh, which should have
      // been forgiven, then threw the user out of their offline decks.
      setExplicitLogout(false);
      // Only drop to the login screen for a real sign-out.
      //
      // supabase-js emits SIGNED_OUT for a failed token refresh too, and not
      // only when offline: a refresh token that was rotated out from under this
      // tab ("Already Used" — two tabs, or a resumed PWA racing itself), a
      // project that was briefly unreachable, a captive portal. Every one of
      // those used to land the user on the login wall while online, holding a
      // device full of their own decks. That is a network hiccup, not a
      // sign-out, and it is the whole of "why does it keep asking me to log in".
      //
      // So the wall is now reserved for the two cases that mean it: the user
      // pressed Sign out, or there is nothing on this device to show them
      // anyway. recoverSessionIfPossible() retries the rest on the next
      // `online` event, and the sync pill says the sync is paused meanwhile.
      if (!wasExplicit && hasUsableLocalLibrary()) {
        setSignedOutChip(true);
        setSyncIndicator(navigator.onLine ? "signedout" : "offline");
        return;
      }
      if (!wasExplicit && !navigator.onLine) return;
      setAppInitialized(false);
      showLoginScreen();
    }
  });
  authListenerSubscription = data.subscription;
}

// Is there a full local library belonging to a known account on this device?
//
// The three conditions together are what make it safe to open the app before
// the cloud has been consulted at all: a configured project, a recorded owner
// (so ensureLocalLibraryOwner has something to compare against later), and
// decks actually on disk. Without any one of them there is nothing to show
// early and the ordinary sign-in path is the right answer.
export function hasUsableLocalLibrary() {
  try {
    if (!loadSupabaseConfig()) return false;
    if (!localStorage.getItem(LAST_USER_STORAGE_KEY)) return false;
    return readLocalDeckIndex().length > 0;
  } catch (error) {
    console.warn("Could not check for a local library", error);
    return false;
  }
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
  // Painted as part of the first screen rather than only when connectivity
  // CHANGES, which is all the online/offline listeners can tell us. A launch
  // that was already offline used to show no indicator at all — the one launch
  // where saying so matters most.
  updateOnlineIndicator();

  let status = initSupabaseClient();

  // A configured device whose library didn't arrive gets one patient retry
  // before being told anything: the script is a blocking tag, so if it is merely
  // slow rather than blocked it will land within this window.
  //
  // Skipped when offline. The wait can only be rewarded by a request completing,
  // and there is no request to complete — so offline it was eight seconds of
  // blank screen bought for certain and paid for nothing. (Since the library was
  // vendored it is same-origin and precached, so reaching here at all now means
  // something is genuinely wrong rather than merely slow.)
  if (status === "no-library" && loadSupabaseConfig() && navigator.onLine) {
    if (await waitForSupabaseLibrary()) status = initSupabaseClient();
  }

  if (status === "no-config") {
    setSigningPending(false);
    showSetupScreen();
    return;
  }
  if (status !== "ok") {
    // A device that cannot build a client can still READ. The decks are in
    // IndexedDB on this machine and need nothing from Supabase to be opened,
    // studied or edited, so telling someone with a full library that the app
    // is unavailable — which is what this screen amounts to — is simply untrue.
    // The wall is now only for the case it describes: no client AND nothing
    // local to fall back on.
    // No client means no signature is ever coming for this launch, so the
    // images in those decks should be judged on what the worker's cache can
    // actually answer rather than left waiting on an answer that cannot arrive
    // (see the signing-state block in cloud/supabase-client.js).
    setSigningPending(false);
    if (hasUsableLocalLibrary()) {
      openLocalLibraryOffline();
      return;
    }
    // Deliberately NOT the setup screen. See initSupabaseClient.
    showLibraryFailedScreen();
    return;
  }

  setupAuthListener();

  // ── Local first, cloud second ──────────────────────────────────────────
  // The session check below can take seconds (getCachedSession refreshes an
  // expired token over the network), and it used to be awaited with NOTHING on
  // screen — so a lapsed token on a slow connection was a blank page for as
  // long as it took, and a hung one was a blank page forever.
  //
  // Nothing about opening this device's own decks depends on the answer. So
  // open them now, and let the session confirm itself behind the app. The only
  // thing the deferred answer can still do is send the user to the login
  // screen, and only when it is certain — see confirmSessionInBackground.
  if (hasUsableLocalLibrary()) {
    openLocalLibraryOffline();
    confirmSessionInBackground();
    return;
  }

  // No local library to show: the session answer is the only thing that can
  // decide this screen, so it is worth waiting for. Bounded now (see
  // getCachedSession), so the wait cannot be unbounded even here.
  const { status: sessionStatus, session } = await getSessionOutcome();
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
    return;
  }
  // No decks on this device yet, so there is not much to open — but a
  // remembered sign-in that merely could not be refreshed is still not a reason
  // to demand the password. Open the app, mark sync as paused, and let the
  // recovery path bring the session back when the network does.
  if (sessionStatus !== "signed-out") {
    setSigningPending(false);
    openLocalLibraryOffline();
    setSignedOutChip(true);
    setSyncIndicator(navigator.onLine ? "signedout" : "offline");
    return;
  }
  setSigningPending(false);
  showLoginScreen();
}

// Open this device's library immediately, without having confirmed anything
// with the cloud.
//
// Deliberately read-WRITE. Every edit already goes to IndexedDB first and is
// carried to the cloud later by the dirty flags and the pending queues, so a
// read-only mode would forbid something the app is built to do — and would do
// it at the one moment (a plane, a tunnel, a dead cell) when someone most wants
// to sit and read their notes. Nothing here can push: reconcileAllDecks bails
// on `isSignedIn`, which stays false until a session is actually verified.
export function openLocalLibraryOffline() {
  showAuthenticatedUI();
  if (!appInitialized) {
    setAppInitialized(true);
    initAppForUser();
  }
  warmDeferredLibraries();
}

// Settle the session after the app is already usable.
//
// Three outcomes, and the difference between the last two is the whole reason
// this is not just `await`ed inline:
//
//   • a session          -> mark signed in, verify the library's owner, sync
//   • no session, offline -> say nothing, change nothing
//   • no session, online  -> mark sync paused and say so on the pill
//
// The last one used to show the login screen, and that is the bug behind "it
// makes me sign in every time I open it". By the time this runs the user's
// whole library is already open in front of them, out of IndexedDB, needing
// nothing from the cloud — so the only thing an empty session answer can
// truthfully report is that SYNCING stopped. It never means the reader has to
// re-authenticate to keep reading. recoverSessionIfPossible() retries on the
// next `online` event and on every resume, and the pill is a sign-in button
// for whenever the user does want the cloud back.
export async function confirmSessionInBackground() {
  let outcome = { status: "unknown", session: null };
  try {
    outcome = await getSessionOutcome();
  } catch (error) {
    console.warn("Background session check failed", error);
    // Answered, in the only way that matters to anything waiting on it: no
    // session is coming out of this launch.
    setSigningPending(false);
    return;
  }
  const session = outcome.session;

  if (session?.user) {
    setSignedIn(true);
    setSignedOutChip(false);
    // A different account: the library on screen was just wiped out from under
    // the view, so repaint before anything can be clicked on a deck that no
    // longer exists.
    if (await ensureLocalLibraryOwner(session.user.id)) showCard();
    refreshSyncIndicatorBaseline();
    // initAppForUser only schedules a sync when it runs while online AND the
    // session was already known, which on this path it was not — so ask for one
    // here rather than leaving the first sync until the auto-sync deadline.
    if (navigator.onLine) setTimeout(() => reconcileAllDecks({ explicit: false }), 1200);
    return;
  }

  if (!navigator.onLine) {
    setSigningPending(false);
    setSyncIndicator("offline");
    return;
  }

  // Online, without a usable session — either the refresh could not be
  // completed (a captive portal, a project that was asleep, a refresh token
  // rotated out from under this tab) or the stored session is genuinely gone.
  //
  // Neither one is grounds for a password prompt HERE. This function only runs
  // on the path where the device already has a full local library open on
  // screen, and every deck on it can be read, studied and edited with no cloud
  // at all. Walling that off asks the user to authenticate for something they
  // are not doing. What actually stopped is syncing, so that is what gets said:
  // the pill reads "Signed out · tap to sign in" and is itself the way back in
  // (see the syncIndicator click handler), for whenever they want it.
  setSignedIn(false);
  setSignedOutChip(true);
  setSyncIndicator("signedout");
  reportBackgroundSyncProblem(
    "signed-out",
    "Signed out — sign in again to resume syncing. Your decks are safe on this device."
  );
}
