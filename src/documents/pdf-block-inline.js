// Writing in a block where it is, on the page.
//
// A block's words were written in a window over the page (./pdf-block-editor.js):
// a header, Write/Preview, the whole formatting strip, a style row and a footer,
// covering the very page the block was on — for a caption of four words. "Adding
// a block should not be very bulky and obstructive, it should be lightweight as
// adding text." And once a block was down, its words could not be selected at
// all: every press on it was a drag. "It is so difficult to just select some
// text inside and apply styling — it directly goes to pan and move."
//
// So a block opens IN PLACE: its rendered body steps aside and the markdown is
// typed into the block itself, in its own size, face and colour, with the
// markdown coloured as the Notes editor colours it. The block grows with the
// lines as they are typed — wider with the longest line, up to the page's
// edge, then taller; on a Canvas, in the balanced box its words will be put
// down in (measureTypedWidth's `balance`); one whose width was dragged by hand
// wraps at it.
// Selecting words raises the Notes selection bar — bold, colour, highlight,
// maths, a cloze — because the editor is the Notes editor's own kit
// (src/notes/note-editor-kit.js) registered as the surface the bar acts on. Its
// own Write/Preview row and toolbar strip are hidden (styles/53-handwriting.css):
// the bar, the keys (Ctrl+B, Ctrl+I, lists) and the undo ring are what is left,
// and they are the whole of what typing a few lines on a page needs. The window
// is still there for a long block, one press away ("Full editor").
//
// Put down by a press anywhere off the block, Escape or Ctrl+Enter — every way
// out keeps the words, as the window's backdrop press always did. Escape is not
// a cancel: a reader who typed a paragraph and pressed Escape has not asked to
// lose it.

import { createNoteEditorKit } from "../notes/note-editor-kit.js?v=__BUILD__";
import { hideNotesSelectionButton, scheduleNotesSelectionCheck } from "../notes/selection.js?v=__BUILD__";
import { balancedWidthPx } from "./block-measure.js?v=__BUILD__";

export const PDF_BLOCK_INLINE_CLASS = "pdf-block-inline";

let inlineSession = null;
let inlineKit = null;

function ensureKit() {
  if (inlineKit) return inlineKit;
  inlineKit = createNoteEditorKit({
    placeholder: "Write — markdown, maths, code, as in Notes",
    onInput: () => { growToFit(); inlineSession?.onInput?.(inlineKit.textarea.value); }
  });
  inlineKit.root.classList.add(PDF_BLOCK_INLINE_CLASS);
  inlineKit.root.addEventListener("keydown", (event) => {
    if (!inlineSession) return;
    if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
      event.preventDefault();
      event.stopPropagation();
      closeInlineBlockEditor(true);
    }
  });
  // A press inside it is not a press on the page — not the pen's, not the
  // block's own drag, not the lasso's: handleBlockPointerDown
  // (src/documents/pdf-blocks.js) stops it for them and leaves it to the
  // textarea, so the caret goes where it was put and a drag selects words.
  return inlineKit;
}

// The textarea is as tall as its lines, so the block is too — the !important
// beats the editor's own `height: 100% !important` (styles/10-editor.css),
// which is right for a pane and wrong for a box that grows.
function growToFit() {
  if (!inlineKit || !inlineSession) return;
  const { textarea } = inlineKit;
  // The width first: the Block grows with its longest line (up to the page's
  // edge — the caller's to say), and only then is the height measured, at the
  // width the lines will actually wrap at.
  if (inlineSession.onWidth) {
    const measure = measureTypedWidth(textarea, inlineSession.node);
    if (measure) inlineSession.onWidth(measure);
  }
  textarea.style.setProperty("height", "auto", "important");
  textarea.style.setProperty("height", `${Math.ceil(textarea.scrollHeight)}px`, "important");
  inlineSession.onGrow?.();
  // Words still picked (a press of the selection bar's B wraps them and can
  // add a line): the bar goes back above the Block's new edge, not over it.
  if (textarea.selectionEnd > textarea.selectionStart) scheduleNotesSelectionCheck();
}

// How wide the typed words want to be, in screen pixels: the longest line as
// typed, unwrapped, in the textarea's own face, size, spacing and padding — set
// once in a hidden box beside it. An empty editor measures its placeholder, so a
// new Block opens wide enough to say what it is for. `framePx` is everything of
// the Block that is not the textarea (its edges).
let typedWidthProbe = null;
const PROBE_PROPS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "wordSpacing",
  "fontFeatureSettings", "fontVariant", "tabSize", "paddingLeft", "paddingRight", "textTransform"];

