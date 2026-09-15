// A card's answer can hold a REFERENCE to a spot on a PDF page — see
// pdf-region.js for why a dragged region carries a quad and no text — and
// this is what turns that reference into something a reader actually sees:
// a live render of exactly that box, re-drawn from the deck's own already-
// stored PDF each time it's shown, with a real (selectable) text layer over
// it. Not a screenshot: nothing is rasterised and kept. Not text extraction
// either: the box was never a reliable way to say which words belong to it.
//
// The reference travels as an ordinary markdown image whose `src` is never
// meant to be fetched — `![](pdfref:<page>:<x0>,<y0>,<x1>,<y1>)` — the same
// idea as `recall-img:<token>` (src/images/outbox.js) for an image still
// queued for upload: a marker intercepted before the browser tries to load
// it, not a real URL.

import { state } from "../core/state.js?v=__BUILD__";
import { ensurePdfJs } from "../core/lib-loader.js?v=__BUILD__";
import { MARK_HIGHLIGHT_HEX } from "../format/highlight-colors.js?v=__BUILD__";
import { decodeInkStrokes } from "../format/ink-strokes.js?v=__BUILD__";
import { paintInkStrokes } from "../render/ink-paint.js?v=__BUILD__";
import { documentHighlightsForPdf, documentInkMarksForPdf } from "./pdf-highlights.js?v=__BUILD__";
import { deckPdfById, PDF_PRIMARY_ID, pdfStoreKey } from "./pdf-multi.js?v=__BUILD__";
import { getDocument } from "./pdf-store.js?v=__BUILD__";
import { buildTextLayer, clampScale } from "./pdf-view.js?v=__BUILD__";

export const PDFREF_SCHEME = "pdfref:";

// Wide enough to read a figure's fine print on a card face; not so wide that
// it overflows a phone-width answer column before the (deferred) zoom/expand
// affordance exists to compensate.
export const EMBED_TARGET_WIDTH = 420;

// `pdfId` is appended only for a non-primary PDF, so a card made before a
// deck ever had more than one PDF keeps the exact ref it always had — every
// existing card, and every client that has not seen this change, still parses
// it exactly as before (implicit primary).
export function pdfRegionRefMarkdown(page, rect, pdfId) {
  const suffix = pdfId && pdfId !== PDF_PRIMARY_ID ? `:${pdfId}` : "";
  return `![](${PDFREF_SCHEME}${page}:${rect.join(",")}${suffix})`;
}

export function parsePdfRef(src) {
  const value = String(src || "");
  if (!value.startsWith(PDFREF_SCHEME)) return null;
  const body = value.slice(PDFREF_SCHEME.length);
  const sep = body.indexOf(":");
  if (sep === -1) return null;
  const page = Number(body.slice(0, sep));
  const rest = body.slice(sep + 1);
  const [rectPart, pdfId = null] = rest.split(":");
  const rect = rectPart.split(",").map(Number);
  if (!Number.isInteger(page) || page < 1) return null;
  if (rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) return null;
  return { page, rect, pdfId };
}

// ── One open PDF per deck, independent of the Document surface's own
//    `openPdf` ──────────────────────────────────────────────────────────────
//
// A deck can have many region-embedded cards pointing at the same PDF, shown
// one after another in Study or listed together in All Cards — each asking
// for this again would reopen and re-parse the same file every time. Cached
// for the session, keyed by the deck AND which of its PDFs (a deck can have
// several now — see pdf-multi.js) — deliberately NOT the Document surface's
// own document object, so switching tabs/decks there can't tear an embed down
// out from under a card that's still showing it, and vice versa.
const embedDocs = new Map();

function openEmbedDoc(storeKey, pdfMeta) {
  const key = storeKey || "";
  const cached = embedDocs.get(key);
  if (cached) return cached;
  const promise = (async () => {
    if (!(await ensurePdfJs())) return null;
    const blob = await getDocument(storeKey, pdfMeta);
    if (!blob) return null;
    // A copy of the bytes: pdf.js transfers the buffer it's given to its
    // worker, which detaches it, and the blob in the store must survive —
    // same reasoning as the Document surface's own open (pdf-view.js).
    const data = new Uint8Array(await blob.arrayBuffer());
    return window.pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  })().catch((error) => {
    console.warn("Could not open the PDF for a region embed", error);
    return null;
  }).then((doc) => {
    // A failure (offline, not yet on this device) is never cached — the next
    // embed asked for gets a fresh attempt, in case connectivity returns
    // later in the same session. Only a real, open document is worth
    // remembering, which is the whole point of caching (see above).
    if (!doc) embedDocs.delete(key);
    return doc;
  });
  embedDocs.set(key, promise);
  return promise;
}

function buildWrapper(rect) {
  const wrapper = document.createElement("div");
  wrapper.className = "pdf-region-embed is-loading";
  // An immediate aspect-ratio guess from the quad itself (scale-invariant —
  // PDF user-space points, not pixels) so the surrounding text doesn't jump
  // once the real render lands.
  const w = Math.abs(rect[2] - rect[0]) || 1;
  const h = Math.abs(rect[3] - rect[1]) || 1;
  wrapper.style.width = `${EMBED_TARGET_WIDTH}px`;
  wrapper.style.height = `${Math.round((EMBED_TARGET_WIDTH * h) / w)}px`;
  return wrapper;
}

