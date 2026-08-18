// The editor toolbars, and the reveal-all-clozes button.

import { el } from "../core/dom.js?v=__BUILD__";
import { enableSyntaxHighlighting } from "./highlight-mirror.js?v=__BUILD__";
import { markHighlightSwatchButtonsHtml } from "../format/highlight.js?v=__BUILD__";
import { CLOZE_MAKE_ICON, RENDER_HIGHLIGHT_GLYPH, refreshRenderSwatches } from "../format/render-toolbar.js?v=__BUILD__";

// Dynamic HTML template for the inline edit toolbar.
// Pass { quickNote: true } to append the "save selection to quick_notes" button.
// The + / quick-note pair mirrors the rendered-view render-toolbar's capture
// group: this toolbar REPLACES that one while raw-editing, so anything only
// present there would silently disappear the moment you tapped ✎.
export function createToolbarHtml(options = {}) {
  // The three controls a SELECTION cannot express, which is why they have no
  // home on the floating pill: inserting an image needs a caret, not a
  // selection, and bullet / clear-formatting act on whole lines.
  const lineTools = `
    <button type="button" data-action="bullet" title="Toggle Bullet List">-</button>
    <button type="button" data-action="insert-image" title="Insert image (upload to Supabase Storage)">🖼️</button>
    <button type="button" data-action="clear-all" title="Clear Formatting">Tx</button>`;
  // Everything else this toolbar used to carry — B I U S </>, font, colour,
  // highlight, and the capture group — now lives on the floating selection pill,
  // which works in raw mode too (see applyRenderFormat's editing branch). A
  // permanent row of controls that every one of them refuses without a selection
  // was a row that did nothing while you read, and on a phone it was a row that
  // did nothing while covering the text.
  //
  // The All Cards editor is the exception and still asks for the full strip: it
  // is the one editing surface the pill does not serve (SELECTION_TARGETS covers
  // notes, question and answer only), so its textareas would otherwise lose
  // formatting altogether.
  if (options.formatting === false) return lineTools;
  const quickNoteBtn = options.quickNote
    ? `
    <span class="edit-toolbar-divider" aria-hidden="true"></span>
    <button type="button" data-action="make-card" class="toolbar-make-card" title="Make a flashcard from the selection">+</button>
    <button type="button" data-action="quick-note" class="toolbar-quick-note" title="Save selection to the quick_notes deck">📌</button>`
    : "";
  // The notes header owns cloze/capture and stays visible while raw-editing, so
  // repeating them here would show each action twice in the same header.
  const clozeBtn = options.cloze === false
    ? ""
    : `
    <button type="button" data-action="cloze" class="make-cloze-btn" title="Cloze — hide selection as a fill-in-the-blank (tap the card to reveal)">${CLOZE_MAKE_ICON}</button>`;
  return `
    <button type="button" data-action="bold" title="Bold"><b>B</b></button>
    <button type="button" data-action="italic" title="Italic"><i>I</i></button>
    <button type="button" data-action="underline" title="Underline"><u>U</u></button>
    <button type="button" data-action="strikethrough" title="Strikethrough"><span style="text-decoration: line-through;">S</span></button>
    <button type="button" data-action="code" title="Code Block"><code>&lt;/&gt;</code></button>${clozeBtn}

    <div class="toolbar-dropdown">
      <button type="button" class="toolbar-dropdown-toggle" title="Font Family">Aa</button>
      <div class="toolbar-dropdown-content font-menu">
        <button type="button" data-font="sans-serif" style="font-family: sans-serif;">Sans-Serif</button>
        <button type="button" data-font="serif" style="font-family: serif;">Serif</button>
        <button type="button" data-font="monospace" style="font-family: monospace;">Monospace</button>
        <button type="button" data-font="cursive" style="font-family: cursive;">Cursive</button>
        <button type="button" data-font="system-ui" style="font-family: system-ui;">System UI</button>
        <button type="button" data-font="georgia" style="font-family: georgia, serif;">Georgia</button>
        <button type="button" data-font="Garamond" style="font-family: Garamond, serif;">Garamond</button>
        <button type="button" data-font="Impact" style="font-family: Impact, sans-serif;">Impact</button>
        <button type="button" data-font="Trebuchet MS" style="font-family: 'Trebuchet MS', sans-serif;">Trebuchet</button>
        <button type="button" data-font="Arial" style="font-family: Arial, sans-serif;">Arial</button>
        <button type="button" data-font="Times New Roman" style="font-family: 'Times New Roman', serif;">Times New Roman</button>
        <button type="button" data-font="Verdana" style="font-family: Verdana, sans-serif;">Verdana</button>
        <button type="button" data-font="Tahoma" style="font-family: Tahoma, sans-serif;">Tahoma</button>
        <button type="button" data-font="Courier New" style="font-family: 'Courier New', monospace;">Courier New</button>
        <button type="button" data-font="Consolas" style="font-family: Consolas, monospace;">Consolas</button>
        <button type="button" data-font="Comic Sans MS" style="font-family: 'Comic Sans MS', cursive;">Comic Sans</button>
      </div>
    </div>

    <div class="toolbar-dropdown">
      <button type="button" class="toolbar-dropdown-toggle" title="Text Color"><span class="render-glyph">A</span><span class="render-underbar"></span></button>
      <div class="toolbar-dropdown-content color-menu">
        <button type="button" data-color="#ef4444" style="--btn-bg: #ef4444;" title="Red"></button>
        <button type="button" data-color="#f97316" style="--btn-bg: #f97316;" title="Orange"></button>
        <button type="button" data-color="#f59e0b" style="--btn-bg: #f59e0b;" title="Yellow"></button>
        <button type="button" data-color="#10b981" style="--btn-bg: #10b981;" title="Green"></button>
        <button type="button" data-color="#14b8a6" style="--btn-bg: #14b8a6;" title="Teal"></button>
        <button type="button" data-color="#3b82f6" style="--btn-bg: #3b82f6;" title="Blue"></button>
        <button type="button" data-color="#6366f1" style="--btn-bg: #6366f1;" title="Indigo"></button>
        <button type="button" data-color="#8b5cf6" style="--btn-bg: #8b5cf6;" title="Purple"></button>
        <button type="button" data-color="#ec4899" style="--btn-bg: #ec4899;" title="Pink"></button>
        <button type="button" data-color="var(--accent-strong)" style="--btn-bg: var(--accent-strong);" title="Accent"></button>
        <button type="button" data-color="#ffffff" style="--btn-bg: #ffffff;" title="White"></button>
        <button type="button" data-color="#9ca3af" style="--btn-bg: #9ca3af;" title="Gray"></button>
        <button type="button" data-color="clear" class="color-clear" title="Clear Color">Clear Color</button>
      </div>
    </div>

    <div class="toolbar-dropdown">
      <button type="button" class="toolbar-dropdown-toggle" title="Highlight">${RENDER_HIGHLIGHT_GLYPH}</button>
      <div class="toolbar-dropdown-content highlight-menu">
        ${markHighlightSwatchButtonsHtml()}
        <button type="button" data-highlight="clear" class="highlight-clear" title="Clear Highlight">Clear Highlight</button>
      </div>
    </div>

${lineTools}${quickNoteBtn}
  `;
}

