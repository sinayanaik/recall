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
import { existsSync, readFileSync } from "node:fs";
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
    if (out.indexOf("## Highlight Notes") === -1) return "no section written: " + JSON.stringify(out);
    if (out.indexOf("### [hn-aaaa] “highlight”") === -1) return "no readable entry heading: " + JSON.stringify(out);
    if (out.indexOf("Remember **this**.") === -1) return "the note text is not in the section";
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
    if (/-{3,}\s*$/.test(src)) return "the separator rule was left behind: " + JSON.stringify(src);
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
  // src/notes/highlight-badges.js. One numbered, pressable badge per annotated
  // highlight — numbered from the SOURCE so a note built lazily, chunk by
  // chunk, cannot renumber itself as the reader scrolls; drawn out of flow so it
  // moves no glyph; and present only where there is a note to read.

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

  // The number a card shows has to be the number its badge shows, and the only
  // way to be sure of that is for both to come out of one function. This is that
  // assertion: the entries the pane renders carry exactly the numbers the badge
  // index hands out, including the skip over a highlight with nothing written on
  // it. Three surfaces print this number — the badge on the mark, the note
  // printed under a page, and the card — and "we computed the same sequence the
  // same way in three files" is the guarantee that does not survive an edit to
  // one of them.
  check("a card's number is the number its badge wears", () => {
    api.state.notes = NOTED;
    const index = api.highlightNoteIndex(NOTED).byAttr;
    const badges = [...index.values()].map((info) => info.n);
    const cards = api.collectHighlightEntries().map((entry) => entry.n).filter(Boolean);
    if (cards.join(",") !== badges.join(",")) {
      return "cards numbered " + JSON.stringify(cards.join(",")) + " against badges " + JSON.stringify(badges.join(","));
    }
    // ...and the two highlights with no note are numbered in neither.
    const unnumbered = api.collectHighlightEntries().filter((entry) => !entry.n).length;
    if (unnumbered !== 2) return unnumbered + " entries carry no number, expected 2";
    return true;
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

  check("a note gives its highlight a numbered badge, a plain highlight none", () => {
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
      // Numbered from the SOURCE, in document order — the property that has to
      // survive a note being built lazily, chunk by chunk.
      if (badges.map((b) => b.textContent).join(",") !== "1,2") return "numbered " + badges.map((b) => b.textContent).join(",");
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
    import("/src/notes/chapters.js?v=__BUILD__"),
    import("/src/render/preprocess.js?v=__BUILD__"),
    import("/src/render/block-cache.js?v=__BUILD__"),
    import("/src/format/render-toolbar.js?v=__BUILD__")
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
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 })
      .catch(() => {});
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
