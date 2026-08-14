// Quick Notes constants, as a LEAF module — it imports nothing.
//
// board.js seeds `qnNewColor` from QUICK_NOTE_DEFAULT_COLOR in a top-level
// initialiser, and board.js and categories.js import each other. Leaving these
// in categories.js meant that initialiser ran first and threw.

// Persisted id of the user's quick_notes deck. Deterministic per user so
// repeated saves always append to the same deck.
export const QUICK_NOTES_DECK_TITLE = "quick_notes";

// Curated swatch palette offered when creating a category (theme-friendly).
export const QUICK_NOTE_COLOR_PALETTE = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
  "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#64748b"
];

export const QUICK_NOTE_DEFAULT_COLOR = QUICK_NOTE_COLOR_PALETTE[0];

// Local mirror of the managed category set, so the board can render instantly
// (and offline) before/without a cloud deck load.
export const QUICK_NOTE_CATEGORIES_CACHE_KEY = "recall:quickNoteCategories";
