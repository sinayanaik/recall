// The CDN libraries that are NOT loaded up front.
//
// Every URL here must stay byte-identical to its counterpart in sw.js's
// CDN_ASSETS: the service worker precaches by exact URL, so a mismatch means
// the precache holds a file nothing asks for while the real request goes to a
// network that may not be there. That contract is the whole reason these can
// be deferred without giving up offline support.

import { configureMermaid, currentThemeId } from "../ui/theme.js?v=__BUILD__";

// ── Deferred third-party libraries ──────────────────────────────────────────
//
// index.html used to load 5.8MB of blocking CDN JavaScript before app.js, and
// every listener in this file attaches at module scope — so until all of that
// had downloaded AND executed, the whole UI was painted and completely inert.
// Measured cold: controls on screen at 56ms, listeners live at 5421ms. That is
// the real reason the app "felt laggy": the first press of a session genuinely
// did nothing. (The boot-click queue in index.html covers that window by
// replaying the press; it is a mitigation, not a fix.)
//
// Six of those libraries — mermaid (3.3MB on its own), jszip, nomnoml+graphre
// and turndown+its gfm plugin — are render-, import- or export-only. They now
// load from here instead.
//
// Why injected rather than `defer`: deferred scripts still block
// DOMContentLoaded, and initToolbars — which wires the ☰ drawer that every
// toolbar action lives behind — waits on that event, so `defer` would have
// moved the stall rather than removed it. `async` would not block it, but
// loses the ordering graphre→nomnoml and turndown→its plugin both require.
//
// What stays blocking in index.html: dompurify, marked, prism and katex (the
// first render needs them) and supabase-js (bootApp needs it).
//
// OFFLINE CONTRACT: these URLs must stay byte-identical to the entries in
// sw.js's CDN_ASSETS. The worker precaches them at install and serves
// cdn.jsdelivr.net cache-first, so an injected <script> for the same URL is
// still answered from the cache with no connection. A typo here doesn't fail
// loudly — it quietly turns "works offline" into "worked offline on the
// machine it was tested on".
export const CDN_BASE = "https://cdn.jsdelivr.net/npm/";

export const LIB_URLS = {
  mermaid: `${CDN_BASE}mermaid@10.9.1/dist/mermaid.min.js`,
  jszip: `${CDN_BASE}jszip@3.10.1/dist/jszip.min.js`,
  graphre: `${CDN_BASE}graphre/dist/graphre.js`,
  nomnoml: `${CDN_BASE}nomnoml/dist/nomnoml.js`,
  turndown: `${CDN_BASE}turndown@7.1.2/dist/turndown.js`,
  turndownGfm: `${CDN_BASE}turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js`,
  // ── pdf.js ────────────────────────────────────────────────────────────────
  //
  // Pinned to the LEGACY UMD build, and to a 3.x version, for one reason each:
  // loadScriptOnce injects a classic <script> (an ES module cannot be loaded
  // that way, and the whole deferred-library mechanism is built on classic
  // tags), and 3.11.174 is the last line that still ships one — 4.x is
  // ESM-only. The legacy build also targets older syntax, which is what keeps
  // it working in the same browsers everything else here does.
  //
  // NOT vendored, unlike dompurify/marked/prism/katex. vendor/ is 1.2MB today
  // and sits on the boot precache path; pdf.js plus its worker would roughly
  // double it, for a library only import and PDF reading ever touch. It is
  // precached in sw.js like the other five deferred libraries instead, which is
  // what keeps offline reading of an already-imported paper working.
  pdfjs: `${CDN_BASE}pdfjs-dist@3.11.174/legacy/build/pdf.min.js`,
  pdfjsWorker: `${CDN_BASE}pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js`
};

