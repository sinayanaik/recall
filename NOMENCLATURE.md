# Nomenclature

What things are called in Recall, and where each name lives in the data and the
code. Use these words in the UI, in the Help guide, in bug reports and in
commit messages.

## The five words

The library holds **files**. Each file has up to four **parts**, one per tab:

| Say | Meaning | Tab |
|---|---|---|
| **File** / **Files** | One item in the library: what you open from Home or My Files, rename, move between folders, sync, back up and share | — |
| **Cards** | The file's question/answer flashcards | ▢ Cards |
| **Notes** | The file's one Markdown document | 📝 Notes |
| **PDFs** | The PDF documents attached to the file (papers, books), read and highlighted in place | 📄 PDFs |
| **Canvas** | The file's handwritten pages: blank paper you write on with a pen, plus blocks and pictures | ✎ Canvas |

"Folder" (a file's category path), "Quick Notes", "Highlights" and "Clozes" keep
their names.

Any two parts of one file can be on screen at once, **side by side** (the split
button beside the tabs, or the reading rail's row): the part **in focus**, whose
tab is lit and whose tools are in the tab row, and the part **beside** it. Say
"Notes beside the PDFs", not "a second tab" or "a split view". In the code the
part in focus is `state.viewMode` and the part beside is `state.splitPart`
(`src/ui/split-parts.js`); the PDFs and the Canvas side by side are two
document stages, `#documentStage` and `#documentStageAlt`
(`src/documents/doc-scrollers.js`). The Highlights pane is still called
"Side by side" in the contents drawer — it is the other thing that takes the
same column, and the two never share it.

## On a page

What goes on a PDF's or a Canvas's page. It is put there from the top row,
beside ✎ — not from inside the pen's bar: **Insert** (＋, it was the Block
button, and before that Text) puts a Block, a shaped Block or a Picture where
you tap next (`src/documents/block-place.js`), and **Shapes** arms the Shapes
tool and picks which one (`src/ui/ink-rail.js`). A Block opens to type in, in
place (`src/documents/pdf-block-inline.js`), and a double-click or double-tap
on a Block (or Enter on a picked-up one) opens it again; a single click only
picks it up. A Canvas's pages are added, duplicated, moved and torn out from
⋯ → Canvas pages, and ＋□ beside the page number adds one after the page in view
(`src/documents/notebook.js`). **＋ Page**, the pill in the gap under every
Canvas page, inserts a blank page right there, between that page and the next
(`appendPageInsertButton` in `src/documents/pdf-view.js`; `data-page-chrome`
keeps the page's tools off it). Each Canvas page shows its **page number**,
"k / n", at its foot, and the Canvas PDF export prints it in the same place;
⋯ → Canvas pages → Page numbers turns it off (`meta.notebook.pageNumbers:
false`; `CANVAS_NUMBER_SIZE` / `CANVAS_NUMBER_BASELINE` in
`src/documents/pdf-export.js`). **Page setup** (⋯ → Canvas pages → Page setup…, or **Page setup…** on the
empty Canvas tab before the first page) sets a Canvas page's size and
orientation, its **paper** (Blank, Ruled, Grid, Dot grid or Cornell, and the
paper's colour), its **lines** (spacing, colour, strength, thickness, style,
the heavier grid line, dot size, the margin line, the Cornell columns) and the
**margins** the pattern is drawn inside — for **this page** or **all pages**. A
page added after a page copies its setup. Say "page setup" or "paper", not
"template" or "page style". Data: `meta.notebook.setup` (every page without its
own) and `meta.notebook.pageSetups` (`{ "<page>": setup }`), lengths in PDF
points; both absent is a Canvas never set up, drawn from `meta.notebook.paper`
exactly as before. A page of any size keeps its top-left corner at user point
(0, 842) and its lines on a lattice from (0, 0), so nothing written on a page
moves when it is resized.

A page's size follows what is on it (`setup.fit`). Every page **grows as
needed** (`"grow"`, and what a page with no `fit` does — a `"fixed"` written by
one early build too): longer or wider by just enough — an inch past what is on
it, in inch steps — when a Block, a shape or a picture is put past its right
edge or its foot, or the pen writes near it (within half an inch: a pen cannot
write past the paper), never smaller than its size; its top-left corner never
moves, and it changes no byte of the page until it has grown. A page that has
grown shows its **original size** — where it was set up to end, edged dashed in
the accent on the sides it grew, "Original size" in the corner
(`.pdf-page.is-grown::before` in `styles/53-handwriting.css`, set by
`markCanvasPageGrowth` in `src/documents/pdf-view.js`) — and that edge is the
line: everything taken back inside it, even by a little, and the page is its
size again (the pen's half inch apart). Say "original size", not "boundary",
"border" or "base size". Switched off (Page setup's **Grows as needed**, or ⋯ →
Canvas pages → **Pages grow as needed** for every page) a page is **set to its
size** (`"set"`). **Boundless** (`"boundless"`, beside Portrait and Landscape)
is a page with no size: what is on it with room round it on every side, its
setup's size only where it starts; it has no page number, no margins and no
Cornell paper, and its PDF page (and its web page) is cut to what is on it.
Say "Boundless", not "infinite canvas", "sizeless" or "whiteboard"; say "grows
as needed", not "auto-extend".

While something is dragged past the edge of a page that grows, the page shows
where it will reach — its paper carried on to a dashed edge, **Page grows** at
the corner (`src/documents/page-grow-preview.js`) — and grows the moment it is
let go. **The pointer decides the page**: with the pointer still on the page,
what hangs past its foot makes it longer; carried on until the pointer is over
the next page, it goes there, and that page is outlined as where it lands
(`is-drop-target`). Nothing moves the next page while a drag is on, so it can
always be reached.

Where each page reaches is `meta.notebook.pageBoxes` (`{ "<page>": [x0, y0, x1,
y1] }`, only for a page past its set size), worked out from what is on it, so
an undo takes the room back and two devices draw the same file; only a page
something was done to since the Canvas was opened is fitted, so a page written
to its foot before pages grew is not grown by opening it.
`meta.notebook.boxSha` is the hash of the bytes drawn knowing those boxes. A
page that grows is redrawn in place — only that page, the reader held still
(`swapOpenCanvasBytes` in `src/documents/pdf-view.js`) — and the Canvas is
fitted to the screen by each page's set width, so growing never zooms it out.
Code: `src/documents/canvas-extent.js` (the numbers, pure),
`applyCanvasPageExtents` / `scheduleCanvasExtentFit` / `setNotebookPagesGrow` in
`notebook.js`; a page too big for one picture is exported in tiles
(`canvasExportTiles` in `src/documents/pdf-export.js`). Code: `src/documents/canvas-setup.js` (the numbers,
pure), `src/documents/canvas-setup-dialog.js` (the dialog),
`setNotebookPageSetup` in `src/documents/notebook.js`, `buildBlankPdf` in
`src/documents/blank-pdf.js`. Picked-up Blocks are **copied** (or cut) from
their strip or the bar over several, and pasted onto any page of the same part
with Insert → **Paste blocks** or Ctrl+V (`copyPickedByButton`, `pastePicked` in
`src/documents/canvas-selection.js`). With the mouse over a page, Ctrl+V puts
copied Blocks, shapes and lassoed ink there, **centred on the mouse**; another
Ctrl+V without moving it is stepped 16 pt on, so copies never stack. With no
mouse over a page (touch, Insert → Paste blocks, the pen bar's paste) they land
beside the originals. The **middle mouse button** held over a PDF's or a
Canvas's page **pans** it, and swallows the paste a middle click fires on Linux
(`src/documents/middle-pan.js`); say "pan", not "scroll-drag".

| Say | Meaning | Data | Code |
|---|---|---|---|
| **Block** | A box of markdown — words, maths, code, tables and pictures — rendered like a note, written in where it is, dragged, resized from any edge or corner, and **turned** by the round handle over it (or Arrange → Turn 90°). Its height follows its words until its height is dragged — a top or bottom edge, or a corner dragged mostly up or down, to more room than the words need — and then it is the reader's (`style.fit: false`), still growing when the words need more; a corner dragged mostly sideways sets only the width. Its width is its words' too: as it is typed in, and whenever its words are drawn, it is as wide as its longest line — growing with the words and drawn in when they are cut — up to a little short of the page's right edge on a PDF, or the **widest a Block grows** on a Canvas (below), where they wrap and the height takes over. No resize corner is painted; the edges and corners still resize it. A width dragged by hand is the reader's: kept when it is typed in again, the words wrapping at it. A new Block takes the last Block's look but never its height. Arrange → **Fit to words** (or a double-click on a resize handle) brings one back to its words. It is always typed left-aligned; its alignment shows once the words are down. Not "text block": it holds more than text. Insert → Block and a tap; with a mouse, the **T** or **B** key or a double-click on bare paper (never a pen's) puts one at the pointer; words pasted (Ctrl+V) onto the page become one there | a record in `meta.pdfBlocks`; `kind` `"text"` (or none) is markdown; a turn is `rot`, degrees counter-clockwise; `wHand` says the width was dragged by hand (a `wSet` from older builds is dropped); `wBal` that it is balanced; `from` where To the Canvas made it from | `src/documents/pdf-blocks.js` (`PDF_BLOCK_MARKDOWN`), `pdf-block-inline.js`, `pdf-block-editor.js` (Full editor); `src/documents/page-pointer.js` |
| **Picture** | A block that is a picture alone, from Insert → Picture… or Paste picture, or pasted (Ctrl+V) or dropped onto the page — its top-left corner where the mouse is; compressed first, as a note's picture is | a `meta.pdfBlocks` record with `kind: "image"` and a `src` | `PDF_BLOCK_IMAGE`; `addHandwritingImages` in `src/handwriting/board.js`; `src/documents/page-pointer.js`, `page-clipboard.js` |
| **Block shape** | A Block's outline in a diagram — rectangle, rounded, pill, ellipse, diamond, hexagon, parallelogram, cylinder or document — from Insert's palette or Style → Shape. Still a **Block**: say "a diamond block", not "a shape", which is the Shapes tool's | `style.shape` (with `line`, `lineWidth`, `lineDash`, `valign`) on a `meta.pdfBlocks` record | `src/render/node-outlines.js`; `paintBlockOutline` in `pdf-blocks.js` |
| **Connector** | A line or an arrow whose ends are tied to the Blocks (or Shapes-tool boxes) it joins, so it follows them: made from a picked-up Block's four arrows, or by drawing or dragging a line's end onto one | a line/arrow shape in `meta.pdfHighlights` with `ends` (and `route`, `exits`, a bend in `p[2]`, an elbow's corners round what is in its way in `via`, words in `text`) | `src/documents/pdf-connectors.js`; the page's connectors laid out together — sides, shared-out ends, routes — in `src/render/connector-route.js`; `connectorPath` in `src/render/annot-shapes.js` |
| **A card of a spot** | A card whose answer is a live picture of a box on a page — of a PDF, or of the Canvas — drawn from the page each time it is shown, with whatever is on the page inside the box. Made by **Card** on the lasso's bar, a picked-up Block's strip and the bar over several picked, or by **Make a card** in the menu of ▣'s box or any mark. Say "a picture of that spot of the Canvas", not "a screenshot": nothing is kept but where the box is | `![](pdfref:<page>:<x0>,<y0>,<x1>,<y1>[:<pdfId>[:<width>]])` in a card or the notes; the reserved pdfId `canvas` names the Canvas, and its page numbers follow the Canvas's pages when they are added, moved or torn out | `src/documents/pdf-region-embed.js` (`CANVAS_REF_ID`, `remapCanvasRefs`); `src/documents/region-card.js` |

Words typed with the old **Text** tool (before the Block button, now Insert, replaced it) are
still on their pages, shown and edited as they were: a shape with
`type: "text"` in `meta.pdfHighlights` (`src/documents/pdf-shapes.js`,
`pdf-shape-text.js`). Nothing new is made that way, so the UI calls them "words
typed on the page", never a kind of thing to add.

A **sticky note** is one of the Shapes tool's shapes (with lines, arrows, boxes,
ellipses and callouts), not a row of Insert.

**View only** is the 👁 half of the ✎ | 👁 pill beside the tabs on the PDFs
and the Canvas — the same pill Notes has. On it the page is read, scrolled,
zoomed, selected, highlighted and made into cards, and nothing on it is drawn,
moved, resized, added, pasted or undone. Each part has its own, kept on this
device and never synced: `recall:view-only-v1` in localStorage,
`src/documents/view-only.js` (`documentViewOnly`), the body classes
`view-only-doc` / `view-only-notebook`, and `styles/a1-view-only.css`. Say
"View only", not "read-only" or "locked".

Several Blocks and shapes **picked up** together (Shift-click, a box drawn on a
Canvas with the Select tool, Ctrl+A) are moved, lined up, copied and **grouped**
as one; a group is a `group` id on each record (`src/documents/canvas-selection.js`).
A Block, a Picture, a shape or several picked up together are **dragged onto
another page** of the same part by letting go of them over it — the record's
`page` changes, one undo step; a connector on the page they left lets go of an
end tied to something that moved, and goes with them when both its ends did
(`src/documents/page-handoff.js`; `connectorChangesForPageMove` in
`src/documents/pdf-connectors.js`). Lassoed handwriting still stays on its page.
The thin lines a drag snaps to are **guides**, and grid paper's squares (and a
dot grid's dots) are the **grid**, at each page's own spacing
(`src/documents/pdf-guides.js`, `src/render/snap-guides.js`).

**The Canvas's type** is ◐ on the Canvas: **Blocks**, **Headings**, **Code** and
**Labels** — the last being every other word on a Canvas page: Shapes text
boxes and callouts, a connector's words and the page numbers. Say "labels", not
"annotations" or "captions". Data: the `canvas*` keys of the style profiles
(`src/ui/style-schema.js`, scope `handwriting`), applied as `--canvas-*` and
mapped onto the stage's `--doc-*` names in `styles/79-tab-text.css`; the rules
are `styles/a3-canvas-type.css`. A Block's own **Style → More** wins over them:
Heading face, Code face, Weight, Lines and Letters, **Padding** (top, right, bottom, left, in points; empty is 6, `style.padTop` … `padLeft`), and the **Headings** chip
tab beside Fill and Text — `headFont`, `codeFont`, `weight`, `lineHeight`,
`letterSpacing` and `headInk` in its `style`, which is stored as only what was
set (`compactBlockStyle`, `src/documents/block-style.js`). The theme's colours
on a page are its **accents made readable on the paper** — the same hue, lighter
or darker (`src/format/paper-palette.js`); say "the theme's colour", not "the
accent".

A Block that follows its words grows with its longest line only as far as the
**widest a Block grows** — ◐ Canvas → Blocks, a share of the page's width (62%
unless set; `canvasBlockMaxWidth`, held by `src/documents/block-measure.js`) —
and wraps there; code may run to the page's edge. Pasted words keep to it too.
Once its words are longer than a comfortable line (about 16 ems, 30–35
characters), a Block on a Canvas is **balanced** (◐ Canvas → Blocks → **Block
width**, `canvasBlockWidthRule`: "auto" is Balanced, "longest" the old Longest
line): wrapped at that line while the words are few, then laid out in a box near
3:2, widening with the square root of how much is in it rather than with its
longest line, up to the widest a Block grows, and drawn in to its widest line.
A shorter line — a label — keeps its own width. It is the same while it is typed
in: the box written in is the box put down, and once the words wrap its width
moves only by more than an em at a time, so lines are not rewrapped at every key
(`balancedWidthPx`, `BALANCED_MIN_LINE_EM`, `BALANCED_BLOCK_ASPECT`,
`balancedWidthGuess` in `block-measure.js`; `blockNaturalWidth` and
`blockTypingWidth` in `src/documents/pdf-blocks.js`). Only a
Block made, pasted or typed in since — or fitted to its words again — is
balanced (`wBal: true` on its record, with `wFit`), so a page laid out before
keeps its widths. Say "balanced", not "auto-sized".

**To the Canvas** puts what the reader has already picked out onto the Canvas
as Blocks, sized, placed and stacked for them: the Notes' highlights (⋯ →
Highlights to the Canvas…), a PDF's highlights (⋯ → Highlights to the
Canvas… — a text highlight as its words, a ▣ region as a `pdfref:` live
picture of its spot, a reference rather than a copy), and the Cards (**To the
Canvas** under them — a question Block, an arrow, an answer Block, grouped).
Each opens the **picker**, a list of the part's items with the new ones ticked
and the ones already on the Canvas marked "on the Canvas"; Add puts the ticked
ones at the **end of the Canvas**, under the lowest thing on the last page,
adding pages as each fills (`appendNotebookPages` in `notebook.js`), one undo
step. Everything put on the Canvas this way takes the **last Block's look** —
the style of the last Block styled on this device, what + Add starts a Block
with (`blockStylePreference`, `latestCanvasBlockStyle` in `canvas-feed.js`);
the picker's **Fill with each highlight's colour** (off unless ticked,
remembered) puts a highlight's colour over the fill. The picker's **Colours** row takes one or several highlight colours (a
highlight with none counts as yellow), remembered per part on the device
(`recall_canvas_feed_colours_v1`). The Cards' picker has a **Style** section —
Question, Answer and Arrow tabs (fill, text colour, size, face, bold, align,
frame, shape; the arrow's colour, thickness, line, end and route) and the
**layout**, side by side or question above answer — over the last Block's look,
each control showing the value in use and where it comes from (from the last
Block, ◐ Canvas, the Shapes tool's arrow, or "set here ✕"; never a bare
"Default" or "auto") — which a card dragged by its grip takes too (`recall_card_canvas_style_v1`, `card-canvas-style.js`). One at
a time: **To the Canvas** in a highlight's menu and ✎ on the selection bar.
**Dragged across**: with the Canvas side by side, a selection, a highlight
pressed and dragged, a card by its ⠿ grip, or a whole picture, code listing,
table, diagram, maths block or heading of the Notes by the ⠿ grip that comes up
beside it (a heading takes its **section**, down to the next heading of its
level or above; `notes-grip.js`), let go over a Canvas page, is a Block there.
Words, a selection or a picture dragged in from a **web page, another PDF
reader or another app** land the same way: a page's HTML as markdown, bare
words as a PDF's words (the page's line ends joined, `pdfPlainToMarkdown`), a
picture file as a picture Block. While it is dragged, the **drop preview** is
the Block itself, drawn by the page's renderer in the look it will have
(`renderCanvasPreview`), following the pointer and settling onto the edges and
middles of the Blocks there; it lands where the preview was. The browser's own
faded picture of what is dragged is swapped for an empty one; something from
another app is drawn by that app, and gets a dashed box the size of its kind. The
**Canvas's sizes, not the source's**: a picture's width in the Notes, a
diagram's `w=`, a font size in a span or a site's own sizes are taken off
(`canvasSizedMarkdown` in `canvas-sizing.js`), and the Block takes ◐ Canvas's
type at the width ◐ Canvas → Blocks gives its kind — words the widest a Block
grows, pictures **Pictures land at** (40% of the page), tables, code and
diagrams **Tables and code land at** (80%) (`canvasDropWidthPercent` in
`block-measure.js`). A Block made this way says where it came from (`from`:
`notes:<key>`, `notes:el:<hash>`, `pdf:<highlight id>`, `card:<card id>`),
which is how the picker knows. Code: `src/documents/canvas-feed.js` (items,
measuring, placing), `canvas-flow.js` (where they go, pure), `canvas-sizing.js`
(sizes taken off, pure), `canvas-feed-dialog.js` (the picker),
`canvas-drop.js` (the drag and its preview); `styles/a8-canvas-feed.css`. Say
"to the Canvas", not "export to canvas" or "send"; "drop preview", not "ghost".

