// Cut styles.css into ordered files, without changing the cascade.
//
//   node tools/split-css.mjs          # split, then verify
//   node tools/split-css.mjs --check  # verify only
//
// styles.css is 13,784 lines with three section comments in it, which makes
// finding anything a scroll. Splitting it is worth doing, but a stylesheet is
// not a set of independent parts: later rules beat earlier ones at equal
// specificity, so ANY reordering is a behaviour change that shows up as a
// subtly wrong colour or a broken layout at one viewport width.
//
// So the cut is strictly contiguous. Each file is a slice of the original in
// its original order, loaded by ordered <link> tags, and the verification is
// exact: concatenating the parts must reproduce styles.css byte for byte.
//
// Deliberately NOT done: moving each feature's @media rules next to its base
// rules. There are 34 of them scattered through the file and gathering them
// would read far better — but it reorders the cascade, which is the one thing
// this cannot do while claiming to change nothing.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "styles.css");
const OUT_DIR = path.join(ROOT, "styles");
const CHECK_ONLY = process.argv.includes("--check");

// [start line (1-based, inclusive), file name, what it holds].
// Every start line is the first line of a TOP-LEVEL rule, found with
// tools/css-rules (see the boundaries in the commit that introduced this).
const SECTIONS = [
  [1,     "01-tokens.css",      "Custom properties and the ten themes"],
  [417,   "02-shell.css",       "App shell, layout, and the boot screens"],
  [845,   "03-toolbar.css",     "Top bar, toolbar and the mobile drawer"],
  [1141,  "04-import.css",      "The import panel and its staging preview"],
  [1966,  "05-study.css",       "The quiz panel and the card itself"],
  [2304,  "06-rendered.css",    "Rendered markdown: headings, tables, code, math, diagrams"],
  [3619,  "07-library.css",     "My Decks: rows, tiles, folders, drag and drop"],
  [4400,  "08-panels.css",      "Style panel, cloze panel, restore preview, EPUB preview"],
  [6192,  "09-all-cards.css",   "The All Cards panel and the Cornell layouts"],
  [8541,  "10-editor.css",      "Raw editor, its mirror, and the formatting toolbars"],
  [10230, "11-chrome.css",      "Empty states, Help, App Info, storage"],
  [11612, "12-notes.css",       "Highlights, note links, table of contents, backlinks"],
  [12988, "13-quick-notes.css", "The Quick Notes board"],
];

