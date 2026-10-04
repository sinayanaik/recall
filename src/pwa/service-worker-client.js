// Registering the service worker, warming the image cache, and the update
// banner.
//
// Deliberately unregistered on localhost: a cache-first worker there masks
// every edit behind the previously cached bundle.

import { canReachS3 } from "../cloud/s3-config.js?v=__BUILD__";
import { canSignStorageUrls, resolveImageUrls } from "../cloud/storage-urls.js?v=__BUILD__";
import { BUILD_STAMP } from "../core/build.js?v=__BUILD__";
import { fetchLiveRelease, requestedAppVersion } from "./release-info.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { isHomeVisible, onHomeShown } from "../ui/home-state.js?v=__BUILD__";

// Every Supabase Storage image URL referenced by a deck's markdown. Used to
// pre-cache a pulled deck's images so it reads offline later — the service
// worker's cache-first rule only covers images it has already SEEN, which means
// only the ones that happened to be on screen while online.
export const SUPABASE_IMAGE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/[^\s)"'<>]+/gi;

export function collectDeckImageUrls(snapshot) {
  const seen = new Set();
  const scan = (text) => {
    for (const match of String(text || "").matchAll(SUPABASE_IMAGE_URL_PATTERN)) seen.add(match[0]);
  };
  scan(snapshot?.notes);
  for (const card of snapshot?.cards || []) {
    scan(card.question);
    scan(card.answer);
  }
  // A PDF deck's image and text blocks hold figures of their own, which a note
  // scan never sees.
  for (const block of Array.isArray(snapshot?.meta?.pdfBlocks) ? snapshot.meta.pdfBlocks : []) {
    scan(block?.src);
    scan(block?.md);
  }
  return Array.from(seen);
}

// Hand a deck's image URLs to the service worker to warm its image cache.
// Fire-and-forget: this is an optimisation, and a controller that isn't ready
// yet (first load, before the SW has claimed the page) just means the images
// get cached the normal way — on first view, while online.
//
// SIGNED, not canonical. The markdown holds `/object/public/…` URLs and that is
// what the scan above finds, but both buckets are private: the worker fetches
// whatever it is handed, and a public URL is a 400 it will not cache. So this
// message did nothing at all from the day the buckets were locked down —
// silently, because the whole path is best-effort and swallows failures. That
// is not a missed optimisation, it is the reason a deck could arrive by sync
// with none of its pictures: nothing warmed them, so every image in it had to
// be fetched live at render time, and any hiccup there (a session still being
// confirmed, a dropped connection) left a broken-image placeholder with no
// cached copy behind it to fall back on.
//
// The worker needs no change — imageCacheKey already stores a signed response
// under its canonical key, which is what the offline fallback later asks for.
export async function warmDeckImageCache(snapshot) {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
  const urls = collectDeckImageUrls(snapshot);
  if (!urls.length) return;
  // Nothing signable means nothing fetchable. Skip rather than post URLs that
  // are certain to 400 — the next pull, or the render, warms them instead. The
  // reader's bucket counts: its URLs are signed on this device, no session
  // needed, and the worker files what they fetch under the canonical key.
  if (!canSignStorageUrls() && !(canReachS3() && navigator.onLine !== false)) return;
  try {
    // Batched and cached inside signedUrlsFor, so a pull of many decks that
    // share images pays for each signature once.
    const resolved = await resolveImageUrls(urls);
    const fetchable = urls.map((url) => resolved.get(url)).filter(Boolean);
    if (!fetchable.length) return;
    // Re-read: signing is a round trip, and a controller can be replaced by an
    // update taking over while it is in flight.
    navigator.serviceWorker.controller?.postMessage({ type: "cache-images", urls: fetchable });
  } catch (error) {
    console.warn("Could not warm the image cache", error);
  }
}

export let serviceWorkerRegistered = false;

// Kept so the App Info modal's "Check for updates" can poke the worker on
// demand (see refreshAppInfo).
export let serviceWorkerRegistration = null;

// ── Update state, shared with the App Info modal ────────────────────────────
// True once a newer worker has installed and is waiting to take over.
export let updateIsWaiting = false;

