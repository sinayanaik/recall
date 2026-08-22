// Getting an image out of a paste, a drag, or the file picker — including a
// dragged GIF, which arrives as a URL rather than a file.

import { chooseImageCompression } from "./compress-dialog.js?v=__BUILD__";
import { insertImageUpload, insertPreparedImageUpload } from "./outbox.js?v=__BUILD__";
import { setImagePickerActive } from "./upload.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// A GIF URL carried alongside the flattened bitmap, or null. DOMParser (not
// innerHTML) so parsing the fragment can't kick off a load of every image in it.
export function gifSourceUrlFromTransfer(dataTransfer) {
  const looksLikeGif = (url) => /^https?:/i.test(url) && /\.gif(\?|#|$)/i.test(url);
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
        if (looksLikeGif(src)) return src;
      }
    } catch (_) { /* malformed fragment — fall through to the uri-list */ }
  }
  let uriList = "";
  try {
    uriList = dataTransfer?.getData?.("text/uri-list") || "";
  } catch (_) { /* as above */ }
  const uri = uriList.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  return uri && looksLikeGif(uri) ? uri : null;
}

export async function fetchGifFile(url) {
  if (!navigator.onLine) return null;
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) return null;
    const blob = await response.blob();
    // The URL ended in .gif; trust what came back over what it was named.
    if (blob.type !== "image/gif" || !blob.size) return null;
    const name = (url.split("/").pop() || "image.gif").split(/[?#]/)[0] || "image.gif";
    return new File([blob], name, { type: "image/gif" });
  } catch (_) {
    return null;
  }
}

// Insert an image that arrived by paste or drop. Identical to insertImageUpload
// except that a clipboard-flattened GIF is swapped back for the real animated
// file first. Both `gifUrl` and `atPos` are captured by the CALLER while the
// event is still live, because a DataTransfer can't be read after its handler
// returns and the caret may move while the GIF is being fetched.
export async function insertTransferImage(textarea, file, gifUrl, atPos) {
  let toUpload = file;
  if (gifUrl) {
    showToast("Fetching the original GIF…", "info");
    toUpload = (await fetchGifFile(gifUrl)) || file;
    if (toUpload === file) showToast("Couldn't fetch the animated GIF — kept the still frame", "info");
  }
  insertImageUpload(textarea, toUpload, atPos);
}

// Several images at once (dragging a selection out of a folder, or pasting a
// multi-file copy). One compression dialog covers all of them — a prompt per
// image for a drop of twenty would be its own kind of unusable — and then each
// prepared file is inserted in the order it arrived. The single-file case goes
// through insertTransferImage so a dragged GIF still gets its animation back.
export async function insertTransferImages(textarea, files, gifUrl, atPos) {
  const list = Array.from(files || []);
  if (list.length <= 1) {
    if (list.length) await insertTransferImage(textarea, list[0], gifUrl, atPos);
    return;
  }
  const chosen = await chooseImageCompression(list);
  if (!chosen?.items?.length) return;
  // Not awaited in turn: each call inserts its placeholder synchronously (so
  // the images land in the order they were dropped) and then uploads on its
  // own. The first goes to the caret captured before the dialog took focus;
  // the rest follow it, since the caret has advanced past each placeholder.
  chosen.items.forEach((item, index) => {
    insertPreparedImageUpload(textarea, item.upload, index === 0 ? atPos : undefined);
  });
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
      const chosen = await chooseImageCompression(files);
      if (!chosen?.items?.length) return;
      chosen.items.forEach((item, i) => {
        // First image lands at the captured caret; the rest follow (the caret has
        // advanced past each inserted placeholder), so use the live caret for them.
        insertPreparedImageUpload(target, item.upload, i === 0 ? pos : undefined);
      });
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
