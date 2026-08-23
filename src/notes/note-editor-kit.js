// The editor a highlight's note is written in — built once, used in both places
// a note gets written.
//
// ── Why this is one module ────────────────────────────────────────────────
//
// There are two surfaces for the same text. The popup
// (src/notes/highlight-note-editor.js) is a draggable window opened from a mark,
// a badge or a printed page note; the Highlights tab
// (src/panels/highlights-editor.js) opens the note in place, in the flow, where
// it is listed. They are the same note in the same markdown, and they had
// wildly different tools: the popup carried the full formatting toolbar, the
// syntax-highlight mirror, an undo ring, Write/Preview and the in-note image
// grips, and the panel carried a bare <textarea> with Ctrl+B bound to it.
//
// "The texts are not having all the features that we've implemented for raw and
// rendered nodes in notes selection — I want complete feature implementation
// everywhere." Two implementations of one editor is exactly how a surface ends
// up with a quarter of the features, so there is one now.
//
// ── What a caller still owns ──────────────────────────────────────────────
//
// Everything about WHERE the text goes and what the surface looks like around
// it: the popup keeps its header, footer, resize grip and remembered box; the
// panel keeps its entry, its commit-on-blur and its rebuild guard. This module
// owns the parts that were duplicated or missing — the toolbar, the mirror, the
// undo ring, the two modes, the preview render and the image/diagram grips —
// and the registration that makes the floating selection pill work over them.
//
// ── The pill ──────────────────────────────────────────────────────────────
//
// Neither surface raised it before. A note about a highlight is a markdown
// surface with a source that can be spliced, which is the whole contract
// renderTargetConfig describes, so the open editor registers itself as one:
// under a fixed name in src/format/render-toolbar.js (so a pill button can
// resolve it) and as a selection target in src/notes/selection.js (so the pill
// appears at all). Both are dropped on close — a registration outliving its
// textarea would have the pill splicing a detached node's value.

