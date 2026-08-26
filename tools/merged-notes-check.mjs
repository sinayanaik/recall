// N decks' notes as one document, and back again — without losing anything on
// the way.
//
//   node tools/merged-notes-check.mjs
//
// Two features build this document: "read this folder as one deck" and a bulk
// Load of several decks from My Decks. Both cut it back into the decks it came
// from every time the reader pauses typing, so the round trip is not a nicety —
// it is the write path, firing every 400ms, over every deck in the selection.
// Anything the split cannot put back is deleted from a real deck on the next
// autosave, and the reader has no way of knowing.
//
// The half that is hardest to see, and the reason this check exists rather than
// a couple of assertions inside the folder one: a deck's notes may END with the
// fenced highlight-notes block, the block is DEFINED to be last, and
// highlightNotesBlockSpan finds it by taking the last opening marker. Join five
// annotated decks and four of those blocks stop being findable — their entries
// become ordinary prose in the middle of the document, printed under the deck
// they belong to, scanned by the Highlights pane as body text, and handed to
// the raw editor. So the tails come off, the entries are unioned into one block
// at the end, and each entry is placed back on its own deck. Property 4 below is
// that bug, written down.
//
// Pure Node, like tools/document-sync-check.mjs: the format is string work by
// design (src/format/merged-notes.js imports two leaf modules and nothing else)
// precisely so this can drive the real code with no browser and no baseline tag.
// A check that can only skip verifies nothing.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-merged-"));

function destamp(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) destamp(full);
    else if (entry.endsWith(".js")) {
      const text = readFileSync(full, "utf8");
      const clean = text.replaceAll("?v=__BUILD__", "");
      if (clean !== text) writeFileSync(full, clean);
    }
  }
}

