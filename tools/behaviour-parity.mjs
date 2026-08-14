// Does the split code still PRODUCE the same output as the code it came from?
//
//   node tools/behaviour-parity.mjs            # compare against the pre-modular tag
//   node tools/behaviour-parity.mjs --base=REF
//
// split-parity proves the source text is unchanged. module-symbols proves the
// references resolve. boot-check proves it starts. None of them proves that
// running it gives the same answers — and the whole promise of this restructure
// is that it does.
//
// So: load the baseline app.js as a classic script in one page and the module
// tree in another, push identical inputs through the pure parts of the pipeline
// on both sides, and diff the results. Same browser, same libraries, same DOM.
//
// It covers the parts that are reachable without a Supabase session: markdown
// rendering (math, clozes, note links, citations, images, tables, diagrams),
// card parsing, and the editor's text transforms. That is the code most likely
// to be quietly broken by a move and least likely to be noticed if it is.

import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
// The baseline is the TAG pre-modular, not a branch. It used to default to
// `main`, which stopped meaning anything the moment the restructure landed
// there — main became the thing under test, and the comparison had nothing
// left to compare against.
const BASE_REF = (args.find((a) => a.startsWith("--base=")) || "--base=pre-modular").slice(7);
const CASES = JSON.parse(readFileSync(path.join(ROOT, "tools/behaviour-cases.json"), "utf8"));

const CHROME = [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"
].find(existsSync);

function loadPuppeteer() {
  for (const base of [ROOT, "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/"]) {
    try { return createRequire(path.join(base, "x.js"))("puppeteer"); } catch (_) { /* next */ }
  }
  return null;
}
const puppeteer = loadPuppeteer();
if (!puppeteer || !CHROME) { console.log("behaviour-parity: no puppeteer/Chrome — skipping."); process.exit(0); }

// The probe runs INSIDE the page, against whatever `api` the harness handed it.
// Written as a string so both sides run byte-identical code.
const PROBE = `(api, cases) => {
  const out = {};
  const safe = (label, fn) => { try { out[label] = String(fn()); } catch (e) { out[label] = "THREW: " + e.message; } };

  cases.markdown.forEach((md, i) => {
    safe("prepare/" + i, () => api.preprocessSpecialBlocks(md));
    safe("math/" + i, () => api.protectMath(md));
    safe("cloze/" + i, () => api.applyClozeMarkup(md));
    safe("inline/" + i, () => api.protectInline(md));
    safe("cite/" + i, () => api.normalizeCitations(md));
    safe("repair/" + i, () => api.repairEscapedMathMarkdown(md));
    safe("html/" + i, () => api.markdownToSafeHtml(md));
    safe("ranges/" + i, () => JSON.stringify(api.findMathRanges(md)));
  });

  cases.decks.forEach((md, i) => {
    // Card ids end in a random suffix by design, so they differ every call on
    // both sides. Normalise it away — what has to match is the SPLIT into
    // questions and answers, not the entropy.
    safe("cards/" + i, () => JSON.stringify(api.parseCards(md)).replace(/-[a-z0-9]{6}"/g, '-RANDOM"'));
    safe("classify/" + i, () => api.classifyCardSyntax(md));
    safe("title/" + i, () => api.inferDeckTitle(md, ""));
    safe("notes/" + i, () => api.extractNotesFromMarkdown(md));
    safe("qheads/" + i, () => api.countQuestionHeadings(md));
  });

  cases.transforms.forEach((c, i) => {
    const [fn, ...rest] = c;
    safe("tx/" + fn + "/" + i, () => api[fn](...rest));
  });

  // Language inference over the code fences.
  ["def f(x):\\n  return 1", "const a = 1;", "SELECT * FROM t;", "<div class='a'></div>", "#include <stdio.h>"]
    .forEach((src, i) => safe("lang/" + i, () => api.inferCodeLanguage(src)));

  return out;
}`;

// Names the probe needs, and where they now live.
const API = [
  "preprocessSpecialBlocks", "protectMath", "applyClozeMarkup", "protectInline",
  "normalizeCitations", "repairEscapedMathMarkdown", "markdownToSafeHtml", "findMathRanges",
  "parseCards", "classifyCardSyntax", "inferDeckTitle", "extractNotesFromMarkdown",
  "countQuestionHeadings", "inferCodeLanguage",
  "toggleWrap", "toggleUnderline", "toggleStrikethrough", "toggleCode", "toggleCloze",
  "toggleBulletPoints", "clearFormatting", "clearStyling"
];

// The clipper vendors these, so the check needs no network.
const VENDORED = [
  path.join(ROOT, "recall-clipper/vendor/marked.min.js"),
  path.join(ROOT, "recall-clipper/vendor/purify.min.js")
];

