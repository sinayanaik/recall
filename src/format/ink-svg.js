// A drawing as a file, with the strokes still inside it.
//
// In a note, ink is an IMAGE — the markdown holds an ordinary `![](…)` and the
// bytes go to the same private Storage bucket every pasted picture goes to.
// That is what buys the whole image pipeline for nothing: the offline outbox
// and its `recall-img:` placeholder, the resize grip, the delete button and its
// "is anything else still pointing at this file" check, the signed-URL
// resolution, the service worker's image cache, every export, and the backup.
// None of them had to learn what ink is.
//
// The cost of that trade is that a picture is not editable — so the strokes ride
// INSIDE the file, in the SVG's own <metadata>, in exactly the encoding the
// paper's ink uses (src/format/ink-strokes.js). Reopening a drawing to add to
// it is reading them back out. An SVG that loses its metadata still draws; a
// drawing whose file cannot be reached still renders, because the <img> is what
// renders. Only the ✎ stops working, and it says so.
//
// ── One geometry, two outputs ──────────────────────────────────────────────
//
// The outline of a pressure-varying stroke is fiddly enough that a second
// implementation of it would drift from the first within a release. So
// inkStrokeOutline in src/render/ink-paint.js is handed a RECORDER instead of a
// canvas context — same calls, same order, same shape — and the recorder emits
// SVG path data. What you see on the page and what lands in the file are the
// same code.
//
// ── Why the colours are a <style> block and not attributes ─────────────────
//
// An <img> cannot inherit anything from the page it is on: no custom property,
// no currentColor, nothing. A near-black stroke baked into the file is
// invisible the first time the reader switches to a dark theme, which is the
// exact fault the highlight <span> had before it became a <mark data-color>.
//
// But an SVG loaded as an image DOES evaluate a <style> of its own, media
// queries included. So each path carries a class, and the file carries both
// The colours are the ones the reader was actually looking at, resolved from
// the live theme when the drawing was made, on a page of the paper it was drawn
// on — a file that stands on its own rather than one that asks the operating
// system a question about an app it knows nothing about.

import { INK_PEN_HEX, INK_PEN_TOKENS, normalizeInkPen } from "./ink-colors.js?v=__BUILD__";
import { decodeInkStroke, encodeInkStrokes, inkStrokesBounds } from "./ink-strokes.js?v=__BUILD__";
import { inkStrokeOutline, resolveInkColor } from "../render/ink-paint.js?v=__BUILD__";

// The element the strokes are stashed in, and the attribute that says which
// encoding they are in. Read back by inkStrokesFromSvg; ignored by every
// renderer, which is the point of <metadata>.
export const INK_SVG_METADATA_TAG = "recall-ink";

// Room left round the drawing so a stroke's own width is not clipped by the
// viewBox. inkStrokesBounds already pads by each stroke's half width; this is
// the extra breath that stops a cap sitting exactly on the edge.
export const INK_SVG_PADDING = 4;

// The colour the paper was, if it can be read. A drawing carries its own page
// (see inkStrokesToSvg) and this is where that page's colour comes from — the
// same custom property the surface it was drawn on uses, so the picture matches
// what the reader was looking at when they drew it.
const INK_SVG_PAPER_FALLBACK = "#f7f7f5";
const INK_SVG_EDGE_FALLBACK = "#d9d9d4";