// True once an install has been discarded before taking over — a release that
// could not be downloaded. Distinct from "no update": the difference decides
// whether the honest answer is "you're up to date" or "an update exists and
// this device keeps failing to get it".
export let updateDownloadFailed = false;

// Set by the service worker when it had to serve one release's bytes under
// another release's URL (see announceMixedBuild in sw.js). Holds the URLs it
// happened to, because the App Info screen otherwise CANNOT detect this: it
// reads the ?v= off the <script> attribute, which is the URL that was
// requested, not the bundle that actually ran.
export const mixedBuildUrls = new Set();

export function isMixedBuild() {
  if (mixedBuildUrls.size > 0) return true;
  // Self-detection, for the load where the worker's message never arrived: if
  // the URL this file was fetched from carries a different stamp than the one
  // compiled into it, the bytes running now are not the bytes that URL names.
  const requested = requestedAppVersion();
  return Boolean(requested && requested !== BUILD_STAMP);
}

export let updateBannerEl = null;

// A persistent, dismissible bar — deliberately not a toast. A toast for "your
// app is out of date" is a message that disappears before it can be acted on,
// which is how everyone stayed on the old release while the app believed it had
// told them.
export function showUpdateBanner() {
  updateIsWaiting = true;
  updateDownloadFailed = false;
  markUpdateAvailableInMenu();
  if (updateBannerEl) return;

  updateBannerEl = document.createElement("div");
  updateBannerEl.className = "update-banner";
  updateBannerEl.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "update-banner-text";
  text.textContent = "A new version of Recall is ready.";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "update-banner-action";
  reload.textContent = "Reload";
  // The one way an update is applied — the same function the App Info modal's
  // button calls. See applyUpdate for why a plain reload could not do this.
  reload.addEventListener("click", () => applyUpdate({ button: reload }));

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "update-banner-dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => {
    updateBannerEl?.remove();
    updateBannerEl = null;
    // The dot in the menu deliberately stays: dismissing the bar means "not
    // now", not "pretend this build is current".
  });

  updateBannerEl.append(text, reload, dismiss);
  document.body.appendChild(updateBannerEl);
}

export function setUpdateFailedHint() {
  // Only meaningful if nothing is waiting — a redundant worker that was simply
  // superseded by a newer one is not a failure.
  if (updateIsWaiting) return;
  updateDownloadFailed = true;
  markUpdateAvailableInMenu();
}

// A dot on the hamburger button, which is the one control always on screen.
// The App Info modal is behind it, so this is what makes the modal findable at
// the moment it has something to say.
export function markUpdateAvailableInMenu() {
  document.getElementById("mobileMenuBtn")?.classList.add("has-update");
  document.getElementById("appInfoBtn")?.classList.add("has-update");
}

// ── Applying an update ──────────────────────────────────────────────────────
//
// Both Reload buttons (the banner and the App Info modal) used to end in a bare
// location.reload(), and that is why pressing them so often did nothing. The
// modal says "Update available" the moment the SERVER has a newer index.html,
// which is usually well before this device's new worker has finished
// downloading its ~170 files. A reload in that window is answered by the OLD
// worker, whose fetch handler deliberately refuses newer HTML it has no
// matching bundle for (htmlMatchesThisRelease in sw.js) and serves its cached
// shell instead. So the page came back on the version it left, every time,
// until the background install happened to finish — and if that install kept
// failing on a poor connection, forever.
//
// applyUpdate carries a press all the way through instead: it finds out what
// the server is serving, waits for the new worker to install and take control
// (asking it to, if it is waiting), and only then reloads. When no worker can
// be brought to take over — the install failed, or stalled past its budget — it
// unregisters the worker and drops the versioned shell cache, so the reload
// comes straight from the network. Nothing the user owns lives in those
// caches: decks are in IndexedDB, and the image, vendor, CDN and share-target
// caches are spared by name exactly as the worker's own activate sweep spares
// them. The fresh page registers a new worker, which restores offline support.

// Set while a press (or a silent auto-apply) is being carried through, so the
// controllerchange handler leaves the reload to applyUpdate.
let updateInProgress = false;

