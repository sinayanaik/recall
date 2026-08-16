// Did the restructure change any code?
//
//   node tools/split-parity.mjs                 # compare against the pre-modular tag
//   node tools/split-parity.mjs --base=<ref>    # ...or any git ref
//   node tools/split-parity.mjs --show <name>   # print both sides of one symbol
//
// The whole premise of the restructure is that it is PURE CODE MOVEMENT: the
// same 1,255 functions and 410 bindings, in different files, with imports added.
// Nothing about that premise is self-evident once 35,000 lines are in flight,
// and "it still seems to work" is not a check — most of this codebase is paths
// that only run during an EPUB import, a sync conflict, or a PDF export.
//
// So: pull every top-level declaration out of the baseline app.js and out of the
// current tree, and compare them by name, modulo whitespace and comments. A
// correct split reports every symbol present exactly once with an identical
// body. Anything else is a lost function, a duplicated one, or an edit that
// sneaked in with the move.
//
// The corollary is a working rule: BUG FIXES GO IN THEIR OWN COMMITS, after the
// move that carried the code. A fix buried inside a 3,000-line file move is
// invisible to review and to this tool. A fix in its own commit is a two-line
// diff that anyone can read.
//
// Intentional changes are recorded in ACCEPTED below, with the reason.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelDecls, normalize } from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
// The baseline is the TAG pre-modular, not a branch. It used to default to
// `main`, which stopped meaning anything the moment the restructure landed
// there — main became the thing under test, and the comparison had nothing
// left to compare against.
const baseRef = (args.find((a) => a.startsWith("--base=")) || "--base=pre-modular").slice(7);
const showIdx = args.indexOf("--show");
const showName = showIdx !== -1 ? args[showIdx + 1] : null;

