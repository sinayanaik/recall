// Images pasted while offline.
//
// They go into an IndexedDB outbox under a local:// token and render from an
// object URL, so the note looks right immediately. When the connection comes
// back the upload runs and every reference to the token is rewritten to the
// real URL — in the deck, and in any other deck that quoted it.

import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { deckImageFolder, insertAtCursor, optimizeImage, replaceInTextarea, uploadImageToSupabase } from "./upload.js?v=__BUILD__";
import { readLocalDeckIndex, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { forEachDeckSnapshot, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// Insert an "uploading…" placeholder, upload the image, then swap in `![](url)`.
// Dropped in wherever the caret is — no surrounding blank-line padding needed:
// every rendered <img> gets wrapped in a block-level .diagram-shell (see
// enhanceSurfaceImageControls below), so it always lands on its own visual row
// regardless of whether it shares a markdown paragraph with other text. That
// same paragraph-sharing case gets the corner-drag resize grip immediately
// too (findImageTokens' `isInline` case), not a "move to its own line" step.
// `atPos` (optional) forces the placeholder to the caret captured before the file
// picker opened; without it the current caret is used (paste/drop already have focus).
// ── Offline image outbox ─────────────────────────────────────────────────────
// An image picked while offline used to be thrown away with "Can't upload image
// while offline" — the placeholder was deleted from the markdown and the file
// was gone. Now the blob is parked in IndexedDB (localStorage can't hold binary
// without a ~33% base64 tax on an already-tight quota), the markdown gets a
// `recall-img:<token>` placeholder that renders from the local blob, and the
// next reconcile uploads it and rewrites the placeholder to the real URL.
export const IMAGE_OUTBOX_DB = "recall-outbox";

export const IMAGE_OUTBOX_STORE = "images";

// The scheme used in markdown for a not-yet-uploaded image. Deliberately not a
// bare `blob:` URL: those die with the page, and the markdown outlives it.
export const LOCAL_IMAGE_SCHEME = "recall-img:";

export function openImageOutbox() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open(IMAGE_OUTBOX_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_OUTBOX_STORE)) {
        db.createObjectStore(IMAGE_OUTBOX_STORE, { keyPath: "token" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function imageOutboxRequest(mode, run) {
  return openImageOutbox().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_OUTBOX_STORE, mode);
    const request = run(tx.objectStore(IMAGE_OUTBOX_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  }));
}

export const putOutboxImage = (entry) => imageOutboxRequest("readwrite", (store) => store.put(entry));

export const getOutboxImage = (token) => imageOutboxRequest("readonly", (store) => store.get(token));

export const allOutboxImages = () => imageOutboxRequest("readonly", (store) => store.getAll());

export const deleteOutboxImage = (token) => imageOutboxRequest("readwrite", (store) => store.delete(token));

// Whether an image is still parked under this token. Used by restore to leave a
// `recall-img:` reference alone when this device's outbox already holds it,
// instead of parking (and later uploading) a second copy of the same image.
export async function outboxHasToken(token) {
  try {
    return Boolean(await getOutboxImage(token));
  } catch {
    return false;
  }
}

// Object URLs minted for queued images, so they can be revoked rather than
// leaked. Keyed by token, since the same image may render many times.
export const localImageObjectUrls = new Map();

// Resolve `recall-img:<token>` to a displayable blob URL. Returns null when the
// token is gone (already uploaded, or the outbox was cleared), which the caller
// treats as a missing image rather than an error.
export async function resolveLocalImageUrl(token) {
  if (localImageObjectUrls.has(token)) return localImageObjectUrls.get(token);
  try {
    const entry = await getOutboxImage(token);
    if (!entry?.blob) return null;
    const url = URL.createObjectURL(entry.blob);
    // Resolves run in parallel now (see hydrateLocalImages), so the same token —
    // the same image used twice in one note — can be read twice at once. Without
    // this the loser's blob URL is overwritten in the map and never revoked,
    // pinning the image's bytes for the life of the session.
    if (localImageObjectUrls.has(token)) {
      URL.revokeObjectURL(url);
      return localImageObjectUrls.get(token);
    }
    localImageObjectUrls.set(token, url);
    return url;
  } catch (error) {
    console.warn("Could not read the queued image", error);
    return null;
  }
}

// Every blob URL minted so far, released.
//
// Called on pagehide, on clear-this-device, and — the one that matters for a
// session that never navigates — on every deck swap. Each entry pins a whole
// image's bytes in memory for as long as the URL exists, and a PWA can go hours
// without a pagehide, so holding them for the session meant image memory only
// ever grew. Safe to do eagerly because resolveLocalImageUrl re-mints on demand
// from the outbox: a revoked URL costs one lazy IndexedDB read, and the render
// that follows a deck swap re-resolves every placeholder anyway.
export function revokeLocalImageUrls() {
  for (const url of localImageObjectUrls.values()) URL.revokeObjectURL(url);
  localImageObjectUrls.clear();
}

// Swap every recall-img: placeholder in the DOM for its blob URL. Called after
// a render, since markdown-to-HTML leaves the custom scheme untouched.
// `root` is a container, or the list of freshly rendered nodes the incremental
// renderer just built (which may themselves be the images).
export async function hydrateLocalImages(root = document) {
  const nodes = Array.isArray(root)
    ? scopedQueryAll(root, `img[src^="${LOCAL_IMAGE_SCHEME}"]`)
    : root.querySelectorAll?.(`img[src^="${LOCAL_IMAGE_SCHEME}"]`);
  if (!nodes || !nodes.length) return;
  // In parallel, not one awaited IndexedDB read after another: revokeLocalImageUrls
  // runs on every deck swap, so every render after a swap re-resolves each
  // pending image from scratch and serialising them showed as the images
  // appearing one by one.
  await Promise.all(Array.from(nodes, async (node) => {
    const token = node.getAttribute("src").slice(LOCAL_IMAGE_SCHEME.length);
    const url = await resolveLocalImageUrl(token);
    if (url) {
      node.src = url;
      node.dataset.pendingUpload = "1";
      node.title = "Waiting to upload — will sync when you're back online";
    }
  }));
}

// Upload everything the outbox is holding and rewrite the markdown that points
// at it. Called from reconcileAllDecks. Returns how many images landed.
export async function flushPendingImageUploads() {
  if (!supabaseClient || !isSignedIn || !navigator.onLine) return 0;
  let queued;
  try {
    queued = await allOutboxImages();
  } catch (error) {
    console.warn("Could not read the image outbox", error);
    return 0;
  }
  if (!queued?.length) return 0;

  let uploaded = 0;
  for (const entry of queued) {
    let url;
    try {
      url = await uploadImageToSupabase(entry.blob, { folder: entry.folder || null });
    } catch (error) {
      // A permanent rejection (RLS) would fail identically forever, and holding
      // the blob would re-attempt it on every single sync. Anything else is
      // worth keeping for the next try.
      if (error?.authFailed) {
        console.warn("Dropping a queued image the server refuses", error);
        await deleteOutboxImage(entry.token).catch(() => {});
      }
      continue;
    }
    await rewriteLocalImageReferences(entry.token, url);
    await deleteOutboxImage(entry.token).catch(() => {});
    const objectUrl = localImageObjectUrls.get(entry.token);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      localImageObjectUrls.delete(entry.token);
    }
    uploaded++;
  }
  return uploaded;
}

// Point every copy of a placeholder at the real URL: the live editor and state
// (so the change is visible now) and every stored snapshot (so it survives, and
// so the deck's own updatedAt bump carries it to the cloud).
export async function rewriteLocalImageReferences(token, url) {
  const placeholder = LOCAL_IMAGE_SCHEME + token;
  const swap = (text) => String(text || "").split(placeholder).join(url);
  const touched = (text) => String(text || "").includes(placeholder);

  if (touched(state.notes)) state.notes = swap(state.notes);
  for (const list of [state.masterCards, state.cards]) {
    for (const card of list || []) {
      if (touched(card.question)) card.question = swap(card.question);
      if (touched(card.answer)) card.answer = swap(card.answer);
    }
  }

  const now = new Date().toISOString();
  // Cursor-streamed for the same reason as the math repair: this scans the
  // whole library to find the (usually one) deck holding the placeholder, and
  // reading every deck by id would pull the entire library into memory just to
  // rewrite one string. Rewrites are collected and applied after the scan —
  // the cursor's transaction is readonly.
  const rewritten = [];
  await forEachDeckSnapshot((id, snapshot) => {
    const notesTouched = touched(snapshot.notes);
    const touchedCards = (snapshot.cards || []).filter((card) => touched(card.question) || touched(card.answer));
    if (!notesTouched && !touchedCards.length) return;
    if (notesTouched) snapshot.notes = swap(snapshot.notes);
    for (const card of touchedCards) {
      card.question = swap(card.question);
      card.answer = swap(card.answer);
      // The card's text genuinely changed, so it owes the cloud a push.
      card.dirty = true;
      card.updatedAt = now;
    }
    // IndexedDB's own clone of the record, not the shared cache object — safe
    // to have mutated in place above.
    rewritten.push({ id: String(id), snapshot });
  });

  if (!rewritten.length) return;
  for (const { id, snapshot } of rewritten) writeDeckSnapshot(id, snapshot);
  // One index write for the whole batch, read fresh so a concurrent change
  // isn't reverted. A notes-conflict stash has no index entry — it simply
  // doesn't match, which is correct: its content was still rewritten above.
  const touchedIds = new Set(rewritten.map((r) => r.id));
  const index = readLocalDeckIndex();
  let indexChanged = false;
  for (const entry of index) {
    if (!touchedIds.has(String(entry.id))) continue;
    entry.updatedAt = now;
    indexChanged = true;
  }
  if (indexChanged) writeLocalDeckIndex(index);
}

export async function insertImageUpload(textarea, file, atPos) {
  if (!textarea || !file || !file.type || !file.type.startsWith("image/")) return;
  const uploadToken = `![uploading…](#upl-${Date.now()}-${Math.random().toString(36).slice(2, 7)})`;
  insertAtCursor(textarea, uploadToken, atPos);
  showToast("Optimizing image…", "info");
  let optimized = file;
  // Resolved before the await so the image is filed under the deck the user
  // actually pasted into, even if they switch decks while it uploads.
  const folder = deckImageFolder();
  try {
    optimized = await optimizeImage(file);
    const url = await uploadImageToSupabase(optimized, { folder });
    replaceInTextarea(textarea, uploadToken, `![](${url})`);
    showToast("Image uploaded", "success");
    return;
  } catch (err) {
    if (err.message !== "OFFLINE") {
      replaceInTextarea(textarea, uploadToken, "");
      if (err.message === "NOT_SIGNED_IN") {
        showToast("Sign in to upload images", "error");
      } else {
        console.error("Image upload failed", err);
        showToast("Image upload failed", "error");
      }
      return;
    }
  }

  // Offline: park the blob and leave a placeholder that renders from it, rather
  // than discarding the image the user just chose.
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  try {
    // `folder` rides along so a queued image still lands beside the rest of its
    // deck's images when it finally uploads, however many decks the user has
    // opened in between. Entries queued before this existed have no folder and
    // fall back to unfiled/.
    await putOutboxImage({ token, blob: optimized, folder, savedAt: new Date().toISOString() });
  } catch (error) {
    console.warn("Could not queue the image for upload", error);
    replaceInTextarea(textarea, uploadToken, "");
    showToast("Can't upload image while offline", "error");
    return;
  }
  replaceInTextarea(textarea, uploadToken, `![](${LOCAL_IMAGE_SCHEME}${token})`);
  showToast("Image saved here — uploads when you're back online", "info");
}
