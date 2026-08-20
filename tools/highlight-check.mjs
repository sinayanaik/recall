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

  return results;
}`;

const API_SRC = `async () => {
  const mods = await Promise.all([
    import("/src/format/highlight.js?v=__BUILD__"),
    import("/src/format/locate-selection.js?v=__BUILD__"),
    import("/src/notes/selection.js?v=__BUILD__"),
    import("/src/editor/text-transforms.js?v=__BUILD__"),
    import("/src/panels/highlights-panel.js?v=__BUILD__"),
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
