// Blocks on a page you write on by hand: typed markdown, and pictures.
//
// A page of working usually wants both: a derivation in your own hand, and the
// statement of the problem typed above it. Handwriting is quick and unreadable
// by anything; typed text is slower and readable by everything. So a block is
// markdown, rendered through the same pipeline every other surface in this app
// uses, dropped where you put it and moved and resized with a finger.
//
// ── ...and why a picture is one of these rather than a thing of its own ────
//
// A photograph of a whiteboard beside the working you did from it is the other
// half of the same page, and it wants exactly what a text block wants: a
// rectangle in the page's own points, a drag, a resize, a delete, a tombstone
// when it goes, and a merge by id on the next sync. All of that is already here
// and all of it is already checked, so an image is a block with `kind: "image"`
// and a `src` instead of a `md`.
//
// It is deliberately NOT markdown-with-an-image-in-it, which would have needed
// no new code at all. A block whose whole content is a picture would still be
// sized as a paragraph, still be scrolled inside its own box, and still show the
// reader a text editor when they pressed ✎ — three answers to questions nobody
// asked about a photograph. The record is one field wider; the surface is a
// picture you can pick up.
//
// A record with no `kind` is text, because that is what every record written
// before this existed was.
//
// ── Why they live in PDF user space ───────────────────────────────────────
//
// For exactly the reason the strokes do (src/documents/pdf-ink.js): a position
// in the DOCUMENT survives a zoom, a refit, a rotation, a reload and a second
// device, and a position in screen pixels survives none of them. A block is a
// rectangle in points on a page, and the viewport pdf.js hands back is what
// turns that into a box on the glass — the same transform, so a block and the
// ink beside it move together and cannot drift apart.
//
// That also means blocks work on ANY paper, not only on a notebook's generated
// pages. Typing a note over a figure in somebody's preprint is the same feature.
//
// ── Pointer mechanics ─────────────────────────────────────────────────────
//
// Modelled on the image resize grip in src/images/surface-controls.js: capture
// the pointer so a fast drag that leaves the element keeps the gesture, throttle
// the move to one style write per frame, and take the document-level listeners
// off again in the up handler — a leaked pointermove listener is the "stray
// element that follows the cursor" bug.
//
// Every press here stops propagating, and pdf-ink.js stands down for anything
// inside a block (PDF_BLOCK_CLASS). Without that pair a pen press meant to move
// a block would also draw a stroke, every time.

import { PDF_BLOCK_CLASS, PDF_BLOCK_LAYER_CLASS } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { closeBlockActionsPopover, openBlockActionsPopover } from "./block-actions-popover.js?v=__BUILD__";
import { closeBlockStylePopover, openBlockStylePopover } from "./block-style-bar.js?v=__BUILD__";
import { blockFillVar, blockInkVar, isDefaultBlockStyle, normalizeBlockStyle } from "./block-style.js?v=__BUILD__";
import { activeDocSlot, DOC_SLOT_DOC, stampDocSlotAll } from "./doc-slot.js?v=__BUILD__";
import { activePdfId, recordsForSurface, recordsOutsideSurface, stampRecordPdfIdAll } from "./pdf-multi.js?v=__BUILD__";
import { closeBlockEditor, openBlockEditor } from "./pdf-block-editor.js?v=__BUILD__";
import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { resolveStorageImages } from "../cloud/storage-urls.js?v=__BUILD__";
import { hydrateLocalImages, storeImageOrQueue } from "../images/outbox.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { blockStylePreference, writeBlockStylePreference } from "../storage/ink-prefs.js?v=__BUILD__";
import { dropMetaTombstonesForLiveIds, recordDeletedMetaId } from "../sync/document-sync.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { resolveFontFamily } from "../ui/fonts.js?v=__BUILD__";

// A block with no `kind` is text — see the header. Named constants rather than
// bare strings so the record, the builder and the painter cannot drift.
export const PDF_BLOCK_TEXT = "text";

export const PDF_BLOCK_IMAGE = "image";

// In PDF points. A block narrower than this cannot show a line of text, and one
// shorter cannot be grabbed by its own bar.
export const PDF_BLOCK_MIN_WIDTH = 90;
export const PDF_BLOCK_MIN_HEIGHT = 34;
const PDF_BLOCK_DEFAULT_WIDTH = 240;
const PDF_BLOCK_DEFAULT_HEIGHT = 90;

// In CSS pixels, not points — this is about a finger or a mouse, not the page.
// Every press on a block used to become a drag gesture on the spot: pointer
// capture taken and the block re-placed on the very first pointermove,
// whatever its distance. A tap that trembled by a pixel while landing still
// read as a drag started and (harmlessly, per the no-op guard in `finish`)
// abandoned — but the capture and the live re-placement happened regardless,
// which is jitter a plain "select this block" press was never asking for.
// Below this many pixels of travel, `beginGesture`'s drag mode treats the
// press as what it still visibly is: a tap. The resize grip is exempt — a
// press on the grip is unambiguously always a resize, never a tap.
const PDF_BLOCK_DRAG_SLOP_PX = 4;

let editingId = null;
// Which block the keyboard is talking about. A separate thing from `editingId`:
// a block being TYPED into is in the sheet, and a block that is merely selected
// is one the reader has picked up so that Delete, the arrows or Ctrl+D mean it.
let selectedId = null;
// True for the length of a drag or a resize. Read by the height-fitter, which
// must not fight a finger that is already sizing the box.
let gestureLive = false;
// Which block the floating style panel is describing, so a second press on the
// same button shuts it rather than rebuilding it in place.
let styleOpenFor = null;
let onBlocksChanged = () => {};
// Told whenever the block the keyboard is pointing at changes — including to
// nothing. What this is FOR: src/ui/ink-rail.js paints #inkRailBlock (Style /
// Edit / Delete) off exactly this, the way a lassoed stroke already paints
// #inkRailSelection off its own count. Selection itself lives here rather than
// in the rail because it is a fact about the BLOCK, asked by the keyboard map
// in src/main.js as much as by any rail.
let onSelectionChanged = () => {};

export function setBlocksChangedHandler(fn) {
  onBlocksChanged = typeof fn === "function" ? fn : () => {};
}

export function setBlockSelectionChangedHandler(fn) {
  onSelectionChanged = typeof fn === "function" ? fn : () => {};
}

// The one place `selectedId` is written. Every other assignment in this file
// goes through this, so the rail can never miss a change — five separate call
// sites each remembering to say so themselves is five chances to forget one.
function setSelectedId(id) {
  if (id === selectedId) return;
  selectedId = id;
  onSelectionChanged(selectedId);
}

// ── Bringing the quick-actions popover into agreement with the selection ───
//
// Deliberately NOT called from setSelectedId itself, unlike onSelectionChanged
// above it: duplicateBlock sets the id of a block whose DOM node does not
// exist yet (setSelectedId runs before repaintDocumentBlocks paints it), and
// a lookup here at that instant would find nothing and close a popover that
// was never open. So every caller below runs this AFTER its own repaint —
// selectBlock, duplicateBlock, writeBlockText, openStyleFor's toggle-off, and
// beginGesture's finish() — which is also exactly the set of moments a
// gesture is not still live and the node's current position is settled.
function syncBlockActionsPopover() {
  if (!selectedId || editingId || gestureLive) { closeBlockActionsPopover(); return; }
  const node = document.querySelector(`[data-pdf-block="${selectedId}"]`);
  const block = node && documentBlocks().find((entry) => entry.id === selectedId);
  if (!node || !block) { closeBlockActionsPopover(); return; }
  openBlockActionsPopover({
    anchor: node,
    kind: block.kind,
    // Toggling the STYLE popover already means "I am done with the quick
    // actions for a moment" — openStyleFor closes this one itself, so there
    // is nothing to duplicate here.
    onStyle: () => openSelectedBlockStyle(),
    onEdit: () => editBlock(selectedId),
    onDuplicate: () => duplicateBlock(selectedId),
    onRestackForward: () => restackBlock(1, selectedId),
    onRestackBack: () => restackBlock(-1, selectedId),
    onDelete: () => deleteBlock(selectedId)
  });
}

