// Reading the deck index out of the cloud, and deciding what each deck's sync
// status is.
//
// Every read here has to survive a project whose schema is older than the app:
// a missing table or column is reported as "that feature is not set up" rather
// than failing the whole sync, because each install owns its own database and
// may simply not have run the latest setup SQL.

import { CLOUD_TIMEOUT_MS, abortable, mapWithConcurrency, withTimeout } from "./net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "./supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { showNotesConflictModal } from "../sync/notes-conflict.js?v=__BUILD__";
import { tsMs } from "../sync/stats.js?v=__BUILD__";

// Just enough of every deck to decide which way it needs to sync, and enough
// to paint My Decks / list cloud-only decks for export — id, title, category,
// and the two timestamps are all any caller reads. This used to be a separate,
// heavier `fetchCloudDeckList` that did `select("*, cards(count)")` — every
// deck's ENTIRE notes markdown plus a per-deck aggregate over the whole cards
// table, on every sync AND every My Decks render, purely to compare two
// timestamps or list a title. For a library of EPUB-imported decks that was
// megabytes of transfer before any real work started, and it fired far more
// often than sync — every folder click, every category filter change. The
// columns here are the ones any caller actually reads; the bodies come back in
// fetchCloudDeckRows, for the handful of decks that need them.
export const DECK_INDEX_COLUMNS = "id, title, category, updated_at, last_accessed_at, created_at, current_card_index";

// What a SYNC needs, which is less than what My Decks needs. Worth splitting
// because this is the most frequent query in the app: it runs on every
// auto-sync, over EVERY deck, whether or not anything changed — so on a
// 700-deck library it is the one read that repeats forever regardless of how
// little is happening.
//
// `id` and `updated_at` are what the reconcile actually decides on (which deck
// to pull or push, and the complete id set the deletion pass depends on). The
// pull and push paths take everything else from fetchCloudDeckRows, for the
// handful of decks genuinely moving.
//
// `title` and `category` ride along for one narrow reason: when a deck's body
// read comes back missing (it was deleted between the index read and the body
// read) the push falls back to the index row to diff against, and reads
// exactly those two to report what changed. Dropping them would save a little
// more and quietly make that report wrong, which is not a trade worth taking
// in this file. The three that ARE dropped — last_accessed_at, created_at,
// current_card_index — are read by the library UI and by nothing in sync.
//
// Ordering below sorts on updated_at then id, both present here, so paging
// stays exactly as deterministic as with the full set.
export const DECK_SYNC_INDEX_COLUMNS = "id, updated_at, title, category";

// PAGED, and that is now load-bearing rather than tidy: reconcile treats a deck
// missing from this list as deleted in the cloud (see the deletion-adoption pass
// in reconcileAllDecks). PostgREST caps a response at ~1000 rows, so an unpaged
// read would silently present every deck past the cap as deleted and take the
// local copies with it. Keep asking until a short page comes back.
// The reconcile derives DELETIONS from what is missing here, so a short read is
// not a performance detail — it is data loss. Two things make it provably whole:
//
//   • a stable sort. Paging with `.order("updated_at")` alone is unsound:
//     timestamps tie (a bulk import stamps many decks the same millisecond) and
//     Postgres is free to order ties differently per page, so a row can appear
//     on both pages or on neither. The one that lands on neither reads as a
//     deleted deck. `id` is unique, so adding it as a tiebreak makes the total
//     order deterministic across requests.
//   • an exact count. Even with stable paging, a row inserted or deleted by
//     another device mid-read shifts the window. Comparing what we assembled
//     against the server's own count turns "silently short" into a thrown
//     error — and a throw is safe, because the caller aborts the sync while a
//     short list would have deleted decks.
export async function fetchCloudDeckIndex(columns = DECK_INDEX_COLUMNS) {
  const byId = new Map();
  const pageSize = 1000;
  let expectedTotal = null;
  for (let from = 0; ; from += pageSize) {
    const { data, error, count } = await withTimeout(
      abortable((signal) => supabaseClient
        .from("decks")
        .select(columns, { count: "exact" })
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1)
        .abortSignal(signal)),
      CLOUD_TIMEOUT_MS,
      "read deck index"
    );
    if (error) throw error;
    if (typeof count === "number") expectedTotal = count;
    const page = data || [];
    // Keyed by id rather than appended: if a concurrent write did shift the
    // window, an overlap is a duplicate row, not a second deck.
    for (const row of page) byId.set(String(row.id), row);
    if (page.length < pageSize) break;
  }
  const rows = [...byId.values()];
  if (expectedTotal !== null && rows.length < expectedTotal) {
    throw new Error(`Deck index read was incomplete (${rows.length} of ${expectedTotal}) — not treating the gap as deletions`);
  }
  return rows;
}

