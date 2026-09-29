// Files handed to the app from outside it: a .recall dropped onto the window,
// opened from the desktop with the installed app (manifest file_handlers →
// window.launchQueue), or sent from another app through the system share sheet
// (manifest share_target → the service worker, which parks the file and sends
// the page to ./?share-target=1).
//
// All three end in loadFiles — the same place the Import button's picker ends
// — so a package opened any way goes through the same preview. They wait for
// the app itself to be on screen first: a file opened on a cold start would
// otherwise put its preview over the sign-in page.

import { loadFiles } from "../import/files.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

const SHARE_TARGET_CACHE_NAME = "recall-share-target-v1";

const SHARE_TARGET_PREFIX = "__share-target/";

export function appShellShown() {
  const shell = document.querySelector(".app-shell");
  return Boolean(shell) && !shell.hidden;
}

// Run `fn` once the app shell is visible — now, if it already is.
export function whenAppShellShown(fn) {
  if (appShellShown()) {
    fn();
    return;
  }
  const shell = document.querySelector(".app-shell");
  if (!shell || typeof MutationObserver !== "function") {
    const timer = setInterval(() => {
      if (!appShellShown()) return;
      clearInterval(timer);
      fn();
    }, 500);
    return;
  }
  const observer = new MutationObserver(() => {
    if (!appShellShown()) return;
    observer.disconnect();
    fn();
  });
  observer.observe(shell, { attributes: true, attributeFilter: ["hidden"] });
}

// A file the page takes from a drop anywhere on it: a package, a backup, a
// deck bundle. Deliberately not every kind Import reads — a PDF dropped while
// reading a paper, or an image, has other places it may be meant for.
export function isDroppableImportFile(file) {
  const name = String(file?.name || "").toLowerCase();
  return /\.(recall|zip|json)$/.test(name);
}

function dragCarriesFiles(transfer) {
  return Array.from(transfer?.types || []).includes("Files");
}

function isEditableTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest("textarea, input, [contenteditable=''], [contenteditable='true']"));
}

async function takeSharedFiles() {
  if (typeof caches === "undefined") return [];
  const cache = await caches.open(SHARE_TARGET_CACHE_NAME);
  const files = [];
  for (const request of await cache.keys()) {
    if (!new URL(request.url).pathname.includes(`/${SHARE_TARGET_PREFIX}`)) continue;
    const response = await cache.match(request);
    if (response) {
      const blob = await response.blob();
      const name = decodeURIComponent(response.headers.get("x-recall-file-name") || "shared.recall");
      files.push(new File([blob], name, { type: blob.type || "application/octet-stream" }));
    }
    await cache.delete(request);
  }
  return files;
}

function dropUrlFlag(flag) {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has(flag)) return;
    url.searchParams.delete(flag);
    history.replaceState(history.state, "", url.pathname + (url.search || "") + url.hash);
  } catch {
    // Cosmetic only.
  }
}

export function installIncomingFiles() {
  // Drop anywhere. Only when nothing more specific took the drop — a card
  // editor's image drop and the handwriting page's run first and prevent the
  // default when they do.
  document.addEventListener("dragover", (event) => {
    if (event.defaultPrevented || !dragCarriesFiles(event.dataTransfer) || isEditableTarget(event.target)) return;
    if (!appShellShown()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("drop", (event) => {
    if (event.defaultPrevented || isEditableTarget(event.target) || !appShellShown()) return;
    const files = Array.from(event.dataTransfer?.files || []).filter(isDroppableImportFile);
    if (!files.length) {
      if (dragCarriesFiles(event.dataTransfer)) event.preventDefault();
      return;
    }
    event.preventDefault();
    loadFiles(files);
  });

  // Opened with the installed app from the desktop.
  if (typeof window !== "undefined" && window.launchQueue && typeof window.launchQueue.setConsumer === "function") {
    window.launchQueue.setConsumer(async (params) => {
      const handles = Array.from(params?.files || []);
      if (!handles.length) return;
      const files = [];
      for (const handle of handles) {
        try { files.push(await handle.getFile()); } catch (error) { console.warn("Could not open a launched file", error); }
      }
      dropUrlFlag("open-file");
      if (files.length) whenAppShellShown(() => loadFiles(files));
    });
  }

  // Sent from another app through the share sheet.
  try {
    if (new URLSearchParams(location.search).has("share-target")) {
      dropUrlFlag("share-target");
      takeSharedFiles().then((files) => {
        if (!files.length) {
          whenAppShellShown(() => showToast("Nothing arrived with that share — try sending the .recall file again", "error"));
          return;
        }
        whenAppShellShown(() => loadFiles(files));
      }).catch((error) => console.warn("Could not read a shared file", error));
    }
  } catch (error) {
    console.warn("Could not check for a shared file", error);
  }
}