// Stylesheets in styles/ that are NOT slices of the original, added after the
// split and excluded from the reassembly compare.
//
// The check above answers exactly one question — "did cutting styles.css up
// change any of it?" — and that question stays worth asking forever. But the
// app has to keep being fixed, and a CSS fix written into a slice would fail
// this check with no way to say "yes, on purpose", the way ACCEPTED does for
// tools/split-parity.mjs.
//
// So new CSS goes in a new file, listed here with the reason. The 13 slices
// stay byte-for-byte comparable to what they came from, and a fix is a whole
// file anyone can read on its own rather than eight lines buried in 1,800.
// Anything appearing in styles/ that is neither a slice nor listed here is
// still a failure.
const POST_SPLIT = {
  "14-selection.css":
    "user-select on the app's own chrome. Without it a drag that left the note " +
    "it started in pulled the app's furniture in with it — 370 characters of " +
    "the top bar and the (only off-screen, never hidden) ☰ drawer, or the whole " +
    "notes toolbar when dragging upward. See tools/selection-check.mjs.",
  "15-headings.css":
    "One heading SIZE everywhere markdown renders. .rendered has sized h1-h6 at " +
    "1em since the underline ladder replaced the size ladder, but .qn-card-body " +
    "(Quick Notes board) and .epub-preview-chapter-body (import preview) don't " +
    "carry that class, so the same note's headings fell through to the UA " +
    "defaults — 2em and 1.5em — on those two surfaces alone.",
  "16-mobile-reading.css":
    "The phone reading surface. Four chrome bars stacked above the first line " +
    "of a note; this folds the render toolbar back into the notes header (six " +
    "buttons move behind a ⋯ popover), drops the card counters and the sync " +
    "countdown from the appbar while reading, lets body.chrome-collapsed fold " +
    "the notes header too, and dims the per-image controls on touch screens.",
  "17-toc-fold.css":
    "Foldable table-of-contents sections, folded by default. The list is flat " +
    "(the tree is drawn by rail spans, not by nesting), so there is no child " +
    "list to hide: this is the twisty laid over each branch row's dot cell, " +
    "and [hidden] on the rows JS works out are under a folded ancestor.",
  "18-paged-notes.css":
    "Paged reading mode: the note laid out as pages you turn, one column or " +
    "two, by giving #notesView columns + column-fill:auto and paging it with " +
    "scrollLeft. Also the rules that MUST turn content-visibility off there — " +
    "multicol has to measure every block, and its layout containment would " +
    "stop a paragraph flowing across a column boundary at all.",
  "19-notes-chunks.css":
    "Containment per GROUP of blocks, for notes far too long to lay out one " +
    "block at a time. content-visibility per block still leaves the engine " +
    "tracking one box each — 24,600 of them on a 4.1MB note, measured at 122ms " +
    "per scroll frame against 11ms of our own JS. Grouping takes that to ~600 " +
    "boxes: 122ms -> 17ms per frame, layout 853ms -> 41ms.",
  "20-broken-images.css":
    "The broken-image report (My Decks -> More -> Check for broken images), " +
    "which lists every image reference a deck still points at that no longer " +
    "resolves — a wider shell and a scrolling list, because the rows are full " +
    "storage URLs and there can be hundreds. Also the one rule the finished " +
    "backup panel needs (white-space on .backup-progress-note): missing " +
    "uploads and CORS-blocked web links are separate problems reported as " +
    "separate paragraphs, which collapse into one sentence without it.",
  "21-app-info-project.css":
    "The Supabase project rows in App Info — which project URL, ref, anon key " +
    "and account this device is connected to. Every install brings its own " +
    "backend and nothing in the app would say WHICH one, so a health check " +
    "run against the wrong project read as a broken app. Values are a URL, a " +
    "JWT and a uuid, so the rows stack label-over-value instead of using the " +
    "shared row's baseline-aligned two-column shape.",
  "22-selection-bar.css":
    "The floating selection pill is now the ONLY formatting surface — the card " +
    "faces' persistent render toolbar and the B/I/U half of all three raw-edit " +
    "toolbars are gone, because every button on them refused without a " +
    "selection. That left the pill carrying twelve controls, with two problems: " +
    "a phone-width bar could not show them all, and twelve identical circles in " +
    "a row say nothing about which does what. The first answer was a ⋯ " +
    "disclosure, which put a second tap on exactly the surface with the least " +
    "room to spare; it is gone. Both are answered by grouping instead — five " +
    "categories (capture / mark / style / use / cut) told apart by the space " +
    "between them, every control one press away at every width. Space rather " +
    "than hairlines because the bar genuinely wraps on a phone, and a rule " +
    "drawn before each group lands at the START of any group that begins a row.",
  "25-sync-report.css":
    "The per-phase timing panel in the sync report. \"Sync is slow\" used to be " +
    "unanswerable: the only thing on screen during a run was a button label, so " +
    "40 seconds spent reading deck bodies and 40 seconds spent waiting on one " +
    "stalled request looked identical — to the user and to anyone trying to fix " +
    "it. Collapsed by default, because which decks moved is still the headline. " +
    "See buildSyncTimingHtml in src/sync/report.js.",
  "24-highlight-tools.css":
    "The controls for a highlight that already exists, on the mark itself in " +
    "the note. A highlight used to be something you could read and jump to and " +
    "nothing else: changing its colour or removing it meant going back and " +
    "re-selecting exactly the same words, which the source search cannot " +
    "reliably do once there are tags around them. The menu addresses the mark " +
    "by its ORDINAL, so there is no text matching involved and no way to edit a " +
    "different copy of the same words. See src/notes/mark-menu.js.",
  "23-highlight-marks.css":
    "A highlight must not move the text it highlights. `.rendered mark` carried " +
    "`padding: 0 1px`, and wrapAcrossBlocks emits one mark per line/list item/" +
    "table cell — so a ten-bullet highlight widened its own text by 20px and " +
    "could re-wrap the block. renderNotesViewPinned measures its anchor BEFORE " +
    "the repaint, so that rewrap lands after the measurement and settleNotesPin " +
    "chases the residual for 400ms: the 'everything shivers when I highlight' " +
    "report. Cancels the padding with an equal negative margin (tint unchanged, " +
    "zero net advance) and adds box-decoration-break so a mark broken across a " +
    "wrap or a column break keeps its radius on both fragments.",
  "26-highlights-panel-rows.css":
    "What is left of the Highlights tab's old row layout — the per-row Go to / " +
    "note buttons and the image caps the preview needed. The tab is a " +
    "continuous editor now (44-highlights-editor.css), so the file is down to " +
    "the padding the frozen .highlights-list slice in 12-notes.css cannot be " +
    "given.",
  "27-highlight-notes.css":
    "Note-over-highlight: the mark-menu's Note button, the Highlights panel's " +
    "per-mark note button and rendered note block, and the popup editor " +
    "itself (src/notes/highlight-note-editor.js). Data lives in the " +
    "<mark data-note> attribute (src/format/highlight-notes.js) — no new " +
    "storage, so this file is presentation only.",
  "28-export-highlights.css":
    "The 'Export highlights' dialog (#exportHighlightsModal) — reuses the " +
    ".confirm-modal/.sync-modal-actions chrome other small dialogs already " +
    "have; only the context-size number input and the format row are new.",
  "29-print-safe-rendered.css":
    "Widens .cornell-print-row .rendered's print-safe link/heading/quote/code " +
    "colours (09-all-cards.css) to .cornell-print-document .rendered and " +
    "the new .highlights-export-page wrapper — the notes/highlights print " +
    "and standalone-HTML export paths put rendered content directly under " +
    "those instead of a Cornell row, so it fell through to the live-theme " +
    "screen rules and could render invisible (same colour as the fixed " +
    "print background) when exported from a dark theme.",
  "30-signed-out-chip.css":
    "The standing \"Sign in to sync\" chip. Boot used to answer any session it " +
    "could not confirm — a stalled refresh, a captive portal, a refresh token " +
    "rotated out from under a resumed PWA — by showing the login form, which " +
    "is why the app asked for a password on launch after launch. It now keeps " +
    "the local library open and says so with this chip instead; #syncIndicator " +
    "could not, because it blanks itself whenever no deck is open. See " +
    "tools/session-persistence-check.mjs.",
  "31-touch-selection.css":
    "Text selection on a touch screen. Long press had to be fought and the " +
    "native handles landed in the wrong place: the reading surfaces carried a " +
    "pan-only touch-action, which is the compositor fast path that suppresses " +
    "long-press-to-select and pins a handle to one axis, and the " +
    "content-visibility estimates on notes blocks/chunks re-laid the document " +
    "under the finger the moment a drag reached unread text. Coarse-pointer " +
    "only — selection-check.mjs asserts the mouse path is unchanged. See " +
    "tools/mobile-selection-check.mjs.",
  "32-touch-select.css":
    "The app's OWN touch selection, replacing the native gesture rather than " +
    "accommodating it — 31-touch-selection.css above did the accommodating and " +
    "the report after it shipped was its ceiling: a 3-4 second wait for a " +
    "press to become a selection (Android's long press is main-thread gated, " +
    "so no amount of the app doing less makes it deterministic) and handles " +
    "that still landed off the text (they are drawn from a layout snapshot, " +
    "which every content-visibility estimate resolving mid-drag invalidates). " +
    "So: user-select: none on the reading surfaces to take the gesture off the " +
    "browser, ::highlight(recall-touch-selection) to paint the selection in " +
    "the same layout pass as the text it covers, and two handles positioned " +
    "from the same live Range the highlight is painted from. Every rule is " +
    "under body.has-touch-select, added ONLY by arm() in " +
    "src/notes/touch-selection.js when canTouchSelect() passes — a desktop " +
    "never gets the class and so never reaches a declaration in this file. " +
    "See tools/touch-selection-check.mjs.",
  "33-reading-chrome.css":
    "The reading room's own chrome, quieted at EVERY width. " +
    "16-mobile-reading.css made this argument for a phone, where four stacked " +
    "bars over a 757px viewport made it unarguable; a laptop has the pixels, " +
    "which is why nothing was ever done about it. Measured on a 1280x800 " +
    "window with a note open: two bars and ~96px, of which the reader is using " +
    "the tabs — the rest is a card score for cards they are not looking at, a " +
    "sync countdown ticking once a second, a headline-weight title and a " +
    "filled category pill. While the quiz panel is in notes-mode (and only " +
    "then) the counters and countdown go, the title and category become text, " +
    "the two edit pencils wait for a pointer, and the tabs lose their frame. " +
    "Also the immersive-mode button's own pressed state, and the background " +
    "the root element paints in fullscreen.",
  "35-notes-menu.css":
    "The notes \u22ef menu as ten sentences rather than ten glyphs. It shipped " +
    "as a tray of icon buttons \u2014 two of them the same bookmark drawing, " +
    "filled and not \u2014 whose only explanation was a `title` that a phone " +
    "has no way to show, and whose three MODES said nothing about being on or " +
    "off. Each button is a row now: icon, the sentence in .nhm-label, and for " +
    "the modes a switch drawn from aria-pressed, under headings built from " +
    "data-nhm-group. The labels are displayed only inside the menu, so a " +
    "button that has not been moved there is still the icon button it was. " +
    "See src/notes/notes-head-overflow.js.",
  "36-document.css":
    "The Document surface \u2014 a PDF rendered page by page by pdf.js, in " +
    "three stacked layers whose ORDER is the whole design: the canvas at the " +
    "bottom, the highlights over it, and a transparent text layer on top that " +
    "is what makes native selection work over a canvas at all. Highlights use " +
    "the same four colour tokens as a <mark> at the same mix ratios, so one " +
    "palette covers both surfaces. Dark themes invert the CANVAS only \u2014 " +
    "inverting the page would turn a yellow highlight blue. " +
    "See src/documents/pdf-view.js.",
  "37-document-chrome.css":
    "Everything AROUND the PDF page, and it exists because a PDF deck is the " +
    "first deck with four tabs. `.view-mode-toggle` hardcoded three grid " +
    "columns, so Highlights wrapped onto a second line and grew the row that " +
    "focus mode animates; and the rule that stands the notes controls down " +
    "where they mean nothing covered Cards and Highlights but not Document, " +
    "so a table-of-contents button for a note nobody was reading and a " +
    "raw/rendered toggle for markdown that does not exist both sat there " +
    "doing nothing. The toggle counts its own tabs here, the document controls " +
    "take the notes controls' place in the same row, the page number and zoom " +
    "float over the page instead of above it, and region highlights are drawn " +
    "as an outline rather than tinted \u2014 a 35% multiply over a photograph " +
    "washes out the figure being highlighted. " +
    "See src/documents/pdf-region.js and src/documents/pdf-page-notes.js.",
  "38-reading-rail.css":
    "The rail focus mode gives back. body.chrome-collapsed folds the appbar " +
    "and the view-mode row away, which is the point of it and also takes the " +
    "contents, the four views and the way back to My Decks with them \u2014 so " +
    "changing tab meant leaving focus mode and re-entering it. A nine-pixel " +
    "grip on the right edge (the left is the back gesture's, and the text is " +
    "the selection handles') expands into seven icon buttons and puts itself " +
    "away again. display:none outside focus mode, because every one of those " +
    "controls is already on screen in the row above when the chrome is not " +
    "folded. The grip is a \u263c-sized \u2630 rather than the original " +
    "nine-pixel stripe: a 26%-alpha tint has no background it reliably " +
    "contrasts with over an arbitrary PDF page, right:0 lands it on the " +
    "scrollbar, and top:50% is the one band the eye does not sweep. " +
    "See src/ui/reading-rail.js.",
  "39-document-export.css":
    "The Document surface's own export: the paper, with your notes on it. One " +
    "sheet per page, the page as an image rasterised by pdf.js with its " +
    "highlights painted on, and that page's notes printed underneath in two " +
    "columns \u2014 the same packing the on-screen strip uses, for the same " +
    "reason. Printed through the existing pipeline (installPdfPrintStyle), so " +
    "what is here is only what that pipeline cannot know. Fixed --print-* " +
    "colours throughout, like 28-export-highlights.css: this content can land " +
    "in the standalone HTML path, which inlines the LIVE theme around it, and " +
    "a dark background under a white scanned page reads as a printing fault. " +
    "See src/documents/pdf-export.js.",
  "40-image-controls.css":
    "Resize and delete controls that are usable on an image of ANY size. The " +
    "shell hugs its picture, so on a thumbnail the grip, the delete button and " +
    "the Zoom pill were painted on top of each other and on top of the image \u2014 " +
    "which is what 'small images have no controls' looks like. A tiny shell " +
    "gets a size floor and a compact layout for the three, and the two controls " +
    "that EDIT come back up from the 45% touch dim that 16-mobile-reading.css " +
    "applies to all three.",
  "41-image-compress.css":
    "The 'choose a compression level' dialog every image upload now goes " +
    "through, and the same level picker inside the EPUB import preview. Frame " +
    "borrowed from .category-choice-modal (08-panels.css) \u2014 the app's one " +
    "modal shape; what is here is the level row, the folded Advanced sliders, " +
    "and the per-file before/after list.",
  "42-highlight-badge.css":
    "The number on a highlight that has a note, and the dotted underline that " +
    "says one is there. It was a ::after tinted --accent-strong, which a " +
    "pseudo-element makes unpressable and unfocusable, and which vanished over " +
    "a yellow or pink tint on the dark themes — a colour-mixed background is " +
    "not something a single ink can be guaranteed to read on. It is an opaque " +
    "chip in --accent-contrast now, and a real <button>, kept out of flow so " +
    "it still moves the text by zero pixels. See src/notes/highlight-badges.js.",
  "43-drawer-highlights.css":
    "A Highlights section in each reading panel's contents drawer, so a reader " +
    "inside the Notes panel or the Document panel can find what they marked on " +
    "THAT surface without leaving it for the Highlights tab — which on a PDF " +
    "deck lists the paper's highlights and the deck note's together. A switch " +
    "row under the drawer head and a second scroll pane beside the contents " +
    "list; the drawer itself is a frozen slice and is not touched. See " +
    "src/panels/drawer-highlights.js.",
  "44-highlights-editor.css":
    "The Highlights tab as an editor: every highlight in reading order, grouped " +
    "by page or by chapter, its note under it and editable where it sits. " +
    "Arrived as the .doc-note* rules in 34-inline-highlight-notes.css, which " +
    "styled a PDF deck's Notes tab — the right surface at the wrong address, " +
    "since that tab is where the reader's own writing belongs. Renamed with the " +
    "move; a rule called .doc-note on a surface that is mostly not a document " +
    "reads as a leftover. See src/panels/highlights-editor.js.",
  "45-toc-rows.css":
    "One row class, two elements, and only one of them was ever styled. " +
    "src/notes/toc-tree.js builds a note's heading as an <a href> and a PDF's " +
    "page as a <button> (a page has no URL to link to), and .notes-toc-link in " +
    "the frozen 12-notes.css resets none of the user-agent button styling it " +
    "sits on top of \u2014 so a document's contents rendered as a stack of " +
    "ButtonFace-grey pills, each shrink-wrapped to its own title, text centred, " +
    "and the page numbers (margin-left:auto, in a box with no spare width) " +
    "never forming a column. The reset, the type ladder and the states, applied " +
    "to both drawers. Also re-centres the fold twisty, which 17-toc-fold.css " +
    "positions against the row's padding alone and so misses the border and the " +
    "flex gap between that padding and the dot it stands in for.",
  "46-highlight-cycle.css":
    "Side by side: the reading surface and the highlights made on it, in one " +
    "panel. \"The highlights view section, the numbering \u2014 visually they " +
    "are far detached from each other; one has to click the numbers then only " +
    "be able to see it.\" A highlight lived on the page and its note lived in " +
    "the Highlights tab, and a tab is somewhere you go INSTEAD of the page. " +
    ".quiz-panel is already a grid holding the four surfaces as siblings, so " +
    "this is a second and third track on that grid rather than a new container " +
    "\u2014 nothing is reparented, which matters because .pdf-page's " +
    "offsetParent is .document-stage and every highlight on a paper is " +
    "positioned against it. The tracks are `fr` and not per cent: a percentage " +
    "would divide the whole panel rather than the part being split, which came " +
    "out at 65:35 and made a drag drift away from the finger. Two columns above " +
    "720px, two rows below it \u2014 390px halved is two thumbnails. " +
    "See src/panels/highlight-cycle.js.",
  "47-broken-image.css":
    "\"The image is not visible.\" Every upload path writes ![](url) with an " +
    "EMPTY alt and #notesView .diagram-shell img:not(.has-custom-size) forces " +
    "width:auto, so an <img> whose source cannot be fetched paints NOTHING \u2014 " +
    "measured in Chrome at 393px against these stylesheets, the element " +
    "computes to 0x0 and its shell collapses to 82x50: an empty rounded box " +
    "holding only the Zoom pill. And inside a box that small the three " +
    "controls overlap each other (grip at 60,28; delete at 56,4; pill at " +
    "11,11). A failed image now gets a floor, a dashed box and a label naming " +
    "which picture it was, drawn on the SHELL because .diagram-shell img's " +
    "!important widths in the frozen 06-rendered.css can only be out-specified " +
    "per view id. Also carries the surface-agnostic .is-editable-image rule " +
    "that replaces three copies of \"move the Zoom pill aside when there is a " +
    "grip\" \u2014 written once per view in 06-rendered.css, 27-highlight-notes.css " +
    "and 44-highlights-editor.css, which is how a new editable surface kept " +
    "shipping without image controls. See src/images/broken.js.",
  "48-reading-chrome.css":
    "\"There are three different hamburger items that may confuse the user.\" " +
    "There were, and they were not three copies of one control — the app " +
    "menu, the contents drawer and the reading rail wore one glyph between " +
    "them. ☰ keeps the app menu; the contents drawer gets a contents glyph " +
    "(its bars are drawn in the frozen 12-notes.css, so the span is stood down " +
    "here and an <svg> sibling replaces it) and the rail gets a chevron " +
    "edge-tab in 38-reading-rail.css. Also the other three surfaces the same " +
    "report named: the EPUB dialog, whose .category-choice-shell has no " +
    "max-height and no scroller so Import fell off the bottom of a phone; the " +
    "selection bar, which mixed colour-font emoji with drawn icons across a " +
    "scatter of circles; and the highlight menu, which was six 20px targets " +
    "and no words.",
  "49-highlights-only.css":
    "The second WIDTH the highlights pane has: the same cards and the same " +
    "editor, holding the whole panel instead of one track beside the reading " +
    "surface. Reading back what you marked was only possible with the page " +
    "taking three fifths of the screen, and the Highlights tab that used to " +
    "answer that is deliberately gone — it was a VIEW, reached by leaving the " +
    "paper. This is not: state.viewMode, the deck and the stage's place in the " +
    "DOM are all untouched, so pageOffsetTop() and everything else that reads " +
    "them is unaffected. Collapses .quiz-panel's split grid to one track and " +
    "hides the stage and the divider, carries the .hc-wide switch that sets " +
    "it, and lays out the drawer's two ways in as one row. See splitMode in " +
    "src/panels/highlight-cycle.js.",
  "50-image-width.css":
    "A committed image width, on the first paint. The width lives on the tag " +
    "as an inline `--notes-img-w` and an inline `width`, and a non-important " +
    "inline width loses to 06-rendered.css's `img:not(.has-custom-size) { " +
    "width: auto !important }` — so a resized picture painted at its OLD size " +
    "until enhanceSurfaceImageControls added the class, which on a big note " +
    "waits for an idle callback with a 300ms backstop. That is the snap-back " +
    "on letting go of the grip, and the flash on opening any note that was " +
    "resized before today. Keyed off the property rather than the class so it " +
    "fixes the widths already written into people's notes as well as the ones " +
    "written from now on.",
};

