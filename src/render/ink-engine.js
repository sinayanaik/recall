// The pen itself: what happens between the nib touching the glass and a stroke
// existing.
//
// Surface-agnostic on purpose. It is handed HOSTS — an element to draw into and
// a matrix that maps model coordinates onto it — and knows nothing about PDFs,
// pages, notes or markdown. The Document surface gives it one host per rendered
// page whose matrix is pdf.js's own viewport transform, so ink lands in PDF user
// space and survives a zoom; the drawing sheet gives it one host whose matrix is
// a plain scale. Neither had to teach this file anything.
//
// ── Three canvases, and why ────────────────────────────────────────────────
//
//   dry      one per host. Every committed stroke. Repainted only when the
//            strokes change or the matrix does.
//   inkOverlay  one, moved onto whichever host is being drawn on. The stroke under
//            the nib, the lasso, and the selection chrome.
//   tip      one, over the inkOverlay. Predicted ink and nothing else.
//
// The split is the whole performance story. Redrawing every stroke on the page
// each frame is what makes a drawing app stutter once the page has a hundred
// strokes on it, so committed ink is painted once and left alone. The live
// stroke is APPEND-ONLY — each frame draws the outline of just the samples that
// arrived since the last one, plus INK_SEAM_OVERLAP of overlap so the caps hide
// the seam. Ink is opaque and the outline fills nonzero, so overlapping
// sub-outlines join invisibly; that is what buys an O(new points) frame instead
// of O(stroke).
//
// The tip needs its own canvas precisely BECAUSE the inkOverlay is append-only:
// predicted ink has to be wiped every frame when the prediction turns out
// wrong, and wiping a rectangle of the inkOverlay would take the real ink under it
// with it. It carries one thing more than prediction — the SETTLING TAIL. A
// sample the digitiser has only just reported has no successor, so it does not
// yet know its own width or its own tangent; painting it onto a layer that can
// never be repainted is how a line comes to bead at every frame boundary. So the
// wet layer takes only settled samples and the tip carries the last one or two,
// where being redrawn every frame is free.
//
// Neither the wet layer nor the tip is unmounted between strokes. They are
// cleared. See mountOverlay.
//
// ── What the pen feel actually comes from ──────────────────────────────────
//
//   • getCoalescedEvents(). A stylus samples at 240Hz and pointermove fires at
//     frame rate, so three of every four samples are inside the event you were
//     given rather than in one of their own. Without this a fast stroke is
//     visibly polygonal — it is a fidelity fix at least as much as a latency
//     one, and both Chrome/Android and Safari/iPadOS have it.
//   • getPredictedEvents(), on the tip canvas. Chrome only; absent elsewhere
//     and simply not used there, which costs nothing but the prediction.
//   • desynchronized on the inkOverlay and tip contexts. Presents without waiting
//     for the compositor on Chrome/Android. Deliberately NOT on the dry canvas:
//     a desynchronized context may tear, which is fine for a stroke in flight
//     and not for a page of finished work.
//   • Not one layout read in the pointer path. The host rect is measured at
//     pointerdown and on relayout, never per move. This is the discipline
//     src/notes/touch-selection.js arrived at the hard way — its extendTo() ran
//     straight off every touchmove with rect reads interleaved with class
//     writes, which is layout thrash, and the report that produced was "a
//     little unstable, a little flickering".

import { INK_PEN_DEFAULT, INK_TOOL_DEFAULT, INK_WIDTH_DEFAULT, normalizeInkPen, normalizeInkTool, normalizeInkWidth } from "../format/ink-colors.js?v=__BUILD__";
import { inkStrokeHitsPoint, inkStrokeInPolygon, inkStrokesBounds, transformInkStroke } from "../format/ink-strokes.js?v=__BUILD__";
import { INK_WIDTH_LOOKAHEAD, INK_WIDTH_LOOKBACK, paintInkStroke, paintInkStrokes, resolveInkColor } from "./ink-paint.js?v=__BUILD__";
import { INK_SHAPE_HOLD_MS, fitInkShape } from "./ink-shapes.js?v=__BUILD__";

// A canvas is painted at devicePixelRatio so ink is sharp, capped for the same
// reason src/documents/pdf-view.js caps its page canvases: a phone at dpr 3
// showing a zoomed A4 page is a bitmap nobody asked for, three of them in the
// render window.
export const INK_MAX_CANVAS_SCALE = 2;
export const INK_MAX_CANVAS_PIXELS = 4_000_000;

// How many samples of the previous frame's ink each frame redraws over. This is
// not a number to taste: it is exactly how far back a sample's own width reaches
// (INK_WIDTH_LOOKBACK, src/render/ink-paint.js), because a run that starts any
// later computes different widths for its first samples than the finished stroke
// will — and paints them at full opacity, so the wider of the two wins and the
// line beads at every frame seam.
const INK_SEAM_OVERLAP = INK_WIDTH_LOOKBACK;

