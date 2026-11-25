// Recall Drag to Canvas — the toolbar popup: the how-to, and three switches.
//
//   • Show the grips without holding Alt — this tab only, held by the content
//     script (content/drag.js) until turned off; Alt+Shift+D does the same.
//   • Off on this site — remembered (chrome.storage.sync offSites).
//   • On — everywhere (chrome.storage.sync enabled).

const $ = (id) => document.getElementById(id);
const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

$("version").textContent = `v${chrome.runtime.getManifest().version}`;

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname = "";
  try { hostname = tab && tab.url ? new URL(tab.url).hostname : ""; } catch (_) { hostname = ""; }
  const usable = Boolean(tab && tab.id != null && tab.url && !RESTRICTED.test(tab.url) && hostname);
  $("host").textContent = hostname || "this site";
  $("blocked").hidden = usable;

  const settings = await chrome.storage.sync.get({ enabled: true, offSites: [] });
  $("enabled").checked = settings.enabled !== false;
  $("site").checked = (settings.offSites || []).includes(hostname);
  $("site").disabled = !hostname;

  let state = null;
  if (usable) state = await chrome.tabs.sendMessage(tab.id, { type: "rdc-get-state" }).catch(() => null);
  $("grips").checked = Boolean(state && state.gripsOn);
  // A tab opened before the extension was installed has no content script
  // until it is reloaded.
  $("grips").disabled = !state;
  if (usable && !state) {
    $("blocked").hidden = false;
    $("blocked").textContent = "Reload this page to use it here: it was open before the extension was.";
  }

  $("grips").addEventListener("change", async () => {
    const answer = await chrome.tabs.sendMessage(tab.id, { type: "rdc-set-grips", on: $("grips").checked }).catch(() => null);
    if (answer) $("grips").checked = answer.gripsOn;
  });
  $("site").addEventListener("change", async () => {
    const { offSites = [] } = await chrome.storage.sync.get({ offSites: [] });
    const next = offSites.filter((h) => h !== hostname);
    if ($("site").checked) next.push(hostname);
    await chrome.storage.sync.set({ offSites: next });
  });
  $("enabled").addEventListener("change", () => chrome.storage.sync.set({ enabled: $("enabled").checked }));
}

main().catch((error) => {
  $("blocked").hidden = false;
  $("blocked").textContent = String((error && error.message) || error);
});
