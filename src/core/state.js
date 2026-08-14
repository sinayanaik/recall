// The one mutable object the whole app reads: the open deck, its cards, the
// view it is in, and the style settings in force.
//
// A LEAF module — it imports nothing, deliberately. Everything imports it, so
// any import back out of here would close a cycle around the single most
// widely read value in the codebase.
//
// It is an object rather than a set of exported `let`s because an imported
// binding is read-only: `state.deckId = x` works from anywhere, `deckId = x`
// would not.

export const state = {
  deckId: null,
  localDeckId: null,
  cards: [],
  masterCards: [],
  statusById: {},
  // Per-card subject label for quick_notes cards (id -> category id). Parallel
  // to statusById; only populated when the active deck is the quick_notes deck.
  categoryById: {},
  // Managed category set for the quick_notes deck: [{ id, name, color }].
  quickNoteCategories: [],
  // The open deck's meta bag, carried forward from load so per-deck fields
  // (quick_notes categories, a synced reading position, …) survive autosave.
  meta: {},
  previewCard: null,
  // Set only while a whole FOLDER is open as one document (see
  // src/library/folder-deck.js): { path, members: [...], cardOwner: {...} }.
  // Non-null is what tells saveDeckToLibrary/saveDeckToLibrarySync that this is
  // not a deck of its own and must be written back to the decks it came from —
  // without which the first autosave would mint a brand-new library entry for
  // the merged blob and sync it to every device.
  folderDeck: null,
  deckTitle: "",
  deckCategory: "Uncategorized",
  notes: "",
  viewMode: "cards",
  // My Decks library UI preferences (persisted per device).
  myDecksView: (() => { try { const v = localStorage.getItem("flashcards_mydecks_view_v1"); return ["grid", "folder", "tree"].includes(v) ? v : "folder"; } catch (_) { return "folder"; } })(),
  myDecksDisplay: (() => { try { const v = localStorage.getItem("flashcards_mydecks_display_v1"); return ["tiles", "list"].includes(v) ? v : "list"; } catch (_) { return "list"; } })(),
  myDecksSort: (() => { try { const v = localStorage.getItem("flashcards_mydecks_sort_v1"); return ["recent", "title-asc", "title-desc", "updated-desc", "created-desc", "size-desc"].includes(v) ? v : "recent"; } catch (_) { return "recent"; } })(),
  // Always start at Home (root) on app open, even though the current folder
  // is persisted per navigation below — the persisted value is only there so
  // helpers like currentMyDecksFolder() have something to read mid-session.
  myDecksCwd: "",
  myDecksSearch: "",
  sourceTitle: "",
  importTitleHint: "",
  results: {
    known: [],
    review: []
  },
  current: 0,
  known: 0,
  review: 0,
  flipped: false,
  dragStartX: 0,
  dragStartY: 0,
  dragCurrentX: 0,
  dragCurrentY: 0,
  dragPointerId: null,
  dragPointerType: "",
  dragCaptured: false,
  dragStartTime: 0,
  dragLastX: 0,
  dragLastY: 0,
  dragLastTime: 0,
  dragging: false,
  dragMoved: false,
  suppressClickUntil: 0,
  transitionToken: 0,
  styleSettings: {},
  styleProfiles: {
    desktop: {},
    mobile: {}
  },
  activeStyleProfile: "desktop",
  styleEditProfile: "desktop",
  styleEditProfileFollowsDevice: true,
  styleTouched: false,
  stylePanelScrollY: 0,
  stylePanelTouchY: 0
};