// Full rows (notes + meta included) for a specific set of decks — the ones a
// sync has decided to pull or push. Returns a Map keyed by deck id.
// CHUNKED, and load-bearing for the same reason the index read is paged: these
// rows are the ONLY source of a deck's notes and meta (DECK_INDEX_COLUMNS
// carries neither). PostgREST caps a response at ~1000 rows, so a single
// `.in()` over a big library silently returned nothing for the decks past the
// cap — and the pull then had a deck row with no `notes` key at all, which it
// wrote as empty notes. Chunks stay well under the cap, so a row missing from
// the result now means only one thing: that deck really isn't in the cloud.
// (A long `.in()` list is also a very long URL; chunking fixes that too.)
export async function fetchCloudDeckRows(deckIds) {
  const byId = new Map();
  if (!deckIds.length) return byId;
  // Sized by RESPONSE, not by the row cap. These are full rows — every deck's
  // entire notes markdown — and a book-length note is megabytes on its own, so
  // 200 of them in one response is tens of megabytes against a 20s timeout that
  // is meant for a phone. The whole chunk then fails, retries once, and fails
  // again, which is how a sync of a large library presented as a hang. 25 keeps
  // each request small enough to finish and cheap enough to retry; the extra
  // round trips cost far less than one timeout does.
  const chunkSize = 25;
  const chunks = [];
  for (let i = 0; i < deckIds.length; i += chunkSize) chunks.push(deckIds.slice(i, i + chunkSize));

  // CONCURRENT, where this was a plain `for … await`. Each chunk is an
  // independent read of a disjoint set of ids, so nothing about the sequence
  // was load-bearing — it was simply how the loop was written, and it cost a
  // full round trip per 25 decks before a single deck could be merged. On a
  // library of 700 that is 28 trips end to end, on a phone, before the sync
  // appears to do anything.
  //
  // The concurrency is small on purpose. These are FULL deck rows — every
  // deck's entire notes markdown — so the ceiling that matters is not the
  // server's, it is the 20s timeout each request is given and the bandwidth
  // they are sharing. Five 25-deck responses in flight is roughly one large
  // response's worth of data at a time, which is the size this was tuned to
  // finish; raising it trades the round trips saved for requests that start
  // timing out, and a timeout here costs a retry and then the deck.
  const results = await mapWithConcurrency(chunks, 5, async (chunk) => {
    const { data, error } = await withTimeout(
      abortable((signal) => supabaseClient
        .from("decks")
        .select("*")
        .in("id", chunk)
        .abortSignal(signal)),
      CLOUD_TIMEOUT_MS,
      "read deck bodies"
    );
    // Thrown, not collected. mapWithConcurrency runs its workers under
    // Promise.all, so this rejects the whole read — which is the required
    // behaviour, not a convenience: the caller treats a deck missing from this
    // map as "not in the cloud", and a partial map would therefore read a
    // failed chunk as a batch of deleted decks.
    if (error) throw error;
    return data || [];
  });
  for (const rows of results) {
    for (const row of rows) byId.set(String(row.id), row);
  }
  return byId;
}