// A deck can carry its own paper AND a notebook, and both keep their blocks in
// this one array with a `doc` field saying which (src/documents/doc-slot.js).
// This returns the surface's own, because that is what every caller means.
export function documentBlocks(pageNumber = null) {
  const slot = activeDocSlot();
  const list = recordsForSurface(state.meta?.pdfBlocks, slot, slot === DOC_SLOT_DOC ? activePdfId(state.meta) : null);
  const out = list
    .filter((block) => block && typeof block === "object" && block.id)
    .map((block) => ({
      id: String(block.id),
      page: Number(block.page) || 1,
      x: Number(block.x) || 0,
      y: Number(block.y) || 0,
      w: Math.max(PDF_BLOCK_MIN_WIDTH, Number(block.w) || PDF_BLOCK_DEFAULT_WIDTH),
      h: Math.max(PDF_BLOCK_MIN_HEIGHT, Number(block.h) || PDF_BLOCK_DEFAULT_HEIGHT),
      z: Number(block.z) || 0,
      kind: block.kind === PDF_BLOCK_IMAGE ? PDF_BLOCK_IMAGE : PDF_BLOCK_TEXT,
      md: typeof block.md === "string" ? block.md : "",
      src: typeof block.src === "string" ? block.src : "",
      alt: typeof block.alt === "string" ? block.alt : "",
      at: Number(block.at) || 0,
      // ── Carried through, and deliberately NOT normalised here ────────────
      //
      // Every other field above is normalised into a value the painter can use
      // without asking twice. `style` cannot be, and the reason is that THIS
      // ARRAY IS WRITTEN BACK: a drag, a delete and a page renumber all do
      // `writeBlocks(documentBlocks().map(…))`, so anything this function
      // invents becomes a field on the record the next time anything moves.
      // Normalising here would therefore stamp a full default style bag onto
      // every block in every deck the first time one of them was nudged — in an
      // array that is re-sent whole on every push, for ever, saying nothing.
      //
      // So the key is passed on when it is there and absent when it is not, and
      // blockStyle() below is what the painter asks. writeBlockStyle is the only
      // thing that ever creates the key, and it removes it again the moment the
      // reader puts every control back where it started.
      ...(block.style && typeof block.style === "object" ? { style: { ...block.style } } : {})
    }));
  return pageNumber === null ? out : out.filter((block) => block.page === Number(pageNumber));
}

// A block's style, filled in. The one door between the record's optional bag and
// everything that draws it.
export function blockStyle(block) {
  return normalizeBlockStyle(block?.style);
}

// Both papers' blocks, for the callers that mean the DECK: the sync merge and
// the backup, which read the array straight off meta and must never be handed
// half of it.
export function allDocumentBlocks() {
  return Array.isArray(state.meta?.pdfBlocks) ? state.meta.pdfBlocks : [];
}

// The surface's blocks, stamped with the paper they are on, plus the other
// paper's untouched. Without the second half, adding a text block to a notebook
// would delete every block typed over the preprint beside it — see the same
// argument spelled out on wholeHighlightArray in ./pdf-highlights.js.
// `removed` is one id or a list of them. A list, because tearing a page out of a
// notebook buries every block that was on it in a single write — and a bury that
// arrived in a second write could be carried by a sync on its own, which is the
// half-a-change this whole path exists to avoid.
function writeBlocks(next, { removed = null, revive = null, undoable = true, coalesce = "" } = {}) {
  const slot = activeDocSlot();
  const pdfId = slot === DOC_SLOT_DOC ? activePdfId(state.meta) : null;
  // Before anything is written, and only for the changes a reader MADE — see the
  // ring below for why a page renumber and a late upload are not among them.
  if (undoable) pushBlockUndo(documentBlocks(), coalesce);
  const stamped = stampRecordPdfIdAll(stampDocSlotAll(next, slot), pdfId);
  const whole = recordsOutsideSurface(state.meta?.pdfBlocks, slot, pdfId).concat(stamped);
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}), pdfBlocks: whole };
  // Written back into the meta on every step. recordDeletedMetaId reads the bag
  // off `meta` and returns a fresh one, so a loop that assigns only after its
  // last iteration hands every step the same starting bag and keeps one id —
  // see the identical rule spelled out in remapDocumentHighlightPages.
  (Array.isArray(removed) ? removed : [removed]).filter(Boolean).forEach((id) => {
    state.meta.deletedBlockIds = recordDeletedMetaId(state.meta, "deletedBlockIds", id);
  });
  // ...and the other direction, which only an undo asks for: a block that has
  // come BACK must lose its tombstone, or the next merge reads a live record and
  // a note saying it was deleted and honours the note. dropMetaTombstonesForLiveIds
  // returns null for "nothing left", and a key holding an empty bag is a key the
  // sync still carries — so it is removed rather than emptied.
  if (revive?.length) {
    // Ids in, records out: `removed` above is a list of ids and this is its
    // mirror, but dropMetaTombstonesForLiveIds takes the RECORDS that are alive
    // and reads an id off each — so the two are made to agree here rather than
    // by giving one of them a different shape from the other.
    const kept = dropMetaTombstonesForLiveIds(state.meta, "deletedBlockIds", revive.map((id) => ({ id })));
    if (kept) state.meta.deletedBlockIds = kept;
    else delete state.meta.deletedBlockIds;
  }
  scheduleDeckAutosave();
  onBlocksChanged();
}

// ── Undo, which this surface owed and did not have ─────────────────────────
//
// The pen has had undo since it was written; a block had none. Adding one was
// optional while the only way to lose a block was to press 🗑 and mean it, and it
// stopped being optional the moment Delete on the keyboard could do the same
// thing to whatever happened to be selected. And a block does not merely
// disappear when it goes: writeBlocks TOMBSTONES it, so the loss is pushed to
// every other device on the next sync. There is nowhere to get it back from.
//
// A snapshot of the surface's whole block list per step, rather than a diff.
// This is at most a few dozen small records — the array the sync sends whole
// anyway — and a diff would have to describe five kinds of change to save bytes
// nobody is counting.
//
// Deliberately NOT covering two of the writers above. remapDocumentBlockPages is
// half of tearing a page out of a notebook, and putting its blocks back on a page
// that no longer exists is not an undo of anything; settleBlockUploadToken is an
// upload landing by itself, minutes later, which is not a thing the reader did.
const BLOCK_UNDO_DEPTH = 20;

const blockUndoRing = [];
const blockRedoRing = [];
// Which deck and which paper the rings are about. Two documents share this
// module, and a deck can be closed and another opened without it ever being torn
// down — so without this, Ctrl+Z on the second deck would restore the first one's
// blocks onto it.
let blockHistoryKey = "";

function currentHistoryKey() {
  const slot = activeDocSlot();
  // The pdfId, when there is more than one PDF on this shelf — otherwise a
  // switch between two PDFs on the same deck would leave Ctrl+Z restoring the
  // WRONG paper's blocks, because both would answer with the identical key.
  const pdfId = slot === DOC_SLOT_DOC ? activePdfId(state.meta) : "";
  return `${state.localDeckId || ""}:${slot}:${pdfId || ""}`;
}

// ── ...and why one of these takes a `coalesce` key ────────────────────────
//
// The style panel's size box previews live, so it writes on every keystroke.
// Typing "18" is two writes; typing "13.5" is four. Each one would be a step of
// its own, so a reader who set a size and pressed Ctrl+Z would get the "1" back
// — and four keystrokes would spend a fifth of a twenty-deep ring.
//
// A push carrying the same key as the last one, within COALESCE_MS of it, is the
// same edit continuing: it is dropped, so the snapshot already on the ring — the
// state before the first keystroke — is what Ctrl+Z returns to. The same idea as
// note-editor-kit's "an unchanged value is not a step", one level up.
const BLOCK_UNDO_COALESCE_MS = 1200;

let lastUndoCoalesce = { key: "", at: 0 };

function pushBlockUndo(before, coalesce = "") {
  const key = currentHistoryKey();
  if (key !== blockHistoryKey) {
    blockUndoRing.length = 0;
    blockRedoRing.length = 0;
    blockHistoryKey = key;
    lastUndoCoalesce = { key: "", at: 0 };
  }
  const now = Date.now();
  const continuing = coalesce
    && coalesce === lastUndoCoalesce.key
    && (now - lastUndoCoalesce.at) < BLOCK_UNDO_COALESCE_MS;
  // The clock is bumped even when the push is dropped, so a slow typist holding
  // one key every second is still one step rather than five.
  lastUndoCoalesce = { key: coalesce, at: now };
  if (continuing) return;
  blockUndoRing.push(before);
  if (blockUndoRing.length > BLOCK_UNDO_DEPTH) blockUndoRing.shift();
  // A new change is a new future, the rule every undo stack in this app follows.
  blockRedoRing.length = 0;
}

// Put the surface back to `list`, and return what it was — which is the entry the
// opposite ring gets. The two id sets are compared rather than assumed, because a
// step can have added AND removed (an undo of a duplicate, a redo of a delete),
// and each direction owes the tombstones the other one wrote.
function restoreBlocks(list) {
  const before = documentBlocks();
  const beforeIds = new Set(before.map((block) => block.id));
  const afterIds = new Set(list.map((block) => block.id));
  writeBlocks(list, {
    undoable: false,
    removed: before.filter((block) => !afterIds.has(block.id)).map((block) => block.id),
    revive: list.filter((block) => !beforeIds.has(block.id)).map((block) => block.id)
  });
  return before;
}

export function canUndoBlocks() {
  return blockUndoRing.length > 0 && currentHistoryKey() === blockHistoryKey;
}

export function canRedoBlocks() {
  return blockRedoRing.length > 0 && currentHistoryKey() === blockHistoryKey;
}

