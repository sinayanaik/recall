// Recall Web Clipper — background service worker (Manifest V3, module).
//
// One extension, three jobs, all on demand: nothing runs on any page until you
// use the toolbar popup (or a shortcut) on the tab you want. That gesture,
// with the "activeTab" permission, is what grants the right to work on exactly
// that one tab — no always-on content scripts.
//
//   • Copy as Markdown (Alt+Shift+M) — the picker, content/picker.js;
//   • Clean this page  (Alt+Shift+C) — the cleaner toolbar, content/cleaner-ui.js;
//   • Save as PDF      (Alt+Shift+P) — pdf-job.js, with the options the popup sets.
//
// The cleaner's "Save as PDF" and "Copy as Markdown" buttons come back here as
// messages, so a cleaned page goes straight on to either.

import { runJob, lastOptions, jobFor } from "./pdf-job.js";

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/i;
const STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

export function canScript(tab) {
  const url = (tab && tab.url) || "";
  return Boolean(tab && tab.id != null) && !RESTRICTED.test(url) && !STORE.test(url);
}

// ---------------------------------------------------------------- Copy as Markdown

const VENDOR = [
  "vendor/turndown.js",
  "vendor/turndown-plugin-gfm.js",
  "vendor/purify.min.js",       // sanitises the rendered preview
  "vendor/marked.min.js",       // renders the Markdown preview
  "content/recall-math.js",     // math capture + Recall's math scanner (ported)
  "content/recall-render.js"    // Recall's exact render pipeline (ported)
];

// Heavy libraries that make the preview a pixel-faithful match for a Recall
// file. Injected lazily on the first Preview (see the message handler) so the
// common "click → Copy Markdown" path never pays their cost. Order matters:
// Prism core before languages/autoloader; KaTeX before its auto-render helper.
const PREVIEW_JS = [
  "vendor/prism/prism-core.min.js",
  "vendor/prism/prism-python.min.js",
  "vendor/prism/prism-autoloader.min.js",
  "vendor/katex/katex.min.js",
  "vendor/katex/auto-render.min.js",
  "vendor/mermaid/mermaid.min.js",
  "vendor/nomnoml/nomnoml.js"
];

// MathJax keeps every formula's original LaTeX in a page-world global, which is
// invisible from the isolated world the rest of our code runs in. This one file
// is injected into the page's MAIN world to copy that source onto the DOM, where
// the picker can read it. Best-effort: a page without MathJax just returns 0,
// and the picker falls back to reading MathML.
async function stampMathSource(tabId, frameId) {
  const target = { tabId };
  if (frameId != null) target.frameIds = [frameId];
  try {
    const results = await chrome.scripting.executeScript({
      target,
      world: "MAIN",
      files: ["content/mathjax-source.js"]
    });
    return results.reduce((sum, r) => sum + (Number(r && r.result) || 0), 0);
  } catch (err) {
    // MAIN-world injection is unavailable on older Chrome, and blocked on a few
    // pages. Neither is fatal — it only costs fidelity, not capture.
    console.warn("Recall Web Clipper: could not read MathJax source —", err?.message || err);
    return 0;
  }
}

export async function startClipper(tab) {
  if (!canScript(tab)) return false;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/picker.css"] });
    await stampMathSource(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [...VENDOR, "content/picker.js"] });
    return true;
  } catch (err) {
    // Most commonly a restricted page. Nothing else we can do from here.
    console.warn("Recall Web Clipper: could not inject into this page —", err?.message || err);
    return false;
  }
}

// First Preview in a tab asks us to inject the heavy render libraries + their
// stylesheets. KaTeX's CSS references its font files by relative path; we
// rewrite those to absolute extension URLs (the fonts are web_accessible) and
// inject via insertCSS so the page's own CSP can't block them.
async function loadPreviewLibs(tabId, frameId) {
  const target = { tabId };
  if (frameId != null) target.frameIds = [frameId];

  await chrome.scripting.executeScript({ target, files: PREVIEW_JS });
  await chrome.scripting.insertCSS({ target, files: ["vendor/prism/prism-tomorrow.min.css"] });

  let katexCss = await (await fetch(chrome.runtime.getURL("vendor/katex/katex.min.css"))).text();
  const fontsBase = chrome.runtime.getURL("vendor/katex/fonts/");
  katexCss = katexCss.replace(/url\(\s*(['"]?)fonts\//g, (_m, q) => `url(${q}${fontsBase}`);
  await chrome.scripting.insertCSS({ target, css: katexCss });
  return true;
}

// ---------------------------------------------------------------- Clean this page

export async function startCleaner(tab) {
  if (!canScript(tab)) return false;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/cleaner.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/cleaner-core.js", "content/cleaner-ui.js"] });
    return true;
  } catch (err) {
    console.warn("Recall Web Clipper: could not inject the cleaner —", err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------- wiring

const reply = (promise, sendResponse) => {
  promise
    .then((r) => sendResponse(r && typeof r === "object" ? r : { ok: Boolean(r) }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the message channel open for the async response
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  const tabId = sender.tab && sender.tab.id;

  // From the picker.
  if (msg.type === "rc-load-preview-libs" && tabId != null) return reply(loadPreviewLibs(tabId, sender.frameId), sendResponse);
  // Re-read MathJax's source right before a clip, so formulas typeset after the
  // picker was switched on (lazy sections, an SPA route change) are stamped too.
  if (msg.type === "rc-stamp-math" && tabId != null) {
    return reply(stampMathSource(tabId, sender.frameId).then((count) => ({ ok: true, count })), sendResponse);
  }

  // From the cleaner's toolbar: the cleaned page goes on to a PDF or the picker.
  // Cleaning first is skipped for the PDF — it already happened.
  if (msg.type === "rwc-save-pdf" && tabId != null) {
    return reply(lastOptions().then((opts) => runJob(tabId, { ...opts, clean: "off", capture: "page" })), sendResponse);
  }
  if (msg.type === "rwc-clip" && sender.tab) return reply(startClipper(sender.tab), sendResponse);

  // From the popup, which is not in a tab: it names the tab.
  if (msg.type === "rwc-start-pdf") return reply(runJob(msg.tabId, msg.options), sendResponse);
  if (msg.type === "rwc-get-status") { sendResponse(jobFor(msg.tabId)); return false; }
  if (msg.type === "rwc-clean" || msg.type === "rwc-copy") {
    const start = msg.type === "rwc-clean" ? startCleaner : startClipper;
    return reply(chrome.tabs.get(msg.tabId).then(start), sendResponse);
  }
  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === "toggle-clipper") startClipper(tab);
  else if (command === "toggle-cleaner") startCleaner(tab);
  else if (command === "save-pdf") {
    const opts = await lastOptions();
    runJob(tab.id, { ...opts, capture: opts.capture === "element" || opts.capture === "selection" ? opts.capture : "page" }).catch(() => {});
  }
});
