// Everything, in one command. Run this before every commit.
//
//   node tools/check.mjs
//   node tools/check.mjs --quick     # skip the browser (static checks only)
//   node tools/check.mjs --full      # ...and drive a real install/update/offline cycle
//
// This exists because running the checks individually meant one of them could
// be skipped, and one of them was: a `git checkout` during an unrelated
// experiment reverted an import fix, split-parity still passed (it compares
// declaration bodies, and the bodies were fine), and the commit shipped a
// module importing a name that had moved. The page died at instantiation with
// "does not provide an export named 'resetCardUndoHistory'". Every check needed
// to catch it existed; nothing made running all of them the default.
//
// Each check answers a different question, and none of them subsumes another:
//
//   split-parity    is the code still the same code?
//   scanner-audit   does the scanner module-symbols relies on actually SEE
//                   every reference? (it once did not, and hid 13 of them)
//   module-symbols  does every cross-module reference resolve?
//   css-parity      do the stylesheet slices still reassemble to the original?
//   port-sync       do the extension's copies still match?
//   readme-sql      ...and does the SQL the README tells you to PASTE still
//                   match the file? The README embeds the whole of
//                   supabase_setup.sql and asserts in prose that the two are
//                   identical, which is not self-enforcing — they drifted, and
//                   the documented setup path handed out the old schema
//   vendor          are the vendored libraries on disk, unmodified, and
//                   precached? (a hole here is a blank page offline, not a
//                   missing feature — they are blocking tags before main.js)
//   incremental     when an edit re-splits the note by PATCHING the previous
//                   block array instead of re-lexing it, does that give the
//                   same blocks a full re-lex would? Pure Node, no browser — it
//                   loads the vendored marked and lifts the splitters out of
//                   block-cache.js as text. Also asserts the boundary property
//                   the chunked lexer rests on, which until now was argued for
//                   by citing a scratch file that is not in the tree
//   viewport        ...and when a note is not lexed at all until the reader
//                   comes near each part of it, do those parts add up to the
//                   same note? Same corpus as `incremental` (tools/note-shapes.mjs),
//                   six properties: spans tile and lex to the whole-document
//                   blocks; a boundary scan resumed at a safe cut reproduces the
//                   full scan's tail; the prelude derived from candidate spans
//                   alone equals the real one; the heading index agrees with
//                   marked's own headings; an edit taken locally leaves cuts
//                   that are still real; and it takes ordinary edits often
//                   enough to be worth having. Project memory warns that an
//                   earlier attempt in this area was reverted over corruption
//                   found by a fuzzer, with nothing left in git to read — this
//                   is the standing answer to that warning
//   document-sync   do a paper's highlights and the notes written on them
//                   actually reach the other device — and stop claiming a
//                   conflict every time? Two simulated devices and one in-memory
//                   cloud row driven through the real merge, in the order the
//                   reconcile calls it. Pure Node: the merge is string-and-object
//                   work by design, so this needs neither a browser nor the
//                   pre-modular tag the sync checks below rest on
//   image-controls  does every image the renderer renders get a resize grip and
//                   a delete button — including the ones in a table cell, a
//                   link, or an HTML block that had none for as long as they
//                   were bound by token index — and does using one rewrite that
//                   image's own slice and nothing else in the note? marked is
//                   the oracle for "what is an image"
//   precache        does sw.js precache every module the app imports, and
//                   nothing that no longer exists? (a missing entry breaks the
//                   app OFFLINE only; a stale one stops any worker activating)
//   boot-check      does it actually run?
//   behaviour       does it still produce the same answers?
//   render-scale    does a BIG note still render? (2,000+ blocks takes a
//                   different branch that nothing else here ever reaches — a
//                   total failure of large notes once passed every other check)
//   mobile-menu     does the ☰ drawer still open on a PHONE with a book on
//                   screen? The only check that throttles the CPU and uses a
//                   fixture with figures in it, and it times the shared
//                   overlay/chrome plumbing directly — all three are why the
//                   drawer freeze survived five rounds of profiling
//   notes-menu      can you tell what the notes ⋯ menu's controls DO, and which
//                   way the modes in it are set, without pressing one to find
//                   out? Every row read the way a reader reads it — the label
//                   the CSS actually shows, the switch's own word, the two
//                   bookmark drawings compared — at desktop width and at 390px,
//                   plus whether a note printed into a paragraph is drawn any
//                   differently from the paragraph. Speaks CDP directly, so it
//                   runs wherever there is a Chrome rather than skipping
//   style           does a Style panel setting reach the element it names?
//   highlight       does highlighting mark the thing that was SELECTED?
//   note-editor     can you format a highlight's note with the keyboard — and
//                   does Ctrl+E flip the popup rather than the view behind it?
//                   Nothing drove .highlight-note-editor at all before it, which
//                   is how a key bound to "toggle raw/rendered" came to flip a
//                   surface the reader was not looking at while they typed into
//                   one floating over it
//   paged           can you reach the end of a note in paged reading mode?
//   ribbon          does the caret band sit where the caret is, and stay still
//                   when it should?
//   pdf-document    does a PDF deck work — imported, rendered, selected,
//                   highlighted, saved and read back? The only check that
//                   drives the Document surface, and the only one that can
//                   catch an anchor that works in the session that made it and
//                   nowhere else. It also reports a page that renders ZERO text
//                   items, which is the signal for a scanned PDF with no text
//                   layer: readable, but with no selection and no make-card
//                   (these three assert OUTCOMES rather than parity — a fix
//                   changes the answer, so parity cannot see it by design)
//   epub-import     ...and does importing an EPUB still work? The modal, the
//                   figure uploads and the decks, driven end to end through the
//                   app's own importEpubFile against a book built by hand
//                   (tools/epub-fixture.mjs). It exists because none of that
//                   ran at all: a figure-quality control added to the preview
//                   read an `imageEntries` the modal was never given, so every
//                   book with a picture in it died on a ReferenceError before
//                   the modal reached the screen. Nothing here noticed —
//                   module-symbols only asks about names another MODULE owns,
//                   and that one is a parameter three functions in the same
//                   file legitimately use. The fixture is shaped around the
//                   branches nothing else reaches: a front page the contents
//                   does not name, two chapters sharing one file and split at
//                   an anchor, and figures whose archive names and hrefs are
//                   spelled differently in both directions
//   sync            do the merge PRIMITIVES behave identically, and still
//                   refuse to lose data? (parity plus invariants — passing one
//                   is not passing the other)
//   reconcile       does the whole two-way sync behave identically end to end,
//                   driven against a stand-in backend?
//   ui-smoke        does the APP still work? 18 real actions — import, flip,
//                   mark known, All Cards, notes, export, sync — driven through
//                   the DOM on both builds and compared step by step
//   selection       can you still select text in a note without dragging the
//                   app's own chrome in with it? Real mouse drags, because
//                   selection is a browser behaviour, not a function
//   mobile-select   the same question with a FINGER: does the app still let go
//                   of the gesture a long press needs? touch-action on the
//                   reading surfaces, the card swipe standing down for a dwell,
//                   containment suspended under a live selection, the page snap
//                   held off, and the bar waiting for the drag to finish. The
//                   native handles themselves are browser UI and absent in
//                   headless Chrome — that half is a real-device check
//   touch-select    ...and the same question again, now that the APP owns the
//                   gesture rather than deferring to it. A press timed from
//                   inside the page, the handles it draws asserted against the
//                   boundaries they mark, a press in a block's gutter, drags
//                   both ways past the anchor, edge auto-scroll, and the
//                   highlight compared PIXEL BY PIXEL against the unselected
//                   page. None of that was drivable while the handles belonged
//                   to the browser, which is the second-best argument for the
//                   takeover after the behaviour itself. Ends by proving a
//                   desktop never arms any of it
//   large-select    ...and the same gesture once the note is big enough to be
//                   CHUNKED, which touch-select deliberately is not: a press
//                   taken while the note is still settling, a drag across a
//                   chunk boundary, and how many pixels the note travels after
//                   a highlight — the reported "violent shaking", as a number
//   offline         does it START with no network, a blocked CDN, or a CDN
//                   that hangs? (the one question nothing used to ask — every
//                   other check here runs with a working connection, and the
//                   app shipped unable to launch offline because of it)
//   release-check   (--full) does a release reach an existing install, and
//                   does it work offline?

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUICK = process.argv.includes("--quick");
// The release path drives two real service-worker installs and takes ~40s, so
// it is opt-in. Run it before merging — it is the only check that exercises the
// failure this repo has actually shipped: a release that never reaches an
// existing install.
const FULL = process.argv.includes("--full");

