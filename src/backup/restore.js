// Restore: additive merge, never a replace.
//
// A restore must not be able to lose work that is only on this device, so a
// deck present on both sides is merged rather than overwritten, and a deck the
// backup does not mention is left completely alone. Restored images are
// re-uploaded and every reference rewritten to the new URLs.

import { backupCategoryFromArchivePath, backupTimestamp, backupZipFactory, collectBackupImageRefs, exportLibraryBackupZip, formatBackupSize, mergeBackupMeta, normalizeBackupDeck, normalizeBackupMeta, restoredHighlightCount, restoredMetaKeys, showBackupProgress } from "./backup.js?v=__BUILD__";
import {
  BACKUP_ASSET_INDEX, BACKUP_DOCUMENT_DIR, BACKUP_MANIFEST_FILE,
  archiveHashCoverage, findArchiveFile, isBackupIndexPath,
  mismatchedArchiveFiles, normalizeBackupManifest, verifyBackupArchive
} from "./archive-format.js?v=__BUILD__";
import { commitBackupDocuments, planBackupDocumentRestore, readBackupDocumentIndex } from "./documents.js?v=__BUILD__";
import { applyBackupLibraryState, readBackupLibraryState } from "./library-state.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { escapeHtml, escapeRegExp } from "../core/text.js?v=__BUILD__";
import { normalizeCardStatus, slugifyFileName } from "../export/markdown.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME, flushPendingImageUploads, outboxHasToken, putOutboxImage } from "../images/outbox.js?v=__BUILD__";
import { cacheUploadedImageOffline, storageFolderSlug, supabaseImagePathFromUrl } from "../images/upload.js?v=__BUILD__";
import { FOLDER_SEP, addKnownFolder, normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { readLocalDeckIndex, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { flushPendingUntombstones, queuePendingUntombstones } from "../library/tombstones.js?v=__BUILD__";
import { deckWriteSettled, readDeckSnapshot, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { dropTombstonesForLiveCards } from "../sync/cards.js?v=__BUILD__";
import { normalizeSyncText, syncTextChanged } from "../sync/diff.js?v=__BUILD__";
import { mergeDocumentAnnotations } from "../sync/document-sync.js?v=__BUILD__";
import { repairSnapshotText } from "../sync/text-repair.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";

// A parsed JSON node is either a multi-deck bundle ({decks:[...]}) or a single
// deck snapshot — normalise both into `out`.
export function expandBackupBundleInto(parsed, out, fallbackCategory = "") {
  if (parsed && Array.isArray(parsed.decks)) {
    parsed.decks.forEach((deck) => {
      const normalized = normalizeBackupDeck(deck, fallbackCategory);
      if (normalized) out.push(normalized);
    });
  } else {
    const normalized = normalizeBackupDeck(parsed, fallbackCategory);
    if (normalized) out.push(normalized);
  }
}

// Read `assets/index.json` and pull each packed image out of the zip, returning
// Map(original reference -> Blob). An archive from before image packing (or one
// whose index is unreadable) just yields an empty map and restores exactly as
// it always did.
export async function readBackupAssets(zip) {
  const assets = new Map();
  const indexEntry = zip.files[BACKUP_ASSET_INDEX]
    || zip.files[Object.keys(zip.files).find((path) => path.toLowerCase() === BACKUP_ASSET_INDEX) || ""];
  if (!indexEntry) return assets;
  let index;
  try {
    index = JSON.parse(await indexEntry.async("string"));
  } catch (error) {
    console.warn("Backup asset index is unreadable — restoring text only", error);
    return assets;
  }
  for (const entry of Array.isArray(index?.assets) ? index.assets : []) {
    const file = entry && zip.files[entry.file];
    if (!entry?.url || !file || file.dir) continue;
    try {
      const raw = await file.async("blob");
      // JSZip hands back an octet-stream blob; re-wrap with the recorded type so
      // the image renders (and later uploads) as the right content type.
      assets.set(String(entry.url), entry.type ? new Blob([raw], { type: entry.type }) : raw);
    } catch (error) {
      console.warn("Could not read a packed image from the archive", entry.file, error);
    }
  }
  return assets;
}

// Zip noise no archive reader should look at: macOS resource forks, Finder
// metadata, and the dotfiles a few zip tools sprinkle around.
export function isArchiveJunkPath(path) {
  return /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\._)/i.test(path);
}

// Does this JSON look like a deck rather than some unrelated file that happened
// to be in the zip? Only consulted for unstructured archives, where anything
// could be sitting next to the deck files.
export function looksLikeBackupDeckJson(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (Array.isArray(parsed.decks)) return true;
  if (Array.isArray(parsed.cards)) return true;
  return Boolean(parsed.deck && typeof parsed.deck === "object" && Array.isArray(parsed.cards));
}

// The archive's own account of itself, and whether the zip agrees with it.
//
// The manifest has been written since the format existed and read by nothing —
// so `folders` (the empty ones, whose only record it is) was decorative, the
// version was informational by its own admission, and an archive that lost half
// its entries in transit restored the half that was left and reported success.
// Nothing compared what the archive SAID it held against what it held.
//
// Read before the decks, so the preview can say what is missing before anyone
// presses a button, and so a v1/v2 archive — which has no manifest and claims
// nothing — is still read exactly as it always was.
export async function readBackupIntegrity(zip) {
  const names = Object.keys(zip.files).filter((path) => !zip.files[path].dir && !isArchiveJunkPath(path));
  const manifestPath = findArchiveFile(names, BACKUP_MANIFEST_FILE);
  if (!manifestPath) return { manifest: null, verification: null };
  let manifest = null;
  try {
    manifest = normalizeBackupManifest(await zip.files[manifestPath].async("string"));
  } catch (error) {
    // An unreadable manifest is not a reason to refuse the decks beside it —
    // this whole path is for the archive that has been damaged, and the decks
    // are the part worth saving. It IS a reason to stop claiming the archive
    // was checked.
    console.warn("Backup manifest is unreadable — restoring without integrity checks", error);
    return { manifest: null, verification: null };
  }
  if (!manifest) return { manifest: null, verification: null };

  const verification = verifyBackupArchive(names, manifest);
  // Sizes come from reading each named file back out of the zip, which is the
  // only way to catch the failure that matters most: an entry that is PRESENT
  // and truncated. A missing file is loud; a short one restores as a deck with
  // half its cards.
  //
  // The PAPERS are deliberately left out of this pass. Measuring one means
  // decompressing it, and a library of papers is hundreds of megabytes read into
  // memory to learn a number — in front of a preview, before the user has even
  // said yes. They are not unchecked: commitBackupDocuments hashes each file at
  // the moment it stores it, when the bytes are already in hand and the cost is
  // nothing, and refuses one whose hash does not match what the archive recorded.
  const sizeByPath = new Map();
  for (const entry of Array.isArray(manifest.contents) ? manifest.contents : []) {
    if (!entry?.file || entry.file.startsWith(`${BACKUP_DOCUMENT_DIR}/`)) continue;
    const path = findArchiveFile(names, entry.file);
    if (!path || zip.files[path].dir) continue;
    try {
      sizeByPath.set(entry.file, (await zip.files[path].async("uint8array")).length);
    } catch (error) {
      console.warn("Could not measure an archived file", entry.file, error);
    }
  }
  verification.mismatched = mismatchedArchiveFiles(manifest, { sizeByPath });
  if (verification.mismatched.length) {
    verification.ok = false;
    verification.notes.push(`${verification.mismatched.length} file${verification.mismatched.length === 1 ? " is" : "s are"} damaged or incomplete.`);
  }
  verification.hashes = archiveHashCoverage(manifest);
  return { manifest, verification };
}

export async function readBackupArchive(file) {
  const name = String(file.name || "").toLowerCase();
  const looksZip = /\.zip$/.test(name)
    || file.type === "application/zip"
    || file.type === "application/x-zip-compressed";

  const decks = [];
  if (looksZip) {
    // JSZip when it loaded, this app's own stored-zip reader when it did not.
    // Restore has the same right to work offline that backup does — and the
    // archive it is being handed may well have been written by that fallback.
    const Zip = await backupZipFactory();
    const zip = await Zip.loadAsync(file);
    const files = Object.keys(zip.files).filter((path) => !zip.files[path].dir && !isArchiveJunkPath(path));
    const { manifest, verification } = await readBackupIntegrity(zip);
    // Our own archives (and anything shaped like them): every .json under a
    // decks/ root, at any depth — the depth IS the folder path.
    let deckPaths = files.filter((path) => /(^|\/)decks\/.+\.json$/i.test(path));
    let strict = true;
    if (!deckPaths.length) {
      // An unstructured zip: deck files someone dropped in, loose or in folders
      // of their own naming. Take every .json that reads like a deck, wherever
      // it sits, and let its folder become the deck's folder.
      //
      // isBackupIndexPath is what keeps the archive's OWN bookkeeping out of
      // that net. It grew as the archive did: manifest.json and assets/ were
      // excluded by hand, and documents/index.json and library.json would have
      // walked straight into this branch as decks with no cards. One predicate
      // now, in the module that names those files, so the next one added is
      // excluded by construction rather than by somebody remembering.
      deckPaths = files.filter((path) => /\.json$/i.test(path)
        && !isBackupIndexPath(path)
        && !/(^|\/)assets\//i.test(path));
      strict = false;
    }
    for (const path of deckPaths) {
      try {
        const parsed = JSON.parse(await zip.files[path].async("string"));
        if (!strict && !looksLikeBackupDeckJson(parsed)) continue;
        const before = decks.length;
        expandBackupBundleInto(parsed, decks, backupCategoryFromArchivePath(path));
        // Where in the archive each deck came from. The documents index binds a
        // PDF to its deck by this path — a deck's own id is not enough, because
        // a library's oldest decks have never had one.
        for (let i = before; i < decks.length; i += 1) decks[i].archivePath = path;
      } catch (error) {
        console.warn("Skipping unreadable deck file in archive", path, error);
      }
    }
    if (!decks.length) throw new Error("no decks found in this archive");
    return {
      decks,
      assets: await readBackupAssets(zip),
      zip,
      manifest,
      verification,
      documentIndex: await readBackupDocumentIndex(zip, findArchiveFile),
      libraryState: await readBackupLibraryState(zip, findArchiveFile)
    };
  }

  // Plain JSON export (single snapshot or {decks:[...]} bundle) — text only,
  // there is nowhere in a bare .json for image bytes, papers or folders to live.
  expandBackupBundleInto(JSON.parse(await file.text()), decks);
  if (!decks.length) throw new Error("no decks found in this file");
  return { decks, assets: new Map(), zip: null, manifest: null, verification: null, documentIndex: { documents: [], missing: [] }, libraryState: null };
}

// ── Re-homing a backup's images ────────────────────────────────────────────
// An image reference that came out of the archive is only usable here if it
// points into the storage project THIS device is configured against — the same
// project's bucket is public, so the url resolves for any of its users, and the
// object already exists (re-uploading it would just duplicate it). Anything
// else — a friend's project, a dead project, a queued `recall-img:` placeholder
// from the other device's outbox — is adopted: the bytes go into this device's
// own image outbox and the markdown is rewritten to the local placeholder, so
// the image shows immediately and flushPendingImageUploads later re-uploads it
// into this user's own storage and rewrites the reference to the new url.
//
// Planned without writing anything (restore shows a preview first, and a
// cancelled restore must leave no trace); commitBackupAssets does the writes.
export async function planBackupAssetAdoption(decks, assets) {
  const plan = { keep: [], adopt: [], rewrites: new Map(), missing: 0 };
  if (!assets || !assets.size) return plan;

  // Which deck first mentions a reference, so an adopted image is filed under
  // that deck's folder when it uploads instead of landing in unfiled/.
  const folderByRef = new Map();
  decks.forEach((deck) => {
    const refs = collectBackupImageRefs(deck);
    for (const ref of refs) {
      if (!folderByRef.has(ref) && assets.has(ref)) {
        const slug = storageFolderSlug(deck.title, "untitled-deck");
        folderByRef.set(ref, `decks/${slug}--${deterministicRestoreLocalId(deck)}`);
      }
    }
  });

  for (const [ref, blob] of assets) {
    if (!blob) {
      plan.missing += 1;
      continue;
    }
    if (!ref.startsWith(LOCAL_IMAGE_SCHEME) && supabaseImagePathFromUrl(ref)) {
      // Ours already: keep the url, but seed the offline cache so the restored
      // deck reads on a plane instead of only once it has been online again.
      plan.keep.push({ ref, blob });
      continue;
    }
    // Restoring this device's own backup, taken while an image was still queued
    // for upload: the token is still in the outbox, so leave the reference
    // alone rather than parking a second copy of the same pending image.
    if (ref.startsWith(LOCAL_IMAGE_SCHEME) && await outboxHasToken(ref.slice(LOCAL_IMAGE_SCHEME.length))) {
      continue;
    }
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    plan.adopt.push({ ref, blob, token, folder: folderByRef.get(ref) || null });
    plan.rewrites.set(ref, LOCAL_IMAGE_SCHEME + token);
  }
  return plan;
}

// Point every image reference the plan adopted at its new local placeholder,
// in the BACKUP decks — before planRestore reads them, so the preview diffs and
// the snapshots that get written both carry the rewritten text.
export function applyBackupAssetRewrites(decks, rewrites) {
  if (!rewrites.size) return;
  // One alternation over every reference rather than a pass per reference: a
  // book-sized deck is thousands of card faces, and a library restore can carry
  // hundreds of images.
  const pattern = new RegExp(Array.from(rewrites.keys()).map(escapeRegExp).join("|"), "g");
  const swap = (text) => String(text || "").replace(pattern, (match) => rewrites.get(match) || match);
  decks.forEach((deck) => {
    deck.notes = swap(deck.notes);
    (deck.cards || []).forEach((card) => {
      card.question = swap(card.question);
      card.answer = swap(card.answer);
    });
  });
}

// The writes planBackupAssetAdoption deliberately deferred. Best-effort per
// image: one that can't be stored leaves a placeholder that renders as missing,
// which is no worse than the dead link it replaced.
export async function commitBackupAssets(plan, onProgress) {
  if (!plan) return { kept: 0, adopted: 0, failed: 0 };
  let kept = 0;
  let adopted = 0;
  let failed = 0;
  const total = plan.keep.length + plan.adopt.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  for (const item of plan.keep) {
    await cacheUploadedImageOffline(item.ref, item.blob);
    kept += 1;
    tick();
  }
  for (const item of plan.adopt) {
    try {
      await putOutboxImage({
        token: item.token,
        blob: item.blob,
        folder: item.folder,
        savedAt: new Date().toISOString()
      });
      adopted += 1;
    } catch (error) {
      console.warn("Could not store a restored image on this device", item.ref, error);
      failed += 1;
    }
    tick();
  }
  return { kept, adopted, failed };
}

// Match a backup deck to a local library entry: cloud/deck id first, then a
// unique title match. Ambiguous title (2+ local decks share it) → treat as new.
export function findLocalMatchForBackupDeck(backupDeck, index) {
  if (backupDeck.deckId) {
    const byId = index.find((meta) => meta.deckId && String(meta.deckId) === String(backupDeck.deckId));
    if (byId) return byId;
  }
  const title = normalizeSyncText(backupDeck.title);
  if (title) {
    const byTitle = index.filter((meta) => normalizeSyncText(meta.title) === title);
    if (byTitle.length === 1) return byTitle[0];
  }
  return null;
}

// Dry run — classify every backup deck against the current device state WITHOUT
// writing anything. Reuses the sync diff engine (fuzzy:false: stable-id diff).
export async function planRestore(backupDecks) {
  const index = readLocalDeckIndex();
  const decks = [];
  const totals = { newDecks: 0, cardsAdded: 0, cardsUpdated: 0, cardsKept: 0, notesUpdated: 0, unchanged: 0 };

  // for-of, not forEach: this loop awaits readDeckSnapshot per deck, and
  // forEach can't be paused for a promise — its callback's return value is
  // silently discarded, which would fire every read in parallel and start
  // pushing into `decks`/`totals` out of order before earlier reads resolve.
  for (const backupDeck of backupDecks) {
    const localMeta = findLocalMatchForBackupDeck(backupDeck, index);
    if (!localMeta) {
      decks.push({ title: backupDeck.title, status: "new", localId: null, backupDeck, counts: { added: backupDeck.cards.length } });
      totals.newDecks += 1;
      totals.cardsAdded += backupDeck.cards.length;
      continue;
    }

    const localSnapshot = await readDeckSnapshot(localMeta.id);
    // Newest-wins per deck: the backup only overwrites an existing card or the
    // notes when the backup deck was edited more recently than the local one.
    // A missing card is ALWAYS added back and a local-only card is ALWAYS kept,
    // regardless of direction — those can't lose data either way. Tie / unknown
    // timestamps favour keeping local (never overwrite on a guess).
    const localTime = Date.parse(localMeta.updatedAt || "") || 0;
    const backupTime = Date.parse(backupDeck.updatedAt || "") || 0;
    const backupNewer = backupTime > localTime;

    const localCards = (localSnapshot && localSnapshot.cards) || [];
    // Count by DISTINCT card (id-keyed union), matching exactly what
    // mergeDeckSnapshots does on apply, so the preview never over/under-states.
    const localById = new Map(localCards.map((card) => [String(card.id), card]));
    const backupIds = new Set(backupDeck.cards.map((card) => String(card.id)));
    let backupOnly = 0;  // in backup, not local -> always added back
    let differing = 0;   // id-matched card whose question/answer/status differs
    backupDeck.cards.forEach((backupCard) => {
      const local = localById.get(String(backupCard.id));
      if (!local) {
        backupOnly += 1;
      } else if (
        syncTextChanged(local.question, backupCard.question)
        || syncTextChanged(local.answer, backupCard.answer)
        || normalizeCardStatus(local.status) !== normalizeCardStatus(backupCard.status)
        // A quick-note label move is a real difference; without this a backup
        // that only recategorised notes was previewed (and applied) as
        // "unchanged", so the labels never came back.
        || (local.category || null) !== (backupCard.category || null)
      ) {
        differing += 1;
      }
    });
    const localOnly = localCards.reduce((n, card) => n + (backupIds.has(String(card.id)) ? 0 : 1), 0);

    const localNotes = (localSnapshot && localSnapshot.notes) || "";
    const notesDiffer = syncTextChanged(localNotes, backupDeck.notes);
    // Everything the deck's meta bag holds — a quick-note category this device
    // has lost, a bookmark, a pinned-from anchor, and above all the highlights
    // on a paper. Merged the same way applyRestore will, so the preview can
    // never promise something the apply won't do.
    //
    // It used to ask about quick-note categories ALONE, which is why a restore
    // that would bring back fifty deleted highlights previewed as "unchanged"
    // and then, correctly, changed nothing: the merge behind it could not repair
    // a partial loss either. Both halves are fixed together, because a preview
    // that told the truth about the old merge would only have been a clearer
    // description of the same hole.
    const localMetaBag = (localSnapshot && localSnapshot.meta) || {};
    const mergedMeta = mergeBackupMeta(localMetaBag, backupDeck.meta);
    const metaKeysRestored = restoredMetaKeys(localMetaBag, mergedMeta);
    const highlightsRestored = restoredHighlightCount(localMetaBag, mergedMeta);
    const metaRestored = metaKeysRestored.length > 0;

    // What will actually be written, given the direction.
    const overwritten = backupNewer ? differing : 0;   // matched cards replaced by backup
    const heldLocal = backupNewer ? 0 : differing;     // matched cards kept (local newer/tie)
    const notesUpdated = backupNewer && notesDiffer;
    const notesHeldLocal = notesDiffer && !backupNewer;

    // A write happens only if a card is added, an existing card is overwritten,
    // the notes are replaced, or something the meta bag holds comes back.
    // Differences we deliberately keep local are NOT changes, so a deck where
    // the backup is older with only conflicting edits (and nothing to add) is
    // correctly "unchanged".
    if (!backupOnly && !overwritten && !notesUpdated && !metaRestored) {
      decks.push({ title: backupDeck.title, status: "unchanged", localId: localMeta.id, localMeta, localSnapshot, backupDeck, backupNewer, counts: {} });
      totals.unchanged += 1;
      continue;
    }

    decks.push({
      title: backupDeck.title,
      status: "conflict",
      localId: localMeta.id,
      localMeta,
      localSnapshot,
      backupDeck,
      backupNewer,
      counts: {
        added: backupOnly,
        overwritten,
        heldLocal,
        kept: localOnly,
        notesUpdated: notesUpdated ? 1 : 0,
        notesHeldLocal: notesHeldLocal ? 1 : 0,
        metaRestored: metaRestored ? 1 : 0,
        highlightsRestored,
        // Named, not just counted. "34 highlights restored · bookmark restored"
        // is what someone needs in front of a button they are about to press;
        // "meta restored" is a sentence about the implementation.
        metaKeysRestored
      }
    });
    totals.cardsAdded += backupOnly;
    totals.cardsUpdated += overwritten;
    totals.cardsKept += localOnly + heldLocal;
    if (notesUpdated) totals.notesUpdated += 1;
  }

  return { decks, totals };
}

// Short, stable, order-sensitive fingerprint of a backup deck's own content.
// Deterministic, so re-running the same restore keeps updating the same local
// entry instead of duplicating it — but distinct for two different decks that
// merely share a title.
export function backupDeckFingerprint(backupDeck) {
  const source = [
    normalizeDeckCategory(backupDeck.category),
    String(backupDeck.notes || "").slice(0, 200),
    ...(backupDeck.cards || []).slice(0, 40).map((card) => `${card.id}|${String(card.question || "").slice(0, 60)}`)
  ].join("\u0000");
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

// Stable local id for a restored deck so re-running a restore updates in place
// instead of duplicating (mirrors the deterministic-id reconcile at
// applyCloudDeckToLocal). Reuses an existing local entry if the deckId is known.
export function deterministicRestoreLocalId(backupDeck) {
  const index = readLocalDeckIndex();
  if (backupDeck.deckId) {
    const existing = index.find((meta) => meta.deckId && String(meta.deckId) === String(backupDeck.deckId));
    if (existing) return existing.id;
    return `ld_restore_${String(backupDeck.deckId).replace(/[^A-Za-z0-9_-]/g, "")}`;
  }
  // Two decks in one archive can share a title AND carry no deck id (older
  // exports), in which case a title-only key made the second silently overwrite
  // the first — one of them just vanished from the restore. The fingerprint is
  // what keeps them apart.
  const slug = (slugifyFileName(backupDeck.title || "deck") || "deck").replace(/[^A-Za-z0-9_-]/g, "");
  return `ld_restore_${slug || "deck"}_${backupDeckFingerprint(backupDeck)}`;
}

export function backupDeckToSnapshot(backupDeck, localId) {
  const now = new Date().toISOString();
  const meta = normalizeBackupMeta(backupDeck.meta);
  return {
    app: "recall",
    version: 1,
    exportedAt: now,
    deckTitle: backupDeck.title || "",
    deckCategory: normalizeDeckCategory(backupDeck.category),
    notes: backupDeck.notes || "",
    sourceTitle: backupDeck.title || "",
    importTitleHint: backupDeck.title || "",
    deckId: backupDeck.deckId || null,
    current: backupDeck.current || 0,
    localDeckId: localId,
    // Quick-note category definitions + source anchors, so restored notes can
    // resolve their labels instead of all reading as Uncategorized.
    ...(Object.keys(meta).length ? { meta } : {}),
    cards: backupDeck.cards.map((card) => ({
      id: card.id,
      question: card.question,
      answer: card.answer,
      status: normalizeCardStatus(card.status),
      category: card.category || null,
      // Restored cards owe the cloud a push. Without `dirty`, the pull-side
      // merge (mergeCloudCardsIntoSnapshot) reads a local-only clean card as
      // "this reached the cloud once, so the cloud not having it IS a deletion"
      // and drops it — deleting exactly the cards the restore just brought
      // back, on the very next sync.
      dirty: true,
      updatedAt: now,
      ...(card.noteAnchor ? { noteAnchor: card.noteAnchor } : {})
    }))
  };
}

// Newest-wins union merge. Always: keep every local card, append backup-only
// cards. Only when `backupNewer` is true does the backup overwrite an
// id-matched card's content/status or replace the notes — otherwise the local
// copy is kept. Local-only cards are never dropped in either direction.
export function mergeDeckSnapshots(localSnapshot, backupDeck, backupNewer) {
  const local = localSnapshot || {};
  const now = new Date().toISOString();
  const cards = Array.isArray(local.cards) ? local.cards.slice() : [];
  const indexById = new Map(cards.map((card, i) => [String(card.id), i]));
  let added = 0;
  let updated = 0;

  backupDeck.cards.forEach((backupCard) => {
    const key = String(backupCard.id);
    if (indexById.has(key)) {
      if (!backupNewer) return; // local is newer/tie -> keep the local card as-is
      const i = indexById.get(key);
      const current = cards[i];
      const changed = syncTextChanged(current.question, backupCard.question)
        || syncTextChanged(current.answer, backupCard.answer)
        || normalizeCardStatus(current.status) !== normalizeCardStatus(backupCard.status)
        || (current.category || null) !== (backupCard.category || null);
      cards[i] = {
        ...current,
        question: backupCard.question,
        answer: backupCard.answer,
        status: normalizeCardStatus(backupCard.status),
        // Quick-note subject label follows the same newest-wins rule as the text.
        category: backupCard.category || null,
        // Only a card the backup actually CHANGED owes the cloud a push; one the
        // restore left byte-identical keeps whatever sync flags it already had.
        ...(changed ? { dirty: true, updatedAt: now } : {}),
        ...(backupCard.noteAnchor ? { noteAnchor: backupCard.noteAnchor } : {})
      };
      if (changed) updated += 1;
    } else {
      cards.push({
        id: backupCard.id,
        question: backupCard.question,
        answer: backupCard.answer,
        status: normalizeCardStatus(backupCard.status),
        category: backupCard.category || null,
        // See backupDeckToSnapshot: a clean local-only card is dropped by the
        // next pull as "deleted in the cloud", which would undo the restore.
        dirty: true,
        updatedAt: now,
        ...(backupCard.noteAnchor ? { noteAnchor: backupCard.noteAnchor } : {})
      });
      added += 1;
    }
  });

  const meta = mergeBackupMeta(local.meta, backupDeck.meta);

  // The notes body, and the half of it that is not prose.
  //
  // A paper's notes end with a fenced block holding one entry per highlight —
  // that block is where the words you wrote ON a highlight live. Treating the
  // whole body as one last-write-wins string meant restoring fifty lost
  // highlights restored fifty records whose NOTES were still gone, because the
  // local body won: the annotations came back stripped of everything said about
  // them. The sync has merged those two things together since document-sync.js
  // was written — per entry, settled by each note's own stamp — so a restore
  // asks it the same question, with the archive standing where the cloud
  // stands. `body` follows the existing newest-wins direction, so the reader's
  // own prose behaves exactly as it did.
  const hasAnnotations = Array.isArray(meta.pdfHighlights)
    || Array.isArray((local.meta || {}).pdfHighlights)
    || Array.isArray((backupDeck.meta || {}).pdfHighlights);
  const notes = hasAnnotations
    ? mergeDocumentAnnotations({
      cloudNotes: backupDeck.notes || "",
      cloudMeta: backupDeck.meta || {},
      localNotes: local.notes || "",
      localMeta: local.meta || {},
      body: backupNewer && syncTextChanged(local.notes || "", backupDeck.notes || "") ? "cloud" : "local"
    }).notes
    : (backupNewer && syncTextChanged(local.notes || "", backupDeck.notes || "")
      ? (backupDeck.notes || "")
      : (local.notes || ""));

  const snapshot = {
    ...local,
    app: "recall",
    version: 1,
    exportedAt: now,
    deckTitle: local.deckTitle || backupDeck.title || "",
    deckCategory: local.deckCategory || normalizeDeckCategory(backupDeck.category),
    notes,
    deckId: local.deckId || backupDeck.deckId || null,
    // Per key, and additive — see mergeBackupMeta. A quick-note category the
    // backup remembers and this device has lost comes back, a partially deleted
    // set of highlights is completed, and nothing local is dropped.
    meta,
    cards
  };
  return { snapshot, added, updated };
}

export function upsertRestoredMeta(localId, snapshot, backupDeck) {
  const index = readLocalDeckIndex();
  const existing = index.find((meta) => meta.id === localId);
  const now = new Date().toISOString();
  const meta = {
    id: localId,
    title: snapshot.deckTitle || "Untitled deck",
    category: snapshot.deckCategory || defaultDeckCategory,
    cardCount: (snapshot.cards || []).length,
    hasNotes: Boolean(String(snapshot.notes || "").trim()),
    updatedAt: now,
    createdAt: existing?.createdAt || now,
    lastSyncedAt: existing ? existing.lastSyncedAt || null : null,
    accessedAt: existing ? existing.accessedAt || null : null,
    deckId: snapshot.deckId || backupDeck.deckId || null
  };
  writeLocalDeckIndex([meta, ...index.filter((entry) => entry.id !== localId)]);
}

// What each meta key is called in front of a person. The bag's key names are
// implementation ("pdfToc", "linkIds"); a preview row is read by someone
// deciding whether to press a button.
export const META_KEY_LABELS = {
  pdf: "paper",
  pdfToc: "paper contents",
  bookmark: "bookmark",
  readingPosition: "reading position",
  linkIds: "note links",
  quickNoteCategories: "note categories",
  noteAnchors: "pinned notes"
};

// Confirmation preview — resolves true to apply, false to cancel. Nothing is
// written until the returned promise resolves true.
export function showRestorePreview(report) {
  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal restore-preview-modal";
    modal.setAttribute("aria-label", "Restore preview");

    const total = report.totals;
    const summaryBits = [];
    if (total.newDecks) summaryBits.push(`${total.newDecks} new deck${total.newDecks === 1 ? "" : "s"}`);
    if (total.cardsAdded) summaryBits.push(`${total.cardsAdded} card${total.cardsAdded === 1 ? "" : "s"} restored`);
    if (total.cardsUpdated) summaryBits.push(`${total.cardsUpdated} updated`);
    if (total.cardsKept) summaryBits.push(`${total.cardsKept} local kept`);
    if (total.notesUpdated) summaryBits.push(`${total.notesUpdated} notes updated`);
    if (total.unchanged) summaryBits.push(`${total.unchanged} unchanged`);
    const willChange = total.newDecks || total.cardsAdded || total.cardsUpdated || total.notesUpdated;

    // Images are the part of a restore that isn't visible in a card count, and
    // the part people most expect to be missing — say plainly what happens to
    // them: the archive's own copies are stored on this device, and the ones
    // that came from someone else's storage get re-uploaded to yours.
    const plan = report.assetPlan;
    const imageBits = [];
    if (plan?.keep.length) imageBits.push(`${plan.keep.length} already in your storage (saved for offline use)`);
    if (plan?.adopt.length) imageBits.push(`${plan.adopt.length} copied from the archive onto this device, then uploaded to your own storage`);
    const imageNote = imageBits.length ? `Images: ${imageBits.join(" · ")}.` : "";

    // Papers, said separately from images, because they are the reason a
    // restored deck either opens or asks you to go and find a file.
    const papers = report.documentIndex?.documents?.length || 0;
    const papersMissing = report.documentIndex?.missing?.length || 0;
    const paperNote = papers || papersMissing
      ? `Papers: ${papers} in this archive${papersMissing ? `, ${papersMissing} the backup could not read` : ""}.`
      : "";

    // What the archive claims, and whether the zip agrees. An archive that has
    // lost files is still worth restoring — losing them is the situation you are
    // already in — but never silently, and never behind a button that says the
    // same thing it says for an intact one.
    const verification = report.verification;
    let integrityNote = "";
    if (!verification || !verification.checked) {
      integrityNote = "This archive carries no index, so nothing in it has been checked. "
        + "Backups written before this version are all like this — it is not a sign of damage.";
    } else if (!verification.ok) {
      integrityNote = `This archive does not match its own index. ${verification.notes.join(" ")} `
        + "Everything still readable can be restored; what is missing cannot.";
    } else {
      const hashes = verification.hashes || { total: 0, hashed: 0 };
      integrityNote = hashes.hashed
        ? `Checked against this archive's own index: ${verification.counts?.found?.decks ?? 0} deck files present and the right size.`
        : `Checked against this archive's own index: every file is present and the right size.`;
    }

    const rowsHtml = report.decks.map((entry) => {
      let badge = "MERGE";
      let cls = "is-conflict";
      let detail = "";
      if (entry.status === "new") {
        badge = "NEW";
        cls = "is-new";
        detail = `${entry.counts.added} card${entry.counts.added === 1 ? "" : "s"}`;
      } else if (entry.status === "unchanged") {
        badge = "=";
        cls = "is-unchanged";
        detail = "unchanged";
      } else {
        const c = entry.counts;
        const bits = [];
        if (c.added) bits.push(`+${c.added} restored`);
        if (c.overwritten) bits.push(`~${c.overwritten} updated`);
        if (c.heldLocal) bits.push(`${c.heldLocal} local newer (kept)`);
        if (c.kept) bits.push(`${c.kept} local kept`);
        if (c.notesUpdated) bits.push("notes updated");
        if (c.notesHeldLocal) bits.push("notes differ (local newer, kept)");
        // Named, key by key. This row used to read "note categories restored"
        // for every kind of meta change there is, because the count behind it
        // only ever asked about quick-note categories — so a restore bringing
        // back fifty highlights and a bookmark said nothing at all about either.
        if (c.highlightsRestored) bits.push(`${c.highlightsRestored} highlight${c.highlightsRestored === 1 ? "" : "s"} restored`);
        for (const key of c.metaKeysRestored || []) {
          if (key === "pdfHighlights" || key === "deletedHighlightIds") continue; // counted above
          bits.push(`${META_KEY_LABELS[key] || key} restored`);
        }
        detail = bits.join(" · ") || "changes";
      }
      return `<li class="restore-row ${cls}">`
        + `<span class="restore-badge">${badge}</span>`
        + `<span class="restore-name"><span class="restore-title"></span><span class="restore-folder"></span></span>`
        + `<span class="restore-detail">${escapeHtml(detail)}</span>`
        + `</li>`;
    }).join("");

    const shell = document.createElement("div");
    shell.className = "category-choice-shell restore-preview-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2>Restore from backup</h2>
          <p>Reviewed against your current decks. Nothing changes until you confirm.</p>
        </div>
        <button type="button" data-restore-cancel aria-label="Close">&#215;</button>
      </div>
      <ul class="restore-deck-list">${rowsHtml}</ul>
      <p class="restore-summary">${escapeHtml(summaryBits.join(" · ") || "No changes to apply.")}</p>
      ${imageNote ? `<p class="restore-summary">${escapeHtml(imageNote)}</p>` : ""}
      ${paperNote ? `<p class="restore-summary">${escapeHtml(paperNote)}</p>` : ""}
      <p class="restore-integrity${verification && verification.checked && !verification.ok ? " is-warning" : ""}">${escapeHtml(integrityNote)}</p>
      <p class="restore-note">A full backup of your current decks is saved first, so this is reversible. Local-only decks and cards are never deleted.</p>
      <div class="category-choice-actions">
        <button type="button" data-restore-cancel>Cancel</button>
        <button type="button" class="import-action-primary" data-restore-confirm ${willChange ? "" : "disabled"}>${verification && verification.checked && !verification.ok ? "Restore what's readable" : "Merge &amp; Restore"}</button>
      </div>
    `;

    // Titles set via textContent (never innerHTML) so deck names can't inject markup.
    const titleSpans = shell.querySelectorAll(".restore-title");
    const folderSpans = shell.querySelectorAll(".restore-folder");
    report.decks.forEach((entry, i) => {
      if (titleSpans[i]) titleSpans[i].textContent = entry.title || "Untitled deck";
      // Where the deck will live. Worth showing: for an archive with no folder
      // information of its own this is the folder the restore INFERRED, and the
      // preview is the place to notice it before anything is written.
      if (folderSpans[i]) {
        const folder = normalizeDeckCategory(entry.localMeta?.category || entry.backupDeck?.category);
        folderSpans[i].textContent = folder === defaultDeckCategory ? "" : folder.split(FOLDER_SEP).join(" / ");
      }
    });

    const cleanup = (value) => {
      modal.remove();
      resolve(value);
    };
    shell.querySelectorAll("[data-restore-cancel]").forEach((button) => {
      button.addEventListener("click", () => cleanup(false));
    });
    shell.querySelector("[data-restore-confirm]")?.addEventListener("click", () => cleanup(true));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(false);
    });

    modal.appendChild(shell);
    document.body.appendChild(modal);
    (shell.querySelector("[data-restore-confirm]:not([disabled])") || shell.querySelector("[data-restore-cancel]"))?.focus();
  });
}

// The local id the ARCHIVE knew a deck by, out of the manifest. Two things are
// keyed by it and neither can be found without it: the document store's rows,
// and the reading positions, whose key has the local id baked into it. Only the
// manifest records it — the deck JSON never has.
export function archiveLocalIdFor(manifest, backupDeck) {
  if (!manifest || !backupDeck?.archivePath) return "";
  const row = (Array.isArray(manifest.decks) ? manifest.decks : []).find((deck) => deck.file === backupDeck.archivePath);
  return row?.localId ? String(row.localId) : "";
}

export async function applyRestore(report, { autoBackup = true } = {}) {
  // Nothing on the device, nothing to protect. Worth checking BEFORE the panel
  // is opened rather than letting the backup discover it: on a fresh install —
  // the single most common place a restore is run — the safety step used to
  // open a progress panel, count to zero, and finish on a red "This device has
  // no decks saved yet" that had to be dismissed by hand before the restore the
  // user actually asked for could be seen. An error-shaped interruption
  // announcing a non-problem, in front of the thing it was protecting.
  if (autoBackup && readLocalDeckIndex().length) {
    try {
      await exportLibraryBackupZip({
        fileBaseName: `recall-backup-before-restore-${backupTimestamp()}`,
        panelTitle: "Saving a safety backup first",
        autoClosePanel: true,
        // Without the papers, and only here. A restore can ADD a document's
        // bytes to a deck that has none, re-key ones already on this disk, or
        // refuse one whose hash disagrees — there is no branch in
        // planBackupDocumentRestore that removes or overwrites a file. So the
        // safety copy is protecting against something that cannot happen, and
        // paying for it by holding a second copy of every paper in memory
        // in front of the restore is how the safety net becomes the crash.
        includeDocuments: false,
        // Recorded, but it does not move the backup reminder: restoring
        // something is not a decision to back up, and this is the worst possible
        // moment to tell someone they are covered.
        kind: "safety"
      });
    } catch (error) {
      console.warn("Pre-restore safety backup failed (continuing)", error);
    }
  }

  // Store the archive's images on this device first, so every deck written
  // below already has its pictures behind it.
  const assetResult = await commitBackupAssets(report.assetPlan, (done, total) => {
    setStatus(`Restoring images ${done}/${total}…`);
  });

  let addedDecks = 0;
  let mergedDecks = 0;
  let cardsAdded = 0;
  let cardsUpdated = 0;
  const restoredDeckIds = [];
  const failedDecks = [];
  // archive local id -> the id this device actually used. Built as the decks are
  // written rather than derived up front, because deterministicRestoreLocalId
  // consults the library index and the index is being written to as we go.
  const localIdByArchiveId = new Map();
  const localIdByDeck = new Map();

  // for-of with an await, not forEach — and the await is the point.
  //
  // writeDeckSnapshot persists in the background by design (see deck-store.js),
  // so a synchronous loop returned before any of it had been attempted and the
  // summary underneath printed "Restore complete — 40 decks added" over writes
  // that had not happened yet. A device that ran out of space part-way through
  // said exactly the same sentence as one that succeeded, with the failures
  // going to console.warn where nobody was looking. Of every place in this app
  // that could report a success it did not have, this is the one where being
  // wrong costs the user the data they came here to recover.
  for (const entry of report.decks) {
    // An UNCHANGED deck still has to be in the two maps below. Its cards and
    // notes need no write — that is what unchanged means — but the archive may
    // still be carrying the one thing this device does not have: the PDF. A
    // library whose documents were cleared but whose decks were not is exactly
    // that shape, and skipping these entirely left every one of those papers
    // unmatched and unrestored.
    if (entry.status === "unchanged" && entry.localId) {
      localIdByDeck.set(entry.backupDeck, entry.localId);
      const archived = archiveLocalIdFor(report.manifest, entry.backupDeck);
      if (archived) localIdByArchiveId.set(archived, entry.localId);
      continue;
    }
    if (entry.status !== "new" && entry.status !== "conflict") continue;
    const isNew = entry.status === "new";
    const localId = isNew ? deterministicRestoreLocalId(entry.backupDeck) : entry.localId;
    try {
      const merged = isNew ? null : mergeDeckSnapshots(entry.localSnapshot, entry.backupDeck, entry.backupNewer);
      const snapshot = isNew ? backupDeckToSnapshot(entry.backupDeck, localId) : merged.snapshot;
      // A restore is an explicit "this should exist again" for cards too, not
      // just decks — retire the tombstone of anything the backup brought back.
      if (!isNew) dropTombstonesForLiveCards(snapshot);
      // An archive taken before the sanitizer existed still carries whatever the
      // PDF put in it, and a restore is the one path that puts a snapshot on
      // disk without going through a save. Repair it on the way in, so a
      // restored library does not need a sync failure to discover the problem
      // again. See repairSnapshotText.
      repairSnapshotText(snapshot);
      writeDeckSnapshot(localId, snapshot);
      await deckWriteSettled(localId);
      upsertRestoredMeta(localId, snapshot, entry.backupDeck);
      if (snapshot.deckId) restoredDeckIds.push(String(snapshot.deckId));
      localIdByDeck.set(entry.backupDeck, localId);
      const archiveId = archiveLocalIdFor(report.manifest, entry.backupDeck);
      if (archiveId) localIdByArchiveId.set(archiveId, localId);
      if (isNew) {
        addedDecks += 1;
        cardsAdded += entry.backupDeck.cards.length;
      } else {
        mergedDecks += 1;
        cardsAdded += merged.added;
        cardsUpdated += merged.updated;
      }
    } catch (error) {
      console.warn("Failed to restore deck", entry.title, error);
      failedDecks.push(entry.title || "Untitled deck");
    }
  }

  // The papers. After the decks, because the store is keyed by the local id the
  // loop above has only just settled on — and that ordering is the whole of the
  // fix for a restore severing a paper from bytes on its own disk.
  let documentResult = { stored: 0, rebound: 0, present: 0, failed: 0, refused: 0 };
  if (report.zip && report.documentIndex?.documents?.length) {
    try {
      const plan = await planBackupDocumentRestore(
        report.zip,
        report.documentIndex,
        report.decks.map((entry) => entry.backupDeck).filter(Boolean),
        (deck) => localIdByDeck.get(deck) || ""
      );
      documentResult = await commitBackupDocuments(plan, (done, total) => {
        setStatus(`Restoring papers ${done}/${total}…`);
      });
    } catch (error) {
      console.warn("Could not restore this archive's papers", error);
    }
  }

  // Empty folders, open folds, and where you were in each note.
  //
  // library.json is the precise answer — it carries the device's own registry of
  // folders that hold no decks, which is the only place such a folder exists at
  // all. The manifest's `folders` is the fallback for an archive written before
  // that file existed: it lists every folder a deck was IN as well, so restoring
  // from it registers folders that would have come back on their own. That is
  // the right trade for a v1/v2 archive — a folder listed twice costs nothing, a
  // folder lost costs the shape of someone's library — and the wrong one when a
  // precise list is right there.
  const libraryResult = applyBackupLibraryState(report.libraryState, { localIdByArchiveId });
  if (!report.libraryState) {
    for (const path of Array.isArray(report.manifest?.folders) ? report.manifest.folders : []) {
      if (path && path !== defaultDeckCategory) addKnownFolder(path);
    }
  }

  // Restoring a deck is an explicit statement that it should exist again, so
  // retire its delete tombstones. Without this, a deck that had been deleted
  // came back only to be destroyed a sync or two later: the push pass skips a
  // tombstoned deck, then the tombstone-adoption pass deletes the local copy
  // outright. Queued (not written inline) so a restore performed offline still
  // takes effect — reconcileAllDecks drains the queue before it reads the
  // tombstone list.
  queuePendingUntombstones(restoredDeckIds);
  await flushPendingUntombstones();

  // Adopted images render from the local outbox straight away; pushing them to
  // this user's own storage now (rather than waiting for the next sync) is what
  // makes them survive onto their other devices. Best-effort — offline or
  // signed out, the outbox holds them and the next reconcile picks them up.
  if (assetResult.adopted) {
    try {
      const uploaded = await flushPendingImageUploads();
      if (uploaded) setStatus(`Uploaded ${uploaded} restored image${uploaded === 1 ? "" : "s"} to your storage…`);
    } catch (error) {
      console.warn("Restored images will upload on the next sync", error);
    }
  }

  await renderMyDecksList();

  // Every number below is something that LANDED. The counters are incremented
  // after the write is confirmed, not after it is queued, which is the whole
  // reason the loop above awaits.
  const parts = [];
  if (addedDecks) parts.push(`${addedDecks} deck${addedDecks === 1 ? "" : "s"} added`);
  if (mergedDecks) parts.push(`${mergedDecks} merged`);
  if (cardsAdded) parts.push(`${cardsAdded} card${cardsAdded === 1 ? "" : "s"} restored`);
  if (cardsUpdated) parts.push(`${cardsUpdated} updated`);
  const images = assetResult.kept + assetResult.adopted;
  if (images) parts.push(`${images} image${images === 1 ? "" : "s"} restored`);
  if (assetResult.failed) parts.push(`${assetResult.failed} image${assetResult.failed === 1 ? "" : "s"} could not be stored`);
  const papers = documentResult.stored + documentResult.rebound;
  if (papers) parts.push(`${papers} paper${papers === 1 ? "" : "s"} restored`);
  if (libraryResult.folders) parts.push(`${libraryResult.folders} folder${libraryResult.folders === 1 ? "" : "s"} restored`);
  if (libraryResult.readingPositions) parts.push(`${libraryResult.readingPositions} reading position${libraryResult.readingPositions === 1 ? "" : "s"} restored`);

  // Said out loud, in red, and never folded in with the successes. A restore
  // that could not write is a failed restore, and the person in front of it is
  // the only one who can do anything about the reason.
  const problems = [];
  if (failedDecks.length) {
    problems.push(`${failedDecks.length} deck${failedDecks.length === 1 ? "" : "s"} could not be saved`
      + ` (${failedDecks.slice(0, 3).join(", ")}${failedDecks.length > 3 ? ", and more" : ""})`
      + " — this device may be out of space");
  }
  if (documentResult.refused) {
    problems.push(`${documentResult.refused} paper${documentResult.refused === 1 ? "" : "s"} in this archive did not match the deck${documentResult.refused === 1 ? "" : "s"} `
      + "recorded for them and were not restored — their highlights would have landed on the wrong pages");
  }
  if (documentResult.failed) {
    problems.push(`${documentResult.failed} paper${documentResult.failed === 1 ? "" : "s"} could not be stored on this device`);
  }

  if (problems.length) {
    setStatus(`Restore finished with problems — ${parts.length ? `${parts.join(", ")}. ` : ""}${problems.join(". ")}.`, "error");
    showToast("Restore finished with problems", "error");
    return;
  }
  setStatus(`Restore complete — ${parts.length ? parts.join(", ") : "no changes"}.`);
  showToast("Restore complete", "success");
}

export async function runRestoreFlow(file) {
  // Unzipping a library-sized archive (images included) takes long enough that
  // a silent wait reads as a dead click, same as the backup did. The panel goes
  // away as soon as there's a preview to show.
  const progress = showBackupProgress("Reading backup");
  try {
    setStatus("Reading backup…");
    progress.update("Opening the archive…");
    progress.setStat("size", formatBackupSize(file.size));
    const archive = await readBackupArchive(file);
    const { decks: backupDecks, assets } = archive;
    progress.setStat("decks", backupDecks.length);
    progress.setStat("cards", backupDecks.reduce((n, deck) => n + deck.cards.length, 0));
    progress.setStat("images", assets.size);
    progress.setStat("papers", archive.documentIndex?.documents?.length || 0);
    if (progress.cancelled()) {
      progress.close();
      setStatus("Restore cancelled.");
      return;
    }
    // Images are re-homed BEFORE the diff: a foreign backup's references get
    // rewritten to local placeholders, and the preview then compares (and the
    // apply then writes) exactly the text the decks will end up with.
    progress.update("Checking this backup's images…");
    const assetPlan = await planBackupAssetAdoption(backupDecks, assets);
    applyBackupAssetRewrites(backupDecks, assetPlan.rewrites);
    progress.update("Comparing against your decks…");
    const report = await planRestore(backupDecks);
    report.assetPlan = assetPlan;
    // Everything the apply needs that is not a deck: the open zip (the papers
    // are read out of it lazily rather than held in memory beside it), the
    // manifest, what the verification found, and the library's own shape.
    report.zip = archive.zip;
    report.manifest = archive.manifest;
    report.verification = archive.verification;
    report.documentIndex = archive.documentIndex;
    report.libraryState = archive.libraryState;
    progress.close();
    const confirmed = await showRestorePreview(report);
    if (!confirmed) {
      setStatus("Restore cancelled.");
      return;
    }
    setStatus("Restoring…");
    await applyRestore(report);
  } catch (error) {
    console.error("Restore failed", error);
    setStatus(`Restore failed: ${error && error.message ? error.message : "unreadable backup"}`, "error");
    showToast("Restore failed", "error");
  } finally {
    progress.close();
  }
}