export function undoBlocks() {
  if (!canUndoBlocks()) return false;
  commitBlockEdit();
  blockRedoRing.push(restoreBlocks(blockUndoRing.pop()));
  repaintDocumentBlocks();
  return true;
}

export function redoBlocks() {
  if (!canRedoBlocks()) return false;
  commitBlockEdit();
  blockUndoRing.push(restoreBlocks(blockRedoRing.pop()));
  repaintDocumentBlocks();
  return true;
}

// ── Renumbering, when a page is removed from under them ────────────────────
//
// The exact twin of remapDocumentHighlightPages in ./pdf-highlights.js, and it
// exists because tearing a page out of a notebook called that one and stopped.
// A block is a rectangle on a numbered page in the same way a highlight is, so
// every fault that function was written to prevent applied here unanswered: a
// text block on the torn-out page SURVIVED, floating on whatever page inherited
// its number, and every block after the gap went on describing a page that had
// just moved down by one.
//
// `move` returns the new page number, or null to bury the record. The `at` bump
// on a moved block is what makes the change win its own merge — a renumber that
// kept its old stamp would lose to the other device's copy of the same block,
// still on the page it used to be on.
//
// One write, like the highlights one: the moves and the burials land together or
// a sync between them carries half a tear-out.
export function remapDocumentBlockPages(move) {
  const before = documentBlocks();
  if (!before.length) return 0;
  const next = [];
  const gone = [];
  before.forEach((block) => {
    const to = move(block);
    if (to === null || to === undefined) { gone.push(block); return; }
    if (Number(block.page) === Number(to)) { next.push(block); return; }
    next.push({ ...block, page: Number(to), at: Date.now() });
  });
  // Not undoable — see the ring: half of a tear-out is not a step of its own.
  writeBlocks(next, { removed: gone.map((block) => block.id), undoable: false });
  return gone.length;
}

// ── An upload that landed after the editor closed ──────────────────────────
//
// insertPreparedImageUpload writes a `![uploading…](#upl-…)` token at the caret
// and swaps it for the real URL when the bytes are stored. settleUploadToken
// (src/images/outbox.js) does that swap against the textarea when it is still on
// screen, and otherwise looks for the token in the open deck's NOTES and CARDS —
// which is everywhere a token could be until a block on a page grew the same
// editor. Press Done (or Escape, or the backdrop) before a slow upload lands and
// the block kept the placeholder for ever: no image, no error, and a piece of
// literal markdown in the middle of the working.
//
// Deliberately NOT slot-filtered, unlike every other writer here. The reader may
// well be on the deck's other paper by the time the upload finishes — that is
// the whole case this is for — so this takes the array whole and puts it back
// whole. `at` is bumped on the blocks it changed, for the reason
// remapDocumentBlockPages bumps it: a swap that kept its old stamp would lose to
// the other device's copy of the same block, still holding the placeholder.
export function settleBlockUploadToken(token, replacement) {
  const blocks = Array.isArray(state.meta?.pdfBlocks) ? state.meta.pdfBlocks : [];
  if (!blocks.length || !token) return false;
  let touched = false;
  const next = blocks.map((block) => {
    const md = String(block?.md || "");
    if (!md.includes(token)) return block;
    touched = true;
    return { ...block, md: md.split(token).join(replacement), at: Date.now() };
  });
  if (!touched) return false;
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}), pdfBlocks: next };
  scheduleDeckAutosave();
  onBlocksChanged();
  return true;
}

function freshBlockId(taken) {
  for (;;) {
    const id = `bk-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (!taken.has(id)) return id;
  }
}

// ── Painting ───────────────────────────────────────────────────────────────

function blockLayer(pageNumber) {
  const pageEl = pdfPageElement(pageNumber);
  if (!pageEl) return null;
  let layer = pageEl.querySelector(`.${PDF_BLOCK_LAYER_CLASS}`);
  if (!layer) {
    layer = document.createElement("div");
    layer.className = PDF_BLOCK_LAYER_CLASS;
    pageEl.appendChild(layer);
  }
  return layer;
}

// A rectangle in points onto a box on the glass. Both corners are converted
// because the two coordinate systems disagree about which way y runs, so the
// answer has to be normalised rather than assumed.
function blockBox(viewport, block) {
  const [ax, ay] = viewport.convertToViewportPoint(block.x, block.y);
  const [bx, by] = viewport.convertToViewportPoint(block.x + block.w, block.y + block.h);
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay)
  };
}

function placeBlock(node, viewport, block) {
  const box = blockBox(viewport, block);
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
  // The type scales with the page, or a block that fitted at one zoom overflows
  // at the next. `scale` is the viewport's own, so this follows a pinch exactly.
  node.style.setProperty("--pdf-block-scale", String(viewport.scale || 1));
  node.style.zIndex = String(1 + (Number(block.z) || 0));
}

// ── No header any more ──────────────────────────────────────────────────
//
// A block used to carry Aa / ✎ / 🗑 on a bar across its own top, on EVERY
// block, whether or not the reader was doing anything with it — chrome that
// earns its keep only the moment a block is selected, and was permanent for
// all of them regardless. "Doesn't need to have Aa, edit and delete header,
// it's unnecessarily taking space" is exactly that: three buttons' worth of
// height taken off the block's own text, on every block on the page, for
// controls that act on at most one of them at a time.
//
// The three actions did not go away — they moved to the one place on this
// surface that already answers "what can I do with the thing I picked up":
// #inkRailBlock, over the page, wired in src/ui/ink-rail.js and painted the
// moment selectBlock (below) says something is selected. A lassoed stroke
// already worked this way (see #inkRailSelection) — a block picked up by a
// click is the same idea, one level up.
//
// What is left on the block itself is the resize grip, because a corner you
// drag to resize is not chrome to click through — it is the shape of the box
// you are changing, in the box you are changing it. Everything else about
// the block IS the drag handle now: see handleBlockPointerDown, which begins
// a move on any press that does not land on the grip.
function buildBlock(block) {
  const node = document.createElement("div");
  node.className = PDF_BLOCK_CLASS;
  node.dataset.pdfBlock = block.id;
  node.dataset.pdfBlockKind = block.kind;

  // Still asked for the body's own class below — a picture's body is not
  // rendered markdown and must not say it is (see the comment on that class
  // a few lines down).
  const isImage = block.kind === PDF_BLOCK_IMAGE;

  const body = document.createElement("div");
  // ── `rendered` on a PICTURE was costing the picture most of its own frame ──
  //
  // Both kinds of block used to carry it. On a text block it is right and load-
  // bearing: the body holds markdown put through the same pipeline as a note, and
  // every rule that styles that output is written against `.rendered`. On a
  // picture block there is no markdown — paintBlock puts a bare <img class=
  // "pdf-block-img"> in here — and the class dragged in `.rendered img`
  // (styles/06-rendered.css), which at one class plus one type OUTRANKS a single
  // class and so beat .pdf-block-img on four properties at once:
  //
  //   height: auto                    …killed the height: 100% that fills the frame
  //   margin: 1rem auto               …the literal gap that was reported
  //   border-radius                   …rounded a picture meant to fill its box
  //   max-width: var(--visual-max-width)  …a Style setting for the notes reading
  //                                       column, 50% on desktop — so the picture
  //                                       was capped at HALF the block sized to its
  //                                       own aspect ratio, and the rest was buffer
  //
  // The block is sized from the image's own ratio when it is dropped
  // (addDocumentImageBlock), so with the class gone the picture fills it exactly.
  body.className = isImage ? "pdf-block-body" : "pdf-block-body rendered";

  const grip = document.createElement("span");
  grip.className = "pdf-block-grip";
  grip.dataset.pdfBlockAction = "resize";
  grip.title = "Drag to resize";

  node.append(body, grip);
  return node;
}

// Everything a reader chose about how this block looks, onto the node — as data
// attributes and two custom properties, with every actual value in
// styles/58-block-style.css. Nothing here picks a colour: a fill and an ink are
// TOKENS resolved per theme (see ./block-style.js), so the same block reads
// correctly on ten themes and on an inverted page, which a hex written into an
// inline style could not do.
function paintBlockStyle(node, block) {
  const style = blockStyle(block);
  node.dataset.blockFill = style.fill;
  node.dataset.blockFrame = style.frame;
  node.dataset.blockAlign = style.align;
  node.classList.toggle("is-fit", style.fit);
  node.style.setProperty("--pdf-block-fill", `var(${blockFillVar(style.fill)})`);
  const ink = blockInkVar(style.ink);
  // Removed rather than set to a fallback: with no property the body inherits
  // the theme's own text colour, which is what "default" means and what a block
  // has always done.
  if (ink) node.style.setProperty("--pdf-block-ink", `var(${ink})`);
  else node.style.removeProperty("--pdf-block-ink");

  // ── Every optional value is an ATTRIBUTE that is there or is not ─────────
  //
  // Not a property with a fallback. The rules in styles/58-block-style.css
  // switch on the attribute's presence, so a block nobody has sized matches
  // exactly the rules it matched before any of this existed — rather than the
  // new rule with the old value threaded through it, which is the same pixels
  // right up until the day somebody edits the fallback.
  //
  // The numbers are in POINTS and are multiplied by the viewport scale in CSS,
  // which is what makes "18pt" the same size at every zoom and in an export: on
  // this surface one CSS pixel at scale 1 IS one PDF point.
  setBlockNumber(node, "blockSize", "--pdf-block-size", style.size);
  setBlockNumber(node, "blockCodeSize", "--pdf-block-code-size", style.codeSize);
  setBlockNumber(node, "blockImageWidth", "--pdf-block-image-width", style.imageWidth);
  if (style.codeWrap) node.dataset.blockCodeWrap = "";
  else delete node.dataset.blockCodeWrap;

  // ── The face ─────────────────────────────────────────────────────────────
  //
  // resolveFontFamily (src/ui/fonts.js) both fetches the webfont and returns the
  // stack to paint with meanwhile, and it is the one door every font choice in
  // the app goes through. Called only when the choice has CHANGED: this runs for
  // every block on a page at every repaint, and while the call is cheap and
  // idempotent, asking for a font a hundred times a second is not a thing to
  // write down and leave for somebody to find.
  if (node.dataset.blockFont !== style.font) {
    if (style.font === "inherit") {
      delete node.dataset.blockFont;
      node.style.removeProperty("--pdf-block-font");
    } else {
      node.dataset.blockFont = style.font;
      node.style.setProperty("--pdf-block-font", resolveFontFamily(style.font));
    }
  }
}

// An optional number, as the attribute the CSS switches on plus the value it
// reads. Absent is absent: an empty attribute would still match [data-…].
function setBlockNumber(node, attribute, property, value) {
  if (value === null || value === undefined) {
    delete node.dataset[attribute];
    node.style.removeProperty(property);
    return;
  }
  node.dataset[attribute] = String(value);
  node.style.setProperty(property, String(value));
}

// ── What a block HOLDS, for the controls that are about its contents ───────
//
// A fenced listing and a picture are the two pieces of markdown on this surface
// with a knob worth having, and the rows that carry those knobs are shown only
// when the block has one — a control acting on nothing is clutter, and it is
// also a control that looks broken.
//
// Read off the SOURCE rather than off the rendered body, which the popover could
// also have queried: the source is the same answer in both places the panel is
// arranged, it is the same answer before the render has finished, and it does
// not depend on which pass of enhanceRenderedMarkdown has run yet.
function blockHolds(block) {
  const md = String(block?.md || "");
  return {
    // A fence, or a line indented into a code block. Both are what Prism will
    // end up drawing a <pre> for.
    code: /(^|\n) {0,3}(```|~~~)/.test(md) || /(^|\n)(?: {4}|\t)\S/.test(md),
    image: /!\[[^\]]*\]\(/.test(md) || /<img\b/i.test(md)
  };
}