// Declarations that are ALLOWED to differ, and why. Keep this short — every
// entry is a place where the "pure movement" guarantee was deliberately spent.
const ACCEPTED = {
  requestedAppVersion:
    "reads the ?v= off its own <script src>, which moved from app.js to src/main.js",
  RELEASE_STAMP_RE:
    "matches the <script src> in fetched HTML, which moved from app.js to src/main.js",
  fetchUrl:
    "calls fetchImportText, the URL-import half of the split fetchText — see REMOVED",
  fetchLiveRelease:
    "calls fetchReleaseText, the update-check half of the split fetchText — see REMOVED",
  showUpdateBanner:
    "the Reload button now waits for controllerchange before reloading, instead " +
    "of reloading the instant it has asked the waiting worker to skip waiting. " +
    "Fixes a pre-existing race (measured: 1-2 extra navigations every run) that " +
    "130 module requests make considerably worse. See tools/release-check.mjs.",
  DOCX_HEADING_STYLE_BY_LEVEL:
    "h5 and h6 now map to Heading5/Heading6 instead of both folding into " +
    "Heading4. They only shared a style because size told the levels apart, " +
    "and it no longer does — see buildDocxStylesXml.",
  buildDocxStylesXml:
    "One heading SIZE, in the .docx too. Heading1-4 were 16/14/12/11pt while " +
    "every other surface has rendered h1-h6 at a single size since the " +
    "underline ladder replaced the size ladder (styles/06-rendered.css:5). All " +
    "six are now 11pt, with the hierarchy in weight, colour and a bottom " +
    "border whose weight and dash pattern track the on-screen ladder — Word " +
    "cannot draw a partial-width rule, so width is the one cue that is lost.",
  // ── The raw <-> rendered round trip ──────────────────────────────────────
  // "I want to stay in the same place when I switch." Measured on a 390px phone
  // before these two: coming back from raw mode landed 32 paragraphs early, at
  // every scroll position. Now within one paragraph at every position, on both
  // a phone and a desktop.
  commitNotesEditIfActive:
    "Re-renders with sameNote — it IS the same note, you were editing it, not " +
    "opening another. A bare renderNotesView() re-derives the measured " +
    "block-height estimate and releases the deferred-work queue, re-sizing every " +
    "off-screen block INCLUDING those above the viewport, so the position it " +
    "then restores is computed against a document whose height changed " +
    "underneath it.",
  scrollRenderedNotesToRawOffset:
    "Takes its needle from the start of the caret's LINE rather than from the " +
    "caret itself. A caret resting mid-paragraph gave a needle of ordinary " +
    "prose — '…to give the block a realistic height' — which recurs, so the " +
    "search matched a different copy. A line start is where a markdown " +
    "paragraph, heading or list item begins, so the needle is the distinctive " +
    "part of the text rather than its middle.",

  // ── Chunked notes (styles/19-notes-chunks.css) ───────────────────────────
  // Above NOTES_CHUNK_MIN_BLOCKS the note's blocks are grouped into wrappers
  // that carry the containment, taking the boxes the engine tracks on a 4.1MB
  // note from 24,600 to ~600. Measured: 122ms -> 17ms per scroll frame, browser
  // layout 853ms -> 41ms. Every one of these is a place that assumed a block is
  // a DIRECT CHILD of the container.
  liveBlockNodes:
    "Stops at a chunk as well as at the container. Stopping only at the " +
    "container resolves every block in a chunk to that same chunk, `claimed` " +
    "lets exactly one through, and the other 39 read as gone — so every render " +
    "of a chunked note would rebuild the whole note from source.",
  patchRenderedBlocks:
    "A chunked branch. The cursor walk steps over container.firstChild, which " +
    "is a CHUNK, while the target order is per BLOCK; chunked notes re-home " +
    "their blocks into freshly built wrappers instead. The flat branch is " +
    "unchanged and is also what un-chunks a note that shrank below the " +
    "threshold — the blocks move out one by one and the emptied wrappers are " +
    "what the trailing sweep removes.",
  measureNotesBlockEstimate:
    "Samples the BLOCKS, not container.children — on a chunked note those are " +
    "wrappers of 40, and the estimate would come out 40x too large for exactly " +
    "the notes it matters most on. Also publishes --notes-chunk-estimate.",
  approximateRawOffsetForBlock:
    "Climbs to a chunk's child as well as the root's. Climbing past the block " +
    "to the chunk finds nothing in entry.nodes, so this returned null for every " +
    "block of a chunked note — and without its hint matchSnippetInSource falls " +
    "back to the first match in the document: triple-click paragraph 600, land " +
    "at paragraph 1.",
  markNumberedEquations:
    "Stops at a chunk too, so has-eqn-num-block lands on the block. On the " +
    "chunk it would take the content-visibility exclusion with it and disable " +
    "containment for all 40 of that chunk's blocks.",
  blockAtNotesReadingLine:
    "Same, for the hit-testing twin: probing the horizontal midpoint lands in " +
    "the column gap in two-column mode, where closest('.notes-rendered > *') " +
    "is null — so this returned null on every call. Also matches a chunk's " +
    "child, since on a long note the direct children are wrappers of 40.",
  findRenderedNoteRange:
    "A paged search window, and the block list is now notesTopLevelBlocks(). " +
    "Its window was built from scrollHeight/scrollTop, both meaningless when " +
    "the note runs sideways (scrollTop is 0, scrollHeight === clientHeight), so " +
    "it degenerated to the whole document and indexOf then took the FIRST " +
    "occurrence of the phrase anywhere in the note — the wrong-copy failure the " +
    "window exists to prevent. The binary search was invalid there too: paged " +
    "document order runs along X, so block `bottom` values are not monotonic. " +
    "Pages are, so the paged branch windows by page instead.",
  notesBlockAtReadingLineGeometric:
    "Delegates to firstVisibleNotesBlock when paged (its binary search rests " +
    "on block `bottom` values being monotonic in document order, and paged " +
    "document order runs along X), and reads notesTopLevelBlocks() rather than " +
    "view.children so a chunked note is searched by block, not by wrapper.",
  firstVisibleNotesBlock:
    "Reads notesTopLevelBlocks() rather than view.children.",

  // ── Formatting moved out of the notes header and into the selection pill ──
  // Every button in that strip refuses with "Select some text in the notes
  // first" unless there IS a selection, so a permanent row of them was a row
  // that could do nothing while you read.
  el:
    "notesRenderToolbar removed (the element is gone from index.html, and a " +
    "lookup that can only ever be null is exactly the kind of decoy this " +
    "file's own header warns about); selectionFloatFormat added, the slot in " +
    "the floating pill that the formatting controls moved into.",
  resetNotesEditingUI:
    "No longer un-hides #notesRenderToolbar on leaving raw mode; there is no " +
    "such element.",
  enterNotesEditing:
    "No longer hides #notesRenderToolbar on entering raw mode; there is no " +
    "such element. The raw editor's own toolbar is unaffected.",
  createRenderToolbarHtml:
    "A `highlight` option. The floating selection pill already carries a " +
    "highlight swatch + colour menu driving the same renderFormatDefaults, so " +
    "emitting the split control there too would put two identical controls " +
    "side by side.",
  initRenderToolbars:
    "Fills the pill's format slot instead of #notesRenderToolbar.",
  positionNotesSelectionButton:
    "Stamps data-render-target on the pill. The pill now carries the inline " +
    "formatting controls, which route through the shared " +
    "[data-render-action] delegation — and that reads the target off the " +
    "nearest [data-render-target] ancestor. The pill serves the notes AND both " +
    "card faces, so the target has to follow the selection rather than be " +
    "hard-coded in the markup.",

  // ── Paged reading mode (src/notes/paged-view.js) ─────────────────────────
  // #notesView gains columns and is paged with scrollLeft, so every "reveal
  // something in the notes" helper needs a branch that turns to a page instead
  // of scrolling to a line. There are exactly four of them.
  defaultStyleProfiles:
    "One setting added to both profiles: notesReadingMode (continuous / " +
    "paged-1 / paged-2), defaulting to continuous so nobody's reading view " +
    "changes without them asking.",
  styleControlGroups:
    "The Notes layout control, in Basics. Deliberately absent from " +
    "styleCssVariables — it selects a layout, not a value.",
  applyStyleSettings:
    "Applies notesReadingMode. It drives a class and a repagination rather " +
    "than a custom property, so it cannot ride the styleCssVariables loop.",
  renderNotesView:
    "Re-counts the pages after every repaint. This is the one place every " +
    "repaint of the rendered notes goes through, so it is the only place that " +
    "can see a note grow, shrink or be replaced. No-op on continuous mode.",
  setViewMode:
    "Resets scrollLeft alongside scrollTop when a DIFFERENT note opens: paged " +
    "mode runs sideways, so leaving scrollLeft alone opened the new note " +
    "wherever the previous one had been left. Also repaginates after the paint.",
  scrollNotesHeadingIntoView:
    "Turns to the heading's page when paged. No re-aiming loop there — a page " +
    "boundary is exact, and the loop exists for heights that keep changing " +
    "under a vertical scroll.",
  estimateNotesScrollForOffset:
    "There is no scrollHeight to take a fraction of when the note runs " +
    "sideways, so the same proportional guess becomes a page number.",
  scrollNotesBlockToReadingLine:
    "There is no reading line in paged mode — the block is on the page you " +
    "are looking at or it is not.",
  revealRenderedNoteRange:
    "scrollIntoView WOULD move a paged view, but it stops the moment the " +
    "target is visible, which leaves the reader mid-page with a column sliced " +
    "down the middle of the screen. Land on the page boundary instead — and " +
    "compute that page from the RANGE, not from its block: a block that flows " +
    "across a column break reports the union of its fragments, so paging by " +
    "the block sent every jump whose target sat in the tail of such a " +
    "paragraph to the previous page, with the target off-screen.",
  findRenderedNoteRange:
    "A paged search window. Its window was built from scrollHeight/scrollTop, " +
    "both meaningless when the note runs sideways (scrollTop is 0, " +
    "scrollHeight === clientHeight), so it degenerated to the whole document " +
    "and indexOf then took the FIRST occurrence of the phrase anywhere in the " +
    "note — the wrong-copy failure the window exists to prevent. The binary " +
    "search was invalid there too: paged document order runs along X, so block " +
    "`bottom` values are not monotonic. Pages are, so the paged branch windows " +
    "by page instead.",

  // The reading-position sampler, which was silently wrong in paged mode: it
  // saved "the top of the note" on every call and synced that to every device.
  rawOffsetForCurrentNotesScroll:
    "Two paged branches. The probe x was the horizontal middle of the view, " +
    "which in two-column mode is the COLUMN GAP — elementFromPoint returns " +
    "#notesView itself there, so layer 1 could never hit text. And the layer-4 " +
    "fallback computed `scrollHeight - clientHeight`, which is 0 when the note " +
    "runs sideways, so it returned a literal offset 0 every time. That result " +
    "is stored as the reader's position and folded into meta.readingPosition, " +
    "so reading in paged mode saved — and then restored, everywhere — the top " +
    "of the note.",
  notesBlockAtReadingLineGeometric:
    "Delegates to firstVisibleNotesBlock when paged. Its binary search rests " +
    "on block `bottom` values being monotonic in document order; paged " +
    "document order runs along X, so they are all inside one viewport height " +
    "and the search converged on an arbitrary block near page 0.",
  renderNotesViewPinned:
    "Pins by page when paged instead of correcting scrollTop, which is pinned " +
    "at 0 there. Reached by making a highlight or a cloze, so getting it wrong " +
    "moved the reader every time they marked something up.",

  // ── Reading a whole folder as one deck (src/library/folder-deck.js) ──────
  // A folder open as one document is not a deck and has no record of its own,
  // so the field below is what stops the ordinary save path inventing one.
  state:
    "One field added: folderDeck, non-null only while a whole folder is open " +
    "as one document. It is what routes a save back into the decks the " +
    "document was built from instead of minting a new library entry for the " +
    "merged blob and syncing it to every device.",
  saveDeckToLibrary:
    "Hands over to saveFolderDeck when a folder is the thing open. " +
    "resolveSaveTarget falls through to generateLocalDeckId, so a null " +
    "localDeckId does NOT mean ephemeral — it means 'mint one'.",
  saveDeckToLibrarySync:
    "Same gate as its async twin, and the load-bearing one: flushWorkingDeck " +
    "calls THIS from pagehide/visibilitychange, so without it switching tabs " +
    "while reading a folder would create the merged deck.",
  createNewDeck:
    "Clears state.folderDeck alongside localDeckId, or the new deck's first " +
    "save would be routed into the previous folder's member decks.",
  loadDeckSnapshot:
    "Clears state.folderDeck. Every path that replaces the open deck — " +
    "library, cloud, import, restore — comes through here, so it is the one " +
    "place that has to remember.",
  updateMeta:
    "The deck-title and category pencils are disabled while a folder is open " +
    "as one document: there is no record to rename, and the chip says FOLDER " +
    "rather than a category the merged view does not have.",
  currentDeckKey:
    "Includes the folder path. A folder document has NEITHER id, which is the " +
    "same key an unattached working deck has — so without it a reading anchor " +
    "captured in a folder could be attached to a new deck.",
  currentNavLocation:
    "Records a folder document as kind:'folder'. It has no id, so the deck " +
    "branch would never record it and Back out of a deck opened from the " +
    "folder view would walk straight past the folder.",
  sameNavLocation:
    "Compares kind:'folder' entries by path, the only identity they have.",
  goToNavLocation:
    "Restores a kind:'folder' entry by RE-MERGING from the decks as they are " +
    "now, not from a cached document — a stale merge would be written back " +
    "over decks that have since changed.",
  readChromeHeights:
    "Measures with scrollHeight instead of offsetHeight. The variables it " +
    "writes are the SAME ones the CSS clamps these elements with " +
    "(`.appbar { max-height: var(--appbar-h) }`), so offsetHeight reports the " +
    "clamped box: once a short height was recorded the element could never be " +
    "measured taller. Latent until the appbar's height started depending on " +
    "the view — a height measured while reading was then too small for Cards " +
    "and Highlights, and the meta row spilled out over the tabs below it.",
  buildDeckOverflowMenu:
    "Its inline menu-positioning block moved to positionOverflowMenu(), which " +
    "the new folder overflow menu shares. Identical code, one copy.",
  buildFolderTile:
    "A folder tile gains an action row: Read, plus the same ⋯ overflow menu the " +
    "deck tiles carry. Folder tiles had NO inline controls, so in Tiles display " +
    "a folder was the one thing in the library you could not open, rename, move " +
    "or delete without switching views.",
  buildFolderActionCluster:
    "Two visible buttons and a menu, instead of six inline icons. It was Read / " +
    "Deck / Folder / Import / Rename / Delete — too much furniture for a folder " +
    "row AND missing the two things people looked for, Open and Move. The two " +
    "that stay are the two about going somewhere; everything that CHANGES the " +
    "folder is one press away under ⋯, where each action gets a real name.",
  buildNotesToc:
    "Foldable sections. The list stays flat — the tree is still drawn by the " +
    "rail spans — so the build now also derives the parent/child relation that " +
    "flat DOM cannot carry (notesTocParent / notesTocBranch), carries the fold " +
    "state across a rebuild by heading SLUG rather than by index, and appends a " +
    "twisty <button> as a SIBLING of each branch row's <a>.",
  updateNotesTocActive:
    "When the section being read is folded away, the scroll-spy now lights its " +
    "nearest visible ancestor instead of a row nobody can see. Deliberately " +
    "not 'unfold the ancestors': that would re-open the tree a branch at a " +
    "time as you scrolled, undoing the fold the reader asked for.",
  OVERLAY_LAYERS:
    "One entry added, in the popover group: the notes header's phone-only ⋯ " +
    "menu (src/notes/notes-head-overflow.js). Without it a Back press aimed at " +
    "the open menu falls through to goNavBack() and loads another deck.",

  // ── Egress: the same bytes were being re-fetched, forever ────────────────
  // A library of 700 decks and 3,700 images was moving gigabytes a month
  // against a 5GB quota. Three separate causes, none of which changes what
  // sync decides — only how much it has to transfer to decide it.
  renderMyDecksList:
    "Reads the deck INDEX rather than fetchCloudDeckList's `select(\"*, " +
    "cards(count)\")`, which pulled every cloud deck's entire notes markdown " +
    "plus a per-deck aggregate over the whole cards table — on every repaint " +
    "that hits the network, to show a title and a sync pill. It reads only " +
    "id/title/category/updated_at, all of which the index carries.",
  allMyDeckSelections:
    "Same swap as renderMyDecksList, and the last caller of fetchCloudDeckList " +
    "— which is now removed. It reads only `id` off each row.",
  fetchCloudDeckIndex:
    "Takes the column list as a parameter so sync can ask for less than the " +
    "library UI does (see DECK_SYNC_INDEX_COLUMNS). Paging, the stable " +
    "updated_at+id sort and the exact-count completeness check are unchanged " +
    "— those are what stop a short read reading as deletions.",
  reconcileAllDecks:
    "Asks the index for DECK_SYNC_INDEX_COLUMNS instead of all seven. The " +
    "reconcile only ever reads id and updated_at off an index row (title and " +
    "category ride along solely for the missing-body push fallback at the " +
    "cloudDeck diff); notes, meta and cards still come from fetchCloudDeckRows " +
    "for the decks actually moving. Same rows, same order, fewer columns.",

  // ── Backup: telling a dead link apart from an unreadable one ─────────────
  readBackupAssetBlob:
    "Retries the network fetch, but only for images we host. A CORS refusal " +
    "surfaces as a bare `TypeError: Failed to fetch`, which isTransientCloudError " +
    "matches — so retrying third-party links doubled the requests for hosts " +
    "that can never succeed. Also logs the real reason (HTTP status vs " +
    "timeout vs CORS) instead of collapsing every failure into a silent null.",
  packBackupAssets:
    "Splits `missing` into missingHosted (our uploads whose storage object is " +
    "gone — a real hole) and missingExternal (a third-party link the browser " +
    "is not allowed to read; the note keeps the link). Both are recorded in " +
    "assets/index.json. `missing` itself is unchanged, so an older restore " +
    "reads a new archive exactly as before.",
  runLibraryBackup:
    "Reports those two counts as two different things. One combined figure " +
    "read as 'N of your images are lost' when most of them were pasted web " +
    "links behaving normally, and only the hosted half is an error condition.",

  // ── Storage panel: the check nobody had written ──────────────────────────
  buildStorageReport:
    "Also computes missingRefs — storage paths a deck still points at that " +
    "have no file behind them. The exact inverse of `orphans`, from the two " +
    "sets it already had, so it costs no extra request and needs no per-image " +
    "network probe. Reported only; nothing acts on it.",
  renderStoragePanel:
    "Shows missingRefs as a Missing tile beside Unused, with a note saying " +
    "that deleting unused images will not help — these are the opposite " +
    "problem, and that was the first thing people tried.",
};

