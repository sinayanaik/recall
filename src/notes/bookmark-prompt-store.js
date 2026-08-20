// Has this device already been asked "jump to your bookmark?" for the
// bookmark currently on the deck — one small localStorage key for the whole
// library, mirroring reading-position.js's own local store.
//
// The value stored per deck is the bookmark's OWN `.at`, not a boolean. That
// is what makes "a newer bookmark prompts again" fall out for free: a device
// that already saw the prompt for one `.at` simply fails the equality check
// against a different one, with no separate dismissed/seen state machine.

import { deckBookmarkPromptsKey } from "../core/constants.js?v=__BUILD__";

// Same bound and reasoning as READING_POSITION_MAX_DECKS — a cap so a big
// library cannot grow this key without limit.
export const BOOKMARK_PROMPT_MAX_DECKS = 300;

export function readAllBookmarkPrompts() {
  try {
    const raw = localStorage.getItem(deckBookmarkPromptsKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    // A corrupt bag is not worth a failure: worst case the prompt is shown
    // again once, and the next write replaces it wholesale.
    return {};
  }
}

export function wasBookmarkPrompted(key, at) {
  if (!key || !at) return false;
  return readAllBookmarkPrompts()[key] === at;
}

export function recordBookmarkPrompted(key, at) {
  if (!key || !at) return;
  const all = readAllBookmarkPrompts();
  all[key] = at;
  const keys = Object.keys(all);
  if (keys.length > BOOKMARK_PROMPT_MAX_DECKS) {
    // No timestamp to sort eviction by here (the value IS the bookmark's own
    // `.at`, not "when this device last touched it"), so this drops arbitrary
    // entries rather than the truly oldest. A library with 300+ distinct
    // bookmarked notes on one device is already an edge case; worst case is
    // an extra prompt reappearing once for a dropped entry, not data loss.
    keys.slice(0, keys.length - BOOKMARK_PROMPT_MAX_DECKS).forEach((stale) => delete all[stale]);
  }
  try {
    localStorage.setItem(deckBookmarkPromptsKey, JSON.stringify(all));
  } catch (error) {
    console.warn("Could not store the bookmark prompt state", error);
  }
}
