// The formatting keys, for a markdown textarea that is not one of the three.
//
// ── The report ──────────────────────────────────────────────────────────────
//
// "Ctrl+E and all other text formatting features in raw/rendered mode are not
// applicable to the highlighted note popup."
//
// Both halves were true, and the first was worse than not working. The global
// handler in src/main.js catches Ctrl+E wherever it lands — deliberately, so it
// still fires from inside the notes and card textareas — and toggles the NOTES
// view between raw and rendered. Pressed inside the note popup, which is its own
// editor floating over that view, it flipped the surface BEHIND the popup while
// the reader was typing into the popup. The one key that means "show me the
// other mode of what I am editing" did it to something else.
//
// ── Why the fix is stopPropagation and not a special case up there ──────────
//
// A guard in the global handler would have to name every editor that is not the
// notes view, and the next one added would be forgotten — which is how this one
// arrived. An editor that owns a key says so on its own element instead: the
// event reaches this listener on the way up and never gets to `document`.
//
// ── ...and why the other keys come with it ──────────────────────────────────
//
// The popup ships the full formatting toolbar, so bold, italic, code and the
// rest are all a press away — and were only ever a press away. Nothing in this
// app bound Ctrl+B to anything, anywhere, so "the formatting features do not
// apply here" was also about there being no keyboard route to them on ANY
// surface. toolbarFormatFn (src/editor/toolbar-actions.js) is what a toolbar
// button means, lifted out of the click handler so a key can ask for the same
// thing; this is the keyboard half of the same table.
//
// Every binding here preventDefaults AND stopPropagations. The second is the
// actual fix: without it Ctrl+E still reaches the document listener after doing
// the right thing here, and the view behind the popup flips anyway.

import { applyFormatToTextarea } from "../format/selection-tools.js?v=__BUILD__";
import { toolbarFormatFn } from "./toolbar-actions.js?v=__BUILD__";

// key → the dataset a toolbar button would have carried. The three the browser
// itself claims on a contenteditable (b, i, u) plus the two this editor's own
// toolbar offers next to them. Deliberately not the whole strip: a shortcut
// nobody can guess is a shortcut nobody uses, and these five are the ones a
// reader arrives already knowing.
export const MARKDOWN_FORMAT_KEYS = {
  b: { action: "bold" },
  i: { action: "italic" },
  u: { action: "underline" },
  k: { action: "code" },
  e: null // handled separately — it is a mode, not a format
};

// The hooks, and what each is for:
//
//   toggleMode    Ctrl+E — the same "show me the other mode" the notes view
//                 spends it on, whatever that means on this surface.
//   done          Ctrl+Enter — save and close, the shape every other modal in
//                 this app already uses.
//   scope         set when the caller has already bound those two to the whole
//                 editor (see installModeKeys), so they are not bound twice.
//   undo / redo   Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y. Not optional garnish: see the
//                 branch below for why native undo is already gone by the time
//                 anyone reaches for it here.
//   beforeFormat  called immediately before a transform lands, so the surface
//                 can snapshot what it is about to replace.
//
// Anything not supplied is simply not bound, and the key falls through to
// whatever would have had it.
// The two keys that are about the SURFACE rather than about the text, bound to
// whatever element holds the whole editor.
//
// They cannot live on the textarea alone, and that is not a detail: Ctrl+E
// switches to a preview, at which point the textarea is hidden and the focus is
// somewhere else in the popup — so the key that got you there could not get you
// back. A mode key has to be reachable from every part of the thing whose mode
// it changes.
export function installModeKeys(scope, hooks = {}) {
  if (!scope || scope.dataset.modeKeys === "true") return;
  scope.dataset.modeKeys = "true";
  scope.addEventListener("keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = String(event.key || "").toLowerCase();
    if (key === "e" && hooks.toggleMode) {
      event.preventDefault();
      event.stopPropagation();
      hooks.toggleMode();
      return;
    }
    if (key === "enter" && hooks.done) {
      event.preventDefault();
      event.stopPropagation();
      hooks.done();
    }
  });
}

export function installMarkdownKeys(textarea, hooks = {}) {
  if (!textarea || textarea.dataset.markdownKeys === "true") return;
  textarea.dataset.markdownKeys = "true";
  // A textarea with no editor around it is its own scope, which is the case in
  // the Highlights tab: the textarea IS the mode, and putting it away is what
  // showing the rendered note means.
  if (!hooks.scope) installModeKeys(textarea, hooks);
  textarea.addEventListener("keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = String(event.key || "").toLowerCase();
    // Handled by the scope listener above, or by the one the caller installed
    // on the editor around this textarea.
    if (key === "e" || key === "enter") return;
    if (key === "z" || key === "y") {
      // A programmatic `textarea.value = …` DISCARDS the element's native undo
      // transaction, and every one of the transforms above is one — so from the
      // first time a reader uses any formatting control on this surface, the
      // browser's own Ctrl+Z can no longer step back past it. A surface that
      // offers those controls has to bring its own undo.
      const wantsRedo = key === "y" || (key === "z" && event.shiftKey);
      const hook = wantsRedo ? hooks.redo : hooks.undo;
      if (!hook) return;
      event.preventDefault();
      event.stopPropagation();
      hook();
      return;
    }
    const spec = MARKDOWN_FORMAT_KEYS[key];
    if (!spec) return;
    const formatFn = toolbarFormatFn(spec);
    if (!formatFn) return;
    event.preventDefault();
    event.stopPropagation();
    hooks.beforeFormat?.();
    // applyFormatToTextarea dispatches a bubbling `input` event, so whatever
    // this surface hangs off typing — an autosave debounce, a syntax-highlight
    // backdrop, a textarea that grows to its content — happens for free and in
    // the same order it does for a keystroke.
    applyFormatToTextarea(textarea, formatFn);
  });
}
