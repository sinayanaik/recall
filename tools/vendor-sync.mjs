// Download the boot-critical third-party libraries into vendor/, and verify
// that what is on disk is what we asked for.
//
//   node tools/vendor-sync.mjs            # download anything missing
//   node tools/vendor-sync.mjs --force    # re-download everything
//   node tools/vendor-sync.mjs --check    # verify hashes only, no network
//
// Why these files are in the repo at all.
//
// index.html used to load all of them from cdn.jsdelivr.net as PARSER-BLOCKING
// <script> tags plus two render-blocking <link>s. That put a third-party origin
// on the critical path of every single launch: nothing in this app paints
// before JavaScript runs (the shell and all three boot overlays ship `hidden`),
// and src/main.js cannot execute until every one of those tags has resolved. A
// CDN that merely HANGS — a captive portal, a filtering proxy, a dead cell —
// therefore produced a blank screen for as long as it hung, which is what "the
// app is not offline friendly" actually meant.
//
// The service worker did precache them, but into CACHE_NAME, which is the
// commit sha: every release threw all 82 of them away, and skipWaiting() ran
// BEFORE the re-download. So each deploy handed every install a worker whose
// third-party cache was empty, and the next offline launch had nothing.
//
// Same-origin files in vendor/ are precached with the app shell instead, in the
// same all-or-nothing bracket as the HTML, and their version lives in the PATH
// so the URL never changes between releases and the bytes are never re-fetched.
//
// The heavy on-demand libraries (mermaid, jszip, nomnoml, turndown) stay on the
// CDN — see LIB_URLS in src/core/lib-loader.js and CDN_ASSETS in sw.js. They
// are not on the boot path, and sw.js now keeps them in a cache that survives a
// release.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "vendor");
const LOCK = path.join(VENDOR, "lock.json");
const CDN = "https://cdn.jsdelivr.net/npm/";

const KATEX_FONTS = [
  "KaTeX_AMS-Regular", "KaTeX_Caligraphic-Bold", "KaTeX_Caligraphic-Regular",
  "KaTeX_Fraktur-Bold", "KaTeX_Fraktur-Regular", "KaTeX_Main-Bold",
  "KaTeX_Main-BoldItalic", "KaTeX_Main-Italic", "KaTeX_Main-Regular",
  "KaTeX_Math-BoldItalic", "KaTeX_Math-Italic", "KaTeX_SansSerif-Bold",
  "KaTeX_SansSerif-Italic", "KaTeX_SansSerif-Regular", "KaTeX_Script-Regular",
  "KaTeX_Size1-Regular", "KaTeX_Size2-Regular", "KaTeX_Size3-Regular",
  "KaTeX_Size4-Regular", "KaTeX_Typewriter-Regular"
];

// The grammars the Prism autoloader may ask for. Kept identical to the list
// sw.js used to precache from the CDN — anything outside it still works online
// and degrades to an unhighlighted code block offline.
const PRISM_LANGS = [
  "clike", "markup", "markup-templating", "css", "css-extras",
  "javascript", "typescript", "jsx", "tsx", "json", "yaml",
  "bash", "c", "cpp", "csharp", "java", "go", "rust", "ruby", "php", "sql",
  "python", "markdown", "latex", "kotlin", "swift", "coffeescript", "fsharp",
  "r", "matlab", "perl", "lua", "dart", "scala", "haskell", "docker", "git",
  "ini", "toml", "graphql", "regex", "diff", "powershell", "makefile",
  "nginx", "http"
];

// local path (relative to the repo root) -> URL it came from.
//
// The version is in the DIRECTORY NAME, deliberately. That makes every URL
// immutable, which is what lets sw.js keep these in a cache that survives a
// release and never re-download them — and it means a version bump is a new
// path that cannot be answered by a stale cache entry.
export const VENDOR_FILES = {
  "vendor/dompurify-3.1.6/purify.min.js": `${CDN}dompurify@3.1.6/dist/purify.min.js`,
  "vendor/marked-14.1.2/marked.min.js": `${CDN}marked@14.1.2/marked.min.js`,

  "vendor/katex-0.16.11/katex.min.js": `${CDN}katex@0.16.11/dist/katex.min.js`,
  "vendor/katex-0.16.11/auto-render.min.js": `${CDN}katex@0.16.11/dist/contrib/auto-render.min.js`,
  // katex.min.css asks for url(fonts/KaTeX_*.woff2) RELATIVE to itself, so the
  // stylesheet and the fonts/ directory have to stay siblings. Renaming either
  // silently loses every glyph.
  "vendor/katex-0.16.11/katex.min.css": `${CDN}katex@0.16.11/dist/katex.min.css`,
  ...Object.fromEntries(KATEX_FONTS.map((f) => [
    `vendor/katex-0.16.11/fonts/${f}.woff2`,
    `${CDN}katex@0.16.11/dist/fonts/${f}.woff2`
  ])),

  "vendor/prismjs-1.30.0/prism-core.min.js": `${CDN}prismjs@1.30.0/components/prism-core.min.js`,
  "vendor/prismjs-1.30.0/prism-autoloader.min.js": `${CDN}prismjs@1.30.0/plugins/autoloader/prism-autoloader.min.js`,
  "vendor/prismjs-1.30.0/prism-tomorrow.min.css": `${CDN}prismjs@1.30.0/themes/prism-tomorrow.min.css`,
  // The autoloader resolves grammars against languages_path (set in
  // src/main.js), so these MUST keep prism's own file names.
  ...Object.fromEntries(PRISM_LANGS.map((l) => [
    `vendor/prismjs-1.30.0/components/prism-${l}.min.js`,
    `${CDN}prismjs@1.30.0/components/prism-${l}.min.js`
  ])),

  // Pinned, and the pin matters: this file is served cache-first and never
  // revalidated, so an unpinned "@2" would freeze whatever jsDelivr happened to
  // resolve on the day each user's cache was populated. Bump it here and the
  // path changes with it.
  "vendor/supabase-js-2.112.2/supabase.min.js": `${CDN}@supabase/supabase-js@2.112.2`
};

