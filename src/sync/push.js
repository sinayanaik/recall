// Writing a deck and its cards up to the cloud.
//
// The deck row is written FIRST stamped at the UNIX epoch and only rewritten
// with the real time once every card has landed — so an interrupted push leaves
// the deck looking un-synced and retriable, rather than current with cards
// missing.

import { isMissingColumnError, isMissingNotesColumnError } from "../cloud/deck-list.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, withRetry, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import { syncTextChanged } from "./diff.js?v=__BUILD__";
import { emptySyncStats } from "./stats.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// Upsert one chunk of card rows, retrying without `category` if the database
// hasn't run supabase_setup.sql yet (no cards.category column). Mirrors
// the deck-level `notes` fallback: never lose card edits over a missing
// optional column.
export async function upsertCardRows(rows) {
  if (!rows.length) return;
  // Retried on a transient network failure: an upsert of the same rows lands in
  // the same state, so replaying it is safe, and one dropped packet mid-sync
  // used to fail the whole deck.
  const upsert = (payload, label) => withRetry(
    () => withTimeout(abortable((signal) => supabaseClient.from("cards").upsert(payload).abortSignal(signal)), CLOUD_TIMEOUT_MS, label),
    { label }
  );
  const { error } = await upsert(rows, "save cards");
  if (!error) return;
  // Checked by PG error code first, exactly as isMissingNotesColumnError does.
  // Matching on the bare word "category" anywhere in the message could classify
  // an unrelated failure that merely mentions the column — a check constraint,
  // an RLS policy naming it — as "the migration hasn't run", silently strip the
  // categories out of the payload, and report the push as a clean success.
  if (!isMissingColumnError(error, "category")) throw error;
  console.warn("cards.category column missing — run supabase_setup.sql to sync quick-note categories");
  const stripped = rows.map(({ category: _omit, ...rest }) => rest);
  const { error: retryError } = await upsert(stripped, "save cards");
  if (retryError) throw retryError;
}

