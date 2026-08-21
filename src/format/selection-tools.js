// The floating toolbar on a notes selection: cloze it, highlight it, erase it,
// or lift it out into a note of its own.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { addDocumentHighlight, documentHighlightAtPoint, removeDocumentHighlight } from "../documents/pdf-highlights.js?v=__BUILD__";
import { captureDocumentSelection } from "../documents/pdf-selection.js?v=__BUILD__";
import { isDocumentViewActive } from "../documents/pdf-view.js?v=__BUILD__";
import { toggleWrapPair } from "../editor/text-transforms.js?v=__BUILD__";
import { MARK_HIGHLIGHT_COLORS } from "./highlight-colors.js?v=__BUILD__";
import { makeHighlightFromSelection, toggleMarkColorInText } from "./highlight.js?v=__BUILD__";
import { locateSelectionInSource, renderedSelectionStrings } from "./locate-selection.js?v=__BUILD__";
import { renderFormatDefaults, renderTargetConfig } from "./render-toolbar.js?v=__BUILD__";
import { createLinkedNoteFlow } from "../notes/note-links.js?v=__BUILD__";
import { pushNotesUndo } from "../notes/notes-history.js?v=__BUILD__";
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { currentDeckKey } from "../notes/scroll-anchor.js?v=__BUILD__";
import { activeEditingTarget, activeRenderedTarget, ensurePillSelectionCapture, hideNotesSelectionButton, pillSelectionCapture } from "../notes/selection.js?v=__BUILD__";
import { noteLinkMarkupFor } from "../render/note-links.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { styleMobileMedia } from "../ui/style-tokens.js?v=__BUILD__";

// On mobile the button is pinned to a fixed spot at the bottom of the screen
// (see pinSelectionButtonToBottom) rather than tracking the selection's own
// position, precisely so that scrolling — the normal way to extend a
// selection past the visible edge — doesn't make it disappear. Desktop keeps
// hiding it on scroll, since there its position is tied to the selection rect
// and would otherwise go stale.
export function hideNotesSelectionButtonUnlessPinned() {
  if (styleMobileMedia?.matches) return;
  hideNotesSelectionButton();
}

