// Recall Web Clipper — Save as PDF, run from the background service worker.
//
// One job per tab: attach the DevTools protocol to the tab, prepare the page in
// an isolated world (content/prepare.js), lay it out at the chosen width, print
// it with Page.printToPDF (a real vector PDF with selectable text), put the
// page back, stamp Recall's metadata into the PDF and save it with
// chrome.downloads. Running in the service worker rather than the popup means
// closing the popup — or clicking the page to pick a block or move a page
// break — never kills a job.
//
// While attached, Chrome shows its "started debugging this browser" bar on the
// tab; it goes away when the job detaches.

import { setPdfInfo, countPages } from "./lib/pdf-info.js";
import { trimPageHeights } from "./lib/pdf-pages.js";
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

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buf) => `data:${blob.type};base64,${bytesToB64(new Uint8Array(buf))}`);
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

// Re-encode the images the page itself could not read (cross-origin, no
// CORS). Needs the optional host permission; without it they print as served.
async function reencodeInBackground(items, settings) {
  const results = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i];
      i += 1;
      try {
        const res = await fetch(item.src, { credentials: "omit" });
        if (!res.ok) continue;
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(item.width, item.height);
        const ctx = canvas.getContext("2d");
        const png = /png|gif|webp/.test(blob.type) && !/jpe?g/.test(blob.type);
        if (!png) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, item.width, item.height); }
        if (settings.grayscale) ctx.filter = "grayscale(1)";
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, item.width, item.height);
        bitmap.close();
        const out = await canvas.convertToBlob(png ? { type: "image/png" } : { type: "image/jpeg", quality: settings.jpeg / 100 });
        results.push({ id: item.id, dataUrl: await blobToDataUrl(out) });
      } catch { /* leave this one as served */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
  return results;
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
  o.reencode = settings ? { ...settings, grayscale: o.grayscale } : null;

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
    ({ executionContextId: world } = await send(target, "Page.createIsolatedWorld", {
      frameId: frameTree.frame.id, worldName: "Recall Web Clipper"
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
    const report = await evaluate(`__recallPdf.prepare(${JSON.stringify(o)}, ${JSON.stringify(geo)})`);
    const facts = report.facts;
    report.resized = report.resized || 0;

    if (report.images.length && settings) {
      const allowed = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
      if (allowed) {
        status(tabId, { step: `Resizing ${report.images.length} image${report.images.length === 1 ? "" : "s"}…` });
        const results = await reencodeInBackground(report.images, o.reencode);
        report.resized += results.length;
        for (let i = 0; i < results.length; i += 8) {
          await evaluate(`__recallPdf.swapImages(${JSON.stringify(results.slice(i, i + 8))})`);
        }
      }
    }

    let bytes;
    let pages = 1;
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
      // Smart pages: each page as tall as its own content (see lib/pdf-pages.js).
      if (printed.trimTo) bytes = trimPageHeights(bytes, printed.trimTo);
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
    return { ok: true, name, bytes: bytes.length, pages, cleaned: report.cleaned, resized: report.resized };
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
    generateDocumentOutline: o.outline,
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
  const fits = got === plan.pages && o.footer === "none";
  const trimTo = fits
    ? contentIn.map((h) => Math.min(height, h + slackIn(h) + marginsIn) * 72)
    : null;
  return { bytes, trimTo };
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
