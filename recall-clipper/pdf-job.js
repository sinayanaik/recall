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
// While attached, Chrome shows its "started debugging this browser" bar on the
// tab; it goes away when the job detaches.

import { setPdfInfo, countPages } from "./lib/pdf-info.js";
import { trimPageHeights, pageHeightsFromMarkers } from "./lib/pdf-pages.js";
import { addOutline } from "./lib/pdf-outline.js";
import { isVariableFont, fontFaces } from "./lib/font-check.js";
import { imagesToPdf } from "./lib/image-pdf.js";
import {
  normalize, geometry, imageSettings, fileNameFor, folderFor, pageContentPx,
  MAX_PAGE_IN, CSS_PX_PER_IN, SMART_SLACK_IN
} from "./lib/options.js";

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source|file):/i;
const STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

const jobs = new Map(); // tabId → { step, error, done }

// ---------------------------------------------------------------- status

function status(tabId, patch) {
  const job = { ...(jobs.get(tabId) || {}), ...patch };
  jobs.set(tabId, job);
  chrome.runtime.sendMessage({ type: "rwc-status", tabId, job }).catch(() => {});
  const text = job.error ? "!" : job.done ? "✓" : "…";
  chrome.action.setBadgeBackgroundColor({ tabId, color: job.error ? "#c62828" : "#4f5bd5" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (job.done || job.error) setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}), 8000);
}

// ---------------------------------------------------------------- helpers

