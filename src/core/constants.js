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

export const themeStorageKey = "swipe-notes-theme";

export const defaultDeckCategory = "Uncategorized";
