// The popup editor for a note attached to a highlight (Kindle-style
// "note over a highlight" — see format/highlight-notes.js for the storage
// side: the text is saved as plain markdown in a "Highlight Notes" section at
// the end of the note, so anything written here can equally be edited by hand
// in the raw editor). One singleton element, lazily built and repositioned/repopulated
// per open, the same idiom mark-menu.js uses for its own floating popup.
//
// Responsive without two code paths: the DOM is identical on phone and
// desktop, and styles/27-highlight-notes.css alone decides whether it renders
// as a floating window (positioned near the mark/row that opened it, and then
// wherever the reader puts it) or a full-width bottom sheet (a fixed CSS
// media-query rule that overrides the inline geometry the desktop branch sets).
//
// ── It saves as you type ──────────────────────────────────────────────────
//
// There was a Save button and a Cancel button. Nothing else in this app has
// one: the notes editor commits on input, a card face commits on blur, the
// deck autosaves on a timer. A note about a highlight is a sentence you jot
// while reading, and asking for a deliberate commit on it — with the popup
// closing on Escape and on a click outside, both of which threw the text away
// — meant the one surface in the app where you could lose what you had
// written. See flushNoteSave and the { rerender, undo } options it leans on.
//
// ── ...and it is a window, not a tooltip ──────────────────────────────────
//
// It used to be pinned under the mark that opened it, at a fixed size. Which is
// right for a glance and wrong for everything else: a note long enough to need
// two paragraphs was written through a 160px slot, and the popup covered the
// very sentence it was about, so there was no way to re-read the highlight
// while annotating it. It is now dragged by its header, resized from its
// corner, and remembers both — a reader who parks it on the right-hand margin
// gets it there for every highlight afterwards.

import { createToolbarHtml } from "../editor/toolbars.js?v=__BUILD__";
import { enableSyntaxHighlighting, refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { clearHighlightNoteAt, setHighlightNoteAt } from "../format/highlight-notes.js?v=__BUILD__";
import { enhanceSurfaceDiagramControls, enhanceSurfaceImageControls } from "../images/surface-controls.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { renderNotesViewPinned } from "./notes-view.js?v=__BUILD__";
import { styleMobileMedia } from "../ui/style-tokens.js?v=__BUILD__";

let els = null;
// The key of the highlight being edited: a <mark>'s ordinal in state.notes for
// a note, a document highlight's own id for a PDF. null — never -1 — means "no
// editor open", so that a key of 0 (the first mark in a note) is not mistaken
// for "closed".
let openMarkIndex = null;

// ── Autosave ──────────────────────────────────────────────────────────────
//
// Long enough that a normal typing rhythm produces one save per phrase rather
// than one per word; short enough that the "Saved" line is reassurance rather
// than a question. Every way out of the popup flushes, so this only ever
// governs saves made WHILE typing — nothing depends on the timer having fired.
export const NOTE_AUTOSAVE_MS = 700;

let saveTimer = 0;
// The text last written to state.notes for the open mark. An unchanged value is
// not a save: without this, opening a note and closing it again would rewrite
// the section (and mark the deck dirty) for an edit nobody made.
let savedText = "";
// One undo snapshot per editing session, not one per pause — see the comment on
// rewriteFirstMarkNote's options.
let undoPushed = false;
// Whether anything was actually written since the popup opened, so close() can
// repaint the note exactly once and only when there is something to repaint.
let dirtySinceOpen = false;

// ── The remembered window box ─────────────────────────────────────────────
// Same shape as FOCUS_MODE_KEY: a preference about how you like to work, not
// about one note, so it belongs to the device rather than to the deck.
export const NOTE_EDITOR_BOX_KEY = "recall:highlightNoteBox";

export function readStoredNoteBox() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTE_EDITOR_BOX_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const box = ["top", "left", "width", "height"].every((k) => Number.isFinite(raw[k])) ? raw : null;
    return box;
  } catch (_) {
    return null; // private mode, or something else wrote the key
  }
}

