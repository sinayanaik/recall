// The order a page is read in, for the PDF teleprompter
// (src/documents/pdf-teleprompter.js).
//
// A PDF is a picture of where its author put things, not a stream of words in
// reading order, so "scroll down at so many words a minute" is only right for a
// page set in one column. A two-column paper is read down the left column, back
// up to the top of the right one, and only then on to the next page — and its
// first page usually has a title and an abstract across both columns above
// that. This file turns one page into that order: a list of SEGMENTS, each a
// stretch of the page the eye travels straight down through.
//
//   { kind: "full" | "column", x0, x1, y0, y1, words, linePitch, lines }
//
// All in fractions of the page (0–1, from the top-left corner), so a segment
// means the same thing at every zoom. `words` is what sets the pace through it;
// `linePitch` is how far apart its lines are, which is what the reading band is
// sized from.
//
// ── Two ways in, one way out ───────────────────────────────────────────────
//
//   • A page with a text layer: the boxes of its text items (buildPathFromBoxes).
//   • A scan, with no text at all: a small greyscale picture of the page
//     (buildPathFromInk), read for where the ink is — the gutter between two
//     columns is a stripe with none, and a line of type is a run of rows with
//     some.
//
// Both reduce the page to line FRAGMENTS — a run of type on one line that does
// not cross a gutter — each marked left, right or full (across both columns),
// and segmentsFromFragments turns those into the reading order. So a scanned
// two-column book and a born-digital paper are read the same way.
//
// No DOM and no imports, so tools/pdf-reading-path-check.mjs runs it in node.

// A page with fewer words than this in its text layer is read from its picture
// instead: a scan with a page number stamped on it, or an OCR layer that only
// caught the running head, is not a text layer worth trusting.
export const PATH_MIN_TEXT_WORDS = 20;

// Where a gutter may be, as a fraction of the width the text spans: two-column
// layouts are near the middle; a margin note column at the edge is not a
// second column of the main text.
const GUTTER_SEARCH = [0.3, 0.7];

// How narrow a gutter may be, as a fraction of the page width. Most papers
// leave 3–5%; 1.2% is the narrowest two-column layout that turns up in print.
const GUTTER_MIN_WIDTH = 0.012;

// A stripe counts as empty while what crosses it is at most this share of what
// a column holds: a title, an abstract or a wide caption crosses the gutter,
// and a page that has one is still a two-column page.
const GUTTER_EMPTY_SHARE = 0.2;

// Each side of a gutter has to hold at least this share of the page's text.
const GUTTER_SIDE_SHARE = 0.2;

// Running heads and page numbers: short lines in the top or bottom strip of
// the page, set no bigger than the body. Left out of the path, so the band
// does not stop to read "Proceedings of …, page 4" on every page.
const RUNNING_STRIP = 0.07;
const RUNNING_MAX_WORDS = 15;

// Inside one segment, a vertical gap of more than this many lines (a figure, a
// table, a page's bottom margin) splits it in two, and the camera glides over
// the gap instead of reading it at the pace of the text.
const SPLIT_GAP_LINES = 4;

// ── Small helpers ───────────────────────────────────────────────────────────

function pathMedian(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The body size: the size carrying the most words, not the most lines — six
// words of title do not outvote the paragraph under them.
function pathBodySize(fragments) {
  const weights = new Map();
  fragments.forEach((fragment) => {
    const key = Math.round(fragment.size * 2) / 2;
    if (key > 0) weights.set(key, (weights.get(key) || 0) + Math.max(1, fragment.words));
  });
  let best = 0;
  let bestWeight = -1;
  weights.forEach((weight, size) => {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  });
  return best || pathMedian(fragments.map((fragment) => fragment.size)) || 10;
}

// ── Text boxes into line fragments ──────────────────────────────────────────

// `boxes`: one per text item, { x0, y0, x1, y1, words, size } in page units
// with y DOWN. Items on one baseline are joined while the gap between them is
// below about an em — and never across `splitAt`, the middle of a gutter once
// one is known, which a narrow gutter can be narrower than an em of. Each
// fragment keeps its `items`.
export function fragmentsFromBoxes(boxes, { splitAt = null } = {}) {
  const items = (boxes || [])
    .filter((box) => box && box.x1 > box.x0 && box.y1 > box.y0 && box.size > 0 && box.words > 0)
    .map((box) => ({ ...box }))
    .sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0);
  // Rows by baseline (the box's bottom), within under half the type size.
  const rows = [];
  items.forEach((item) => {
    const row = rows[rows.length - 1];
    if (row && Math.abs(item.y1 - row.y1) <= Math.max(row.size, item.size) * 0.45) {
      row.items.push(item);
      row.size = Math.max(row.size, item.size);
    } else {
      rows.push({ y1: item.y1, size: item.size, items: [item] });
    }
  });
  const fragments = [];
  rows.forEach((row) => {
    row.items.sort((a, b) => a.x0 - b.x0);
    let current = null;
    row.items.forEach((item) => {
      const joinGap = Math.max(current?.size || 0, item.size) * 1.1;
      const crosses = splitAt != null && current && current.x1 <= splitAt && item.x0 >= splitAt;
      if (current && !crosses && item.x0 - current.x1 <= joinGap) {
        current.x1 = Math.max(current.x1, item.x1);
        current.y0 = Math.min(current.y0, item.y0);
        current.y1 = Math.max(current.y1, item.y1);
        current.words += item.words;
        current.size = Math.max(current.size, item.size);
        current.items.push(item);
      } else {
        current = { x0: item.x0, x1: item.x1, y0: item.y0, y1: item.y1, words: item.words, size: item.size, items: [item] };
        fragments.push(current);
      }
    });
  });
  return fragments;
}

