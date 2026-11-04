// The geometry of annotations, in pure Node: src/render/annot-shapes.js (the
// Shapes tool's shapes) and src/format/mark-styles.js (how a text mark is drawn).
//
//   node tools/annot-shapes-check.mjs
//
// Both are leaves on purpose — they import nothing — so every rule in them can
// be asserted here without a browser: what a shape normalises to, where its
// arrowheads go, what a tap hits and what it does not, what a drag makes with
// and without the snap, how a handle moves a shape, how words wrap in a box,
// and that a shape record rides the same merge-by-id every other mark does.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-annot-"));

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
  const S = await import(path.join(stage, "src/render/annot-shapes.js"));
  const M = await import(path.join(stage, "src/format/mark-styles.js"));
  const { mergeRecordsById } = await import(path.join(stage, "src/sync/diff.js"));

  // ── Normalising ───────────────────────────────────────────────────────
  must("a shape of an unknown type, or with too few points, is refused", () => {
    if (S.normalizeShape({ type: "star", p: [[0, 0], [1, 1]] }) !== null) return "a star was accepted";
    if (S.normalizeShape({ type: "line", p: [[0, 0]] }) !== null) return "a one-point line was accepted";
    if (S.normalizeShape({ type: "callout", p: [[0, 0], [1, 1]] }) !== null) return "a callout with no target was accepted";
    if (S.normalizeShape({ type: "rect", p: [[0, 0], ["x", 1]] }) !== null) return "a non-numeric point was accepted";
    return true;
  });
  must("every field is clamped to what the controls can set", () => {
    const s = S.normalizeShape({ type: "arrow", p: [[0, 0], [10, 10]], width: 999, opacity: 0, dash: "wiggly", heads: ["spike", "dot"], stroke: "red", fill: "#ABC" });
    if (s.width !== S.SHAPE_WIDTH_RANGE.max) return `width ${s.width}`;
    if (s.opacity !== 0.1) return `opacity ${s.opacity}`;
    if (s.dash !== "solid") return `dash ${s.dash}`;
    if (s.heads.join() !== "none,dot") return `heads ${s.heads}`;
    if (s.stroke !== S.SHAPE_DEFAULTS.stroke) return `stroke ${s.stroke}`;
    if (s.fill !== "#aabbcc") return `fill ${s.fill}`;
    return true;
  });
  must("a callout keeps at most four points; a sticky one", () => {
    const c = S.normalizeShape({ type: "callout", p: [[0, 0], [10, 10], [20, 20], [5, 5], [9, 9]] });
    const k = S.normalizeShape({ type: "sticky", p: [[3, 4], [5, 6]] });
    return c.p.length === 4 && k.p.length === 1 ? true : `${c.p.length} / ${k.p.length}`;
  });

  // ── Primitives and arrowheads ──────────────────────────────────────────
  must("an arrow is a shaft and a filled head at its end", () => {
    const prims = S.shapePrimitives({ type: "arrow", p: [[0, 0], [100, 0]], width: 2, heads: ["none", "filled"] });
    if (prims.length !== 2) return `${prims.length} primitives`;
    const [shaft, head] = prims;
    if (shaft.closed || head.closed !== true || head.fill !== S.SHAPE_DEFAULTS.stroke) return JSON.stringify(head);
    // The tip of the head is the end of the line; the shaft stops short of it.
    if (!head.pts.some(([x, y]) => near(x, 100) && near(y, 0))) return "the head's tip is not the arrow's end";
    if (shaft.pts[1][0] >= 100) return `the shaft runs to ${shaft.pts[1][0]}, through the tip`;
    return true;
  });
  must("each head style draws what it says", () => {
    const line = { stroke: "#000000", width: 2, opacity: 1 };
    const open = S.arrowHeadPrimitives([10, 0], [0, 0], "open", line)[0];
    const dot = S.arrowHeadPrimitives([10, 0], [0, 0], "dot", line)[0];
    const bar = S.arrowHeadPrimitives([10, 0], [0, 0], "bar", line)[0];
    if (open.closed || open.fill) return "an open head is filled";
    if (!dot.closed || !dot.fill || dot.pts.length < 8) return "a dot is not a filled circle";
    if (bar.pts.length !== 2 || !near(bar.pts[0][0], 10) || !near(bar.pts[1][0], 10)) return "a bar is not across the tip";
    if (S.arrowHeadPrimitives([10, 0], [0, 0], "none", line).length) return "'none' drew something";
    return true;
  });
  must("a head grows with the line, and never shrinks below a readable size", () => {
    return S.arrowHeadLength(1) === 7.5 && S.arrowHeadLength(4) > 16 ? true : `${S.arrowHeadLength(1)} / ${S.arrowHeadLength(4)}`;
  });
  must("a callout's leader leaves its box at the edge nearest its target", () => {
    const start = S.calloutLeaderStart([100, 100, 200, 150], [50, 125]);
    const inside = S.calloutLeaderStart([100, 100, 200, 150], [195, 125]);
    return start[0] === 100 && start[1] === 125 && inside[0] === 200 ? true : `${start} / ${inside}`;
  });
  must("a callout draws its leader, its head, its box and its words", () => {
    const prims = S.shapePrimitives({ type: "callout", p: [[100, 100], [200, 150], [20, 20]], text: "why", heads: ["none", "filled"] });
    const kinds = prims.map((p) => p.kind).join();
    return kinds === "poly,poly,poly,text" ? true : kinds;
  });
  must("free text has no border, and a sticky note is an icon", () => {
    const text = S.shapePrimitives({ type: "text", p: [[0, 0], [50, 20]], text: "hi" });
    const sticky = S.shapePrimitives({ type: "sticky", p: [[0, 20]] });
    if (text.length !== 1 || text[0].kind !== "text") return `text: ${text.map((p) => p.kind)}`;
    if (sticky.length !== 1 || sticky[0].kind !== "sticky") return `sticky: ${sticky.map((p) => p.kind)}`;
    return S.stickyIconPolys(sticky[0].rect, "#e0b400").length >= 3 ? true : "the icon has no lines";
  });

  // ── Hit-testing ───────────────────────────────────────────────────────
  must("a tap on a line's stroke hits it; one beside it does not", () => {
    const line = { type: "line", p: [[0, 0], [100, 0]], width: 2 };
    if (!S.shapeHitsPoint(line, 50, 3, 3)) return "a tap 3pt from the line missed";
    if (S.shapeHitsPoint(line, 50, 10, 3)) return "a tap 10pt away hit";
    if (S.shapeHitsPoint(line, 120, 0, 3)) return "a tap past the end hit";
    return true;
  });
  must("an unfilled box is hit on its edge, not across the words inside it", () => {
    const box = { type: "rect", p: [[0, 0], [100, 50]], width: 1 };
    if (!S.shapeHitsPoint(box, 0.5, 25, 3)) return "the edge missed";
    if (S.shapeHitsPoint(box, 50, 25, 3)) return "the middle of an unfilled box hit";
    if (!S.shapeHitsPoint({ ...box, fill: "#ff0000" }, 50, 25, 3)) return "the middle of a filled box missed";
    return true;
  });
  must("an ellipse is hit on its outline", () => {
    const e = { type: "ellipse", p: [[0, 0], [100, 50]], width: 1 };
    return S.shapeHitsPoint(e, 100, 25, 2) && !S.shapeHitsPoint(e, 50, 25, 2) ? true : "the ellipse's hit area is wrong";
  });
  must("a text box, a callout's box and a sticky note are hit anywhere inside", () => {
    const text = S.shapeHitsPoint({ type: "text", p: [[0, 0], [100, 50]] }, 50, 25, 1);
    const callout = S.shapeHitsPoint({ type: "callout", p: [[0, 0], [100, 50], [200, 200]] }, 50, 25, 1);
    const sticky = S.shapeHitsPoint({ type: "sticky", p: [[0, 20]] }, 10, 10, 1);
    return text && callout && sticky ? true : `${text} ${callout} ${sticky}`;
  });
  must("a callout's leader is hit along its length", () => {
    return S.shapeHitsPoint({ type: "callout", p: [[100, 100], [200, 150], [0, 0]] }, 50, 50, 2) ? true : "the leader missed";
  });
  must("an eraser path crossing a shape touches it; one passing by does not", () => {
    const line = { type: "line", p: [[0, 0], [100, 0]], width: 1 };
    if (!S.shapeCrossesSegment(line, [50, -20], [50, 20])) return "a crossing missed";
    if (S.shapeCrossesSegment(line, [0, 20], [100, 20])) return "a parallel pass hit";
    return true;
  });

  // ── Drags, the snap and handles ─────────────────────────────────────────
  must("a drag too short to mean anything makes nothing — except a text box or a sticky note", () => {
    if (S.shapeFromDrag("arrow", [0, 0], [1, 1]) !== null) return "a 1pt arrow was made";
    const text = S.shapeFromDrag("text", [0, 100], [0, 100]);
    const sticky = S.shapeFromDrag("sticky", [50, 50], [50, 50]);
    if (!text || Math.abs(text.p[1][0] - text.p[0][0]) !== S.TEXT_BOX_DEFAULT.width) return "a tapped text box is not the default width";
    if (!sticky || !near(sticky.p[0][0], 50 - S.STICKY_SIZE / 2)) return "a sticky is not centred on the tap";
    return true;
  });
  must("the snap puts a line on a 15° step, and makes a box square", () => {
    const line = S.shapeFromDrag("line", [0, 0], [100, 9], { snap: true });
    const rect = S.shapeFromDrag("rect", [0, 0], [100, -40], { snap: true });
    if (!near(line.p[1][1], 0, 0.02)) return `the line ends at y=${line.p[1][1]}`;
    const w = Math.abs(rect.p[1][0] - rect.p[0][0]);
    const h = Math.abs(rect.p[1][1] - rect.p[0][1]);
    if (!near(w, h)) return `${w} × ${h}`;
    if (rect.p[1][1] > 0) return "the square flipped the drag's direction";
    return true;
  });
  must("a drag carries the type's defaults under the reader's settings", () => {
    const arrow = S.shapeFromDrag("arrow", [0, 0], [50, 0]);
    const line = S.shapeFromDrag("line", [0, 0], [50, 0], { base: { stroke: "#2563eb" } });
    return arrow.heads[1] === "filled" && line.heads.join() === "none,none" && line.stroke === "#2563eb" ? true : `${arrow.heads} ${line.heads} ${line.stroke}`;
  });
  must("a callout is dragged from its target to where its words go", () => {
    const c = S.shapeFromDrag("callout", [10, 10], [100, 100]);
    const box = S.shapeTextRect(c);
    if (!near(c.p[2][0], 10) || !near(c.p[2][1], 10)) return `target ${c.p[2]}`;
    return box[0] >= 99 && box[1] >= 99 ? true : `the box ${box} is not past the drag's end`;
  });
  must("a line has its two ends as handles; a box has eight; a callout ten; a sticky none", () => {
    const counts = [
      S.shapeHandles({ type: "line", p: [[0, 0], [1, 1]] }).length,
      S.shapeHandles({ type: "rect", p: [[0, 0], [1, 1]] }).length,
      S.shapeHandles({ type: "callout", p: [[0, 0], [1, 1], [5, 5]] }).length,
      S.shapeHandles({ type: "sticky", p: [[0, 0]] }).length
    ];
    return counts.join() === "2,8,10,0" ? true : counts.join();
  });
  must("a corner handle moves that corner and keeps the opposite one", () => {
    const moved = S.moveShapeHandle({ type: "rect", p: [[0, 0], [100, 50]] }, "ne", 150, 80);
    const rect = S.rectFromPoints(moved.p[0], moved.p[1]);
    return rect.join() === "0,0,150,80" ? true : rect.join();
  });
  must("a callout's knee handle adds a knee to the leader", () => {
    const moved = S.moveShapeHandle({ type: "callout", p: [[100, 100], [200, 150], [0, 0]] }, "knee", 30, 90);
    const prims = S.shapePrimitives(moved);
    return moved.p.length === 4 && prims[0].pts.length === 3 ? true : `${moved.p.length} points, leader of ${prims[0].pts.length}`;
  });
  must("moving a shape moves every one of its points", () => {
    const t = S.translateShape({ type: "callout", p: [[0, 0], [10, 10], [20, 20]] }, 5, -5);
    return JSON.stringify(t.p) === JSON.stringify([[5, -5], [15, 5], [25, 15]]) ? true : JSON.stringify(t.p);
  });
  must("a shape's bounds cover its line and its heads", () => {
    const b = S.shapeBounds({ type: "arrow", p: [[0, 0], [100, 0]], width: 2, heads: ["none", "filled"] });
    return b[0] < 0 && b[2] > 100 && b[1] < -2 && b[3] > 2 ? true : b.join();
  });

  // ── Words in a box ──────────────────────────────────────────────────────
  must("words wrap to the box, a typed break always breaks, and a long word is split", () => {
    const measure = (t) => t.length * 10;
    const lines = S.wrapShapeText("one two three\nfour abcdefghijklmnop", 80, measure);
    if (lines[0] !== "one two" || lines[1] !== "three" || lines[2] !== "four") return JSON.stringify(lines);
    if (lines.slice(3).some((l) => measure(l) > 80)) return `a line overflows: ${JSON.stringify(lines)}`;
    return lines.slice(3).join("") === "abcdefghijklmnop" ? true : JSON.stringify(lines);
  });
  must("a shape is named by its words, or by what it is", () => {
    return S.shapeLabel({ type: "callout", p: [[0, 0], [1, 1], [2, 2]], text: "  why?  " }) === "why?"
      && S.shapeLabel({ type: "ellipse", p: [[0, 0], [1, 1]] }) === "Ellipse" ? true : "labels wrong";
  });

  // ── Text marks ──────────────────────────────────────────────────────────
  must("a mark's style is one of five, and anything else is a highlight", () => {
    return M.normalizeMarkStyle("squiggly") === "squiggly" && M.normalizeMarkStyle("blink") === "highlight"
      && M.markStyleOf({}) === "highlight" ? true : "styles wrong";
  });
  must("an underline is a thin bar near the foot of the line; a strike through its middle", () => {
    const u = M.markGeometry("underline", 0, 0, 100, 20, 1).bars[0];
    const s = M.markGeometry("strike", 0, 0, 100, 20, 1).bars[0];
    if (u[3] > 3 || u[1] < 15) return `underline ${u}`;
    if (Math.abs(s[1] + s[3] / 2 - 10) > 1.5) return `strike ${s}`;
    return true;
  });
  must("a squiggle runs the width of the box and waves about its line", () => {
    const w = M.markGeometry("squiggly", 10, 0, 100, 20, 1).wave;
    const ys = w.map(([, y]) => y);
    if (!near(w[0][0], 10) || !near(w[w.length - 1][0], 110)) return "it does not span the box";
    return Math.max(...ys) - Math.min(...ys) > 2 ? true : "it is flat";
  });
  must("a box is an outline inside the line's box, and a tint fills it", () => {
    const b = M.markGeometry("box", 0, 0, 100, 20, 1);
    const h = M.markGeometry("highlight", 0, 0, 100, 20, 1);
    return b.outline && b.outline[0] > 0 && h.fill?.join() === "0,0,100,20" ? true : JSON.stringify({ b, h });
  });
  must("a mark's own colour is #rrggbb or nothing", () => {
    return M.normalizeMarkHex("#ABC") === "#aabbcc" && M.normalizeMarkHex("red") === null ? true : "hex wrong";
  });

  // ── Sync ────────────────────────────────────────────────────────────────
  must("a shape record merges by id like any mark: newest wins, tombstones hold", () => {
    const base = { id: "hn-s1", kind: "shape", page: 1, quads: [], shape: { type: "line", p: [[0, 0], [1, 1]] } };
    const older = { ...base, at: 100, shape: { ...base.shape, stroke: "#000000" } };
    const newer = { ...base, at: 200, shape: { ...base.shape, stroke: "#dc2626" } };
    const merged = mergeRecordsById([older], [newer]);
    if (merged.length !== 1 || merged[0].shape.stroke !== "#dc2626") return JSON.stringify(merged);
    const buried = mergeRecordsById([newer], [], { tombstones: { "hn-s1": 300 } });
    return buried.length === 0 ? true : "a deleted shape came back";
  });

  console.log("── annotation geometry ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
