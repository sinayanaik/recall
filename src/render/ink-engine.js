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
// ── Two canvases, and why it used to be three ──────────────────────────────
//
//   dry     one per host. Every committed stroke. Repainted only when the
//           strokes change or the matrix does.
//   live    one, moved onto whichever host is being drawn on. The stroke under
//           the nib, the browser's guess at what comes next, the lasso, and the
//           selection chrome. Wiped and repainted whole, every frame.
//
// There were three, and the third is what this file was reported for: "when I
// am writing, the tip of the stroke is visible, and when I release, the rest of
// it then shows."
//
// The old shape was an append-only WET layer carrying settled samples, and a TIP
// layer over it carrying the unsettled tail and the prediction, wiped each
// frame. Both `desynchronized`. That asks to be taken out of the normal
// compositing path, and on Chrome/Android it can mean promotion to a hardware
// overlay plane — which is exactly what ce9f73a already found out the hard way,
// in its own words: "a plane does not blend with what is beneath it". Two of
// them stacked is that finding again one layer up. The tip is on top, so the tip
// is what you see; the wet layer under it is painted, present and hidden, and
// the whole stroke appears the instant the pair comes off at the pen lift.
//
// The append-only wet layer had a second way to produce the identical symptom,
// and it needed no compositing story at all: append-only ASSUMES the layer keeps
// what was drawn on it last frame, and a low-latency swap chain is not obliged
// to. Where it does not, every earlier frame's ink is gone and only the newest
// samples survive — which looks like a tip, because it is one.
//
// So there is one live layer and it is repainted WHOLE from live.points every
// frame. Neither mechanism can produce the fault any more: nothing is stacked
// over anything, and nothing is assumed to persist between frames.
//
// What that costs is a fill per frame over the whole stroke instead of over the
// few samples that just arrived, and the answer to that is INK_LIVE_MAX_POINTS
// below rather than a second layer.
//
// The live layer is mounted for the duration of a stroke and taken off again at
// the end of it — a cleared but still-mounted low-latency canvas HID the
// committed ink on the dry one beneath, which is the fault ce9f73a fixed and
// which this must not undo. See handOverToDry.
//
// ── What the pen feel actually comes from ──────────────────────────────────
//
//   • getCoalescedEvents(). A stylus samples at 240Hz and pointermove fires at
//     frame rate, so three of every four samples are inside the event you were
//     given rather than in one of their own. Without this a fast stroke is
//     visibly polygonal — it is a fidelity fix at least as much as a latency
//     one, and both Chrome/Android and Safari/iPadOS have it.
//   • getPredictedEvents(), on the live canvas. Chrome only; absent elsewhere
//     and simply not used there, which costs nothing but the prediction.
//   • desynchronized on the live context, and on that one alone. Presents
//     without waiting for the compositor on Chrome/Android. Deliberately NOT on
//     the dry canvas: a desynchronized context may tear, which is fine for a
//     stroke in flight and not for a page of finished work. And deliberately not
//     on a SECOND live layer either, which is the whole of the fault above.
//   • Not one layout read in the pointer path. The host rect is measured at
//     pointerdown and on relayout, never per move. This is the discipline
//     src/notes/touch-selection.js arrived at the hard way — its extendTo() ran
//     straight off every touchmove with rect reads interleaved with class
//     writes, which is layout thrash, and the report that produced was "a
//     little unstable, a little flickering".

import { INK_ERASER_SIZE_DEFAULT, INK_ERASE_MODE_DEFAULT, INK_PEN_DEFAULT, INK_TOOL_DEFAULT, INK_WIDTH_DEFAULT, normalizeInkEraseMode, normalizeInkEraserSize, normalizeInkPen, normalizeInkTool, normalizeInkWidth } from "../format/ink-colors.js?v=__BUILD__";
import { eraseFromInkStroke, inkStrokeHitsPoint, inkStrokeInPolygon, inkStrokesBounds, transformInkStroke } from "../format/ink-strokes.js?v=__BUILD__";
import { INK_WIDTH_LOOKBACK, paintInkStroke, paintInkStrokes, resolveInkColor } from "./ink-paint.js?v=__BUILD__";
import { INK_SHAPE_HOLD_MS, fitInkShape } from "./ink-shapes.js?v=__BUILD__";

