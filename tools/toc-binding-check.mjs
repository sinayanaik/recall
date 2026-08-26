// Does the Nth row of the contents take you to the heading it NAMES?
//
//   node tools/toc-binding-check.mjs
//
// Nothing asked this before, and "the TOC takes me to the wrong heading" is
// what that cost. Every other check in the area asks a question one side of the
// join can answer alone:
//
//   viewport   does scanPreparedHeadings find the same headings marked does?
//              (the DESCRIPTORS, off the source, with no DOM in sight)
//   ribbon     does the chapter band agree with where the reader is?
//   paged      can you reach the end of the note?
//
// The contents is a JOIN, and the join is where it went wrong. A row is a
// descriptor scanned out of the source; a jump needs an element; and the two are
// married by bindNotesHeadingElements. That pairing used to be positional — the
// Nth element is the Nth descriptor — and both sides can legitimately hold
// headings the other does not:
//
//   • `- ## thing` and a raw `<h2>` render as headings the contents does not
//     carry, so the DOM ran AHEAD and every row after one of them named the
//     heading before it, with the last rows naming nothing at all;
//   • a note built span by span has most of its headings not in the document,
//     and the whole-view pass began at descriptor 0 regardless — so a span
//     nineteen chapters in was paired with chapter one, on every rebuild of the
//     drawer, overwriting the correct pairing each span made as it was built.
//
// So this drives the real code in a real browser: the app's own modules, its own
// vendored marked, its own #notesView. The DOM is the oracle — after pairing,
// every descriptor that claims an element must be looking at an element that
// SAYS what the descriptor says. That is the property a reader actually cares
// about, and it is false in the old build for six of the shapes below.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

// The app exposes no global API, so the modules are imported in the page and
// flattened — the same approach notes-menu-check and mobile-menu-check take.
const API_SRC = `async () => {
  const paths = [
    "/src/core/dom.js?v=__BUILD__",
    "/src/notes/toc.js?v=__BUILD__",
    "/src/render/block-cache.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// ── The corpus ─────────────────────────────────────────────────────────────
//
// One shape per way the two sides can disagree about how many headings a note
// has, plus well-formed notes either side of them so a pairing that simply
// refused to bind anything cannot pass.
//
// `<!--` is written in pieces so this file does not contain a comment its own
// reader has to skip past.
const OPEN = "<!--";
const CLOSE = "-->";

const SHAPES = {
  plain:
    "# Alpha\n\nWords.\n\n## Beta\n\nWords.\n\n### Gamma\n\nWords.\n\n## Delta\n\nWords.\n",
  headingInAListItem:
    "# Alpha\n\n- ## Nested\n\nWords.\n\n## Beta\n\nWords.\n\n## Gamma\n\nWords.\n",
  rawHtmlHeading:
    "# Alpha\n\n<h2>Raw</h2>\n\nWords.\n\n## Beta\n\nWords.\n\n## Gamma\n\nWords.\n",
  headingInsideADiv:
    "# Alpha\n\n<div>\n<h3>Inside</h3>\n</div>\n\n## Beta\n\nWords.\n\n## Gamma\n\nWords.\n",
  bulletsThenRule:
    "# Alpha\n\n- one\n- two\n---\n\n## Beta\n\nWords.\n\n## Gamma\n\nWords.\n",
  commentedOutHeading:
    `# Alpha\n\n${OPEN}\n## Draft\n${CLOSE}\n\n## Beta\n\nWords.\n\n## Gamma\n\nWords.\n`,
  setextAndBlockquote:
    "Alpha\n=====\n\nWords.\n\n> ## Quoted\n\nWords.\n\n## Beta\n\nWords.\n",
  escapedEmphasis:
    "# Alpha\n\n## a \\* b\n\nWords.\n\n## Beta\n\nWords.\n",
  repeatedTitles:
    "# Alpha\n\n## Summary\n\nWords.\n\n## Detail\n\nWords.\n\n## Summary\n\nWords.\n",
  everythingAtOnce:
    "# Alpha\n\n- ## Nested\n\n<h2>Raw</h2>\n\n- one\n- two\n---\n\n" +
    `${OPEN}\n## Draft\n${CLOSE}\n\n## Beta\n\nWords.\n\n### Gamma\n\nWords.\n`
};

