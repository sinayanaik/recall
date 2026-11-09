// Recall Web Clipper — Save as PDF, run from the background service worker.
//
// One job per tab: attach the DevTools protocol to the tab, prepare the page in
// an isolated world (content/prepare.js), lay it out at the chosen width, print
// it with Page.printToPDF (a real vector PDF with selectable text), put the
// page back, stamp Recall's metadata into the PDF and save it with
// chrome.downloads.
//
// What makes a printed web page heavy to open is mostly what Chrome cannot
// draw as vectors, so the job keeps those out of the PDF:
// - pictures are re-encoded at the size they print (shrinkImages), read
//   through the debugger, so pictures from other sites need no permission;
// - shadows and blur filters are switched off (content/prepare.js), since
//   each one would become a 300-DPI picture of its own;
// - text in a variable web font is printed in the page's fallback font
//   (variableFamilies), since Chrome embeds a variable font as a Type 3 font;
// - bookmarks come from named destinations (lib/pdf-outline.js), so the PDF
//   need not be tagged — tagging a long page makes it several times bigger.
//
// Running in the service worker rather than the popup means closing the popup
// — or clicking the page to pick a block or move a page break — never kills a
// job.
//
// A job never gets stuck:
// - every DevTools call has a time limit and gives up at once when the job is
//   cancelled (send);
// - the reader's steps ("Pick a block", the break editor) are polled with
//   short calls (waitForUser) instead of one call left open for minutes, which
//   Chrome could answer by stopping the service worker;
// - a watchdog stops a job that has made no progress for a while, and any job
//   that has run far too long;
// - whatever ends a job — done, error, Cancel, timeout, the tab closed, the
//   debugging bar's Cancel — one cleanup puts the page back and detaches, each
//   step of it time-limited, and only then is the tab free for the next job;
// - the job's state is mirrored in chrome.storage.session, so if Chrome does
//   stop the worker the popup can still say so, and the next start cleans up.
//
// Saving tells the truth: the PDF goes to chrome.downloads as a blob: address
// (from offscreen.html; a data: address only as a fallback), and "Saved" is
// only said once Chrome reports the file complete. If it fails, the PDF is
// kept so "Save again" needs no second print.
//
// While attached, Chrome shows its "started debugging this browser" bar on the
// tab; it goes away when the job detaches.

import { setPdfInfo, countPages } from "./lib/pdf-info.js";
import { trimPageHeights, pageHeightsFromMarkers } from "./lib/pdf-pages.js";
import { addOutline } from "./lib/pdf-outline.js";
import { isVariableFont, fontFaces } from "./lib/font-check.js";
import { imagesToPdf } from "./lib/image-pdf.js";
import { isAnimatedImage } from "./lib/animated.js";
import {
  normalize, geometry, imageSettings, fileNameFor, folderFor, pageContentPx,
  MAX_PAGE_IN, CSS_PX_PER_IN, SMART_SLACK_IN
} from "./lib/options.js";

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source|file):/i;
const STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

// Time limits, in ms. One object, so the browser check can shorten them.
export const LIMITS = {
  call: 60000,              // one DevTools call
  print: 300000,            // one Page.printToPDF
  poll: 5000,               // one look at the on-page UI
  pollEvery: 300,
  missedPolls: 3,           // in a row, then the page is taken to be frozen
  stall: 180000,            // no progress at all
  stallPrinting: 360000,    // … while Chrome prints
  total: 60 * 60000,        // a whole job, editing included
  watchdogEvery: 5000,
  cleanupStep: 5000,        // each step of putting the page back
  pageStale: 15000,         // the on-page UI closes itself after this long without a poll
  mediaFrames: 90000,       // taking pictures of all the videos and embeds on a page
  downloadWait: 120000,     // for Chrome to say a download is complete
  downloadWaitSaveAs: 15 * 60000,
  failDownloads: 0          // checks only: make the next N downloads fail
};
globalThis.__rwcLimits = LIMITS;

const OUT_CACHE = "rwc-out";
const OUT_BASE = "https://recall-clipper.invalid/out/";

class JobError extends Error {
  constructor(message, kind = "error") {
    super(message);
    this.kind = kind; // "error" | "cancelled" | "timeout" | "busy"
  }
}

const RUNNING_PHASES = new Set(["attaching", "preparing", "waiting-pick", "waiting-breaks", "printing"]);
const WAITING_PHASES = new Set(["waiting-pick", "waiting-breaks"]);
const PHASE_WORDS = {
  attaching: "attaching to the page",
  preparing: "preparing the page",
  "waiting-pick": "waiting for you to pick a block",
  "waiting-breaks": "showing the page breaks",
  printing: "printing",
  saving: "saving"
};

const jobs = new Map(); // tabId → job record (newJob)
let nextId = 1;

function newJob(tabId) {
  let resolveFinished;
  const finished = new Promise((r) => { resolveFinished = r; });
  return {
    id: `${Date.now().toString(36)}-${nextId++}`,
    tabId,
    phase: "attaching",
    step: "",
    error: null,
    cancelled: false,
    done: false,
    running: false,
    pages: 0,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    controller: new AbortController(),
    finished,
    resolveFinished,
    evaluate: null, // set once the page side is loaded
    ctx: null,
    saved: null,    // { key, filename, name, saveAs, showAfter, size, pages, cached, retry }
    downloadId: null
  };
}

function publicJob(job) {
  return {
    id: job.id,
    phase: job.phase,
    step: job.step || "",
    error: job.error || null,
    cancelled: Boolean(job.cancelled),
    done: Boolean(job.done),
    running: Boolean(job.running),
    pages: job.pages || 0,
    canSaveAgain: Boolean(job.saved && job.saved.retry)
  };
}

// ---------------------------------------------------------------- status

function status(job, patch) {
  Object.assign(job, patch);
  job.lastProgressAt = Date.now();
  // A newer job on the same tab owns what the popup and badge show.
  if (jobs.get(job.tabId) !== job) return;
  const tabId = job.tabId;
  const pub = publicJob(job);
  chrome.runtime.sendMessage({ type: "rwc-status", tabId, job: pub }).catch(() => {});
  const record = { ...pub, saved: job.saved ? { ...job.saved } : null, downloadId: job.downloadId, at: Date.now() };
  chrome.storage.session.set({ [`job:${tabId}`]: record }).catch(() => {});
  const failed = job.error && !job.cancelled;
  const text = failed ? "!" : job.done ? "✓" : job.running || job.phase === "saving" ? "…" : "";
  chrome.action.setBadgeBackgroundColor({ tabId, color: failed ? "#c62828" : "#4f5bd5" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (!job.running && job.phase !== "saving") {
    setTimeout(() => { if (jobs.get(tabId) === job && !job.running) chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}); }, 8000);
  }
}

// ---------------------------------------------------------------- time limits & cancelling

// `promise`, unless `ms` pass first (then onTimeout()'s error) or `signal`
// aborts first (then its reason).
function limit(promise, ms, onTimeout, signal = null) {
  return new Promise((resolve, reject) => {
    let over = false;
    let timer = null;
    const onAbort = () => end(reject, signal.reason);
    function end(fn, value) {
      if (over) return;
      over = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    }
    timer = setTimeout(() => end(reject, onTimeout()), ms);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    Promise.resolve(promise).then((v) => end(resolve, v), (e) => end(reject, e));
  });
}

const sleep = (ms, signal = null) => limit(new Promise(() => {}), ms, () => null, signal).catch((e) => { if (e) throw e; });

function runningJob(tabId) {
  const job = jobs.get(tabId);
  return job && job.running ? job : null;
}

function isAbort(target, err) {
  const job = jobs.get(target.tabId);
  return Boolean(job && job.controller.signal.aborted) || (err instanceof JobError && err.kind === "cancelled");
}

/** A DevTools call made by a job: time-limited, and given up the moment the job is cancelled. */
function send(target, method, params = {}, ms = LIMITS.call) {
  const job = runningJob(target.tabId);
  const call = chrome.debugger.sendCommand(target, method, params);
  return limit(call, ms, () => new JobError(`The page did not answer in time (${method}).`, "timeout"), job ? job.controller.signal : null)
    .then((r) => { if (job) job.lastProgressAt = Date.now(); return r; });
}

/** A DevTools call made while cleaning up: never cancelled, still time-limited. */
function rawSend(target, method, params = {}, ms = LIMITS.cleanupStep) {
  return limit(chrome.debugger.sendCommand(target, method, params), ms, () => new Error(`${method} timed out`));
}

function abortJob(job, err) {
  if (!job.running || job.controller.signal.aborted) return;
  job.controller.abort(err);
}

// Keeps the service worker awake while a job or a save is under way: each
// extension API call counts as activity.
let keepers = 0;
let keepTimer = null;
function hold() {
  keepers += 1;
  if (!keepTimer) keepTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
}
function release() {
  keepers = Math.max(0, keepers - 1);
  if (!keepers && keepTimer) { clearInterval(keepTimer); keepTimer = null; }
}