// ── Webfonts (Style → Basics/Notes → Font) ──────────────────────────────────
//
// Deliberately NOT in CDN_ASSETS, unlike everything above. Those six libraries
// are precached at install so a feature that has never been used still works
// the first time it's reached offline (a diagram, an export). A typeface is
// cosmetic: picking one is something you do while looking at the Style panel,
// which means online, and sw.js's fetch handler already caches ANY
// cdn.jsdelivr.net request on first fetch (see isCdnAsset in sw.js) — so a font
// used once is available offline forever after, same as the libraries, just
// without paying to eagerly download all 28 of them (~50 files) for every
// install regardless of whether Style is ever opened. The one degradation this
// accepts: choosing a font you have never used before, while offline, silently
// keeps the previous one — the same tradeoff already made for an unfetched
// Prism grammar (see PRISM_LANGS in sw.js).
//
// Keyed by the exact string fontFamilyChoices uses, in theme-catalog.js — that
// object is both the font-family CSS stack AND (via WEBFONT_PACKAGES below)
// the answer to "does this choice need a network fetch at all", so the two
// must name the same fonts the same way or a choice silently renders in the
// fallback typeface forever.
//
// Each entry points at the per-weight stylesheet of an @fontsource package
// (self-hosted woff2, no Google Fonts origin involved). Only 400/700 are
// loaded — the app's weight control is a separate setting (300..900), and the
// browser matches whatever weight is asked for to the nearest one actually
// registered rather than refusing to render, so two real weights cover it
// without fetching all nine. Every package here ships both; the one exception
// (Patrick Hand, a single-weight handwriting face) lists only 400 — 700 would
// 404.
//
// The CSS also declares subsets this app never authors in (cyrillic, greek,
// vietnamese, latin-ext) — left in rather than hand-filtered to "latin" only,
// because @font-face's unicode-range means the BROWSER only ever fetches the
// woff2 for a subset some rendered character actually falls in. Plain English
// notes cost exactly the "latin" file; nothing else is ever requested.
export const FONT_CDN_BASE = `${CDN_BASE}@fontsource/`;

export const WEBFONT_PACKAGES = {
  // Sans-serif
  Inter: { pkg: "inter", version: "5.3.0", weights: [400, 700] },
  Roboto: { pkg: "roboto", version: "5.3.0", weights: [400, 700] },
  "Open Sans": { pkg: "open-sans", version: "5.3.0", weights: [400, 700] },
  Lato: { pkg: "lato", version: "5.3.0", weights: [400, 700] },
  Montserrat: { pkg: "montserrat", version: "5.3.0", weights: [400, 700] },
  Poppins: { pkg: "poppins", version: "5.3.0", weights: [400, 700] },
  "Work Sans": { pkg: "work-sans", version: "5.3.0", weights: [400, 700] },
  Nunito: { pkg: "nunito", version: "5.3.0", weights: [400, 700] },
  Raleway: { pkg: "raleway", version: "5.3.0", weights: [400, 700] },
  "IBM Plex Sans": { pkg: "ibm-plex-sans", version: "5.3.0", weights: [400, 700] },

  // Serif
  Lora: { pkg: "lora", version: "5.3.0", weights: [400, 700] },
  Merriweather: { pkg: "merriweather", version: "5.3.0", weights: [400, 700] },
  "Playfair Display": { pkg: "playfair-display", version: "5.3.0", weights: [400, 700] },
  "PT Serif": { pkg: "pt-serif", version: "5.3.0", weights: [400, 700] },
  "Source Serif 4": { pkg: "source-serif-4", version: "5.3.0", weights: [400, 700] },
  "Crimson Pro": { pkg: "crimson-pro", version: "5.3.0", weights: [400, 700] },
  "Libre Baskerville": { pkg: "libre-baskerville", version: "5.3.0", weights: [400, 700] },
  "EB Garamond": { pkg: "eb-garamond", version: "5.3.0", weights: [400, 700] },

  // Monospace
  "JetBrains Mono": { pkg: "jetbrains-mono", version: "5.3.0", weights: [400, 700] },
  "Fira Code": { pkg: "fira-code", version: "5.3.0", weights: [400, 700] },
  "Source Code Pro": { pkg: "source-code-pro", version: "5.3.0", weights: [400, 700] },
  "IBM Plex Mono": { pkg: "ibm-plex-mono", version: "5.3.0", weights: [400, 700] },
  "Space Mono": { pkg: "space-mono", version: "5.3.0", weights: [400, 700] },

  // Rounded
  Quicksand: { pkg: "quicksand", version: "5.3.0", weights: [400, 700] },
  Comfortaa: { pkg: "comfortaa", version: "5.3.0", weights: [400, 700] },
  "Baloo 2": { pkg: "baloo-2", version: "5.3.0", weights: [400, 700] },

  // Handwriting
  Caveat: { pkg: "caveat", version: "5.3.0", weights: [400, 700] },
  Kalam: { pkg: "kalam", version: "5.3.0", weights: [400, 700] },
  "Patrick Hand": { pkg: "patrick-hand", version: "5.3.0", weights: [400] }
};

