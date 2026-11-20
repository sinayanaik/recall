// Whole things out of the Notes, onto the Canvas beside them.
//
// With the Canvas side by side with the Notes, a ⠿ grip comes up at the left
// of a picture, a code listing, a table, a diagram, a block of maths or a
// heading as the pointer goes over it, and dragging the grip takes the whole
// of it — a heading with its section, down to the next heading of its level or
// above — to a Canvas page (src/documents/canvas-drop.js), where it becomes a
// Block as anything else dropped there does. A picture dragged by itself (the
// browser's own drag of an <img>) goes the same way.
//
// One grip for the whole view, moved to whatever is under the pointer: the
// rendered Notes are a cached render (src/render/block-cache.js) and are not
// written into.
//
// What it carries is the markdown the thing was written as: the slice of the
// Notes the render cache says it came from (src/format/source-blocks.js), or,
// when the cache cannot say, the same serialisation a selection of it would
// give (notesSelectionMarkdown). Its sizes there are taken off on the Canvas
// (canvasSizedMarkdown, ./canvas-sizing.js).

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { preparedSourceMap, renderedBlockFor, renderedSourceContext } from "../format/source-blocks.js?v=__BUILD__";
import { notesSelectionMarkdown, SELECTION_TARGETS, isTargetEditing } from "../notes/selection.js?v=__BUILD__";
import { headingNumbersOn, stripTypedHeadingNumbersFromMarkdown } from "../notes/heading-numbers.js?v=__BUILD__";
import { isNotesShown, isPartShown } from "../ui/split-parts.js?v=__BUILD__";

// What a grip comes up for. A table's scroller and a picture's shell are the
// things on screen; the <table> and <img> inside them are found through them.
export const NOTES_GRIP_SELECTOR = [
  ".diagram-shell", "pre", "table", ".mermaid", ".nomnoml-diagram", ".math-display",
  "h1", "h2", "h3", "h4", "h5", "h6"
].join(", ");

const notesGripSelectionTarget = () => SELECTION_TARGETS.find((target) => target.name === "notes");

// The Canvas and the Notes both on screen, the Notes read rather than typed in.
export function notesGripAvailable() {
  const target = notesGripSelectionTarget();
  return Boolean(state.splitPart) && isPartShown("handwriting") && isNotesShown()
    && Boolean(el.notesView) && !el.notesView.hidden && !(target && isTargetEditing(target));
}

// The thing a grip stands for, from any node inside it.
export function notesGripElement(node) {
  const start = node?.nodeType === 1 ? node : node?.parentElement;
  const found = start?.closest?.(NOTES_GRIP_SELECTOR);
  if (!found || !el.notesView?.contains(found)) return null;
  // A table's own scroller, a picture's own shell: the outer one is the thing.
  return found.closest(".diagram-shell") || found;
}

