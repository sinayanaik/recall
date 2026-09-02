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
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";
import {
  BACKUP_ASSET_DIR, BACKUP_ASSET_INDEX, BACKUP_ASSET_SCHEMA, BACKUP_DECK_DIR,
  BACKUP_LIBRARY_FILE, BACKUP_MANIFEST_FILE, BACKUP_SCHEMA, BACKUP_VERSION,
  buildBackupManifest
} from "./archive-format.js?v=__BUILD__";
import { packBackupDocuments } from "./documents.js?v=__BUILD__";
import { recordBackup } from "./history.js?v=__BUILD__";
import { collectBackupLibraryState } from "./library-state.js?v=__BUILD__";
import { LiteZip } from "./zip-lite.js?v=__BUILD__";

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

// Every deck in the library, each paired with the SELECTION it came from.
//
// The selection was thrown away before, and the deck payload does not carry a
// local id — but the local id is the key to two of the largest things a deck
// owns. The document store is keyed by it (src/documents/pdf-store.js), and so
// is the reading position (currentDeckKey). Discarding it here is a large part
// of why neither was ever in an archive: by the time anything downstream wanted
// them, there was nothing left to look them up by.
export async function collectBackupPayloads(progress = null) {
  const selections = await allMyDeckSelections();
  const payloads = [];
  for (const sel of selections) {
    if (progress?.cancelled()) break;
    try {
      payloads.push({ selection: sel, payload: await myDeckPayload(sel) });
    } catch (error) {
      console.warn("Skipping unavailable deck in backup", sel, error);
    }
    progress?.update(`Reading decks ${payloads.length}/${selections.length}…`, payloads.length / Math.max(selections.length, 1));
    progress?.setStat("decks", payloads.length);
  }
  return payloads;
}