// Functions whose ONLY change is that a write to a module-level binding now goes
// through that binding's setter.
//
// This is the one edit the split forces on function bodies. `import { x }` makes
// x read-only in the importing module — assigning to it is an early SyntaxError
// that stops the whole graph instantiating — so a binding written from a module
// other than the one declaring it needs `setX(v)`. Reads are untouched: a live
// binding still shows every reader the current value, exactly as the shared
// script scope did.
//
// Listed by name rather than waved through, so a body that changed for any
// OTHER reason still fails. The check below verifies that the only difference is
// the setter rewrite; anything more is reported as a real change.
// Discovered, not hand-listed: every `export function setX(value) { x = value; }`
// in the tree, plus the bump helpers. Registering these by hand meant forgetting
// one and getting a spurious "body differs" report for a routing that was
// entirely mechanical.
const SETTER_ROUTED = new Map();
for (const f of walk(path.join(ROOT, "src"))) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/export function (set[A-Za-z0-9_$]*)\(\s*([A-Za-z0-9_$]+)\s*\)\s*\{\s*([A-Za-z0-9_$]+) = \2;\s*\}/g)) {
    SETTER_ROUTED.set(m[1], { name: m[3], kind: "set" });
  }
  for (const m of text.matchAll(/export function (bump[A-Za-z0-9_$]*)\(\s*\)\s*\{\s*([A-Za-z0-9_$]+) \+= 1;/g)) {
    SETTER_ROUTED.set(m[1], { name: m[2], kind: "bump" });
  }
  // `export function nextX() { return ++y; }` — a counter claimed from another
  // module, where `++y` on the import would throw.
  for (const m of text.matchAll(/export function ([A-Za-z0-9_$]+)\(\s*\)\s*\{\s*return \+\+([A-Za-z0-9_$]+);\s*\}/g)) {
    SETTER_ROUTED.set(m[1], { name: m[2], kind: "preinc" });
  }
}


