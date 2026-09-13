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

import { activeDocSlot, recordsInSlot, recordsOutsideSlot, stampDocSlotAll } from "./doc-slot.js?v=__BUILD__";
import { PDF_BLOCK_CLASS, PDF_BLOCK_LAYER_CLASS } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { hydrateLocalImages, storeImageOrQueue } from "../images/outbox.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { closeBlockEditor, openBlockEditor } from "./pdf-block-editor.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { dropMetaTombstonesForLiveIds, recordDeletedMetaId } from "../sync/document-sync.js?v=__BUILD__";
import { blockFillVar, blockInkVar, isDefaultBlockStyle, normalizeBlockStyle } from "./block-style.js?v=__BUILD__";
import { blockStylePreference, writeBlockStylePreference } from "../storage/ink-prefs.js?v=__BUILD__";
import { resolveFontFamily } from "../ui/fonts.js?v=__BUILD__";
import { openBlockStylePopover, closeBlockStylePopover } from "./block-style-bar.js?v=__BUILD__";
import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";

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

export function setBlocksChangedHandler(fn) {
  onBlocksChanged = typeof fn === "function" ? fn : () => {};
}

// A deck can carry its own paper AND a notebook, and both keep their blocks in
// this one array with a `doc` field saying which (src/documents/doc-slot.js).
// This returns the surface's own, because that is what every caller means.
export function documentBlocks(pageNumber = null) {
  const list = recordsInSlot(state.meta?.pdfBlocks, activeDocSlot());
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
  // Before anything is written, and only for the changes a reader MADE — see the
  // ring below for why a page renumber and a late upload are not among them.
  if (undoable) pushBlockUndo(documentBlocks(), coalesce);
  const whole = recordsOutsideSlot(state.meta?.pdfBlocks, slot).concat(stampDocSlotAll(next, slot));
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
  return `${state.localDeckId || ""}:${activeDocSlot()}`;
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

function buildBlock(block) {
  const node = document.createElement("div");
  node.className = PDF_BLOCK_CLASS;
  node.dataset.pdfBlock = block.id;
  node.dataset.pdfBlockKind = block.kind;

  const bar = document.createElement("div");
  bar.className = "pdf-block-bar";
  bar.dataset.pdfBlockAction = "drag";
  bar.title = "Drag to move";

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "pdf-block-btn";
  edit.dataset.pdfBlockAction = "edit";
  // On an image this edits the description, which is what a reader would type
  // if the picture failed to load and what a screen reader reads out. A picture
  // with a ✎ that opened a markdown editor would be a control lying about what
  // it does.
  const isImage = block.kind === PDF_BLOCK_IMAGE;
  // The same words the window it opens puts at the top of itself. They were
  // "Edit this text" and "Edit this block", which is one control and one heading
  // disagreeing about what the reader is about to work on.
  edit.title = isImage ? "Describe this image" : "Edit this block";
  edit.setAttribute("aria-label", edit.title);
  edit.innerHTML = isImage ? "&#9750;" : "&#9998;";

  // ── The third button, and why it is a word-ish glyph rather than a palette ─
  //
  // 🎨 is what this control is called everywhere else in the world and it is the
  // one thing it must not be: a full-colour emoji standing a head taller than the
  // two monochrome glyphs beside it, which is the fault README already records
  // against the old + 📷. "Aa" is the same two characters the editor's own font
  // menu uses for the same question, renders on every platform, and says which
  // kind of block it belongs to — a picture's frame is ▣, because "Aa" on a
  // photograph would be a control lying about what it does.
  const style = document.createElement("button");
  style.type = "button";
  style.className = "pdf-block-btn";
  style.dataset.pdfBlockAction = "style";
  style.title = isImage ? "Frame this picture" : "Style this block";
  style.setAttribute("aria-label", style.title);
  style.innerHTML = isImage ? "&#9635;" : "Aa";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "pdf-block-btn is-danger";
  remove.dataset.pdfBlockAction = "delete";
  remove.title = "Delete this block";
  remove.setAttribute("aria-label", "Delete this block");
  remove.innerHTML = "&#128465;";
  bar.append(style, edit, remove);

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

  node.append(bar, body, grip);
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
    if (img.getAttribute("src") !== block.src) img.setAttribute("src", block.src);
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
    // The block's own images, which reach here as recall-img: tokens when they
    // were added offline — the same hydrate paintDocumentBlocks does for the
    // image blocks beside them.
    await hydrateLocalImages(body);
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
  selectedId = block.id;
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
  selectedId = block.id;
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
  if (text === null) { repaintDocumentBlocks(); return; }
  const blocks = documentBlocks();
  const block = blocks.find((entry) => entry.id === id);
  const field = block?.kind === PDF_BLOCK_IMAGE ? "alt" : "md";
  if (block && block[field] !== text) {
    writeBlocks(blocks.map((entry) => (entry.id === id ? { ...entry, [field]: text, at: Date.now() } : entry)));
  }
  repaintDocumentBlocks();
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

  const move = (moveEvent) => {
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

  const finish = () => {
    gestureLive = false;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    try { node.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
    placeBlock(node, viewport, live);
    // A press that ended where it started must not cost an autosave and a push.
    if (live.x === block.x && live.y === block.y && live.w === block.w && live.h === block.h) return;
    writeBlocks(documentBlocks().map((entry) => (entry.id === id ? { ...entry, ...live, at: Date.now() } : entry)));
  };

  try { node.setPointerCapture(event.pointerId); } catch (_) { /* synthetic */ }
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
    // ...unless the press was inside the style popover, which floats OVER the
    // page and is about the very block that is selected. Dismissing the
    // selection there would close the popover on its own first press.
    if (!event.target.closest?.(".pdf-block-style-pop")) selectBlock(null);
    return false;
  }
  const action = event.target.closest("[data-pdf-block-action]")?.dataset.pdfBlockAction;
  // The text of a block being edited is in the sheet over the page, not in the
  // block — so a press on the block itself while its editor is open is a press
  // on the page, and it commits like any other. The bar's own buttons still
  // reach their actions below.
  event.preventDefault();
  event.stopPropagation();
  const id = node.dataset.pdfBlock;
  // Picked up by any press on it, whatever else that press goes on to do. This
  // is what the keyboard verbs below are about, and it costs nothing to be wrong
  // about — a selection is a ring around a box, not a mode.
  selectBlock(id);
  // Anything but pressing the style button again puts the popover away: it is
  // anchored to ONE block and pinned to where that block was, so a press that
  // moves the reader on to another block — or moves this one — leaves a panel
  // hanging over the page describing something else.
  if (action !== "style") closeBlockStylePopover();
  if (action === "edit") beginBlockEdit(id);
  else if (action === "style") openStyleFor(id, node);
  else if (action === "delete") deleteBlock(id);
  else if (action === "drag" || action === "resize") {
    commitBlockEdit();
    beginGesture(event, node, action);
  }
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

export function selectBlock(id) {
  const next = id && documentBlocks().some((block) => block.id === id) ? id : null;
  if (next === selectedId) return next;
  selectedId = next;
  if (!next) closeBlockStylePopover();
  repaintDocumentBlocks();
  return next;
}

export function deleteBlock(id = selectedId) {
  if (!id) return false;
  const blocks = documentBlocks();
  if (!blocks.some((block) => block.id === id)) return false;
  if (editingId === id) commitBlockEdit();
  if (selectedId === id) { selectedId = null; closeBlockStylePopover(); }
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
  selectedId = copy.id;
  repaintDocumentBlocks();
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
function openStyleFor(id, node) {
  // A toggle, because the button stays under the reader's finger while the panel
  // it opened is up and pressing it again is the plainest way to say "done".
  if (closeBlockStylePopover() && styleOpenFor === id) { styleOpenFor = null; return; }
  const block = documentBlocks().find((entry) => entry.id === id);
  if (!block) return;
  styleOpenFor = id;
  commitBlockEdit();
  openBlockStylePopover({
    anchor: node,
    kind: block.kind,
    style: blockStyle(block),
    has: blockHolds(block),
    onChange: (patch) => writeBlockStyle(id, patch)
  });
}

// ── Which page, and where on it, a point on the glass is ───────────────────
//
// For the two callers that have a pointer and want a block there: the
// double-click that makes one, and a picture dropped or pasted onto the page.
// Both used to be able to say only "the middle of whatever page is in view",
// which is how a multi-file drop put four photographs in one pile.
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

// A double-click on bare paper makes a block there and opens it. Returns true
// when it did, so the caller knows the press was spent.
//
// Guarded on the press NOT being inside a block, which is the whole of the rule:
// a double-click on a block is a reader selecting a word inside it, and on the
// deck's other paper it is a reader selecting a word of somebody's preprint.
// src/main.js is what decides this only happens on the Write tab.
export function addBlockAtPoint(clientX, clientY) {
  const at = pdfPointAt(clientX, clientY);
  if (!at) return false;
  return Boolean(addDocumentBlock(at.page, at));
}