function paintBlock(node, block) {
  const body = node.querySelector(".pdf-block-body");
  paintBlockStyle(node, block);
  // A block the keyboard is talking about. Said with a class for the reason
  // is-editing is: the ring is drawn in CSS beside every other state this block
  // can be in, rather than as an inline style that would have to be unset.
  node.classList.toggle("is-selected", selectedId === block.id);
  // While a block is being edited its text is in the sheet, not here. Said with
  // a class rather than by hiding the body: the block has to keep its box on the
  // page — it is what the reader is looking at the editor ABOUT — and a hidden
  // body would collapse the frame to its bar.
  node.classList.toggle("is-editing", editingId === block.id);
  if (block.kind === PDF_BLOCK_IMAGE) {
    // Rebuilt only when the source actually changed. This runs as every page
    // paints and on every drag frame's repaint, and re-assigning an <img>'s src
    // to the value it already holds is a decode and a flash of nothing on some
    // engines — over a photograph the reader is dragging.
    let img = body.querySelector("img");
    if (!img) {
      body.innerHTML = "";
      img = document.createElement("img");
      img.className = "pdf-block-img";
      img.decoding = "async";
      body.appendChild(img);
    }
    // Compared with the SOURCE this element was last given, not with its live
    // src: the resolve pass below swaps a canonical Storage URL for a signed
    // one (and hydrateLocalImages a recall-img: token for a blob), and putting
    // the canonical URL back on every paint — every drag frame — would throw
    // that away each time, and show a private bucket's refusal in its place.
    if (img.dataset.blockSrc !== block.src) {
      img.dataset.blockSrc = block.src || "";
      img.removeAttribute("data-canonical-src");
      delete img.dataset.signRetried;
      delete img.dataset.bucketRetried;
      img.setAttribute("src", block.src || "");
    }
    img.alt = block.alt || "";
    return;
  }
  // An empty block says so. A transparent rectangle you cannot find again is
  // exactly what one added and not yet typed into would otherwise be.
  if (!block.md.trim()) {
    renderedMarkdown.delete(body);
    body.innerHTML = '<p class="pdf-block-empty">Empty — press &#9998; to write</p>';
    return;
  }
  // ── The same renderer the Notes panel uses, and why it was not ──────────
  //
  // This was `markdownToSafeHtml`, which is marked + DOMPurify and nothing
  // else: no KaTeX, no Prism, no mermaid, no clozes, no image or diagram
  // controls. A block is markdown dropped on a page of working, and working is
  // exactly where the mathematics is — so the one surface in this app most
  // likely to hold `$…$` was the one surface that rendered it as the literal
  // characters. renderMarkdown + enhanceRenderedMarkdown is the pair
  // src/notes/note-editor-kit.js already uses for the same reason, and it is
  // what "the full markdown ecosystem we have in the notes panel" means.
  //
  // Guarded on the markdown actually having CHANGED, which the old one-line
  // innerHTML did not need to be. This runs as every page paints and on every
  // frame of a drag, renderMarkdown is async and does real work (a lex, a
  // sanitize, a KaTeX pass, possibly a mermaid render), and firing one per
  // frame at a block being dragged would queue renders faster than they finish.
  // Same argument, and the same shape, as the image branch above.
  if (renderedMarkdown.get(body) === block.md) {
    // Same words, possibly a different box: a block whose height follows its
    // text has to be re-measured when the page zooms or the reader drags it
    // narrower, and neither of those changes the markdown.
    fitBlockHeight(node, block);
    return;
  }
  renderedMarkdown.set(body, block.md);
  renderBlockBody(body, block.md, node, block);
}

// ── A block that is as tall as what is in it ───────────────────────────────
//
// The box is dragged to a size and the text inside it is whatever length it is,
// so the two disagree constantly: type three more words into a block sized to
// two lines and the third line is behind `overflow: auto`, in a 90pt rectangle
// on a page nobody scrolls inside. `fit` says the height is not the reader's to
// choose — the words decide it, and the corner grip sets the WIDTH.
//
// ── Why the measurement takes the box apart first ──────────────────────────
//
// The obvious read is body.scrollHeight, and it can only ever make a block
// TALLER: the body is a flex child stretched to whatever height the block has,
// so once the box is bigger than the text, scrollHeight is the box and the block
// can never come back down. Asking a stretched box how tall its contents are is
// asking the wrong element. So the stretch is taken off for the length of one
// synchronous measurement and put straight back — two forced layouts, on the few
// blocks that asked for this, and never during a gesture.
function fitBlockHeight(node, block) {
  if (gestureLive || block.kind === PDF_BLOCK_IMAGE || !blockStyle(block).fit) return false;
  const viewport = pdfPageViewport(block.page);
  const body = node.querySelector(".pdf-block-body");
  if (!viewport || !body) return false;
  const scale = viewport.scale || 1;
  // The bar, the borders — everything of the block that is not the body.
  const chrome = node.offsetHeight - body.clientHeight;
  body.style.flex = "none";
  body.style.height = "auto";
  const content = body.scrollHeight;
  body.style.flex = "";
  body.style.height = "";
  const wanted = Math.max(PDF_BLOCK_MIN_HEIGHT, Math.round((chrome + content) / scale));
  // A point of slack, because the round trip through points and back is not
  // exact and a block that rewrote itself by a pixel on every paint would be an
  // autosave and a sync push per repaint.
  if (Math.abs(wanted - block.h) <= 1) return false;
  queueFit(block.id, wanted);
  return true;
}

// ── ...and why the write is a frame away ───────────────────────────────────
//
// fitBlockHeight is called from inside the paint, and writeBlocks calls
// onBlocksChanged, which repaints. Writing where it is measured would therefore
// re-enter the paint loop that is still running — from inside its own forEach —
// on the way to a value the next pass agrees with anyway. Deferred by a frame it
// is an ordinary change made from outside, and the map collapses a page of
// blocks that all grew at once into one write, one autosave and one push.
const pendingFits = new Map();
let fitFrame = 0;

