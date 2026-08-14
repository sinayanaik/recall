// The open deck's title and category, and the panels reached from the header.

import { hasActiveDeck, updateMeta } from "../cards/card-status.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { applyWebDeckCategory, updateWebDeckTitle } from "../cloud/web-decks.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { clearImportStaging } from "../import/staging.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { renameDeckInLibrary, saveDeckToLibrary, showImportSourceDrawer, state } from "../main.js?v=__BUILD__";
import { setStatus, showPromptModal, showToast } from "./feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "./overlays.js?v=__BUILD__";
import { chooseDeckCategory } from "./pickers.js?v=__BUILD__";

export function maybeShowSwipeHint() {
  if (!el.swipeHint) return;
  if (localStorage.getItem("swipe-hint-seen")) return;
  if (!("ontouchstart" in window) && navigator.maxTouchPoints < 1) return;
  el.swipeHint.hidden = false;
  swipeHintTimer = setTimeout(dismissSwipeHint, 3500);
}

export function dismissSwipeHint() {
  if (!el.swipeHint || el.swipeHint.hidden) return;
  clearTimeout(swipeHintTimer);
  try { localStorage.setItem("swipe-hint-seen", "1"); } catch (_) {}
  el.swipeHint.classList.add("is-fading");
  setTimeout(() => {
    if (el.swipeHint) {
      el.swipeHint.hidden = true;
      el.swipeHint.classList.remove("is-fading");
    }
  }, 420);
}

export function setDeckTitle(title, options = {}) {
  const normalized = String(title || "").trim();
  state.deckTitle = normalized;
  if (options.updateSourceTitle || !state.sourceTitle) {
    state.sourceTitle = normalized;
  }
  if (options.save !== false)  updateMeta();
}

export function setDeckCategory(category, options = {}) {
  state.deckCategory = normalizeDeckCategory(category);
  if (options.save !== false)  updateMeta();
}

export async function editCurrentDeckTitle() {
  if (!hasActiveDeck()) {
    setStatus("Create or import a deck before editing its title.", "error");
    return;
  }

  showPromptModal("Edit Deck Title", "", state.deckTitle || state.sourceTitle || "Untitled Deck", async (nextTitle) => {
    const title = nextTitle.trim();
    if (!title) {
      setStatus("Deck title cannot be empty.", "error");
      return;
    }

    // 1) Update the live view + every title field (deckTitle/sourceTitle/
    //    importTitleHint) right away so the header never reverts to the old name.
    setDeckTitle(title, { updateSourceTitle: true, save: false });
    state.importTitleHint = title;
    updateMeta();

    // 2) Persist to the local library IMMEDIATELY — independent of any network
    //    round-trip — so the new name survives navigation/reload and, because
    //    renameDeckInLibrary bumps updatedAt, the next reconcile pushes it even
    //    if the cloud call below fails or the device is offline. A working deck
    //    not yet in the library gets saved for the first time. (Previously the
    //    local snapshot was only rewritten inside the awaited cloud call, so a
    //    slow/failed sync left the deck saved under its old name.)
    if (state.localDeckId) {
      await renameDeckInLibrary(state.localDeckId, title);
    } else {
      await saveDeckToLibrary({ silent: true });
    }
    renderMyDecksList();
    setStatus("Deck title updated.");
    showToast(`Renamed to "${title}"`);

    // 3) Best-effort immediate cloud rename so other devices see it now instead
    //    of waiting for the next periodic reconcile. Failure is non-fatal.
    if (state.deckId && supabaseClient && isSignedIn && navigator.onLine) {
      try {
        await updateWebDeckTitle(state.deckId, title);
        setStatus("Deck title updated in the cloud.");
      } catch (error) {
        console.warn("Cloud rename failed — the next sync will push it", error);
        setStatus("Deck renamed. Cloud update will retry on the next sync.");
      }
    }
  });
}

export async function editCurrentDeckCategory() {
  if (!hasActiveDeck()) {
    setStatus("Create or import a deck before editing its category.", "error");
    return;
  }

  const category = await chooseDeckCategory(state.deckCategory);
  if (category === null) return;
  setDeckCategory(category);

  if (!state.deckId || !supabaseClient) {
    setStatus("Deck category updated locally. Sync to update the web deck.");
    return;
  }

  try {
    setStatus("Updating web deck category...");
    await applyWebDeckCategory(state.deckId, category);
    setStatus("Deck category updated in the cloud.");
  } catch (error) {
    console.error("Failed to update web deck category", error);
    // Was a flat "run the deck category SQL migration first", which is only one
    // of the reasons this fails — and since the write now reports a zero-row
    // update instead of pretending it succeeded, it is no longer the likeliest.
    setStatus(
      `Deck category updated on this device, but the cloud copy didn't change — ${error?.message || "unknown error"}`,
      "error"
    );
  }
}

export function openImportPanel() {
  lockPageScroll();
  el.importPanel.classList.add("is-open");
}

// Closing throws away anything staged but not committed: a half-chosen import
// must not be waiting the next time the panel opens.
export function closeImportPanel() {
  clearImportStaging();
  showImportSourceDrawer(null);
  if (el.pasteMarkdownInput) el.pasteMarkdownInput.value = "";
  el.importPanel.classList.remove("is-open");
  unlockPageScroll();
}

export function openMyDecksPanel() {
  lockPageScroll();
  el.myDecksPanel.hidden = false;
  // Reset the transient search each time the panel opens so it never surprises
  // the user with a stale filter; keep the persisted view/display/cwd.
  state.myDecksSearch = "";
  if (el.myDecksSearch) el.myDecksSearch.value = "";
  renderMyDecksList();
}

export function closeMyDecksPanel() {
  el.myDecksPanel.hidden = true;
  unlockPageScroll();
}

export let swipeHintTimer = null;