// Start a server on a FREE port and resolve to its URL base. Fixed ports made
// these checks quietly unreliable — a server left behind by an interrupted run
// keeps the port, the new bind fails, and the stale one answers from a
// different tree.
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

async function collect(url, buildApi) {
  const browser = await puppeteer.launch({ headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
    // The render probes go through marked + DOMPurify. index.html pulls those
    // from a CDN, which makes this check depend on the network being up and on
    // jsdelivr not rate-limiting — neither of which says anything about whether
    // the split is correct. Inject the copies the clipper already vendors, into
    // BOTH pages, so the comparison is hermetic and both sides run identical
    // library code.
    for (const lib of VENDORED) {
      if (!existsSync(lib)) continue;
      await page.addScriptTag({ path: lib });
    }
    try {
      await page.waitForFunction("window.marked && window.DOMPurify", { timeout: 15000 });
    } catch (_) {
      return { result: null, errors: ["marked/DOMPurify unavailable (no CDN and no vendored copy)"] };
    }
    const result = await page.evaluate(
      async (probeSrc, apiSrc, cases) => {
        const api = await (0, eval)(apiSrc)();
        return (0, eval)("(" + probeSrc + ")")(api, cases);
      },
      PROBE, buildApi, CASES
    );
    return { result, errors };
  } finally {
    await browser.close();
  }
}

const servers = [];
const temps = [];
try {
  // ── Baseline: app.js is a classic script, so its functions are page globals
  // only if it ran at top level. It did — that is what the restructure changed.
  const baseDir = mkdtempSync(path.join(tmpdir(), "recall-base-"));
  temps.push(baseDir);
  execFileSync("bash", ["-c", `git archive ${BASE_REF} | tar -x -C ${baseDir}`], { cwd: ROOT });
  // app.js declares everything with `function`/`const` at top level of a classic
  // script, which lands on the global object for `function` but NOT for `const`.
  // Re-evaluate it inside a wrapper that hands the names back instead.
  const appJs = readFileSync(path.join(baseDir, "app.js"), "utf8");
  writeFileSync(path.join(baseDir, "probe.js"),
    `window.__recallApi = (function () {\n${appJs}\n;return { ${API.join(", ")} };\n})();\n`);
  const html = readFileSync(path.join(baseDir, "index.html"), "utf8")
    .replace('<script src="app.js?v=__BUILD__"></script>', '<script src="probe.js"></script>');
  writeFileSync(path.join(baseDir, "index.html"), html);
  const __s_baseDir = await serveOn(baseDir); servers.push(__s_baseDir.proc);

  const __s_ROOT = await serveOn(ROOT); servers.push(__s_ROOT.proc);
  await new Promise((r) => setTimeout(r, 1500));

  const before = await collect(`${__s_baseDir.base}/index.html`, "async () => window.__recallApi");
  const after = await collect(
    `${__s_ROOT.base}/index.html`,
    // Import the modules that now own each name and reassemble the same surface.
    `async () => {
      const mods = await Promise.all([
        import("/src/render/preprocess.js?v=__BUILD__"), import("/src/render/math.js?v=__BUILD__"),
        import("/src/render/cloze-markup.js?v=__BUILD__"), import("/src/render/inline.js?v=__BUILD__"),
        import("/src/import/parse-cards.js?v=__BUILD__"), import("/src/render/code-language.js?v=__BUILD__"),
        import("/src/editor/text-transforms.js?v=__BUILD__")
      ]);
      const api = {};
      for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
      return api;
    }`
  );

  if (!before.result || !after.result) {
    console.log(`  SKIPPED: ${(before.errors[0] || after.errors[0])}`);
    console.log("  (the static checks still cover the code; this one needs cdn.jsdelivr.net)");
    process.exit(0);
  }
  const keys = [...new Set([...Object.keys(before.result), ...Object.keys(after.result)])].sort();
  const diffs = keys.filter((k) => before.result[k] !== after.result[k]);
  const threw = keys.filter((k) => String(after.result[k]).startsWith("THREW"));

  for (const k of diffs.slice(0, 12)) {
    console.log(`  DIFF ${k}`);
    console.log(`    ${BASE_REF}: ${JSON.stringify(String(before.result[k]).slice(0, 220))}`);
    console.log(`    now:  ${JSON.stringify(String(after.result[k]).slice(0, 220))}`);
  }
  if (diffs.length > 12) console.log(`  … and ${diffs.length - 12} more`);
  if (before.errors.length) console.log(`  baseline page errors: ${before.errors.slice(0, 3).join(" | ")}`);
  if (after.errors.length) console.log(`  current page errors: ${after.errors.slice(0, 3).join(" | ")}`);

  console.log(`\n${keys.length} probes · ${diffs.length} differ · ${threw.length} threw`);
  process.exitCode = diffs.length || threw.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
