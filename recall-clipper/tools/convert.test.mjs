// Headless conversion tests for the Recall Clipper.
//
// Loads a fixture page in Chromium, injects exactly what background.js injects,
// clicks the fixture's #clip block to select it, and asserts on the Markdown
// convert() produces. This is the only way to test the picker honestly: every
// interesting decision it makes is a DOM decision (shadow roots, computed
// attributes, MathML trees), so a string-level unit test would prove nothing.
//
//   node tools/convert.test.mjs            # all fixtures
//   node tools/convert.test.mjs --print    # also dump the produced markdown
//
// Chromium comes from the puppeteer that ships with @mermaid-js/mermaid-cli;
// override with PUPPETEER_PATH=/path/to/puppeteer if you have your own.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PRINT = process.argv.includes("--print");

const PUPPETEER_PATHS = [
  process.env.PUPPETEER_PATH,
  "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/node_modules",
  "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules"
].filter(Boolean);

const puppeteer = require(require.resolve("puppeteer", { paths: PUPPETEER_PATHS }));

// Puppeteer's own Chrome download lives under a cache directory it resolves
// relative to the working directory, so `node tools/convert.test.mjs` and
// `cd tools && node convert.test.mjs` don't always find the same thing (or any
// thing). Prefer a system browser, which is what's actually installed here.
import { existsSync } from "node:fs";
const CHROME = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium"
].find((p) => p && existsSync(p));

// What background.js injects into the page's MAIN world before anything else.
const MAIN_WORLD = ["content/mathjax-source.js"];
// Exactly background.js's VENDOR list, plus picker.js. Keep in step with it.
const INJECT = [
  "vendor/turndown.js",
  "vendor/turndown-plugin-gfm.js",
  "vendor/purify.min.js",
  "vendor/marked.min.js",
  "content/recall-math.js",
  "content/recall-render.js",
  "content/picker.js"
];

async function open(browser, fixture) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(`file://${path.join(HERE, "fixtures", fixture)}`, { waitUntil: "load" });
  // Puppeteer evaluates in the page's own world, so a plain script tag is the
  // same world the extension asks for with `world: "MAIN"`.
  for (const file of [...MAIN_WORLD, ...INJECT]) await page.addScriptTag({ path: path.join(ROOT, file) });
  return { page, errors };
}

// Pick the fixture's #clip block and convert it.
async function clip(browser, fixture) {
  const { page, errors } = await open(browser, fixture);
  await page.evaluate(() => document.getElementById("clip").click());
  const result = await page.evaluate(() => window.__recallClipper.convert());
  await page.close();
  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  return result;
}

// Drive the Smart Remove workflow: switch to remove mode, delete one block,
// keep nothing — so convert() takes the "remaining" (whole cleaned page) path.
async function clipRemaining(browser, fixture, deleteSelector) {
  const { page, errors } = await open(browser, fixture);
  await page.evaluate((sel) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    document.querySelector(sel).click();
  }, deleteSelector);
  const result = await page.evaluate(() => window.__recallClipper.convert());
  await page.close();
  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  return result;
}

// Switch the picker on, sculpt the page (delete blocks, isolate), then switch it
// off — and check the page came back exactly as it was. The picker drives the
// LIVE DOM to do its job, so "Clear or close restores the page" is a promise it
// has to keep, not a nice-to-have.
async function restoreCheck(browser, fixture) {
  const { page, errors } = await open(browser, fixture);
  const result = await page.evaluate(() => {
    const before = document.body.innerHTML;
    // The picker is already on by the time this runs, so its own marker class is
    // already present — compare against the class list without it.
    const beforeClass = document.documentElement.className
      .split(/\s+/).filter((c) => c && c !== "recall-clip-active").join(" ");
    // Remove mode: delete two blocks, then keep one and isolate everything else.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    document.querySelector("footer").click();
    document.querySelector(".sidebar").click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    document.querySelector("article").click();
    document.querySelector('#recall-clipper-ui [data-act="isolate"]').click();
    const touched = document.body.innerHTML !== before;   // it really did change
    window.__recallClipper.destroy();
    return {
      touched,
      restored: document.body.innerHTML === before,
      classRestored: document.documentElement.className === beforeClass,
      uiGone: !document.getElementById("recall-clipper-ui") &&
              !document.getElementById("recall-clip-overlay"),
      strayAttrs: document.querySelectorAll("[data-recall-clip-removed], [data-recall-tex], [data-recall-tex-display]").length
    };
  });
  await page.close();
  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  return result;
}