// Cards for MANY decks in one request, instead of one round trip per deck.
// On a phone each round trip costs a full RTT, so a 20-deck sync spent most of
// its time waiting rather than transferring — the per-deck loops now read from
// the map this returns. Paged because PostgREST caps a response at ~1000 rows
// (a limit a per-deck query rarely hit but a batched one easily does): keep
// asking until a short page comes back, or rows would be silently dropped and
// the sync would read the missing cards as "deleted in the cloud".
//
// Also count-verified, the same way fetchCloudDeckIndex is: a short-page check
// alone only catches a read that came back FULLY short, not one where a
// concurrent write shifted the window mid-page (same row count, wrong rows,
// or an off-by-a-few miss). The callers that matter — mergeCloudCardsIntoSnapshot
// and reconcileCardsBeforePush — drop a local card the moment it's absent from
// this result, so an unverified partial read here costs a card, not just a
// deck; see the (now corrected) comment this used to leave in
// pushLibraryDeckToCloud claiming this always returns a complete list.
// CHUNKED BY DECK as well as paged by row, and the chunking is a hard limit
// rather than a tuning choice. `.in("deck_id", ids)` becomes a query STRING —
// PostgREST reads it from the URL — so the id list has to fit in a request line.
// A uuid costs ~46 characters once the quotes and commas are percent-encoded,
// which puts 200 decks at ~9KB, past the 8KB request-line ceiling that nginx
// and most proxies ship with by default. The server answers 414 and the sync
// fails outright — and it only starts happening at a library size the developer
// is unlikely to have, having worked fine for every smaller one. A restore is
// how you get there in one step: every restored deck needs a pull, so the very
// next sync asks for all of them at once.
export const CARD_FETCH_DECK_CHUNK = 50;

export async function fetchCardsForDecks(deckIds, columns = "*") {
  const byDeck = new Map(deckIds.map((id) => [String(id), []]));
  if (!deckIds.length) return byDeck;
  const chunks = [];
  for (let i = 0; i < deckIds.length; i += CARD_FETCH_DECK_CHUNK) {
    chunks.push(deckIds.slice(i, i + CARD_FETCH_DECK_CHUNK));
  }

  // CONCURRENT, for the same reason as fetchCloudDeckRows above, with one extra
  // thing to be careful about: each chunk is itself a PAGING loop, so this is
  // four page-walks at a time rather than four requests. That is deliberate —
  // the paging inside a chunk must stay sequential (each page's `from` depends
  // on the last one having come back short or not), and it is exactly the part
  // that made a large library slow: 14 chunks of 50 decks, each walking several
  // 1000-row pages, all strictly one after another.
  //
  // Every chunk writes into DIFFERENT buckets of `byDeck` — the buckets are
  // pre-created above, keyed by deck id, and a chunk only ever touches the ids
  // it asked for — so concurrent writes cannot interleave into the same array.
  // Order within a bucket is preserved by the per-chunk ordering in
  // readCardPagesForDecks, which is what the position tiebreak is for.
  //
  // A short read still throws from inside readCardPagesForDecks and still takes
  // the whole call down with it. That is the guarantee mergeCloudCardsIntoSnapshot
  // depends on: it drops a local card the moment the card is absent from this
  // result, so a partial answer here costs cards, not just time.
  await mapWithConcurrency(chunks, 4, (chunk) => readCardPagesForDecks(chunk, columns, byDeck));
  return byDeck;
}

// One chunk of decks, read to completion and verified. Split out of
// fetchCardsForDecks so the paging and the count check stay a single unit that
// applies per request set — a chunk that came back short must throw on its own,
// not be averaged into a total that happens to look right.
export async function readCardPagesForDecks(deckIds, columns, byDeck) {
  const seen = new Set();
  const pageSize = 1000;
  let expectedTotal = null;
  for (let from = 0; ; from += pageSize) {
    const { data, error, count } = await withTimeout(
      abortable((signal) => supabaseClient
        .from("cards")
        .select(columns, { count: "exact" })
        .in("deck_id", deckIds)
        .order("deck_id", { ascending: true })
        .order("position", { ascending: true })
        // Unique tiebreak. (deck_id, position) is NOT unique — a merge can leave
        // two cards on the same position — and ties order arbitrarily per page,
        // so without this a card can fall between two pages. A card missing from
        // this read is read as deleted by the merge, so the gap costs the card.
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1)
        .abortSignal(signal)),
      CLOUD_TIMEOUT_MS,
      "download cards"
    );
    if (error) throw error;
    if (typeof count === "number") expectedTotal = count;
    const rows = data || [];
    for (const row of rows) {
      const bucket = byDeck.get(String(row.deck_id));
      if (!bucket) continue;
      // Guard against an overlapping page re-delivering a row we already have.
      const key = String(row.id);
      if (seen.has(key)) continue;
      seen.add(key);
      bucket.push(row);
    }
    if (rows.length < pageSize) break;
  }
  if (expectedTotal !== null && seen.size < expectedTotal) {
    throw new Error(`Card read was incomplete (${seen.size} of ${expectedTotal}) — not treating the gap as deletions`);
  }
}