function readCssColor(name, fallback) {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    // color-mix() and other computed forms are fine in CSS and meaningless in a
    // standalone file, so anything that is not a plain colour is refused rather
    // than written into an SVG that has to stand on its own.
    return /^(#|rgb|hsl)/i.test(value) ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

function inkSvgNumber(value) {
  // Three decimals is a tenth of a quantisation step — below anything the
  // encoding itself can distinguish, so nothing is lost and the file is not
  // full of seventeen-digit floats.
  return Math.round(value * 1000) / 1000;
}

// A stand-in for a CanvasRenderingContext2D that answers only the calls
// inkStrokeOutline makes, and writes SVG path data instead of painting.
export function inkPathRecorder() {
  const parts = [];
  let x = 0;
  let y = 0;
  let started = false;
  const n = inkSvgNumber;
  return {
    ctx: {
      beginPath() { started = false; },
      moveTo(px, py) { parts.push(`M${n(px)} ${n(py)}`); x = px; y = py; started = true; },
      lineTo(px, py) {
        if (!started) { this.moveTo(px, py); return; }
        parts.push(`L${n(px)} ${n(py)}`); x = px; y = py;
      },
      quadraticCurveTo(cx, cy, px, py) {
        if (!started) { this.moveTo(px, py); return; }
        parts.push(`Q${n(cx)} ${n(cy)} ${n(px)} ${n(py)}`); x = px; y = py;
      },
      // Canvas arcs are clockwise unless told otherwise, and inkStrokeOutline
      // never tells otherwise — every one of its arcs is a round cap.
      arc(cx, cy, r, from, to) {
        const sx = cx + (Math.cos(from) * r);
        const sy = cy + (Math.sin(from) * r);
        if (!started) { parts.push(`M${n(sx)} ${n(sy)}`); started = true; }
        else if (Math.abs(sx - x) > 1e-6 || Math.abs(sy - y) > 1e-6) parts.push(`L${n(sx)} ${n(sy)}`);
        let sweep = to - from;
        while (sweep < 0) sweep += Math.PI * 2;
        // SVG has no single-command full circle: an arc whose endpoints
        // coincide draws nothing at all, which would silently lose every dot
        // in the drawing.
        if (sweep >= (Math.PI * 2) - 1e-6) {
          const mx = cx - (Math.cos(from) * r);
          const my = cy - (Math.sin(from) * r);
          parts.push(`A${n(r)} ${n(r)} 0 1 1 ${n(mx)} ${n(my)}`);
          parts.push(`A${n(r)} ${n(r)} 0 1 1 ${n(sx)} ${n(sy)}`);
          x = sx; y = sy;
          return;
        }
        const ex = cx + (Math.cos(to) * r);
        const ey = cy + (Math.sin(to) * r);
        parts.push(`A${n(r)} ${n(r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${n(ex)} ${n(ey)}`);
        x = ex; y = ey;
      },
      closePath() { parts.push("Z"); }
    },
    path: () => parts.join("")
  };
}

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// `strokes` are in the drawing's own units. The viewBox is derived from them,
// so a drawing is exactly as big as what is in it and a note is not asked to
// make room for empty paper.
export function inkStrokesToSvg(strokes, { title = "Handwriting" } = {}) {
  const list = Array.isArray(strokes) ? strokes.filter((stroke) => stroke?.p?.length >= 3) : [];
  if (!list.length) return "";
  const box = inkStrokesBounds(list);
  if (!box) return "";
  const minX = box.minX - INK_SVG_PADDING;
  const minY = box.minY - INK_SVG_PADDING;
  const width = Math.max(1, (box.maxX - box.minX) + (INK_SVG_PADDING * 2));
  const height = Math.max(1, (box.maxY - box.minY) + (INK_SVG_PADDING * 2));

  const paths = list.map((stroke) => {
    const recorder = inkPathRecorder();
    if (!inkStrokeOutline(recorder.ctx, stroke)) return "";
    const path = recorder.path();
    if (!path) return "";
    return `<path class="p-${normalizeInkPen(stroke.c)}" d="${path}"/>`;
  }).filter(Boolean).join("");
  if (!paths) return "";

  // ── Why this is not two palettes and a media query any more ─────────────
  //
  // It was, and the report was "the SVG drawings are always looking black".
  // `prefers-color-scheme` inside a file loaded through <img> resolves against
  // the OPERATING SYSTEM, and this app's theme is not the operating system's:
  // seven of its ten themes are dark, and the machine under them is usually set
  // to light. So a note on a dark page, drawn in a pen that had correctly
  // resolved to near-white on the canvas, was written into a file whose base
  // rule was near-black — and rendered near-black on that dark page.
  //
  // There is no lever to fix that from the outside. `color-scheme` on the <img>
  // does not propagate a preference into the sub-document (measured, in Chrome:
  // setting it either way gives the same answer). So the file stops asking a
  // question it cannot get a true answer to, and simply records what the reader
  // was looking at: the pen colours resolved from the live theme at the moment
  // of drawing, and the paper they were drawn on behind them.
  //
  // Carrying the paper is what makes it hold up afterwards. Baked colours alone
  // would leave a white-ink drawing invisible the day somebody switched to a
  // light theme; with its own page under it, a drawing looks exactly as it did
  // when it was made, anywhere it is ever opened — a note, an export, a print,
  // or a file on a desk. It is a picture of a page, so it looks like one.
  const rules = INK_PEN_TOKENS
    .map((token) => `.p-${token}{fill:${resolveInkColor(token) || INK_PEN_HEX[token]}}`)
    .join("");
  const paper = readCssColor("--card", readCssColor("--panel", INK_SVG_PAPER_FALLBACK));
  const edge = readCssColor("--line", INK_SVG_EDGE_FALLBACK);
  const encoded = encodeInkStrokes(list);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${inkSvgNumber(minX)} ${inkSvgNumber(minY)} ${inkSvgNumber(width)} ${inkSvgNumber(height)}" width="${Math.round(width)}" height="${Math.round(height)}" role="img" aria-label="${escapeSvgText(title)}">`
    + `<title>${escapeSvgText(title)}</title>`
    + `<style>${rules}</style>`
    + `<metadata><${INK_SVG_METADATA_TAG}>${escapeSvgText(JSON.stringify(encoded))}</${INK_SVG_METADATA_TAG}></metadata>`
    + `<rect x="${inkSvgNumber(minX)}" y="${inkSvgNumber(minY)}" width="${inkSvgNumber(width)}" height="${inkSvgNumber(height)}" rx="${inkSvgNumber(Math.min(8, width / 12, height / 12))}" fill="${paper}" stroke="${edge}" stroke-width="1"/>`
    + `${paths}</svg>`;
}

// The way back. Returns [] for an SVG that is not one of ours, for one whose
// metadata was stripped by a tool on the way through, and for anything that
// does not parse — all three mean the same thing to the caller: this drawing can
// be looked at but not added to.
//
// Parsed as XML rather than pattern-matched out of the text. The metadata is
// JSON inside escaped XML inside an SVG, and a regular expression over three
// layers of quoting is a bug waiting for the first drawing that contains a
// less-than sign.
export function inkStrokesFromSvg(svgText) {
  const text = typeof svgText === "string" ? svgText : "";
  if (!text.includes(INK_SVG_METADATA_TAG)) return [];
  try {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    if (doc.querySelector("parsererror")) return [];
    const node = doc.getElementsByTagName(INK_SVG_METADATA_TAG)[0];
    const raw = node?.textContent || "";
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out = [];
    list.forEach((entry) => {
      const stroke = decodeInkStroke(entry);
      if (stroke) out.push(stroke);
    });
    return out;
  } catch (_) {
    return [];
  }
}

// The file itself, ready for the ordinary image upload path. `image/svg+xml` is
// already in IMAGE_STORAGE_EXT and compressImageToPreset already passes vector
// images through untouched, so this needs nothing added anywhere.
export function inkSvgFile(strokes, { name = "drawing", title = "Handwriting" } = {}) {
  const svg = inkStrokesToSvg(strokes, { title });
  if (!svg) return null;
  return new File([svg], `${name}.svg`, { type: "image/svg+xml" });
}
