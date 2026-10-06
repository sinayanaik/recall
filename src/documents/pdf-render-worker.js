// PDF pages, drawn in a worker.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// Six rounds of work went into making pdf.js's page drawing cost the main thread
// less, and the readout from the phone after the last of them said why it was
// never going to be enough: on a 6-page, 3.6MB paper of figures, "draw one page:
// median 626ms, p90 2.2s, worst 7.1s", with 7ms of it waiting for pdf.js's worker
// and all the rest DRAWING — on the main thread, into a canvas — and 10.7s of
// slow frames under the reader's finger spent in main-thread work that was not
// even script: the thread blocked inside canvas and GPU calls. A CPU canvas cost
// 0.7–1.7s a page on that paper; a GPU one 0.6–7s. Whichever way the main
// thread draws a page, the reader's scroll waits for it.
//
// So pages are not drawn on the main thread at all. pdf.js's drawing code runs
// here, in a worker, onto an OffscreenCanvas, and what crosses back is a
// finished ImageBitmap — transferred, not copied — that the page shows in a
// `bitmaprenderer` canvas. Swapping it in is a pointer move. However long a page
// takes, it takes it on another core, and the reader keeps scrolling the
// stretched or blank page they already have until it lands.
//
// ── How pdf.js 3.11 is talked into running here ───────────────────────────
//
// Its drawing code (CanvasGraphics) reaches the DOM only through things
// getDocument lets a caller replace, checked against the 3.11.174 source:
//
//   • canvasFactory   its scratch canvases (masks, scaled images, patterns) —
//                     an OffscreenCanvas factory instead of createElement;
//   • ownerDocument   only `.fonts` is used for a file's embedded fonts
//                     (FontLoader), so the worker's own FontFaceSet stands in;
//   • filterFactory   the DOM one builds SVG filters for transfer functions; a
//                     stub answering "none" is what BaseFilterFactory does;
//   • the core worker is handed over as a PORT (new PDFWorker({ port })), which
//                     skips the window.location lookup PDFWorker otherwise makes.
//
// With no `window`, pdf.js schedules its drawing slices with microtasks, which
// would never let a cancel message in; each slice therefore yields through a
// MessageChannel, so "stop drawing that page" is heard between slices.
//
// Dark page is drawn into the pixels here too (the same filtered copy the main
// thread made in bakePagePaper), at no cost to the reader's frames.
//
// ── And when it cannot ─────────────────────────────────────────────────────
//
// No OffscreenCanvas, no FontFaceSet in workers, no nested workers, pdf.js not
// to be had as a same-origin URL, or anything thrown on the way: the renderer
// reports itself unavailable with the reason, and pages are drawn on the main
// thread exactly as before. `recall:pdfRenderWorker` = "0" in localStorage forces
// that, so the two can be compared from App Info on the device itself.

import { pdfjsWorkerSources } from "../core/lib-loader.js?v=__BUILD__";

export const PDF_RENDER_WORKER_KEY = "recall:pdfRenderWorker";

// How long the worker has to load pdf.js and say it is ready.
export const PDF_RENDER_WORKER_START_MS = 8000;