function dropRunningLines(fragments, height) {
  const body = pathBodySize(fragments);
  return fragments.filter((fragment) => {
    const inStrip = fragment.y1 < height * RUNNING_STRIP || fragment.y0 > height * (1 - RUNNING_STRIP);
    return !(inStrip && fragment.words <= RUNNING_MAX_WORDS && fragment.size <= body * 1.05);
  });
}

// ── The gutter ──────────────────────────────────────────────────────────────

// The widest stripe in the middle of `coverage` (one number per bin across the
// page, how much text crosses it) that holds next to nothing compared with the
// columns either side. Returns { x0, x1 } in bins, or null.
//
// `relaxed` is the reader's own "Two columns": the stripe with the least in it
// is the gutter even when it is not empty, and the middle of the text when
// nothing stands out at all.
function findGutterBins(coverage, left, right, { minBins, relaxed = false }) {
  const span = right - left;
  if (span < 4) return null;
  const from = Math.floor(left + span * GUTTER_SEARCH[0]);
  const to = Math.ceil(left + span * GUTTER_SEARCH[1]);
  const leftLevel = pathMedian(coverage.slice(left, from).filter((value) => value > 0));
  const rightLevel = pathMedian(coverage.slice(to, right + 1).filter((value) => value > 0));
  const level = Math.min(leftLevel, rightLevel);
  if (level > 0) {
    const ceiling = level * GUTTER_EMPTY_SHARE;
    let best = null;
    let start = -1;
    for (let bin = from; bin <= to + 1; bin += 1) {
      const empty = bin <= to && coverage[bin] <= ceiling;
      if (empty && start < 0) start = bin;
      if (!empty && start >= 0) {
        const run = { x0: start, x1: bin - 1 };
        if (!best || run.x1 - run.x0 > best.x1 - best.x0) best = run;
        start = -1;
      }
    }
    if (best && best.x1 - best.x0 + 1 >= minBins) return best;
  }
  if (!relaxed) return null;
  let low = from;
  for (let bin = from; bin <= to; bin += 1) if (coverage[bin] < coverage[low]) low = bin;
  if (coverage[low] >= Math.max(leftLevel, rightLevel) * 0.8) {
    const middle = Math.round(left + span / 2);
    return { x0: middle, x1: middle };
  }
  return { x0: low, x1: low };
}

// ── Fragments into reading order ────────────────────────────────────────────

// A run of fragments into one segment, or several where a big gap splits it.
function segmentsOf(fragments, kind, width, height) {
  if (!fragments.length) return [];
  const sorted = [...fragments].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  // Line pitch: baseline to baseline, read off fragments that start a new line.
  const baselines = [];
  sorted.forEach((fragment) => {
    const last = baselines[baselines.length - 1];
    if (last == null || fragment.y1 - last > fragment.size * 0.45) baselines.push(fragment.y1);
  });
  const steps = [];
  for (let index = 1; index < baselines.length; index += 1) steps.push(baselines[index] - baselines[index - 1]);
  const size = pathMedian(sorted.map((fragment) => fragment.size)) || 10;
  const pitchSteps = steps.filter((step) => step > size * 0.8 && step < size * 3);
  const pitch = pathMedian(pitchSteps) || size * 1.2;
  const groups = [];
  let group = null;
  sorted.forEach((fragment) => {
    if (group && fragment.y0 - group.y1 > pitch * SPLIT_GAP_LINES) group = null;
    if (!group) {
      group = { x0: fragment.x0, x1: fragment.x1, y0: fragment.y0, y1: fragment.y1, words: 0, lines: 0, lastBaseline: -Infinity };
      groups.push(group);
    }
    group.x0 = Math.min(group.x0, fragment.x0);
    group.x1 = Math.max(group.x1, fragment.x1);
    group.y0 = Math.min(group.y0, fragment.y0);
    group.y1 = Math.max(group.y1, fragment.y1);
    group.words += fragment.words;
    if (fragment.y1 - group.lastBaseline > fragment.size * 0.45) {
      group.lines += 1;
      group.lastBaseline = fragment.y1;
    }
  });
  return groups.map((run) => ({
    kind,
    x0: Math.max(0, run.x0 / width),
    x1: Math.min(1, run.x1 / width),
    y0: Math.max(0, run.y0 / height),
    y1: Math.min(1, run.y1 / height),
    words: Math.max(1, Math.round(run.words)),
    linePitch: pitch / height,
    lines: run.lines
  }));
}