// The eight that index.html loads up front. Split out because the deploy job
// checks these are actually referenced from the HTML, while the fonts and the
// autoloaded grammars are subresources nothing links directly.
export const VENDOR_BOOT_FILES = [
  "vendor/dompurify-3.1.6/purify.min.js",
  "vendor/marked-14.1.2/marked.min.js",
  "vendor/prismjs-1.30.0/prism-core.min.js",
  "vendor/prismjs-1.30.0/components/prism-python.min.js",
  "vendor/prismjs-1.30.0/prism-autoloader.min.js",
  "vendor/katex-0.16.11/katex.min.js",
  "vendor/katex-0.16.11/auto-render.min.js",
  "vendor/supabase-js-2.112.2/supabase.min.js",
  "vendor/katex-0.16.11/katex.min.css",
  "vendor/prismjs-1.30.0/prism-tomorrow.min.css"
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK, "utf8"));
  } catch {
    return {};
  }
}

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const CHECK = process.argv.includes("--check");
  const FORCE = process.argv.includes("--force");
  const lock = readLock();
  const problems = [];
  const nextLock = {};
  let fetched = 0;

  for (const [rel, url] of Object.entries(VENDOR_FILES)) {
    const full = path.join(ROOT, rel);
    const have = existsSync(full) ? readFileSync(full) : null;

    if (CHECK) {
      if (!have) { problems.push(`${rel} is missing — run: node tools/vendor-sync.mjs`); continue; }
      if (!lock[rel]) { problems.push(`${rel} is not in vendor/lock.json`); continue; }
      if (lock[rel].sha256 !== sha256(have)) problems.push(`${rel} does not match its recorded hash`);
      if (lock[rel].url !== url) problems.push(`${rel} was fetched from ${lock[rel].url}, manifest now says ${url}`);
      continue;
    }

    if (have && !FORCE && lock[rel]?.sha256 === sha256(have) && lock[rel]?.url === url) {
      nextLock[rel] = lock[rel];
      continue;
    }
    const body = await download(url);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
    nextLock[rel] = { url, sha256: sha256(body), bytes: body.length };
    fetched++;
    process.stdout.write(`  fetched ${rel} (${Math.round(body.length / 1024)}KB)\n`);
  }

  if (CHECK) {
    // A file in vendor/ that the manifest no longer names is dead weight the
    // service worker would still be precaching.
    for (const rel of Object.keys(lock)) {
      if (!VENDOR_FILES[rel]) problems.push(`${rel} is in lock.json but not in the manifest — delete it`);
    }
    if (problems.length) {
      console.error("vendor-sync: FAIL");
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    const total = Object.values(lock).reduce((n, e) => n + (e.bytes || 0), 0);
    console.log(`vendor-sync: ${Object.keys(VENDOR_FILES).length} files · ${Math.round(total / 1024)}KB · OK`);
    return;
  }

  // Drop anything the manifest dropped, so a version bump doesn't leave the old
  // directory behind to be precached forever.
  for (const rel of Object.keys(lock)) {
    if (VENDOR_FILES[rel]) continue;
    const full = path.join(ROOT, rel);
    if (existsSync(full)) { rmSync(full); process.stdout.write(`  removed ${rel}\n`); }
  }

  const ordered = Object.fromEntries(Object.keys(VENDOR_FILES).map((rel) => [rel, nextLock[rel]]));
  writeFileSync(LOCK, `${JSON.stringify(ordered, null, 2)}\n`);
  syncVendorAssets(Object.keys(ordered));
  const total = Object.values(ordered).reduce((n, e) => n + (e.bytes || 0), 0);
  console.log(`vendor-sync: ${Object.keys(ordered).length} files · ${Math.round(total / 1024)}KB · ${fetched} fetched`);
}

// Rewrite sw.js's VENDOR_ASSETS from what is actually on disk.
//
// Generated rather than hand-kept for the reason every list in this repo is: a
// file added here and forgotten there is invisible online — the network answers
// — and shows up only on someone's first offline launch, which is the one
// occasion the precache exists for. tools/precache-check.mjs enforces the same
// thing statically, so a hand-edit cannot survive a check run either.
function syncVendorAssets(files) {
  const swPath = path.join(ROOT, "sw.js");
  const sw = readFileSync(swPath, "utf8");
  const start = "// vendor-assets:start";
  const end = "// vendor-assets:end";
  const a = sw.indexOf(start);
  const b = sw.indexOf(end);
  if (a === -1 || b === -1) {
    console.error("  ! sw.js has no vendor-assets block");
    return;
  }
  const body = `const VENDOR_ASSETS = [\n${
    [...files].sort().map((rel) => `  "./${rel}",`).join("\n").replace(/,$/, "")
  }\n];\n`;
  const next = `${sw.slice(0, a + start.length)}\n${body}${sw.slice(b)}`;
  if (next !== sw) writeFileSync(swPath, next);
}

main().catch((error) => {
  console.error("vendor-sync failed:", error.message);
  process.exit(1);
});