// Recall's importer treats certain shapes as explicit FLASHCARD syntax
// (app.js parseCards / hasExplicitCardSyntax). A clip that trips one of them
// gets shredded into question/answer cards instead of landing as notes, which
// is not a formatting nit — it is the wrong destination for the whole clip.
function cardSyntaxTriggers(md) {
  const hits = [];
  if (/<details[\s>]/i.test(md)) hits.push("<details>");
  if (/<summary[\s>]/i.test(md)) hits.push("<summary>");
  if (/(?:^|\n)\s*::/.test(md)) hits.push(":: delimited block");
  if (/^(?:Q|Question)\s*:\s/im.test(md)) hits.push("Q: line");
  if (/^(?:A|Answer)\s*:\s/im.test(md)) hits.push("A: line");
  if (/^#{2,6}\s+.+\?\s*$/m.test(md)) hits.push("## heading ending in ?");
  return hits;
}

// Parse every math span in the markdown with the exact KaTeX build a deck ships,
// and report the ones that fail. This is the end of the chain the clip has to
// survive: it doesn't matter what TeX we captured if KaTeX won't draw it.
async function katexCheck(browser, markdown) {
  const page = await browser.newPage();
  await page.goto("about:blank");
  await page.addScriptTag({ path: path.join(ROOT, "vendor/katex/katex.min.js") });
  const failures = await page.evaluate((md) => {
    const spans = [];
    const re = /\$\$([\s\S]*?)\$\$|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;
    let m;
    while ((m = re.exec(md))) spans.push([m[1] != null, (m[1] ?? m[2]).trim()]);
    const bad = [];
    for (const [display, tex] of spans) {
      try { katex.renderToString(tex, { displayMode: display, throwOnError: true }); }
      catch (e) { bad.push(`${tex.slice(0, 48)} → ${e.message.split("\n")[0].slice(0, 70)}`); }
    }
    return bad;
  }, markdown);
  await page.close();
  return failures;
}

// Run the clipped markdown back through the preview pipeline (recall-render.js),
// which is meant to be a faithful copy of Recall's own renderer.
async function preview(browser, markdown) {
  const { page, errors } = await open(browser, "page.html");
  const html = await page.evaluate((md) => window.__recallRender.markdownToSafeHtml(md), markdown);
  await page.close();
  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  return html;
}

// ---------------------------------------------------------------------------

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
}
function has(md, needle) { return md.includes(needle); }

