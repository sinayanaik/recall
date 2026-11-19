// ── A section line, pressed ────────────────────────────────────────────────
//
// The lines that section lines draw (./section-lines.js) are paint, not
// elements: a block's own border-image, out in the strip beside it. So the
// strip is the notes view itself, and this works out from the pointer which
// line it is over — and therefore which heading's section — the way a thread
// line under a comment collapses the replies under it:
//
//   • a click (or a tap) on a line folds that section, the same as the arrow
//     on its heading, and brings the heading into view if it was above;
//   • a mouse over one darkens that one line, down the whole section, and
//     makes the pointer a hand.
//
// One delegated listener of each kind on #notesView, registered once at boot
// (src/main.js), like initNotesFoldTwisties.

import { el } from "../core/dom.js?v=__BUILD__";
import { NOTES_CHUNK_CLASS, toggleNotesHeadingFold } from "../render/block-cache.js?v=__BUILD__";
import { outlineDepthOf, sectionLinesOn } from "./section-lines.js?v=__BUILD__";

const HOT_INK = "var(--ol-hot-ink)";
const HOT_CLASS = "is-outline-hot";

// The block before/after `node` in the note, across chunk boundaries.
function blockBefore(node) {
  if (node.previousElementSibling) return node.previousElementSibling;
  const chunk = node.parentElement;
  if (chunk?.classList.contains(NOTES_CHUNK_CLASS)) return chunk.previousElementSibling?.lastElementChild || null;
  return null;
}

function blockAfter(node) {
  if (node.nextElementSibling) return node.nextElementSibling;
  const chunk = node.parentElement;
  if (chunk?.classList.contains(NOTES_CHUNK_CLASS)) return chunk.nextElementSibling?.firstElementChild || null;
  return null;
}

// The top-level block that owns `target`, or null outside one.
function topLevelBlock(target, view) {
  let node = target;
  while (node && node.parentElement && node.parentElement !== view && !node.parentElement.classList.contains(NOTES_CHUNK_CLASS)) {
    node = node.parentElement;
  }
  return node && node !== view && !node.classList?.contains(NOTES_CHUNK_CLASS) && view.contains(node) ? node : null;
}

// The block level with the pointer: whatever is under it a little to the right
// of the strip, or — in the gap between two blocks — the next one down.
function blockAtY(view, x, y, step) {
  const probeX = x + step * 7;
  for (let dy = 0; dy <= 48; dy += 6) {
    const hit = document.elementFromPoint(probeX, y + dy);
    if (!hit || !view.contains(hit)) continue;
    const block = topLevelBlock(hit, view);
    if (block && !block.hidden) return block;
  }
  return null;
}

function lengthOf(view, name) {
  return parseFloat(getComputedStyle(view).getPropertyValue(name)) || 0;
}

// Which section's line is at (x, y): the heading, the line's index (its depth)
// and the CSS colour variable that draws it. Null if the pointer is not on one.
function sectionLineAt(view, x, y) {
  if (!sectionLinesOn() || view.classList.contains("is-paged")) return null;
  const step = lengthOf(view, "--ol-step");
  if (!(step > 0)) return null;
  const offset = lengthOf(view, "--ol-offset");
  const width = lengthOf(view, "--ol-width") || 1;
  const block = blockAtY(view, x, y, step);
  const depth = outlineDepthOf(block);
  if (!depth) return null;
  const left = block.getBoundingClientRect().left - depth * step;
  const k = Math.round((x - left - offset - width / 2) / step);
  if (k < 0 || k >= depth) return null;
  const lineX = left + k * step + offset + width / 2;
  if (Math.abs(x - lineX) > Math.max(5, step / 2)) return null;
  // The section the line belongs to: the nearest heading above at that depth.
  let node = block;
  while (node) {
    if (/^H[1-6]$/.test(node.tagName) && outlineDepthOf(node) === k && node !== block) break;
    if (/^H[1-6]$/.test(node.tagName) && outlineDepthOf(node) < k) return null;
    node = blockBefore(node);
  }
  if (!node) return null;
  return { heading: node, depth: k, variable: `--ol-c${k + 1}` };
}

// The blocks a heading's line runs beside: everything after it, up to the
// next heading as shallow as it.
function sectionBlocks(heading, depth) {
  const nodes = [];
  for (let node = blockAfter(heading); node; node = blockAfter(node)) {
    if (/^H[1-6]$/.test(node.tagName) && outlineDepthOf(node) <= depth) break;
    nodes.push(node);
  }
  return nodes;
}

let hot = null;

function clearHot(view) {
  if (!hot) return;
  hot.nodes.forEach((node) => node.style.removeProperty(hot.variable));
  hot = null;
  view?.classList.remove(HOT_CLASS);
}

function setHot(view, line) {
  if (hot && line && hot.heading === line.heading && hot.depth === line.depth) return;
  clearHot(view);
  if (!line) return;
  const nodes = sectionBlocks(line.heading, line.depth);
  nodes.forEach((node) => node.style.setProperty(line.variable, HOT_INK));
  hot = { ...line, nodes };
  view.classList.add(HOT_CLASS);
}

export function initNotesSectionLines() {
  const view = el.notesView;
  if (!view) return;
  // Where the press began: a drag that selects text from the margin across a
  // paragraph ends in a click on their common ancestor — this view — and must
  // not fold anything.
  let down = null;
  view.addEventListener("pointerdown", (event) => {
    down = { x: event.clientX, y: event.clientY };
  }, true);
  view.addEventListener("click", (event) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    if (event.target !== view && !event.target.classList?.contains(NOTES_CHUNK_CLASS)) return;
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    const line = sectionLineAt(view, event.clientX, event.clientY);
    const key = line?.heading.querySelector(":scope > .notes-fold-twisty")?.dataset.foldKey;
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    clearHot(view);
    toggleNotesHeadingFold(key);
    // Folded from far down a long section, the heading is above the screen:
    // bring it back, the way a collapsed thread keeps its comment in view.
    const viewTop = view.getBoundingClientRect().top;
    if (line.heading.getBoundingClientRect().top < viewTop) line.heading.scrollIntoView({ block: "start" });
  });
  let frame = 0;
  let last = null;
  view.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    last = event;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const ev = last;
      const onStrip = ev && !ev.buttons && (ev.target === view || ev.target.classList?.contains(NOTES_CHUNK_CLASS));
      setHot(view, onStrip ? sectionLineAt(view, ev.clientX, ev.clientY) : null);
    });
  });
  view.addEventListener("pointerleave", () => clearHot(view));
}
