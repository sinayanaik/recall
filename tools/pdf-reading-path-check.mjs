// The order a PDF page is read in, for the PDF teleprompter.
//
//   node tools/pdf-reading-path-check.mjs
//
// src/documents/pdf-reading-path.js turns a page into the stretches the eye
// travels straight down through: one for a page set in one column; the left
// column and then the right for a two-column page; and the title and abstract
// across both, first, above them. It does that from a page's text boxes when it
// has a text layer and from a picture of the page when it is a scan. It is pure
// and imports nothing, so the pages here are made up: text boxes laid out the
// way a paper lays them out, and greyscale pictures with lines of "words" drawn
// in them as dark bars.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reading = await import(pathToFileURL(path.join(ROOT, "src/documents/pdf-reading-path.js")).href);

const results = [];
async function must(name, fn) {
  try {
    const answer = await fn();
    results.push([answer === true, name, answer === true ? "" : String(answer)]);
  } catch (error) {
    results.push([false, name, error?.stack || String(error)]);
  }
}

// "L R" for a left column then a right one; "F" for a stretch across the
// page. Two full stretches in a row (a title, a gap, an abstract) read the
// same as one, and are shown as one.
const show = (path) => (path?.segments || [])
  .map((segment) => (segment.kind === "full" ? "F" : segment.x0 < 0.45 ? "L" : "R"))
  .filter((letter, index, letters) => !(letter === "F" && letters[index - 1] === "F"))
  .join(" ");

// ── Pages with text ─────────────────────────────────────────────────────────

const W = 612;
const H = 792;
const SIZE = 10;
const PITCH = 12;

// One line of type as text boxes: a single box (how most PDFs come), or a box
// per word with a space-sized gap between (how some LaTeX output comes).
function line(x0, x1, y, { size = SIZE, perWord = false, words = 0 } = {}) {
  const count = words || Math.max(1, Math.round((x1 - x0) / (size * 2.6)));
  if (!perWord) return [{ x0, x1, y0: y - size * 0.8, y1: y + size * 0.2, words: count, size }];
  const boxes = [];
  const step = (x1 - x0) / count;
  for (let index = 0; index < count; index += 1) {
    const a = x0 + index * step;
    boxes.push({ x0: a, x1: a + step - size * 0.3, y0: y - size * 0.8, y1: y + size * 0.2, words: 1, size });
  }
  return boxes;
}

function lines(x0, x1, top, count, options) {
  const boxes = [];
  for (let index = 0; index < count; index += 1) boxes.push(...line(x0, x1, top + index * PITCH, options));
  return boxes;
}

const LEFT = [54, 300];
const RIGHT = [312, 558];
const twoColumns = (top, count, options) => [...lines(...LEFT, top, count, options), ...lines(...RIGHT, top, count, options)];

await must("a page in one column is read straight down, as one stretch", () => {
  const path = reading.buildPathFromBoxes(lines(72, 540, 90, 50), W, H);
  const segment = path?.segments?.[0];
  return (path.columns === 1 && show(path) === "F" && segment.lines === 50 && Math.abs(segment.linePitch - PITCH / H) < 1e-6)
    || `got ${show(path)}, ${JSON.stringify(segment)}`;
});

await must("a page in two columns is read down the left column, then down the right", () => {
  const path = reading.buildPathFromBoxes(twoColumns(80, 54), W, H);
  const [left, right] = path.segments;
  return (path.columns === 2 && show(path) === "L R" && left.x1 < right.x0 && left.kind === "column"
    && Math.abs(left.y0 - right.y0) < 0.01)
    || `got ${show(path)}, gutter ${JSON.stringify(path.gutter)}`;
});

await must("...also when every word is a text box of its own", () => {
  const path = reading.buildPathFromBoxes(twoColumns(80, 54, { perWord: true }), W, H);
  return (show(path) === "L R" && path.segments[0].lines === 54) || `got ${show(path)}, ${path.segments[0]?.lines} lines`;
});

await must("a first page: the title and abstract across both columns come first", () => {
  const boxes = [
    ...line(120, 492, 80, { size: 18, words: 9 }),
    ...lines(72, 540, 120, 8),
    ...twoColumns(240, 42)
  ];
  const path = reading.buildPathFromBoxes(boxes, W, H);
  return (show(path) === "F L R" && path.segments[0].y1 < path.segments[1].y0)
    || `got ${show(path)}`;
});

await must("a figure caption across both columns cuts the page: columns above, caption, columns below", () => {
  const boxes = [...twoColumns(80, 20), ...line(72, 540, 340), ...line(72, 400, 352), ...twoColumns(420, 25)];
  const path = reading.buildPathFromBoxes(boxes, W, H);
  return show(path) === "L R F L R" || `got ${show(path)}`;
});

await must("a running head and a page number are not read", () => {
  const boxes = [...line(54, 220, 40, { words: 5 }), ...twoColumns(80, 54), ...line(300, 312, 760, { words: 1 })];
  const path = reading.buildPathFromBoxes(boxes, W, H);
  const top = Math.min(...path.segments.map((segment) => segment.y0));
  const bottom = Math.max(...path.segments.map((segment) => segment.y1));
  return (show(path) === "L R" && top > 0.07 && bottom < 0.93) || `got ${show(path)}, ${top}..${bottom}`;
});

await must("a figure in the middle of a column splits it, so it can be glided over", () => {
  const boxes = [...lines(...LEFT, 80, 15), ...lines(...LEFT, 80 + 15 * PITCH + 200, 15), ...lines(...RIGHT, 80, 47)];
  const path = reading.buildPathFromBoxes(boxes, W, H);
  return show(path) === "L L R" || `got ${show(path)}`;
});