// ...and the other half of the same rule: a sample with no successor yet cannot
// know its own width or its own tangent. The wet layer is append-only, so
// anything painted there is painted for good — it therefore paints only SETTLED
// samples, and the unsettled tail goes on the tip layer, which is wiped and
// redrawn every frame anyway. The tail is at most INK_WIDTH_LOOKAHEAD samples,
// i.e. one frame, behind the nib and the prediction covers it.

// How near the nib a stroke has to pass to be erased, on top of its own half
// width. A stroke-eraser that demands a direct hit is one people scrub at.
const INK_ERASE_SLACK = 3;

// The shortest interval between two re-arms of the straightener's hold timer.
// A stylus reports up to 240 pointermoves a second and each one used to cost a
// clearTimeout and a setTimeout; this makes it ten a second instead. The hold
// it measures is therefore 600-700ms of stillness rather than exactly 600, which
// is not a distinction a hand can make.
const INK_HOLD_REARM_MS = 100;

// Undo depth. Snapshots are an array of references — a page of a thousand
// strokes is eight kilobytes a snapshot — so forty is cheap and is more steps
// back than anyone takes.
const INK_HISTORY_MAX = 40;

// The corner grip on a lasso selection, in CSS pixels.
const INK_GRIP_SIZE = 22;

function inkCanvasScale(width, height) {
  const wanted = Math.min(INK_MAX_CANVAS_SCALE, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
  const area = Math.max(1, width * height);
  return Math.min(wanted, Math.sqrt(INK_MAX_CANVAS_PIXELS / area));
}

function inkSizeCanvas(canvas, width, height) {
  const scale = inkCanvasScale(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${Math.round(width)}px`;
  canvas.style.height = `${Math.round(height)}px`;
  return scale;
}

// Model -> device pixels, in one matrix. Handed straight to setTransform, so
// everything downstream draws in model units and nothing in this file or in
// ink-paint.js has to know about zoom, rotation or device pixels.
function inkDeviceTransform(matrix, scale) {
  const m = Array.isArray(matrix) && matrix.length === 6 ? matrix : [1, 0, 0, 1, 0, 0];
  return [m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale, m[4] * scale, m[5] * scale];
}

export function createInkEngine({
  getMatrix,
  getHostSize,
  toModel,
  onCommit = () => {},
  onSelectionChange = () => {},
  onToolChange = () => {},
  root = null,
  className = "ink-layer-canvas"
} = {}) {
  const hosts = new Map();
  const history = [];
  const future = [];

  let tool = INK_TOOL_DEFAULT;
  let pen = INK_PEN_DEFAULT;
  let width = INK_WIDTH_DEFAULT;

  let inkOverlay = null;
  let overlayCtx = null;
  let overlayScale = 1;
  let tip = null;
  let tipCtx = null;
  let tipScale = 1;
  let tipRect = null;

  let live = null;
  let queued = [];
  let frame = 0;
  let selection = null;

  // ── Hosts ────────────────────────────────────────────────────────────────

  function ensureCanvas(extraClass, desynchronized) {
    const canvas = document.createElement("canvas");
    canvas.className = `${className}${extraClass ? ` ${extraClass}` : ""}`;
    const ctx = canvas.getContext("2d", desynchronized ? { desynchronized: true } : undefined);
    return { canvas, ctx };
  }

  function attachHost(key, element) {
    if (!element) return null;
    const existing = hosts.get(key);
    if (existing && existing.el === element) {
      // Same element, but its canvas may have been taken out from under it —
      // a PDF page torn back down to a placeholder empties itself wholesale.
      // Without this the entry looks attached, paints into a detached canvas,
      // and the page comes back blank with its ink still in memory.
      if (existing.canvas && existing.canvas.parentNode !== element) {
        element.appendChild(existing.canvas);
        repaint(key);
      }
      return existing;
    }
    if (existing) detachHost(key);
    const { canvas, ctx } = ensureCanvas("is-ink-dry", false);
    element.appendChild(canvas);
    const entry = { key, el: element, canvas, ctx, scale: 1, strokes: existing?.strokes || [] };
    hosts.set(key, entry);
    repaint(key);
    return entry;
  }

  function detachHost(key) {
    const entry = hosts.get(key);
    if (!entry) return;
    // The strokes are NOT dropped with the canvas. A PDF page scrolled out of
    // the render window is torn back down to a placeholder and rebuilt later;
    // forgetting its ink here would mean re-reading and re-decoding every
    // stroke on it each time it came back past the viewport.
    // The wet pair stays mounted between strokes now (see mountOverlay), so the
    // host that is going away is the one that has to take them off — otherwise
    // two canvases are left parented to an element nothing else is holding.
    if (inkOverlay && inkOverlay.parentNode === entry.el) unmountOverlay();
    entry.canvas.remove();
    entry.canvas = null;
    entry.ctx = null;
    entry.el = null;
    if (live?.key === key) cancel();
    if (selection?.key === key) setSelection(null);
  }

  function setStrokes(key, strokes) {
    const entry = hosts.get(key) || { key, el: null, canvas: null, ctx: null, scale: 1, strokes: [] };
    entry.strokes = Array.isArray(strokes) ? strokes.slice() : [];
    hosts.set(key, entry);
    repaint(key);
  }

  function getStrokes(key) {
    return (hosts.get(key)?.strokes || []).slice();
  }

  function repaint(key) {
    const entry = hosts.get(key);
    if (!entry?.canvas || !entry.ctx || !entry.el) return;
    const size = getHostSize ? getHostSize(key) : null;
    if (!size || !size.width || !size.height) return;
    entry.scale = inkSizeCanvas(entry.canvas, size.width, size.height);
    const ctx = entry.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    const m = inkDeviceTransform(getMatrix ? getMatrix(key) : null, entry.scale);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    paintInkStrokes(ctx, entry.strokes, { root });
    if (selection?.key === key) drawSelectionChrome();
  }

  function repaintAll() {
    hosts.forEach((_, key) => repaint(key));
  }

  // ── The inkOverlay pair ─────────────────────────────────────────────────────

  function mountOverlay(key) {
    const entry = hosts.get(key);
    if (!entry?.el) return false;
    if (!inkOverlay) {
      const a = ensureCanvas("is-ink-wet", true);
      inkOverlay = a.canvas;
      overlayCtx = a.ctx;
      const b = ensureCanvas("is-ink-tip", true);
      tip = b.canvas;
      tipCtx = b.ctx;
    }
    const size = getHostSize ? getHostSize(key) : null;
    if (!size || !size.width || !size.height) return false;
    overlayScale = inkSizeCanvas(inkOverlay, size.width, size.height);
    tipScale = inkSizeCanvas(tip, size.width, size.height);
    // Appending an already-appended child moves it, which is real DOM work on
    // a path that runs every frame of a drag. Only touch it when it is not
    // already where it belongs.
    //
    // Which, since end() and cancel() stopped unmounting the pair, is only when
    // the pen has moved to a different host. They used to be detached at every
    // pointerup and re-attached at the next pointerdown: two removeChilds and
    // two appendChilds per stroke, tearing down and re-allocating a
    // `desynchronized` low-latency surface each time — which is both a hitch on
    // the first frame of every stroke and the thing that makes the low-latency
    // promotion unstable in the first place.
    if (inkOverlay.parentNode !== entry.el) {
      entry.el.appendChild(inkOverlay);
      entry.el.appendChild(tip);
      clearOverlay();
      clearTip();
    }
    return true;
  }

  function overlayTransform(key, ctx, scale) {
    const m = inkDeviceTransform(getMatrix ? getMatrix(key) : null, scale);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

  function clearOverlay() {
    if (!overlayCtx || !inkOverlay) return;
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, inkOverlay.width, inkOverlay.height);
  }

  function clearTip() {
    if (!tipCtx || !tip) return;
    tipCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (tipRect) tipCtx.clearRect(tipRect[0], tipRect[1], tipRect[2], tipRect[3]);
    else tipCtx.clearRect(0, 0, tip.width, tip.height);
    tipRect = null;
  }

  // The device-pixel box a run of model points was painted into, so clearTip can
  // wipe a rectangle rather than the whole canvas every frame. `tipRect` used to
  // be set to the full canvas unconditionally, which made the dirty-rect clear a
  // whole-page clear at device resolution on every animation frame of every
  // stroke — the one place in this file where the cost did not depend on how
  // much had actually been drawn.
  function tipBounds(key, points, nib) {
    const count = Math.floor(points.length / 3);
    if (!count) return null;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const x = points[i * 3];
      const y = points[(i * 3) + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // The outline reaches half a nib either side of the centreline, and the
    // round cap another half beyond each end. One whole nib of slack covers
    // both, whatever the pressure did.
    const pad = Math.max(1, Number(nib) || 1);
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const m = inkDeviceTransform(getMatrix ? getMatrix(key) : null, tipScale);
    const xs = []; const ys = [];
    [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]].forEach(([x, y]) => {
      xs.push((m[0] * x) + (m[2] * y) + m[4]);
      ys.push((m[1] * x) + (m[3] * y) + m[5]);
    });
    const left = Math.max(0, Math.floor(Math.min(...xs)) - 1);
    const top = Math.max(0, Math.floor(Math.min(...ys)) - 1);
    const right = Math.min(tip.width, Math.ceil(Math.max(...xs)) + 1);
    const bottom = Math.min(tip.height, Math.ceil(Math.max(...ys)) + 1);
    if (right <= left || bottom <= top) return null;
    return [left, top, right - left, bottom - top];
  }

  // The wet layer gives up the live stroke only AFTER the dry layer has taken
  // it. The wet pair is `desynchronized` — it may present ahead of the
  // compositor, which is the whole point of it — so clearing it first lets the
  // erase reach the glass a frame before the committed stroke does. What that
  // looks like is the stroke you have just written blinking out and back at
  // every single pen lift.
  //
  // repaint() draws the selection chrome onto the very layer that is wiped a
  // line later, so the chrome is put back rather than lost.
  function handOverToDry(key) {
    repaint(key);
    clearOverlay();
    clearTip();
    if (selection?.key === key) drawSelectionChrome();
  }

  function unmountOverlay() {
    clearOverlay();
    clearTip();
    inkOverlay?.remove();
    tip?.remove();
  }

  // ── History ──────────────────────────────────────────────────────────────

  // Every mutating gesture records the array it started from, and that array is
  // what both undo and cancel use. One mechanism rather than three, because the
  // three were not agreeing: a drag paints straight into the stroke array frame
  // by frame, so a snapshot taken when the drag ENDED recorded the result, and
  // an erase cancelled mid-scrub had already removed strokes that nothing was
  // holding a copy of.
  function remember(key, before) {
    history.push({ key, strokes: before });
    if (history.length > INK_HISTORY_MAX) history.shift();
    future.length = 0;
  }

  function snapshot(key) {
    const entry = hosts.get(key);
    if (!entry) return;
    remember(key, entry.strokes.slice());
  }

  function sameStrokes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) { if (a[i] !== b[i]) return false; }
    return true;
  }

  function restore(from, to, label) {
    const step = from.pop();
    if (!step) return false;
    const entry = hosts.get(step.key);
    if (!entry) return false;
    to.push({ key: step.key, strokes: entry.strokes.slice() });
    entry.strokes = step.strokes;
    setSelection(null);
    repaint(step.key);
    onCommit(step.key, entry.strokes.slice(), { reason: label });
    return true;
  }

  // ── Selection ────────────────────────────────────────────────────────────

  function setSelection(next) {
    const previousKey = selection?.key;
    selection = next;
    if (previousKey && previousKey !== next?.key) repaint(previousKey);
    if (next?.key) repaint(next.key);
    else clearOverlay();
    onSelectionChange(next ? { key: next.key, count: next.indices.length, box: next.box } : null);
  }

  function selectionBox(key, indices) {
    const entry = hosts.get(key);
    if (!entry) return null;
    return inkStrokesBounds(indices.map((i) => entry.strokes[i]).filter(Boolean));
  }

  // Half the corner grip, in MODEL units, and the one place that number is
  // worked out — the chrome that draws it and the hit test that reads it were
  // separately derived and disagreed, which made a small selection impossible
  // to drag: the grip's hit box reached 22 units in every direction from the
  // corner, so on a selection smaller than about 44 units square every press
  // landed on the grip and every drag was a resize.
  //
  // Two rules. It is a fixed size ON SCREEN, because it is a target for a
  // finger and a finger does not get bigger when you zoom out. And it never
  // takes more than a third of the smaller side, because a grip that covers the
  // thing it is a grip for leaves nothing to grab.
  function gripHalf(key) {
    const m = getMatrix ? getMatrix(key) : null;
    const unit = Math.abs((m?.[0] ?? 1)) || 1;
    const wanted = INK_GRIP_SIZE / unit / 2;
    const box = selection?.box;
    if (!box) return wanted;
    const smaller = Math.min(box.maxX - box.minX, box.maxY - box.minY);
    return Math.max(1 / unit, Math.min(wanted, smaller / 3));
  }

  // Chrome goes on the OVERLAY rather than the dry canvas: it is not ink, it
  // must not be exported, and it has to be able to move under a drag without
  // the page's strokes being repainted behind it every frame.
  function drawSelectionChrome() {
    if (!selection || !overlayCtx) return;
    if (!mountOverlay(selection.key)) return;
    const box = selection.box;
    if (!box) return;
    const m = getMatrix ? getMatrix(selection.key) : null;
    overlayTransform(selection.key, overlayCtx, overlayScale);
    const ctx = overlayCtx;
    // The dash is specified in model units, so it has to be divided back out of
    // the matrix or it becomes a solid line at high zoom and invisible at low.
    const unit = Math.abs((m?.[0] ?? 1)) || 1;
    ctx.save();
    ctx.lineWidth = 1 / unit;
    ctx.setLineDash([5 / unit, 4 / unit]);
    ctx.strokeStyle = resolveInkColor("blue", root);
    ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
    ctx.setLineDash([]);
    const grip = gripHalf(selection.key);
    ctx.fillStyle = resolveInkColor("blue", root);
    ctx.fillRect(box.maxX - grip, box.maxY - grip, grip * 2, grip * 2);
    ctx.restore();
  }

  // The drawn grip, with a little slack so a fingertip that lands just off it
  // still counts. The slack is deliberately small and symmetric: any more and
  // it starts eating the drag area again, which is the fault this is fixing.
  function gripHit(key, x, y) {
    if (!selection || selection.key !== key || !selection.box) return false;
    const grip = gripHalf(key) * 1.4;
    return x >= selection.box.maxX - grip && x <= selection.box.maxX + grip
      && y >= selection.box.maxY - grip && y <= selection.box.maxY + grip;
  }

  function insideSelection(key, x, y) {
    if (!selection || selection.key !== key || !selection.box) return false;
    return x >= selection.box.minX && x <= selection.box.maxX
      && y >= selection.box.minY && y <= selection.box.maxY;
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  // `samples` are whatever the surface accumulated while it was still deciding
  // between a tap and a stroke. They are real ink and are not thrown away.
  function begin(key, samples, event) {
    const entry = hosts.get(key);
    if (!entry?.el) return false;
    if (!mountOverlay(key)) return false;
    const eraser = isEraserEvent(event);
    const active = eraser ? "eraser" : tool;

    if (active === "lasso" && selection?.key === key) {
      const first = toModelPoint(key, samples[0]);
      if (first && gripHit(key, first.x, first.y)) {
        live = { key, mode: "scale", from: first, origin: { ...selection.box }, base: captureSelected(key), before: entry.strokes.slice() };
        return true;
      }
      if (first && insideSelection(key, first.x, first.y)) {
        live = { key, mode: "move", from: first, base: captureSelected(key), before: entry.strokes.slice() };
        return true;
      }
    }

    if (active === "lasso") {
      setSelection(null);
      live = { key, mode: "lasso", polygon: [] };
      samples.forEach((sample) => pushLasso(sample));
      return true;
    }

    if (active === "eraser") {
      live = { key, mode: "erase", before: entry.strokes.slice() };
      queued.push(...samples);
      inkScheduleFrame();
      return true;
    }

    live = {
      key,
      mode: "draw",
      points: [],
      drawnTo: 0,
      pen,
      width,
      holdTimer: 0,
      holdArmedAt: 0,
      snapped: null,
      snapDeclined: false,
      predicted: null,
      lastEvent: null,
      before: entry.strokes.slice()
    };
    samples.forEach((sample) => pushPoint(sample));
    inkScheduleFrame();
    return true;
  }

  function toModelPoint(key, sample) {
    if (!toModel) return null;
    return toModel(key, sample.clientX, sample.clientY);
  }

  function pushPoint(sample) {
    const point = toModelPoint(live.key, sample);
    if (!point) return;
    const pressure = Number.isFinite(sample.pressure) ? sample.pressure : 0.5;
    live.points.push(point.x, point.y, Math.max(0, Math.min(1, pressure)));
  }

  function pushLasso(sample) {
    const point = toModelPoint(live.key, sample);
    if (!point) return;
    live.polygon.push(point.x, point.y);
  }

  // One filter and one repaint per FRAME, not per sample. A scrub across a page
  // arrives coalesced at digitiser rate, and repainting every stroke on the page
  // once per sample is the same mistake the live stroke exists not to make.
  function eraseFrame() {
    const pending = queued;
    queued = [];
    if (!pending.length) return;
    const entry = hosts.get(live.key);
    if (!entry) return;
    const points = [];
    pending.forEach((sample) => {
      const point = toModelPoint(live.key, sample);
      if (point) points.push(point);
    });
    if (!points.length) return;
    const kept = entry.strokes.filter((stroke) =>
      !points.some((point) => inkStrokeHitsPoint(stroke, point.x, point.y, INK_ERASE_SLACK)));
    if (kept.length === entry.strokes.length) return;
    entry.strokes = kept;
    repaint(live.key);
  }

  function captureSelected(key) {
    const entry = hosts.get(key);
    return selection.indices.map((i) => entry.strokes[i]).filter(Boolean);
  }

  function move(event) {
    if (!live) return;
    const samples = coalesced(event);
    if (live.mode === "draw") {
      queued.push(...samples);
      // Any movement cancels a pending shape offer: the hold has to be the LAST
      // thing that happened, or a pause halfway through a long careful curve
      // would snap the half already drawn.
      armHold(event);
      inkScheduleFrame();
      return;
    }
    if (live.mode === "erase") { queued.push(...samples); inkScheduleFrame(); return; }
    if (live.mode === "lasso") { samples.forEach(pushLasso); inkScheduleFrame(); return; }
    if (live.mode === "move" || live.mode === "scale") {
      const point = toModelPoint(live.key, samples[samples.length - 1]);
      if (point) { live.to = point; inkScheduleFrame(); }
    }
  }

  function armHold(event) {
    // Held rather than read here: getPredictedEvents() is a call per move on the
    // hottest path in the file, and the frame is the only place its answer is
    // ever used. The event object outlives the dispatch, so keeping it costs a
    // reference.
    live.lastEvent = event;
    // A stroke that has already declined a shape is not asked again — see
    // revokeShape.
    if (live.snapDeclined) return;
    const now = Date.now();
    if (live.holdTimer && (now - live.holdArmedAt) < INK_HOLD_REARM_MS) return;
    if (live.holdTimer) clearTimeout(live.holdTimer);
    live.holdArmedAt = now;
    live.holdTimer = setTimeout(() => offerShape(), INK_SHAPE_HOLD_MS);
  }

  function offerShape() {
    if (!live || live.mode !== "draw" || live.snapped || live.snapDeclined) return;
    const fit = fitInkShape(live.points);
    if (!fit) return;
    live.snapped = fit;
    // The whole live stroke is replaced, so the append-only inkOverlay has to be
    // wiped and redrawn once — the one place in a stroke's life that happens.
    clearOverlay();
    clearTip();
    overlayTransform(live.key, overlayCtx, overlayScale);
    fit.runs.forEach((run) => paintInkStroke(overlayCtx, { w: live.width, c: live.pen, p: run }, { root }));
  }

  // ...and the other half of offering, which was missing.
  //
  // The straightener fires on a HOLD, and a hold is very often just someone
  // thinking in the middle of a word. Once it had fired there was no way back:
  // drawFrame threw away every sample that arrived afterwards and end() committed
  // the fitted shape rather than the points. So a slow, deliberate writer who
  // rested the nib for half a second watched the line stop following it and stay
  // stopped until they lifted — and the handwriting they had written after the
  // pause was gone. That is the flicker-and-stall this whole file was reported
  // for.
  //
  // Continuing the stroke revokes the offer, and the offer is not made again for
  // this stroke: the reader has now demonstrated, with the pen, that it is not a
  // shape. `drawnTo` goes back to nothing because the wet layer has just been
  // wiped and has to be rebuilt from the real points.
  function revokeShape() {
    live.snapped = null;
    live.snapDeclined = true;
    live.drawnTo = 0;
    if (live.holdTimer) { clearTimeout(live.holdTimer); live.holdTimer = 0; }
    clearOverlay();
    clearTip();
    if (selection?.key === live.key) drawSelectionChrome();
  }

  function coalesced(event) {
    const list = typeof event?.getCoalescedEvents === "function" ? event.getCoalescedEvents() : null;
    return (list && list.length) ? list : [event];
  }

  function isEraserEvent(event) {
    if (!event) return false;
    // The flipped end of a stylus, the dedicated eraser button, or a barrel
    // button held as the nib lands. Any of the three means erase for this
    // stroke only — the chosen tool is not changed under the reader.
    if (event.button === 5) return true;
    const buttons = Number(event.buttons) || 0;
    return Boolean(buttons & 32) || Boolean(buttons & 2);
  }

  function inkScheduleFrame() {
    if (frame) return;
    frame = requestAnimationFrame(inkRunFrame);
  }

  function inkRunFrame() {
    frame = 0;
    if (!live) return;
    if (live.mode === "draw") { drawFrame(); return; }
    if (live.mode === "erase") { eraseFrame(); return; }
    if (live.mode === "lasso") { drawLassoFrame(); return; }
    if (live.mode === "move" || live.mode === "scale") { drawTransformFrame(); return; }
  }

  function drawFrame() {
    const pending = queued;
    queued = [];
    // Ink that arrives after the straightener fired says the straightener was
    // wrong. Before the samples are taken, so they are taken into a stroke that
    // is drawing again rather than into one that is discarding them.
    if (live.snapped && pending.length) revokeShape();
    pending.forEach((sample) => pushPoint(sample));
    // A snap still standing means the pen has not moved since it fired: there is
    // nothing to draw and the fitted shape is already on the wet layer.
    if (live.snapped) return;

    clearTip();

    const total = Math.floor(live.points.length / 3);
    // Only the samples whose width is FINAL go onto the append-only wet layer.
    // A sample with no successor yet has neither its own tangent nor its own
    // smoothed width (see INK_WIDTH_LOOKAHEAD, src/render/ink-paint.js), so
    // painting it here would put one width on the glass and a different one
    // there when the finished stroke is repainted — which is the bead you can
    // watch travel along a line as you write it.
    const settled = Math.max(0, total - INK_WIDTH_LOOKAHEAD);
    if (settled > live.drawnTo) {
      const from = Math.max(0, live.drawnTo - INK_SEAM_OVERLAP);
      const run = live.points.slice(from * 3, settled * 3);
      overlayTransform(live.key, overlayCtx, overlayScale);
      paintInkStroke(overlayCtx, { w: live.width, c: live.pen, p: run }, { root });
      live.drawnTo = settled;
    }

    // The unsettled tail and the browser's guess at what comes next, both on the
    // tip — the canvas that is wiped and redrawn every frame precisely so that
    // provisional ink can be taken back without taking real ink with it. The tail
    // carries the seam overlap too, so it joins the wet layer invisibly.
    const tailFrom = Math.max(0, live.drawnTo - INK_SEAM_OVERLAP);
    const tail = live.points.slice(tailFrom * 3);
    const run = tail.slice();
    const event = live.lastEvent;
    live.lastEvent = null;
    const predicted = typeof event?.getPredictedEvents === "function" ? event.getPredictedEvents() : null;
    (predicted || []).forEach((sample) => {
      const point = toModelPoint(live.key, sample);
      if (point) run.push(point.x, point.y, Math.max(0, Math.min(1, Number.isFinite(sample.pressure) ? sample.pressure : 0.5)));
    });
    if (run.length < 3) return;
    overlayTransform(live.key, tipCtx, tipScale);
    paintInkStroke(tipCtx, { w: live.width, c: live.pen, p: run }, { root });
    tipRect = tipBounds(live.key, run, live.width);
    // A guess has to be able to expire. Frames are only scheduled by input, so a
    // pen that stopped moving used to leave its last prediction on the glass —
    // a phantom stub of ink sitting ahead of the nib until the hand moved again.
    // One more frame repaints the tail without it, and schedules nothing after
    // itself because by then there is no prediction left to clear.
    if (run.length > tail.length) inkScheduleFrame();
  }

  function drawLassoFrame() {
    clearOverlay();
    if (live.polygon.length < 4) return;
    const m = getMatrix ? getMatrix(live.key) : null;
    const unit = Math.abs((m?.[0] ?? 1)) || 1;
    overlayTransform(live.key, overlayCtx, overlayScale);
    const ctx = overlayCtx;
    ctx.save();
    ctx.lineWidth = 1.5 / unit;
    ctx.setLineDash([6 / unit, 4 / unit]);
    ctx.strokeStyle = resolveInkColor("blue", root);
    ctx.beginPath();
    ctx.moveTo(live.polygon[0], live.polygon[1]);
    for (let i = 2; i + 1 < live.polygon.length; i += 2) ctx.lineTo(live.polygon[i], live.polygon[i + 1]);
    ctx.stroke();
    ctx.restore();
  }

  function drawTransformFrame() {
    if (!live.to || !selection) return;
    const entry = hosts.get(live.key);
    if (!entry) return;
    const moved = transformFor(live);
    selection.indices.forEach((index, n) => { entry.strokes[index] = moved[n]; });
    selection.box = selectionBox(live.key, selection.indices);
    repaint(live.key);
  }

  function transformFor(gesture) {
    if (gesture.mode === "move") {
      const dx = gesture.to.x - gesture.from.x;
      const dy = gesture.to.y - gesture.from.y;
      return gesture.base.map((stroke) => transformInkStroke(stroke, { dx, dy }));
    }
    const originX = gesture.origin.minX;
    const originY = gesture.origin.minY;
    const wasW = Math.max(1e-3, gesture.origin.maxX - originX);
    const wasH = Math.max(1e-3, gesture.origin.maxY - originY);
    // One scale from the larger axis rather than two, so a drawing cannot be
    // squashed into something that is no longer the thing that was drawn.
    const scale = Math.max(0.1, Math.max((gesture.to.x - originX) / wasW, (gesture.to.y - originY) / wasH));
    return gesture.base.map((stroke) => transformInkStroke(stroke, { scale, originX, originY }));
  }

  function end() {
    if (!live) return;
    const gesture = live;
    if (gesture.holdTimer) clearTimeout(gesture.holdTimer);
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    const entry = hosts.get(gesture.key);

    if (gesture.mode === "draw") {
      // Drain whatever arrived in the last frame before the pen left the glass.
      // Done while `live` is still set, because pushPoint reads it — the end of
      // a stroke is exactly where a dropped sample shows, as a line that stops
      // short of where the reader lifted.
      //
      // A snap that was still standing is revoked by these samples on exactly
      // the same terms drawFrame revokes one: ink after a hold is not a shape.
      if (gesture.snapped && queued.length) { gesture.snapped = null; gesture.snapDeclined = true; }
      queued.forEach((sample) => pushPoint(sample));
      queued = [];
    }
    // Erase paints straight into the stroke array, so its last frame's worth of
    // samples has to be spent too — a scrub that ended between two frames used
    // to leave the strokes it had just crossed standing.
    if (gesture.mode === "erase" && queued.length) { live = gesture; eraseFrame(); }
    live = null;
    if (!entry) { clearOverlay(); clearTip(); return; }

    if (gesture.mode === "lasso") {
      // The marquee is not ink and there is nothing behind it being committed,
      // so it goes now rather than through the handover below.
      clearOverlay();
      clearTip();
      if (gesture.polygon.length < 6) return;
      const indices = [];
      entry.strokes.forEach((stroke, index) => {
        if (inkStrokeInPolygon(stroke, gesture.polygon)) indices.push(index);
      });
      if (!indices.length) { setSelection(null); return; }
      setSelection({ key: gesture.key, indices, box: selectionBox(gesture.key, indices) });
      return;
    }

    if (gesture.mode === "draw") {
      const runs = gesture.snapped ? gesture.snapped.runs : [gesture.points];
      const added = runs
        .filter((run) => run.length >= 3)
        .map((run) => ({ w: gesture.width, c: gesture.pen, p: run }));
      if (!added.length) { clearOverlay(); clearTip(); return; }
      entry.strokes = entry.strokes.concat(added);
      remember(gesture.key, gesture.before);
      handOverToDry(gesture.key);
      onCommit(gesture.key, entry.strokes.slice(), { reason: "draw", added });
      return;
    }

    // Erase, move and scale all painted straight into the array as they went,
    // so the only question left is whether anything actually changed. A scrub
    // that hit nothing, or a drag of two pixels that ended where it started,
    // must not cost an undo step or a write.
    if (sameStrokes(gesture.before, entry.strokes)) { clearOverlay(); clearTip(); return; }
    remember(gesture.key, gesture.before);
    if (selection?.key === gesture.key) selection.box = selectionBox(gesture.key, selection.indices);
    handOverToDry(gesture.key);
    onCommit(gesture.key, entry.strokes.slice(), { reason: gesture.mode });
  }

  function cancel() {
    if (!live) return;
    const gesture = live;
    if (gesture.holdTimer) clearTimeout(gesture.holdTimer);
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    live = null;
    queued = [];
    clearOverlay();
    clearTip();
    // Put back whatever the gesture started from. An erase cancelled mid-scrub
    // and a drag the compositor took away have both already changed the array,
    // and neither is a state the reader asked for — so this is a restore, not
    // an undo, and it leaves no step to redo.
    const entry = hosts.get(gesture.key);
    if (entry && gesture.before && !sameStrokes(gesture.before, entry.strokes)) {
      entry.strokes = gesture.before;
      if (selection?.key === gesture.key) setSelection(null);
    }
    repaint(gesture.key);
  }

  // ── Selection actions ────────────────────────────────────────────────────

  // Everything on one host, in one step, on the undo stack.
  //
  // The lasso can already delete a selection and undo can already take back a
  // stroke, but neither is what you want after covering a page in working you
  // have finished with: that was a lasso drawn round the whole page, or forty
  // presses of undo. It goes through snapshot/repaint/onCommit like every other
  // mutation here, so the answer to a mistaken press is one press of undo.
  function clearHost(key) {
    const entry = hosts.get(key);
    if (!entry || !entry.strokes.length) return false;
    snapshot(key);
    entry.strokes = [];
    if (selection?.key === key) setSelection(null);
    repaint(key);
    onCommit(key, [], { reason: "clear" });
    return true;
  }

  function deleteSelection() {
    if (!selection) return false;
    const entry = hosts.get(selection.key);
    if (!entry) return false;
    snapshot(selection.key);
    const drop = new Set(selection.indices);
    entry.strokes = entry.strokes.filter((_, index) => !drop.has(index));
    const key = selection.key;
    setSelection(null);
    repaint(key);
    onCommit(key, entry.strokes.slice(), { reason: "delete" });
    return true;
  }

  function selectedStrokes() {
    if (!selection) return [];
    const entry = hosts.get(selection.key);
    if (!entry) return [];
    return selection.indices.map((i) => entry.strokes[i]).filter(Boolean);
  }

  return {
    attachHost,
    detachHost,
    setStrokes,
    getStrokes,
    repaint,
    repaintAll,
    begin,
    move,
    end,
    cancel,
    clearHost,
    deleteSelection,
    selectedStrokes,
    clearSelection: () => setSelection(null),
    hasSelection: () => Boolean(selection),
    selectionKey: () => selection?.key ?? null,
    selectionIndices: () => (selection ? selection.indices.slice() : []),
    isDrawing: () => Boolean(live),
    undo: () => restore(history, future, "undo"),
    redo: () => restore(future, history, "redo"),
    canUndo: () => history.length > 0,
    canRedo: () => future.length > 0,
    getTool: () => tool,
    setTool: (next) => { tool = normalizeInkTool(next); if (tool !== "lasso") setSelection(null); onToolChange({ tool, pen, width }); },
    getPen: () => pen,
    setPen: (next) => { pen = normalizeInkPen(next); onToolChange({ tool, pen, width }); },
    getWidth: () => width,
    setWidth: (next) => { width = normalizeInkWidth(next); onToolChange({ tool, pen, width }); },
    destroy: () => {
      cancel();
      unmountOverlay();
      hosts.forEach((_, key) => detachHost(key));
      hosts.clear();
      history.length = 0;
      future.length = 0;
    }
  };
}