// Stops any job that has made no progress for too long, or run too long.
// Polls of the on-page UI count as progress, so a reader taking their time is
// never cut off — a frozen or vanished page is.
let watchdog = null;
function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    const now = Date.now();
    let any = false;
    for (const job of jobs.values()) {
      if (!job.running) continue;
      any = true;
      const stall = job.phase === "printing" ? LIMITS.stallPrinting : LIMITS.stall;
      if (now - job.lastProgressAt > stall) {
        abortJob(job, new JobError(`Stopped: the page stopped responding while ${PHASE_WORDS[job.phase] || "working"}. Reload the page and try again.`, "timeout"));
      } else if (now - job.startedAt > LIMITS.total) {
        abortJob(job, new JobError("Stopped: making this PDF took far too long. Try again, perhaps with Images: Medium.", "timeout"));
      }
    }
    if (!any) { clearInterval(watchdog); watchdog = null; }
  }, LIMITS.watchdogEvery);
}

// ---------------------------------------------------------------- helpers

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

// JPEG pixel size, from its start-of-frame marker.
function jpegSize(bytes) {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

async function sourceOf(path) {
  return (await fetch(chrome.runtime.getURL(path))).text();
}

// ---------------------------------------------------------------- resources

// A resource's bytes, as the page loaded it: from the page's own cache through
// the debugger (Page.getResourceContent — any origin, no CORS, no host
// permission), else fetched the way the page would (Network.loadNetworkResource),
// unless `network` is false. Null when neither works.
async function resourceBytes(target, frameId, url, { network = true } = {}) {
  if (url.startsWith("data:")) {
    const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/.exec(url);
    if (!m) return null;
    try { return m[2] ? b64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])); } catch { return null; }
  }
  try {
    const r = await send(target, "Page.getResourceContent", { frameId, url });
    if (r && r.content != null) return r.base64Encoded ? b64ToBytes(r.content) : new TextEncoder().encode(r.content);
  } catch { /* not in the page's cache */ }
  if (!network) return null;
  try {
    const { resource } = await send(target, "Network.loadNetworkResource", {
      frameId, url, options: { disableCache: false, includeCredentials: true }
    });
    if (!resource || !resource.success || !resource.stream) return null;
    return await readStream(target, resource.stream, 64 * 1048576);
  } catch (err) {
    if (isAbort(target, err)) throw err;
    return null;
  }
}

// A DevTools stream (a fetched resource, or a printed PDF), read to its end in
// chunks — never one huge message — and always closed.
async function readStream(target, handle, maxBytes = Infinity) {
  const parts = [];
  let total = 0;
  let empty = 0;
  try {
    for (;;) {
      const chunk = await send(target, "IO.read", { handle, size: 4 << 20 });
      const bytes = chunk.base64Encoded ? b64ToBytes(chunk.data || "") : new TextEncoder().encode(chunk.data || "");
      parts.push(bytes);
      total += bytes.length;
      if (chunk.eof || total > maxBytes) break;
      // A stream that keeps answering with nothing has ended in all but name.
      empty = bytes.length ? 0 : empty + 1;
      if (empty > 5) break;
    }
  } finally {
    rawSend(target, "IO.close", { handle }).catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  const at = (i, s) => String.fromCharCode(...b.subarray(i, i + s.length)) === s;
  if (at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (at(4, "ftyp") && (at(8, "avif") || at(8, "avis"))) return "avif";
  if (at(0, "<") || at(0, "<?xml") || at(0, "<svg")) return "svg";
  return "other";
}

// Whether a picture has see-through pixels, and whether it is drawn in few
// colours (a diagram or a screenshot of text, which JPEG would smear) — from
// a sample of its pixels.
function inspectPixels(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  const step = Math.max(1, Math.floor((w * h) / 60000));
  let alpha = false;
  const colours = new Set();
  for (let p = 0; p < w * h; p += step) {
    const i = p * 4;
    if (data[i + 3] < 250) alpha = true;
    if (colours.size <= 256) colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    if (alpha && colours.size > 256) break;
  }
  return { alpha, few: colours.size <= 256 };
}

// How wide a picture is drawn, in CSS pixels, given its own pixel size.
function drawnWidth(item, nw, nh, maxCss) {
  const ar = nw / Math.max(1, nh);
  let w = item.cssWidth;
  if (item.fit === "cover") w = Math.max(item.cssWidth, item.cssHeight * ar);
  else if (item.fit === "contain") w = Math.min(item.cssWidth, item.cssHeight * ar);
  return Math.min(w, maxCss * (item.fit === "cover" ? 2 : 1));
}

/**
 * Every picture the print shows, re-encoded at the size it prints: JPEG for a
 * photo, PNG for a picture with see-through pixels or few colours. A JPEG that
 * is already small enough is left as it is. WebP and AVIF are always
 * re-encoded, even at "Original" size: Chrome would store their raw pixels.
 * One result per distinct picture, for every element that shows it.
 */
async function shrinkImages(target, frameId, items, settings, geo, grayscale, moment = "middle") {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.src)) groups.set(item.src, []);
    groups.get(item.src).push(item);
  }
  const queue = [...groups.entries()];
  const results = [];
  const animated = [];
  let shrunk = 0;
  const worker = async () => {
    while (queue.length) {
      const [src, uses] = queue.shift();
      try {
        const bytes = await resourceBytes(target, frameId, src);
        if (!bytes || bytes.length < 64) continue;
        const kind = sniffImage(bytes);
        if (kind === "svg" || kind === "other") continue;
        // A moving picture prints as one still, whatever happens below; it is
        // made a link to its original (linkAnimated in content/prepare.js).
        // Its middle frame then stands in for it: the first is so often blank,
        // a fade-in or a title. (Without one, the still is whichever frame
        // Chrome or the re-encode below lands on — the first, as a rule.)
        let frame = null;
        if (kind !== "jpeg" && isAnimatedImage(bytes)) {
          const ids = uses.filter((u) => u.kind === "img").map((u) => u.id);
          if (ids.length) animated.push({ ids, src });
          if (moment === "middle") frame = await middleFrame(bytes, kind);
        }
        // Original size: only what Chrome would store as raw pixels changes.
        if (!frame && !settings.dpi && kind !== "webp" && kind !== "avif" && !grayscale) continue;
        const bitmap = await createImageBitmap(new Blob([frame || bytes]));
        const nw = bitmap.width;
        const nh = bitmap.height;
        const cssW = Math.max(...uses.map((u) => drawnWidth(u, nw, nh, geo.layoutWidthPx)));
        const targetW = settings.dpi ? Math.max(16, Math.round(((cssW * geo.scale) / CSS_PX_PER_IN) * settings.dpi)) : nw;
        const shrink = nw > targetW * 1.15;
        const w = shrink ? targetW : nw;
        const h = Math.max(1, Math.round((w * nh) / nw));
        if (!shrink && kind === "jpeg" && !grayscale) { bitmap.close(); continue; }
        // Big enough to matter: a small icon is cheap whatever it is.
        if (!frame && !shrink && w * h < 120 * 120 && kind !== "webp" && kind !== "avif") { bitmap.close(); continue; }
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingQuality = "high";
        if (grayscale) ctx.filter = "grayscale(1)";
        ctx.drawImage(bitmap, 0, 0, w, h);
        const { alpha, few } = inspectPixels(ctx, w, h);
        // A PNG or GIF kept at its size and kept lossless gains nothing.
        if (!frame && !shrink && (kind === "png" || kind === "gif") && (alpha || few) && !grayscale) { bitmap.close(); continue; }
        let out;
        if (alpha || few) out = await canvas.convertToBlob({ type: "image/png" });
        else {
          const flat = new OffscreenCanvas(w, h);
          const fctx = flat.getContext("2d");
          fctx.fillStyle = "#fff";
          fctx.fillRect(0, 0, w, h);
          fctx.imageSmoothingQuality = "high";
          if (grayscale) fctx.filter = "grayscale(1)";
          fctx.drawImage(bitmap, 0, 0, w, h);
          out = await flat.convertToBlob({ type: "image/jpeg", quality: settings.jpeg / 100 });
        }
        bitmap.close();
        // Re-encoding a same-size JPEG or PNG that came out bigger: keep the original.
        if (!frame && !shrink && (kind === "jpeg" || kind === "png") && out.size >= bytes.length) continue;
        results.push({ ids: uses.map((u) => u.id), type: out.type, b64: bytesToB64(new Uint8Array(await out.arrayBuffer())) });
        if (shrink) shrunk += uses.length;
      } catch (err) { if (isAbort(target, err)) throw err; /* this one prints as served */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return { results, shrunk, animated };
}

// ---------------------------------------------------------------- videos and embeds

// Whether a picture is one flat colour: a frame that never painted (a lazy
// embed), a protected video drawn black, a video not loaded yet.
async function isBlank(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    const w = Math.min(64, bitmap.width);
    const h = Math.max(1, Math.round((w * bitmap.height) / bitmap.width));
    const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        if (data[i + c] < lo[c]) lo[c] = data[i + c];
        if (data[i + c] > hi[c]) hi[c] = data[i + c];
      }
    }
    return hi.every((v, c) => v - lo[c] <= 12);
  } catch {
    return true;
  } finally {
    if (bitmap) bitmap.close();
  }
}