import { enableSyntaxHighlighting, refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { installMarkdownKeys } from "../editor/markdown-keys.js?v=__BUILD__";
import { createToolbarHtml } from "../editor/toolbars.js?v=__BUILD__";
import { clearRenderTarget, registerRenderTarget } from "../format/render-toolbar.js?v=__BUILD__";
import { enhanceSurfaceDiagramControls, enhanceSurfaceImageControls } from "../images/surface-controls.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { NOTE_EDITOR_TARGET, hideNotesSelectionButton, scheduleNotesSelectionCheck, setNoteEditorSelectionTarget } from "./selection.js?v=__BUILD__";

// How many steps back a note's own undo goes. A note is a sentence or two, not
// a document — twenty is far more than anyone walks back through, and the whole
// ring is a few kilobytes of strings.
export const NOTE_UNDO_DEPTH = 20;

export const NOTE_EDITOR_PLACEHOLDER =
  "Write a note about this highlight… (Markdown supported — images, lists, bold, etc.)";

// ── One kit ────────────────────────────────────────────────────────────────
//
// Returns the nodes for the caller to arrange, plus the verbs that act on them.
// Nothing is appended to the document here: the popup puts these between a
// header and a footer, the panel puts them inside an entry, and neither should
// have to undo a placement this module guessed at.
export function createNoteEditorKit({
  placeholder = NOTE_EDITOR_PLACEHOLDER,
  onInput = () => {},
  onModeChange = () => {}
} = {}) {
  // ── Write / Preview ──────────────────────────────────────────────────────
  const modes = document.createElement("div");
  modes.className = "note-editor-modes";
  const writeBtn = document.createElement("button");
  writeBtn.type = "button";
  writeBtn.className = "note-editor-mode is-active";
  writeBtn.textContent = "Write";
  writeBtn.title = "Write in Markdown (Ctrl+E)";
  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "note-editor-mode";
  previewBtn.textContent = "Preview";
  previewBtn.title = "See it rendered (Ctrl+E)";
  modes.append(writeBtn, previewBtn);

  // ── The formatting strip ────────────────────────────────────────────────
  //
  // The FULL toolbar, the one the main notes editor and All Cards use. Clicks
  // are handled by the existing global delegated listener (handleToolbarClick in
  // src/editor/toolbar-actions.js), which resolves the target textarea by
  // looking for `[data-note-edit-value]` inside `.note-editor-kit` — the same
  // dynamic-container idiom the All Cards editor uses for its own textareas.
  const toolbarWrap = document.createElement("div");
  toolbarWrap.className = "note-editor-toolbar-wrap";
  const toolbar = document.createElement("div");
  toolbar.className = "edit-toolbar";
  toolbar.innerHTML = createToolbarHtml();
  toolbarWrap.appendChild(toolbar);

  const textarea = document.createElement("textarea");
  // edit-textarea: required by enableSyntaxHighlighting, which makes the
  // textarea's own text transparent so the styled backdrop mirror underneath is
  // what is actually seen (src/editor/highlight-mirror.js).
  textarea.className = "note-editor-input edit-textarea";
  textarea.placeholder = placeholder;
  textarea.spellcheck = true;
  textarea.dataset.noteEditValue = "";

  const rendered = document.createElement("div");
  rendered.className = "note-editor-rendered rendered";
  rendered.hidden = true;
  // Focusable, so that switching to Preview leaves the focus INSIDE the editor.
  // Two things need that: a keyboard reader who pressed Preview would otherwise
  // be dropped back to the top of the page, and Ctrl+E is bound to the editor's
  // root, so a focus that has fallen out of it takes the key that gets you back
  // out of the preview with it. -1, not 0: it is a destination, not a stop on
  // the way through.
  rendered.tabIndex = -1;

  const root = document.createElement("div");
  root.className = "note-editor-kit";
  root.append(modes, toolbarWrap, textarea, rendered);

  // enableSyntaxHighlighting reparents `textarea` into its own wrapper/backdrop
  // in place, so it has to run AFTER the textarea has a real parent. It always
  // wraps, so textarea.parentElement is that wrapper from here on — captured
  // once rather than re-queried by setMode below.
  enableSyntaxHighlighting(textarea);
  const textareaWrapper = textarea.parentElement;

  // ── Undo, which this surface has to bring itself ─────────────────────────
  //
  // applyFormatToTextarea snapshots for el.notesEdit and nothing else, on the
  // stated ground that "notes textareas already get native per-keystroke undo
  // from the browser". A card face does. This does not, and neither did the
  // notes editor: a programmatic `textarea.value = …` DISCARDS the element's
  // undo transaction, and every toolbar button, every colour and every highlight
  // here is one. So from the first time a reader used any control, Ctrl+Z could
  // not step back past it — and could not step back over their typing either,
  // because the same write threw that away too.
  //
  // A ring rather than a stack with no bottom: this is one note, not a document,
  // and holding every state of it for a session that can run all afternoon is
  // memory spent on steps nobody takes.
  const undoRing = [];
  const redoRing = [];
  const pushUndoSnapshot = () => {
    const snapshot = { value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd };
    // An unchanged value is not a step. Two buttons pressed in a row with
    // nothing in between would otherwise cost two presses of Ctrl+Z to get past.
    if (undoRing.length && undoRing[undoRing.length - 1].value === snapshot.value) return;
    undoRing.push(snapshot);
    if (undoRing.length > NOTE_UNDO_DEPTH) undoRing.shift();
    // A new edit is a new future: whatever was ahead of the caret is gone, the
    // same rule every undo stack in this app follows.
    redoRing.length = 0;
  };
  const restore = (from, to) => {
    const snapshot = from.pop();
    if (!snapshot) return;
    to.push({ value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd });
    textarea.value = snapshot.value;
    textarea.setSelectionRange(snapshot.start, snapshot.end);
    refreshHighlightBackdrop(textarea);
    // Through the editor's own input path, so the autosave and anything sizing
    // the textarea see it exactly as they would see typing.
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // Capture, so it runs before the delegated toolbar handler in
  // src/editor/toolbar-actions.js gets the press and rewrites the value. That
  // ordering is the whole reason this is a listener and not a call inside the
  // handler: the handler serves five surfaces and only this one keeps its own
  // history.
  toolbarWrap.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) pushUndoSnapshot();
  }, true);

  // Toolbar dropdowns (font/colour/highlight) are not covered by the global
  // closeAllEditToolbarDropdowns — that is scoped to the three fixed editor
  // toolbars only (src/editor/toolbars.js) — so this one closes its own on any
  // click elsewhere inside it.
  root.addEventListener("click", (event) => {
    if (event.target.closest(".toolbar-dropdown")) return;
    toolbar.querySelectorAll(".toolbar-dropdown.is-open").forEach((d) => d.classList.remove("is-open"));
  });

  // ── The surface, for everything that edits markdown in place ─────────────
  //
  // enhanceSurfaceImageControls / enhanceSurfaceDiagramControls do not care
  // which of the app's surfaces they are pointed at; they need something shaped
  // like a render target (a view plus getSource/setSource/rerender), and its
  // view and its source have to describe the SAME document or the shell↔markdown
  // matching inside them is invalid. Both are scoped to this note.
  const setValue = (text) => {
    textarea.value = text;
    // A programmatic .value write fires no "input" event, which the
    // syntax-highlight backdrop normally syncs itself from.
    refreshHighlightBackdrop(textarea);
  };

  const surface = {
    view: rendered,
    getSource: () => textarea.value,
    setSource: setValue,
    rerender: () => renderPreview()
  };

  function renderPreview() {
    // Unhidden BEFORE rendering, not after: a mermaid diagram inside the note
    // needs real layout to size against, which a `hidden` (display:none)
    // container has none of — see renderMarkdown/enhanceRenderedMarkdown. The
    // full pipeline, not a bare markdownToSafeHtml pass, so LaTeX and images
    // render instead of showing raw "$…$" and a broken-image icon — and so the
    // grips below have real <img>/diagram elements to attach to.
    return renderMarkdown(rendered, textarea.value).then(() => {
      enhanceSurfaceImageControls(surface);
      enhanceSurfaceDiagramControls(surface);
    });
  }

  // ── The two modes ────────────────────────────────────────────────────────
  //
  // `hidden` goes on the TEXTAREA as well as on its wrapper, and that is
  // load-bearing rather than tidy: isTargetEditing() in src/notes/selection.js
  // reads `edit.hidden` to tell a raw-mode surface from a rendered one, so a
  // textarea left visible-to-the-DOM behind a hidden wrapper would make the
  // preview look like raw-edit mode and the pill would format against a
  // textarea nobody can see.
  const setMode = (mode) => {
    const write = mode === "write";
    writeBtn.classList.toggle("is-active", write);
    previewBtn.classList.toggle("is-active", !write);
    toolbarWrap.hidden = !write;
    textareaWrapper.hidden = !write;
    textarea.hidden = !write;
    rendered.hidden = write;
    onModeChange(write ? "write" : "preview");
    if (!write) renderPreview();
    if (write) textarea.focus();
    else rendered.focus();
  };
  const currentMode = () => (writeBtn.classList.contains("is-active") ? "write" : "preview");

  writeBtn.addEventListener("click", () => setMode("write"));
  previewBtn.addEventListener("click", () => setMode("preview"));

  textarea.addEventListener("input", () => onInput(textarea.value));

  // ── Telling the pill a textarea selection happened ───────────────────────
  //
  // src/main.js says it plainly where it binds these to the three fixed
  // editors: "<textarea> selections don't fire the document selectionchange
  // event reliably across browsers, so raw/edit mode is covered separately via
  // direct mouse/keyboard selection events on each editor itself." That list is
  // el.notesEdit / el.questionEdit / el.answerEdit — three elements that exist
  // in index.html — and this textarea is built per open, so it was covered by
  // none of it. Selecting a phrase in a note with a mouse raised nothing.
  ["mouseup", "keyup", "select"].forEach((type) => {
    textarea.addEventListener(type, scheduleNotesSelectionCheck);
  });
  // ...and a scroll inside it moves the words the bar is pointing at. The
  // rendered half needs no equivalent: a Range's rects move with the text.
  textarea.addEventListener("scroll", hideNotesSelectionButton, { passive: true });

  installMarkdownKeys(textarea, {
    scope: root,
    undo: () => restore(undoRing, redoRing),
    redo: () => restore(redoRing, undoRing),
    beforeFormat: pushUndoSnapshot
  });

  // ── Registration ─────────────────────────────────────────────────────────
  //
  // What makes the floating pill appear over this editor and act on it. See the
  // header. `isEditing` and `isActive` are asked live rather than captured,
  // because the answer changes every time the reader presses Write or Preview.
  const target = {
    name: NOTE_EDITOR_TARGET,
    view: rendered,
    edit: textarea,
    isActive: () => Boolean(root.isConnected)
  };
  const config = {
    view: rendered,
    edit: textarea,
    label: "note",
    isEditing: () => currentMode() === "write",
    getSource: () => textarea.value,
    setSource: setValue,
    // The preview is what a rendered-mode edit was made against, so it is what
    // has to be repainted. In write mode there is nothing rendered to repaint —
    // applyFormatToTextarea has already written into the textarea and fired its
    // own input event.
    rerender: () => (currentMode() === "write" ? Promise.resolve() : renderPreview())
  };

  const attach = () => {
    registerRenderTarget(NOTE_EDITOR_TARGET, config);
    setNoteEditorSelectionTarget(target);
  };
  const detach = () => {
    clearRenderTarget(NOTE_EDITOR_TARGET);
    setNoteEditorSelectionTarget(null);
  };

  return {
    root,
    modes,
    toolbarWrap,
    toolbar,
    textarea,
    textareaWrapper,
    rendered,
    writeBtn,
    previewBtn,
    surface,
    setMode,
    currentMode,
    // "Show me the other mode", for whichever root the caller binds Ctrl+E to.
    // Bound by the caller and not here: the popup's Ctrl+E has to work with the
    // focus anywhere in its window, including on the header and the footer,
    // which are not inside this kit.
    toggleMode: () => setMode(currentMode() === "write" ? "preview" : "write"),
    renderPreview,
    setValue,
    pushUndoSnapshot,
    clearHistory: () => { undoRing.length = 0; redoRing.length = 0; },
    attach,
    detach
  };
}