const send = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params);

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
  let handle = null;
  try {
    const { resource } = await send(target, "Network.loadNetworkResource", {
      frameId, url, options: { disableCache: false, includeCredentials: true }
    });
    if (!resource || !resource.success || !resource.stream) return null;
    handle = resource.stream;
    const parts = [];
    let total = 0;
    for (let i = 0; i < 4096; i += 1) {
      const chunk = await send(target, "IO.read", { handle, size: 1 << 20 });
      const bytes = chunk.base64Encoded ? b64ToBytes(chunk.data) : new TextEncoder().encode(chunk.data);
      parts.push(bytes);
      total += bytes.length;
      if (chunk.eof || total > 64 * 1048576) break;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  } catch {
    return null;
  } finally {
    if (handle) send(target, "IO.close", { handle }).catch(() => {});
  }
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
async function shrinkImages(target, frameId, items, settings, geo, grayscale) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.src)) groups.set(item.src, []);
    groups.get(item.src).push(item);
  }
  const queue = [...groups.entries()];
  const results = [];
  let shrunk = 0;
  const worker = async () => {
    while (queue.length) {
      const [src, uses] = queue.shift();
      try {
        const bytes = await resourceBytes(target, frameId, src);
        if (!bytes || bytes.length < 64) continue;
        const kind = sniffImage(bytes);
        if (kind === "svg" || kind === "other") continue;
        // Original size: only what Chrome would store as raw pixels changes.
        if (!settings.dpi && kind !== "webp" && kind !== "avif" && !grayscale) continue;
        const bitmap = await createImageBitmap(new Blob([bytes]));
        const nw = bitmap.width;
        const nh = bitmap.height;
        const cssW = Math.max(...uses.map((u) => drawnWidth(u, nw, nh, geo.layoutWidthPx)));
        const targetW = settings.dpi ? Math.max(16, Math.round(((cssW * geo.scale) / CSS_PX_PER_IN) * settings.dpi)) : nw;
        const shrink = nw > targetW * 1.15;
        const w = shrink ? targetW : nw;
        const h = Math.max(1, Math.round((w * nh) / nw));
        if (!shrink && kind === "jpeg" && !grayscale) { bitmap.close(); continue; }
        // Big enough to matter: a small icon is cheap whatever it is.
        if (!shrink && w * h < 120 * 120 && kind !== "webp" && kind !== "avif") { bitmap.close(); continue; }
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingQuality = "high";
        if (grayscale) ctx.filter = "grayscale(1)";
        ctx.drawImage(bitmap, 0, 0, w, h);
        const { alpha, few } = inspectPixels(ctx, w, h);
        // A PNG or GIF kept at its size and kept lossless gains nothing.
        if (!shrink && (kind === "png" || kind === "gif") && (alpha || few) && !grayscale) { bitmap.close(); continue; }
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
        if (!shrink && (kind === "jpeg" || kind === "png") && out.size >= bytes.length) continue;
        results.push({ ids: uses.map((u) => u.id), type: out.type, b64: bytesToB64(new Uint8Array(await out.arrayBuffer())) });
        if (shrink) shrunk += uses.length;
      } catch { /* this one prints as served */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return { results, shrunk };
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

export async function runJob(tabId, rawOptions) {
  if (jobs.get(tabId) && !jobs.get(tabId).done && !jobs.get(tabId).error) throw new Error("A PDF is already being made for this tab.");
  const o = normalize(rawOptions);
  const geo = geometry(o);
  const settings = imageSettings(o);

  const tab = await chrome.tabs.get(tabId);
  if (RESTRICTED.test(tab.url || "") || STORE.test(tab.url || "")) throw new Error("Chrome does not let extensions read this page.");

  status(tabId, { step: "Attaching to the page…", error: null, done: false });
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  let prepared = false;
  let world = null;
  const evaluate = async (expression) => {
    const r = await send(target, "Runtime.evaluate", { expression, contextId: world, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || "page script failed");
    }
    return r.result ? r.result.value : undefined;
  };

  try {
    await send(target, "Page.enable");
    const { frameTree } = await send(target, "Page.getFrameTree");
    const frameId = frameTree.frame.id;
    ({ executionContextId: world } = await send(target, "Page.createIsolatedWorld", {
      frameId, worldName: "Recall Web Clipper"
    }));
    const [coreSrc, prepSrc] = await Promise.all([sourceOf("content/cleaner-core.js"), sourceOf("content/prepare.js")]);
    await evaluate(`${coreSrc}\n;\n${prepSrc}\n;true`);

    if (o.capture === "element") {
      status(tabId, { step: "Click the block you want…" });
      await evaluate("__recallPdf.pickElement()");
    }

    // Colour scheme and media type apply to the measuring pass as well as the print.
    await send(target, "Emulation.setEmulatedMedia", { media: o.media === "screen" ? "screen" : "", features: mediaFeatures(o) });

    status(tabId, { step: "Preparing the page…" });
    prepared = true;
    const report = await evaluate(`__recallPdf.prepare(${JSON.stringify(o)})`);
    const facts = report.facts;

    if (o.fonts === "auto" && o.capture !== "visible") {
      status(tabId, { step: "Checking the fonts…" });
      const families = await variableFamilies(target, frameId, facts.url || tab.url);
      if (families.length) report.fonts = await evaluate(`__recallPdf.replaceFonts(${JSON.stringify(families)})`);
    }

    report.resized = 0;
    if (report.images.length && settings && o.capture !== "visible") {
      status(tabId, { step: `Sizing ${report.images.length} picture${report.images.length === 1 ? "" : "s"} for print…` });
      const { results, shrunk } = await shrinkImages(target, frameId, report.images, settings, geo, o.grayscale);
      report.resized = shrunk;
      // In batches of about 4 MB, so no single message gets huge.
      for (let i = 0; i < results.length;) {
        const batch = [];
        let size = 0;
        while (i < results.length && (size < 4 * 1048576 || !batch.length)) { size += results[i].b64.length; batch.push(results[i]); i += 1; }
        await evaluate(`__recallPdf.swapImages(${JSON.stringify(batch)})`);
      }
    }

    let bytes;
    let pages = 1;
    let markedPages = 0;
    if (o.capture === "visible") {
      status(tabId, { step: "Capturing the visible area…" });
      const shot = await send(target, "Page.captureScreenshot", { format: "jpeg", quality: settings ? settings.jpeg : 92 });
      const jpeg = b64ToBytes(shot.data);
      const size = jpegSize(jpeg) || { width: 1280, height: 800 };
      bytes = imagesToPdf([{ jpeg, ...size }], { pageWidthPt: geo.paperWidthIn * 72 });
    } else {
      const printed = await print(target, o, geo, evaluate, tabId);
      bytes = printed.bytes;
      pages = countPages(bytes);
      // Smart pages: each page as tall as its own content (see lib/pdf-pages.js),
      // where the PDF says that content ends, else as measured on screen.
      if (printed.trim) {
        const { measured, bottomPt } = printed.trim;
        const marked = pageHeightsFromMarkers(bytes, measured.length, { bottomPt });
        markedPages = marked.filter((h) => h != null).length;
        bytes = trimPageHeights(bytes, measured.map((h, i) => marked[i] ?? h));
      }
      if (o.outline && !o.tagged && report.headings.length) bytes = addOutline(bytes, report.headings);
    }

    await evaluate("__recallPdf.restore()").catch(() => {});
    prepared = false;
    await send(target, "Emulation.setEmulatedMedia", { media: "", features: [] }).catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});

    status(tabId, { step: "Saving…" });
    const capturedAt = new Date();
    const host = (() => { try { return new URL(facts.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    bytes = setPdfInfo(bytes, {
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
    const id = await chrome.downloads.download({
      url: `data:application/pdf;base64,${bytesToB64(bytes)}`,
      filename: folder ? `${folder}/${name}` : name,
      saveAs: o.saveAs,
      conflictAction: "uniquify"
    });
    if (o.showAfter && id != null) whenComplete(id, () => chrome.downloads.show(id));
    status(tabId, { step: `Saved ${name} (${(bytes.length / 1048576).toFixed(1)} MB, ${pages} page${pages === 1 ? "" : "s"})`, done: true });
    return {
      ok: true, name, bytes: bytes.length, pages, cleaned: report.cleaned, resized: report.resized,
      fonts: report.fonts || 0, bookmarks: report.headings.length, markedPages
    };
  } catch (err) {
    if (prepared) await evaluate("__recallPdf.restore()").catch(() => {});
    await send(target, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
    const message = /cancelled/.test(String(err && err.message)) ? "Cancelled." : String((err && err.message) || err);
    status(tabId, { step: message, error: message });
    throw err;
  }
}

async function print(target, o, geo, evaluate, tabId) {
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
    generateDocumentOutline: o.outline && o.tagged,
    transferMode: "ReturnAsBase64"
  };

  if (o.layout === "paged") {
    status(tabId, { step: "Printing…" });
    return { bytes: b64ToBytes((await send(target, "Page.printToPDF", { ...base, paperHeight: geo.paperHeightIn })).data) };
  }

  if (o.layout === "smart") return printSmart(target, o, geo, evaluate, tabId, base);

  // Continuous: lay the page out at the print width, measure it, and make the
  // paper that tall. Past MAX_PAGE_IN it becomes a few equally tall pages, and
  // the injected break-inside rules keep each cut between blocks.
  status(tabId, { step: "Measuring the page…" });
  await layOutForPrint(target, o, geo, evaluate);
  const size = await evaluate("__recallPdf.measure()");
  await layOutForScreen(target, o);

  const marginsIn = geo.margin.top + geo.margin.bottom;
  const contentIn = (size.height * geo.scale) / CSS_PX_PER_IN;
  const pages = Math.max(1, Math.ceil((contentIn + marginsIn) / MAX_PAGE_IN));
  let height = Math.min(MAX_PAGE_IN, contentIn / pages + marginsIn + 0.3);
  let bytes = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    status(tabId, { step: attempt ? "Fitting the page…" : "Printing…" });
    bytes = b64ToBytes((await send(target, "Page.printToPDF", { ...base, paperHeight: height })).data);
    const got = countPages(bytes);
    if (got <= pages || height >= MAX_PAGE_IN) break;
    // Print layout came out taller than the measurement: grow and retry.
    height = Math.min(MAX_PAGE_IN, height * (1 + 0.12 * (got - pages)) + 0.5);
  }
  return { bytes };
}

// Lays the page out at its print width under the media the print will use —
// the colour scheme rides along, since each call replaces the emulated
// features as a whole — so what is measured is what prints.
async function layOutForPrint(target, o, geo, evaluate) {
  const viewport = await evaluate("({ h: innerHeight })");
  await send(target, "Emulation.setDeviceMetricsOverride", {
    width: geo.layoutWidthPx, height: Math.max(600, viewport.h), deviceScaleFactor: 1, mobile: false
  });
  if (o.media !== "screen") await send(target, "Emulation.setEmulatedMedia", { media: "print", features: mediaFeatures(o) });
  await new Promise((r) => setTimeout(r, 250));
}

async function layOutForScreen(target, o) {
  await send(target, "Emulation.clearDeviceMetricsOverride");
  if (o.media !== "screen") await send(target, "Emulation.setEmulatedMedia", { media: "", features: mediaFeatures(o) });
}

// Smart pages: the page is cut into pages of about the chosen length, at the
// best place near each length (content/prepare.js planBreaks) — and, if asked,
// the cuts are shown on the page to move first (editBreaks). Chrome prints
// every page on one paper size, as tall as the tallest page; then each page is
// given its own height, so none ends in a band of white.
async function printSmart(target, o, geo, evaluate, tabId, base) {
  status(tabId, { step: "Finding page breaks…" });
  await layOutForPrint(target, o, geo, evaluate);
  const lengths = {};
  for (const key of ["screen", "a4", "2a4"]) lengths[key] = pageContentPx(o, geo, key);
  if (o.pageLength === "custom") lengths.custom = pageContentPx(o, geo, "custom");
  const targetPx = pageContentPx(o, geo);
  let plan;
  try {
    plan = await evaluate(`__recallPdf.planBreaks(${targetPx}, ${JSON.stringify(lengths)})`);
    if (o.adjustBreaks) {
      status(tabId, { step: `Check the ${plan.pages} page break${plan.pages === 2 ? "" : "s"} on the page, then press Save PDF there…` });
      plan = await evaluate("__recallPdf.editBreaks()");
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
    status(tabId, { step: attempt ? "Fitting the pages…" : `Printing ${plan.pages} page${plan.pages === 1 ? "" : "s"}…` });
    bytes = b64ToBytes((await send(target, "Page.printToPDF", { ...base, paperHeight: height })).data);
    got = countPages(bytes);
    if (got <= plan.pages || height >= MAX_PAGE_IN) break;
    // A page printed taller than measured spilled onto a page of its own.
    height = Math.min(MAX_PAGE_IN, height * 1.15 + 0.5);
  }
  // Each page cut to its own content — only when the print came out exactly as
  // planned, and never under a footer, which sits at the bottom of the paper.
  // The measured heights are the fallback for a page without an end marker.
  const fits = got === plan.pages && o.footer === "none";
  const trim = fits
    ? {
      measured: contentIn.map((h) => Math.min(height, h + slackIn(h) + marginsIn) * 72),
      bottomPt: geo.margin.bottom * 72
    }
    : null;
  return { bytes, trim };
}

function whenComplete(id, fn) {
  const listener = (delta) => {
    if (delta.id !== id || !delta.state) return;
    if (delta.state.current === "complete") fn();
    if (delta.state.current !== "in_progress") chrome.downloads.onChanged.removeListener(listener);
  };
  chrome.downloads.onChanged.addListener(listener);
}

export async function lastOptions() {
  try {
    const { last } = await chrome.storage.sync.get("last");
    return last || {};
  } catch { return {}; }
}

export function jobFor(tabId) {
  return jobs.get(tabId) || null;
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null && reason === "canceled_by_user") {
    const job = jobs.get(source.tabId);
    if (job && !job.done && !job.error) status(source.tabId, { step: "Stopped: the debugging bar was closed.", error: "stopped" });
  }
});