// ── The textarea half of the shared formatting contract ────────────────────
//
// A format is a pure function `formatFn(value, start, end)` returning either a
// replacement string for [start, end) or a { text, rangeStart, rangeEnd } that
// swallows adjacent markers (see toggleWrapPair — un-bolding has to eat the
// "**" sitting just OUTSIDE the selection). applyRenderFormat is the rendered
// half, resolving [start, end) by matching the rendered selection back into the
// source; this is the raw half, where the textarea hands those offsets over
// exactly and no search is needed.
//
// One definition of the write-back, because there are two callers: the raw
// editor's own toolbar and — now that it is the only formatting surface in
// either mode — the floating pill.
export function applyFormatToTextarea(textarea, formatFn) {
  if (!textarea || textarea.hidden) return false;
  // Every formatting button in either mode ends up here, and the assignment
  // below is what throws away the browser's own undo for this field. Snapshot
  // first so Ctrl+Z has somewhere to go back to. Notes only: a card face keeps
  // native undo, which is finer-grained for plain typing.
  if (textarea === el.notesEdit) pushNotesUndo("formatting");
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const result = formatFn(value, start, end);
  if (result == null) return false;
  const isRange = typeof result === "object";
  const replacement = isRange ? result.text : result;
  const rangeStart = isRange ? result.rangeStart : start;
  const rangeEnd = isRange ? result.rangeEnd : end;
  textarea.focus();
  textarea.value = value.slice(0, rangeStart) + replacement + value.slice(rangeEnd);
  // The formatted text stays selected, so a second button applies to the same
  // words rather than to a collapsed caret.
  textarea.setSelectionRange(rangeStart, rangeStart + replacement.length);
  // Persist through the editor's own input path, same as any other raw edit.
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

// Wrap the raw-editor (textarea) selection in {{ }} — the edit-mode counterpart
// to makeClozeFromSelection (which works on a rendered-view selection).
export function clozeTextareaSelection(target) {
  const ta = target?.edit;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  if (start === end) return;
  if (ta === el.notesEdit) pushNotesUndo("cloze");
  const result = toggleWrapPair(ta.value, start, end, "{{", "}}");
  ta.value = ta.value.slice(0, result.rangeStart) + result.text + ta.value.slice(result.rangeEnd);
  const caret = result.rangeStart + result.text.length;
  ta.setSelectionRange(caret, caret);
  ta.focus();
  // Persist through the editor's own input path (updates state.notes for notes;
  // card faces commit on blur/next commit, same as any other raw edit).
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  showToast(result.text.startsWith("{{") ? "Cloze added" : "Cloze removed");
}

// Which selection a pill button should act on. The LIVE selection wins when
// it's still there (desktop: pointerdown + preventDefault keeps it alive);
// the position-time snapshot (pillSelectionCapture) is the fallback for touch
// platforms where the tap itself dissolved it. Returns
//   { kind:"rendered", name, sel } | { kind:"editing", target } | null
export function pillActionTarget() {
  // The Document surface answers first, and answers with a shape of its own.
  // Everything below resolves a target by NAME so renderTargetConfig can hand
  // back a markdown source to splice into; there is no markdown here, and the
  // selection is captured as PDF coordinates instead.
  //
  // Captured on the spot rather than from pillSelectionCapture: every pill
  // button is pointerdown + preventDefault, so the selection is still alive at
  // this instant, and a document capture is cheap (a range walk and its client
  // rects) in a way the markdown one is not.
  if (isDocumentViewActive()) {
    const capture = captureDocumentSelection();
    return capture ? { kind: "document", capture } : null;
  }
  // The expensive half of the capture is deferred so the bar can appear at once
  // (see schedulePillSelectionCapture). If a button is pressed before that pass
  // has run, this is where it gets paid for — still with the selection alive,
  // because a press cannot come before the release that showed the bar.
  ensurePillSelectionCapture();
  const rendered = activeRenderedTarget();
  if (rendered) {
    const sel = pillSelectionCapture && !pillSelectionCapture.editing && pillSelectionCapture.targetName === rendered.name
      ? pillSelectionCapture.sel
      : null;
    return { kind: "rendered", name: rendered.name, sel };
  }
  const editing = activeEditingTarget();
  if (editing) return { kind: "editing", target: editing };
  if (pillSelectionCapture && !pillSelectionCapture.editing) {
    return { kind: "rendered", name: pillSelectionCapture.targetName, sel: pillSelectionCapture.sel };
  }
  return null;
}

// Raw-editor (textarea) counterpart of the highlight button: the textarea
// hands us an exact [start,end), so there's no source search — wrap, recolour
// or strip the substring directly, same as the edit toolbar's Highlight
// dropdown (toggleMarkColorInText) but as a one-tap apply of the shared
// last-used swatch.
export function highlightTextareaSelection(target, color = renderFormatDefaults.highlight) {
  const ta = target?.edit;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  if (start === end) return;
  if (ta === el.notesEdit) pushNotesUndo("highlight");
  const selected = ta.value.slice(start, end);
  const wrapped = toggleMarkColorInText(selected, color);
  ta.value = ta.value.slice(0, start) + wrapped + ta.value.slice(end);
  ta.setSelectionRange(start, start + wrapped.length);
  ta.focus();
  // Persist through the editor's own input path, same as any other raw edit.
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// Raw-editor counterpart of the eraser: splice the selection out of the
// textarea. (Native Backspace already did this; the button exists so the pill
// behaves the same in both modes — the reported bug was that it looked
// available and did nothing.)
export function eraseTextareaSelection(target) {
  const ta = target?.edit;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  if (start === end) return;
  if (ta === el.notesEdit) pushNotesUndo("erase");
  ta.value = ta.value.slice(0, start) + ta.value.slice(end);
  ta.setSelectionRange(start, start);
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  showToast("Selection erased");
}

// ── The pill's own colour menu ─────────────────────────────────────────────
//
// Why it exists rather than sending you to the render toolbar: reaching the
// toolbar means letting go of the selection, and on a touch device that ends
// the selection outright. The pill is the one surface guaranteed to still be
// there, so the choice has to be makeable from it.
//
// Everything here is pointerdown + preventDefault, exactly like the other pill
// buttons, so no tap ever collapses the selection being acted on.
export function applyPillHighlight(color) {
  const target = pillActionTarget();
  if (target?.kind === "document") {
    // "clear" on the document surface means "un-highlight what I have
    // selected", the same as it does in a note — resolved by hit-testing the
    // selection's own first quad rather than by stripping tags, since there are
    // no tags to strip.
    if (color === "clear") {
      const rect = window.getSelection()?.rangeCount
        ? window.getSelection().getRangeAt(0).getBoundingClientRect()
        : null;
      const record = rect ? documentHighlightAtPoint(rect.left + 1, rect.top + rect.height / 2) : null;
      if (record) removeDocumentHighlight(record.id);
      else showToast("Nothing highlighted there", "error");
    } else {
      addDocumentHighlight(target.capture, color);
    }
    // The selection has served its purpose and a live one over a fresh
    // highlight hides the colour that was just applied.
    window.getSelection()?.removeAllRanges();
  } else if (target?.kind === "rendered") {
    makeHighlightFromSelection(renderTargetConfig(target.name), color, target.sel);
  } else if (target?.kind === "editing") {
    highlightTextareaSelection(target.target, color);
  }
  closePillHighlightMenu();
  hideNotesSelectionButton();
}

export function closePillHighlightMenu() {
  if (!el.highlightSelectionMenu) return;
  el.highlightSelectionMenu.hidden = true;
  el.highlightSelectionMenuBtn?.setAttribute("aria-expanded", "false");
}

export function buildPillHighlightMenu() {
  if (!el.highlightSelectionMenu || el.highlightSelectionMenu.childElementCount) return;
  el.highlightSelectionMenu.innerHTML =
    MARK_HIGHLIGHT_COLORS.map(
      (c) =>
        `<button type="button" class="pill-swatch-btn" data-pill-highlight="${c.value}" style="--sw:${c.swatch};" title="${c.name}" aria-label="${c.name}"></button>`
    ).join("") +
    '<button type="button" class="pill-swatch-clear" data-pill-highlight="clear" title="Remove highlight" aria-label="Remove highlight">&#10005;</button>';
}

// ── Split a note: selection → its own note, with a link left behind ─────────
//
// The "this has got too long" action. Select the section that has outgrown its
// home, and it MOVES to a note of its own with a [[reference]] taking its place
// — so the shape of the argument you were writing survives, one line long
// instead of three pages.
//
// Notes only, in both modes. Extracting from a card face would leave a link on
// a flashcard, which is not a thing you can follow while studying.
export function promptForText(title, hint, suggestion) {
  return new Promise((resolve) => {
    let watch = 0;
    const settle = (value) => {
      if (watch) clearInterval(watch);
      watch = 0;
      resolve(value);
    };
    // Empty field, suggestion as the placeholder — the convention every other
    // prompt in this app follows, so there is nothing to delete before typing
    // and pressing Enter accepts the suggestion.
    // The watchdog is stopped HERE rather than left for its own next tick to
    // notice: a submitted prompt has nothing left to watch for.
    showPromptModal(title, hint, "", settle, { placeholder: suggestion });
    // showPromptModal has no cancel callback, so a dismissed dialog would leave
    // this promise pending forever. Watch for the modal going away instead.
    watch = setInterval(() => {
      if (el.promptModal?.hidden) settle(null);
    }, 200);
  });
}

// A sensible name to offer: the selection's first heading, else its first line,
// trimmed to something that reads as a title rather than a paragraph.
export function suggestedNoteTitle(body) {
  const firstLine = String(body || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  const heading = firstLine.match(/^#{1,6}\s+(.*)$/);
  const text = (heading ? heading[1] : firstLine).replace(/[*_`>#]/g, "").trim();
  if (!text) return "";
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
}

export async function extractSelectionToNote() {
  if (state.viewMode !== "notes") {
    showToast("Open a note first, then select the part to split out", "error");
    return;
  }
  const target = pillActionTarget();
  // Which note this splice belongs to. Everything below — `start`/`end` in the
  // textarea branch, `loc` in the rendered one — is an OFFSET INTO THIS NOTE,
  // captured now but not applied until after two modals have been awaited. If
  // the open note changed in between (a Back press, a sync pull reloading the
  // active deck), those offsets address text that is no longer there and
  // applyLink would splice a link into the middle of an unrelated note.
  const startedIn = currentDeckKey();

  // Both modes end up as: the markdown being moved, plus a way to put the link
  // back where it came from.
  let body = "";
  let applyLink = null;

  if (target?.kind === "editing" && target.target?.edit === el.notesEdit) {
    const textarea = el.notesEdit;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) {
      showToast("Select the text to move into its own note first", "error");
      return;
    }
    body = textarea.value.slice(start, end);
    applyLink = (link) => {
      pushNotesUndo("split into its own note");
      textarea.value = textarea.value.slice(0, start) + link + textarea.value.slice(end);
      const at = start + link.length;
      textarea.setSelectionRange(at, at);
      textarea.focus();
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };
  } else if (target?.kind === "rendered" && target.name === "notes") {
    const sel = target.sel || renderedSelectionStrings(el.notesView);
    if (!sel) {
      showToast("Select the text to move into its own note first", "error");
      return;
    }
    // Same locate-then-splice the eraser uses, so a selection that spans list
    // items or padded bullets is found the same way there as here.
    const loc = locateSelectionInSource(state.notes || "", sel, { fuzzy: true });
    if (!loc) {
      showToast("Couldn't match that selection in the note — try selecting within one section.", "error");
      return;
    }
    body = sel.asMarkdown || sel.asText || "";
    applyLink = (link) => {
      const notes = state.notes || "";
      pushNotesUndo("split into its own note");
      state.notes = notes.slice(0, loc.idx) + link + notes.slice(loc.end);
      window.getSelection()?.removeAllRanges();
      // renderNotesViewPinned, not a bare renderNotesView(). This is an edit to
      // the note the reader is looking at, exactly like a highlight or a cloze,
      // and it was the one such path still repainting as though a DIFFERENT note
      // had been opened: that releases the deferred-work queue and re-derives
      // the measured block-height estimate, which re-sizes every off-screen
      // block INCLUDING the ones above the viewport. The reader was moved by
      // however much the whole document's estimate shifted — a much bigger jump
      // than the one this text actually removed.
      //
      // setNotesScrolledSource(null) went with it: it exists to tell the next
      // render "this is a new document", which is precisely the claim that was
      // wrong here.
      renderNotesViewPinned();
      scheduleDeckAutosave();
    };
  } else {
    showToast("Select the text to move into its own note first", "error");
    return;
  }

  if (!body.trim()) {
    showToast("Nothing selected to move", "error");
    return;
  }

  hideNotesSelectionButton();
  const title = await promptForText(
    "Split into its own note",
    "The selected text moves into a new note, and a link to it takes its place here.",
    suggestedNoteTitle(body)
  );
  if (title === null) return;
  const name = String(title || "").trim() || suggestedNoteTitle(body) || "Untitled note";

  const created = await createLinkedNoteFlow(name, body);
  if (!created) return;
  // See startedIn. The new note has already been written and keeps the text, so
  // nothing is lost — but the link must not be spliced into a different note.
  if (currentDeckKey() !== startedIn) {
    showToast(`Made "${created.title}", but you'd moved on — the link wasn't inserted`, "info");
    return;
  }
  applyLink(noteLinkMarkupFor(created));
  showToast(`Moved into "${created.title}"`);
}
