// Markdown → PDF: where the pages break.
//
// The layout (md-pdf/layout.js) made one continuous column of rows; this cuts
// it into pages. The planner is the clipper extension's Smart pages
// (recall-clipper/content/prepare.js — chooseBreaks, chunkHeights, nearest,
// stepFrom), ported from DOM elements to rows: greedy, from the top of each
// page the best CLEAN cut between 70% and 100% of the page length (WINDOW), where a
// heading beats a paragraph, a paragraph beats a list item, and a fuller page
// beats an emptier one. A table cut between its rows prints its header again,
// so the page after it has that much less room.
//
// The same planner serves every layout; they differ only in how long a page
// may be and what is done with the pieces:
//
//   smart   about the chosen length; each page TRIMMED to where its own content
//           ends — no band of white at the foot of a page, which is most of
//           what makes it the space-saving default
//   paper   full sheets of one size; a page's content never exceeds the sheet
//   long    one page as tall as the content (a PDF page stops at 200 inches;
//           past that it is cut like any other)
//
// Two columns lay the same column out at half width and put two of its pieces
// side by side on each page; the last page's pair is balanced. "Break before
// H1/H2/H3" makes every such heading a cut that is always there.
//
// A page break is remembered by the KEY of the row under it (the row's block
// fingerprint and its place in the block), so the cuts you place by hand stay
// where you put them while the markdown above or below is edited. Pure.

import { PDF_MAX_PAGE_PT } from "./layout.js?v=__BUILD__";

const MIN_TAIL = 40;
// Where on a page the planner starts looking for a cut, and how much a fuller
// page is worth against a better place. The extension looks from 55% with a
// weight of 1.5, so a heading anywhere past half a page wins — right for a web
// page saved to read, and a third of every sheet left white in a PDF whose
// point is to be small. From 70%, with fullness counting double, a heading
// still wins when it is near the foot of the page, and a page is not ended
// early for one that is not.
const WINDOW = 0.7;
const FILL_WEIGHT = 3;

function rowBottom(row) {
  return row.y + row.h;
}

// The planner over rows [a, b): indices of the rows each new piece starts at.
// `room` is how much column a piece holds.
export function chooseBreaks(rows, a, b, room) {
  const cuts = [];
  if (b - a < 2) return { cuts, uncut: false };
  let startIdx = a;
  let start = rows[a].y;
  let roomNow = room;
  const end = rowBottom(rows[b - 1]);
  let uncut = false;
  let guard = 0;
  while (end - start > roomNow && guard < 5000) {
    guard += 1;
    let best = null;
    let bestValue = -Infinity;
    let lastClean = null;
    let lastAny = null;
    for (let i = startIdx + 1; i < b; i += 1) {
      const row = rows[i];
      const used = rowBottom(rows[i - 1]) - start;
      if (used > roomNow + 0.01) break;
      if (!row.cut) continue;
      if (row.cut.clean) {
        if (row.y - start > MIN_TAIL) lastClean = i;
        if (row.y > start + roomNow * WINDOW) {
          const value = row.cut.score + FILL_WEIGHT * (used / roomNow);
          if (value >= bestValue) { best = i; bestValue = value; }
        }
      }
      if (row.y - start > MIN_TAIL || lastAny === null) lastAny = i;
    }
    // Nothing clean in the window: the last clean cut there is at all, then
    // any cut (the middle of a long paragraph or code block), then — one row
    // taller than the page — straight after it.
    let pick = best ?? lastClean ?? lastAny;
    if (pick === null || pick === undefined) {
      uncut = true;
      pick = startIdx + 1;
    }
    cuts.push(pick);
    startIdx = pick;
    start = rows[pick].y;
    const extra = rows[pick].repeat ? rows[pick].repeat.h : 0;
    roomNow = Math.max(60, room - extra);
    if (start >= end) break;
  }
  return { cuts, uncut };
}

// The forced cuts: rows that start a heading at or above `breakBefore`.
export function forcedCuts(rows, breakBefore) {
  const level = { h1: 1, h2: 2, h3: 3 }[breakBefore] || 0;
  if (!level) return [];
  const out = [];
  rows.forEach((row, i) => {
    if (i > 0 && row.heading && row.heading.level <= level) out.push(i);
  });
  return out;
}

// Height of the column from row a up to (not including) row b, plus a
// repeated table header when the piece starts inside a table.
export function sliceHeight(rows, a, b) {
  if (b <= a) return 0;
  return rowBottom(rows[b - 1]) - rows[a].y + (a > 0 && rows[a].repeat ? rows[a].repeat.h : 0);
}

