// Recall Web Clipper — the offscreen document (see pdf-job.js, "saving").
//
// A service worker cannot make a blob: address, and handing Chrome's downloads
// a whole PDF as a data: address is fragile for big files. So the worker puts
// the finished PDF in Cache Storage (shared with this page, same origin), and
// this page turns it into a blob: address for chrome.downloads — then lets it
// go once the download is over.
//
// It also picks the middle frame out of a moving picture (a GIF, or an
// animated WebP, PNG or AVIF) for Save as PDF: ImageDecoder, which can, is
// not there in a service worker.

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
  if (msg.type === "rwc-offscreen-middle-frame") {
    middleFrame(msg.b64, msg.mime).then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
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

// The middle frame (by count) of a moving picture, as PNG bytes in base64.
async function middleFrame(b64, mime) {
  if (typeof ImageDecoder === "undefined") return { ok: false, error: "no ImageDecoder" };
  if (!(await ImageDecoder.isTypeSupported(mime))) return { ok: false, error: `cannot decode ${mime}` };
  const bin = atob(b64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) data[i] = bin.charCodeAt(i);
  const decoder = new ImageDecoder({ data, type: mime });
  try {
    // The track says how many frames there are once all the data is read.
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const frames = track ? track.frameCount : 1;
    const index = Math.floor(frames / 2);
    const { image } = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
    try {
      const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
      canvas.getContext("2d").drawImage(image, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let out = "";
      for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { ok: true, frames, index, b64: btoa(out) };
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}
