// Copying a web page's pictures into Recall's own image storage when its import
// is confirmed.
//
// A picture left on the site it came from breaks the day that site moves it,
// renames it, puts it behind a login or starts refusing other sites — and food
// and news sites refuse other sites routinely (hotlink protection). So each one
// is fetched once, here, and stored where the reader's other images are; the
// note then points at that copy.
//
// Fetching another site's picture from a page needs that site to allow it
// (CORS), and most do not. Those go through wsrv.nl, a free public image proxy
// that fetches the picture itself and serves the same bytes with CORS allowed —
// the same kind of third party r.jina.ai already is for a link import, and it
// sees nothing but the picture's own address. A picture neither route can get
// keeps its web address; the note still shows it wherever the site allows.

import { compressImageToPreset, readImageCompressionChoice } from "../images/compress.js?v=__BUILD__";
import { storageFolderSlug, storageGroupId, uploadImage } from "../images/upload.js?v=__BUILD__";
import { isHttpUrl } from "./web-text.js?v=__BUILD__";

export const IMAGE_PROXY_BASE = "https://wsrv.nl/";

// Pictures copied at once. A recipe has a dozen; a long article can have fifty,
// and the reader's storage should not see fifty uploads land in the same second.
export const WEB_IMAGE_CONCURRENCY = 3;

export const WEB_IMAGE_FETCH_TIMEOUT_MS = 20000;

export const WEB_IMAGE_UPLOAD_ATTEMPTS = 3;

export const WEB_IMAGE_RETRY_BASE_MS = 600;

// Larger than any picture worth keeping in a note; a link to a huge file stays a link.
export const WEB_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

export function proxiedImageUrl(url) {
  // n=-1 keeps every frame of an animated picture; without it the proxy sends
  // the first frame only.
  return `${IMAGE_PROXY_BASE}?url=${encodeURIComponent(url)}&n=-1`;
}

// Swappable for tools/web-page-import-check.mjs, which must not reach the
// network or a real storage bucket.
export const defaultWebImageTransport = {
  fetch: (url, init) => fetch(url, init),
  upload: (file, options) => uploadImage(file, options),
  online: () => typeof navigator === "undefined" || navigator.onLine !== false
};

let webImageTransport = defaultWebImageTransport;

export function setWebImageTransport(next) {
  webImageTransport = { ...defaultWebImageTransport, ...next };
}

export function resetWebImageTransport() {
  webImageTransport = defaultWebImageTransport;
}

// The bytes of one picture, as an image File, or null.
export async function fetchImageBlob(url) {
  let signal;
  try { signal = AbortSignal.timeout(WEB_IMAGE_FETCH_TIMEOUT_MS); } catch (_) { /* pre-2022 engine */ }
  const response = await webImageTransport.fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", signal });
  if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
  const blob = await response.blob();
  const type = String(blob.type || response.headers?.get?.("content-type") || "").split(";")[0].trim();
  if (!type.startsWith("image/")) throw new Error(`not an image (${type || "no type"})`);
  if (!blob.size || blob.size > WEB_IMAGE_MAX_BYTES) throw new Error(`unusable size ${blob.size}`);
  const name = decodeURIComponent((new URL(url).pathname.split("/").pop() || "image").replace(/\.[^.]*$/, "")) || "image";
  return new File([blob], name.slice(0, 80), { type });
}

// Straight from the site when it allows it, else through the proxy.
export async function fetchWebImage(url) {
  try {
    return await fetchImageBlob(url);
  } catch (_) {
    return fetchImageBlob(proxiedImageUrl(url));
  }
}

export async function uploadWithRetry(file, options) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await webImageTransport.upload(file, options);
    } catch (error) {
      const worthRetrying = error?.message !== "NOT_SIGNED_IN" && error?.message !== "OFFLINE" && !error?.authFailed;
      if (!worthRetrying || attempt >= WEB_IMAGE_UPLOAD_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, WEB_IMAGE_RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
}

// Every picture in `urls` copied into storage. Returns { map, failed, skipped }:
// `map` is { webUrl: storedUrl } for the ones that made it; `skipped` names why
// nothing was tried at all (offline, signed out), so the caller can say so.
export async function copyWebImages(urls, { title = "", onProgress = () => {} } = {}) {
  const list = (urls || []).filter(isHttpUrl);
  const map = {};
  if (!list.length) return { map, failed: 0, skipped: "" };
  if (!webImageTransport.online()) return { map, failed: list.length, skipped: "offline" };
  const folder = `web/${storageFolderSlug(title, "page")}--${storageGroupId()}`;
  const choice = readImageCompressionChoice();
  let done = 0;
  let failed = 0;
  let stop = "";
  let next = 0;
  const worker = async () => {
    while (next < list.length && !stop) {
      const url = list[next];
      next += 1;
      try {
        const original = await fetchWebImage(url);
        const compressed = await compressImageToPreset(original, choice).catch(() => null);
        map[url] = await uploadWithRetry(compressed?.file || original, { folder });
      } catch (error) {
        failed += 1;
        // Nothing else will upload either; stop rather than fail each in turn.
        if (error?.message === "NOT_SIGNED_IN" || error?.message === "OFFLINE" || error?.authFailed) stop = error.message || "refused";
      }
      done += 1;
      onProgress(done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WEB_IMAGE_CONCURRENCY, list.length) }, worker));
  if (stop) failed = list.length - Object.keys(map).length;
  return { map, failed, skipped: stop && !Object.keys(map).length ? stop : "" };
}
