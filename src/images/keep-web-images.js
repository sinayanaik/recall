// Keep web pictures: copy every picture a file shows from someone else's
// website into the reader's own storage, and point the file at the copy.
//
// A note, a card or a Block can show a picture by its web address — pasted from
// a page, typed by hand, or carried over from an import made before imports
// copied pictures (src/import/web-images.js). That picture is only on loan: the
// day the site moves it, renames it, puts it behind a login or starts refusing
// other sites, it is gone from the file, and from every backup of it, which
// only ever held the link. This makes it the reader's own.
//
// Each picture is fetched once (straight from the site, or through the same
// public image proxy a web-page import uses, when the site refuses), stored
// where the reader's other pictures are, and every place the file shows it —
// the Notes, both faces of every card, the Blocks and the words typed on a
// PDF's or a Canvas's pages — is rewritten to the stored copy. A picture that
// cannot be fetched keeps its address and is counted, not lost.
//
// Run from a file's or a folder's ⋯ menu, from the bulk bar, from the Notes ⋯
// menu, and from the backup dialog's "also keep them in my library".

import { state } from "../core/state.js?v=__BUILD__";
import { escapeRegExp } from "../core/text.js?v=__BUILD__";
import { collectBackupImageRefs, isOtherSitePicture, isShapeTextRecord } from "../backup/backup.js?v=__BUILD__";
import { copyWebImages } from "../import/web-images.js?v=__BUILD__";
import { loadDeckFromLibrary, readLocalDeckIndex, saveDeckToLibrary, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { readDeckSnapshot, rewriteDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";

// Every picture address a stored file shows that lives on someone else's site.
export async function webPictureRefs(snapshot) {
  const out = [];
  for (const ref of collectBackupImageRefs(snapshot)) {
    if (await isOtherSitePicture(ref)) out.push(ref);
  }
  return out;
}

// Point every address in `map` ({ webUrl: storedUrl }) at its copy, wherever
// the file shows it. Marks what it changed the way an edit would, so the change
// syncs: a card is made dirty with a fresh stamp, a Block or a page's typed
// words get a new `at`. Returns true when anything changed.
export function rewriteWebPictures(snapshot, map, { stampIso = new Date().toISOString(), nowMs = Date.now() } = {}) {
  const keys = Object.keys(map || {});
  if (!snapshot || !keys.length) return false;
  const pattern = new RegExp(keys.map(escapeRegExp).join("|"), "g");
  // An address inside stored HTML can be entity-escaped (`&amp;`), so the
  // escaped spelling is matched too.
  const escaped = new Map(keys.filter((key) => key.includes("&")).map((key) => [key.replace(/&/g, "&amp;"), map[key]]));
  const escapedPattern = escaped.size ? new RegExp([...escaped.keys()].map(escapeRegExp).join("|"), "g") : null;
  const swap = (text) => {
    let next = String(text ?? "").replace(pattern, (match) => map[match] || match);
    if (escapedPattern) next = next.replace(escapedPattern, (match) => escaped.get(match) || match);
    return next;
  };
  let changed = false;
  if (typeof snapshot.notes === "string") {
    const notes = swap(snapshot.notes);
    if (notes !== snapshot.notes) { snapshot.notes = notes; changed = true; }
  }
  (snapshot.cards || []).forEach((card) => {
    const question = swap(card.question);
    const answer = swap(card.answer);
    if (question === String(card.question ?? "") && answer === String(card.answer ?? "")) return;
    card.question = question;
    card.answer = answer;
    card.dirty = true;
    card.updatedAt = stampIso;
    changed = true;
  });
  const meta = snapshot.meta && typeof snapshot.meta === "object" ? snapshot.meta : null;
  if (Array.isArray(meta?.pdfBlocks)) {
    meta.pdfBlocks = meta.pdfBlocks.map((block) => {
      if (!block || typeof block !== "object") return block;
      const src = typeof block.src === "string" && map[block.src] ? map[block.src] : block.src;
      const md = typeof block.md === "string" ? swap(block.md) : block.md;
      if (src === block.src && md === block.md) return block;
      changed = true;
      return { ...block, src, md, at: nowMs };
    });
  }
  if (Array.isArray(meta?.pdfHighlights)) {
    meta.pdfHighlights = meta.pdfHighlights.map((record) => {
      if (!isShapeTextRecord(record)) return record;
      const text = swap(record.shape.text);
      const words = typeof record.text === "string" ? swap(record.text) : record.text;
      if (text === record.shape.text && words === record.text) return record;
      changed = true;
      return { ...record, text: words, at: nowMs, shape: { ...record.shape, text } };
    });
  }
  return changed;
}

// The work, for a list of My Files selections. Returns
// { files, pictures, kept, failed, skipped, changedFiles, reason }.
export async function keepWebImagesInFiles(selections, { onProgress = null } = {}) {
  const result = { files: 0, pictures: 0, kept: 0, failed: 0, skipped: 0, changedFiles: 0, reason: "" };
  const list = (selections || []).filter(Boolean);
  for (let i = 0; i < list.length; i += 1) {
    const sel = list[i];
    onProgress?.({ index: i + 1, total: list.length, phase: "reading" });
    // A file stored only in the cloud has no copy here to rewrite; it is
    // counted, and opening it once brings it down.
    const id = sel.localId ? String(sel.localId) : "";
    if (!id) { result.skipped += 1; continue; }
    const isOpen = String(state.localDeckId || "") === id;
    // The open file is saved first, so what is rewritten below is what is on
    // screen, and re-opened after, so what is on screen is what was written.
    if (isOpen) await saveDeckToLibrary({ silent: true }).catch(() => {});
    const snapshot = await readDeckSnapshot(id).catch(() => null);
    if (!snapshot) { result.skipped += 1; continue; }
    result.files += 1;
    const refs = await webPictureRefs(snapshot);
    if (!refs.length) continue;
    result.pictures += refs.length;
    onProgress?.({ index: i + 1, total: list.length, phase: "copying", pictures: refs.length, title: snapshot.deckTitle || "" });
    const copied = await copyWebImages(refs, { title: snapshot.deckTitle || "pictures" });
    if (copied.skipped) {
      // Offline, or signed out: nothing else will upload either.
      result.reason = copied.skipped;
      result.failed += refs.length;
      break;
    }
    const kept = Object.keys(copied.map).length;
    result.kept += kept;
    result.failed += copied.failed;
    if (!kept) continue;
    const stampIso = new Date().toISOString();
    const wrote = await rewriteDeckSnapshot(id, (fresh) => (rewriteWebPictures(fresh, copied.map, { stampIso }) ? fresh : null));
    if (!wrote) continue;
    result.changedFiles += 1;
    // The notes and the meta travel with the file's own stamp.
    writeLocalDeckIndex(readLocalDeckIndex().map((entry) => (String(entry.id) === id ? { ...entry, updatedAt: stampIso } : entry)));
    if (isOpen) await loadDeckFromLibrary(id, { keepPlace: true }).catch(() => {});
  }
  return result;
}

// The words for what happened, for a toast.
export function keepWebImagesSummary(result) {
  if (!result) return "";
  if (result.reason === "offline") return "No connection — the web pictures stay as links for now.";
  if (result.reason === "NOT_SIGNED_IN") return "Sign in to save web pictures into your files.";
  if (!result.pictures) return result.skipped ? "Nothing to do here: these files are stored only in the cloud on this device — open them once first." : "No web pictures to save — every picture is already your own.";
  const parts = [`Saved ${result.kept} of ${result.pictures} web picture${result.pictures === 1 ? "" : "s"} into your files`];
  if (result.failed) parts.push(`${result.failed} could not be downloaded and keep their web link`);
  return `${parts.join("; ")}.`;
}

// The button: run it over `selections` and say what happened.
export async function keepWebImagesWithFeedback(selections) {
  setStatus("Saving web pictures into your files…");
  try {
    const result = await keepWebImagesInFiles(selections, {
      onProgress: ({ index, total, phase, pictures }) => {
        setStatus(phase === "copying"
          ? `Saving ${pictures} web picture${pictures === 1 ? "" : "s"} (file ${index} of ${total})…`
          : `Looking for web pictures (file ${index} of ${total})…`);
      }
    });
    const message = keepWebImagesSummary(result);
    setStatus(message, result.failed && !result.kept ? "error" : "info");
    showToast(message, result.failed && !result.kept ? "error" : "success");
    return result;
  } catch (error) {
    console.error("Keeping web pictures failed", error);
    setStatus(`Could not save the web pictures: ${error?.message || error}`, "error");
    showToast("Could not save the web pictures", "error");
    return null;
  }
}
