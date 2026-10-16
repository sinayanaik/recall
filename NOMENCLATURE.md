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
| **Canvas** | The file's handwritten pages: blank paper you write on with a pen, plus text blocks and pictures | ✎ Canvas |

"Folder" (a file's category path), "Quick Notes", "Highlights" and "Clozes" keep
their names.

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
and fails on *deck*, *flashcard*, *notebook*, *handwritten notes* or *Study
Notes*. A string that genuinely needs an old word — SQL naming the real `decks`
table, say — goes in its `ALLOWED` list with the reason.