// ── The worker itself ───────────────────────────────────────────────────────
//
// Shipped as the source of this function, in a Blob: one module, nothing new to
// precache or version, and the code that runs in the worker sits beside the code
// that talks to it. It must not close over anything outside itself.
function pageRendererWorker() {
  "use strict";
  let lib = null;
  let core = null;
  let cpu = true;
  let canDark = false;
  const docs = new Map();
  const tasks = new Map();
  const cancelled = new Set();

  const post = (message, transfer) => self.postMessage(message, transfer || []);

  // A zero-delay yield to the event loop: setTimeout(0) is clamped to 4ms once
  // nested, which on 15ms slices would be a quarter of the drawing time.
  const channel = new MessageChannel();
  const pendingYields = [];
  channel.port1.onmessage = () => { const next = pendingYields.shift(); if (next) next(); };
  const yieldThen = (fn) => { pendingYields.push(fn); channel.port2.postMessage(0); };

  class CanvasFactory {
    create(width, height) {
      if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
      const canvas = new OffscreenCanvas(width, height);
      return { canvas, context: canvas.getContext("2d", cpu ? { willReadFrequently: true } : undefined) };
    }
    reset(canvasAndContext, width, height) {
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    }
    destroy(canvasAndContext) {
      if (canvasAndContext.canvas) {
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
      }
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    }
  }

  const filterFactory = {
    addFilter: () => "none",
    addHCMFilter: () => "none",
    addHighlightHCMFilter: () => "none",
    destroy() {}
  };

  const ownerDocument = {
    fonts: self.fonts,
    createElement() { throw new Error("no DOM in the page renderer"); }
  };

  const DARK_FILTER = "invert(1) hue-rotate(180deg)";

  function probeDark() {
    try {
      const canvas = new OffscreenCanvas(1, 1);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx || !("filter" in ctx)) return false;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1, 1);
      ctx.filter = DARK_FILTER;
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(canvas, 0, 0);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return r < 16 && g < 16 && b < 16;
    } catch (_) {
      return false;
    }
  }

  // The same two filters the CSS applies, once, into the pixels — and floored
  // at #030303 so a dark page is never PURE black, which is how the main thread
  // recognises a canvas the browser cleared.
  function bakeDark(canvas, ctx) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = DARK_FILTER;
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "lighten";
    ctx.fillStyle = "#030303";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function cancelledError(job) {
    const error = new Error(`Rendering cancelled, job ${job}`);
    error.name = "RenderingCancelledException";
    return error;
  }

  // ── Recorded drawing, replayed ─────────────────────────────────────────────
  //
  // The reader's marks are painted by the app's own code (paintRegionMarks,
  // paintInkLayers) against a RECORDING context on the main thread, where theme
  // colours resolve; what arrives here is the list of calls. `["=prop", value]`
  // sets a property, `[method, ...args]` calls one, and the two layer markers
  // paint a group onto a scratch canvas and blend it back ONCE — the way the
  // page's mark layer is blended as one group on screen, so two overlapping
  // highlights read as one rather than darkening twice.
  function replayOps(canvas, base, ops) {
    let ctx = base;
    const stack = [];
    for (const op of ops || []) {
      const [name, ...args] = op;
      if (name === "layer:begin") {
        const scratch = new OffscreenCanvas(canvas.width, canvas.height);
        const sctx = scratch.getContext("2d");
        stack.push({ ctx, scratch });
        ctx = sctx;
        continue;
      }
      if (name === "layer:end") {
        const top = stack.pop();
        if (!top) continue;
        ctx = top.ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = args[0] || "source-over";
        ctx.drawImage(top.scratch, 0, 0);
        ctx.restore();
        top.scratch.width = 0;
        continue;
      }
      if (name.charCodeAt(0) === 61 /* = */) {
        try { ctx[name.slice(1)] = args[0]; } catch (_) { /* unsupported property */ }
        continue;
      }
      const fn = ctx[name];
      if (typeof fn === "function") fn.apply(ctx, args);
    }
  }

  function encode(canvas, quality) {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }

  // A page drawn for keeping: `width` device pixels across, dark page baked in
  // if asked, encoded as a JPEG — the PLAIN picture — and then, when there are
  // marks, the same pixels with them painted on, encoded again: the MARKED one.
  // The drawing data pdf.js kept for the page is handed back at once; the page
  // is drawn once per paper per device, not once per zoom, so nothing is gained
  // by holding it.
  async function renderPicture(message) {
    const { job, id, pageNumber, width, dark, ops, quality } = message;
    const doc = docs.get(id);
    if (!doc) throw new Error("that document is not open in the page renderer");
    const started = performance.now();
    const page = await doc.getPage(pageNumber);
    if (cancelled.has(job)) throw cancelledError(job);
    const unit = page.getViewport({ scale: 1 });
    const scale = width / unit.width;
    const viewport = page.getViewport({ scale });
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    const task = page.render({ canvasContext: ctx, viewport });
    let firstSliceAt = 0;
    task.onContinue = (proceed) => {
      if (!firstSliceAt) firstSliceAt = performance.now();
      yieldThen(proceed);
    };
    tasks.set(job, task);
    try {
      await task.promise;
    } finally {
      tasks.delete(job);
      try { page.cleanup(); } catch (_) { /* still busy: the next cleanup has it */ }
    }
    if (cancelled.has(job)) throw cancelledError(job);
    const drawnAt = performance.now();
    const baked = Boolean(dark && canDark);
    if (baked) bakeDark(canvas, ctx);
    const plain = await encode(canvas, quality);
    let marked = null;
    if (ops && ops.length) {
      replayOps(canvas, ctx, ops);
      marked = await encode(canvas, quality);
    }
    const encodedAt = performance.now();
    canvas.width = 0;
    post({
      type: "picture",
      job,
      plain,
      marked,
      width: viewport.width,
      height: viewport.height,
      pixelWidth: Math.round(viewport.width),
      pixelHeight: Math.round(viewport.height),
      dark: baked,
      firstSliceMs: firstSliceAt ? firstSliceAt - started : drawnAt - started,
      drawMs: firstSliceAt ? drawnAt - firstSliceAt : 0,
      encodeMs: encodedAt - drawnAt
    });
  }

  // A picture made from another one, with no pdf.js in it: the plain picture of
  // a page decoded, optionally cropped and scaled, dark page baked in if the
  // source was light and the result is not, the marks painted on, and encoded.
  // What a new highlight, a dark page toggle and a region's picture cost once
  // the page has been drawn: a decode and an encode.
  async function composePicture(message) {
    const { job, source, crop, outWidth, outHeight, bakeDarkPage, ops, quality, as } = message;
    const started = performance.now();
    const bitmap = crop
      ? await createImageBitmap(source, crop.x, crop.y, crop.width, crop.height)
      : await createImageBitmap(source);
    const width = Math.max(1, Math.round(outWidth || bitmap.width));
    const height = Math.max(1, Math.round(outHeight || bitmap.height));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    if (bakeDarkPage && canDark) bakeDark(canvas, ctx);
    if (ops && ops.length) replayOps(canvas, ctx, ops);
    let blob = null;
    let image = null;
    if (as === "bitmap") image = canvas.transferToImageBitmap();
    else blob = await encode(canvas, quality);
    canvas.width = 0;
    post({ type: "composed", job, blob, bitmap: image, width, height, ms: performance.now() - started }, image ? [image] : []);
  }

  async function render(message) {
    const { job, id, pageNumber, scale, outputScale, region, density, dark } = message;
    const doc = docs.get(id);
    if (!doc) throw new Error("that document is not open in the page renderer");
    const started = performance.now();
    const page = await doc.getPage(pageNumber);
    if (cancelled.has(job)) throw cancelledError(job);
    const viewport = page.getViewport({ scale });
    let width;
    let height;
    let transform;
    if (region) {
      width = Math.max(1, Math.floor(region.width * density));
      height = Math.max(1, Math.floor(region.height * density));
      transform = [density, 0, 0, density, -region.x * density, -region.y * density];
    } else {
      width = Math.max(1, Math.floor(viewport.width * outputScale));
      height = Math.max(1, Math.floor(viewport.height * outputScale));
      transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", cpu ? { alpha: false, willReadFrequently: true } : { alpha: false });
    const task = page.render({ canvasContext: ctx, viewport, transform });
    let firstSliceAt = 0;
    task.onContinue = (proceed) => {
      if (!firstSliceAt) firstSliceAt = performance.now();
      yieldThen(proceed);
    };
    tasks.set(job, task);
    try {
      await task.promise;
    } finally {
      tasks.delete(job);
    }
    if (cancelled.has(job)) throw cancelledError(job);
    const drawnAt = performance.now();
    const baked = Boolean(dark && canDark);
    if (baked) bakeDark(canvas, ctx);
    const bitmap = canvas.transferToImageBitmap();
    post({
      type: "rendered",
      job,
      bitmap,
      dark: baked,
      firstSliceMs: firstSliceAt ? firstSliceAt - started : drawnAt - started,
      drawMs: firstSliceAt ? drawnAt - firstSliceAt : 0
    }, [bitmap]);
  }

  self.onmessage = async (event) => {
    const message = event.data || {};
    try {
      switch (message.type) {
        case "init": {
          cpu = message.cpu !== false;
          if (typeof OffscreenCanvas !== "function") throw new Error("no OffscreenCanvas in workers");
          if (!self.fonts || typeof self.fonts.add !== "function") throw new Error("no FontFaceSet in workers");
          if (typeof Worker !== "function") throw new Error("no nested workers");
          importScripts(message.library);
          lib = self.pdfjsLib;
          if (!lib?.getDocument || !lib?.PDFWorker) throw new Error("pdf.js did not load in the worker");
          core = new lib.PDFWorker({ name: "recall-render-core", port: new Worker(message.core) });
          canDark = probeDark();
          // Kept pictures need an encoder here and a decoder for blobs; without
          // either, pages are shown the canvas way.
          const canPicture = typeof OffscreenCanvas.prototype.convertToBlob === "function"
            && typeof self.createImageBitmap === "function";
          post({ type: "ready", version: lib.version, canDark, canPicture });
          break;
        }
        case "open": {
          // The paper's content hash, when the record carries none: it is what
          // the picture store is keyed by. Taken here, off the main thread,
          // and BEFORE getDocument, which transfers the bytes away.
          let sha = "";
          if (message.hash && self.crypto?.subtle) {
            try {
              const digest = await self.crypto.subtle.digest("SHA-256", message.data);
              sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
            } catch (_) { /* no hash: no kept pictures for this paper */ }
          }
          const loading = lib.getDocument({
            data: message.data,
            worker: core,
            isEvalSupported: false,
            isOffscreenCanvasSupported: true,
            ownerDocument,
            canvasFactory: new CanvasFactory(),
            filterFactory
          });
          docs.set(message.id, await loading.promise);
          post({ type: "opened", id: message.id, sha });
          break;
        }
        case "render":
          await render(message);
          break;
        case "picture":
          await renderPicture(message);
          break;
        case "compose":
          await composePicture(message);
          break;
        case "cancel": {
          cancelled.add(message.job);
          const task = tasks.get(message.job);
          if (task) task.cancel();
          break;
        }
        case "cleanup": {
          const doc = docs.get(message.id);
          if (doc) doc.getPage(message.pageNumber).then((page) => { try { page.cleanup(); } catch (_) { /* busy */ } }, () => {});
          break;
        }
        case "close": {
          const doc = docs.get(message.id);
          docs.delete(message.id);
          if (doc) doc.destroy().catch(() => {});
          break;
        }
        // Everything pdf.js holds for the document beyond its structure: fonts,
        // images, operator lists. After a batch of kept pictures nothing will be
        // drawn from it for a while, perhaps ever.
        case "cleanupDocument": {
          const doc = docs.get(message.id);
          if (doc) doc.cleanup().catch(() => {});
          break;
        }
        default:
          break;
      }
    } catch (error) {
      if (message.job != null) cancelled.delete(message.job);
      post({
        type: "error",
        request: message.type,
        job: message.job ?? null,
        id: message.id ?? null,
        name: error?.name || "Error",
        message: String(error?.message || error)
      });
    } finally {
      if (message.type === "render" || message.type === "picture" || message.type === "compose") cancelled.delete(message.job);
    }
  };
}

