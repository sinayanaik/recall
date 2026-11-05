// The words in a text box or a callout, rendered as markdown.
//
// ── Why ────────────────────────────────────────────────────────────────────
//
// The Text button typed plain text: `box.textContent` on the page, `fillText`
// in every picture and export. "Extend these text inputs over PDFs to have
// complete markdown support" — so the words are now the same markdown a note
// is, put through the same pipeline a note and a text block use
// (renderMarkdown + enhanceRenderedMarkdown): emphasis, lists, headings, code
// with highlighting, KaTeX maths, links, tables, pictures, diagrams.
//
// ── What this module owns, and what it does not ─────────────────────────────
//
// It owns the BOX's contents and how the box is styled from the shape's font —
// one function each, used by the live page (src/documents/pdf-shapes.js) and by
// the static copy a picture or an export is made from (buildStaticShapeText,
// rasterised by src/documents/pdf-region-marks.js). It does not write records:
// a box whose rendered size disagrees with its stored rectangle is reported to
// pdf-shapes.js, which owns updateShape and the undo ring.
//
// ── Rendered once per text, not once per paint ──────────────────────────────
//
// paintDocumentShapes rebuilds the whole shape layer on every repaint — every
// selection change and EVERY FRAME of a drag. A render is async and does real
// work (a lex, a sanitize, a KaTeX pass, maybe a mermaid diagram), so the
// rendered body is cached by record id and the text it was rendered from, and
// the next box built for the same words simply adopts it. A drag therefore
// moves an already-rendered node and renders nothing.
//
// ── Plain words stay plain ──────────────────────────────────────────────────
//
// shapeTextNeedsRendering (src/render/annot-shapes.js) says whether markdown
// would change the words at all. A label with no syntax in it is drawn as it
// always was — synchronously, as text — so every box typed before this existed
// looks exactly the same, with no render to wait for and no flash of nothing.
//
// Debugging: every render that fails, and every one that finishes, is noted
// through notePdfGesture (☰ → Diagnostics, and console.debug "[pdf-gesture]").

import { SHAPE_TEXT_PAD, markdownToPlainText, normalizeShape, shapePrimitives, shapeTextNeedsRendering, typedTextMarkdown } from "../render/annot-shapes.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { hydrateLocalImages } from "../images/outbox.js?v=__BUILD__";
import { resolveStorageImages } from "../cloud/storage-urls.js?v=__BUILD__";
import { PDF_SHAPE_TEXT_CLASS } from "../core/constants.js?v=__BUILD__";
import { notePdfGesture } from "./pdf-timing.js?v=__BUILD__";

export const SHAPE_TEXT_BODY_CLASS = "pdf-shape-text-body";

// The one text primitive of a callout or a text box, or null for every other
// shape. Read off shapePrimitives so the box here and the box every other
// renderer draws are the same rectangle by construction.
export function shapeTextPrimitive(shape) {
  const s = normalizeShape(shape);
  if (!s || (s.type !== "text" && s.type !== "callout")) return null;
  return shapePrimitives(s).find((prim) => prim.kind === "text") || null;
}

// ── The box ─────────────────────────────────────────────────────────────────

