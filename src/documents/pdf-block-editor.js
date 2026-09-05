// Writing INTO a block on a page of handwriting.
//
// ── Why this is not the textarea it replaces ───────────────────────────────
//
// A block was edited in place, in a bare <textarea> the size of the block. That
// is the right shape for a caption and the wrong one for the thing a block
// actually is: markdown, rendered through the same pipeline as everything else
// in this app, on the surface where somebody is working a problem. It had no
// formatting strip, no Write/Preview, no insert-image, no insert-drawing, no
// cloze, no syntax highlighting and no undo — while the Notes panel, the
// highlight popup and the Highlights tab all shared one editor that has every
// one of those. "The markdown boxes are utterly redundant, it doesn't support
// the full markdown ecosystem we have in the notes panel" is that gap, stated
// exactly.
//
// So the block gets the same editor, and gets it by IMPORTING it rather than by
// growing a fourth copy: src/notes/note-editor-kit.js returns unparented nodes
// precisely so a caller can arrange them, which is what the popup and the panel
// already do. Everything below is the arrangement — a sheet, a header, a footer
// — and nothing below is an editor.
//
// ── ...and why it is a sheet rather than in-place ──────────────────────────
//
// The default block is 240x90 points. The formatting strip alone is wider than
// that at any zoom a reader writes at, so an in-place kit would be a toolbar
// with one visible button and a two-line textarea under it. The block stays
// where it is on the page and the editing happens in a window over it, which is
// the same answer src/notes/highlight-note-editor.js reached for a note that is
// attached to a highlight sitting in a line of text.

import { createNoteEditorKit } from "../notes/note-editor-kit.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

let blockSheet = null;
let blockSession = null;

function buildBlockSheet() {
  if (blockSheet?.root?.isConnected) return blockSheet;

  const root = document.createElement("div");
  root.className = "pdf-block-editor";
  root.id = "pdfBlockEditor";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");

  const head = document.createElement("div");
  head.className = "pdf-block-editor-head";
  const title = document.createElement("h2");
  title.className = "pdf-block-editor-title";
  title.textContent = "Block";
  head.appendChild(title);

  // The kit: Write/Preview, the full formatting strip, the syntax-highlight
  // mirror, the undo ring, the image and diagram grips, and the registration
  // that makes the floating selection pill work over this text.
  const kit = createNoteEditorKit({ placeholder: "Markdown — the same as a note" });

  const foot = document.createElement("div");
  foot.className = "pdf-block-editor-foot";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "tool-button";
  cancel.textContent = "Cancel";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "tool-button pdf-block-editor-done";
  done.textContent = "Done";
  foot.append(cancel, done);

  root.append(head, kit.root, foot);
  document.body.appendChild(root);
  blockSheet = { root, title, kit, cancel, done };

  cancel.addEventListener("click", () => closeBlockSheet(false));
  done.addEventListener("click", () => closeBlockSheet(true));

  // Ctrl+E is the kit's own Write/Preview toggle and has to work with the focus
  // anywhere in this window, which is why the kit does not bind it itself.
  root.addEventListener("keydown", (event) => {
    if (!blockSession) return;
    if (event.key === "Escape") { event.preventDefault(); closeBlockSheet(false); return; }
    if ((event.ctrlKey || event.metaKey) && (event.key === "e" || event.key === "E")) {
      event.preventDefault();
      kit.toggleMode();
      return;
    }
    // Ctrl+Enter commits, which is what every other "window with a body of text
    // and a Done" in this app means by it.
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      closeBlockSheet(true);
    }
  });

  // A press on the backdrop commits rather than discards, matching the way an
  // in-place block used to end: pressing the page elsewhere was a commit, and a
  // reader who has typed a paragraph and tapped outside has not asked to lose it.
  root.addEventListener("pointerdown", (event) => {
    if (event.target === root) closeBlockSheet(true);
  });

  return blockSheet;
}

export function isBlockEditorOpen() {
  return Boolean(blockSession);
}

// `value` is the text to edit — a block's markdown, or an image block's
// description. `onDone` is handed the new text, or null when it was cancelled.
export function openBlockEditor({ value = "", title = "Edit this text", placeholder = "", onDone = () => {} } = {}) {
  const built = buildBlockSheet();
  // A second open with one already up commits the first, the way beginBlockEdit
  // has always committed whatever was open before it.
  if (blockSession) closeBlockSheet(true);
  blockSession = { onDone };
  built.title.textContent = title;
  built.kit.setValue(value);
  built.kit.clearHistory();
  built.kit.setMode("write");
  if (placeholder) built.kit.textarea.placeholder = placeholder;
  built.root.hidden = false;
  built.kit.attach();
  lockPageScroll();
  // After the sheet is on screen, or the focus lands on a hidden element and the
  // caret is nowhere.
  built.kit.textarea.focus();
  built.kit.textarea.setSelectionRange(value.length, value.length);
}

// Exported because leaving the view has to be able to end an open edit — the
// same contract commitBlockEdit already had with setViewMode's flush hook.
export function closeBlockEditor(commit = true) {
  return closeBlockSheet(commit);
}

function closeBlockSheet(commit) {
  if (!blockSession) return false;
  const { onDone } = blockSession;
  const text = blockSheet.kit.surface.getSource();
  blockSession = null;
  blockSheet.kit.detach();
  blockSheet.root.hidden = true;
  unlockPageScroll();
  onDone(commit ? text : null);
  return true;
}