// `fragments` each carry `side`: "left", "right" or "full". Fragments across
// the gutter cut the page into horizontal bands: a band of them is read
// straight down, as one; a band between them is read down its left column and
// then down its right. A left or right fragment that sits INSIDE a full band
// (a short line of the abstract) belongs to that band.
export function segmentsFromFragments(fragments, width, height) {
  if (!fragments.length) return [];
  const full = fragments.filter((fragment) => fragment.side === "full").sort((a, b) => a.y0 - b.y0);
  // Full fragments within a couple of lines of each other are one band.
  const blocks = [];
  full.forEach((fragment) => {
    const block = blocks[blocks.length - 1];
    if (block && fragment.y0 - block.y1 <= fragment.size * 2.5) {
      block.y1 = Math.max(block.y1, fragment.y1);
    } else {
      blocks.push({ y0: fragment.y0, y1: fragment.y1 });
    }
  });
  // Band index for each fragment: 2k is the columns above block k, 2k+1 the
  // block itself.
  const bandOf = (fragment) => {
    const centre = (fragment.y0 + fragment.y1) / 2;
    let above = 0;
    for (let k = 0; k < blocks.length; k += 1) {
      const block = blocks[k];
      const inside = fragment.side === "full"
        ? fragment.y0 >= block.y0 && fragment.y0 <= block.y1
        : centre >= block.y0 && centre <= block.y1;
      if (inside) return 2 * k + 1;
      if (block.y1 < centre) above = k + 1;
    }
    return 2 * above;
  };
  const bands = new Map();
  fragments.forEach((fragment) => {
    const band = bandOf(fragment);
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(fragment);
  });
  const segments = [];
  [...bands.keys()].sort((a, b) => a - b).forEach((band) => {
    const members = bands.get(band);
    if (band % 2 === 1) {
      segments.push(...segmentsOf(members, "full", width, height));
      return;
    }
    // A band with only one side in use (the last page of a paper whose right
    // column is empty) is still that column, so zooming to the column means
    // the same as on the page before.
    segments.push(...segmentsOf(members.filter((fragment) => fragment.side === "left"), "column", width, height));
    segments.push(...segmentsOf(members.filter((fragment) => fragment.side === "right"), "column", width, height));
  });
  return segments;
}

// ── A page with text ────────────────────────────────────────────────────────

// `columns`: "auto" finds the gutter if there is one, "one" never looks, and
// "two" takes the emptiest stripe in the middle even when it is not empty.
// Returns null when the page has too little text to go by (read its picture).
export function buildPathFromBoxes(boxes, width, height, { columns = "auto" } = {}) {
  if (!(width > 0 && height > 0)) return null;
  const all = fragmentsFromBoxes(boxes);
  const totalWords = all.reduce((sum, fragment) => sum + fragment.words, 0);
  if (totalWords < PATH_MIN_TEXT_WORDS) return null;
  const kept = dropRunningLines(all, height);
  if (!kept.length) return { segments: [], columns: 1, gutter: null, source: "text" };
  // The gutter is looked for among the ITEMS, not the joined lines: a gutter
  // narrower than the join distance would otherwise be joined over.
  const items = kept.flatMap((fragment) => fragment.items);
  const gutter = columns === "one" ? null : findTextGutter(items, width, columns === "two");
  if (!gutter) {
    kept.forEach((fragment) => { fragment.side = "full"; });
    return { segments: segmentsFromFragments(kept, width, height), columns: 1, gutter: null, source: "text" };
  }
  const middle = (gutter.x0 + gutter.x1) / 2;
  const fragments = fragmentsFromBoxes(items, { splitAt: middle });
  fragments.forEach((fragment) => {
    // Across the gutter only when it reaches well into both columns; anything
    // else (a line that pokes into the gutter, an equation number sitting in
    // it) belongs to the side its middle is on.
    const across = fragment.x0 < gutter.x0 - fragment.size && fragment.x1 > gutter.x1 + fragment.size;
    if (across) fragment.side = "full";
    else fragment.side = (fragment.x0 + fragment.x1) / 2 < middle ? "left" : "right";
  });
  return {
    segments: segmentsFromFragments(fragments, width, height),
    columns: 2,
    gutter: { x0: gutter.x0 / width, x1: gutter.x1 / width },
    source: "text"
  };
}

