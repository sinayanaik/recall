// Backup: the whole library as one .zip.
//
// Images ride INSIDE the archive rather than as links, because the links point
// at the user's own Supabase bucket — a backup that referenced them would stop
// working the moment that project went away, which is exactly when a backup
// matters. Restore re-homes them.

import { mapWithConcurrency, withRetry } from "../cloud/net.js?v=__BUILD__";
import { fetchableStorageUrl } from "../cloud/storage-urls.js?v=__BUILD__";
import { deckPayloadSnapshot } from "../cloud/web-decks.js?v=__BUILD__";
import { BUILD_STAMP, IS_DEV_BUILD } from "../core/build.js?v=__BUILD__";
import { ensureJsZip } from "../core/lib-loader.js?v=__BUILD__";
import { allMyDeckSelections } from "../export/decks.js?v=__BUILD__";
import { normalizeCardStatus, slugifyFileName } from "../export/markdown.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME, getOutboxImage } from "../images/outbox.js?v=__BUILD__";
import { OFFLINE_IMAGE_CACHE } from "../images/upload.js?v=__BUILD__";
import { FOLDER_SEP, folderSegments, normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { myDeckPayload } from "../library/my-decks-selection.js?v=__BUILD__";
import { mergePdfHighlights } from "../sync/diff.js?v=__BUILD__";
import { highlightTombstoneMs, mergeDeckMeta, mergeHighlightTombstones } from "../sync/document-sync.js?v=__BUILD__";
import { sha256 } from "../documents/pdf-store.js?v=__BUILD__";
import { utf8Bytes } from "../export/zip.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";
import {
  BACKUP_ASSET_DIR, BACKUP_ASSET_INDEX, BACKUP_ASSET_SCHEMA, BACKUP_DECK_DIR,
  BACKUP_DOCUMENT_INDEX, BACKUP_LIBRARY_FILE, BACKUP_MANIFEST_FILE, BACKUP_SETTINGS_FILE,
  PACKAGE_EXT, PACKAGE_KIND_LIBRARY, PACKAGE_KIND_SHARE, PACKAGE_MIME,
  buildBackupManifest, collectBackupSettings, newPackageId, normalizeBackupManifest, shareMetaBag
} from "./archive-format.js?v=__BUILD__";
import { DOCUMENT_MISSING_OFFLOADED, packBackupDocuments } from "./documents.js?v=__BUILD__";
import { recordBackup } from "./history.js?v=__BUILD__";
import { formatJobBytes, raceCancel, showJobConsole } from "./job-console.js?v=__BUILD__";
import { collectBackupLibraryState } from "./library-state.js?v=__BUILD__";
import { LiteZip, canInflate, yieldToPage } from "./zip-lite.js?v=__BUILD__";

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Filesystem-safe local timestamp with SECONDS, so multiple backups on the same
// day (and a backup + its pre-restore safety backup moments apart) get distinct
// names instead of colliding. Colons are illegal in filenames -> dashes.
export function backupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

// The deck-level meta bag, whatever shape it arrived in (a parsed object, a JSON
// string from a hand-edited archive, or missing entirely).
export function normalizeBackupMeta(raw) {
  let bag = raw;
  if (typeof bag === "string") {
    try { bag = JSON.parse(bag); } catch { bag = null; }
  }
  return bag && typeof bag === "object" && !Array.isArray(bag) ? bag : {};
}

// Restore is ADDITIVE, and this bag is where that used to stop being true.
//
// It was `{ ...backup, ...local }` with two hand-rolled rules bolted on, which
// means local won every other key unconditionally — so a PARTIAL loss was
// unrepairable. Fifty of a paper's sixty highlights deleted, a bookmark cleared,
// a pinned-from anchor dropped: restore the backup that still has them and
// nothing happens, because the local bag is present and therefore wins. Only a
// TOTAL loss of a key could ever be repaired, and the preview did not even
// mention the difference — planRestore asked about quick-note categories and
// nothing else.
//
// The sync already settles this exact bag, key by key, in both directions, and
// has done since document-sync.js was written — its own comment lists what
// "whoever wrote last wins" costs for pdf, bookmark, quickNoteCategories,
// noteAnchors, linkIds and readingPosition. A restore is the same question with
// the archive standing where the cloud stands. So it asks that, rather than
// keeping a second, weaker set of rules beside it that would drift: two merges
// of one bag is how this diverged in the first place.
//
// `prefer: "local"` keeps today's behaviour for any key nobody has a rule for —
// a restore must never overwrite work this device has and the archive does not.
// The highlights and their tombstones are the two mergeDeckMeta leaves to its
// callers, because the sync merges them alongside the notes body they are
// written in; here there is no body to settle, so they are merged directly.
export function mergeBackupMeta(localMeta, backupMeta) {
  const local = normalizeBackupMeta(localMeta);
  const backup = normalizeBackupMeta(backupMeta);
  const merged = mergeDeckMeta(backup, local, { prefer: "local" });

  const localRecords = Array.isArray(local.pdfHighlights) ? local.pdfHighlights : null;
  const backupRecords = Array.isArray(backup.pdfHighlights) ? backup.pdfHighlights : null;
  if (localRecords || backupRecords) {
    // Tombstones from BOTH sides, so a highlight the reader deleted after the
    // backup was taken stays deleted. A plain union of the live records would
    // resurrect precisely the ones someone took the trouble to remove.
    merged.pdfHighlights = mergePdfHighlights(backupRecords, localRecords, {
      tombstones: highlightTombstoneMs(backup, local)
    });
    const tombstones = mergeHighlightTombstones(backup, local);
    if (tombstones && Object.keys(tombstones).length) merged.deletedHighlightIds = tombstones;
  }
  return merged;
}

// Which meta keys a restore would actually put back — for the preview, so it can
// name them instead of the single "note categories restored" it used to manage.
// Compared as JSON because these are arrays and nested bags rebuilt by a merge,
// where identical content in a different order is the ordinary case.
export function restoredMetaKeys(localMeta, mergedMeta) {
  const local = normalizeBackupMeta(localMeta);
  const merged = normalizeBackupMeta(mergedMeta);
  const changed = [];
  for (const key of Object.keys(merged)) {
    if (JSON.stringify(merged[key]) !== JSON.stringify(local[key])) changed.push(key);
  }
  return changed;
}

// How many highlights a restore would bring back on one deck. Counted rather
// than described, because "34 highlights restored" is the sentence someone
// needs in front of a button they are about to press.
export function restoredHighlightCount(localMeta, mergedMeta) {
  const local = normalizeBackupMeta(localMeta);
  const merged = normalizeBackupMeta(mergedMeta);
  if (!Array.isArray(merged.pdfHighlights)) return 0;
  const had = new Set((Array.isArray(local.pdfHighlights) ? local.pdfHighlights : []).map((record) => String(record?.id)));
  return merged.pdfHighlights.filter((record) => !had.has(String(record?.id))).length;
}

// Coerce any deck shape we might read from an archive — a per-deck backup file,
// a legacy deckPayloadSnapshot, or a normalizeWebDeckPayload deck+cards bundle —
// into the single shape planRestore/applyRestore work with.
// `fallbackCategory` is the folder the file itself sat in inside the archive.
// It only applies when the deck carries no category of its own, which is what
// lets an unstructured zip — deck files someone dropped into folders by hand —
// come back organised into folders of those names instead of one flat pile.
export function normalizeBackupDeck(raw, fallbackCategory = "") {
  if (!raw || typeof raw !== "object") return null;
  const cards = Array.isArray(raw.cards) ? raw.cards : [];
  const title = raw.deckTitle || raw.title || (raw.deck && raw.deck.title) || "Untitled deck";
  const ownCategory = raw.deckCategory || raw.category || (raw.deck && raw.deck.category) || "";
  return {
    deckId: raw.deckId || raw.deck_id || (raw.deck && raw.deck.id) || null,
    title: String(title),
    category: normalizeDeckCategory(ownCategory || fallbackCategory),
    notes: String(raw.notes || (raw.deck && raw.deck.notes) || ""),
    // Carried through so a restore puts the quick-note category NAMES and
    // COLOURS back, not just the per-card ids that point at them — without it
    // every restored note resolved its label against a category that no longer
    // existed and showed up as Uncategorized.
    meta: normalizeBackupMeta(raw.meta || (raw.deck && raw.deck.meta)),
    current: Number.isFinite(Number(raw.current)) ? Number(raw.current) : 0,
    updatedAt: raw.updatedAt || raw.updated_at || raw.exportedAt || null,
    cards: cards.map((card, index) => ({
      id: String(card.id || `${index}`),
      question: String(card.question || ""),
      answer: String(card.answer || ""),
      status: normalizeCardStatus(card.status),
      // Quick-note subject label (see `meta` above).
      category: card.category ? String(card.category) : null,
      ...(card.noteAnchor ? { noteAnchor: card.noteAnchor } : {})
    }))
  };
}

// ── Live backup panel ──────────────────────────────────────────────────────
// A backup used to be one click followed by a long silence. It then got a panel
// with one line on it, which is a long silence with a picture. The panel is now
// src/backup/job-console.js — steps, the item in hand, counters, a log — and
// this name is kept for the callers that already hold it.
export function showBackupProgress(title = "Backing up your library", options = {}) {
  return showJobConsole(title, options);
}

export function formatBackupSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// ── Images travel INSIDE the backup ────────────────────────────────────────
// A deck's markdown only ever holds an image REFERENCE — a public Supabase
// Storage URL, or a `recall-img:<token>` placeholder for one still queued
// offline. A backup of just that text is only as portable as those references
// are: hand the zip to someone else (or to yourself after the bucket is gone)
// and every picture is a dead link, because the bytes only ever lived in the
// original owner's project.
//
// So the archive carries the bytes too: `assets/index.json` maps each original
// reference to a file in `assets/`, and restore re-homes them (see
// planBackupAssetAdoption). Deck JSON keeps the ORIGINAL urls untouched, which
// is what keeps a new backup readable by an older build and makes restoring
// your own backup into your own project a no-op.
//
// The paths and the schema names live in ./archive-format.js, with the rest of
// what the archive IS, so the writer here and the reader in restore.js cannot
// disagree about them — which they did, on the manifest, for the whole of the
// format's life.

// Per-image ceiling when the bytes have to come off the network. Generous
// enough for a slow phone on a big screenshot, short enough that a dead host
// can't hold the whole backup hostage.
export const BACKUP_ASSET_FETCH_TIMEOUT_MS = 20000;

// Every image reference in a deck's text: markdown `![alt](url)` (optional
// `<...>` wrapping and a trailing "title") and raw `<img src=…>`, which the
// notes renderer accepts just as readily.
export const BACKUP_IMAGE_REF_RE = new RegExp(
  "!\\[[^\\]]*\\]\\(\\s*<?([^)\\s<>\"']+)"
  + "|<img\\b[^>]*?\\bsrc\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
  "gi"
);

// An image WE host, in a Supabase Storage bucket, as opposed to a third-party
// link someone pasted. The difference decides two things: whether a failed
// fetch is worth retrying (a third-party CORS refusal never becomes reachable,
// however many times it's asked), and how the result is reported — a missing
// upload of ours is a real gap in the archive, an unreachable external link is
// a link the archive keeps but cannot inline.
//
// Matched on url shape rather than through supabaseImagePathFromUrl, which
// needs a live client and so classifies everything as external when signed out.
export function isSupabaseStorageRef(ref) {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\//i.test(String(ref || ""));
}

// Refs whose bytes we can actually pack. `data:` images are already inline in
// the markdown, and in-page `blob:`/anchor urls are meaningless in an archive.
export function isPackableImageRef(ref) {
  if (!ref) return false;
  if (ref.startsWith(LOCAL_IMAGE_SCHEME)) return true;
  return /^https?:\/\//i.test(ref);
}

export function collectBackupImageRefs(snapshot, into = new Set()) {
  const scan = (text) => {
    for (const match of String(text || "").matchAll(BACKUP_IMAGE_REF_RE)) {
      const ref = decodeImageRefEntities(match[1] || match[2] || match[3] || match[4] || "");
      if (isPackableImageRef(ref)) into.add(ref);
    }
  };
  scan(snapshot?.notes);
  for (const card of snapshot?.cards || []) {
    scan(card.question);
    scan(card.answer);
  }
  // A PDF deck's image blocks (`src`) and text blocks (`md`) hold figures of
  // their own. Left out, a backup quietly lacked them — and a backup is what
  // the reader is told to take before anything in the cloud is removed.
  for (const block of Array.isArray(snapshot?.meta?.pdfBlocks) ? snapshot.meta.pdfBlocks : []) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.src === "string" && isPackableImageRef(block.src)) into.add(block.src);
    scan(block.md);
  }
  return into;
}

