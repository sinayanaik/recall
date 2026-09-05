// Images pasted while offline.
//
// They go into an IndexedDB outbox under a local:// token and render from an
// object URL, so the note looks right immediately. When the connection comes
// back the upload runs and every reference to the token is rewritten to the
// real URL — in the deck, and in any other deck that quoted it.

import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { chooseImageCompression } from "./compress-dialog.js?v=__BUILD__";
import { deckImageFolder, insertAtCursor, replaceInTextarea, uploadImageToSupabase } from "./upload.js?v=__BUILD__";
import { readLocalDeckIndex, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { scopedQueryAll } from "../render/deferred-work.js?v=__BUILD__";
// Only ever CALLED, never read at module scope — the cycle back through
// block-cache is the case tools/module-symbols.mjs allows for hoisted function
// declarations.
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { forEachDeckSnapshot, rewriteDeckSnapshot, scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// Only ever CALLED, never read at module scope — the cycle back through
// block-cache is the case tools/module-symbols.mjs allows for hoisted function
// declarations.

// Insert an "uploading…" placeholder, upload the image, then swap in `![](url)`.
// Dropped in wherever the caret is — no surrounding blank-line padding needed:
// every rendered <img> gets wrapped in a block-level .diagram-shell (see
// enhanceSurfaceImageControls below), so it always lands on its own visual row
// regardless of whether it shares a markdown paragraph with other text. That
// same paragraph-sharing case gets the corner-drag resize grip immediately
// too (findSourceImages sees every image, whatever encloses it), not a "move
// to its own line" step.
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
      // The token, kept where it can still be read after the src is gone.
      // enhanceSurfaceImageControls pairs each rendered image with the markdown
      // token it came from by URL, and the markdown for this one still says
      // `recall-img:<token>` — so once src is a blob: URL there is nothing left
      // to match on, and the image (and every image after it) loses its resize
      // grip. See sourceUrlForImage in src/images/surface-controls.js.
      node.dataset.localToken = token;
      node.title = "Waiting to upload — will sync when you're back online";
    }
  }));
}

// Upload everything the outbox is holding and rewrite the markdown that points
// at it. Called from reconcileAllDecks. Returns how many images landed.
// How many uploads share one rewrite pass. The rewrite is a cursor scan of the
// WHOLE library, so doing it per image is O(images x library): measured at 85ms
// each over 721 decks / 26MB of notes, which is 3.4 seconds for 40 images with
// the upload itself costing nothing — and a restored library is far bigger than
// that. Batching makes it one scan per 25.
//
// Not one single scan at the very end, because the outbox entry can only be
// dropped once its rewrite has landed: anything still queued when the tab is
// closed is uploaded again next time, leaving an orphaned copy in storage. A
// batch bounds that to 25 rather than to everything.
export const IMAGE_REWRITE_BATCH = 25;

// `onProgress(done, total)` is not decoration. This runs inside reconcileAllDecks
// BEFORE the deck index is even read, and used to be completely silent — so a
// sync with a full outbox sat on "Checking the cloud…" for minutes, having
// started no deck work at all, which is indistinguishable from a hang.
export async function flushPendingImageUploads(onProgress = null) {
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
  let pending = new Map();   // token -> url, awaiting one shared rewrite
  onProgress?.(0, queued.length);

  const settleBatch = async () => {
    if (!pending.size) return;
    await rewriteLocalImageReferences(pending);
    for (const token of pending.keys()) {
      await deleteOutboxImage(token).catch(() => {});
      const objectUrl = localImageObjectUrls.get(token);
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        localImageObjectUrls.delete(token);
      }
    }
    pending = new Map();
  };

  for (const entry of queued) {
    let url;
    try {
      url = await uploadImageToSupabase(entry.blob, { folder: entry.folder || null });
    } catch (error) {
      // A permanent rejection (RLS) would fail identically forever, and holding
      // the blob would re-attempt it on every single sync. Anything else is
      // worth keeping for the next try — including `notStored` (the upload came
      // back clean and left nothing in the bucket, see assertImageStored): the
      // image is still on screen from the outbox, so retrying costs a request
      // where giving up costs the picture. A retry takes a fresh random path, so
      // an object that did land after all is left behind as an orphan — which
      // Storage & Data can see and clear, and which is much the cheaper mistake.
      if (error?.authFailed) {
        console.warn("Dropping a queued image the server refuses", error);
        await deleteOutboxImage(entry.token).catch(() => {});
      }
      continue;
    }
    pending.set(entry.token, url);
    uploaded++;
    onProgress?.(uploaded, queued.length);
    if (pending.size >= IMAGE_REWRITE_BATCH) await settleBatch();
  }
  await settleBatch();
  return uploaded;
}

