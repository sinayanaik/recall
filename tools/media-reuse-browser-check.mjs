// The same picture is stored once (src/images/media-reuse.js), in a real
// browser with a storage that counts what it is sent.
//
//   node tools/media-reuse-browser-check.mjs
//
// What a reader asked for: "when a specific element involving visual elements
// is duplicated it should reference the same link instead of reuploading —
// all media, GIFs and everything." Copying a Block in the app always kept its
// address; what this holds to is the rest:
//
//   1. the same bytes uploaded twice into one file are sent once — a still and
//      an animated GIF alike — and into another file, again;
//   2. an address whose object has gone is not handed out: it uploads anew;
//   3. offline, the same picture pasted twice is parked once;
//   4. a picture copied out of this file (a presigned, signed or canonical
//      address, or a parked one's blob:) is read back to its identifier, and
//      put on a Canvas page at that address with nothing uploaded;
//   5. a picture on a Canvas page counts as used when the Notes let go of it.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { pdflibSource } from "./pdflib-source.mjs";
import { htmlToImageSource } from "./htmltoimage-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 240000;
const SHOTS = "";

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
}

const API_SRC = `async () => {
  const paths = [
    "/src/handwriting/board.js?v=__BUILD__",
    "/src/documents/pdf-blocks.js?v=__BUILD__",
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-export.js?v=__BUILD__",
    "/src/documents/view-only.js?v=__BUILD__",
    "/src/documents/notebook.js?v=__BUILD__",
    "/src/documents/canvas-setup.js?v=__BUILD__",
    "/src/documents/canvas-setup-dialog.js?v=__BUILD__",
    "/src/documents/canvas-pages-panel.js?v=__BUILD__",
    "/src/export/canvas-html.js?v=__BUILD__",
    "/src/images/upload.js?v=__BUILD__",
    "/src/images/media-reuse.js?v=__BUILD__",
    "/src/images/outbox.js?v=__BUILD__",
    "/src/images/paste.js?v=__BUILD__",
    "/src/images/surface-controls.js?v=__BUILD__",
    "/src/documents/blank-pdf.js?v=__BUILD__",
    "/src/documents/pdf-store.js?v=__BUILD__",
    "/src/cloud/s3-files.js?v=__BUILD__",
    "/src/storage/ink-prefs.js?v=__BUILD__",
    "/src/core/lib-loader.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/core/dom.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const SETUP_SRC = `async (apiSrc, pdfjsSrc, workerSrc) => {
  const tag = document.createElement("script");
  tag.textContent = pdfjsSrc;
  document.head.appendChild(tag);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };
  window.__errs = [];
  window.addEventListener("error", (e) => window.__errs.push(String(e.message) + " @ " + String(e.filename).split("/").pop() + ":" + e.lineno));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push("reject: " + String((e.reason && e.reason.stack) || e.reason)));
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("media-reuse-browser-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Reuse fixture", notesMode: true });
  await settle(400);
  document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
  await settle(250);
  document.querySelector("#documentView .pdf-missing-pick")?.click();
  for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
  await settle(300);
  return Boolean(document.querySelector("#documentStage .pdf-page[data-page-number='1']"));
}`;

const chrome = findChrome();
if (!chrome) { console.log("media-reuse-browser-check: no Chrome on this machine — skipping."); process.exit(0); }

// pdf-lib for the Canvas PDF case, from disk as the other checks take it; with
// no way to fetch it, that one case is skipped rather than the whole check.
let pdflib = null;
try {
  pdflib = pdflibSource();
} catch (error) {
  console.log(`media-reuse-browser-check: no pdf-lib (${error?.message || error}) — the Canvas PDF case will be skipped.`);
}

// html-to-image draws the Blocks into the page pictures, as it does for the
// export; with no copy of it, the picture-of-a-Block case is skipped.
let htmlToImage = null;
try {
  htmlToImage = htmlToImageSource();
} catch (error) {
  console.log(`media-reuse-browser-check: no html-to-image (${error?.message || error}) — Blocks in the pictures will not be checked.`);
}

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

const watchdog = setTimeout(() => {
  console.log(`  FAIL  the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  process.exit(1);
}, WATCHDOG_MS);