export function writeStoredNoteBox(box) {
  try {
    localStorage.setItem(NOTE_EDITOR_BOX_KEY, JSON.stringify(box));
  } catch (_) {
    /* private mode — the window still moves, it just won't be remembered */
  }
}

function ensureHighlightNoteEditor() {
  if (els?.root?.isConnected) return els;

  const root = document.createElement("div");
  root.className = "highlight-note-editor";
  root.hidden = true;

  const header = document.createElement("div");
  header.className = "highlight-note-editor-head";
  const title = document.createElement("span");
  title.className = "highlight-note-editor-title";
  title.textContent = "Note";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "highlight-note-editor-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  header.append(title, closeBtn);

  const modeRow = document.createElement("div");
  modeRow.className = "highlight-note-editor-modes";
  const writeBtn = document.createElement("button");
  writeBtn.type = "button";
  writeBtn.className = "highlight-note-editor-mode is-active";
  writeBtn.textContent = "Write";
  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "highlight-note-editor-mode";
  previewBtn.textContent = "Preview";
  modeRow.append(writeBtn, previewBtn);

  // Full formatting toolbar — bold/italic/lists/image-upload/etc, the same
  // one the main notes editor and All Cards use (createToolbarHtml). This
  // surface isn't in SELECTION_TARGETS (the floating format pill only covers
  // notes/question/answer), so unlike those it needs the toolbar's OWN full
  // strip rather than the line-tools-only variant. Clicks are handled by the
  // existing global delegated listener (handleToolbarClick in
  // src/editor/toolbar-actions.js) — it resolves the target textarea via
  // `.highlight-note-editor` + `[data-note-edit-value]`, the same
  // dynamic-container idiom the All Cards editor uses for its own textareas.
  const toolbarWrap = document.createElement("div");
  toolbarWrap.className = "highlight-note-editor-toolbar-wrap";
  const toolbar = document.createElement("div");
  toolbar.className = "edit-toolbar";
  toolbar.innerHTML = createToolbarHtml();
  toolbarWrap.appendChild(toolbar);

  const textarea = document.createElement("textarea");
  // edit-textarea: required by enableSyntaxHighlighting (makes the textarea's
  // own text transparent so the styled backdrop mirror underneath is what's
  // actually seen — see editor/highlight-mirror.js).
  textarea.className = "highlight-note-editor-input edit-textarea";
  textarea.placeholder = "Write a note about this highlight… (Markdown supported — images, lists, bold, etc.)";
  textarea.spellcheck = true;
  textarea.dataset.noteEditValue = "";

  const rendered = document.createElement("div");
  rendered.className = "highlight-note-editor-rendered rendered";
  rendered.hidden = true;

  const footer = document.createElement("div");
  footer.className = "highlight-note-editor-foot";
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "highlight-note-editor-delete";
  deleteBtn.textContent = "Delete note";
  const spacer = document.createElement("span");
  spacer.className = "highlight-note-editor-spacer";
  // Where Save and Cancel used to be. A status line, not a button: there is
  // nothing left to press, and the only question the two buttons were really
  // answering ("is my text safe?") is the one this answers directly.
  // aria-live so a screen reader hears the save land without being interrupted
  // mid-sentence — polite, because it is reassurance rather than news.
  const status = document.createElement("span");
  status.className = "highlight-note-editor-status";
  status.setAttribute("aria-live", "polite");
  footer.append(deleteBtn, spacer, status);

  // Bottom-right resize grip. Same idiom as the notes' own image handles
  // (src/images/surface-controls.js): a real element rather than CSS `resize`,
  // because `resize` needs `overflow: auto` on the box it is applied to and
  // this popup's scrolling belongs to the textarea and the preview inside it.
  const grip = document.createElement("span");
  grip.className = "highlight-note-editor-grip";
  grip.setAttribute("aria-hidden", "true");

  root.append(header, modeRow, toolbarWrap, textarea, rendered, footer, grip);
  document.body.appendChild(root);

  // enableSyntaxHighlighting reparents `textarea` into its own wrapper/backdrop
  // in place, so it has to run AFTER the textarea is already positioned in the
  // document (root.append above) — its insertBefore relies on a real parent.
  // It always wraps unconditionally, so textarea.parentNode is that wrapper
  // from here on — captured once rather than re-queried by setMode below.
  enableSyntaxHighlighting(textarea);
  const textareaWrapper = textarea.parentElement;

  // Toolbar dropdowns (font/colour/highlight) aren't covered by the global
  // closeAllEditToolbarDropdowns — that's scoped to the three fixed editor
  // toolbars only (see editor/toolbars.js:editToolbars) — so this popup closes
  // its own on any click elsewhere inside it, and always on close.
  root.addEventListener("click", (event) => {
    if (event.target.closest(".toolbar-dropdown")) return;
    toolbar.querySelectorAll(".toolbar-dropdown.is-open").forEach((d) => d.classList.remove("is-open"));
  });

  // Corner-drag resize/delete for an image or diagram in the note, same as
  // the main notes editor — enhanceSurfaceImageControls/
  // enhanceSurfaceDiagramControls (src/images/surface-controls.js) don't
  // care which of the app's fixed surfaces they're pointed at; they only
  // need something shaped like a render target (view + getSource/setSource/
  // rerender), so this popup gets its own rather than needing to be one of
  // the 3 hardcoded names (notes/question/answer). A resize/delete commits
  // through setSource into THIS note's own textarea, not state.notes.
  const noteSurface = {
    view: rendered,
    getSource: () => textarea.value,
    setSource: (v) => {
      textarea.value = v;
      // A programmatic .value write fires no "input" event, which the
      // syntax-highlight backdrop normally syncs itself from.
      refreshHighlightBackdrop(textarea);
    },
    rerender: () => renderPreview()
  };

  function renderPreview() {
    // Unhidden BEFORE rendering, not after: a mermaid diagram inside the note
    // needs real layout to size against, which a `hidden` (display:none)
    // container has none of — see renderMarkdown/enhanceRenderedMarkdown.
    // Same full pipeline the Highlights panel now uses (not the bare
    // markdownToSafeHtml pass) so LaTeX and images in a note actually render
    // instead of showing raw "$…$" or a broken image icon — and so the
    // resize/delete grips below have real <img>/diagram elements to attach to.
    return renderMarkdown(rendered, textarea.value).then(() => {
      enhanceSurfaceImageControls(noteSurface);
      enhanceSurfaceDiagramControls(noteSurface);
    });
  }

  // ── Saving ───────────────────────────────────────────────────────────────
  //
  // The one place a note is written, so the four ways out of the popup and the
  // debounce all agree about what "saved" means. Returns without touching
  // anything when the text has not moved since the last write — which is the
  // common case for open-and-close, and is what stops merely LOOKING at a note
  // rewriting the section and marking the deck dirty.
  const flushNoteSave = () => {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (openMarkIndex == null) return;
    const text = textarea.value;
    if (text === savedText) return;
    // { rerender: false } — the text being written lives in the "Highlight
    // Notes" section at the END of the document, not in the paragraph the
    // reader is looking at, so there is nothing on screen to repaint and
    // renderNotesViewPinned on a book between keystrokes is not a thing to do.
    // The one repaint happens on close, where it also picks up the inline copy
    // (src/notes/inline-highlight-notes.js).
    //
    // { undo: !undoPushed } — one Ctrl+Z step for the whole editing session,
    // the same shape applyFormatToTextarea uses for a formatting run. A stack
    // with one entry per typing pause is not an undo stack.
    noteHandlers.save(openMarkIndex, text, { rerender: false, undo: !undoPushed });
    undoPushed = true;
    savedText = text;
    dirtySinceOpen = true;
    // The delete button only makes sense once there is something to delete,
    // and autosave is what makes that change while the popup is open.
    deleteBtn.hidden = !text.trim();
    showSaved();
  };

  let savedFadeTimer = 0;
  function showSaved() {
    clearTimeout(savedFadeTimer);
    status.textContent = "Saved";
    status.classList.add("is-visible");
    // Fades rather than sticks. A permanent "Saved" is a label, and a label
    // that never changes stops being read; one that appears as you pause says
    // something.
    savedFadeTimer = setTimeout(() => status.classList.remove("is-visible"), 1800);
  }

  textarea.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushNoteSave, NOTE_AUTOSAVE_MS);
  });

  const setMode = (mode) => {
    const write = mode === "write";
    // Switching to Preview must show what is SAVED, and what is saved is
    // whatever is in the textarea — so flush first and let renderPreview read
    // the same string the section now holds.
    if (!write) flushNoteSave();
    writeBtn.classList.toggle("is-active", write);
    previewBtn.classList.toggle("is-active", !write);
    toolbarWrap.hidden = !write;
    textareaWrapper.hidden = !write;
    rendered.hidden = write;
    if (!write) renderPreview();
    if (write) textarea.focus();
  };
  writeBtn.addEventListener("click", () => setMode("write"));
  previewBtn.addEventListener("click", () => setMode("preview"));

  closeBtn.addEventListener("click", () => closeHighlightNoteEditor());
  deleteBtn.addEventListener("click", () => {
    if (openMarkIndex == null) return closeHighlightNoteEditor();
    // Cancel the pending autosave rather than letting it re-add what was just
    // deleted: the timer holds the old text, and it would fire after this.
    clearTimeout(saveTimer);
    saveTimer = 0;
    noteHandlers.remove(openMarkIndex, { undo: !undoPushed });
    savedText = "";
    // Deleted, then closed — the note IS gone from the section, and the
    // paragraph it was printed into still shows the old copy until a repaint.
    dirtySinceOpen = true;
    closeHighlightNoteEditor();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !root.hidden) closeHighlightNoteEditor();
  });
  // The tab going away is the one exit that never reaches closeHighlightNote
  // Editor — a phone backgrounding the browser mid-sentence, or the tab being
  // closed outright. Nothing else in the app loses text this way and neither
  // should this.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && !root.hidden) flushNoteSave();
  });

  installNoteWindowGestures(root, header, grip);

  els = { root, textarea, rendered, writeBtn, previewBtn, deleteBtn, status, setMode, flushNoteSave };
  return els;
}

