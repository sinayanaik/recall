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
  // ── Offline: the app must always paint, and sync must name its failures ──
  // The app loaded eight parser-blocking <script> tags and two render-blocking
  // <link>s from cdn.jsdelivr.net, and paints nothing before src/main.js runs —
  // so a CDN that was blocked, or merely hanging, was a blank screen for as
  // long as it lasted. Those libraries are same-origin files in vendor/ now,
  // precached before the worker activates, in caches a release does not touch.
  // The entries below are the rest of that work: bounding the waits that were
  // unbounded, opening the local library instead of a sign-in wall, and saying
  // "your sign-in expired" where the provider's own "JWT expired" used to land.
  bootApp:
    "Local data paints BEFORE any Supabase work. The session check was awaited " +
    "with nothing on screen, and getCachedSession goes to the network when the " +
    "access token has expired — so a lapsed token on a stalled connection was a " +
    "blank page indefinitely. Now: a device with a configured project, a known " +
    "owner and decks on disk opens its library immediately and confirms the " +
    "session behind it (confirmSessionInBackground); the 8-second " +
    "waitForSupabaseLibrary retry is skipped when offline, where it could only " +
    "ever buy blank screen; and the library-failed wall is shown only when " +
    "there is genuinely nothing local to fall back on. Also paints the Offline " +
    "pill during boot rather than only when connectivity CHANGES.",
  getCachedSession:
    "Wrapped in withTimeout. Its name and its old comment both said 'no " +
    "network', and that was false — getSession() refreshes over the network " +
    "once the access token has expired, which verifiedCloudUserId twenty lines " +
    "below had already been bounded for. Unwrapped and awaited by bootApp " +
    "before any screen exists, it was the single most direct cause of the " +
    "blank-screen report. A timeout reads as 'no session', which is a state " +
    "the app already handles by opening the local library.",
  showBootScreen:
    "Clears the pre-JavaScript boot placeholder in index.html. Here and " +
    "nowhere else, for the same reason this function is the only place that " +
    "unhides a screen: whatever it is about to show IS the answer the " +
    "placeholder stood in for.",
  initSupabaseClient:
    "createClient now receives its auth options explicitly instead of relying " +
    "on the v2 defaults. persistSession and autoRefreshToken are load-bearing " +
    "here (an offline launch reads the stored session; a phone left for a week " +
    "needs the refresh), so a supabase-js bump changing either would present " +
    "as 'sync just stopped working' with nothing in the repo to point at. " +
    "storageKey is deliberately still unset — see the comment there.",
  describeAuthError:
    "Names an expired sign-in before falling through to the raw provider " +
    "string. That fallback is where 'JWT expired' and 'Invalid Refresh Token: " +
    "Already Used' were reaching the login screen verbatim — true, useless, " +
    "and indistinguishable from the app being broken.",
  safeHtmlFromPrepared:
    "Renders the markdown SOURCE when marked or DOMPurify is missing instead " +
    "of throwing. Throwing took the whole view down and left an empty pane " +
    "with nothing to explain it; the source is still readable and copyable, " +
    "and the boot guard has already named the missing file on screen.",
  renderPreparedBlocks:
    "Same guard as safeHtmlFromPrepared, which is where each block lands on " +
    "this path.",

  // ── Sync: speed, and every wait bounded ──────────────────────────────────
  readLocalDeckIndex:
    "Reads the batch's pending copy when a sync has one open. Still returns a " +
    "FRESH PARSE on every call — the aliasing that handing out a shared array " +
    "would introduce is not worth the saving across 48 call sites.",
  writeLocalDeckIndex:
    "Batchable. The index is one localStorage key holding the whole library " +
    "and every deck a sync touches rewrites all of it, so a 700-deck pull did " +
    "700 synchronous ~200KB disk writes on the main thread — the largest " +
    "single cost in a sync, and it presented as the app freezing rather than " +
    "as sync being slow. Inside a batch the writes accumulate in memory and " +
    "reach disk on a checkpoint (see INDEX_CHECKPOINT_EVERY), on pagehide, and " +
    "at the end of the run.",
  pushDeckRowsToCloud:
    "Three calls that were wrapped in withTimeout without abortable() now have " +
    "it: the fallback card read, the card prune and the final deck bump. " +
    "Without it a timeout only stops WAITING for the answer — the request " +
    "stays open holding one of six per-host sockets, which is what turned one " +
    "stalled request into a whole sync crawling behind its own dead " +
    "connections.",
  writeStyleToCloud: "abortable(), for the reason in pushDeckRowsToCloud.",
  writeQuickNoteAnchors:
    "withTimeout + abortable, where there was no timeout at all. " +
    "flushPendingQuickNoteAnchors is awaited by reconcileAllDecks BEFORE the " +
    "deck list is read, so an unbounded call here hung the entire sync before " +
    "a single deck had been looked at.",
  writeQuickNoteCategoryOpsToCloud:
    "withTimeout + abortable, same position in the sync and same reason as " +
    "writeQuickNoteAnchors.",
  loadDeckNotesForSearch: "withTimeout + abortable; it had neither.",
  flushPendingUntombstones:
    "The delete is CHUNKED. An `.in()` list becomes part of the request URL " +
    "and a uuid costs ~46 characters percent-encoded, so past a few hundred " +
    "ids it crosses the 8KB request-line ceiling nginx and most proxies ship " +
    "with — the same trap CARD_FETCH_DECK_CHUNK exists for. A 414 here would " +
    "leave every restored deck still tombstoned, and the next sync would " +
    "honour that by deleting it again.",

  // ── Sync report: where the time went ─────────────────────────────────────
  buildSyncReportHtml:
    "Takes per-phase timings and renders them collapsed above the deck list. " +
    "'Sync is slow' was unanswerable: the only thing on screen during a run " +
    "was a changing button label, so 40 seconds spent reading deck bodies and " +
    "40 seconds spent waiting on one stalled request looked identical.",
  showSyncReport: "Passes timings through to buildSyncReportHtml.",
  renderWelcomeSyncReport: "Passes timings through, so a background sync reports them too.",

  // ── The floating selection pill becomes the only formatting surface ──────
  // Every button on a persistent formatting strip refuses without a selection,
  // so those strips were permanent rows that could do nothing until you made
  // one — and on a phone, rows that did nothing while covering the text. The
  // card faces' render toolbar is gone and the raw-edit toolbars keep only the
  // three controls a selection cannot express (insert image, bullet, clear
  // formatting). The pill carries the rest, in raw mode as well as rendered.
  createToolbarHtml:
    "Takes { formatting: false } to emit only the three controls a SELECTION " +
    "cannot express — insert-image needs a caret, bullet and clear-formatting " +
    "act on whole lines. The All Cards editor still asks for the full strip: " +
    "it is the one editing surface the floating pill does not serve " +
    "(SELECTION_TARGETS covers notes, question and answer only).",
  initToolbars:
    "All three faces now get the line-tools strip only, and no capture group. " +
    "Formatting and capture both ride the floating pill, which works in raw " +
    "mode too, so repeating either here would be a second copy of a control " +
    "already on screen the moment it can be used.",
  applyRenderFormat:
    "Raw-edit mode applies the formatFn to the textarea's exact [start, end) " +
    "instead of refusing with 'switch to preview to format a selection there'. " +
    "That refusal was only tolerable while each editor carried its own " +
    "toolbar; the pill is now the only formatting surface, so it would have " +
    "meant no bold, italic, colour or font in raw mode at all. The write-back " +
    "is applyFormatToTextarea, shared with the raw toolbar's own handler.",
  handleToolbarClick:
    "The textarea write-back moved into applyFormatToTextarea, so the raw " +
    "toolbar and the floating pill share one definition of it rather than " +
    "keeping two copies that could drift.",
  handleRenderToolbarAction:
    "Handles the font list: a `font-menu` open/close and a data-render-font " +
    "apply. The font picker moved here from the raw editor's toolbar when that " +
    "shrank, and would otherwise have become unreachable.",
  closeAllRenderMenus:
    'Resets aria-expanded on every menu opener ([data-render-action$="-menu"]), ' +
    "not just .render-split-side. The font picker's toggle is a plain button, " +
    "so the old selector left its aria-expanded stuck on 'true'.",
  commitEditIfActive:
    "Drops the renderToolbar entries — the card faces' persistent render " +
    "toolbar no longer exists to show or hide.",
  toggleEditMode:
    "Drops the renderToolbar lookup and its two show/hide calls, for the same " +
    "reason as commitEditIfActive.",
  hideNotesSelectionButton:
    "Also clears the is-format-open class (the phone bar's ⋯ formatting " +
    "disclosure). It is a CLASS on the pill, so hiding the pill hides it " +
    "visually while leaving it set, and the next selection would open already " +
    "expanded — the one state a collapsed-by-default bar exists to avoid. It " +
    "is in the fast-path test too, or the early return skips the only reset.",

  // ── The selection bar appears before it describes the selection ──────────
  // Reported as "the text select options are coming very delayed after
  // selection happening". Everything the bar's BUTTONS need — the markdown
  // serialisation, the occurrence count, the word tally — used to be computed
  // before it was drawn: three clones of the selected fragment, two Turndown
  // conversions, and a count that clones the whole note above the selection
  // (measured 43ms on an 8,000-paragraph note, far more on a real book). None
  // of it is needed to DRAW the bar, so it is scheduled immediately afterwards
  // and resolved on demand if a button is pressed first.
  pillActionTarget:
    "Resolves the deferred half of the capture before reading it.",
  selectionForRenderTarget:
    "Resolves the deferred half of the capture before falling back to it.",

  // ── Highlights you can manage ────────────────────────────────────────────
  collectDeckHighlights:
    "Reports each row's colour, so the menu on the mark can show which of the " +
    "six swatches the highlight already is. Six identical circles otherwise " +
    "give no clue which is current, and the only way to find out is to press " +
    "one — which is a change you then have to undo.",

  // ── Opening a book without freezing the tab ──────────────────────────────
  renderMarkdown:
    "Awaits patchRenderedBlocks, slices enhancement, and defers the render tail " +
    "on a large note. A cold render used to be one synchronous burst: measured " +
    "on a 2.6MB / 18,000-block note, the tab answered nothing for 382ms and the " +
    "reader saw no text at all until 876ms. It is now built in batches with a " +
    "frame between them — first visible text at ~170ms — which is also what " +
    "stops a long press being classified as a scroll on a phone, because the " +
    "browser's long-press timer needs the events delivered on time.",
  patchRenderedBlocks:
    "Async, and streams a large build through streamRenderedBlocks instead of " +
    "parsing every missing block in one pass. Takes `sequenceOk` so a run whose " +
    "container a newer render has already claimed abandons itself at a batch " +
    "boundary rather than writing into a view it no longer owns.",
  shouldChunkRenderedBlocks:
    "Always wraps in paged mode, at any size, because there a wrapper is one " +
    "CHAPTER and showing a chapter is a class rather than a re-render. It used " +
    "to do the opposite — never wrap when paged — which is why paged mode had " +
    "to lay out the whole book and why it refused above 250,000 characters " +
    "with \"Note too long for pages — scrolling instead\".",
  reshapeRenderedChunks:
    "Regroups even when the chunked/unchunked answer is unchanged, and passes " +
    "notesChunkBoundaries: going continuous -> paged keeps wrapping but changes " +
    "what a wrapper IS, from a run of forty blocks to a whole chapter.",
  rechunkRenderedBlocks:
    "Reuses the existing chunk ELEMENTS rather than rebuilding them, and takes " +
    "optional chapter boundaries. content-visibility: auto remembers the size a " +
    "box last laid out at and that memory belongs to the element, so " +
    "replaceChildren() on fresh wrappers reset every off-screen chunk to the " +
    "flat estimate — hundreds of thousands of pixels of document height moving " +
    "under the reader on every repaint. Re-homing is appendChild in plan order " +
    "with a global planned-set sweep; an earlier attempt held a firstChild " +
    "cursor per chunk, which any cross-chunk move invalidates, and it threw " +
    "NotFoundError on every note over 2,000 blocks.",
  firstVisibleNotesBlock:
    "Binary search rather than a linear sweep (document order runs along X in a " +
    "columned layout, so `left` is monotonic), and scoped to the ACTIVE chapter " +
    "— every other block is display:none and reports a zero rect the search " +
    "cannot order.",
  isNotesPaged:
    "No longer consults notesPagedTooLarge. There is no size at which paged " +
    "mode refuses now that it lays out one chapter at a time.",
  notesPagedTooLarge:
    "Always false — kept only so importers do not break. See isNotesPaged.",
  notesPageCount:
    "Math.ceil rather than Math.round: a note whose content stops partway " +
    "through its final page leaves scrollWidth a fractional multiple of " +
    "clientWidth, and rounding dropped that page from the count entirely — the " +
    "End key clamped early, the forward arrow disabled itself, and the settle " +
    "snapped the reader back off the last page.",
  notesCurrentPage:
    "Parked at the end of the flow IS the last page, whatever the arithmetic " +
    "says; without that the final clamped scroll position rounded back to the " +
    "second-to-last page.",
  goToNotesPage:
    "Clamps the tween's target to notesMaxScrollLeft(), so it lands where the " +
    "scroller will actually stop instead of at a value the browser refuses.",
  turnNotesPage:
    "Crosses chapter boundaries: past the last page of a chapter opens the next " +
    "one at page 1, before the first opens the previous at its end. Paging is " +
    "per chapter now, and without this a book would read as a set of separate " +
    "documents.",
  updateNotesPageIndicator:
    "Reads \"Ch 3/121 · 2/9\" when the note has chapters, and the arrows are " +
    "only disabled at the two ends of the BOOK rather than of the chapter.",
  revealInPagedNotes:
    "Activates the target's chapter before aiming, and on every re-aim. A node " +
    "in an inactive chapter is display:none — no box, no page — so \"Go to\" " +
    "from the Highlights panel scrolled nowhere once paging became per chapter.",
  revealRangeInPagedNotes:
    "Same as revealInPagedNotes, for a Range.",
  applyNotesPagedLayout:
    "Marks the active chapter before measuring, and no longer announces a " +
    "too-large note — there is no such thing now.",
  scheduleNotesPageSettle:
    "Leaves the last page alone instead of snapping off it, and clamps its " +
    "target to the reachable maximum.",

  // ── Undo and redo for the notes ──────────────────────────────────────────
  // The app relied on the browser's own per-keystroke undo inside the raw
  // editor, and said so out loud: all-cards-edit.js keeps its stack scoped to
  // the card ARRAY "because question/answer/notes textareas already get native
  // per-keystroke undo from the browser", and main.js excluded text fields from
  // Ctrl+Z for the same reason. That premise is false. A programmatic
  // `textarea.value = …` DISCARDS the element's undo transaction, and every
  // toolbar action, pill button, pasted image, cloze, highlight and link insert
  // does exactly that — so from the first time you used any feature of the
  // editor, Ctrl+Z could not step back past it. In the rendered view, where
  // highlights are actually made, `state.notes` is mutated directly and there
  // was no undo at all. Each entry below snapshots the note before it changes
  // it; see src/notes/notes-history.js.
  applyFormatToTextarea:
    "Snapshots the note before the write-back when the target is #notesEdit. " +
    "This function IS the shared write-back for the whole raw toolbar and the " +
    "floating pill, so it is the one place that has to record a formatting edit.",
  clozeTextareaSelection:
    "Snapshots the note before wrapping the selection in {{ }} — see above.",
  highlightTextareaSelection:
    "Snapshots the note before wrapping the selection in <mark> — see above.",
  eraseTextareaSelection:
    "Snapshots the note before splicing the selection out — see above.",
  discardNotesEditingForDeckSwap:
    "Clears the undo stack. Whatever is on it belongs to the note being left, " +
    "and carrying it across would let Ctrl+Z paste the previous deck's note " +
    "into this one — the same class of mistake the `startedIn` guard in " +
    "extractSelectionToNote exists to prevent.",
  renderTargetConfig:
    "setSource snapshots the note first and re-adopts the baseline after. It " +
    "is the single choke point every rendered-view edit reaches through " +
    "applyRenderFormat — highlight, colour, font, bold, cloze, erase — so one " +
    "line here is one definition of \"an undoable notes edit\". (It also still " +
    "carries `edit`, the surface's textarea, for the reason recorded below.)",

  // ── Highlighting the things a note is actually made of ───────────────────
  // Reported as "it says Highlighted but I see no highlight", most often on
  // bullets and tables. Four separate defects, each of which either put the
  // <mark> somewhere the reader was not looking or turned markup into visible
  // characters. None of them is reachable from a test of a moved function; all
  // of them are one-line facts about markdown.
  textWithLineBreaks:
    "Reconstructs TABLE structure. Neither TD/TH nor TR was in TIGHT_ or " +
    "LOOSE_BLOCK_TAGS, so a selected row came back as one run-together string " +
    "— \"ElementSymbolHydrogenH\" for a source reading \"| Element | Symbol |\". " +
    "Nothing downstream survives that: the plain-text needle can never match " +
    "the source, and sel.occurrence is counted against the same string, so a " +
    "table highlight either missed outright or fell through to " +
    "looseMarkupMatch's first-hit-anywhere and marked a different table. Cells " +
    "are joined with \" | \" (a cell separator only applies BETWEEN cells of the " +
    "same row — prevBlockTag, not a bare `text` check, or every row got a " +
    "leading one) and trimmed; rows and the THEAD/TBODY/TFOOT sections each " +
    "start a line, because a table's children are its sections, not its rows.",
  NO_TEXT_LINE_RE:
    "Matches a setext heading's \"===\" underline. A run of \"=\" under a line is " +
    "what makes that line an H1 and it renders no text of its own, but it was " +
    "not listed here — so a drag across a setext heading wrapped the underline " +
    "in a <mark>, the line stopped being a heading, and the \"=\" showed up as " +
    "prose. (Setext H2 uses \"-\", already covered by the \"---\" alternative.)",
  wrapAcrossBlocks:
    "Skips INDENTED code blocks, not just fenced ones. marked escapes HTML in " +
    "both, so a <mark> dropped into four-space-indented code rendered as the " +
    "literal text \"<mark>\". Tracked with the same line walk the fence state " +
    "already uses: indentation only opens a code block at a block boundary " +
    "(start of the slice, or after a blank line), never mid-paragraph. And " +
    "never once a list marker has been seen — inside a list, four spaces after " +
    "a blank line is the ITEM'S continuation, which is ordinary prose the " +
    "reader expects to highlight. Reading that as code would break the " +
    "commonest selection there is in order to fix the rarest.",
  locateSelectionInSource:
    "Runs every stage's hit through balancedHit, not just looseMarkupMatch's. " +
    "expandToBalancedBounds has always widened a match that starts or ends " +
    "halfway through an inline construct, but only the last-resort stage asked " +
    "for it — so an exact or whitespace-fuzzy hit running from inside a " +
    "**bold** run to past its closing marker produced tags crossing the " +
    "emphasis they were opened inside. Same slack budget, so the eraser still " +
    "refuses a match that grew far beyond what was selected.",
  extractSelectionToNote:
    "Repaints with renderNotesViewPinned() instead of clearing " +
    "notesScrolledSource and calling a bare renderNotesView(). Splitting a " +
    "selection out edits the note the reader is looking at, exactly like a " +
    "highlight or a cloze — but this was the one such path still repainting as " +
    "though a DIFFERENT note had been opened, which releases the deferred-work " +
    "queue and re-derives the measured block-height estimate for the whole " +
    "document. Every off-screen block gets resized, including the ones ABOVE " +
    "the viewport, so the reader was moved by far more than the text this " +
    "actually removed." +
    " ALSO snapshots the note before splicing the [[link]] in, in both the raw " +
    "and rendered branches: moving a section into a note of its own is the most " +
    "destructive thing on the pill and was the least reversible.",

  INLINE_REGION_PATTERNS:
    "Each pattern is now { re, literal } rather than a bare regex. `literal` " +
    "marks a construct whose CONTENTS are not markdown — a code span, a formula " +
    "— where nothing can be inserted at all, so a hit landing wholly inside one " +
    "still has to be widened. Everything else is a container that markup nests " +
    "inside perfectly well, and a hit wholly inside one is already balanced. " +
    "That distinction is load-bearing: highlightToggleInSource recognises an " +
    "existing highlight by finding <mark> immediately before the hit and " +
    "</mark> immediately after, so widening a hit that already sits inside a " +
    "mark hid the very tags the toggle looks for, and re-highlighting the same " +
    "words nested a second mark instead of removing the first.",
  inlineRegionsIn:
    "Destructures { re, literal } and carries `literal` onto each region it " +
    "reports — see INLINE_REGION_PATTERNS.",
  expandToBalancedBounds:
    "Skips a region that CONTAINS the hit outright unless it is a literal (see " +
    "INLINE_REGION_PATTERNS); straddling one edge still widens, which is the " +
    '"**foo <mark>bar** baz</mark>" case this mechanism exists for. Also ' +
    "scans a WINDOW around each edge (inlineRegionsNear) instead of the whole " +
    "note. Only the two edges of a hit can be unbalanced and no region it " +
    "considers exceeds INLINE_REGION_MAX_CHARS, so a region able to widen an " +
    "edge must begin within that distance of it. Required by the change above: " +
    "this used to run once per highlight only as a last resort, and putting " +
    "eleven regexes over a 4MB note on the fast path is not affordable.",

  // ── EPUB math fidelity (tools/epub-preview-check.mjs proves it on real books) ──
  buildTurndownService:
    "The mathml-tex rule now falls back to mathmlToTex (src/import/mathml-to-tex.js) when a <math> element has no TeX annotation — Nougat books ship dozens bare, and they used to serialize as MathML glyph soup — and sanitizeMathTex strips an unbalanced \\left/\\right pair that KaTeX rejects wholesale. The inline-math rules also append one space when the next element is another inline math span: \"$=$$12$\" reads as a display opener to protectMath and swallowed the prose after it.",
  epubContainerToMarkdown:
    "Folds a display equation's <span class=\"math-tag\">(16)</span> onto the math element as data-tag, so the turndown rule emits it as a real \\tag{16} instead of an orphan \"(16)\" paragraph under the equation.",

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
    "such element. The raw editor's own toolbar is unaffected. Also adopts the " +
    "current text as the undo baseline (syncNotesHistoryBaseline) — opening the " +
    "editor is not an edit, but the history has to know what the text is now so " +
    "the first real keystroke has a previous value to push.",
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

  // ── Long-note containment, and the raw editor's caret ────────────────────
  // Five bodies that drifted as the notes surface grew a chunked, contained
  // layout and a measured caret. All predate the egress work below; they were
  // simply never recorded here.
  resetNotesBlockEstimate:
    "Clears --notes-chunk-estimate as well as --notes-block-estimate. Blocks " +
    "are now grouped into content-visibility wrappers (styles/19-notes-chunks" +
    ".css), and a chunk's placeholder height is its own custom property. " +
    "Resetting only the per-block one left the PREVIOUS note's chunk " +
    "placeholder in place, so a new note's scroll height was sized by content " +
    "it had never been measured against.",
  visualLineTopForOffset:
    "The no-mirror branch returns wrappedLineTopEstimate(textarea, pos) " +
    "instead of the inline newline-counting arithmetic. Both boxes are " +
    "`white-space: pre-wrap`, so a paragraph occupies many visual rows per " +
    "hard break and the old math ignored every one of them — it undershot " +
    "monotonically, which is why the further into a note you triple-clicked " +
    "the further off-screen the caret landed. The estimate models wrapped " +
    "rows and applies them as a RATIO of the textarea's real scrollHeight, so " +
    "a uniform bias in the characters-per-row guess cancels instead of " +
    "accumulating.",
  scrollTextareaToOffset:
    "Takes an optional `measured` caret top. Measuring the caret in a " +
    "textarea is O(offset), and taking it twice a frame apart across a reflow " +
    "is exactly how the scroll and the caret ribbon ended up disagreeing — so " +
    "a caller that has already located the caret hands the number in and both " +
    "halves use the one measurement. Absent it, behaviour is as before.",
  notesHeadingOffset:
    "Measured inside withChunkRendered(). On a chunked note the containment " +
    "sits on the wrapper, so a heading inside a skipped chunk answers with its " +
    "CHUNK's box — the same answer all ~40 of its neighbours give, which is a " +
    "TOC jump landing up to 40 blocks early. Forcing just that one chunk to " +
    "lay out is what makes the answer the heading's own, without un-skipping " +
    "the document the way a full sweep would.",
  scrollNotesEditToHeadingIndex:
    "Sets the caret before focusing, then hands off to revealNotesCaretAt() " +
    "instead of scrolling itself. That is the single entry point for an " +
    "explicit jump: it owns both halves from ONE measurement (where to scroll " +
    "and where to draw the reading band) and re-asserts after the reflow that " +
    "opening the editor causes — the header un-hiding and the browser's own " +
    "focus-time caret reveal both land after a synchronous scroll. It also " +
    "absorbs the dispatched scroll-event nudge this call site used to carry " +
    "alone, so a raw-mode TOC jump now behaves exactly like opening the " +
    "editor from the rendered view.",

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
    "for the decks actually moving. Same rows, same order, fewer columns. " +
    "Also reports progress on BACKGROUND runs, not just explicit ones: the " +
    "Sync Now button's label is the only thing on screen describing the job, " +
    "and it was written once by setButtonLoading as a bare 'Syncing…' and then " +
    "never again — so a sync working through 700 decks looked exactly like one " +
    "that had hung, for as long as it took. The status LINE stays " +
    "explicit-only; it is the app's reply to something the user just did. The " +
    "pull loop counts per deck for the same reason the push loop already did " +
    "(it awaits a lock and a snapshot write each time, so it does yield — the " +
    "note claiming otherwise was wrong). And the pre-flight steps name " +
    "themselves — sign-in, queued note changes, queued images, deck list — so " +
    "a stall before any deck work has an address instead of all four sharing " +
    "one \"Checking the cloud…\".",

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
    "reads a new archive exactly as before. The no-images shortcut return now " +
    "carries all four keys: that split only updated the main return, so a " +
    "library with no images at all handed back two undefined arrays, and the " +
    "caller reads `.length` off both while writing its summary — the archive " +
    "was built, compressed and DOWNLOADED, and then the run reported itself " +
    "failed with \"Cannot read properties of undefined (reading 'length')\".",
  runLibraryBackup:
    "Reports those two counts as two different things. One combined figure " +
    "read as 'N of your images are lost' when most of them were pasted web " +
    "links behaving normally, and only the hosted half is an error condition. " +
    "Also: an empty library is a failed backup when the user pressed the " +
    "button (no file arrived — say so), and a non-event when this is the " +
    "safety step inside a restore (autoClosePanel), where having nothing to " +
    "protect is the successful outcome. It used to report both in red.",
  applyRestore:
    "Skips the pre-restore safety backup when the device holds no decks at " +
    "all. Checked BEFORE the panel opens rather than inside the backup, " +
    "because on a fresh install — the commonest place a restore is run — the " +
    "safety step opened a progress panel, counted to zero and finished on a " +
    "red 'This device has no decks saved yet' that had to be dismissed by " +
    "hand, in front of the restore it was protecting.",

  // ── The sync's silent pre-flight ─────────────────────────────────────────
  // Everything reconcileAllDecks awaits BEFORE it reads the deck list. None of
  // it reported anything, and one piece of it could not end at all — which
  // together are why a sync that had started no deck work looked hung.
  verifiedCloudUserId:
    "getSession() is wrapped in withTimeout. It reads local storage in the " +
    "common case, but on an EXPIRED access token it goes to the network to " +
    "refresh — supabase-js's own call, with no timeout of ours on it. On a " +
    "connection that accepts and then answers nothing it never settles, and " +
    "this is the first thing the reconcile awaits: reconcileInFlight stays " +
    "true forever, the button holds its first label, and no later sync can " +
    "start. A timeout reads as \"couldn't confirm the sign-in\", which is " +
    "already a safe handled outcome (skip the sync, touch no local deck).",
  flushPendingImageUploads:
    "Reports progress, and batches the rewrite. It runs before the deck index " +
    "is read and used to be completely silent, so a backlog here — real " +
    "uploading, potentially hundreds of megabytes of it — showed as a sync " +
    "stuck on its first message with no deck work started. The rewrite is now " +
    "shared across IMAGE_REWRITE_BATCH uploads instead of run per image: " +
    "measured 3415ms -> 242ms for 40 images over a 721-deck library, with the " +
    "upload itself costing nothing. Outbox entries are still dropped only " +
    "after their rewrite lands, so an interrupted flush re-uploads at most one " +
    "batch rather than everything.",
  rewriteLocalImageReferences:
    "Takes a MAP of token -> url rather than one pair. The cursor scan over " +
    "every deck snapshot is the whole cost and it is the same for one " +
    "replacement or fifty, so doing it per image made the flush " +
    "O(images x library). Also rejects a note in one indexOf when it holds no " +
    "recall-img: scheme at all, which is almost all of them, instead of " +
    "testing every pair against it.",

  // ── Reads that only break at a library size the developer never had ──────
  // Both of these worked for every library anyone had tested and failed for a
  // 700-deck one, which is a size you reach in a single step by restoring a
  // backup: every restored deck comes back with lastSyncedAt null, so the very
  // next sync asks the cloud for all of them at once.
  fetchCardsForDecks:
    "Chunked by DECK as well as paged by row. `.in(\"deck_id\", ids)` goes out " +
    "in the URL, and a uuid costs ~46 characters percent-encoded — 200 decks " +
    "is ~9KB, past the 8KB request-line ceiling nginx and most proxies ship " +
    "with, so the server answers 414 and the sync fails outright. The paging " +
    "and its count check moved into readCardPagesForDecks unchanged, so each " +
    "chunk is still verified complete on its own rather than averaged into a " +
    "total that happens to look right.",
  fetchCloudDeckRows:
    "chunkSize 200 -> 25. These are full rows — every deck's entire notes " +
    "markdown — so the chunk is sized by RESPONSE, not by PostgREST's 1000-row " +
    "cap: 200 book-length notes is tens of megabytes against a 20s timeout " +
    "meant for a phone, and the whole chunk then fails, retries once and fails " +
    "again. Extra round trips cost far less than one timeout does.",
  ensureLocalLibraryOwner:
    "Pure extraction, no behaviour change: the wipe is now resetLocalLibrary, " +
    "shared with the explicit sign-out. Both callers must remove exactly the " +
    "same set and the failure mode of them drifting is silent and delayed — a " +
    "leftover tombstone suppresses a deck the next account legitimately owns.",
  openAppInfoModal:
    "Also fills the Supabase project rows (renderSupabaseProjectDetails). The " +
    "health check below them can only report on the project this device is " +
    "configured for, and nothing in the app said which one that was — the URL " +
    "and key are entered once on a setup screen the user never sees again.",

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
  visualLineTopForOffset:
    "it returned the exact measured position OR a completely different " +
    "estimate, with nothing for the caller to tell them apart. Its one caller " +
    "was the caret ribbon, which is the single thing that must never be drawn " +
    "from a guess — a band in the wrong place does not merely fail to say " +
    "where the caret is, it says something false — and the silent swap between " +
    "the two is what made it flicker while typing on ONE line. Replaced by " +
    "exactLineTopForOffset, which returns null instead of guessing (the ribbon " +
    "then stays where it is), plus the estimate's own name where an " +
    "approximation is genuinely correct: measuredCaretTop, because a jump has " +
    "to land somewhere.",
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
  // The chrome ResizeObserver watches the view-mode ROW, not just the toggle
  // inside it, because that is what readChromeHeights measures. The row also
  // holds the TOC button, the edit pill and the ⋯ menu, and those show and hide
  // per view WITHOUT resizing the tabs — so observing only the toggle left
  // --view-toggle-h stale, and .view-mode-row's own
  // `max-height: var(--view-toggle-h)` then clipped its contents. The toggle
  // stays as the fallback for markup without the row.
  [/(if \(appbarEl\) chromeSizeObserver\.observe\(appbarEl\); )(if \(el\.viewModeToggle\) chromeSizeObserver\.observe\(el\.viewModeToggle\); )/,
   '$1const viewModeRow = document.getElementById("viewModeRow"); if (viewModeRow) chromeSizeObserver.observe(viewModeRow); else $2'],
  // One more entry in the My Decks "⋯" menu wiring: Check for broken images
  // (src/backup/broken-images.js). An ADDITION beside the Restore handler
  // above it, not a rewrite of anything — it reports image references whose
  // storage object no longer exists, and touches nothing else in the menu.
  [/(await runRestoreFlow\(file\); \}\); \} )(\})/,
   '$1document.getElementById("myDecksCheckImagesBtn")?.addEventListener("click", () => { closeMyDecksMoreMenu(); runBrokenImageScan(); }); $2'],
  // Signing out now takes the local library with it. The baseline handed the
  // click straight to handleLogout and left every deck on the device: the
  // library is a mirror of ONE account's cloud data, so it stayed readable in
  // My Decks by whoever used the browser next, with no session needed because
  // every read is local. (The account-SWITCH path already wiped it — the
  // sign-out that wasn't followed by another sign-in did not.) Confirmed
  // rather than silent, and the never-synced decks are counted separately in
  // the question, because those are the only ones this can actually cost.
  [/document\.getElementById\("logoutBtn"\)\?\.addEventListener\("click", handleLogout\); /,
   () => 'document.getElementById("logoutBtn")?.addEventListener("click", () => { const index = readLocalDeckIndex(); const total = index.length; const localOnly = index.filter((meta) => !meta.deckId || !meta.lastSyncedAt).length; const signOutAndWipe = async () => { await handleLogout(); try { await resetLocalLibrary(); showToast(total ? `Signed out — ${total} deck${total === 1 ? "" : "s"} removed from this device` : "Signed out", "success"); } catch (error) { console.warn("Could not clear the local deck library on sign-out", error); showToast("Signed out, but the decks on this device could not be removed", "error"); } }; if (!total) return void signOutAndWipe(); showConfirmModal( `Sign out and remove all ${total} deck${total === 1 ? "" : "s"} from this device? ` + "Everything already synced stays in your Supabase project and comes back when you sign in again." + (localOnly ? ` But ${localOnly} deck${localOnly === 1 ? " has" : "s have"} never synced — ` + `${localOnly === 1 ? "it exists" : "they exist"} only on this device and will be gone for good. ` + "Cancel and use My Decks → ⋯ → Backup first if you need them." : ""), () => { signOutAndWipe(); }, { confirmLabel: "Sign out & delete", danger: true } ); }); '],
  // The ⋯ formatting disclosure on the floating selection pill. It exists
  // because the pill became the only formatting surface in the app (see the
  // ACCEPTED entries for createToolbarHtml and applyRenderFormat), which on a
  // phone made its bottom-pinned bar twelve controls over two rows — about
  // 100px of screen sitting on the sentence you had just selected. Collapsing
  // the formatting row behind this halves it. pointerdown + preventDefault like
  // every other control on the pill: a click would dissolve the selection the
  // buttons it reveals are for.
  [/el\.extractNoteFromSelectionBtn\?\.addEventListener\("pointerdown"/,
   () => 'el.selectionFormatToggleBtn?.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); const open = el.selectionFloat?.classList.toggle("is-format-open"); el.selectionFormatToggleBtn.setAttribute("aria-expanded", open ? "true" : "false"); }); el.extractNoteFromSelectionBtn?.addEventListener("pointerdown"'],

  // The notes input handler records a typing step for undo. See the ACCEPTED
  // block for why the browser's own undo was not enough.
  ["state.notes = el.notesEdit.value; notesScrolledSource = state.notes; if (el.exportNotesBtn)",
   "state.notes = el.notesEdit.value; recordNotesTyping(state.notes); notesScrolledSource = state.notes; if (el.exportNotesBtn)"],

  // Notes undo/redo, checked BEFORE the card stack and before the textarea
  // guard — see the ACCEPTED block for why that guard's premise was false.
  ['} return; } if ((event.ctrlKey || event.metaKey) && !event.target.matches("input, textarea") && (event.key === "z"',
   '} return; } const inNotesSurface = state.viewMode === "notes" && (event.target === el.notesEdit || !event.target.matches("input, textarea")); '
   + 'if ((event.ctrlKey || event.metaKey) && inNotesSurface && (event.key === "z" || event.key === "Z")) { event.preventDefault(); event.shiftKey ? redoNotes() : undoNotes(); return; } '
   + 'if ((event.ctrlKey || event.metaKey) && inNotesSurface && (event.key === "y" || event.key === "Y")) { event.preventDefault(); redoNotes(); return; } '
   + 'if ((event.ctrlKey || event.metaKey) && !event.target.matches("input, textarea") && (event.key === "z"'],

  // The mark menu (tap a highlight in the note to recolour or remove it), and
  // the hook that lets an edit made there refresh the Highlights tab without
  // highlight-edit.js importing the panel that owns it.
  ["onDomReady(initNotesCaretLine); ",
   "onDomReady(initNotesCaretLine); onDomReady(initMarkMenu); onDomReady(() => setHighlightsChangedHandler(renderHighlightsPanel)); "],

  // The floating pill waits for the selection GESTURE to finish before it
  // appears. An ADDITION beside the selectionchange registration, not a rewrite
  // of it: the debounce still runs, but positionNotesSelectionButton returns
  // early while a pointer is down. Reported as "the text options spawn almost
  // immediately after I start selecting and not after completing the select",
  // and it is also what took the expensive capture — three fragment clones and
  // two Turndown runs — off the drag's hot path. Capture and pointercancel
  // because a drag routinely leaves the element it started in, and a touch
  // taken over by the scroller never sends pointerup at all.
  // See tools/selection-check.mjs.
  [/(document\.addEventListener\("selectionchange", scheduleNotesSelectionCheck\); )(document\.addEventListener\("selectionchange", \(\) => \{ if \(questionFitDeferredBySelection)/,
   '$1document.addEventListener("pointerdown", (event) => { if (event.target?.closest?.(".selection-float")) return; beginSelectionGesture(); }, { capture: true, passive: true }); ["pointerup", "pointercancel"].forEach((type) => { document.addEventListener(type, endSelectionGesture, { capture: true, passive: true }); }); window.addEventListener("blur", endSelectionGesture); $2'],

  // The font picker moved onto the pill from the raw editor's toolbar when that
  // shrank to three buttons, so the shared [data-render-target] delegation has
  // to see its buttons too — without this they are inert.
  // The font picker for a SELECTION is gone: a per-selection typeface is not
  // something a reading app needs, and the font choices that matter are
  // settings (Style -> Basics, Style -> Notes font) rather than formatting
  // actions. Nothing emits [data-render-font] any more, so the delegation stops
  // looking for it — which is the baseline's own selector, unchanged.
  ["", ""],

  // marked.setOptions is guarded, and the guard is load-bearing. This is
  // module-scope code in the ENTRY module: `marked` being undefined here was a
  // ReferenceError during evaluation of src/main.js, so registerServiceWorker()
  // and bootApp() at the bottom of the file never ran and the page stayed blank
  // — permanently, on that device, because no worker was ever registered to fix
  // the next load either. It was reachable any time cdn.jsdelivr.net was
  // blocked or slow, which is why "the app is not offline friendly" so often
  // meant a white screen rather than a missing feature. The library is vendored
  // now (see tools/vendor-sync.mjs); this makes its absence survivable rather
  // than fatal. See assertBootLibraries in src/core/lib-guard.js.
  [/marked\.setOptions\(\{ breaks: true, gfm: true, mangle: false, headerIds: false \}\);/,
   "if (typeof marked !== \"undefined\") { marked.setOptions({ breaks: true, gfm: true, mangle: false, headerIds: false }); }"],

  // The Prism autoloader points at the vendored grammars. It injects a <script>
  // for a language the first time a code block uses one, so leaving it on the
  // CDN meant syntax highlighting quietly reached the network mid-render — and
  // got nothing at all offline, which is where the other 46 grammars sw.js
  // precached were being spent. tools/vendor-sync.mjs keeps that directory
  // populated and the deploy refuses a vendor URL carrying a ?v= stamp.
  [/Prism\.plugins\.autoloader\.languages_path = "https:\/\/cdn\.jsdelivr\.net\/npm\/prismjs@1\.30\.0\/components\/";/,
   'Prism.plugins.autoloader.languages_path = "vendor/prismjs-1.30.0/components/";'],

  // bootApp() only runs if markdown is actually available. The service worker
  // is still registered on the line above it either way, and deliberately: if a
  // library really is missing, the single most useful thing that load can do is
  // leave behind a worker that has precached the whole app, so the NEXT load
  // works. See assertBootLibraries.
  [/initBackGesture\(\); bootApp\(\);/,
   'initBackGesture(); if (bootLibrariesPresent) bootApp(); else console.error("Boot halted: the markdown libraries are unavailable. See the message on screen.");'],

  // Both handlers that mean "this page may be about to go away" now also flush
  // the batched deck index. A sync holds it in memory between checkpoints (see
  // beginIndexBatch), so a tab that disappears mid-sync would otherwise leave
  // the last few pulled decks with a snapshot in IndexedDB and no index entry
  // naming it — which the next boot's orphan sweep would throw away. Swiping a
  // phone's app away mid-sync is the ordinary way that happens.
  [/window\.addEventListener\("pagehide", \(\) => \{ flushWorkingDeck\(\); revokeLocalImageUrls\(\); \}\);/,
   'window.addEventListener("pagehide", () => { flushWorkingDeck(); try { flushIndexBatch(); } catch (error) { console.warn("Could not flush the deck index", error); } revokeLocalImageUrls(); });'],
  // Written in the BASELINE's form (a bare `lastHiddenAt = …`), because these
  // patterns are applied to the baseline text and compared against the current
  // tree with unroute() having already undone the setter rewrite.
  [/if \(document\.visibilityState === "hidden"\) \{ lastHiddenAt = Date\.now\(\); flushWorkingDeck\(\); return; \}/,
   'if (document.visibilityState === "hidden") { lastHiddenAt = Date.now(); flushWorkingDeck(); try { flushIndexBatch(); } catch (error) { console.warn("Could not flush the deck index", error); } return; }'],
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
