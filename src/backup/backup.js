// Backup: the whole library as one .zip.
//
// Images ride INSIDE the archive rather than as links, because the links point
// at the user's own Supabase bucket — a backup that referenced them would stop
// working the moment that project went away, which is exactly when a backup
// matters. Restore re-homes them.

import { mapWithConcurrency } from "../cloud/net.js?v=__BUILD__";
import { deckPayloadSnapshot } from "../cloud/web-decks.js?v=__BUILD__";
import { ensureJsZip } from "../core/lib-loader.js?v=__BUILD__";
import { allMyDeckSelections } from "../export/decks.js?v=__BUILD__";
import { normalizeCardStatus, slugifyFileName } from "../export/markdown.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME, getOutboxImage } from "../images/outbox.js?v=__BUILD__";
import { OFFLINE_IMAGE_CACHE } from "../images/upload.js?v=__BUILD__";
import { FOLDER_SEP, folderSegments, normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { myDeckPayload } from "../library/my-decks-selection.js?v=__BUILD__";
import { noteAnchorsFromMeta } from "../quick-notes/anchors.js?v=__BUILD__";
import { quickNoteCategoriesFromMeta } from "../quick-notes/categories.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";

export const BACKUP_SCHEMA = "recall-backup";

// 2: images are packed into assets/ as real files (see packBackupAssets).
// Purely informational — nothing reads it to decide how to restore, so v1 and v2
// archives are both readable by both builds.
export const BACKUP_VERSION = 2;

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

// Restore is ADDITIVE, so a deck's meta bag merges rather than replaces: a
// quick-note category the backup still knows about but this device has lost is
// added back, every local one is kept, and local wins on a conflicting id (same
// newest-wins-but-never-delete rule the cards follow). Sibling keys — the pinned
// -from source anchors above all — are unioned the same way.
export function mergeBackupMeta(localMeta, backupMeta) {
  const local = normalizeBackupMeta(localMeta);
  const backup = normalizeBackupMeta(backupMeta);
  const merged = { ...backup, ...local };

  const localCats = quickNoteCategoriesFromMeta(local);
  const backupCats = quickNoteCategoriesFromMeta(backup);
  if (localCats.length || backupCats.length) {
    const byId = new Map(localCats.map((cat) => [cat.id, cat]));
    for (const cat of backupCats) if (!byId.has(cat.id)) byId.set(cat.id, cat);
    merged.quickNoteCategories = Array.from(byId.values());
  }

  const localAnchors = noteAnchorsFromMeta(local);
  const backupAnchors = noteAnchorsFromMeta(backup);
  if (Object.keys(localAnchors).length || Object.keys(backupAnchors).length) {
    merged.noteAnchors = { ...backupAnchors, ...localAnchors };
  }
  return merged;
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

export async function collectBackupPayloads(progress = null) {
  const selections = await allMyDeckSelections();
  const payloads = [];
  for (const sel of selections) {
    if (progress?.cancelled()) break;
    try {
      payloads.push(await myDeckPayload(sel));
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
export const BACKUP_ASSET_DIR = "assets";

export const BACKUP_ASSET_INDEX = `${BACKUP_ASSET_DIR}/index.json`;

export const BACKUP_ASSET_SCHEMA = "recall-backup-assets";

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
  // A host that accepts the connection and then never answers would otherwise
  // park one of the fetch workers forever, and the whole backup with it — the
  // failure mode that looks exactly like the app having frozen.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), BACKUP_ASSET_FETCH_TIMEOUT_MS);
  try {
    // Storage serves public objects with permissive CORS; a third-party host
    // (an old ImgBB/Drive link) may not, in which case this throws and the
    // image is reported as missing rather than failing the backup.
    const response = await fetch(ref, { mode: "cors", credentials: "omit", signal: abort.signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size ? blob : null;
  } catch {
    return null;
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
export const BACKUP_DECK_DIR = "decks";

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
  if (!refs.length) return { assets: [], missing: [] };

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

  zip.file(BACKUP_ASSET_INDEX, `${JSON.stringify({
    schema: BACKUP_ASSET_SCHEMA,
    version: 1,
    note: "Maps each image reference used in decks/**.json to its packed file. "
      + "Files are grouped per deck, named the way that deck's Storage folder is. "
      + "Restore re-homes these into the restoring device's own storage.",
    assets,
    missing
  }, null, 2)}\n`);
  return { assets, missing };
}

export async function exportLibraryBackupZip({
  fileBaseName,
  includeImages = true,
  // The panel is the whole point of the click; `showPanel:false` exists for the
  // callers that already own the screen (nothing does today except tests).
  showPanel = true,
  panelTitle = "Backing up your library",
  // The safety backup taken before a restore is a step INSIDE another job, so
  // its panel gets out of the way on success instead of waiting to be dismissed.
  autoClosePanel = false
} = {}) {
  // jszip loads on demand now (see ensureJsZip); it is export-only, so it has
  // no business blocking the app's boot.
  if (!(await ensureJsZip())) {
    setStatus("Backup needs the zip library, which failed to load.", "error");
    return false;
  }
  const progress = showPanel ? showBackupProgress(panelTitle) : null;
  try {
    return await runLibraryBackup({ fileBaseName, includeImages, progress, autoClosePanel });
  } catch (error) {
    console.error("Backup failed", error);
    setStatus(`Backup failed: ${error && error.message ? error.message : "unknown error"}`, "error");
    showToast("Backup failed", "error");
    progress?.finish("Backup failed.", { warning: String(error && error.message || "Something went wrong.") });
    return false;
  }
}

export async function runLibraryBackup({ fileBaseName, includeImages, progress, autoClosePanel = false }) {
  progress?.update("Reading your decks…");
  const payloads = await collectBackupPayloads(progress);
  if (progress?.cancelled()) {
    progress.close();
    setStatus("Backup cancelled.");
    return false;
  }
  if (!payloads.length) {
    setStatus("No decks to back up.", "error");
    progress?.finish("No decks to back up.", { warning: "This device has no decks saved yet." });
    return false;
  }

  const zip = new JSZip();
  const now = new Date();
  const manifestDecks = [];
  const usedPaths = new Set();
  const entries = [];
  const folders = new Set();

  payloads.forEach((payload) => {
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
    zip.file(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    entries.push({ snapshot, assetFolder: backupAssetFolderPath(payload.deck.title, idPart) });
    manifestDecks.push({
      file: path,
      deckId: payload.deck.id || null,
      title: payload.deck.title || "Untitled deck",
      category: payload.deck.category || "",
      cardCount: payload.cards.length,
      hasNotes: Boolean(String(payload.deck.notes || "").trim()),
      updatedAt: payload.deck.updated_at || null
    });
  });

  const cardTotal = payloads.reduce((n, payload) => n + payload.cards.length, 0);
  progress?.setStat("decks", payloads.length);
  progress?.setStat("cards", cardTotal);

  const deckLabel = `${payloads.length} deck${payloads.length === 1 ? "" : "s"}`;
  let packed = { assets: [], missing: [] };
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
  }

  const manifest = {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    app: "recall",
    exportedAt: now.toISOString(),
    deckCount: payloads.length,
    // Image bytes live in assets/ (see assets/index.json). Counted here so a
    // restore knows whether an archive predates image packing or genuinely had
    // no images at all.
    assetCount: packed.assets.length,
    assetsMissing: packed.missing.length,
    // The folder tree these decks came from, so the archive documents the
    // library's shape even where a folder holds no decks of its own.
    folders: Array.from(folders).sort(),
    decks: manifestDecks
  };
  zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  zip.file("README.txt", [
    "Recall library backup",
    "",
    `Created: ${now.toISOString()}`,
    `Decks:   ${payloads.length}`,
    `Folders: ${folders.size}`,
    `Images:  ${packed.assets.length}${packed.missing.length ? ` (${packed.missing.length} unreachable, not packed)` : ""}`,
    "",
    "Layout:",
    "  manifest.json          index of every deck, folder and image",
    "  decks/<folder>/*.json  one file per deck, inside its own folder path",
    "  assets/<deck>--<id>/   that deck's images, as real files",
    "  assets/index.json      maps each image reference to its packed file",
    "",
    "The zip mirrors the library: the folders under decks/ are the folders in",
    "My Decks, and each deck's images sit in a folder named the same way its",
    "cloud Storage folder is. Restoring puts all of it back — decks into those",
    "folders, images into this device's own storage. A hand-made zip works too:",
    "deck files dropped into folders are restored into folders of those names.",
    "",
    "The images are real files in here, not links — this archive stands on its",
    "own. Restoring it on another device (or another person's) copies those",
    "files onto that device and, if it has its own cloud project, re-uploads",
    "them there on the next sync. Nothing depends on the original owner's",
    "storage staying reachable.",
    "",
    "Restore from the app: My Decks -> More -> Restore backup. Restore is not",
    "the same as Import: Import brings ONE source in as notes or cards and lets",
    "you choose where it lands, while Restore merges a whole library archive.",
    "Restore compares every deck, card and note against your current",
    "decks and shows a preview before changing anything. It never deletes your",
    "local-only decks or cards; it only adds what's missing and applies edits",
    "from this backup.",
    ""
  ].join("\n"));

  setStatus(`Compressing backup (${deckLabel}${packed.assets.length ? `, ${packed.assets.length} images` : ""})…`);
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
  const imageNote = packed.assets.length
    ? ` with ${packed.assets.length} image${packed.assets.length === 1 ? "" : "s"}`
    : "";
  const missingNote = packed.missing.length
    ? ` ${packed.missing.length} image${packed.missing.length === 1 ? " was" : "s were"} unreachable and could not be packed.`
    : "";
  setStatus(`Backed up ${deckLabel}${imageNote} to ${name}.${missingNote}`, packed.missing.length ? "error" : "info");
  if (autoClosePanel && !packed.missing.length) {
    progress?.close();
  } else {
    progress?.finish(`Saved ${name}`, {
      warning: packed.missing.length
        ? `${packed.missing.length} image${packed.missing.length === 1 ? "" : "s"} could not be reached and ${packed.missing.length === 1 ? "is" : "are"} not in this archive. Everything else is.`
        : ""
    });
  }
  if (!packed.missing.length) showToast("Backup saved", "success");
  return true;
}