// ── Dragging and resizing the window ──────────────────────────────────────
//
// Both use setPointerCapture, the idiom src/images/surface-controls.js already
// uses for the in-note image handles: the element that took the press keeps
// receiving moves even when the pointer leaves it, so a fast drag cannot slip
// off the 12px grip and strand the gesture.
//
// Desktop only. On a phone the popup is a full-width bottom sheet whose
// geometry the CSS sets with !important (styles/27-highlight-notes.css), so
// there is nothing to drag it to and the inline styles below could not win
// anyway. `isFloating()` is asked per gesture rather than once, because a
// window resized across the breakpoint changes the answer.
export const NOTE_EDITOR_MIN_WIDTH = 300;

export const NOTE_EDITOR_MIN_HEIGHT = 220;

function isFloating() {
  return !styleMobileMedia?.matches;
}

// Kept on screen whatever the reader does with it, and whatever the window does
// afterwards: a box dragged to the right edge of a wide window must not be
// off-screen when the same box is restored in a narrow one.
function clampNoteBox(box) {
  const margin = 8;
  const width = Math.min(Math.max(box.width, NOTE_EDITOR_MIN_WIDTH), Math.max(NOTE_EDITOR_MIN_WIDTH, window.innerWidth - margin * 2));
  const height = Math.min(Math.max(box.height, NOTE_EDITOR_MIN_HEIGHT), Math.max(NOTE_EDITOR_MIN_HEIGHT, window.innerHeight - margin * 2));
  return {
    width,
    height,
    left: Math.min(Math.max(margin, box.left), Math.max(margin, window.innerWidth - width - margin)),
    top: Math.min(Math.max(margin, box.top), Math.max(margin, window.innerHeight - height - margin))
  };
}