// The rows of black bars above and below a picture (a 16:9 video in a 4:3
// thumbnail): { top, height } of what is between them, in the picture's pixels.
function withoutBars(bitmap) {
  const w = Math.min(64, bitmap.width);
  const h = Math.min(256, bitmap.height);
  const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const dark = (row) => {
    for (let x = 0; x < w; x += 1) {
      const i = (row * w + x) * 4;
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 24) return false;
    }
    return true;
  };
  let top = 0;
  while (top < h && dark(top)) top += 1;
  let bottom = h;
  while (bottom > top && dark(bottom - 1)) bottom -= 1;
  // All dark, or bars that would leave a sliver: keep the picture whole.
  if (bottom - top < h * 0.4) return { top: 0, height: bitmap.height };
  const k = bitmap.height / h;
  return { top: Math.round(top * k), height: Math.max(1, Math.round((bottom - top) * k)) };
}

// A poster or thumbnail, as a JPEG `width` pixels wide (never wider than it
// is). `trim` takes off black bars above and below; a picture narrower than
// `minWidth` (YouTube's stand-in for a thumbnail it has not got) is null.
async function pictureAsJpeg(bytes, width, quality, grayscale, { trim = false, minWidth = 0 } = {}) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    if (bitmap.width < minWidth) return null;
    const crop = trim ? withoutBars(bitmap) : { top: 0, height: bitmap.height };
    const w = Math.max(16, Math.min(bitmap.width, Math.round(width)));
    const h = Math.max(1, Math.round((w * crop.height) / bitmap.width));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    if (grayscale) ctx.filter = "grayscale(1)";
    ctx.drawImage(bitmap, 0, crop.top, bitmap.width, crop.height, 0, 0, w, h);
    return await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  } finally {
    bitmap.close();
  }
}

// YouTube keeps a picture of every video's middle (…/2.jpg; 1 and 3 are its
// quarters), in up to three sizes. The largest it has, without its bars.
async function youtubeMiddle(target, frameId, videoId, width, settings, grayscale) {
  for (const size of ["maxres2", "sd2", "hq2"]) {
    const raw = await resourceBytes(target, frameId, `https://i.ytimg.com/vi/${videoId}/${size}.jpg`);
    if (!raw || raw.length < 64 || sniffImage(raw) !== "jpeg") continue;
    const blob = await pictureAsJpeg(raw, width, settings.jpeg, grayscale, { trim: true, minWidth: 200 });
    if (blob && !(await isBlank(blob))) return blob;
  }
  return null;
}

/**
 * The addresses of the page's frames that could not load. Such a frame shows
 * Chrome's own error page, which is not blank but is no picture of the video
 * either. A frame from another site runs in a target of its own, out of the
 * tab's frame tree, so those are attached to for a moment and asked too
 * (a child session: Chrome 125 and later; before that, only the tab's own
 * frames are known).
 */
async function unreachableFrames(target) {
  const urls = new Set();
  const walk = (node) => {
    if (node.frame && node.frame.unreachableUrl) urls.add(node.frame.unreachableUrl);
    (node.childFrames || []).forEach(walk);
  };
  try {
    walk((await send(target, "Page.getFrameTree")).frameTree);
  } catch (err) { if (isAbort(target, err)) throw err; }
  const sessions = [];
  const onEvent = (source, method, params) => {
    if (source.tabId === target.tabId && !source.sessionId && method === "Target.attachedToTarget"
      && params && params.targetInfo && params.targetInfo.type === "iframe") sessions.push(params.sessionId);
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await send(target, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await new Promise((r) => setTimeout(r, 150));
    for (const sessionId of sessions) {
      try { walk((await send({ ...target, sessionId }, "Page.getFrameTree")).frameTree); }
      catch (err) { if (isAbort(target, err)) throw err; }
    }
  } catch (err) {
    if (isAbort(target, err)) throw err;
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await rawSend(target, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    for (const sessionId of sessions) await rawSend(target, "Target.detachFromTarget", { sessionId }).catch(() => {});
  }
  return urls;
}

/**
 * A picture of every video, embed and large canvas content/prepare.js marked
 * (handleEmbeds, "frame"): a screenshot of the element as the page shows it —
 * which reaches into frames from other sites and playing videos alike — or,
 * when that comes out one flat colour, the video's poster or YouTube's own
 * thumbnail. Each goes back to the page (swapMedia) in the element's place,
 * linked to the real video; one with no picture becomes the link box.
 */
async function captureFrames(target, frameId, evaluate, items, settings, geo, grayscale, moment = "middle") {
  const results = [];
  const pxPerCss = settings.dpi ? (settings.dpi / CSS_PX_PER_IN) * geo.scale : 2;
  const unreachable = items.some((i) => i.kind === "embed") ? await unreachableFrames(target) : new Set();
  // A page of fifty videos that never load would otherwise wait on each;
  // past this, the rest keep their link box.
  const deadline = Date.now() + LIMITS.mediaFrames;
  for (const item of items) {
    let result = { id: item.id, failed: true };
    if (Date.now() > deadline) { results.push(result); continue; }
    try {
      const box = await evaluate(`__recallPdf.focusMedia(${JSON.stringify(item.id)}, ${JSON.stringify(moment)})`, LIMITS.call);
      if (box && box.width >= 1 && box.height >= 1) {
        const failedToLoad = item.kind === "embed" && item.src && unreachable.has(item.src);
        // Never a huge bitmap: at most about 16 million pixels a picture.
        const area = box.width * box.height;
        const scale = Math.max(0.5, Math.min(2, pxPerCss, Math.sqrt(16e6 / Math.max(1, area))));
        // A YouTube player cannot be moved from another site, but YouTube
        // has a picture of the video's middle.
        const middle = moment === "middle" && item.youtubeId
          ? await youtubeMiddle(target, frameId, item.youtubeId, box.width * scale, settings, grayscale) : null;
        if (middle) {
          results.push({ id: item.id, type: middle.type, b64: bytesToB64(new Uint8Array(await middle.arrayBuffer())) });
          continue;
        }
        const shot = failedToLoad ? null : await send(target, "Page.captureScreenshot", {
          format: "jpeg",
          quality: settings.jpeg,
          clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale },
          captureBeyondViewport: box.height > box.viewportHeight || box.width > box.viewportWidth,
          fromSurface: true
        });
        let bytes = shot && shot.data ? b64ToBytes(shot.data) : null;
        let type = "image/jpeg";
        if (bytes && grayscale) {
          const blob = await pictureAsJpeg(bytes, box.width * scale, settings.jpeg, true);
          bytes = new Uint8Array(await blob.arrayBuffer());
        }
        if (!bytes || await isBlank(new Blob([bytes]))) {
          bytes = null;
          const fallbacks = [item.poster, item.youtubeId ? `https://i.ytimg.com/vi/${item.youtubeId}/hqdefault.jpg` : ""].filter(Boolean);
          for (const url of fallbacks) {
            const raw = await resourceBytes(target, frameId, url);
            if (!raw || raw.length < 64 || ["svg", "other"].includes(sniffImage(raw))) continue;
            const blob = await pictureAsJpeg(raw, box.width * scale, settings.jpeg, grayscale);
            if (await isBlank(blob)) continue;
            bytes = new Uint8Array(await blob.arrayBuffer());
            type = blob.type;
            break;
          }
        }
        if (bytes) result = { id: item.id, type, b64: bytesToB64(bytes) };
      }
    } catch (err) {
      if (isAbort(target, err)) throw err;
      /* this one becomes the link box */
    }
    results.push(result);
  }
  return results;
}

/**
 * The font families the page shows in a variable font: every @font-face in
 * the page's style sheets (read through the CSS domain, so sheets from other
 * sites are readable too), checked by the first of its files the page loaded.
 * Chrome keeps no copy of a font's bytes for Page.getResourceContent, so a
 * loaded font is read again with Network.loadNetworkResource (from the cache,
 * as a rule); files the page never loaded are not fetched.
 */
async function variableFamilies(target, frameId, pageUrl) {
  const headers = [];
  const onEvent = (source, method, params) => {
    if (source.tabId === target.tabId && method === "CSS.styleSheetAdded" && params && params.header) headers.push(params.header);
  };
  chrome.debugger.onEvent.addListener(onEvent);
  const families = new Map();
  try {
    await send(target, "DOM.enable");
    await send(target, "CSS.enable");
    await new Promise((r) => setTimeout(r, 120));
    const loaded = new Set();
    try {
      const { frameTree } = await send(target, "Page.getResourceTree");
      for (const r of frameTree.resources || []) if (r.type === "Font") loaded.add(r.url);
    } catch { /* then nothing is fetched */ }
    const checked = new Map();
    for (const header of headers.slice(0, 300)) {
      if (header.frameId && header.frameId !== frameId) continue;
      let text = "";
      try { ({ text } = await send(target, "CSS.getStyleSheetText", { styleSheetId: header.styleSheetId })); } catch { continue; }
      if (!/@font-face/i.test(text)) continue;
      for (const face of fontFaces(text, header.sourceURL || pageUrl)) {
        const key = face.family.toLowerCase();
        if (families.has(key)) continue;
        // The first file the page loaded decides; files it never needed say nothing.
        const url = face.urls.find((u) => u.startsWith("data:") || loaded.has(u));
        if (!url) continue;
        let variable = checked.get(url);
        if (variable === undefined) {
          const bytes = await resourceBytes(target, frameId, url);
          variable = bytes ? isVariableFont(bytes) : false;
          checked.set(url, variable);
        }
        if (variable) families.set(key, face.family);
      }
    }
  } catch { /* fonts stay as they are */ } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await send(target, "CSS.disable").catch(() => {});
    await send(target, "DOM.disable").catch(() => {});
  }
  return [...families.values()];
}

