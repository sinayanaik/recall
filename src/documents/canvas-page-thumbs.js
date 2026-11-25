// The Canvas's pages as small pictures, drawn once and shared.
//
// Two places show them: the Pages panel (src/documents/canvas-pages-panel.js)
// and the Pages tab of the ☰ drawer (src/documents/canvas-drawer-pages.js).
// Both ask here, so a page drawn for one is on screen in the other at once,
// and a page is never drawn twice because two surfaces wanted it.
//
// A picture is drawn as the Canvas's PDF export draws a page
// (renderCanvasPageThumb, src/documents/pdf-export.js), one at a time, and
// drawn again only for a page whose things changed (canvasPageSignature). The
// cache belongs to one file: opening another empties it.
//
// A surface asks for a page with wantCanvasThumb(page, owner, onDrawn) and is
// called back when the picture is ready; when it closes it takes its requests
// back (dropCanvasThumbRequests), so nothing is drawn for a surface nobody is
// looking at.

import { state } from "../core/state.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK } from "./doc-slot.js?v=__BUILD__";
import { canvasPageBox } from "./canvas-setup.js?v=__BUILD__";
import { currentPaperTone } from "./pdf-view.js?v=__BUILD__";
import { renderCanvasPageThumb } from "./pdf-export.js?v=__BUILD__";
import { notebookPageCount, notebookPagesBusy } from "./notebook.js?v=__BUILD__";
import { recordsForSurface } from "./pdf-multi.js?v=__BUILD__";

// The picture's size in device pixels: about twice the widest column it is
// shown in, so it is sharp on a high-density screen.
export const CANVAS_THUMB_MAX_W = 280;
export const CANVAS_THUMB_MAX_H = 400;

const cptThumbs = new Map(); // page → { sig, canvas }
const cptWaiting = new Map(); // page → Map(owner → onDrawn)
let cptDrawing = false;
let cptFile = "";

// Which file the pictures are of.
export function canvasThumbFileKey() {
  return `${state.localDeckId || state.deckTitle || ""}`;
}

// Empties the cache when another file is open. True when it did.
export function resetCanvasThumbsIfFileChanged() {
  const file = canvasThumbFileKey();
  if (file === cptFile) return false;
  cptFile = file;
  cptThumbs.clear();
  cptWaiting.clear();
  return true;
}

// What a page's picture depends on: everything on it (each record's id and
// when it last changed — ink, by how much is written), its setup and how far it
// reaches, and the paper it is seen on. Cheap, so it is asked of every page in
// view every few seconds while a surface showing them is open.
export function canvasPageSignature(page) {
  const meta = state.meta || {};
  const parts = [];
  const onPage = (record) => Number(record?.page || record?.quads?.[0]?.page) === page;
  for (const record of recordsForSurface(meta.pdfHighlights, DOC_SLOT_NOTEBOOK, null)) {
    if (!onPage(record)) continue;
    parts.push(`${record.id}@${record.at || ""}:${record.ink?.s?.length || 0}`);
  }
  for (const block of recordsForSurface(meta.pdfBlocks, DOC_SLOT_NOTEBOOK, null)) {
    if (!onPage(block)) continue;
    parts.push(`${block.id}@${block.at || ""}`);
  }
  const notebook = meta.notebook || {};
  parts.push(JSON.stringify(canvasPageBox(notebook, page)));
  parts.push(JSON.stringify(notebook.pageSetups?.[String(page)] || notebook.setup || notebook.paper || ""));
  const tone = currentPaperTone();
  parts.push(tone?.key || "");
  return parts.join("|");
}

// The frame a page's picture sits in, as a CSS aspect-ratio. A very long page
// shows as a tall frame, held to 1:2 so it does not take the whole column; the
// picture inside is drawn to fit it.
export function canvasThumbAspect(page) {
  const box = canvasPageBox(state.meta?.notebook, page);
  const w = Math.max(1, Number(box?.[2]) - Number(box?.[0]) || 595);
  const h = Math.max(1, Number(box?.[3]) - Number(box?.[1]) || 842);
  return `${w} / ${Math.min(h, w * 2)}`;
}