const results = [];
let failures = 0;
function must(name, fn) {
  let detail;
  try {
    detail = fn();
  } catch (error) {
    detail = `threw: ${error?.message || error}`;
  }
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

const show = (text) => JSON.stringify(String(text).slice(0, 160));

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));

  const load = (rel) => import(path.join(stage, rel));
  const fence = await load("src/format/notes-fence.js");
  const merge = await load("src/format/highlight-notes-merge.js");
  const merged = await load("src/format/merged-notes.js");

  // No DOM stubs, deliberately. If this file ever needs one, an import has crept
  // into merged-notes.js that does not belong in a leaf — see its header.

  // ── The decks ─────────────────────────────────────────────────────────────
  //
  // One fixture per shape a real note comes in. `documentNoteIds` stands for a
  // PDF deck's meta.pdfHighlights: ids that own an entry but appear in no body.
  const FIXTURES = {
    prose: {
      localId: "local-prose",
      title: "Ancient Rome",
      notes: "# Republic\n\nThe consuls served for one year.\n\n## Punic Wars\n\nThree of them."
    },
    annotated: {
      localId: "local-annotated",
      title: "Transformers",
      notes: [
        "Attention is <mark class=\"hl\" data-note=\"hn-a1b2\">all you need</mark>, they said.",
        "",
        "And <mark class=\"hl\" data-note=\"hn-c3d4\">softmax</mark> normalises it.",
        "",
        "---",
        "",
        "<!--recall:highlight-notes-->",
        "",
        "<!--hn:hn-a1b2 “all you need”-->",
        "",
        "The title is a joke about the Beatles.",
        "",
        "<!--hn:hn-c3d4 “softmax”-->",
        "",
        "Over the key dimension.",
        "<!--/recall:highlight-notes-->"
      ].join("\n")
    },
    paper: {
      // The one deck shape whose body is empty because the PDF IS the document.
      localId: "local-paper",
      title: "Attention Is All You Need",
      documentNoteIds: ["hn-9f8e"],
      notes: [
        "<!--recall:highlight-notes-->",
        "",
        "<!--hn:hn-9f8e “multi-head attention”-->",
        "",
        "Eight heads, 64 dimensions each.",
        "<!--/recall:highlight-notes-->"
      ].join("\n")
    },
    legacy: {
      // The heading form the fence replaced. Still read, and migrated on write.
      localId: "local-legacy",
      title: "Old Notes",
      notes: [
        "A note from before the fence, with <mark class=\"hl\" data-note=\"hn-7a7a\">a highlight</mark>.",
        "",
        "---",
        "",
        "## Highlight Notes",
        "",
        "### [hn-7a7a] “a highlight”",
        "",
        "Written in the old form."
      ].join("\n")
    },
    empty: { localId: "local-empty", title: "Nothing Yet", notes: "" },
    codeFence: {
      localId: "local-code",
      title: "Recall Internals",
      notes: [
        "How a section is introduced:",
        "",
        "```markdown",
        "<!-- recall-section:local-elsewhere -->",
        "# Some Other Deck",
        "```",
        "",
        "…which is code, not a marker."
      ].join("\n")
    },
    proseHeading: {
      // The reader's OWN "## Highlight Notes" heading, with no entries under it.
      localId: "local-prose-heading",
      title: "Study Method",
      notes: "## Highlight Notes\n\nI write these in the margin of the paper, not here."
    },
    collidingA: {
      localId: "local-collide-a",
      title: "Deck A",
      notes: [
        "Alpha <mark class=\"hl\" data-note=\"hn-zzzz\">one</mark>.",
        "",
        "---",
        "",
        "<!--recall:highlight-notes-->",
        "",
        "<!--hn:hn-zzzz “one”-->",
        "",
        "A's note.",
        "<!--/recall:highlight-notes-->"
      ].join("\n")
    },
    collidingB: {
      localId: "local-collide-b",
      title: "Deck B",
      notes: [
        "Beta <mark class=\"hl\" data-note=\"hn-zzzz\">two</mark>.",
        "",
        "---",
        "",
        "<!--recall:highlight-notes-->",
        "",
        "<!--hn:hn-zzzz “two”-->",
        "",
        "B's note.",
        "<!--/recall:highlight-notes-->"
      ].join("\n")
    },
    preamble: {
      localId: "local-preamble",
      title: "With An Aside",
      notes: [
        "Body with <mark class=\"hl\" data-note=\"hn-4444\">a mark</mark>.",
        "",
        "---",
        "",
        "<!--recall:highlight-notes-->",
        "These are my notes on the highlights above.",
        "",
        "<!--hn:hn-4444 “a mark”-->",
        "",
        "The entry itself.",
        "<!--/recall:highlight-notes-->"
      ].join("\n")
    },
    untitled: { localId: "local-untitled", title: "", notes: "A deck whose title never got set." }
  };

  const NAMES = Object.keys(FIXTURES);
  const clone = (name) => JSON.parse(JSON.stringify(FIXTURES[name]));
  const membersOf = (names) => names.map(clone);

  // What the app does on a save, without the app: split the document, put each
  // member's tail back on its section, and hand back what each deck would be
  // written with. Mirrors planFolderDeckWrite (src/library/folder-deck.js),
  // which cannot be imported here — it reaches state, the deck store and the
  // toast layer, which is the whole reason the format lives in a leaf.
  function writeBack(document, built, members) {
    const { sections, tail } = merged.splitMergedNotes(document);
    const folder = {
      members,
      noteOwner: built.noteOwner,
      originalNoteId: built.originalNoteId,
      preambleById: built.preambleById
    };
    const shareById = merged.splitMemberNoteTails(tail, sections, folder);
    const out = new Map();
    sections.forEach((section) => {
      out.set(section.localId, {
        title: section.title,
        notes: merged.memberNotesFromMerged(merged.mergedSectionBody(section), shareById.get(section.localId))
      });
    });
    return out;
  }

  // What the deck would hold after the merge has normalized it. The legacy
  // heading form is converted on the way in — the same migration opening the
  // raw editor performs — so the round trip is measured against the fenced
  // spelling of the same note, not against the input string.
  //
  // Trailing whitespace is not part of the comparison, and is not a content
  // change anywhere in the app either: normalizeSyncText trims before
  // deckContentMatches asks whether a save has anything in it. A note the app
  // itself wrote ends with the newline joinHighlightNotesTail leaves; one typed
  // into a fixture here does not, and that is not a fact worth asserting.
  const normalized = (notes) => merge.fenceLegacySection(String(notes || "")).replace(/\s+$/, "");
  const settled = (notes) => String(notes || "").replace(/\s+$/, "");

  const entryTexts = (source) => merge.parseHighlightNoteEntries(source).map((entry) => entry.text);

  // ── 1. The round trip ─────────────────────────────────────────────────────

  function roundTripProblem(names) {
    const members = membersOf(names);
    const built = merged.buildMergedNotes(members);
    const back = writeBack(built.notes, built, members);
    for (const member of members) {
      const got = back.get(member.localId);
      if (!got) return `${member.localId}: no section came back`;
      if (settled(got.notes) !== normalized(member.notes)) {
        return `${member.localId}: notes came back as ${show(got.notes)}, expected ${show(normalized(member.notes))}`;
      }
      if (got.title !== String(member.title || "Untitled deck")) {
        return `${member.localId}: title came back as ${show(got.title)}`;
      }
    }
    return true;
  }

  NAMES.forEach((name) => {
    must(`round trip: ${name} alone`, () => roundTripProblem([name]));
  });

  // Every ordered pair, so a shape is tested both before and after every other.
  must("round trip: every pair of decks", () => {
    for (const a of NAMES) {
      for (const b of NAMES) {
        if (a === b) continue;
        const problem = roundTripProblem([a, b]);
        if (problem !== true) return `[${a}, ${b}] ${problem}`;
      }
    }
    return true;
  });

  must("round trip: all ten at once", () => roundTripProblem(NAMES));

  // The shape a bulk Load of papers produces: two decks with no body between
  // them, so every section is a title and the whole document is the block.
  must("round trip: papers and empty decks together", () =>
    roundTripProblem(["paper", "empty", "prose"]));

  // ── 2. Nothing is lost, and nothing is invented ──────────────────────────

  must("the union carries every entry", () => {
    const members = membersOf(NAMES);
    const built = merged.buildMergedNotes(members);
    const expected = members.flatMap((member) => entryTexts(normalized(member.notes)));
    const got = entryTexts(built.notes);
    if (got.length !== expected.length) return `${expected.length} entries in, ${got.length} out`;
    const missing = expected.filter((text) => !got.includes(text));
    return missing.length ? `lost ${show(missing[0])}` : true;
  });

  must("...under ids that are unique across the merge", () => {
    const built = merged.buildMergedNotes(membersOf(NAMES));
    const ids = merge.parseHighlightNoteEntries(built.notes).map((entry) => entry.id);
    return new Set(ids).size === ids.length || `${ids.length} entries, ${new Set(ids).size} distinct ids`;
  });

  // ── 3. One block, at the end ─────────────────────────────────────────────

  must("the merged document holds exactly one highlight-notes block", () => {
    const built = merged.buildMergedNotes(membersOf(NAMES));
    const opens = built.notes.split(fence.HIGHLIGHT_NOTES_OPEN).length - 1;
    return opens === 1 || `${opens} opening markers`;
  });

  must("...and it is the last thing in the document", () => {
    const built = merged.buildMergedNotes(membersOf(NAMES));
    const span = fence.highlightNotesBlockSpan(built.notes);
    if (!span) return "no block found at all";
    return built.notes.slice(span.after).trim() === "" || `${show(built.notes.slice(span.after))} follows the block`;
  });

  // ── 4. The bug this was written for ──────────────────────────────────────
  //
  // Every surface that shows a note to a reader — the rendered view, the raw
  // editor, the Highlights pane — reads readerNotesBody(). Before the union,
  // joining N annotated decks left N-1 blocks inside the body, so their notes
  // printed as prose under the deck they belonged to.
  must("no deck's highlight notes leak into the readable body", () => {
    const members = membersOf(NAMES);
    const built = merged.buildMergedNotes(members);
    const body = fence.readerNotesBody(built.notes);
    for (const member of members) {
      for (const text of entryTexts(normalized(member.notes))) {
        if (body.includes(text)) return `${member.localId}: ${show(text)} is in the reading view`;
      }
    }
    return body.includes(fence.HIGHLIGHT_NOTES_OPEN)
      ? "an opening marker survives in the body"
      : true;
  });

  // ── 5. Convergence ───────────────────────────────────────────────────────
  //
  // The write-back rebuilds each deck's block rather than preserving the bytes
  // it arrived as, and deckContentMatches (src/library/local-library.js) diffs
  // the whole notes string to decide whether a save advances updatedAt. A
  // rebuild that is not byte-identical would therefore mark every member deck
  // edited on every open — and push all of them on the next sync.
  // Every shape except the two that collide: a collision is settled by minting a
  // fresh id, which is random by construction and therefore not the same id
  // twice. What must hold for THOSE decks is the assertion below — that each one
  // is handed back exactly what it had — and it does.
  must("opening a merged document twice gives the same document", () => {
    const members = membersOf(NAMES.filter((name) => !name.startsWith("colliding")));
    const first = merged.buildMergedNotes(members);
    const back = writeBack(first.notes, first, members);
    const reopened = members.map((member) => ({ ...member, ...back.get(member.localId) }));
    const second = merged.buildMergedNotes(reopened);
    return second.notes === first.notes
      || `second open differs: ${show(second.notes.slice(0, 400))}`;
  });

  must("...and a deck that was not touched is byte-identical to what it held", () => {
    const members = membersOf(["annotated", "paper", "prose"]);
    const built = merged.buildMergedNotes(members);
    const back = writeBack(built.notes, built, members);
    // annotated and paper are already in the fenced form, so normalization is
    // the identity on them: this is the real "no spurious edit" assertion.
    for (const name of ["local-annotated", "local-paper", "local-prose"]) {
      const member = members.find((m) => m.localId === name);
      if (settled(back.get(name).notes) !== settled(member.notes)) return `${name} came back changed`;
    }
    return true;
  });

  // ── 6. Refusing a broken document ────────────────────────────────────────

  must("an intact document is not refused", () => {
    const members = membersOf(["prose", "annotated"]);
    const built = merged.buildMergedNotes(members);
    const problem = merged.mergedSplitProblem(built.notes, members);
    return problem === "" || `refused an intact document: ${problem}`;
  });

  must("a deleted section marker is refused", () => {
    const members = membersOf(["prose", "annotated"]);
    const built = merged.buildMergedNotes(members);
    const broken = built.notes.replace(merged.mergedSectionMarker("local-prose") + "\n", "");
    return merged.mergedSplitProblem(broken, members) !== "" || "a missing marker was accepted";
  });

  must("a duplicated section marker is refused", () => {
    const members = membersOf(["prose", "annotated"]);
    const built = merged.buildMergedNotes(members);
    const broken = built.notes.replace(
      merged.mergedSectionMarker("local-prose"),
      `${merged.mergedSectionMarker("local-prose")}\n# Copy\n\n${merged.mergedSectionMarker("local-prose")}`
    );
    return merged.mergedSplitProblem(broken, members) !== "" || "a duplicated marker was accepted";
  });

  must("a marker naming a deck that is not in the merge is refused", () => {
    const members = membersOf(["prose", "annotated"]);
    const built = merged.buildMergedNotes(members);
    const broken = built.notes.replace("recall-section:local-prose", "recall-section:local-somewhere-else");
    return merged.mergedSplitProblem(broken, members) !== "" || "an unknown marker was accepted";
  });

  // ── 7. Placement ─────────────────────────────────────────────────────────

  must("an entry follows its highlight when the reader moves it", () => {
    const members = membersOf(["annotated", "prose"]);
    const built = merged.buildMergedNotes(members);
    // The reader cuts the marked sentence out of Transformers and pastes it into
    // Ancient Rome. The note must go with it.
    const moved = built.notes
      .replace("Attention is <mark class=\"hl\" data-note=\"hn-a1b2\">all you need</mark>, they said.\n\n", "")
      .replace("The consuls served for one year.", "The consuls served for one year. <mark class=\"hl\" data-note=\"hn-a1b2\">all you need</mark>");
    const back = writeBack(moved, built, members);
    return back.get("local-prose").notes.includes("The title is a joke")
      || `the note stayed behind: ${show(back.get("local-annotated").notes)}`;
  });

  must("a paper's entry goes home even though it is in no body", () => {
    const members = membersOf(["paper", "prose"]);
    const built = merged.buildMergedNotes(members);
    const back = writeBack(built.notes, built, members);
    return back.get("local-paper").notes.includes("Eight heads")
      || `the paper's note went elsewhere: ${show(back.get("local-prose").notes)}`;
  });

  must("an entry with no home at all is kept, not dropped", () => {
    const members = membersOf(["prose", "annotated"]);
    const built = merged.buildMergedNotes(members);
    // A note minted inside the merged view whose <mark> was then deleted: no
    // section holds its id, and it was never in a member deck either.
    const orphaned = built.notes.replace(
      fence.HIGHLIGHT_NOTES_OPEN + "\n",
      fence.HIGHLIGHT_NOTES_OPEN + "\n\n<!--hn:hn-0001 “gone”-->\n\nWritten while reading, mark since deleted.\n"
    );
    const back = writeBack(orphaned, built, members);
    const kept = [...back.values()].some((deck) => deck.notes.includes("mark since deleted"));
    return kept || "an orphaned entry was dropped on the floor";
  });

  must("every entry that goes in comes out somewhere", () => {
    const members = membersOf(NAMES);
    const built = merged.buildMergedNotes(members);
    const back = writeBack(built.notes, built, members);
    const inCount = merge.parseHighlightNoteEntries(built.notes).length;
    const outCount = [...back.values()]
      .reduce((total, deck) => total + merge.parseHighlightNoteEntries(deck.notes).length, 0);
    return inCount === outCount || `${inCount} entries in the document, ${outCount} across the decks`;
  });

  // ── 8. Two decks that minted the same id ─────────────────────────────────

  must("colliding ids come apart in the merged document", () => {
    const built = merged.buildMergedNotes(membersOf(["collidingA", "collidingB"]));
    const ids = merge.parseHighlightNoteEntries(built.notes).map((entry) => entry.id);
    if (ids.length !== 2) return `${ids.length} entries, expected 2`;
    if (ids[0] === ids[1]) return "both entries still carry the same id";
    const marks = [...built.notes.matchAll(/data-note="(hn-[a-z0-9]+)"/g)].map((m) => m[1]);
    return new Set(marks).size === 2 || `the marks were not reminted with them: ${marks.join(", ")}`;
  });

  must("...and each deck gets its own id back", () => {
    const members = membersOf(["collidingA", "collidingB"]);
    const built = merged.buildMergedNotes(members);
    const back = writeBack(built.notes, built, members);
    for (const member of members) {
      const got = settled(back.get(member.localId).notes);
      if (got !== settled(member.notes)) return `${member.localId} came back as ${show(got)}`;
    }
    return true;
  });

  must("a reminted paper id is still protected from the orphan sweep", () => {
    // The paper's entry id is what meta.pdfHighlights holds; if the merge has to
    // remint it, the id the prune guard protects must be the NEW one, or the
    // sweep takes the paper's annotations.
    const members = [clone("paper"), { ...clone("paper"), localId: "local-paper-2", title: "The Same Paper, Filed Twice" }];
    const built = merged.buildMergedNotes(members);
    const ids = merge.parseHighlightNoteEntries(built.notes).map((entry) => entry.id);
    const missing = ids.filter((id) => !built.protectedNoteIds.includes(id));
    return missing.length === 0 || `${missing.join(", ")} is in the document but not protected`;
  });

  // ── 9. What the move must not have changed ───────────────────────────────

  must("a section marker inside a code fence is not a marker", () => {
    const members = membersOf(["codeFence", "prose"]);
    const built = merged.buildMergedNotes(members);
    const { sections } = merged.splitMergedNotes(built.notes);
    return sections.length === 2 || `${sections.length} sections — the fenced marker was read as one`;
  });

  must("the reader's own '## Highlight Notes' heading stays in their note", () => {
    const members = membersOf(["proseHeading"]);
    const built = merged.buildMergedNotes(members);
    return fence.readerNotesBody(built.notes).includes("## Highlight Notes")
      || "a heading with no entries under it was eaten as a legacy block";
  });

  must("a preamble stays with the deck that wrote it", () => {
    const members = membersOf(["preamble", "annotated"]);
    const built = merged.buildMergedNotes(members);
    if (built.notes.includes("These are my notes on the highlights above.")) {
      return "the preamble was carried into the merged block, where it reads as another deck's aside";
    }
    const back = writeBack(built.notes, built, members);
    return back.get("local-preamble").notes.includes("These are my notes on the highlights above.")
      || "the preamble was lost";
  });

  must("a card made in the merged view is owned by the section it came from", () => {
    const members = membersOf(["prose", "annotated"]);
    const built = merged.buildMergedNotes(members);
    const { sections } = merged.splitMergedNotes(built.notes);
    const owner = merged.ownerForNewCard({ question: "The consuls served for one year." }, sections);
    return owner === "local-prose" || `ownerForNewCard answered ${owner}`;
  });

  must("an untitled deck still gets a heading to be found by", () => {
    const built = merged.buildMergedNotes(membersOf(["untitled"]));
    return /^# .+$/m.test(built.notes)
      || "a deck with no title produced a bare '#', which the folder table of contents cannot match";
  });

  console.log("── merged notes ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