function mediaFeatures(o) {
  return o.colorScheme === "page" ? [] : [{ name: "prefers-color-scheme", value: o.colorScheme }];
}

function headerFooter(o) {
  const font = `font-size:${o.hfFontSize}px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#555;`;
  const row = (left, right) => `<div style="${font}width:100%;padding:0 0.4in;display:flex;justify-content:space-between;gap:12px;">`
    + `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${left}</span>`
    + `<span style="white-space:nowrap;">${right}</span></div>`;
  const tokens = (text) => String(text)
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
    .replace(/\{title\}/g, '<span class="title"></span>')
    .replace(/\{url\}/g, '<span class="url"></span>')
    .replace(/\{date\}/g, '<span class="date"></span>')
    .replace(/\{page\}/g, '<span class="pageNumber"></span>')
    .replace(/\{pages\}/g, '<span class="totalPages"></span>');
  const pages = '<span class="pageNumber"></span> / <span class="totalPages"></span>';
  const header = {
    none: "<span></span>",
    title: row('<span class="title"></span>', ""),
    url: row('<span class="url"></span>', ""),
    "title-url": row('<span class="title"></span>', '<span class="url"></span>'),
    custom: row(tokens(o.headerCustom), "")
  }[o.header];
  const footer = {
    none: "<span></span>",
    page: row("", pages),
    "date-page": row('<span class="date"></span>', pages),
    "url-page": row('<span class="url"></span>', pages),
    custom: row(tokens(o.footerCustom), "")
  }[o.footer];
  return { header, footer };
}


// ---------------------------------------------------------------- the job

/**
 * Makes and saves the PDF for one tab. Resolves with what was saved, or
 * rejects with a JobError whose message is ready to show. Either way the page
 * is put back and the tab is free again before it settles.
 */
export async function runJob(tabId, rawOptions) {
  await recovered;
  // Checked and claimed without waiting in between, so two quick clicks can
  // never start two jobs on one tab.
  const prev = jobs.get(tabId);
  if (prev && prev.running) {
    const stale = Date.now() - prev.lastProgressAt > LIMITS.stall;
    if (!stale) {
      throw new JobError(WAITING_PHASES.has(prev.phase)
        ? "A PDF is waiting for you on the page: press Save PDF there (or here), or Cancel."
        : "A PDF is already being made for this tab. Wait for it, or press Cancel.", "busy");
    }
    abortJob(prev, new JobError("Stopped: it had stopped responding.", "timeout"));
    await limit(prev.finished, LIMITS.cleanupStep * 4, () => null).catch(() => {});
    if (runningJob(tabId)) throw new JobError("A PDF is already being made for this tab. Wait for it, or press Cancel.", "busy");
  }
  if (prev && prev.saved) dropSaved(prev.saved);

  const job = newJob(tabId);
  job.running = true;
  jobs.set(tabId, job);
  hold();
  startWatchdog();
  const ctx = { target: { tabId }, attachTried: false, attached: false, ready: false, world: null, hiddenFrames: false, restored: true };
  job.ctx = ctx;
  let made = null;
  let failure = null;
  try {
    status(job, { phase: "attaching", step: "Attaching to the page…" });
    made = await makePdf(job, ctx, rawOptions);
  } catch (err) {
    failure = err;
  }
  await cleanup(job, ctx);
  job.running = false;
  job.evaluate = null;
  job.resolveFinished();
  try {
    if (failure) {
      const kind = errorKind(failure, job);
      let message = explain(failure, job);
      if (!ctx.restored) message += " If the page looks wrong, reload it.";
      status(job, { phase: "error", step: message, error: message, cancelled: kind === "cancelled", done: false });
      if (kind !== "cancelled") notify(job, message, true);
      throw new JobError(message, kind);
    }
    try {
      return await saveMade(job, made);
    } catch (err) {
      if (err instanceof JobError) throw err;
      const message = `Could not save the PDF: ${errText(err)}. Try again.`;
      status(job, { phase: "error", step: message, error: message, done: false });
      notify(job, message, true);
      throw new JobError(message);
    }
  } finally {
    release();
  }
}

async function makePdf(job, ctx, rawOptions) {
  const { target, tabId } = { target: ctx.target, tabId: job.tabId };
  const signal = job.controller.signal;
  const o = normalize(rawOptions);
  const geo = geometry(o);
  const settings = imageSettings(o);

  const tab = await limit(chrome.tabs.get(tabId), LIMITS.call, () => new JobError("Chrome did not answer."), signal);
  if (RESTRICTED.test(tab.url || "") || STORE.test(tab.url || "")) throw new JobError("Chrome does not let extensions read this page.");

  await attach(job, ctx);
  const evaluate = async (expression, ms = LIMITS.call) => {
    const r = await send(target, "Runtime.evaluate", { expression, contextId: ctx.world, awaitPromise: true, returnByValue: true, userGesture: true }, ms);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || "page script failed");
    }
    return r.result ? r.result.value : undefined;
  };

  await send(target, "Page.enable");
  const { frameTree } = await send(target, "Page.getFrameTree");
  const frameId = frameTree.frame.id;
  ({ executionContextId: ctx.world } = await send(target, "Page.createIsolatedWorld", {
    frameId, worldName: "Recall Web Clipper"
  }));
  const [coreSrc, prepSrc] = await limit(Promise.all([sourceOf("content/cleaner-core.js"), sourceOf("content/prepare.js")]),
    LIMITS.call, () => new JobError("Could not load the clipper's own files."), signal);
  await evaluate(`${coreSrc}\n;\n${prepSrc}\n;true`);
  ctx.ready = true;
  ctx.restored = false; // from here on the page may hold our changes
  job.evaluate = evaluate;

  if (o.capture === "element") {
    await evaluate(`__recallPdf.pickElement(${LIMITS.pageStale})`);
    status(job, { phase: "waiting-pick", step: "Click the block you want on the page (Esc cancels)…" });
    await waitForUser(job, evaluate);
  }

  // Colour scheme and media type apply to the measuring pass as well as the print.
  status(job, { phase: "preparing", step: "Preparing the page…" });
  await send(target, "Emulation.setEmulatedMedia", { media: o.media === "screen" ? "screen" : "", features: mediaFeatures(o) });
  const report = await evaluate(`__recallPdf.prepare(${JSON.stringify(o)})`,
    LIMITS.call + (o.lazyLoad ? Number(o.lazyWaitMs || 0) + 120000 : 0));
  const facts = report.facts;

  if (o.fonts === "auto" && o.capture !== "visible") {
    status(job, { step: "Checking the fonts…" });
    const families = await variableFamilies(target, frameId, facts.url || tab.url);
    if (families.length) report.fonts = await evaluate(`__recallPdf.replaceFonts(${JSON.stringify(families)})`);
  }

  // In batches of about 4 MB, so no single message gets huge.
  const inBatches = async (results, call) => {
    for (let i = 0; i < results.length;) {
      const batch = [];
      let size = 0;
      while (i < results.length && (size < 4 * 1048576 || !batch.length)) { size += (results[i].b64 || "").length; batch.push(results[i]); i += 1; }
      await call(batch);
    }
  };

  report.frames = 0;
  if (report.media && report.media.length && settings && o.capture !== "visible") {
    const n = report.media.length;
    status(job, { step: `Taking a picture of ${n} video${n === 1 ? "" : "s"} and embed${n === 1 ? "" : "s"}…` });
    const frames = await captureFrames(target, frameId, evaluate, report.media, settings, geo, o.grayscale, o.mediaFrame);
    const items = JSON.stringify(report.media);
    await inBatches(frames, async (batch) => {
      report.frames += Number(await evaluate(`__recallPdf.swapMedia(${JSON.stringify(batch)}, ${items})`)) || 0;
    });
    // The print and its measuring start from the top.
    await evaluate("scrollTo(0, 0), true");
  }

  report.resized = 0;
  report.moving = 0;
  if (report.images.length && settings && o.capture !== "visible") {
    status(job, { step: `Sizing ${report.images.length} picture${report.images.length === 1 ? "" : "s"} for print…` });
    const { results, shrunk, animated } = await shrinkImages(target, frameId, report.images, settings, geo, o.grayscale, o.mediaFrame);
    report.resized = shrunk;
    await inBatches(results, (batch) => evaluate(`__recallPdf.swapImages(${JSON.stringify(batch)})`));
    if (animated.length) report.moving = Number(await evaluate(`__recallPdf.linkAnimated(${JSON.stringify(animated)})`)) || 0;
  }

  let bytes;
  let pages = 1;
  let markedPages = 0;
  if (o.capture === "visible") {
    status(job, { phase: "printing", step: "Capturing the visible area…" });
    const shot = await send(target, "Page.captureScreenshot", { format: "jpeg", quality: settings ? settings.jpeg : 92 });
    const jpeg = b64ToBytes(shot.data);
    const size = jpegSize(jpeg) || { width: 1280, height: 800 };
    bytes = imagesToPdf([{ jpeg, ...size }], { pageWidthPt: geo.paperWidthIn * 72 });
  } else {
    const printed = await print(target, o, geo, evaluate, job);
    bytes = printed.bytes;
    pages = countPages(bytes);
    // Smart pages: each page as tall as its own content (see lib/pdf-pages.js),
    // where the PDF says that content ends, else as measured on screen.
    // Every page is trimmed, also when Chrome printed more or fewer pages
    // than planned (uneven cuts): markers count for the page they landed on,
    // and the measured height only where page i is still planned page i. A
    // page with neither (a full page that spilled) is left as it is.
    if (printed.trim) {
      const { measured, planned, bottomPt } = printed.trim;
      const marked = pageHeightsFromMarkers(bytes, pages, { bottomPt });
      markedPages = marked.filter((h) => h != null).length;
      bytes = trimPageHeights(bytes, marked.map((h, i) => h ?? (pages === planned ? measured[i] : 0)));
    }
    if (o.outline && !o.tagged && report.headings.length) bytes = addOutline(bytes, report.headings);
  }
  if (!bytes || bytes.length < 8) throw new JobError("Chrome printed an empty PDF. Try again.");
  return { bytes, pages, markedPages, report, facts, o };
}

