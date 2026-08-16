// The raw editor's toolbar: which button does which transform.

import { el } from "../core/dom.js?v=__BUILD__";
import { applyInlineStyleProperty, clearFormatting, clearInlineStyleProperty, toggleBulletPoints, toggleCloze, toggleCode, toggleKbd, toggleStrikethrough, toggleUnderline, toggleWrap } from "./text-transforms.js?v=__BUILD__";
import { toggleMarkColorInText } from "../format/highlight.js?v=__BUILD__";
import { setRenderDefault } from "../format/render-toolbar.js?v=__BUILD__";
import { applyFormatToTextarea } from "../format/selection-tools.js?v=__BUILD__";
import { openImagePicker } from "../images/paste.js?v=__BUILD__";
import { captureNotesAnchor, captureSourceAnchor, createCardFromNotesSelection } from "../notes/anchors.js?v=__BUILD__";
import { saveQuickNote } from "../quick-notes/board.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";

// Handle toolbar actions
export function handleToolbarClick(event) {
  const button = event.target.closest("button");
  if (!button) return;

  const toolbar = button.closest(".edit-toolbar");
  if (!toolbar) return;

  // Find the associated textarea
  let textarea = null;
  if (toolbar.id === "questionEditToolbar") {
    textarea = el.questionEdit;
  } else if (toolbar.id === "answerEditToolbar") {
    textarea = el.answerEdit;
  } else if (toolbar.id === "notesEditToolbar") {
    textarea = el.notesEdit;
  } else {
    // Inside dynamic "All cards" editor
    const container = toolbar.closest(".all-card-editor");
    if (container) {
      textarea = container.querySelector("[data-all-edit-value]");
    }
  }

  if (!textarea) return;

  event.preventDefault();

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selectedText = textarea.value.substring(start, end);

  // Quick note: save the selected text as a new card (question) in the
  // quick_notes web deck instead of formatting the textarea.
  if (button.dataset.action === "quick-note") {
    // Capture before closing menus / dropping the selection, so a pin from the
    // raw notes editor can link the quick_notes card back to this spot.
    const anchor = captureSourceAnchor();
    document.querySelectorAll(".edit-toolbar .toolbar-dropdown").forEach(d => {
      d.classList.remove("is-open");
    });
    saveQuickNote(selectedText, button, anchor);
    return;
  }

  // Make a flashcard from the raw-editor selection. The textarea gives exact
  // offsets, so captureNotesAnchor's editing branch resolves the source spot
  // precisely — no fuzzy re-find needed.
  if (button.dataset.action === "make-card") {
    if (!selectedText.trim()) {
      setStatus("Select some text first, then tap + to turn it into a card.", "error");
      return;
    }
    const anchor = captureNotesAnchor();
    document.querySelectorAll(".edit-toolbar .toolbar-dropdown").forEach((d) => {
      d.classList.remove("is-open");
    });
    createCardFromNotesSelection(selectedText, anchor);
    return;
  }

  // Insert image: open a file picker, then upload each chosen image to Supabase Storage and
  // insert markdown at the caret this toolbar's textarea had before the picker opened.
  if (button.dataset.action === "insert-image") {
    openImagePicker(textarea, start);
    return;
  }

  let formatFn = null;

  // Toggle actions look at text just outside the selection too (see
  // toggleWrapPair), so they take the full value + range and may return an
  // extended range that swallows adjacent markers. Everything else only
  // touches the selected substring and keeps the original [start, end) range.
  if (button.dataset.action === "bold") {
    formatFn = (val, s, e) => toggleWrap(val, s, e, "**");
  } else if (button.dataset.action === "italic") {
    formatFn = (val, s, e) => toggleWrap(val, s, e, "*");
  } else if (button.dataset.action === "underline") {
    formatFn = (val, s, e) => toggleUnderline(val, s, e);
  } else if (button.dataset.action === "strikethrough") {
    formatFn = (val, s, e) => toggleStrikethrough(val, s, e);
  } else if (button.dataset.action === "code") {
    formatFn = (val, s, e) => toggleCode(val, s, e);
  } else if (button.dataset.action === "cloze") {
    formatFn = (val, s, e) => toggleCloze(val, s, e);
  } else if (button.dataset.action === "kbd") {
    formatFn = (val, s, e) => toggleKbd(val, s, e);
  } else if (button.dataset.action === "bullet") {
    formatFn = (val, s, e) => toggleBulletPoints(val.slice(s, e));
  } else if (button.dataset.action === "clear-all") {
    formatFn = (val, s, e) => clearFormatting(val.slice(s, e));
  } else if (button.dataset.font) {
    const font = button.dataset.font;
    formatFn = (val, s, e) => applyInlineStyleProperty(val.slice(s, e), "font-family", font);
  } else if (button.dataset.color) {
    const color = button.dataset.color;
    // Same choice, same shared default. Without this the raw editor and the
    // rendered view kept two different opinions about "the current colour":
    // pick Green here and the floating pill's swatch (and its one-tap apply)
    // still said yellow. setRenderDefault ignores "clear", which is an action.
    setRenderDefault("color", color);
    if (color === "clear") {
      formatFn = (val, s, e) => clearInlineStyleProperty(val.slice(s, e), "color");
    } else {
      formatFn = (val, s, e) => applyInlineStyleProperty(val.slice(s, e), "color", color);
    }
  } else if (button.dataset.highlight) {
    const highlight = button.dataset.highlight;
    setRenderDefault("highlight", highlight);
    formatFn = (val, s, e) => toggleMarkColorInText(val.slice(s, e), highlight);
  }

  if (!formatFn) return;

  // Shared with the floating pill's formatting buttons, which run the same
  // formatFns against the same textareas — see applyFormatToTextarea.
  applyFormatToTextarea(textarea, formatFn);

  // Close all open dropdowns after action is applied
  document.querySelectorAll(".edit-toolbar .toolbar-dropdown").forEach(d => {
    d.classList.remove("is-open");
  });
}
