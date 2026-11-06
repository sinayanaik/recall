// The paper menu: which tone a PDF or a Canvas is shown on.
//
// It was a button that turned a dark page on and off. A reader with ten themes
// had two pages to choose from — white, or pure black — and a Canvas had none at
// all (it followed the theme by polarity and the button was hidden there). The
// tones themselves, and what each one means for the page's pixels, its pens and
// everything laid over it, are in src/format/paper-tones.js; this file is only
// the list a reader picks from.
//
// Opened from #documentDarkBtn in the tab row and from the reading rail's
// "Paper" row. A listbox of its own rather than a <select>: each row shows the
// paper's colour, and "Match theme" shows the colour the theme gives it NOW.

import { PAPER_TONES, resolvePaperTone } from "../format/paper-tones.js?v=__BUILD__";
import { currentPaperTone, setPaperShownHook, setPaperTone } from "./pdf-view.js?v=__BUILD__";

const PAPER_TONE_NOTES = {
  white: "Plain paper, as printed",
  sepia: "Warm and soft, for long reads",
  dim: "Soft dark grey",
  black: "Inverted, for dark rooms",
  theme: "The theme's own colour"
};

let paperMenuEl = null;
let paperMenuAnchor = null;

function buildMenu() {
  if (paperMenuEl) return paperMenuEl;
  paperMenuEl = document.createElement("div");
  paperMenuEl.className = "paper-menu";
  paperMenuEl.id = "paperMenu";
  paperMenuEl.setAttribute("role", "listbox");
  paperMenuEl.setAttribute("aria-label", "Paper");
  paperMenuEl.hidden = true;
  PAPER_TONES.forEach((tone) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "paper-option";
    option.setAttribute("role", "option");
    option.dataset.paperTone = tone.id;
    const swatch = document.createElement("span");
    swatch.className = "paper-swatch";
    swatch.setAttribute("aria-hidden", "true");
    // Two lines of "print" on the swatch, so a dark paper reads as a page with
    // light words on it rather than as a black square.
    swatch.append(document.createElement("i"), document.createElement("i"));
    const text = document.createElement("span");
    text.className = "paper-option-text";
    const label = document.createElement("strong");
    label.textContent = tone.label;
    const note = document.createElement("small");
    note.textContent = PAPER_TONE_NOTES[tone.id] || "";
    text.append(label, note);
    const check = document.createElement("span");
    check.className = "paper-check";
    check.setAttribute("aria-hidden", "true");
    option.append(swatch, text, check);
    paperMenuEl.appendChild(option);
  });
  paperMenuEl.addEventListener("click", (event) => {
    const option = event.target.closest?.("[data-paper-tone]");
    if (!option) return;
    setPaperTone(option.dataset.paperTone);
    closePaperMenu({ focusAnchor: true });
  });
  paperMenuEl.addEventListener("keydown", onPaperMenuKey);
  document.body.appendChild(paperMenuEl);
  return paperMenuEl;
}

function paintMenu() {
  if (!paperMenuEl) return;
  const current = currentPaperTone();
  paperMenuEl.querySelectorAll("[data-paper-tone]").forEach((option) => {
    const tone = resolvePaperTone(option.dataset.paperTone);
    const selected = option.dataset.paperTone === current.id;
    option.setAttribute("aria-selected", selected ? "true" : "false");
    option.tabIndex = selected ? 0 : -1;
    const swatch = option.querySelector(".paper-swatch");
    swatch?.style.setProperty("--paper-swatch-bg", tone.bg);
    swatch?.style.setProperty("--paper-swatch-ink", tone.dark ? "#e8eaed" : "#16181d");
    const check = option.querySelector(".paper-check");
    if (check) check.textContent = selected ? "✓" : "";
  });
}

function placeMenu() {
  if (!paperMenuEl) return;
  const rect = paperMenuAnchor?.getBoundingClientRect?.();
  paperMenuEl.style.left = "0px";
  paperMenuEl.style.top = "0px";
  const width = paperMenuEl.offsetWidth;
  const height = paperMenuEl.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!rect || (!rect.width && !rect.height)) {
    // No visible anchor (opened from the reading rail, whose tray has shut):
    // centred, a little above the middle.
    paperMenuEl.style.left = `${Math.max(8, (vw - width) / 2)}px`;
    paperMenuEl.style.top = `${Math.max(8, (vh - height) / 3)}px`;
    return;
  }
  paperMenuEl.style.left = `${Math.max(8, Math.min(rect.right - width, vw - width - 8))}px`;
  paperMenuEl.style.top = (rect.bottom + height + 6 > vh)
    ? `${Math.max(8, rect.top - height - 6)}px`
    : `${rect.bottom + 6}px`;
}

function onOutsidePress(event) {
  if (!paperMenuEl || paperMenuEl.hidden) return;
  if (paperMenuEl.contains(event.target) || paperMenuAnchor?.contains?.(event.target)) return;
  closePaperMenu();
}

function onDocumentKey(event) {
  if (event.key === "Escape" && isPaperMenuOpen()) {
    event.preventDefault();
    event.stopPropagation();
    closePaperMenu({ focusAnchor: true });
  }
}

function onPaperMenuKey(event) {
  const options = [...paperMenuEl.querySelectorAll("[data-paper-tone]")];
  const at = options.indexOf(document.activeElement);
  let next = -1;
  if (event.key === "ArrowDown") next = (at + 1) % options.length;
  else if (event.key === "ArrowUp") next = (at - 1 + options.length) % options.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = options.length - 1;
  else return;
  event.preventDefault();
  options[next]?.focus();
}

export function isPaperMenuOpen() {
  return Boolean(paperMenuEl && !paperMenuEl.hidden);
}

export function openPaperMenu(anchor = null) {
  buildMenu();
  if (isPaperMenuOpen()) {
    closePaperMenu();
    return;
  }
  paperMenuAnchor = anchor;
  paintMenu();
  paperMenuEl.hidden = false;
  paperMenuAnchor?.setAttribute?.("aria-expanded", "true");
  placeMenu();
  document.addEventListener("pointerdown", onOutsidePress, true);
  document.addEventListener("keydown", onDocumentKey, true);
  window.addEventListener("resize", placeMenu);
  (paperMenuEl.querySelector('[aria-selected="true"]') || paperMenuEl.querySelector("[data-paper-tone]"))?.focus({ preventScroll: true });
}

export function closePaperMenu({ focusAnchor = false } = {}) {
  if (!paperMenuEl || paperMenuEl.hidden) return;
  paperMenuEl.hidden = true;
  paperMenuAnchor?.setAttribute?.("aria-expanded", "false");
  document.removeEventListener("pointerdown", onOutsidePress, true);
  document.removeEventListener("keydown", onDocumentKey, true);
  window.removeEventListener("resize", placeMenu);
  if (focusAnchor && paperMenuAnchor?.isConnected && paperMenuAnchor.getClientRects().length) paperMenuAnchor.focus({ preventScroll: true });
  paperMenuAnchor = null;
}

// A tone changed by anything else (a theme change under "Match theme", a check)
// shows in the menu if it is open.
setPaperShownHook(() => {
  if (isPaperMenuOpen()) paintMenu();
});
