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

## On a page

What goes on a PDF's or a Canvas's page. The **Block** button beside ✎ (it was
the Text button) and the pen bar's **+ Add** menu put a Block where you tap next
(`src/documents/block-place.js`); it opens to type in, in place
(`src/documents/pdf-block-inline.js`), and a tap on a picked-up Block opens it
again.

| Say | Meaning | Data | Code |
|---|---|---|---|
| **Block** | A box of markdown — words, maths, code, tables and pictures — rendered like a note, written in where it is, dragged and resized on the page. Its width is what it was given; its height follows its words. Not "text block": it holds more than text | a record in `meta.pdfBlocks`; `kind` `"text"` (or none) is markdown | `src/documents/pdf-blocks.js` (`PDF_BLOCK_MARKDOWN`), `pdf-block-inline.js`, `pdf-block-editor.js` (Full editor) |
| **Picture** | A block that is a picture alone, from + Add → Picture…, or pasted (Ctrl+V) or dropped onto the page; compressed first, as a note's picture is | a `meta.pdfBlocks` record with `kind: "image"` and a `src` | `PDF_BLOCK_IMAGE`; `addHandwritingImages` in `src/handwriting/board.js` |
| **Block shape** | A Block's outline in a diagram — rectangle, rounded, pill, ellipse, diamond, hexagon, parallelogram, cylinder or document — from + Add's palette or Style → Shape. Still a **Block**: say "a diamond block", not "a shape", which is the Shapes tool's | `style.shape` (with `line`, `lineWidth`, `lineDash`, `valign`) on a `meta.pdfBlocks` record | `src/render/node-outlines.js`; `paintBlockOutline` in `pdf-blocks.js` |
| **Connector** | A line or an arrow whose ends are tied to the Blocks (or Shapes-tool boxes) it joins, so it follows them: made from a picked-up Block's four arrows, or by drawing or dragging a line's end onto one | a line/arrow shape in `meta.pdfHighlights` with `ends` (and `route`, `exits`, a bend in `p[2]`, words in `text`) | `src/documents/pdf-connectors.js`; `connectorPath` in `src/render/annot-shapes.js` |

Words typed with the old **Text** tool (before the Block button replaced it) are
still on their pages, shown and edited as they were: a shape with
`type: "text"` in `meta.pdfHighlights` (`src/documents/pdf-shapes.js`,
`pdf-shape-text.js`). Nothing new is made that way, so the UI calls them "words
typed on the page", never a kind of thing to add.

A **sticky note** is one of the Shapes tool's shapes (with lines, arrows, boxes,
ellipses and callouts), not a row of + Add.

Several Blocks and shapes **picked up** together (Shift-click, a box drawn on a
Canvas with the Select tool, Ctrl+A) are moved, lined up, copied and **grouped**
as one; a group is a `group` id on each record (`src/documents/canvas-selection.js`).
The thin lines a drag snaps to are **guides**, and grid paper's squares are the
**grid** (`src/documents/pdf-guides.js`, `src/render/snap-guides.js`).

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