// A newer worker took control of this page during its lifetime, but the page
// itself was not reloaded (a deck was open). The page is the old release; the
// next reload, served by the worker now in control, is the new one.
let controllerReplaced = false;

const UPDATE_RELOAD_AT_KEY = "recall:updateReloadAt";
// The stamp a press was trying to reach, and the one it was leaving. Read back
// by the page that loads next, which is how a reload that STILL landed on the
// old build gets noticed. "Left the old build" is the test rather than "reached
// the target": a deploy landing in between moves the target, not the outcome.
const UPDATE_TARGET_KEY = "recall:updateTarget";
const UPDATE_FROM_KEY = "recall:updateFrom";
// Set once the network-only fallback has been tried for that target, so a
// device that cannot get the new build is told so instead of reload-looping.
const UPDATE_HARD_TRIED_KEY = "recall:updateHardTried";

// How long a press waits for the new worker before falling back. Installing
// is the slow case — the whole app shell over whatever connection this is.
const UPDATE_INSTALL_BUDGET_MS = 45_000;
const UPDATE_ACTIVATE_BUDGET_MS = 8_000;

// The caches a release owns, and only those. Everything else is addressed by
// URLs that carry their own version, and is spared for the reasons sw.js's
// activate handler gives.
const SPARED_CACHES = new Set(["recall-images-v1", "recall-vendor-v1", "recall-cdn-v1", "recall-share-target-v1"]);

function readSession(key) {
  try { return sessionStorage.getItem(key); } catch (_) { return null; }
}

function writeSession(key, value) {
  try { sessionStorage.setItem(key, String(value)); } catch (_) { /* private mode — best effort */ }
}

function clearSession(key) {
  try { sessionStorage.removeItem(key); } catch (_) { /* nothing to clear */ }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reloadedRecently() {
  return Date.now() - (Number(readSession(UPDATE_RELOAD_AT_KEY)) || 0) < 60_000;
}

// Reload, marking the reload as ours so the controllerchange guard does not
// mistake it for the user's own and so the next page can check where it landed.
function reloadIntoUpdate(target) {
  writeSession(UPDATE_RELOAD_AT_KEY, Date.now());
  if (target) {
    writeSession(UPDATE_TARGET_KEY, target);
    writeSession(UPDATE_FROM_KEY, BUILD_STAMP);
  }
  location.reload();
}

// Is reloading right now free? Only when the reader is on the home screen, with
// nothing half-typed and no dialog or import in progress. Every launch starts
// on home anyway (see clearBrowserPersistence), and the open deck — if home was
// opened over one — has already been saved by the pagehide flush. Anywhere
// else, a reload would throw the reader out of what they are reading.
export function isSafeToAutoReload() {
  if (!isHomeVisible()) return false;
  const active = document.activeElement;
  if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return false;
  if (document.getElementById("importPanel")?.classList.contains("is-open")) return false;
  for (const id of ["confirmModal", "promptModal"]) {
    if (document.getElementById(id)?.hidden === false) return false;
  }
  return true;
}

// Hand control to the new worker and resolve once it has it. true: a newer
// worker now controls this page, so a reload lands on it. false: nothing to
// hand over to, or it could not be brought to take control within budget.
async function handOverToNewWorker() {
  if (!("serviceWorker" in navigator)) return false;
  let registration = serviceWorkerRegistration;
  if (!registration) {
    try { registration = await navigator.serviceWorker.getRegistration(); } catch (_) { registration = null; }
  }
  if (!registration) return false;

  // Listening before anything is asked of the worker, so a takeover that
  // happens fast is not missed.
  const controllerChanged = new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", () => resolve(true), { once: true });
  });

  let worker = registration.waiting || registration.installing;
  if (!worker) {
    // Nothing downloaded yet: ask for it now rather than waiting on the
    // 30-minute timer. update() resolves once sw.js has been fetched, and a
    // changed one is already "installing" by then.
    try { await Promise.race([registration.update(), waitMs(10_000)]); } catch (_) { /* offline, or sw.js 404 */ }
    worker = registration.waiting || registration.installing;
  }
  if (!worker) return false;

  const budget = worker.state === "installing" ? UPDATE_INSTALL_BUDGET_MS : UPDATE_ACTIVATE_BUDGET_MS;
  const settled = new Promise((resolve) => {
    const onState = () => {
      // The release's own install already asks to take over (skipWaiting in
      // sw.js); asking again covers a worker from before that, and one that is
      // sitting in "waiting" for any other reason.
      if (worker.state === "installed") {
        try { worker.postMessage({ type: "skip-waiting" }); } catch (_) { /* gone */ }
      } else if (worker.state === "activated") {
        resolve(true);
      } else if (worker.state === "redundant") {
        // Discarded: a failed download, or superseded by a newer one.
        resolve(false);
      }
    };
    worker.addEventListener("statechange", onState);
    onState();
  });
  return Promise.race([controllerChanged, settled, waitMs(budget).then(() => false)]);
}

