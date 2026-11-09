// Recall Web Clipper — the offscreen document (see pdf-job.js, "saving").
//
// A service worker cannot make a blob: address, and handing Chrome's downloads
// a whole PDF as a data: address is fragile for big files. So the worker puts
// the finished PDF in Cache Storage (shared with this page, same origin), and
// this page turns it into a blob: address for chrome.downloads — then lets it
// go once the download is over. Nothing else lives here.

const CACHE = "rwc-out";
const urls = new Map(); // cache key → blob: address

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  if (msg.type === "rwc-offscreen-url") {
    (async () => {
      const cache = await caches.open(CACHE);
      const res = await cache.match(msg.key);
      if (!res) return { ok: false, error: "not kept" };
      const blob = await res.blob();
      const old = urls.get(msg.key);
      if (old) URL.revokeObjectURL(old);
      const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "application/pdf" }));
      urls.set(msg.key, url);
      return { ok: true, url };
    })().then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === "rwc-offscreen-revoke") {
    const url = urls.get(msg.key);
    if (url) URL.revokeObjectURL(url);
    urls.delete(msg.key);
    sendResponse({ ok: true, left: urls.size });
    return false;
  }
  return false;
});
