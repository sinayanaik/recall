// Writing a deck and its cards up to the cloud.
//
// The deck row is written FIRST stamped at the UNIX epoch and only rewritten
// with the real time once every card has landed — so an interrupted push leaves
// the deck looking un-synced and retriable, rather than current with cards
// missing.
//
// ── ...and it is written only if nobody else wrote first ───────────────────
//
// Everything the caller merged — the cards, the highlights, the ink, the blocks,
// the notes, every key of the meta bag — was merged against a cloud row read
// ONCE, up front, before three decks began pushing at a time. Between that read
// and this write another device's push can land, and this used to be a plain
// upsert: the second writer took the whole notes and meta column, discarding a
// merge that was correct when it was computed. The comment on `meta` below said
// so out loud and called it accepted risk.
//
// It is a compare-and-swap now. `expectedUpdatedAt` is the row the merge
// actually read; an existing deck is an UPDATE predicated on it, and a new one
// is an INSERT, which is the same test spelled for a row that must not exist
// yet. Zero rows affected means the row moved, and the caller re-reads and
// re-merges rather than overwriting — see pushLibraryDeckToCloud.
//
// The PENDING_TS sentinel is orthogonal to all of that and stays exactly as it
// was. The one hazard it leaves open is worth naming rather than pretending
// away: while a push is in flight its row reads as the epoch, so another device
// sees an ancient cloud and pushes. The window is one card upload wide, the card
// writes are per-row merges regardless, and closing it properly needs a lock
// this schema does not have.

import { isMissingColumnError, isMissingNotesColumnError } from "../cloud/deck-list.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, withRetry, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { sanitizeUnicodeDeep, stripInvalidUnicode } from "../core/text.js?v=__BUILD__";
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
// Raised when the deck row moved between the read the caller merged against and
// this write. Not an error in the ordinary sense — nothing is wrong and nothing
// is lost — so it carries its own name and the caller catches it by that rather
// than by matching a message.
export class DeckRowMovedError extends Error {
  constructor(deckId) {
    super(`Deck ${deckId} was written by another device between the read and the push`);
    this.name = "DeckRowMovedError";
    this.deckRowMoved = true;
    // A code, so withRetry can never read this as transient. Its second test is
    // `!error.code && /network|connection|socket|…/`, which today's message does
    // not match — but a message is prose and this is a contract, and replaying a
    // compare-and-swap that has already been told the row moved would be a retry
    // that can only fail again.
    this.code = "DECK_ROW_MOVED";
  }
}

