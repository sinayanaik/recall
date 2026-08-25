// The formatting toolbar that acts on a RENDERED selection — bold, colour,
// highlight, cloze — by editing the markdown underneath it.

import { scheduleLiveQuestionFit } from "../cards/question-fit.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { rawEditorValueFor } from "../notes/notes-edit-split.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { applyInlineStyleProperty, clearInlineStyleProperty, smartBulletify, toggleBlockquote, toggleCode, toggleStrikethrough, toggleUnderline, toggleWrap } from "../editor/text-transforms.js?v=__BUILD__";
import { resetClozeButton } from "../editor/toolbars.js?v=__BUILD__";
import { makeClozeFromSelection } from "./cloze.js?v=__BUILD__";
import { MARK_HIGHLIGHT_COLORS, MARK_HIGHLIGHT_DEFAULT, MARK_HIGHLIGHT_HEX } from "./highlight-colors.js?v=__BUILD__";
import { makeHighlightFromSelection, selectionForRenderTarget } from "./highlight.js?v=__BUILD__";
import { locateSelectionInSource, renderedSelectionStrings } from "./locate-selection.js?v=__BUILD__";
import { applyFormatToTextarea, clozeTextareaSelection } from "./selection-tools.js?v=__BUILD__";
import { captureNotesAnchor, captureSourceAnchor, createCardFromNotesSelection } from "../notes/anchors.js?v=__BUILD__";
import { isNotesEditing, renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { activeEditingTarget, hideNotesSelectionButton } from "../notes/selection.js?v=__BUILD__";
import { saveQuickNote } from "../quick-notes/board.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { pushNotesUndo, syncNotesHistoryBaseline } from "../notes/notes-history.js?v=__BUILD__";
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

// ── Surfaces that are not always there ────────────────────────────────────
//
// The three below are fixed furniture: the notes view and the two card faces
// exist for the whole session and are addressed by name. A note written on a
// highlight is not — it is a textarea and a preview that exist while one note
// is open, in the popup (src/notes/highlight-note-editor.js) or inline in the
// Highlights tab (src/panels/highlights-editor.js) — and it is nonetheless a
// markdown surface with a source that can be spliced, which is the entire
// contract this function describes.
//
// Without this those surfaces had the toolbar and nothing else: selecting a
// phrase in a note about a highlight raised no floating pill, so none of bold,
// colour, highlight, erase, copy, share or web-search reached the one place in
// the app where a reader writes about what they have just read.
//
// A registry rather than a fourth branch, because the surface has to bring its
// own view, textarea and source verbs — those change per open — and because
// nothing here should have to know which of the two editors is showing.
const namedRenderTargets = new Map();

export function registerRenderTarget(name, config) {
  if (!name || !config) return;
  namedRenderTargets.set(name, config);
}

export function clearRenderTarget(name) {
  namedRenderTargets.delete(name);
}

// One place that knows, for each rendered surface (card question/answer, notes),
// its view element, how to read/write its markdown source, how to re-render, and
// whether it's currently in raw-edit mode. Shared by the header cloze buttons
// and the rendered-view formatting toolbar so both stay in lock-step.
export function renderTargetConfig(target) {
  const registered = namedRenderTargets.get(target);
  if (registered) return registered;
  if (target === "notes") {
    return {
      view: el.notesView,
      // The raw editor behind this surface. applyRenderFormat needs it because
      // the formatting controls now serve BOTH modes from the floating pill —
      // in raw mode there is no rendered text to match a selection against, so
      // it works off the textarea's own offsets instead.
      edit: el.notesEdit,
      label: "notes",
      isEditing: () => isNotesEditing(),
      getSource: () => state.notes,
      setSource: (v) => {
        // The single choke point for every rendered-view edit to the notes —
        // highlight, colour, font, bold, cloze, erase all arrive here through
        // applyRenderFormat. Snapshotting here rather than at each caller is
        // what keeps one definition of "an undoable notes edit".
        pushNotesUndo("edit");
        state.notes = v;
        // Only when the raw editor is actually OPEN. This used to write the
        // whole note into it unconditionally, and by definition every edit that
        // arrives here was made in the RENDERED view — so the textarea was
        // hidden, and handing a hidden <textarea> a fresh multi-megabyte value
        // is 21ms of the main thread, per highlight, measured on a 2.4MB note.
        // Nothing could read it either: enterNotesEditing assigns
        // el.notesEdit.value = state.notes every time the editor opens, so a
        // stale hidden value can never be seen, and every other reader of .value
        // (notesEditSelectionText, applyFormatToTextarea, activeEditingTarget,
        // commitNotesEditIfActive) tests `hidden` or isNotesEditing() first.
        if (el.notesEdit && !el.notesEdit.hidden) el.notesEdit.value = rawEditorValueFor(v);
        syncNotesHistoryBaseline(v);
      },
      // Everything routed through here (highlight, erase, cloze, the rendered
      // formatting toolbar) edits the note the reader is looking at, so it
      // repaints in place and leaves them exactly where they were. An
      // optional raw-offset hint (only makeHighlightFromSelection passes one
      // today) lets the pin anchor on the block that was actually just
      // edited instead of guessing one from where the reading line happens
      // to sit — see renderNotesViewPinned.
      rerender: (offsetHint) => renderNotesViewPinned(offsetHint),
    };
  }
  const side = target === "answer" ? "answer" : "question";
  const view = side === "question" ? el.questionView : el.answerView;
  return {
    view,
    edit: side === "question" ? el.questionEdit : el.answerEdit,
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

// (renderFontControlHtml and RENDER_FONTS used to sit here: a picker offering
// sixteen typefaces for a text SELECTION, which wrote an inline `font-family`
// into the markdown. Removed — a per-selection typeface is not something a
// reading app needs, and the font choices that matter are settings rather than
// formatting actions: Style -> Basics picks the app font, and Style -> Notes
// font picks one for the reading view alone. Notes that already carry an inline
// font still render, and the raw editor's Clear formatting strips one.)

// ── Everything you rarely reach for, behind one control ────────────────────
//
// Bold, italic, underline, strikethrough, inline code, the sixteen font faces
// and the twelve text colours were nine controls across the bar, in front of
// the ones that get used — highlight, bulletify, cloze, make-card. They are
// worth having and are not worth the width, so they fold into a single "Aa"
// popover and the bar keeps its top row for actions.
//
// One menu, not a menu per property: three separate popovers hanging off one
// bar is three things to open and close, and the reason to open any of them is
// the same ("style these words"). It reuses .render-color-menu and the
// `font-menu` action so closeAllRenderMenus and the ${prop}-menu branch in
// handleRenderToolbarAction find it with no second mechanism.
export function renderTextStyleControlHtml() {
  const colours = RENDER_TEXT_COLORS.map(
    (c) =>
      `<button type="button" class="render-swatch-btn" data-render-color="${c.value}" data-render-prop="color" style="--sw: ${c.swatch || c.value};" title="${c.name}"></button>`
  ).join("");
  return `
    <span class="render-split" data-render-split="font">
      <button type="button" class="render-btn render-font-toggle" data-render-action="font-menu" title="Text style — bold, italic, colour" aria-haspopup="true" aria-expanded="false">Aa</button>
      <div class="render-color-menu render-text-style-menu" data-render-menu="font" hidden>
        <div class="render-style-row">
          <button type="button" class="render-btn" data-render-action="bold" title="Bold"><b>B</b></button>
          <button type="button" class="render-btn" data-render-action="italic" title="Italic"><i>I</i></button>
          <button type="button" class="render-btn" data-render-action="underline" title="Underline"><u>U</u></button>
          <button type="button" class="render-btn" data-render-action="strikethrough" title="Strikethrough"><s>S</s></button>
          <button type="button" class="render-btn" data-render-action="code" title="Inline code"><code>&lt;/&gt;</code></button>
        </div>
        <div class="render-style-swatches">
          ${colours}
          <button type="button" class="render-swatch-clear" data-render-color="clear" data-render-prop="color" title="Remove colour">Clear</button>
        </div>
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

// A quotation mark with a rule down its left, which is what a rendered
// blockquote actually looks like — so the button is a picture of its result,
// the same argument the cloze icons above are drawn for. currentColor
// throughout, so it takes the row's ink like every other control on the pill.
export const BLOCKQUOTE_ICON =
  '<svg class="cz-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.6 4.5v15"/><path d="M8.8 8.2c-1.7 0-3 1.3-3 2.9s1.3 2.9 3 2.9c.4 0 .8-.1 1.1-.2-.2 1.4-1.2 2.4-2.4 2.7"/><path d="M17 8.2c-1.7 0-3 1.3-3 2.9s1.3 2.9 3 2.9c.4 0 .8-.1 1.1-.2-.2 1.4-1.2 2.4-2.4 2.7"/></svg>';

export const RENDER_COLOR_GLYPH =
  '<span class="render-glyph">A</span><span class="render-underbar" data-render-swatch="color"></span>';

export const RENDER_HIGHLIGHT_GLYPH =
  '<span class="render-glyph render-glyph-hl" data-render-swatch="highlight">A</span>';

// Formatting, plus (on the card faces) a capture group. The NOTES surface passes
// { actions: false }: its cloze / make-card / pin buttons live up in the notes
// header instead, where they sit beside the other two cloze controls and stay
// put when you switch to raw-edit mode. A card face has no such header row, so
// it keeps them here.
// `highlight: false` is for the floating selection pill, which carries its own
// highlight swatch + colour menu already (index.html, #highlightSelectionBtn).
// Emitting the split control there too would put two identical highlight
// controls side by side, driving the same renderFormatDefaults.highlight.
export function createRenderToolbarHtml({ actions = true, highlight = true } = {}) {
  const captureGroup = actions
    ? `
    <span class="render-divider" aria-hidden="true"></span>
    <button type="button" class="render-btn render-make-card" data-render-action="make-card" title="Make a flashcard from the selection">+</button>
    <button type="button" class="render-btn make-cloze-btn" data-render-action="cloze" title="Cloze — hide the selection as a fill-in-the-blank">${CLOZE_MAKE_ICON}</button>
    <button type="button" class="render-btn render-quick-note" data-render-action="quick-note" title="Save selection to the quick_notes deck">📌</button>`
    : "";
  // ── ≡ and ❝, side by side ─────────────────────────────────────────────
  //
  // The two things a reader does to the STRUCTURE of a passage rather than to
  // its words: break it into points, or set it off as somebody else's. They
  // belong together, and the quote mark is drawn rather than typed for the
  // reason this file already records for the cloze icons — a ">" beside a "≡"
  // reads as a chevron, not as a quotation, and the one glyph that does read as
  // one (") is punctuation the eye skips.
  return `
    <button type="button" class="render-btn render-bulletify" data-render-action="bulletify" title="Make bullet points from the selection">&#8801;</button>
    <button type="button" class="render-btn render-blockquote" data-render-action="blockquote" title="Quote the selection — set it off as a block quotation">${BLOCKQUOTE_ICON}</button>
    ${renderTextStyleControlHtml()}
    ${highlight ? renderSplitControlHtml("highlight", RENDER_HIGHLIGHT_GLYPH, "highlight", MARK_HIGHLIGHT_COLORS) : ""}${captureGroup}`;
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
  // NO surface has a persistent strip any more — not the notes, and as of now
  // not the card faces either. Formatting rides the floating selection pill,
  // which is the only place it can actually be used: every one of these buttons
  // refuses without a selection (see applyRenderFormat), so a permanent row of
  // them was a row that did nothing while you read, and on a phone a row that
  // did nothing while covering the text.
  //
  // The pill serves all three faces — it stamps data-render-target per
  // selection (positionNotesSelectionButton) — and works in raw-edit mode too,
  // so nothing was left behind on the faces that lost their strip.
  //
  // No highlight split here — the pill already carries one.
  const pillFormat = document.getElementById("selectionFloatFormat");
  if (pillFormat) pillFormat.innerHTML = createRenderToolbarHtml({ actions: false, highlight: false });
  refreshRenderSwatches();
}

// ── Closing the menus without walking the document ─────────────────────────
//
// This is called from a document-level pointerdown handler (see main.js), so it
// runs on EVERY press anywhere in the app — and it used to run two
// `document.querySelectorAll` sweeps to do it, one of them a selector list with
// an attribute-suffix match, which no engine can answer from an index. That is
// a full CSS match against every element in the document, and with a book open
// the document is a couple of hundred thousand elements. Paid twice per tap,
// on the thread the reader is waiting for.
//
// Nothing is ever open in the common case, so the flag answers it outright, and
// when something IS open the search is scoped to the toolbars that can hold a
// menu — of which there is one (the floating selection pill).
export let anyRenderMenuOpen = false;

export function setAnyRenderMenuOpen(value) {
  anyRenderMenuOpen = Boolean(value);
}

// The containers a render toolbar is ever painted into — today just the
// floating selection pill's formatting slot (see initRenderToolbars: no surface
// carries a persistent strip any more). Named rather than queried for, for the
// same reason as the flag above: this is the press path.
export function renderToolbarHosts() {
  return [el.selectionFloatFormat].filter(Boolean);
}

export function closeAllRenderMenus() {
  if (!anyRenderMenuOpen) return;
  anyRenderMenuOpen = false;
  renderToolbarHosts().forEach((host) => {
    host.querySelectorAll(".render-color-menu").forEach((m) => (m.hidden = true));
    // Every control that OPENS a menu, not just the split ones: the font
    // picker's toggle is a plain button, so keying off .render-split-side alone
    // would leave its aria-expanded stuck on "true".
    host
      .querySelectorAll('.render-split-side, [data-render-action$="-menu"]')
      .forEach((b) => b.setAttribute("aria-expanded", "false"));
  });
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
  // Raw-edit mode: the textarea hands over exact offsets, so there is no source
  // search to do — the same formatFn is applied directly (see
  // applyFormatToTextarea, which is the other half of this contract).
  //
  // This used to refuse outright: "Switch the notes to preview to format a
  // selection there." That was tolerable only while each editor carried its own
  // toolbar. The floating pill is now the only formatting surface in either
  // mode, so the refusal would have meant no bold, italic, colour or font in
  // raw mode at all.
  if (config.isEditing()) {
    const textarea = config.edit;
    if (!textarea || textarea.hidden || textarea.selectionStart === textarea.selectionEnd) {
      setStatus(`Select some text in the ${config.label} first, then tap a formatting button.`, "error");
      return;
    }
    applyFormatToTextarea(textarea, formatFn);
    return;
  }
  const sel = selectionForRenderTarget(config.view);
  if (!sel) {
    setStatus(`Select some text in the ${config.label} first, then tap a formatting button.`, "error");
    return;
  }
  const source = config.getSource();
  // Block-level actions (bulletify) need the whitespace/marker-tolerant search:
  // a selection spanning several list items or wrapped lines never matches the
  // source verbatim, because Turndown pads its markers differently. The inline
  // formats deliberately do NOT opt in — they wrap the match in a simple pair,
  // and a fuzzy match across a block boundary would corrupt the markup the same
  // way a bare <mark> across one used to.
  const loc = locateSelectionInSource(source, sel, opts.fuzzy ? { fuzzy: true } : undefined);
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

// Bulletify a selection, and detach whatever of its paragraph was NOT selected.
//
// A list is a block, so text left on the same line either side of it is not
// merely untidy — markdown reads it as part of the list. Bulletifying the middle
// of a paragraph used to leave the run-up glued to the first bullet and, worse,
// the remainder lazily continuing the LAST one, so a sentence the reader never
// touched became part of a bullet. A blank line on each side (only where there
// is actually something to separate) makes the list a block of its own and puts
// the rest back to being a paragraph.
export function bulletifyFormat(value, start, end) {
  return blockFormat(value, start, end, smartBulletify);
}

// Set the selection off as a quotation — the same shape as bulletify, and for
// the same reason it needs the machinery below: a blockquote is a BLOCK, so
// text left on the line either side of it is not merely untidy, markdown reads
// it as part of the quote.
export function blockquoteFormat(value, start, end) {
  return blockFormat(value, start, end, toggleBlockquote);
}

// The half both of the two above share: turn a selection into a block of its
// own, and detach whatever of its paragraph was NOT selected.
//
// A list is a block, so text left on the same line either side of it is not
// merely untidy — markdown reads it as part of the block. Bulletifying the
// middle of a paragraph used to leave the run-up glued to the first bullet and,
// worse, the remainder lazily continuing the LAST one, so a sentence the reader
// never touched became part of a bullet. A blank line on each side (only where
// there is actually something to separate) makes it a block of its own and puts
// the rest back to being a paragraph. Every word of that is true of a quotation
// too, which is why the two differ by nothing but `transform`.
export function blockFormat(value, start, end, transform) {
  // Swallow the spaces either side of the selection: they belonged to the
  // sentence flow that is being broken up, and left behind they show up as a
  // trailing space on the run-up and a leading one on the remainder.
  let from = start;
  while (from > 0 && (value[from - 1] === " " || value[from - 1] === "\t")) from -= 1;
  let to = end;
  while (to < value.length && (value[to] === " " || value[to] === "\t")) to += 1;
  start = from;
  end = to;
  const body = transform(value.slice(start, end).trim());
  const before = value.slice(0, start);
  const after = value.slice(end);
  // Only what is on THIS line matters: a blank line is already a separation.
  const runUp = before.slice(before.lastIndexOf("\n") + 1);
  const runOn = after.slice(0, after.indexOf("\n") === -1 ? after.length : after.indexOf("\n"));
  const lead = runUp.trim() ? "\n\n" : "";
  const trail = runOn.trim() ? "\n\n" : "";
  return { text: lead + body + trail, rangeStart: start, rangeEnd: end };
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

  // Open/close a split-button's colour menu, or the font list.
  if (action === "color-menu" || action === "highlight-menu" || action === "font-menu") {
    const prop = action.slice(0, action.indexOf("-"));
    const menu = toolbar.querySelector(`.render-color-menu[data-render-menu="${prop}"]`);
    const willOpen = menu && menu.hidden;
    closeAllRenderMenus();
    if (menu && willOpen) {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      setAnyRenderMenuOpen(true);
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

  // Turn the selection into a bullet list — including a run-on line that IS a
  // list and was never written as one. See smartBulletify. Quoting it is the
  // same journey with a different transform (blockFormat), so the two share a
  // branch rather than repeating the raw-editor fallback twice.
  if (action === "bulletify" || action === "blockquote") {
    const format = action === "blockquote" ? blockquoteFormat : bulletifyFormat;
    const editing2 = config.isEditing?.() ? activeEditingTarget() : null;
    if (editing2) {
      pushNotesUndo(action);
      applyFormatToTextarea(editing2.edit, format);
      return;
    }
    // Fuzzy, like bulletify and for its reason: a selection spanning several
    // lines never matches the source verbatim, because Turndown pads its
    // markers differently.
    applyRenderFormat(config, format, { fuzzy: true });
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
