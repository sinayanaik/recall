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

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Chrome comes from tools/browser.mjs, which drives it over the DevTools
// protocol rather than through puppeteer. This used to be a hard-coded list of
// five /usr/bin paths plus a puppeteer under one person's nvm directory, and on
// any machine that matched neither — every container, every CI runner — the
// guard below printed "skipping." and exited 0, which the suite scored as a
// pass. See tools/browser.mjs for the whole story.
const CHROME = findChrome();

if (!CHROME) {
  // Not a skip: a check that cannot run has not passed. tools/check.mjs counts
  // this as a failure and names it.
  console.error("highlight-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

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
const PROBE = `async (api) => {
  const results = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, ok: detail === true, detail: detail === true ? "" : String(detail) });
    } catch (e) {
      results.push({ name, ok: false, detail: "THREW: " + e.message });
    }
  };
  // The same, for the few cases that have to wait on something (a grammar the
  // Prism autoloader fetches, a library pulled in for one case).
  const checkAsync = async (name, fn) => {
    try {
      const detail = await fn();
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

  // ── ...and where the mark it made begins ────────────────────────────────
  //
  // 'idx' was only ever used to tell the re-render which block to pin to, so
  // nothing checked what it actually pointed AT. "Highlight & annotate" turns
  // it into an ordinal — markOpenOffsets(source).indexOf(idx) — and opens the
  // note editor on that mark, so an 'idx' that is off by the width of an open
  // tag is a note written on the wrong highlight. That is the invariant here:
  // in the text it hands back, 'idx' is the first character of the new mark's
  // own '<mark' tag, on both the paths that change anything.
  check("a fresh highlight says where the mark it made begins", () => {
    const source = "One sentence here, and a second sentence after it.";
    const added = api.highlightToggleInSource(source, { asText: "second sentence", occurrence: 0 }, "yellow");
    if (!added || added.action !== "added") return "action was " + (added && added.action);
    if (!added.text.startsWith("<mark", added.idx)) {
      return "idx " + added.idx + " points at " + JSON.stringify(added.text.slice(added.idx, added.idx + 12));
    }
    // ...and it is the FIRST such offset that is not already accounted for —
    // i.e. the ordinal the annotate path computes is the mark just made.
    // \\b, not \b: this whole probe is a template literal, so a single backslash
    // here is a BACKSPACE character and the regex matches nothing. It returned
    // 0 marks for a text that plainly had one.
    const opens = added.text.match(/<mark\\b[^>]*>/g) || [];
    if (opens.length !== 1) return "expected one mark, got " + opens.length;
    return true;
  });

  check("...and a recolour says where the mark it rewrote begins", () => {
    const source = "One sentence here, and a second sentence after it.";
    const added = api.highlightToggleInSource(source, { asText: "second sentence", occurrence: 0 }, "yellow");
    const recoloured = api.highlightToggleInSource(added.text, { asText: "second sentence", occurrence: 0 }, "green");
    if (!recoloured || recoloured.action !== "recolored") return "action was " + (recoloured && recoloured.action);
    if (!recoloured.text.startsWith("<mark", recoloured.idx)) {
      return "idx " + recoloured.idx + " points at " + JSON.stringify(recoloured.text.slice(recoloured.idx, recoloured.idx + 12));
    }
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

  // ── Quote it ──────────────────────────────────────────────────────────────
  //
  // The bulletify's neighbour on the selection bar, and deliberately NOT its
  // sentence-splitting cousin: a quote is somebody else's words, and breaking
  // them up on the punctuation would be editing them. Same toggle contract
  // though — press it twice and the text has to come back byte for byte, which
  // is what the round-trip cases below are for.
  // NOTE the doubled backslashes in the six cases below. This whole probe is a
  // template literal, so a single \\n here becomes a REAL newline in the probe
  // SOURCE — which lands inside a string literal and makes the entire 57KB
  // probe unparseable ("SyntaxError: Invalid or unexpected token", raised by
  // the page's own eval, naming no line). These cases were written that way and
  // took the other seventy with them; nobody saw it because this check had not
  // run on any machine but one for months.
  check("quoting a passage prefixes every line", () => {
    const out = api.toggleBlockquote("first line\\nsecond line");
    if (out !== "> first line\\n> second line") return JSON.stringify(out);
    return true;
  });

  check("...and quotes the blank lines inside it too", () => {
    // A bare blank line ENDS a blockquote — everything after it reads as a new
    // paragraph outside the quote. Quoting the blank as ">" is what keeps a
    // two-paragraph passage one quotation.
    const out = api.toggleBlockquote("one\\n\\ntwo");
    if (out !== "> one\\n>\\n> two") return JSON.stringify(out);
    return true;
  });

  check("...without splitting a run-on sentence the way bulletify does", () => {
    const out = api.toggleBlockquote("First do this. Then do that.");
    if (out !== "> First do this. Then do that.") return JSON.stringify(out);
    return true;
  });

  check("...and toggles an existing quote back off", () => {
    const out = api.toggleBlockquote("> already\\n> quoted");
    if (out !== "already\\nquoted") return JSON.stringify(out);
    return true;
  });

  check("...counting a nested quote as quoted, so it unwraps one level", () => {
    const out = api.toggleBlockquote(">> deep\\n>> quote");
    if (out !== "> deep\\n> quote") return JSON.stringify(out);
    return true;
  });

  check("quoting a passage twice gives it back unchanged", () => {
    const shapes = ["one line only", "a\\nb", "one\\n\\ntwo", "- a bullet\\n- and another"];
    for (const shape of shapes) {
      const back = api.toggleBlockquote(api.toggleBlockquote(shape));
      if (back !== shape) return JSON.stringify(shape) + " came back as " + JSON.stringify(back);
    }
    return true;
  });

  // The block half: a quotation is a BLOCK, so a selection taken out of the
  // middle of a paragraph has to be detached from what is left either side of
  // it — otherwise markdown reads the run-up and the remainder as part of the
  // quote. blockFormat is the shared machinery bulletify already used; this is
  // the case that says quoting goes through it.
  check("quoting the middle of a paragraph detaches it from both ends", () => {
    const source = "Before it. The quoted part. After it.";
    const start = source.indexOf("The quoted");
    const end = start + "The quoted part.".length;
    const result = api.blockquoteFormat(source, start, end);
    const spliced = source.slice(0, result.rangeStart) + result.text + source.slice(result.rangeEnd);
    if (spliced !== "Before it.\\n\\n> The quoted part.\\n\\nAfter it.") return JSON.stringify(spliced);
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

  // ── One counter for every mark ────────────────────────────────────────────
  //
  // "That highlight is no longer in the note", ✕ that removed nothing, ✎ that
  // wrote onto a different highlight. Every one of them was the same bug: the
  // edits counted marks with a lazy <mark>…</mark> regex, the DOM counted
  // elements, and a nested or empty mark made the two disagree from that point
  // on. scanMarks is the one counter now; these hold it to the DOM's count.
  const NESTED = 'a <mark>foo <mark data-color="green">bar</mark> baz</mark> b <mark>x</mark> c <mark>y</mark>';
  const EMPTY = 'a <mark></mark> b <mark>x</mark> c <mark data-color="green">y</mark>';
  const domMarks = (src) => {
    const box = document.createElement("div");
    box.innerHTML = api.markdownToSafeHtml(src);
    return box.querySelectorAll("mark").length;
  };

  check("a nested mark is counted the way the DOM counts it", () => {
    const n = api.scanMarks(NESTED).length;
    const dom = domMarks(NESTED);
    if (n !== 4) return "scanMarks counted " + n + ", expected 4";
    if (dom !== n) return "the DOM holds " + dom + " marks, the scanner " + n;
    const last = api.markSpanAt(NESTED, n - 1);
    if (!last || last.inner !== "y") return "the last ordinal is not the last highlight: " + JSON.stringify(last);
    return true;
  });

  check("an empty mark does not swallow the highlight after it", () => {
    const entries = api.scanMarks(EMPTY);
    if (entries.length !== domMarks(EMPTY)) return "scanner " + entries.length + " vs DOM " + domMarks(EMPTY);
    if (api.markSpanAt(EMPTY, 1)?.inner !== "x") return "ordinal 1 is " + JSON.stringify(api.markSpanAt(EMPTY, 1));
    if (api.markSpanAt(EMPTY, 2)?.inner !== "y") return "ordinal 2 is " + JSON.stringify(api.markSpanAt(EMPTY, 2));
    return true;
  });

  check("repair: nested marks flatten into the outer one, empty ones go", () => {
    const fixed = api.normalizeHighlightSource(NESTED);
    const entries = api.scanMarks(fixed);
    if (entries.length !== 3) return "expected 3 marks, got " + entries.length + ": " + fixed;
    if (entries.some((e) => e.depth > 0)) return "still nested: " + fixed;
    if (!fixed.includes("<mark>foo bar baz</mark>")) return "outer mark lost its words: " + fixed;
    const clean = api.normalizeHighlightSource(EMPTY);
    if (clean.includes("<mark></mark>")) return "the empty mark survived: " + clean;
    if (api.scanMarks(clean).length !== 2) return "expected 2 marks after the repair: " + clean;
    const untouched = 'plain <mark>one</mark> and <mark data-color="green">two</mark>';
    if (api.normalizeHighlightSource(untouched) !== untouched) return "a healthy note was rewritten";
    return true;
  });

  check("repair: a nested highlight's note is folded in, not dropped", () => {
    let src = 'x <mark data-note="hn-aaaa">foo <mark data-note="hn-bbbb">bar</mark> baz</mark> y';
    src = api.setHighlightNoteInSource(src, "hn-aaaa", "outer note", "");
    src = api.setHighlightNoteInSource(src, "hn-bbbb", "inner note", "");
    const fixed = api.normalizeHighlightSource(src);
    const notes = api.readHighlightNotes(fixed);
    if (api.scanMarks(api.readerNotesBody(fixed)).length !== 1) return "not flattened: " + fixed;
    if (notes.has("hn-bbbb")) return "the folded entry is still there";
    const text = notes.get("hn-aaaa") || "";
    if (!text.includes("outer note") || !text.includes("inner note")) return "a note was lost: " + JSON.stringify(text);
    return true;
  });

  check("an inner mark with the only note hands it to the outer one", () => {
    const fixed = api.normalizeHighlightSource('x <mark>foo <mark data-note="hn-bbbb">bar</mark> baz</mark> y');
    if (!fixed.includes('<mark data-note="hn-bbbb">foo bar baz</mark>')) return fixed;
    return true;
  });

  check("a mark inside an inline code span is text, and is left alone", () => {
    const tick = String.fromCharCode(96);
    const src = "use " + tick + "<mark></mark>" + tick + " to highlight, like <mark>this</mark>";
    if (api.normalizeHighlightSource(src) !== src) return api.normalizeHighlightSource(src);
    return true;
  });

  // ── Extending, shrinking, never nesting ───────────────────────────────────
  const marksOf = (text) => api.scanMarks(text);
  const noNesting = (text) => (marksOf(text).some((e) => e.depth > 0) ? "nested: " + text : true);

  check("extend: selecting past a highlight grows it, it does not toggle it off", () => {
    const src = "one <mark>two</mark> three four";
    const out = api.highlightToggleInSource(src, { asText: "two three", occurrence: 0 }, "yellow");
    if (!out || out.action !== "extended") return "action " + (out && out.action) + ": " + (out && out.text);
    if (out.text !== "one <mark>two three</mark> four") return out.text;
    if (!out.text.startsWith("<mark", out.idx)) return "idx does not point at the mark";
    return true;
  });

  check("extend backwards, and keep the note on the highlight", () => {
    const src = 'one <mark data-color="green" data-note="hn-aaaa">two</mark> three';
    const out = api.highlightToggleInSource(src, { asText: "one two", occurrence: 0 }, "green");
    if (!out || out.action !== "extended") return "action " + (out && out.action) + ": " + (out && out.text);
    if (out.text !== '<mark data-color="green" data-note="hn-aaaa">one two</mark> three') return out.text;
    return true;
  });

  check("a selection across two highlights makes one, never a nest", () => {
    const src = "<mark>one</mark> two <mark>three</mark> four";
    const out = api.highlightToggleInSource(src, { asText: "one two three", occurrence: 0 }, "yellow");
    if (!out) return "no result";
    const nested = noNesting(out.text);
    if (nested !== true) return nested;
    if (out.text !== "<mark>one two three</mark> four") return out.text;
    return true;
  });

  check("two annotated highlights merged keep both notes", () => {
    const src = '<mark data-note="hn-aaaa">one</mark> two <mark data-note="hn-bbbb">three</mark>';
    const out = api.highlightToggleInSource(src, { asText: "one two three", occurrence: 0 }, "yellow");
    if (!out || out.action !== "extended") return "action " + (out && out.action);
    if (JSON.stringify(out.notes) !== JSON.stringify([["hn-aaaa", "hn-bbbb"]])) return "notes " + JSON.stringify(out.notes);
    if (!out.text.startsWith('<mark data-note="hn-aaaa">one two three</mark>')) return out.text;
    return true;
  });

  check("shrink: clearing the middle of a highlight leaves both ends", () => {
    const src = 'x <mark data-color="green" data-note="hn-aaaa">alpha beta gamma</mark> y';
    const out = api.highlightToggleInSource(src, { asText: "beta", occurrence: 0 }, "clear");
    if (!out || out.action !== "removed") return "action " + (out && out.action);
    if (out.text !== 'x <mark data-color="green" data-note="hn-aaaa">alpha </mark>beta<mark data-color="green"> gamma</mark> y') return out.text;
    return true;
  });

  check("shrink: clearing one end keeps the note on what is left", () => {
    const src = 'x <mark data-note="hn-aaaa">alpha beta</mark> y';
    const out = api.highlightToggleInSource(src, { asText: "alpha", occurrence: 0 }, "clear");
    if (!out) return "no result";
    if (out.text !== 'x alpha<mark data-note="hn-aaaa"> beta</mark> y') return out.text;
    return true;
  });

  check("re-selecting part of a highlight in its own colour is 'already'", () => {
    const src = "x <mark>alpha beta</mark> y";
    const out = api.highlightToggleInSource(src, { asText: "beta", occurrence: 0 }, "yellow");
    if (!out || out.action !== "already") return "action " + (out && out.action) + ": " + (out && out.text);
    return true;
  });

  check("the raw editor's highlight never nests either", () => {
    const out = api.toggleMarkColorInText("<mark>a</mark> b <mark>c</mark>", "green");
    const nested = noNesting(out);
    if (nested !== true) return nested;
    if (out !== '<mark data-color="green">a b c</mark>') return out;
    return true;
  });

  // ── Edits by ordinal on a note that has (had) a nested mark ───────────────
  check("remove/recolour/note reach the LAST highlight of a nested note", () => {
    const saved = api.state.notes;
    try {
      api.state.notes = NESTED;
      const last = api.scanMarks(NESTED).length - 1;
      if (!api.recolourHighlightAt(last, "green")) return "recolour refused";
      if (!api.state.notes.endsWith('<mark data-color="green">y</mark>')) return "recolour hit: " + api.state.notes;
      // The recolour re-rendered, and a render repairs the nest — so the
      // ordinal is counted again, as anything holding one across an edit must
      // (the mark menu and the note editor hold a ref for exactly this).
      const lastNow = api.scanMarks(api.readerNotesBody(api.state.notes)).length - 1;
      if (!api.setHighlightNoteAt(lastNow, "about y", { rerender: false })) return "note refused";
      const id = api.markSpanAt(api.state.notes, lastNow)?.note;
      if (api.readHighlightNotes(api.state.notes).get(id) !== "about y") return "note not on y";
      if (!api.removeHighlightAt(lastNow)) return "remove refused";
      // removeHighlightAt re-renders, which repairs the nest first — so count
      // what is left rather than assume the ordinals did not move.
      if (api.readerNotesBody(api.state.notes).includes(">y</mark>")) return "y still highlighted: " + api.state.notes;
      if (!api.readerNotesBody(api.state.notes).includes("<mark>x</mark>")) return "removed the wrong one: " + api.state.notes;
      return true;
    } finally {
      api.state.notes = saved;
    }
  });

  check("a held highlight survives one being made above it", () => {
    const src = "a <mark>x</mark> b <mark>y</mark>";
    const ref = api.highlightRefAt(1, src);
    const moved = "<mark>new</mark> " + src;
    if (api.resolveHighlightRef(moved, ref) !== 2) return "resolved to " + api.resolveHighlightRef(moved, ref);
    const gone = "a <mark>x</mark> b y";
    if (api.resolveHighlightRef(gone, ref) !== -1) return "a removed highlight resolved to " + api.resolveHighlightRef(gone, ref);
    return true;
  });

  check("adjust: a highlight grows and shrinks, keeping colour and note", () => {
    const saved = api.state.notes;
    try {
      api.state.notes = 'one <mark data-color="green" data-note="hn-aaaa">two three</mark> four five';
      if (!api.adjustHighlightAt(0, { asText: "two three four", occurrence: 0 })) return "grow refused";
      if (!api.state.notes.startsWith('one <mark data-color="green" data-note="hn-aaaa">two three four</mark> five')) return "grow: " + api.state.notes;
      if (!api.adjustHighlightAt(0, { asText: "three", occurrence: 0 })) return "shrink refused";
      if (!api.state.notes.startsWith('one two <mark data-color="green" data-note="hn-aaaa">three</mark> four five')) return "shrink: " + api.state.notes;
      // Shifted: starts earlier, ends earlier than it did.
      if (!api.adjustHighlightAt(0, { asText: "two three", occurrence: 0 })) return "shift refused";
      if (!api.state.notes.startsWith('one <mark data-color="green" data-note="hn-aaaa">two three</mark> four five')) return "shift: " + api.state.notes;
      return true;
    } finally {
      api.state.notes = saved;
    }
  });

  check("a rendered mark's words are checked against its source entry", () => {
    if (!api.markTextMatches("**bold** [link](http://x.y)", "bold link")) return "markup in the source broke the match";
    if (api.markTextMatches("other words", "bold link")) return "different words matched";
    return true;
  });

  // ── Chapters have to be worth a page ─────────────────────────────────────
  //
  // Reported as "headings that have no contents still occupy blank columns,
  // making the note discontinuous". A paper's shallowest heading is usually
  // "##", so every section became a chapter and owned a page — including the
  // one-line ones. Measured before this: an Abstract section filled 11% of a
  // column and the reader turned a whole page to read one line.
  const para = (tag, n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push(tag + " " + (i + 1) + ". " + "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ".repeat(3));
    }
    return out.join("\\n\\n");
  };

  check("a one-line section does not get a chapter of its own", () => {
    const md = "## Abstract\\n\\nWe propose a thing.\\n\\n## Keywords\\n\\na, b, c\\n\\n## Introduction\\n\\n" + para("Intro", 12);
    const chapters = api.chapterIndexFor(md);
    if (chapters.length !== 1) return "split into " + chapters.length + " chapters: " + JSON.stringify(chapters.map((c) => c.title));
    return true;
  });

  check("sections that ARE substantial still get their own chapters", () => {
    const md = "## One\\n\\n" + para("A", 12) + "\\n\\n## Two\\n\\n" + para("B", 12);
    const chapters = api.chapterIndexFor(md);
    if (chapters.length !== 2) return "split into " + chapters.length + ": " + JSON.stringify(chapters.map((c) => c.title));
    return true;
  });

  check("a merged chapter keeps the FIRST heading as its title", () => {
    const md = "## Abstract\\n\\nshort.\\n\\n## Introduction\\n\\n" + para("Intro", 12);
    const chapters = api.chapterIndexFor(md);
    if (chapters[0].title !== "Abstract") return "title is " + JSON.stringify(chapters[0].title);
    return true;
  });

  check("every block still belongs to exactly one chapter", () => {
    // Merging moves boundaries; it must never drop or duplicate a block, or a
    // paged reader would lose text outright.
    const md = "## A\\n\\nx\\n\\n## B\\n\\ny\\n\\n## C\\n\\n" + para("C", 14) + "\\n\\n## D\\n\\nz";
    const chapters = api.chapterIndexFor(md);
    let at = 0;
    for (const chapter of chapters) {
      if (chapter.blockStart !== at) return "gap or overlap at block " + at;
      at = chapter.blockEnd;
    }
    const total = api.splitPreparedBlocks(api.preprocessSpecialBlocks(md)).blocks.length;
    if (at !== total) return "chapters cover " + at + " of " + total + " blocks";
    return true;
  });

  // ── The font picker is gone from the selection tools ─────────────────────
  check("no font-family control is emitted for a selection", () => {
    const html = api.createRenderToolbarHtml({ actions: false, highlight: false });
    if (html.indexOf("data-render-font") !== -1) return "the bar still emits a font control";
    if (html.indexOf("render-style-faces") !== -1) return "the face list is still in the popover";
    return true;
  });

  // ── A note on a highlight is readable markdown at the end of the note ────
  //
  // Reported as "the notes on my highlights are written inline as cryptic
  // messages". They used to be base64 inside the <mark> itself; they are now
  // plain markdown in a "Highlight Notes" section at the end of the same note,
  // referenced by a short id. Each case here is something a reader can do to
  // that section by hand, because being hand-editable is the whole point.
  check("a note is written as readable markdown at the end of the note", () => {
    const src = "Body with a <mark data-note=\\"hn-aaaa\\">highlight</mark> in it.";
    const out = api.setHighlightNoteInSource(src, "hn-aaaa", "Remember **this**.", "“highlight”");
    // The block's own markers, taken from src/format/notes-fence.js rather than
    // typed here, so a change to the format fails at the definition rather than
    // silently passing a stale literal.
    if (out.indexOf(api.HIGHLIGHT_NOTES_OPEN) === -1) return "no notes block written: " + JSON.stringify(out);
    if (out.indexOf(api.HIGHLIGHT_NOTES_CLOSE) === -1) return "the notes block is never closed: " + JSON.stringify(out);
    // The entry still names the id AND the words it was written on, which is
    // what makes the block hand-editable — the id alone would be a lookup table.
    if (out.indexOf("hn-aaaa") === -1) return "the entry does not name its id: " + JSON.stringify(out);
    if (out.indexOf("“highlight”") === -1) return "the entry does not quote the highlighted words: " + JSON.stringify(out);
    if (out.indexOf("Remember **this**.") === -1) return "the note text is not in the block";
    if (/data-note="[A-Za-z0-9+/]{16,}"/.test(out)) return "a base64 blob is still inline";
    return true;
  });

  check("the note reads back out of the section by id", () => {
    const src = api.setHighlightNoteInSource("x <mark data-note=\\"hn-bbbb\\">y</mark>", "hn-bbbb", "a note", "“y”");
    const text = api.highlightNoteText(src, "hn-bbbb");
    if (text !== "a note") return "read back " + JSON.stringify(text);
    return true;
  });

  check("hand-editing an entry's body is what the app then reads", () => {
    let src = api.setHighlightNoteInSource("x <mark data-note=\\"hn-cccc\\">y</mark>", "hn-cccc", "written by the popup", "“y”");
    src = src.replace("written by the popup", "rewritten by hand\\n\\nwith a second paragraph");
    const text = api.highlightNoteText(src, "hn-cccc");
    if (text !== "rewritten by hand\\n\\nwith a second paragraph") return "read back " + JSON.stringify(text);
    return true;
  });

  check("editing one note leaves every other entry untouched", () => {
    let src = "a <mark data-note=\\"hn-dddd\\">one</mark> b <mark data-note=\\"hn-eeee\\">two</mark>";
    src = api.setHighlightNoteInSource(src, "hn-dddd", "first note", "“one”");
    src = api.setHighlightNoteInSource(src, "hn-eeee", "second note", "“two”");
    src = src.replace("first note", "first note, edited by hand");
    src = api.setHighlightNoteInSource(src, "hn-eeee", "second note, changed", "“two”");
    if (api.highlightNoteText(src, "hn-dddd") !== "first note, edited by hand") return "the untouched note changed";
    if (api.highlightNoteText(src, "hn-eeee") !== "second note, changed") return "the edited note did not change";
    return true;
  });

  check("removing the last note removes the section, not just its text", () => {
    let src = api.setHighlightNoteInSource("body text", "hn-ffff", "only note", "“x”");
    src = api.setHighlightNoteInSource(src, "hn-ffff", "", null);
    if (src.indexOf("Highlight Notes") !== -1) return "an empty section was left behind: " + JSON.stringify(src);
    // \\s, not \s — same reason as the \\b above. A template literal drops the
    // backslash from an unrecognised escape, so this read /-{3,}s*$/ and would
    // only ever have matched a rule followed by literal letter s.
    if (/-{3,}\\s*$/.test(src)) return "the separator rule was left behind: " + JSON.stringify(src);
    return true;
  });

  check("a note whose highlight is gone is pruned", () => {
    let src = api.setHighlightNoteInSource("kept <mark data-note=\\"hn-gggg\\">here</mark>", "hn-gggg", "live", "“here”");
    src = api.setHighlightNoteInSource(src, "hn-hhhh", "orphan", "“gone”");
    const pruned = api.pruneOrphanHighlightNotes(src);
    if (api.highlightNoteText(pruned, "hn-gggg") !== "live") return "the live note was pruned";
    if (api.highlightNoteText(pruned, "hn-hhhh") !== "") return "the orphan survived";
    return true;
  });

  check("an old base64 note still reads, and migrates to the section", () => {
    const blob = api.encodeHighlightNote("an old note with é");
    const legacy = "text <mark data-color=\\"green\\" data-note=\\"" + blob + "\\">old</mark> end";
    if (api.highlightNoteText(legacy, blob) !== "an old note with é") return "the legacy note no longer reads";
    const migrated = api.migrateLegacyHighlightNotes(legacy);
    const id = (/data-note="(hn-[a-z0-9]+)"/.exec(migrated) || [])[1];
    if (!id) return "no id written: " + JSON.stringify(migrated);
    if (migrated.indexOf(blob) !== -1) return "the base64 blob is still in the note";
    if (api.highlightNoteText(migrated, id) !== "an old note with é") return "the text did not survive migration";
    if (migrated.indexOf("data-color=\\"green\\"") === -1) return "the highlight lost its colour";
    return true;
  });

  check("a note with nothing legacy in it is returned untouched", () => {
    const src = api.setHighlightNoteInSource("a <mark data-note=\\"hn-iiii\\">b</mark>", "hn-iiii", "note", "“b”");
    if (api.migrateLegacyHighlightNotes(src) !== src) return "an already-migrated note was rewritten";
    if (api.migrateLegacyHighlightNotes("no marks here") !== "no marks here") return "a plain note was rewritten";
    return true;
  });

  check("a note reference survives a recolour", () => {
    const out = api.toggleMarkColorInText("<mark data-color=\\"green\\" data-note=\\"hn-jjjj\\">t</mark>", "blue");
    if (out.indexOf("data-note=\\"hn-jjjj\\"") === -1) return "the note reference was dropped: " + out;
    if (out.indexOf("data-color=\\"blue\\"") === -1) return "the recolour did not happen: " + out;
    return true;
  });

  check("markSpanAt reports the id of an annotated mark", () => {
    const span = api.markSpanAt("a <mark data-note=\\"hn-kkkk\\">b</mark> c", 0);
    if (!span || span.note !== "hn-kkkk") return "note read as " + JSON.stringify(span && span.note);
    return true;
  });

  // ── A highlight's note, said where the highlight is ─────────────────────
  //
  // src/notes/highlight-badges.js. One pressable fold per annotated highlight,
  // carrying no number — indexed from the SOURCE so a note built lazily, chunk
  // by chunk, cannot reshuffle itself as the reader scrolls; drawn out of flow
  // so it moves no glyph; and present only where there is a note to read.

  // The note bodies live in a "## Highlight Notes" section at the end (see
  // format/highlight-notes.js); the marks in the body only point at them.
  // "hn-dead" is the case that matters most here: an id whose entry was
  // deleted by hand is NOT a note, and nothing may light up for it.
  const NOTED = [
    "First paragraph with <mark data-note=\\"hn-aaaa\\">an annotated span</mark> in it.",
    "",
    "Second one with <mark data-note=\\"hn-bbbb\\">a longer annotation</mark> here.",
    "",
    "Third has <mark data-note=\\"hn-dead\\">a dangling id</mark> and <mark>a plain highlight</mark>.",
    "",
    "---",
    "",
    "## Highlight Notes",
    "",
    "### [hn-aaaa] \\u201Can annotated span\\u201D",
    "",
    "One line of commentary.",
    "",
    "### [hn-bbbb] \\u201Ca longer annotation\\u201D",
    "",
    "First line of a longer note.",
    "",
    "Second paragraph of it."
  ].join("\\n");

  // ── ...and the panel that lists them can actually read them ────────────
  //
  // The note bodies live in a fenced block at the END of state.notes, and every
  // surface that lists highlights scans readerNotesBody() — the note with that
  // block sliced off — because a <mark> a reader typed INSIDE a note is not a
  // highlight of the document and counting it breaks the exact-ordinal jump for
  // every other row. Resolving a mark's id against that same sliced string
  // found nothing, so the panel reported every markdown highlight as having no
  // note: the reader's own writing was invisible in the one place that lists it,
  // and pressing ✎ opened an empty editor over a note that was really there.
  // ── What the highlights surface costs to scroll ─────────────────────────
  //
  // It is a document of every highlight AND every note, each one a rendered
  // markdown fragment, and how much DOM that comes to depends on the content
  // rather than the count: 300 highlights of prose are about 7,700 nodes and 300
  // whose lines carry inline maths are 21,000, because one $x$ is a KaTeX tree
  // on its own. Above a threshold the entries are given content-visibility so
  // the engine can skip the ones off screen; below it they are not, because
  // containment costs a layout every time an entry crosses the edge and on a
  // small surface that is the more expensive half. Measured at 6x CPU throttle:
  //
  //     7,700 nodes    24ms per frame plain,  30ms contained
  //    21,000 nodes    53ms per frame plain,  31ms contained
  //
  // Neither number is assertable here — this file has no throttled scroll — but
  // the DECISION is, and it is the part that silently rots: a threshold nothing
  // checks is a threshold that gets moved.
  check("a small highlights surface is left uncontained", () => {
    api.state.notes = NOTED;
    // Rendered into the pane's own body — #highlightsList went with the
    // Highlights tab, and the container stays an argument on
    // renderHighlightsEditor partly so this check has somewhere to draw.
    const list = api.el.highlightCycleBody;
    api.renderHighlightsEditor(api.collectHighlightEntries(), list);
    const root = list.querySelector(".hl-notes");
    if (!root) return "the panel rendered nothing";
    if (root.classList.contains("is-contained")) {
      return "four highlights were given containment they cannot pay for";
    }
    // ...and every entry still carries the estimate the containment would need,
    // so turning it on is a class and not a rebuild.
    const missing = [...list.querySelectorAll(".hl-note")].filter((a) => !Number(a.dataset.estimate));
    if (missing.length) return missing.length + " entries carry no size estimate";
    return true;
  });

  check("...and the threshold is a real number, applied to the real count", () => {
    // The gate reads what was built, not how many entries there are — the two
    // are not the same question, which is the whole reason it is counted.
    if (!Number.isFinite(api.HL_CONTAIN_MIN_NODES) || api.HL_CONTAIN_MIN_NODES < 1000) {
      return "the threshold is " + api.HL_CONTAIN_MIN_NODES;
    }
    const list = api.el.highlightCycleBody;
    const root = list.querySelector(".hl-notes");
    if (!root) return "the panel rendered nothing";
    // Force the count over the line with filler the gate has to notice, and
    // re-run the decision the way the build does.
    const filler = document.createElement("div");
    filler.hidden = true;
    for (let i = 0; i < api.HL_CONTAIN_MIN_NODES; i += 1) filler.appendChild(document.createElement("span"));
    list.appendChild(filler);
    try {
      api.applyContainmentForCheck([...list.querySelectorAll(".hl-note")], []);
      if (!root.classList.contains("is-contained")) return "a surface over the threshold was left uncontained";
      return true;
    } finally {
      filler.remove();
      api.applyContainmentForCheck([...list.querySelectorAll(".hl-note")], []);
    }
  });

  check("a listed highlight carries the note that is written on it", () => {
    api.state.notes = NOTED;
    const entries = api.collectHighlightEntries();
    if (entries.length !== 4) return entries.length + " entries, expected one per highlight";
    const notes = entries.map((entry) => entry.note || "").filter(Boolean);
    if (notes.length !== 2) return notes.length + " of the entries carry a note, expected 2";
    if (notes[0] !== "One line of commentary.") return "the first note reads " + JSON.stringify(notes[0]);
    if (!notes[1].startsWith("First line of a longer note.")) return "the second note reads " + JSON.stringify(notes[1]);
    // ...and a mark whose section entry was deleted by hand still reports none,
    // which is the same test that keeps a badge off it.
    const dangling = entries.find((entry) => entry.text === "a dangling id");
    if (dangling && dangling.note) return "an id with no note behind it reported one";
    return true;
  });

  check("...and so does an export of them", () => {
    api.state.notes = NOTED;
    const items = api.collectDeckHighlightsForExport({ includeNotes: true });
    const noted = items.filter((item) => item.note).length;
    if (noted !== 2) return noted + " exported highlights carry their note, expected 2";
    // annotatedOnly reads the note BEFORE includeNotes is applied, so "the
    // annotated ones, without their notes" is not silently empty.
    const only = api.collectDeckHighlightsForExport({ annotatedOnly: true, includeNotes: false });
    if (only.length !== 2) return "annotatedOnly returned " + only.length + " entries";
    return true;
  });

  // A highlight in the notes view wears an unnumbered fold, so its card in the
  // pane carries no number either: the card is the quote with its note under
  // it, and a counter there grew to two and three digits while saying nothing
  // the layout did not. Only a PDF Document highlight — whose page badge still
  // shows one — gives its card a number (pdf-preview-check covers that half).
  check("a notes-view card carries no number, annotated or not", () => {
    api.state.notes = NOTED;
    const entries = api.collectHighlightEntries();
    if (entries.length !== 4) return entries.length + " entries, expected 4";
    const numbered = entries.filter((entry) => entry.n);
    if (numbered.length) return numbered.length + " notes-view card(s) still carry a number";
    return true;
  });

  // ── A card is a markdown surface, and has to be dressed as one ───────────
  //
  // paintNoteBody has always used the full renderMarkdown pipeline, so the
  // CONTENT of a note in a card was right; the element it was rendered into did
  // not carry 'rendered', and every rule that makes markdown look like markdown
  // in this app is scoped to that class. So a "## " came out as a bare bold line
  // with no rule under it, a fence as unstyled monospace with no panel, a list
  // at the UA's indent. "The formatting of texts in the highlighter is not
  // identical to the notes section" — and it was one word in a className.
  check("a card's note is dressed as rendered markdown", () => {
    api.state.notes = NOTED;
    const list = api.el.highlightCycleBody;
    api.renderHighlightsEditor(api.collectHighlightEntries(), list);
    const bodies = [...list.querySelectorAll(".hl-note-body")];
    if (!bodies.length) return "the pane rendered no note bodies at all";
    const bare = bodies.filter((body) => !body.classList.contains("rendered"));
    if (bare.length) return bare.length + " of " + bodies.length + " note bodies do not carry 'rendered'";
    // The quote above it always did, and the two have to agree — they are the
    // same markdown, one quoted and one written.
    const quotes = [...list.querySelectorAll(".hl-note-quote")];
    if (quotes.some((q) => !q.classList.contains("rendered"))) return "a quote lost its 'rendered'";
    return true;
  });

  // ...and a highlight with nothing written on it says nothing at all.
  //
  // It used to print "Write a note on this highlight…" into every such card. On
  // a paper marked up while reading that is most of them, so a list of what the
  // reader WROTE was mostly one instruction repeated down the column. The box is
  // still there — it is the click target, and it still carries an accessible
  // name, because a screen reader has no hover state to discover it with — but
  // there is nothing in it.
  check("an unannotated card is blank, not an instruction", () => {
    api.state.notes = NOTED;
    const list = api.el.highlightCycleBody;
    api.renderHighlightsEditor(api.collectHighlightEntries(), list);
    const empty = [...list.querySelectorAll(".hl-note-body.is-empty")];
    if (empty.length !== 2) return empty.length + " cards report an empty note, expected 2";
    const talking = empty.filter((body) => body.textContent.trim());
    if (talking.length) return "an empty card still says " + JSON.stringify(talking[0].textContent.trim());
    if (list.querySelector(".hl-note-placeholder")) return "the placeholder element is still being built";
    // Still reachable, and still says what it is to anything reading the page.
    const first = empty[0];
    if (first.tabIndex !== 0) return "an empty note is not focusable, so there is no way in by keyboard";
    if (!/no note/i.test(first.getAttribute("aria-label") || "")) {
      return "an empty note is announced as " + JSON.stringify(first.getAttribute("aria-label"));
    }
    // ...and the height estimate agrees with it. A blank box contributes no
    // height, and an estimate that still counts a line for one is a scroller
    // claiming more than the cards occupy — see estimateEntryHeight.
    const entries = api.collectHighlightEntries();
    const blank = entries.find((entry) => !entry.note);
    const written = entries.find((entry) => entry.note);
    if (!blank || !written) return "the fixture no longer has one of each";
    if (api.estimateEntryHeight(blank) >= api.estimateEntryHeight(written)) {
      return "an empty card is estimated as tall as one carrying a note";
    }
    return true;
  });

  // ── Everything that changes the SET of highlights has to say so ──────────
  //
  // notifyHighlightsChanged is what rebuilds the side-by-side pane, moves its
  // "12 / 87" counter, repaints the badges and marks the contents drawers stale.
  // makeHighlightFromSelection — the one verb behind every way of marking text
  // in a note — never called it, so a highlight made with the pane open beside
  // the note did not appear in it. "The highlight count is not real-time
  // updating." The document side never had the bug, because
  // addDocumentHighlight goes through commitDocumentHighlights.
  //
  // Asserted through the registered handler rather than through the pane, so
  // this is a statement about the verb and not about whatever surface happens to
  // be listening.
  check("making a highlight tells the surfaces that list them", () => {
    const source = "A plain sentence in a note.\\n";
    let told = 0;
    const previous = api.notifyHighlightsChanged;
    api.setHighlightsChangedHandler(() => { told += 1; });
    try {
      let written = source;
      api.makeHighlightFromSelection({
        view: document.createElement("div"),
        label: "notes",
        getSource: () => written,
        setSource: (text) => { written = text; },
        rerender: () => {}
      }, "green", { asText: "plain sentence", occurrence: 0 });
      if (!written.includes("<mark")) return "nothing was highlighted, so this proves nothing";
      if (told !== 1) return "the highlight was made and the handler was called " + told + " time(s)";
      // ...and erasing one, which takes any <mark> inside it with it.
      api.eraseNotesSelection({
        view: document.createElement("div"),
        label: "notes",
        getSource: () => written,
        setSource: (text) => { written = text; },
        rerender: () => {}
      }, { asText: "in a note", occurrence: 0 });
      if (told !== 2) return "erasing a passage called the handler " + told + " time(s) in total, expected 2";
      return true;
    } finally {
      api.setHighlightsChangedHandler(previous);
    }
  });

  // ...and so does formatting a phrase inside a note that is already written.
  //
  // The card registers itself as a render target so the floating pill can splice
  // its markdown (registerCardTarget). Its setSource wrote with { rerender:
  // false } and stopped, on the belief that the write notified by itself. For a
  // <mark> it does; for a DOCUMENT highlight setDocumentHighlightNote passes the
  // same flag on as { notify: false }, so bolding a word in a note about a PDF
  // highlight wrote the ** and repainted nothing. The button looked dead.
  check("formatting a rendered card's note repaints the card", () => {
    api.state.notes = NOTED;
    const list = api.el.highlightCycleBody;
    api.renderHighlightsEditor(api.collectHighlightEntries(), list);
    const card = [...list.querySelectorAll(".hl-note")]
      .find((node) => !node.querySelector(".hl-note-body.is-empty"));
    if (!card) return "no card in the fixture carries a note";
    const body = card.querySelector(".hl-note-body");
    let told = 0;
    const previous = api.notifyHighlightsChanged;
    api.setHighlightsChangedHandler(() => { told += 1; });
    try {
      // The registration the pill resolves through, made the way a press on the
      // card makes it.
      body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const config = api.renderTargetConfig(api.NOTE_EDITOR_TARGET);
      if (!config || config.view !== body) return "a press on a card registered no render target";
      if (config.isEditing()) return "a rendered card reported itself as being edited";
      const before = config.getSource();
      if (!before) return "the registered target reads an empty note";
      config.setSource(before + " More.");
      if (told !== 1) return "a write through the card's own target notified " + told + " time(s)";
      return true;
    } finally {
      api.setHighlightsChangedHandler(previous);
      api.state.notes = NOTED;
    }
  });

  // ── ...and the two verbs behind that write agree about when to say so ────
  //
  // A card's note is written by one of two verbs depending on which kind of
  // highlight it belongs to, and they disagreed about what { rerender: false }
  // meant. For a <mark> it meant "do not repaint the note" and the surfaces were
  // told anyway; for a document highlight it was passed straight through as the
  // notify as well, so the same call told nobody. That asymmetry is the whole of
  // why bolding a word in a note about a PDF highlight repainted nothing while
  // the identical press on a note in a markdown deck worked.
  //
  // Both take 'notify' by that name now, so a caller can ask for either without
  // knowing which kind it is holding. The per-typing-pause default is preserved
  // on the document side and asserted here too — printing a page's notes again
  // between keystrokes is what made the paper jump under the note being written.
  check("both note verbs take rerender and notify as separate questions", () => {
    const previousMeta = api.state.meta;
    const previousNotes = api.state.notes;
    let told = 0;
    const previous = api.notifyHighlightsChanged;
    api.setHighlightsChangedHandler(() => { told += 1; });
    try {
      api.state.notes = NOTED;
      api.state.meta = {
        pdf: { pages: 1 },
        pdfHighlights: [{ id: "doc-1", color: "yellow", page: 1, text: "a passage", quads: [{ page: 1 }] }]
      };
      // Quiet, because this is the shape an editor saves in on every pause.
      api.setDocumentHighlightNote("doc-1", "First pause.", { rerender: false });
      if (told !== 0) return "a quiet document write notified " + told + " time(s)";
      api.setHighlightNoteAt(0, "First pause.", { rerender: false, notify: false });
      if (told !== 0) return "a quiet mark write notified " + told + " time(s)";
      // ...and loud, which is the shape a discrete action saves in.
      api.setDocumentHighlightNote("doc-1", "Committed.", { rerender: false, notify: true });
      if (told !== 1) return "a document write asking to notify called the handler " + told + " time(s)";
      api.setHighlightNoteAt(0, "Committed.", { rerender: false, notify: true });
      if (told !== 2) return "a mark write asking to notify brought the total to " + told + ", expected 2";
      return true;
    } finally {
      api.setHighlightsChangedHandler(previous);
      api.state.meta = previousMeta;
      api.state.notes = previousNotes;
    }
  });

  check("note index: numbered in document order, dangling ids skipped", () => {
    const index = api.highlightNoteIndex(NOTED);
    const got = [...index.byAttr.entries()].map(([attr, info]) => attr + "=" + info.n).join(",");
    if (got !== "hn-aaaa=1,hn-bbbb=2") return "numbered as " + JSON.stringify(got);
    if (index.byAttr.has("hn-dead")) return "an id with no section entry was numbered";
    return true;
  });

  check("note index: a legacy base64 note is numbered alongside the rest", () => {
    // The pre-section form, still readable and still an annotation — it must
    // not be a second case every caller has to remember.
    const blob = api.encodeHighlightNote("Written before the section existed.");
    const source = "Para with <mark data-note=\\"" + blob + "\\">an old note</mark>.\\n\\n" + NOTED;
    const index = api.highlightNoteIndex(source);
    const info = index.byAttr.get(blob);
    if (!info) return "the legacy note was not indexed at all";
    if (info.n !== 1) return "numbered " + info.n + ", expected 1 (it comes first)";
    if (info.text !== "Written before the section existed.") return "decoded as " + JSON.stringify(info.text);
    return true;
  });

  check("note index: memoized on the source, and its signature tracks edits", () => {
    const source = NOTED;
    if (api.highlightNoteIndex(source) !== api.highlightNoteIndex(source)) {
      return "a second call for the same string rebuilt the index";
    }
    const before = api.highlightNoteIndex(source).signature;
    // An edit that touches no note at all must NOT move the signature — that
    // is what keeps the whole-document refresh off every ordinary repaint.
    const unrelated = source.replace("First paragraph", "First paragraph, edited");
    if (api.highlightNoteIndex(unrelated).signature !== before) {
      return "an edit to ordinary prose changed the signature";
    }
    // ...and an edit to a note's TEXT must move it, or the printed copy would
    // go stale. Same length, so a length-only signature would miss this.
    const retyped = source.replace("One line of commentary.", "One line of commentarY.");
    if (api.highlightNoteIndex(retyped).signature === before) {
      return "a same-length edit to a note body left the signature unchanged";
    }
    return true;
  });

  // The DOM half. A real container with real rendered blocks, so the pass has
  // paragraphs to find hosts in and a section to hide.
  const renderNoted = () => {
    const host = document.createElement("div");
    host.className = "rendered notes-rendered";
    host.innerHTML = api.markdownToSafeHtml(NOTED);
    document.body.appendChild(host);
    return host;
  };

  check("a note gives its highlight a fold, a plain highlight none", () => {
    api.state.notes = NOTED;
    const host = renderNoted();
    try {
      api.annotateHighlightBadges(host);
      const marks = [...host.querySelectorAll("mark")];
      // firstChild, not textContent: the badge is a real element INSIDE the
      // mark now, so textContent would read "an annotated span1".
      const got = marks.map((m) => m.firstChild.textContent + ":" + (m.classList.contains("has-note") ? "yes" : "no")).join(", ");
      const want = "an annotated span:yes, a longer annotation:yes, a dangling id:no, a plain highlight:no";
      if (got !== want) return got;
      const badges = [...host.querySelectorAll(".hl-note-badge")];
      if (badges.length !== 2) return badges.length + " badge(s), expected 2";
      // A fold, not a number: nothing in it that could grow with the note, and
      // nothing a screen reader would read as a footnote count.
      if (badges.some((b) => b.textContent !== "")) return "the badge carries text: " + badges.map((b) => JSON.stringify(b.textContent)).join(",");
      if (!badges.every((b) => b.getAttribute("aria-label"))) return "a badge with no accessible name";
      // Still indexed from the SOURCE, in document order — the property that
      // has to survive a note being built lazily, chunk by chunk.
      const keys = badges.map((b) => b.dataset.hnKey).join(",");
      if (keys !== "1,2") return "indexed " + keys;
      // Only where there is something to read. An id whose section entry was
      // deleted by hand is not a note, and must not be offered as one.
      const dangling = marks.find((m) => m.firstChild.textContent === "a dangling id");
      if (dangling.querySelector(".hl-note-badge")) return "an id with no note behind it was given a badge";
      if (marks[3].querySelector(".hl-note-badge")) return "a highlight with no note at all was given a badge";
      // Pressable and reachable, which is the whole reason it is an element and
      // not the ::after it used to be.
      if (badges[0].tagName !== "BUTTON") return "the badge is a " + badges[0].tagName + ", which cannot be pressed or focused";
      return true;
    } finally { host.remove(); }
  });

  check("...and it costs the line it is on not one pixel", () => {
    // The rule styles/23-highlight-marks.css exists for, asserted rather than
    // argued. A mark that widens its own text re-wraps the block it is in, and a
    // rewrap after renderNotesViewPinned has measured its anchor is the "severe
    // shivering when I highlight" report. An absolutely positioned badge is out
    // of flow and contributes nothing to the line box; a ::after was too, and
    // any replacement has to keep that.
    api.state.notes = NOTED;
    const host = renderNoted();
    try {
      const mark = host.querySelector("mark");
      const bare = mark.getBoundingClientRect();
      const bareParagraph = mark.closest("p").getBoundingClientRect();
      api.annotateHighlightBadges(host);
      if (!mark.querySelector(".hl-note-badge")) return "no badge was added, so this proves nothing";
      const withBadge = mark.getBoundingClientRect();
      const withParagraph = mark.closest("p").getBoundingClientRect();
      if (Math.abs(withBadge.width - bare.width) > 0.01) {
        return "the mark grew by " + (withBadge.width - bare.width).toFixed(2) + "px";
      }
      if (Math.abs(withParagraph.height - bareParagraph.height) > 0.01) {
        return "the paragraph re-wrapped: " + bareParagraph.height + " -> " + withParagraph.height;
      }
      return true;
    } finally { host.remove(); }
  });

  check("...and it sits in the highlight's own corner, small, over nothing past it", () => {
    // The report that retired the number: on a note with a gloss on every word
    // the pills sat on the vowel signs and on the next word, and grew with
    // every digit. The fold is the mark's top-right corner and no more — its
    // right edge the tint's, its top the tint's, the same few pixels whatever
    // the count — so it can neither reach the next word nor drop into the
    // letters below the top band of the line.
    api.state.notes = NOTED;
    const host = renderNoted();
    try {
      api.annotateHighlightBadges(host);
      const marks = [...host.querySelectorAll("mark.has-note")];
      if (marks.length !== 2) return marks.length + " annotated mark(s), expected 2";
      for (const mark of marks) {
        const name = JSON.stringify(mark.firstChild.textContent);
        const lines = mark.getClientRects();
        const end = lines[lines.length - 1];
        const fold = mark.querySelector(".hl-note-badge").getBoundingClientRect();
        const em = parseFloat(getComputedStyle(mark).fontSize);
        if (fold.right > end.right + 0.5) return name + ": the fold reaches " + (fold.right - end.right).toFixed(1) + "px past the highlight";
        if (end.right - fold.right > 1.5) return name + ": the fold stops " + (end.right - fold.right).toFixed(1) + "px short of the corner";
        if (Math.abs(fold.top - end.top) > 1.5) return name + ": the fold's top is " + (fold.top - end.top).toFixed(1) + "px from the highlight's";
        if (fold.width > 0.45 * em || fold.height > 0.45 * em) {
          return name + ": the fold is " + fold.width.toFixed(1) + "x" + fold.height.toFixed(1) + "px at a " + em + "px font";
        }
        // ...and the drawn part is the upper-right half of that square: the
        // corner of an em box, above the letters' x-height.
        const clip = getComputedStyle(mark.querySelector(".hl-note-badge"), "::after").clipPath;
        if (!/polygon/.test(clip)) return name + ": the fold is not drawn as a corner triangle (" + clip + ")";
      }
      return true;
    } finally { host.remove(); }
  });

  check("...and on a highlight that wraps, it is where the highlight ENDS", () => {
    // An abs-pos child of a multi-line inline is positioned against the FIRST
    // line box, so offsets from the mark's edges put the number at the end of
    // the first line — mid-highlight, with the real end a line further down.
    api.state.notes = NOTED;
    const host = renderNoted();
    host.style.width = "180px";
    try {
      api.annotateHighlightBadges(host);
      const mark = [...host.querySelectorAll("mark.has-note")].find((m) => m.getClientRects().length > 1);
      if (!mark) return "no annotated highlight wrapped at 180px, so this proves nothing";
      const lines = mark.getClientRects();
      const lastLine = lines[lines.length - 1];
      const chip = mark.querySelector(".hl-note-badge").getBoundingClientRect();
      const midY = (chip.top + chip.bottom) / 2;
      if (midY < lastLine.top || midY > lastLine.bottom) {
        return "the fold is at y=" + chip.top.toFixed(0) + ", the highlight's last line is y=" + lastLine.top.toFixed(0) + "-" + lastLine.bottom.toFixed(0);
      }
      if (Math.abs(chip.right - lastLine.right) > 1.5) {
        return "the fold ends at x=" + chip.right.toFixed(0) + ", the highlight ends at x=" + lastLine.right.toFixed(0);
      }
      return true;
    } finally { host.remove(); }
  });

  check("...and the source matcher never reads its digits", () => {
    // The failure this guards is silent and total: a stray "1" in the needle
    // means locateSelectionInSource cannot find the paragraph in the markdown,
    // so every highlight, cloze and erase made over an annotated paragraph
    // misses. cleanedSelectionFragment strips the badge as part of removing
    // every <button>; emitTextWithLineBreaks walks the LIVE dom and needs the
    // class named, which is the half that is easy to forget.
    api.state.notes = NOTED;
    const host = renderNoted();
    try {
      api.annotateHighlightBadges(host);
      const para = host.querySelector("p");
      const read = api.textWithLineBreaks(para);
      if (read !== "First paragraph with an annotated span in it.") return JSON.stringify(read);
      return true;
    } finally { host.remove(); }
  });

  check("two notes in one paragraph, and a re-run replaces in place", () => {
    // A paragraph with two annotated highlights is where every "just take the
    // last child" shortcut in this pass falls over — and where a stale badge is
    // most visible, since the two sit side by side.
    const two = [
      "One para with <mark data-note=\\"hn-cccc\\">the first span</mark> and <mark data-note=\\"hn-dddd\\">the second</mark>.",
      "",
      "## Highlight Notes",
      "",
      "### [hn-cccc]",
      "",
      "Note about the first.",
      "",
      "### [hn-dddd]",
      "",
      "Note about the second."
    ].join("\\n");
    api.state.notes = two;
    // The REAL #notesView, not a container of our own, because the pass under
    // test here is refreshHighlightBadges — the whole-document one, which
    // resolves its container from el and which sweeps any badge the pass did
    // not claim. That sweep is what a wrongly-returned node breaks, and it is
    // invisible to the per-chunk pass every case above uses.
    const host = api.el.notesView;
    const restore = host.innerHTML;
    host.innerHTML = api.markdownToSafeHtml(two);
    try {
      api.refreshHighlightBadges({ force: true });
      const para = host.querySelector("p");
      let badges = [...para.querySelectorAll(".hl-note-badge")];
      if (badges.length !== 2) return "put " + badges.length + " badges in the paragraph, expected 2";
      if (badges.map((n) => n.dataset.hnKey).join(",") !== "1,2") return "numbered " + badges.map((n) => n.dataset.hnKey).join(",");

      // Running the pass again must change nothing at all — the enhancement
      // passes re-run on every repaint, and a pass that appends rather than
      // recognises would double every badge on screen.
      const before = badges.slice();
      api.refreshHighlightBadges({ force: true });
      badges = [...para.querySelectorAll(".hl-note-badge")];
      if (badges.length !== 2) return "a second pass left " + badges.length + " badges";
      if (badges[0] !== before[0] || badges[1] !== before[1]) return "a second pass rebuilt nodes that had not changed";

      // Now edit the FIRST note only. Its badge must be replaced where it
      // stands, and the second must be left alone.
      api.state.notes = two.replace("Note about the first.", "Rewritten note about the first.");
      api.refreshHighlightBadges({ force: true });
      badges = [...para.querySelectorAll(".hl-note-badge")];
      if (badges.length !== 2) return "editing one note left " + badges.length + " badges";
      if (badges.map((n) => n.dataset.hnKey).join(",") !== "1,2") return "the replacement landed out of order: " + badges.map((n) => n.dataset.hnKey).join(",");
      if (badges[0] === before[0]) return "the edited note's badge was not refreshed";
      if (!badges[0].title.includes("Rewritten")) return "the refreshed badge still describes the old text";
      if (badges[1] !== before[1]) return "the untouched note's badge was rebuilt too";

      // ...and deleting both notes takes both badges with them. Nothing else
      // sweeps them: the block they are in is not rebuilt by an edit to the
      // section at the end of the document.
      api.state.notes = "One para with <mark>the first span</mark> and <mark>the second</mark>.";
      host.innerHTML = api.markdownToSafeHtml(api.state.notes);
      api.refreshHighlightBadges({ force: true });
      if (host.querySelector(".hl-note-badge")) return "a badge survived its note being deleted";
      if (host.querySelector("mark.has-note")) return "a mark still says it is annotated";
      return true;
    } finally {
      host.innerHTML = restore;
      api.refreshHighlightBadges({ force: true });
    }
  });

  // ── One highlight is one highlight, however many lines it is next to ──────
  //
  // The Gayatri Mantra report: one phrase per line, one highlight per phrase,
  // a note on each. A lone newline between two same-colour marks was read as a
  // block boundary inside ONE highlight action, so the pane and the export
  // merged neighbours, kept only the first one's note, and recolour/remove hit
  // both. marked runs with breaks: true; a lone newline is inside a paragraph,
  // and wrapAcrossBlocks never splits a mark there.
  check("highlights on consecutive lines of one paragraph stay separate", () => {
    const src = "ॐ <mark>स्वः</mark>\\n<mark>तत्</mark>सवितुर्";
    const scan = api.scanHighlightGroups(src);
    if (scan.groups.length !== 2) return "scanned as " + scan.groups.length + " group(s), expected 2";
    const group = api.markGroupSpanAt(src, 0);
    if (!group || group.count !== 1) return "an edit to the first would also take " + ((group?.count || 1) - 1) + " more";
    return true;
  });

  check("a highlight carrying its own note never joins the one before it", () => {
    const src = "- <mark>alpha</mark>\\n- <mark data-note=\\"hn-abcd\\">bravo</mark>";
    if (api.markGroupSpanAt(src, 0).count !== 1) return "the annotated bravo was swept into alpha's group";
    if (api.scanHighlightGroups(src).groups.length !== 2) return "the pane would show one row for two annotations";
    return true;
  });

  check("an edit never groups two colours", () => {
    const src = "- <mark>alpha</mark>\\n- <mark data-color=\\"green\\">bravo</mark>";
    const group = api.markGroupSpanAt(src, 0);
    if (group.count !== 1) return "removing the yellow highlight would also remove the green one";
    return true;
  });

  check("one drag across paragraphs, and from a heading, still moves as one", () => {
    const para = "<mark>first paragraph</mark>\\n\\n<mark>second paragraph</mark>";
    if (api.markGroupSpanAt(para, 0).count !== 2) return "a paragraph drag no longer groups";
    const heading = "## <mark>Heading</mark>\\n<mark>the paragraph under it</mark>";
    if (api.markGroupSpanAt(heading, 0).count !== 2) return "a heading-into-paragraph drag no longer groups";
    return true;
  });

  // ── A highlight never ends half-way through a letter ─────────────────────
  check("a highlight boundary never splits a letter from its virama or vowel sign", () => {
    // "तत" selected out of "तत्सवितुर्": the virama belongs to the second त.
    const src = "तत्सवितुर्";
    const snapped = api.snapToWholeCharacters(src, 0, 2);
    if (src.slice(snapped.idx, snapped.end) !== "तत्") return "snapped to " + JSON.stringify(src.slice(snapped.idx, snapped.end));
    // ...and a start that lands ON a sign moves back to its letter.
    const start = api.snapToWholeCharacters("ab भू", 4, 5);
    if (start.idx !== 3) return "a start on a vowel sign stayed at " + start.idx;
    // Never across a tag: the letter on the far side is another highlight's.
    const tagged = api.snapToWholeCharacters("<mark>त</mark>्स", 14, 16);
    if (tagged.idx !== 14) return "moved back across a tag to " + tagged.idx;
    return true;
  });

  // ── Touching a highlight is not selecting it ──────────────────────────────
  check("a selection that only touches a neighbouring highlight does not overlap it", () => {
    const host = document.createElement("p");
    host.innerHTML = "ॐ <mark>भू</mark>र्भुवः स्वः";
    document.body.appendChild(host);
    try {
      const mark = host.querySelector("mark");
      const inside = mark.firstChild;
      const after = mark.nextSibling;
      const touching = document.createRange();
      touching.setStart(inside, inside.data.length);
      touching.setEnd(after, 6);
      if (!touching.intersectsNode(mark)) return "the fixture does not reproduce the old false positive";
      if (api.rangeCoversTextOf(touching, mark)) return "a range ending inside the neighbour's last position counted as covering it";
      const covering = document.createRange();
      covering.selectNodeContents(mark);
      if (!api.rangeCoversTextOf(covering, mark)) return "the highlight's own words did not count";
      return true;
    } finally { host.remove(); }
  });

  // ── The pane and the export colour only the card's own highlight ─────────
  check("a card's quote keeps only its own highlight coloured", () => {
    const out = api.markdownWithOnlyOwnMarks("ॐ <mark>भू</mark><mark data-color=\\"green\\" data-note=\\"hn-abcd\\">र्भुवः</mark> <mark>स्वः</mark>", [1]);
    if (out !== "ॐ भू<mark data-color=\\"green\\">र्भुवः</mark> स्वः") return JSON.stringify(out);
    return true;
  });

  check("the export keeps every line's note on its own card, with no number or label", () => {
    const notes = [
      "ॐ <mark data-note=\\"hn-aaaa\\">स्वः</mark>",
      "<mark data-note=\\"hn-bbbb\\">तत्</mark>सवितुर्",
      "",
      "## Highlight Notes",
      "",
      "### [hn-aaaa]",
      "",
      "soul",
      "",
      "### [hn-bbbb]",
      "",
      "that"
    ].join("\\n");
    const saved = api.state.notes;
    api.state.notes = notes;
    try {
      const items = api.collectDeckHighlightsForExport({ includeChapter: false });
      if (items.length !== 2) return items.length + " item(s), expected 2";
      if (items.map((i) => i.note).join("|") !== "soul|that") return "notes came out as " + JSON.stringify(items.map((i) => i.note));
      if (items.some((i) => i.n)) return "an exported card still carries a number";
      // The Markdown export: the note is a plain quote under its passage —
      // no "Note 3:" telling the reader what the layout already does.
      const md = api.buildHighlightsExportMarkdown("T");
      if (md.includes("**Note")) return "the Markdown export still labels its notes";
      if (!md.includes("> soul") || !md.includes("> that")) return "a note is missing from the Markdown export";
      if ((items[0].markdown.match(/<mark/g) || []).length !== 1) return "card 1 colours more than its own highlight: " + items[0].markdown;
      if (items[0].markdown.includes("data-note")) return "a note id leaked into the export";
      return true;
    } finally { api.state.notes = saved; }
  });

  // ── Highlights inside a code block ───────────────────────────────────────
  //
  // src/render/code-marks.js (the render) and src/format/code-highlight.js (the
  // write). A mark in a fence used to be written into the code and rendered as
  // the literal TEXT "<mark>", with any line starting "# " or "- " split in two
  // as though it were a heading or a list item. F is a fence, spelled with
  // \x60 so this template literal needs no escaped backticks.
  const F = "\x60\x60\x60";
  const CODE_NOTE = ["Intro.", "", F + "python", "# compute area", "def area(r):", "    return 3.14 * r ** 2", F, "", "After."].join("\\n");
  const CODE_TEXT = "# compute area\\ndef area(r):\\n    return 3.14 * r ** 2\\n";
  const MARKED_NOTE = CODE_NOTE.replace("def area(r):", 'def <mark data-color="green">area(r)</mark>:');
  const codeSel = (text, start, end, view = null, element = null) => ({ code: { text, start, end, element }, view });
  const renderCode = (markdown) => {
    const host = document.createElement("div");
    host.className = "rendered";
    host.innerHTML = api.markdownToSafeHtml(markdown);
    document.body.appendChild(host);
    api.enhanceCodeBlocks([host]);
    return host;
  };
  const addBadge = (mark, digit) => {
    const badge = document.createElement("button");
    badge.className = "hl-note-badge";
    badge.textContent = digit;
    mark.appendChild(badge);
    return badge;
  };
  // A DOM position for a clean-text offset in a rendered <code>.
  const codePoint = (root, offset) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    let pos = 0;
    while ((node = walker.nextNode())) {
      if (offset <= pos + node.data.length) return [node, offset - pos];
      pos += node.data.length;
    }
    return [root, root.childNodes.length];
  };

  check("code: a '# ' line is marked whole, not split as a heading", () => {
    const r = api.highlightCodeSelectionInSource(CODE_NOTE, codeSel(CODE_TEXT, 0, 14), "green");
    if (!r || r.action !== "added") return "no result: " + JSON.stringify(r);
    if (!r.text.includes('<mark data-color="green"># compute area</mark>')) return JSON.stringify(r.text);
    if (r.text.slice(r.idx, r.idx + 5) !== "<mark") return "idx does not point at the new mark";
    return true;
  });

  check("code: a multi-line selection is ONE mark", () => {
    const start = CODE_TEXT.indexOf("def");
    const end = CODE_TEXT.indexOf("** 2") + 4;
    const r = api.highlightCodeSelectionInSource(CODE_NOTE, codeSel(CODE_TEXT, start, end), "blue");
    const marks = ((r && r.text).match(/<mark/g) || []).length;
    if (marks !== 1) return "expected one mark, got " + marks + ": " + JSON.stringify(r && r.text);
    if (!r.text.includes('<mark data-color="blue">def area(r):\\n    return 3.14 * r ** 2</mark>')) return JSON.stringify(r.text);
    return true;
  });

  check("code: same colour again removes, another recolours and keeps the note", () => {
    const once = api.highlightCodeSelectionInSource(CODE_NOTE, codeSel(CODE_TEXT, 2, 14), "green").text;
    const noted = once.replace('<mark data-color="green">', '<mark data-color="green" data-note="hn-abcd">');
    const recoloured = api.highlightCodeSelectionInSource(noted, codeSel(CODE_TEXT, 2, 14), "blue");
    if (recoloured.action !== "recolored" || !recoloured.text.includes('<mark data-color="blue" data-note="hn-abcd">compute area</mark>')) {
      return "recolour: " + JSON.stringify(recoloured);
    }
    const removed = api.highlightCodeSelectionInSource(recoloured.text, codeSel(CODE_TEXT, 2, 14), "blue");
    if (removed.action !== "removed" || removed.text !== CODE_NOTE) return "remove: " + JSON.stringify(removed);
    return true;
  });

  check("code: a selection across two highlights is refused", () => {
    let src = api.highlightCodeSelectionInSource(CODE_NOTE, codeSel(CODE_TEXT, 2, 9), "green").text;
    src = api.highlightCodeSelectionInSource(src, codeSel(CODE_TEXT, 10, 14), "green").text;
    const r = api.highlightCodeSelectionInSource(src, codeSel(CODE_TEXT, 0, 14), "blue");
    return r.action === "already" && r.text === src ? true : JSON.stringify(r);
  });

  check("code: a fence indented under a list item maps back through the indent", () => {
    const src = ["- step one", "", "  " + F + "js", "  const a = 1;", "  const b = a;", "  " + F].join("\\n");
    const text = "const a = 1;\\nconst b = a;\\n";
    const start = text.indexOf("b = a");
    const r = api.highlightCodeSelectionInSource(src, codeSel(text, start, start + 5), "green");
    if (!r) return "no fence matched";
    return r.text.includes('  const <mark data-color="green">b = a</mark>;') ? true : JSON.stringify(r.text);
  });

  check("drag from code into prose: the prose after the fence is still marked", () => {
    const out = api.wrapAcrossBlocks("return x\\n" + F + "\\n\\nProse after.", "green", { openFence: F });
    if (/<mark[^>]*>return/.test(out)) return "the code was wrapped as prose: " + JSON.stringify(out);
    if (!/<mark data-color="green">Prose after\\.<\\/mark>/.test(out)) return "the prose was not marked: " + JSON.stringify(out);
    return true;
  });

  check("text search inside a fence: one mark, a list-looking line left whole", () => {
    const src = [F + "yaml", "- item one", "- item two", F].join("\\n");
    const r = api.highlightToggleInSource(src, { asText: "- item two", asMarkdown: "" }, "green");
    if (!r) return "not located";
    return r.text.includes('<mark data-color="green">- item two</mark>') ? true : JSON.stringify(r.text);
  });

  check("raw editor: a selection inside a fence gets one mark", () => {
    const src = [F + "bash", "# install", "npm i", F].join("\\n");
    const s = src.indexOf("# install");
    const e = src.indexOf("npm i") + 5;
    const out = api.toggleMarkColorInText(src.slice(s, e), "green", api.codeSelectionContext(src, s, e));
    return out === '<mark data-color="green"># install\\nnpm i</mark>' ? true : JSON.stringify(out);
  });

  check("render: a code mark is a wash and a ring — no underline — and the strength setting scales it", () => {
    const host = renderCode(MARKED_NOTE);
    try {
      const mark = host.querySelector("pre code mark");
      const root = document.documentElement;
      const alphaOf = () => {
        const m = getComputedStyle(mark).backgroundColor.match(/[\\d.]+/g).map(Number);
        return m.length > 3 ? m[3] : 1;
      };
      const was = root.style.getPropertyValue("--code-mark-scale");
      const seen = {};
      try {
        for (const [level, scale] of [["subtle", "0.7"], ["medium", "1"], ["strong", "1.5"]]) {
          root.style.setProperty("--code-mark-scale", scale);
          seen[level] = alphaOf();
        }
      } finally {
        if (was) root.style.setProperty("--code-mark-scale", was); else root.style.removeProperty("--code-mark-scale");
      }
      if (!(seen.subtle < seen.medium && seen.medium < seen.strong)) return "wash does not grow with the setting: " + JSON.stringify(seen);
      const css = getComputedStyle(mark);
      if (css.textDecorationLine !== "none") return "the code mark is underlined: " + css.textDecorationLine;
      if (!/inset/.test(css.boxShadow) || /0px -2px/.test(css.boxShadow)) return "expected an all-round ring, got " + css.boxShadow;
      return true;
    } finally {
      host.remove();
    }
  });

  check("render: a mark in a fence is one element over Prism's tokens", () => {
    const host = renderCode(MARKED_NOTE);
    try {
      const code = host.querySelector("pre code");
      const marks = code.querySelectorAll("mark");
      if (marks.length !== 1) return "expected 1 mark element, got " + marks.length + ": " + code.innerHTML;
      if (code.textContent.includes("<mark")) return "tag text left in the code: " + code.textContent;
      if (marks[0].textContent !== "area(r)") return "the mark holds " + JSON.stringify(marks[0].textContent);
      if (marks[0].getAttribute("data-color") !== "green") return "colour lost";
      if (!code.querySelector(".token")) return "Prism did not run (no tokens)";
      if (!marks[0].querySelector(".token")) return "the mark holds no token spans: " + marks[0].innerHTML;
      if (api.codeCleanText(code) !== CODE_TEXT) return "clean text: " + JSON.stringify(api.codeCleanText(code));
      return true;
    } finally {
      host.remove();
    }
  });

  check("render: a second Prism pass keeps the mark, its identity and its badge", () => {
    const host = renderCode(MARKED_NOTE);
    try {
      const code = host.querySelector("pre code");
      const mark = code.querySelector("mark");
      const badge = addBadge(mark, "7");
      Prism.highlightElement(code);
      const after = code.querySelectorAll("mark");
      if (after.length !== 1) return "marks after re-highlight: " + after.length;
      if (after[0] !== mark) return "the mark element was replaced";
      if (!mark.contains(badge)) return "the badge was lost";
      if (api.codeCleanText(code) !== CODE_TEXT) return "clean text picked up the badge: " + JSON.stringify(api.codeCleanText(code));
      if (mark.textContent !== "area(r)7") return "mark text: " + JSON.stringify(mark.textContent);
      return true;
    } finally {
      host.remove();
    }
  });

  check("code: identical blocks — the second one's selection marks the second fence", () => {
    const twin = [F + "python", "i += 1", F, "", "between", "", F + "python", "i += 1", F].join("\\n");
    const host = renderCode(twin);
    try {
      const codes = host.querySelectorAll("pre code");
      const r = api.highlightCodeSelectionInSource(twin, codeSel(api.codeCleanText(codes[1]), 0, 1, host, codes[1]), "green");
      if (!r) return "no fence matched";
      return r.text.indexOf("<mark") > r.text.indexOf("between") ? true : "marked the first block: " + JSON.stringify(r.text);
    } finally {
      host.remove();
    }
  });

  check("copy: Ctrl+C in a highlighted block puts only the code on the clipboard", () => {
    const host = renderCode(MARKED_NOTE);
    const selection = window.getSelection();
    try {
      const code = host.querySelector("pre code");
      addBadge(code.querySelector("mark"), "5");
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new DataTransfer();
      const event = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
      host.dispatchEvent(event);
      if (!event.defaultPrevented) return "the copy was left to the browser";
      const got = data.getData("text/plain");
      return got === CODE_TEXT ? true : "copied " + JSON.stringify(got);
    } finally {
      selection.removeAllRanges();
      host.remove();
    }
  });

  check("card from a code selection keeps the highlight, clipped to the selection", () => {
    const host = renderCode(MARKED_NOTE);
    try {
      const code = host.querySelector("pre code");
      addBadge(code.querySelector("mark"), "4");
      const text = api.codeCleanText(code);
      const range = document.createRange();
      range.setStart(...codePoint(code, text.indexOf("def")));
      range.setEnd(...codePoint(code, text.indexOf("(r)")));
      const out = api.notesSelectionCodeFence(range, { view: host });
      const want = F + 'python\\ndef <mark data-color="green">area</mark>\\n' + F;
      return out === want ? true : JSON.stringify(out);
    } finally {
      host.remove();
    }
  });

  check("highlight entries: a code mark carries its fenced lines and its exact code", () => {
    const saved = api.state.notes;
    api.state.notes = MARKED_NOTE;
    try {
      const entry = api.noteHighlightEntries()[0];
      if (!entry) return "no entry";
      if (entry.codeText !== "area(r)") return "codeText " + JSON.stringify(entry.codeText);
      const want = F + 'python\\ndef <mark data-color="green">area(r)</mark>:\\n' + F;
      if (entry.codeMarkdown !== want) return "codeMarkdown " + JSON.stringify(entry.codeMarkdown);
      const row = api.collectHighlightEntries().find((e) => e.markIndex === 0);
      if (!row || row.markdown !== want) return "pane row: " + JSON.stringify(row && row.markdown);
      return true;
    } finally {
      api.state.notes = saved;
    }
  });

  await checkAsync("paste/Turndown: a highlighted code block keeps its marks, not its badge", async () => {
    if (typeof TurndownService === "undefined") {
      (0, eval)(await (await fetch("/recall-clipper/vendor/turndown.js")).text());
    }
    const host = renderCode(MARKED_NOTE);
    try {
      addBadge(host.querySelector("pre code mark"), "3");
      const md = api.buildTurndownService({ preserveInlineStyles: true }).turndown(host.querySelector("pre").outerHTML);
      if (!md.includes(F + "python")) return "no fence: " + JSON.stringify(md);
      if (!md.includes('def <mark data-color="green">area(r)</mark>:')) return JSON.stringify(md);
      if (/area\\(r\\)3/.test(md)) return "the badge digit leaked: " + JSON.stringify(md);
      return true;
    } finally {
      host.remove();
    }
  });

  await checkAsync("render: marks survive the autoloader's second pass", async () => {
    const note = [F + "rust", 'fn main() { let <mark data-color="blue">total</mark> = 1; }', F].join("\\n");
    const host = renderCode(note);
    try {
      const code = host.querySelector("pre code");
      const deadline = Date.now() + 8000;
      while (!code.querySelector(".token") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      if (!code.querySelector(".token")) return "rust was never highlighted";
      const marks = code.querySelectorAll("mark");
      if (marks.length !== 1 || marks[0].textContent !== "total") return "after the autoloader: " + code.innerHTML;
      return true;
    } finally {
      host.remove();
    }
  });

  return results;
}`;

const API_SRC = `async () => {
  const mods = await Promise.all([
    import("/src/format/highlight.js?v=__BUILD__"),
    import("/src/core/state.js?v=__BUILD__"),
    import("/src/core/dom.js?v=__BUILD__"),
    import("/src/notes/highlight-badges.js?v=__BUILD__"),
    import("/src/format/locate-selection.js?v=__BUILD__"),
    import("/src/notes/selection.js?v=__BUILD__"),
    import("/src/editor/text-transforms.js?v=__BUILD__"),
    import("/src/panels/highlights-panel.js?v=__BUILD__"),
    import("/src/panels/highlights-editor.js?v=__BUILD__"),
    import("/src/format/highlight-edit.js?v=__BUILD__"),
    import("/src/format/highlight-notes.js?v=__BUILD__"),
    // For HIGHLIGHT_NOTES_OPEN / _CLOSE, so the block's markers are asserted
    // from their definition rather than retyped as literals here. The literal
    // this replaced ("## Highlight Notes") was the pre-fence form and had been
    // wrong since the storage changed.
    import("/src/format/notes-fence.js?v=__BUILD__"),
    import("/src/notes/chapters.js?v=__BUILD__"),
    import("/src/render/preprocess.js?v=__BUILD__"),
    import("/src/render/block-cache.js?v=__BUILD__"),
    import("/src/format/render-toolbar.js?v=__BUILD__"),
    // eraseNotesSelection, for the "everything that changes the set says so"
    // case — it is the other verb that can take a <mark> out of a note.
    import("/src/format/cloze.js?v=__BUILD__"),
    // ...and setDocumentHighlightNote, the other half of the pair whose
    // { rerender, notify } contract the two verbs now share.
    import("/src/documents/pdf-highlights.js?v=__BUILD__"),
    // Highlights inside a code block: the render, the write, and everything a
    // highlighted block has to survive on its way into a card.
    import("/src/render/code-marks.js?v=__BUILD__"),
    import("/src/format/code-highlight.js?v=__BUILD__"),
    import("/src/render/enhance.js?v=__BUILD__"),
    import("/src/panels/highlight-index.js?v=__BUILD__"),
    import("/src/import/html-to-markdown.js?v=__BUILD__"),
    // buildHighlightsExportMarkdown, for what an exported note is labelled.
    import("/src/export/pdf.js?v=__BUILD__")
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

  const browser = await launch({
    headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  let results;
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    // Injected BEFORE navigation, and the CDN cut off. These cases call
    // splitPreparedBlocks, which needs `marked`: without it the split returns
    // null, every note looks like zero blocks, and the chapter assertions fail
    // for a reason that has nothing to do with the code under test. This file
    // used to rely on the CDN answering, so it passed or failed on the network.
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    for (const lib of [
      "recall-clipper/vendor/marked.min.js", "recall-clipper/vendor/purify.min.js",
      "recall-clipper/vendor/katex/katex.min.js", "recall-clipper/vendor/katex/auto-render.min.js"
    ]) {
      const full = path.join(ROOT, lib);
      if (existsSync(full)) await page.evaluateOnNewDocument(readFileSync(full, "utf8"));
    }
    await page.goto(`${server.base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
    // No .catch() here. A page that never boots is the loudest failure this
    // check can find, and swallowing the rejection turned it into the quietest:
    // the next line asks whether marked and DOMPurify are present, a dead page
    // has neither, and the answer was "skipped" rather than "the app did not
    // start".
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
      throw new Error("marked/DOMPurify never loaded — the chapter cases would fail for the wrong reason");
    }
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
