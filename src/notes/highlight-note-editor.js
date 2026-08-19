// The popup editor for a note attached to a highlight (Kindle-style
// "note over a highlight" — see format/highlight-notes.js for the storage
// side). One singleton element, lazily built and repositioned/repopulated
// per open, the same idiom mark-menu.js uses for its own floating popup.
//
// Responsive without two code paths: the DOM is identical on phone and
// desktop, and styles/27-highlight-note-editor.css alone decides whether it
// renders as a floating popover (positioned near the mark/row that opened it)
// or a full-width bottom sheet (a fixed CSS media-query rule that overrides
// the inline top/left the desktop branch sets).

import { createToolbarHtml } from "../editor/toolbars.js?v=__BUILD__";
import { enableSyntaxHighlighting, refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { clearHighlightNoteAt, setHighlightNoteAt } from "../format/highlight-notes.js?v=__BUILD__";
import { enhanceSurfaceDiagramControls, enhanceSurfaceImageControls } from "../images/surface-controls.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { styleMobileMedia } from "../ui/style-tokens.js?v=__BUILD__";

let els = null;
let openMarkIndex = -1;

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
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "highlight-note-editor-cancel";
  cancelBtn.textContent = "Cancel";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "highlight-note-editor-save";
  saveBtn.textContent = "Save";
  footer.append(deleteBtn, spacer, cancelBtn, saveBtn);

  root.append(header, modeRow, toolbarWrap, textarea, rendered, footer);
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

  const setMode = (mode) => {
    const write = mode === "write";
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
  cancelBtn.addEventListener("click", () => closeHighlightNoteEditor());
  saveBtn.addEventListener("click", () => {
    if (openMarkIndex < 0) return closeHighlightNoteEditor();
    setHighlightNoteAt(openMarkIndex, textarea.value);
    closeHighlightNoteEditor();
  });
  deleteBtn.addEventListener("click", () => {
    if (openMarkIndex < 0) return closeHighlightNoteEditor();
    clearHighlightNoteAt(openMarkIndex);
    closeHighlightNoteEditor();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !root.hidden) closeHighlightNoteEditor();
  });

  els = { root, textarea, rendered, writeBtn, previewBtn, deleteBtn, setMode };
  return els;
}

export function isHighlightNoteEditorOpen() {
  return Boolean(els?.root && !els.root.hidden);
}

export function closeHighlightNoteEditor() {
  if (!els?.root || els.root.hidden) return;
  els.root.hidden = true;
  openMarkIndex = -1;
}

// `anchorRect` is whatever the trigger button/mark reports from
// getBoundingClientRect() — used only on desktop-width screens; the mobile
// bottom-sheet layout ignores it entirely (see the CSS media query).
export function openHighlightNoteEditor(markIndex, anchorRect, existingNoteMarkdown) {
  const { root, textarea, deleteBtn, setMode } = ensureHighlightNoteEditor();
  openMarkIndex = markIndex;
  textarea.value = existingNoteMarkdown || "";
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
