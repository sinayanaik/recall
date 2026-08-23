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

// Union of two pdfHighlights arrays, keyed by id — the document's answer to
// mergeCloudCardsIntoSnapshot, and the same reasoning: an id is minted once and
// never reused, so a union is exactly right for adds, and a per-record timestamp
// is what settles a genuine conflict on the same record.
//
// Returns null when NEITHER side has any — so a deck that is not a PDF deck
// never grows an empty key in its meta bag, and the ordinary cloud-wins
// behaviour of every other key is untouched.
//
// ── Two stamps, resolved independently ────────────────────────────────────
//
// This used to keep whichever WHOLE record had the newer `at`, and `at` was
// bumped by every edit — including writing the note. So one field dated two
// unrelated things: a highlight recoloured on a phone and a note written on it
// from a laptop each bumped the same number, and whichever landed second took
// the other's work with it.
//
// A note now stamps `noteAt` and nothing else (see setDocumentHighlightNote),
// and the two are resolved separately: the visual record — colour, page, quads,
// kind — comes from whichever side has the newer `at`, and `noteAt` is simply
// the later of the two, because it dates text that does not live in this record
// at all (it is in the fenced block at the end of `notes`, merged by
// mergeHighlightNoteTails, which reads exactly this stamp).
//
// `tombstones` is { [id]: ms } — see src/sync/document-sync.js. A record whose
// deletion is newer than its own `at` is dropped rather than resurrected: the
// only thing that used to make a deleted highlight stay deleted was the
// whole-column last-write-wins that a merge, by existing, removes.
export function mergePdfHighlights(cloudList, localList, { tombstones = null } = {}) {
  const cloud = Array.isArray(cloudList) ? cloudList : null;
  const local = Array.isArray(localList) ? localList : null;
  if (!cloud && !local) return null;
  const buried = tombstones && typeof tombstones === "object" ? tombstones : {};
  const byId = new Map();
  const take = (record) => {
    if (!record?.id) return;
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      return;
    }
    // A record with no timestamp at all (written by a build from before this
    // existed) is treated as older than one that has one — the same rule
    // betterReadingPosition uses for the same reason.
    const primary = (existing.at || 0) >= (record.at || 0) ? existing : record;
    const noteAt = Math.max(existing.noteAt || 0, record.noteAt || 0);
    byId.set(record.id, noteAt ? { ...primary, noteAt } : { ...primary });
  };
  (cloud || []).forEach(take);
  (local || []).forEach(take);
  return [...byId.values()].filter((record) => {
    const deletedAt = Number(buried[record.id] || 0);
    // "Newer than the record" and not merely "present": a highlight re-made over
    // the same words after a delete is a new annotation, not a resurrection, and
    // it carries a later `at` to say so.
    return !(deletedAt && deletedAt >= (record.at || 0) && deletedAt >= (record.noteAt || 0));
  });
}
