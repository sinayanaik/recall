// The formatting toolbar that acts on a RENDERED selection — bold, colour,
// highlight, cloze — by editing the markdown underneath it.

import { scheduleLiveQuestionFit } from "../cards/question-fit.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { applyInlineStyleProperty, clearInlineStyleProperty, toggleCode, toggleStrikethrough, toggleUnderline, toggleWrap } from "../editor/text-transforms.js?v=__BUILD__";
import { resetClozeButton } from "../editor/toolbars.js?v=__BUILD__";
import { makeClozeFromSelection } from "./cloze.js?v=__BUILD__";
import { MARK_HIGHLIGHT_COLORS, MARK_HIGHLIGHT_DEFAULT, MARK_HIGHLIGHT_HEX } from "./highlight-colors.js?v=__BUILD__";
import { makeHighlightFromSelection, selectionForRenderTarget } from "./highlight.js?v=__BUILD__";
import { locateSelectionInSource, renderedSelectionStrings } from "./locate-selection.js?v=__BUILD__";
import { clozeTextareaSelection } from "./selection-tools.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { captureNotesAnchor, captureSourceAnchor, createCardFromNotesSelection } from "../notes/anchors.js?v=__BUILD__";
import { isNotesEditing, renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { hideNotesSelectionButton } from "../notes/selection.js?v=__BUILD__";
import { saveQuickNote } from "../quick-notes/board.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";

// Persist a question/answer edit to both the active deck and the master list
// (mirrors the save path in toggleEditMode / commitEditIfActive).
export function setCurrentCardField(side, value) {
  const card = state.cards[state.current];
  if (!card) return;
  if (side === "question") card.question = value;
  else card.answer = value;
  const masterIndex = state.masterCards.findIndex((c) => c.id === card.id);
  if (masterIndex > -1) {
    if (side === "question") state.masterCards[masterIndex].question = value;
    else state.masterCards[masterIndex].answer = value;
  }
}

// One place that knows, for each rendered surface (card question/answer, notes),
// its view element, how to read/write its markdown source, how to re-render, and
// whether it's currently in raw-edit mode. Shared by the header cloze buttons
// and the rendered-view formatting toolbar so both stay in lock-step.
export function renderTargetConfig(target) {
  if (target === "notes") {
    return {
      view: el.notesView,
      label: "notes",
      isEditing: () => isNotesEditing(),
      getSource: () => state.notes,
      setSource: (v) => {
        state.notes = v;
        if (el.notesEdit) el.notesEdit.value = v;
      },
      // Everything routed through here (highlight, erase, cloze, the rendered
      // formatting toolbar) edits the note the reader is looking at, so it
      // repaints in place and leaves them exactly where they were.
      rerender: () => renderNotesViewPinned(),
    };
  }
  const side = target === "answer" ? "answer" : "question";
  const view = side === "question" ? el.questionView : el.answerView;
  return {
    view,
    label: side,
    // The rendered view is hidden (edit mode) or there's simply no card.
    isEditing: () => !state.cards[state.current] || !view || view.hidden,
    getSource: () => state.cards[state.current]?.[side] || "",
    setSource: (v) => setCurrentCardField(side, v),
    rerender: () =>
      renderMarkdown(view, state.cards[state.current]?.[side] || "", true).then(() => {
        if (side === "question") scheduleLiveQuestionFit();
        resetClozeButton(el.clozeToggleBtn);
      }),
  };
}

// Text-colour palette mirrors the editor toolbar's.
export const RENDER_TEXT_COLORS = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Yellow", value: "#f59e0b" },
  { name: "Green", value: "#10b981" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Purple", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
  { name: "Accent", value: "var(--accent-strong)" },
  { name: "White", value: "#ffffff" },
  { name: "Gray", value: "#9ca3af" },
];

// The currently-chosen default for each split-button's one-click apply. Persisted
// so it survives reloads; seeded from the first palette swatch. A pre-existing
// value under the highlight key predates data-color tokens (it was a hex
// background colour) — falling back to the default token instead of trusting
// it keeps an old install from writing an unrecognised data-color into notes.
export const renderFormatDefaults = {
  color: localStorage.getItem("recall:renderColorDefault") || RENDER_TEXT_COLORS[0].value,
  highlight: MARK_HIGHLIGHT_HEX[localStorage.getItem("recall:renderHighlightDefault")]
    ? localStorage.getItem("recall:renderHighlightDefault")
    : MARK_HIGHLIGHT_DEFAULT,
};

// The split button's face IS the preview: an "A" wearing the colour it will
// apply (an underline bar for text colour, a filled block for highlight), the
// convention every word processor uses. That replaced a 🎨/🖍️ emoji plus a
// separate swatch chip on the ▾ side — two things saying the same thing, in a
// row where width is scarce. `data-render-swatch` stays on whichever element
// carries the colour, so refreshRenderSwatches() keeps working untouched.
// Each swatch's --sw preview uses c.swatch when given (an opaque chip colour
// distinct from the value actually applied — see MARK_HIGHLIGHT_COLORS above)
// and falls back to c.value for palettes where the two are the same thing.
export function renderSplitControlHtml(prop, glyph, label, swatches) {
  const items = swatches
    .map(
      (c) =>
        `<button type="button" class="render-swatch-btn" data-render-color="${c.value}" data-render-prop="${prop}" style="--sw:${c.swatch || c.value};" title="${c.name}"></button>`
    )
    .join("");
  return `
    <span class="render-split" data-render-split="${prop}">
      <button type="button" class="render-btn render-split-main" data-render-action="${prop}-apply" title="Apply ${label} (current default)">${glyph}</button>
      <button type="button" class="render-btn render-split-side" data-render-action="${prop}-menu" title="Choose ${label}" aria-haspopup="true" aria-expanded="false"><span class="render-caret" aria-hidden="true">▾</span></button>
      <div class="render-color-menu" data-render-menu="${prop}" hidden>
        ${items}
        <button type="button" class="render-swatch-clear" data-render-color="clear" data-render-prop="${prop}" title="Remove ${label}">Clear</button>
      </div>
    </span>`;
}

// ── The three cloze icons ──────────────────────────────────────────────
// Drawn, not typed. Every lettered attempt (👀/🎯, then [ … ]/[A]/[?], then
// A̶/A/?) failed the same way: the three actions are DIFFERENT, so glyphs that
// differ by one character read as three copies of one button. Each of these
// depicts what its button does.
//
//   MAKE   a line of text whose middle is replaced by a solid block, + a plus
//   LIST   three such lines stacked — every blank in the deck, as a list
//   TOGGLE an eye; a slash crosses it once the answers are showing
//
// Shared by every surface that offers the action (notes header, card faces,
// the floating selection pill, the raw-edit toolbars) so one mark means one
// thing app-wide.
export const CLOZE_SVG_ATTRS =
  'class="cz-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"';

export const CLOZE_MAKE_ICON = `<svg ${CLOZE_SVG_ATTRS}><path d="M2.5 7h4.5"/><rect x="9.5" y="4" width="12" height="6" rx="1.5" fill="currentColor" stroke="none"/><path d="M6 14.5v7M2.5 18h7"/></svg>`;

export const CLOZE_LIST_ICON = `<svg ${CLOZE_SVG_ATTRS}><path d="M2.5 5.5h4"/><rect x="9" y="3.5" width="12.5" height="4" rx="1.2" fill="currentColor" stroke="none"/><path d="M2.5 12h4"/><rect x="9" y="10" width="9" height="4" rx="1.2" fill="currentColor" stroke="none"/><path d="M2.5 18.5h4"/><rect x="9" y="16.5" width="12.5" height="4" rx="1.2" fill="currentColor" stroke="none"/></svg>`;

export const CLOZE_TOGGLE_ICON = `<svg ${CLOZE_SVG_ATTRS} stroke-linejoin="round"><path d="M1.8 12S5.5 5.5 12 5.5 22.2 12 22.2 12 18.5 18.5 12 18.5 1.8 12 1.8 12Z"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><path class="cz-slash" d="M4 20 20 4"/></svg>`;

export const RENDER_COLOR_GLYPH =
  '<span class="render-glyph">A</span><span class="render-underbar" data-render-swatch="color"></span>';

export const RENDER_HIGHLIGHT_GLYPH =
  '<span class="render-glyph render-glyph-hl" data-render-swatch="highlight">A</span>';

// Formatting, plus (on the card faces) a capture group. The NOTES surface passes
// { actions: false }: its cloze / make-card / pin buttons live up in the notes
// header instead, where they sit beside the other two cloze controls and stay
// put when you switch to raw-edit mode. A card face has no such header row, so
// it keeps them here.
export function createRenderToolbarHtml({ actions = true } = {}) {
  const captureGroup = actions
    ? `
    <span class="render-divider" aria-hidden="true"></span>
    <button type="button" class="render-btn render-make-card" data-render-action="make-card" title="Make a flashcard from the selection">+</button>
    <button type="button" class="render-btn make-cloze-btn" data-render-action="cloze" title="Cloze — hide the selection as a fill-in-the-blank">${CLOZE_MAKE_ICON}</button>
    <button type="button" class="render-btn render-quick-note" data-render-action="quick-note" title="Save selection to the quick_notes deck">📌</button>`
    : "";
  return `
    <button type="button" class="render-btn" data-render-action="bold" title="Bold"><b>B</b></button>
    <button type="button" class="render-btn" data-render-action="italic" title="Italic"><i>I</i></button>
    <button type="button" class="render-btn" data-render-action="underline" title="Underline"><u>U</u></button>
    <button type="button" class="render-btn" data-render-action="strikethrough" title="Strikethrough"><s>S</s></button>
    <button type="button" class="render-btn" data-render-action="code" title="Inline code"><code>&lt;/&gt;</code></button>
    <span class="render-divider" aria-hidden="true"></span>
    ${renderSplitControlHtml("color", RENDER_COLOR_GLYPH, "text colour", RENDER_TEXT_COLORS)}
    ${renderSplitControlHtml("highlight", RENDER_HIGHLIGHT_GLYPH, "highlight", MARK_HIGHLIGHT_COLORS)}${captureGroup}`;
}

// Paint the little swatch on each split-button's side control to the current
// default colour, so you can see what a one-click apply will use.
export function refreshRenderSwatches() {
  document.querySelectorAll('[data-render-swatch="color"]').forEach((s) => {
    s.style.background = renderFormatDefaults.color;
  });
  document.querySelectorAll('[data-render-swatch="highlight"]').forEach((s) => {
    s.style.background = MARK_HIGHLIGHT_HEX[renderFormatDefaults.highlight] || MARK_HIGHLIGHT_HEX[MARK_HIGHLIGHT_DEFAULT];
  });
}

export function initRenderToolbars() {
  [el.questionRenderToolbar, el.answerRenderToolbar].forEach((tb) => {
    if (tb) tb.innerHTML = createRenderToolbarHtml();
  });
  // Notes: formatting only — the capture/cloze actions are in the notes header.
  if (el.notesRenderToolbar) el.notesRenderToolbar.innerHTML = createRenderToolbarHtml({ actions: false });
  refreshRenderSwatches();
}

export function closeAllRenderMenus() {
  document.querySelectorAll(".render-color-menu").forEach((m) => (m.hidden = true));
  document.querySelectorAll(".render-split-side").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

// When the located text is exactly the inner content of a <span style="…">…
// </span>, return the range of the WHOLE span. Colour/highlight/clear then see
// the entire span (via matchWholeStyleSpan) so they merge a new property in or
// strip one, instead of nesting yet another span around the inner text.
export function enclosingStyleSpan(source, idx, end) {
  const open = /<span style="[^"]*">$/.exec(source.slice(0, idx));
  if (!open) return null;
  if (!source.slice(end).startsWith("</span>")) return null;
  return { start: idx - open[0].length, end: end + "</span>".length };
}

// Core engine: apply a raw-editor transform fn to the selected occurrence in the
// source, then persist + re-render. `formatFn(value, start, end)` returns either
// a replacement string for [start,end) or a { text, rangeStart, rangeEnd } range
// object — exactly the shape the editor toolbar's fns already return. Pass
// { expandStyleSpan: true } (colour/highlight) so an existing style span around
// the selection is merged into rather than nested.
export function applyRenderFormat(config, formatFn, opts = {}) {
  if (config.isEditing()) {
    setStatus(`Switch the ${config.label} to preview to format a selection there.`, "error");
    return;
  }
  const sel = selectionForRenderTarget(config.view);
  if (!sel) {
    setStatus(`Select some text in the ${config.label} first, then tap a formatting button.`, "error");
    return;
  }
  const source = config.getSource();
  const loc = locateSelectionInSource(source, sel);
  if (!loc) {
    setStatus("Couldn't match that selection in the source — try selecting whole words, or use the editor.", "error");
    return;
  }
  let { idx, end } = loc;
  if (opts.expandStyleSpan) {
    const span = enclosingStyleSpan(source, idx, end);
    if (span) {
      idx = span.start;
      end = span.end;
    }
  }
  const result = formatFn(source, idx, end);
  const isRange = result && typeof result === "object";
  const replacement = isRange ? result.text : result;
  const rangeStart = isRange ? result.rangeStart : idx;
  const rangeEnd = isRange ? result.rangeEnd : end;
  config.setSource(source.substring(0, rangeStart) + replacement + source.substring(rangeEnd));
  window.getSelection()?.removeAllRanges();
  config.rerender();
  scheduleDeckAutosave();
}

export const RENDER_INLINE_FORMATS = {
  bold: (v, s, e) => toggleWrap(v, s, e, "**"),
  italic: (v, s, e) => toggleWrap(v, s, e, "*"),
  underline: (v, s, e) => toggleUnderline(v, s, e),
  strikethrough: (v, s, e) => toggleStrikethrough(v, s, e),
  code: (v, s, e) => toggleCode(v, s, e),
};

export function applyRenderColor(config, prop, value) {
  const property = prop === "highlight" ? "background-color" : "color";
  const formatFn =
    value === "clear"
      ? (v, s, e) => clearInlineStyleProperty(v.slice(s, e), property)
      : (v, s, e) => applyInlineStyleProperty(v.slice(s, e), property, value);
  applyRenderFormat(config, formatFn, { expandStyleSpan: true });
}

export function setRenderDefault(prop, value) {
  if (value === "clear") return; // "clear" is an action, never a default
  renderFormatDefaults[prop] = value;
  try { localStorage.setItem(prop === "highlight" ? "recall:renderHighlightDefault" : "recall:renderColorDefault", value); } catch (_) {}
  refreshRenderSwatches();
}

export function handleRenderToolbarAction(btn, toolbar) {
  const target = toolbar.dataset.renderTarget;
  const config = renderTargetConfig(target);
  const action = btn.dataset.renderAction;
  const colorVal = btn.dataset.renderColor;

  // Open/close a split-button's colour menu.
  if (action === "color-menu" || action === "highlight-menu") {
    const prop = action.slice(0, action.indexOf("-"));
    const menu = toolbar.querySelector(`.render-color-menu[data-render-menu="${prop}"]`);
    const willOpen = menu && menu.hidden;
    closeAllRenderMenus();
    if (menu && willOpen) {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
    return;
  }

  // A swatch (or Clear) inside a menu: set it as the new default, then apply.
  // Resolve the selection BEFORE closeAllRenderMenus()/setRenderDefault() run
  // and pass it through explicitly — the same eager resolve-then-pass shape
  // applyPillHighlight() uses (see selectionForRenderTarget's doc comment).
  // Left to its own default parameter, makeHighlightFromSelection would
  // re-resolve the selection itself, one tick later and via the same
  // live-selection-or-borrowed-pill-capture fallback that made this toolbar's
  // highlight buttons unreliable compared to the pill.
  if (colorVal !== undefined) {
    const prop = btn.dataset.renderProp;
    const sel = prop === "highlight" ? selectionForRenderTarget(config.view) : null;
    closeAllRenderMenus();
    setRenderDefault(prop, colorVal);
    if (prop === "highlight") makeHighlightFromSelection(config, colorVal, sel);
    else applyRenderColor(config, prop, colorVal);
    return;
  }

  // One-click apply of the current default colour/highlight.
  if (action === "color-apply") return applyRenderColor(config, "color", renderFormatDefaults.color);
  if (action === "highlight-apply") {
    return makeHighlightFromSelection(config, renderFormatDefaults.highlight, selectionForRenderTarget(config.view));
  }

  // The three selection actions below live in the notes HEADER, which stays put
  // when you tap ✎ — so unlike the formatting controls (whose whole toolbar is
  // swapped out while raw-editing) they have to handle the textarea case too, or
  // they'd sit there looking available and do nothing. Same dual path the
  // floating selection pill uses: rendered view first, raw editor as fallback.
  const editing = config.isEditing?.() ? activeEditingTarget() : null;

  // Cloze reuses its dedicated driver (toggle + "already"/"removed" toasts).
  // Same eager-resolve reasoning as the highlight branches above.
  if (action === "cloze") {
    if (editing) return clozeTextareaSelection(editing);
    return makeClozeFromSelection(config, selectionForRenderTarget(config.view));
  }

  // Turn the selection into a flashcard. captureNotesAnchor (not the deck-tagged
  // captureSourceAnchor the pin below uses) because this card lands in the deck
  // we're already in — there's no other deck to navigate back from.
  if (action === "make-card") {
    if (editing) {
      const raw = editing.edit.value.slice(editing.edit.selectionStart, editing.edit.selectionEnd);
      if (!raw.trim()) {
        setStatus(`Select some text in the ${config.label} first, then tap + to turn it into a card.`, "error");
        return;
      }
      createCardFromNotesSelection(raw, captureNotesAnchor());
      return;
    }
    const sel = renderedSelectionStrings(config.view);
    if (!sel) {
      setStatus(`Select some text in the ${config.label} first, then tap + to turn it into a card.`, "error");
      return;
    }
    const anchor = captureNotesAnchor();
    hideNotesSelectionButton();
    window.getSelection()?.removeAllRanges();
    createCardFromNotesSelection(sel.asMarkdown || sel.asText, anchor);
    return;
  }

  // Save the selection as a new card (question) in the quick_notes deck —
  // same destination and behaviour as the raw-editor toolbar's 📌 button.
  if (action === "quick-note") {
    if (editing) {
      const raw = editing.edit.value.slice(editing.edit.selectionStart, editing.edit.selectionEnd);
      if (!raw.trim()) {
        setStatus(`Select some text in the ${config.label} first, then tap 📌 to save it to quick_notes.`, "error");
        return;
      }
      saveQuickNote(raw, btn, captureSourceAnchor());
      return;
    }
    const sel = renderedSelectionStrings(config.view);
    if (!sel) {
      setStatus(`Select some text in the ${config.label} first, then tap 📌 to save it to quick_notes.`, "error");
      return;
    }
    // Capture the source location while the selection is still live so the
    // quick_notes card can offer a "Go to notes" jump back here.
    saveQuickNote(sel.asMarkdown || sel.asText, btn, captureSourceAnchor());
    return;
  }

  // Plain inline toggles.
  const fn = RENDER_INLINE_FORMATS[action];
  if (fn) applyRenderFormat(config, fn);
}
