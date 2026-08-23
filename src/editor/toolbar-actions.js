// The raw editor's toolbar: which button does which transform.

import { el } from "../core/dom.js?v=__BUILD__";
import { closeAllEditToolbarDropdowns } from "./toolbars.js?v=__BUILD__";
import { applyInlineStyleProperty, clearFormatting, clearInlineStyleProperty, toggleBulletPoints, toggleCloze, toggleCode, toggleKbd, toggleStrikethrough, toggleUnderline, toggleWrap } from "./text-transforms.js?v=__BUILD__";
import { toggleMarkColorInText } from "../format/highlight.js?v=__BUILD__";
import { setRenderDefault } from "../format/render-toolbar.js?v=__BUILD__";
import { applyFormatToTextarea } from "../format/selection-tools.js?v=__BUILD__";
import { openImagePicker } from "../images/paste.js?v=__BUILD__";
import { captureNotesAnchor, captureSourceAnchor, createCardFromNotesSelection } from "../notes/anchors.js?v=__BUILD__";
import { saveQuickNote } from "../quick-notes/board.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";

// ── What a control MEANS, apart from which control it was ──────────────────
//
// Lifted out of handleToolbarClick so a keystroke can ask for the same
// transform a button does. It was a chain of `button.dataset.…` tests, which
// made "bold" a property of a DOM node rather than a thing the editor can do —
// and Ctrl+B had nowhere to look it up.
//
// The setRenderDefault calls stay INSIDE it, because remembering the colour you
// just chose is part of what choosing it means, whichever way you chose it.
//
// Returns null for anything that is not a formatting action (quick-note,
// make-card, insert-image — see their early returns above), which is what every
// caller treats as "not mine".
export function toolbarFormatFn({ action, font, color, highlight } = {}) {
  let formatFn = null;

  // Toggle actions look at text just outside the selection too (see
  // toggleWrapPair), so they take the full value + range and may return an
  // extended range that swallows adjacent markers. Everything else only
  // touches the selected substring and keeps the original [start, end) range.
  if (action === "bold") {
    formatFn = (val, s, e) => toggleWrap(val, s, e, "**");
  } else if (action === "italic") {
    formatFn = (val, s, e) => toggleWrap(val, s, e, "*");
  } else if (action === "underline") {
    formatFn = (val, s, e) => toggleUnderline(val, s, e);
  } else if (action === "strikethrough") {
    formatFn = (val, s, e) => toggleStrikethrough(val, s, e);
  } else if (action === "code") {
    formatFn = (val, s, e) => toggleCode(val, s, e);
  } else if (action === "cloze") {
    formatFn = (val, s, e) => toggleCloze(val, s, e);
  } else if (action === "kbd") {
    formatFn = (val, s, e) => toggleKbd(val, s, e);
  } else if (action === "bullet") {
    formatFn = (val, s, e) => toggleBulletPoints(val.slice(s, e));
  } else if (action === "clear-all") {
    formatFn = (val, s, e) => clearFormatting(val.slice(s, e));
  } else if (font) {
    const font = font;
    formatFn = (val, s, e) => applyInlineStyleProperty(val.slice(s, e), "font-family", font);
  } else if (color) {
    const color = color;
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
  } else if (highlight) {
    const highlight = highlight;
    setRenderDefault("highlight", highlight);
    formatFn = (val, s, e) => toggleMarkColorInText(val.slice(s, e), highlight);
  }

  return formatFn;
}

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
    } else {
      // The note-over-highlight popup editor (src/notes/highlight-note-editor.js)
      // — same "dynamic container, textarea marked by a data attribute" idiom
      // as the All Cards editor above, since it's likewise outside the three
      // fixed editing surfaces.
      const noteEditor = toolbar.closest(".highlight-note-editor");
      if (noteEditor) textarea = noteEditor.querySelector("[data-note-edit-value]");
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
    closeAllEditToolbarDropdowns();
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
    closeAllEditToolbarDropdowns();
    createCardFromNotesSelection(selectedText, anchor);
    return;
  }

  // Insert image: open a file picker, then upload each chosen image to Supabase Storage and
  // insert markdown at the caret this toolbar's textarea had before the picker opened.
  if (button.dataset.action === "insert-image") {
    openImagePicker(textarea, start);
    return;
  }

  const formatFn = toolbarFormatFn(button.dataset);

  if (!formatFn) return;

  // Shared with the floating pill's formatting buttons, which run the same
  // formatFns against the same textareas — see applyFormatToTextarea.
  applyFormatToTextarea(textarea, formatFn);

  // Close all open dropdowns after action is applied
  closeAllEditToolbarDropdowns();
}
