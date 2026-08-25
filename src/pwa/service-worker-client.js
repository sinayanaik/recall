// Registering the service worker, warming the image cache, and the update
// banner.
//
// Deliberately unregistered on localhost: a cache-first worker there masks
// every edit behind the previously cached bundle.

import { canSignStorageUrls, signedUrlsFor, storagePathFromUrl } from "../cloud/storage-urls.js?v=__BUILD__";
import { BUILD_STAMP } from "../core/build.js?v=__BUILD__";
import { IMAGE_BUCKET } from "../images/upload.js?v=__BUILD__";
import { requestedAppVersion } from "./release-info.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

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
  // are certain to 400 — the next pull, or the render, warms them instead.
  if (!canSignStorageUrls()) return;
  try {
    const byPath = new Map();
    for (const url of urls) {
      const path = storagePathFromUrl(IMAGE_BUCKET, url);
      if (path) byPath.set(path, url);
    }
    if (!byPath.size) return;
    // Batched and cached inside signedUrlsFor, so a pull of many decks that
    // share images pays for each signature once.
    const signed = await signedUrlsFor(IMAGE_BUCKET, [...byPath.keys()]);
    const fetchable = [...byPath.keys()].map((path) => signed.get(path)).filter(Boolean);
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
  reload.addEventListener("click", () => {
    // Straight to the waiting worker if there is one: reloading alone does not
    // promote it when the page still has a controller, so without this the
    // button would appear to do nothing on the first press.
    const waiting = serviceWorkerRegistration?.waiting;
    if (!waiting) {
      location.reload();
      return;
    }

    // Reload once the new worker CONTROLS the page, not the instant it has been
    // asked to. skipWaiting is a request, not a transition: it still has to
    // finish activating and claim this client. Reloading immediately raced that
    // — the old worker was still in charge, so it answered the navigation with
    // its own release, and the page came back on the version the user had just
    // pressed a button to leave. The controllerchange handler further down then
    // declined to reload again (it refuses twice inside a minute, which is what
    // stops a reload loop), so the update sat there until the user navigated
    // again of their own accord.
    //
    // Measured before this change, driving a real install/update cycle: 1 to 3
    // extra navigations were needed, and it never landed on the first press.
    // It was always a race — the pre-split build lost it too — but a release
    // whose install is 130 module requests instead of one loses it far more
    // often, because the waiting worker takes that much longer to activate.
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      // Tell the controllerchange handler this reload was ours, so it does not
      // count as the user's own and suppress the next one.
      try { sessionStorage.setItem("recall:updateReloadAt", String(Date.now())); } catch (_) {}
      location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", go, { once: true });
    try { waiting.postMessage({ type: "skip-waiting" }); } catch (_) { go(); return; }
    // If the message is lost or the worker never claims, reload anyway rather
    // than leaving a pressed button doing nothing at all.
    setTimeout(go, 4000);
  });

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

  // A worker that takes over a page which already had one has just swapped the
  // app's files underneath a page still running the PREVIOUS release's JS. The
  // markup can already be the new build while the behaviour is the old one, so
  // half the app quietly does the old thing. It used to just show a toast and
  // wait — but nobody reads it and everyone kept running the old release for
  // days, which is exactly the "browsers serve the stale version" report.
  // Reload straight into the new release instead; notes/cards autosave on
  // input, so at most a keystroke is in flight. The sessionStorage guard keeps
  // a flapping update (bad deploy, oscillating server) from reload-looping the
  // tab: one automatic reload per minute at most.
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
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true; // first-ever install: this page is already current
      return;
    }
    let lastReload = 0;
    try { lastReload = Number(sessionStorage.getItem("recall:updateReloadAt")) || 0; } catch (_) {}
    if (Date.now() - lastReload < 60_000) {
      showToast("Recall updated — reload to finish", "info");
      return;
    }
    try { sessionStorage.setItem("recall:updateReloadAt", String(Date.now())); } catch (_) {}
    location.reload();
  });

  // A worker that reaches "installed" while this page already has a controller
  // is a release waiting to take over; one that reaches "redundant" without ever
  // installing is a release that FAILED to download. Both were previously
  // invisible — the only automatic signal was controllerchange, which by
  // definition never fires in the second case, and the only manual one was a
  // modal buried in the hamburger drawer that most users never open. So a user
  // whose install kept failing on a bad connection sat on an old build
  // indefinitely with the app insisting nothing was wrong.
  const watchInstallingWorker = (registration) => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        showUpdateBanner();
      } else if (worker.state === "redundant") {
        // Discarded before it could take over: a failed precache, a quota
        // rejection, or a newer worker superseding it. Only worth saying
        // anything about in the first case, which is the one that repeats.
        setUpdateFailedHint();
      }
    });
  };

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
        if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner();
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
