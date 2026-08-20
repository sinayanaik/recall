// Pushing meta.bookmark to the cloud, on its own — not as a passenger on a
// full deck sync.
//
// A bookmark click is a rare, deliberate action, not scroll spam, so unlike
// reading-position's old eager push this has no debounce: callers push
// immediately after the click. The write itself is a narrow read-merge-write
// of exactly the `bookmark` key, merged into whatever the cloud row's meta
// already holds — never touching notes/cards/updated_at/whole-deck LWW.
// Cross-device ordering for this field is resolved by the bookmark's own
// `at` timestamp (see maybePromptBookmarkJump in bookmark.js), not the deck
// row's updated_at.
//
// `deckId` is the CLOUD id. A deck with none yet (never synced) has nothing
// to merge into — callers gate on it before calling this.

import { CLOUD_TIMEOUT_MS, abortable, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";

// One deck at a time. A push already running for a deck is left to finish
// rather than started twice — the bookmark is already durable in the local
// deck snapshot, so nothing is lost if this call is skipped.
const pushesInFlight = new Set();

export async function pushBookmarkNow(deckId, localDeckId, bookmark) {
  if (!deckId || !bookmark || !supabaseClient || !isSignedIn || pushesInFlight.has(deckId)) return false;
  pushesInFlight.add(deckId);
  try {
    const { data: currentRow, error: readError } = await withTimeout(
      abortable((signal) => supabaseClient.from("decks").select("meta").eq("id", deckId).abortSignal(signal)),
      CLOUD_TIMEOUT_MS, "read deck meta"
    );
    if (readError || !currentRow) return false;
    const cloudMeta = (currentRow.meta && typeof currentRow.meta === "object") ? currentRow.meta : {};
    // Don't clobber a bookmark another device already pushed more recently —
    // this device's click may be racing a newer one made elsewhere.
    if (cloudMeta.bookmark && (cloudMeta.bookmark.at || 0) > (bookmark.at || 0)) return false;
    const mergedMeta = { ...cloudMeta, bookmark };
    const { error: writeError } = await withTimeout(
      abortable((signal) => supabaseClient.from("decks").update({ meta: mergedMeta }).eq("id", deckId).abortSignal(signal)),
      CLOUD_TIMEOUT_MS, "save bookmark"
    );
    if (writeError) {
      console.warn("Could not sync bookmark", writeError);
      return false;
    }
    // Keep in-memory state in step with what the cloud now holds. Guarded on
    // the deck still being the active one: this is an awaited network round
    // trip, and the reader may have opened a different deck by the time it
    // resolves — writing state.meta unconditionally would stamp THAT deck's
    // in-memory meta with this one's bookmark.
    if (state.deckId === deckId && state.localDeckId === localDeckId) {
      state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}), bookmark };
    }
    return true;
  } catch (error) {
    console.warn("Could not sync bookmark", error);
    return false;
  } finally {
    pushesInFlight.delete(deckId);
  }
}
