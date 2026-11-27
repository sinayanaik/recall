// The Canvas as data (src/export/canvas-data.js), in pure Node: what the web
// page export carries for a program to read, next to the drawing.
//
//   node tools/canvas-data-check.mjs
//
// A small Canvas with everything a board has — two pages, one cut Boundless, a
// turned Block, a picture, an arrow tied Block to Block, an elbow connector
// with words on it, a group, a sticky note, a callout and a stroke of the pen —
// put through canvasData, and every fact a reader of the page relies on asked
// of it: the ids are the records', the ties survive, lengths are the page's
// own (points from its top-left, y down, as the page's svg), pictures are not
// copied in twice, and the JSON is safe to put inside a <script>.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-canvas-data-"));

function destamp(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) destamp(full);
    else if (entry.endsWith(".js")) {
      const text = readFileSync(full, "utf8");
      const clean = text.replaceAll("?v=__BUILD__", "");
      if (clean !== text) writeFileSync(full, clean);
    }
  }
}

const results = [];
let failures = 0;
function must(name, fn) {
  let detail;
  try {
    detail = fn();
  } catch (error) {
    detail = `threw: ${error?.message || error}`;
  }
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));
  const D = await import(path.join(stage, "src/export/canvas-data.js"));
  const { encodeInkStrokes } = await import(path.join(stage, "src/format/ink-strokes.js"));

  // Page 1 is A4 landscape (842 × 595 pt) drawn whole; page 2 is Boundless,
  // cut to [100, 200, 500, 600]. PDF space: y up.
  const pages = [
    { n: 1, setup: { fit: "grow", pattern: "dots", paper: "#160d03" }, box: [0, 0, 842, 595] },
    { n: 3, setup: { fit: "boundless", pattern: "blank" }, box: [100, 200, 500, 600] }
  ];
  const blocks = [
    { id: "bk-title", page: 1, kind: "text", x: 40, y: 500, w: 200, h: 40, z: 4, md: "**porcelain crab**", style: { ink: "red", size: 25, align: "center" }, group: "g1" },
    { id: "bk-gif", page: 1, kind: "image", x: 40, y: 300, w: 240, h: 180, z: 5, src: "recall-img:abc", alt: "crab", group: "g1" },
    { id: "bk-side", page: 1, kind: "text", x: 300, y: 300, w: 60, h: 200, rot: 90, z: 6, md: "fans collect plankton (1:16-1:20)" },
    { id: "bk-p2", page: 3, kind: "text", x: 150, y: 500, w: 100, h: 50, z: 1, md: "page two" },
    { id: "bk-gone", page: 2, kind: "text", x: 0, y: 0, w: 10, h: 10, md: "on a page not exported" }
  ];
  const ink = encodeInkStrokes([{ w: 2, c: "x112233", p: [400, 400, 0.5, 450, 420, 0.5, 500, 400, 0.5] }]);
  const marks = [
    { id: "sh-arrow", page: 1, kind: "shape", shape: { type: "arrow", p: [[280, 390], [300, 390]], heads: ["none", "filled"], ends: [{ id: "bk-gif", side: "e" }, { id: "bk-side", side: "w", at: [0, 0.5] }] } },
    { id: "sh-elbow", page: 1, kind: "shape", shape: { type: "line", p: [[140, 300], [600, 100]], route: "elbow", text: "eats", ends: [{ id: "bk-gif" }, null] } },
    { id: "sh-sticky", page: 1, kind: "shape", note: "check the 1:21 bit", shape: { type: "sticky", p: [[700, 580]] } },
    { id: "sh-callout", page: 1, kind: "shape", group: "g1", shape: { type: "callout", p: [[600, 300], [760, 360], [500, 250]], text: "200 million in a bay in Chile" } },
    { id: "sh-p2box", page: 3, kind: "shape", shape: { type: "rect", p: [[120, 480], [300, 580]], rot: 15 } },
    { id: "ink-1", page: 1, kind: "ink", ink: { s: ink } },
    { id: "hl-elsewhere", page: 2, kind: "shape", shape: { type: "rect", p: [[0, 0], [5, 5]] } }
  ];
  const data = D.canvasData({ title: "Animal profiles", pages, blocks, marks });

  must("it says what it is", () => (data.format === "recall.canvas" && data.version === 1 && data.title === "Animal profiles") || JSON.stringify(data).slice(0, 80));
  must("pages in export order, numbered within it, with their own size and paper", () => {
    if (data.pages.length !== 2) return `${data.pages.length} pages`;
    const [a, b] = data.pages;
    if (a.n !== 1 || a.index !== 1 || a.size.join() !== "842,595") return JSON.stringify(a);
    if (b.n !== 3 || b.index !== 2 || b.size.join() !== "400,400" || b.fit !== "boundless") return JSON.stringify(b);
    return (a.paper.pattern === "dots" && a.paper.color === "#160d03") || JSON.stringify(a.paper);
  });
  must("what is on a page not exported is left out", () => {
    const ids = [...data.blocks, ...data.shapes, ...data.connectors].map((r) => r.id);
    return (!ids.includes("bk-gone") && !ids.includes("hl-elsewhere")) || ids.join();
  });
  must("a Block is in points from the page's top-left, y down", () => {
    const title = data.blocks.find((b) => b.id === "bk-title");
    // y: 595 - (500 + 40) = 55
    if (!(near(title.x, 40) && near(title.y, 55) && title.w === 200 && title.h === 40)) return JSON.stringify(title);
    const p2 = data.blocks.find((b) => b.id === "bk-p2");
    // On the cut page: x 150 - 100 = 50; y 600 - (500 + 50) = 50.
    return (p2.page === 2 && near(p2.x, 50) && near(p2.y, 50)) || JSON.stringify(p2);
  });
  must("a Block keeps its markdown, its turn, its stack, its style and its group", () => {
    const title = data.blocks.find((b) => b.id === "bk-title");
    if (title.md !== "**porcelain crab**" || title.style.ink !== "red" || title.style.size !== 25 || title.group !== "g1") return JSON.stringify(title);
    const side = data.blocks.find((b) => b.id === "bk-side");
    return (side.rot === 90 && side.z === 6) || JSON.stringify(side);
  });
  must("a picture is pointed at on the page, not copied in again", () => {
    const gif = data.blocks.find((b) => b.id === "bk-gif");
    if (gif.kind !== "image" || gif.md || gif.alt !== "crab") return JSON.stringify(gif);
    if (JSON.stringify(data).includes("recall-img:")) return "the picture's address is in the data";
    // A selector for the Block's own <img> on the page.
    return (gif.picture.includes('"bk-gif"') && gif.picture.endsWith("] img")) || gif.picture;
  });
  must("an arrow keeps what it is tied to at each end, and which way it points", () => {
    const arrow = data.connectors.find((c) => c.id === "sh-arrow");
    if (!arrow) return "no arrow";
    if (arrow.from?.id !== "bk-gif" || arrow.from.side !== "e") return JSON.stringify(arrow.from);
    if (arrow.to?.id !== "bk-side" || arrow.to.side !== "w" || arrow.to.at?.join() !== "0,0.5") return JSON.stringify(arrow.to);
    if (arrow.heads.join() !== "none,filled" || arrow.type !== "arrow") return JSON.stringify(arrow);
    // Its path in the page's own points: y 595 - 390 = 205.
    return (arrow.points.length === 2 && near(arrow.points[0][0], 280) && near(arrow.points[0][1], 205) && near(arrow.points[1][0], 300)) || JSON.stringify(arrow.points);
  });
  must("a connector keeps its route, its words, and a free end as null", () => {
    const elbow = data.connectors.find((c) => c.id === "sh-elbow");
    if (!elbow || elbow.route !== "elbow" || elbow.label !== "eats") return JSON.stringify(elbow);
    if (elbow.from?.id !== "bk-gif" || elbow.to !== undefined) return `ends ${JSON.stringify([elbow.from, elbow.to])}`;
    if (elbow.points.length < 3) return `an elbow of ${elbow.points.length} points`;
    const first = elbow.points[0];
    const last = elbow.points[elbow.points.length - 1];
    return (near(first[0], 140) && near(first[1], 295) && near(last[0], 600) && near(last[1], 495)) || JSON.stringify(elbow.points);
  });
  must("a sticky note keeps its words, a callout its words and what it points at", () => {
    const sticky = data.shapes.find((s) => s.id === "sh-sticky");
    if (!sticky || sticky.type !== "sticky" || sticky.text !== "check the 1:21 bit") return JSON.stringify(sticky);
    const callout = data.shapes.find((s) => s.id === "sh-callout");
    if (!callout || callout.text !== "200 million in a bay in Chile") return JSON.stringify(callout);
    // Box [600,300]–[760,360]: top-left (600, 595 - 360 = 235); target (500, 345).
    if (!(near(callout.x, 600) && near(callout.y, 235) && callout.w === 160 && callout.h === 60)) return JSON.stringify(callout);
    return (callout.target && near(callout.target[0], 500) && near(callout.target[1], 345)) || JSON.stringify(callout.target);
  });
  must("a shape keeps its turn on its own page", () => {
    const box = data.shapes.find((s) => s.id === "sh-p2box");
    return (box && box.page === 2 && box.rot === 15 && near(box.x, 20) && near(box.y, 20)) || JSON.stringify(box);
  });
  must("a group lists everything in it, whatever it is", () => {
    const g = data.groups.find((group) => group.id === "g1");
    return (g && g.members.slice().sort().join() === "bk-gif,bk-title,sh-callout") || JSON.stringify(data.groups);
  });
  must("the pen is summed up: where, what colour, not a highlighter, a few points", () => {
    const stroke = data.ink.find((i) => i.id === "ink-1");
    if (!stroke) return "no ink";
    if (stroke.highlighter || stroke.colors.join() !== "x112233") return JSON.stringify(stroke);
    const [x0, y0, x1, y1] = stroke.bbox;
    // y: 595 - 420 = 175 at the top, 595 - 400 = 195 at the bottom.
    return (near(x0, 400) && near(y0, 175) && near(x1, 500) && near(y1, 195) && stroke.strokes[0].points.length <= 48) || JSON.stringify(stroke.bbox);
  });
  must("the script cannot be closed by what the Canvas says", () => {
    const nasty = D.canvasData({ title: "</script><script>alert(1)</script>", pages, blocks: [{ id: "x", page: 1, kind: "text", x: 0, y: 0, w: 1, h: 1, md: "<!-- \u2028 -->" }], marks: [] });
    const tag = D.canvasDataScript(nasty);
    const inner = tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("</script>"));
    if (/<\/?script|<!--/i.test(inner)) return "the text can close or comment the element";
    const back = JSON.parse(inner);
    return (back.title === nasty.title && back.blocks[0].md === "<!-- \u2028 -->" && tag.includes(`id="${D.CANVAS_DATA_ID}"`)) || "did not round-trip";
  });
  must("the whole of it round-trips as JSON", () => JSON.stringify(JSON.parse(JSON.stringify(data))) === JSON.stringify(data) || "it did not");
  must("an empty Canvas is an empty board, not an error", () => {
    const empty = D.canvasData({});
    return (empty.pages.length === 0 && empty.blocks.length === 0 && empty.groups.length === 0) || JSON.stringify(empty);
  });

  console.log("── the Canvas as data ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