function slicesFrom(rows, cutIdx) {
  const edges = [0, ...cutIdx, rows.length];
  const slices = [];
  for (let k = 1; k < edges.length; k += 1) {
    const from = edges[k - 1];
    const to = edges[k];
    if (to > from) slices.push({ from, to, h: sliceHeight(rows, from, to) });
  }
  return slices;
}

function uniqSorted(list) {
  return [...new Set(list)].filter((i) => Number.isInteger(i)).sort((x, y) => x - y);
}

// Balance rows [a, b) into two columns: the cut that makes the taller half
// shortest.
function balanceTwo(rows, a, b) {
  let best = null;
  let bestH = Infinity;
  for (let i = a + 1; i < b; i += 1) {
    if (!rows[i].cut) continue;
    const h = Math.max(sliceHeight(rows, a, i), sliceHeight(rows, i, b));
    const penalty = rows[i].cut.clean ? 0 : 18;
    if (h + penalty < bestH) { bestH = h + penalty; best = i; }
  }
  return best;
}

// The whole plan.
//
// `cuts` — null to plan automatically, or the list of row KEYS a person left
// the page breaks at (the editor's state). Keys that no longer name a row (the
// paragraph was deleted) are dropped. Returns:
//
//   cuts     the row indices the pages start at (after the first)
//   keys     the same, as keys — what gets stored
//   slices   [{ from, to, h }] column pieces
//   pages    [{ slices: [i…], width, height, contentHeight, over }]
//   uncut    a row taller than a page had to be cut after
export function planPages(flow, { cuts = null } = {}) {
  const { rows, geometry: g, options: o } = flow;
  if (!rows.length) return { cuts: [], keys: [], slices: [], pages: [], uncut: false, room: g.pageContent };
  const room = g.pageContent;
  // The most one column piece may ever hold: a sheet in paper mode, the PDF
  // page limit otherwise.
  const hardLimit = o.layout === "paper" ? room : PDF_MAX_PAGE_PT - g.marginTop - g.marginBottom;
  const forced = forcedCuts(rows, o.breakBefore);
  let cutIdx;
  let uncut = false;
  if (Array.isArray(cuts)) {
    const byKey = new Map(rows.map((row, i) => [row.key, i]));
    cutIdx = uniqSorted(cuts.map((key) => byKey.get(key)).filter((i) => i > 0));
  } else if (o.layout === "long" && o.columns === 1) {
    cutIdx = forced;
  } else if (o.layout === "long") {
    // One page per section, each balanced into two columns.
    const edges = [0, ...forced, rows.length];
    cutIdx = [...forced];
    for (let k = 1; k < edges.length; k += 1) {
      const mid = balanceTwo(rows, edges[k - 1], edges[k]);
      if (mid !== null) cutIdx.push(mid);
    }
    cutIdx = uniqSorted(cutIdx);
  } else {
    const edges = [0, ...forced, rows.length];
    cutIdx = [...forced];
    for (let k = 1; k < edges.length; k += 1) {
      const result = chooseBreaks(rows, edges[k - 1], edges[k], room);
      cutIdx.push(...result.cuts);
      uncut = uncut || result.uncut;
    }
    cutIdx = uniqSorted(cutIdx);
  }
  // Whatever the cuts, no piece may exceed the hard limit: one that does is
  // planned again inside itself (a hand-placed cut list on paper pages, or a
  // long page past 200 inches).
  const fixed = [];
  for (const slice of slicesFrom(rows, cutIdx)) {
    if (slice.h > hardLimit + 0.01) {
      const result = chooseBreaks(rows, slice.from, slice.to, hardLimit);
      fixed.push(...result.cuts);
      uncut = uncut || result.uncut;
    }
  }
  cutIdx = uniqSorted([...cutIdx, ...fixed]);
  let slices = slicesFrom(rows, cutIdx);

  // Pieces → pages.
  const pages = [];
  const perPage = o.columns === 2 ? 2 : 1;
  if (perPage === 2 && o.layout === "long") {
    // Every section is one page of two balanced columns: pair the pieces by
    // the section they fall in.
    const sectionOf = (from) => forced.filter((f) => f <= from).length;
    for (let s = 0; s < slices.length; s += 1) {
      const last = pages[pages.length - 1];
      if (last && last.slices.length < 2 && sectionOf(slices[last.slices[0]].from) === sectionOf(slices[s].from)) last.slices.push(s);
      else pages.push({ slices: [s] });
    }
  } else {
    for (let s = 0; s < slices.length; s += perPage) {
      pages.push({ slices: slices.slice(s, s + perPage).map((_, k) => s + k) });
    }
  }
  // The last page of two columns is balanced, unless it was planned by hand.
  if (perPage === 2 && !Array.isArray(cuts) && o.layout !== "long" && pages.length) {
    const last = pages[pages.length - 1];
    const from = slices[last.slices[0]].from;
    const to = slices[last.slices[last.slices.length - 1]].to;
    const forcedInside = forced.some((f) => f > from && f < to);
    if (!forcedInside) {
      const mid = balanceTwo(rows, from, to);
      if (mid !== null) {
        cutIdx = uniqSorted([...cutIdx.filter((i) => i <= from || i >= to), mid]);
        slices = slicesFrom(rows, cutIdx);
        // Re-pair: everything before is unchanged, the last page is the two
        // balanced halves.
        pages.length = 0;
        for (let s = 0; s < slices.length; s += 2) pages.push({ slices: slices.slice(s, s + 2).map((_, k) => s + k) });
      }
    }
  }
  for (const page of pages) {
    const contentHeight = Math.max(...page.slices.map((s) => slices[s].h), 0);
    page.contentHeight = contentHeight;
    page.width = g.pageWidth;
    page.height = o.layout === "paper"
      ? g.paperHeight
      : Math.min(PDF_MAX_PAGE_PT, Math.max(contentHeight, 24) + g.marginTop + g.marginBottom);
    // Longer than the chosen length: shown amber in the editor, as the
    // extension does. Only a smart page can be; paper never is.
    page.over = o.layout === "smart" && contentHeight > room + 0.5;
    page.fill = room > 0 ? contentHeight / room : 1;
  }
  return {
    cuts: cutIdx,
    keys: cutIdx.map((i) => rows[i].key),
    slices,
    pages,
    uncut,
    room
  };
}