// A canvas is painted at devicePixelRatio so ink is sharp, capped for the same
// reason src/documents/pdf-view.js caps its page canvases: a phone at dpr 3
// showing a zoomed A4 page is a bitmap nobody asked for, three of them in the
// render window.
export const INK_MAX_CANVAS_SCALE = 2;
export const INK_MAX_CANVAS_PIXELS = 4_000_000;

// How far two runs of the same stroke overlap where they meet. Not a number to
// taste: it is exactly how far back a sample's own width reaches
// (INK_WIDTH_LOOKBACK, src/render/ink-paint.js), because a run that starts any
// later computes different widths for its first samples than the finished stroke
// will — and paints them at full opacity, so the wider of the two wins and the
// line beads at the join. Ink is opaque and the outline fills nonzero, so two
// runs that overlap by this much join invisibly.
//
// Only one thing needs it now: the hand-off at INK_LIVE_MAX_POINTS below. It
// used to be needed every frame, because the live layer was append-only.
const INK_SEAM_OVERLAP = INK_WIDTH_LOOKBACK;

// ── The bound on repainting the live stroke whole ─────────────────────────
//
// A frame repaints every sample of the stroke in flight, which is what makes the
// live layer immune to being hidden and to not being preserved. The cost is a
// fill over the whole stroke rather than over the samples that just arrived, and
// for the strokes people actually make — a letter, a word, an arrow, a few
// hundred samples — that is nothing.
//
// It is not nothing for a stylus reporting 240 samples a second into a spiral
// somebody draws for ten seconds without lifting. So past this many live
// samples, everything but the tail is handed to the DRY canvas and the live
// layer carries only what is left: the frame cost stops growing, and the part
// handed over is on a normal context whose contents are guaranteed to persist.
//
// The hand-off is a PAINT, not a commit — the stroke is still in flight and is
// committed once, at the pen lift, exactly as before. `live.settled` records
// what was handed over so a repaint of the dry canvas mid-stroke can put it
// back; without that a theme change under the nib would erase the front of the
// stroke somebody is still drawing.
const INK_LIVE_MAX_POINTS = 900;

// How much of the stroke stays live when that happens. Comfortably more than one
// frame of samples at any rate a digitiser reports, so the hand-off can never
// race the nib.
const INK_LIVE_TAIL = 180;

// How near the nib a stroke has to pass to be erased used to be this constant,
// on top of the stroke's own half width — "a stroke-eraser that demands a direct
// hit is one people scrub at", which is still true. It is a setting now
// (INK_ERASER_SIZES, ../format/ink-colors.js) with this value in the middle of
// the set, because 3 points is generous for crossing out a word and far too
// coarse to rub out one letter, which the part-eraser can do.

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

// How far a paste or a duplicate lands from where it was taken, in model units,
// when the caller has not said where the reader is pointing. Enough to see the
// copy is a copy; not so far that it arrives off the part of the page being
// looked at. A copy that lands exactly on its original looks like nothing
// happened, and then a drag moves the wrong one.
const INK_PASTE_OFFSET = 16;

// How far a selection moves per press of an arrow key, in model units, and with
// Shift held. Ten points is about a line of handwriting.
export const INK_NUDGE_STEP = 1;

