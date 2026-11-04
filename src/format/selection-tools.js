// The floating toolbar on a notes selection: cloze it, highlight it, erase it,
// or lift it out into a note of its own.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { addDocumentHighlight, documentHighlightsCovering, documentHighlightsUnderRects, recolourDocumentHighlight, removeDocumentHighlight, restyleDocumentHighlight } from "../documents/pdf-highlights.js?v=__BUILD__";
import { captureDocumentSelection } from "../documents/pdf-selection.js?v=__BUILD__";
import { isDocumentViewActive } from "../documents/pdf-view.js?v=__BUILD__";
import { toggleWrapPair } from "../editor/text-transforms.js?v=__BUILD__";
import { MARK_HIGHLIGHT_COLORS } from "./highlight-colors.js?v=__BUILD__";
import { INK_PEN_COLORS } from "./ink-colors.js?v=__BUILD__";
import { MARK_STYLES, MARK_STYLE_LABELS, markStyleOf, normalizeMarkHex, normalizeMarkStyle } from "./mark-styles.js?v=__BUILD__";
import { inkPreferences, rememberInkRecentColor, writeInkPreferences } from "../storage/ink-prefs.js?v=__BUILD__";
import { codeSelectionContext, makeHighlightFromSelection, toggleMarkColorInText } from "./highlight.js?v=__BUILD__";
import { balancedHit, locateSelectionInSource, renderedSelectionStrings } from "./locate-selection.js?v=__BUILD__";
import { sourceRangeForSelection } from "./source-blocks.js?v=__BUILD__";
import { renderFormatDefaults, renderTargetConfig } from "./render-toolbar.js?v=__BUILD__";
import { createLinkedNoteFlow } from "../notes/note-links.js?v=__BUILD__";
import { pushNotesUndo } from "../notes/notes-history.js?v=__BUILD__";
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { currentDeckKey } from "../notes/scroll-anchor.js?v=__BUILD__";
import { activeEditingTarget, activeRenderedTarget, ensurePillSelectionCapture, hideNotesSelectionButton, noteEditorHoldsSelection, pillSelectionCapture, suspendSelectionBarForScroll } from "../notes/selection.js?v=__BUILD__";
import { noteLinkMarkupFor } from "../render/note-links.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { styleMobileMedia } from "../ui/style-tokens.js?v=__BUILD__";

