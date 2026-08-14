// `[[Note|id]]` links live in the markdown itself, not in a table — so a note
// carries its own links wherever it is copied, exported or restored.

import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { sanitizeNoteLinkLabel } from "../main.js?v=__BUILD__";

// ── Note references: [[Another note]] ───────────────────────────────────────
//
// One note pointing at another. The whole feature lives in the markdown — there
// is no link table, no new column, nothing in the deck's meta bag. That is not
// a shortcut: `decks.notes` is already part of the fingerprint that decides
// whether a deck has changed (see deckContentMatches), so a link syncs, backs
// up, exports and restores with the text around it and cannot fall out of step
// with it. A links table would have needed all of that built again, and could
// have gone stale against the very text it describes.
//
// Written as  [[Visible title|target]]  where target is one of
//   <deckId>           a deck's CLOUD id — the portable form, always preferred
//   ld_xxxxx           a deck in this device's library, when it has no cloud id
//   …#heading-slug     either of the above, scrolled to a heading
//   qn:<cardId>        a single quick_notes pin
// The target is optional: [[Chain Rule]] resolves by title instead, which is
// what a link typed by hand looks like. The picker always writes the id form,
// so links it makes survive the note being renamed.
//
// ── Why the target has to prefer the cloud id ───────────────────────────────
// A deck carries two ids, and only one of them means anything on a second
// device. `localId` is minted by generateLocalDeckId() from Date.now() plus a
// random suffix, per device, and a deck arriving by sync is given a DIFFERENT
// one on the receiving device (`ld_cloud_<deckId>`, see
// pullCloudDeckIntoLibraryLocked). `deckId` is `decks.id` and is the same
// string everywhere.
//
// The picker used to write `entry.localId || entry.deckId` — i.e. the
// device-local id whenever the deck existed locally, which is essentially
// always. `decks.notes` syncs verbatim and nothing rewrites link targets, so
// every such link resolved on exactly one device and greyed out as broken on
// all the others (and took the "Linked from" backlinks with it). Two halves fix
// it, and both are needed:
//
//   1. Write the portable id going forward — noteLinkMarkupFor / noteLinkIdFor
//      below. A deck that has never been pushed still has no deckId, so the
//      localId remains the fallback.
//   2. Resolve the ids ALREADY written into people's notes, which no amount of
//      writing new links can help. Each device records its own localId for a
//      deck in that deck's `meta.linkIds`, which syncs with everything else in
//      the meta bag; noteLinkEntryMatchesId then accepts any id the deck has
//      ever been known by, on any device. This is why nothing has to rewrite
//      the user's markdown to repair it.
//
// Nothing here has to worry about code: preprocessSpecialBlocks has already cut
// ``` fences out of the text this ever sees, and protectInline (below) skips
// inline `code` spans — so documenting the syntax by writing `[[x]]` in
// backticks leaves it alone, exactly as it does for {{cloze}} and $math$.
export const NOTE_LINK_PATTERN = /\[\[([^[\]\n|]+?)(?:\|([^[\]\n]*?))?\]\]/g;

// How many device-local ids one deck remembers. Each device contributes exactly
// one, so this is "the last 8 devices to open this deck" — far past what anyone
// syncs across, and small enough that the meta bag can't grow without bound on
// a deck that has been around for years.
export const NOTE_LINK_ALIAS_LIMIT = 8;

// Every id this deck answers to: the ids other devices minted for it
// (meta.linkIds), plus this device's own. Deduped, and never containing a falsy
// entry — an empty id would match every link with no target at all.
//
// SORTED, which matters more than it looks. The result is a pure function of the
// SET of ids, so two devices holding the same set always produce a byte-identical
// array. Keeping insertion order instead (this device's id first, as the obvious
// version did) meant A wrote [A,B] and B rewrote it as [B,A] — the same set,
// endlessly reordered, each rewrite dirtying the deck for the other to undo.
// The cap is applied after sorting for the same reason: which ids survive must
// not depend on who is doing the capping.
export function noteLinkAliasesFor(meta, localId) {
  const seen = new Set();
  const add = (id) => {
    const value = String(id || "").trim();
    if (value) seen.add(value);
  };
  add(localId);
  const existing = meta && Array.isArray(meta.linkIds) ? meta.linkIds : [];
  for (const id of existing) add(id);
  return [...seen].sort().slice(0, NOTE_LINK_ALIAS_LIMIT);
}

// Does this link-index entry answer to `id`? The one place that question is
// asked, so resolution, the broken-link styling and the backlinks panel cannot
// drift into three different answers — which is precisely how a link could open
// while still being drawn as broken.
export function noteLinkEntryMatchesId(entry, id) {
  if (!entry || !id) return false;
  if (entry.localId === id || entry.deckId === id) return true;
  return Array.isArray(entry.aliasIds) && entry.aliasIds.includes(id);
}

// The target string to WRITE for a deck. Prefers the cloud id, which means the
// same deck on every device; falls back to the local one only for a deck that
// has never been pushed (and whose localId therefore syncs into meta.linkIds
// the moment it is, keeping even those links resolvable elsewhere).
export function noteLinkIdFor(entry) {
  if (!entry) return "";
  if (entry.pinId) return `qn:${entry.pinId}`;
  return String(entry.deckId || entry.localId || "");
}

// A complete `[[Label|id]]` for a deck, sanitized. Shared by every writer so
// they cannot disagree about which id form gets recorded.
export function noteLinkMarkupFor(entry, label = null) {
  const shown = sanitizeNoteLinkLabel(label != null ? label : entry?.title);
  const id = noteLinkIdFor(entry);
  return id ? `[[${shown}|${id}]]` : `[[${shown}]]`;
}

// What a pipe-less label READS as. "#" is syntax, not something to show: a
// hand-written [[Chain Rule#Proof]] displays as "Chain Rule › Proof", and
// [[#Proof]] (a heading in this same note) as just "Proof". The raw label is
// still what goes into data-note-title, because that is what resolveNoteLink
// parses back apart.
export function noteLinkDisplayLabel(label) {
  const hash = label.indexOf("#");
  if (hash === -1) return label;
  const note = label.slice(0, hash).trim();
  const heading = label.slice(hash + 1).trim();
  if (!heading) return note || label;
  return note ? `${note} › ${heading}` : heading;
}

export function applyNoteLinkMarkup(text) {
  const source = String(text);
  // Ordinary prose has no "[[" in it at all; this keeps the regex off the hot
  // render path for the overwhelming majority of blocks.
  if (!source.includes("[[")) return source;
  return source.replace(NOTE_LINK_PATTERN, (match, label, target) => {
    const title = label.trim();
    if (!title) return match;
    const ref = (target || "").trim();
    // A piped link's label was written deliberately (by the picker, or by hand)
    // and is shown as-is; only the pipe-less form can contain "#" syntax.
    const shown = ref ? title : noteLinkDisplayLabel(title);
    // No href, deliberately. enhanceRenderedMarkdown rewrites every a[href] to
    // open in a new tab, and an internal reference must not — leaving the href
    // off keeps this anchor invisible to that pass instead of needing an
    // exception carved into it. role/tabindex put the keyboard back.
    return `<a class="note-link" role="link" tabindex="0"`
      + ` data-note-target="${escapeHtml(ref)}"`
      + ` data-note-title="${escapeHtml(title)}">${escapeHtml(shown)}</a>`;
  });
}