const TEXT_BINS = 240;

function findTextGutter(items, width, relaxed) {
  const coverage = new Array(TEXT_BINS).fill(0);
  let left = TEXT_BINS;
  let right = -1;
  items.forEach((item) => {
    const a = Math.max(0, Math.floor((item.x0 / width) * TEXT_BINS));
    const b = Math.min(TEXT_BINS - 1, Math.floor((item.x1 / width) * TEXT_BINS));
    for (let bin = a; bin <= b; bin += 1) coverage[bin] += 1;
    left = Math.min(left, a);
    right = Math.max(right, b);
  });
  const found = findGutterBins(coverage, left, right, { minBins: Math.max(1, Math.round(GUTTER_MIN_WIDTH * TEXT_BINS)), relaxed });
  if (!found) return null;
  const x0 = (found.x0 / TEXT_BINS) * width;
  const x1 = ((found.x1 + 1) / TEXT_BINS) * width;
  if (!relaxed) {
    // Real text either side, or it is a ragged right edge rather than a gutter.
    let leftWords = 0;
    let rightWords = 0;
    let total = 0;
    items.forEach((item) => {
      total += item.words;
      if (item.x1 <= x1) leftWords += item.words;
      else if (item.x0 >= x0) rightWords += item.words;
    });
    if (leftWords < total * GUTTER_SIDE_SHARE || rightWords < total * GUTTER_SIDE_SHARE) return null;
  }
  return { x0, x1 };
}

// ── A page without text ─────────────────────────────────────────────────────

// Ink is anything clearly darker than the paper. The paper is the commonest
// light value, read off a histogram, so a yellowed scan or a grey photocopy
// works as well as white.
function inkMask(gray, w, h) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) histogram[gray[i]] += 1;
  let paper = 255;
  let paperCount = -1;
  for (let value = 96; value < 256; value += 1) {
    if (histogram[value] > paperCount) {
      paper = value;
      paperCount = histogram[value];
    }
  }
  const threshold = paper - Math.max(48, paper * 0.25);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i += 1) mask[i] = gray[i] < threshold ? 1 : 0;
  return mask;
}

// Runs of rows with ink in them between columns `xa`..`xb` — lines of type.
// Each is a fragment, its words estimated from its width and height: a word is
// about six characters, a character about half an em, and the em about the
// height of a line's ink.
function inkLines(mask, w, xa, xb, ya, yb, side, wordScale) {
  const stripe = Math.max(1, xb - xa);
  const minInk = Math.max(1, Math.round(stripe * 0.006));
  const rows = [];
  for (let y = ya; y < yb; y += 1) {
    let ink = 0;
    let first = -1;
    let last = -1;
    const base = y * w;
    for (let x = xa; x < xb; x += 1) {
      if (mask[base + x]) {
        ink += 1;
        if (first < 0) first = x;
        last = x;
      }
    }
    rows.push(ink >= minInk ? { first, last } : null);
  }
  const lines = [];
  let current = null;
  let blank = 0;
  rows.forEach((row, index) => {
    const y = ya + index;
    if (row) {
      if (current && blank <= 1) {
        current.y1 = y + 1;
        current.x0 = Math.min(current.x0, row.first);
        current.x1 = Math.max(current.x1, row.last + 1);
      } else {
        current = { x0: row.first, x1: row.last + 1, y0: y, y1: y + 1 };
        lines.push(current);
      }
      blank = 0;
    } else {
      blank += 1;
    }
  });
  return lines
    .filter((line) => line.y1 - line.y0 >= 2 && line.x1 - line.x0 >= 4)
    .map((line) => {
      const size = line.y1 - line.y0;
      const words = ((line.x1 - line.x0) / (size * 0.5 * 6)) * wordScale;
      return { ...line, size, words: Math.max(1, words), side };
    });
}

