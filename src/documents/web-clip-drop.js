// What the Recall Drag to Canvas extension drops onto a Canvas page.
//
// The extension (recall-canvas-drag/) puts a ⠿ grip on any part of any web
// page, and dragging it carries that part as one JSON value under
// WEB_CLIP_MIME, beside the text/html and text/plain any drag has:
//
//   { v: 1, kind, html, text, title, url,
//     images:  { webAddress: "data:image/…" },   // the pictures' own bytes
//     picture: { dataUrl, width, height, cssWidth, cssHeight, cut } | null }
//
// `html` is already cleaned in the page it came from — hidden things out,
// addresses whole, a picture's shown source chosen, canvases and large SVGs made
// pictures — so it is read the way any web page's HTML dropped here is
// (canvasItemFromStrings, ./canvas-drop.js). What the extension adds is the
// bytes: the pictures it fetched (which a site's CORS rules stop this page from
// doing) are stored with the reader's other pictures, and the Block made from
// the drop is pointed at the stored copies as each one lands
// (settleBlockUploadToken). Until then, and for good if storing fails, it shows
// them by their web address, as any dropped HTML does.
//
// `picture` is the part as it looked on the page, taken when it was picked: a
// drop with Shift held puts that on the page instead, as a picture Block.

import { copyWebImages } from "../import/web-images.js?v=__BUILD__";
import { settleBlockUploadToken } from "./pdf-blocks.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

export const WEB_CLIP_MIME = "application/x-recall-web-clip";

const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*(?:;base64)?,/i;

// The clip, checked, or null.
export function readWebClip(raw) {
  if (!raw) return null;
  let clip;
  try { clip = JSON.parse(raw); } catch { return null; }
  if (!clip || typeof clip !== "object" || clip.v !== 1 || typeof clip.html !== "string") return null;
  const images = {};
  if (clip.images && typeof clip.images === "object") {
    for (const [url, data] of Object.entries(clip.images)) {
      if (/^https?:\/\//i.test(url) && typeof data === "string" && DATA_IMAGE_RE.test(data)) images[url] = data;
    }
  }
  const picture = clip.picture && typeof clip.picture === "object" && typeof clip.picture.dataUrl === "string" && DATA_IMAGE_RE.test(clip.picture.dataUrl)
    ? {
      dataUrl: clip.picture.dataUrl,
      cssWidth: Number(clip.picture.cssWidth) || 0,
      cssHeight: Number(clip.picture.cssHeight) || 0,
      cut: Boolean(clip.picture.cut)
    }
    : null;
  return {
    kind: String(clip.kind || ""),
    html: clip.html,
    text: String(clip.text || ""),
    title: String(clip.title || ""),
    url: /^https?:\/\//i.test(String(clip.url || "")) ? String(clip.url) : "",
    images,
    picture
  };
}

const EXT_FOR = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif" };

// A data: address as a File, or null.
export function dataUrlToFile(dataUrl, name = "picture") {
  const match = /^data:([^;,]+)((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!match || !match[1].startsWith("image/")) return null;
  const type = match[1].toLowerCase();
  let bytes;
  try {
    if (match[3]) {
      const binary = atob(match[4]);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(match[4]));
    }
  } catch {
    return null;
  }
  if (!bytes.length) return null;
  const base = String(name || "picture").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "picture";
  return new File([bytes], `${base}.${EXT_FOR[type] || "png"}`, { type });
}

// The picture of the part, as a File.
export function webClipPictureFile(clip) {
  return clip?.picture ? dataUrlToFile(clip.picture.dataUrl, clip.title || "web picture") : null;
}

// Its width on the Canvas, in points: the size it was on the page (a CSS pixel
// is three quarters of a point), no wider than `maxWidth`.
export function webClipPictureWidth(clip, maxWidth) {
  const css = Number(clip?.picture?.cssWidth) || 0;
  if (!css) return null;
  return Math.max(24, Math.min(Number(maxWidth) || Infinity, Math.round(css * 0.75)));
}

// Every picture address markdown shows, in order, once each.
export function markdownPictureUrls(md) {
  const out = [];
  const text = String(md || "");
  const push = (url) => { if (url && !out.includes(url)) out.push(url); };
  for (const match of text.matchAll(/!\[[^\]]*\]\(\s*<([^>]+)>|!\[[^\]]*\]\(\s*([^)\s]+)/g)) push(match[1] || match[2]);
  for (const match of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) push(match[1] || match[2]);
  return out;
}

// The pictures the Block made from `md` shows, stored with the reader's other
// pictures, and the Block pointed at the copies. Best-effort: a picture that
// cannot be stored keeps its address.
export async function keepWebClipPictures(clip, md) {
  const urls = markdownPictureUrls(md).filter((url) => /^https?:\/\//i.test(url) || DATA_IMAGE_RE.test(url));
  if (!urls.length) return { kept: 0, failed: 0, skipped: "" };
  const files = {};
  urls.forEach((url, index) => {
    const data = DATA_IMAGE_RE.test(url) ? url : clip?.images?.[url];
    const file = data ? dataUrlToFile(data, `${clip?.title || "web"} ${index + 1}`) : null;
    if (file) files[url] = file;
  });
  const copied = await copyWebImages(urls, { title: clip?.title || "web", files });
  let kept = 0;
  for (const [from, to] of Object.entries(copied.map)) {
    if (to && settleBlockUploadToken(from, to)) kept += 1;
  }
  if (copied.skipped === "NOT_SIGNED_IN") {
    showToast("The pictures are shown from the web page — sign in to keep copies of them", "info");
  }
  return { kept, failed: copied.failed, skipped: copied.skipped };
}