// Point every copy of a placeholder at the real URL: the live editor and state
// (so the change is visible now) and every stored snapshot (so it survives, and
// so the deck's own updatedAt bump carries it to the cloud).
// Takes a MAP of token -> url, not one pair, because the library scan below is
// the expensive part and it costs the same for one replacement or fifty. See
// IMAGE_REWRITE_BATCH.
export async function rewriteLocalImageReferences(replacements) {
  const pairs = [...(replacements instanceof Map ? replacements : new Map(Object.entries(replacements || {})))]
    .map(([token, url]) => [LOCAL_IMAGE_SCHEME + token, url]);
  if (!pairs.length) return;
  const swap = (text) => {
    let out = String(text || "");
    // split/join per placeholder rather than one alternating RegExp: a token is
    // arbitrary text as far as this function knows, and building a pattern out
    // of it is how a stray metacharacter silently rewrites the wrong thing.
    for (const [placeholder, url] of pairs) {
      if (out.includes(placeholder)) out = out.split(placeholder).join(url);
    }
    return out;
  };
  const touched = (text) => {
    const value = String(text || "");
    // Cheap reject first: a note with no placeholder scheme in it at all — the
    // overwhelming majority — costs one indexOf instead of one per pair.
    if (!value.includes(LOCAL_IMAGE_SCHEME)) return false;
    return pairs.some(([placeholder]) => value.includes(placeholder));
  };

  // ── The third place a picture can be ────────────────────────────────────
  //
  // A photograph dropped on a page of handwriting is not markdown in a note. It
  // is a RECORD — `meta.pdfBlocks`, with the reference in its own `src` field
  // (src/documents/pdf-blocks.js) — and it reaches this function by exactly the
  // same route a pasted image does, because both go through storeImageOrQueue
  // and both come back holding a `recall-img:` reference when there was no
  // connection to upload over.
  //
  // This scanned the notes and the cards and stopped, so that reference was
  // never settled. The block kept a token naming bytes that live in ONE device's
  // outbox, which is a picture that shows up on the tablet it was added on and
  // is blank on every other device the deck reaches — for ever, since the upload
  // that would have fixed it had already happened and never came back.
  //
  // `at` moves with the rewrite because the record genuinely changed: the other
  // device is holding the same block with the token still in it, and a merge by
  // id settles on the stamp.
  const blocksHold = (blocks) => (Array.isArray(blocks) ? blocks : []).some((block) => touched(block?.src));
  // One stamp for the whole pass, not one per block. The same block is rewritten
  // twice — once in the open deck's memory and once in its stored snapshot — and
  // two calls to Date.now() would give the durable copy and the visible one
  // different stamps for the identical change.
  const stampedAt = Date.now();
  // A new array or null, never an edit in place: every writer of a meta bag in
  // this app replaces it, and half the sync's "did anything move" answers are
  // identity comparisons that an in-place edit would walk straight past.
  const swappedBlocks = (blocks) => {
    if (!blocksHold(blocks)) return null;
    return blocks.map((block) => (touched(block?.src)
      ? { ...block, src: swap(block.src), at: stampedAt }
      : block));
  };

  if (touched(state.notes)) state.notes = swap(state.notes);
  for (const list of [state.masterCards, state.cards]) {
    for (const card of list || []) {
      if (touched(card.question)) card.question = swap(card.question);
      if (touched(card.answer)) card.answer = swap(card.answer);
    }
  }
  const openBlocks = swappedBlocks(state.meta?.pdfBlocks);
  if (openBlocks) state.meta = { ...state.meta, pdfBlocks: openBlocks };

  const now = new Date().toISOString();
  // Cursor-streamed for the same reason as the math repair: this scans the
  // whole library to find the (usually one) deck holding the placeholder, and
  // reading every deck by id would pull the entire library into memory just to
  // rewrite one string. Rewrites are collected and applied after the scan —
  // the cursor's transaction is readonly.
  // The cursor FINDS the decks; it does not supply what is written back. It
  // reads the object store directly, so a deck with a write in flight comes
  // back at its previous durable value — and writing that copy back would
  // replace the newer save. See rewriteDeckSnapshot, which re-reads each one
  // under its own lock and re-applies the swap to whatever is there now.
  const candidates = [];
  await forEachDeckSnapshot((id, snapshot) => {
    const notesTouched = touched(snapshot.notes);
    const touchedCards = (snapshot.cards || []).some((card) => touched(card.question) || touched(card.answer));
    // The blocks too, or the deck holding the only reference is never even
    // visited and the rewrite below has nothing to run against.
    if (!notesTouched && !touchedCards && !blocksHold(snapshot.meta?.pdfBlocks)) return;
    candidates.push(String(id));
  });

  if (!candidates.length) return;
  const rewritten = [];
  for (const id of candidates) {
    const wrote = await rewriteDeckSnapshot(id, (snapshot) => {
      const notesTouched = touched(snapshot.notes);
      const touchedCards = (snapshot.cards || []).filter((card) => touched(card.question) || touched(card.answer));
      const nextBlocks = swappedBlocks(snapshot.meta?.pdfBlocks);
      // The placeholder is gone from the fresh copy — another pass got there
      // first, or the deck was edited. Nothing owed.
      if (!notesTouched && !touchedCards.length && !nextBlocks) return null;
      if (nextBlocks) snapshot.meta = { ...snapshot.meta, pdfBlocks: nextBlocks };
      if (notesTouched) snapshot.notes = swap(snapshot.notes);
      for (const card of touchedCards) {
        card.question = swap(card.question);
        card.answer = swap(card.answer);
        // The card's text genuinely changed, so it owes the cloud a push.
        card.dirty = true;
        card.updatedAt = now;
      }
      return snapshot;
    });
    if (wrote) rewritten.push(id);
  }
  if (!rewritten.length) return;
  // One index write for the whole batch, read fresh so a concurrent change
  // isn't reverted. A notes-conflict stash has no index entry — it simply
  // doesn't match, which is correct: its content was still rewritten above.
  const touchedIds = new Set(rewritten);
  const index = readLocalDeckIndex();
  let indexChanged = false;
  for (const entry of index) {
    if (!touchedIds.has(String(entry.id))) continue;
    entry.updatedAt = now;
    indexChanged = true;
  }
  if (indexChanged) writeLocalDeckIndex(index);
}