// Attaches the debugger. Two refusals are common and both are handled here:
// a session of our own left over from before Chrome restarted the worker
// (detached, then tried once more), and a frame another extension put into
// the page, which Chrome does not let a debugger near (taken out of the page
// for the length of the job, then put back, by cleanup).
async function attach(job, ctx) {
  const signal = job.controller.signal;
  const once = () => {
    ctx.attachTried = true;
    return limit(chrome.debugger.attach(ctx.target, "1.3"), LIMITS.call,
      () => new JobError("Chrome did not let the clipper connect to this page in time. Reload the page and try again.", "timeout"), signal);
  };
  try {
    await once();
  } catch (err) {
    const m = errText(err);
    if (/already attached/i.test(m)) {
      // Ours, from before a restart? Then this frees it; someone else's stays.
      await chrome.debugger.detach(ctx.target).catch(() => {});
      await once();
    } else if (OTHER_EXTENSION.test(m)) {
      const n = await hideOtherFrames(job.tabId);
      if (!n) throw err;
      ctx.hiddenFrames = true;
      await once();
    } else throw err;
  }
  ctx.attached = true;
}

/** Waits for the reader to finish on the page, by asking a few times a second. */
async function waitForUser(job, evaluate) {
  let missed = 0;
  for (;;) {
    let s;
    try {
      s = await evaluate("__recallPdf.uiState()", LIMITS.poll);
      missed = 0;
    } catch (err) {
      if (job.controller.signal.aborted || pageGone(err)) throw err;
      missed += 1;
      if (missed >= LIMITS.missedPolls) throw new JobError("The page stopped responding while it waited for you. Reload it and try again.", "timeout");
      continue;
    }
    if (!s || s.state === "none") throw new JobError("The page changed while it waited for you. Try again.");
    if (s.state === "done") return s;
    if (s.state === "cancelled") throw new JobError("Cancelled.", "cancelled");
    if (s.pages && s.pages !== job.pages) status(job, { pages: s.pages, step: breaksStep(s.pages) });
    await sleep(LIMITS.pollEvery, job.controller.signal);
  }
}

const breaksStep = (pages) => `Check the ${pages} page${pages === 1 ? "" : "s"} on the page (drag, add or remove breaks there), then press Save PDF on the page or here.`;

// Puts everything back, whatever happened. Each step has its own time limit
// and none can stop the next, so this always ends.
async function cleanup(job, ctx) {
  const { target } = ctx;
  const step = (fn) => limit(Promise.resolve().then(fn), LIMITS.cleanupStep, () => new Error("cleanup step timed out"));
  if (ctx.attachTried) {
    if (ctx.ready) {
      try {
        const r = await step(() => rawSend(target, "Runtime.evaluate", { expression: "__recallPdf.restore()", contextId: ctx.world, returnByValue: true }));
        if (r && !r.exceptionDetails) ctx.restored = true;
      } catch { /* the page is gone or frozen; see below */ }
    }
    await step(() => rawSend(target, "Emulation.clearDeviceMetricsOverride")).catch(() => {});
    await step(() => rawSend(target, "Emulation.setEmulatedMedia", { media: "", features: [] })).catch(() => {});
    job.detaching = true;
    await step(() => chrome.debugger.detach(target)).catch(() => {});
    ctx.attached = false;
  }
  // The page side could not put itself back (frozen, or gone): at least take
  // our overlays off, so nothing is left blocking the page.
  if (!ctx.restored) await step(() => removeLeftovers(job.tabId)).catch(() => {});
  if (ctx.hiddenFrames) await step(() => restoreOtherFrames(job.tabId)).catch(() => {});
}

// ---------------------------------------------------------------- errors

const OTHER_EXTENSION = /chrome-extension:\/\/|Cannot attach to this target|Cannot access contents of url/i;

const errText = (err) => String((err && err.message) || err || "");

function pageGone(err) {
  return /Cannot find (default )?(execution )?context|Execution context was destroyed|Inspected target navigated|Debugger is not attached|Detached while handling|No tab with|Target closed/i.test(errText(err));
}

function errorKind(err, job) {
  const e = (job && job.controller.signal.aborted && job.controller.signal.reason) || err;
  if (e instanceof JobError) return e.kind;
  return /cancelled/i.test(errText(e)) ? "cancelled" : "error";
}

/** A sentence the reader can act on, for any error a job can end with. */
function explain(err, job) {
  const e = (job && job.controller.signal.aborted && job.controller.signal.reason) || err;
  if (e instanceof JobError) return e.message;
  const m = errText(e);
  if (/cancelled/i.test(m)) return "Cancelled.";
  if (/already attached/i.test(m)) return "DevTools (or another debugger) is open on this tab. Close it and try again.";
  if (OTHER_EXTENSION.test(m)) return "Another extension has put a frame into this page, and Chrome does not allow saving the page while it is there. Turn that extension off for this site, reload the page and try again.";
  if (/No tab with|Target closed/i.test(m)) return "Stopped: the tab was closed.";
  if (/Cannot find (default )?(execution )?context|Execution context was destroyed|Inspected target navigated/i.test(m)) {
    return "The page reloaded or went to another address while the PDF was being made. Try again.";
  }
  if (/Debugger is not attached|Detached while handling/i.test(m)) return "Stopped: the clipper was disconnected from the page. Try again.";
  if (/printToPDF|Printing failed/i.test(m)) return `Chrome could not print this page (${m}). Try again with Images: Medium, or fewer pages.`;
  return `Something went wrong: ${m || "unknown error"}. Reload the page and try again.`;
}

// ---------------------------------------------------------------- printing

// Page.printToPDF, read back as a stream in chunks: a long page can make a PDF
// far bigger than one DevTools message should carry.
async function printPdf(target, params) {
  const r = await send(target, "Page.printToPDF", { ...params, transferMode: "ReturnAsStream" }, LIMITS.print);
  if (r && r.stream) return readStream(target, r.stream);
  return b64ToBytes((r && r.data) || "");
}

