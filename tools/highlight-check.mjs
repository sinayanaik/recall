// Does highlighting mark the thing that was selected?
//
//   node tools/highlight-check.mjs
//
// behaviour-parity asks "does this still give the same answer as before?", which
// is the wrong question for a fix: the whole point of a fix is that the answer
// changes. This asks the other question — "is the answer right?" — for the parts
// of highlighting that are pure functions of a string, and it asserts outcomes
// rather than comparing builds.
//
// Every case here is a shape that was reported as "it says Highlighted but I
// see no highlight". They are all things a note is ordinarily made of: bullets,
// tables, headings, code. None of them is exotic, and each one failed for its
// own separate reason, so each one gets its own assertion rather than a single
// end-to-end drag that could pass for the wrong reason.
//
// Run in a real browser, not node: these modules reach the DOM (textWithLineBreaks
// walks rendered nodes, and the module graph pulls in core/dom.js on the way).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
if (!puppeteer || !CHROME) { console.log("highlight-check: no puppeteer/Chrome — skipping."); process.exit(0); }

// Same free-port server the other browser checks use: a fixed port left behind
// by an interrupted run answers from a different tree.
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

// Runs INSIDE the page. Returns [{ name, ok, detail }].
const PROBE = `(api) => {
  const results = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, ok: detail === true, detail: detail === true ? "" : String(detail) });
    } catch (e) {
      results.push({ name, ok: false, detail: "THREW: " + e.message });
    }
  };

  // ── wrapAcrossBlocks: one mark per block, prefixes left outside ──────────

  // The DEFAULT colour is written as a bare <mark> with no data-color (so
  // highlights made before colours existed keep matching), so these cases use a
  // non-default one wherever the attribute itself is being asserted.
  check("bullets: every item marked, markers outside", () => {
    const out = api.wrapAcrossBlocks("- alpha\\n- beta\\n- gamma", "green");
    const lines = out.split("\\n");
    if (lines.length !== 3) return "expected 3 lines, got " + JSON.stringify(out);
    for (const line of lines) {
      if (!/^- <mark data-color="green">/.test(line)) return "marker not outside the mark: " + line;
      if (!line.endsWith("</mark>")) return "unclosed mark: " + line;
    }
    return true;
  });

  check("setext H1: the === underline is not wrapped", () => {
    const out = api.wrapAcrossBlocks("Chapter One\\n===========", "yellow");
    if (/<mark[^>]*>=+/.test(out) || /=+<\\/mark>/.test(out)) return "underline got wrapped: " + JSON.stringify(out);
    if (!out.includes("<mark")) return "the heading text was not marked at all: " + JSON.stringify(out);
    return true;
  });

  check("setext H2: the --- underline is not wrapped", () => {
    const out = api.wrapAcrossBlocks("Section Two\\n-----------", "yellow");
    if (/<mark[^>]*>-+/.test(out) || /-+<\\/mark>/.test(out)) return "underline got wrapped: " + JSON.stringify(out);
    return true;
  });

  check("indented code: left verbatim", () => {
    const out = api.wrapAcrossBlocks("prose here\\n\\n    const x = 1;\\n    return x;", "yellow");
    if (out.includes("<mark") === false) return "nothing was marked at all";
    const code = out.split("\\n").filter((l) => l.startsWith("    "));
    if (!code.length) return "the indented lines vanished: " + JSON.stringify(out);
    for (const line of code) if (line.includes("<mark")) return "mark dropped into indented code: " + line;
    return true;
  });

  check("fenced code: still left verbatim", () => {
    const out = api.wrapAcrossBlocks("prose\\n\\n\\\`\\\`\\\`js\\nconst x = 1;\\n\\\`\\\`\\\`", "yellow");
    if (out.includes("<mark>const") || /<mark[^>]*>const/.test(out)) return "mark inside a fence: " + JSON.stringify(out);
    return true;
  });

  check("list continuation: indentation is NOT read as code", () => {
    // Four spaces after a blank line INSIDE a list is the item's own second
    // paragraph — ordinary prose the reader expects to highlight.
    const out = api.wrapAcrossBlocks("- alpha\\n\\n    more about alpha", "yellow");
    if (!out.includes("more about alpha")) return "the continuation vanished: " + JSON.stringify(out);
    if (!/<mark[^>]*>more about alpha/.test(out)) return "continuation was treated as code: " + JSON.stringify(out);
    return true;
  });

  check("table row: one mark per cell, pipes outside", () => {
    const out = api.wrapAcrossBlocks("| Element | Symbol |", "green");
    const marks = (out.match(/<mark/g) || []).length;
    if (marks !== 2) return "expected 2 cell marks, got " + marks + ": " + JSON.stringify(out);
    if (out.includes("<mark data-color=\\"green\\">|")) return "a pipe got swallowed: " + JSON.stringify(out);
    return true;
  });

  check("blockquote: the > prefix stays outside", () => {
    const out = api.wrapAcrossBlocks("> quoted line", "yellow");
    if (!out.startsWith("> <mark")) return "quote marker not outside: " + JSON.stringify(out);
    return true;
  });

  check("heading: the ## prefix stays outside", () => {
    const out = api.wrapAcrossBlocks("## A heading", "yellow");
    if (!out.startsWith("## <mark")) return "hashes not outside: " + JSON.stringify(out);
    return true;
  });

  // ── textWithLineBreaks: a rendered table reads back as its source shape ──

  const render = (html) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host;
  };

  check("table selection: cells separated, rows on their own lines", () => {
    const host = render("<table><thead><tr><th>Element</th><th>Symbol</th></tr></thead>" +
                        "<tbody><tr><td>Hydrogen</td><td>H</td></tr></tbody></table>");
    const text = api.textWithLineBreaks(host).trim();
    if (text.includes("ElementSymbol")) return "cells still run together: " + JSON.stringify(text);
    if (!text.includes("Element | Symbol")) return "no cell separator: " + JSON.stringify(text);
    if (!text.includes("Hydrogen | H")) return "no cell separator in the body row: " + JSON.stringify(text);
    if (!/Symbol\\s*\\n\\s*Hydrogen/.test(text)) return "header and body row not on separate lines: " + JSON.stringify(text);
    return true;
  });

  check("table selection: a cell's own padding is not content", () => {
    const host = render("<table><tbody><tr><td>  Hydrogen  </td><td>H</td></tr></tbody></table>");
    const text = api.textWithLineBreaks(host).trim();
    if (!text.startsWith("Hydrogen | H")) return "cell padding leaked: " + JSON.stringify(text);
    return true;
  });

  check("list selection: still one line per item", () => {
    const host = render("<ul><li>alpha</li><li>beta</li></ul>");
    const text = api.textWithLineBreaks(host).trim();
    if (text !== "alpha\\nbeta") return "list shape changed: " + JSON.stringify(text);
    return true;
  });

  check("paragraph selection: still a blank line between blocks", () => {
    const host = render("<p>one</p><p>two</p>");
    const text = api.textWithLineBreaks(host).trim();
    if (text !== "one\\n\\ntwo") return "paragraph shape changed: " + JSON.stringify(text);
    return true;
  });

  // ── locateSelectionInSource: a hit never starts or ends mid-construct ────

  check("hit crossing a bold marker is widened to the whole run", () => {
    const source = "Some **bold text** here.";
    // The rendered text of "**bold text**" is "bold text", so a drag from
    // mid-bold to past the closing marker finds "text here" verbatim.
    const loc = api.locateSelectionInSource(source, { asText: "text here", occurrence: 0 }, { fuzzy: true });
    if (!loc) return "no match at all";
    const slice = source.slice(loc.idx, loc.end);
    const opens = (slice.match(/\\*\\*/g) || []).length;
    if (opens % 2 !== 0) return "unbalanced ** in the match: " + JSON.stringify(slice);
    return true;
  });

  check("hit inside a code span is widened past the backticks", () => {
    const source = "Call \\\`someFunction\\\` now.";
    const loc = api.locateSelectionInSource(source, { asText: "someFunction", occurrence: 0 }, { fuzzy: true });
    if (!loc) return "no match at all";
    const slice = source.slice(loc.idx, loc.end);
    const ticks = (slice.match(/\\\`/g) || []).length;
    if (ticks % 2 !== 0) return "unbalanced backticks: " + JSON.stringify(slice);
    return true;
  });

  check("a hit wholly inside a CONTAINER is not widened", () => {
    // Markup nests inside bold perfectly well, so this hit is already balanced.
    // Widening it would hide the tags highlightToggleInSource reads to find an
    // existing highlight — which is how re-highlighting nested a second mark
    // instead of removing the first.
    const source = "Some **bold text here** and more.";
    const loc = api.locateSelectionInSource(source, { asText: "bold text here", occurrence: 0 }, { fuzzy: true });
    if (!loc) return "no match at all";
    const slice = source.slice(loc.idx, loc.end);
    if (slice !== "bold text here") return "widened when it did not need to: " + JSON.stringify(slice);
    return true;
  });

  check("a hit wholly inside a LITERAL is widened", () => {
    // Nothing can be inserted inside a code span: <mark> there renders as the
    // literal text "<mark>". So containment still has to widen here.
    const source = "Call \\\`the function\\\` now.";
    const loc = api.locateSelectionInSource(source, { asText: "the function", occurrence: 0 }, { fuzzy: true });
    if (!loc) return "no match at all";
    const slice = source.slice(loc.idx, loc.end);
    if (!slice.startsWith("\\\`") || !slice.endsWith("\\\`")) return "did not swallow the backticks: " + JSON.stringify(slice);
    return true;
  });

  check("an ordinary hit is left exactly where it was", () => {
    const source = "Plain prose with nothing special in it.";
    const loc = api.locateSelectionInSource(source, { asText: "nothing special", occurrence: 0 }, { fuzzy: true });
    if (!loc) return "no match at all";
    if (source.slice(loc.idx, loc.end) !== "nothing special") return "widened for no reason: " + JSON.stringify(source.slice(loc.idx, loc.end));
    return true;
  });

  check("the SELECTED copy is targeted, not the first one", () => {
    const source = "the thing here\\n\\nand the thing here again";
    const loc = api.locateSelectionInSource(source, { asText: "the thing here", occurrence: 1 }, { fuzzy: true });
    if (!loc) return "no match at all";
    if (loc.idx < source.indexOf("and")) return "landed on the first copy, not the second";
    return true;
  });

  // ── highlightToggleInSource: end to end over the same shapes ─────────────

  check("highlighting a bullet list adds a mark to every item", () => {
    const source = "intro\\n\\n- alpha\\n- beta\\n- gamma\\n\\noutro";
    const result = api.highlightToggleInSource(source, { asText: "alpha\\nbeta\\ngamma", occurrence: 0 }, "green");
    if (!result) return "could not locate the selection";
    if (result.action !== "added") return "action was " + result.action;
    const marks = (result.text.match(/<mark/g) || []).length;
    if (marks !== 3) return "expected 3 marks, got " + marks + ": " + JSON.stringify(result.text);
    if (result.text.includes("<mark data-color=\\"green\\">- ")) return "a marker got swallowed: " + JSON.stringify(result.text);
    return true;
  });

  check("highlighting then re-highlighting the same words removes it", () => {
    const source = "one plain sentence here";
    const added = api.highlightToggleInSource(source, { asText: "plain sentence", occurrence: 0 }, "yellow");
    if (!added || added.action !== "added") return "first pass did not add: " + JSON.stringify(added);
    const removed = api.highlightToggleInSource(added.text, { asText: "plain sentence", occurrence: 0 }, "yellow");
    if (!removed) return "could not locate the mark to remove it";
    if (removed.action !== "removed") return "second pass said " + removed.action;
    if (removed.text !== source) return "did not round-trip: " + JSON.stringify(removed.text);
    return true;
  });

  // ── Bulletify ─────────────────────────────────────────────────────────────────
  //
  // The point is the run-on line: a paragraph that IS a list and was never
  // written as one. A line-based toggle cannot help there.
  check("bulletify splits a run-on line on its semicolons", () => {
    const out = api.smartBulletify("You need eggs; whisk them together; then rest the batter.");
    const lines = out.split("\\n");
    if (lines.length !== 3) return "got " + lines.length + " bullets: " + JSON.stringify(out);
    if (!lines.every((l) => l.indexOf("- ") === 0)) return "not all bulleted: " + JSON.stringify(out);
    return true;
  });

  check("bulletify splits a run-on line on sentence ends", () => {
    const out = api.smartBulletify("First do this. Then do that. Finally check the result.");
    if (out.split("\\n").length !== 3) return JSON.stringify(out);
    return true;
  });

  check("bulletify splits inline numbering and eats the numbers", () => {
    const out = api.smartBulletify("Steps: 1) preheat the oven 2) mix the batter 3) bake it");
    const lines = out.split("\\n");
    if (lines.length !== 4) return "got " + lines.length + ": " + JSON.stringify(out);
    if (lines.some((l) => /^- [0-9]+[.)]/.test(l))) return "a number marker survived: " + JSON.stringify(out);
    return true;
  });

  check("bulletify gives several lines one bullet each", () => {
    const out = api.smartBulletify("line one\\nline two\\nline three");
    if (out !== "- line one\\n- line two\\n- line three") return JSON.stringify(out);
    return true;
  });

  check("bulletify toggles an existing list back off", () => {
    const out = api.smartBulletify("- already\\n- a list");
    if (out !== "already\\na list") return JSON.stringify(out);
    return true;
  });

  check("bulletify leaves a single plain sentence as one bullet", () => {
    const out = api.smartBulletify("one line only");
    if (out !== "- one line only") return JSON.stringify(out);
    return true;
  });

  // ── Editing a highlight by ordinal ──────────────────────────────────────
  //
  // The panel controls address a mark by its POSITION among all marks, never by
  // its text: the text of a highlight is very often repeated elsewhere.
  check("the nth mark is found by ordinal, not by text", () => {
    const src = "one <mark>same words</mark> two <mark data-color=\\"blue\\">same words</mark> three";
    const first = api.markSpanAt(src, 0);
    const second = api.markSpanAt(src, 1);
    if (!first || !second) return "a span was not found";
    if (!(second.start > first.start)) return "the second span is not after the first";
    if (src.slice(second.start, second.end).indexOf("blue") === -1) return "the second span is not the blue one";
    return true;
  });

  check("a highlight spanning several list items moves as one group", () => {
    const src = "- <mark>alpha</mark>\\n- <mark>bravo</mark>\\n- <mark>charlie</mark>";
    const group = api.markGroupSpanAt(src, 0);
    if (!group) return "no group found";
    if (group.count !== 3) return "grouped " + group.count + " marks, expected 3";
    return true;
  });

  check("a separate highlight is NOT swept into the group", () => {
    const src = "- <mark>alpha</mark>\\n\\nplain paragraph\\n\\n- <mark>bravo</mark>";
    const group = api.markGroupSpanAt(src, 0);
    if (!group) return "no group found";
    if (group.count !== 1) return "grouped " + group.count + " marks, expected 1";
    return true;
  });

  return results;
}`;

const API_SRC = `async () => {
  const mods = await Promise.all([
    import("/src/format/highlight.js?v=__BUILD__"),
    import("/src/format/locate-selection.js?v=__BUILD__"),
    import("/src/notes/selection.js?v=__BUILD__"),
    import("/src/editor/text-transforms.js?v=__BUILD__"),
    import("/src/panels/highlights-panel.js?v=__BUILD__"),
    import("/src/format/highlight-edit.js?v=__BUILD__")
  ]);
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const servers = [];
try {
  const server = await serveOn(ROOT);
  servers.push(server.proc);
  await new Promise((r) => setTimeout(r, 800));

  const browser = await puppeteer.launch({
    headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  let results;
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${server.base}/index.html`, { waitUntil: "networkidle2", timeout: 90000 });
    results = await page.evaluate(
      async (probeSrc, apiSrc) => {
        const api = await (0, eval)(apiSrc)();
        return (0, eval)("(" + probeSrc + ")")(api);
      },
      PROBE, API_SRC
    );
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log(`\n${results.length} highlight cases · ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
}