// `gray`: one byte per pixel, w × h, the page drawn small (about 700px across
// is plenty). `wordScale` corrects the word estimate when the same PDF has text
// pages to calibrate against (1 = take the estimate as it is).
export function buildPathFromInk(gray, w, h, { columns = "auto", wordScale = 1 } = {}) {
  if (!gray || !(w > 8 && h > 8) || gray.length < w * h) return null;
  const mask = inkMask(gray, w, h);
  // A scanner's dark edges and the shadow of the binding are not text.
  const mx = Math.round(w * 0.03);
  const my = Math.round(h * 0.03);
  const coverage = new Array(w).fill(0);
  for (let y = my; y < h - my; y += 1) {
    const base = y * w;
    for (let x = mx; x < w - mx; x += 1) coverage[x] += mask[base + x];
  }
  let left = -1;
  let right = -1;
  const floor = Math.max(1, (h - 2 * my) * 0.003);
  for (let x = mx; x < w - mx; x += 1) {
    if (coverage[x] > floor) {
      if (left < 0) left = x;
      right = x;
    }
  }
  if (left < 0) return { segments: [], columns: 1, gutter: null, source: "ink" };
  // Smoothed over a few pixels, so the gaps between letters of a full-width
  // title do not read as a run of tiny gutters.
  const smooth = coverage.map((_, x) => {
    let sum = 0;
    let count = 0;
    for (let d = -2; d <= 2; d += 1) {
      if (x + d >= 0 && x + d < w) {
        sum += coverage[x + d];
        count += 1;
      }
    }
    return sum / count;
  });
  const gutterBins = columns === "one" ? null
    : findGutterBins(smooth, left, right, { minBins: Math.max(2, Math.round(GUTTER_MIN_WIDTH * w)), relaxed: columns === "two" });
  if (!gutterBins) {
    const fragments = inkLines(mask, w, left, right + 1, my, h - my, "full", wordScale);
    return { segments: segmentsFromFragments(fragments, w, h), columns: 1, gutter: null, source: "ink" };
  }
  // The stripe tested for ink crossing it: the gutter's middle, not its edges,
  // which a ragged right margin reaches into.
  const g0 = gutterBins.x0;
  const g1 = gutterBins.x1 + 1;
  const pad = Math.max(0, Math.floor((g1 - g0) * 0.2));
  const t0 = Math.min(g0 + pad, g1 - 1);
  const t1 = Math.max(t0 + 1, g1 - pad);
  // Rows where ink crosses the gutter, gathered into runs: those are the parts
  // of the page set across both columns.
  const crossing = [];
  for (let y = my; y < h - my; y += 1) {
    const base = y * w;
    let ink = 0;
    for (let x = t0; x < t1; x += 1) ink += mask[base + x];
    crossing.push(ink > 0);
  }
  // Word spaces of a full-width line can fall on the stripe for a row or two;
  // a gap of more than a few rows ends the run.
  const fullRuns = [];
  let open = null;
  let gap = 0;
  crossing.forEach((crosses, index) => {
    const y = my + index;
    if (crosses) {
      if (open) open.y1 = y + 1;
      else {
        open = { y0: y, y1: y + 1 };
        fullRuns.push(open);
      }
      gap = 0;
    } else if (open) {
      gap += 1;
      if (gap > 4) {
        open = null;
        gap = 0;
      }
    }
  });
  // Widened by a row or two, so the tops of a full-width line's letters that
  // did not reach the stripe are not left behind as slivers in a column.
  const runs = fullRuns
    .filter((run) => run.y1 - run.y0 >= 3)
    .map((run) => ({ y0: Math.max(my, run.y0 - 2), y1: Math.min(h - my, run.y1 + 2) }));
  const fragments = [];
  let cursor = my;
  const pushColumns = (ya, yb) => {
    if (yb - ya < 2) return;
    fragments.push(...inkLines(mask, w, left, g0, ya, yb, "left", wordScale));
    fragments.push(...inkLines(mask, w, g1, right + 1, ya, yb, "right", wordScale));
  };
  runs.forEach((run) => {
    pushColumns(cursor, run.y0);
    fragments.push(...inkLines(mask, w, left, right + 1, run.y0, run.y1, "full", wordScale));
    cursor = run.y1;
  });
  pushColumns(cursor, h - my);
  return {
    segments: segmentsFromFragments(fragments, w, h),
    columns: 2,
    gutter: { x0: g0 / w, x1: g1 / w },
    source: "ink"
  };
}

// Words in a path, for the time-left estimate.
export function pathWords(path) {
  return (path?.segments || []).reduce((sum, segment) => sum + segment.words, 0);
}
