// Recall Page Cleaner — background service worker (Manifest V3).
//
// On demand only, like Recall Clipper: nothing runs on a page until the
// toolbar icon (or Alt+Shift+C) is used on it. That gesture plus "activeTab"
// is what lets us inject into exactly that tab.

// Recall Web to PDF's ID. It is fixed by the "key" in that extension's
// manifest.json, so it is the same on every install — which is what lets this
// extension hand a cleaned page over to it.
const WEB_TO_PDF_ID = "jcggbcoegkedmplddimgefonccicnihb";

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/i;

async function activateOnTab(tab) {
  if (!tab || tab.id == null) return;
  const url = tab.url || "";
  if (RESTRICTED.test(url) || url.startsWith("https://chromewebstore.google.com")
      || url.startsWith("https://chrome.google.com/webstore")) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/cleaner.css"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/cleaner-core.js", "content/cleaner-ui.js"]
    });
  } catch (err) {
    console.warn("Recall Page Cleaner: could not inject into this page —", err?.message || err);
  }
}

chrome.action.onClicked.addListener((tab) => { activateOnTab(tab); });

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-cleaner") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activateOnTab(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "rpc-handoff-pdf" && sender.tab && sender.tab.id != null) {
    chrome.runtime.sendMessage(WEB_TO_PDF_ID, { type: "recall-print", tabId: sender.tab.id, from: "recall-page-cleaner" })
      .then((res) => sendResponse(res && typeof res === "object" ? res : { ok: false }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});
