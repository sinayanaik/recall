// Which panel a deck was last left on, per deck, on this device.
//
// documentTabForOpenDeck decides which surface a deck OPENS on, and it decides
// it from the deck's contents: a paper opens on the PDF tab because the document
// is the deck, a notebook opens on Write by the same argument, and everything
// else opens on Notes. That is the right answer the first time and the wrong one
// every time after: a reader who studies the cards of a paper deck was put back
// on the paper on every open, and a reader who writes in a notebook beside a
// paper was put back on the paper too.
//
// So the tab is remembered, and the content-derived answer becomes the fallback
// for a deck this device has never opened.
//
// ── A LEAF, importing nothing ──────────────────────────────────────────────
//
// src/documents/doc-slot.js reads this, and that module's own header explains at
// length why it imports almost nothing: the painters, the writers, the store,
// the view and the sync path all read IT, one of them from a top-level
// initialiser, and a module caught in an import cycle would be read before it
// was evaluated — which has cost this app a boot once already. A module that
// imports nothing is safe to import from anywhere, which is the whole reason
// this is a file of its own rather than three functions inside doc-slot.js.
//
// ── Device-local, and never in the deck ────────────────────────────────────
//
// Which tab you were on is a fact about this screen, not about the deck: the
// phone is for writing and the laptop is for the cards, and a deck that dragged
// one device's choice onto the other would be worse than not remembering at all.
// The same argument src/storage/ink-prefs.js makes for the nib.

// One bag under one key, merged on write, the way ink-prefs.js keeps its own —
// rather than a key per deck, which is a localStorage entry per deck in a
// library that can run to hundreds.
export const DECK_TAB_KEY = "recall:deckTab-v1";

// The cap, and the same one the reading-position store uses for the same reason:
// a big library must not grow one localStorage key without limit. Evicted
// oldest-first on the `at` every entry carries — the deck you last read is the
// one you are most likely to reopen.
export const DECK_TAB_MAX_DECKS = 300;

// The four the tab row offers. An unknown string is refused rather than stored:
// this value is handed straight to setViewMode, and "highlights" — a mode this
// app used to have — must not come back out of a bag written by an older build.
const KNOWN_TABS = new Set(["cards", "notes", "document", "handwriting"]);

// ── The key, and why it is not currentDeckKey() ────────────────────────────
//
// The reading position is keyed by [deckId, localDeckId, folderKey], because it
// has to tell a folder read as one document apart from an unattached working
// deck — both of which have neither id. A tab has no such problem and does have
// the opposite one: the two routes into a deck reach their setViewMode at
// different moments. The library loader has the local id and not yet the cloud
// one; the cloud loader has the cloud id and has NOT yet assigned the local one,
// so a composite key there would carry the previously-open deck's id and could
// match another deck's remembered tab.
//
// So: the deck's own identity, cloud id first because that is the one both
// routes and both devices agree on, and the local id for a deck that has never
// synced. A folder read as one document is deliberately not remembered — it has
// neither id, it is assembled fresh on every open, and there is no deck there to
// remember anything about.
export function deckTabKey(deckId = null, localDeckId = null) {
  const id = String(deckId || "").trim() || String(localDeckId || "").trim();
  return id || null;
}

function readBag() {
  try {
    const raw = localStorage.getItem(DECK_TAB_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    // A corrupt bag is not worth a failure: the remembered tab is a
    // convenience, and the next write replaces it wholesale.
    return {};
  }
}

export function rememberedDeckTab(deckKey) {
  if (!deckKey) return null;
  const entry = readBag()[deckKey];
  const mode = typeof entry === "string" ? entry : entry?.mode;
  return KNOWN_TABS.has(mode) ? mode : null;
}

export function rememberDeckTab(deckKey, mode) {
  if (!deckKey || !KNOWN_TABS.has(mode)) return;
  const bag = readBag();
  const current = bag[deckKey];
  // Nothing to write when the answer has not changed. This is called on every
  // tab press, and rewriting the whole bag to say what it already says is a
  // synchronous localStorage write per press for no reason.
  if ((typeof current === "string" ? current : current?.mode) === mode) return;
  bag[deckKey] = { mode, at: Date.now() };
  const keys = Object.keys(bag);
  if (keys.length > DECK_TAB_MAX_DECKS) {
    keys
      .sort((a, b) => (bag[a]?.at || 0) - (bag[b]?.at || 0))
      .slice(0, keys.length - DECK_TAB_MAX_DECKS)
      .forEach((stale) => delete bag[stale]);
  }
  try {
    localStorage.setItem(DECK_TAB_KEY, JSON.stringify(bag));
  } catch (error) {
    console.warn("Could not remember which tab this deck was on", error);
  }
}

// For "sign out and remove all decks". The keys carry deck ids and nothing else
// — no note text — but they describe one account's library and have no business
// outliving it.
export function forgetAllDeckTabs() {
  try {
    localStorage.removeItem(DECK_TAB_KEY);
  } catch (error) {
    console.warn("Could not clear the remembered deck tabs", error);
  }
}