// url -> true. Same shape as loadedScripts, for a <link> instead of a
// <script>: idempotent per URL, so re-applying settings (every control change
// re-runs applyStyleSettings) doesn't inject a second copy of the stylesheet.
export const loadedStylesheets = new Set();

export function loadStylesheetOnce(url) {
  if (loadedStylesheets.has(url)) return;
  loadedStylesheets.add(url);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  document.head.appendChild(link);
}

// Injects the stylesheet(s) for a font-family CHOICE, if it names one that
// needs a network fetch at all — "system", "serif", "mono", "rounded" and
// "inherit" all resolve here to nothing, same as any typo, which is the
// correct behaviour: those already render from fonts the OS ships.
export function ensureWebfont(key) {
  const font = WEBFONT_PACKAGES[key];
  if (!font) return;
  font.weights.forEach((weight) => {
    loadStylesheetOnce(`${FONT_CDN_BASE}${font.pkg}@${font.version}/${weight}.css`);
  });
}

// url -> Promise<boolean>. Cached by URL so concurrent callers (a note with
// twelve diagrams in it) share one <script>, and so a failed load isn't retried
// on a loop — it resolves false and the caller degrades.
export const loadedScripts = new Map();

export function loadScriptOnce(url) {
  let pending = loadedScripts.get(url);
  if (pending) return pending;
  pending = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => {
      // Drop the rejection from the cache so a later attempt (back online, or
      // after the worker's CDN repair pass) can succeed.
      loadedScripts.delete(url);
      console.warn("Could not load", url);
      resolve(false);
    };
    document.head.appendChild(script);
  });
  loadedScripts.set(url, pending);
  return pending;
}

export async function ensureMermaid() {
  if (typeof mermaid !== "undefined") return true;
  if (!(await loadScriptOnce(LIB_URLS.mermaid))) return false;
  // setTheme() ran at boot and its configureMermaid() call was a no-op with no
  // library to configure. Apply the current theme now, or the first diagram
  // would draw in mermaid's own default palette.
  configureMermaid(currentThemeId());
  return true;
}

export async function ensureJsZip() {
  if (window.JSZip) return true;
  return loadScriptOnce(LIB_URLS.jszip);
}

// pdf.js, plus the one piece of setup it cannot do for itself here.
//
// The worker is the whole complication. pdf.js parses and rasterises off the
// main thread, and it needs a workerSrc to do it — but a CROSS-ORIGIN worker
// script cannot be constructed from its URL at all (the Worker constructor
// rejects it), which is exactly what a jsdelivr URL is. The standard answer is
// to fetch the worker source and wrap it in a Blob, and it has a second benefit
// here: the fetch goes through the page's own service-worker-controlled path,
// so it is answered from the precache with no connection — whereas a fetch
// pdf.js made internally would not necessarily be.
//
// If any of that fails, workerSrc is set to the plain CDN URL rather than left
// unset — see the note in the catch below, which is where the reasoning that
// used to sit here turned out to be wrong about what pdf.js actually does.
export let pdfWorkerBlobUrl = "";