// ── Marks the page itself doesn't carry ─────────────────────────────────────
//
// page.render() draws only the PDF's own content. A highlight is an
// absolutely-positioned div over the canvas (.pdf-mark, styles/36-document.css
// and styles/37-document-chrome.css) and ink is its own canvas layer
// (pdf-ink.js) — neither exists in the rendered pixels, so an embed built from
// page.render() alone shows the UNMARKED page, not what the reader actually
// marked up. Repainted here directly onto the embed's own canvas instead,
// matching those CSS rules' colours/opacities/blend modes exactly.
const HIGHLIGHT_FILL_ALPHA = { yellow: 0.35, green: 0.33, blue: 0.32, pink: 0.3 };

const AREA_FILL_ALPHA = 0.12;

function hexWithAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function paintHighlightsOnCanvas(ctx, pageNumber, viewport, pdfId) {
  documentHighlightsForPdf(pdfId).forEach((record) => {
    if (record.kind === "ink") return; // painted separately, below
    const hex = MARK_HIGHLIGHT_HEX[record.color] || MARK_HIGHLIGHT_HEX.yellow;
    (record.quads || []).forEach((quad) => {
      if (quad.page !== pageNumber) return;
      const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(quad.rect);
      const left = Math.min(vx0, vx1);
      const top = Math.min(vy0, vy1);
      const width = Math.abs(vx1 - vx0);
      const height = Math.abs(vy1 - vy0);
      ctx.save();
      if (record.kind === "area") {
        // Outlined with a faint wash rather than tinted — a filled multiply
        // over a photograph would wash out the figure being highlighted, the
        // same reason the live page draws a region this way.
        ctx.fillStyle = hexWithAlpha(hex, AREA_FILL_ALPHA);
        ctx.fillRect(left, top, width, height);
        ctx.strokeStyle = hex;
        ctx.lineWidth = 2;
        ctx.strokeRect(left + 1, top + 1, Math.max(0, width - 2), Math.max(0, height - 2));
      } else {
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = hexWithAlpha(hex, HIGHLIGHT_FILL_ALPHA[record.color] ?? 0.35);
        ctx.fillRect(left, top, width, height);
      }
      ctx.restore();
    });
  });
}

function paintInkOnCanvas(ctx, pageNumber, viewport, pdfId) {
  const marks = documentInkMarksForPdf(pdfId, pageNumber);
  if (!marks.length) return;
  // Ink strokes are stored in PDF user-space points, same as everything else
  // here — paintInkStrokes expects the context already carrying that
  // transform, the same way the live page's own ink layer applies it.
  const t = viewport.transform;
  ctx.save();
  ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  marks.forEach((record) => paintInkStrokes(ctx, decodeInkStrokes(record.ink?.s), { root: null }));
  ctx.restore();
}

function showFallback(wrapper, page) {
  wrapper.classList.remove("is-loading");
  wrapper.classList.add("is-fallback");
  wrapper.replaceChildren();
  const note = document.createElement("div");
  note.className = "pdf-region-embed-fallback";
  note.textContent = page ? `Region · page ${page}` : "Region";
  wrapper.appendChild(note);
}

// Replaces `img` in place with a live-rendered crop of the PDF location it
// points at. Fire-and-forget: called from enhanceRenderedMarkdown for every
// `img[src^="pdfref:"]` a render pass finds.
export async function mountPdfRegionEmbed(img) {
  const parsed = parsePdfRef(img.getAttribute("src"));
  if (!parsed) return;
  const wrapper = buildWrapper(parsed.rect);
  img.replaceWith(wrapper);

  try {
    const pdfId = parsed.pdfId || PDF_PRIMARY_ID;
    const pdfMeta = deckPdfById(state.meta, pdfId);
    const storeKey = pdfStoreKey(state.localDeckId, pdfId);
    const doc = await openEmbedDoc(storeKey, pdfMeta);
    if (!doc || parsed.page > doc.numPages) return showFallback(wrapper, parsed.page);
    const page = await doc.getPage(parsed.page);
    const [x0, y0, x1, y1] = parsed.rect;
    const quadWidth = Math.max(1, Math.abs(x1 - x0));
    const scale = clampScale(EMBED_TARGET_WIDTH / quadWidth);
    const viewport = page.getViewport({ scale });
    const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(parsed.rect);
    const left = Math.min(vx0, vx1);
    const top = Math.min(vy0, vy1);
    const width = Math.max(1, Math.round(Math.abs(vx1 - vx0)));
    const height = Math.max(1, Math.round(Math.abs(vy1 - vy0)));

    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    await page.render({ canvasContext: ctx, viewport }).promise;
    // What the reader actually marked up on this page — highlights and ink —
    // composited onto the same canvas the PDF itself just rendered to. See
    // the note above paintHighlightsOnCanvas for why page.render() alone
    // can't already carry them.
    paintHighlightsOnCanvas(ctx, parsed.page, viewport, pdfId);
    paintInkOnCanvas(ctx, parsed.page, viewport, pdfId);

    // Real, positioned, selectable text — the exact function the Document
    // surface itself renders every page's text layer with. Nothing here is
    // re-measured or re-derived: the whole page's spans are correct as they
    // are, and clipping a correctly-positioned thing to a window is free.
    const { layer: textLayer } = await buildTextLayer(page, viewport);

    const pageGroup = document.createElement("div");
    pageGroup.className = "pdf-region-embed-page";
    pageGroup.style.width = `${viewport.width}px`;
    pageGroup.style.height = `${viewport.height}px`;
    pageGroup.style.transform = `translate(${-left}px, ${-top}px)`;
    pageGroup.append(canvas, textLayer);

    wrapper.classList.remove("is-loading");
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.replaceChildren(pageGroup);
  } catch (error) {
    console.warn("Could not render a PDF region embed", error);
    showFallback(wrapper, parsed.page);
  }
}
