// Resolving a `[[Note]]` link to a deck, and creating the note when it does
// not exist yet.
//
// The index is built from every deck's notes and cached, because a link can
// point at any note in the library and rebuilding that per click is a full
// library read.

import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { loadWebDeck } from "../cloud/web-decks.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { generateLocalDeckId, getQuickNotesDeckId, listLocalDecks, loadDeckFromLibrary, openQuickNotesBoard, pushLibraryDeckToCloud, readLocalDeckIndex, refreshHighlightBackdrop, scheduleDeckAutosave, setQnReturnState, state, writeDeckSnapshot, writeLocalDeckIndex } from "../main.js?v=__BUILD__";
import { notesAnchorPlainText } from "./anchors.js?v=__BUILD__";
import { renderNotesView, setNotesScrolledSource } from "./notes-view.js?v=__BUILD__";
import { currentDeckKey } from "./scroll-anchor.js?v=__BUILD__";
import { ensureNotesHeadingIds, scrollNotesHeadingIntoView } from "./toc.js?v=__BUILD__";
import { NOTE_LINK_PATTERN, noteLinkAliasesFor, noteLinkEntryMatchesId, noteLinkMarkupFor } from "../render/note-links.js?v=__BUILD__";
import { setStatus, showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { chooseDeckCategory } from "../ui/pickers.js?v=__BUILD__";

// ── Following a [[note reference]] ──────────────────────────────────────────
//
// The index behind the [[ picker and behind "does this link still point at
// something?". Titles and ids only — deliberately NOT loadDeckNotesForSearch,
// which pulls the full body of every deck in the library because it is
// searching inside them. Nothing here needs a single word of any note's text,
// and on a library of book chapters that difference is megabytes.
export let noteLinkIndexCache = null;

export let noteLinkIndexPromise = null;

export function invalidateNoteLinkIndex() {
  noteLinkIndexCache = null;
  noteLinkIndexPromise = null;
}

export async function loadNoteLinkIndex() {
  if (noteLinkIndexCache) return noteLinkIndexCache;
  if (noteLinkIndexPromise) return noteLinkIndexPromise;
  noteLinkIndexPromise = (async () => {
    const seenCloud = new Set();
    const entries = [];
    for (const meta of listLocalDecks()) {
      if (meta.deckId) seenCloud.add(String(meta.deckId));
      entries.push({
        localId: meta.id,
        deckId: meta.deckId || null,
        // Every OTHER id this deck has been known by, on this device or any
        // other — the ids already baked into links in people's notes. Without
        // these, a link written on one device is unresolvable on the rest; see
        // the note-reference header.
        aliasIds: Array.isArray(meta.linkIds) ? meta.linkIds : [],
        title: String(meta.title || "Untitled"),
        category: normalizeDeckCategory(meta.category)
      });
    }
    // Then anything that exists only in the account — a note written on another
    // device and never opened here still has to be linkable, or the picker
    // would quietly disagree with My Decks about what exists.
    //
    // Whether this half ran, and whether it succeeded, is recorded on the
    // returned array: an index missing every cloud-only deck can still answer
    // "which notes can I link to", but it CANNOT answer "does this id exist" —
    // and markMissingNoteLinks must not grey out a perfectly good link on the
    // strength of a lookup that never happened. Signed out is not a partial
    // index: there is no cloud half to be missing.
    let cloudComplete = !(supabaseClient && isSignedIn);
    if (supabaseClient && isSignedIn && navigator.onLine) {
      try {
        // `meta` comes back for the alias set — a cloud-only deck still has to
        // answer to the ids other devices wrote into their links for it.
        const { data, error } = await supabaseClient.from("decks").select("id, title, category, meta");
        if (error) throw error;
        for (const deck of data || []) {
          if (!deck || seenCloud.has(String(deck.id))) continue;
          entries.push({
            localId: null,
            deckId: String(deck.id),
            aliasIds: Array.isArray(deck.meta?.linkIds) ? deck.meta.linkIds : [],
            title: String(deck.title || "Untitled"),
            category: normalizeDeckCategory(deck.category)
          });
        }
        cloudComplete = true;
      } catch (error) {
        // Offline or a failed round trip: the local half is still a useful
        // index, so degrade rather than fail.
        console.warn("Could not list cloud decks for note links", error);
      }
    }
    entries.cloudComplete = cloudComplete;
    // Quick Notes pins are linkable too — they are often the scrap a longer
    // note is being written around. They come last and are labelled, so a
    // library of a few hundred pins can never bury the notes in the picker.
    for (const pin of await loadQuickNotePinIndex()) entries.push(pin);

    noteLinkIndexCache = entries;
    return entries;
  })();
  return noteLinkIndexPromise;
}

// The quick_notes deck's cards, as picker rows. One query, cached with the rest
// of the index; an empty list whenever quick notes aren't available (signed
// out, offline, or simply never used) rather than an error — the picker's job
// is to offer what it can.
export async function loadQuickNotePinIndex() {
  const deckId = getQuickNotesDeckId();
  if (!deckId || !supabaseClient || !isSignedIn || !navigator.onLine) return [];
  try {
    const { data, error } = await supabaseClient
      .from("cards")
      .select("id, question")
      .eq("deck_id", deckId)
      .order("position");
    if (error) throw error;
    return (data || [])
      .filter((card) => String(card.question || "").trim())
      .map((card) => {
        const text = notesAnchorPlainText(card.question).replace(/\s+/g, " ").trim();
        return {
          localId: null,
          deckId: null,
          pinId: String(card.id),
          title: text.length > 70 ? `${text.slice(0, 67)}…` : text,
          category: "Quick note"
        };
      });
  } catch (error) {
    console.warn("Could not list quick notes for note links", error);
    return [];
  }
}

// Split "ld_abc#some-heading" / "qn:card_1" / "" into its parts. Pure string
// work, no lookups — resolveNoteLink does those.
export function parseNoteLinkTarget(target) {
  const raw = String(target || "").trim();
  if (!raw) return { id: "", heading: "", cardId: "" };
  if (raw.startsWith("qn:")) return { id: "", heading: "", cardId: raw.slice(3) };
  const hash = raw.indexOf("#");
  if (hash === -1) return { id: raw, heading: "", cardId: "" };
  return { id: raw.slice(0, hash), heading: raw.slice(hash + 1), cardId: "" };
}

// Index entries whose title is exactly `wanted`, case- and space-insensitively.
// Returns all of them, because "how many" is the whole question at the fallback
// below — one match is an answer, two is a coin toss.
//
// The picker writes "Note › Heading" as the label of a heading link, so the
// displayed name is trimmed back to the note's own title before comparing.
export function noteLinkEntriesByTitle(index, wanted) {
  const name = String(wanted || "").split("›")[0].trim().toLowerCase();
  if (!name) return [];
  return index.filter((entry) => entry.title.trim().toLowerCase() === name);
}

// What a link points at, or null if nothing answers to it.
//
// The id is tried first and the title is only a fallback, which is what makes a
// link survive a rename: the picker always writes an id, so renaming the target
// changes the words shown in the link but not where it goes. A link typed by
// hand has no id and resolves by title — and will break on a rename, which is
// the honest trade for markdown that reads as plain [[Chain Rule]].
export async function resolveNoteLink({ target, title }) {
  const parts = parseNoteLinkTarget(target);
  const index = await loadNoteLinkIndex();

  if (parts.id) {
    const byId = index.find((entry) => noteLinkEntryMatchesId(entry, parts.id));
    if (byId) return { ...byId, heading: parts.heading, cardId: parts.cardId };
    // An id that answers to nothing usually means a deleted note, and grabbing
    // just any note that shares the title would be worse than admitting the
    // link is broken — landing silently on the wrong document is the one
    // outcome there is no way to notice.
    //
    // But it can also mean a link written on a device whose ids this one has
    // never been told about (see the note-reference header: the alias set
    // repairs those, and only once the other device has pushed since). So try
    // the title — and only accept it when EXACTLY ONE note has that name. At
    // one match there is no wrong document to land on; at two or more there is,
    // and the link stays broken exactly as before.
    const named = noteLinkEntriesByTitle(index, title);
    if (named.length === 1) return { ...named[0], heading: parts.heading, cardId: parts.cardId };
    return null;
  }

  // No pipe, so the whole thing is a label — but a label may itself carry a
  // "#Heading". Written by hand, [[Chain Rule#Proof]] is the obvious way to
  // reach a section, and it used to resolve to nothing at all: the "#Proof"
  // stayed glued to the title, matched no deck, and the link greyed out as
  // missing with an offer to create a note called "Chain Rule#Proof".
  let wanted = String(title || "").trim();
  let heading = parts.heading;
  const hash = wanted.indexOf("#");
  if (hash !== -1) {
    heading = heading || wanted.slice(hash + 1).trim();
    wanted = wanted.slice(0, hash).trim();
    // [[#Proof]] — a heading in the note you are already in.
    if (!wanted) {
      return { localId: state.localDeckId, deckId: state.deckId, title: state.deckTitle, heading, cardId: "", sameNote: true };
    }
  }
  if (!wanted) return null;
  const byTitle = noteLinkEntriesByTitle(index, wanted)[0];
  return byTitle ? { ...byTitle, heading, cardId: parts.cardId } : null;
}

// Which heading a "#…" fragment means.
//
// Three forms are accepted, because three forms get written. The picker emits
// the exact element id ("toc-chain-rule"); somebody reading that markdown back
// reasonably drops the machine-looking prefix ("chain-rule"); and somebody
// writing a link from scratch types what they can see on the page ("Chain
// Rule"). Only the first used to work, and the "toc-" prefix was documented
// nowhere, so a hand-written heading link essentially always failed.
export function matchesHeadingFragment(heading, fragment) {
  if (heading.id === fragment) return true;
  if (heading.id === `toc-${fragment}`) return true;
  return heading.textContent.trim().toLowerCase() === fragment.trim().toLowerCase();
}

// Scroll to a heading in the note that is now open. Retried across a few frames
// because the click may have just triggered a deck load, and the headings only
// exist once that render has landed.
export async function revealNoteHeading(slug) {
  if (!slug) return true;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const heading = ensureNotesHeadingIds().find((h) => matchesHeadingFragment(h, slug));
    if (heading) {
      await scrollNotesHeadingIntoView(heading);
      heading.classList.add("notes-heading-flash");
      setTimeout(() => heading.classList.remove("notes-heading-flash"), 1200);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

// Guards against a second click landing while the first is still loading a
// deck — two overlapping loads would leave the back history describing a route
// the user never took.
export let followingNoteLink = false;

export async function followNoteLink(anchor) {
  if (followingNoteLink) return;
  const target = anchor.getAttribute("data-note-target") || "";
  const title = anchor.getAttribute("data-note-title") || anchor.textContent || "";

  // A quick_notes pin. The board is the destination, not a deck — and pointing
  // at one card on it is something the back-history restore already knows how
  // to do, so reuse that rather than inventing a second way to focus a pin.
  const asPin = parseNoteLinkTarget(target);
  if (asPin.cardId) {
    setQnReturnState({ cardId: asPin.cardId, filters: [], query: "", scrollTop: 0 });
    openQuickNotesBoard({ restore: true }).catch((error) => {
      console.warn("Could not open the quick notes board", error);
      showToast("Couldn't open quick notes", "error");
    });
    return;
  }

  followingNoteLink = true;
  try {
    const found = await resolveNoteLink({ target, title });
    if (!found) {
      anchor.classList.add("is-missing");
      // Offer to create the NOTE, not "Note#Heading" — a pipe-less label can
      // carry a heading, and creating a note literally named "Nope#Missing" is
      // never what was meant.
      offerToCreateMissingNote(anchor, title.split("#")[0].trim() || title);
      return;
    }

    // Already here — a same-note heading jump. Don't reload the deck: that
    // would discard the reading position for no reason. "[[#Heading]]" says so
    // outright; the id comparisons cover the case where the note names itself.
    const here = found.sameNote
      || (found.localId && found.localId === state.localDeckId)
      || (found.deckId && found.deckId === state.deckId);
    if (!here) {
      // The deck loaders record the back history themselves, so Back returns to
      // the note the link was in — at the paragraph it was in, via the anchor
      // currentNavLocation now captures.
      const opened = found.localId ? await loadDeckFromLibrary(found.localId) : false;
      if (!opened) {
        if (!found.deckId || !supabaseClient || !navigator.onLine) {
          setStatus(`Couldn't open "${found.title}" — it isn't available on this device.`, "error");
          showToast(`"${found.title}" isn't available offline`, "error");
          return;
        }
        await loadWebDeck(found.deckId);
      }
    }

    if (found.heading && !(await revealNoteHeading(found.heading))) {
      showToast(`Opened "${found.title}" — that heading no longer exists`);
    }
  } catch (error) {
    console.error("Could not follow the note link", error);
    setStatus("Couldn't open that note.", "error");
    showToast("Couldn't open that note", "error");
  } finally {
    followingNoteLink = false;
  }
}

// A link whose target is gone, or one typed by hand before the note existed.
// Rather than a dead end, it becomes the quickest way to create what it names.
export function offerToCreateMissingNote(anchor, title) {
  const name = String(title || "").trim();
  if (!name) {
    showToast("That link doesn't point at anything", "error");
    return;
  }
  // Which note the broken link is IN. The confirm modal and the folder picker
  // are both awaited below, and rewriteNoteLinkTarget edits whatever note is
  // open when it finally runs — which needs to be this one.
  const startedIn = currentDeckKey();
  showConfirmModal(
    `There's no note called "${name}". Create it?`,
    async () => {
      const created = await createLinkedNoteFlow(name);
      if (!created) return;
      if (currentDeckKey() !== startedIn) {
        showToast(`Made "${created.title}", but you'd moved on — the link wasn't repointed`, "info");
        return;
      }
      // Repoint the link in the SOURCE TEXT, not just in the DOM: the rendered
      // anchor is rebuilt from the markdown on the next repaint, so a DOM-only
      // fix would last exactly one render and the link would go broken again.
      rewriteNoteLinkTarget(name, created);
    },
    { confirmLabel: "Create note" }
  );
}

// Point every [[…]] in the OPEN note that names `title` at `entry`, and repaint.
export function rewriteNoteLinkTarget(title, entry) {
  const wanted = String(title || "").trim().toLowerCase();
  if (!wanted) return;
  let changed = false;
  const next = String(state.notes || "").replace(NOTE_LINK_PATTERN, (match, label, target) => {
    if (String(label).trim().toLowerCase() !== wanted) return match;
    // Only fill in links that have no target yet; one that names a different
    // id is pointing somewhere on purpose.
    if (String(target || "").trim()) return match;
    changed = true;
    // Sanitized like every other written label: a deck title carrying "|" or a
    // bracket would produce a link NOTE_LINK_PATTERN can no longer match, which
    // renders as literal "[[…]]" text with no way back. noteLinkMarkupFor also
    // picks the portable id, so a link repaired here resolves on every device.
    return noteLinkMarkupFor(entry, label);
  });
  if (!changed) return;
  state.notes = next;
  if (el.notesEdit && !el.notesEdit.hidden) {
    el.notesEdit.value = next;
    refreshHighlightBackdrop(el.notesEdit);
  }
  setNotesScrolledSource(null); // force a real repaint rather than a cache hit
  renderNotesView();
  scheduleDeckAutosave();
}

// ── Creating a note from a reference ────────────────────────────────────────
//
// The constraint that shapes all of this: createNewDeck REPLACES the open deck
// and navigates to the new one. That is right when you mean "start a new deck",
// and completely wrong here — you are mid-sentence in a note and asking for
// somewhere to put a thought. So this writes the new deck straight to storage
// and leaves you exactly where you were, with a link now sitting in your text.
//
// Where it goes is asked, never assumed. Dropping new notes into the root would
// turn a library that people have filed carefully into a flat heap within a
// week. chooseDeckCategory is the same picker "Move to folder…" uses, so the
// folder list and the "new category" affordance are already whatever the user
// expects them to be; it just opens on the current note's folder.
export async function createLinkedNoteFlow(rawTitle, body = "") {
  const title = String(rawTitle || "").trim();
  if (!title) return null;

  const category = await chooseDeckCategory(normalizeDeckCategory(state.deckCategory));
  if (category === null) return null; // cancelled

  try {
    const entry = createLinkedNoteDeck({ title, category: normalizeDeckCategory(category), body });
    const where = entry.category === defaultDeckCategory ? "" : ` in "${entry.category}"`;
    showToast(`Created "${entry.title}"${where} — open it from the link`);
    return entry;
  } catch (error) {
    console.error("Could not create the linked note", error);
    showToast("Couldn't create that note", "error");
    return null;
  }
}

export function createLinkedNoteDeck({ title, category, body = "" }) {
  const localId = generateLocalDeckId();
  const now = new Date().toISOString();
  // Seeded with its own title as an H1, for two reasons: an empty deck is
  // refused by saveDeckToLibrary (no cards AND no notes), and opening a brand
  // new note to a blank page gives you nothing to confirm you landed in the
  // right place. `body` is the text being moved here by the extract action.
  const snapshot = {
    app: "recall",
    version: 1,
    exportedAt: now,
    deckTitle: title,
    deckCategory: category,
    notes: `# ${title}\n\n${String(body || "").trim()}${body ? "\n" : ""}`,
    sourceTitle: title,
    importTitleHint: title,
    deckId: null,
    localDeckId: localId,
    // This deck has no cloud id yet — the push below is what mints one, and it
    // resolves long after the caller has already written a link pointing here.
    // That link therefore carries `localId`, so the alias has to go up with the
    // deck or the link is unresolvable on every other device. Written here
    // rather than left to the first autosave (resolveSaveTarget) because this
    // path writes the snapshot itself and pushes it straight away.
    meta: { linkIds: noteLinkAliasesFor(null, localId) },
    current: 0,
    cards: []
  };
  writeDeckSnapshot(localId, snapshot);
  writeLocalDeckIndex([
    {
      id: localId,
      title,
      category,
      cardCount: 0,
      hasNotes: true,
      updatedAt: now,
      createdAt: now,
      lastSyncedAt: null,
      accessedAt: null,
      notesConflicted: false,
      notesSyncFailed: false,
      deckId: null,
      linkIds: snapshot.meta.linkIds
    },
    ...readLocalDeckIndex()
  ]);
  invalidateNoteLinkIndex();

  // Best-effort push. Failing here is not an error the user needs to see: the
  // deck is already durable on this device and the next reconcile will carry it
  // up, exactly as it would for a deck created any other way.
  if (supabaseClient && isSignedIn && navigator.onLine) {
    pushLibraryDeckToCloud({ id: localId, deckId: null })
      .then(() => invalidateNoteLinkIndex())
      .catch((error) => console.warn("Could not push the new linked note yet", error));
  }

  return { localId, deckId: null, title, category };
}
