// Dark page that leaves the pictures alone.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// A dark paper is the whole page through `invert(1) hue-rotate(180deg)`
// (bakePagePaper in src/documents/pdf-view.js, bakeDark in
// src/documents/pdf-render-worker.js). For print that is exactly right: black
// words become light, the white page becomes the paper, and a red heading stays
// red. For a PHOTOGRAPH it is a negative — faces turn blue-grey, skies orange —
// and a paper of figures read on a dark page looked broken.
//
// So the pictures are found and put back. pdf.js has already worked out, for
// the drawing it just did, every place a picture was painted: its operator
// list. One pass over that list (tracking the current transform the way
// CanvasGraphics does) gives each picture's quadrilateral on the page. Before
// the page is turned dark, the pixels under each picture worth keeping are
// copied aside; after, they are painted back.
//
// ── Which pictures are worth keeping ───────────────────────────────────────
//
// Not all of them. A scanned page is ONE picture of black words on white
// paper, and a reader who asked for a dark page wants that dark too; so is a
// black-on-white line drawing, or a screenshot of text. Each picture is sampled
// from the page as drawn (light, before any paper is applied) and is kept only
// if it is NOT paper-like: a picture that is mostly near-white and colourless
// is inverted with the page, everything else — photographs, colourful charts,
// a dark screenshot — keeps its own pixels. Stencil masks (`*ImageMask*`) are
// never candidates: they are one colour, painted like text.
//
// The decision is made once per page and filed with it (and with each kept
// picture of the page), so a zoom, a detail tile or a picture composed from the
// other paper keeps the same pictures — never a seam where half a photo was
// kept and the other half not.
//
// ── Shape ───────────────────────────────────────────────────────────────────
//
// One factory with nothing outside itself: the page renderer's worker is
// shipped as source (src/documents/pdf-render-worker.js) and gets this kit as
// `(${imageKeepKit})()`. Quads are 8 numbers, x0 y0 … x3 y3, as fractions of
// the page as SHOWN (rotation included), so they mean the same thing at every
// zoom and in every picture of the page. A "map" turns them into pixels of a
// particular canvas: { sx, sy, ox, oy } → (x * sx - ox, y * sy - oy).