async function print(target, o, geo, evaluate, job) {
  const { header, footer } = headerFooter(o);
  const base = {
    landscape: false, // orientation is already applied to the paper size
    displayHeaderFooter: o.header !== "none" || o.footer !== "none",
    headerTemplate: header,
    footerTemplate: footer,
    printBackground: o.backgrounds,
    scale: geo.scale,
    paperWidth: geo.paperWidthIn,
    marginTop: geo.margin.top,
    marginBottom: geo.margin.bottom,
    marginLeft: geo.margin.left,
    marginRight: geo.margin.right,
    preferCSSPageSize: false,
    generateTaggedPDF: o.tagged,
    // Chrome writes its own outline only into a tagged PDF; otherwise
    // lib/pdf-outline.js adds one afterwards.
    generateDocumentOutline: o.outline && o.tagged
  };

  if (o.layout === "paged") {
    status(job, { phase: "printing", step: "Printing…" });
    return { bytes: await printPdf(target, { ...base, paperHeight: geo.paperHeightIn }) };
  }

  if (o.layout === "smart") return printSmart(target, o, geo, evaluate, job, base);

  // Continuous: lay the page out at the print width, measure it, and make the
  // paper that tall. Past MAX_PAGE_IN it becomes a few equally tall pages, and
  // the injected break-inside rules keep each cut between blocks.
  status(job, { phase: "printing", step: "Measuring the page…" });
  let size;
  try {
    await layOutForPrint(target, o, geo);
    size = await evaluate("__recallPdf.measure()");
  } finally {
    await layOutForScreen(target, o).catch(() => {});
  }

  const marginsIn = geo.margin.top + geo.margin.bottom;
  const contentIn = (size.height * geo.scale) / CSS_PX_PER_IN;
  const pages = Math.max(1, Math.ceil((contentIn + marginsIn) / MAX_PAGE_IN));
  let height = Math.min(MAX_PAGE_IN, contentIn / pages + marginsIn + 0.3);
  let bytes = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    status(job, { step: attempt ? "Fitting the page…" : "Printing…" });
    bytes = await printPdf(target, { ...base, paperHeight: height });
    const got = countPages(bytes);
    if (got <= pages || height >= MAX_PAGE_IN) break;
    // Print layout came out taller than the measurement: grow and retry.
    height = Math.min(MAX_PAGE_IN, height * (1 + 0.12 * (got - pages)) + 0.5);
  }
  return { bytes };
}

// Lays the page out at its print width under the media the print will use —
// the colour scheme rides along, since each call replaces the emulated
// features as a whole — so what is measured is what prints. Only the width is
// overridden (height 0 keeps the window's own): an emulated window taller
// than the real one would put the bottom of the page, and anything fixed
// there, out of sight.
async function layOutForPrint(target, o, geo) {
  await send(target, "Emulation.setDeviceMetricsOverride", {
    width: geo.layoutWidthPx, height: 0, deviceScaleFactor: 1, mobile: false
  });
  if (o.media !== "screen") await send(target, "Emulation.setEmulatedMedia", { media: "print", features: mediaFeatures(o) });
  await sleep(250);
}

async function layOutForScreen(target, o) {
  await rawSend(target, "Emulation.clearDeviceMetricsOverride");
  if (o.media !== "screen") await rawSend(target, "Emulation.setEmulatedMedia", { media: "", features: mediaFeatures(o) });
}

// Smart pages: the page is cut into pages of about the chosen length, at the
// best place near each length (content/prepare.js planBreaks) — and, if asked,
// the cuts are shown on the page to move first (editBreaks). Chrome prints
// every page on one paper size, as tall as the tallest page; then each page is
// given its own height, so none ends in a band of white.
async function printSmart(target, o, geo, evaluate, job, base) {
  status(job, { phase: "printing", step: "Finding page breaks…" });
  // What the reader sees, before the layout width changes: the break editor's
  // bar is kept inside it.
  const view = await evaluate("({ w: innerWidth, h: innerHeight })");
  const lengths = {};
  for (const key of ["screen", "a4", "2a4"]) lengths[key] = pageContentPx(o, geo, key);
  if (o.pageLength === "custom") lengths.custom = pageContentPx(o, geo, "custom");
  const targetPx = pageContentPx(o, geo);
  let plan;
  try {
    await layOutForPrint(target, o, geo);
    plan = await evaluate(`__recallPdf.planBreaks(${targetPx}, ${JSON.stringify(lengths)})`);
    if (o.adjustBreaks) {
      const shown = await evaluate(`__recallPdf.editBreaks(${JSON.stringify({ ...view, staleMs: LIMITS.pageStale })})`);
      status(job, { phase: "waiting-breaks", pages: shown.pages, step: breaksStep(shown.pages) });
      await waitForUser(job, evaluate);
      status(job, { phase: "printing", step: "Applying your page breaks…" });
    }
    plan = await evaluate("__recallPdf.applyBreaks()");
  } finally {
    await layOutForScreen(target, o).catch(() => {});
  }

  const marginsIn = geo.margin.top + geo.margin.bottom;
  const contentIn = plan.heights.map((px) => (px * geo.scale) / CSS_PX_PER_IN);
  // Room for what the measurement cannot see coming: a font that prints a
  // touch larger, a margin that does not collapse at the top of a page.
  const slackIn = (h) => Math.min(SMART_SLACK_IN, Math.max(0.12, h * 0.02));
  let height = Math.min(MAX_PAGE_IN, Math.max(...contentIn.map((h) => h + SMART_SLACK_IN)) + marginsIn);
  let bytes = null;
  let got = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    status(job, { step: attempt ? "Fitting the pages…" : `Printing ${plan.pages} page${plan.pages === 1 ? "" : "s"}…` });
    bytes = await printPdf(target, { ...base, paperHeight: height });
    got = countPages(bytes);
    if (got <= plan.pages || height >= MAX_PAGE_IN) break;
    // A page printed taller than measured spilled onto a page of its own.
    height = Math.min(MAX_PAGE_IN, height * 1.15 + 0.5);
  }
  // Each page cut to its own content — never under a footer, which sits at
  // the bottom of the paper. The measured heights are the fallback for a page
  // without an end marker, while the print has the pages planned.
  const trim = o.footer === "none"
    ? {
      measured: contentIn.map((h) => Math.min(height, h + slackIn(h) + marginsIn) * 72),
      planned: plan.pages,
      bottomPt: geo.margin.bottom * 72
    }
    : null;
  return { bytes, trim };
}

// ---------------------------------------------------------------- saving