// ── The main thread's side ──────────────────────────────────────────────────

let rendererWorker = null;
let rendererStarting = null;
let rendererReady = false;
let rendererBakesDark = false;
let rendererKeepsPictures = false;
// The content hash the renderer took of each document it opened, by id.
const renderDocShas = new Map();
// Why the renderer is not in use, for App Info — empty while it is.
let rendererUnavailable = "not started";
// Once it has failed at something, it is not started again until the app is
// reloaded: a renderer that fails on every open would cost every open a retry.
let failedThisSession = false;
let nextJob = 1;
let nextDoc = 1;
const rendererJobs = new Map();
const rendererOpening = new Map();
// Jobs the worker has been sent and not yet answered — a cancelled one too,
// since a cancel lands only between pdf.js slices and an encode or a decode
// runs to its end regardless. This, not rendererJobs, is how busy it is.
const workerJobsOut = new Set();

export function pageRendererActive() {
  return rendererReady && Boolean(rendererWorker);
}

export function pageRendererBakesDark() {
  return pageRendererActive() && rendererBakesDark;
}

// Whether the renderer can draw pages for keeping (src/documents/pdf-pictures.js):
// an encoder for its OffscreenCanvas and a blob decoder.
export function pageRendererKeepsPictures() {
  return pageRendererActive() && rendererKeepsPictures;
}