// Cross-device delete tombstones (see supabase_setup.sql, section 3). A local
// tombstone alone only stops THIS device from resurrecting a deck it deleted —
// another device that hasn't reconciled since still holds a local copy and
// will push it right back. This durable, shared list is what lets that other
// device learn "this deck was deleted elsewhere" before it re-pushes.
// Best-effort: an unmigrated project (table doesn't exist yet) degrades to the
// old local-only behavior rather than breaking sync — but says so, see below.
//
// Set when the deleted_decks table doesn't exist. Cross-device deck deletion is
// then impossible: every device holding a copy of a deck deleted elsewhere
// re-pushes it on its next sync, forever. That used to be a console warning
// nobody sees on a phone; reconcileAllDecks now surfaces it.
export let deckTombstoneTableMissing = false;

// PostgREST reports an unknown table as 42P01 ("undefined_table"), sometimes as
// a bare message. Distinguished from a transient failure because the remedy is
// a migration, not a retry.
export function isMissingRelationError(error) {
  if (!error) return false;
  if (String(error.code || "") === "42P01") return true;
  const message = String(error.message || error).toLowerCase();
  return message.includes("does not exist") || message.includes("could not find the table");
}

// PostgREST reports an unknown column as 42703 ("undefined_column"), sometimes
// as a bare message. Checked by code first — matching on the column name
// anywhere in the message (the old approach) could misclassify an unrelated
// error that merely mentions the column (a check constraint, an RLS policy
// naming it) as "the migration hasn't run", silently drop the payload, and
// report the push as a clean success. See pushDeckRowsToCloud.
export function isMissingColumnError(error, column) {
  if (!error) return false;
  if (String(error.code || "") === "42703") return true;
  const message = String(error.message || error).toLowerCase();
  return message.includes(String(column).toLowerCase())
    && message.includes("column")
    && message.includes("does not exist");
}

export function isMissingNotesColumnError(error) {
  return isMissingColumnError(error, "notes");
}

export async function fetchDeletedDeckIds() {
  try {
    // Paged for the same reason fetchCardsForDecks is: PostgREST caps a response
    // at ~1000 rows, and tombstones are never pruned from the shared table. Past
    // that cap the truncated list silently omits deletions — and a deck whose
    // tombstone is missing is a deck another device happily resurrects.
    const ids = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await withTimeout(
        abortable((signal) => supabaseClient.from("deleted_decks").select("deck_id").range(from, from + pageSize - 1).abortSignal(signal)),
        CLOUD_TIMEOUT_MS,
        "read tombstones"
      );
      if (error) throw error;
      const rows = data || [];
      for (const row of rows) ids.push(String(row.deck_id));
      if (rows.length < pageSize) break;
    }
    deckTombstoneTableMissing = false;
    return ids;
  } catch (error) {
    deckTombstoneTableMissing = isMissingRelationError(error);
    console.warn("Could not fetch deck-deletion tombstones (run supabase_setup.sql?)", error);
    return [];
  }
}