export async function ensurePdfJs() {
  if (!window.pdfjsLib) {
    if (!(await loadScriptOnce(LIB_URLS.pdfjs))) return false;
  }
  if (!window.pdfjsLib) return false;
  if (pdfWorkerBlobUrl || window.pdfjsLib.GlobalWorkerOptions?.workerSrc) return true;
  try {
    const response = await fetch(LIB_URLS.pdfjsWorker);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = await response.blob();
    pdfWorkerBlobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerBlobUrl;
  } catch (error) {
    console.warn("pdf.js worker unavailable — naming the CDN copy instead", error);
  }
  // ── The fallback, written down rather than assumed ─────────────────────────
  //
  // This used to leave workerSrc UNSET, on the stated belief that pdf.js then
  // falls back to a main-thread "fake worker" — slower, but correct. Checked
  // against the build this app actually pins (3.11.174, legacy), that is not
  // what happens. PDFWorker.workerSrc reads GlobalWorkerOptions.workerSrc and,
  // when it is empty, falls back to a URL it derived from document.currentScript
  // at LIBRARY EVALUATION time — throwing `No "GlobalWorkerOptions.workerSrc"
  // specified.` when even that is null. The read sits outside its own
  // try/catch, so that throw comes straight back out of getDocument().
  //
  // Which is to say: whether this branch degraded gracefully or failed outright
  // depended on whether document.currentScript happened to be readable when
  // pdf.js evaluated. True for the classic <script> loadScriptOnce injects;
  // false the moment anything loads pdf.js another way — which is exactly what
  // tools/pdf-preview-check.mjs does, and why it has to install a workerSrc of
  // its own. Not a thing to leave to chance in a branch that only ever runs
  // after something else has already gone wrong.
  //
  // So name it. pdf.js's own createCDNWrapper wraps a cross-origin worker URL
  // in a blob that importScripts() it, so the Worker constructor's same-origin
  // rule is pdf.js's problem rather than ours — and a worker created from a
  // blob URL inherits this page's service worker, so it still resolves from the
  // precache with no connection, which was the whole point of the fetch above.
  const options = window.pdfjsLib.GlobalWorkerOptions;
  if (options && !options.workerSrc) options.workerSrc = LIB_URLS.pdfjsWorker;
  return true;
}

export async function ensureNomnoml() {
  if (typeof nomnoml !== "undefined") return true;
  // Sequential, not Promise.all: nomnoml reads graphre off the global at
  // evaluation time.
  if (!(await loadScriptOnce(LIB_URLS.graphre))) return false;
  return loadScriptOnce(LIB_URLS.nomnoml);
}

export async function ensureTurndown() {
  if (typeof TurndownService !== "undefined") return true;
  if (!(await loadScriptOnce(LIB_URLS.turndown))) return false;
  // The gfm plugin augments TurndownService, so it must come second. Its
  // absence is survivable (tables and strikethrough convert less well), so a
  // failure here doesn't fail the whole thing.
  await loadScriptOnce(LIB_URLS.turndownGfm);
  return true;
}

// Called once the app is interactive. The ensureX() guards above are the
// correctness backstop, but they make the caller wait; warming the libraries
// while the user is still reading their first card means that by the time
// anyone renders a diagram, runs a backup or pastes rich text, the library is
// already there. Idle-time and unawaited, so it cannot get in front of
// anything the user is doing.
//
// This also covers htmlToMarkdown's paste path, which reads clipboardData
// synchronously and so genuinely cannot await a loader mid-event.
export let deferredLibrariesWarmed = false;

export function warmDeferredLibraries() {
  if (deferredLibrariesWarmed) return;
  deferredLibrariesWarmed = true;
  const warm = () => {
    ensureMermaid();
    ensureJsZip();
    ensureNomnoml();
    ensureTurndown();
    // Deliberately NOT pdf.js. It is far heavier than any of the four above
    // (the library and its worker together are over a megabyte), and unlike a
    // diagram or a paste, nothing reaches it by accident: only importing a PDF
    // or opening a PDF deck does, and both of those already await
    // ensurePdfJs(). Warming it would cost every user that download for a
    // feature most of them never open.
  };
  // Held back a couple of seconds and THEN made to wait for an idle moment.
  // Both halves matter: the app is still rendering its first deck when this is
  // armed, and requestIdleCallback alone would happily fire during one of
  // boot's IndexedDB awaits — dropping a 3.3MB mermaid parse straight into the
  // window this whole change exists to clear. Anyone who reaches a diagram
  // before then simply loads it through the ensureX() guard instead.
  setTimeout(() => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 5000 });
    else warm();
  }, 2000);
}