function queueFit(id, height) {
  pendingFits.set(id, height);
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    const wanted = new Map(pendingFits);
    pendingFits.clear();
    if (gestureLive) return;
    const blocks = documentBlocks();
    let touched = false;
    const next = blocks.map((entry) => {
      const h = wanted.get(entry.id);
      if (!h || Math.abs(h - entry.h) <= 1) return entry;
      touched = true;
      // The TOP edge is what stays still, which in a coordinate space whose y
      // runs up the page means moving the origin — the same arithmetic the
      // resize grip does, and for the same reason: a block that grew downwards
      // from its own bottom edge would walk up the page as somebody typed.
      return { ...entry, h, y: entry.y + (entry.h - h), at: Date.now() };
    });
    // Not undoable: this is the block agreeing with its own text, not a step the
    // reader took. Ctrl+Z after typing should take back the typing.
    if (touched) writeBlocks(next, { undoable: false });
  });
}

// ── The width, once, on the way in ─────────────────────────────────────────
//
// Height follows the text continuously (fitBlockHeight, above) — width does
// not, and cannot: markdown reflows at whatever width it is given, so there is
// no "natural width" for a paragraph the way there is a natural height for one
// at a fixed width. But the STARTING width is a different question, and a
// short answer — a label, a single equation, one word typed into a block that
// defaults to 240pt — sitting in a box sized for a paragraph is exactly the
// "predefined size" the height fix above does not reach.
//
// So this runs once: the first time a block goes from no text to some, and
// only while its width is still the untouched default. It measures how wide
// the words actually want to be and shrinks to that, clamped so it can never
// make a block WIDER than the default it started at — a real paragraph, whose
// unwrapped width would exceed 240pt, always clamps straight back to
// unchanged, so this never fights the common case and only ever helps the
// short one. A block a reader has dragged the corner of no longer has the
// default width and this never runs on it again.
function shouldShrinkBlockWidth(block) {
  return block.kind !== PDF_BLOCK_IMAGE && block.w === PDF_BLOCK_DEFAULT_WIDTH;
}

// One-shot per block, consumed the first time its render finishes — not a
// style the block carries, so it lives here rather than on the record.
const awaitingWidthShrink = new Set();

function shrinkBlockWidthToContent(node, block) {
  if (gestureLive || !shouldShrinkBlockWidth(block)) return false;
  const viewport = pdfPageViewport(block.page);
  const body = node.querySelector(".pdf-block-body");
  if (!viewport || !body) return false;
  const scale = viewport.scale || 1;
  // The bar, the borders, the padding — everything of the block that is not
  // the body's own content box — measured the same way fitBlockHeight measures
  // its chrome, one axis over.
  const chrome = node.offsetWidth - body.clientWidth;
  // The exact same escape fitBlockHeight uses, one axis over: the body is a
  // flex child stretched to the block's own width, so `scrollWidth` as-is just
  // answers with the block's width back. `flex: none` takes the stretch off
  // and `width: max-content` is what lets the browser compute the content's
  // own preferred width — the width it would take with nothing forcing it to
  // wrap — for the length of one synchronous measurement, put straight back.
  body.style.flex = "none";
  body.style.width = "max-content";
  const content = body.scrollWidth;
  body.style.flex = "";
  body.style.width = "";
  const wanted = Math.min(
    PDF_BLOCK_DEFAULT_WIDTH,
    Math.max(PDF_BLOCK_MIN_WIDTH, Math.round((chrome + content) / scale))
  );
  // Nothing shorter than the default was found — the common case for any real
  // paragraph — so there is nothing to shrink and nothing to write.
  if (wanted >= PDF_BLOCK_DEFAULT_WIDTH) return false;
  // Not undoable, for the same reason queueFit's height write is not: this is
  // the block agreeing with its own first words, not a step the reader took.
  writeBlocks(documentBlocks().map((entry) => (
    entry.id === block.id ? { ...entry, w: wanted, at: Date.now() } : entry
  )), { undoable: false });
  return true;
}

// What each block body was last rendered FROM. A WeakMap rather than a dataset
// attribute: the markdown can be a page of text, and the entry goes when the
// node does.
const renderedMarkdown = new WeakMap();

// The async tail of paintBlock. Separate so the paint itself stays synchronous —
// every caller of paintDocumentBlocks is a paint loop, and none of them can
// await.
//
// The re-check after the render is the ordinary hazard of an async paint: the
// reader can drag, delete or retype a block while its markdown is being
// rendered, and a late render must not put stale HTML back. `renderedMarkdown`
// is the record of what this body is SUPPOSED to be showing, so a mismatch means
// a newer render already owns it.
async function renderBlockBody(body, md, node = null, block = null) {
  try {
    await renderMarkdown(body, md);
    if (renderedMarkdown.get(body) !== md || !body.isConnected) return;
    await enhanceRenderedMarkdown(body);
    if (renderedMarkdown.get(body) !== md || !body.isConnected) return;
    // The words are on the page now, so this is the first moment a block that
    // follows its text can be measured. Before the images below, which is a
    // compromise: a picture that has not decoded yet has no height to include,
    // and hydrateLocalImages does not report when one arrives. The next paint
    // catches it, and the alternative is a load listener per image on a path
    // that repaints on every drag frame.
    if (node && block) fitBlockHeight(node, block);
    // The one-shot width measurement rides the same first render: the words
    // have to be on the page to ask how wide they want to be, and this is the
    // only place that is ever true for a block whose text just went from
    // nothing to something. Consumed here whether or not it actually shrinks
    // anything, so a paragraph that clamped back to unchanged is not measured
    // again on its next edit.
    if (node && block && awaitingWidthShrink.delete(block.id)) {
      shrinkBlockWidthToContent(node, block);
    }
    // The block's own images, which reach here as recall-img: tokens when they
    // were added offline — the same hydrate paintDocumentBlocks does for the
    // image blocks beside them.
    await hydrateLocalImages(body);
    // ...and the ones already uploaded, which reach here as canonical URLs the
    // private bucket will not serve as they stand — the same swap a note's
    // pictures get (cloud/storage-urls.js).
    await resolveStorageImages(body);
  } catch (error) {
    console.warn("Could not render a block", error);
  }
}

// Called as each page finishes painting, through the same hook the ink and the
// note badges take — pdf-view.js must not import this module back.
export function paintDocumentBlocks(pageNumber) {
  const viewport = pdfPageViewport(pageNumber);
  const blocks = documentBlocks(pageNumber);
  const pageEl = pdfPageElement(pageNumber);
  if (!pageEl || !viewport) return;
  // A page with no blocks and no layer is left alone, exactly as a page with no
  // ink is: a div per page of a three-hundred-page paper is a real cost for
  // nothing.
  if (!blocks.length && !pageEl.querySelector(`.${PDF_BLOCK_LAYER_CLASS}`)) return;
  const layer = blockLayer(pageNumber);
  if (!layer) return;
  const wanted = new Set(blocks.map((block) => block.id));
  [...layer.children].forEach((node) => {
    if (!wanted.has(node.dataset.pdfBlock)) node.remove();
  });
  blocks.forEach((block) => {
    let node = layer.querySelector(`[data-pdf-block="${block.id}"]`);
    if (!node) { node = buildBlock(block); layer.appendChild(node); }
    placeBlock(node, viewport, block);
    paintBlock(node, block);
  });
  // An image added while offline is parked in the outbox under a recall-img:
  // token; this is what turns that token into something the page can show,
  // exactly as it does for a picture in a note. A no-op when there are none.
  hydrateLocalImages(layer);
  // And an uploaded one is given a URL that loads — from the reader's bucket or
  // a Supabase signature, whichever holds it. Image blocks were never given one
  // before, and showed only when the service worker happened to have cached
  // the picture.
  resolveStorageImages(layer).catch((error) => console.warn("Could not resolve the block images", error));
}

export function repaintDocumentBlocks() {
  const view = el.documentView;
  if (!view) return;
  view.querySelectorAll(".pdf-page[data-page-number]").forEach((pageEl) => {
    const pageNumber = Number(pageEl.dataset.pageNumber);
    if (pageNumber) paintDocumentBlocks(pageNumber);
  });
}

// ── Adding one ─────────────────────────────────────────────────────────────