// The fallback that does not depend on the worker cooperating: take it out of
// the way, drop the release's shell cache, and load from the network.
async function reloadFromNetwork(target) {
  writeSession(UPDATE_HARD_TRIED_KEY, target || "1");
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch (_) { /* nothing registered */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith("recall-") && !SPARED_CACHES.has(key))
      .map((key) => caches.delete(key)));
  } catch (_) { /* no Cache API */ }
  reloadIntoUpdate(target);
}

// `silent`: an automatic apply at a safe moment. It never asks the server what
// it is serving and never takes the network-only fallback — those are for a person
// who pressed a button and is waiting on the answer. If it cannot finish, the
// banner says so instead.
export async function applyUpdate({ button = null, silent = false } = {}) {
  if (updateInProgress) return;
  updateInProgress = true;
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Updating…";
  }
  const giveBack = () => {
    updateInProgress = false;
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  };

  try {
    if (silent) {
      if (reloadedRecently()) { giveBack(); showUpdateBanner(); return; }
      if (controllerReplaced || await handOverToNewWorker()) { reloadIntoUpdate(null); return; }
      giveBack();
      showUpdateBanner();
      return;
    }

    // What is the server serving? fetchLiveRelease is bounded (8s) and never
    // answered from a cache.
    let target = null;
    try { target = (await fetchLiveRelease())?.stamp || null; } catch (_) { target = null; }
    if (!target && navigator.onLine === false) {
      giveBack();
      showToast("You're offline — the update will install when you're back online", "info");
      return;
    }

    // Nothing newer exists: a plain reload is the whole answer (it also clears
    // a mixed build, which is the other thing these buttons are offered for).
    if (target && target === BUILD_STAMP && !updateIsWaiting && !controllerReplaced) {
      reloadIntoUpdate(null);
      return;
    }

    if (controllerReplaced || await handOverToNewWorker()) {
      reloadIntoUpdate(target);
      return;
    }

    // No worker could be brought to take over, yet the server has a newer
    // build. Go around the worker.
    if (target && target !== BUILD_STAMP) {
      if (button) button.textContent = "Reloading…";
      await reloadFromNetwork(target);
      return;
    }
    reloadIntoUpdate(target);
  } catch (error) {
    console.warn("Could not apply the update", error);
    giveBack();
    showToast("Couldn't finish the update — try again in a moment", "error");
  }
}

// Read on every launch: did the update a button was pressed for actually land?
// One network-only retry if it did not, then an honest message rather than a
// loop.
function verifyUpdateLanded() {
  const target = readSession(UPDATE_TARGET_KEY);
  if (!target) return;
  const from = readSession(UPDATE_FROM_KEY);
  const forget = () => {
    clearSession(UPDATE_TARGET_KEY);
    clearSession(UPDATE_FROM_KEY);
    clearSession(UPDATE_HARD_TRIED_KEY);
  };
  if (target === BUILD_STAMP || (from && from !== BUILD_STAMP)) {
    forget();
    showToast("Recall is up to date ✓", "success");
    return;
  }
  if (readSession(UPDATE_HARD_TRIED_KEY) || navigator.onLine === false) {
    forget();
    showToast("Couldn't switch to the new version yet — it will retry automatically", "error");
    markUpdateAvailableInMenu();
    return;
  }
  reloadFromNetwork(target);
}