// A `<img src="…&amp;x=1">` in stored HTML holds entity-escaped text; the fetch
// (and the later find-and-replace) both need the real url.
export function decodeImageRefEntities(ref) {
  return String(ref).replace(/&amp;/gi, "&").trim();
}

// The bytes behind one reference, or null if they can't be reached. Tries the
// offline image cache before the network: it holds exactly what the app renders,
// costs nothing, and means a backup taken offline still carries its pictures.
//
// `onSource`, when given, is told where the bytes came from — "device" (the
// offline outbox), "cache" or "network" — which is what the job console shows
// against each image, because "downloading from storage" is the answer to "why
// is this taking so long" for a library whose figures were never opened here.
export async function readBackupAssetBlob(ref, onSource = null) {
  if (ref.startsWith(LOCAL_IMAGE_SCHEME)) {
    try {
      const entry = await getOutboxImage(ref.slice(LOCAL_IMAGE_SCHEME.length));
      if (entry?.blob) onSource?.("device");
      return entry?.blob || null;
    } catch {
      return null;
    }
  }
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(OFFLINE_IMAGE_CACHE);
      // ignoreVary: entries written by the service worker come from a CORS
      // fetch, and Supabase Storage answers those with `Vary: Origin` — without
      // this, a lookup keyed by the bare URL would miss every one of them.
      const hit = await cache.match(ref, { ignoreVary: true });
      if (hit && hit.ok) {
        const blob = await hit.blob();
        if (blob.size) {
          onSource?.("cache");
          return blob;
        }
      }
    }
  } catch (error) {
    console.warn("Could not read a cached image for the backup", ref, error);
  }
  // Retried ONLY for images we host. withRetry replays anything
  // isTransientCloudError matches, and a CORS refusal reaches JS as a bare
  // `TypeError: Failed to fetch` — indistinguishable from a dropped
  // connection, and matched by that same test. For a third-party host that
  // sends no Access-Control-Allow-Origin, every replay fails identically, so
  // retrying there only doubles the requests and the time to finish a backup
  // (a library with hundreds of pasted external links pays that twice over).
  // Our own Storage objects are worth a second attempt: a cache-miss image
  // evicted from recall-images-v1 (see the SW's IMAGE_CACHE_LIMIT) otherwise
  // gets exactly one shot at the network before being called missing.
  try {
    onSource?.("network");
    return isSupabaseStorageRef(ref)
      ? await withRetry(() => fetchBackupAssetOverNetwork(ref), { label: "backup asset" })
      : await fetchBackupAssetOverNetwork(ref);
  } catch (error) {
    // Logged (not surfaced in the UI, which only shows a count) so a run with
    // devtools open can tell a dead link (HTTP 404/403) apart from a timeout
    // or a CORS refusal — the three collapse to the same "could not be
    // reached" message otherwise, which is enough to know something failed
    // but not enough to know what to do about it.
    console.warn(`Backup: image unreachable — ${ref}`, error?.message || error);
    return null;
  }
}