// Placed at a point on a page, clamped so a block added while scrolled to the
// foot of one is not created off it.
export function addDocumentBlock(pageNumber, at = null) {
  const viewport = pdfPageViewport(pageNumber);
  if (!viewport) return null;
  const [pageWidth, pageHeight] = [viewport.viewBox[2] - viewport.viewBox[0], viewport.viewBox[3] - viewport.viewBox[1]];
  const blocks = documentBlocks();
  const wanted = at || { x: pageWidth / 2, y: pageHeight / 2 };
  const inherited = freshBlockStyle(PDF_BLOCK_TEXT);
  const block = {
    // Unique across the DECK, not the surface: a block id is a sync key, and a
    // notebook minting the same one as a block over the paper beside it would
    // make the two records one record on the next merge.
    id: freshBlockId(new Set(allDocumentBlocks().map((b) => b?.id))),
    page: Number(pageNumber),
    x: Math.round(Math.max(12, Math.min(pageWidth - PDF_BLOCK_DEFAULT_WIDTH - 12, wanted.x - (PDF_BLOCK_DEFAULT_WIDTH / 2)))),
    y: Math.round(Math.max(12, Math.min(pageHeight - PDF_BLOCK_DEFAULT_HEIGHT - 12, wanted.y - (PDF_BLOCK_DEFAULT_HEIGHT / 2)))),
    w: PDF_BLOCK_DEFAULT_WIDTH,
    h: PDF_BLOCK_DEFAULT_HEIGHT,
    z: blocks.length,
    kind: PDF_BLOCK_TEXT,
    md: "",
    at: Date.now(),
    ...(inherited ? { style: inherited } : {})
  };
  writeBlocks([...blocks, block]);
  setSelectedId(block.id);
  paintDocumentBlocks(pageNumber);
  beginBlockEdit(block.id);
  return block;
}

// ── ...and adding a picture ────────────────────────────────────────────────
//
// The upload goes through storeImageOrQueue, which is the one function in this
// app that knows what "offline" means for an image: it uploads, and if it
// cannot, it parks the bytes in the outbox under a `recall-img:` token that
// paintDocumentBlocks hydrates into something the page can show. Reusing it is
// what makes a photograph dropped on a page behave like one pasted into a note,
// including the part where it uploads by itself later.
//
// The block is sized from the image's own aspect ratio, capped to fit the page
// with a margin — an 8-megapixel photograph placed at a text block's default
// 240x90 would be an unreadable letterbox that the reader then has to drag out
// to something sensible before they can see what it is.
export async function addDocumentImageBlock(pageNumber, file, at = null) {
  const viewport = pdfPageViewport(pageNumber);
  if (!viewport) return null;
  if (!file || !String(file.type || "").startsWith("image/")) {
    showToast("That file is not an image", "error");
    return null;
  }
  const [pageWidth, pageHeight] = [viewport.viewBox[2] - viewport.viewBox[0], viewport.viewBox[3] - viewport.viewBox[1]];
  const ratio = await imageAspectRatio(file);
  const maxW = Math.max(PDF_BLOCK_MIN_WIDTH, pageWidth * 0.62);
  const maxH = Math.max(PDF_BLOCK_MIN_HEIGHT, pageHeight * 0.42);
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) { h = maxH; w = h * ratio; }

  const stored = await storeImageOrQueue(file);
  if (stored.error) {
    showToast(stored.error === "not-signed-in"
      ? "Sign in to add pictures — they are stored with your deck"
      : "Could not add that image", "error");
    return null;
  }
  if (stored.queued) showToast("Image saved here — it uploads when you're back online", "info");

  const blocks = documentBlocks();
  const wanted = at || { x: pageWidth / 2, y: pageHeight / 2 };
  const inherited = freshBlockStyle(PDF_BLOCK_IMAGE);
  const block = {
    id: freshBlockId(new Set(allDocumentBlocks().map((b) => b?.id))),
    page: Number(pageNumber),
    x: Math.round(Math.max(12, Math.min(pageWidth - w - 12, wanted.x - (w / 2)))),
    y: Math.round(Math.max(12, Math.min(pageHeight - h - 12, wanted.y - (h / 2)))),
    w: Math.round(w),
    h: Math.round(h),
    z: blocks.length,
    kind: PDF_BLOCK_IMAGE,
    md: "",
    src: stored.url,
    alt: "",
    at: Date.now(),
    ...(inherited ? { style: inherited } : {})
  };
  writeBlocks([...blocks, block]);
  setSelectedId(block.id);
  paintDocumentBlocks(pageNumber);
  return block;
}

// Width over height, from the file itself. 4/3 when the browser cannot decode it
// — a shape rather than a failure, since the picture may still be perfectly
// displayable and the reader can drag it to whatever they want anyway.
async function imageAspectRatio(file) {
  const url = URL.createObjectURL(file);
  try {
    const size = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    });
    if (!size?.w || !size?.h) return 4 / 3;
    return size.w / size.h;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Editing ────────────────────────────────────────────────────────────────

export function isEditingBlock() {
  return Boolean(editingId);
}

// ── Opening the editor ─────────────────────────────────────────────────────
//
// The text goes into the sheet (./pdf-block-editor.js), which is the Notes
// panel's own editor arranged as a window. `editingId` still says which block is
// being edited — the paint reads it to hide the block's body while its text is
// somewhere else — but the <textarea> it used to point at is gone.
//
// An IMAGE block's editor holds its description and not markdown, which is the
// distinction its ✎ has always made (see buildBlock). It is the same sheet with
// a different question at the top of it.
function beginBlockEdit(id) {
  commitBlockEdit();
  const block = documentBlocks().find((entry) => entry.id === id);
  if (!block) return;
  const isImage = block.kind === PDF_BLOCK_IMAGE;
  editingId = id;
  // The quick-actions popover is about a block sitting on the page; the text
  // is about to leave it for the sheet, and a strip of action buttons under a
  // window that has just buried the thing they act on is clutter with nothing
  // to point at. beginBlockEdit does not go through setSelectedId — selection
  // and editing are deliberately separate facts — so this is the one place
  // that has to say so.
  closeBlockActionsPopover();
  repaintDocumentBlocks();
  openBlockEditor({
    value: isImage ? block.alt : block.md,
    title: isImage ? "Describe this image" : "Edit this block",
    placeholder: isImage
      ? "What is in the picture — read out when it cannot be shown"
      : "Markdown — the same as a note",
    kind: block.kind,
    style: blockStyle(block),
    has: blockHolds(block),
    // Live, and that is the point of putting the controls in the window at all:
    // the block stays on the page behind the sheet (.pdf-block.is-editing keeps
    // it lit rather than hiding it), so a fill or a size chosen here is seen on
    // the paper where it will live, at the size it will be, rather than guessed
    // at and checked after pressing Done.
    onStyle: (patch) => writeBlockStyle(id, patch),
    onDone: (text) => writeBlockText(id, text)
  });
}

// ── Restyling ──────────────────────────────────────────────────────────────
//
// `patch` is whichever controls were touched, so a picker can send one key
// without holding the other six.
//
// The write is the whole normalised bag or NO KEY AT ALL — see documentBlocks on
// why a default style must never be written. Putting every control back where it
// started genuinely removes the field, so a block that has been styled and
// unstyled is the same record as one that never was.
export function writeBlockStyle(id, patch) {
  const blocks = documentBlocks();
  const block = blocks.find((entry) => entry.id === id);
  if (!block) return null;
  const next = normalizeBlockStyle({ ...blockStyle(block), ...(patch || {}) });
  const bare = isDefaultBlockStyle(next);
  const was = blockStyle(block);
  // Nothing to do only when the VALUES agree and the record already says so the
  // same way — a block still carrying a bag of defaults from an older write has
  // the same values and still owes the removal.
  const sameValues = Object.keys(next).every((key) => next[key] === was[key]);
  const sameShape = Boolean(block.style) === !bare;
  if (sameValues && sameShape) return next;
  // Keyed on the FIELD as well as the block, so a run of keystrokes in the size
  // box is one undo step while size-then-face-then-frame is three. Coalescing on
  // the block alone would fold every control a reader touched inside a second
  // into one step, which is a Ctrl+Z that takes back decisions nobody asked it
  // to.
  const coalesce = `style:${id}:${Object.keys(patch || {}).sort().join(",")}`;
  writeBlocks(blocks.map((entry) => {
    if (entry.id !== id) return entry;
    const { style: _drop, ...rest } = entry;
    return bare ? { ...rest, at: Date.now() } : { ...rest, style: next, at: Date.now() };
  }), { coalesce });
  // Remembered on this device, so the NEXT block starts here — see
  // blockStylePreference. Written from the whole bag rather than from the patch:
  // what a reader means by "like the last one" is how the last one ended up, not
  // the one control they touched most recently.
  writeBlockStylePreference(block.kind, next);
  repaintDocumentBlocks();
  return next;
}

// The style a new block starts with, and the two things that are true of it:
// it is whatever the reader last chose on this device, and when that is the
// default it is NOTHING — a fresh device still writes a record with no style key
// on it, exactly as it did before any of this existed.
function freshBlockStyle(kind) {
  const remembered = blockStylePreference(kind);
  return isDefaultBlockStyle(remembered) ? null : remembered;
}

