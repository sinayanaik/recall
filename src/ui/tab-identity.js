// The browser tab's title and favicon follow the open file.
//
// With several files open in several tabs, every tab used to read "Recall"
// under the same icon, so the only way to find one was to click through them.
// Now the tab reads the file's name, and the favicon is that file's initials on
// a colour of its own. Home, and a window with no file open, keep "Recall" and
// the app icon.
//
// A leaf on purpose: updateMeta() (src/cards/card-status.js) calls this on
// every repaint of the header, and home-state calls it when home comes and
// goes, so it must not pull the library graph in behind it.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { isHomeVisible, onHomeChromeChange } from "./home-state.js?v=__BUILD__";

const APP_TITLE = "Recall";
const ICON_SIZE = 64;

// Saturated enough for a 16px square to read as a colour, dark enough for
// white initials on top.
const PALETTE = [
  "#2563eb", "#7c3aed", "#c026d3", "#db2777", "#dc2626",
  "#ea580c", "#b45309", "#15803d", "#0f766e", "#0369a1"
];

let iconLink = null;
let defaultIconHref = "";
const iconCache = new Map();

function faviconLink() {
  if (iconLink && iconLink.isConnected) return iconLink;
  iconLink = document.querySelector('link[rel="icon"]');
  if (iconLink && !defaultIconHref) defaultIconHref = iconLink.getAttribute("href") || "";
  return iconLink;
}

// The same test as hasActiveDeck() in src/cards/card-status.js, repeated here
// so this module stays a leaf.
function hasOpenFile() {
  return Boolean(state.deckTitle)
    || (state.masterCards?.length || 0) > 0
    || Boolean(String(state.notes || "").trim());
}

function openFileName() {
  if (isHomeVisible() || !hasOpenFile()) return "";
  return String(state.deckTitle || state.sourceTitle || "").trim() || "Untitled File";
}

// An export points document.title at the download's file name while the print
// preview is up — the browser uses it as the "Save as PDF" name — and puts it
// back when the preview closes (closePrintPreview calls us then).
function printHoldsTitle() {
  const root = el.printRoot;
  return Boolean(root && (root.classList.contains("is-preparing") || root.classList.contains("is-preview")));
}

function tabGraphemes(text) {
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
    }
  } catch (_) {}
  return Array.from(text);
}

// "Organic Chemistry" → "OC", "Physics" → "P", "🧪 Lab notes" → "🧪".
export function tabIconGlyph(name) {
  const text = String(name || "").trim();
  if (!text) return "";
  const first = tabGraphemes(text)[0] || "";
  if (/\p{Extended_Pictographic}/u.test(first)) return first;
  const words = text.split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (!words.length) return tabGraphemes(text)[0] || "";
  return words.slice(0, 2)
    .map((word) => tabGraphemes(word)[0].toLocaleUpperCase())
    .join("");
}

function hashKey(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function drawIcon(glyph, color) {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const r = ICON_SIZE * 0.22;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, ICON_SIZE, ICON_SIZE, r);
  else ctx.rect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.fill();
  const isEmoji = /\p{Extended_Pictographic}/u.test(glyph);
  const letters = isEmoji ? 1 : tabGraphemes(glyph).length;
  const size = isEmoji ? 44 : letters > 1 ? 34 : 46;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  // Fit two wide letters (WM) inside the square rather than clipping them.
  const width = ctx.measureText(glyph).width;
  const max = ICON_SIZE * 0.86;
  if (width > max) ctx.font = `700 ${Math.floor(size * max / width)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillText(glyph, ICON_SIZE / 2, ICON_SIZE / 2 + size * 0.06);
  return canvas.toDataURL("image/png");
}

function iconFor(name) {
  const glyph = tabIconGlyph(name);
  if (!glyph) return "";
  // Keyed on the file's id where it has one, so renaming a file keeps its colour.
  const key = String(state.localDeckId || state.deckId || name);
  const color = PALETTE[hashKey(key) % PALETTE.length];
  const iconKey = `${color}|${glyph}`;
  if (!iconCache.has(iconKey)) iconCache.set(iconKey, drawIcon(glyph, color));
  return iconCache.get(iconKey);
}

export function syncTabIdentity() {
  const name = openFileName();
  if (!printHoldsTitle()) {
    const title = name || APP_TITLE;
    if (document.title !== title) document.title = title;
  }
  const link = faviconLink();
  if (!link) return;
  let href = defaultIconHref;
  if (name) {
    try { href = iconFor(name) || defaultIconHref; } catch (error) {
      console.warn("Could not draw the tab icon", error);
    }
  }
  if (href && link.getAttribute("href") !== href) link.setAttribute("href", href);
}

onHomeChromeChange(syncTabIdentity);
