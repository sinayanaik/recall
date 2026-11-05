// ☰ → Extensions, in the real app in Chromium: the sheet opens from the
// drawer, shows one card per extension in the catalog, and each Download
// button saves a .zip whose entries are exactly that extension's catalog
// files under one top-level folder, byte for byte as they are on disk, with a
// manifest.json Chrome can load.
//
//   node tools/extension-store-check.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect, findChrome, launchChrome, openPage } from "./cdp.mjs";
import { buildCatalog } from "./extension-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromePath = findChrome();
if (!chromePath) {
  console.log("FAIL no Chrome found (set CHROME_PATH)");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

// Just enough of a zip reader to list and inflate what the app wrote.
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + packed);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    entries.set(name, { data, crc, method });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const server = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), ROOT, "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((resolve) => server.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
const downloads = mkdtempSync(path.join(tmpdir(), "recall-store-dl-"));
const unzipped = mkdtempSync(path.join(tmpdir(), "recall-store-unzipped-"));
const chrome = await launchChrome(chromePath, [], { windowSize: "1280,900" });
const client = await connect(chrome.wsUrl);

try {
  const catalog = buildCatalog();
  await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  const done = new Map();
  client.on((m) => {
    if (m.method === "Browser.downloadWillBegin") done.set(m.params.guid, { name: m.params.suggestedFilename, state: "started" });
    if (m.method === "Browser.downloadProgress" && done.has(m.params.guid)) done.get(m.params.guid).state = m.params.state;
  });

  const page = await openPage(client);
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitFor(() => Boolean(document.getElementById("extensionsBtn")), { label: "the app" });
  // The drawer button is wired at module load, whether or not anyone is signed in.
  await page.waitFor(() => { document.getElementById("extensionsBtn").click(); return document.getElementById("extensionsModal").hidden === false; }, { label: "the Extensions sheet", timeout: 30000 });
  check("☰ → Extensions opens the sheet", true);

  const cards = await page.evaluate(() => [...document.querySelectorAll("#extensionsList .ext-card")].map((c) => ({
    id: c.dataset.extension,
    name: c.querySelector(".ext-card-name")?.textContent,
    meta: c.querySelector(".ext-card-meta")?.textContent,
    hasButton: Boolean(c.querySelector("button.ext-card-download"))
  })));
  check("one card per extension, each with a Download button", cards.length === catalog.length && cards.every((c) => c.hasButton),
    cards.map((c) => c.name).join(", "));
  check("one extension, Recall Web Clipper, is in the store", cards.length === 1 && cards[0].id === "recall-clipper" && cards[0].name === "Recall Web Clipper",
    JSON.stringify(cards.map((c) => c.name)));
  check("cards show each version", catalog.every((e) => cards.find((c) => c.id === e.id)?.meta?.includes(`Version ${e.version}`)));
  const icons = await page.evaluate(() => Promise.all([...document.querySelectorAll("#extensionsList .ext-card-icon")].map((img) =>
    img.complete ? img.naturalWidth : new Promise((r) => { img.onload = () => r(img.naturalWidth); img.onerror = () => r(0); }))));
  check("every card's icon loads", icons.length === catalog.length && icons.every((w) => w > 0), icons.join(","));

  for (const ext of catalog) {
    const before = done.size;
    await page.evaluate((id) => document.querySelector(`button.ext-card-download[data-extension="${id}"]`).click(), ext.id);
    const expected = `${ext.folder}-${ext.version}.zip`;
    let file = null;
    for (let i = 0; i < 300 && !file; i += 1) {
      const hit = [...done.values()].find((d) => d.name === expected && d.state === "completed");
      if (hit && existsSync(path.join(downloads, expected))) file = path.join(downloads, expected);
      else await sleep(100);
    }
    check(`${ext.name}: downloads as ${expected}`, Boolean(file) && done.size > before);
    if (!file) continue;
    const entries = readZip(readFileSync(file));
    const want = ext.files.map((f) => `${ext.folder}/${f.path}`);
    const got = [...entries.keys()];
    check(`${ext.name}: the zip holds exactly the catalog's ${want.length} files, under one folder`,
      got.length === want.length && want.every((w) => entries.has(w)) && got.every((g) => g.startsWith(`${ext.folder}/`)));
    const differs = ext.files.filter((f) => !entries.get(`${ext.folder}/${f.path}`)?.data.equals(readFileSync(path.join(ROOT, ext.folder, f.path))));
    check(`${ext.name}: every file is byte-identical to the repository's`, differs.length === 0, differs.map((f) => f.path).slice(0, 5).join(", "));
    const manifest = JSON.parse(entries.get(`${ext.folder}/manifest.json`).data.toString("utf8"));
    check(`${ext.name}: its manifest names it and its version`, manifest.name === ext.name && manifest.version === ext.version);
    check(`${ext.name}: no tools/ or test files in the download`, !got.some((g) => /\/tools\//.test(g)));
    check(`${ext.name}: text files are compressed`, [...entries.entries()].some(([n, e]) => n.endsWith(".js") && e.method === 8));
    // Unzip it, as a person would, for the install step below.
    for (const [name, { data }] of entries) {
      const out = path.join(unzipped, name);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, data);
    }
  }
  // "Load unpacked" on each unzipped folder: Chrome starts all three.
  const folders = catalog.map((e) => path.join(unzipped, e.folder)).filter((f) => existsSync(path.join(f, "manifest.json")));
  const second = await launchChrome(chromePath, [`--disable-extensions-except=${folders.join(",")}`, `--load-extension=${folders.join(",")}`]);
  const c2 = await connect(second.wsUrl);
  // Chrome runs a component extension or two of its own, so look for ours by
  // ID: the two fixed ones come from their manifest "key", and an unpacked
  // folder without one (the Clipper) gets the hash of its absolute path.
  const idOf = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 32)
    .split("").map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
  const expectedIds = folders.map((f) => {
    const manifest = JSON.parse(readFileSync(path.join(f, "manifest.json"), "utf8"));
    return manifest.key ? idOf(Buffer.from(manifest.key, "base64")) : idOf(Buffer.from(f, "utf8"));
  });
  let workers = [];
  for (let i = 0; i < 60; i += 1) {
    workers = (await c2.send("Target.getTargets")).targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
    if (expectedIds.every((id) => workers.some((w) => w.url.startsWith(`chrome-extension://${id}/`)))) break;
    await sleep(100);
  }
  const running = expectedIds.filter((id) => workers.some((w) => w.url.startsWith(`chrome-extension://${id}/`)));
  check("Chrome loads every unzipped download as an extension", folders.length === catalog.length && running.length === catalog.length,
    `${running.length} of ${catalog.length} running`);
  c2.close();
  await second.close();

  const after = await page.evaluate(() => [...document.querySelectorAll("button.ext-card-download")].every((b) => !b.disabled && b.textContent === "Download .zip"));
  check("buttons come back ready after each download", after);
  await page.evaluate(() => document.getElementById("extensionsCloseBtn").click());
  check("the sheet closes", await page.evaluate(() => document.getElementById("extensionsModal").hidden === true));
} catch (err) {
  check("ran to the end", false, err && err.stack || String(err));
}

try { client.close(); } catch { /* gone */ }
await chrome.close();
server.kill();
rmSync(downloads, { recursive: true, force: true });
rmSync(unzipped, { recursive: true, force: true });
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length} checks · ${failed} failed`);
console.log(`CHECK: ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