// ── Settling the "uploading…" placeholder, wherever it ended up ───────────
//
// An upload holds its textarea across the await, and by the time it resolves
// that textarea may not be the live editing surface any more: the reader closed
// the raw editor, or opened another deck. Writing through it anyway is what
// made an upload publish a stale value over the top of everything done in the
// rendered view since — a highlight, another picture, a deletion — and then
// autosave the loss. Across a deck swap it wrote the previous deck's whole note
// into the new one.
//
// So the textarea is used only while it really is on screen, where it is still
// the right answer: the caret, the undo stack and the highlight mirror all move
// with the text. Otherwise the placeholder is settled in the strings
// themselves. Split/join per token rather than a pattern, for the same reason
// rewriteLocalImageReferences gives: a token is arbitrary text as far as this
// is concerned.
export function replaceUploadTokenInMemory(uploadToken, replacement) {
  let touched = false;
  const swap = (text) => {
    const value = String(text || "");
    if (!value.includes(uploadToken)) return value;
    touched = true;
    return value.split(uploadToken).join(replacement);
  };
  state.notes = swap(state.notes);
  for (const list of [state.masterCards, state.cards]) {
    for (const card of list || []) {
      card.question = swap(card.question);
      card.answer = swap(card.answer);
    }
  }
  return touched;
}

// ...and if it is in neither the editor nor the open deck, the reader moved on
// while it uploaded. The placeholder is in a stored deck, so it is settled
// there — through rewriteDeckSnapshot, which re-reads under that deck's lock
// rather than writing back what the cursor happened to hand over.
export async function settleUploadToken(textarea, uploadToken, replacement) {
  if (textarea && !textarea.hidden && textarea.isConnected) {
    replaceInTextarea(textarea, uploadToken, replacement);
    return;
  }
  if (replaceUploadTokenInMemory(uploadToken, replacement)) {
    scheduleDeckAutosave();
    // The rendered view is what the reader is looking at when the editor is
    // shut, and it is still showing the placeholder. Same repaint the offline
    // flush does for the same reason (see reconcileAllDecks).
    renderNotesViewPinned();
    return;
  }
  const candidates = [];
  await forEachDeckSnapshot((id, snapshot) => {
    const holds = String(snapshot.notes || "").includes(uploadToken)
      || (snapshot.cards || []).some((card) =>
        String(card.question || "").includes(uploadToken) || String(card.answer || "").includes(uploadToken));
    if (holds) candidates.push(String(id));
  });
  const now = new Date().toISOString();
  for (const id of candidates) {
    await rewriteDeckSnapshot(id, (snapshot) => {
      let changed = false;
      const swap = (text) => {
        const value = String(text || "");
        if (!value.includes(uploadToken)) return value;
        changed = true;
        return value.split(uploadToken).join(replacement);
      };
      snapshot.notes = swap(snapshot.notes);
      for (const card of snapshot.cards || []) {
        const question = swap(card.question);
        const answer = swap(card.answer);
        if (question === card.question && answer === card.answer) continue;
        card.question = question;
        card.answer = answer;
        card.dirty = true;
        card.updatedAt = now;
      }
      return changed ? snapshot : null;
    });
  }
}

