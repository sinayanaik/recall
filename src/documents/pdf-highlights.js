// Highlights on the Document surface.
//
// The promise this pays for is "it works exactly like the notes do", and the
// way it keeps that promise is by reusing the machinery rather than
// re-implementing it:
//
//   colours    the same four tokens as a <mark> (format/highlight-colors.js),
//              so a document highlight and a note highlight are the same yellow
//              in every one of this app's themes.
//   notes      the same "## Highlight Notes" section at the end of state.notes,
//              keyed by the same hn-xxxx ids (format/highlight-notes.js). A
//              document highlight's id IS that id, which is why
//              setHighlightNoteInSource and the note editor are reused
//              unchanged rather than forked.
//   the menu   the same mark menu, given a different handler set.
//   the panel  the same Highlights tab, given a second row source.
//
// What is NOT shared is where the highlight itself lives. A <mark> is spliced
// into markdown; there is no markdown here, so a record goes in
// `meta.pdfHighlights` — an array on the deck's existing JSONB meta bag, no new
// table and no new column.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { quadToPageBox } from "./pdf-selection.js?v=__BUILD__";
import { pdfMarkLayer } from "./pdf-view.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT, MARK_HIGHLIGHT_HEX } from "../format/highlight-colors.js?v=__BUILD__";
import { notifyHighlightsChanged } from "../format/highlight-edit.js?v=__BUILD__";
import { pruneOrphanHighlightNotes, readHighlightNotes, setHighlightNoteInSource } from "../format/highlight-notes.js?v=__BUILD__";
import { openHighlightNoteEditor } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { closeMarkMenu, openMarkMenuWith } from "../notes/mark-menu.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";

export const PDF_MARK_CLASS = "pdf-mark";

// How long a jumped-to highlight pulses. Matched to revealNoteMark's own flash
// so arriving at a highlight feels the same whichever surface it is on.
export const PDF_MARK_FLASH_MS = 1400;

// ── The records ─────────────────────────────────────────────────────────────

export function documentHighlights() {
  const list = state.meta?.pdfHighlights;
  return Array.isArray(list) ? list : [];
}

export function isPdfDeck() {
  return Boolean(state.meta?.pdf);
}

// Reading order, which is also the order the Highlights panel lists them in:
// by page, then down the page. Stored order is creation order, and a reader who
// goes back to annotate page 2 after finishing page 9 does not want that row
// at the bottom of the list.
export function documentHighlightsInReadingOrder() {
  return documentHighlights().slice().sort((a, b) => {
    if (a.page !== b.page) return (a.page || 0) - (b.page || 0);
    // Larger y is HIGHER on the page — PDF user space has its origin at the
    // bottom left, so reading order is descending y.
    return (b.quads?.[0]?.rect?.[3] || 0) - (a.quads?.[0]?.rect?.[3] || 0);
  });
}

export function documentHighlightById(id) {
  return documentHighlights().find((record) => record.id === id) || null;
}

// Every live id, for pruneOrphanHighlightNotes. A document highlight's id is a
// highlight-note id, so the notes section has to count these as live or every
// note written on a PDF would be pruned away the next time a <mark> was edited.
export function documentHighlightNoteIds() {
  return documentHighlights().map((record) => record.id).filter(Boolean);
}

// Ids are minted the same way format/highlight-notes.js mints them, and
// deliberately in the same namespace: this IS a highlight-note id. Uniqueness
// is checked against both the records and the note text, since either can
// already be using one.
export function freshDocumentHighlightId() {
  const taken = new Set(documentHighlightNoteIds());
  const notes = state.notes || "";
  for (;;) {
    const id = `hn-${Math.random().toString(36).slice(2, 6)}`;
    if (taken.has(id)) continue;
    if (!notes.includes(`[${id}]`) && !notes.includes(`"${id}"`)) return id;
  }
}

// The one write path. Every mutation goes through here so the two calls that
// have to follow a highlight change — the autosave and the panel refresh —
// cannot be forgotten. Exactly the pair rewriteHighlightGroup makes for a
// <mark> (src/format/highlight-edit.js).
function commitDocumentHighlights(next) {
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}) };
  state.meta.pdfHighlights = next;
  scheduleDeckAutosave();
  notifyHighlightsChanged();
}