// One place that turns "the editor closed" into a write, whichever way it
// closed. `text` is null for a cancel, which is the one case that writes
// nothing at all.
function writeBlockText(id, text) {
  editingId = null;
  if (text === null) { repaintDocumentBlocks(); syncBlockActionsPopover(); return; }
  const blocks = documentBlocks();
  const block = blocks.find((entry) => entry.id === id);
  const field = block?.kind === PDF_BLOCK_IMAGE ? "alt" : "md";
  if (block && block[field] !== text) {
    // The one width-shrink pass this block ever gets is armed here, off the
    // OLD value: going from nothing typed to something is what "a block's
    // first words" means, and it is the one transition renderBlockBody can
    // tell apart from every later edit of the same block.
    if (field === "md" && !block.md.trim() && text.trim()) awaitingWidthShrink.add(id);
    writeBlocks(blocks.map((entry) => (entry.id === id ? { ...entry, [field]: text, at: Date.now() } : entry)));
  }
  repaintDocumentBlocks();
  // The block was still selected going into the sheet — editing does not
  // change that — so it is still selected coming out, and its quick actions
  // belong back at it, whether the sheet was committed or cancelled.
  syncBlockActionsPopover();
}

// Anything open, committed. Called on the way out of the view, on a press
// elsewhere on the page, and before a drag — every place that used to read the
// textarea's value directly.
//
// The sheet's own close is what calls writeBlockText, so this does not write
// anything itself: two paths into one write is how the two came to disagree
// about what "the current text" was.
export function commitBlockEdit() {
  if (!editingId) return false;
  if (!closeBlockEditor(true)) {
    // The sheet is not up — an edit that was begun and then lost its window.
    // Nothing to read, so the only thing owed is putting the block back.
    editingId = null;
    repaintDocumentBlocks();
  }
  return true;
}

// ── Dragging and resizing ──────────────────────────────────────────────────

function beginGesture(event, node, mode) {
  const id = node.dataset.pdfBlock;
  const block = documentBlocks().find((entry) => entry.id === id);
  if (!block) return;
  const viewport = pdfPageViewport(block.page);
  if (!viewport) return;
  // Points per CSS pixel, read once. The viewport's own scale, so a drag is the
  // same distance on the page at every zoom.
  const perPixel = 1 / (viewport.scale || 1);
  const start = { x: event.clientX, y: event.clientY };
  // A block whose height follows its text is resized in one dimension: the grip
  // still sets the width, and the words still set the height. A grip that
  // dragged the height to a number the very next paint overwrote would be a
  // control that visibly does not work.
  const widthOnly = mode === "resize" && blockStyle(block).fit;
  let live = { ...block };
  let frame = 0;
  gestureLive = true;

  const apply = () => { frame = 0; placeBlock(node, viewport, live); };

  // ── Whose pointer this gesture is ───────────────────────────────────────
  //
  // Both listeners below go on `document`, because a drag has to keep tracking
  // the pointer once it leaves the block — but `document` hears every pointer
  // in the app, pen and mouse and every finger of a multi-touch gesture alike,
  // and neither listener checked which one was theirs. `finish` did not even
  // take the event it was called with; it read the ORIGINAL pointerdown's id
  // for releasePointerCapture and otherwise ignored the argument outright. The
  // one pointer this surface used to see at a time was the mouse or the one
  // stylus in a reader's hand, so the bug had nothing else to fire on. It
  // stopped being harmless the moment every press on a block — not just its
  // bar and grip — could start one of these: a block picked up and immediately
  // let go (a plain click, to select it) still opens this gesture, and ANY
  // unrelated pointerup anywhere else in the document — a pen stroke lifting,
  // a lasso closing — ended it early and could feed a stray pointermove from a
  // second pointer into `live` as this block's own move.
  const pointerId = event.pointerId;

  // ── Claimed immediately, or claimed on proof ────────────────────────────
  //
  // A resize is unambiguous the instant it starts — the grip IS the drag, and
  // there is no tap reading of a press on a corner handle — so it takes the
  // pointer the way every gesture here always has. A press on the block's own
  // body is not unambiguous: it is what "select this block" looks like right
  // up until it has moved PDF_BLOCK_DRAG_SLOP_PX, and claiming the pointer —
  // and repainting the block — before that point is what turned a plain tap
  // into a gesture that merely undid itself rather than one that never
  // started. `captured` stays false until the proof arrives, and nothing
  // below moves the block or holds the pointer while it is.
  let captured = mode === "resize";
  if (captured) {
    try { node.setPointerCapture(pointerId); } catch (_) { /* synthetic */ }
    // A resize is a drag from the first pixel — see above — so the quick
    // actions popover, which is about a block sitting still to be acted on,
    // has nothing to float over here either. finish() below brings it back.
    closeBlockActionsPopover();
  }

  const move = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    if (!captured) {
      const travelled = Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y);
      if (travelled < PDF_BLOCK_DRAG_SLOP_PX) return;
      captured = true;
      // Only now, on the same move that proved this is a drag — the earlier
      // pointerdown deliberately left it alone so a plain tap still reaches
      // the browser's own click and everything bound to it.
      moveEvent.preventDefault();
      try { node.setPointerCapture(pointerId); } catch (_) { /* synthetic */ }
      // The instant a body press proves itself a drag, for the same reason
      // the resize branch above closes it immediately rather than on its own
      // first move.
      closeBlockActionsPopover();
    }
    const dx = (moveEvent.clientX - start.x) * perPixel;
    // PDF y runs UP the page and the screen's runs down, so a downward drag is a
    // decreasing y. Getting this backwards is the classic way a box drifts the
    // wrong way under a finger.
    const dy = -(moveEvent.clientY - start.y) * perPixel;
    if (mode === "drag") {
      live = { ...block, x: Math.round(block.x + dx), y: Math.round(block.y + dy) };
    } else {
      // The grip is the bottom-right on screen, which is the bottom-right in
      // points too — so it grows the width and moves the origin DOWN.
      const w = Math.max(PDF_BLOCK_MIN_WIDTH, block.w + dx);
      const h = widthOnly ? block.h : Math.max(PDF_BLOCK_MIN_HEIGHT, block.h - dy);
      live = { ...block, w: Math.round(w), h: Math.round(h), y: Math.round(block.y + (block.h - h)) };
    }
    if (!frame) frame = requestAnimationFrame(apply);
  };

  const finish = (upEvent) => {
    if (upEvent && upEvent.pointerId !== pointerId) return;
    gestureLive = false;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    // A press that never crossed the slop was never captured and never moved
    // `live` off the block's own values — nothing to release and nothing to
    // re-place.
    if (captured) {
      try { node.releasePointerCapture(pointerId); } catch (_) { /* already gone */ }
      placeBlock(node, viewport, live);
    }
    // The gesture is over, however it resolved — a tap that never crossed the
    // slop (the popover was never closed for it), a drag that settled the
    // block somewhere new, or a resize — and in every one of those the block
    // is still selected. Its quick actions belong back at it, anchored to
    // wherever it now sits.
    syncBlockActionsPopover();
    // A press that ended where it started must not cost an autosave and a push.
    if (live.x === block.x && live.y === block.y && live.w === block.w && live.h === block.h) return;
    writeBlocks(documentBlocks().map((entry) => (entry.id === id ? { ...entry, ...live, at: Date.now() } : entry)));
  };

  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

// One delegated listener, bound by src/main.js on the scroller. Returns true
// when the press belonged to a block, so the caller knows the paper did not get
// it — which is what stops a pen press meant to move a block from also drawing.
export function handleBlockPointerDown(event) {
  const node = event.target.closest?.(`.${PDF_BLOCK_CLASS}`);
  if (!node) {
    // A press anywhere else finishes an edit in progress, which is how every
    // other editor in this app commits — and puts down whatever was picked up,
    // for the same reason: the keyboard must not still be pointing at a block
    // the reader has visibly moved on from.
    if (editingId) commitBlockEdit();
    // ...unless the press was inside the style popover or the block's own
    // actions on the rail, both of which are ABOUT the selected block and float
    // OUTSIDE it. Dismissing the selection there would close either on its own
    // first press.
    if (!event.target.closest?.(".pdf-block-style-pop, .pdf-block-actions-pop, #inkRailBlock")) selectBlock(null);
    return false;
  }
  // Resize is the one action a block still keeps on itself, because the grip
  // IS the shape of the box being changed, in the box being changed — every
  // other action lives in #inkRailBlock now (src/ui/ink-rail.js), reached once
  // the block below has been picked up.
  const resizing = event.target.closest("[data-pdf-block-action]")?.dataset.pdfBlockAction === "resize";
  // The text of a block being edited is in the sheet over the page, not in the
  // block — so a press on the block itself while its editor is open is a press
  // on the page, and it commits like any other.
  //
  // stopPropagation is unconditional and stays that way: it is what stands
  // the ink layer, the lasso and the pen's text tool down for this press (see
  // the block stand-downs in src/documents/pdf-ink.js and
  // src/notes/touch-selection.js), a concern that has nothing to do with
  // whether this press turns out to be a tap or a drag.
  //
  // preventDefault is NOT unconditional any more. A resize is always a drag
  // from the first pixel, so it is claimed here exactly as it always was; a
  // press on the block's body is, until proven otherwise, a plain tap meant
  // to select the block — and calling preventDefault on every one of those
  // discarded the browser's own click for a gesture that beginGesture's own
  // no-op guard was about to throw away anyway. beginGesture defers the call
  // to the moment a body press actually crosses PDF_BLOCK_DRAG_SLOP_PX, which
  // is the only moment it is actually true.
  event.stopPropagation();
  if (resizing) event.preventDefault();
  const id = node.dataset.pdfBlock;
  // Picked up by any press on it, whatever else that press goes on to do. This
  // is what the keyboard verbs and the rail's own actions are for, and it costs
  // nothing to be wrong about — a selection is a ring around a box, not a mode.
  selectBlock(id);
  // A press that moves the reader on to another block — or moves this one — is
  // not the popover's own block any more, and it floats OVER the page pinned to
  // where that block WAS.
  closeBlockStylePopover();
  commitBlockEdit();
  beginGesture(event, node, resizing ? "resize" : "drag");
  return true;
}