const checks = [
  ["split-parity  ", ["node", ["tools/split-parity.mjs"], ROOT]],
  ["scanner-audit ", ["node", ["tools/scanner-audit.mjs"], ROOT]],
  ["module-symbols", ["node", ["tools/module-symbols.mjs"], ROOT]],
  ["css-parity   ", ["node", ["tools/split-css.mjs", "--check"], ROOT]],
  ["port-sync     ", ["node", ["tools/port-sync.mjs"], path.join(ROOT, "recall-clipper")]],
  ["readme-sql    ", ["node", ["tools/readme-sql-check.mjs"], ROOT]],
  ["vendor        ", ["node", ["tools/vendor-sync.mjs", "--check"], ROOT]],
  ["precache      ", ["node", ["tools/precache-check.mjs"], ROOT]],
  // Needs no browser and no network — it loads the vendored marked directly and
  // lifts the splitters out of block-cache.js as text — so it belongs with the
  // static checks rather than behind --quick. That is the point of it running
  // here: a check that skips is a check that never catches anything, and this one
  // guards the change most able to render a WRONG note.
  ["incremental   ", ["node", ["tools/incremental-split-check.mjs"], ROOT]],
  // Beside it, for the same reasons and against the same corpus: the viewport
  // path decides what a note IS, one span at a time, and gets no browser and no
  // network to do it.
  ["viewport      ", ["node", ["tools/viewport-split-check.mjs"], ROOT]],
  // Same shape again: pure string work, marked as the oracle. It asks whether
  // every image the renderer renders is one the resize/delete controls can
  // find, and whether using one rewrites that image's slice and nothing else
  // in the note.
  ["image-controls", ["node", ["tools/image-controls-check.mjs"], ROOT]],
  // And again: a paper's highlights and the notes written on them, merged
  // between two devices. The merge is deliberately pure string-and-object work
  // (src/format/highlight-notes-merge.js, src/sync/document-sync.js) precisely
  // so this can drive it with no browser and no baseline tag — the sync checks
  // below need both, and a check that can only skip verifies nothing.
  ["document-sync ", ["node", ["tools/document-sync-check.mjs"], ROOT]],
  ...(QUICK ? [] : [
    ["boot-check    ", ["node", ["tools/boot-check.mjs", "--baseline", "pre-modular"], ROOT]],
    ["behaviour     ", ["node", ["tools/behaviour-parity.mjs"], ROOT]],
    ["sync          ", ["node", ["tools/sync-parity.mjs"], ROOT]],
    ["reconcile     ", ["node", ["tools/reconcile-parity.mjs"], ROOT]],
    ["ui-smoke      ", ["node", ["tools/ui-smoke.mjs"], ROOT]],
    ["selection     ", ["node", ["tools/selection-check.mjs"], ROOT]],
    ["mobile-select ", ["node", ["tools/mobile-selection-check.mjs"], ROOT]],
    ["touch-select  ", ["node", ["tools/touch-selection-check.mjs"], ROOT]],
    ["large-select  ", ["node", ["tools/large-note-selection-check.mjs"], ROOT]],
    ["render-scale  ", ["node", ["tools/render-scale-check.mjs"], ROOT]],
    ["interaction   ", ["node", ["tools/interaction-scale-check.mjs"], ROOT]],
    ["mobile-menu   ", ["node", ["tools/mobile-menu-check.mjs"], ROOT]],
    ["notes-menu    ", ["node", ["tools/notes-menu-check.mjs"], ROOT]],
    ["style         ", ["node", ["tools/style-check.mjs"], ROOT]],
    ["highlight     ", ["node", ["tools/highlight-check.mjs"], ROOT]],
    ["note-editor   ", ["node", ["tools/note-editor-check.mjs"], ROOT]],
    ["paged         ", ["node", ["tools/paged-check.mjs"], ROOT]],
    ["ribbon        ", ["node", ["tools/ribbon-check.mjs"], ROOT]],
    ["pdf-document  ", ["node", ["tools/pdf-preview-check.mjs"], ROOT]],
    ["epub-import   ", ["node", ["tools/epub-import-check.mjs"], ROOT]],
    ["offline       ", ["node", ["tools/offline-check.mjs"], ROOT]],
    ...(FULL ? [["release-check ", ["node", ["tools/release-check.mjs"], ROOT]]] : [])
  ])
];