export const INK_NUDGE_STEP_COARSE = 10;

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
  let eraseMode = INK_ERASE_MODE_DEFAULT;
  let eraserSize = INK_ERASER_SIZE_DEFAULT;
  // Whether a hold offers to straighten the stroke into a shape. On by default,
  // because it is what the feature is for — but refusable, which it was not:
  // somebody writing mathematics draws a fraction bar and a radical and a long
  // division rule, and every one of them is a held straight line.
  let snapShapes = true;

  let inkOverlay = null;
  let overlayCtx = null;
  let overlayScale = 1;

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
    // handOverToDry takes the live layer off at every pen lift, so in the
    // ordinary case there is nothing here to unmount. This is for the case where
    // there was no pen lift: a host torn down mid-stroke (a page scrolled out of
    // the render window, a sheet closed under the nib) would otherwise leave a
    // canvas parented to an element nothing else is holding.
    if (inkOverlay && entry.el && inkOverlay.parentNode === entry.el) unmountOverlay();
    // Optional chaining because this has to be idempotent: the entry deliberately
    // stays in `hosts` after a detach (that is what keeps the strokes), so a
    // second detach of the same key finds it with nothing left to remove. On the
    // PDF surface that never happened; a stack of pages, where closing tears the
    // hosts down and re-rendering an empty stack tears them down again, hits it
    // on the first try.
    entry.canvas?.remove();
    entry.canvas = null;
    entry.ctx = null;
    entry.el = null;
    if (live?.key === key) cancel();
    if (selection?.key === key) setSelection(null);
  }

  // Detach, and then genuinely forget.
  //
  // detachHost keeps the strokes on purpose, because a PDF page swept out of the
  // render window is coming back. A page DELETED from a notebook is not, and a
  // sheet closed and re-opened mints new page ids — so without this the map grows
  // for the life of the tab, holding the ink of pages that no longer exist.
  function forgetHost(key) {
    detachHost(key);
    hosts.delete(key);
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
    // A stroke still in flight that has handed part of itself to this canvas —
    // see the bound in drawFrame — is not in entry.strokes yet, because it is
    // not committed until the pen lifts. Without this, anything that repaints
    // the dry canvas mid-stroke (a theme change, a relayout, a selection) would
    // erase the front of the line the reader is still drawing.
    if (live?.key === key && live.settled?.length) {
      live.settled.forEach((run) => paintInkStroke(ctx, { w: live.width, c: live.pen, p: run }, { root }));
    }
    if (selection?.key === key) drawSelectionChrome();
  }

  function repaintAll() {
    hosts.forEach((_, key) => repaint(key));
  }

  // ── The inkOverlay pair ─────────────────────────────────────────────────────

  function mountOverlay(key) {
    const entry = hosts.get(key);
    if (!entry?.el) return false;
    // `is-ink-wet` is kept as the class name: it is what the two stylesheets
    // that position these canvases select on, and the layer is still the wet
    // one — there is simply no longer a second one over it.
    if (!inkOverlay) {
      const made = ensureCanvas("is-ink-wet", true);
      inkOverlay = made.canvas;
      overlayCtx = made.ctx;
    }
    const size = getHostSize ? getHostSize(key) : null;
    if (!size || !size.width || !size.height) return false;
    overlayScale = inkSizeCanvas(inkOverlay, size.width, size.height);
    // Appending an already-appended child moves it, which is real DOM work on
    // a path that runs every frame of a drag. Only touch it when it is not
    // already where it belongs — which, since the layer is unmounted at every
    // pen lift, means at the start of every stroke.
    if (inkOverlay.parentNode !== entry.el) {
      entry.el.appendChild(inkOverlay);
      clearOverlay();
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

  // The wet layer gives up the live stroke only AFTER the dry layer has taken
  // it. The live layer is `desynchronized` — it may present ahead of the
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
    // ── ...and then the layer comes OFF the page ────────────────────────────
    //
    // Reported from a Samsung tablet: "I can see the strokes while drawing but
    // they disappear once drawn, and only appear again after uploading." The
    // stroke was never lost — it was on the dry canvas the whole time, behind a
    // canvas that had stopped leaving.
    //
    // The live layer is created `desynchronized`, which is what buys the latency
    // that makes the pen feel like a pen. What that flag actually asks for is to
    // be taken OUT of the normal compositing path — on Chrome/Android a
    // low-latency canvas can be promoted to a hardware overlay plane, and a
    // plane does not blend with what is underneath it. Cleared to transparent on
    // a desktop that composites it normally, it is invisible and harmless, which
    // is exactly why leaving it mounted looked free here and was not.
    //
    // So it is mounted for the duration of a stroke and no longer. The DOM churn
    // that costs is the price of the committed ink being on top of nothing at
    // all, and the blink that used to come with it was never the unmount: it was
    // doing this BEFORE the repaint above rather than after it.
    unmountOverlay();
    if (selection?.key === key) drawSelectionChrome();
  }

  function unmountOverlay() {
    clearOverlay();
    inkOverlay?.remove();
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
    // The turn grip, on the opposite corner from the resize one so the two can
    // never be reached for by mistake, and round rather than square so they do
    // not have to be told apart by position alone.
    ctx.beginPath();
    ctx.arc(box.minX + grip, box.minY + grip, grip, 0, Math.PI * 2);
    ctx.fill();
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

  // The turn grip, top-left, with the same slack for the same reason.
  function turnGripHit(key, x, y) {
    if (!selection || selection.key !== key || !selection.box) return false;
    const grip = gripHalf(key) * 1.4;
    return x >= selection.box.minX - grip && x <= selection.box.minX + grip
      && y >= selection.box.minY - grip && y <= selection.box.minY + grip;
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
      // Turn before resize, because the two grips are on opposite corners and a
      // press can only be one of them — but the order still has to be stated, or
      // a selection small enough for the two hit boxes to overlap answers to
      // whichever test happens to be written first.
      if (first && turnGripHit(key, first.x, first.y)) {
        const box = { ...selection.box };
        const originX = (box.minX + box.maxX) / 2;
        const originY = (box.minY + box.maxY) / 2;
        live = {
          key,
          mode: "turn",
          origin: box,
          centre: { x: originX, y: originY },
          // The angle the press started at, so what the reader turns is the
          // DIFFERENCE — a grip grabbed off-centre must not snap the drawing
          // round to meet the finger.
          from: Math.atan2(first.y - originY, first.x - originX),
          base: captureSelected(key),
          before: entry.strokes.slice()
        };
        return true;
      }
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
      // The first sample still drawn on the live layer, and the runs already
      // handed to the dry canvas. Both stay at their initial values for every
      // stroke shorter than INK_LIVE_MAX_POINTS, which is very nearly all of
      // them — see the bound in drawFrame.
      from: 0,
      settled: [],
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
    // Whole strokes, which is what this always did — cross a mark anywhere and
    // all of it goes.
    if (eraseMode === "stroke") {
      const kept = entry.strokes.filter((stroke) =>
        !points.some((point) => inkStrokeHitsPoint(stroke, point.x, point.y, eraserSize)));
      if (kept.length === entry.strokes.length) return;
      entry.strokes = kept;
      repaint(live.key);
      return;
    }
    // ...and only what the nib passed over, leaving the rest of the stroke
    // standing. eraseFromInkStroke returns the SAME stroke object when it took
    // nothing, so `changed` is an identity compare and a scrub over empty paper
    // costs one bounding-box test per stroke and no repaint.
    let changed = false;
    const next = [];
    entry.strokes.forEach((stroke) => {
      const left = eraseFromInkStroke(stroke, points, eraserSize);
      if (left.length === 1 && left[0] === stroke) { next.push(stroke); return; }
      changed = true;
      left.forEach((piece) => next.push(piece));
    });
    if (!changed) return;
    entry.strokes = next;
    // The lasso's indices are positions in an array that has just changed length.
    // Rubbing out part of a selected stroke and then dragging what was "selected"
    // would move whatever now sits at those positions, which is somebody else's
    // handwriting.
    if (selection?.key === live.key) setSelection(null);
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
    if (live.mode === "move" || live.mode === "scale" || live.mode === "turn") {
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
    // Turned off entirely, which it could not be. The offer is a good default and
    // a bad law: a fraction bar, a radical and a long-division rule are all held
    // straight lines, and somebody working through a page of them wants a pen
    // that does not keep making a decision for them.
    if (!snapShapes) return;
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
    // The fitted shape replaces the WHOLE stroke, including any part of it
    // already handed to the dry canvas — so that hand-off is taken back first,
    // or the straightened line would be drawn over the crooked one it replaced.
    // A stroke long enough to have reached INK_LIVE_MAX_POINTS and then held
    // still for INK_SHAPE_HOLD_MS is rare and entirely possible.
    reclaimSettled();
    clearOverlay();
    overlayTransform(live.key, overlayCtx, overlayScale);
    fit.runs.forEach((run) => paintInkStroke(overlayCtx, { w: live.width, c: live.pen, p: run }, { root }));
  }

  // Take back everything this stroke handed to the dry canvas, so the live layer
  // is once again the whole of it. Repainting the dry canvas from entry.strokes
  // is what removes the handed-over runs: the stroke is not committed yet, so it
  // is not in there.
  function reclaimSettled() {
    if (!live?.settled?.length) return;
    live.settled = [];
    live.from = 0;
    repaint(live.key);
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
  // shape. Nothing has to be rebuilt by hand — the next frame repaints the live
  // layer from live.points, which is the real stroke and always was.
  function revokeShape() {
    live.snapped = null;
    live.snapDeclined = true;
    if (live.holdTimer) { clearTimeout(live.holdTimer); live.holdTimer = 0; }
    clearOverlay();
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
    if (live.mode === "move" || live.mode === "scale" || live.mode === "turn") { drawTransformFrame(); return; }
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
    // nothing to draw and the fitted shape is already on the live layer.
    if (live.snapped) return;

    const total = Math.floor(live.points.length / 3);

    // ── The bound ───────────────────────────────────────────────────────────
    //
    // Past INK_LIVE_MAX_POINTS live samples, hand everything but the tail to the
    // dry canvas so the per-frame fill stops growing with the stroke. A PAINT,
    // not a commit: the stroke is still in flight and is committed once, at the
    // pen lift. The two runs overlap by INK_SEAM_OVERLAP so the join is
    // invisible — ink is opaque and the outline fills nonzero.
    //
    // Only settled samples are handed over, which INK_LIVE_TAIL guarantees by
    // being far larger than the one sample of lookahead a width needs
    // (INK_WIDTH_LOOKAHEAD, ink-paint.js). A sample with no successor cannot
    // know its own width or its own tangent, and the dry canvas is the one
    // surface a stroke in flight cannot be repainted from — so a provisional
    // width painted there is a bead that never comes out.
    if (total - live.from > INK_LIVE_MAX_POINTS) {
      const handOver = total - INK_LIVE_TAIL;
      const entry = hosts.get(live.key);
      if (entry?.ctx && handOver > live.from) {
        const run = live.points.slice(live.from * 3, handOver * 3);
        const m = inkDeviceTransform(getMatrix ? getMatrix(live.key) : null, entry.scale);
        entry.ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        paintInkStroke(entry.ctx, { w: live.width, c: live.pen, p: run }, { root });
        // Remembered so repaint() can put it back. Without this a theme change,
        // a selection or a relayout under the nib would repaint the dry canvas
        // from entry.strokes — which does not hold this stroke yet — and erase
        // the front of the line somebody is still drawing.
        live.settled.push(run);
        live.from = Math.max(0, handOver - INK_SEAM_OVERLAP);
      }
    }

    // ── ...and the frame itself ─────────────────────────────────────────────
    //
    // Wiped and repainted whole, from live.from to the nib, plus the browser's
    // guess at what comes next. That is the whole of the fix this file was
    // rewritten for: nothing is stacked over this layer, and nothing about it is
    // assumed to survive from the previous frame.
    clearOverlay();
    const run = live.points.slice(live.from * 3);
    const event = live.lastEvent;
    live.lastEvent = null;
    const predicted = typeof event?.getPredictedEvents === "function" ? event.getPredictedEvents() : null;
    (predicted || []).forEach((sample) => {
      const point = toModelPoint(live.key, sample);
      if (point) run.push(point.x, point.y, Math.max(0, Math.min(1, Number.isFinite(sample.pressure) ? sample.pressure : 0.5)));
    });
    if (run.length < 3) return;
    overlayTransform(live.key, overlayCtx, overlayScale);
    paintInkStroke(overlayCtx, { w: live.width, c: live.pen, p: run }, { root });
    // A guess has to be able to expire. Frames are only scheduled by input, so a
    // pen that stopped moving used to leave its last prediction on the glass —
    // a phantom stub of ink sitting ahead of the nib until the hand moved again.
    // One more frame repaints without it, and schedules nothing after itself
    // because by then there is no prediction left to clear.
    if (predicted?.length) inkScheduleFrame();
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
    if (gesture.mode === "turn") {
      const theta = Math.atan2(gesture.to.y - gesture.centre.y, gesture.to.x - gesture.centre.x) - gesture.from;
      return gesture.base.map((stroke) =>
        transformInkStroke(stroke, { theta, originX: gesture.centre.x, originY: gesture.centre.y }));
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
    if (!entry) { clearOverlay(); unmountOverlay(); return; }

    if (gesture.mode === "lasso") {
      // The marquee is not ink and there is nothing behind it being committed,
      // so it goes now rather than through the handover below.
      clearOverlay();
      unmountOverlay();
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
      if (!added.length) { clearOverlay(); unmountOverlay(); return; }
      entry.strokes = entry.strokes.concat(added);
      remember(gesture.key, gesture.before);
      handOverToDry(gesture.key);
      onCommit(gesture.key, entry.strokes.slice(), { reason: "draw", added });
      return;
    }

    // Erase, move, scale and turn all painted straight into the array as they
    // went, so the only question left is whether anything actually changed. A
    // scrub that hit nothing, or a drag of two pixels that ended where it
    // started, must not cost an undo step or a write.
    if (sameStrokes(gesture.before, entry.strokes)) { clearOverlay(); unmountOverlay(); return; }
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
    unmountOverlay();
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

  // ── Everything else a selection is for ───────────────────────────────────
  //
  // The lasso could move a selection, resize it from one corner, and delete it.
  // That is the shape of a tool you can only use to correct a placement, and
  // "the selection contents options are very limited" is exactly right about it:
  // the things a page of working actually needs — this bit in red, this bit
  // thinner, this diagram again over here, this line onto the next page — were
  // all a lasso away and none of them existed.
  //
  // All of them are the same three steps, which is why they are one function:
  // snapshot for the undo stack, replace the selected strokes, repaint and
  // commit. `make` is handed each selected stroke and returns its replacement.
  // Nothing here has to know about mark ids: a replacement made by spreading the
  // original carries `m` with it, and one built without a mark is given a fresh
  // one by commitInkPage (../documents/pdf-ink.js), which already has that rule
  // for the strokes an undo hands back.
  function mapSelection(make, reason) {
    if (!selection) return false;
    const entry = hosts.get(selection.key);
    if (!entry) return false;
    const key = selection.key;
    const before = entry.strokes.slice();
    const next = entry.strokes.slice();
    selection.indices.forEach((index) => {
      const stroke = entry.strokes[index];
      if (!stroke) return;
      next[index] = make(stroke);
    });
    if (sameStrokes(before, next)) return false;
    snapshot(key);
    entry.strokes = next;
    selection.box = selectionBox(key, selection.indices);
    repaint(key);
    onCommit(key, entry.strokes.slice(), { reason });
    return true;
  }

  // The colour and the nib of what is already on the page. A press on a swatch
  // or a nib while something is lassoed means "make THIS that", which is what
  // anyone who has used a drawing tool expects it to mean — and the rail needed
  // no new buttons for it, which is why it is the first of these.
  function restyleSelection({ pen: nextPen = null, width: nextWidth = null } = {}) {
    const c = nextPen === null ? null : normalizeInkPen(nextPen);
    const w = nextWidth === null ? null : normalizeInkWidth(nextWidth);
    if (c === null && w === null) return false;
    return mapSelection((stroke) => {
      // Returned UNCHANGED when it already says the right thing, so mapSelection's
      // identity compare can refuse the whole gesture — a press on the colour a
      // selection is already in must not cost an undo step or a write.
      const recolour = c !== null && stroke.c !== c;
      const renib = w !== null && stroke.w !== w;
      if (!recolour && !renib) return stroke;
      const next = { ...stroke };
      if (recolour) next.c = c;
      if (renib) next.w = w;
      return next;
    }, "restyle");
  }

  // Move by a fixed step, for the arrow keys. A drag is a pointer gesture and a
  // pointer is not always what somebody has: this is the same transform, and one
  // undo step per press, which is what makes a nudge correctable.
  function nudgeSelection(dx, dy) {
    if (!dx && !dy) return false;
    return mapSelection((stroke) => transformInkStroke(stroke, { dx, dy }), "move");
  }

  // Turn what is selected about the middle of its own box. The grip drives this
  // continuously; it is also what a "rotate 90°" would call if one is ever added.
  function rotateSelection(theta, origin) {
    if (!theta) return false;
    const box = origin || selection?.box;
    if (!box) return false;
    const originX = (box.minX + box.maxX) / 2;
    const originY = (box.minY + box.maxY) / 2;
    return mapSelection((stroke) => transformInkStroke(stroke, { theta, originX, originY }), "rotate");
  }

  // ── Copying, which the engine does NOT keep ──────────────────────────────
  //
  // copySelection hands the strokes BACK rather than holding them, and paste
  // takes them as an argument. That looks like a needlessly long way round until
  // you ask how long an engine lives: it is destroyed and rebuilt whenever the
  // document under it changes, and on a notebook that happens every time a page
  // is added — which is exactly the gesture between "copy this working" and
  // "paste it on the new page". A buffer inside the engine would be emptied by
  // the very act the reader performed in order to use it. The caller that
  // outlives the document holds it (src/documents/pdf-ink.js).
  //
  // The mark ids are stripped on the way out: a pasted copy is a new mark, with
  // its own note and its own card, or the two pieces would share one and editing
  // either would edit both. commitInkPage gives an untagged stroke a fresh mark.
  function copySelection() {
    const strokes = selectedStrokes();
    if (!strokes.length) return null;
    return {
      box: inkStrokesBounds(strokes),
      strokes: strokes.map((stroke) => { const { m, ...rest } = stroke; return { ...rest, p: stroke.p.slice() }; })
    };
  }

  function cutSelection() {
    const clip = copySelection();
    if (!clip) return null;
    return deleteSelection() ? clip : null;
  }

  // Pasted onto `key` — whichever page the reader is looking at, which is not
  // necessarily the one it was copied from. Placed at `at` when the caller knows
  // where the reader is pointing, and otherwise offset from where it was taken:
  // a copy that lands exactly on top of its original looks like nothing
  // happened, and then a drag moves the wrong one.
  function pasteStrokes(key, clip, at = null) {
    const entry = hosts.get(key);
    if (!entry || !clip?.strokes?.length) return false;
    const box = clip.box;
    const dx = at && box ? at.x - ((box.minX + box.maxX) / 2) : INK_PASTE_OFFSET;
    const dy = at && box ? at.y - ((box.minY + box.maxY) / 2) : INK_PASTE_OFFSET;
    const added = clip.strokes.map((stroke) => transformInkStroke(stroke, { dx, dy }));
    snapshot(key);
    const first = entry.strokes.length;
    entry.strokes = entry.strokes.concat(added);
    // Selected on arrival, so the very next drag moves what was just pasted
    // rather than making the reader find it and lasso it again.
    setSelection({ key, indices: added.map((_, i) => first + i), box: selectionBox(key, added.map((_, i) => first + i)) });
    repaint(key);
    onCommit(key, entry.strokes.slice(), { reason: "paste" });
    return true;
  }

  // A copy in place, which is the same thing without the round trip through the
  // clipboard — and, unlike a paste, it leaves whatever the reader had copied
  // earlier alone.
  function duplicateSelection() {
    if (!selection) return false;
    const key = selection.key;
    const entry = hosts.get(key);
    const strokes = selectedStrokes();
    if (!entry || !strokes.length) return false;
    const added = strokes.map((stroke) => {
      const { m, ...rest } = stroke;
      return transformInkStroke({ ...rest, p: stroke.p.slice() }, { dx: INK_PASTE_OFFSET, dy: INK_PASTE_OFFSET });
    });
    snapshot(key);
    const first = entry.strokes.length;
    entry.strokes = entry.strokes.concat(added);
    const indices = added.map((_, i) => first + i);
    setSelection({ key, indices, box: selectionBox(key, indices) });
    repaint(key);
    onCommit(key, entry.strokes.slice(), { reason: "duplicate" });
    return true;
  }

  return {
    attachHost,
    detachHost,
    forgetHost,
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
    restyleSelection,
    nudgeSelection,
    rotateSelection,
    duplicateSelection,
    copySelection,
    cutSelection,
    pasteStrokes,
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
    getEraseMode: () => eraseMode,
    setEraseMode: (next) => { eraseMode = normalizeInkEraseMode(next); onToolChange({ tool, pen, width }); },
    getEraserSize: () => eraserSize,
    setEraserSize: (next) => { eraserSize = normalizeInkEraserSize(next); onToolChange({ tool, pen, width }); },
    getSnapShapes: () => snapShapes,
    setSnapShapes: (on) => { snapShapes = Boolean(on); onToolChange({ tool, pen, width }); },
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
