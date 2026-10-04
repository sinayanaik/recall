// The home screen: where every launch lands, and where ⌂ goes back to.
//
// It used to be the flashcard slot's empty state — "Recall · Choose how to get
// started" and three buttons, squeezed into the space a card occupies — and
// once a deck was open there was no way back to it at all. This is a page of
// its own, drawn over the study surface rather than instead of it: opening it
// from a deck leaves the deck loaded underneath, so "Back to …" returns to the
// exact place and nothing is reloaded.
//
// Everything on it is read from the local deck index (listLocalDecks), which
// is already in memory. Nothing here waits on IndexedDB or the network, so it
// paints in the same frame as a press.
//
// Visibility lives in ./home-state.js; this module only draws.

import { createNewDeck } from "../cards/new-deck.js?v=__BUILD__";
import { hasActiveDeck } from "../cards/card-status.js?v=__BUILD__";
import { openAllCardsPanel } from "../cards/all-cards.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { deckCardCountSpan, deckNotesMarker, deckPagesMarker } from "../library/deck-rows.js?v=__BUILD__";
import { listLocalDecks } from "../library/local-library.js?v=__BUILD__";
import { loadDeckEntry } from "../library/my-decks-actions.js?v=__BUILD__";
import { openQuickNotesBoard } from "../quick-notes/board.js?v=__BUILD__";
import { reconcileAllDecks } from "../sync/reconcile.js?v=__BUILD__";
import { formatRelativeTime, renderWelcomeSyncReport, updateDeckEmptyStatus } from "../sync/indicator.js?v=__BUILD__";
import { openImportPanel, openMyDecksPanel } from "./deck-header.js?v=__BUILD__";
import { hideHome, isHomeVisible, setHomeRenderHook, showHome } from "./home-state.js?v=__BUILD__";

// Enough to fill two rows on a desktop and not so many that home becomes a
// second My Decks. "See all" is one press away.
const HOME_RECENT_LIMIT = 8;

function homeGreeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function homeCount(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// "Biology · 24 cards · 3h ago" — the same facts a My Decks row shows, in the
// order a person scanning for a deck reads them.
function homeDeckMeta(deck) {
  const parts = [];
  if (deck.category) parts.push(deck.category);
  parts.push(homeCount(Number(deck.cardCount) || 0, "card"));
  const when = formatRelativeTime(deck.accessedAt || deck.updatedAt);
  if (when) parts.push(when);
  return parts.join(" · ");
}

function buildHomeDeckTile(deck) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "home-deck";
  tile.dataset.deckId = deck.id;
  tile.setAttribute("aria-label", `Open ${deck.title || "Untitled deck"}`);

  const title = document.createElement("span");
  title.className = "home-deck-title";
  title.textContent = deck.title || "Untitled deck";

  const category = document.createElement("span");
  category.className = "home-deck-category";
  category.textContent = deck.category || "";

  const facts = document.createElement("span");
  facts.className = "home-deck-facts";
  const count = document.createElement("span");
  count.className = "home-deck-count";
  const cardCount = Number(deck.cardCount) || 0;
  count.append(deckCardCountSpan(cardCount), cardCount === 1 ? " card" : " cards");
  facts.append(count);
  if (deck.hasNotes) facts.append(deckNotesMarker());
  if (deck.pageCount > 0) facts.append(deckPagesMarker(deck.pageCount));
  const when = formatRelativeTime(deck.accessedAt || deck.updatedAt);
  if (when) {
    const time = document.createElement("span");
    time.className = "home-deck-when";
    time.textContent = when;
    facts.append(time);
  }

  tile.append(title, category, facts);
  tile.addEventListener("click", () => openDeckFromHome(deck));
  return tile;
}

async function openDeckFromHome(deck) {
  // Hidden first, so the press visibly lands; loadDeckEntry reports a failure
  // through its own toast.
  hideHome();
  await loadDeckEntry(deck, "local");
  // Nothing opened (an unreadable snapshot, a deck deleted elsewhere): back to
  // home rather than an empty study surface.
  if (!hasActiveDeck()) showHome();
}