// port-sync has two PRE-EXISTING drifts, present since before the restructure
// began and unrelated to it (the clipper's protectInline has not picked up note
// links, and its SANITIZE_CONFIG lags on ADD_ATTR). Failing every run on them
// would train the eye to ignore a red line, so the expected count is pinned
// here: any OTHER drift, or these two being fixed, changes the number and fails.
const PORT_SYNC_EXPECTED_DRIFT = 2;

// Was 2 while the render ran as one synchronous burst — a 2.6MB note blocked
// the main thread for 382ms and showed nothing at all until it finished. The
// render is now streamed in batches with a frame between them (first visible
// text at ~170ms instead of ~880ms), so those cases pass and this is 0. It must
// never go up again.
const RENDER_SCALE_EXPECTED_FAILURES = 0;

let failed = 0;
for (const [label, [cmd, args, cwd]] of checks) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  let ok = r.status === 0;
  let note = "";

  if (label.trim() === "port-sync") {
    const drift = Number(out.match(/(\d+) drifted/)?.[1] ?? -1);
    ok = drift === PORT_SYNC_EXPECTED_DRIFT;
    note = ok ? `(${drift} known pre-existing drift)` : `expected ${PORT_SYNC_EXPECTED_DRIFT} drifted, got ${drift}`;
  } else if (label.trim() === "render-scale") {
    const failedCases = Number(out.match(/·\s*(\d+) failed/)?.[1] ?? -1);
    ok = failedCases === RENDER_SCALE_EXPECTED_FAILURES;
    note = ok
      ? `${out.trim().split("\n").filter(Boolean).pop()}${failedCases ? ` (${failedCases} known)` : ""}`
      : `expected ${RENDER_SCALE_EXPECTED_FAILURES} known failure(s), got ${failedCases}`;
  } else {
    note = out.trim().split("\n").filter(Boolean).pop() || "";
  }

  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}  ${note}`);
  if (!ok) {
    failed++;
    console.log(out.split("\n").map((l) => `        ${l}`).join("\n"));
  }
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
