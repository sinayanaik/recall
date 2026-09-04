// Values shared across the app that depend on nothing.
//
// This module imports NOTHING, and must stay that way. Everything else may
// import from core/*, so an import back out of here would close a cycle — and a
// cycle whose top-level initialiser reads across it throws on a temporal-dead-
// zone access rather than returning undefined. That is not hypothetical: moving
// webDeckCategories out before this module existed left it initialised from
// `[defaultDeckCategory]` while defaultDeckCategory was still in main.js's TDZ,
// and the app died on load.

export const delimitedCardBoundaryPattern = /(?:^|\n)\s*::/;

export const cardSideSeparatorPattern = /^\s*---(?!-)/;

export const deckStorageKey = "swipe-notes-current-deck-v1";

export const styleStorageKey = "swipe-notes-style-settings-v1";

// Where in each deck's notes the reader last was. One key for the whole library
// (a few bytes per deck), deliberately separate from the deck bodies: the
// position changes every time the reader stops scrolling, and the deck record
// is a multi-megabyte note. See src/notes/reading-position.js.
export const deckReadingPositionsKey = "swipe-notes-reading-positions-v1";

// Which bookmark version (its own `.at`) this device has already been shown
// the "jump to bookmark?" prompt for, one entry per deck. See
// src/notes/bookmark-prompt-store.js.
export const deckBookmarkPromptsKey = "swipe-notes-bookmark-prompts-v1";

export const themeStorageKey = "swipe-notes-theme";

export const defaultDeckCategory = "Uncategorized";

// The layer a PDF page's numbered note badges are painted into.
//
// Here, and not beside the painter that owns it (src/documents/pdf-page-notes.js),
// because two modules have to name it and they cannot import each other:
// pdf-page-notes.js reaches pdf-view.js for the page element and the viewport,
// and pdf-view.js has to DROP this layer on a relayout — the badges are placed
// by converting through the live viewport, so at a new scale they are in the
// wrong place, which is the same reason it already drops the mark and text
// layers. A constant in this file, which imports nothing, is how the two say
// the same word without closing a cycle through the document surface.
export const PDF_BADGE_LAYER_CLASS = "pdf-badge-layer";

// The layer a PDF page's ink is drawn into.
//
// Here for exactly the reason PDF_BADGE_LAYER_CLASS is, one line above: two
// modules have to name it and they cannot import each other. src/documents/
// pdf-ink.js reaches pdf-view.js for the page element and the viewport, and
// pdf-view.js has to DROP this layer on a relayout — ink is painted through the
// live viewport transform, so at a new scale the canvas holds a picture of the
// page at the old one, stretched. Missing for the few frames a re-render takes
// is right; wrong is not, and that is the rule the mark, text and badge layers
// beside it already follow.
export const PDF_INK_LAYER_CLASS = "pdf-ink-layer";

// ...and a third, for the same reason again: the markdown blocks a reader drops
// onto a page. Named here rather than in the module that builds them because
// src/documents/pdf-ink.js has to be able to recognise one without importing it
// — a pen press that lands on a block belongs to the block, not to the paper.
export const PDF_BLOCK_LAYER_CLASS = "pdf-block-layer";
export const PDF_BLOCK_CLASS = "pdf-block";