export function registerServiceWorker() {
  if (serviceWorkerRegistered) return;
  if (!pwaAssetsSupported()) return;
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;

  // Never run the worker against a dev server. Versioned assets (app.js?v=…)
  // are cache-first and deliberately never revalidated — that is what makes a
  // release load instantly — but it also means an edit to app.js WITHOUT a new
  // ?v= is invisible forever: the browser keeps serving the bundle it cached
  // under that URL, so the page reloads into frozen code and the fix looks
  // broken. Fine for releases, useless while editing. Unregister anything a
  // previous visit left behind and drop its caches, so localhost always runs
  // the files on disk.
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    serviceWorkerRegistered = true;
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .then((unregistered) => caches.keys()
        // Only the versioned app shell. The image cache holds the user's
        // uploaded pictures and is spared here for the same reason the worker
        // spares it on every release — re-downloading them is pure waste. It
        // has to be named explicitly: it shares the "recall-" prefix, and back
        // when shell caches were "recall-v…" the prefix alone happened to
        // exclude it.
        .then((keys) => keys.filter((key) => key.startsWith("recall-") && key !== "recall-images-v1"))
        .then((stale) => Promise.all(stale.map((key) => caches.delete(key))).then(() => stale.length))
        .then((cleared) => {
          // Reload only when something was actually removed, so this settles
          // after one pass instead of looping. The page that reached here was
          // still being served by the worker, so it needs the reload to pick
          // up the files on disk.
          if (unregistered.some(Boolean) || cleared) location.reload();
        }))
      .catch((error) => console.warn("Could not unregister dev service worker", error));
    return;
  }

  serviceWorkerRegistered = true;
  // Ask the worker to re-fetch any offline asset its install failed to get.
  // The install's third-party precache is best-effort, so a first run on a bad
  // connection leaves the app permanently missing libraries offline — no
  // markdown, no formulas, no export — and nothing retried, because the cache
  // is only rebuilt when the worker's version changes. Sent once the worker is
  // in control, and again whenever the connection comes back, which is exactly
  // when the gap can be filled.
  const requestOfflineCacheRepair = () => {
    navigator.serviceWorker.ready
      .then((registration) => registration.active?.postMessage({ type: "repair-offline-cache" }))
      .catch(() => { /* no worker yet — the next online event tries again */ });
  };

  // The worker reporting that it served one release's bytes under another
  // release's URL. This is the only way the page can learn it is running a mixed
  // build — see mixedBuildUrls.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "mixed-build") return;
    const known = mixedBuildUrls.size > 0;
    mixedBuildUrls.add(String(event.data.url || ""));
    // Say it once. Repeating it per asset would be three toasts for one fault.
    if (!known) {
      showToast("Some of this app didn't load in the right version — reload when you can", "error");
      markUpdateAvailableInMenu();
    }
  });

  let hadController = Boolean(navigator.serviceWorker.controller);

  // A newer worker has taken over. Reload into it — but only when that is free.
  //
  // It used to reload unconditionally (bar two guards), on the grounds that a
  // toast saying "reload to finish" was read by nobody. But this repo publishes
  // on every push to main, and a reload is not free for a reader: every launch
  // starts on the home screen with no deck open, so a release landing while
  // somebody studied or read threw them out of their deck, several times a day.
  //
  // So: reload at once when it costs nothing (the reader is on the home screen
  // — see isSafeToAutoReload). Anywhere else, keep the persistent banner and the
  // menu dot up, and take the update at the next safe moment: going Home,
  // coming back to the tab while home is showing, or the next launch, which is
  // served by the new worker anyway. The sessionStorage guard still keeps a
  // flapping deploy from reload-looping the tab: one automatic reload a minute.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true; // first-ever install: this page is already current
      return;
    }
    controllerReplaced = true;
    updateIsWaiting = true;
    markUpdateAvailableInMenu();
    // A press is in flight: applyUpdate reloads on its own listener.
    if (updateInProgress) return;
    if (!reloadedRecently() && isSafeToAutoReload()) {
      reloadIntoUpdate(null);
      return;
    }
    showUpdateBanner();
  });

  // A release that is ready and was waiting for the reader to get somewhere it
  // can be applied without cost.
  const applyPendingUpdateIfSafe = () => {
    if (!(controllerReplaced || updateIsWaiting) || updateInProgress) return;
    if (isSafeToAutoReload()) applyUpdate({ silent: true });
  };
  onHomeShown(applyPendingUpdateIfSafe);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") applyPendingUpdateIfSafe();
  });

  // A worker that reaches "installed" while this page already has a controller
  // is a release waiting to take over; one that reaches "redundant" without ever
  // installing is a release that FAILED to download. Both were previously
  // invisible — the only automatic signal was controllerchange, which by
  // definition never fires in the second case, and the only manual one was a
  // modal buried in the hamburger drawer that most users never open. So a user
  // whose install kept failing on a bad connection sat on an old build
  // indefinitely with the app insisting nothing was wrong.
  //
  // "installed" no longer raises the banner by itself. sw.js's install asks to
  // take over as soon as its shell is cached, so "installed" is normally a
  // moment-long state that controllerchange (above) follows and decides on —
  // and a banner raised here was a banner flashed at a reader who was about to
  // be reloaded anyway, or one shown on the home screen where the update could
  // simply be applied. It only stays for a worker that genuinely sits waiting.
  const watchInstallingWorker = (registration) => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        updateIsWaiting = true;
        updateDownloadFailed = false;
        markUpdateAvailableInMenu();
        if (!updateInProgress && !reloadedRecently() && isSafeToAutoReload()) {
          applyUpdate({ silent: true });
          return;
        }
        setTimeout(() => {
          if (registration.waiting === worker && !updateInProgress) showUpdateBanner();
        }, 5000);
      } else if (worker.state === "redundant") {
        // Discarded before it could take over: a failed precache, a quota
        // rejection, or a newer worker superseding it. Only worth saying
        // anything about in the first case, which is the one that repeats.
        setUpdateFailedHint();
      }
    });
  };

  verifyUpdateLanded();

  const register = () => {
    // updateViaCache: "none" — the browser's own HTTP cache must never answer
    // the "is there a new sw.js?" check, or a host that serves the worker with
    // cacheable headers delays every release by up to a day (the browser's
    // forced re-check cap). The .update() calls below are the proactive half:
    // without them the check only runs on navigation, so a tab left open for
    // days never sees a release at all.
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
      .then((registration) => {
        serviceWorkerRegistration = registration;
        requestOfflineCacheRepair();
        // A worker may already be waiting from a previous visit — updatefound
        // has long since fired for it and will not fire again.
        // On launch the reader is normally on the home screen, so it is simply
        // applied; otherwise the banner offers it.
        if (registration.waiting && navigator.serviceWorker.controller) {
          updateIsWaiting = true;
          markUpdateAvailableInMenu();
          if (!reloadedRecently() && isSafeToAutoReload()) applyUpdate({ silent: true });
          else showUpdateBanner();
        }
        watchInstallingWorker(registration);
        registration.addEventListener("updatefound", () => watchInstallingWorker(registration));
        const checkForUpdate = () => registration.update().catch(() => {});
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") checkForUpdate();
        });
        setInterval(checkForUpdate, 30 * 60 * 1000);
      })
      .catch((error) => {
        console.warn("Service worker registration failed", error);
      });
    window.addEventListener("online", requestOfflineCacheRepair);
  };
  // Register after `load` to avoid competing with first-paint fetches — but if
  // the page has already finished loading (this runs from the async auth/boot
  // flow, long after `load` fires), a "load" listener would never run, so
  // register immediately instead. This is why offline previously never worked:
  // the SW was only ever set up inside initAppForUser(), after `load`.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

export function pwaAssetsSupported() {
  return location.protocol === "http:" || location.protocol === "https:";
}

export function installManifestLink() {
  if (!pwaAssetsSupported() || document.querySelector('link[rel="manifest"]')) return;

  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = "manifest.webmanifest";
  document.head.appendChild(link);
}