export function applyNoteBox(root, box) {
  const clamped = clampNoteBox(box);
  root.style.left = `${clamped.left}px`;
  root.style.top = `${clamped.top}px`;
  root.style.width = `${clamped.width}px`;
  root.style.height = `${clamped.height}px`;
  return clamped;
}

function installNoteWindowGestures(root, header, grip) {
  // One handler shape for both gestures: capture the pointer, remember where
  // the box and the pointer started, and write the difference on every move.
  // `read` turns a delta into a box; that is the only thing that differs.
  const startGesture = (element, event, read) => {
    if (!isFloating()) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    const from = { x: event.clientX, y: event.clientY, top: rect.top, left: rect.left, width: rect.width, height: rect.height };
    element.setPointerCapture(event.pointerId);
    root.classList.add("is-adjusting");
    let last = from;
    const move = (moveEvent) => {
      last = applyNoteBox(root, read(from, moveEvent.clientX - from.x, moveEvent.clientY - from.y));
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      root.classList.remove("is-adjusting");
      // Written once, at the end. Persisting on every move would be a
      // localStorage write per frame for a value only the final one matters to.
      writeStoredNoteBox({ top: last.top, left: last.left, width: last.width, height: last.height });
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  };

  header.addEventListener("pointerdown", (event) => {
    // The × lives in the header and is a button, not a handle.
    if (event.target.closest("button")) return;
    startGesture(header, event, (from, dx, dy) => ({
      top: from.top + dy, left: from.left + dx, width: from.width, height: from.height
    }));
  });

  grip.addEventListener("pointerdown", (event) => {
    startGesture(grip, event, (from, dx, dy) => ({
      top: from.top, left: from.left, width: from.width + dx, height: from.height + dy
    }));
  });

  // A window resized smaller can leave the popup off-screen or taller than the
  // viewport. Re-clamped in place, and NOT persisted — the reader's chosen size
  // should come back when the window is big enough for it again.
  window.addEventListener("resize", () => {
    if (root.hidden || !isFloating()) return;
    const rect = root.getBoundingClientRect();
    applyNoteBox(root, { top: rect.top, left: rect.left, width: rect.width, height: rect.height });
  });
}

export function isHighlightNoteEditorOpen() {
  return Boolean(els?.root && !els.root.hidden);
}

export function closeHighlightNoteEditor() {
  if (!els?.root || els.root.hidden) return;
  // Every exit lands here — the ×, Escape, the mark menu opening another note,
  // a view change — so this is the one place that has to make the text safe.
  els.flushNoteSave();
  els.root.hidden = true;
  openMarkIndex = null;
  // The single repaint the autosave deferred. It is what puts the edited note
  // back in front of the reader when the inline mode is on, and what refreshes
  // the mark's own "has a note" underline when the first note on a highlight
  // was just written — so it is skipped only when nothing was written at all.
  if (dirtySinceOpen) noteHandlers.repaint();
  dirtySinceOpen = false;
  noteHandlers = NOTES_NOTE_HANDLERS;
}

// `anchorRect` is whatever the trigger button/mark reports from
// getBoundingClientRect() — used only on desktop-width screens; the mobile
// bottom-sheet layout ignores it entirely (see the CSS media query).
// Where a note is written to, as a pair of verbs.
//
// The editor itself — the draggable window, the write/preview toggle, the
// autosave debounce, the one-undo-step-per-session bookkeeping — is identical
// whether the highlight it belongs to is a <mark> in the markdown or a record
// in meta.pdfHighlights. Only the destination differs, so only the destination
// is passed in. Defaulting to the notes pair keeps every existing caller
// unchanged.
export const NOTES_NOTE_HANDLERS = {
  save: (key, text, options) => setHighlightNoteAt(key, text, options),
  remove: (key, options) => clearHighlightNoteAt(key, options),
  // Called on close. The notes editor repaints the note so the mark's own
  // "has a note" underline and the inline copy both catch up; a document
  // highlight has its own repaint and passes a different one.
  repaint: () => renderNotesViewPinned()
};

let noteHandlers = NOTES_NOTE_HANDLERS;

export function openHighlightNoteEditor(markIndex, anchorRect, existingNoteMarkdown, destination = NOTES_NOTE_HANDLERS) {
  // ── Finish the note that is already open before opening another ──────────
  //
  // closeHighlightNoteEditor's own comment claims "the mark menu opening
  // another note" lands there. It did not: nothing on this path called it, and
  // the popup is a singleton, so opening a second note simply overwrote
  // openMarkIndex and savedText while the 700ms autosave timer from the first
  // was still armed. When that timer fired it read the textarea — which by then
  // held the NEW note — compared it to savedText, found them equal and returned.
  // The last thing typed into the previous highlight's note was gone, with a
  // "Saved" line having been shown for it.
  //
  // Done here rather than at the three call sites (the mark menu, the
  // Highlights panel, a page-note badge) so no fourth one can forget. It is a
  // no-op when nothing is open, and flushing an unchanged note writes nothing.
  closeHighlightNoteEditor();
  const { root, textarea, deleteBtn, status, setMode } = ensureHighlightNoteEditor();
  noteHandlers = destination || NOTES_NOTE_HANDLERS;
  openMarkIndex = markIndex;
  textarea.value = existingNoteMarkdown || "";
  // The session's bookkeeping, reset per open. `savedText` starts as what is
  // already stored, so opening a note and closing it without typing writes
  // nothing; `undoPushed` starts false, so the first real edit takes one
  // snapshot and the rest of the session rides on it.
  savedText = textarea.value;
  undoPushed = false;
  dirtySinceOpen = false;
  status.textContent = "";
  status.classList.remove("is-visible");
  // A programmatic .value write fires no "input" event, which is what the
  // syntax-highlight backdrop normally syncs itself from — without this the
  // backdrop shows whatever the PREVIOUS note left behind (or nothing) while
  // the actual textarea text (invisible — see enableSyntaxHighlighting)
  // shows the real value underneath it.
  refreshHighlightBackdrop(textarea);
  deleteBtn.hidden = !existingNoteMarkdown;
  root.hidden = false;
  // An existing note opens rendered — same as the rest of the app's notes,
  // which you normally see rendered, not raw — so an image inside it (and
  // its resize handle) is visible immediately instead of hiding behind a
  // tap on "Preview" the reader has no reason to expect. A blank note opens
  // in Write mode, since there's nothing yet to preview.
  setMode(existingNoteMarkdown ? "preview" : "write");

  if (styleMobileMedia?.matches) return; // full-width sheet, positioned by CSS alone

  // Where the reader last put it wins over where the mark happens to be. That
  // is the whole point of making it draggable: someone who parks it in the
  // right-hand margin wants it there for the next highlight too, not jumping
  // back under whatever they just tapped. clampNoteBox keeps a box saved on a
  // wide window on screen in a narrow one.
  const stored = readStoredNoteBox();
  if (stored) {
    applyNoteBox(root, stored);
    return;
  }

  // First open on this device: under the mark, above it if there is no room
  // below — the original behaviour, and still the right guess when there is
  // nothing better to go on.
  const box = root.getBoundingClientRect();
  const margin = 8;
  let top = anchorRect.bottom + margin;
  if (top + box.height > window.innerHeight - margin) top = Math.max(margin, anchorRect.top - box.height - margin);
  const left = Math.min(
    Math.max(margin, anchorRect.left),
    Math.max(margin, window.innerWidth - box.width - margin)
  );
  root.style.top = `${top}px`;
  root.style.left = `${left}px`;
}