// Per-deck sync state for the My Decks "Sync" column, comparing the on-device
// copy against the cloud (when we can reach it). `cloudById` is a Map of cloud
// decks, or null when we haven't/can't fetch it. Mirrors the timestamp logic
// reconcileAllDecks uses to decide direction, so the column predicts what the
// next sync will do to each deck.
// Presentation-agnostic sync state — { label, cls, title } — consumed by both the
// table "Sync" cell and the grid-tile sync badge. `cloudOnly` short-circuits to the
// cloud-only badge (a deck not yet on this device).
export function deckSyncStatus(deck, cloudById, cloudOnly = false) {
  if (cloudOnly) {
    return { label: "Cloud only", cls: "sync-cloud-only", title: "In the cloud but not on this device yet — Load to pull it down." };
  }
  // Checked first, and outside every network branch, because a stashed notes
  // copy is a purely LOCAL condition: it sits beside the deck on this device
  // whatever the cloud is doing, and it is the only status here the reader has
  // to act on. It used to be tested last, inside the branch that needs a live
  // cloud row AND exactly matching timestamps, so the pill vanished the moment
  // the deck had any pending edit — taking the only route to the resolver with
  // it, while the unanswered conflict stayed on disk.
  if (deck.notesConflicted) {
    return {
      label: "Notes conflict",
      cls: "sync-error",
      title: "A newer notes edit from another device replaced yours here. Your copy was kept — tap to choose which version to keep.",
      conflictId: deck.id
    };
  }
  const canCloud = Boolean(supabaseClient && isSignedIn);
  let label, cls, title;
  if (!canCloud) {
    label = "On device"; cls = "sync-local";
    title = "Saved on this device. Sign in to back it up to the cloud.";
  } else if (!navigator.onLine || !cloudById) {
    if (!deck.deckId) {
      label = "Pending"; cls = "sync-pending";
      title = "Not uploaded yet — will sync once you're back online.";
    } else {
      label = "Offline"; cls = "sync-local";
      title = "Can't reach the cloud right now — will re-check when you're online.";
    }
  } else if (!deck.deckId) {
    label = "Pending"; cls = "sync-pending";
    title = "Not uploaded yet — will upload on the next sync.";
  } else {
    const cloud = cloudById.get(String(deck.deckId));
    if (!cloud) {
      label = "Pending"; cls = "sync-pending";
      title = "Not in the cloud yet — will upload on the next sync.";
    } else {
      const localMs = tsMs(deck.updatedAt);
      const cloudMs = tsMs(cloud.updated_at);
      if (localMs > cloudMs) {
        label = "Pending"; cls = "sync-pending";
        title = "Edited here since the last sync — will upload on the next sync.";
      } else if (cloudMs > localMs) {
        label = "Update"; cls = "sync-behind";
        title = "A newer copy is in the cloud — will download on the next sync.";
      } else if (deck.notesSyncFailed) {
        // Cards and the deck row matched, but the notes column specifically
        // never reached the cloud (see pushDeckRowsToCloud) — timestamps alone
        // would read this as fully synced, which is exactly the bug this flag
        // exists to stop.
        label = "Notes not synced"; cls = "sync-error";
        title = "Cards synced, but notes did not — run supabase_setup.sql in Supabase.";
      } else {
        label = "Synced"; cls = "sync-ok";
        title = "In sync with the cloud.";
      }
    }
  }
  return { label, cls, title };
}

export function deckSyncStatusCell(deck, cloudById) {
  const { label, cls, title, conflictId } = deckSyncStatus(deck, cloudById);
  const td = document.createElement("td");
  td.dataset.label = "Sync";
  td.classList.add("my-deck-sync", cls);
  // The label lives in an inner span so the pill can be a shrink-wrapped
  // inline-flex box; a <td> stretches to its column and would tint the whole
  // cell instead of drawing a badge.
  const pill = document.createElement("span");
  pill.textContent = label;
  // The one status that is an unanswered question rather than a report, so it's
  // the one that opens something. A real <button> so it's reachable by keyboard
  // and announced as actionable; stopPropagation because the row itself loads
  // the deck, and picking a version is not that.
  if (conflictId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "my-deck-sync-action";
    button.append(pill);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      showNotesConflictModal(conflictId);
    });
    td.append(button);
  } else {
    td.append(pill);
  }
  td.title = title;
  return td;
}

// Repopulates the category filter from every known category, preserving the
// current selection when it still exists. Returns the active filter value.
export function populateMyDecksCategoryFilter(categories) {
  const filter = el.myDecksCategoryFilter;
  if (!filter) return "";

  const selected = filter.value || "";
  filter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All folders";
  filter.appendChild(allOption);
  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    filter.appendChild(option);
  });
  filter.value = categories.includes(selected) ? selected : "";
  return filter.value;
}