function measureTypedWidth(textarea, node) {
  if (!textarea?.isConnected || !node) return null;
  if (!typedWidthProbe) {
    typedWidthProbe = document.createElement("div");
    typedWidthProbe.setAttribute("aria-hidden", "true");
    typedWidthProbe.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;"
      + "white-space:pre;width:max-content;height:auto;border:0;margin:0;contain:layout style;";
  }
  const style = getComputedStyle(textarea);
  PROBE_PROPS.forEach((key) => { typedWidthProbe.style[key] = style[key]; });
  // A trailing space so a line that ends in one is measured with it, the way
  // the caret sees it.
  typedWidthProbe.textContent = `${textarea.value || textarea.placeholder || " "} `;
  if (!typedWidthProbe.isConnected) document.body.appendChild(typedWidthProbe);
  const contentPx = typedWidthProbe.getBoundingClientRect().width;
  const framePx = Math.max(0, node.offsetWidth - textarea.offsetWidth);
  const fontPx = parseFloat(style.fontSize) || 16;
  // The balanced width of the same words (balancedWidthPx), asked for by a
  // Block on a Canvas: the probe wrapped as the textarea wraps, its width
  // counting its padding as the textarea's does. Laid out only when asked.
  const balance = ({ capPx, minLinePx }) => {
    const probe = typedWidthProbe;
    probe.style.lineHeight = style.lineHeight;
    // The height counts the padding above and below, as the rendered body's
    // does, or the box typed in comes out narrower than the one put down.
    probe.style.paddingTop = style.paddingTop;
    probe.style.paddingBottom = style.paddingBottom;
    probe.style.whiteSpace = "pre-wrap";
    probe.style.overflowWrap = style.overflowWrap || "break-word";
    probe.style.boxSizing = "border-box";
    probe.textContent = textarea.value || " ";
    try {
      const laid = balancedWidthPx(probe, { capPx, minLinePx });
      if (!(laid.width < laid.single - 1)) return laid;
      // ...drawn in to its widest line, as the render draws the rendered words
      // in (blockNaturalWidth), so putting it down does not narrow it again.
      probe.style.width = `${laid.width}px`;
      const box = probe.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(probe);
      let right = -Infinity;
      for (const rect of range.getClientRects()) if (rect.width > 0) right = Math.max(right, rect.right);
      if (!Number.isFinite(right)) return laid;
      const drawn = Math.ceil(right - box.left + (parseFloat(style.paddingRight) || 0));
      return { ...laid, width: Math.min(laid.width, Math.max(1, drawn)) };
    } finally {
      probe.style.whiteSpace = "pre";
      probe.style.boxSizing = "";
      probe.style.paddingTop = "";
      probe.style.paddingBottom = "";
      probe.style.width = "max-content";
    }
  };
  return { contentPx, framePx, fontPx, balance };
}

export function isInlineBlockEditorOpen() {
  return Boolean(inlineSession);
}

export function inlineBlockEditorId() {
  return inlineSession?.id || null;
}

// The words as they stand, for "Full editor", which carries them on into the
// window rather than dropping what was typed so far.
export function inlineBlockEditorValue() {
  return inlineSession && inlineKit ? inlineKit.surface.getSource() : null;
}

// Whether `target` is inside the open editor.
export function inlineBlockEditorHolds(target) {
  return Boolean(inlineSession && inlineKit && target && inlineKit.root.contains(target));
}

// Into `node` — the block's own element. Called again by the paint when the
// block's node has been rebuilt (a page re-rendered at a new zoom), which moves
// the open editor into the new node rather than losing it.
export function mountInlineBlockEditor(node) {
  if (!inlineSession || !inlineKit || !node) return;
  if (inlineKit.root.parentNode !== node) {
    const hadFocus = inlineKit.root.contains(document.activeElement);
    node.appendChild(inlineKit.root);
    if (hadFocus) inlineKit.textarea.focus({ preventScroll: true });
  }
  inlineSession.node = node;
  node.classList.add("is-inline-editing");
  growToFit();
}

// `onDone` is handed the text (always: there is no cancel here), `onGrow` is
// told whenever the editor changed height.
export function openInlineBlockEditor({ id, node, value = "", placeholder = "", onDone = () => {}, onGrow = () => {}, onWidth = null } = {}) {
  if (inlineSession) closeInlineBlockEditor(true);
  const built = ensureKit();
  inlineSession = { id, node: null, onDone, onGrow, onWidth };
  built.setMode("write");
  built.setValue(value);
  built.clearHistory();
  if (placeholder) built.textarea.placeholder = placeholder;
  mountInlineBlockEditor(node);
  built.attach();
  built.textarea.focus({ preventScroll: true });
  built.textarea.setSelectionRange(value.length, value.length);
  growToFit();
  return true;
}

export function closeInlineBlockEditor(commit = true) {
  if (!inlineSession || !inlineKit) return false;
  const { onDone, node } = inlineSession;
  const text = inlineKit.surface.getSource();
  inlineSession = null;
  inlineKit.detach();
  hideNotesSelectionButton();
  node?.classList.remove("is-inline-editing");
  if (inlineKit.root.contains(document.activeElement)) document.activeElement.blur();
  inlineKit.root.remove();
  inlineKit.textarea.style.removeProperty("height");
  onDone(commit ? text : null);
  return true;
}