export function renderDocumentSha(id) {
  return renderDocShas.get(id) || "";
}

// Jobs sent to the renderer and not answered yet — pages, pictures, composes,
// detail tiles, and cancelled ones it is still finishing. Work drawn AHEAD of
// the reader starts only when this is 0 (src/documents/pdf-view.js,
// runPrerender): a worker job cannot be stopped mid-encode, and one started
// just before the reader touches the paper is one the page they want waits
// behind.
export function pageRendererBusy() {
  return workerJobsOut.size;
}

export function pageRendererStatus() {
  return pageRendererActive() ? "" : rendererUnavailable;
}

function turnedOffHere() {
  try { return localStorage.getItem(PDF_RENDER_WORKER_KEY) === "0"; } catch (_) { return false; }
}

// Stop using the renderer for the rest of the session. Every job still out is
// failed, so its page falls back to the main thread rather than waiting.
export function pageRendererFailed(reason) {
  failedThisSession = true;
  rendererUnavailable = reason || "it failed";
  rendererReady = false;
  const was = rendererWorker;
  rendererWorker = null;
  rendererStarting = null;
  rendererJobs.forEach((job) => job.reject(Object.assign(new Error(rendererUnavailable), { name: "PageRendererUnavailable" })));
  rendererJobs.clear();
  workerJobsOut.clear();
  rendererOpening.forEach((pending) => pending.resolve(null));
  rendererOpening.clear();
  try { was?.terminate(); } catch (_) { /* already gone */ }
  console.warn(`PDF pages will be drawn on the main thread: ${rendererUnavailable}`);
}