// A short label for the note section's heading, so a hand-edited note file
// still says which highlight each entry belongs to.
export function documentExcerptLabel(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const clipped = flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat;
  return `“${clipped}”`;
}

// ── Create / recolour / remove ──────────────────────────────────────────────

export function addDocumentHighlight(capture, color = MARK_HIGHLIGHT_DEFAULT) {
  if (!capture?.quads?.length) return null;
  const record = {
    id: freshDocumentHighlightId(),
    color: MARK_HIGHLIGHT_HEX[color] ? color : MARK_HIGHLIGHT_DEFAULT,
    page: capture.page,
    anchor: capture.anchor,
    focus: capture.focus,
    text: capture.text || "",
    quads: capture.quads,
    // Per-record, and per-EDIT: the sync merge is a union by id with newest
    // winning, so a recolour made on a phone has to be able to out-rank the
    // original made on a laptop. A whole-deck last-write-wins would simply drop
    // one device's afternoon of reading.
    at: Date.now()
  };
  commitDocumentHighlights([...documentHighlights(), record]);
  paintDocumentHighlights(record.page);
  return record;
}

export function recolourDocumentHighlight(id, color) {
  const next = documentHighlights().map((record) =>
    record.id === id ? { ...record, color, at: Date.now() } : record);
  commitDocumentHighlights(next);
  repaintDocumentHighlights();
}

export function removeDocumentHighlight(id) {
  const record = documentHighlightById(id);
  if (!record) return;
  commitDocumentHighlights(documentHighlights().filter((entry) => entry.id !== id));
  // The note that was attached to it would otherwise sit in the "Highlight
  // Notes" section forever with nothing pointing at it — the same cleanup
  // removeHighlightAt does for a <mark>.
  const pruned = pruneOrphanHighlightNotes(state.notes || "");
  if (pruned !== state.notes) state.notes = pruned;
  repaintDocumentHighlights();
}

// ── The note on a highlight ─────────────────────────────────────────────────
//
// Written straight into state.notes through the existing section writer. The
// deck's Notes tab is an ordinary markdown note, so a note taken on a PDF
// highlight is readable, editable and exportable exactly like one taken on a
// <mark> — including by hand, in any editor.

export function documentHighlightNote(id) {
  if (!id) return "";
  return readHighlightNotes(state.notes || "").get(id) || "";
}

export function setDocumentHighlightNote(id, text) {
  const record = documentHighlightById(id);
  if (!record) return false;
  state.notes = setHighlightNoteInSource(state.notes || "", id, text, documentExcerptLabel(record.text));
  // `at` moves too: a note is an edit to the highlight, and the sync merge
  // decides by timestamp.
  commitDocumentHighlights(documentHighlights().map((entry) =>
    entry.id === id ? { ...entry, at: Date.now() } : entry));
  return true;
}

export function clearDocumentHighlightNote(id) {
  return setDocumentHighlightNote(id, "");
}

// ── Painting ────────────────────────────────────────────────────────────────
//
// One absolutely-positioned div per quad, in the page's mark layer — which sits
// UNDER the text layer, so the reader still selects text through a highlight
// rather than selecting the highlight.
//
// The colours come from `--hl-<token>` custom properties rather than from
// MARK_HIGHLIGHT_HEX directly, for the same reason a <mark> does (see
// format/highlight-colors.js): an opaque swatch chosen at authoring time looks
// wrong the moment the theme changes, and these are alpha tints over whatever
// is behind them.
export function paintDocumentHighlights(pageNumber) {
  const layer = pdfMarkLayer(pageNumber);
  if (!layer) return;
  layer.innerHTML = "";
  const frag = document.createDocumentFragment();
  documentHighlights().forEach((record) => {
    (record.quads || []).forEach((quad) => {
      if (quad.page !== pageNumber) return;
      const box = quadToPageBox(quad);
      if (!box) return;
      const mark = document.createElement("div");
      mark.className = PDF_MARK_CLASS;
      mark.dataset.color = record.color || MARK_HIGHLIGHT_DEFAULT;
      mark.dataset.highlightId = record.id;
      mark.style.left = `${box.left}px`;
      mark.style.top = `${box.top}px`;
      mark.style.width = `${box.width}px`;
      mark.style.height = `${box.height}px`;
      frag.appendChild(mark);
    });
  });
  layer.appendChild(frag);
}