export function renderHome() {
  const view = document.getElementById("homeView");
  if (!view) return;
  const decks = listLocalDecks();
  const deckOpen = hasActiveDeck();

  const greeting = document.getElementById("homeGreeting");
  if (greeting) greeting.textContent = homeGreeting();
  const summary = document.getElementById("homeSummary");
  if (summary) {
    const cards = decks.reduce((sum, deck) => sum + (Number(deck.cardCount) || 0), 0);
    summary.textContent = decks.length
      ? `${homeCount(decks.length, "deck")} · ${homeCount(cards, "card")} on this device`
      : "Your study library starts here.";
  }

  // The continue card: the deck underneath if there is one, otherwise the one
  // opened most recently (listLocalDecks is sorted by accessedAt).
  const continueBtn = document.getElementById("homeContinueBtn");
  const continueLabel = document.getElementById("homeContinueLabel");
  const continueTitle = document.getElementById("homeContinueTitle");
  const continueMeta = document.getElementById("homeContinueMeta");
  const openEntry = deckOpen ? decks.find((deck) => deck.id === state.localDeckId) : null;
  const resumeDeck = deckOpen ? null : decks[0] || null;
  if (continueBtn) {
    continueBtn.hidden = !deckOpen && !resumeDeck;
    continueBtn.dataset.mode = deckOpen ? "back" : "resume";
    if (continueLabel) continueLabel.textContent = deckOpen ? "Back to your deck" : "Continue where you left off";
    if (continueTitle) continueTitle.textContent = deckOpen ? (state.deckTitle || "Untitled deck") : (resumeDeck?.title || "Untitled deck");
    if (continueMeta) {
      continueMeta.textContent = deckOpen
        ? (openEntry ? homeDeckMeta(openEntry) : homeCount(state.masterCards.length, "card"))
        : (resumeDeck ? homeDeckMeta(resumeDeck) : "");
    }
  }

  // Recent decks, minus whichever one the continue card already offers.
  const featuredId = deckOpen ? state.localDeckId : resumeDeck?.id;
  const recent = decks.filter((deck) => deck.id !== featuredId).slice(0, HOME_RECENT_LIMIT);
  const grid = document.getElementById("homeRecent");
  if (grid) grid.replaceChildren(...recent.map(buildHomeDeckTile));
  const recentSection = document.getElementById("homeRecentSection");
  if (recentSection) recentSection.hidden = recent.length === 0 && decks.length > 0;
  const empty = document.getElementById("homeRecentEmpty");
  if (empty) empty.hidden = decks.length > 0;
  const seeAll = document.getElementById("homeSeeAllBtn");
  if (seeAll) seeAll.hidden = decks.length === 0;
  // All Cards browses the OPEN deck's cards, so it is only offered over one.
  const allCards = document.getElementById("homeAllCardsBtn");
  if (allCards) allCards.hidden = !state.masterCards.length;

  updateDeckEmptyStatus();
  renderWelcomeSyncReport();
}

// The ⌂ buttons. Opening home over a loaded deck is deliberate, so it stays
// until the reader picks something — see releaseAutomaticHome.
export function openHome() {
  showHome({ explicit: hasActiveDeck() });
}

// Escape, the hardware Back key and "Back to your deck" — but only while there
// IS a deck to go back to. With nothing loaded, home is the app.
export function isHomeDismissible() {
  return isHomeVisible() && hasActiveDeck();
}

export function closeHome() {
  if (isHomeDismissible()) hideHome();
}

export function initHome() {
  setHomeRenderHook(renderHome);
  const on = (id, handler) => document.getElementById(id)?.addEventListener("click", handler);
  on("appHomeBtn", openHome);
  on("homeBtn", openHome);
  on("homeContinueBtn", () => {
    if (hasActiveDeck()) { hideHome(); return; }
    const deck = listLocalDecks()[0];
    if (deck) openDeckFromHome(deck);
  });
  // The panels open OVER home and leave it underneath, so closing one comes
  // back here. Only creating a deck replaces it, and createNewDeck does that.
  on("homeNewDeckBtn", () => createNewDeck());
  on("homeImportBtn", () => openImportPanel());
  on("homeMyDecksBtn", () => openMyDecksPanel());
  on("homeSeeAllBtn", () => openMyDecksPanel());
  on("homeQuickNotesBtn", () => openQuickNotesBoard());
  on("homeAllCardsBtn", () => openAllCardsPanel());
  on("homeSyncBtn", () => reconcileAllDecks({ explicit: true }));
}