// ── The two ways a note reaches the screen ─────────────────────────────────
//
// EAGER is one container holding the whole rendered note. LAZY is the shape a
// book takes: one chunk per span, and only some of them built. `built` names
// which — [0, 2] means the reader opened at the top and resumed in the middle,
// which is exactly the state ensureNotesLazyFractionBuilt leaves behind and
// exactly the state the whole-view pairing got wrong.
const MODES = [
  { name: "eager", lazy: false },
  { name: "lazy: first span only", lazy: true, built: [0] },
  { name: "lazy: a middle span only", lazy: true, built: [1] },
  { name: "lazy: first and last", lazy: true, built: [0, -1] },
  { name: "lazy: all built", lazy: true, built: null }
];

// Everything below runs IN THE PAGE. It stages a render the way block-cache
// would have left one, calls the real pairing, and reports what each descriptor
// ended up looking at.
function stageAndBind(prepared, mode) {
  const api = window.__tocApi;
  const view = api.el.notesView;

  // Reset: the surface is reused across cases, and a stale plan or cache entry
  // would be answering for the previous note.
  api.notesLazyPlans.delete(view);
  view.classList.remove("is-paged");
  view.replaceChildren();
  api.renderedBlockCache.set(view, { prepared });

  const html = (text) => window.DOMPurify.sanitize(window.marked.parse(text), api.SANITIZE_CONFIG);

  if (!mode.lazy) {
    view.innerHTML = html(prepared);
  } else {
    // Split at blank lines into as many spans as there are top-level sections,
    // which is enough shape for this: the pairing only ever reads span.start /
    // span.end and whether the chunk is built.
    const cuts = [0];
    const re = /\n\n/g;
    let hit;
    while ((hit = re.exec(prepared))) cuts.push(hit.index + 2);
    cuts.push(prepared.length);
    const bounds = [...new Set(cuts)].sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      if (bounds[i + 1] > bounds[i]) spans.push({ start: bounds[i], end: bounds[i + 1] });
    }
    const wanted = mode.built === null
      ? spans.map((_, i) => i)
      : mode.built.map((i) => (i < 0 ? spans.length + i : i));
    const chunks = spans.map((span, index) => {
      const chunk = document.createElement("div");
      chunk.className = api.NOTES_CHUNK_CLASS;
      if (wanted.includes(index)) {
        chunk.innerHTML = html(prepared.slice(span.start, span.end));
      } else {
        chunk.classList.add(api.NOTES_CHUNK_PENDING_CLASS);
      }
      view.appendChild(chunk);
      return chunk;
    });
    api.notesLazyPlans.set(view, {
      prepared,
      spans,
      chunks,
      built: spans.map((_, i) => (wanted.includes(i) ? 1 : 0)),
      blocks: [],
      groups: [],
      starts: [],
      links: []
    });
  }

  const headings = api.notesHeadingsForPrepared(prepared);
  headings.forEach((h) => { h.el = null; });
  api.bindNotesHeadingsAcrossView(view);

  // What the DOM says each bound element is, read the way the reader reads it.
  const said = (node) => {
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 1 && child.classList?.contains("hl-note-badge")) continue;
      text += child.textContent || "";
    }
    return { level: Number(node.tagName[1]), text: text.replace(/\s+/g, " ").trim(), id: node.id };
  };

  // Which spans a descriptor could possibly have been bound from — used to tell
  // "correctly unbound because its span is not built" from "lost".
  const plan = api.notesLazyPlans.get(view) || null;
  const buildable = (heading) => {
    if (!plan) return true;
    const i = plan.spans.findIndex((s) => heading.offset >= s.start && heading.offset < s.end);
    return i === -1 ? false : Boolean(plan.built[i]);
  };

  return headings.map((h) => ({
    level: h.level,
    text: h.text,
    id: h.id,
    buildable: buildable(h),
    bound: h.el && h.el.isConnected ? said(h.el) : null
  }));
}

// ── The same question in RAW mode ──────────────────────────────────────────
//
// The rendered view is hidden while the editor is open, so a press on a row
// moves the CARET instead of scrolling. That path used a heading walker of its
// own — ATX only, anchored at column 0 — while the rows come from a scanner
// that also reports setext, blockquoted and indented headings. Every one of
// those shifted the ordinal, so a press landed on a different section, and the
// rows past the last ATX heading did nothing at all.
//
// Asserted here as: the caret this puts down is on the line the row names.
const RAW_SHAPES = {
  setextFirst: "Overview\n========\n\n## Setup\n\n> ### Warning\n\n  ## Indented\n\n## Done\n",
  fencedHash: "# Alpha\n\n```\n# not a heading\n```\n\n## Beta\n\n## Gamma\n",
  atxOnly: "# Alpha\n\n## Beta\n\n### Gamma\n\n## Delta\n"
};