// Every page currently carrying a mark layer. Called after any CRUD, because a
// highlight can span a page break and a recolour has to reach both halves.
export function repaintDocumentHighlights() {
  document.querySelectorAll(".pdf-page[data-page-number]").forEach((page) => {
    const pageNumber = Number(page.dataset.pageNumber);
    if (pageNumber && page.querySelector(".pdf-mark-layer")) paintDocumentHighlights(pageNumber);
  });
}

// Pulse one highlight's quads, so a jump from a card or the Highlights panel
// lands somewhere the reader can see it landed.
export function flashDocumentHighlight(id) {
  const marks = document.querySelectorAll(`.${PDF_MARK_CLASS}[data-highlight-id="${CSS.escape(id)}"]`);
  marks.forEach((mark) => {
    mark.classList.remove("is-flashing");
    // Forces the class removal to take effect before it is re-added, so a
    // second jump to the same highlight flashes again rather than doing
    // nothing.
    void mark.offsetWidth;
    mark.classList.add("is-flashing");
    setTimeout(() => mark.classList.remove("is-flashing"), PDF_MARK_FLASH_MS);
  });
  return marks.length > 0;
}

// The highlight under a tap, if any.
//
// Hit-tested against the RECORDS, geometrically — not by letting the mark divs
// receive the event, and not through elementsFromPoint either. The mark layer
// carries `pointer-events: none` (it has to: the text layer sits above it and
// must keep receiving every pointer event, or selection stops working over a
// highlight), and an element with pointer-events disabled is exactly what
// elementsFromPoint declines to return. So the quads are tested directly, in
// the page's own coordinate space, which is where they already live.
export function documentHighlightAtPoint(clientX, clientY) {
  const page = document.elementFromPoint(clientX, clientY)?.closest(".pdf-page");
  if (!page) return null;
  const box = page.getBoundingClientRect();
  const x = clientX - box.left;
  const y = clientY - box.top;
  const pageNumber = Number(page.dataset.pageNumber);
  for (const record of documentHighlights()) {
    for (const quad of record.quads || []) {
      if (quad.page !== pageNumber) continue;
      const quadBox = quadToPageBox(quad);
      if (!quadBox) continue;
      if (x >= quadBox.left && x <= quadBox.left + quadBox.width
          && y >= quadBox.top && y <= quadBox.top + quadBox.height) return record;
    }
  }
  return null;
}

// ── Importing the PDF's own highlights ──────────────────────────────────────
//
// A paper that arrives already annotated in Zotero, Preview or Okular carries
// those highlights as PDF annotations. Reading them once, at import, is what
// makes "drop the paper in" mean the same thing as "carry on where I was" —
// and it costs one getAnnotations() per page during an import that is already
// reading every page.
//
// Deliberately one-way and one-time. The app never writes annotations back into
// the file: the bytes are the reader's original document, and rewriting them
// would break the sha256 that every anchor depends on.

// Annotation colours are arbitrary RGB; the app's are four named tokens. Mapped
// by nearest neighbour in plain RGB space — good enough to put a Zotero yellow
// in the yellow bucket and a Zotero pink in the pink one, which is all this
// needs to do.
export function nearestHighlightColor(rgb) {
  if (!rgb || rgb.length < 3) return MARK_HIGHLIGHT_DEFAULT;
  let best = MARK_HIGHLIGHT_DEFAULT;
  let bestDistance = Infinity;
  Object.entries(MARK_HIGHLIGHT_HEX).forEach(([token, hex]) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = token;
    }
  });
  return best;
}

