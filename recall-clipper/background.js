// Recall Clipper — background service worker (Manifest V3).
//
// Fully on-demand: nothing runs on any page until the user clicks the toolbar
// icon (or presses the hotkey) on a tab they want to clip. That user gesture,
// combined with the "activeTab" permission, is what grants us the right to
// inject into exactly that one tab — no broad host permissions, no always-on
// content scripts. The picker itself is self-toggling, so a second activation
// on the same tab just tears it down.

const VENDOR = [
  "vendor/turndown.js",
  "vendor/turndown-plugin-gfm.js",
  "vendor/purify.min.js",       // sanitises the rendered preview
  "vendor/marked.min.js",       // renders the Markdown preview
  "content/recall-render.js"    // Recall's exact render pipeline (ported)
];

// Heavy libraries that make the preview a pixel-faithful match for a Recall
// deck. Injected lazily on the first Preview (see the message handler) so the
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

async function activateOnTab(tab) {
  if (!tab || !tab.id) return;
  // Guard against pages we can never script (Chrome Web Store, chrome://, etc.).
  const url = tab.url || "";
  if (/^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/i.test(url)
      || url.startsWith("https://chrome.google.com/webstore")
      || url.startsWith("https://chromewebstore.google.com")) {
    return;
  }
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content/picker.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [...VENDOR, "content/picker.js"]
    });
  } catch (err) {
    // Most commonly a restricted page. Nothing else we can do from here.
    console.warn("Recall Clipper: could not inject into this page —", err?.message || err);
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "rc-load-preview-libs" && sender.tab && sender.tab.id != null) {
    loadPreviewLibs(sender.tab.id, sender.frameId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => { console.warn("Recall Clipper: preview libs failed —", err); sendResponse({ ok: false }); });
    return true; // keep the message channel open for the async response
  }
});

chrome.action.onClicked.addListener((tab) => { activateOnTab(tab); });

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-clipper") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activateOnTab(tab);
});
