// Does the service worker precache everything the app actually loads?
//
//   node tools/precache-check.mjs
//
// sw.js lists every module and stylesheet by hand — 137 of them — and precaches
// them at install. Two ways that list goes wrong, both silent:
//
//   • A new module is imported but never added to the list. Online it works
//     perfectly, because the network answers. OFFLINE the import rejects and the
//     app dies at instantiation, on exactly the devices a PWA exists for. No
//     other check here would notice: the module resolves, it boots, it renders.
//   • A file is renamed or deleted but left in the list. `cache.addAll()` is
//     all-or-nothing, so ONE 404 makes the whole install fail and no worker ever
//     activates — every user stays on the previous release forever.
//
// Both are pure filesystem facts, so this is a static check: no browser, no
// server, runs in milliseconds.
//
// Stylesheets get the same treatment against index.html, because a sheet that is
// precached but never linked is dead weight and one that is linked but never
// precached is an unstyled app offline.
//
// And vendor/ hardest of all. Those files are parser-blocking <script> tags
// ahead of src/main.js, so one of them missing from the worker's VENDOR_ASSETS
// is not a degraded feature — it is a blank page on the next offline launch,
// which is precisely the failure this whole area was rebuilt to remove.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sw = readFileSync(path.join(ROOT, "sw.js"), "utf8");
const html = readFileSync(path.join(ROOT, "index.html"), "utf8");

function walk(dir, out = []) {
  const full = path.join(ROOT, dir);
  if (!existsSync(full)) return out;
  for (const entry of readdirSync(full)) {
    const rel = path.join(dir, entry);
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

// Every module reachable from src/main.js by following static imports. Only
// these have to be precached — an unimported file is dead code, not an offline
// hazard, and reporting it here would train the eye to ignore this check.
function reachableModules() {
  const seen = new Set();
  const queue = ["src/main.js", "src/boot.js"];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || !existsSync(path.join(ROOT, rel))) continue;
    seen.add(rel);
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    // Static `import ... from "…"` and bare `import "…"`, plus dynamic
    // `import("…")` — lib-loader uses the last form for the deferred CDN shims.
    const re = /\bimport\s*(?:[^"'()]*?\bfrom\s*)?\(?\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1].split("?")[0];
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      const resolved = spec.startsWith("/")
        ? spec.replace(/^\//, "")
        : path.normalize(path.join(path.dirname(rel), spec));
      if (resolved.endsWith(".js")) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

const problems = [];

// ── vendor/ ────────────────────────────────────────────────────────────────
// Three facts have to agree: what is on disk, what vendor/lock.json recorded,
// and what sw.js precaches. tools/vendor-sync.mjs writes all three, so a
// disagreement means someone edited one by hand.
const vendorLockPath = path.join(ROOT, "vendor", "lock.json");
if (!existsSync(vendorLockPath)) {
  problems.push("vendor/lock.json is missing — run: node tools/vendor-sync.mjs");
} else {
  const vendorFiles = Object.keys(JSON.parse(readFileSync(vendorLockPath, "utf8")));
  for (const rel of vendorFiles) {
    if (!existsSync(path.join(ROOT, rel))) {
      problems.push(`${rel} is in vendor/lock.json but not on disk — run: node tools/vendor-sync.mjs`);
      continue;
    }
    if (!sw.includes(`"./${rel}"`)) {
      problems.push(`${rel} is not in sw.js VENDOR_ASSETS — it would be absent on a first offline launch`);
    }
  }
  // The other direction: a file left on disk after a version bump is dead
  // weight the worker would go on precaching forever.
  for (const rel of walk("vendor")) {
    if (rel.endsWith("lock.json")) continue;
    const url = rel.replace(/\\/g, "/");
    if (!vendorFiles.includes(url)) problems.push(`${url} is on disk but not in vendor/lock.json — delete it or re-run vendor-sync`);
  }
  // Nothing on the boot path may point at a third-party origin any more. This
  // is the check that would have caught the original bug: index.html loaded
  // eight blocking scripts from cdn.jsdelivr.net, and no test anywhere said it
  // shouldn't.
  // Comments stripped first: this file documents what it moved away from, and
  // a check that fires on its own explanation is a check people delete.
  const markup = html.replace(/<!--[\s\S]*?-->/g, "");
  const bootTags = markup.match(/<script src="https:\/\/[^"]+"/g) || [];
  for (const tag of bootTags) problems.push(`index.html loads a blocking third-party script: ${tag} — vendor it instead`);
  const bootSheets = markup.match(/<link rel="stylesheet" href="https:\/\/[^"]+"/g) || [];
  for (const tag of bootSheets) problems.push(`index.html loads a render-blocking third-party stylesheet: ${tag} — vendor it instead`);
}

const modules = reachableModules();
for (const rel of modules) {
  if (!sw.includes(`${rel}?v=`)) {
    problems.push(`${rel} is imported by the app but NOT precached in sw.js — it would fail to load offline`);
  }
}

// Every module except the entry point needs a <link rel="modulepreload">.
// Without one the browser cannot ask for a module until it has parsed whichever
// module imports it, and the deepest chain here is dozens of hops — on a first
// load that is dozens of sequential round trips. The deploy workflow enforces
// this and FAILS THE BUILD without it, which is how four new modules got as far
// as a push before anyone noticed. Checked here too, so it is caught locally.
for (const rel of modules) {
  if (rel === "src/main.js") continue;
  if (!html.includes(`modulepreload" href="${rel}?v=`)) {
    problems.push(`${rel} has no <link rel="modulepreload"> in index.html — the deploy workflow rejects this`);
  }
}

const sheets = walk("styles").filter((f) => f.endsWith(".css"));
for (const rel of sheets) {
  const linked = html.includes(`${rel}?v=`);
  const cached = sw.includes(`${rel}?v=`);
  if (linked && !cached) problems.push(`${rel} is linked in index.html but NOT precached in sw.js`);
  if (cached && !linked) problems.push(`${rel} is precached in sw.js but never linked in index.html`);
  if (!linked && !cached) problems.push(`${rel} exists but is neither linked nor precached — dead stylesheet`);
}

// The other direction: anything the install would ask for that is not there.
// One 404 fails cache.addAll() outright and no new worker ever activates.
const listed = [...sw.matchAll(/\.\/((?:src|styles)\/[A-Za-z0-9_./-]+\.(?:js|css))\?v=/g)].map((m) => m[1]);
for (const rel of [...new Set(listed)]) {
  if (!existsSync(path.join(ROOT, rel))) {
    problems.push(`sw.js precaches ${rel}, which does not exist — cache.addAll() would fail and NO worker would activate`);
  }
}

// Unreachable modules are reported separately: not a failure, but a file nobody
// imports is either a mistake or work in progress, and it should be visible.
const allModules = walk("src").filter((f) => f.endsWith(".js"));
const orphans = allModules.filter((f) => !modules.includes(f));

for (const p of problems) console.log(`  ${p}`);
if (orphans.length) {
  console.log(`\n  note: ${orphans.length} module(s) in src/ are imported by nothing:`);
  for (const o of orphans) console.log(`    ${o}`);
}

console.log(`\n${modules.length} modules reachable · ${sheets.length} stylesheets · ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
