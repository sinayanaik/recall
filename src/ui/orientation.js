// Portrait or landscape, chosen in the app rather than by the phone's
// auto-rotate.
//
// "In mobile mode there needs to be a landscape and portrait mode toggle which I
// can use instead of the phone's built-in auto rotate." So: one switch,
// Landscape — on locks the screen sideways, off locks it upright. It is a lock
// either way, not a hand-back to the sensor, because the reader this is for
// keeps auto-rotate OFF and wants the app to turn when THEY say, and "off" has
// to mean upright whatever the phone happens to be doing.
//
// ── Where the platform lets it happen ─────────────────────────────────────
//
// screen.orientation.lock() is Android's: Chrome honours it in full screen, or
// in an installed app (this one is `display: standalone`, manifest.webmanifest),
// and nowhere else. iOS Safari has the method and rejects every call, and a
// desktop has nothing to rotate. So the control is offered only where there is a
// lock() to call AND a coarse pointer — a phone or a tablet — and if the call
// still fails the reader is told so, rather than shown a switch that moved and a
// screen that did not.
//
// In a browser TAB the lock needs full screen, so pressing the switch there
// enters full screen first (the press is the gesture both need) and then turns
// the screen. That is the one place a mode changes as a side effect of another
// control, and it is the honest one: the Full screen switch lights up because
// the window really is in full screen, and leaving full screen is what gives the
// rotation back — the browser drops the lock itself, and this file notices.
//
// It does NOT run the other way. Full screen used to put the remembered
// orientation back every time it was entered, so ⛶ turned the phone sideways —
// or pinned it upright — when all the reader asked for was full screen. Same
// rule as focus mode and full screen (src/ui/chrome.js): a control that moves
// when you did not touch it is not a control. Pressing Landscape is the only
// thing that turns the screen.
//
// ── What the switch says ──────────────────────────────────────────────────
//
// Only what is actually held. The API has no getter for a lock, so the switch
// is cleared whenever the browser is known to have dropped one: full screen
// ending in a tab, the screen ending up the other way round than the lock said
// (an orientation change nobody here asked for), or the app coming back from
// the background, which on Android costs it full screen and the lock with it.
//
// ── What is remembered ────────────────────────────────────────────────────
//
// The last orientation chosen, in localStorage. The installed app re-applies it
// at launch, where a lock needs no gesture. A tab does not: there the lock only
// ever lives inside full screen, and entering full screen is not a request to
// turn anything.

import { el } from "../core/dom.js?v=__BUILD__";
import { isFullscreenAvailable } from "./chrome.js?v=__BUILD__";
import { showToast } from "./feedback.js?v=__BUILD__";

export const ORIENTATION_KEY = "recall:screenOrientation";

// What the screen is locked to RIGHT NOW, as far as this app has made it so.
// The API has no getter for "is a lock held", so this is tracked: set when a
// lock resolves, cleared when the browser is known to have dropped it.
let lockedTo = null;
// Whether that lock only holds while the window is in full screen — always, in
// a tab; in the installed app only if it had to fall back to full screen. The
// browser drops such a lock the moment full screen ends, and the switch has to
// stop claiming it.
let heldByFullscreen = false;
// A lock this file is in the middle of asking for. The fullscreenchange and
// orientation change it sets off on the way are its own doing, not the browser
// dropping a lock, and must not clear the switch under it.
let locking = false;

// The rail mirrors this control, and is told rather than left to notice — the
// same registration idiom as setChromeModesHandler, for the same reason: the
// rail imports this file, so this file cannot import the rail.
let onOrientationModes = () => {};

export function setOrientationModesHandler(fn) {
  onOrientationModes = typeof fn === "function" ? fn : () => {};
}

export function isOrientationLockAvailable() {
  if (typeof screen === "undefined" || typeof screen.orientation?.lock !== "function") return false;
  return Boolean(window.matchMedia?.("(pointer: coarse)").matches);
}

// Installed and launched as an app — where Chrome lets a page lock without full
// screen. Decided once, at launch, and not asked again: Chrome answers
// `(display-mode: fullscreen)` for a browser TAB in API full screen too, and a
// lock taken there, mistaken for an app's, was never cleared when full screen
// ended — the switch went on saying Landscape over an upright screen.
let launchedAsApp = null;

function detectInstalledApp() {
  const media = (query) => Boolean(window.matchMedia?.(query).matches);
  return media("(display-mode: standalone)")
    || (media("(display-mode: fullscreen)") && !document.fullscreenElement)
    || navigator.standalone === true;
}

export function isStandaloneApp() {
  if (launchedAsApp === null) launchedAsApp = detectInstalledApp();
  return launchedAsApp;
}

function storedOrientation() {
  try {
    const value = localStorage.getItem(ORIENTATION_KEY);
    return value === "landscape" || value === "portrait" ? value : null;
  } catch (_) {
    return null;
  }
}

