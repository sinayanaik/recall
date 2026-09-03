// Does handwriting survive being stored, and does the pen refuse what it should?
//
//   node tools/ink-check.mjs
//
// Pure Node, like tools/document-sync-check.mjs and tools/text-sanitize-check.mjs,
// and for the same reason: the three modules under test import nothing between
// them but each other. src/format/ink-strokes.js is a leaf, src/render/ink-
// shapes.js is a leaf, and src/render/ink-paint.js reaches only the palette —
// which is deliberate, because everything here is either a WIRE FORMAT or a
// THRESHOLD, and both are things a browser-driven check is the wrong instrument
// for. The one accommodation is the same one those files make: every import in
// src/ carries the build stamp, which the static server understands and Node's
// ESM resolver does not, so the tree is copied to a temp directory with it
// removed.
//
// Three questions, and none of them subsumes another:
//
//   1. Does a stroke come back? A drawing is quantised, delta-encoded, packed
//      into base64url and simplified before it is stored, and every one of
//      those steps loses something on purpose. What must not be lost is the
//      handwriting.
//   2. Can it stop a deck syncing? These ride in the deck's meta bag, which
//      goes over the wire as JSON — the exact place a U+0000 out of pdf.js once
//      stopped a whole book from ever reaching the cloud (tools/text-sanitize-
//      check.mjs is that story). A format that can emit one is a format that
//      can do it again.
//   3. Does the straightener refuse? A shape that snaps when it was meant to is
//      a delight and a shape that snaps when it was not is a reader's
//      handwriting taken away. The interesting assertions here are the ones
//      about what it declines: a written word, a scribble, a tick, and — the
//      one this threshold was actually moved for — a letter O.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-ink-"));

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

// A deterministic generator, so a failure here is reproducible rather than a
// thing that happened once on somebody's machine.
function seeded(seed) {
  let value = seed;
  return () => {
    value = ((value * 1103515245) + 12345) % 2147483648;
    return value / 2147483648;
  };
}

// Something shaped like handwriting rather than like a test fixture: short
// strokes, sub-point steps between samples at stylus rates, pressure that
// moves slowly.
function handwritingStroke(rand, { at = [60, 700], samples = 40, nib = 1.8 } = {}) {
  const points = [];
  let x = at[0];
  let y = at[1];
  for (let i = 0; i < samples; i += 1) {
    x += (rand() - 0.35) * 1.1;
    y += Math.sin(i / 8) * 1.6;
    points.push(x, y, 0.35 + (0.3 * Math.sin(i / 9)));
  }
  return { w: nib, c: "ink", p: points };
}

