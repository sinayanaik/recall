// "Make a flashcard" — the panels a card is framed in, from a selection in the
// notes, a card face, or a region drawn on a PDF.
//
// ── Why panels, plural, and why the page behind stays live ──────────────────
//
// This used to be ONE modal: a fixed section over the whole screen that, even
// once its dimming was dropped, still caught every click, wheel and touch meant
// for the page behind it, and a page-scroll lock on top of that. So the one
// thing a reader needs while framing a question — to scroll back up the PDF or
// the notes and look again — was the one thing they could not do. And a second
// "Make a flashcard" while one was open had nowhere to go but over the first,
// throwing away whatever had been typed into it.
//
// So each request gets its own panel now, built from #frameCardTemplate into
// #frameCardLayer. The layer passes every event through (pointer-events: none,
// 62-frame-card-draggable.css) and only the panels themselves take them, so the
// page behind scrolls, selects and opens menus exactly as it does with nothing
// open — which is also how a second selection gets made to open a second panel.
// Nothing here takes the page-scroll lock, and these panels are not in
// anyModalOpen (src/ui/overlays.js): they are windows over the page, like the
// highlight-note popup, not dialogs in front of it.
//
// Every panel carries its own draft — its own editor, preview, question,
// anchor back into the notes, and its own Add and Cancel — and adding one card
// leaves every other draft exactly as it was.
//
// ── Phones ──────────────────────────────────────────────────────────────────
//
// A centred panel on a phone is the whole screen with an 18px border, which is
// no page left to scroll. There a panel opens as a bottom sheet (CSS alone, see
// the (max-width: 720px) block in 62-frame-card-draggable.css), leaving the top
// of the page visible and live. It still drags and resizes like on a desktop.

import { el } from "../core/dom.js?v=__BUILD__";
import { installMarkdownKeys, installModeKeys } from "../editor/markdown-keys.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";
import { styleMobileMedia } from "../ui/style-tokens.js?v=__BUILD__";
import { addCardFromNotes } from "./anchors.js?v=__BUILD__";
import { createNoteEditorKit } from "./note-editor-kit.js?v=__BUILD__";

const FRAME_CARD_BLANK_PLACEHOLDER = "No text found here — describe what this shows (a figure, table, equation…)";

// Debounced rather than on every keystroke: a region embed reopens and
// re-renders a page of the PDF (see mountPdfRegionEmbed), which is real work
// worth coalescing while the reader is still typing beside it.
const FRAME_CARD_PREVIEW_DEBOUNCE_MS = 300;

const FRAME_CARD_MIN_WIDTH = 320;
const FRAME_CARD_MIN_HEIGHT = 260;
// A margin kept on screen at all times, on every edge — so a panel dragged
// toward a corner can still be grabbed back rather than stranding itself
// off-screen with no visible titlebar left to drag.
const FRAME_CARD_EDGE_MARGIN = 40;

// Each panel opened while others are up sits this much further down and to the
// right of where the last one would have, so a new draft never lands exactly
// over an old one and hides it — up to a few steps, after which they stack.
const FRAME_CARD_CASCADE_STEP = 28;
const FRAME_CARD_CASCADE_MAX_STEPS = 4;

// The open panels, oldest first. Each entry is the handle frameCardPanel()
// returns.
const openFrameCards = [];
// Stacking order within #frameCardLayer: the panel last pressed or opened is on
// top. A z-index rather than re-appending the element, because moving an
// element that holds the focused textarea takes the focus out of it.
let frameCardTopZ = 0;
// For a unique preview id per panel (aria-controls needs one).
let frameCardSerial = 0;
// The reader's choice, kept for the session: someone who folded the preview
// away to get room on a phone does not want it back on the next card.
let frameCardPreviewDefault = true;
// Where the reader last parked a panel on a desktop — so the next one opens
// there rather than back in the middle of the page they moved it off. `height`
// is set only by a RESIZE; a drag pins a height too, but only to leave the
// centred layout, and the next card's content will want its own.
let rememberedFrameCardBox = null;

