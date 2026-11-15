// View only: the 👁 half of the ✎ | 👁 pill on the PDFs and the Canvas.
//
// "The Canvas needs a view only mode too, because on a phone or a laptop, when
// I zoom in and out, the blocks get displaced." Notes has had its 👁 since it
// had an editor: the note is read, selected and highlighted, and nothing in it
// moves. The PDFs and the Canvas had no such state. Every press on the page
// was one tool or another's — a block picked up and dragged by a finger, typed
// words carried off, the pen drawing — and a reader who only wanted to look,
// scroll and pinch had nothing to say so with.
//
// With it on, the page is read, scrolled, zoomed, its words selected and
// highlighted (▣ and the selection bar), and cards made from it — what Notes'
// 👁 allows. Nothing on the page is drawn, moved, resized, turned, added,
// pasted or deleted. Each tool asks documentViewOnly() at the one place it
// takes a press or a key and stands down, the way it already stands down for
// everything else that is not its own; CSS hides the tools that would only be
// refused (styles/a1-view-only.css, keyed on the two body classes below).
//
// ── Per part, and per device ───────────────────────────────────────────────
//
// The PDFs and the Canvas each have their own switch: a paper read on a phone
// is a thing to look at, and the Canvas beside it is still where the pen
// writes. And it is a fact about this screen, not about the file — the phone
// is for reading and the tablet for writing — so it lives in localStorage
// beside the pen's own settings (src/storage/ink-prefs.js) and never syncs.
//
// ── A leaf ────────────────────────────────────────────────────────────────
//
// The pen, the blocks, the shapes, the selection and the clipboard all ask
// this, and several of them sit in the import cycles round pdf-view.js. So it
// imports only src/documents/doc-slot.js, itself a leaf for the same reason,
// and is told what to do on a change through a hook src/main.js registers.

import { activeDocSlot, DOC_SLOT_DOC, DOC_SLOT_NOTEBOOK, normalizeDocSlot } from "./doc-slot.js?v=__BUILD__";

export const VIEW_ONLY_KEY = "recall:view-only-v1";

// On <body>, one per part, so CSS can ask about the stage holding either one
// (side by side, both are up at once — see styles/a1-view-only.css).
export const VIEW_ONLY_BODY_CLASS = {
  [DOC_SLOT_DOC]: "view-only-doc",
  [DOC_SLOT_NOTEBOOK]: "view-only-notebook"
};

function readStored() {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(VIEW_ONLY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      [DOC_SLOT_DOC]: Boolean(parsed?.[DOC_SLOT_DOC]),
      [DOC_SLOT_NOTEBOOK]: Boolean(parsed?.[DOC_SLOT_NOTEBOOK])
    };
  } catch {
    // Unreadable or blocked (a private window, cleared site data): editable,
    // which is what this surface was before the switch existed.
    return { [DOC_SLOT_DOC]: false, [DOC_SLOT_NOTEBOOK]: false };
  }
}

// Read once and kept: every press on the page asks, and a JSON.parse per
// pointerdown is a cost for nothing. Written through on every change.
let viewOnlyParts = readStored();

function writeStored() {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(VIEW_ONLY_KEY, JSON.stringify(viewOnlyParts));
  } catch { /* storage full or blocked: still on for this session */ }
}

// Whether the part — by default the live one, the paper every tool acts on —
// is View only.
export function documentViewOnly(slot = activeDocSlot()) {
  return Boolean(viewOnlyParts[normalizeDocSlot(slot)]);
}

let changedHook = () => {};

// Told after every change, with the part that changed and its new state.
// Registered by src/main.js, which puts down whatever was picked up or armed.
export function setViewOnlyChangedHook(fn) {
  changedHook = typeof fn === "function" ? fn : () => {};
}

export function applyViewOnlyClasses() {
  const body = typeof document === "undefined" ? null : document.body;
  if (!body) return;
  Object.entries(VIEW_ONLY_BODY_CLASS).forEach(([slot, name]) => {
    const on = Boolean(viewOnlyParts[slot]);
    if (body.classList.contains(name) !== on) body.classList.toggle(name, on);
  });
}

export function setDocumentViewOnly(slot, on) {
  const key = normalizeDocSlot(slot);
  const next = Boolean(on);
  if (viewOnlyParts[key] === next) return false;
  viewOnlyParts = { ...viewOnlyParts, [key]: next };
  writeStored();
  applyViewOnlyClasses();
  changedHook(key, next);
  return true;
}

export function toggleDocumentViewOnly(slot = activeDocSlot()) {
  setDocumentViewOnly(slot, !documentViewOnly(slot));
  return documentViewOnly(slot);
}

// Read again from storage — another tab of this app changed it, or a check
// wants to start clean.
export function reloadDocumentViewOnly() {
  viewOnlyParts = readStored();
  applyViewOnlyClasses();
}
