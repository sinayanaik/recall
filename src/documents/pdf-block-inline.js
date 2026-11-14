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
// typed into the block itself, at the block's own width, in its own size, face
// and colour, with the markdown coloured as the Notes editor colours it. The
// block's height follows the lines as they are typed; its width does not move.
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
  textarea.style.setProperty("height", "auto", "important");
  textarea.style.setProperty("height", `${Math.ceil(textarea.scrollHeight)}px`, "important");
  inlineSession.onGrow?.();
  // Words still picked (a press of the selection bar's B wraps them and can
  // add a line): the bar goes back above the Block's new edge, not over it.
  if (textarea.selectionEnd > textarea.selectionStart) scheduleNotesSelectionCheck();
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
export function openInlineBlockEditor({ id, node, value = "", placeholder = "", onDone = () => {}, onGrow = () => {} } = {}) {
  if (inlineSession) closeInlineBlockEditor(true);
  const built = ensureKit();
  inlineSession = { id, node: null, onDone, onGrow };
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