// The last picture drawn of a page, current or not — something to show while
// a fresher one is drawn.
export function canvasThumbHeld(page) {
  resetCanvasThumbsIfFileChanged();
  return cptThumbs.get(page)?.canvas || null;
}

// A copy to put on screen: the drawn canvas stays in the cache, and a list
// rebuilt later takes it again without drawing.
export function copyCanvasThumb(canvas) {
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext("2d")?.drawImage(canvas, 0, 0);
  return copy;
}

// Asks for page `page`'s picture on behalf of `owner`. Nothing happens when the
// one held is current; otherwise it is drawn and onDrawn(page, canvas) called.
export function wantCanvasThumb(page, owner, onDrawn) {
  resetCanvasThumbsIfFileChanged();
  const held = cptThumbs.get(page);
  if (held && held.sig === canvasPageSignature(page)) return;
  let waiting = cptWaiting.get(page);
  if (!waiting) {
    waiting = new Map();
    cptWaiting.set(page, waiting);
  }
  waiting.set(owner, onDrawn);
  cptDrawNext();
}

// Everything `owner` asked for and has not had yet, taken back.
export function dropCanvasThumbRequests(owner) {
  for (const [page, waiting] of cptWaiting) {
    waiting.delete(owner);
    if (!waiting.size) cptWaiting.delete(page);
  }
}

// Forget these pages' pictures (or every one), after a change that moved
// things between pages in a way a signature would not show.
export function forgetCanvasThumbs(pages = null) {
  if (!pages) {
    cptThumbs.clear();
    return;
  }
  pages.forEach((page) => cptThumbs.delete(page));
}

// After pages were put in another order: the pictures follow their pages.
// `order` is the new order, as old page numbers; null forgets them all.
export function remapCanvasThumbs(order) {
  if (!order) {
    cptThumbs.clear();
    return;
  }
  const next = new Map();
  order.forEach((oldPage, index) => {
    const held = cptThumbs.get(oldPage);
    if (held) next.set(index + 1, held);
  });
  cptThumbs.clear();
  next.forEach((value, key) => cptThumbs.set(key, value));
}

function cptDeliver(page, waiting, canvas) {
  waiting.forEach((onDrawn) => {
    try {
      onDrawn?.(page, canvas);
    } catch (error) {
      console.warn("Could not show a Canvas page's picture", error);
    }
  });
}

async function cptDrawNext() {
  if (cptDrawing || !cptWaiting.size) return;
  if (notebookPagesBusy()) {
    setTimeout(cptDrawNext, 300);
    return;
  }
  const [page, waiting] = cptWaiting.entries().next().value;
  cptWaiting.delete(page);
  if (page > notebookPageCount()) {
    cptDrawNext();
    return;
  }
  // Drawn already, for someone who asked while another draw ran.
  const held = cptThumbs.get(page);
  const sig = canvasPageSignature(page);
  if (held && held.sig === sig) {
    cptDeliver(page, waiting, held.canvas);
    cptDrawNext();
    return;
  }
  cptDrawing = true;
  const file = canvasThumbFileKey();
  let canvas = null;
  try {
    canvas = await renderCanvasPageThumb(page, { maxW: CANVAS_THUMB_MAX_W, maxH: CANVAS_THUMB_MAX_H });
  } catch (error) {
    console.warn("Could not draw a Canvas page's picture", error);
  }
  cptDrawing = false;
  if (canvas && file === canvasThumbFileKey()) {
    if (sig === canvasPageSignature(page)) {
      cptThumbs.set(page, { sig, canvas });
      cptDeliver(page, waiting, canvas);
    } else {
      // Changed while it drew: draw it again, for everyone still waiting.
      const again = cptWaiting.get(page) || new Map();
      waiting.forEach((onDrawn, owner) => { if (!again.has(owner)) again.set(owner, onDrawn); });
      cptWaiting.set(page, again);
    }
  }
  // Let the pen and the scroll have the main thread between pictures.
  setTimeout(cptDrawNext, 30);
}