// Undo the setter rewrite on the CURRENT text; if it then matches the baseline,
// the setter routing was the whole of the difference.
function unroute(code) {
  // To a fixed point: a setter call routinely appears INSIDE another setter's
  // argument (`setX(requestAnimationFrame(() => { setX(0); … }))`), and one pass
  // hands the inner one through untouched as part of the outer's argument.
  let out = code;
  for (let pass = 0; pass < 5; pass++) {
    const before = out;
    for (const [setter, { name, kind }] of SETTER_ROUTED) {
      if (kind === "bump") { out = out.replaceAll(`${setter}();`, `${name} += 1;`); continue; }
    if (kind === "preinc") { out = out.replaceAll(`${setter}()`, `++${name}`); continue; }
      out = replaceCall(out, setter, (arg) => `${name} = ${arg};`);
    }
    if (out === before) break;
  }
  return out;
}

// Replace `setter(<balanced args>);` — matching parentheses rather than
// scanning to the next `;`. The argument is routinely a whole callback:
//
//   setChromeScrollFrame(requestAnimationFrame(() => { … ; … }));
//
// A `[^;]*` pattern stops at the first semicolon INSIDE that callback, fails to
// match, and reports a mechanical setter routing as a real code change.
function replaceCall(text, fn, build) {
  let out = "";
  let i = 0;
  for (;;) {
    const at = text.indexOf(`${fn}(`, i);
    if (at === -1) return out + text.slice(i);
    // Only a standalone call, not a longer identifier ending in this name.
    const prev = text[at - 1];
    if (prev && /[\w$.]/.test(prev)) { out += text.slice(i, at + fn.length + 1); i = at + fn.length + 1; continue; }
    let depth = 0;
    let j = at + fn.length;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") { depth--; if (!depth) break; }
    }
    if (j >= text.length) return out + text.slice(i);
    const arg = text.slice(at + fn.length + 1, j);
    const semi = text[j + 1] === ";" ? j + 2 : j + 1;
    out += text.slice(i, at) + build(arg) + (text[j + 1] === ";" ? "" : "");
    i = semi;
  }
}