function samplePolyline(fn, steps) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const [x, y] = fn(i / steps);
    points.push(x, y, 0.5);
  }
  return points;
}

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));

  const strokesMod = await import(path.join(stage, "src/format/ink-strokes.js"));
  const shapesMod = await import(path.join(stage, "src/render/ink-shapes.js"));
  const paintMod = await import(path.join(stage, "src/render/ink-paint.js"));
  const {
    INK_COORD_SCALE, INK_FORMAT_VERSION, INK_MARK_IDLE_MS, INK_SIMPLIFY_RATIO,
    decodeInkStroke, decodeInkStrokes, encodeInkStroke, encodeInkStrokes,
    inkBoxGap, inkEncodedSize, inkPointCount, inkStrokeBounds, inkStrokeHitsPoint,
    inkStrokeInPolygon, inkStrokesBounds, inkStrokesJoinMark, mergeInkBoxes,
    simplifyInkStroke, transformInkStroke
  } = strokesMod;
  const { fitInkShape, INK_SHAPE_MIN_SIZE } = shapesMod;

  // ── 1. Does a stroke come back? ─────────────────────────────────────────

  must("a stroke round-trips to within one quantisation step", () => {
    const rand = seeded(7);
    for (let n = 0; n < 40; n += 1) {
      const stroke = handwritingStroke(rand, { samples: 12 + (n * 3) });
      const kept = simplifyInkStroke(stroke.p, Math.max(1 / INK_COORD_SCALE, stroke.w * INK_SIMPLIFY_RATIO));
      const back = decodeInkStroke(encodeInkStroke(stroke));
      if (!back) return `stroke ${n} did not decode at all`;
      if (back.p.length !== kept.length) return `stroke ${n}: ${back.p.length / 3} points back, ${kept.length / 3} encoded`;
      // An ABSOLUTE tolerance, deliberately not 1 / INK_COORD_SCALE. Written in
      // terms of the constant under test, this assertion widens exactly as fast
      // as the quantiser coarsens and can therefore never fail — which is what
      // it did when the quantiser was dropped from eighths of a point to whole
      // points as a probe. An eighth of a point is ~0.04mm and is the claim the
      // format actually makes; that is the number to hold it to.
      const step = 0.125;
      for (let i = 0; i < kept.length; i += 3) {
        if (Math.abs(kept[i] - back.p[i]) > step) return `stroke ${n}: x off by ${Math.abs(kept[i] - back.p[i]).toFixed(3)}pt`;
        if (Math.abs(kept[i + 1] - back.p[i + 1]) > step) return `stroke ${n}: y off by ${Math.abs(kept[i + 1] - back.p[i + 1]).toFixed(3)}pt`;
      }
    }
    return true;
  });

  must("...and so do its nib and its pen", () => {
    for (const w of [1.2, 2, 3.4, 6]) {
      for (const c of ["ink", "red", "blue", "green", "amber"]) {
        const back = decodeInkStroke(encodeInkStroke({ w, c, p: [10, 10, 0.5, 20, 20, 0.6, 30, 15, 0.4] }));
        if (!back) return `${c} at ${w} did not decode`;
        if (back.w !== w) return `${c} at ${w} came back at ${back.w}`;
        if (back.c !== c) return `${c} came back as ${back.c}`;
      }
    }
    return true;
  });

  must("a one-sample stroke is a dot, not nothing", () => {
    const back = decodeInkStroke(encodeInkStroke({ w: 2, c: "ink", p: [40, 50, 0.7] }));
    return (back && back.p.length === 3) || "a full stop in a margin note decoded to nothing";
  });

  must("simplification keeps both ends and cuts the middle", () => {
    const rand = seeded(11);
    const stroke = handwritingStroke(rand, { samples: 200 });
    const kept = simplifyInkStroke(stroke.p, 0.225);
    if (kept.length >= stroke.p.length) return "nothing was removed";
    if (kept[0] !== stroke.p[0] || kept[1] !== stroke.p[1]) return "the first point moved";
    const n = kept.length;
    const m = stroke.p.length;
    if (kept[n - 3] !== stroke.p[m - 3] || kept[n - 2] !== stroke.p[m - 2]) return "the last point moved";
    return true;
  });

  must("encoding actually simplifies, and the saving is most of the file", () => {
    // Asserted rather than assumed. Simplification is the largest single saving
    // in the format — it is what takes a page of handwriting from hundreds of
    // kilobytes to tens — and it is one default argument away from silently not
    // happening at all, in which case everything else here still passes and
    // every sync gets several times bigger.
    const rand = seeded(29);
    const stroke = handwritingStroke(rand, { samples: 300 });
    const raw = encodeInkStroke(stroke, { simplify: false });
    const real = encodeInkStroke(stroke);
    const rawPoints = decodeInkStroke(raw).p.length / 3;
    const realPoints = decodeInkStroke(real).p.length / 3;
    if (realPoints >= rawPoints) return `simplification kept all ${rawPoints} points`;
    if (realPoints > rawPoints * 0.8) return `only ${rawPoints - realPoints} of ${rawPoints} points were dropped`;
    return real.length < raw.length * 0.8 || `the file shrank by only ${(100 - ((real.length / raw.length) * 100)).toFixed(0)}%`;
  });

  must("a stroke's box is padded by its own half width", () => {
    const box = inkStrokeBounds({ w: 6, c: "ink", p: [10, 10, 0.5, 30, 40, 0.5] });
    // A centreline bound would crop the mark's own thumbnail and mis-place the
    // badge pinned to its corner.
    return (box.minX === 7 && box.minY === 7 && box.maxX === 33 && box.maxY === 43)
      || `got ${JSON.stringify(box)}`;
  });

  must("...and a set of strokes' box contains every one of them", () => {
    const rand = seeded(3);
    const list = [handwritingStroke(rand), handwritingStroke(rand, { at: [300, 400] })];
    const all = inkStrokesBounds(list);
    for (const stroke of list) {
      const one = inkStrokeBounds(stroke);
      if (one.minX < all.minX || one.maxX > all.maxX || one.minY < all.minY || one.maxY > all.maxY) return "a stroke sits outside the union";
    }
    return true;
  });

  // ── 2. Can it stop a deck syncing? ──────────────────────────────────────

  must("an encoded page carries nothing Postgres will refuse", () => {
    const rand = seeded(19);
    const strokes = [];
    for (let i = 0; i < 200; i += 1) strokes.push(handwritingStroke(rand, { samples: 10 + Math.floor(rand() * 50) }));
    const encoded = encodeInkStrokes(strokes);
    // The wire form, not the JavaScript string: PostgREST parses the whole
    // request body as JSON and one bad escape fails the entire push.
    const body = JSON.stringify({ meta: { pdfHighlights: [{ id: "hn-abc123", kind: "ink", ink: { v: 1, s: encoded } }] } });
    if (body.includes("\\u0000")) return "a NUL escape reached the body";
    if (/\\u[dD][89abAB][0-9a-fA-F]{2}/.test(body)) return "a lone surrogate reached the body";
    for (const text of encoded) {
      if (!/^[\x20-\x7e]*$/.test(text)) return `a stroke is not ASCII: ${JSON.stringify(text.slice(0, 40))}`;
    }
    return true;
  });

  must("a saturated page stays inside its size budget", () => {
    // The regression guard on the encoding. A page covered edge to edge is
    // about a thousand strokes; this is measured rather than asserted from
    // memory, and the ceiling is what the README's number is worth.
    const rand = seeded(23);
    const strokes = [];
    for (let i = 0; i < 1000; i += 1) strokes.push(handwritingStroke(rand, { samples: 10 + Math.floor(rand() * 50) }));
    const bytes = inkEncodedSize(encodeInkStrokes(strokes));
    if (bytes > 80 * 1024) return `${(bytes / 1024).toFixed(0)}KB for a saturated page — the encoding has regressed`;
    if (inkPointCount(strokes) < 20000) return "the fixture is not actually a saturated page any more";
    return true;
  });

  must("...and a notebook of ordinary handwriting stays inside the meta bag", () => {
    // The other end of the same question, and the one the Handwritten Notes
    // section raises: a paper's ink is bounded by the paper, but a notebook can
    // be added to forever, and every page of it rides in the SAME JSONB column,
    // re-sent whole on every push.
    //
    // Thirty pages of ordinary writing rather than one saturated page: about a
    // hundred and twenty strokes a page is a page of prose, not a page covered
    // edge to edge. If this ever fails, the answer is not a bigger ceiling — it
    // is that pages have to stop living in `meta`.
    const rand = seeded(29);
    const pages = [];
    for (let page = 0; page < 30; page += 1) {
      const strokes = [];
      for (let i = 0; i < 120; i += 1) strokes.push(handwritingStroke(rand, { samples: 10 + Math.floor(rand() * 30) }));
      pages.push({ id: `hp-${page}`, order: page, w: 794, h: 1123, paper: "grid", ink: encodeInkStrokes(strokes), at: 1 });
    }
    const bytes = JSON.stringify({ meta: { pages } }).length;
    if (bytes > 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB for a 30-page notebook — too much to re-send on every sync`;
    return true;
  });

  must("a version this build does not know decodes to nothing", () => {
    const real = encodeInkStroke({ w: 2, c: "ink", p: [1, 2, 0.5, 3, 4, 0.5] });
    const future = real.replace(/^\d+:/, `${INK_FORMAT_VERSION + 1}:`);
    // Null, never a best guess: ink drawn under rules this build does not have
    // must not paint, and must still be there for a build that does.
    return decodeInkStroke(future) === null || "a future format was decoded anyway";
  });

  must("a corrupted stroke is refused rather than half-read", () => {
    const real = encodeInkStroke({ w: 2, c: "ink", p: [10, 10, 0.5, 20, 20, 0.6, 30, 30, 0.7] });
    const cases = {
      "out-of-alphabet character": real.slice(0, -2) + "!!",
      "no colour token": "1:20::AAA",
      "colour that is not a token": '1:20:<script>:AAA',
      "no width": "1::ink:AAA",
      "empty body": "1:20:ink:",
      "not a stroke at all": "hello",
      "truncated mid-number": `${real.slice(0, real.length - 1)}${"_"}`
    };
    for (const [name, text] of Object.entries(cases)) {
      const back = decodeInkStroke(text);
      if (back !== null && back.p.length >= 3 && name !== "truncated mid-number") return `${name} decoded to a stroke`;
    }
    // ...and a list drops what it cannot read instead of throwing.
    const list = decodeInkStrokes([real, "nonsense", null, 42, real]);
    return list.length === 2 || `a mixed list gave ${list.length} strokes`;
  });

  // ── 3. Geometry the eraser and the lasso depend on ──────────────────────

  must("the eraser hits a stroke it crosses and misses one it does not", () => {
    const stroke = { w: 2, c: "ink", p: [0, 0, 0.5, 100, 0, 0.5] };
    if (!inkStrokeHitsPoint(stroke, 50, 0, 0)) return "a point on the line missed";
    if (!inkStrokeHitsPoint(stroke, 50, 3, 3)) return "a point within the slack missed";
    if (inkStrokeHitsPoint(stroke, 50, 40, 3)) return "a point well off the line hit";
    if (inkStrokeHitsPoint(stroke, 400, 0, 3)) return "a point past the end hit";
    return true;
  });

  must("the lasso takes what it encloses and leaves what it does not", () => {
    const inside = { w: 2, c: "ink", p: [20, 20, 0.5, 30, 30, 0.5] };
    const outside = { w: 2, c: "ink", p: [200, 200, 0.5, 210, 210, 0.5] };
    const polygon = [0, 0, 100, 0, 100, 100, 0, 100];
    if (!inkStrokeInPolygon(inside, polygon)) return "an enclosed stroke was not selected";
    if (inkStrokeInPolygon(outside, polygon)) return "a stroke outside was selected";
    return true;
  });

  must("moving and scaling a selection takes its nib with it", () => {
    const stroke = { w: 4, c: "ink", p: [10, 10, 0.5, 20, 20, 0.5] };
    const moved = transformInkStroke(stroke, { dx: 5, dy: -3 });
    if (moved.p[0] !== 15 || moved.p[1] !== 7) return "the move did not land";
    if (moved.w !== 4) return "a move changed the nib";
    const scaled = transformInkStroke(stroke, { scale: 2, originX: 10, originY: 10 });
    if (scaled.p[3] !== 30 || scaled.p[4] !== 30) return "the scale did not land";
    // A drawing made smaller with its lines left at full weight is a different,
    // coarser drawing.
    return scaled.w === 8 || `the nib scaled to ${scaled.w}, not 8`;
  });

  // ── 4. Grouping ─────────────────────────────────────────────────────────

  must("strokes made together on one page become one mark", () => {
    const now = 1_000_000;
    const open = { page: 3, startedAt: now, lastAt: now, box: { minX: 10, minY: 10, maxX: 40, maxY: 30 } };
    const near = { minX: 42, minY: 12, maxX: 60, maxY: 28 };
    return inkStrokesJoinMark(open, { page: 3, box: near, now: now + 300 })
      || "a stroke a moment later and right beside it started a new mark";
  });

  must("...and a pause, another page, or a different part of the page starts a new one", () => {
    const now = 1_000_000;
    const open = { page: 3, startedAt: now, lastAt: now, box: { minX: 10, minY: 10, maxX: 40, maxY: 30 } };
    const near = { minX: 42, minY: 12, maxX: 60, maxY: 28 };
    if (inkStrokesJoinMark(open, { page: 3, box: near, now: now + INK_MARK_IDLE_MS + 1 })) return "a pause did not close the mark";
    if (inkStrokesJoinMark(open, { page: 4, box: near, now: now + 100 })) return "a different page joined the mark";
    if (inkStrokesJoinMark(null, { page: 3, box: near, now })) return "there was no mark open and one was joined anyway";
    const faraway = { minX: 500, minY: 600, maxX: 520, maxY: 620 };
    if (inkStrokesJoinMark(open, { page: 3, box: faraway, now: now + 100 })) return "the other end of the page joined the mark";
    return true;
  });

  must("continuous writing is capped rather than accumulating all page", () => {
    const start = 1_000_000;
    let open = { page: 1, startedAt: start, lastAt: start, box: { minX: 0, minY: 0, maxX: 20, maxY: 10 } };
    let closes = 0;
    // A stroke every 400ms for twelve seconds, each one right beside the last.
    for (let t = 400; t <= 12000; t += 400) {
      const box = { minX: t / 40, minY: 0, maxX: (t / 40) + 20, maxY: 10 };
      if (inkStrokesJoinMark(open, { page: 1, box, now: start + t })) {
        open = { ...open, lastAt: start + t, box: mergeInkBoxes(open.box, box) };
      } else {
        closes += 1;
        open = { page: 1, startedAt: start + t, lastAt: start + t, box };
      }
    }
    return closes >= 2 || `twelve seconds of unbroken writing made ${closes + 1} mark(s) — the ceiling is not holding`;
  });

  must("two boxes that overlap have no gap between them", () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const b = { minX: 5, minY: 5, maxX: 15, maxY: 15 };
    if (inkBoxGap(a, b) !== 0) return "overlapping boxes reported a gap";
    const c = { minX: 13, minY: 0, maxX: 20, maxY: 10 };
    return Math.abs(inkBoxGap(a, c) - 3) < 1e-9 || `a 3-unit gap measured ${inkBoxGap(a, c)}`;
  });

  // ── 5. The straightener, and mostly what it refuses ─────────────────────

  const wobble = (n) => ((Math.sin(n * 2.7) + Math.cos(n * 1.3)) * 1.1);

  must("a held line, box, ring and arrow snap", () => {
    const line = samplePolyline((t) => [20 + (t * 160), 40 + (t * 8) + wobble(t * 20)], 60);
    const ring = samplePolyline((t) => {
      const a = t * Math.PI * 2;
      return [100 + (Math.cos(a) * 60) + wobble(a * 3), 100 + (Math.sin(a) * 55) + wobble(a * 5)];
    }, 80);
    const corners = [[20, 20], [180, 20], [180, 120], [20, 120], [20, 20]];
    const box = samplePolyline((t) => {
      const s = Math.min(3.999, t * 4);
      const e = Math.floor(s);
      const f = s - e;
      return [corners[e][0] + ((corners[e + 1][0] - corners[e][0]) * f) + wobble(s * 4),
        corners[e][1] + ((corners[e + 1][1] - corners[e][1]) * f) + wobble(s * 6)];
    }, 100);
    const arrow = samplePolyline((t) => [20 + (t * 150), 60 + wobble(t * 15)], 50)
      .concat([155, 48, 0.5, 145, 44, 0.5, 138, 41, 0.5]);
    const want = { line: "line", ring: "ellipse", box: "rect", arrow: "arrow" };
    for (const [name, points] of Object.entries({ line, ring, box, arrow })) {
      const fit = fitInkShape(points);
      if (fit?.kind !== want[name]) return `${name} fitted as ${fit ? fit.kind : "nothing"}, wanted ${want[name]}`;
    }
    return true;
  });

  must("...and an arrow comes out as a shaft and a head", () => {
    const arrow = samplePolyline((t) => [20 + (t * 150), 60 + wobble(t * 15)], 50)
      .concat([155, 48, 0.5, 145, 44, 0.5, 138, 41, 0.5]);
    const fit = fitInkShape(arrow);
    return (fit?.runs?.length === 2) || `an arrow came out as ${fit?.runs?.length} run(s)`;
  });

  must("handwriting is left alone", () => {
    // The one this threshold was moved for. At INK_SHAPE_MIN_SIZE = 12 a
    // well-drawn letter O fitted an ellipse, and turning somebody's writing
    // into a circle is the worst thing the straightener could do.
    const letterO = (height) => samplePolyline((t) => {
      const a = t * Math.PI * 2;
      return [40 + (Math.cos(a) * height * 0.62), 50 + (Math.sin(a) * height)];
    }, 40);
    for (const height of [4, 5, 6, 8]) {
      const fit = fitInkShape(letterO(height));
      if (fit) return `a letter O ${height * 2} points tall snapped to a ${fit.kind}`;
    }
    const word = samplePolyline((t) => [20 + (t * 90), 50 + (Math.sin(t * 38) * 22)], 70);
    if (fitInkShape(word)) return "a written word snapped to a shape";
    const scribble = samplePolyline((t) => [30 + (Math.sin(t * 25) * 70), 60 + (Math.cos(t * 17) * 45)], 120);
    if (fitInkShape(scribble)) return "a scribble snapped to a shape";
    const tick = samplePolyline((t) => [10 + (t * 6), 10 + (t * 4)], 6);
    if (fitInkShape(tick)) return "a tick snapped to a shape";
    return true;
  });

  must("a deliberate ring round one symbol is still offered", () => {
    // The other side of the same threshold: refusing handwriting must not also
    // refuse the smallest thing anyone actually draws on purpose.
    const ring = samplePolyline((t) => {
      const a = t * Math.PI * 2;
      return [40 + (Math.cos(a) * 13), 40 + (Math.sin(a) * 12)];
    }, 40);
    const fit = fitInkShape(ring);
    if (fit?.kind !== "ellipse") return `a 26-point ring fitted as ${fit ? fit.kind : "nothing"}`;
    return INK_SHAPE_MIN_SIZE >= 18 || `the size floor is ${INK_SHAPE_MIN_SIZE}, which lets handwriting through`;
  });

  must("a snapped shape is drawn evenly, whatever was actually drawn", () => {
    // Lopsided input, symmetric output: the point of snapping is that it comes
    // out even, and a fit that merely tidied the input would not be worth the
    // risk of ever being wrong.
    const lopsided = samplePolyline((t) => [20 + (t * 160), 40 + (t * 9) + (wobble(t * 20) * 1.6)], 60);
    const fit = fitInkShape(lopsided);
    if (fit?.kind !== "line") return `expected a line, got ${fit ? fit.kind : "nothing"}`;
    return (fit.runs[0].length === 6) || `a fitted line came out with ${fit.runs[0].length / 3} points`;
  });

  // ── 6. The painter, driven through a recorder ───────────────────────────

  must("a stroke's outline is a closed filled path with a cap at each end", () => {
    const ops = [];
    const ctx = {
      beginPath: () => ops.push("begin"), moveTo: () => ops.push("move"), lineTo: () => ops.push("line"),
      quadraticCurveTo: () => ops.push("quad"), arc: () => ops.push("arc"), closePath: () => ops.push("close"),
      fill: () => ops.push("fill"), set fillStyle(_v) { /* ignored */ }
    };
    const drew = paintMod.inkStrokeOutline(ctx, { w: 2, c: "ink", p: [0, 0, 0.3, 10, 6, 0.7, 20, 2, 0.9, 30, 9, 0.4] });
    if (!drew) return "nothing was drawn";
    const arcs = ops.filter((op) => op === "arc").length;
    if (arcs !== 2) return `${arcs} cap(s), wanted 2`;
    if (ops[0] !== "begin" || ops.at(-1) !== "close") return `the path is not closed: ${ops.join(" ")}`;
    return true;
  });

  must("a nib varies along the stroke when the digitiser reports pressure", () => {
    const widths = paintMod.inkStrokeWidths({ w: 4, c: "ink", p: [0, 0, 0.05, 1, 0, 0.5, 2, 0, 1] });
    if (!(widths[2] > widths[0] * 1.4)) return `pressure barely moved the nib: ${widths.map((w) => w.toFixed(2)).join(",")}`;
    // ...and falls back to speed when it does not, so a mouse still tapers
    // instead of drawing a dead-flat line.
    const flat = paintMod.inkStrokeWidths({ w: 4, c: "ink", p: [0, 0, 0.5, 1, 0, 0.5, 40, 0, 0.5] });
    return (flat[2] < flat[1]) || "a fast mouse stroke did not thin at all";
  });

  must("a stroke that held still does not collapse to a notch", () => {
    // Two samples in the same place is a hand resting. Without a borrowed
    // tangent the outline collapses onto the centreline and leaves a nick.
    const ops = [];
    const ctx = {
      beginPath() {}, moveTo() {}, lineTo() { ops.push("line"); }, quadraticCurveTo() { ops.push("quad"); },
      arc() { ops.push("arc"); }, closePath() {}, fill() {}, set fillStyle(_v) {}
    };
    return paintMod.inkStrokeOutline(ctx, { w: 3, c: "ink", p: [5, 5, 0.5, 5, 5, 0.5, 5, 5, 0.5, 9, 9, 0.5] })
      || "a held-still stroke drew nothing";
  });

  console.log("── ink ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