// Populate toolbars for static question & answer fields on load
export function initToolbars() {
  // All three faces get the line-tools strip only. Formatting AND capture (+ /
  // cloze / 📌) both ride the floating pill now, in raw mode as well as
  // rendered, so repeating either here would be a second copy of a control that
  // is already on screen the moment it can be used.
  [el.questionEditToolbar, el.answerEditToolbar, el.notesEditToolbar].forEach((tb) => {
    if (tb) tb.innerHTML = createToolbarHtml({ formatting: false });
  });

  if (el.questionEdit) enableSyntaxHighlighting(el.questionEdit);
  if (el.answerEdit) enableSyntaxHighlighting(el.answerEdit);
  if (el.notesEdit) enableSyntaxHighlighting(el.notesEdit);
  // The All Cards editor's strips still carry their own copy of the highlight
  // glyph (RENDER_HIGHLIGHT_GLYPH, inside the Highlight dropdown toggle), and
  // they are built after this runs — but painting here costs nothing and keeps
  // the swatches right for any strip already in the document. Safe to call
  // again: refreshRenderSwatches just re-paints every match.
  refreshRenderSwatches();
}

// --- Global "flip all clozes" button (current card / notes only) ------------
// A plain alternating switch: each press flips EVERY cloze in the view to the
// opposite of the button's current state — press once to reveal them all, press
// again to hide them all. The button's aria-pressed is the single source of
// truth (true = currently showing), so the action is always predictable. The
// button resets to hidden whenever the view re-renders (see resetClozeButton).
// Tapping an individual cloze still overrides just that one afterwards.
export function setClozeButtonState(button, revealed) {
  if (!button) return;
  button.setAttribute("aria-pressed", revealed ? "true" : "false");
  const label = button.querySelector(".cloze-toggle-label");
  if (label) label.textContent = revealed ? "Hide clozes" : "Reveal clozes";
  // The glyph itself is drawn in CSS off aria-pressed (an "A" you can reveal,
  // becoming the bare blank you'd go back to) rather than swapped here — block
  // characters render at wildly different weights across platforms, and this
  // button now sits next to two other cloze controls it must stay distinct from.
  button.title = revealed ? "Hide all clozes on this card" : "Reveal all clozes on this card";
}

export function toggleClozes(container, button) {
  if (!container || !button) return;
  const reveal = button.getAttribute("aria-pressed") !== "true";
  container.querySelectorAll(".cloze").forEach((c) => c.classList.toggle("is-revealed", reveal));
  setClozeButtonState(button, reveal);
}

// New card / re-rendered notes start with every cloze hidden again.
export function resetClozeButton(button) {
  setClozeButtonState(button, false);
}

// ── Hamburger menu (side drawer, all screen sizes) ───────────────
// The drawer's controls live inside the block below, but the overlay stack
// (OVERLAY_LAYERS) and the Back key have to be able to see and close it from
// outside. These two are the seam. They default to "there is no drawer" so
// nothing has to null-check them if the markup is ever absent.
export let isMainMenuOpen = () => false;

// Setter: an imported binding is read-only, and initToolbars in main.js installs the drawer's real implementation.
export function setIsMainMenuOpen(value) {
  isMainMenuOpen = value;
}

export let closeMainMenu = () => {};

// Setter: an imported binding is read-only, and initToolbars in main.js installs the drawer's real implementation.
export function setCloseMainMenu(value) {
  closeMainMenu = value;
}

// ── The three edit toolbars, by name ───────────────────────────────────────
//
// Their dropdowns used to be closed with `document.querySelectorAll(".edit-toolbar
// .toolbar-dropdown")` — a descendant combinator, so no fast path, so a full CSS
// match against every element in the document. One of those ran on EVERY click
// anywhere in the app (see the dropdown handler in main.js), which with a
// book-sized note open means walking a couple of hundred thousand elements to
// close menus that live in three known boxes.
export function editToolbars() {
  return [el.notesEditToolbar, el.questionEditToolbar, el.answerEditToolbar].filter(Boolean);
}

export function closeAllEditToolbarDropdowns() {
  editToolbars().forEach((toolbar) => {
    toolbar.querySelectorAll(".toolbar-dropdown").forEach((d) => d.classList.remove("is-open"));
  });
}
