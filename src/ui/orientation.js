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
// ── What is remembered ────────────────────────────────────────────────────
//
// The last orientation chosen, in localStorage. The installed app re-applies it
// at launch, where a lock needs no gesture; a tab re-applies it whenever full
// screen is entered, since that is the only moment a tab is allowed to.

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
// A lock this file is in the middle of asking for. The fullscreenchange that
// entering full screen fires on the way must not re-apply the OLD preference
// over the one being set.
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
// screen.
export function isStandaloneApp() {
  const media = (query) => Boolean(window.matchMedia?.(query).matches);
  return media("(display-mode: standalone)") || media("(display-mode: fullscreen)");
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

export function initScreenOrientation() {
  const available = offerOrientationControl();
  // A tablet with a keyboard cover, a laptop that folds into one: whether there
  // is a touch screen to turn can change under a running app.
  window.matchMedia?.("(pointer: coarse)").addEventListener?.("change", offerOrientationControl);

  // Leaving full screen in a tab takes the lock with it — the browser's doing,
  // not ours — so the switch has to say so. Entering it (by ⛶, by F11, by this
  // file) is the one moment a tab may lock, so the remembered choice is put back.
  document.addEventListener("fullscreenchange", () => {
    if (!isOrientationLockAvailable() || locking) return;
    if (!document.fullscreenElement) {
      if (lockedTo && heldByFullscreen) {
        lockedTo = null;
        heldByFullscreen = false;
        paintOrientationButton();
      }
      return;
    }
    if (!lockedTo) restoreOrientation();
  });

  // Installed and launched: the lock is allowed without a gesture, so the app
  // opens the way it was left.
  if (available && isStandaloneApp()) restoreOrientation();
}

// Quietly: this is the app putting back what the reader chose, not the reader
// asking, so a refusal is not worth a toast.
function restoreOrientation() {
  const wanted = storedOrientation();
  if (!wanted) return;
  const viaFullscreen = Boolean(document.fullscreenElement) && !isStandaloneApp();
  new Promise((resolve) => resolve(screen.orientation.lock(wanted)))
    .then(() => { lockedTo = wanted; heldByFullscreen = viaFullscreen; paintOrientationButton(); })
    .catch(() => {});
}