function clampFrameCard(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function isFrameCardOpen() {
  return openFrameCards.length > 0;
}

function frontFrameCard() {
  let front = null;
  for (const card of openFrameCards) {
    if (!front || Number(card.panel.style.zIndex) > Number(front.panel.style.zIndex)) front = card;
  }
  return front;
}

// For Back and Escape from outside any panel (src/ui/back-gesture.js): one
// press, the frontmost draft — the same "one layer per press" every other
// overlay answers to.
export function cancelFrontFrameCard() {
  frontFrameCard()?.cancel();
}

function bringFrameCardToFront(panel) {
  if (Number(panel.style.zIndex) === frameCardTopZ) return;
  panel.style.zIndex = String(++frameCardTopZ);
}

// ── Where a new panel goes ──────────────────────────────────────────────────
//
// On a phone: nowhere, here — the bottom sheet is CSS alone. On a desktop,
// either where the reader last parked one, or centred by CSS; both nudged along
// by however many are already open.
function placeFrameCardPanel(panel, cascadeIndex) {
  if (styleMobileMedia?.matches) return;
  const offset = Math.min(cascadeIndex, FRAME_CARD_CASCADE_MAX_STEPS) * FRAME_CARD_CASCADE_STEP;
  const box = rememberedFrameCardBox;
  if (!box) {
    panel.style.setProperty("--frame-card-offset", `${offset}px`);
    return;
  }
  const margin = 8;
  const width = Math.min(box.width, window.innerWidth - margin * 2);
  const left = clampFrameCard(box.left + offset, margin, window.innerWidth - width - margin);
  const top = clampFrameCard(box.top + offset, margin, Math.max(margin, window.innerHeight - FRAME_CARD_MIN_HEIGHT - margin));
  panel.style.transform = "none";
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.width = `${width}px`;
  panel.style.maxWidth = "none";
  if (box.height) {
    panel.style.height = `${Math.min(box.height, window.innerHeight - top - margin)}px`;
    panel.style.maxHeight = "none";
    panel.classList.add("is-resized");
  } else {
    // Sized by its content, as a centred one is — but from a pinned top, so
    // it is its bottom edge that has to be kept on screen.
    panel.style.maxHeight = `${window.innerHeight - top - margin}px`;
  }
}

function rememberFrameCardBox(panel, withHeight) {
  if (styleMobileMedia?.matches) return;
  const rect = panel.getBoundingClientRect();
  rememberedFrameCardBox = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    // A height once a resize has chosen one — kept through later drags, which
    // are the same panel at the size the reader already picked.
    height: (withHeight || rememberedFrameCardBox?.height) ? rect.height : null
  };
}

// ── Moving and resizing one panel ───────────────────────────────────────────
//
// The panel's own answer preview is often the whole reason to open one — a
// region card's answer face IS a picture of a spot on the page — so the reader
// can move it aside and resize it, keeping the page behind visible (and, since
// the layer passes events through, usable) while they write.

// Leave whatever layout placed the panel — CSS centring, the bottom sheet, a
// remembered box — for explicit geometry at exactly where it already is, so the
// switch itself moves nothing. Width and height matter as much as position:
// without them the frozen `width: 100%` (11-chrome.css) and the sheet's
// left/right would take over the moment the placement rules stop applying.
function pinFrameCardGeometry(panel) {
  const rect = panel.getBoundingClientRect();
  panel.style.transform = "none";
  panel.style.margin = "0";
  panel.style.left = `${rect.left}px`;
  panel.style.top = `${rect.top}px`;
  panel.style.width = `${rect.width}px`;
  panel.style.height = `${rect.height}px`;
  // The CSS cap on a centred panel is in terms of the cascade offset it no
  // longer has, and would clip a height the reader is about to drag larger.
  panel.style.maxHeight = "none";
  return rect;
}

function beginFrameCardDrag(panel, titlebar, event) {
  if (event.button !== undefined && event.button !== 0) return;
  const rect = pinFrameCardGeometry(panel);
  const startX = event.clientX;
  const startY = event.clientY;
  try { titlebar.setPointerCapture(event.pointerId); } catch (_) { /* synthetic event */ }

  const onMove = (moveEvent) => {
    const width = panel.offsetWidth;
    const maxLeft = window.innerWidth - FRAME_CARD_EDGE_MARGIN;
    const maxTop = window.innerHeight - FRAME_CARD_EDGE_MARGIN;
    const left = clampFrameCard(rect.left + (moveEvent.clientX - startX), FRAME_CARD_EDGE_MARGIN - width, maxLeft);
    const top = clampFrameCard(rect.top + (moveEvent.clientY - startY), 0, maxTop);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };
  const onUp = (upEvent) => {
    try { titlebar.releasePointerCapture(upEvent.pointerId); } catch (_) { /* already gone */ }
    titlebar.removeEventListener("pointermove", onMove);
    titlebar.removeEventListener("pointerup", onUp);
    titlebar.removeEventListener("pointercancel", onUp);
    rememberFrameCardBox(panel, false);
  };
  titlebar.addEventListener("pointermove", onMove);
  titlebar.addEventListener("pointerup", onUp);
  titlebar.addEventListener("pointercancel", onUp);
}

