// Every cloud call is bounded, retried and rate-limited.
//
// The failure this exists for is not being offline — that fails fast and is
// handled. It is a network that is up and answers nothing: a captive portal, a
// dead cell. There, fetch neither resolves nor rejects, and an unbounded sync
// hangs forever with no way for the user to tell it apart from a slow one.

// How long any single cloud read/write is allowed to hang before we give up.
// A Supabase call over a dropped/stalled connection otherwise never settles,
// wedging sync (reconcileInFlight never resets) or an EPUB import (whose
// Cancel only polls between steps, not during a hung await).
export const CLOUD_TIMEOUT_MS = 20000;

// Where withTimeout looks for the AbortController belonging to a request (see
// abortable() below).
export const CLOUD_ABORT = Symbol("cloudAbort");

// Reject a hangable network promise after `ms` so a stalled connection fails
// cleanly instead of hanging forever. The message carries "load failed" so it
// classifies as offline through the existing detection regex (see the reconcile
// catch) and the user sees "Couldn't reach the cloud" rather than a spinner
// that never stops. The underlying request may still complete server-side; we
// only wrap idempotent upserts/reads/uploads, so a late success is harmless.
export function withTimeout(promise, ms = CLOUD_TIMEOUT_MS, label = "") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // supabase-js query builders are thenable and expose .abortSignal(), but
      // by the time we get here the request is already in flight — so cancel it
      // through the AbortController the caller attached, if any. Racing a timer
      // alone left the connection open and consuming one of the browser's very
      // few per-host sockets, which on a flaky mobile link is what turned one
      // stalled request into a whole sync crawling behind it.
      try { promise?.[CLOUD_ABORT]?.abort(); } catch (_) { /* already settled */ }
      reject(new Error(`Load failed — request timed out${label ? ` (${label})` : ""}`));
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// Wrap a supabase-js query so a withTimeout on it actually cancels the request
// instead of just giving up on the answer. Kept separate from withTimeout
// because not every awaitable it wraps is a query builder — Storage uploads,
// for one, take no signal in supabase-js v2.
export function abortable(buildQuery) {
  const controller = new AbortController();
  const query = buildQuery(controller.signal);
  try { query[CLOUD_ABORT] = controller; } catch (_) { /* frozen thenable */ }
  return query;
}

// Is this the network giving out, as opposed to the server saying no? Only the
// former is worth retrying — replaying an RLS rejection or a schema error just
// burns time and ends in the same place. Matches the same shapes the reconcile
// catch already classifies as "offline".
export function isTransientCloudError(error) {
  const message = String(error?.message || error || "");
  if (/failed to fetch|networkerror|load failed|timed out|aborted/i.test(message)) return true;
  // PostgREST/PostgreSQL surface real refusals with a code; those are final.
  return !error?.code && /network|connection|socket|econn|timeout/i.test(message);
}

// Retry an IDEMPOTENT cloud operation through a transient network failure.
// Every call site is a select, an upsert, or a delete-by-id — replaying any of
// them lands in the same final state, which is what makes this safe. A single
// dropped packet used to mark a whole deck "failed" for the run and leave the
// user to notice and re-sync by hand.
export async function withRetry(operation, { tries = 2, baseMs = 500, label = "" } = {}) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === tries - 1 || !isTransientCloudError(error)) throw error;
      // Don't sit through a backoff for a connection that's simply gone.
      if (!navigator.onLine) throw error;
      console.warn(`Retrying ${label || "cloud request"} after a transient failure`, error);
      await new Promise((resolve) => setTimeout(resolve, baseMs * (attempt + 1)));
    }
  }
  throw lastError;
}

// Run `worker` over `items` with at most `limit` in flight. Pushing decks one
// at a time meant a 20-deck sync paid 60+ sequential round trips — on a phone,
// almost all of it spent waiting rather than transferring. Results come back in
// input order.
//
// A throwing worker rejects the WHOLE call, via the Promise.all below. Both
// behaviours are used, deliberately, and which one a call site wants depends
// entirely on what a missing result would be read as:
//
//   • The push loop (reconcileAllDecks) wraps its own body and never throws, so
//     one deck failing is recorded as a failed deck and the rest continue.
//     A deck that didn't push is simply a deck that pushes next time.
//   • The chunked READS (fetchCloudDeckRows, fetchCardsForDecks) deliberately
//     let the throw through, because their results are read as facts about what
//     exists in the cloud: a deck missing from the map means "deleted", and a
//     card missing from it means "delete this card". A partial answer there is
//     not slower or less complete, it is WRONG, and the count checks that guard
//     against exactly that would be pointless if a failed chunk could be
//     silently dropped instead.
//
// Runners already in flight when one rejects are left to settle and are
// discarded. Their rejections are still handled — Promise.all attaches to every
// runner — so a second failure cannot surface as an unhandled rejection.
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