// Position and type, from the primitive, through the page's own transform. The
// same function for the live box and the static one, so they cannot disagree
// about where a word goes.
export function styleShapeTextBox(box, prim, viewport, { exact = false } = {}) {
  const scale = viewport.scale || 1;
  const [ax, ay] = viewport.convertToViewportPoint(prim.rect[0], prim.rect[3]);
  const [bx, by] = viewport.convertToViewportPoint(prim.rect[2], prim.rect[1]);
  const left = Math.min(ax, bx);
  const top = Math.min(ay, by);
  const width = Math.abs(bx - ax);
  const height = Math.abs(by - ay);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  // Typewriter text is as wide as its longest line, on screen as in the editor
  // it was typed in, so the two cannot wrap differently. `exact` is the static
  // copy for a picture: drawn into the very rectangle the record stores, which
  // the live page keeps equal to what it shows (see fitShapeTextBoxes in
  // pdf-shapes.js).
  if (prim.fit && !exact) box.dataset.fit = "";
  else box.style.width = `${width}px`;
  // Typewriter text is as TALL as its lines, too: a stored height as a floor
  // would let the box grow with its words and never shrink back (a smaller
  // size, a line deleted), and the fitter would measure the floor, not the words.
  if (exact) box.style.height = `${height}px`;
  else if (!prim.fit) box.style.minHeight = `${height}px`;
  box.style.padding = `${SHAPE_TEXT_PAD * scale}px`;
  box.style.fontSize = `${prim.size * scale}px`;
  box.style.fontWeight = prim.bold ? "700" : "400";
  box.style.textAlign = prim.align;
  box.style.color = prim.color;
  applyShapeTextTurn(box, prim.rot);
}

// A turned box: laid out upright where the record puts it, then turned about
// its middle. Counter-clockwise on the page is a negative CSS turn (y DOWN).
export function applyShapeTextTurn(node, rot) {
  node.style.transformOrigin = rot ? "50% 50%" : "";
  node.style.transform = rot ? `rotate(${-rot}deg)` : "";
}

// ── The body: rendered once per text ────────────────────────────────────────

// id → { source, body, state: "plain" | "pending" | "rendered" | "failed" }.
// Insertion-ordered, so the oldest entry is the first to go when it grows.
const bodies = new Map();
const BODY_CACHE_MAX = 400;

let renderedHandler = () => {};

// Told when a box's markdown has finished rendering (or failed), with the
// record's id — so pdf-shapes.js can measure the box now that its real words
// are in it. Registered rather than imported: pdf-shapes.js imports this.
export function setShapeTextRenderedHandler(fn) {
  renderedHandler = typeof fn === "function" ? fn : () => {};
}

// The state of a record's body, for checks and for the fitter — which must not
// write a size measured off a placeholder that is about to be replaced.
export function shapeTextBodyState(id) {
  return bodies.get(String(id))?.state || null;
}

// Put `text`, rendered, into `box`. Adopts the cached body when it was rendered
// from the same words; builds (and starts rendering) a new one when not.
export function mountShapeTextBody(box, id, text) {
  const key = String(id || "");
  const source = String(text || "");
  if (!key) {
    // A shape being drawn has no record yet and nothing typed in it.
    box.appendChild(plainBody(source));
    return null;
  }
  const kept = bodies.get(key);
  if (kept && kept.source === source) {
    box.appendChild(kept.body);
    return kept;
  }
  let entry;
  if (!shapeTextNeedsRendering(source)) {
    entry = { source, body: plainBody(source), state: "plain" };
  } else {
    const body = document.createElement("div");
    body.className = `${SHAPE_TEXT_BODY_CLASS} rendered is-pending`;
    // The words without their syntax while the render runs — the right lines
    // in roughly the right size, rather than an empty box that jumps.
    body.textContent = markdownToPlainText(source);
    entry = { source, body, state: "pending" };
    renderLiveBody(key, entry);
  }
  const replaced = bodies.get(key);
  if (replaced && shapeTextSizeObserver) shapeTextSizeObserver.unobserve(replaced.body);
  bodies.delete(key);
  bodies.set(key, entry);
  if (bodies.size > BODY_CACHE_MAX) {
    const oldest = bodies.keys().next().value;
    if (shapeTextSizeObserver) shapeTextSizeObserver.unobserve(bodies.get(oldest).body);
    bodies.delete(oldest);
  }
  box.appendChild(entry.body);
  return entry;
}

function plainBody(text) {
  const body = document.createElement("div");
  body.className = `${SHAPE_TEXT_BODY_CLASS} is-plain`;
  body.textContent = text;
  return body;
}