// ── What the keyboard can do with the block it is pointing at ──────────────
//
// Everything below is one verb, exported for the key map in src/main.js — which
// is where every other shortcut on this surface is already dispatched, and the
// one place that can see the pen's claims on the same keys.

export function selectedBlockId() {
  return selectedId;
}

// The kind of the block the keyboard is pointing at, or null for none — what
// src/ui/ink-rail.js asks to decide whether #inkRailBlock's Style/Edit buttons
// say "Style"/"Edit" or "Frame"/"Describe", the same distinction their labels
// always made when they lived on the block itself.
export function selectedBlockKind() {
  if (!selectedId) return null;
  return documentBlocks().find((block) => block.id === selectedId)?.kind || null;
}

export function selectBlock(id) {
  const next = id && documentBlocks().some((block) => block.id === id) ? id : null;
  if (next === selectedId) return next;
  setSelectedId(next);
  if (!next) closeBlockStylePopover();
  repaintDocumentBlocks();
  // After the repaint, so a freshly selected block's node already exists to
  // anchor to; closeBlockActionsPopover on deselect needs no such wait.
  if (next) syncBlockActionsPopover();
  else closeBlockActionsPopover();
  return next;
}

export function deleteBlock(id = selectedId) {
  if (!id) return false;
  const blocks = documentBlocks();
  if (!blocks.some((block) => block.id === id)) return false;
  if (editingId === id) commitBlockEdit();
  if (selectedId === id) { setSelectedId(null); closeBlockStylePopover(); closeBlockActionsPopover(); }
  writeBlocks(blocks.filter((entry) => entry.id !== id), { removed: id });
  repaintDocumentBlocks();
  return true;
}

// Offset, rather than placed exactly on top of the original: two identical boxes
// at identical coordinates are one box as far as anybody looking at the page can
// tell, and the copy is the one that ends up being dragged away from a stack
// nobody knew was there. The same reason ink's paste offsets itself.
const BLOCK_DUPLICATE_OFFSET = 14;

export function duplicateBlock(id = selectedId) {
  if (!id) return null;
  const blocks = documentBlocks();
  const block = blocks.find((entry) => entry.id === id);
  if (!block) return null;
  const copy = {
    ...block,
    id: freshBlockId(new Set(allDocumentBlocks().map((entry) => entry?.id))),
    x: block.x + BLOCK_DUPLICATE_OFFSET,
    y: block.y - BLOCK_DUPLICATE_OFFSET,
    z: blocks.length,
    at: Date.now()
  };
  writeBlocks([...blocks, copy]);
  setSelectedId(copy.id);
  repaintDocumentBlocks();
  // After the repaint: the copy's node does not exist until this paints it,
  // and syncBlockActionsPopover's lookup would find nothing before that.
  syncBlockActionsPopover();
  return copy;
}

// In points, and the same two steps a lassoed stroke moves by — a block and the
// handwriting around it have to be nudgeable to the same places or they cannot
// be lined up with each other.
export const BLOCK_NUDGE_STEP = 1;

export const BLOCK_NUDGE_STEP_COARSE = 10;

export function nudgeBlock(dx, dy, { coarse = false, id = selectedId } = {}) {
  if (!id || (!dx && !dy)) return false;
  const step = coarse ? BLOCK_NUDGE_STEP_COARSE : BLOCK_NUDGE_STEP;
  const blocks = documentBlocks();
  if (!blocks.some((block) => block.id === id)) return false;
  writeBlocks(blocks.map((entry) => (entry.id === id
    // dy is given the way the SCREEN means it — down is positive — and turned
    // over here, because every caller is a key press and no key press should
    // have to know which way a PDF's y runs.
    ? { ...entry, x: entry.x + (dx * step), y: entry.y - (dy * step), at: Date.now() }
    : entry)));
  repaintDocumentBlocks();
  return true;
}

// ── Stacking ───────────────────────────────────────────────────────────────
//
// `z` has been on the record since blocks were written and has been set exactly
// once, at creation, from the length of the list — so two blocks that overlap
// have always been stacked in the order they were made, with no way to say
// otherwise. This is that way: the pressed block swaps places with its nearest
// neighbour in the stack, which is what "bring it forward" means and is stable
// in a way that "z += 1" is not.
export function restackBlock(direction, id = selectedId) {
  if (!id) return false;
  const blocks = documentBlocks();
  const order = [...blocks].sort((a, b) => (a.z - b.z) || (a.at - b.at));
  const index = order.findIndex((block) => block.id === id);
  const swap = index + (direction > 0 ? 1 : -1);
  if (index < 0 || swap < 0 || swap >= order.length) return false;
  [order[index], order[swap]] = [order[swap], order[index]];
  const z = new Map(order.map((block, index) => [block.id, index]));
  writeBlocks(blocks.map((entry) => (entry.z === z.get(entry.id)
    ? entry
    : { ...entry, z: z.get(entry.id), at: Date.now() })));
  repaintDocumentBlocks();
  return true;
}

export function editBlock(id = selectedId) {
  if (!id) return false;
  beginBlockEdit(id);
  return true;
}

// The style controls, over the block rather than in the editor window. The same
// bar the sheet carries (./block-style-bar.js) — one builder, two homes, which is
// the arrangement src/notes/note-editor-kit.js already uses to serve three.
//
// Takes the node rather than finding it itself, because the one internal caller
// (openSelectedBlockStyle, below) already has the DOM element the popover has
// to anchor to — resolving it twice would be two places that could disagree
// about which node "the selected block" means.
function openStyleFor(id, node) {
  // A toggle, because the button stays under the reader's finger while the panel
  // it opened is up and pressing it again is the plainest way to say "done".
  if (closeBlockStylePopover() && styleOpenFor === id) {
    styleOpenFor = null;
    // The style popover just closed and the block is still selected — the
    // quick actions belong back at it, the same as after any other popover
    // exchange here.
    syncBlockActionsPopover();
    return;
  }
  const block = documentBlocks().find((entry) => entry.id === id);
  if (!block) return;
  styleOpenFor = id;
  // commitBlockEdit, below, can itself reopen the quick-actions popover — its
  // own writeBlockText ends in syncBlockActionsPopover, for the ordinary case
  // of Done/Escape leaving the block selected. That would land AFTER a close
  // called any earlier in this function, so the close belongs here, once
  // everything above it that could reopen it has already run.
  commitBlockEdit();
  closeBlockActionsPopover();
  openBlockStylePopover({
    anchor: node,
    kind: block.kind,
    style: blockStyle(block),
    has: blockHolds(block),
    onChange: (patch) => writeBlockStyle(id, patch)
  });
}

// What #inkRailBlock's Style button calls (src/ui/ink-rail.js) — the rail knows
// only that SOMETHING is selected, not which DOM node it is, so this is the one
// place that looks the node up before handing off to the toggle above.
export function openSelectedBlockStyle() {
  if (!selectedId) return false;
  const node = document.querySelector(`[data-pdf-block="${selectedId}"]`);
  if (!node) return false;
  openStyleFor(selectedId, node);
  return true;
}

// ── Which page, and where on it, a point on the glass is ───────────────────
//
// For src/main.js's drop and paste handler, which wants a picture landing where
// it was actually dropped rather than in the middle of whichever page is in
// view — which is how a multi-file drop used to put four photographs in one
// pile.
export function pdfPointAt(clientX, clientY) {
  const pageEl = document.elementFromPoint(clientX, clientY)?.closest?.(".pdf-page[data-page-number]");
  const page = Number(pageEl?.dataset.pageNumber);
  if (!page) return null;
  const viewport = pdfPageViewport(page);
  const box = pageEl.getBoundingClientRect();
  if (!viewport || !box.width || !box.height) return null;
  const [x, y] = viewport.convertToPdfPoint(clientX - box.left, clientY - box.top);
  return { page, x, y };
}

