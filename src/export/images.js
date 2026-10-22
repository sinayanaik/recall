// Every picture in an export, made to travel inside the file.
//
// One step, shared by the PDF, HTML and Word exports, run over the off-screen
// render in el.printRoot once enhanceRenderedMarkdown is done with it:
//
//   1. a picture still waiting to upload (`recall-img:<token>`, src/images/
//      outbox.js) is given its blob URL — the screen renderer does this after
//      every render, and the export renders never did, so an image added
//      offline came out as a "View image" link or a broken tile;
//   2. every <img> is fetched and inlined as a data: URI. The images bucket is
//      private, so a note's canonical URL only loads when signed — and the PDF
//      exports used to skip this step altogether and hand the print frame the
//      canonical URL, which showed only when the service worker happened to
//      have that picture cached;
//   3. every picture has decoded, so nothing is printed half-loaded.
//
// What happens to a picture that cannot be inlined (a host that refuses the
// cross-origin fetch, a private share answering with a sign-in page) depends
// on where it is going. A browser — the PDF's print frame, a saved HTML file —
// can still show it from its own address, so it stays an <img>. Word cannot
// fetch anything, so there it becomes a plain link: broken but honest, rather
// than the unreadable tile Word draws for bytes that are not an image.

import { fetchableStorageUrl } from "../cloud/storage-urls.js?v=__BUILD__";
import { hydrateLocalImages } from "../images/outbox.js?v=__BUILD__";

export function unembeddableImageFallback(img, src) {
  const link = document.createElement("a");
  link.className = "export-image-fallback";
  link.href = src;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = img.getAttribute("alt")?.trim() || "View image";
  return link;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function imageDataUrl(src) {
  // A blob: URL is a picture still in the outbox, already on this device.
  // Anything else may be ours: the canonical `.../object/public/…` src a note
  // holds is not fetchable on its own, so it is signed here rather than
  // trusting whatever the render-time swap happened to leave on the element;
  // a no-op for a link we never hosted.
  const fetchSrc = src.startsWith("blob:") ? src : await fetchableStorageUrl(src);
  const response = await fetch(fetchSrc, { mode: "cors" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error(`Not image bytes (got ${blob.type || "unknown"})`);
  return blobToDataUrl(blob);
}

// `mode` is "pdf", "html" or "docx". Returns how many pictures could not be
// inlined, for imageEmbedSuffix (src/export/run.js).
export async function prepareExportImages(root, { mode = "html" } = {}) {
  await hydrateLocalImages(root).catch((error) => console.warn("Could not resolve pictures waiting to upload", error));
  const images = Array.from(root.querySelectorAll("img[src]"));
  let failedCount = 0;
  await Promise.all(images.map(async (img) => {
    // The figure's identifier when the render already swapped in a signed URL:
    // it is what gets signed afresh, and what a fallback names. A signed URL in
    // an exported file is a bearer credential that outlives the export by up
    // to a week.
    const src = img.getAttribute("data-canonical-src") || img.getAttribute("src");
    if (!src || src.startsWith("data:")) return;
    // Still a placeholder: hydrateLocalImages found nothing for its token (the
    // outbox was cleared). Nothing anywhere can show it.
    const pending = src.startsWith("recall-img:");
    try {
      if (pending) throw new Error("No local copy of a picture waiting to upload");
      img.setAttribute("src", await imageDataUrl(src));
      img.removeAttribute("data-canonical-src");
      img.removeAttribute("loading");
      // In the file it is simply a picture: the "Waiting to upload" tooltip
      // and the token hydrateLocalImages left on it are this device's business.
      if (img.dataset.pendingUpload) {
        img.removeAttribute("title");
        delete img.dataset.pendingUpload;
        delete img.dataset.localToken;
      }
    } catch (error) {
      console.warn("Could not embed image for export:", src, error);
      failedCount += 1;
      if (pending) {
        // A link to a token means nothing outside this device; its name does.
        const label = document.createElement("span");
        label.className = "export-image-fallback";
        label.textContent = img.getAttribute("alt")?.trim() || "Picture not on this device";
        img.replaceWith(label);
      } else if (mode === "docx") {
        img.replaceWith(unembeddableImageFallback(img, src));
      } else {
        // A browser can still fetch it from where it lives — and never a
        // signed address, for the reason above.
        img.setAttribute("src", src);
        img.removeAttribute("data-canonical-src");
        img.removeAttribute("loading");
      }
    }
  }));
  await Promise.all(Array.from(root.querySelectorAll("img"), (img) => (img.decode ? img.decode().catch(() => {}) : null)));
  return failedCount;
}