async function saveMade(job, made) {
  const { facts, o, pages } = made;
  status(job, { phase: "saving", step: "Saving…", pages });
  const capturedAt = new Date();
  const host = (() => { try { return new URL(facts.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  const bytes = setPdfInfo(made.bytes, {
    Title: facts.title,
    Author: facts.author,
    Subject: facts.url,
    Keywords: [facts.site, facts.keywords].filter(Boolean).join(", ").slice(0, 500),
    Creator: "Recall Web Clipper",
    Producer: "Chrome (Skia/PDF) via Recall Web Clipper",
    CreationDate: capturedAt,
    custom: {
      RecallSourceURL: facts.url,
      RecallSiteName: facts.site || host,
      RecallCapturedAt: capturedAt.toISOString(),
      RecallPublished: facts.published ? String(facts.published) : "",
      RecallDescription: (facts.description || "").slice(0, 500)
    }
  });

  const folder = folderFor(o.subfolder);
  const name = `${fileNameFor(o.filename, facts, capturedAt)}.pdf`;
  const saved = {
    key: `${OUT_BASE}${job.id}.pdf`, filename: folder ? `${folder}/${name}` : name, name,
    saveAs: Boolean(o.saveAs), showAfter: Boolean(o.showAfter), size: bytes.length, pages, cached: false, retry: false
  };
  // Kept until it is saved, so "Save again" never needs a second print.
  try {
    const cache = await caches.open(OUT_CACHE);
    await cache.put(saved.key, new Response(new Blob([bytes], { type: "application/pdf" })));
    saved.cached = true;
  } catch { /* then only the data: address below */ }
  job.saved = saved;
  const extra = {
    bytes: bytes.length, pages, cleaned: made.report.cleaned, resized: made.report.resized,
    fonts: made.report.fonts || 0, bookmarks: made.report.headings.length, markedPages: made.markedPages,
    frames: made.report.frames || 0, moving: made.report.moving || 0
  };
  hold();
  try {
    const outcome = await download(job, saved, bytes);
    return finishSave(job, saved, outcome, extra);
  } finally {
    release();
  }
}

/** "Save again" after a failed save: the same PDF, kept from last time. */
export async function saveAgain(tabId) {
  let job = jobs.get(tabId);
  if (job && job.running) throw new JobError("A PDF is being made for this tab right now.", "busy");
  let saved = job && job.saved;
  if (!saved) {
    const rec = await storedRecord(tabId);
    if (rec && rec.saved) {
      job = newJob(tabId);
      jobs.set(tabId, job);
      saved = rec.saved;
    }
  }
  if (!saved) throw new JobError("There is no PDF kept to save again. Press Save as PDF to make it again.");
  job.saved = saved;
  status(job, { phase: "saving", step: "Saving again…", error: null, cancelled: false, done: false });
  hold();
  try {
    const outcome = await download(job, saved, null);
    return finishSave(job, saved, outcome, { bytes: saved.size, pages: saved.pages });
  } finally {
    release();
  }
}

// "; 2 videos and embeds as pictures, 1 moving picture linked" — or nothing.
function mediaWords(extra) {
  const bits = [];
  if (extra.frames) bits.push(extra.frames === 1 ? "1 video or embed as a picture" : `${extra.frames} videos and embeds as pictures`);
  if (extra.moving) bits.push(`${extra.moving} moving picture${extra.moving === 1 ? "" : "s"} linked`);
  return bits.length ? `; ${bits.join(", ")}` : "";
}

function finishSave(job, saved, outcome, extra) {
  if (outcome.state === "complete" || outcome.state === "pending") {
    if (outcome.state === "complete" && saved.showAfter && outcome.id != null) {
      try { chrome.downloads.show(outcome.id); } catch { /* a nicety */ }
    }
    dropSaved(saved);
    job.saved = null;
    const pages = saved.pages || extra.pages || 1;
    const step = outcome.state === "complete"
      ? `Saved ${saved.name} (${(saved.size / 1048576).toFixed(1)} MB, ${pages} page${pages === 1 ? "" : "s"}${mediaWords(extra)})`
      : `Sent ${saved.name} to your downloads`;
    status(job, { phase: "done", step, done: true, error: null, cancelled: false });
    notify(job, step, false);
    return { ok: true, name: saved.name, ...extra };
  }
  const cancelled = outcome.error === "USER_CANCELED";
  const why = cancelled
    ? `Not saved: the save was cancelled.`
    : `Could not save ${saved.name}: ${downloadWords(outcome.error)}.`;
  saved.retry = true;
  const step = `${why} Press Save again to try once more.`;
  status(job, { phase: "error", step, error: why, cancelled, done: false });
  if (!cancelled) notify(job, `${why} Open the clipper to save it again.`, true);
  return { ok: false, error: why, name: saved.name };
}

function downloadWords(code) {
  const c = String(code || "FAILED");
  if (/NO_SPACE/.test(c)) return "the disk is full";
  if (/ACCESS_DENIED/.test(c)) return "Chrome may not write to that folder";
  if (/NAME_TOO_LONG/.test(c)) return "the file name is too long (shorten it under More options)";
  if (/TOO_LARGE/.test(c)) return "the file is too large for that drive";
  if (/BLOCKED|SECURITY|VIRUS/.test(c)) return "a security check blocked it";
  if (/TRANSIENT|FILE_FAILED/.test(c)) return "the file could not be written";
  if (/^NETWORK/.test(c)) return "Chrome could not read the PDF it was given";
  if (/Invalid filename/i.test(c)) return "the file name or folder is not allowed (change it under More options)";
  return c.toLowerCase().replace(/_/g, " ");
}

// Hands the PDF to chrome.downloads and waits for Chrome's verdict. A blob:
// address from the offscreen document first; if that cannot be made or read,
// a data: address.
async function download(job, saved, bytes) {
  if (LIMITS.failDownloads > 0) {
    LIMITS.failDownloads -= 1;
    return { state: "interrupted", error: "FILE_FAILED" };
  }
  let source = await sourceFor(saved, bytes, true);
  for (let attempt = 0; ; attempt += 1) {
    let outcome;
    try {
      const id = await limit(chrome.downloads.download({
        url: source.url, filename: saved.filename, saveAs: saved.saveAs, conflictAction: "uniquify"
      }), saved.saveAs ? LIMITS.downloadWaitSaveAs : LIMITS.downloadWait, () => new Error("TRANSIENT"));
      if (id == null) throw new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "FAILED");
      job.downloadId = id;
      status(job, {});
      outcome = await downloadOutcome(id, saved.saveAs);
    } catch (err) {
      outcome = { state: "interrupted", error: errText(err) };
    }
    if (source.blob) revokeBlob(saved.key);
    const retryable = source.blob && attempt === 0 && outcome.state === "interrupted"
      && outcome.error !== "USER_CANCELED" && !/filename/i.test(outcome.error || "");
    if (!retryable) return outcome;
    try { source = await sourceFor(saved, bytes, false); } catch { return outcome; }
  }
}

async function sourceFor(saved, bytes, blobFirst) {
  if (blobFirst && saved.cached) {
    try {
      const url = await blobUrl(saved.key);
      if (url) return { url, blob: true };
    } catch { /* fall through to data: */ }
  }
  const data = bytes || await cachedBytes(saved.key);
  if (!data) throw new JobError("The PDF is no longer kept. Press Save as PDF to make it again.");
  return { url: `data:application/pdf;base64,${bytesToB64(data)}`, blob: false };
}

function downloadOutcome(id, saveAs) {
  return new Promise((resolve) => {
    let timer = null;
    let over = false;
    const end = (o) => {
      if (over) return;
      over = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(o);
    };
    const from = (d) => {
      if (!d) return;
      if (d.state === "complete") end({ state: "complete", id });
      else if (d.state === "interrupted") end({ state: "interrupted", id, error: d.error || "FAILED" });
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") end({ state: "complete", id });
      else if (delta.state.current === "interrupted") {
        chrome.downloads.search({ id }).then(([d]) => end({ state: "interrupted", id, error: (d && d.error) || "FAILED" }))
          .catch(() => end({ state: "interrupted", id, error: "FAILED" }));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // It may have finished before the listener was added.
    chrome.downloads.search({ id }).then(([d]) => from(d)).catch(() => {});
    // Still going after this long: a Save As dialog left open, or a slow disk.
    timer = setTimeout(() => end({ state: "pending", id }), saveAs ? LIMITS.downloadWaitSaveAs : LIMITS.downloadWait);
  });
}

async function cachedBytes(key) {
  try {
    const cache = await caches.open(OUT_CACHE);
    const r = await cache.match(key);
    return r ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch { return null; }
}

function dropSaved(saved) {
  if (!saved || !saved.key) return;
  caches.open(OUT_CACHE).then((c) => c.delete(saved.key)).catch(() => {});
}

// The offscreen document turns a cached PDF into a blob: address — a service
// worker cannot make one — and lets it go once the download is over.
let offscreenReady = null;
let blobsOut = 0;
let decodesOut = 0;

const ANIMATED_MIME = { gif: "image/gif", webp: "image/webp", png: "image/png", avif: "image/avif" };
// Larger than any moving picture worth decoding twice; past it, the still
// is the first frame.
const MIDDLE_FRAME_MAX_BYTES = 32 * 1048576;

/**
 * The middle frame of a moving picture, as PNG bytes, decoded in the
 * offscreen document (ImageDecoder is not there in a service worker). Null
 * when it cannot be had: the caller then keeps the first frame.
 */
async function middleFrame(bytes, kind) {
  const mime = ANIMATED_MIME[kind];
  if (!mime || bytes.length > MIDDLE_FRAME_MAX_BYTES) return null;
  decodesOut += 1;
  try {
    await limit(ensureOffscreen(), 10000, () => new Error("offscreen document did not start"));
    const r = await limit(chrome.runtime.sendMessage({ type: "rwc-offscreen-middle-frame", b64: bytesToB64(bytes), mime }),
      30000, () => new Error("offscreen document did not answer"));
    return r && r.ok && r.b64 ? b64ToBytes(r.b64) : null;
  } catch {
    return null;
  } finally {
    decodesOut -= 1;
    closeOffscreenIfIdle(0, true);
  }
}

// After a decode, only a document this worker started is closed: one left
// from before a restart may still be handing a PDF to the downloads.
function closeOffscreenIfIdle(left = 0, ownOnly = false) {
  if (ownOnly && !offscreenReady) return;
  if (blobsOut === 0 && decodesOut === 0 && left === 0 && chrome.offscreen) {
    offscreenReady = null;
    chrome.offscreen.closeDocument().catch(() => {});
  }
}

function ensureOffscreen() {
  if (!chrome.offscreen) return Promise.reject(new Error("no offscreen documents"));
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const have = chrome.runtime.getContexts
        ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })
        : [];
      if (!have.length) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["BLOBS"],
          justification: "Hands a finished PDF to Chrome's downloads as a blob: address."
        }).catch((err) => { if (!/single offscreen|already/i.test(errText(err))) throw err; });
      }
    })().catch((err) => { offscreenReady = null; throw err; });
  }
  return offscreenReady;
}

async function blobUrl(key) {
  blobsOut += 1;
  try {
    await limit(ensureOffscreen(), 10000, () => new Error("offscreen document did not start"));
    const r = await limit(chrome.runtime.sendMessage({ type: "rwc-offscreen-url", key }), 20000, () => new Error("offscreen document did not answer"));
    if (!r || !r.ok || !r.url) throw new Error((r && r.error) || "no blob");
    return r.url;
  } catch (err) {
    blobsOut = Math.max(0, blobsOut - 1);
    throw err;
  }
}