function gripKeyHash(text) {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const unmark = (md) => String(md || "").replace(/<\/?mark\b[^>]*>/gi, "");

// The heading's level as written: `## Title` is 2, whatever level the view
// promoted it to.
function writtenHeadingLevel(line) {
  const match = String(line || "").match(/^ {0,3}(#{1,6})(?:\s|$)/);
  return match ? match[1].length : 0;
}

// From `start` (a heading's line) to the next heading at its level or above,
// outside code fences — the heading's section.
export function headingSectionEnd(body, start) {
  const text = String(body || "");
  const firstEnd = text.indexOf("\n", start);
  const level = writtenHeadingLevel(text.slice(start, firstEnd === -1 ? text.length : firstEnd));
  if (!level || firstEnd === -1) return text.length;
  let at = firstEnd + 1;
  let fence = null;
  while (at < text.length) {
    const end = text.indexOf("\n", at);
    const line = text.slice(at, end === -1 ? text.length : end);
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
    } else if (open) {
      fence = open[1];
    } else {
      const next = writtenHeadingLevel(line);
      if (next && next <= level) return at;
    }
    if (end === -1) break;
    at = end + 1;
  }
  return text.length;
}

// The markdown slice the render cache says `node` came from, with where it
// starts in the Notes, when `node` is all of its block — or null.
function sourceSliceFor(node) {
  const context = renderedSourceContext(el.notesView, state.notes || "");
  if (!context) return null;
  const block = renderedBlockFor(context, node);
  if (!block || !block.roots.length) return null;
  const toSource = preparedSourceMap(context);
  const start = toSource(block.preparedStart, "start");
  const end = toSource(block.preparedEnd, "end");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { body: context.body, start, end, roots: block.roots };
}

function textOf(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function rangeMarkdown(startNode, endNode = null) {
  const range = document.createRange();
  range.setStartBefore(startNode);
  if (endNode) range.setEndBefore(endNode);
  else range.setEndAfter(el.notesView.lastChild || startNode);
  return String(notesSelectionMarkdown(range, notesGripSelectionTarget()) || "").trim();
}

function nodeMarkdown(node) {
  const range = document.createRange();
  range.selectNode(node);
  return String(notesSelectionMarkdown(range, notesGripSelectionTarget()) || "").trim();
}

const IMAGE_TOKEN_RE = /!\[[^\]]*\]\((?:<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\)|<img\b[^>]*>/gi;

function headingMarkdown(heading) {
  const slice = sourceSliceFor(heading);
  if (slice) return slice.body.slice(slice.start, headingSectionEnd(slice.body, slice.start)).trim();
  // The DOM's own reading: from the heading to the next heading of its level
  // or above, in the order the view shows them.
  const level = Number(heading.tagName.slice(1)) || 6;
  const headings = [...el.notesView.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  const next = headings.slice(headings.indexOf(heading) + 1).find((h) => (Number(h.tagName.slice(1)) || 6) <= level);
  return rangeMarkdown(heading, next || null);
}

function pictureMarkdown(shell) {
  const img = shell.matches("img") ? shell : shell.querySelector("img");
  const slice = sourceSliceFor(shell);
  if (slice && img) {
    const md = slice.body.slice(slice.start, slice.end);
    const tokens = md.match(IMAGE_TOKEN_RE) || [];
    const imgs = slice.roots.flatMap((root) => (root.matches?.("img") ? [root] : [...(root.querySelectorAll?.("img") || [])]));
    const token = tokens.length === imgs.length ? tokens[imgs.indexOf(img)] : tokens.length === 1 ? tokens[0] : null;
    if (token) return token;
  }
  return nodeMarkdown(shell);
}

// The markdown for a whole thing in the Notes, or "".
export function notesElementMarkdown(node) {
  const thing = notesGripElement(node) || (node?.matches?.("img") && el.notesView?.contains(node) ? node : null);
  if (!thing) return "";
  let md;
  if (/^H[1-6]$/.test(thing.tagName)) md = headingMarkdown(thing);
  else if (thing.matches("img") || (thing.matches(".diagram-shell") && thing.querySelector("img") && !thing.querySelector(".mermaid, .nomnoml-diagram"))) md = pictureMarkdown(thing);
  else {
    const slice = sourceSliceFor(thing);
    const whole = slice && textOf({ textContent: slice.roots.map((root) => root.textContent).join(" ") }) === textOf(thing);
    md = whole ? slice.body.slice(slice.start, slice.end) : nodeMarkdown(thing);
  }
  md = unmark(md).trim();
  if (md && headingNumbersOn()) md = stripTypedHeadingNumbersFromMarkdown(md);
  return md;
}

// The item a drag of it carries (src/documents/canvas-feed.js's shape).
export function notesElementItem(node) {
  const md = notesElementMarkdown(node);
  return md ? { kind: "text", md, from: `notes:el:${gripKeyHash(md)}` } : null;
}

// ── The grip ──────────────────────────────────────────────────────────────

let notesGrip = null;
let gripFor = null;

export function notesGripTarget() {
  return gripFor && gripFor.isConnected ? gripFor : null;
}

function hideGrip() {
  gripFor = null;
  if (notesGrip) notesGrip.hidden = true;
}

function ensureGrip() {
  if (notesGrip) return notesGrip;
  notesGrip = document.createElement("button");
  notesGrip.type = "button";
  notesGrip.className = "notes-canvas-grip";
  notesGrip.hidden = true;
  notesGrip.setAttribute("draggable", "true");
  notesGrip.title = "Drag onto the Canvas";
  notesGrip.setAttribute("aria-label", "Drag this onto the Canvas");
  notesGrip.textContent = "⠿";
  notesGrip.addEventListener("pointerleave", (event) => {
    if (!gripFor?.contains(event.relatedTarget)) hideGrip();
  });
  document.body.appendChild(notesGrip);
  return notesGrip;
}

function placeGrip(thing) {
  const rect = thing.getBoundingClientRect();
  const view = el.notesView.getBoundingClientRect();
  if (!rect.height || rect.bottom < view.top || rect.top > view.bottom) { hideGrip(); return; }
  const button = ensureGrip();
  gripFor = thing;
  button.dataset.kind = /^H[1-6]$/.test(thing.tagName) ? "heading" : "block";
  button.title = button.dataset.kind === "heading" ? "Drag this heading and its section onto the Canvas" : "Drag this onto the Canvas";
  button.hidden = false;
  const size = 22;
  const left = Math.max(view.left + 2, rect.left - size - 4);
  const top = Math.max(view.top + 2, Math.min(rect.top + 2, view.bottom - size - 2));
  button.style.left = `${Math.round(left)}px`;
  button.style.top = `${Math.round(top)}px`;
}

function onNotesPointerMove(event) {
  if (event.pointerType === "touch" || !notesGripAvailable()) { hideGrip(); return; }
  if (notesGrip && (event.target === notesGrip)) return;
  const thing = notesGripElement(event.target);
  if (!thing) {
    // Over the gutter between the grip and its thing: keep it.
    if (gripFor && notesGrip && !notesGrip.hidden) {
      const rect = gripFor.getBoundingClientRect();
      if (event.clientY >= rect.top && event.clientY <= rect.bottom && event.clientX < rect.left && event.clientX > rect.left - 40) return;
    }
    hideGrip();
    return;
  }
  if (thing !== gripFor || notesGrip?.hidden) placeGrip(thing);
}

let notesGripWired = false;

export function initNotesGrip() {
  if (notesGripWired || !el.notesView) return;
  notesGripWired = true;
  el.notesView.addEventListener("pointermove", onNotesPointerMove);
  el.notesView.addEventListener("pointerleave", (event) => {
    if (notesGrip && event.relatedTarget === notesGrip) return;
    hideGrip();
  });
  document.addEventListener("scroll", () => { if (gripFor) hideGrip(); }, true);
}