// styles.css itself is gone once the split has been applied, so the baseline
// comes from git — the point of the check is that styles/ still reassembles to
// the stylesheet the app shipped with before any of this began.
// The baseline is the TAG pre-modular, not a branch. It used to default to
// `main`, which stopped meaning anything the moment the restructure landed
// there — main became the thing under test, and the comparison had nothing
// left to compare against.
const BASE_REF = (process.argv.find((a) => a.startsWith("--base=")) || "--base=pre-modular").slice(7);
const source = existsSync(SOURCE)
  ? readFileSync(SOURCE, "utf8")
  : execFileSync("git", ["show", `${BASE_REF}:styles.css`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
const lines = source.split("\n");

// A boundary should carry the comment block sitting directly above it — that
// comment explains the rule it precedes, and leaving it at the end of the
// previous file strands it.
//
// It has to carry the WHOLE block, and the first version of this did not. It
// walked up while each line "looked like a comment" — started with `/*` or `*`,
// or ended with `*/` — which is wrong for the style used throughout this
// stylesheet, where continuation lines are indented prose with no leading `*`:
//
//     /* ── Headings: one system, six variations ─────────────────
//        Every level is body-sized (font-size: 1em) — deliberately.
//        …
//        headings (card faces, cloze context) must therefore hide ::after — see
//        `.card-question .rendered` and `.cloze-item .cloze-ctx` below. */
//     .rendered :is(h1, h2, h3, h4, h5, h6) { font-size: 1em; … }
//
// It pulled back exactly ONE line (the one ending `*/`) and stopped at the
// unindented prose above it. The comment was then split across two files: the
// opening `/*` stayed at the end of 05-study.css (harmless — an unterminated
// comment at EOF) while its closing line landed at the top of 06-rendered.css
// as bare text. A stylesheet is parsed per file, so that orphan is not a
// comment there: it becomes part of the SELECTOR of the rule beneath it, and an
// invalid selector drops the whole rule.
//
// The rule dropped was `font-size: 1em` on h1–h6. Every heading in every note
// silently fell back to the UA sizes (h1 2em, h2 1.5em) while the ::after
// underline ladder immediately below it — a separate, still-valid rule — kept
// applying. The same thing happened at the 07-library.css boundary.
//
// So: when the line above ends a block comment, walk up to the line that OPENS
// it and take the lot.
function pullBackComments(startLine) {
  const i = startLine - 1;             // 0-based index of the boundary line
  let j = i;
  for (;;) {
    let k = j;
    while (k > 0 && !lines[k - 1].trim()) k--;   // skip blank lines above
    if (k === 0) break;
    const above = lines[k - 1].trim();
    if (!above.endsWith("*/")) break;
    // Walk up to the `/*` that opened it. Required to be the first thing on its
    // line, so a trailing `color: red; /* note */` is never mistaken for one.
    let start = k - 1;
    while (start > 0 && !lines[start].trim().startsWith("/*")) start--;
    if (!lines[start].trim().startsWith("/*")) break;
    j = start;
  }
  // Don't drag a trailing blank line along with it.
  while (j < i && !lines[j].trim()) j++;
  return j + 1;
}

const bounds = SECTIONS.map(([line], k) => (k === 0 ? 1 : pullBackComments(line)));
for (let k = 1; k < bounds.length; k++) {
  if (bounds[k] <= bounds[k - 1]) {
    console.error(`Section ${SECTIONS[k][1]} starts at or before the previous one.`);
    process.exit(2);
  }
}

const parts = SECTIONS.map(([, name, blurb], k) => {
  const from = bounds[k];
  const to = k + 1 < bounds.length ? bounds[k + 1] - 1 : lines.length;
  return { name, blurb, body: lines.slice(from - 1, to).join("\n"), from, to };
});

// The whole point: the parts must reassemble into exactly the original.
const rebuilt = parts.map((p) => p.body).join("\n");
if (rebuilt !== source) {
  console.error("Reassembly does not match styles.css — refusing to write.");
  let i = 0;
  while (i < rebuilt.length && rebuilt[i] === source[i]) i++;
  console.error(`first difference at byte ${i}:`);
  console.error(`  original: ${JSON.stringify(source.slice(i - 60, i + 60))}`);
  console.error(`  rebuilt : ${JSON.stringify(rebuilt.slice(i - 60, i + 60))}`);
  process.exit(1);
}

if (CHECK_ONLY) {
  if (!existsSync(OUT_DIR)) { console.log("styles/ does not exist yet."); process.exit(0); }
  const onDisk = readdirSync(OUT_DIR).sort().filter((f) => f.endsWith(".css"));
  const slices = onDisk.filter((f) => !(f in POST_SPLIT));
  const added = onDisk.filter((f) => f in POST_SPLIT);
  const stray = slices.filter((f) => !SECTIONS.some(([, name]) => name === f));
  if (stray.length) {
    console.log(`styles/ has ${stray.length} file(s) that are neither a slice nor listed in POST_SPLIT: ${stray.join(", ")}`);
    process.exit(1);
  }
  // Each file carries a three-line banner that is not part of the stylesheet.
  const joined = slices
    .map((f) => readFileSync(path.join(OUT_DIR, f), "utf8").replace(/^\/\*[\s\S]*?\*\/\n/, ""))
    .join("\n");
  const ok = joined === source;
  console.log(ok
    ? `styles/ reassembles to ${BASE_REF}:styles.css exactly (${slices.length} files, ${source.split("\n").length} lines)`
      + (added.length ? `, plus ${added.length} added since: ${added.join(", ")}` : "")
    : `styles/ does NOT reassemble to ${BASE_REF}:styles.css`);
  if (!ok) {
    let i = 0;
    while (i < joined.length && joined[i] === source[i]) i++;
    console.log(`  first difference at byte ${i}`);
    console.log(`    expected: ${JSON.stringify(source.slice(i - 50, i + 50))}`);
    console.log(`    got     : ${JSON.stringify(joined.slice(i - 50, i + 50))}`);
  }
  process.exit(ok ? 0 : 1);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const p of parts) {
  const banner = `/* ${p.blurb}\n * Part of the split styles.css — see tools/split-css.mjs. Order matters.\n */\n`;
  writeFileSync(path.join(OUT_DIR, p.name), banner + p.body);
  console.log(`  ${p.name.padEnd(20)} lines ${String(p.from).padStart(6)}–${String(p.to).padEnd(6)} (${p.to - p.from + 1})`);
}
console.log(`\n${parts.length} files, ${lines.length} lines, reassembly verified byte-for-byte.`);