function revokeBlob(key) {
  blobsOut = Math.max(0, blobsOut - 1);
  chrome.runtime.sendMessage({ type: "rwc-offscreen-revoke", key })
    .then((r) => { if (r) closeOffscreenIfIdle(r.left); })
    .catch(() => {});
}

// ---------------------------------------------------------------- the page around the job

// A note on the page itself, for when the popup is closed: the badge alone is
// easy to miss.
async function notify(job, text, error) {
  try {
    if (chrome.runtime.getContexts) {
      const popups = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
      if (popups.length) return;
    }
    await limit(chrome.scripting.executeScript({ target: { tabId: job.tabId }, func: pageToast, args: [text, Boolean(error)] }),
      LIMITS.cleanupStep, () => null);
  } catch { /* the page went away, or does not let us in: the badge says it */ }
}

// Runs in the page (chrome.scripting): self-contained.
function pageToast(text, error) {
  document.querySelectorAll("recall-clipper-toast").forEach((t) => t.remove());
  const host = document.createElement("recall-clipper-toast");
  host.setAttribute("data-recall-pdf-ui", "");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    .t { position: fixed; inset: auto; right: 16px; top: 16px; margin: 0; max-width: min(420px, calc(100vw - 32px));
      box-sizing: border-box; color: #fff; border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer; z-index: 2147483647;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 10px 28px rgba(0,0,0,.3); }
    @media print { .t { display: none !important; } }
  </style><div class="t" role="status"></div>`;
  const t = root.querySelector(".t");
  t.style.background = error ? "#b3261e" : "#1f2430";
  t.textContent = `Recall Web Clipper: ${text}`;
  t.addEventListener("click", () => host.remove());
  document.documentElement.append(host);
  try { t.setAttribute("popover", "manual"); t.showPopover(); } catch { /* stays position: fixed */ }
  setTimeout(() => host.remove(), error ? 12000 : 6000);
}

// Runs in the page: our overlays and styles, when the page side could not
// take them away itself.
function removeLeftovers(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      let n = 0;
      document.querySelectorAll("[data-recall-pdf-ui]:not(recall-clipper-toast)").forEach((el) => {
        // Placeholders stand in for videos and embeds: those stay, the rest go.
        if (el.tagName === "DIV" && el.style.position !== "absolute" && el.style.position !== "fixed" && !el.shadowRoot) return;
        el.remove();
        n += 1;
      });
      return n;
    }
  });
}

async function hideOtherFrames(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [chrome.runtime.id],
      func: (ownId) => {
        const found = [];
        const walk = (root, depth) => {
          for (const f of root.querySelectorAll("iframe, frame, embed, object")) {
            const src = f.getAttribute("src") || f.getAttribute("data") || "";
            if (/^chrome-extension:\/\//i.test(src) && !src.includes(ownId)) found.push(f);
          }
          if (depth < 6) for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        };
        walk(document, 0);
        const kept = globalThis.__rwcHiddenFrames || (globalThis.__rwcHiddenFrames = []);
        for (const f of found) {
          kept.push({ f, parent: f.parentNode, next: f.nextSibling });
          f.remove();
        }
        return found.length;
      }
    });
    return (r && r.result) || 0;
  } catch { return 0; }
}

function restoreOtherFrames(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const kept = globalThis.__rwcHiddenFrames || [];
      for (const { f, parent, next } of kept.reverse()) {
        try { parent.insertBefore(f, next && next.parentNode === parent ? next : null); } catch { /* the page moved on */ }
      }
      globalThis.__rwcHiddenFrames = [];
    }
  });
}

// ---------------------------------------------------------------- controls (popup, shortcut)

/** The popup's "Save PDF now", or the shortcut while the page waits for the reader. */
export async function finishWaiting(tabId) {
  const job = runningJob(tabId);
  if (!job || !job.evaluate || !WAITING_PHASES.has(job.phase)) return { ok: false, error: "Nothing is waiting on the page." };
  try {
    const ok = await job.evaluate("__recallPdf.finishUi()", LIMITS.poll);
    if (ok) status(job, { step: job.phase === "waiting-breaks" ? "Applying your page breaks…" : "Preparing the page…" });
    return { ok: Boolean(ok), error: ok ? undefined : "Nothing is waiting on the page." };
  } catch (err) {
    return { ok: false, error: explain(err, job) };
  }
}

/**
 * The popup's Cancel. Stops the job and waits until the page is put back. With
 * no job known here (Chrome restarted the worker meanwhile), it still makes
 * sure nothing of ours is left on the tab.
 */
export async function cancelJob(tabId) {
  const job = runningJob(tabId);
  if (job) {
    abortJob(job, new JobError("Cancelled.", "cancelled"));
    await limit(job.finished, LIMITS.cleanupStep * 5, () => null).catch(() => {});
    return { ok: true };
  }
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await limit(removeLeftovers(tabId), LIMITS.cleanupStep, () => null).catch(() => {});
  const rec = await storedRecord(tabId);
  if (rec && (rec.running || rec.phase === "saving")) {
    const stopped = { ...rec, running: false, phase: "error", step: "Cancelled.", error: "Cancelled.", cancelled: true, at: Date.now() };
    await chrome.storage.session.set({ [`job:${tabId}`]: stopped }).catch(() => {});
    chrome.runtime.sendMessage({ type: "rwc-status", tabId, job: stopped }).catch(() => {});
  }
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  return { ok: true };
}

export async function lastOptions() {
  try {
    const { last } = await chrome.storage.sync.get("last");
    return last || {};
  } catch { return {}; }
}

async function storedRecord(tabId) {
  try {
    const key = `job:${tabId}`;
    return (await chrome.storage.session.get(key))[key] || null;
  } catch { return null; }
}

/** What the popup shows for a tab: the live job, else what was last stored. */
export async function jobFor(tabId) {
  await recovered;
  const job = jobs.get(tabId);
  if (job) return publicJob(job);
  const rec = await storedRecord(tabId);
  if (!rec) return null;
  return { ...rec, canSaveAgain: Boolean(rec.saved && rec.saved.retry) };
}

export function isWaiting(tabId) {
  const job = runningJob(tabId);
  return Boolean(job && WAITING_PHASES.has(job.phase));
}

// ---------------------------------------------------------------- outside events

chrome.debugger.onDetach.addListener((source, reason) => {
  const job = source.tabId != null ? runningJob(source.tabId) : null;
  if (!job || job.detaching) return;
  if (job.ctx) job.ctx.attached = false;
  const message = reason === "canceled_by_user"
    ? "Stopped: the debugging bar's Cancel was pressed."
    : "Stopped: the page was closed, or went somewhere Chrome does not let extensions work.";
  abortJob(job, new JobError(message, reason === "canceled_by_user" ? "cancelled" : "error"));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const job = jobs.get(tabId);
  if (job && job.running) abortJob(job, new JobError("Stopped: the tab was closed."));
  else if (job) { if (job.saved) dropSaved(job.saved); jobs.delete(tabId); }
  chrome.storage.session.remove(`job:${tabId}`).catch(() => {});
});

// A new worker: any job the last one left unfinished is over. Say so, free
// the tab, and take our overlays off it.
async function recover() {
  let all = {};
  try { all = await chrome.storage.session.get(null); } catch { return; }
  for (const [key, rec] of Object.entries(all || {})) {
    if (!key.startsWith("job:") || !rec) continue;
    const tabId = Number(key.slice(4));
    if (!Number.isFinite(tabId) || jobs.has(tabId)) continue;
    let next = null;
    if (rec.running) {
      chrome.debugger.detach({ tabId }).catch(() => {});
      limit(removeLeftovers(tabId), LIMITS.cleanupStep, () => null).catch(() => {});
      const step = "Interrupted: Chrome stopped the clipper while it was working. Reload the page, then try again.";
      next = { ...rec, running: false, phase: "error", step, error: step, cancelled: false };
    } else if (rec.phase === "saving") {
      let d = null;
      if (rec.downloadId != null) { try { [d] = await chrome.downloads.search({ id: rec.downloadId }); } catch { /* unknown */ } }
      if (d && d.state === "complete") {
        next = { ...rec, phase: "done", done: true, step: `Saved ${rec.saved ? rec.saved.name : "the PDF"}`, error: null, saved: null };
        if (rec.saved) dropSaved(rec.saved);
      } else if (d && d.state === "in_progress") {
        continue;
      } else {
        const why = "The save was interrupted.";
        const saved = rec.saved ? { ...rec.saved, retry: true } : null;
        next = { ...rec, phase: "error", step: saved ? `${why} Press Save again to try once more.` : `${why} Try again.`, error: why, saved };
      }
    }
    if (next) await chrome.storage.session.set({ [key]: { ...next, at: Date.now() } }).catch(() => {});
  }
}
const recovered = recover().catch(() => {});