// Runs IN THE PAGE: put the shape in the raw editor, press each row in turn,
// and report the line the caret ended up on.
function caretLinesForRows(source) {
  const api = window.__tocApi;
  const textarea = api.el.notesEdit;
  const wasHidden = textarea.hidden;
  textarea.hidden = false;
  textarea.value = source;
  const rows = api.scanPreparedHeadings(source);
  const out = rows.map((heading, index) => {
    api.scrollNotesEditToHeadingIndex(index);
    const at = textarea.selectionStart;
    const lineStart = source.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
    const newline = source.indexOf("\n", at);
    return {
      text: heading.text,
      level: heading.level,
      caretLine: source.slice(lineStart, newline === -1 ? source.length : newline)
    };
  });
  textarea.value = "";
  textarea.hidden = wasHidden;
  return out;
}

const failures = [];
let cases = 0;
let rows = 0;

const chrome = findChrome();
if (!chrome) {
  console.log("toc-binding-check: no Chrome on this machine — nothing to check.");
  process.exit(1);
}

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

try {
  await page.goto(`${server.base}/index.html`);
  await page.waitFor(() => Boolean(window.marked && window.DOMPurify), { label: "the vendored libraries" });
  const ready = await page.evaluate(`async () => {
    window.__tocApi = await (${API_SRC})();
    return Boolean(window.__tocApi.bindNotesHeadingsAcrossView && window.__tocApi.el.notesView);
  }`);
  if (!ready) throw new Error("the app did not expose bindNotesHeadingsAcrossView / #notesView");

  for (const [shapeName, prepared] of Object.entries(SHAPES)) {
    for (const mode of MODES) {
      cases += 1;
      const report = await page.evaluate(stageAndBind, prepared, mode);
      const where = `${shapeName} / ${mode.name}`;
      const seen = new Map();
      for (let i = 0; i < report.length; i += 1) {
        const row = report[i];
        rows += 1;
        if (!row.bound) {
          // Unbound is the right answer only for a heading whose span is not on
          // screen. Anywhere else it is a contents row that does nothing.
          if (row.buildable) failures.push(`${where}: row ${i} ${JSON.stringify(row.text)} bound to nothing`);
          continue;
        }
        if (!row.buildable) {
          failures.push(`${where}: row ${i} ${JSON.stringify(row.text)} bound into a span that is not built`);
          continue;
        }
        if (row.bound.text !== row.text || row.bound.level !== row.level) {
          failures.push(
            `${where}: row ${i} says h${row.level} ${JSON.stringify(row.text)} ` +
            `but landed on h${row.bound.level} ${JSON.stringify(row.bound.text)}`
          );
          continue;
        }
        // The anchor the row's href points at has to be the element it landed
        // on, or a middle-click goes somewhere the click does not.
        if (row.bound.id !== row.id) {
          failures.push(`${where}: row ${i} ${JSON.stringify(row.text)} has id ${row.id} but its element carries ${row.bound.id}`);
          continue;
        }
        // Two rows sharing one element is the signature of a pairing that lost
        // its place and never found it again.
        const twin = seen.get(row.bound.id);
        if (twin !== undefined) failures.push(`${where}: rows ${twin} and ${i} both landed on ${row.bound.id}`);
        seen.set(row.bound.id, i);
      }
    }
  }

  for (const [shapeName, source] of Object.entries(RAW_SHAPES)) {
    cases += 1;
    const report = await page.evaluate(caretLinesForRows, source);
    if (!report.length) {
      failures.push(`raw / ${shapeName}: no contents rows at all`);
      continue;
    }
    for (let i = 0; i < report.length; i += 1) {
      const row = report[i];
      rows += 1;
      // The line the caret landed on has to be the line the row names. Compared
      // by the row's own text so the markers in front of it — `#`, `>`, indent
      // — do not have to be re-parsed here.
      if (!row.caretLine.includes(row.text)) {
        failures.push(
          `raw / ${shapeName}: row ${i} h${row.level} ${JSON.stringify(row.text)} ` +
          `put the caret on ${JSON.stringify(row.caretLine)}`
        );
      }
    }
  }
} finally {
  client.close();
  launched.close();
  server.proc.kill();
}

for (const line of failures.slice(0, 25)) console.log(`  ${line}`);
if (failures.length > 25) console.log(`  …and ${failures.length - 25} more`);
console.log(failures.length
  ? `\n${cases} cases · ${rows} contents rows · ${failures.length} failed`
  : `\n${cases} cases · ${rows} contents rows · 0 failed`);
process.exit(failures.length ? 1 : 0);
