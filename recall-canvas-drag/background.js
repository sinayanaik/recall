// Recall Drag to Canvas — background service worker (Manifest V3, module).
//
// The content script (content/drag.js) runs in every page and does the picking
// and the dragging. It asks this worker for the two things a page cannot do for
// itself:
//
//   • rdc-fetch-image — a picture's bytes, as a data: URL. The page's own fetch
//     is bound by the site's CORS rules; this worker's host permission is not,
//     so a picture the site shows can be carried into Recall whole instead of
//     as a link that breaks when the site moves it.
//   • rdc-capture — a picture of the part of the tab an element covers
//     (chrome.tabs.captureVisibleTab, cropped here), for a drop with Shift held.
//
// And it relays the Alt+Shift+D shortcut to the tab: show the grips without
// holding Alt.
//
// Nothing is uploaded anywhere: everything goes from here to the page, and from
// the page into the drag.

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
// captureVisibleTab allows about two calls a second per window.
const CAPTURE_GAP_MS = 550;
const LARGE_CAPTURE_BYTES = 3 * 1024 * 1024;

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
  });
}

async function fetchImage(url) {
  if (!/^https?:\/\//i.test(String(url || ""))) return { ok: false, error: "not a web address" };
  let signal;
  try { signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); } catch (_) { /* older engine */ }
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal });
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  const blob = await response.blob();
  const type = String(blob.type || response.headers.get("content-type") || "").split(";")[0].trim();
  if (!type.startsWith("image/")) return { ok: false, error: `not a picture (${type || "no type"})` };
  if (!blob.size || blob.size > MAX_IMAGE_BYTES) return { ok: false, error: `size ${blob.size}` };
  const typed = blob.type === type ? blob : new Blob([blob], { type });
  return { ok: true, dataUrl: await blobToDataUrl(typed), type, bytes: blob.size };
}

let lastCapture = 0;
let captureQueue = Promise.resolve();

// `rect` is in CSS pixels of the tab's viewport, `dpr` its devicePixelRatio
// (and zoom): the screenshot is in device pixels.
function capture(windowId, rect, dpr) {
  const run = async () => {
    const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCapture = Date.now();
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
    const scale = Number(dpr) > 0 ? Number(dpr) : 1;
    const sx = Math.max(0, Math.round(rect.x * scale));
    const sy = Math.max(0, Math.round(rect.y * scale));
    const sw = Math.min(bitmap.width - sx, Math.round(rect.width * scale));
    const sh = Math.min(bitmap.height - sy, Math.round(rect.height * scale));
    if (sw < 2 || sh < 2) return { ok: false, error: "nothing on screen" };
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    bitmap.close?.();
    let blob = await canvas.convertToBlob({ type: "image/png" });
    // A large part (a long article, a full-width figure on a high-density
    // screen) can be tens of megabytes as a PNG, all of it carried in the drag:
    // past this size it goes as a JPEG, which keeps words readable at a
    // fraction of the size.
    if (blob.size > LARGE_CAPTURE_BYTES) {
      const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      if (jpeg.size < blob.size) blob = jpeg;
    }
    return { ok: true, dataUrl: await blobToDataUrl(blob), width: sw, height: sh, scale };
  };
  const next = captureQueue.then(run, run);
  captureQueue = next.catch(() => {});
  return next;
}

const reply = (promise, sendResponse) => {
  promise
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true; // the answer comes later
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  if (msg.type === "rdc-fetch-image") return reply(fetchImage(msg.url), sendResponse);
  if (msg.type === "rdc-capture" && sender.tab) return reply(capture(sender.tab.windowId, msg.rect || {}, msg.dpr), sendResponse);
  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-grips") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: "rdc-toggle-grips" }).catch(() => {});
});