function onWorkerMessage(event) {
  const message = event.data || {};
  if (message.job != null) workerJobsOut.delete(message.job);
  if (message.type === "picture" || message.type === "composed") {
    const job = rendererJobs.get(message.job);
    rendererJobs.delete(message.job);
    if (!job) {
      try { message.bitmap?.close(); } catch (_) { /* nothing to free */ }
      return;
    }
    job.resolve(message);
    return;
  }
  if (message.type === "rendered") {
    const job = rendererJobs.get(message.job);
    rendererJobs.delete(message.job);
    if (!job) {
      try { message.bitmap?.close(); } catch (_) { /* nothing to free */ }
      return;
    }
    job.resolve(message);
    return;
  }
  if (message.type === "opened") {
    const pending = rendererOpening.get(message.id);
    rendererOpening.delete(message.id);
    if (message.sha) renderDocShas.set(message.id, message.sha);
    pending?.resolve(message.id);
    return;
  }
  if (message.type === "error") {
    if ((message.request === "render" || message.request === "picture" || message.request === "compose") && message.job != null) {
      const job = rendererJobs.get(message.job);
      rendererJobs.delete(message.job);
      if (!job) return;
      job.reject(Object.assign(new Error(message.message), { name: message.name }));
      return;
    }
    if (message.request === "open") {
      const pending = rendererOpening.get(message.id);
      rendererOpening.delete(message.id);
      console.warn("The page renderer could not open the document", message.message);
      pending?.resolve(null);
    }
  }
}

// Start the renderer once for the session. Resolves true when pages can be drawn
// in it, false (with the reason in pageRendererStatus) when they cannot.
export function startPageRenderer() {
  if (rendererReady && rendererWorker) return Promise.resolve(true);
  if (rendererStarting) return rendererStarting;
  rendererStarting = (async () => {
    if (failedThisSession) return false;
    if (turnedOffHere()) {
      rendererUnavailable = `turned off on this device (${PDF_RENDER_WORKER_KEY})`;
      return false;
    }
    if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function" || typeof ImageBitmap !== "function") {
      rendererUnavailable = "this browser has no OffscreenCanvas";
      return false;
    }
    const sources = await pdfjsWorkerSources();
    if (!sources) {
      rendererUnavailable = "pdf.js could not be handed to a rendererWorker";
      return false;
    }
    let url = "";
    try {
      url = URL.createObjectURL(new Blob([`(${pageRendererWorker.toString()})();`], { type: "text/javascript" }));
      const created = new Worker(url, { name: "recall-page-renderer" });
      const answer = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ type: "error", message: "it did not start in time" }), PDF_RENDER_WORKER_START_MS);
        created.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data || {});
        };
        created.onerror = (event) => {
          clearTimeout(timer);
          resolve({ type: "error", message: event?.message || "it could not start" });
        };
        created.postMessage({ type: "init", library: sources.library, core: sources.core, cpu: true });
      });
      if (answer.type !== "ready") {
        try { created.terminate(); } catch (_) { /* never started */ }
        rendererUnavailable = answer.message || "it could not start";
        return false;
      }
      created.onmessage = onWorkerMessage;
      created.onerror = (event) => pageRendererFailed(event?.message || "the rendererWorker stopped");
      rendererWorker = created;
      rendererBakesDark = Boolean(answer.canDark);
      rendererKeepsPictures = Boolean(answer.canPicture);
      rendererReady = true;
      rendererUnavailable = "";
      return true;
    } catch (error) {
      rendererUnavailable = String(error?.message || error);
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (!rendererReady) rendererStarting = null;
    }
  })();
  return rendererStarting;
}

