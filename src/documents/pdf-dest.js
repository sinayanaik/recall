// A PDF destination → where on which page it points.
//
// Two things in a PDF point somewhere inside it: an outline entry (the contents
// drawer, src/documents/pdf-outline.js) and a link annotation on a page (a
// "see §3", a citation, the paper's own printed contents — src/documents/
// pdf-links.js). Both carry the same thing, a destination, and both used to need
// only its page. A link needs more: a reference list is one page with fifty
// entries on it, and landing on the top of that page when the citation pointed
// at the forty-third is a jump that did not finish. So the destination's own
// height is read as well, as the same 0..1 fraction of the page that
// scrollToDocumentPage takes.
//
// No imports on purpose: pdf-outline.js is imported by pdf-view.js, and
// pdf-links.js imports pdf-view.js, so a helper both of them share has to sit
// outside that graph.

// The explicit destination array for a named or explicit destination, or null.
export async function explicitDestination(doc, dest) {
  try {
    const resolved = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    return Array.isArray(resolved) && resolved.length ? resolved : null;
  } catch (_) {
    return null;
  }
}

// 1-based page number for an explicit destination, or 0. The first element is
// a page reference — or, in a destination written for another file (or by a
// careless producer), a bare 0-based page index.
export async function destinationPageNumber(doc, explicit) {
  if (!explicit) return 0;
  const target = explicit[0];
  try {
    if (Number.isInteger(target)) return target >= 0 && target < doc.numPages ? target + 1 : 0;
    if (target && typeof target === "object") return (await doc.getPageIndex(target)) + 1;
  } catch (_) {
    return 0;
  }
  return 0;
}

// The y coordinate (PDF user space) a destination asks to be at the top of the
// screen, or null when it names none. The array after the reference is
// [{name: kind}, ...arguments], with the arguments per kind as the PDF spec
// lists them (ISO 32000-1, 12.3.2.2).
export function destinationTop(explicit) {
  if (!explicit) return null;
  const kind = explicit[1]?.name;
  const args = explicit.slice(2);
  let top = null;
  if (kind === "XYZ") top = args[1];
  else if (kind === "FitH" || kind === "FitBH") top = args[0];
  else if (kind === "FitR") top = args[3];
  return Number.isFinite(top) ? top : null;
}

// { page, ratio } for any destination — ratio 0 when the destination names a
// page and no height on it. `viewportFor(page)` hands back the viewer's live
// viewport when the page has been laid out; failing that the page's own
// unscaled one is asked for, which is the same fraction (it is a ratio).
export async function resolvePdfDestination(doc, dest, viewportFor = null) {
  const explicit = await explicitDestination(doc, dest);
  const page = await destinationPageNumber(doc, explicit);
  if (!page) return { page: 0, ratio: 0 };
  const top = destinationTop(explicit);
  if (top === null) return { page, ratio: 0 };
  let viewport = viewportFor?.(page) || null;
  if (!viewport) {
    try {
      viewport = (await doc.getPage(page)).getViewport({ scale: 1 });
    } catch (_) {
      return { page, ratio: 0 };
    }
  }
  const height = viewport?.height;
  if (!height) return { page, ratio: 0 };
  const [, y] = viewport.convertToViewportPoint(0, top);
  return { page, ratio: Math.min(1, Math.max(0, y / height)) };
}
