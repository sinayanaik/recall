// Getting an image out of a paste, a drag, or the file picker — including a
// dragged GIF, which arrives as a URL rather than a file.

import { insertImageUpload } from "./outbox.js?v=__BUILD__";
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

// Pull the first image File from a clipboard/drag DataTransfer, if any.
export function firstImageFile(dataTransfer) {
  if (!dataTransfer) return null;
  const files = dataTransfer.files;
  if (files && files.length) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f && f.type && f.type.startsWith("image/")) return f;
    }
  }
  const items = dataTransfer.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
  }
  return null;
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
    imagePickerInput.addEventListener("change", () => {
      setImagePickerActive(false);
      const target = imagePickerInput._targetTextarea;
      const pos = imagePickerInput._targetPos;
      const files = Array.from(imagePickerInput.files || [])
        .filter((file) => file.type && file.type.startsWith("image/"));
      files.forEach((file, i) => {
        // First image lands at the captured caret; the rest follow (the caret has
        // advanced past each inserted placeholder), so use the live caret for them.
        insertImageUpload(target, file, i === 0 ? pos : undefined);
      });
      imagePickerInput.value = "";
    });
  }
  imagePickerInput._targetTextarea = textarea;
  imagePickerInput._targetPos = atPos;
  // Keep edit mode alive across the file-dialog blur; the change handler (or a
  // cancelled dialog's window refocus) clears it again.
  setImagePickerActive(true);
  window.addEventListener("focus", () => { setImagePickerActive(false); }, { once: true });
  imagePickerInput.click();
}