// One network attempt for a backup asset. Throws on any failure so withRetry
// can tell a transient one (worth replaying) from a real one (a 404, a CORS
// refusal from a non-Supabase host) — see readBackupAssetBlob.
async function fetchBackupAssetOverNetwork(ref) {
  // A host that accepts the connection and then never answers would otherwise
  // park one of the fetch workers forever, and the whole backup with it — the
  // failure mode that looks exactly like the app having frozen.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), BACKUP_ASSET_FETCH_TIMEOUT_MS);
  try {
    // The images bucket is private, so the canonical `/object/public/…` URL a
    // note holds is an identifier, not an address — fetched as-is it answers
    // 400. That made a backup taken on a device which had only ever SYNCED its
    // decks pack no images at all: the cache lookup above misses (nothing was
    // ever fetched here) and this fetch fails for every hosted picture, which
    // reads as "the image is missing" when it is sitting in the bucket. A no-op
    // for a third-party link, so the CORS reasoning below is unchanged.
    const fetchRef = await fetchableStorageUrl(ref);
    // Storage serves public objects with permissive CORS; a third-party host
    // (an old ImgBB/Drive link) may not, in which case this throws and the
    // image is reported as missing rather than failing the backup.
    const response = await fetch(fetchRef, { mode: "cors", credentials: "omit", signal: abort.signal });
    if (!response.ok) throw new Error(`Backup asset fetch failed: HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("Backup asset fetch returned an empty body");
    return blob;
  } finally {
    clearTimeout(timer);
  }
}

export const BACKUP_ASSET_EXT_BY_TYPE = {
  "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png",
  "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp"
};

// ── The archive mirrors the library's own shape ────────────────────────────
// A flat `decks/*.json` bag is fine for a machine and useless for a person: a
// 200-deck backup was an unbrowsable wall of files, with no sign of the folder
// tree those decks actually live in. Deck files are now written under their
// folder path, and every image is filed beside the deck that uses it, in a
// folder named the same way the Storage bucket names it:
//
//   decks/Science/Cell Biology/Mitosis-a1b2c3.json
//   assets/Mitosis--a1b2c3/0001-spindle.webp
//
// This is also what lets an UNSTRUCTURED archive come back organised: restore
// reads the folder path back out of the zip when a deck file carries no
// category of its own (backupCategoryFromArchivePath), so a hand-made zip of
// deck files in folders lands in exactly those folders here.
// One path segment, safe in a zip and still readable — slugifyFileName keeps
// spaces and capitals (unlike storageFolderSlug) and only strips what a
// filesystem would choke on, so `Science/Chapter 1` survives the round trip
// exactly as typed.
export function backupPathSegment(value, fallback) {
  return slugifyFileName(String(value || "").trim(), fallback).replace(/^\.+/, "").trim() || fallback;
}

// `decks/<folder path>/` for one deck, honouring the deck's category tree.
export function backupDeckFolderPath(category) {
  const segments = folderSegments(normalizeDeckCategory(category)).map((segment) => backupPathSegment(segment, "Folder"));
  return [BACKUP_DECK_DIR, ...segments].join("/");
}

// The deck's own asset folder, named exactly the way its Storage bucket folder
// is (`<slug>--<id>`), so what you see in the zip matches what you see in the
// bucket.
export function backupAssetFolderPath(title, id) {
  return `${BACKUP_ASSET_DIR}/${backupPathSegment(title, "Deck")}--${id}`;
}

// Read a deck's folder path back out of the archive: everything between the
// `decks/` root (wherever it sits — some zip tools nest the whole archive one
// level deeper) and the file itself. Returns "" when the file is at the root,
// which leaves the deck's own category (or the default) in charge.
export function backupCategoryFromArchivePath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  parts.pop(); // the file itself
  const root = parts.findIndex((part) => part.toLowerCase() === BACKUP_DECK_DIR);
  const folders = root >= 0 ? parts.slice(root + 1) : parts;
  return folderSegments(folders.join(FOLDER_SEP)).join(FOLDER_SEP);
}

// A readable, unique filename for one packed image. The original basename is
// kept where there is one (a book figure stays recognisable inside the zip),
// behind an index that guarantees uniqueness without a second pass.
export function backupAssetName(ref, blob, index, usedNames) {
  const fromUrl = ref.startsWith(LOCAL_IMAGE_SCHEME)
    ? "queued-image"
    : decodeURIComponent((ref.split("?")[0].split("#")[0].split("/").pop() || "image"));
  const stem = slugifyFileName(fromUrl.replace(/\.[^.]+$/, ""), "image") || "image";
  const ext = BACKUP_ASSET_EXT_BY_TYPE[blob.type]
    || (/\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(ref)?.[1] || "img").toLowerCase();
  let name = `${String(index + 1).padStart(4, "0")}-${stem}.${ext}`;
  let n = 2;
  while (usedNames.has(name)) name = `${String(index + 1).padStart(4, "0")}-${stem}-${n++}.${ext}`;
  usedNames.add(name);
  return name;
}

// Pack every image the decks reference into `assets/<deck>--<id>/`, writing the
// reference→file index alongside. `entries` is one {snapshot, assetFolder} per
// deck, in library order, so each image lands in the folder of the first deck
// that uses it (a picture shared by two decks is stored once, not twice).
// Best-effort per image: one unreachable url is recorded in the index's
// `missing` list (so a restore can say what it couldn't bring) and never aborts
// the backup.
//
// `onItem`, when given, hears about every image as it lands: `{ ref, source,
// bytes, missing }`. The job console turns that into its log.
export async function packBackupAssets(zip, entries, onProgress, isCancelled = () => false, onItem = null) {
  const folderByRef = new Map();
  entries.forEach((entry) => {
    for (const ref of collectBackupImageRefs(entry.snapshot)) {
      if (!folderByRef.has(ref)) folderByRef.set(ref, entry.assetFolder);
    }
  });
  const refs = Array.from(folderByRef.keys());
  // The SAME four keys the full path returns. This shortcut kept the two-key
  // shape it was written with, and splitting `missing` into missingHosted /
  // missingExternal later only updated the other return — so a library with no
  // images at all handed the caller a result with two undefined arrays. The
  // caller reads `.length` off both, unconditionally, at the very end: the
  // archive was built, compressed and downloaded, and then the run threw
  // "Cannot read properties of undefined (reading 'length')" while writing the
  // summary. A backup that had entirely succeeded reported itself as failed.
  // `indexBytes: 0` says "no index file was written", which the caller needs in
  // order not to record one in the manifest's inventory. It did exactly that,
  // and an archive from a library with no images then failed its own
  // verification for a file nobody had ever written.
  if (!refs.length) return { assets: [], missing: [], missingHosted: [], missingExternal: [], missingQueued: [], indexBytes: 0, indexJson: "" };

  let done = 0;
  onProgress?.(0, refs.length);
  // A handful at a time: these are mostly cache hits, and the ones that aren't
  // are latency-bound, but an unbounded fan-out over a few hundred images would
  // stall the browser's connection pool.
  const blobs = await mapWithConcurrency(refs, 5, async (ref) => {
    if (isCancelled()) return null;
    let source = "";
    const blob = await readBackupAssetBlob(ref, (where) => { source = where; });
    done += 1;
    onItem?.({ ref, source, bytes: blob ? blob.size : 0, missing: !blob, index: done, total: refs.length });
    onProgress?.(done, refs.length);
    return blob;
  });

  // Names are unique per folder, so two decks can both hold a `0001-fig.webp`.
  const usedNames = new Map();
  const assets = [];
  const missing = [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const blob = blobs[i];
    if (!blob) {
      missing.push(ref);
      continue;
    }
    const folder = folderByRef.get(ref) || BACKUP_ASSET_DIR;
    if (!usedNames.has(folder)) usedNames.set(folder, new Set());
    const names = usedNames.get(folder);
    const name = backupAssetName(ref, blob, names.size, names);
    const path = `${folder}/${name}`;
    // Stored: an image is already compressed.
    zip.file(path, blob, { compression: "STORE" });
    assets.push({
      file: path,
      url: ref,
      type: blob.type || "application/octet-stream",
      bytes: blob.size,
      // Hashed here, where the bytes are in hand, so the manifest can say what
      // each file should be and a restore can tell a damaged one from a whole
      // one without taking the archive's word for it.
      sha256: await sha256(blob)
    });
  }

  const indexJson = `${JSON.stringify({
    schema: BACKUP_ASSET_SCHEMA,
    version: 1,
    note: "Maps each image reference used in decks/**.json to its packed file. "
      + "Files are grouped per deck, named the way that deck's Storage folder is. "
      + "Restore re-homes these into the restoring device's own storage.",
    assets,
    missing,
    // Split so a restore (and the person reading this file) can tell the two
    // apart: `missingHosted` are OUR uploads whose Storage object is gone —
    // a real hole in the archive. `missingExternal` are third-party links the
    // browser is not allowed to read (no CORS header) or that 404 at source;
    // the deck text still carries the link, so those images keep working
    // wherever the original host is reachable.
    missingHosted: missing.filter(isSupabaseStorageRef),
    missingExternal: missing.filter((ref) => !isSupabaseStorageRef(ref) && !ref.startsWith(LOCAL_IMAGE_SCHEME)),
    missingQueued: missing.filter((ref) => ref.startsWith(LOCAL_IMAGE_SCHEME))
  }, null, 2)}\n`;
  zip.file(BACKUP_ASSET_INDEX, indexJson, { compression: "DEFLATE" });
  return {
    assets,
    missing,
    missingHosted: missing.filter(isSupabaseStorageRef),
    missingExternal: missing.filter((ref) => !isSupabaseStorageRef(ref) && !ref.startsWith(LOCAL_IMAGE_SCHEME)),
    // A picture pasted offline on ANOTHER device and never uploaded from it:
    // its placeholder synced here, its bytes never did. Not a website refusing
    // a download, which is what it used to be reported as.
    missingQueued: missing.filter((ref) => ref.startsWith(LOCAL_IMAGE_SCHEME)),
    // BYTES, not characters. This was `indexJson.length`, which counts UTF-16
    // units — so an index naming one figure called "Größe.png" declared itself
    // shorter than it is, and the restore called the archive damaged.
    indexBytes: utf8Bytes(indexJson).length,
    indexJson
  };
}


// ── The zip implementation ────────────────────────────────────────────────
//
// For READING an archive: this app's own reader (src/backup/zip-lite.js), which
// reads a File lazily and checks every member's CRC — and JSZip only on the
// browser that cannot inflate a deflated member itself. For WRITING: always the
// app's own writer, because it is the one that can say what it is doing (see
// that file) and it never waits on a CDN. The old code waited for JSZip first,
// in silence, on the one click that most needs to feel alive.
export async function backupZipFactory() {
  if (canInflate()) return LiteZip;
  if (await ensureJsZip()) return window.JSZip;
  return LiteZip;
}

// ── Reading the decks ─────────────────────────────────────────────────────

// Every deck in the selection (the whole library when there is none), each
// paired with the SELECTION it came from.
//
// The selection was thrown away before, and the deck payload does not carry a
// local id — but the local id is the key to two of the largest things a deck
// owns. The document store is keyed by it (src/documents/pdf-store.js), and so
// is the reading position (currentDeckKey).
//
// A deck that cannot be read is no longer dropped with a console.warn: it is
// returned in `skipped`, and the package's manifest and the finished panel both
// name it. A backup that says "40 decks" when the library holds 42 has lied.
export async function collectBackupPayloads(progress = null, selections = null) {
  let chosen = selections;
  if (!chosen) {
    const stop = progress?.wait?.("Listing your decks (and asking the cloud for any stored only there)") || (() => {});
    try {
      chosen = await raceCancel(allMyDeckSelections(), progress);
      stop(`Found ${chosen.length} deck${chosen.length === 1 ? "" : "s"}`);
    } catch (error) {
      stop();
      if (error?.message === "CANCELLED") return { payloads: [], skipped: [] };
      throw error;
    }
  }
  const payloads = [];
  const skipped = [];
  for (let i = 0; i < chosen.length; i += 1) {
    if (progress?.cancelled()) break;
    const sel = chosen[i];
    progress?.current?.(`Reading deck ${i + 1} of ${chosen.length}…`);
    try {
      const payload = await myDeckPayload(sel);
      payloads.push({ selection: sel, payload });
      progress?.log?.(`Read "${payload.deck.title || "Untitled"}" — ${describeDeckPayload(payload)}`);
    } catch (error) {
      const label = sel?.localId || sel?.deckId || "a deck";
      skipped.push({ localId: sel?.localId || null, deckId: sel?.deckId || null, reason: String(error?.message || error || "unreadable") });
      progress?.warn?.(`Could not read ${label}: ${error?.message || error}`);
      console.warn("Skipping unavailable deck in backup", sel, error);
    }
    progress?.count?.(i + 1, chosen.length, `Reading decks ${i + 1}/${chosen.length}…`);
    progress?.setStat("decks", payloads.length);
    // One deck per turn of the event loop. A book-sized deck is a lot of JSON,
    // and a library of them read back to back was the freeze.
    await yieldToPage();
  }
  // The old callers took the bare list. Kept as an array with the extra facts
  // hung off it, so they still can.
  const out = payloads;
  out.skipped = skipped;
  out.payloads = payloads;
  return out;
}

// "12 cards · notes 4 KB · 2 PDFs · 180 highlights" — what the log says about
// each deck as it is read, so a slow one can be told apart from a stuck one.
export function describeDeckPayload(payload) {
  const meta = payload?.deck?.meta || {};
  const bits = [];
  const cards = payload?.cards?.length || 0;
  bits.push(`${cards} card${cards === 1 ? "" : "s"}`);
  const notes = String(payload?.deck?.notes || "");
  if (notes.trim()) bits.push(`notes ${formatJobBytes(notes.length)}`);
  const papers = (Array.isArray(meta.pdfs) && meta.pdfs.length) ? meta.pdfs.length : (meta.pdf ? 1 : 0);
  if (papers) bits.push(`${papers} PDF${papers === 1 ? "" : "s"}`);
  if (meta.notebook) bits.push("notebook");
  const marks = Array.isArray(meta.pdfHighlights) ? meta.pdfHighlights : [];
  const ink = marks.filter((record) => record?.kind === "ink").length;
  if (marks.length - ink) bits.push(`${marks.length - ink} highlight${marks.length - ink === 1 ? "" : "s"}`);
  if (ink) bits.push(`${ink} ink mark${ink === 1 ? "" : "s"}`);
  const blocks = Array.isArray(meta.pdfBlocks) ? meta.pdfBlocks.length : 0;
  if (blocks) bits.push(`${blocks} block${blocks === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

// ── What a deck travels as ────────────────────────────────────────────────

// The cloud id a deck really has, or null. A deck that has never synced reads
// back with its LOCAL id in the payload's `id` slot (localDeckPayload), and an
// archive that recorded that as the deck's cloud id restored a deck claiming to
// be a cloud row that never existed.
export function realDeckIdFor(selection, payload) {
  if (selection?.deckId) return String(selection.deckId);
  const id = String(payload?.deck?.id || "");
  if (!id || (selection?.localId && id === String(selection.localId))) return null;
  return id;
}

// The identity a deck travels under in a package — what a recipient matches a
// second copy of the same package against. A deck that was itself imported
// keeps the identity it arrived with, so a deck passed along from one person to
// the next is still recognised as the same deck at the end of the chain.
export function packageOriginFor(selection, payload) {
  const imported = payload?.deck?.meta?.importedFrom;
  if (imported && typeof imported === "object" && imported.origin) return String(imported.origin);
  return realDeckIdFor(selection, payload) || String(selection?.localId || payload?.deck?.id || "");
}

// Every id a deck answers to, so an importer can rewrite [[links]] that name it.
export function packageIdsFor(selection, payload) {
  const ids = new Set();
  const deckId = realDeckIdFor(selection, payload);
  if (deckId) ids.add(deckId);
  if (selection?.localId) ids.add(String(selection.localId));
  if (payload?.deck?.id) ids.add(String(payload.deck.id));
  for (const id of Array.isArray(payload?.deck?.meta?.linkIds) ? payload.deck.meta.linkIds : []) {
    if (id) ids.add(String(id));
  }
  return Array.from(ids);
}

// Anchors a quick note was pinned from that have not been written into the
// deck's meta yet (they are queued, see src/quick-notes/anchors.js). Folded in
// so an offline pin is not the one thing a backup cannot see. The key is named
// here rather than imported: that module pulls in the whole quick-notes board.
const PENDING_QUICK_NOTE_ANCHORS_KEY = "recall:pendingQuickNoteAnchors";

function pendingQuickNoteAnchorPatch() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_QUICK_NOTE_ANCHORS_KEY) || "null");
    return raw && raw.patch && typeof raw.patch === "object" ? raw.patch : null;
  } catch {
    return null;
  }
}

// One deck, as the file in decks/ holds it.
export function packageDeckSnapshot(selection, payload, { kind = PACKAGE_KIND_LIBRARY, includeProgress = true } = {}) {
  const snapshot = deckPayloadSnapshot(payload);
  snapshot.deckId = realDeckIdFor(selection, payload);
  const meta = { ...(snapshot.meta || {}) };
  const patch = Array.isArray(meta.quickNoteCategories) || meta.noteAnchors ? pendingQuickNoteAnchorPatch() : null;
  if (patch) meta.noteAnchors = { ...(meta.noteAnchors || {}), ...patch };
  snapshot.meta = kind === PACKAGE_KIND_SHARE ? shareMetaBag(meta, { includeProgress }) : meta;
  if (!includeProgress) {
    snapshot.current = 0;
    snapshot.cards = snapshot.cards.map((card) => ({ ...card, status: null }));
  }
  return snapshot;
}

// ── Writing a package ─────────────────────────────────────────────────────

export const PACKAGE_STEPS = [
  ["scan", "Find decks"],
  ["decks", "Read decks"],
  ["images", "Pack images"],
  ["papers", "Pack papers"],
  ["library", "Library & settings"],
  ["write", "Write the file"],
  ["verify", "Verify"],
  ["save", "Save"]
];

// The one writer. A whole-library backup and a share of three decks are the
// same file with different contents, so they are the same function with
// different arguments:
//
//   selections        which decks (null = every deck My Decks shows)
//   kind              "library" | "share"
//   includeProgress   card statuses, bookmarks, reading positions
//   includeImages     pack every picture the decks show
//   includeDocuments  pack every PDF and notebook
//   includeSettings   carry this device's preferences (library only)
//   deliver           "download" (default) or "none" — return the blob only
//
// Returns { ok, blob, name, manifest } — ok false on an empty selection, a
// cancel, or a failure the panel has already explained.
export async function writeRecallPackage({
  selections = null,
  kind = PACKAGE_KIND_LIBRARY,
  includeProgress = kind !== PACKAGE_KIND_SHARE,
  includeImages = true,
  includeDocuments = true,
  includeSettings = kind === PACKAGE_KIND_LIBRARY,
  fileBaseName = "",
  title = "",
  progress = null,
  autoClosePanel = false,
  historyKind = "manual",
  deliver = "download"
} = {}) {
  const isShare = kind === PACKAGE_KIND_SHARE;
  const noun = isShare ? "package" : "backup";
  const bail = (message) => {
    progress?.close();
    setStatus(message);
    return { ok: false };
  };

  progress?.step?.("scan", selections ? `Preparing ${selections.length} deck${selections.length === 1 ? "" : "s"}…` : "Finding your decks…");
  const collected = await collectBackupPayloads(progress, selections);
  const payloads = collected.payloads || collected;
  const skipped = collected.skipped || [];
  if (progress?.cancelled()) return bail(`${isShare ? "Share" : "Backup"} cancelled.`);
  progress?.stepDone?.("scan", `${payloads.length + skipped.length} deck${payloads.length + skipped.length === 1 ? "" : "s"}`);
  if (!payloads.length) {
    // An empty library is a failed BACKUP — the user pressed a button and no
    // file arrived, so say so. It is not a failed SAFETY STEP: there, having
    // nothing to protect is the successful outcome, and reporting it in red
    // over the job that is still running (see applyRestore) reads as the
    // restore itself having gone wrong.
    if (autoClosePanel) {
      progress?.close();
      return { ok: false };
    }
    const message = skipped.length ? `None of the ${skipped.length} decks could be read.` : "No decks to back up.";
    setStatus(message, "error");
    progress?.finish(message, { warning: skipped.length ? "Cloud-only decks need a connection." : "This device has no decks saved yet.", failed: true });
    return { ok: false };
  }

  const zip = new LiteZip();
  const now = new Date();
  const packageId = newPackageId();
  const manifestDecks = [];
  const usedPaths = new Set();
  const entries = [];
  const folders = new Set();
  // Every file written, in write order, with its size AND its hash — the
  // inventory verifyBackupArchive checks a zip against on the way back in.
  // Recorded as the archive is built rather than derived from it afterwards,
  // so it describes what this run MEANT to write: an entry that never made it
  // into the zip is exactly the thing worth catching.
  //
  // `bytes` is a byte count. It was a JS string's `.length` — UTF-16 units — so
  // every deck with an em-dash, a curly quote, an umlaut or an equation
  // declared itself shorter than it was, and restore called the archive
  // damaged. That warning was on nearly every real library's restore.
  const contents = [];
  const recordText = async (file, text) => {
    const bytes = utf8Bytes(text);
    contents.push({ file, bytes: bytes.length, sha256: await sha256(new Blob([bytes])) });
  };
  const addText = async (file, text) => {
    zip.file(file, text, { compression: "DEFLATE" });
    await recordText(file, text);
  };

  progress?.step?.("decks", "Packing decks…");
  let cardTotal = 0;
  for (let i = 0; i < payloads.length; i += 1) {
    if (progress?.cancelled()) return bail(`${isShare ? "Share" : "Backup"} cancelled.`);
    const { selection, payload } = payloads[i];
    const snapshot = packageDeckSnapshot(selection, payload, { kind, includeProgress });
    const idPart = String(payload.deck.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16)
      || Math.random().toString(36).slice(2, 8);
    // Filed under the deck's own folder path, so unzipping the backup gives you
    // the same tree you see in My Decks.
    const category = normalizeDeckCategory(payload.deck.category);
    const dir = backupDeckFolderPath(category);
    folders.add(category);
    const base = `${backupPathSegment(payload.deck.title, "Deck")}-${idPart}`;
    let path = `${dir}/${base}.json`;
    let n = 2;
    while (usedPaths.has(path)) path = `${dir}/${base}-${n++}.json`;
    usedPaths.add(path);
    const deckJson = `${JSON.stringify(snapshot, null, 2)}\n`;
    await addText(path, deckJson);
    cardTotal += payload.cards.length;
    const pathSegment = backupPathSegment(payload.deck.title, "Deck");
    entries.push({
      snapshot,
      assetFolder: backupAssetFolderPath(payload.deck.title, idPart),
      // Carried for the documents pass, which needs all four: the local id to
      // read the bytes by, the archive path to bind the file back to this deck
      // on restore, and the title and id part to name its folder the same way
      // the asset folder and the Storage folder are named.
      deckFile: path,
      localId: selection?.localId || null,
      deckId: snapshot.deckId || null,
      title: payload.deck.title || "Untitled deck",
      pathSegment,
      idPart
    });
    manifestDecks.push({
      file: path,
      deckId: snapshot.deckId || null,
      // The local id on the device that WROTE the archive. Restoring your own
      // backup onto your own machine, this is what lets the document bytes
      // already on disk be re-keyed onto the restored deck instead of unpacked
      // again — see planBackupDocumentRestore.
      localId: selection?.localId || null,
      // What a recipient recognises this deck by the second time it arrives,
      // and every id [[links]] in the other decks might name it by.
      origin: packageOriginFor(selection, payload),
      ids: packageIdsFor(selection, payload),
      title: payload.deck.title || "Untitled deck",
      category: payload.deck.category || "",
      cardCount: payload.cards.length,
      hasNotes: Boolean(String(payload.deck.notes || "").trim()),
      updatedAt: payload.deck.updated_at || null,
      bytes: utf8Bytes(deckJson).length
    });
    progress?.count?.(i + 1, payloads.length, `Packing decks ${i + 1}/${payloads.length}…`);
    progress?.current?.(`${payload.deck.title || "Untitled"} · ${formatJobBytes(deckJson.length)}`);
    progress?.setStat("cards", cardTotal);
    await yieldToPage();
  }
  progress?.stepDone?.("decks", `${payloads.length} deck${payloads.length === 1 ? "" : "s"}, ${cardTotal} cards`);

  const deckLabel = `${payloads.length} deck${payloads.length === 1 ? "" : "s"}`;
  let packed = { assets: [], missing: [], missingHosted: [], missingExternal: [], missingQueued: [], indexBytes: 0, indexJson: "" };
  if (includeImages) {
    progress?.step?.("images", "Looking for images…");
    const sourceLabel = { device: "from this device", cache: "from the offline cache", network: "downloaded from storage" };
    packed = await packBackupAssets(zip, entries, (done, total) => {
      // The slow phase, and the one people most need to see moving: each image
      // is read from the offline cache or fetched back from storage.
      setStatus(`Packing images ${done}/${total}…`);
      progress?.count?.(done, total, `Packing images ${done}/${total}…`);
      progress?.setStat("images", done);
    }, () => Boolean(progress?.cancelled()), ({ ref, source, bytes, missing, index, total }) => {
      const name = shortImageName(ref);
      if (missing) {
        const why = ref.startsWith(LOCAL_IMAGE_SCHEME)
          ? " (pasted on another device and never uploaded from it)"
          : isSupabaseStorageRef(ref) ? " (missing from your storage)" : " (the site does not allow downloading)";
        progress?.warn?.(`Image ${index}/${total} could not be read: ${name}${why}`);
      } else {
        progress?.current?.(`Image ${index}/${total} · ${name} · ${formatJobBytes(bytes)} · ${sourceLabel[source] || ""}`);
        if (source === "network" || total <= 200) progress?.log?.(`Image ${index}/${total} · ${name} · ${formatJobBytes(bytes)} · ${sourceLabel[source] || ""}`);
      }
    });
    if (progress?.cancelled()) return bail(`${isShare ? "Share" : "Backup"} cancelled.`);
    progress?.setStat("images", packed.assets.length);
    packed.assets.forEach((asset) => contents.push({ file: asset.file, bytes: asset.bytes, sha256: asset.sha256 || "" }));
    if (packed.indexJson) await recordText(BACKUP_ASSET_INDEX, packed.indexJson);
    progress?.stepDone?.("images", packed.assets.length || packed.missing.length
      ? `${packed.assets.length} packed${packed.missing.length ? `, ${packed.missing.length} unreachable` : ""}`
      : "none");
  } else {
    progress?.stepSkipped?.("images", "left out");
  }

  // The papers themselves. This is the half a backup never had: the deck JSON
  // has always carried meta.pdf and every highlight measured against that file,
  // and the file lived only in an IndexedDB store on one device and a PRIVATE
  // bucket in one Supabase project. See src/backup/documents.js.
  let documents = { documents: [], missing: [], bytes: 0, indexJson: "" };
  if (includeDocuments) {
    progress?.step?.("papers", "Looking for papers…");
    let paperBytes = 0;
    documents = await packBackupDocuments(zip, entries, (done, total) => {
      setStatus(`Packing papers ${done}/${total}…`);
      progress?.count?.(done, total, `Packing papers ${done}/${total}…`);
      progress?.setStat("papers", done);
    }, () => Boolean(progress?.cancelled()), (item) => {
      const label = `Paper ${item.index}/${item.total} · ${item.name}${item.bytes ? ` · ${formatJobBytes(item.bytes)}` : ""}`;
      if (item.phase === "packed") {
        paperBytes += item.bytes || 0;
        progress?.setStat("size", formatJobBytes(paperBytes));
        progress?.log?.(`${label} · from ${item.source === "device" ? "this device" : "your storage"} (${item.deckTitle})`);
      } else if (item.phase === "missing") {
        progress?.warn?.(`${label} could not be read (${item.deckTitle}) — ${item.reason === DOCUMENT_MISSING_OFFLOADED ? "removed from the cloud and not on this device" : "not on this device and not reachable"}`);
      } else {
        progress?.current?.(`${label} · ${item.phase === "downloading" ? "downloading from your storage…" : item.phase === "hashing" ? "checking…" : "reading…"}`);
      }
    });
    if (progress?.cancelled()) return bail(`${isShare ? "Share" : "Backup"} cancelled.`);
    progress?.setStat("papers", documents.documents.length);
    documents.documents.forEach((doc) => contents.push({ file: doc.file, bytes: doc.bytes, sha256: doc.sha256 || "" }));
    if (documents.indexJson) await recordText(BACKUP_DOCUMENT_INDEX, documents.indexJson);
    progress?.stepDone?.("papers", documents.documents.length || documents.missing.length
      ? `${documents.documents.length} packed (${formatJobBytes(documents.bytes)})${documents.missing.length ? `, ${documents.missing.length} missing` : ""}`
      : "none");
  } else {
    progress?.stepSkipped?.("papers", "left out");
  }

  // Folders that hold no decks, which folds are open, and where you were in each
  // note. None of it is deck data, all of it is the difference between "my
  // library is back" and "my app is back" — see src/backup/library-state.js.
  // A SHARE carries none of it: it is the sender's device, not their decks.
  progress?.step?.("library", isShare ? "Finishing the package…" : "Saving folders, reading positions and settings…");
  let libraryState = null;
  if (!isShare) {
    libraryState = collectBackupLibraryState();
    await addText(BACKUP_LIBRARY_FILE, `${JSON.stringify(libraryState, null, 2)}\n`);
    progress?.log?.(`Library: ${libraryState.folders.known.length} folder${libraryState.folders.known.length === 1 ? "" : "s"}, ${libraryState.readingPositions.length} reading position${libraryState.readingPositions.length === 1 ? "" : "s"}`);
  }
  if (!isShare && includeSettings) {
    const settings = collectBackupSettings();
    await addText(BACKUP_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
    progress?.log?.(`Settings: ${Object.keys(settings.values).length} preference${Object.keys(settings.values).length === 1 ? "" : "s"}`);
  }
  progress?.stepDone?.("library", isShare ? "not part of a share" : "");

  const manifest = buildBackupManifest({
    exportedAt: now.toISOString(),
    // Which build wrote this. Blank in an unstamped checkout, which is honest
    // rather than a placeholder pretending to be a commit.
    build: IS_DEV_BUILD ? "" : BUILD_STAMP,
    decks: manifestDecks,
    assets: packed.assets,
    assetsMissing: packed.missing.length,
    documents: documents.documents,
    documentsMissing: documents.missing.length,
    // The folder tree these decks came from, PLUS the ones holding no decks at
    // all — a folder is a deck's category prefix, so an empty one exists nowhere
    // else and this is its only record.
    folders: [...folders, ...(libraryState ? libraryState.folders.known : [])],
    contents,
    kind,
    packageId,
    includesProgress: includeProgress,
    skipped,
    title
  });
  zip.file(BACKUP_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, { compression: "DEFLATE" });
  zip.file("README.txt", packageReadme({ now, isShare, title, payloads, folders, packed, documents }), { compression: "DEFLATE" });

  // ── Write ──
  progress?.step?.("write", "Writing the file…");
  setStatus(`Writing ${noun} (${deckLabel}${packed.assets.length ? `, ${packed.assets.length} images` : ""}${documents.documents.length ? `, ${documents.documents.length} papers` : ""})…`);
  let blob;
  try {
    blob = await zip.generateAsync({
      type: "blob",
      mimeType: PACKAGE_MIME,
      isCancelled: () => Boolean(progress?.cancelled())
    }, (meta) => {
      progress?.update?.(`Writing the file… ${Math.floor(meta.percent)}%`, meta.percent / 100);
      if (meta.currentFile) {
        progress?.current?.(`File ${meta.fileIndex + 1} of ${meta.fileCount} · ${meta.currentFile} · ${formatJobBytes(meta.bytesDone)} of ${formatJobBytes(meta.bytesTotal)}`);
      }
    });
  } catch (error) {
    if (error?.message === "CANCELLED") return bail(`${isShare ? "Share" : "Backup"} cancelled.`);
    throw error;
  }
  progress?.setStat("size", formatJobBytes(blob.size));
  progress?.stepDone?.("write", formatJobBytes(blob.size));

  // ── Verify ──
  // Read the file just written back through the reader a restore will use, and
  // hold it to the inventory. Only the archive's index is read — seconds for a
  // library of papers — and it is the difference between "Saved" and "Saved,
  // and every one of these 412 files is in it at the size it should be".
  progress?.step?.("verify", "Checking the file…");
  const verification = await verifyWrittenPackage(blob, manifest);
  if (!verification.ok) {
    progress?.error?.(`The written file does not match what was packed: ${verification.problem}`);
    progress?.finish(`The ${noun} could not be verified.`, { warning: verification.problem, failed: true });
    setStatus(`${isShare ? "Share" : "Backup"} failed its own check: ${verification.problem}`, "error");
    showToast(`${isShare ? "Share" : "Backup"} failed`, "error");
    return { ok: false };
  }
  progress?.log?.(`Verified ${verification.files} files against the package's own index.`);
  progress?.stepDone?.("verify", `${verification.files} files`);

  // ── Save ──
  const name = `${fileBaseName || (isShare ? `recall-${packageFileSlug(title || payloads[0]?.payload?.deck?.title)}-${backupTimestamp(now)}` : `recall-backup-${backupTimestamp(now)}`)}${PACKAGE_EXT}`;
  progress?.step?.("save", "Saving…");
  if (deliver === "download") downloadBlob(blob, name);
  progress?.log?.(`Saved ${name} (${formatJobBytes(blob.size)}).`);
  progress?.stepDone?.("save");
  // Recorded once the file has actually been handed over, so the "last backup"
  // line and the reminder that reads it can never describe an archive that was
  // never written. A share is not a backup — it moves nothing.
  if (!isShare) {
    recordBackup({
      decks: payloads.length,
      cards: cardTotal,
      documents: documents.documents.length,
      bytes: blob.size,
      name,
      kind: historyKind
    });
  }

  const imageNote = packed.assets.length
    ? ` with ${packed.assets.length} image${packed.assets.length === 1 ? "" : "s"}`
    : "";
  const paperNoteShort = documents.documents.length
    ? ` and ${documents.documents.length} paper${documents.documents.length === 1 ? "" : "s"}`
    : "";
  // Reported as two different things, because they mean two different things
  // and only one is a problem with YOUR library. An external link the browser
  // is refused (no CORS header on someone else's server) is the normal state
  // of a pasted web image and says nothing about the archive's integrity — the
  // note keeps the link. A missing upload of ours is a genuine gap.
  const hosted = packed.missingHosted.length;
  const external = packed.missingExternal.length;
  const plural = (count, one, many) => (count === 1 ? one : many);
  const hostedNote = hosted
    ? ` ${hosted} of your uploaded image${plural(hosted, " is", "s are")} missing from storage.`
    : "";
  const externalNote = external
    ? ` ${external} web link${plural(external, "", "s")} couldn't be downloaded (the site blocks it) — the link${plural(external, " is", "s are")} still in your notes.`
    : "";
  // A paper that could not be read is its own kind of gap, and a louder one than
  // a missing figure. Named deck by deck, because "1 paper missing" out of forty
  // is a question about WHICH.
  const missingPapers = documents.missing;
  const warnings = [];
  if (skipped.length) {
    warnings.push(`${skipped.length} deck${plural(skipped.length, "", "s")} could not be read and ${plural(skipped.length, "is", "are")} not in this ${noun}`
      + " (cloud-only decks need a connection). The Activity log names them.");
  }
  if (missingPapers.length) {
    warnings.push(`${missingPapers.length} paper${plural(missingPapers.length, "", "s")} could not be read and ${plural(missingPapers.length, "is", "are")} not in this ${noun}: `
      + `${missingPapers.slice(0, 5).map((entry) => entry.deckTitle).join(", ")}`
      + `${missingPapers.length > 5 ? `, and ${missingPapers.length - 5} more` : ""}. `
      + "Their highlights and notes are here; the files themselves are not, so those decks will ask for the PDF to be re-attached.");
  }
  if (hosted) {
    warnings.push(
      `${hosted} image${plural(hosted, "", "s")} you uploaded ${plural(hosted, "is", "are")} no longer in your storage, so ${plural(hosted, "it", "they")} could not be packed. `
      + "Use More → Check for broken images to see which decks they're in."
    );
  }
  const queued = (packed.missingQueued || []).length;
  if (queued) {
    warnings.push(
      `${queued} image${plural(queued, " was", "s were")} pasted on another device while offline and never uploaded from it, so ${plural(queued, "it is", "they are")} not here to pack. `
      + "Open the app on that device while online and back up again."
    );
  }
  if (external) {
    warnings.push(
      `${external} image${plural(external, "", "s")} link${plural(external, "s", "")} to another website that doesn't allow downloading, so ${plural(external, "it", "they")} couldn't be stored. `
      + `The notes still contain the link${plural(external, "", "s")}.`
    );
  }
  setStatus(`${isShare ? "Packaged" : "Backed up"} ${deckLabel}${imageNote}${paperNoteShort} to ${name}.${hostedNote}${externalNote}`, hosted || missingPapers.length || skipped.length ? "error" : "info");

  const actions = [];
  if (deliver === "download") {
    actions.push({ label: "Download again", onClick: () => downloadBlob(blob, name) });
    if (canShareFile(blob, name)) {
      actions.push({ label: "Share…", primary: isShare, onClick: () => shareFile(blob, name, title || deckLabel) });
    }
  }
  if (autoClosePanel && !warnings.length) {
    progress?.close();
  } else {
    progress?.finish(`Saved ${name}`, { warning: warnings.join("\n\n"), actions });
  }
  if (!warnings.length) showToast(isShare ? "Package saved" : "Backup saved", "success");
  return { ok: true, blob, name, manifest };
}

export function packageFileSlug(value) {
  return (slugifyFileName(String(value || "decks").toLowerCase(), "decks") || "decks").replace(/\s+/g, "-").slice(0, 48);
}

function shortImageName(ref) {
  if (ref.startsWith(LOCAL_IMAGE_SCHEME)) return "a queued image";
  const tail = ref.split("?")[0].split("#")[0].split("/").pop() || ref;
  try { return decodeURIComponent(tail).slice(0, 60); } catch { return tail.slice(0, 60); }
}

// The file handed to the system share sheet — the way a package reaches another
// person from a phone, where "download it, then find it, then attach it" is
// three apps too many.
export function canShareFile(blob, name) {
  try {
    if (typeof navigator === "undefined" || typeof navigator.canShare !== "function" || typeof File !== "function") return false;
    return navigator.canShare({ files: [new File([blob], name, { type: blob.type || PACKAGE_MIME })] });
  } catch {
    return false;
  }
}

export async function shareFile(blob, name, title = "") {
  try {
    await navigator.share({
      files: [new File([blob], name, { type: blob.type || PACKAGE_MIME })],
      title: title ? `Recall: ${title}` : "Recall decks",
      text: "Open this in Recall (My Decks → Import) to get the decks, with their papers, highlights and notes."
    });
  } catch (error) {
    if (error?.name !== "AbortError") showToast("Could not open the share sheet — use Download instead", "error");
  }
}

// The file just written, read back through the restore's own reader and held to
// the manifest: every file there, every size right. Reads the index only.
export async function verifyWrittenPackage(blob, manifest) {
  try {
    const zip = await LiteZip.loadAsync(blob);
    const names = new Set(Object.keys(zip.files));
    for (const entry of manifest.contents || []) {
      if (!names.has(entry.file)) return { ok: false, problem: `${entry.file} is missing from the file` };
      const size = zip.files[entry.file].size;
      if (size !== null && size !== undefined && Number.isFinite(Number(entry.bytes)) && size !== Number(entry.bytes)) {
        return { ok: false, problem: `${entry.file} is ${size} bytes, expected ${entry.bytes}` };
      }
    }
    if (!names.has(BACKUP_MANIFEST_FILE)) return { ok: false, problem: "the manifest is missing" };
    const readBack = normalizeBackupManifest(await zip.files[BACKUP_MANIFEST_FILE].async("string"));
    if (!readBack || readBack.packageId !== manifest.packageId) return { ok: false, problem: "the manifest does not read back" };
    return { ok: true, files: names.size };
  } catch (error) {
    return { ok: false, problem: String(error?.message || error) };
  }
}

function packageReadme({ now, isShare, title, payloads, folders, packed, documents }) {
  const paperNote = documents.documents.length
    ? `${documents.documents.length}${documents.missing.length ? ` (${documents.missing.length} could not be read)` : ""}`
    : (documents.missing.length ? `0 (${documents.missing.length} could not be read)` : "0");
  return [
    isShare ? `Recall package${title ? ` — ${title}` : ""}` : "Recall library backup",
    "",
    `Created: ${now.toISOString()}`,
    `Decks:   ${payloads.length}`,
    `Folders: ${folders.size}`,
    `Images:  ${packed.assets.length}${packed.missing.length ? ` (${packed.missing.length} unreachable, not packed)` : ""}`,
    `Papers:  ${paperNote}`,
    "",
    isShare
      ? "Open it in Recall: My Decks → Import (or drop the file onto the app). The decks arrive as "
        + "your own — cards, notes, papers, highlights, ink and pictures — and their papers and "
        + "images are uploaded to your own storage. Importing the same package again offers to "
        + "update the decks you already have from it."
      : "Restore it in Recall: My Decks → More → Restore backup (or drop the file onto the app).",
    "",
    "It is a zip. Rename it to .zip to look inside:",
    "  manifest.json          index of every deck, image and paper, with sizes and hashes",
    "  decks/<folder>/*.json  one file per deck, inside its own folder path",
    "  assets/<deck>--<id>/   that deck's images, as real files",
    "  assets/index.json      maps each image reference to its packed file",
    "  documents/<deck>--<id>/ that deck's PDFs, exactly as they were imported",
    "  documents/index.json   which PDF belongs to which deck, and its hash",
    ...(isShare ? [] : [
      "  library.json           empty folders, open folds, and your place in each note",
      "  settings.json          this device's preferences (restored only when asked)"
    ]),
    "",
    "The images and the PDFs are real files in here, not links — the package stands",
    "on its own. A paper's highlights are coordinates into its exact bytes, so an",
    "import refuses a PDF whose hash does not match the deck's own record rather",
    "than putting every highlight on the wrong words.",
    ""
  ].join("\n");
}

// ── The buttons ───────────────────────────────────────────────────────────

// My Decks → More → Back up library. Kept under its old name: main.js, the
// restore's safety step and the checks all call it.
export async function exportLibraryBackupZip({
  fileBaseName,
  includeImages = true,
  includeDocuments = true,
  includeSettings = true,
  // The panel is the whole point of the click; `showPanel:false` exists for the
  // callers that already own the screen (nothing does today except tests).
  showPanel = true,
  panelTitle = "Backing up your library",
  // The safety backup taken before a restore is a step INSIDE another job, so
  // its panel gets out of the way on success instead of waiting to be dismissed.
  autoClosePanel = false,
  // "safety" is recorded but does not move the backup reminder — see recordBackup.
  kind = "manual"
} = {}) {
  const progress = showPanel ? showBackupProgress(panelTitle, { steps: PACKAGE_STEPS }) : null;
  try {
    const result = await writeRecallPackage({
      kind: PACKAGE_KIND_LIBRARY,
      includeProgress: true,
      includeImages,
      includeDocuments,
      includeSettings,
      fileBaseName,
      progress,
      autoClosePanel,
      historyKind: kind
    });
    return result.ok;
  } catch (error) {
    console.error("Backup failed", error);
    setStatus(`Backup failed: ${error && error.message ? error.message : "unknown error"}`, "error");
    showToast("Backup failed", "error");
    progress?.error?.(`Failed: ${error?.message || error}`);
    progress?.finish("Backup failed.", { warning: String(error && error.message || "Something went wrong."), failed: true });
    return false;
  }
}

// Share selected decks as one .recall package.
export async function exportRecallPackage(selections, {
  includeProgress = false,
  includeImages = true,
  includeDocuments = true,
  title = ""
} = {}) {
  if (!selections?.length) return false;
  const panelTitle = `Packaging ${selections.length} deck${selections.length === 1 ? "" : "s"} to share`;
  const progress = showBackupProgress(panelTitle, { steps: PACKAGE_STEPS });
  try {
    const result = await writeRecallPackage({
      selections,
      kind: PACKAGE_KIND_SHARE,
      includeProgress,
      includeImages,
      includeDocuments,
      includeSettings: false,
      title,
      progress
    });
    return result.ok;
  } catch (error) {
    console.error("Packaging failed", error);
    setStatus(`Could not make the package: ${error?.message || "unknown error"}`, "error");
    showToast("Share failed", "error");
    progress?.error?.(`Failed: ${error?.message || error}`);
    progress?.finish("Could not make the package.", { warning: String(error?.message || "Something went wrong."), failed: true });
    return false;
  }
}

// The name the checks (and anything older) call a library backup by.
export async function runLibraryBackup({ fileBaseName, includeImages, includeDocuments = true, includeSettings = true, progress, autoClosePanel = false, kind = "manual", selections = null, packageKind = PACKAGE_KIND_LIBRARY, includeProgress } = {}) {
  const result = await writeRecallPackage({
    selections,
    kind: packageKind,
    includeProgress: includeProgress ?? packageKind !== PACKAGE_KIND_SHARE,
    includeImages,
    includeDocuments,
    includeSettings,
    fileBaseName,
    progress,
    autoClosePanel,
    historyKind: kind
  });
  return result.ok;
}
