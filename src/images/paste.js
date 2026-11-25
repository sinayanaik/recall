// Getting an image out of a paste, a drag, or the file picker — including an
// animation copied off a web page, which arrives as a still plus its URL.

import { chooseImageCompression } from "./compress-dialog.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME, getOutboxImage, insertImageUpload, insertPreparedImageUpload, localImageObjectUrls, releaseImageSlots, reserveImageSlots, settleUploadToken } from "./outbox.js?v=__BUILD__";
import { S3_IMAGE_PREFIX, canonicalImageParts, canonicalImageUrlFor, s3ImagePartsFromKey, s3ImageUrlPrefix } from "../cloud/s3-images.js?v=__BUILD__";
import { CANONICAL_SRC_ATTR } from "../cloud/storage-urls.js?v=__BUILD__";
import { UNFILED_IMAGE_FOLDER, deckImageFolder, setImagePickerActive } from "./upload.js?v=__BUILD__";
import { isAnimatedImage, sniffImageType, withSniffedType } from "./compress.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// The web address of the picture a paste or drag came from, or null. When an
// image is copied out of a web page the clipboard holds a flattened still PNG
// of it, and the only way back to the animation is the original's URL, which
// the browser leaves alongside it in the HTML or the uri-list.
//
// Any http(s) URL is returned, not just one ending in .gif: Giphy, Tenor and
// most GIF sites serve animated WebP, or addresses with no extension at all.
// Whether the original is really animated is decided from its bytes once it
// has been fetched (fetchAnimatedOriginal), never from its name.
//
// DOMParser (not innerHTML) so parsing the fragment can't kick off a load of
// every image in it.
export function animatedSourceUrlFromTransfer(dataTransfer) {
  const isWebUrl = (url) => /^https?:/i.test(url);
  let html = "";
  try {
    html = dataTransfer?.getData?.("text/html") || "";
  } catch (_) { /* some transfer types are unreadable outside their own event */ }
  if (html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const imgs = doc.querySelectorAll("img");
      // More than one image means the paste is a chunk of a page, not a single
      // copied image — the markdown converter handles that case, not this one.
      if (imgs.length === 1) {
        const src = imgs[0].getAttribute("src") || "";
        if (isWebUrl(src)) return src;
      }
    } catch (_) { /* malformed fragment — fall through to the uri-list */ }
  }
  let uriList = "";
  try {
    uriList = dataTransfer?.getData?.("text/uri-list") || "";
  } catch (_) { /* as above */ }
  const uri = uriList.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  return uri && isWebUrl(uri) ? uri : null;
}

// ── A picture of our own, back from the clipboard ────────────────────────
//
// A picture copied out of this app (a Canvas Picture, a figure in the Notes or
// on a card — right-click → Copy image, or dragged) arrives as bytes AND as the
// address it was shown from: a presigned bucket URL, a signed Supabase URL, the
// canonical identifier itself, or the blob: URL of one still waiting to
// upload. Uploading the bytes again would store a second copy of a picture
// that is already stored, so the address is read back to the identifier the
// file keeps (src/cloud/s3-images.js) and that is what goes on the page.