// Baseline symbols that are intentionally gone, and why. A rename lands here
// (the old name) and in the ADDED list (the new one), which is the honest way
// to show it — the tool matches by name and cannot know the two are related.
const REMOVED = {
  fetchText:
    "declared TWICE in the baseline (app.js:25472 and app.js:29556). Legal in a " +
    "classic script, where the second silently won for every caller; a hard " +
    "SyntaxError in a module, so the app did not boot at all. Split into " +
    "fetchImportText (URL import, 45s) and fetchReleaseText (update check, 8s).",
  fetchCloudDeckList:
    "both callers (renderMyDecksList, allMyDeckSelections) read the deck INDEX " +
    "instead. It selected `*, cards(count)` — every cloud deck's whole notes " +
    "markdown plus an aggregate over the cards table — to render a title and a " +
    "sync pill, on every My Decks repaint that hits the network. Nothing ever " +
    "read `notes` or the count off it, so leaving it in place would only be a " +
    "trap for the next caller who reached for the obvious-looking name."
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

// The baseline: app.js as it stood before any of this began.
let baseSrc;
try {
  baseSrc = execFileSync("git", ["show", `${baseRef}:app.js`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
} catch (_) {
  console.error(`Could not read app.js at '${baseRef}'. Pass --base=<ref> for the pre-restructure commit.`);
  process.exit(2);
}

// The current tree: whatever is in src/, plus app.js if it is still there (it is,
// until phase 1 moves it).
const currentFiles = walk(path.join(ROOT, "src"));
if (existsSync(path.join(ROOT, "app.js"))) currentFiles.push(path.join(ROOT, "app.js"));
if (!currentFiles.length) {
  console.error("Nothing to compare: no src/**/*.js and no app.js.");
  process.exit(2);
}

const baseDecls = new Map();
const baseAllDecls = topLevelDecls(baseSrc);
const baseDupes = [];
for (const d of baseAllDecls) {
  if (baseDecls.has(d.name)) baseDupes.push(`${d.name} (lines ${baseDecls.get(d.name).line} and ${d.line})`);
  baseDecls.set(d.name, d);
}

const currentDecls = new Map();
const currentDupes = [];
for (const file of currentFiles) {
  const rel = path.relative(ROOT, file);
  for (const d of topLevelDecls(readFileSync(file, "utf8"))) {
    d.file = rel;
    if (currentDecls.has(d.name)) {
      const first = currentDecls.get(d.name);
      currentDupes.push(`${d.name} — ${first.file}:${first.line} and ${rel}:${d.line}`);
    }
    currentDecls.set(d.name, d);
  }
}

if (showName) {
  const a = baseDecls.get(showName);
  const b = currentDecls.get(showName);
  console.log(`--- ${baseRef}:app.js ---\n${a ? a.text : "(absent)"}`);
  console.log(`\n--- current (${b ? b.file : "absent"}) ---\n${b ? b.text : "(absent)"}`);
  process.exit(0);
}

const missing = [];
const changed = [];
const added = [];
const accepted = [];

for (const [name, base] of baseDecls) {
  const cur = currentDecls.get(name);
  if (!cur) {
    if (REMOVED[name]) accepted.push(`${name} (removed) — ${REMOVED[name]}`);
    else missing.push(name);
    continue;
  }
  if (normalize(base.text) === normalize(cur.text)) continue;
  if (ACCEPTED[name]) { accepted.push(`${name} — ${ACCEPTED[name]}`); continue; }
  if (normalize(base.text) === unroute(normalize(cur.text))) {
    accepted.push(`${name} — writes a moved binding through its setter`);
    continue;
  }
  // Where do they first diverge? Far more useful than "these differ".
  const na = normalize(base.text), nb = normalize(cur.text);
  let i = 0;
  while (i < na.length && na[i] === nb[i]) i++;
  changed.push(
    `${name}  (${cur.file}:${cur.line})\n` +
    `    was: …${na.slice(Math.max(0, i - 40), i + 70)}\n` +
    `    now: …${nb.slice(Math.max(0, i - 40), i + 70)}`
  );
}
for (const name of currentDecls.keys()) {
  if (!baseDecls.has(name)) added.push(`${name} (${currentDecls.get(name).file})`);
}

// ── The residual: everything that is NOT a top-level declaration ───────────
//
// Comparing declarations misses a third of the file. What is left over is the
// module-scope code — the event-listener registrations, the ~10 bootstrap calls
// — plus comments and blank lines. That residual is real behaviour, and an
// extraction can damage it: cutting an already-exported declaration from after
// its `export ` keyword left the keyword stranded on its own line, which is a
// SyntaxError that took the whole app down and which this file, comparing only
// declarations, reported as perfectly fine.
//
// So: strip every declaration, drop comments and whitespace, and compare what
// remains as one blob.
function residual(text, decls) {
  const cuts = [...decls].sort((a, b) => b.fullStart - a.fullStart);
  let out = text;
  for (const d of cuts) out = out.slice(0, d.fullStart) + out.slice(d.end);
  return normalize(out).replace(/\s+/g, " ").trim();
}

// Intentional module-scope changes, applied to the BASELINE so the comparison
// stays meaningful instead of being switched off. Each entry is a change made
// on purpose — by the restructure, or by a fix landed since it — spelled out
// so that everything around it keeps being compared byte for byte.
const RESIDUAL_REWRITES = [
  // Phase 1: a deferred module script sees readyState "interactive", so the
  // old inline `else` branch fired mid-file. See onDomReady in src/main.js.
  [/if \(document\.readyState === "loading"\) \{ document\.addEventListener\("DOMContentLoaded", (\w+)\); \} else \{ \1\(\); \}/g,
   "onDomReady($1);"],
  [/if \(document\.readyState === "loading"\) \{ document\.addEventListener\("DOMContentLoaded", (\w+), \{ once: true \}\); \} else \{ \1\(\); \}/g,
   "onDomReady($1);"],
  // Landed after the split, so it is an ADDITION to the baseline rather than a
  // rewrite of it: the floating selection pill's container now cancels
  // pointerdown/mousedown, so a press that lands on the pill but on none of its
  // buttons can no longer place a caret in the note underneath and throw away
  // the selection the pill is there to act on. See tools/selection-check.mjs.
  [/(hideNotesSelectionButtonUnlessPinned, \{ passive: true \}\); \}\); )(el\.makeCardFromSelectionBtn\?\.addEventListener)/,
   '$1["pointerdown", "mousedown"].forEach((type) => { el.selectionFloat?.addEventListener(type, (event) => { event.preventDefault(); }); }); $2'],
  // Also an ADDITION rather than a rewrite: two more boot hooks next to the one
  // that fills #notesRenderToolbar. They set up the notes header's phone-only ⋯
  // overflow menu and the measurement that lets that header fold away with the
  // rest of the chrome — see src/notes/notes-head-overflow.js and
  // src/notes/notes-head-fold.js.
  [/(onDomReady\(initRenderToolbars\); )(document\.addEventListener\("pointerdown")/,
   "$1onDomReady(initNotesHeadOverflow); onDomReady(initNotesTocFolding); onDomReady(initPagedNotes); onDomReady(initNotesCaretLine); $2"],
];

let baseResidual = residual(baseSrc, baseAllDecls);
for (const [re, to] of RESIDUAL_REWRITES) baseResidual = baseResidual.replace(re, to);
// unroute() undoes the setter rewrite, so module-scope listeners that write a
// moved binding compare equal without weakening anything else.
const currentResidual = currentFiles
  .map((f) => {
    const text = readFileSync(f, "utf8");
    // Import statements are new by construction; they are not "leftover code".
    const stripped = text.split("\n").filter((l) => !/^import\s.+from\s*["'][^"']+["'];\s*$/.test(l)).join("\n");
    return residual(stripped, topLevelDecls(stripped));
  })
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();
const currentResidualUnrouted = unroute(currentResidual);

const residualDrift = [];
if (baseResidual !== currentResidualUnrouted) {
  let i = 0;
  while (i < baseResidual.length && baseResidual[i] === currentResidualUnrouted[i]) i++;
  residualDrift.push(
    "module-scope code differs from the baseline\n" +
    `    was: …${baseResidual.slice(Math.max(0, i - 60), i + 90)}\n` +
    `    now: …${currentResidualUnrouted.slice(Math.max(0, i - 60), i + 90)}`
  );
}

const report = (label, list, verbose = true) => {
  if (!list.length) return;
  console.log(`\n${label} (${list.length})`);
  for (const line of (verbose ? list : list.slice(0, 40))) console.log(`  ${line}`);
  if (!verbose && list.length > 40) console.log(`  … and ${list.length - 40} more`);
};

// Duplicate names in the CURRENT tree are the headline failure: two modules each
// owning a symbol of the same name is exactly the flat-scope collision this
// restructure exists to make impossible (see fetchText).
report("DUPLICATE in current tree — two modules own the same name", currentDupes);
report("MISSING — in the baseline, gone from the tree", missing, false);
report("CHANGED — body differs from the baseline", changed);
report("ADDED — new since the baseline (expected: setters, module glue)", added, false);
report("MODULE-SCOPE DRIFT", residualDrift);
report("accepted differences", accepted);

if (baseDupes.length) {
  console.log(`\nnote: the baseline itself declares these twice — ${baseDupes.join(", ")}`);
}

const fail = currentDupes.length + missing.length + changed.length + residualDrift.length;
console.log(
  `\n${baseDecls.size} baseline symbols · ${currentDecls.size} current · ` +
  `${currentDecls.size - added.length - missing.length} matched · ${fail} problem(s)`
);
process.exit(fail ? 1 : 0);
