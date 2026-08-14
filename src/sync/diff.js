// What changed between this device's cards and the cloud's.
//
// Matching is by id first and content second: a card edited on two devices has
// to be recognised as ONE card, or a sync turns every edit into a duplicate.

import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import { normalizeMarkdown } from "../import/parse-cards.js?v=__BUILD__";

export function normalizeSyncText(value) {
  return normalizeMarkdown(String(value || ""))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function syncTextChanged(localValue, webValue) {
  return normalizeSyncText(localValue) !== normalizeSyncText(webValue);
}

export function sameSyncContent(localCard, webCard) {
  return !syncTextChanged(localCard.question, webCard.question)
    && !syncTextChanged(localCard.answer, webCard.answer);
}

export function uniqueMatchingWebCard(webCards, predicate) {
  const matches = webCards.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

export function fallbackWebCardFor(localCard, localIndex, unmatchedWebCards, localIds) {
  const candidates = unmatchedWebCards.filter((webCard) => !localIds.has(String(webCard.id)));

  return uniqueMatchingWebCard(candidates, (webCard) => sameSyncContent(localCard, webCard))
    || uniqueMatchingWebCard(candidates, (webCard) => Number(webCard.position) === localIndex)
    || uniqueMatchingWebCard(candidates, (webCard) => (
      normalizeSyncText(localCard.question)
      && normalizeSyncText(localCard.question) === normalizeSyncText(webCard.question)
    ))
    || uniqueMatchingWebCard(candidates, (webCard) => (
      normalizeSyncText(localCard.answer)
      && normalizeSyncText(localCard.answer) === normalizeSyncText(webCard.answer)
    ));
}

// `fuzzy` (default on) lets a local card with no exact id match pair up with a
// web card by content/position — right when the two sides may have drifted ids
// (e.g. an import-minted local deck vs its first web copy). It is WRONG for a
// stable-id diff (old library snapshot vs the same deck's cloud rows), where a
// genuinely deleted card would get spuriously paired with a genuinely added one
// and both miscounted as an "update" — pass `{ fuzzy: false }` there.
export function calculateSyncDiff(localCards, webCards, statusById = {}, { fuzzy = true } = {}) {
  const unmatchedWeb = new Map(webCards.map((card) => [String(card.id), card]));
  const localIds = new Set(localCards.map((card) => String(card.id)));
  const changes = {
    added: 0,
    deleted: 0,
    edited: 0,
    moved: 0,
    statusChanges: 0,
    categoryChanges: 0
  };

  localCards.forEach((localCard, index) => {
    const id = String(localCard.id);
    let webCard = unmatchedWeb.get(id) || null;

    if (!webCard && fuzzy) {
      webCard = fallbackWebCardFor(localCard, index, Array.from(unmatchedWeb.values()), localIds);
    }

    if (!webCard) {
      changes.added += 1;
      return;
    }

    unmatchedWeb.delete(String(webCard.id));

    if (syncTextChanged(localCard.question, webCard.question) || syncTextChanged(localCard.answer, webCard.answer)) {
      changes.edited += 1;
    }

    const webPosition = Number(webCard.position);
    if (Number.isFinite(webPosition) && webPosition !== index) {
      changes.moved += 1;
    }

    const localStatus = normalizeCardStatus(statusById[id]);
    const webStatus = normalizeCardStatus(webCard.status);
    if (localStatus !== webStatus) {
      changes.statusChanges += 1;
    }

    // Quick-note label moves are real changes; without this a pull that only
    // recategorised notes reported "no per-card changes".
    if ((localCard.category || null) !== (webCard.category || null)) {
      changes.categoryChanges += 1;
    }
  });

  changes.deleted = unmatchedWeb.size;
  return changes;
}