// quadPoints has been two different shapes across pdf.js versions: a flat
// Float32Array of 8 numbers per quad (x1,y1,…,x4,y4), and an array of arrays of
// {x,y} points. Both are read here rather than pinning the reader's imported
// highlights to one library version.
export function annotationQuads(annotation, pageNumber) {
  const quads = [];
  const points = annotation?.quadPoints;
  if (Array.isArray(points) && points.length && Array.isArray(points[0])) {
    points.forEach((corners) => {
      const xs = corners.map((point) => point.x);
      const ys = corners.map((point) => point.y);
      quads.push({ page: pageNumber, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    });
  } else if (points && points.length >= 8) {
    for (let i = 0; i + 7 < points.length; i += 8) {
      const xs = [points[i], points[i + 2], points[i + 4], points[i + 6]];
      const ys = [points[i + 1], points[i + 3], points[i + 5], points[i + 7]];
      quads.push({ page: pageNumber, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  } else if (Array.isArray(annotation?.rect) && annotation.rect.length === 4) {
    // A highlight with no quadPoints at all (some producers omit them) still
    // has a rectangle. Coarser, but a highlight in roughly the right place beats
    // dropping the reader's annotation on the floor.
    const [x0, y0, x1, y1] = annotation.rect;
    quads.push({ page: pageNumber, rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)] });
  }
  return quads;
}

// ── The mark menu, on a coordinate ──────────────────────────────────────────
//
// Same menu, same four swatches, same ✎ and ✕ as in a note — given a different
// set of verbs. The key it is opened with is the highlight's id rather than a
// <mark>'s ordinal, which is the whole reason src/notes/mark-menu.js takes a
// handler set at all.

export const DOCUMENT_MARK_HANDLERS = {
  recolour: (id, color) => recolourDocumentHighlight(id, color),
  remove: (id) => removeDocumentHighlight(id),
  noteText: (id) => documentHighlightNote(id),
  openNote: (id, rect) => openHighlightNoteEditor(id, rect, documentHighlightNote(id), DOCUMENT_NOTE_HANDLERS)
};

export const DOCUMENT_NOTE_HANDLERS = {
  save: (id, text) => setDocumentHighlightNote(id, text),
  remove: (id) => clearDocumentHighlightNote(id),
  // Nothing on the page changes when a note is written — the note's text lives
  // in the deck's markdown, not in the PDF — but the highlight's own "has a
  // note" state does, and the Highlights panel is a different surface that may
  // well be where the edit was made from.
  repaint: () => { repaintDocumentHighlights(); notifyHighlightsChanged(); }
};

// A tap on a highlight opens its menu; a tap anywhere else on the page closes
// it. Deliberately a click and not a selection, exactly as in a note: selecting
// a highlight to change it would go through the text layer, which is the one
// thing that cannot tell you WHICH highlight you meant.
export function initDocumentMarkMenu() {
  const view = el.documentView;
  if (!view) return;
  view.addEventListener("click", (event) => {
    // A live text selection means the reader is selecting, not tapping a
    // highlight — the floating pill is the right surface for that. Read
    // through the RANGE rather than Selection.toString(), for the reason
    // src/notes/mark-menu.js gives at the same test: an armed touch controller
    // makes toString() answer "" over unselectable content while every Range
    // operation stays correct.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount
        && selection.getRangeAt(0).toString().trim()) return;
    const record = documentHighlightAtPoint(event.clientX, event.clientY);
    if (!record) {
      closeMarkMenu();
      return;
    }
    event.preventDefault();
    // Anchored to the highlight's own first painted quad, so the menu appears
    // over the words it acts on rather than wherever the finger landed.
    const anchor = view.querySelector(`.${PDF_MARK_CLASS}[data-highlight-id="${CSS.escape(record.id)}"]`) || event.target;
    openMarkMenuWith(anchor, record.id, DOCUMENT_MARK_HANDLERS, record.color || MARK_HIGHLIGHT_DEFAULT);
  });

  // The menu is positioned against a rect that scrolling invalidates.
  view.addEventListener("scroll", closeMarkMenu, { passive: true });
}