const SUPABASE_SIGNED_IMAGE_RE = /^https:\/\/([^/?#]+)\/storage\/v1\/object\/sign\/images\/([^?#]+)/;

// The identifier a file keeps for the picture shown at `url` — or "" when it
// is not one of ours.
export function ownImageCanonical(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith(LOCAL_IMAGE_SCHEME)) return value;
  if (canonicalImageParts(value)) return value;
  const signed = SUPABASE_SIGNED_IMAGE_RE.exec(value);
  if (signed) {
    let path = signed[2];
    try { path = decodeURI(path); } catch { /* keep it as it is */ }
    return canonicalImageUrlFor(signed[1], path);
  }
  const prefix = s3ImageUrlPrefix();
  if (prefix && value.startsWith(prefix)) {
    const rest = value.slice(prefix.length).split(/[?#]/)[0];
    let key = "";
    try {
      key = `${S3_IMAGE_PREFIX}/${rest.split("/").map((part) => decodeURIComponent(part)).join("/")}`;
    } catch {
      return "";
    }
    const parts = s3ImagePartsFromKey(key);
    return parts ? canonicalImageUrlFor(parts.host, parts.path) : "";
  }
  if (value.startsWith("blob:")) {
    for (const [token, objectUrl] of localImageObjectUrls) {
      if (objectUrl === value) return `${LOCAL_IMAGE_SCHEME}${token}`;
    }
  }
  return "";
}

// Whether `own` (from ownImageCanonical) is a picture of the file open now —
// filed under its folder, or parked for it. Only those are put down by
// address: a picture of ANOTHER file is uploaded again for this one, since
// removing it from that file's Notes deletes its object (removeSourceImage,
// src/images/surface-controls.js), which would take it off this page too.
export async function isThisFilesPicture(own) {
  const folder = deckImageFolder();
  if (!own || !folder || folder === UNFILED_IMAGE_FOLDER) return false;
  if (own.startsWith(LOCAL_IMAGE_SCHEME)) {
    try {
      const entry = await getOutboxImage(own.slice(LOCAL_IMAGE_SCHEME.length));
      return Boolean(entry) && entry.folder === folder;
    } catch {
      return false;
    }
  }
  const parts = canonicalImageParts(own);
  if (!parts) return false;
  // <uid>/<folder…>/<name>
  return parts.path.split("/").slice(1).join("/").startsWith(`${folder}/`);
}

// The identifier of the one picture of ours a paste or a drop carries, or "".
// Read while the event is live, as every DataTransfer must be.
export function ownPictureFromTransfer(dataTransfer) {
  let html = "";
  try {
    html = dataTransfer?.getData?.("text/html") || "";
  } catch { /* unreadable outside its own event */ }
  if (html) {
    try {
      const imgs = new DOMParser().parseFromString(html, "text/html").querySelectorAll("img");
      if (imgs.length === 1) {
        const img = imgs[0];
        const own = ownImageCanonical(img.getAttribute(CANONICAL_SRC_ATTR)) || ownImageCanonical(img.getAttribute("src"));
        if (own) return own;
      }
      if (imgs.length > 1) return "";
    } catch { /* a fragment that does not parse: try the uri-list */ }
  }
  let uriList = "";
  try {
    uriList = dataTransfer?.getData?.("text/uri-list") || "";
  } catch { /* as above */ }
  const uri = uriList.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  return uri ? ownImageCanonical(uri) : "";
}

// A URL that names an animation outright — by extension, or by being one of
// the big GIF hosts. Only these are worth a toast while fetching, and only
// these are worth linking to when the fetch is refused: an ordinary picture
// copied off a page is better uploaded as the still it already is.
export function looksAnimatedUrl(url) {
  try {
    const parsed = new URL(url);
    if (/\.(gif|webp|apng)$/i.test(parsed.pathname)) return true;
    return /(^|\.)(giphy\.com|tenor\.com|tenor\.googleapis\.com|gfycat\.com)$/i.test(parsed.hostname);
  } catch (_) {
    return false;
  }
}

// Formats that cannot animate: not worth a fetch that would only hold up the
// compression dialog for a picture the clipboard already has.
export function cannotAnimateUrl(url) {
  try {
    return /\.(jpe?g|bmp|svg|ico|tiff?)$/i.test(new URL(url).pathname);
  } catch (_) {
    return true;
  }
}

// Long enough for a big GIF on a phone connection when the URL says it is an
// animation; short when it does not, since then the fetch is only a check.
export const ORIGINAL_FETCH_TIMEOUT_MS = 15000;

export const UNNAMED_FETCH_TIMEOUT_MS = 5000;

// The original behind a flattened paste, as a File — but only when it really
// is animated. A still comes back null, so the clipboard's own bitmap is used
// and nothing changes. `{ blocked: true }` means the site would not let this
// page read it (no CORS) or could not be reached, which is a different answer
// from "it is not animated": the caller may still link to it.
export async function fetchAnimatedOriginal(url, timeoutMs = ORIGINAL_FETCH_TIMEOUT_MS) {
  if (!navigator.onLine) return { blocked: true };
  let blob = null;
  try {
    // A signal rather than a raced timer, so the limit covers reading the body
    // too — fetch() itself resolves as soon as the headers arrive.
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetch(url, { mode: "cors", credentials: "omit", signal });
    if (!response.ok) return { blocked: true };
    blob = await response.blob();
  } catch (_) {
    return { blocked: true };
  }
  if (!blob?.size) return { file: null };
  try {
    const head = new Uint8Array(await blob.slice(0, 4 * 1024 * 1024).arrayBuffer());
    if (!isAnimatedImage(head, blob.type)) return { file: null };
    const type = sniffImageType(head) || blob.type;
    const name = (url.split("/").pop() || "image").split(/[?#]/)[0] || "image";
    return { file: withSniffedType(new File([blob], name, { type }), head) };
  } catch (_) {
    return { file: null };
  }
}

// A drag out of a browser tab often carries the real file already — then the
// URL beside it has nothing to add, and fetching it again is a wasted wait.
async function fileIsAnimated(file) {
  try {
    return isAnimatedImage(new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer()), file.type);
  } catch (_) {
    return false;
  }
}

// Insert an image that arrived by paste or drop. Identical to insertImageUpload
// except that a clipboard-flattened animation is swapped back for the real
// file first. Both `sourceUrl` and `atPos` are captured by the CALLER while the
// event is still live, because a DataTransfer can't be read after its handler
// returns and the caret may move while the original is being fetched.
//
// When the site refuses to hand the original over, an address that plainly
// names an animation is LINKED rather than uploaded as a still: it keeps
// moving, at the cost of living on that site rather than in your storage —
// which the toast says.
//
// The placeholder goes in first, before the fetch and before the dialog — see
// reserveImageSlots in ./outbox.js — synchronously, while the paste or drop
// event is still running. `token`, when given, is one a caller already reserved.
//
// `ownUrl`: the address the picture was copied from, when it is one of ours
// (ownPictureFromTransfer). One of this file's own goes in at that address —
// nothing fetched, compressed or uploaded.
export async function insertTransferImage(textarea, file, sourceUrl, atPos, { token = null, ownUrl = "" } = {}) {
  const slot = token || reserveImageSlots(textarea, 1, atPos)[0];
  if (ownUrl && (await isThisFilesPicture(ownUrl))) {
    await settleUploadToken(textarea, slot, `![](${ownUrl.replace(/[()\s]/g, encodeURIComponent)})`);
    return;
  }
  let toUpload = file;
  if (sourceUrl && !cannotAnimateUrl(sourceUrl) && !(await fileIsAnimated(file))) {
    const named = looksAnimatedUrl(sourceUrl);
    if (named) showToast("Fetching the original animation…", "info");
    const original = await fetchAnimatedOriginal(sourceUrl, named ? ORIGINAL_FETCH_TIMEOUT_MS : UNNAMED_FETCH_TIMEOUT_MS);
    if (original.file) {
      toUpload = original.file;
    } else if (original.blocked && named) {
      let host = "that site";
      try { host = new URL(sourceUrl).hostname; } catch (_) { /* keep the generic name */ }
      // Parentheses and whitespace would end the markdown destination early.
      await settleUploadToken(textarea, slot, `![](${sourceUrl.replace(/[()\s]/g, encodeURIComponent)})`);
      showToast(`Linked the animation from ${host} — that site doesn't allow copying it, so it stays hosted there`, "info");
      return;
    }
  }
  await insertImageUpload(textarea, toUpload, undefined, { token: slot });
}

// Several images at once (dragging a selection out of a folder, or pasting a
// multi-file copy). One compression dialog covers all of them — a prompt per
// image for a drop of twenty would be its own kind of unusable — and then each
// prepared file is inserted in the order it arrived. The single-file case goes
// through insertTransferImage so a copied animation still gets its frames back.
export async function insertTransferImages(textarea, files, sourceUrl, atPos, { ownUrl = "" } = {}) {
  const list = Array.from(files || []);
  if (list.length <= 1) {
    if (list.length) await insertTransferImage(textarea, list[0], sourceUrl, atPos, { ownUrl });
    return;
  }
  // One placeholder per image, in the order they arrived, at the caret captured
  // while the event was live — before the dialog, so nothing that puts the
  // editor down while it is asking can leave them out.
  const tokens = reserveImageSlots(textarea, list.length, atPos);
  const chosen = await chooseImageCompression(list);
  if (!chosen?.items?.length) { await releaseImageSlots(textarea, tokens); return; }
  // Not awaited in turn: each uploads on its own and settles its own slot.
  chosen.items.forEach((item, index) => {
    insertPreparedImageUpload(textarea, item.upload, undefined, { token: tokens[index] });
  });
  // A slot the dialog handed nothing back for is not left saying "uploading…".
  if (tokens.length > chosen.items.length) releaseImageSlots(textarea, tokens.slice(chosen.items.length));
}

// Detect an image in a DataTransfer during `dragover`, where getAsFile() is still
// null (file data is protected until drop). Reads item kind/type (exposed during
// dragover) with a "Files" types fallback for browsers that don't populate items yet.
export function dragContainsImage(dataTransfer) {
  if (!dataTransfer) return false;
  const items = dataTransfer.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type && it.type.startsWith("image/")) return true;
    }
  }
  const types = dataTransfer.types;
  if (types) {
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
  }
  return false;
}

// Every image File in a clipboard/drag DataTransfer, in the order it carries
// them. A drop used to take the first and silently discard the rest, which is
// the one way of adding images that could lose some.
export function allImageFiles(dataTransfer) {
  const found = [];
  if (!dataTransfer) return found;
  const files = dataTransfer.files;
  if (files && files.length) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file && file.type && file.type.startsWith("image/")) found.push(file);
    }
  }
  if (found.length) return found;
  // `files` is empty for a copied (rather than saved) image on some platforms;
  // the items list still carries it.
  const items = dataTransfer.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file" || !item.type || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) found.push(file);
    }
  }
  return found;
}