// Core cloud writer shared by the active-deck sync and the headless
// library-reconcile sync. Upserts the deck row and diff-upserts its cards from
// an explicit payload (never touches `state`). Throws on failure.
// `cards`: [{ id, question, answer, status, category }] in display order.
// `webCards`: this deck's existing cloud rows if the caller already fetched
// them (reconcileAllDecks fetches every deck's in one batched request), else
// null to fetch them here.
export async function pushDeckRowsToCloud({ deckId, title, category, notes, meta, currentIndex, cards, isNewDeck, overwrite, now, webCards = null, say = () => {} }) {
  const deckData = {
    id: deckId,
    title,
    category,
    notes: notes || "",
    // Symmetric with the pull side (pullCloudDeckToLibrary), which already
    // reads cloud.meta generically for any deck — this was the missing half:
    // meta only ever reached Supabase via the quick_notes-scoped writers, so
    // a normal deck's meta (e.g. a synced reading position) never left the
    // device. Whole-column last-write-wins, same as notes; this does add one
    // more writer against that column alongside the quick-notes-scoped ones,
    // accepted as the same class of risk as two devices pushing concurrently.
    meta: meta && typeof meta === "object" ? meta : {},
    current_card_index: Number.isFinite(currentIndex) ? currentIndex : 0,
    updated_at: now,
    last_accessed_at: now
  };

  // Crash-safe ordering: write the deck row FIRST (a new deck's row must exist
  // to satisfy the cards.deck_id foreign key) but with a stale `updated_at`, so
  // an interrupted push leaves the deck looking un-synced and retriable rather
  // than "current" with missing cards. The real `now` timestamp is stamped last
  // (deckBumpData below), only after every card chunk has landed.
  const PENDING_TS = new Date(0).toISOString();
  const deckDataPending = { ...deckData, updated_at: PENDING_TS };

  let { error: deckError } = await withRetry(
    () => withTimeout(abortable((signal) => supabaseClient.from("decks").upsert(deckDataPending).abortSignal(signal)), CLOUD_TIMEOUT_MS, "save deck"),
    { label: "save deck" }
  );
  // This deck is NOT fully synced if we fall into this branch — cards may
  // still go through below, but the notes text stays cloud-side stale. The
  // caller must know that, not just see a console warning: this flag rides
  // in pushStats all the way to the sync report and the "Synced" pill, so the
  // deck stops silently reading as fully synced. See isMissingNotesColumnError
  // for why this is keyed on the error code, not a loose message match.
  let notesSyncFailed = false;
  if (deckError && isMissingNotesColumnError(deckError)) {
    // Database hasn't run supabase_setup.sql yet — sync everything else so
    // the user doesn't lose card changes, but warn about notes.
    const { notes: _omit, ...deckDataWithoutNotes } = deckDataPending;
    ({ error: deckError } = await withTimeout(abortable((signal) => supabaseClient.from("decks").upsert(deckDataWithoutNotes).abortSignal(signal)), CLOUD_TIMEOUT_MS, "save deck"));
    if (!deckError && String(notes || "").trim()) {
      notesSyncFailed = true;
      // A data-loss-relevant warning, unlike routine save-confirmation toasts
      // that only make sense for an explicit action — this must fire on a
      // background sync too, or it never reaches the user at all (the only
      // caller always pushes in the background).
      showToast("Notes not synced — run supabase_setup.sql in Supabase", "error");
    }
  }
  if (deckError) throw deckError;

  let webCardsById = new Map();
  let cardsDeleted = 0;
  if (overwrite) {
    say("Syncing... (2/3) Replacing existing web cards");
    const { error } = await withTimeout(abortable((signal) => supabaseClient.from("cards").delete().eq("deck_id", deckId).abortSignal(signal)), CLOUD_TIMEOUT_MS, "replace cards");
    if (error) throw error;
  } else if (!isNewDeck) {
    say("Syncing... (2/3) Checking for changes");
    let existing = webCards;
    if (!existing) {
      const { data, error } = await withTimeout(
        // abortable(), like every other cloud call. Without it withTimeout only
        // stops WAITING for the answer — the request stays open, holding one of
        // the browser's six per-host sockets for as long as the connection
        // takes to die on its own. On a flaky mobile link that is how one
        // stalled request turned into a whole sync crawling behind its own
        // abandoned connections.
        abortable((signal) => supabaseClient
          .from("cards")
          .select("id, question, answer, position, status, category")
          .eq("deck_id", deckId)
          .abortSignal(signal)),
        CLOUD_TIMEOUT_MS,
        "read cards"
      );
      if (error) console.warn("Could not read cloud cards before push", deckId, error);
      existing = error ? null : data;
    }
    if (existing) {
      webCardsById = new Map(existing.map((wc) => [String(wc.id), wc]));
      const localIds = new Set(cards.map((c) => String(c.id)));
      const idsToDelete = existing.filter((wc) => !localIds.has(String(wc.id))).map((wc) => wc.id);
      cardsDeleted = idsToDelete.length;
      if (idsToDelete.length > 0) {
        const { error: deleteError } = await withTimeout(
          abortable((signal) => supabaseClient
            .from("cards").delete().eq("deck_id", deckId).in("id", idsToDelete)
            .abortSignal(signal)),
          CLOUD_TIMEOUT_MS,
          "prune cards"
        );
        if (deleteError) throw deleteError;
      }
    }
  }

  // Tally WHICH kind of change each row represents, not just that it changed —
  // the report names them individually (see describeSyncStats).
  const pushStats = emptySyncStats();
  const cardsData = cards
    .map((card, index) => {
      const status = normalizeCardStatus(card.status);
      const category = card.category ? String(card.category) : null;
      const webCard = webCardsById.get(String(card.id));
      if (!webCard) {
        // isNewDeck/overwrite wiped the web side, so there's nothing to diff
        // against and every row legitimately counts as an addition.
        pushStats.cardsAdded += 1;
        return { id: card.id, deck_id: deckId, question: card.question, answer: card.answer, position: index, status, category, updated_at: now };
      }
      const edited = syncTextChanged(card.question, webCard.question) || syncTextChanged(card.answer, webCard.answer);
      const moved = Number(webCard.position) !== index;
      const restacked = normalizeCardStatus(webCard.status) !== status;
      const recategorised = (webCard.category || null) !== category;
      if (!edited && !moved && !restacked && !recategorised) return null;
      if (edited) pushStats.cardsEdited += 1;
      if (moved) pushStats.cardsMoved += 1;
      if (restacked) pushStats.statusChanges += 1;
      if (recategorised) pushStats.categoryChanges += 1;
      // `category` is sent on EVERY row, never conditionally. PostgREST requires
      // all objects in a bulk upsert to share one key set (PGRST102, "All object
      // keys must match"), so omitting it on the uncategorised rows failed the
      // whole batch for any deck with a mix — and made clearing a category
      // impossible to push. Databases without the column are handled by the
      // retry in upsertCardRows.
      return { id: card.id, deck_id: deckId, question: card.question, answer: card.answer, position: index, status, category, updated_at: now };
    })
    .filter(Boolean);

  say(`Syncing... (3/3) Saving ${cardsData.length} of ${cards.length} cards`);
  const chunkSize = 50;
  // Upload chunks sequentially — parallel Promise.all could leave the cloud
  // in a partial state if chunk N fails while chunk N+1 already succeeded,
  // silently dropping the cards in the failed chunk.
  for (let i = 0; i < cardsData.length; i += chunkSize) {
    await upsertCardRows(cardsData.slice(i, i + chunkSize));
  }

  // Every card is in — NOW advance the deck's `updated_at` (and last-accessed)
  // to the real timestamp. This is the last write of the push, so a crash any
  // time before here leaves the deck stamped at PENDING_TS and therefore
  // re-pushed on the next sync, never falsely current. The caller marks the
  // local deck's lastSyncedAt only after this whole function resolves, and it
  // throws on any failure above, so a partial push is never marked synced.
  const { error: bumpError } = await withTimeout(
    abortable((signal) => supabaseClient
      .from("decks").update({ updated_at: now, last_accessed_at: now }).eq("id", deckId)
      .abortSignal(signal)),
    CLOUD_TIMEOUT_MS,
    "finalize deck"
  );
  if (bumpError) throw bumpError;

  pushStats.cardsDeleted = cardsDeleted;
  pushStats.notesSyncFailed = notesSyncFailed;
  return pushStats;
}