// For the editor: the candidate rows a dragged cut snaps to. `any` includes
// the unclean ones (inside a paragraph or code block) — Alt, in the extension.
export function cutCandidates(rows, { any = false } = {}) {
  const out = [];
  rows.forEach((row, i) => {
    if (i === 0 || !row.cut) return;
    if (any || row.cut.clean) out.push({ i, y: row.y, score: row.cut.score, clean: row.cut.clean });
  });
  return out;
}

// The candidate nearest `y` (binary search over a y-sorted list), leaving out
// the indices in `skip`.
export function nearestCandidate(list, y, skip = new Set()) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].y < y) lo = mid + 1; else hi = mid;
  }
  let best = null;
  for (let k = Math.max(0, lo - 3); k < Math.min(list.length, lo + 3); k += 1) {
    const c = list[k];
    if (skip.has(c.i)) continue;
    if (!best || Math.abs(c.y - y) < Math.abs(best.y - y)) best = c;
  }
  if (!best) for (const c of list) if (!skip.has(c.i) && (!best || Math.abs(c.y - y) < Math.abs(best.y - y))) best = c;
  return best;
}

// The candidate before (dir −1) or after (+1) `y`.
export function stepCandidate(list, y, dir, skip = new Set()) {
  if (dir > 0) { for (const c of list) if (c.y > y + 1 && !skip.has(c.i)) return c; }
  else for (let k = list.length - 1; k >= 0; k -= 1) if (list[k].y < y - 1 && !skip.has(list[k].i)) return list[k];
  return null;
}

// The dialog's preview: the column as ONE continuous strip — no page breaks,
// so a page break can be dragged through the text — on pages one column wide,
// cut only where a PDF page must end (200 inches).
export function previewPlan(flow) {
  const { rows, geometry: g } = flow;
  if (!rows.length) return { cuts: [], keys: [], slices: [], pages: [], uncut: false, room: g.pageContent };
  const limit = PDF_MAX_PAGE_PT - g.marginTop - g.marginBottom;
  const { cuts } = flow.height > limit ? chooseBreaks(rows, 0, rows.length, limit) : { cuts: [] };
  const slices = slicesFrom(rows, cuts);
  const pages = slices.map((slice, s) => ({
    slices: [s],
    width: g.columnWidth + 2 * g.marginX,
    height: slice.h + g.marginTop + g.marginBottom,
    contentHeight: slice.h,
    over: false,
    fill: 1
  }));
  return { cuts, keys: cuts.map((i) => rows[i].key), slices, pages, uncut: false, room: g.pageContent };
}