// Hand the renderer its own copy of a document's bytes. Resolves the id to
// render it by, or null when it could not be opened there.
// `hash` asks the renderer to take the bytes' SHA-256 on the way in, for a paper
// whose record carries none (renderDocumentSha reads it back).
export function openRenderDocument(bytes, { hash = false } = {}) {
  if (!pageRendererActive() || !bytes) return Promise.resolve(null);
  const id = nextDoc++;
  return new Promise((resolve) => {
    rendererOpening.set(id, { resolve });
    rendererWorker.postMessage({ type: "open", id, data: bytes, hash }, [bytes.buffer]);
  });
}

export function closeRenderDocument(id) {
  if (id == null || !rendererWorker) return;
  renderDocShas.delete(id);
  rendererWorker.postMessage({ type: "close", id });
}

export function cleanupRenderDocument(id) {
  if (id == null || !rendererWorker) return;
  rendererWorker.postMessage({ type: "cleanupDocument", id });
}

function rendererJob(message) {
  if (!pageRendererActive()) {
    return { promise: Promise.reject(Object.assign(new Error(rendererUnavailable), { name: "PageRendererUnavailable" })), cancel() {} };
  }
  const job = nextJob++;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    rendererJobs.set(job, {
      resolve: (value) => { settled = true; resolve(value); },
      reject: (error) => { settled = true; reject(error); }
    });
  });
  workerJobsOut.add(job);
  rendererWorker.postMessage({ ...message, job });
  return {
    promise,
    cancel() {
      if (settled) return;
      const pending = rendererJobs.get(job);
      rendererJobs.delete(job);
      rendererWorker?.postMessage({ type: "cancel", job });
      pending?.reject(Object.assign(new Error(`Rendering cancelled, job ${job}`), { name: "RenderingCancelledException" }));
    }
  };
}

// Draw one page for keeping: `width` device pixels across, dark page baked in
// when `dark`, and — when `ops` (recorded mark drawing, see
// src/render/canvas-record.js) are given — a second, marked picture as well.
// Resolves { plain, marked, width, height, pixelWidth, pixelHeight, dark,
// firstSliceMs, drawMs, encodeMs }, the pictures as JPEG blobs.
export function renderPagePicture({ id, pageNumber, width, dark = false, ops = null, quality = 0.9 }) {
  return rendererJob({ type: "picture", id, pageNumber, width, dark, ops, quality });
}

// Make a picture from a kept one, no pdf.js involved: `source` (a blob)
// decoded, cropped to `crop` (source pixels) if given, scaled to
// outWidth × outHeight, dark page baked in when `bakeDarkPage`, `ops` painted
// on. Resolves { blob } — or { bitmap } with `as: "bitmap"`.
export function composePagePicture({ source, crop = null, outWidth = 0, outHeight = 0, bakeDarkPage = false, ops = null, quality = 0.9, as = "blob" }) {
  return rendererJob({ type: "compose", source, crop, outWidth, outHeight, bakeDarkPage, ops, quality, as });
}

export function cleanupRenderPage(id, pageNumber) {
  if (id == null || !rendererWorker) return;
  rendererWorker.postMessage({ type: "cleanup", id, pageNumber });
}

// Draw one page (or, with `region` and `density`, the detail tile over part of
// one). Resolves { bitmap, dark, firstSliceMs, drawMs }; a cancel rejects with a
// RenderingCancelledException, as a pdf.js render task does.
export function renderPageBitmap({ id, pageNumber, scale, outputScale = 1, region = null, density = 1, dark = false }) {
  if (!pageRendererActive()) {
    return { promise: Promise.reject(Object.assign(new Error(rendererUnavailable), { name: "PageRendererUnavailable" })), cancel() {} };
  }
  const job = nextJob++;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    rendererJobs.set(job, {
      resolve: (value) => { settled = true; resolve(value); },
      reject: (error) => { settled = true; reject(error); }
    });
  });
  workerJobsOut.add(job);
  rendererWorker.postMessage({ type: "render", job, id, pageNumber, scale, outputScale, region, density, dark });
  return {
    promise,
    cancel() {
      if (settled) return;
      const pending = rendererJobs.get(job);
      rendererJobs.delete(job);
      rendererWorker?.postMessage({ type: "cancel", job });
      pending?.reject(Object.assign(new Error(`Rendering cancelled, page ${pageNumber}`), { name: "RenderingCancelledException" }));
    }
  };
}