async function renderLiveBody(id, entry) {
  const started = performance.now();
  try {
    await renderShapeMarkdown(entry.body, entry.source, () => bodies.get(id) !== entry);
    if (bodies.get(id) !== entry) return;
    entry.state = "rendered";
    entry.body.classList.remove("is-pending");
    watchRenderedSize(id, entry.body);
    notePdfGesture("text", "rendered", { id, ms: performance.now() - started });
  } catch (error) {
    if (bodies.get(id) !== entry) return;
    // The words still show — as the plain text the placeholder already holds.
    entry.state = "failed";
    entry.body.classList.remove("is-pending");
    entry.body.classList.remove("rendered");
    entry.body.textContent = markdownToPlainText(entry.source);
    console.warn("Could not render the markdown in a text box", error);
    notePdfGesture("text", "render failed", { id, error: error?.message || String(error) });
  }
  renderedHandler(id);
}

// ── ...and re-measured when it changes size by itself ───────────────────────
//
// A render finishing is not the last time rendered words change size: KaTeX's
// fonts and a picture in the words arrive later, and a diagram lays itself out
// after that. Each would leave the stored box a few points off what is shown —
// and the stored box is what a press is hit-tested against. So every rendered
// body is watched, by one shared observer, and a change in its size asks for the
// same measurement a finished render does. Converges: the fitter only writes
// when the two disagree by more than a point.
const bodyIds = new WeakMap();
let shapeTextSizeObserver = null;

function watchRenderedSize(id, body) {
  if (typeof ResizeObserver !== "function") return;
  if (!shapeTextSizeObserver) {
    shapeTextSizeObserver = new ResizeObserver((entries) => {
      const ids = new Set();
      entries.forEach((entry) => {
        const key = bodyIds.get(entry.target);
        // Only a body still on the page and still the current one for its id.
        if (key && entry.target.isConnected && bodies.get(key)?.body === entry.target) ids.add(key);
      });
      ids.forEach((key) => renderedHandler(key));
    });
  }
  bodyIds.set(body, id);
  shapeTextSizeObserver.observe(body);
}

// The render itself — the pair src/notes/note-editor-kit.js and the text
// blocks use — and the image passes a note's pictures get. `stale()` says a
// newer render owns this body, at each await, so a late one never writes over it.
async function renderShapeMarkdown(body, source, stale = () => false) {
  await renderMarkdown(body, typedTextMarkdown(source));
  if (stale()) return;
  await enhanceRenderedMarkdown(body);
  if (stale()) return;
  await hydrateLocalImages(body);
  await resolveStorageImages(body);
  // A picture in the words is part of something that is picked up and dragged;
  // the browser's own image drag would cancel that drag (see the same rule on
  // the text blocks, src/documents/pdf-blocks.js).
  body.querySelectorAll("img").forEach((img) => { img.draggable = false; });
}

// ── The static copy, for a picture or an export ─────────────────────────────
//
// The same box and the same rendered words, with nothing that makes the live
// one a thing you can pick up, sized EXACTLY to the stored rectangle. Resolves
// once the words are rendered and any picture in them has decoded, so a caller
// turning it into pixels gets the finished box.
export async function buildStaticShapeText(record, viewport) {
  const prim = shapeTextPrimitive(record?.shape);
  if (!prim) return null;
  const box = document.createElement("div");
  box.className = `${PDF_SHAPE_TEXT_CLASS} is-static`;
  box.style.position = "absolute";
  box.style.pointerEvents = "none";
  styleShapeTextBox(box, prim, viewport, { exact: true });
  if (!shapeTextNeedsRendering(prim.text)) {
    box.appendChild(plainBody(prim.text));
    return box;
  }
  const body = document.createElement("div");
  body.className = `${SHAPE_TEXT_BODY_CLASS} rendered`;
  box.appendChild(body);
  await renderShapeMarkdown(body, prim.text);
  await Promise.all([...box.querySelectorAll("img")].map((img) => (img.decode ? img.decode().catch(() => {}) : null)));
  return box;
}