export function imageKeepKit() {
  "use strict";

  // A picture smaller than this share of the page is a bullet, an icon or a
  // rule: not worth a sample, and inverted with the page like the text it sits
  // in.
  const MIN_AREA = 0.0015;
  // Pages with more pictures than this are tiled scans or patterns; the rest
  // go dark with the page rather than cost a sample each.
  const MAX_QUADS = 200;
  const SAMPLE = 48;
  // The floor a dark page is lifted to (PAPER_DARK_FLOOR in
  // src/format/paper-tones.js): a kept picture is lifted to it too, so a black
  // photograph in a corner is not read as a canvas the browser cleared
  // (canvasLostItsPixels, src/documents/pdf-view.js).
  const FLOOR = "#030303";

  // pdf.js's Util.transform: m then n.
  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }

  function isMatrix(m) {
    return Boolean(m) && m.length === 6 && Array.prototype.every.call(m, (v) => typeof v === "number" && Number.isFinite(v));
  }

  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  function quadArea(q) {
    let sum = 0;
    for (let i = 0; i < 8; i += 2) {
      const j = (i + 2) % 8;
      sum += q[i] * q[j + 1] - q[j] * q[i + 1];
    }
    return Math.abs(sum) / 2;
  }

  // Every picture painted by an operator list, as quads on the page.
  //
  // `ops` is { fnArray, argsArray } (a pdf.js OperatorList), `OPS` pdf.js's
  // opcode table, `viewport` the page's viewport (its `transform`, `width` and
  // `height` — any scale: the result is normalised by them).
  function quads(ops, OPS, viewport) {
    const out = [];
    if (!ops || !OPS || !viewport) return out;
    const fnArray = ops.fnArray || [];
    const argsArray = ops.argsArray || [];
    const vt = viewport.transform;
    const vw = viewport.width;
    const vh = viewport.height;
    if (!isMatrix(vt) || !(vw > 0) || !(vh > 0)) return out;
    const seen = new Set();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];

    const emit = (m) => {
      if (out.length >= MAX_QUADS) return;
      const t = mul(vt, m);
      const q = [];
      for (const [ux, uy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        q.push(round4((t[0] * ux + t[2] * uy + t[4]) / vw), round4((t[1] * ux + t[3] * uy + t[5]) / vh));
      }
      // Clipped to the page for the size test: a picture mostly off the page
      // is only as big as the part that shows.
      let minX = 1; let minY = 1; let maxX = 0; let maxY = 0;
      for (let i = 0; i < 8; i += 2) {
        minX = Math.min(minX, Math.max(0, q[i]));
        maxX = Math.max(maxX, Math.min(1, q[i]));
        minY = Math.min(minY, Math.max(0, q[i + 1]));
        maxY = Math.max(maxY, Math.min(1, q[i + 1]));
      }
      if (maxX <= minX || maxY <= minY) return;
      const visible = Math.min(quadArea(q), (maxX - minX) * (maxY - minY));
      if (visible < MIN_AREA) return;
      const key = q.join(",");
      if (seen.has(key)) return;
      seen.add(key);
      out.push(q);
    };

    for (let i = 0, n = fnArray.length; i < n && out.length < MAX_QUADS; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];
      if (fn === OPS.save) {
        stack.push(ctm);
      } else if (fn === OPS.restore) {
        if (stack.length) ctm = stack.pop();
      } else if (fn === OPS.transform) {
        if (isMatrix(args)) ctm = mul(ctm, args);
      } else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args && isMatrix(args[0])) ctm = mul(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) {
        if (stack.length) ctm = stack.pop();
      } else if (fn === OPS.beginAnnotation) {
        // CanvasGraphics starts an annotation from the page's own transform,
        // then applies its rect's transform and its appearance's matrix.
        stack.push(ctm);
        ctm = [1, 0, 0, 1, 0, 0];
        if (args && isMatrix(args[2])) ctm = mul(ctm, args[2]);
        if (args && isMatrix(args[3])) ctm = mul(ctm, args[3]);
      } else if (fn === OPS.endAnnotation) {
        if (stack.length) ctm = stack.pop();
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        // Drawn into the unit square of the current transform.
        emit(ctm);
      } else if (fn === OPS.paintImageXObjectRepeat) {
        // [objId, scaleX, scaleY, positions]: one placement per x, y pair.
        const sx = args?.[1];
        const sy = args?.[2];
        const positions = args?.[3] || [];
        if (typeof sx === "number" && typeof sy === "number") {
          for (let p = 0; p + 1 < positions.length && out.length < MAX_QUADS; p += 2) {
            emit(mul(ctm, [sx, 0, 0, sy, positions[p], positions[p + 1]]));
          }
        }
      } else if (fn === OPS.paintInlineImageXObjectGroup) {
        // [imgData, map]: each entry placed by its own transform.
        for (const entry of args?.[1] || []) {
          if (isMatrix(entry?.transform)) emit(mul(ctm, entry.transform));
        }
      }
    }
    return out;
  }

  // A quad, in the pixels of a canvas the `map` describes.
  function toDevice(q, map) {
    const pts = [];
    for (let i = 0; i < 8; i += 2) pts.push(q[i] * map.sx - map.ox, q[i + 1] * map.sy - map.oy);
    return pts;
  }

  // The whole pixels a device quad covers, clamped to a canvas `w` × `h`.
  function pixelBox(pts, w, h) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
    const x = Math.max(0, Math.floor(minX));
    const y = Math.max(0, Math.floor(minY));
    const x2 = Math.min(w, Math.ceil(maxX));
    const y2 = Math.min(h, Math.ceil(maxY));
    return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
  }

  function scratch(w, h) {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  // Is this sample of a picture paper — mostly near-white and colourless, the
  // way a scan, a line drawing or a picture of text is? `data` is RGBA.
  function paperLike(data) {
    let light = 0;
    let ink = 0;
    let coloured = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const chroma = (max - Math.min(r, g, b)) / 255;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      total += 1;
      if (luma > 215 && chroma < 0.12) {
        light += 1;
        continue;
      }
      ink += 1;
      if (chroma > 0.2) coloured += 1;
    }
    if (!total) return true;
    if (light / total < 0.6) return false;
    // Mostly paper. Only the marks on it say whether it is a colourful figure
    // (kept) or print (inverted).
    if (ink / total < 0.02) return true;
    return coloured / ink < 0.25;
  }

  // The quads among `list` worth keeping, judged from `source` — a canvas (or
  // bitmap) of the page as drawn, before any paper went on it — whose pixels
  // `map` describes. A quad mostly outside `source` (a detail tile) is judged
  // on the part that is there.
  function classify(source, list, map) {
    const kept = [];
    if (!source || !list || !list.length) return kept;
    const w = source.width;
    const h = source.height;
    let sample = null;
    let sctx = null;
    for (const q of list) {
      const box = pixelBox(toDevice(q, map), w, h);
      if (!box || box.w < 4 || box.h < 4) continue;
      try {
        if (!sample) {
          sample = scratch(SAMPLE, SAMPLE);
          sctx = sample.getContext("2d", { willReadFrequently: true });
          if (!sctx) return kept;
          sctx.imageSmoothingEnabled = true;
          sctx.imageSmoothingQuality = "high";
        }
        sctx.globalCompositeOperation = "copy";
        sctx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, SAMPLE, SAMPLE);
        if (!paperLike(sctx.getImageData(0, 0, SAMPLE, SAMPLE).data)) kept.push(q);
      } catch (_) {
        // A canvas that cannot be read back (tainted, lost): nothing kept,
        // the page goes dark as it always did.
        return [];
      }
    }
    if (sample) sample.width = 0;
    return kept;
  }

  // Apply a paper to `ctx`'s canvas with `paint()` — the dark invert, or a
  // tint — keeping the pixels under each of `kept` as they were. With nothing
  // to keep this is `paint()` and nothing else.
  function bake(ctx, kept, map, paint, { floor = true } = {}) {
    if (!kept || !kept.length || !map) {
      paint();
      return;
    }
    const canvas = ctx.canvas;
    const snaps = [];
    for (const q of kept) {
      const pts = toDevice(q, map).map((v) => Math.round(v));
      const box = pixelBox(pts, canvas.width, canvas.height);
      if (!box) continue;
      const copy = scratch(box.w, box.h);
      const cctx = copy.getContext("2d");
      if (!cctx) continue;
      cctx.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      snaps.push({ copy, box, pts });
    }
    paint();
    if (!snaps.length) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    for (const { copy, box, pts } of snaps) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < 8; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
      ctx.clip();
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(copy, box.x, box.y);
      if (floor) {
        ctx.globalCompositeOperation = "lighten";
        ctx.fillStyle = FLOOR;
        ctx.fillRect(box.x, box.y, box.w, box.h);
      }
      ctx.restore();
      copy.width = 0;
    }
    ctx.restore();
  }

  // Maps for the canvases pages are drawn into. `vw` × `vh` is the page's
  // viewport in CSS pixels.
  function pageMap(vw, vh, outputScale = 1) {
    return { sx: vw * outputScale, sy: vh * outputScale, ox: 0, oy: 0 };
  }

  function regionMap(vw, vh, region, density) {
    return { sx: vw * density, sy: vh * density, ox: region.x * density, oy: region.y * density };
  }

  // A picture of the whole page, `w` × `h` pixels, optionally cropped
  // (`crop` in its pixels) and scaled to `outW` × `outH`.
  function pictureMap(w, h, crop = null, outW = 0, outH = 0) {
    const cx = crop ? crop.x : 0;
    const cy = crop ? crop.y : 0;
    const kx = (outW || (crop ? crop.width : w)) / (crop ? crop.width : w);
    const ky = (outH || (crop ? crop.height : h)) / (crop ? crop.height : h);
    return { sx: w * kx, sy: h * ky, ox: cx * kx, oy: cy * ky };
  }

  return { quads, classify, bake, paperLike, pageMap, regionMap, pictureMap, toDevice };
}
