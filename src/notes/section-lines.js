// ── Section lines ──────────────────────────────────────────────────────────
//
// Each heading's section in the notes view is set in one small step, with a
// thin line down its left side — the way a thread of replies hangs under the
// comment it answers — so how deep a paragraph sits in the note can be seen at
// a glance. ◐ Notes → Section lines turns it off and sizes it.
//
// The note's DOM is flat (headings are siblings of the paragraphs under them),
// so nothing is wrapped: every top-level block is given its DEPTH — how many
// sections it is inside — as `data-outline-depth`, and the stylesheet does the
// rest (styles/a5-section-lines.css): it indents the block by that many steps
// and draws that many lines beside it. Written from applyNotesFoldState
// (src/render/block-cache.js), which already walks every block after every
// render, fold and lazily built span, so this costs one more pass over an
// array it has in hand and an attribute write only where a depth changed.
//
// The click and hover on a line live in ./section-lines-gutter.js.

// The setting, as applyStyleSettings last left it.
let linesOn = true;
let topSetting = "auto";

export const SECTION_LINES_CLASS = "notes-outline";

export function sectionLinesOn() {
  return linesOn;
}

// Returns whether anything changed, so the caller knows to repaint the note.
export function setNotesSectionLines({ on = true, top = "auto" } = {}) {
  const nextTop = ["h1", "h2", "h3", "h4"].includes(top) ? top : "auto";
  const changed = linesOn !== Boolean(on) || topSetting !== nextTop;
  linesOn = Boolean(on);
  topSetting = nextTop;
  if (typeof document !== "undefined") document.documentElement.classList.toggle(SECTION_LINES_CLASS, linesOn);
  return changed;
}

// The heading level that starts a thread. Headings above it are titles: no
// line, no step. "auto" makes a lone title one — a note that opens with its
// only H1 and puts everything under it would otherwise be set one step in from
// top to bottom for nothing.
//
// `levels` is every heading level in the note, in order (0s are ignored).
export function outlineTopLevel(levels, setting = topSetting) {
  const fixed = /^h([1-6])$/.exec(setting);
  if (fixed) return Number(fixed[1]);
  const present = (levels || []).filter((level) => level > 0);
  if (!present.length) return 1;
  const shallowest = Math.min(...present);
  const lone = present[0] === shallowest
    && present.indexOf(shallowest, 1) === -1
    && present.some((level) => level > shallowest);
  return lone ? shallowest + 1 : shallowest;
}

// One depth per block, from its heading level (0 for anything that is not a
// heading). The same open-section stack as headingNumbersForLevels
// (src/notes/heading-numbers.js), so a skipped level ("#" then "###") is one
// step, not two: a heading is as deep as the sections still open above it, and
// what is under it one deeper. A title (shallower than `top`) closes every
// section and opens none.
export function sectionLineDepths(levels, top = 1) {
  const open = [];
  return (levels || []).map((level) => {
    if (level && level < top) {
      open.length = 0;
      return 0;
    }
    if (level) {
      while (open.length && open[open.length - 1] >= level) open.pop();
      const depth = open.length;
      open.push(level);
      return depth;
    }
    return open.length;
  });
}

// The top level for a whole note's heading scan ({ level } per heading, from
// notesHeadingScan in src/render/block-cache.js), kept per scan: the scan is
// the same array for as long as the note is, and this runs after every fold.
const topByScan = new WeakMap();

function topForScan(scan) {
  const known = topByScan.get(scan);
  if (known && known.setting === topSetting) return known.top;
  const top = outlineTopLevel(scan.map((entry) => entry.level));
  topByScan.set(scan, { setting: topSetting, top });
  return top;
}

// `blocks` and `levels` are the notes view's top-level blocks and each one's
// heading level; `noteScan`, when known, the headings of the WHOLE note — a
// long note is built a part at a time, and whether its title is alone is a
// question about all of it.
export function paintNotesOutline(blocks, levels, noteScan = null) {
  if (!linesOn) {
    blocks.forEach((node) => {
      if (node.dataset.outlineDepth !== undefined) delete node.dataset.outlineDepth;
    });
    return;
  }
  const top = Array.isArray(noteScan) ? topForScan(noteScan) : outlineTopLevel(levels);
  const depths = sectionLineDepths(levels, top);
  blocks.forEach((node, index) => {
    const depth = Math.min(6, depths[index] || 0);
    const want = depth ? String(depth) : undefined;
    if (node.dataset.outlineDepth === want) return;
    if (want) node.dataset.outlineDepth = want;
    else delete node.dataset.outlineDepth;
  });
}

export function outlineDepthOf(node) {
  return Number(node?.dataset?.outlineDepth) || 0;
}