function storeOrientation(value) {
  try {
    localStorage.setItem(ORIENTATION_KEY, value);
  } catch (_) {
    /* private mode — the lock still holds for this session */
  }
}

// Resolves true when this call is what put the window into full screen.
async function enterFullscreen() {
  if (document.fullscreenElement || !isFullscreenAvailable()) return false;
  await document.documentElement.requestFullscreen();
  return true;
}

// Lock to `target` ("landscape" | "portrait"). Resolves true when the screen is
// locked, false when the platform refused.
export async function setScreenOrientation(target) {
  if (!isOrientationLockAvailable()) return false;
  locking = true;
  const standalone = isStandaloneApp();
  let enteredFullscreen = false;
  try {
    // A tab cannot lock without full screen, so ask for it first, while the
    // press that got us here still counts as a gesture.
    if (!standalone) enteredFullscreen = await enterFullscreen();
    try {
      await screen.orientation.lock(target);
    } catch (error) {
      // An installed app on a browser that still wants full screen for this:
      // one more try, from inside it.
      if (document.fullscreenElement || !isFullscreenAvailable()) throw error;
      enteredFullscreen = await enterFullscreen();
      await screen.orientation.lock(target);
    }
    lockedTo = target;
    heldByFullscreen = !standalone || enteredFullscreen;
    storeOrientation(target);
    return true;
  } catch (_) {
    // Full screen was only ever the way to the lock. Without the lock it is a
    // mode the reader did not ask for, so it is handed back.
    if (enteredFullscreen && document.fullscreenElement) {
      Promise.resolve(document.exitFullscreen()).catch(() => {});
    }
    showToast("This browser won't let the app turn the screen — the phone's own rotation still works", "info");
    return false;
  } finally {
    locking = false;
    paintOrientationButton();
  }
}

// The switch: landscape if it is not already, upright if it is.
export function toggleLandscape() {
  return setScreenOrientation(lockedTo === "landscape" ? "portrait" : "landscape");
}

export function paintOrientationButton() {
  const button = el.rotateScreenBtn;
  if (!button) return;
  const on = lockedTo === "landscape";
  button.setAttribute("aria-pressed", on ? "true" : "false");
  const hint = button.querySelector(".nhm-hint");
  const said = lockedTo === "landscape"
    ? "Locked sideways — off turns it upright"
    : lockedTo === "portrait"
      ? "Locked upright — on turns it sideways"
      : "Turn the screen sideways";
  if (hint) hint.textContent = said;
  button.title = `Landscape — ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  onOrientationModes();
}

function offerOrientationControl() {
  const available = isOrientationLockAvailable();
  if (el.rotateScreenBtn) el.rotateScreenBtn.hidden = !available;
  paintOrientationButton();
  return available;
}

// The browser dropped the lock: say so.
function forgetLock() {
  if (!lockedTo) return;
  lockedTo = null;
  heldByFullscreen = false;
  paintOrientationButton();
}

// The screen is the other way round from the lock the switch claims, and no
// lock is being asked for right now — so the lock is gone, whatever took it.
function reconcileLock() {
  if (!lockedTo || locking) return;
  const type = typeof screen !== "undefined" ? screen.orientation?.type : null;
  if (typeof type === "string" && !type.startsWith(lockedTo)) forgetLock();
}

export function initScreenOrientation() {
  // Before anything can be in full screen — see isStandaloneApp.
  isStandaloneApp();
  const available = offerOrientationControl();
  // A tablet with a keyboard cover, a laptop that folds into one: whether there
  // is a touch screen to turn can change under a running app.
  window.matchMedia?.("(pointer: coarse)").addEventListener?.("change", offerOrientationControl);

  // Leaving full screen in a tab takes the lock with it — the browser's doing,
  // not ours — so the switch has to say so. Entering it does nothing here: see
  // the note at the top of this file.
  document.addEventListener("fullscreenchange", () => {
    if (locking || document.fullscreenElement) return;
    if (heldByFullscreen || !isStandaloneApp()) forgetLock();
  });
  if (typeof screen !== "undefined") screen.orientation?.addEventListener?.("change", reconcileLock);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!document.fullscreenElement && (heldByFullscreen || !isStandaloneApp())) forgetLock();
    else reconcileLock();
  });

  // Installed and launched: the lock is allowed without a gesture, so the app
  // opens the way it was left.
  if (available && isStandaloneApp()) restoreOrientation();
}

// The installed app, at launch. Quietly: this is the app putting back what the
// reader chose, not the reader asking, so a refusal is not worth a toast.
function restoreOrientation() {
  const wanted = storedOrientation();
  if (!wanted) return;
  new Promise((resolve) => resolve(screen.orientation.lock(wanted)))
    .then(() => { lockedTo = wanted; heldByFullscreen = false; paintOrientationButton(); })
    .catch(() => {});
}
