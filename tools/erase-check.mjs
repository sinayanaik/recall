// Does a selection in a rendered note land on the markdown it came from?
//
//   node tools/erase-check.mjs
//
// Reported as "I select some content and Delete says it could not match", and
// "when I select a heading and delete it, the empty # / ## stays behind". Both
// came from the same place: a selection was found by searching the note for
// its words, so anything in the middle that reads differently in the source (a
// formula, an `&amp;`, an image, an escaped `\*`) sank the whole search, and a
// heading's words were found inside "## Title" and spliced out of it, leaving
// the marker. src/format/source-blocks.js places a selection by its two ends
// instead, block by block.
//
//   ERASE_SEED=7 ERASE_RUNS=2000 node tools/erase-check.mjs   # a longer random walk
//
// Every case here renders a real note into the real notes view (or a card face),
// makes a real Range across what a reader would drag over, and asserts the exact
// markdown left behind — or, for the wrapping actions, exactly what got wrapped.
// Text-only assertions ("it contains no ##") would pass for the wrong reason.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = findChrome();
if (!CHROME) {
  // Not a skip: a check that cannot run has not passed.
  console.error("erase-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

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
const PROBE = `async () => {
  const V = "?v=__BUILD__";
  const [{ state }, { el }, blocks, locate, cloze, fence, highlight, sourceBlocks] = await Promise.all([
    import("/src/core/state.js" + V),
    import("/src/core/dom.js" + V),
    import("/src/render/block-cache.js" + V),
    import("/src/format/locate-selection.js" + V),
    import("/src/format/cloze.js" + V),
    import("/src/format/notes-fence.js" + V),
    import("/src/format/highlight.js" + V),
    import("/src/format/source-blocks.js" + V)
  ]);
  const results = [];
  const record = (name, detail) => results.push({ name, ok: detail === true, detail: detail === true ? "" : String(detail) });

  const reveal = (node) => {
    for (let n = node; n && n !== document.body; n = n.parentElement) n.hidden = false;
  };
  const shell = document.querySelector(".app-shell");
  if (shell) shell.hidden = false;
  reveal(el.notesView);

  const renderNotes = async (md) => {
    state.notes = md;
    await blocks.renderMarkdown(el.notesView, fence.readerNotesBody(md), true);
    return el.notesView;
  };

  // The DOM point at the start (or end) of the nth copy of \`text\` in the
  // rendered view's text nodes. A needle must sit inside one text node.
  const pointAt = (view, text, { nth = 0, end = false } = {}) => {
    const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
    let count = 0;
    let node;
    while ((node = walker.nextNode())) {
      for (let at = node.data.indexOf(text); at !== -1; at = node.data.indexOf(text, at + 1)) {
        if (count++ === nth) return { node, offset: end ? at + text.length : at };
      }
    }
    throw new Error("no rendered text " + JSON.stringify(text) + " (copy " + nth + ")");
  };
  // The boundary at the very start of the top-level block holding \`text\` — where
  // a triple-click or a drag that stops just past the last word ends.
  const blockStartOf = (view, text) => {
    let node = pointAt(view, text).node.parentElement;
    while (node.parentElement && node.parentElement !== view && !node.parentElement.classList.contains("notes-chunk")) node = node.parentElement;
    return { node: node.parentElement, offset: Array.prototype.indexOf.call(node.parentElement.childNodes, node) };
  };
  const select = (from, to) => {
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return range;
  };
  const point = (view, spec, isEnd) => {
    if (spec.blockStartOf) return blockStartOf(view, spec.blockStartOf);
    return pointAt(view, spec.text, { nth: spec.nth || 0, end: isEnd });
  };

  // ── Delete ────────────────────────────────────────────────────────────────
  const ERASE = [
    { name: "a whole heading goes with its ##",
      md: "Intro para.\\n\\n## Results\\n\\nBody text here.\\n", from: { text: "Results" }, to: { text: "Results" },
      expect: "Intro para.\\n\\nBody text here.\\n" },
    { name: "a heading and the paragraph under it",
      md: "Intro para.\\n\\n## Results\\n\\nBody text here.\\n\\nAfter.\\n", from: { text: "Results" }, to: { text: "here." },
      expect: "Intro para.\\n\\nAfter.\\n" },
    { name: "from mid-heading into the paragraph: one heading line is left",
      md: "Intro para.\\n\\n## Results\\n\\nBody text here.\\n", from: { text: "sults" }, to: { text: "Body" },
      expect: "Intro para.\\n\\n## Re text here.\\n" },
    { name: "mid-word to mid-word closes up",
      md: "Intro para.\\n\\n## Results\\n\\nBody text here.\\n", from: { text: "sults" }, to: { text: "Bo" },
      expect: "Intro para.\\n\\n## Redy text here.\\n" },
    { name: "a setext heading takes its underline",
      md: "Title\\n=====\\n\\nBody.\\n", from: { text: "Title" }, to: { text: "Title" },
      expect: "Body.\\n" },
    { name: "a closed ATX heading takes its closing hashes",
      md: "Lead.\\n\\n## Title ##\\n\\nBody.\\n", from: { text: "Title" }, to: { text: "Title" },
      expect: "Lead.\\n\\nBody.\\n" },
    { name: "one bullet goes with its -",
      md: "Top.\\n\\n- one item\\n- two item\\n- three item\\n\\nEnd.\\n", from: { text: "two item" }, to: { text: "two item" },
      expect: "Top.\\n\\n- one item\\n- three item\\n\\nEnd.\\n" },
    { name: "the last bullet",
      md: "Top.\\n\\n- one item\\n- two item\\n\\nEnd.\\n", from: { text: "two item" }, to: { text: "two item" },
      expect: "Top.\\n\\n- one item\\n\\nEnd.\\n" },
    { name: "two * bullets: the blank line above the list survives",
      md: "Top.\\n\\n* one item\\n* two item\\n* three item\\n\\nEnd.\\n", from: { text: "one item" }, to: { text: "two item" },
      expect: "Top.\\n\\n* three item\\n\\nEnd.\\n" },
    { name: "a numbered item",
      md: "1. alpha\\n2. beta\\n3. gamma\\n", from: { text: "beta" }, to: { text: "beta" },
      expect: "1. alpha\\n3. gamma\\n" },
    { name: "a task goes with its - [ ]",
      md: "- [ ] task one\\n- [x] task two\\n", from: { text: "task one" }, to: { text: "task one" },
      expect: "- [x] task two\\n" },
    { name: "a quote line goes with its >",
      md: "> quoted one\\n> quoted two\\n\\nAfter.\\n", from: { text: "quoted one" }, to: { text: "quoted one" },
      expect: "> quoted two\\n\\nAfter.\\n" },
    { name: "part of a heading keeps the heading",
      md: "## Results\\n\\nBody.\\n", from: { text: "Res" }, to: { text: "Res" },
      expect: "## ults\\n\\nBody.\\n" },
    { name: "a whole paragraph, ending at the next block (triple-click)",
      md: "One.\\n\\nTwo two.\\n\\nThree.\\n", from: { text: "Two two." }, to: { blockStartOf: "Three." },
      expect: "One.\\n\\nThree.\\n" },
    { name: "a word between two words",
      md: "The quick brown fox.\\n", from: { text: "brown" }, to: { text: "brown" },
      expect: "The quick fox.\\n" },
    { name: "the repeated phrase that was selected, not the first",
      md: "the cat sat.\\n\\nthe cat ran.\\n\\nthe cat hid.\\n", from: { text: "the cat", nth: 1 }, to: { text: "the cat", nth: 1 },
      expect: "the cat sat.\\n\\nran.\\n\\nthe cat hid.\\n" },
    { name: "across an inline and a display formula",
      md: "Energy $E = mc^2$ is famous.\\n\\nSecond $$x^2$$ para.\\n\\nThird.\\n", from: { text: "Energy" }, to: { text: "Third" },
      expect: ".\\n" },
    { name: "across an entity",
      md: "Tom &amp; Jerry are here.\\n\\nNext.\\n", from: { text: "Tom" }, to: { text: "Next" },
      expect: ".\\n" },
    { name: "beside an escaped star: the escape is kept whole",
      md: "A \\\\*literal\\\\* star.\\n\\nNext line.\\n", from: { text: "literal" }, to: { text: "Next" },
      expect: "A \\\\* line.\\n" },
    { name: "across an image",
      md: "Before image text.\\n\\n![alt text](https://example.com/img.png)\\n\\nAfter image text.\\n", from: { text: "image text." }, to: { text: "After image" },
      expect: "Before text.\\n" },
    { name: "a table and into the paragraph after it",
      md: "Para before.\\n\\n| A | B |\\n| --- | --- |\\n| 1 | 2 |\\n\\nPara after.\\n", from: { text: "before." }, to: { text: "Para after" },
      expect: "Para .\\n" },
    { name: "a whole table",
      md: "Para before.\\n\\n| A | B |\\n| --- | --- |\\n| 1 | 2 |\\n\\nPara after.\\n", from: { text: "A" }, to: { text: "2" },
      expect: "Para before.\\n\\nPara after.\\n" },
    { name: "out of a bold run: what is left stays bold",
      md: "Some **bold text** and more words.\\n", from: { text: "text" }, to: { text: "more" },
      expect: "Some **bold** words.\\n" },
    { name: "into a bold run: what is left stays bold",
      md: "Some words and **bold text** here.\\n", from: { text: "words" }, to: { text: "bold" },
      expect: "Some **text** here.\\n" },
    { name: "out of a link: the link keeps its target",
      md: "Read [the docs page](https://x.y/z) now.\\n", from: { text: "page" }, to: { text: "now" },
      expect: "Read [the docs](https://x.y/z).\\n" },
    { name: "a whole link",
      md: "Read [the docs page](https://x.y/z) now.\\n", from: { text: "the docs page" }, to: { text: "the docs page" },
      expect: "Read now.\\n" },
    { name: "out of a code span",
      md: "Use \`npm install\` here.\\n", from: { text: "install" }, to: { text: "here" },
      expect: "Use \`npm\`.\\n" },
    { name: "inside a fenced code block, exactly",
      md: "\`\`\`js\\nconst a = 1; // **x**\\nconst b = 2;\\n\`\`\`\\n", from: { text: "1; // **x**" }, to: { text: "1; // **x**" },
      expect: "\`\`\`js\\nconst a = \\nconst b = 2;\\n\`\`\`\\n" },
    { name: "across a link and bold into the next paragraph",
      md: "Start of [a link](https://example.com/a/long/path) and **bold words** end.\\n\\nNext para with \`code\` too.\\n", from: { text: "Start" }, to: { text: "too" },
      expect: ".\\n" },
    { name: "a heading the notes view promoted (### shown as #)",
      md: "### Only heading\\n\\nBody under it.\\n", from: { text: "Only heading" }, to: { text: "Only heading" },
      expect: "Body under it.\\n" },
    // preprocessSpecialBlocks collapses a diagram fence into one line, so every
    // block after one sits at a different place in the prepared text than in
    // the note. A blank line INSIDE the fence is the case the line alignment
    // must not resynchronise on.
    { name: "a paragraph after a diagram (with a blank line inside the fence)",
      md: "Before.\\n\\n\`\`\`mermaid\\ngraph TD\\nA-->B\\n\\nB-->C\\n\`\`\`\\n\\nTarget para.\\n\\nAfter.\\n", from: { text: "Target para." }, to: { text: "Target para." },
      expect: "Before.\\n\\n\`\`\`mermaid\\ngraph TD\\nA-->B\\n\\nB-->C\\n\`\`\`\\n\\nAfter.\\n" },
    { name: "a paragraph after a multi-line display formula",
      md: "Lead.\\n\\n$$\\na^2 + b^2\\n= c^2\\n$$\\n\\nTarget para.\\n\\nAfter.\\n", from: { text: "Target para." }, to: { text: "Target para." },
      expect: "Lead.\\n\\n$$\\na^2 + b^2\\n= c^2\\n$$\\n\\nAfter.\\n" },
    { name: "a nested bullet",
      md: "- outer one\\n  - inner a\\n  - inner b\\n- outer two\\n", from: { text: "inner a" }, to: { text: "inner a" },
      expect: "- outer one\\n  - inner b\\n- outer two\\n" },
    { name: "an item of a loose list",
      md: "- first\\n\\n- second\\n\\n- third\\n", from: { text: "second" }, to: { text: "second" },
      expect: "- first\\n\\n- third\\n" },
    { name: "a bullet inside a quote",
      md: "> - quoted item\\n> - kept item\\n", from: { text: "quoted item" }, to: { text: "quoted item" },
      expect: "> - kept item\\n" },
    { name: "a heading with a list straight under it",
      md: "## Steps\\n- one\\n- two\\n", from: { text: "Steps" }, to: { text: "Steps" },
      expect: "- one\\n- two\\n" },
    { name: "a whole highlight goes with its <mark>",
      md: "Some <mark data-color=\\"green\\">marked words</mark> here.\\n", from: { text: "marked words" }, to: { text: "marked words" },
      expect: "Some here.\\n" },
    { name: "a word inside a highlight keeps the highlight",
      md: "Some <mark>marked words</mark> here.\\n", from: { text: "words" }, to: { text: "words" },
      expect: "Some <mark>marked</mark> here.\\n" },
    { name: "out of a cloze: the rest stays hidden",
      md: "The answer is {{forty two}} today.\\n", from: { text: "two" }, to: { text: "today" },
      expect: "The answer is {{forty}}.\\n" },
    { name: "across a link to another note",
      md: "See [[Other note|ld_abc123]] for more.\\n\\nNext.\\n", from: { text: "See" }, to: { text: "more." },
      expect: "Next.\\n" },
    // Shapes the random walk below found, kept as cases of their own.
    { name: "into a code block keeps its opening fence",
      md: "Para one here.\\n\\n\`\`\`js\\nline one\\nline two\\n\`\`\`\\n", from: {text: "one here"}, to: {text: "line"},
      expect: "Para\\n\\n\`\`\`js\\none\\nline two\\n\`\`\`\\n" },
    { name: "out of a code block keeps its closing fence",
      md: "\`\`\`js\\nline one\\nline two\\n\`\`\`\\n\\nPara after it.\\n", from: {text: "two"}, to: {text: "after"},
      expect: "\`\`\`js\\nline one\\nline \\n\`\`\`\\n\\nit.\\n" },
    { name: "into a table: the cells empty, the grid stays",
      md: "Lead para.\\n\\n| A | B |\\n| --- | --- |\\n| one | two |\\n", from: {text: "para"}, to: {text: "one"},
      expect: "Lead\\n\\n|  |  |\\n| --- | --- |\\n| | two |\\n" },
    { name: "a heading that is only an escaped star",
      md: "Lead.\\n\\n# \\\\*\\n\\n$$\\na + b\\n$$\\n", from: {text: "*"}, to: {text: "*"},
      expect: "Lead.\\n\\n$$\\na + b\\n$$\\n" },
    { name: "a paragraph after two identical formulas in a row",
      md: "$$\\na + b\\n$$\\n\\n$$\\na + b\\n$$\\n\\nTarget para.\\n\\nAfter.\\n", from: {text: "Target para."}, to: {text: "Target para."},
      expect: "$$\\na + b\\n$$\\n\\n$$\\na + b\\n$$\\n\\nAfter.\\n" },
    { name: "between two italic runs: what is left is one run",
      md: "*india* and *delta* end.\\n", from: {text: "dia"}, to: {text: "de"},
      expect: "*inlta* end.\\n" },
    { name: "a numbered item's tail joined to a paragraph: the items after it stay a list",
      md: "Start para.\\n\\n1. alpha\\n2. bravo\\n3. charlie\\n", from: {text: "para"}, to: {text: "bra"},
      expect: "Start vo\\n\\n3. charlie\\n" },
    { name: "an entity on its own goes whole",
      md: "Tom &amp; Jerry.\\n", from: {text: "&"}, to: {text: "&"},
      expect: "Tom Jerry.\\n" },
    { name: "with a Highlight Notes block at the end of the note",
      md: "First para.\\n\\nSecond para.\\n\\n---\\n\\n" + fence.HIGHLIGHT_NOTES_OPEN + "\\n" + fence.HIGHLIGHT_NOTES_CLOSE + "\\n",
      from: { text: "First para." }, to: { text: "First para." },
      expectStartsWith: "Second para." }
  ];

  for (const c of ERASE) {
    try {
      const view = await renderNotes(c.md);
      select(point(view, c.from, false), point(view, c.to, true));
      const sel = locate.renderedSelectionStrings(view);
      if (!sel) { record("erase: " + c.name, "no selection description"); continue; }
      const placed = sourceBlocks.sourceRangeForSelection(c.md, sel, { lines: true });
      const out = cloze.eraseSelectionFromSource(c.md, sel);
      if (out == null) { record("erase: " + c.name, "Couldn't match (placed: " + JSON.stringify(placed) + ")"); continue; }
      if (c.expectStartsWith != null) {
        record("erase: " + c.name, out.startsWith(c.expectStartsWith) ? true : "got " + JSON.stringify(out));
        continue;
      }
      record("erase: " + c.name, out === c.expect ? true : "got " + JSON.stringify(out) + ", expected " + JSON.stringify(c.expect) + (placed ? "" : " (not placed by block)"));
    } catch (error) {
      record("erase: " + c.name, "THREW: " + error.message);
    }
  }

  // ── Every case above was placed by its blocks, not found by the search ────
  {
    const md = "Energy $E = mc^2$ is famous.\\n\\nTom &amp; Jerry.\\n";
    const view = await renderNotes(md);
    select(pointAt(view, "Energy"), pointAt(view, "Jerry", { end: true }));
    const sel = locate.renderedSelectionStrings(view);
    const placed = sourceBlocks.sourceRangeForSelection(md, sel);
    record("place: the range covers exactly what was selected",
      placed && md.slice(placed.idx, placed.end) === "Energy $E = mc^2$ is famous.\\n\\nTom &amp; Jerry" ? true : JSON.stringify(placed));
  }

  // ── The wrapping actions ──────────────────────────────────────────────────
  {
    const md = "Tom &amp; Jerry are friends.\\n";
    const view = await renderNotes(md);
    select(pointAt(view, "Tom"), pointAt(view, "Jerry", { end: true }));
    const sel = locate.renderedSelectionStrings(view);
    const out = cloze.clozeToggleInSource(md, sel);
    record("cloze: a selection with an entity in it", out && out.text === "{{Tom &amp; Jerry}} are friends.\\n" ? true : JSON.stringify(out));
  }
  {
    const md = "Mass $m$ and energy $E$ relate.\\n\\nAs shown.\\n";
    const view = await renderNotes(md);
    select(pointAt(view, "Mass"), pointAt(view, "relate.", { end: true }));
    const sel = locate.renderedSelectionStrings(view);
    const out = highlight.highlightToggleInSource(md, sel, "green");
    const wrapped = out && /<mark data-color="green">Mass \\$m\\$ and energy \\$E\\$ relate\\.<\\/mark>/.test(out.text || out);
    record("highlight: a sentence holding formulas", wrapped ? true : JSON.stringify(out));
  }
  // ── A card face ───────────────────────────────────────────────────────────
  {
    const question = "## Card heading\\n\\nWhat is $x^2$ here?\\n";
    reveal(el.questionView);
    await blocks.renderMarkdown(el.questionView, question, true);
    select(pointAt(el.questionView, "Card heading"), pointAt(el.questionView, "Card heading", { end: true }));
    const sel = locate.renderedSelectionStrings(el.questionView);
    const out = sel ? cloze.eraseSelectionFromSource(question, sel) : null;
    record("card face: a heading goes with its ##", out === "What is $x^2$ here?\\n" ? true : JSON.stringify(out));
  }

  // ── A stale render falls back to the search, and still does its job ─────
  {
    const md = "Alpha beta gamma.\\n";
    const view = await renderNotes(md);
    select(pointAt(view, "beta"), pointAt(view, "beta", { end: true }));
    const sel = locate.renderedSelectionStrings(view);
    const edited = "Zero. Alpha beta gamma.\\n";
    const placed = sourceBlocks.sourceRangeForSelection(edited, sel);
    const out = cloze.eraseSelectionFromSource(edited, sel);
    record("stale render: not placed, found by the search instead",
      placed === null && out === "Zero. Alpha gamma.\\n" ? true : JSON.stringify({ placed, out }));
  }

  // ── Nothing placeable: the editor opens there, and nothing is deleted ─────
  {
    const md = "First para.\\n\\nThe second para.\\n";
    const view = await renderNotes(md);
    select(pointAt(view, "second"), pointAt(view, "second", { end: true }));
    // The note changed under the selection (so the render cache cannot vouch
    // for it), and the description's words are nowhere in the note (so the text
    // search finds nothing). The block it started in can still be found, and
    // that is where the editor opens.
    const sel = { ...locate.renderedSelectionStrings(view), asText: "nowhere in this note", asMarkdown: "nowhere in this note" };
    const edited = "Lead line.\\n\\n" + md;
    let written = null;
    let opened = null;
    cloze.eraseNotesSelection({
      view, label: "notes",
      getSource: () => edited,
      setSource: (text) => { written = text; },
      rerender: () => {},
      openEditorAt: (start, end) => { opened = [start, end]; return true; }
    }, sel);
    record("unplaceable: nothing is deleted", written === null ? true : "wrote " + JSON.stringify(written));
    record("unplaceable: the editor opens at the block it was in",
      opened && opened[0] >= edited.indexOf("The second para.") && opened[1] <= edited.indexOf("The second para.") + "The second para.".length
        ? true : "opened at " + JSON.stringify(opened));
  }

  // ── Random notes, random selections ───────────────────────────────────────
  //
  // The cases above are the shapes that were reported. This is everything
  // else: notes built from every block and inline kind a note is made of, a
  // selection from a random point to a random later point, and two properties
  // asserted of the result, rendered again —
  //
  //   1. the characters a reader sees are exactly the ones that were not
  //      selected, in order (spacing aside: how two joined lines are spaced is
  //      what the cases above pin down), and
  //   2. no line is left holding nothing but a marker ("## ", "- ", "> ").
  //
  // Seeded, so a failure names a case that can be run again.
  {
    let seed = Number(globalThis.__eraseSeed) || 20261024;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (list) => list[Math.floor(random() * list.length)];
    const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
    const INLINE = [
      () => pick(WORDS), () => pick(WORDS), () => pick(WORDS), () => pick(WORDS),
      () => "**" + pick(WORDS) + " " + pick(WORDS) + "**", () => "*" + pick(WORDS) + "*",
      () => "\`" + pick(WORDS) + " x\`", () => "[" + pick(WORDS) + " " + pick(WORDS) + "](https://e.x/" + pick(WORDS) + ")",
      () => "$x_" + Math.floor(random() * 9) + "^2$", () => "&amp;", () => "\\\\*", () => "<mark>" + pick(WORDS) + " " + pick(WORDS) + "</mark>",
      () => "{{" + pick(WORDS) + " " + pick(WORDS) + "}}", () => "![" + pick(WORDS) + "](https://e.x/" + pick(WORDS) + ".png)"
    ];
    const line = (min, max) => {
      const n = min + Math.floor(random() * (max - min + 1));
      const parts = [];
      for (let i = 0; i < n; i += 1) parts.push(pick(INLINE)());
      return parts.join(" ");
    };
    const BLOCKS = [
      () => line(3, 9),
      () => line(3, 9),
      () => "#".repeat(1 + Math.floor(random() * 3)) + " " + line(1, 3),
      () => [0, 1, 2].slice(0, 2 + Math.floor(random() * 2)).map(() => "- " + line(1, 4)).join("\\n"),
      () => [1, 2, 3].slice(0, 2 + Math.floor(random() * 2)).map((n) => n + ". " + line(1, 4)).join("\\n"),
      () => "- [ ] " + line(1, 3) + "\\n- [x] " + line(1, 3),
      () => "- " + line(1, 3) + "\\n  - " + line(1, 3) + "\\n- " + line(1, 3),
      () => "> " + line(2, 5) + "\\n> " + line(2, 5),
      () => "| " + pick(WORDS) + " | " + pick(WORDS) + " |\\n| --- | --- |\\n| " + pick(WORDS) + " " + pick(WORDS) + " | " + pick(WORDS) + " |\\n| " + pick(WORDS) + " | " + pick(WORDS) + " " + pick(WORDS) + " |",
      () => "\`\`\`js\\nconst " + pick(WORDS) + " = 1; // **" + pick(WORDS) + "**\\nlet " + pick(WORDS) + " = [2];\\n\`\`\`",
      () => "---",
      () => "$$\\na_" + Math.floor(random() * 9) + " + b\\n$$"
    ];
    const visible = (view) => sourceBlocks.renderedBlockText(Array.from(view.childNodes)).text;
    const squeeze = (text) => text.replace(/\\s+/g, "");
    // Outside code: a "*" line in a code block is code.
    const markerOnlyLines = (text) => {
      let fenced = false;
      return text.split("\\n").filter((l) => {
        if (/^ {0,3}(\\\`\\\`\\\`|~~~)/.test(l)) {
          fenced = !fenced;
          return false;
        }
        return !fenced && l.trim() && sourceBlocks.MARKER_ONLY_LINE_RE.test(l);
      }).length;
    };
    const contentTextNodes = (view) => {
      const nodes = [];
      const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.data.trim()) continue;
        const host = node.parentElement;
        if (host.closest(sourceBlocks.RENDERED_CHROME_SELECTOR) || host.closest("[aria-hidden='true'], [data-tex], [data-diagram]")) continue;
        nodes.push(node);
      }
      return nodes;
    };

    const RUNS = Number(globalThis.__eraseRuns) || 260;
    let unplaced = 0;
    const unplacedCases = [];
    const failures = [];
    for (let run = 0; run < RUNS && failures.length < 4; run += 1) {
      const count = 3 + Math.floor(random() * 5);
      const md = Array.from({ length: count }, () => pick(BLOCKS)()).join("\\n\\n") + "\\n";
      const view = await renderNotes(md);
      const nodes = contentTextNodes(view);
      if (nodes.length < 2) continue;
      let a = Math.floor(random() * nodes.length);
      let b = Math.floor(random() * nodes.length);
      if (a > b) [a, b] = [b, a];
      const startNode = nodes[a];
      const endNode = nodes[b];
      const startOffset = Math.floor(random() * startNode.data.length);
      const endOffset = a === b
        ? startOffset + 1 + Math.floor(random() * (endNode.data.length - startOffset))
        : 1 + Math.floor(random() * endNode.data.length);
      const range = select({ node: startNode, offset: startOffset }, { node: endNode, offset: Math.min(endOffset, endNode.data.length) });
      if (range.collapsed) continue;
      const sel = locate.renderedSelectionStrings(view);
      if (!sel) continue;
      // What a reader should be left looking at: the note's visible text with
      // the selection (snapped to whole formulas, as every action snaps it) cut
      // out of it.
      const snapped = (await import("/src/notes/selection.js" + V)).snapRangeToAtomicBlocks(range);
      const all = Array.from(view.childNodes);
      const head = sourceBlocks.renderedBlockText(all, { node: snapped.startContainer, offset: snapped.startOffset, edge: "start" });
      const tail = sourceBlocks.renderedBlockText(all, { node: snapped.endContainer, offset: snapped.endOffset, edge: "end" });
      const expected = squeeze(head.text.slice(0, head.at) + tail.text.slice(tail.at));
      const placed = sourceBlocks.sourceRangeForSelection(md, sel, { lines: true });
      if (!placed) {
        unplaced += 1;
        if (unplacedCases.length < 3) unplacedCases.push("run " + run + "\\n  note " + JSON.stringify(md) + "\\n  selected " + JSON.stringify(sel.asText));
      }
      const out = cloze.eraseSelectionFromSource(md, sel);
      if (out == null) {
        failures.push("run " + run + ": Couldn't match\\n" + JSON.stringify(md) + "\\nselected " + JSON.stringify(sel.asText));
        continue;
      }
      await renderNotes(out);
      const got = squeeze(visible(view));
      if (got !== expected) {
        let at = 0;
        while (at < got.length && got[at] === expected[at]) at += 1;
        failures.push("run " + run + ": left " + JSON.stringify(got.slice(Math.max(0, at - 20), at + 30)) + " where " + JSON.stringify(expected.slice(Math.max(0, at - 20), at + 30)) + " was expected\\n  note " + JSON.stringify(md) + "\\n  selected " + JSON.stringify(sel.asText) + "\\n  result " + JSON.stringify(out)
          + "\\n  placed " + JSON.stringify(placed && { idx: placed.idx, end: placed.end, code: placed.code, startBlock: placed.startBlock, endBlock: placed.endBlock })
          + "\\n  from " + JSON.stringify([startNode.data, startOffset, startNode.parentElement.tagName]) + " to " + JSON.stringify([endNode.data, Math.min(endOffset, endNode.data.length), endNode.parentElement.tagName]));
        continue;
      }
      if (markerOnlyLines(out) > markerOnlyLines(md)) {
        failures.push("run " + run + ": a marker-only line was left\\n  note " + JSON.stringify(md) + "\\n  result " + JSON.stringify(out));
      }
    }
    record("random notes: Delete leaves exactly what was not selected (" + RUNS + " runs)", failures.length ? failures.join("\\n\\n") : true);
    record("random notes: every selection was placed by its blocks", unplaced === 0 ? true : unplaced + " of " + RUNS + " fell back to the text search:\\n" + unplacedCases.join("\\n"));
  }

  // ── A long note, built as it is read ──────────────────────────────────────
  {
    const parts = [];
    for (let i = 0; i < 2600; i += 1) {
      parts.push("## Section " + i + "\\n\\nParagraph " + i + " has $x_" + i + "$ and **bold " + i + "** and &amp; text, repeated words here.\\n\\n- item a" + i + "\\n- item b" + i + "\\n");
    }
    const md = parts.join("\\n");
    const view = await renderNotes(md);
    const cached = blocks.renderedBlockCache.get(view);
    const lazy = Boolean(cached && cached.lazy);
    const target = 1203;
    const offset = Math.floor(cached.prepared.indexOf("## Section " + target + "\\n"));
    blocks.ensureNotesLazyOffsetBuilt(view, offset);
    await new Promise((r) => setTimeout(r, 50));
    select(pointAt(view, "Section " + target), pointAt(view, "item a" + target, { end: true }));
    const sel = locate.renderedSelectionStrings(view);
    const t0 = performance.now();
    const out = cloze.eraseSelectionFromSource(md, sel);
    const cold = performance.now() - t0;
    const t1 = performance.now();
    cloze.eraseSelectionFromSource(md, sel);
    const warm = performance.now() - t1;
    const before = "## Section " + (target - 1);
    const expected = md.replace("## Section " + target + "\\n\\nParagraph " + target + " has $x_" + target + "$ and **bold " + target + "** and &amp; text, repeated words here.\\n\\n- item a" + target + "\\n", "");
    record("long note: the selected section, exactly", !lazy ? "the note did not render lazily, so this proves nothing"
      : out === expected ? true : "wrong result near: " + JSON.stringify((out || "").slice((out || "").indexOf(before), (out || "").indexOf(before) + 260)));
    record("long note: placing it is quick (" + cold.toFixed(1) + "ms cold, " + warm.toFixed(1) + "ms warm)", warm < 50 ? true : "warm took " + warm.toFixed(1) + "ms");
  }

  return results;
}`;

const servers = [];
try {
  const server = await serveOn(ROOT);
  servers.push(server.proc);
  const browser = await launch({
    headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  let results;
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    // The CDN cut off and the libraries the render and the selection description
    // need injected from the repo's own copies, so this passes or fails on the
    // code and never on the network. Turndown matters here: without it a
    // selection's markdown reading is empty and only half the description is
    // exercised.
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    for (const lib of [
      "recall-clipper/vendor/marked.min.js", "recall-clipper/vendor/purify.min.js",
      "recall-clipper/vendor/katex/katex.min.js", "recall-clipper/vendor/katex/auto-render.min.js",
      "recall-clipper/vendor/turndown.js", "recall-clipper/vendor/turndown-plugin-gfm.js"
    ]) {
      const full = path.join(ROOT, lib);
      if (existsSync(full)) await page.evaluateOnNewDocument(readFileSync(full, "utf8"));
    }
    await page.evaluateOnNewDocument(`globalThis.__eraseSeed = ${Number(process.env.ERASE_SEED) || 0}; globalThis.__eraseRuns = ${Number(process.env.ERASE_RUNS) || 0};`);
    await page.goto(`${server.base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify && window.TurndownService)))) {
      throw new Error("marked/DOMPurify/Turndown never loaded — every case would fail for the wrong reason");
    }
    results = await page.evaluate(async (src) => (0, eval)("(" + src + ")")(), PROBE);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log(`\n${results.length} selection-placement cases · ${failed.length} failed`);
  console.log(`CHECK: ${results.length} checks · ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
}
