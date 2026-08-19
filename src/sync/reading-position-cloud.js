// Pushing meta.readingPosition to the cloud, on its own — not as a passenger
// on a full deck sync.
//
// reconcileAllDecks (reconcile.js) already carries a narrow write for this
// (see its own comment there), but it only ever runs at the moments a FULL
// sync happens to run: explicit Sync Now, boot, reconnecting, coming back to
// the foreground after being hidden 60s+, or the auto-sync ticker (default
// every 5 minutes, and frozen outright while a mobile tab is backgrounded, so
// it only ever fires while the app is open in the foreground for a full
// interval). A reader who reads for a couple of minutes on a phone and then
// locks it or switches apps hits NONE of those before leaving — the position
// only ever reached the LOCAL store (reading-position.js), and the next sync
// that could have carried it to another device doesn't happen until this
// device is opened again. That is what "the other device doesn't resume in
// the right place" actually was: not a wrong push, a push that had no
// opportunity to run.
//
// scheduleReadingPositionCloudPush is the fix — a short debounce off the same
// capture that already drives the local save (scroll-anchor.js's
// captureCurrentReadingAnchor), so a settled reading position reaches the
// cloud within seconds of the reader stopping, while the page is still alive
// to make the request, instead of waiting on a much longer/rarer trigger.
//
// This lives in its own module rather than inside scroll-anchor.js or
// reconcile.js because those two already import each other in one direction
// (reconcile.js -> scroll-anchor.js, for captureCurrentReadingAnchor) —
// scroll-anchor.js importing back from reconcile.js would be circular. This
// module imports from neither and is imported BY both.

import { CLOUD_TIMEOUT_MS, abortable, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";

// One deck at a time. A push already running for a deck is left to finish
// rather than started twice — the next debounce tick (or the next
// reconcileAllDecks) will catch anything it missed, and the position is never
// lost in the meantime: it is already durable in the local store.
const pushesInFlight = new Set();

// The write itself: only `meta.readingPosition`, merged into whatever the
// cloud row's meta already holds, never touching notes/cards/updated_at/LWW.
// Safe to skip the whole content-diff machinery because the position's OWN
// `at` timestamp is what resolves cross-device ordering on read (see
// betterReadingPosition in reading-position.js) — the deck row's updated_at
// was never part of that comparison.
//
// `deckId` is the CLOUD id. A deck with none yet (never synced) has nothing
// to merge into — callers gate on it before calling this.
export async function pushReadingPositionNow(deckId, localDeckId, anchor) {
  if (!deckId || !anchor || !supabaseClient || pushesInFlight.has(deckId)) return false;
  pushesInFlight.add(deckId);
  try {
    const { data: currentRow, error: readError } = await withTimeout(
      abortable((signal) => supabaseClient.from("decks").select("meta").eq("id", deckId).abortSignal(signal)),
      CLOUD_TIMEOUT_MS, "read deck meta"
    );
    if (readError || !currentRow) return false;
    const cloudMeta = (currentRow.meta && typeof currentRow.meta === "object") ? currentRow.meta : {};
    const mergedMeta = { ...cloudMeta, readingPosition: anchor };
    const { error: writeError } = await withTimeout(
      abortable((signal) => supabaseClient.from("decks").update({ meta: mergedMeta }).eq("id", deckId).abortSignal(signal)),
      CLOUD_TIMEOUT_MS, "save reading position"
    );
    if (writeError) {
      console.warn("Could not sync reading position", writeError);
      return false;
    }
    // Keep in-memory state in step with what the cloud now holds, so this
    // doesn't look "moved" again on the very next check, and so a content save
    // right after doesn't clobber it back. Guarded on the deck still being the
    // active one: this is an awaited network round trip, and the reader may
    // have opened a different deck by the time it resolves — writing
    // state.meta unconditionally would stamp THAT deck's in-memory meta with
    // this one's position.
    //
    // Deliberately NOT also read-modify-writing the local deck snapshot here
    // (readDeckSnapshot/writeDeckSnapshot) the way reconcile.js's OWN save
    // flow does elsewhere: that round-trips the FULL snapshot — cards and the
    // entire notes body — to persist one small meta field, on a debounce that
    // fires every ~8s of active reading. Unnecessary: the next real edit's
    // autosave writes a fresh snapshot from state.meta (already updated,
    // right here) anyway, and reading-position.js's own lightweight local
    // store — updated separately, on every capture — is what an app restart
    // resumes from; see betterReadingPosition. Skipping this is exactly what
    // this module's own doc comment above says NOT to reintroduce: don't
    // serialise the whole note on the reading path.
    if (state.deckId === deckId && state.localDeckId === localDeckId) {
      state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}), readingPosition: anchor };
    }
    return true;
  } catch (error) {
    console.warn("Could not sync reading position", error);
    return false;
  } finally {
    pushesInFlight.delete(deckId);
  }
}

// Long enough that a normal reading pace (people scroll a screenful every
// several seconds to a couple of minutes while actually reading, not every 8s
// forever) doesn't turn into a request on every stop; short enough that a
// reading session far shorter than the auto-sync interval still reaches the
// cloud before the reader backgrounds or closes the tab.
const READING_POSITION_CLOUD_PUSH_MS = 8000;

let cloudPushTimer = 0;

let pendingCloudPush = null;

// Re-armed on every call, exactly like reading-position.js's local save: a
// reader who keeps moving keeps pushing the deadline out, and only the
// position they actually settle on is ever sent.
export function scheduleReadingPositionCloudPush(deckId, localDeckId, anchor) {
  if (!deckId || !anchor || !supabaseClient || !isSignedIn) return;
  pendingCloudPush = { deckId, localDeckId, anchor };
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    cloudPushTimer = 0;
    const pending = pendingCloudPush;
    pendingCloudPush = null;
    if (!pending || !navigator.onLine) return;
    // Already synced by something else (e.g. a reconcile that ran meanwhile) —
    // nothing to send.
    if (pending.anchor.offset === state.meta?.readingPosition?.offset) return;
    pushReadingPositionNow(pending.deckId, pending.localDeckId, pending.anchor);
  }, READING_POSITION_CLOUD_PUSH_MS);
}
