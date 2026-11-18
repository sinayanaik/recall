// The middle mouse button grabs a PDF's or a Canvas's page and moves it.
//
// On Linux (and anywhere else the browser keeps a "primary selection"), a
// middle click fires a paste of whatever was last selected. Over a page that
// paste was taken as a paste ONTO the page (src/main.js: a picture or a Block
// at the mouse), so a middle click dropped stray words on the paper. A middle
// press there now means what it means in most drawing and PDF apps: hold and
// drag, and the page follows the mouse, both ways.
//
// None of the page's tools answer a middle press (the pen, shapes, region,
// connectors, selection and Block placing all return on button > 0), so this
// only has to do two things: scroll the scroller under the mouse while the
// button is held, and swallow the paste the browser fires for that click —
// whichever event it rides on — for a moment after the button comes up.
//
// A middle press inside a field (an open Block's editor, a text box) is the
// field's: the browser's own paste there is left alone.
//
// A leaf beside doc-scrollers.js: no imports from the document modules' cycles.

import { documentScrollers } from "./doc-scrollers.js?v=__BUILD__";

// How long after the button comes up a paste is still the middle click's.
const PASTE_GUARD_MS = 400;
const TYPING_FIELD = "input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']";

let pan = null;
let pasteGuardUntil = 0;

export function isMiddlePanning() {
  return Boolean(pan);
}

function inTypingField(target) {
  return Boolean(target?.closest?.(TYPING_FIELD));
}

function scrollerUnder(target) {
  if (!target) return null;
  return documentScrollers().find((view) => view.contains(target)) || null;
}

function guarding() {
  return Boolean(pan) || Date.now() < pasteGuardUntil;
}

function onPanDown(event) {
  if (event.pointerType !== "mouse" || event.button !== 1) return;
  if (inTypingField(event.target)) return;
  const view = scrollerUnder(event.target);
  if (!view || view.closest("[hidden]")) return;
  event.preventDefault();
  if (pan) endPan();
  pan = {
    view,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startLeft: view.scrollLeft,
    startTop: view.scrollTop,
    cursor: view.style.cursor
  };
  view.style.cursor = "grabbing";
  try { view.setPointerCapture(event.pointerId); } catch (_) { /* moves still arrive on the window */ }
}

function onPanMove(event) {
  if (!pan || event.pointerId !== pan.pointerId) return;
  event.preventDefault();
  pan.view.scrollLeft = pan.startLeft - (event.clientX - pan.startX);
  pan.view.scrollTop = pan.startTop - (event.clientY - pan.startY);
}

function endPan() {
  if (!pan) return;
  const { view, pointerId, cursor } = pan;
  pan = null;
  view.style.cursor = cursor;
  try { if (view.hasPointerCapture?.(pointerId)) view.releasePointerCapture(pointerId); } catch (_) { /* already gone */ }
  pasteGuardUntil = Date.now() + PASTE_GUARD_MS;
}

function onPanUp(event) {
  if (!pan || event.pointerId !== pan.pointerId) return;
  endPan();
}

// The mouse events a middle press brings with it: autoscroll on mousedown,
// the selection paste on mouseup, a link opened in a new tab on auxclick.
function onMiddleMouse(event) {
  if (event.button !== 1 || !guarding()) return;
  event.preventDefault();
}

function onMiddlePaste(event) {
  if (!guarding() || inTypingField(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

let middlePanInstalled = false;
export function initMiddlePan() {
  if (middlePanInstalled) return;
  middlePanInstalled = true;
  // On the window, capturing: ahead of every page listener, and — for the
  // paste — ahead of page-clipboard.js's and src/main.js's paste paths.
  window.addEventListener("pointerdown", onPanDown, { capture: true });
  window.addEventListener("pointermove", onPanMove, { capture: true });
  window.addEventListener("pointerup", onPanUp, true);
  window.addEventListener("pointercancel", onPanUp, true);
  window.addEventListener("lostpointercapture", onPanUp, true);
  window.addEventListener("blur", endPan);
  ["mousedown", "mouseup", "auxclick"].forEach((type) => window.addEventListener(type, onMiddleMouse, true));
  window.addEventListener("paste", onMiddlePaste, true);
}
