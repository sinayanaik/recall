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
import { recordDeletedMetaId } from "../sync/document-sync.js?v=__BUILD__";
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
      at: Number(block.at) || 0
    }));
  return pageNumber === null ? out : out.filter((block) => block.page === Number(pageNumber));
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
function writeBlocks(next, { removed = null } = {}) {
  const slot = activeDocSlot();
  const whole = recordsOutsideSlot(state.meta?.pdfBlocks, slot).concat(stampDocSlotAll(next, slot));
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}), pdfBlocks: whole };
  // Written back into the meta on every step. recordDeletedMetaId reads the bag
  // off `meta` and returns a fresh one, so a loop that assigns only after its
  // last iteration hands every step the same starting bag and keeps one id —
  // see the identical rule spelled out in remapDocumentHighlightPages.
  (Array.isArray(removed) ? removed : [removed]).filter(Boolean).forEach((id) => {
    state.meta.deletedBlockIds = recordDeletedMetaId(state.meta, "deletedBlockIds", id);
  });
  scheduleDeckAutosave();
  onBlocksChanged();
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
  writeBlocks(next, { removed: gone.map((block) => block.id) });
  return gone.length;
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
  edit.title = isImage ? "Describe this image" : "Edit this text";
  edit.setAttribute("aria-label", edit.title);
  edit.innerHTML = isImage ? "&#9750;" : "&#9998;";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "pdf-block-btn is-danger";
  remove.dataset.pdfBlockAction = "delete";
  remove.title = "Delete this block";
  remove.setAttribute("aria-label", "Delete this block");
  remove.innerHTML = "&#128465;";
  bar.append(edit, remove);

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

function paintBlock(node, block) {
  const body = node.querySelector(".pdf-block-body");
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
  if (renderedMarkdown.get(body) === block.md) return;
  renderedMarkdown.set(body, block.md);
  renderBlockBody(body, block.md);
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
async function renderBlockBody(body, md) {
  try {
    await renderMarkdown(body, md);
    if (renderedMarkdown.get(body) !== md || !body.isConnected) return;
    await enhanceRenderedMarkdown(body);
    if (renderedMarkdown.get(body) !== md || !body.isConnected) return;
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
    at: Date.now()
  };
  writeBlocks([...blocks, block]);
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
    at: Date.now()
  };
  writeBlocks([...blocks, block]);
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
    onDone: (text) => writeBlockText(id, text)
  });
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
  let live = { ...block };
  let frame = 0;

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
      const h = Math.max(PDF_BLOCK_MIN_HEIGHT, block.h - dy);
      live = { ...block, w: Math.round(w), h: Math.round(h), y: Math.round(block.y + (block.h - h)) };
    }
    if (!frame) frame = requestAnimationFrame(apply);
  };

  const finish = () => {
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
    // other editor in this app commits.
    if (editingId) commitBlockEdit();
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
  if (action === "edit") beginBlockEdit(id);
  else if (action === "delete") {
    writeBlocks(documentBlocks().filter((entry) => entry.id !== id), { removed: id });
    repaintDocumentBlocks();
  } else if (action === "drag" || action === "resize") {
    commitBlockEdit();
    beginGesture(event, node, action);
  }
  return true;
}
