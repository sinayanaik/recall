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
moves when it is resized. Code: `src/documents/canvas-setup.js` (the numbers,
pure), `src/documents/canvas-setup-dialog.js` (the dialog),
`setNotebookPageSetup` in `src/documents/notebook.js`, `buildBlankPdf` in
`src/documents/blank-pdf.js`. Picked-up Blocks are **copied** (or cut) from
their strip or the bar over several, and pasted onto any page of the same part
with Insert → **Paste blocks** or Ctrl+V (`copyPickedByButton`, `pastePicked` in
`src/documents/canvas-selection.js`).

| Say | Meaning | Data | Code |
|---|---|---|---|
| **Block** | A box of markdown — words, maths, code, tables and pictures — rendered like a note, written in where it is, dragged, resized from any edge or corner, and **turned** by the round handle over it (or Arrange → Turn 90°). Its height follows its words until its height is dragged — a top or bottom edge, or a corner dragged mostly up or down, to more room than the words need — and then it is the reader's (`style.fit: false`), still growing when the words need more; a corner dragged mostly sideways sets only the width. Its width is its words' too: as it is typed in, and whenever its words are drawn, it is as wide as its longest line — growing with the words and drawn in when they are cut — up to a little short of the page's right edge, where they wrap and the height takes over. A width dragged by hand is the reader's: kept when it is typed in again, the words wrapping at it. A new Block takes the last Block's look but never its height. Arrange → **Fit to words** (or a double-click on a resize handle) brings one back to its words. It is always typed left-aligned; its alignment shows once the words are down. Not "text block": it holds more than text. Insert → Block and a tap; with a mouse, the **T** or **B** key or a double-click on bare paper (never a pen's) puts one at the pointer; words pasted (Ctrl+V) onto the page become one there | a record in `meta.pdfBlocks`; `kind` `"text"` (or none) is markdown; a turn is `rot`, degrees counter-clockwise; `wHand` says the width was dragged by hand (a `wSet` from older builds is dropped) | `src/documents/pdf-blocks.js` (`PDF_BLOCK_MARKDOWN`), `pdf-block-inline.js`, `pdf-block-editor.js` (Full editor); `src/documents/page-pointer.js` |
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

**Section lines** are the thin lines down the left of each heading's section in
the Notes, whose text is set one **step** in per section — ◐ Notes → Section
lines (`notesOutline*` keys; `src/notes/section-lines.js`, drawn by
`styles/a5-section-lines.css`). Clicking a line folds its section. Say "section
lines", not "outline", "thread lines" or "indent guides".

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