// Hidden file input (created once, reused) for the toolbar "Insert image" button.
// The caret position is captured before the picker opens (it blurs the textarea and
// resets the selection) and applied to the first image; later images follow it.
export let imagePickerInput = null;

export function openImagePicker(textarea, atPos) {
  if (!imagePickerInput) {
    imagePickerInput = document.createElement("input");
    imagePickerInput.type = "file";
    imagePickerInput.accept = "image/*";
    imagePickerInput.multiple = true;
    imagePickerInput.style.display = "none";
    document.body.appendChild(imagePickerInput);
    imagePickerInput.addEventListener("change", async () => {
      const target = imagePickerInput._targetTextarea;
      const pos = imagePickerInput._targetPos;
      const files = Array.from(imagePickerInput.files || [])
        .filter((file) => file.type && file.type.startsWith("image/"));
      imagePickerInput.value = "";
      if (!files.length) { setImagePickerActive(false); return; }
      // Deliberately NOT cleared before the dialog: it is what keeps edit mode
      // alive across a modal that takes focus off the textarea, and the dialog
      // holds it for its own lifetime (chooseImageCompression) and releases it
      // when it closes. Clearing here first would leave a gap in the middle.
      // The placeholders go in at the caret captured before the picker opened,
      // before the dialog asks anything (reserveImageSlots in ./outbox.js).
      const tokens = reserveImageSlots(target, files.length, pos);
      const chosen = await chooseImageCompression(files);
      if (!chosen?.items?.length) { await releaseImageSlots(target, tokens); return; }
      chosen.items.forEach((item, i) => {
        insertPreparedImageUpload(target, item.upload, undefined, { token: tokens[i] });
      });
      if (tokens.length > chosen.items.length) releaseImageSlots(target, tokens.slice(chosen.items.length));
    });
  }
  imagePickerInput._targetTextarea = textarea;
  imagePickerInput._targetPos = atPos;
  // Keep edit mode alive across the file-dialog blur; a cancelled dialog's
  // window refocus clears it again — unless the compression dialog is already
  // up, which happens when the refocus lands after the change event rather than
  // before it. That modal takes focus off the textarea for exactly the same
  // reason and owns the flag for its own lifetime.
  setImagePickerActive(true);
  window.addEventListener("focus", () => {
    if (!document.querySelector(".image-compress-modal")) setImagePickerActive(false);
  }, { once: true });
  imagePickerInput.click();
}