function beginFrameCardResize(panel, handle, event) {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = pinFrameCardGeometry(panel);
  const startX = event.clientX;
  const startY = event.clientY;
  // The class rule's max-width (560px, 62-frame-card-draggable.css) still caps
  // the USED width even once an inline style sets a bigger one — max-width and
  // width are separate properties, and the smaller of the two wins regardless
  // of which one is inline. Cleared here, once resizing actually starts, so
  // the class rule still sets a sane default size but never fights a
  // deliberate resize.
  panel.style.maxWidth = "none";
  // From here the editor and the preview share whatever height the reader
  // gives the panel, rather than keeping their default boxes — see
  // 61-frame-card-answer-editable.css. Only a resize does this; a drag pins an
  // inline height too, and merely moving the panel must not re-split them.
  panel.classList.add("is-resized");
  try { handle.setPointerCapture(event.pointerId); } catch (_) { /* synthetic event */ }

  const onMove = (moveEvent) => {
    // Never below where it already was: the reader is dragging OUTWARD from
    // a size the panel is already at, and a small viewport clamping the
    // upper bound must not also retroactively shrink it below its start —
    // that read as the corner fighting the drag on a narrow window.
    const maxWidth = Math.max(rect.width, Math.min(window.innerWidth - FRAME_CARD_EDGE_MARGIN * 2, 900));
    const maxHeight = Math.max(rect.height, window.innerHeight - FRAME_CARD_EDGE_MARGIN * 2);
    const width = clampFrameCard(rect.width + (moveEvent.clientX - startX), Math.min(FRAME_CARD_MIN_WIDTH, rect.width), maxWidth);
    const height = clampFrameCard(rect.height + (moveEvent.clientY - startY), Math.min(FRAME_CARD_MIN_HEIGHT, rect.height), maxHeight);
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  };
  const onUp = (upEvent) => {
    try { handle.releasePointerCapture(upEvent.pointerId); } catch (_) { /* already gone */ }
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    rememberFrameCardBox(panel, true);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

// ── One panel ───────────────────────────────────────────────────────────────
//
// The answer is the shared note editor (src/notes/note-editor-kit.js): the
// toolbar, a syntax-highlight mirror whose metrics match the textarea's, the
// undo ring and the formatting keys — exactly as the highlight-note popup has
// it. Two of the kit's parts are left off:
//   - Its Write/Preview switch. A LIVE preview sits under the editor instead,
//     because a region card's answer is a `pdfref:` line whose whole point is
//     the figure it points at, and seeing that while writing is what the
//     preview is for. Ctrl+E (or the Preview label) folds it away.
//   - kit.attach(). That registers the editor with the floating selection pill,
//     whose one note-editor slot belongs to the highlight-note popup and could
//     not hold several of these at once. The kit's own toolbar already carries
//     every format the pill would offer.
function frameCardPanel(captured, noteAnchor) {
  const panel = el.frameCardTemplate.content.firstElementChild.cloneNode(true);
  const part = (selector) => panel.querySelector(selector);
  const titlebar = part(".frame-card-titlebar");
  const answerLabel = part(".frame-card-answer-label");
  const previewLabel = part(".frame-card-preview-label");
  const preview = part(".frame-card-answer-preview");
  const question = part(".frame-card-question");
  const addBtn = part(".frame-card-add");
  const cancelBtn = part(".frame-card-cancel");
  const resizeHandle = part(".frame-card-resize-handle");

  preview.id = `frameCardPreview${++frameCardSerial}`;
  previewLabel.setAttribute("aria-controls", preview.id);

  let previewTimer = 0;
  // What the preview last rendered, so a fold/unfold or an undo back to the
  // same text does not re-render a PDF page for nothing.
  let previewValue = null;
  let previewOpen = frameCardPreviewDefault;

  // A live preview of the answer, not just its raw markdown — the one thing
  // the raw textarea can't show is a region card's whole point: a `pdfref:`
  // reference (src/documents/pdf-region-embed.js) reads on the page as its
  // literal source text, not the boxed figure it points at. Rendered exactly
  // the way the card's own answer face renders it later (same renderMarkdown
  // call), so what's previewed here is what studying the card will show.
  const updatePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = 0;
    const value = kit.textarea.value.trim();
    const show = Boolean(value);
    previewLabel.hidden = !show;
    // Unhidden BEFORE rendering: a diagram in the answer needs real layout to
    // size against, which a `hidden` (display:none) container has none of.
    preview.hidden = !show || !previewOpen;
    if (!show || !previewOpen || value === previewValue) return;
    previewValue = value;
    renderMarkdown(preview, value);
  };
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, FRAME_CARD_PREVIEW_DEBOUNCE_MS);
  };
  const setPreviewOpen = (open) => {
    previewOpen = open;
    frameCardPreviewDefault = open;
    previewLabel.setAttribute("aria-expanded", String(open));
    previewLabel.classList.toggle("is-collapsed", !open);
    updatePreview();
  };

  const kit = createNoteEditorKit({ placeholder: "", onInput: schedulePreview });
  kit.modes.hidden = true;
  part(".frame-card-answer-editor").appendChild(kit.root);

  const hasCapturedText = Boolean(captured);
  answerLabel.textContent = hasCapturedText ? "Answer — captured from your notes" : "Answer";
  kit.textarea.placeholder = hasCapturedText ? "" : FRAME_CARD_BLANK_PLACEHOLDER;
  // setValue, not a bare `.value =`: a programmatic write fires no "input"
  // event, which is what the syntax-highlight backdrop syncs itself from.
  kit.setValue(captured);
  previewLabel.setAttribute("aria-expanded", String(previewOpen));
  previewLabel.classList.toggle("is-collapsed", !previewOpen);

  // Once per panel, whichever way out comes first — both buttons, Ctrl+Enter
  // and Escape on the panel, and Back or Escape from outside it — so a key and
  // a click landing together can never add the card twice.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(previewTimer);
    const index = openFrameCards.indexOf(card);
    if (index !== -1) openFrameCards.splice(index, 1);
    panel.remove();
  };
  const confirm = () => {
    if (closed) return;
    const questionText = question.value.trim();
    const answerText = kit.textarea.value.trim();
    // Kept open, with the focus on what is missing, rather than closed with the
    // draft thrown away: a reader who pressed Add a moment early should be one
    // line of typing from done, not starting again. (Blank-question cards are
    // dropped by loadDeckSnapshot on the next load, so adding one anyway would
    // only lose it later.)
    if (!questionText) {
      setStatus("Card not added — a question is required.", "error");
      question.focus();
      return;
    }
    if (!answerText) {
      setStatus("Card not added — an answer is required.", "error");
      kit.textarea.focus();
      return;
    }
    close();
    addCardFromNotes(questionText, answerText, noteAnchor);
  };
  const card = { panel, kit, confirm, cancel: close };

  addBtn.addEventListener("click", confirm);
  cancelBtn.addEventListener("click", close);
  // Bound on the PANEL, not on either textarea, so they work with the focus
  // anywhere in it — on a toolbar button, the preview, or the question. Ctrl+E
  // has to be claimed here in particular: left alone it reaches the global
  // handler in src/main.js and flips the notes view behind the panel.
  installModeKeys(panel, { toggleMode: () => setPreviewOpen(!previewOpen), done: confirm });
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // Stopped so the global Escape handler doesn't also close whatever is
    // behind this panel — another draft included.
    event.stopPropagation();
    close();
  });
  // The question is markdown too, and a card's question face renders it the
  // same way — so the same four formatting keys. Scoped to the panel, whose
  // mode keys above already own Ctrl+E and Ctrl+Enter.
  installMarkdownKeys(question, { scope: panel });
  // The kit closes its toolbar's dropdowns on a click inside the kit only, and
  // the global closer (closeAllEditToolbarDropdowns) knows only the three
  // fixed toolbars — so a colour menu left open while the reader clicks into
  // the question would otherwise stay open over it.
  panel.addEventListener("click", (event) => {
    if (event.target.closest(".toolbar-dropdown")) return;
    kit.toolbar.querySelectorAll(".toolbar-dropdown.is-open").forEach((d) => d.classList.remove("is-open"));
  });
  previewLabel.addEventListener("click", () => setPreviewOpen(!previewOpen));
  // Capture, so the press that starts a drag or lands on a button raises the
  // panel before anything else sees it.
  panel.addEventListener("pointerdown", () => bringFrameCardToFront(panel), true);
  titlebar.addEventListener("pointerdown", (event) => beginFrameCardDrag(panel, titlebar, event));
  resizeHandle.addEventListener("pointerdown", (event) => beginFrameCardResize(panel, resizeHandle, event));

  return { card, question, updatePreview };
}

export function createCardFromNotesSelection(markdown, noteAnchor = null) {
  // The highlighted fact is what you want to recall — it becomes the ANSWER;
  // the user frames the question that should bring it to mind. The answer
  // starts pre-filled with whatever was captured, but is a real editable
  // field: an area/region drawn on a PDF figure or diagram often captures no
  // text at all, and the only way to get a useful card out of one is to let
  // the reader type what it shows.
  //
  // Always a NEW panel, beside any already open — see the header.
  if (!el.frameCardLayer || !el.frameCardTemplate) return;
  const captured = String(markdown || "").trim();
  const { card, question, updatePreview } = frameCardPanel(captured, noteAnchor);
  const { panel, kit } = card;

  const cascadeIndex = openFrameCards.length;
  panel.style.zIndex = String(++frameCardTopZ);
  placeFrameCardPanel(panel, cascadeIndex);
  el.frameCardLayer.appendChild(panel);
  openFrameCards.push(card);
  updatePreview();

  // Focus whichever field still needs typing: the question when the answer
  // already arrived captured, the answer itself when it's starting blank.
  requestAnimationFrame(() => (captured ? question : kit.textarea).focus());
}