// On a phone the bar sits beside the selection (placeTouchSelectionBar), so a
// scroll moves the selection out from under it. It steps aside for the scroll
// and comes back beside the selection once the scroll stops — without being
// torn down, so extending a selection by scrolling to its other end costs
// nothing. Desktop keeps hiding it outright: its pill is placed afresh by the
// next selection, and a mouse reader scrolling away has usually finished with it.
export function hideNotesSelectionButtonUnlessPinned() {
  if (styleMobileMedia?.matches) {
    suspendSelectionBarForScroll();
    return;
  }
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
  // ...but only when the selection is actually ON the paper. With the
  // side-by-side pane open beside a document, a phrase selected in a note CARD
  // is a markdown selection sitting over a document view — and this branch
  // claimed it, so Highlight, Erase and Cloze acted on the paper or, more often,
  // silently did nothing at all. positionNotesSelectionButton has carried the
  // same guard since the pane existed (it is what draws the pill for the note
  // rather than for the document); without it here the bar appeared for the note
  // and its buttons resolved to the document, which is the worst of both.
  if (isDocumentViewActive() && !noteEditorHoldsSelection()) {
    // Live first, snapshot second — and the snapshot is the half that was
    // missing. Every pill button is pointerdown + preventDefault, so on a mouse
    // the selection genuinely is still alive at this instant and the live
    // capture is the freshest answer. On a touch screen it very often is not:
    // the swatch opens a colour menu, choosing a colour is a second tap, and
    // the selection is gone by then. captureDocumentSelection() returns null
    // for a collapsed selection, so this function returned null, so NONE of the
    // three branches in applyPillHighlight ran and the button did nothing —
    // not even the "Nothing highlighted there" toast. The markdown surfaces
    // have had this fallback all along (ensurePillSelectionCapture, below);
    // the document surface was the one that recorded a capture and never read
    // it back.
    const capture = captureDocumentSelection() || pillSelectionCapture?.document || null;
    const rects = pillSelectionCapture?.targetName === "document" ? pillSelectionCapture.rects : null;
    return capture ? { kind: "document", capture, rects } : null;
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
  const wrapped = toggleMarkColorInText(selected, color, codeSelectionContext(ta.value, start, end));
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

// The client rects of whatever the pill is acting on: the live selection when
// there still is one, and otherwise the ones recorded when the pill appeared.
// Same live-then-snapshot order, and for the same reason, as pillActionTarget.
function selectionRects(target) {
  const selection = window.getSelection();
  if (selection?.rangeCount && !selection.isCollapsed) {
    const live = Array.from(selection.getRangeAt(0).getClientRects());
    if (live.length) return live;
  }
  return target?.rects || [];
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
//
// ── ...and what it hands back ──────────────────────────────────────────────
//
// A descriptor of what was just marked, so a caller can do the NEXT thing to it
// — which today means "Highlight & annotate" opening the note editor on the
// mark it made. The two surfaces name a highlight differently (an ordinal in
// the markdown, a record id on a paper), so what comes back is whichever of the
// two this press produced, and null when nothing was marked at all.
//
// Deliberately not the note editor itself. Both halves of that live on the far
// side of modules this one must not reach — notes/anchors.js for the ordinal,
// documents' own handler set for the paper — and src/main.js already knows all
// of them. Same arrangement as setHighlightBadgeHandler, and for the same
// reason.
// `keepExisting` is the highlight-and-note button's: pressing it over a passage
// that is already highlighted means "write on THAT one", never "toggle it off",
// which is what the plain swatch does with a repeated colour.
// `style` and `hex` say how the words on a PDF are marked
// (src/format/mark-styles.js). Left out, they are what the reader last chose in
// the bar — so the bar's one-press button repeats the last underline as readily
// as the last highlight. Ignored on the notes, where a mark is a <mark>.
export function applyPillHighlight(color, { keepExisting = false, style, hex } = {}) {
  let made = null;
  const target = pillActionTarget();
  if (target?.kind === "document") {
    const prefs = inkPreferences();
    const markStyle = normalizeMarkStyle(style === undefined ? prefs.markStyle : style);
    const markHex = hex === undefined ? prefs.markHex : normalizeMarkHex(hex);
    // "clear" on the document surface means "un-highlight what I have
    // selected", the same as it does in a note — resolved against the
    // selection's own geometry rather than by stripping tags, since there are
    // no tags to strip.
    if (color === "clear") {
      // Every line of the selection, not one guessed point.
      //
      // This used to hit-test the selection's BOUNDING rect at
      // `left + 1, mid-height`. For a selection inside one line that is a point
      // on the words; for a selection spanning two lines it is a point in the
      // left margin between them, and for a drag across a two-column paper it
      // is a point in the gutter. So "remove this highlight" answered "Nothing
      // highlighted there" for most of the selections anyone actually makes,
      // which is what "the cancel/delete button for highlights is broken" was.
      //
      // A range reports one client rect per line fragment, so testing each of
      // them asks the question the reader meant: un-highlight what I have
      // selected. Every record the selection touches goes, because a selection
      // that covers two highlights meant both.
      const under = documentHighlightsUnderRects(selectionRects(target), { textOnly: true });
      under.forEach((record) => removeDocumentHighlight(record.id));
      const removed = under.length;
      if (!removed) showToast("Nothing highlighted there", "error");
      else showToast(removed === 1 ? "Highlight removed" : `${removed} highlights removed`);
    } else {
      // Recolour what is already there rather than stacking another record on
      // top of it. Re-highlighting a passage in a new colour used to ADD a
      // second record over the first: two entries in the panel for one
      // sentence, two "Go to" buttons, and a tap resolving to whichever was
      // made first (documentHighlightAtPoint returns the earliest match). That
      // is one of the ways "multiple highlights in a single line" happened
      // without the reader ever making two.
      //
      // COVERED, not merely touched, and the distinction is the whole rule.
      // Selecting a paragraph that happens to contain one highlighted word and
      // pressing green means "make this paragraph green" — recolouring the word
      // and leaving the rest unmarked would be the app deciding it knew better.
      // Selecting words that are ALREADY entirely highlighted and pressing
      // green means "make that one green". So: recolour when the selection adds
      // nothing new, and add a highlight when it does.
      const rects = selectionRects(target);
      // Text highlights only: a region drawn round this passage is not "already
      // highlighting" it — see documentHighlightsUnderRects.
      //
      // ...and covered by a mark of the SAME style. Underlining words that are
      // already highlighted is a second mark on them, not the highlight turned
      // into a line: a reader who wants it gone has ✕.
      const covering = documentHighlightsCovering(rects, { textOnly: true })
        .filter((record) => markStyleOf(record) === markStyle);
      if (covering.length) {
        covering.forEach((record) => {
          if (markHex) restyleDocumentHighlight(record.id, { hex: markHex });
          else if (normalizeMarkHex(record.hex)) restyleDocumentHighlight(record.id, { hex: null, color });
          else recolourDocumentHighlight(record.id, color);
        });
        // The one the reader was pointing at, when the press covered several.
        made = { surface: "document", id: covering[0].id };
      } else {
        const record = addDocumentHighlight(target.capture, color, { style: markStyle, hex: markHex });
        if (record) made = { surface: "document", id: record.id };
      }
    }
    // The selection has served its purpose and a live one over a fresh
    // highlight hides the colour that was just applied.
    window.getSelection()?.removeAllRanges();
  } else if (target?.kind === "rendered") {
    const result = makeHighlightFromSelection(renderTargetConfig(target.name), color, target.sel, { keepExisting });
    // `idx` is the offset of the new mark's own open tag in `source` — an
    // ordinal is one scan away, and only the caller that wants one has to pay
    // for it. A removal has nothing to annotate.
    if (result && result.action !== "removed") {
      made = { surface: "notes", target: target.name, idx: result.idx, source: result.source };
    }
  } else if (target?.kind === "editing") {
    // No mark to point a popup at: the raw editor shows tags, not marks. The
    // highlight still lands; the note step simply has nowhere to open.
    highlightTextareaSelection(target.target, color);
  }
  closePillHighlightMenu();
  hideNotesSelectionButton();
  return made;
}

export function closePillHighlightMenu() {
  if (!el.highlightSelectionMenu) return;
  el.highlightSelectionMenu.hidden = true;
  el.highlightSelectionMenuBtn?.setAttribute("aria-expanded", "false");
}

// Three rows on a PDF, one everywhere else. The first is the four colours and
// ✕, as it always was. On a PDF a second says HOW the words are marked — a tint,
// a line under or through them, a wave, a box — and a third offers the pen's
// palette and a colour of the reader's own. Notes have no such marks (a <mark>
// is a tint), so the two rows are hidden there rather than offered and refused.
export function buildPillHighlightMenu() {
  if (!el.highlightSelectionMenu || el.highlightSelectionMenu.childElementCount) return;
  const colours = MARK_HIGHLIGHT_COLORS.map(
    (c) =>
      `<button type="button" class="pill-swatch-btn" data-pill-highlight="${c.value}" style="--sw:${c.swatch};" title="${c.name}" aria-label="${c.name}"></button>`
  ).join("") +
    '<button type="button" class="pill-swatch-clear" data-pill-highlight="clear" title="Remove highlight" aria-label="Remove highlight">&#10005;</button>';
  // Each style button is the letter A marked that way — the one glyph every
  // font has, so the five read alike on every platform.
  const styles = MARK_STYLES.map((name) =>
    `<button type="button" class="pill-style-btn" data-pill-style="${name}" title="${MARK_STYLE_LABELS[name]}" aria-label="${MARK_STYLE_LABELS[name]}"><span class="mark-style-glyph is-${name}" aria-hidden="true">A</span></button>`
  ).join("");
  const more = INK_PEN_COLORS.map((c) =>
    `<button type="button" class="pill-swatch-btn is-small" data-pill-hex="${c.swatch}" style="--sw:${c.swatch};" title="${c.name}" aria-label="${c.name}"></button>`
  ).join("") +
    '<label class="pill-color-pick" title="A colour of your own" aria-label="A colour of your own"><span aria-hidden="true">&#65291;</span><input type="color" data-pill-custom value="#7c3aed"></label>';
  el.highlightSelectionMenu.innerHTML =
    `<div class="pill-mark-row" data-pill-row="colours">${colours}</div>` +
    `<div class="pill-mark-row" data-pill-row="styles" role="group" aria-label="How to mark the words" hidden>${styles}</div>` +
    `<div class="pill-mark-row" data-pill-row="more" role="group" aria-label="More colours" hidden>${more}</div>`;
}

// Show the PDF rows when the selection is on a PDF, and say which style is the
// one a press will use. Called each time the menu opens.
export function refreshPillHighlightMenu() {
  const menu = el.highlightSelectionMenu;
  if (!menu) return;
  const onPaper = isDocumentViewActive() && !noteEditorHoldsSelection();
  menu.classList.toggle("has-mark-rows", onPaper);
  menu.querySelectorAll('[data-pill-row="styles"], [data-pill-row="more"]').forEach((row) => { row.hidden = !onPaper; });
  if (!onPaper) return;
  const prefs = inkPreferences();
  menu.querySelectorAll("[data-pill-style]").forEach((button) => {
    const current = button.dataset.pillStyle === prefs.markStyle;
    button.classList.toggle("is-current", current);
    button.setAttribute("aria-pressed", String(current));
  });
}

// The bar's own style buttons and colour rows, on a PDF. A style is
// remembered and applied at once, in the colour last used; a colour from the
// pen's palette or of the reader's own is remembered as `markHex` until one of
// the four is pressed again.
export function applyPillMarkStyle(style) {
  const markStyle = normalizeMarkStyle(style);
  writeInkPreferences({ markStyle });
  return applyPillHighlight(renderFormatDefaults.highlight, { style: markStyle });
}

export function applyPillMarkHex(hex) {
  const markHex = normalizeMarkHex(hex);
  if (!markHex) return null;
  writeInkPreferences({ markHex });
  rememberInkRecentColor(markHex);
  return applyPillHighlight(renderFormatDefaults.highlight, { hex: markHex });
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
    // Placed by its two ends where it can be, the way the eraser places it — a
    // selection that takes whole lines takes their markers, so a section split
    // out moves its "## " heading with it and the link takes the line's place.
    // What moves is then the note's own markdown, exactly, not the selection
    // re-serialised from the page. Inline markup cut at either end is widened to
    // whole so the moved text is balanced. The text search is the fallback.
    const notes = state.notes || "";
    const placed = sel.range ? balancedHit(notes, sourceRangeForSelection(notes, sel, { lines: true }), false) : null;
    const loc = placed || locateSelectionInSource(notes, sel, { fuzzy: true });
    if (!loc) {
      showToast("Couldn't match that selection in the note — try selecting within one section.", "error");
      return;
    }
    body = placed ? notes.slice(placed.idx, placed.end) : (sel.asMarkdown || sel.asText || "");
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