// ── Live backup panel ──────────────────────────────────────────────────────
// A backup used to be one click followed by a long silence: the only sign of
// life was the status bar, which sits behind the My Decks panel the click came
// from. Packing images made that wait much longer (every picture is read, and
// the whole archive is then compressed), so it reads as frozen. This gives the
// job a face — what it's doing right now, a bar, and running counts that become
// the finished archive's stats — plus a way out while it's still working.
export function showBackupProgress(title = "Backing up your library") {
  const modal = document.createElement("section");
  modal.className = "category-choice-modal backup-progress-modal";
  modal.setAttribute("aria-label", title);

  const shell = document.createElement("div");
  shell.className = "category-choice-shell backup-progress-shell";
  shell.innerHTML = `
    <div class="category-choice-head">
      <div>
        <h2 class="backup-progress-title"></h2>
        <p class="backup-progress-line" role="status" aria-live="polite">Starting…</p>
      </div>
    </div>
    <div class="job-progress-track is-indeterminate"><div class="job-progress-fill"></div></div>
    <div class="epub-preview-stats">
      <div class="epub-preview-stat"><strong data-backup-stat="decks">0</strong><span>Decks</span></div>
      <div class="epub-preview-stat"><strong data-backup-stat="cards">0</strong><span>Cards</span></div>
      <div class="epub-preview-stat"><strong data-backup-stat="images">0</strong><span>Images</span></div>
      <div class="epub-preview-stat"><strong data-backup-stat="papers">0</strong><span>Papers</span></div>
      <div class="epub-preview-stat"><strong data-backup-stat="size">—</strong><span>Size</span></div>
    </div>
    <p class="backup-progress-note"></p>
    <div class="category-choice-actions">
      <button type="button" data-backup-cancel>Cancel</button>
    </div>
  `;
  shell.querySelector(".backup-progress-title").textContent = title;
  modal.appendChild(shell);
  document.body.appendChild(modal);

  const line = shell.querySelector(".backup-progress-line");
  const track = shell.querySelector(".job-progress-track");
  const fill = shell.querySelector(".job-progress-fill");
  const note = shell.querySelector(".backup-progress-note");
  const button = shell.querySelector("[data-backup-cancel]");

  let cancelled = false;
  let finished = false;
  button.addEventListener("click", () => {
    if (finished) {
      modal.remove();
      return;
    }
    cancelled = true;
    button.disabled = true;
    if (line) line.textContent = "Stopping…";
  });

  return {
    // `fraction` null/undefined keeps the bar in its indeterminate sweep, which
    // is honest about steps whose total isn't known yet.
    update(text, fraction) {
      if (cancelled && !finished) return;
      if (text) line.textContent = text;
      if (typeof fraction === "number") {
        track.classList.remove("is-indeterminate");
        fill.style.width = `${Math.min(100, Math.max(0, Math.round(fraction * 100)))}%`;
      } else {
        track.classList.add("is-indeterminate");
      }
    },
    setStat(key, value) {
      const cell = shell.querySelector(`[data-backup-stat="${key}"]`);
      if (cell) cell.textContent = String(value);
    },
    note(text, warning = false) {
      note.textContent = text || "";
      note.classList.toggle("is-warning", Boolean(text) && warning);
    },
    cancelled() { return cancelled; },
    // Leaves the panel up with the finished archive's numbers — the point of the
    // whole thing is to be able to see what was saved — and turns the escape
    // hatch into the way to dismiss it.
    finish(text, { warning = "" } = {}) {
      finished = true;
      line.textContent = text;
      track.classList.remove("is-indeterminate");
      fill.style.width = "100%";
      if (warning) this.note(warning, true);
      button.disabled = false;
      button.textContent = "Done";
      button.classList.add("import-action-primary");
      button.focus();
    },
    close() { modal.remove(); }
  };
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
export async function readBackupAssetBlob(ref) {
  if (ref.startsWith(LOCAL_IMAGE_SCHEME)) {
    try {
      const entry = await getOutboxImage(ref.slice(LOCAL_IMAGE_SCHEME.length));
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
        if (blob.size) return blob;
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
export async function packBackupAssets(zip, entries, onProgress, isCancelled = () => false) {
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
  if (!refs.length) return { assets: [], missing: [], missingHosted: [], missingExternal: [], indexBytes: 0 };

  let done = 0;
  onProgress?.(0, refs.length);
  // A handful at a time: these are mostly cache hits, and the ones that aren't
  // are latency-bound, but an unbounded fan-out over a few hundred images would
  // stall the browser's connection pool.
  const blobs = await mapWithConcurrency(refs, 5, async (ref) => {
    if (isCancelled()) return null;
    const blob = await readBackupAssetBlob(ref);
    done += 1;
    onProgress?.(done, refs.length);
    return blob;
  });

  // Names are unique per folder, so two decks can both hold a `0001-fig.webp`.
  const usedNames = new Map();
  const assets = [];
  const missing = [];
  refs.forEach((ref, i) => {
    const blob = blobs[i];
    if (!blob) {
      missing.push(ref);
      return;
    }
    const folder = folderByRef.get(ref) || BACKUP_ASSET_DIR;
    if (!usedNames.has(folder)) usedNames.set(folder, new Set());
    const names = usedNames.get(folder);
    const name = backupAssetName(ref, blob, names.size, names);
    const path = `${folder}/${name}`;
    zip.file(path, blob);
    assets.push({
      file: path,
      url: ref,
      type: blob.type || "application/octet-stream",
      bytes: blob.size
    });
  });

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
    missingExternal: missing.filter((ref) => !isSupabaseStorageRef(ref))
  }, null, 2)}\n`;
  zip.file(BACKUP_ASSET_INDEX, indexJson);
  return {
    assets,
    missing,
    missingHosted: missing.filter(isSupabaseStorageRef),
    missingExternal: missing.filter((ref) => !isSupabaseStorageRef(ref)),
    indexBytes: indexJson.length
  };
}

// The zip implementation to build or read an archive with.
//
// JSZip when it is there, and src/backup/zip-lite.js when it is not. The old
// code returned an error instead of that fallback — "Backup needs the zip
// library, which failed to load." — which meant an install that had never been
// online, a blocked CDN, or a bad day at jsdelivr took the ONE feature whose
// entire purpose is surviving a bad day. An app that works offline that cannot
// give you a copy of your own library offline is not backed up; it is hoping.
//
// Both sides go through this, so a backup written by one is read by the other,
// and neither caller has to know which it got.
export async function backupZipFactory() {
  if (await ensureJsZip()) return window.JSZip;
  return LiteZip;
}

export async function exportLibraryBackupZip({
  fileBaseName,
  includeImages = true,
  includeDocuments = true,
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
  const progress = showPanel ? showBackupProgress(panelTitle) : null;
  try {
    return await runLibraryBackup({ fileBaseName, includeImages, includeDocuments, progress, autoClosePanel, kind });
  } catch (error) {
    console.error("Backup failed", error);
    setStatus(`Backup failed: ${error && error.message ? error.message : "unknown error"}`, "error");
    showToast("Backup failed", "error");
    progress?.finish("Backup failed.", { warning: String(error && error.message || "Something went wrong.") });
    return false;
  }
}

export async function runLibraryBackup({ fileBaseName, includeImages, includeDocuments = true, progress, autoClosePanel = false, kind = "manual" }) {
  progress?.update("Reading your decks…");
  const payloads = await collectBackupPayloads(progress);
  if (progress?.cancelled()) {
    progress.close();
    setStatus("Backup cancelled.");
    return false;
  }
  if (!payloads.length) {
    // An empty library is a failed BACKUP — the user pressed a button and no
    // file arrived, so say so. It is not a failed SAFETY STEP: there, having
    // nothing to protect is the successful outcome, and reporting it in red
    // over the job that is still running (see applyRestore) reads as the
    // restore itself having gone wrong.
    if (autoClosePanel) {
      progress?.close();
      return false;
    }
    setStatus("No decks to back up.", "error");
    progress?.finish("No decks to back up.", { warning: "This device has no decks saved yet." });
    return false;
  }

  const Zip = await backupZipFactory();
  const zip = new Zip();
  const now = new Date();
  const manifestDecks = [];
  const usedPaths = new Set();
  const entries = [];
  const folders = new Set();
  // Every file written, in write order, with its size — the inventory
  // verifyBackupArchive checks a zip against on the way back in. Recorded as the
  // archive is built rather than derived from it afterwards, so it describes
  // what this run MEANT to write: an entry that never made it into the zip is
  // exactly the thing worth catching, and a listing taken from the zip itself
  // could never see it.
  const contents = [];
  const record = (file, bytes) => contents.push({ file, bytes });

  payloads.forEach(({ selection, payload }) => {
    const snapshot = deckPayloadSnapshot(payload);
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
    zip.file(path, deckJson);
    record(path, deckJson.length);
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
      deckId: payload.deck.id || null,
      title: payload.deck.title || "Untitled deck",
      pathSegment,
      idPart
    });
    manifestDecks.push({
      file: path,
      deckId: payload.deck.id || null,
      // The local id on the device that WROTE the archive. Restoring your own
      // backup onto your own machine, this is what lets the document bytes
      // already on disk be re-keyed onto the restored deck instead of unpacked
      // again — see planBackupDocumentRestore.
      localId: selection?.localId || null,
      title: payload.deck.title || "Untitled deck",
      category: payload.deck.category || "",
      cardCount: payload.cards.length,
      hasNotes: Boolean(String(payload.deck.notes || "").trim()),
      updatedAt: payload.deck.updated_at || null
    });
  });

  const cardTotal = payloads.reduce((n, { payload }) => n + payload.cards.length, 0);
  progress?.setStat("decks", payloads.length);
  progress?.setStat("cards", cardTotal);

  const deckLabel = `${payloads.length} deck${payloads.length === 1 ? "" : "s"}`;
  let packed = { assets: [], missing: [], missingHosted: [], missingExternal: [], indexBytes: 0 };
  if (includeImages) {
    progress?.update("Looking for images…");
    packed = await packBackupAssets(zip, entries, (done, total) => {
      // The slow phase, and the one people most need to see moving: each image
      // is read from the offline cache or fetched back from storage.
      setStatus(`Packing images ${done}/${total}…`);
      progress?.update(`Packing images ${done}/${total}…`, done / Math.max(total, 1));
      progress?.setStat("images", done);
    }, () => Boolean(progress?.cancelled()));
    if (progress?.cancelled()) {
      progress.close();
      setStatus("Backup cancelled.");
      return false;
    }
    progress?.setStat("images", packed.assets.length);
    packed.assets.forEach((asset) => record(asset.file, asset.bytes));
    if (packed.indexBytes) record(BACKUP_ASSET_INDEX, packed.indexBytes);
  }

  // The papers themselves. This is the half a backup never had: the deck JSON
  // has always carried meta.pdf and every highlight measured against that file,
  // and the file lived only in an IndexedDB store on one device and a PRIVATE
  // bucket in one Supabase project. See src/backup/documents.js.
  let documents = { documents: [], missing: [], bytes: 0 };
  if (includeDocuments) {
    progress?.update("Looking for papers…");
    documents = await packBackupDocuments(zip, entries, (done, total) => {
      setStatus(`Packing papers ${done}/${total}…`);
      progress?.update(`Packing papers ${done}/${total}…`, done / Math.max(total, 1));
      progress?.setStat("papers", done);
    }, () => Boolean(progress?.cancelled()));
    if (progress?.cancelled()) {
      progress.close();
      setStatus("Backup cancelled.");
      return false;
    }
    progress?.setStat("papers", documents.documents.length);
    documents.documents.forEach((doc) => record(doc.file, doc.bytes));
  }

  // Folders that hold no decks, which folds are open, and where you were in each
  // note. None of it is deck data, all of it is the difference between "my
  // library is back" and "my app is back" — see src/backup/library-state.js.
  const libraryState = collectBackupLibraryState();
  const libraryJson = `${JSON.stringify(libraryState, null, 2)}\n`;
  zip.file(BACKUP_LIBRARY_FILE, libraryJson);
  record(BACKUP_LIBRARY_FILE, libraryJson.length);

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
    folders: [...folders, ...libraryState.folders.known],
    contents
  });
  zip.file(BACKUP_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  const paperNote = documents.documents.length
    ? `${documents.documents.length}${documents.missing.length ? ` (${documents.missing.length} could not be read)` : ""}`
    : (documents.missing.length ? `0 (${documents.missing.length} could not be read)` : "0");
  zip.file("README.txt", [
    "Recall library backup",
    "",
    `Created: ${now.toISOString()}`,
    `Decks:   ${payloads.length}`,
    `Folders: ${folders.size}`,
    `Images:  ${packed.assets.length}${packed.missing.length ? ` (${packed.missing.length} unreachable, not packed)` : ""}`,
    `Papers:  ${paperNote}`,
    "",
    "Layout:",
    "  manifest.json          index of every deck, folder, image and paper",
    "  decks/<folder>/*.json  one file per deck, inside its own folder path",
    "  assets/<deck>--<id>/   that deck's images, as real files",
    "  assets/index.json      maps each image reference to its packed file",
    "  documents/<deck>--<id>/ that deck's PDF, exactly as it was imported",
    "  documents/index.json   which PDF belongs to which deck, and its hash",
    "  library.json           empty folders, open folds, and your place in each note",
    "",
    "The zip mirrors the library: the folders under decks/ are the folders in",
    "My Decks, and each deck's images and paper sit in folders named the same",
    "way its cloud Storage folders are. Restoring puts all of it back — decks",
    "into those folders, images into this device's own storage, papers into its",
    "document store. A hand-made zip works too: deck files dropped into folders",
    "are restored into folders of those names.",
    "",
    "The images and the PDFs are real files in here, not links — this archive",
    "stands on its own. Restoring it on another device (or another person's)",
    "copies those files onto that device and, if it has its own cloud project,",
    "re-uploads the images there on the next sync. Nothing depends on the",
    "original owner's storage staying reachable.",
    "",
    "A paper's highlights are coordinates into its exact bytes, so a restore",
    "refuses a PDF whose hash does not match the deck's own record rather than",
    "putting every highlight on the wrong words.",
    "",
    "Restore from the app: My Decks -> More -> Restore backup. Restore is not",
    "the same as Import: Import brings ONE source in as notes or cards and lets",
    "you choose where it lands, while Restore merges a whole library archive.",
    "Restore checks this archive against manifest.json first, then compares",
    "every deck, card and note against your current decks and shows a preview",
    "before changing anything. It never deletes your local-only decks or cards;",
    "it only adds what's missing and applies edits from this backup.",
    ""
  ].join("\n"));

  setStatus(`Compressing backup (${deckLabel}${packed.assets.length ? `, ${packed.assets.length} images` : ""}${documents.documents.length ? `, ${documents.documents.length} papers` : ""})…`);
  progress?.update("Compressing the archive…", 0);
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  }, (meta) => {
    // JSZip reports real percentage here, which is what keeps the bar moving
    // through what is otherwise the longest opaque step of a big backup.
    progress?.update(`Compressing the archive… ${Math.round(meta.percent)}%`, meta.percent / 100);
  });
  const name = `${fileBaseName || `recall-backup-${backupTimestamp(now)}`}.zip`;
  progress?.setStat("size", formatBackupSize(blob.size));
  downloadBlob(blob, name);
  // Recorded once the file has actually been handed over, so the "last backup"
  // line and the reminder that reads it can never describe an archive that was
  // never written.
  recordBackup({
    decks: payloads.length,
    cards: cardTotal,
    documents: documents.documents.length,
    bytes: blob.size,
    name,
    kind
  });
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
  // note keeps the link. A missing upload of ours is a genuine gap. Lumping
  // them together read as "336 of your images are lost", which was alarming
  // and, for the external ones, simply untrue.
  const hosted = packed.missingHosted.length;
  const external = packed.missingExternal.length;
  const plural = (n, one, many) => (n === 1 ? one : many);
  const hostedNote = hosted
    ? ` ${hosted} of your uploaded image${plural(hosted, " is", "s are")} missing from storage.`
    : "";
  const externalNote = external
    ? ` ${external} web link${plural(external, "", "s")} couldn't be downloaded (the site blocks it) — the link${plural(external, " is", "s are")} still in your notes.`
    : "";
  // A paper that could not be read is its own kind of gap, and a louder one than
  // a missing figure: the deck restores with every highlight it ever had, and
  // the document those highlights are positions IN is not in the archive. Named
  // deck by deck, because "1 paper missing" out of forty is a question about
  // WHICH, and the answer decides whether this archive is good enough.
  const missingPapers = documents.missing;
  const paperWarning = missingPapers.length
    ? `${missingPapers.length} paper${plural(missingPapers.length, "", "s")} could not be read and ${plural(missingPapers.length, "is", "are")} not in this archive: `
      + `${missingPapers.slice(0, 5).map((entry) => entry.deckTitle).join(", ")}`
      + `${missingPapers.length > 5 ? `, and ${missingPapers.length - 5} more` : ""}. `
      + "Their highlights and notes are here; the files themselves are not, so those decks will ask you to re-attach the PDF."
    : "";
  setStatus(`Backed up ${deckLabel}${imageNote}${paperNoteShort} to ${name}.${hostedNote}${externalNote}`, hosted || missingPapers.length ? "error" : "info");
  if (autoClosePanel && !packed.missing.length && !missingPapers.length) {
    progress?.close();
  } else {
    const warnings = [];
    if (paperWarning) warnings.push(paperWarning);
    if (hosted) {
      warnings.push(
        `${hosted} image${plural(hosted, "", "s")} you uploaded ${plural(hosted, "is", "are")} no longer in your storage, so ${plural(hosted, "it", "they")} could not be packed. `
        + "Use More → Check for broken images to see which decks they're in."
      );
    }
    if (external) {
      warnings.push(
        `${external} image${plural(external, "", "s")} link${plural(external, "s", "")} to another website that doesn't allow downloading, so ${plural(external, "it", "they")} couldn't be stored in the archive. `
        + `Your notes still contain the link${plural(external, "", "s")} — nothing of yours is lost.`
      );
    }
    progress?.finish(`Saved ${name}`, { warning: warnings.join("\n\n") });
  }
  if (!hosted && !missingPapers.length) showToast("Backup saved", "success");
  return true;
}
