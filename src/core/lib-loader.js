// The CDN libraries that are NOT loaded up front.
//
// Every URL here must stay byte-identical to its counterpart in sw.js's
// CDN_ASSETS: the service worker precaches by exact URL, so a mismatch means
// the precache holds a file nothing asks for while the real request goes to a
// network that may not be there. That contract is the whole reason these can
// be deferred without giving up offline support.

import { configureMermaid, currentThemeId } from "../main.js?v=__BUILD__";

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
  turndownGfm: `${CDN_BASE}turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js`
};

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