async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--allow-file-access-from-files"]
  });

  try {
    // ---- Math -------------------------------------------------------------
    const math = await clip(browser, "math.html");
    if (PRINT) console.log("\n===== math.html =====\n" + math.markdown + "\n");

    check("M1 Wikipedia inline math → $E=mc^{2}$", has(math.markdown, "$E=mc^{2}$"));
    check("M1 Wikipedia math is not a fallback image",
      !/!\[.*displaystyle/.test(math.markdown));
    check("M1 {\\displaystyle} wrapper is stripped", !has(math.markdown, "\\displaystyle"));
    check("M1 Wikipedia display math is a $$ block",
      /\$\$\n\\int _\{0\}\^\{1\}x\^\{2\}\\,dx\n\$\$/.test(math.markdown));

    check("M2 MathJax 3 copytext → $a^2 + b^2 = c^2$", has(math.markdown, "$a^2 + b^2 = c^2$"));
    check("M2 MathJax 3 assistive MathML → \\frac{a+b}{2}", has(math.markdown, "\\frac{a+b}{2}"));
    check("M2 MathJax 2 script → $\\alpha_i + \\beta_j$", has(math.markdown, "$\\alpha_i + \\beta_j$"));
    check("M2 MathJax 2 rendered span leaves no residue", !has(math.markdown, "x + y"));
    check("M2 MathJax 2 display mode → $$ block",
      /\$\$\n\\sum_\{i=1\}\^\{n\} i = \\frac\{n\(n\+1\)\}\{2\}\n\$\$/.test(math.markdown));

    check("M3 bare MathML → \\sqrt{x^2+y^2}", has(math.markdown, "$\\sqrt{x^2+y^2}$"));
    check("M3 MathML is not flattened to glyph soup", !/Bare MathML: *x2/.test(math.markdown));
    check("M3 MathML greek/limits → \\sum_{i=1}^n\\alpha_i\\le\\pi",
      has(math.markdown, "$\\sum_{i=1}^n\\alpha_i\\le\\pi$"));

    check("M4 KaTeX with annotation → $\\frac{1}{x_n}$", has(math.markdown, "$\\frac{1}{x_n}$"));
    check("M4 KaTeX without annotation is not deleted", has(math.markdown, "y = 3"));

    check("M5 unrendered $x_k$ keeps its underscore unescaped",
      has(math.markdown, "$x_k = \\frac{a}{b}$"));
    check("M5 unrendered \\(y_1\\) survives", has(math.markdown, "\\(y_1\\)") || has(math.markdown, "$y_1$"));

    check("M6 currency across a sentence is escaped, not swallowed",
      has(math.markdown, "\\$100 million") && has(math.markdown, "US\\$50") &&
      has(math.markdown, "priced at"));
    check("M6 simple currency pair survives verbatim",
      /\\?\$5 for one and \\?\$10 for two/.test(math.markdown));

    check("M6 prose brackets are not escaped into display math",
      has(math.markdown, "[citation needed]") && has(math.markdown, "[Figure 1]"));

    check("M7 \\begin{aligned} is wrapped in $$",
      /\$\$\n\\begin\{aligned\}[\s\S]*\\end\{aligned\}\n\$\$/.test(math.markdown));

    check("M6 a formula opening with a digit is not mistaken for currency",
      has(math.markdown, "$2\\pi - \\epsilon$") && !has(math.markdown, "\\$2\\pi"));

    check("M8 a \\\\ row separator does not trigger backslash-halving",
      has(math.markdown, "\\begin{aligned}") && has(math.markdown, "\\text{rel}") &&
      has(math.markdown, "\\mathbf") && !has(math.markdown, "begin{aligned}\nE") &&
      !/[^\\]begin\{aligned\}/.test(math.markdown));

    // The assertion that matters most: every formula we emit has to survive the
    // renderer on the other side. String-matching the TeX only proves we wrote
    // what we meant to; this proves a deck can draw it.
    const katexFails = await katexCheck(browser, math.markdown);
    check("every captured formula parses in the KaTeX a deck uses",
      katexFails.length === 0, katexFails.join(" | "));

    check("math counts are reported", math.math.captured >= 8 && math.math.missed >= 1,
      `captured=${math.math.captured} missed=${math.math.missed}`);

    // ---- MathJax 3 source recovery (the MAIN-world pass) -------------------
    // These pages expose no annotation and no copytext, so without reading
    // MathJax's own state the only route is its assistive MathML — which is a
    // re-rendering, not the source. Assert we take the source.
    const mj = await clip(browser, "mathjax3.html");
    if (PRINT) console.log("\n===== mathjax3.html =====\n" + mj.markdown + "\n");

    check("MJ3 inline takes the author's source, not the MathML reconstruction",
      has(mj.markdown, "$\\mathbb{R}^2$") && !has(mj.markdown, "{\\mathbb{R}}^2"));
    check("MJ3 display keeps \\left[…\\right] and \\begin{array}",
      has(mj.markdown, "\\left[ \\begin{array}{c} x_{\\mathrm{left}} \\\\ y_{\\mathrm{left}} \\end{array}\\right]"));
    check("MJ3 display math is emitted as a $$ block",
      /\$\$\n\\begin\{equation\}[\s\S]*\\end\{equation\}\n\$\$/.test(mj.markdown));
    check("MJ3 reconstruction fallback is not used", !has(mj.markdown, "\\begin{matrix}"));
    check("MJ3 both formulas captured, none missed",
      mj.math.captured === 2 && mj.math.missed === 0,
      `captured=${mj.math.captured} missed=${mj.math.missed}`);
    const mjFails = await katexCheck(browser, mj.markdown);
    check("MJ3 recovered source parses in KaTeX", mjFails.length === 0, mjFails.join(" | "));

    // ---- Structure --------------------------------------------------------
    const s = await clip(browser, "structure.html");
    if (PRINT) console.log("\n===== structure.html =====\n" + s.markdown + "\n");

    check("L1 two-digit ordered marker indents continuations to 5 columns",
      /^30\.  First paragraph[\s\S]*?\n     Second paragraph/m.test(s.markdown));
    check("L1 continuation link is not an indented code block",
      has(s.markdown, "     [A link on a continuation line.](https://example.com/x)"));
    check("L1 nested list keeps its indentation", /-\s+Outer one\n {4}-\s+Inner a\n {4}-\s+Inner b\n-\s+Outer two/.test(s.markdown));
    check("L2 definition list keeps terms and definitions",
      has(s.markdown, "- **fetch()** — Starts the process") && has(s.markdown, "- **Headers** —"));
    check("L3 blank lines inside a code fence are preserved",
      /return x \+ 1\n\n\ndef g\(y\)/.test(s.markdown));

    check("T3 header-less table becomes Markdown, not HTML",
      /\| Name \| Role \|/.test(s.markdown) && /\| Ada \| Engineer \|/.test(s.markdown));
    check("T1 infobox caption survives", has(s.markdown, "<caption>Deity of destruction</caption>"));
    check("T4 site colours are stripped from the HTML table",
      !/background:\s*#111/.test(s.markdown) && !/color:\s*#fff/i.test(s.markdown));
    check("T4 layout style is kept", has(s.markdown, "text-align:center"));
    check("infobox spanned cells all survive",
      has(s.markdown, "Trimurti") && has(s.markdown, "Mount Kailash"));
    // The HTML table path emits raw markup, so Turndown's rules never see into
    // it — the citation and anchor cleanup has to be applied there by hand.
    check("citations inside an HTML table are cleaned like prose",
      has(s.markdown, "Trimurti[7]") && !has(s.markdown, "#cite_note-7"));
    check("anchor affordances inside an HTML table are dropped",
      !has(s.markdown, 'href="#abode"'));
    check("T2 cells with block content do not shatter the grid",
      /\| a \| Line one<br>Line two \\\| with a pipe \|/.test(s.markdown));

    check("H1 <sub> survives", has(s.markdown, "H<sub>2</sub>O"));
    check("H1 <sup> survives", has(s.markdown, "x<sup>2</sup>"));
    check("H1 citation <sup> still becomes [1]",
      has(s.markdown, "claim[1]") && has(s.markdown, "another[2]"));
    check("H2 <mark> keeps its colour", has(s.markdown, '<mark data-color="green">green highlight</mark>'));
    check("H2 <u> and <kbd> survive",
      has(s.markdown, "<u>underline</u>") && has(s.markdown, "<kbd>Ctrl</kbd>"));
    check("H2 <abbr> expands its title", has(s.markdown, "HTML (HyperText Markup Language)"));

    check("H3 <details> does not reach the deck as card syntax",
      !has(s.markdown, "<details>") && !has(s.markdown, "<summary>"));
    check("H3 <details> summary becomes a bold lead-in",
      has(s.markdown, "**Does this become a flashcard?**"));
    check("H3 the clip trips none of Recall's flashcard-syntax triggers",
      cardSyntaxTriggers(s.markdown).length === 0, cardSyntaxTriggers(s.markdown).join(", "));

    check("H6 figcaption is italicised and follows its image",
      /!\[A diagram\]\([^)]*diagram\.png\)\n\n\*Figure 3: the pipeline\.\*/.test(s.markdown));
    check("H7 admonition becomes a blockquote, label and all",
      /> \*\*Warning\*\*\n>\n> This operation cannot be undone\./.test(s.markdown));
    check("H8 ARIA heading becomes a real heading", has(s.markdown, "### An ARIA heading"));
    check("H10 iframe leaves a link behind",
      has(s.markdown, "[▶ A tutorial video](https://www.youtube.com/embed/dQw4w9WgXcQ)"));

    check("H5 lazy placeholder is replaced by data-src",
      has(s.markdown, "![Real one](https://cdn.example.com/real-image.jpg)"));
    check("H5 <picture> picks the widest source",
      has(s.markdown, "![From picture](https://cdn.example.com/large.jpg)"));

    check("code fence keeps its language", has(s.markdown, "```python"));
    check("table stats are reported", s.tables.md >= 2 && s.tables.html >= 1,
      `md=${s.tables.md} html=${s.tables.html}`);

    // ---- Whole-page clip: shadow DOM + page chrome -------------------------
    const p = await clipRemaining(browser, "page.html", "#junk");
    if (PRINT) console.log("\n===== page.html (remaining) =====\n" + p.markdown + "\n");

    check("H4 shadow root content is clipped", has(p.markdown, "Inside the shadow root") &&
      has(p.markdown, "A paragraph rendered by a web component.") &&
      has(p.markdown, "shadow item one"));
    check("H4 light-DOM siblings of the component survive",
      has(p.markdown, "Text after the component."));
    check("H9 site header/nav/footer/sidebar/comments are dropped",
      !has(p.markdown, "Site name") && !has(p.markdown, "Alpha") &&
      !has(p.markdown, "Related") && !has(p.markdown, "First!") &&
      !has(p.markdown, "© 2026 Example"));
    check("H9 the article itself survives",
      has(p.markdown, "# The real article") && has(p.markdown, "should survive a whole-page clip"));
    check("removed block is gone", !has(p.markdown, "Delete me."));
    check("whole-page clip trips none of Recall's flashcard-syntax triggers",
      cardSyntaxTriggers(p.markdown).length === 0, cardSyntaxTriggers(p.markdown).join(", "));

    // ---- Teardown restores the page ---------------------------------------
    const r = await restoreCheck(browser, "page.html");
    check("the picker really does modify the live page", r.touched);
    check("destroy() restores the page byte for byte", r.restored);
    check("destroy() removes its documentElement class", r.classRestored);
    check("destroy() removes its own UI and overlay", r.uiGone);
    check("destroy() leaves no marker or math-source attributes", r.strayAttrs === 0,
      `${r.strayAttrs} left`);

    // ---- Preview fidelity --------------------------------------------------
    const html = await preview(browser, [
      "| A | B |", "| --- | --- |", "| 1 | 2 |", "",
      "It cost \\$5 and \\$10.", "",
      "```mermaid w=520", "graph TD; A-->B;", "```", "",
      "A claim[1] and math $x_k$.", "",
      "<mark data-color=\"green\">kept</mark> and <sup>2</sup>."
    ].join("\n"));

    check("preview: table survives sanitisation", /<table>[\s\S]*<td>1<\/td>/.test(html));
    check("preview: escaped dollars are not math",
      !/math-inline[^>]*data-tex="%245/.test(html) && has(html, "$5"));
    // DOMPurify rewrites each element, so attribute order is not stable —
    // assert on the attributes themselves, never on the serialised tag.
    check("preview: real inline math becomes a KaTeX placeholder",
      has(html, 'data-tex="x_k"') && has(html, 'class="math-inline"'));
    check("preview: diagram width from the fence info string",
      has(html, 'class="mermaid has-custom-size"') &&
      has(html, 'style="--notes-img-w:520px; width:520px"'));
    check("preview: <mark data-color> survives", has(html, 'data-color="green"'));
    check("preview: <sup> survives", has(html, "<sup>2</sup>"));
  } finally {
    await browser.close();
  }
}

run().then(() => {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "  ok  " : "FAIL  "}${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