The Canvas is exported (⇓ beside the tabs) as a **PDF** of its pages, or as a
**web page** — ⇓ → **Web page (.html)**: one `.html` file with every picture
inside it as its own bytes, that opens offline in any browser on any device,
with vector paper and ink, the Blocks' words as words, and moving pictures (a
GIF, an animated WebP) moving, which a PDF cannot do. Both are drawn on the
**paper the Canvas is seen on** — Match theme, White, Sepia, Dim or Black
(`currentPaperTone`): the PDF through `paintPaperTone` (by arithmetic where a
browser's canvas has no `filter`, as on Safari before 18), the web page through
`paperToneColor` and the paper's own tokens (`.paper-tokens`). Say "web page", not "HTML
export" or "web export". Nothing is stored; the file is written and downloaded
(`src/export/canvas-html.js`, `buildCanvasHtml`; drawn by `canvasPageDrawing`
and `canvasPageMarkup` in `src/backup/viewer-pack.js`).

**Section lines** are the thin lines down the left of each heading's section in
the Notes, whose text is set one **step** in per section — ◐ Notes → Section
lines (`notesOutline*` keys; `src/notes/section-lines.js`, drawn by
`styles/a5-section-lines.css`). Clicking a line folds its section. Say "section
lines", not "outline", "thread lines" or "indent guides".

## Backups

| Say | Meaning | Data | Code |
|---|---|---|---|
| **Backup** | A `.recall` file of the **whole library**, **one file**, **one folder** or **ticked files and folders** — everything in them, PDFs and pictures included. The whole library's is restored (⋯ → Restore backup); the others are imported (My Files → ⋯ → Import), as your own files | a zip: `manifest.json`, `decks/<folder>/*.json`, `assets/`, `documents/`, `library.json` and `settings.json` (whole library only), `README.txt` | `writeRecallPackage` in `src/backup/backup.js` (the one writer); the choices in `src/backup/share-dialog.js` (`showBackupOptions`) |
| **Package** / **share** | The same file made for someone else: no study progress, nothing of your account. "Who is it for? Me / Someone else" in the dialog | `manifest.kind: "share"` (a backup of the whole library is `"library"`) | `PACKAGE_KIND_SHARE`, `shareMetaBag` in `src/backup/archive-format.js` |
| **Offline viewer** | `index.html` inside every backup: unzip it, open it in any browser, and read every file — Notes, Cards (with Study), PDFs and Canvas — with no Recall and no network. Read-only. Say "offline viewer" or "index.html", not "web export" or "HTML backup" | `index.html` and `viewer/` (`recall-viewer.js`, `recall-viewer.css`, `recall-content.css`, `katex/`, `library.js`, `files/0001.js` …); listed in `manifest.contents` | `src/backup/viewer-pack.js` (the data, pure), `viewer-shell.js` (the page, script and stylesheet), `viewer-render.js` (the app's markdown pipeline, off-screen) |
| **Web pictures** | Pictures a file shows by another website's address, not stored in Recall. **Download pictures from other websites too** puts the picture itself in a backup (through the wsrv.nl image proxy when a site refuses); **Save web pictures into this file** (and the backup dialog's **Also save those web pictures into my files**) copies them into your storage and points the file at the copies. Say "web pictures", not "external images" or "hotlinks" | the copied picture's address replaces the web one in `notes`, card faces, `meta.pdfBlocks` (`src`, `md`) and typed words in `meta.pdfHighlights` | `isOtherSitePicture`, `readBackupAssetBlob` (`viaProxy`) in `src/backup/backup.js`; `src/images/keep-web-images.js`; `fetchWebImage`, `copyWebImages` in `src/import/web-images.js` |

A `.recall` file is a zip: "Save as .zip" in the dialog names it `.zip`, with the
same bytes, and Restore and Import take either.

## Where each name lives

**The code still says `deck`, `notebook` and `handwriting`, on purpose.** Those
names are stored: they are Supabase table and column names, localStorage keys,
IndexedDB database names, folder names inside every `.recall` archive ever
written, and keys in synced settings. Renaming any of them would break existing
libraries, backups and sync between an old and a new version of the app. Only
the words a person reads changed.

| Say | Data (stored, never renamed) | Code |
|---|---|---|
| **File** | a row in the `decks` table; `deck_id` on `cards`; `deleted_decks` tombstones; `meta` JSON bag; `decks/` folder in a `.recall` archive; IndexedDB `recall-decks` | `deck`, `Deck`, `deckId`, `localDeckId`, `state.deckTitle`; `src/library/`, `src/storage/deck-store.js`, `src/library/my-decks-*.js`, `#myDecksPanel` |
| **Cards** | the `cards` table | view mode `cards`; `state.masterCards`; `src/cards/` |
| **Notes** | the `decks.notes` column | view mode `notes`; `state.notes`; `src/notes/` |
| **PDFs** | `meta.pdf` (the first), `meta.pdfs` (the others), `meta.pdfHighlights`, `meta.pdfBlocks`; `documents/` folder in an archive | view mode `document`; slot `doc`; `#documentStage`; `src/documents/pdf-*.js` |
| **Canvas** | `meta.notebook` (a generated blank PDF); its ink is in `meta.pdfHighlights` with `doc: "notebook"` | view mode `handwriting`; slot `notebook`; `data-slot="notebook"`; `src/handwriting/`, `src/documents/notebook*.js` |

A PDF made from markdown (PDF ⋯ → New PDF from Markdown…), and markdown
pages put into a PDF (Insert Markdown pages…), are still **PDFs**. The
markdown is kept inside the PDF's own bytes — each such page names its part
in `/RecallMd`, the catalog's `/RecallMdParts` holds the source — and the
`meta.pdfs` entry only counts the parts (`md.parts`); the code is
`src/documents/md-pdf/`.

So a bug report that says "the Canvas loses a page after sync" points at
`meta.notebook` and `src/documents/notebook.js`; "a file's PDFs tab shows the
wrong PDF" points at `meta.pdfs`, `pdfActiveId` and `src/documents/pdf-switcher.js`.

## Writing UI text

- **File**, not deck: "My Files", "New File", "Recent files", "Edit file title",
  "Your files are safe on this device".
- **Cards** when only the flashcards are meant: "Cards shuffled", "Cards
  Complete!", "Make a card".
- **Canvas** for the handwritten pages: "Canvas pages", "Start a Canvas", "A canvas
  keeps at least one page". "Handwriting" is still the word for what the pen
  leaves on a page; it is not the name of the part.
- **PDF** / **PDFs** for an attached document, not "paper" or "document" when it
  names the part: "This PDF, annotated", "Packing PDFs". "Grid paper" and "Ruled
  paper" are the Canvas's paper styles and keep the word.
- **Notes**, not "Study Notes".
- When the UI means a file on the user's disk, say what it is — "a `.md` file",
  "a PDF from your device", "a `.recall` package" — so it cannot be mistaken
  for a file in the library.
- Comments and `console.*` messages describe the code, so they keep the code's
  names.

`tools/nomenclature-check.mjs` (part of `node tools/check.mjs`, and of CI) reads
every user-visible string in `index.html`, `src/**/*.js` and the two manifests,
and fails on *deck*, *flashcard*, *notebook*, *handwritten notes*, *Study
Notes* or *text block*. A string that genuinely needs an old word — SQL naming
the real `decks` table, say — goes in its `ALLOWED` list with the reason.