await must("a line that pokes into the gutter stays in its column", () => {
  const boxes = [...twoColumns(80, 54), ...line(54, 306, 80 + 54 * PITCH)];
  const path = reading.buildPathFromBoxes(boxes, W, H);
  return show(path) === "L R" || `got ${show(path)}`;
});

await must("the last page with only the left column used is still a column", () => {
  const path = reading.buildPathFromBoxes([...twoColumns(80, 30), ...lines(...LEFT, 80 + 30 * PITCH, 20)], W, H);
  return show(path) === "L R" || `got ${show(path)}`;
});

await must("“One column” reads a two-column page straight down", () => {
  const path = reading.buildPathFromBoxes(twoColumns(80, 54), W, H, { columns: "one" });
  return (path.columns === 1 && path.segments.every((segment) => segment.kind === "full")) || `got ${show(path)}`;
});

await must("“Two columns” finds a gutter too narrow to be sure of", () => {
  // A 6pt gutter (1% of the page) — narrower than auto will call a gutter.
  const boxes = [...lines(54, 303, 80, 54), ...lines(309, 558, 80, 54)];
  const auto = reading.buildPathFromBoxes(boxes, W, H);
  const two = reading.buildPathFromBoxes(boxes, W, H, { columns: "two" });
  return (show(auto) !== "L R" && show(two) === "L R") || `auto ${show(auto)}, two ${show(two)}`;
});

await must("a page with almost no text says so, so its picture is read instead", () => {
  return reading.buildPathFromBoxes(line(300, 312, 760, { words: 1 }), W, H) === null || "got a path";
});

await must("words add up to the page's words", () => {
  const boxes = twoColumns(80, 54, { words: 9 });
  const path = reading.buildPathFromBoxes(boxes, W, H);
  return reading.pathWords(path) === 54 * 2 * 9 || `got ${reading.pathWords(path)}`;
});

// ── Pages without text ──────────────────────────────────────────────────────

const PW = 700;
const PH = 906;

function picture() {
  const gray = new Uint8Array(PW * PH).fill(238);
  return gray;
}

// A line of "words": dark bars with gaps between, the way a scanned line of
// type looks at this size.
function inkLine(gray, x0, x1, y, height = 6) {
  let x = x0;
  let seed = (y * 7919 + x0) % 97;
  let words = 0;
  while (x < x1) {
    seed = (seed * 31 + 17) % 97;
    const width = Math.min(x1 - x, 14 + (seed % 22));
    for (let row = y; row < y + height; row += 1) {
      for (let col = x; col < x + width; col += 1) gray[row * PW + col] = 30;
    }
    words += 1;
    x += width + 5;
  }
  return words;
}

function inkLines(gray, x0, x1, top, count, pitch = 11) {
  let words = 0;
  for (let index = 0; index < count; index += 1) words += inkLine(gray, x0, x1, top + index * pitch);
  return words;
}

const PL = [62, 343];
const PR = [357, 638];

await must("a scan in one column is read straight down", () => {
  const gray = picture();
  inkLines(gray, 80, 620, 90, 64);
  const path = reading.buildPathFromInk(gray, PW, PH);
  return (path.source === "ink" && show(path) === "F" && path.segments[0].lines === 64) || `got ${show(path)}, ${path.segments[0]?.lines} lines`;
});

await must("a scan in two columns is read down the left, then the right", () => {
  const gray = picture();
  inkLines(gray, ...PL, 90, 64);
  inkLines(gray, ...PR, 90, 64);
  const path = reading.buildPathFromInk(gray, PW, PH);
  return (path.columns === 2 && show(path) === "L R" && path.segments[0].lines === 64 && path.segments[1].lines === 64)
    || `got ${show(path)}, gutter ${JSON.stringify(path.gutter)}, lines ${path.segments.map((s) => s.lines)}`;
});

await must("a scanned first page: the title across both columns first", () => {
  const gray = picture();
  inkLine(gray, 160, 540, 70, 14);
  inkLines(gray, 80, 620, 110, 6);
  inkLines(gray, ...PL, 200, 56);
  inkLines(gray, ...PR, 200, 56);
  const path = reading.buildPathFromInk(gray, PW, PH);
  return show(path) === "F L R" || `got ${show(path)}`;
});

await must("a scanner's dark edges and the binding's shadow are not read as columns", () => {
  const gray = picture();
  for (let y = 0; y < PH; y += 1) {
    for (let x = 0; x < 14; x += 1) gray[y * PW + x] = 20;
    for (let x = PW - 10; x < PW; x += 1) gray[y * PW + x] = 25;
  }
  inkLines(gray, ...PL, 90, 64);
  inkLines(gray, ...PR, 90, 64);
  const path = reading.buildPathFromInk(gray, PW, PH);
  return show(path) === "L R" || `got ${show(path)}`;
});

await must("a blank scanned page has nothing to read", () => {
  const path = reading.buildPathFromInk(picture(), PW, PH);
  return (path && path.segments.length === 0) || `got ${show(path)}`;
});

await must("a scan's word estimate is in the right neighbourhood", () => {
  const gray = picture();
  const words = inkLines(gray, ...PL, 90, 64) + inkLines(gray, ...PR, 90, 64);
  const estimate = reading.pathWords(reading.buildPathFromInk(gray, PW, PH));
  return (estimate > words * 0.5 && estimate < words * 2) || `drew ${words}, estimated ${estimate}`;
});

await must("“One column” reads a two-column scan straight down", () => {
  const gray = picture();
  inkLines(gray, ...PL, 90, 64);
  inkLines(gray, ...PR, 90, 64);
  const path = reading.buildPathFromInk(gray, PW, PH, { columns: "one" });
  return show(path) === "F" || `got ${show(path)}`;
});

console.log("── pdf reading path ──");
for (const [ok, name, detail] of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
}
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n  ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