let failures = 0;
let ran = 0;
function check(label, ok, detail = "") {
  ran += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const picture = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, name), Buffer.from(picture.data, "base64"));
  console.log(`  shot  ${path.join(SHOTS, name)}`);
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: SHOTS ? 2 : 1, mobile: false });
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await servePdfjsFromDisk(client, page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("recall:pdfPictures", "0"); localStorage.removeItem("recall:view-only-v1"); localStorage.removeItem("recall:canvas-pages-panel-v1"); } catch (e) {}`
  });
  if (pdflib) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: pdflib });
  if (htmlToImage) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: htmlToImage });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens", opened === true, JSON.stringify(opened));

  // A storage that keeps what it is sent, and says so when asked.
  await page.evaluate(`async () => {
    const { api } = window.__recall;
    const stored = new Map();
    window.__uploads = [];
    const base = "https://sb.example/storage/v1/object/public/images/";
    api.setSupabaseClient({
      auth: {
        getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
        getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signOut: async () => ({ error: null })
      },
      from: () => { throw new Error("media-reuse-browser-check does not touch the database"); },
      storage: { from: () => ({
        upload: async (path, file) => { window.__uploads.push(path); stored.set(path, file.size); return { data: { path }, error: null }; },
        getPublicUrl: (path) => ({ data: { publicUrl: base + encodeURI(path) } }),
        list: async (dir, { search } = {}) => ({ data: [...stored.keys()].filter((p) => p.startsWith(dir + "/") && p.slice(dir.length + 1) === search).map((p) => ({ name: search, id: p, metadata: { size: stored.get(p) } })), error: null }),
        createSignedUrls: async () => ({ data: [], error: null }),
        remove: async (paths) => { paths.forEach((p) => stored.delete(p)); return { data: [], error: null }; }
      }) }
    });
    window.__storedObjects = stored;
    api.setSignedIn(true);
  }`);

  // ── 1. The same bytes, once per file ───────────────────────────────────
  const once = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const png = await new Promise((resolve) => { const c = document.createElement("canvas"); c.width = 7; c.height = 5; c.getContext("2d").fillRect(1, 1, 3, 3); c.toBlob(resolve, "image/png"); });
    const pngFile = new File([png], "a.png", { type: "image/png" });
    // A two-frame GIF: what a GIF pasted twice is.
    const gifBytes = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQJCgAAACwAAAAAAQABAAACAkQBACH5BAkKAAAALAAAAAABAAEAAAICTAEAOw=="), (c) => c.charCodeAt(0));
    const gif = new File([gifBytes], "b.gif", { type: "image/gif" });
    const folder = api.deckImageFolder();
    const a = await api.uploadImage(pngFile, { folder });
    const b = await api.uploadImage(new File([png], "again.png", { type: "image/png" }), { folder });
    const g1 = await api.uploadImage(gif, { folder });
    const g2 = await api.uploadImage(new File([gifBytes], "again.gif", { type: "image/gif" }), { folder });
    const uploadsInFile = window.__uploads.length;
    const other = await api.uploadImage(pngFile, { folder: "decks/another--x1" });
    // The first object gone: its address is not handed out again.
    const pathOf = (url) => decodeURI(url.split("/object/public/images/")[1]);
    window.__storedObjects.delete(pathOf(a));
    const fresh = await api.uploadImage(pngFile, { folder });
    window.__png = pngFile;
    return { folder, sameStill: a === b, sameGif: g1 === g2, uploadsInFile, otherFile: other !== a, total: window.__uploads.length, freshNew: fresh !== a };
  }`);
  check("the same still uploaded twice into one file is sent once", once.sameStill && once.uploadsInFile === 2, JSON.stringify(once));
  check("...and so is the same animated GIF", once.sameGif, JSON.stringify(once));
  check("into another file, the same bytes are uploaded for that file", once.otherFile && once.total >= 3, JSON.stringify(once));
  check("an address whose object is gone is not reused", once.freshNew && once.total === 4, JSON.stringify(once));

  // ── 3. Offline: parked once ───────────────────────────────────────────
  await page.call("Network.enable", {});
  await page.call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const parked = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    for (let i = 0; i < 20 && navigator.onLine; i += 1) await settle(50);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8]);
    const one = await api.storeImageOrQueue(new File([bytes], "x.png", { type: "image/png" }));
    const two = await api.storeImageOrQueue(new File([bytes], "y.png", { type: "image/png" }));
    const all = await api.allOutboxImages();
    return { offline: !navigator.onLine, one: one.url, two: two.url, parked: all.filter((e) => e.hash && one.url.endsWith(e.token)).length, count: all.length };
  }`);
  await page.call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check("offline, the same picture pasted twice is parked once", parked.offline && parked.one && parked.one === parked.two && parked.count === 1, JSON.stringify(parked));

  // ── 4. A picture of our own, back from the clipboard ───────────────────
  const own = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    for (let i = 0; i < 20 && !navigator.onLine; i += 1) await settle(50);
    const folder = api.deckImageFolder();
    const canonical = "https://sb.example/storage/v1/object/public/images/u1/" + folder + "/pic%20one.png";
    const signed = "https://sb.example/storage/v1/object/sign/images/u1/" + folder + "/pic%20one.png?token=abc";
    api.localImageObjectUrls.set("tok123", "blob:http://x/abc");
    const html = (src) => ({ getData: (kind) => (kind === "text/html" ? '<meta charset="utf-8"><img src="' + src + '">' : "") });
    const before = window.__uploads.length;
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(300);
    const placed = await api.addHandwritingImages([window.__png], { page: 1, x: 100, y: 600 }, { ownUrl: api.ownPictureFromTransfer(html(signed)) });
    await settle(300);
    const notOurs = api.ownImageCanonical("https://example.com/cat.png");
    const otherFile = await api.isThisFilesPicture("https://sb.example/storage/v1/object/public/images/u1/decks/another--x1/p.png");
    return {
      canonical: api.ownImageCanonical(canonical) === canonical,
      signed: api.ownImageCanonical(signed),
      blob: api.ownImageCanonical("blob:http://x/abc"),
      notOurs,
      otherFile,
      src: placed[0]?.src,
      uploaded: window.__uploads.length - before,
      dialog: Boolean(document.querySelector(".image-compress-modal:not([hidden])"))
    };
  }`);
  check("a signed address is read back to the picture's identifier", own.canonical && /object\/public\/images\/u1\/.*pic%20one\.png$/.test(own.signed), JSON.stringify(own));
  check("...as is a parked picture's blob: address, and nobody else's picture is ours", own.blob === "recall-img:tok123" && own.notOurs === "" && own.otherFile === false, JSON.stringify(own));
  check("this file's own picture pasted on a page goes down at its address, nothing uploaded or asked", own.src === own.signed && own.uploaded === 0 && !own.dialog, JSON.stringify(own));

  // ── 5. Used on a page counts as used ──────────────────────────────────
  const used = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const url = api.documentBlocks().find((b) => b.kind === "image")?.src;
    return { url, used: api.deckStillReferencesImage(url), unused: api.deckStillReferencesImage("https://sb.example/storage/v1/object/public/images/u1/nowhere.png") };
  }`);
  check("a picture on a Canvas page counts as used when the Notes let go of it", used.url && used.used === true && used.unused === false, JSON.stringify(used));

  const errs = await page.evaluate("() => window.__errs");
  check("no page errors", !errs.length, errs.join(" | "));
} catch (error) {
  failures += 1;
  console.log(`  FAIL  the check itself: ${error?.stack || error}`);
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
}

console.log(`\nmedia-reuse-browser-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