// Ask what to do with it, then do it. Every interactive path — paste, drop,
// the toolbar picker — comes through here or through the prepared half below,
// so an upload is never something that just happened: the level is chosen and
// the sizes are seen first (src/images/compress-dialog.js), and cancelling
// leaves the note exactly as it was.
export async function insertImageUpload(textarea, file, atPos) {
  if (!textarea || !file || !file.type || !file.type.startsWith("image/")) return;
  const chosen = await chooseImageCompression([file]);
  if (!chosen?.items?.length) return;
  await insertPreparedImageUpload(textarea, chosen.items[0].upload, atPos);
}

// The half that runs once the compression level is settled: the file handed in
// is already the exact blob that will be stored. Callers with SEVERAL images
// (a bulk pick, a multi-file drop) ask once and then call this per file, which
// is what keeps one dialog per batch rather than one per picture.
// Store one image and say where it ended up — WITHOUT touching a textarea.
//
// This is the half of insertPreparedImageUpload that is about the file rather
// than about the caret: upload it, and if that cannot be done right now, park
// the bytes in the outbox and hand back the `recall-img:` reference that
// renders from them until it can. Every branch below used to exist only inside
// the textarea path, which meant the second caller — re-saving an edited
// drawing (src/notes/ink-sheet.js), where there is no caret and no placeholder
// token, only a picture already in the note to be replaced — would have had to
// reimplement "what does offline mean here". It is four cases and one of them
// (`notStored`: the upload reported success and left nothing in the bucket) is
// the one that produced a real report, so a second copy of it was never going
// to stay in step.
//
// Returns { url } on success, { url, queued: true } when the bytes are parked,
// or { error } when the image is not kept at all. The caller decides what to
// say; this decides what happened.
export async function storeImageOrQueue(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) return { error: "not-an-image" };
  // Resolved before the await so the image is filed under the deck the user
  // was actually in, even if they switch decks while it uploads.
  const folder = deckImageFolder();
  try {
    return { url: await uploadImageToSupabase(file, { folder }) };
  } catch (err) {
    if (err.message !== "OFFLINE" && !err.notStored) {
      return { error: err.message === "NOT_SIGNED_IN" ? "not-signed-in" : "failed", cause: err };
    }
    if (err.notStored) console.warn("An upload came back clean but left nothing in the bucket", err);
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    try {
      // `folder` rides along so a queued image still lands beside the rest of
      // its deck's images when it finally uploads, however many decks the user
      // has opened in between. Entries queued before this existed have no
      // folder and fall back to unfiled/.
      await putOutboxImage({ token, blob: file, folder, savedAt: new Date().toISOString() });
    } catch (error) {
      console.warn("Could not queue the image for upload", error);
      return { error: "not-kept", reason: err.notStored ? "not-stored" : "offline" };
    }
    return { url: `${LOCAL_IMAGE_SCHEME}${token}`, queued: true, reason: err.notStored ? "not-stored" : "offline" };
  }
}

export async function insertPreparedImageUpload(textarea, file, atPos) {
  if (!textarea || !file || !file.type || !file.type.startsWith("image/")) return;
  const uploadToken = `![uploading…](#upl-${Date.now()}-${Math.random().toString(36).slice(2, 7)})`;
  insertAtCursor(textarea, uploadToken, atPos);
  showToast("Uploading image…", "info");
  const result = await storeImageOrQueue(file);

  if (result.error) {
    await settleUploadToken(textarea, uploadToken, "");
    if (result.error === "not-signed-in") showToast("Sign in to upload images", "error");
    else if (result.error === "not-kept") {
      showToast(result.reason === "not-stored"
        ? "That image didn't reach the cloud and couldn't be kept here"
        : "Can't upload image while offline", "error");
    } else {
      console.error("Image upload failed", result.cause);
      showToast("Image upload failed", "error");
    }
    return;
  }

  await settleUploadToken(textarea, uploadToken, `![](${result.url})`);
  if (!result.queued) { showToast("Image uploaded", "success"); return; }
  // Kept here rather than uploaded. Said out loud, because the difference
  // matters on the OTHER device: this picture does not exist there yet.
  showToast(result.reason === "not-stored"
    ? "That image didn't reach the cloud — kept here and retried on the next sync"
    : "Image saved here — uploads when you're back online", "info");
}