export async function pushDeckRowsToCloud({ deckId, title, category, notes, meta, currentIndex, cards, isNewDeck, overwrite, now, webCards = null, expectedUpdatedAt = null, sendCurrentIndex = true, say = () => {} }) {
  // ── Nothing Postgres refuses leaves this device ──────────────────────────
  //
  // The last chokepoint, not the fix: this is the only writer of the decks and
  // cards tables, so a strip here means no future caller can fail a whole deck
  // on one U+0000 the way a PDF's title once did (see src/sync/text-repair.js
  // and core/text.js for what the characters are and where they come from).
  //
  // It is NOT sufficient on its own, and must not become the only defence —
  // sanitizing only what goes on the wire leaves the local copy different from
  // the cloud's, and syncTextChanged then reports every card as edited on every
  // sync forever. repairSnapshotText, on the save and the push paths, is what
  // keeps the two sides identical; this is what makes the failure impossible.
  const deckData = {
    id: deckId,
    title: stripInvalidUnicode(title),
    category: category === null || category === undefined ? category : stripInvalidUnicode(category),
    notes: stripInvalidUnicode(notes || ""),
    // Symmetric with the pull side (pullCloudDeckToLibrary), which already
    // reads cloud.meta generically for any deck — this was the missing half:
    // meta only ever reached Supabase via the quick_notes-scoped writers, so
    // a normal deck's meta (e.g. a synced reading position) never left the
    // device. Whole-column last-write-wins, same as notes; this does add one
    // more writer against that column alongside the quick-notes-scoped ones,
    // accepted as the same class of risk as two devices pushing concurrently.
    meta: sanitizeUnicodeDeep(meta && typeof meta === "object" ? meta : {}),
    updated_at: now,
    last_accessed_at: now
  };

  // ── Where the reader is in the CARDS is a position, not shared content ────
  //
  // current_card_index went up on every push, whole, like the title. But it is
  // not a fact about the deck the way a title is — it is where THIS device was
  // in it, the cards' equivalent of meta.readingPosition — so pushing it
  // unconditionally meant the laptop's place overwrote the phone's every sync,
  // for a device that had not opened the Cards panel at all.
  //
  // The cheap fix rather than a stamped record: a device that did not move it
  // omits the column. PostgREST takes a partial object on an update, so this is
  // a key left out and not a null written, and the cloud keeps whatever the
  // device that DID move it last said.
  if (sendCurrentIndex) deckData.current_card_index = Number.isFinite(currentIndex) ? currentIndex : 0;
  // Reported back, so the caller only records a baseline for a value it actually
  // sent — see entry.syncedCurrentIndex in pushLibraryDeckToCloud.
  const currentIndexSent = Boolean(sendCurrentIndex);

  // Crash-safe ordering: write the deck row FIRST (a new deck's row must exist
  // to satisfy the cards.deck_id foreign key) but with a stale `updated_at`, so
  // an interrupted push leaves the deck looking un-synced and retriable rather
  // than "current" with missing cards. The real `now` timestamp is stamped last
  // (deckBumpData below), only after every card chunk has landed.
  const PENDING_TS = new Date(0).toISOString();
  const deckDataPending = { ...deckData, updated_at: PENDING_TS };

  // ── The compare-and-swap ──────────────────────────────────────────────────
  //
  // A new deck is an INSERT: "this row must not exist yet" is the same test as
  // "this row is still the one I read", spelled for a row that has never been
  // read. A unique violation means another device created it first, which is a
  // lost race like any other and is reported as one.
  //
  // An existing deck is an UPDATE predicated on the stamp the caller merged
  // against, asking for the id back so a zero-row answer can be told from a
  // one-row one. Without `.select()` PostgREST returns no body and a write that
  // matched nothing is indistinguishable from a write that landed — which is
  // the worst possible failure here: every push a silent no-op reporting success.
  //
  // No expectedUpdatedAt is the caller saying it has nothing to compare against
  // (an overwrite, a repair). Then it is the old unconditional upsert, because
  // refusing on evidence nobody has would strand the deck for ever.
  const writeDeckRow = async (payload, label) => {
    if (isNewDeck) {
      const inserted = await withTimeout(abortable((signal) => supabaseClient.from("decks").insert(payload).abortSignal(signal)), CLOUD_TIMEOUT_MS, label);
      // 23505 is unique_violation: the row is already there, so "new" was wrong
      // — another device created it between the index read and now, or this
      // device holds an id the index did not list. Reported as a lost race
      // rather than as a failure, because it is one, and answered the same way:
      // the caller re-reads the row and merges against it. Emphatically NOT
      // retried as an upsert — this push's content was computed as if the cloud
      // held nothing, so sending it would erase whatever is actually there.
      if (inserted.error?.code === "23505") throw new DeckRowMovedError(deckId);
      return inserted;
    }
    if (!expectedUpdatedAt) {
      return withTimeout(abortable((signal) => supabaseClient.from("decks").upsert(payload).abortSignal(signal)), CLOUD_TIMEOUT_MS, label);
    }
    const result = await withTimeout(
      abortable((signal) => supabaseClient
        .from("decks").update(payload).eq("id", deckId).eq("updated_at", expectedUpdatedAt).select("id")
        .abortSignal(signal)),
      CLOUD_TIMEOUT_MS,
      label
    );
    if (!result.error && Array.isArray(result.data) && result.data.length === 0) throw new DeckRowMovedError(deckId);
    return result;
  };

  // Retried on a transient network failure exactly as before — and safely,
  // because a CAS is idempotent in the way an upsert is not: the retry either
  // still matches the row it read or raises DeckRowMovedError, and the second
  // outcome is the one the caller is prepared for.
  let { error: deckError } = await withRetry(
    () => writeDeckRow(deckDataPending, "save deck"),
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
    ({ error: deckError } = await writeDeckRow(deckDataWithoutNotes, "save deck"));
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
      const category = card.category ? stripInvalidUnicode(String(card.category)) : null;
      // Sanitized ONCE, then used for both the comparison below and the payload:
      // diffing the raw text against a cloud row written from the clean text
      // would report an edit on every sync for a card that never changed.
      const question = stripInvalidUnicode(card.question);
      const answer = stripInvalidUnicode(card.answer);
      const webCard = webCardsById.get(String(card.id));
      if (!webCard) {
        // isNewDeck/overwrite wiped the web side, so there's nothing to diff
        // against and every row legitimately counts as an addition.
        pushStats.cardsAdded += 1;
        return { id: card.id, deck_id: deckId, question, answer, position: index, status, category, updated_at: now };
      }
      const edited = syncTextChanged(question, webCard.question) || syncTextChanged(answer, webCard.answer);
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
      return { id: card.id, deck_id: deckId, question, answer, position: index, status, category, updated_at: now };
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
  //
  // Predicated on the sentinel this same push wrote, for the same reason the
  // first write is predicated on the row it merged against: between the two, a
  // device that saw the epoch stamp and concluded the cloud was ancient may have
  // pushed a whole deck of its own. Bumping unconditionally would stamp THEIR
  // row with OUR timestamp and hide their write from every device for ever.
  // Zero rows here is the same lost race, answered the same way.
  const bumpResult = await withTimeout(
    abortable((signal) => supabaseClient
      .from("decks").update({ updated_at: now, last_accessed_at: now })
      .eq("id", deckId).eq("updated_at", PENDING_TS).select("id")
      .abortSignal(signal)),
    CLOUD_TIMEOUT_MS,
    "finalize deck"
  );
  if (bumpResult.error) throw bumpResult.error;
  if (Array.isArray(bumpResult.data) && bumpResult.data.length === 0) throw new DeckRowMovedError(deckId);

  pushStats.cardsDeleted = cardsDeleted;
  pushStats.notesSyncFailed = notesSyncFailed;
  pushStats.currentIndexSent = currentIndexSent;
  return pushStats;
}
