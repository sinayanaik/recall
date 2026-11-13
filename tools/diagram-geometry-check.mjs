// The geometry of a diagram on a page, in pure Node: a block's outline
// (src/render/node-outlines.js) and the snapping a drag lines up by
// (src/render/snap-guides.js).
//
//   node tools/diagram-geometry-check.mjs
//
// Both are leaves on purpose — they import nothing — so every rule in them is
// asserted here without a browser: what each outline is, where a connector
// stops on it, which side of a box faces a point, how much room a diamond
// leaves its words; and, for the guides, what a drag snaps to, by how much, and
// when it does not snap at all.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-diagram-"));

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
const nearPoint = (p, q, eps = 0.01) => Boolean(p && q) && near(p[0], q[0], eps) && near(p[1], q[1], eps);

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));
  const O = await import(path.join(stage, "src/render/node-outlines.js"));
  const G = await import(path.join(stage, "src/render/snap-guides.js"));

  // ── Outlines ──────────────────────────────────────────────────────────
  must("there are nine outlines, a plain box first, and anything else is a plain box", () => {
    if (O.NODE_OUTLINES.length !== 9 || O.NODE_OUTLINES[0] !== "rect") return `got ${O.NODE_OUTLINES.join(",")}`;
    if (O.normalizeNodeOutline("star") !== "rect" || O.normalizeNodeOutline(undefined) !== "rect") return "an unknown outline was kept";
    if (O.normalizeNodeOutline("diamond") !== "diamond") return "a diamond was not kept";
    return O.NODE_OUTLINES.every((kind) => O.NODE_OUTLINE_LABELS[kind]) || "an outline has no label";
  });

  must("every outline stays inside its box", () => {
    for (const kind of O.NODE_OUTLINES) {
      const pts = O.outlineLocalPoints(kind, 120, 80);
      if (pts.length < 3) return `${kind} has ${pts.length} points`;
      const out = pts.find(([x, y]) => x < -0.01 || x > 120.01 || y < -0.01 || y > 80.01);
      if (out) return `${kind} has a point at ${out.map((n) => n.toFixed(2)).join(",")}`;
    }
    return true;
  });

  must("every outline reaches all four sides of its box", () => {
    for (const kind of O.NODE_OUTLINES) {
      const pts = O.outlineLocalPoints(kind, 120, 80);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      if (!near(Math.min(...xs), 0, 0.5) || !near(Math.max(...xs), 120, 0.5)) return `${kind} spans x ${Math.min(...xs)}..${Math.max(...xs)}`;
      if (!near(Math.min(...ys), 0, 0.5) || !near(Math.max(...ys), 80, 0.5)) return `${kind} spans y ${Math.min(...ys)}..${Math.max(...ys)}`;
    }
    return true;
  });

  must("a diamond is its four mid-edge points", () => {
    const pts = O.outlineLocalPoints("diamond", 100, 60);
    const want = [[50, 0], [100, 30], [50, 60], [0, 30]];
    return pts.length === 4 && pts.every((p, i) => nearPoint(p, want[i])) || JSON.stringify(pts);
  });

  must("a pill's ends are half circles, and a box with no size is still a box", () => {
    const pts = O.outlineLocalPoints("pill", 100, 40);
    const left = Math.min(...pts.map((p) => p[0]));
    const middleLeft = pts.find((p) => near(p[1], 20, 0.5) && p[0] < 50);
    if (!near(left, 0, 0.05) || !middleLeft) return `left reach ${left}`;
    const flat = O.outlineLocalPoints("rounded", 0, 0);
    return flat.length >= 3 || `${flat.length} points`;
  });

  must("an SVG path is closed, inset by half the stroke, and a cylinder draws its near rim", () => {
    const plain = O.outlineSvgPaths("rect", 100, 50, 0);
    if (!/^M0\.00 0\.00L100\.00 0\.00L100\.00 50\.00L0\.00 50\.00Z$/.test(plain.edge)) return plain.edge;
    if (plain.marks) return "a box has marks";
    const inset = O.outlineSvgPaths("rect", 100, 50, 2);
    if (!inset.edge.startsWith("M2.00 2.00L98.00 2.00")) return inset.edge;
    const cylinder = O.outlineSvgPaths("cylinder", 100, 80, 0);
    return (cylinder.marks.startsWith("M0.00") && !cylinder.marks.endsWith("Z")) || cylinder.marks;
  });

  must("the words keep clear of a diamond's corners and a cylinder's lid, and nothing of a box", () => {
    const d = O.outlineInsets("diamond", 120, 80);
    if (!near(d.left, 30) || !near(d.top, 20)) return JSON.stringify(d);
    const c = O.outlineInsets("cylinder", 100, 100);
    if (!(c.top > c.bottom && c.bottom > 0 && c.left === 0)) return JSON.stringify(c);
    const r = O.outlineInsets("rect", 100, 100);
    return Object.values(r).every((n) => n === 0) || JSON.stringify(r);
  });

  // ── In PDF space ──────────────────────────────────────────────────────
  must("an outline placed on a page is turned the right way up (y runs UP)", () => {
    const pts = O.outlinePolygon("diamond", [100, 200, 200, 260]);
    // Local (50, 0) — the TOP corner — is the highest point on the page.
    return nearPoint(pts[0], [150, 260]) && nearPoint(pts[2], [150, 200]) || JSON.stringify(pts);
  });

  must("a line toward a point leaves a box through the right edge", () => {
    const box = O.outlinePolygon("rect", [0, 0, 100, 50]);
    const right = O.polygonPerimeterPoint(box, [500, 25]);
    if (!nearPoint(right, [100, 25])) return `right: ${right}`;
    const corner = O.polygonPerimeterPoint(box, [200, 100]);
    return nearPoint(corner, [100, 50]) || `corner: ${corner}`;
  });

  must("...and leaves a diamond and an ellipse ON their outline, not on their box", () => {
    const diamond = O.outlinePolygon("diamond", [0, 0, 100, 100]);
    const d = O.polygonPerimeterPoint(diamond, [200, 200]);
    if (!nearPoint(d, [75, 75], 0.01)) return `diamond: ${d}`;
    const ellipse = O.outlinePolygon("ellipse", [0, 0, 100, 100]);
    const e = O.polygonPerimeterPoint(ellipse, [200, 200]);
    const r = Math.hypot(e[0] - 50, e[1] - 50);
    return near(r, 50, 0.5) || `ellipse: ${e} at ${r.toFixed(2)} from the middle`;
  });

  must("a side is the outline straight out from the middle that way", () => {
    const diamond = O.outlinePolygon("diamond", [0, 0, 100, 60]);
    const n = O.polygonSidePoint(diamond, "n");
    const e = O.polygonSidePoint(diamond, "e");
    if (!nearPoint(n, [50, 60]) || !nearPoint(e, [100, 30])) return `n ${n} · e ${e}`;
    const box = O.outlinePolygon("rect", [10, 10, 30, 50]);
    return nearPoint(O.polygonSidePoint(box, "w"), [10, 30]) && O.polygonSidePoint(box, "x") === null || "a box's west side";
  });

  must("the side of a box facing a point is weighed by the box's shape", () => {
    const wide = [0, 0, 200, 40];
    if (O.sideFacing(wide, [100, 200]) !== "n") return "a point straight above";
    if (O.sideFacing(wide, [260, 20]) !== "e") return "a point off the end";
    // Further off to the side than above, but a wide box still faces it upward.
    if (O.sideFacing(wide, [170, 120]) !== "n") return "a point above a wide box's end";
    return O.sideFacing(wide, [100, -50]) === "s" || "a point below";
  });

  must("a point inside, outside and near an outline", () => {
    const diamond = O.outlinePolygon("diamond", [0, 0, 100, 100]);
    if (!O.pointInOutline(diamond, 50, 50)) return "the middle";
    if (O.pointInOutline(diamond, 5, 5)) return "a corner of the box, outside the diamond";
    return near(O.distanceToOutline(diamond, 50, 50), Math.hypot(25, 25), 0.01) || `distance ${O.distanceToOutline(diamond, 50, 50)}`;
  });

  must("opposite sides, and the four vectors point the way they say on a page", () => {
    if (O.oppositeSide("n") !== "s" || O.oppositeSide("w") !== "e" || O.oppositeSide("x") !== null) return "opposites";
    return (O.SIDE_VECTORS.n[1] === 1 && O.SIDE_VECTORS.s[1] === -1 && O.SIDE_VECTORS.e[0] === 1) || "vectors";
  });

  // ── Snapping ──────────────────────────────────────────────────────────
  must("a box dragged near another's left edge settles onto it, and a guide says so", () => {
    const r = G.snapMove([103, 0, 143, 20], [[100, 100, 160, 140]], { threshold: 4 });
    if (!near(r.dx, -3) || r.dy !== 0) return JSON.stringify(r);
    const guide = r.guides.find((g) => g.axis === "x");
    return (guide && near(guide.at, 100) && near(guide.from, 0) && near(guide.to, 140)) || JSON.stringify(r.guides);
  });
  must("...onto a middle as readily as an edge, and the nearest of several wins", () => {
    // Mine: 52, 56, 60. Theirs: 40, 55, 70 — middle to middle is 1 away, and
    // the second box's edge at 62 is 2 away from my top: the middle wins.
    const r = G.snapMove([0, 52, 20, 60], [[100, 40, 120, 70], [200, 62, 220, 90]], { threshold: 4 });
    if (!near(r.dy, -1)) return JSON.stringify(r);
    const guide = r.guides.find((g) => g.axis === "y");
    return (guide && near(guide.at, 55)) || JSON.stringify(r.guides);
  });
  must("beyond the threshold nothing snaps — unless there is squared paper", () => {
    const loose = G.snapMove([10, 10, 30, 30], [[100, 100, 120, 120]], { threshold: 4 });
    if (loose.dx || loose.dy || loose.guides.length) return JSON.stringify(loose);
    const gridded = G.snapMove([10, 10, 30, 30], [], { threshold: 4, grid: { pitch: 16 } });
    return (near(gridded.dx, 6) && near(gridded.dy, 6) && !gridded.guides.length) || JSON.stringify(gridded);
  });
  must("a box beats the grid: a neighbour's edge in reach wins over the squares", () => {
    const r = G.snapMove([30, 0, 50, 10], [[33, 100, 60, 120]], { threshold: 4, grid: { pitch: 16 } });
    return near(r.dx, 3) || JSON.stringify(r);
  });
  must("a resize snaps only the edges it moves", () => {
    const r = G.snapEdges([0, 0, 97, 50], [2, null], [[100, 200, 150, 250]], { threshold: 4 });
    if (!near(r.rect[2], 100) || r.rect[0] !== 0 || r.rect[3] !== 50) return JSON.stringify(r.rect);
    return (r.guides.length === 1 && r.guides[0].axis === "x" && near(r.guides[0].at, 100)) || JSON.stringify(r.guides);
  });
  must("...an edge never snaps past the opposite one", () => {
    const r = G.snapEdges([0, 0, 2, 50], [0, null], [[3, 100, 9, 120]], { threshold: 4 });
    return r.rect[0] < r.rect[2] || JSON.stringify(r.rect);
  });
  must("a handle's name says which edges it moves, north being the high edge", () => {
    const want = { n: [null, 2], se: [2, 0], w: [0, null], nw: [0, 2] };
    return Object.entries(want).every(([h, e]) => JSON.stringify(G.edgesForHandle(h)) === JSON.stringify(e)) || "handles";
  });
} catch (error) {
  results.push([false, "the check itself ran", String(error?.stack || error)]);
  failures += 1;
} finally {
  rmSync(stage, { recursive: true, force: true });
}

results.forEach(([ok, name, detail]) => console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`));
console.log(`\n${results.length} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
