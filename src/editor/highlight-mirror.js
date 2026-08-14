// Syntax highlighting in the raw editor.
//
// The <textarea> is transparent and laid over a backdrop <div> holding a styled
// copy of the same text — so what you read in raw mode IS the mirror, and
// without it the textarea's own text is invisible. Past a size limit the mirror
// is switched off (and the text made visible again), because re-escaping and
// re-laying out a very large document on every keystroke is not affordable.

// Syntax highlighting backdrop creator for textareas.
//
// The textarea's own text is transparent (see .edit-textarea) — what you read in
// raw mode is this mirror underneath it, which is why it can't simply be skipped
// for a big document. What it CAN do is stop rebuilding itself more than once
// per frame: a burst of keystrokes (or a held key) used to re-escape and re-lay
// out the whole document once per event.
export const highlightBackdropSync = new WeakMap();

export function refreshHighlightBackdrop(textarea) {
  highlightBackdropSync.get(textarea)?.();
}

// ── Why very large notes edit without the highlight mirror ─────────────────
// The raw editor is a transparent <textarea> laid over a backdrop <div> holding
// a styled copy of the same text — that mirror is the only thing you actually
// see, and it's what tints {{cloze}} braces and fades HTML tags. Its cost is a
// second full text layout of the whole document, and unlike the textarea's own
// (native, cheap) layout it is ordinary DOM text with spans, which measured
// roughly ten times more expensive.
//
// On a large note that is ruinous, and it dominated everything the editor does.
// Measured on an 800KB note, entering raw mode took 1,950ms with the mirror and
// 186ms without it; a single keystroke took 442ms with and 187ms without,
// because every keystroke replaces the mirror's entire innerHTML and re-lays out
// the document. The string work itself is nothing (~1ms) — it is purely the
// layout of a second copy of the text.
//
// So past this threshold the mirror is switched off and the textarea shows its
// own text instead (see .highlight-textarea-wrapper.is-plain in styles.css,
// which un-hides the textarea's colour and moves the visible border onto it).
// What that costs is the cloze/HTML-tag tinting, on exactly the notes least
// likely to use clozes — an imported book chapter — and what it buys is an
// editor that responds to typing. Everything below the threshold is unchanged.
export const HIGHLIGHT_MIRROR_MAX_CHARS = 60000;

export function enableSyntaxHighlighting(textarea) {
  if (!textarea || textarea.dataset.highlighted === "true") return;
  textarea.dataset.highlighted = "true";

  const wrapper = document.createElement("div");
  wrapper.className = "highlight-textarea-wrapper";

  const backdrop = document.createElement("div");
  backdrop.className = "highlight-textarea-backdrop";

  textarea.parentNode.insertBefore(wrapper, textarea);
  wrapper.appendChild(backdrop);
  wrapper.appendChild(textarea);

  let syncedText = null;
  let syncFrame = 0;
  let plainMode = false;

  function sync() {
    const text = textarea.value;
    if (text === syncedText) return;
    syncedText = text;

    // Checked before any string work: past the threshold the whole point is to
    // never build or lay out a second copy of the text.
    const wantPlain = text.length > HIGHLIGHT_MIRROR_MAX_CHARS;
    if (wantPlain !== plainMode) {
      plainMode = wantPlain;
      wrapper.classList.toggle("is-plain", wantPlain);
      // Dropping the old mirror content matters as much as not building a new
      // one — leaving a stale 800KB subtree in the DOM would keep costing
      // layout and memory for as long as the editor is open.
      if (wantPlain) backdrop.textContent = "";
    }
    if (plainMode) return;

    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Fade out HTML syntax tags
    let highlighted = escaped.replace(/(&lt;\/?[a-zA-Z0-9]+(?:\s+[^&]*)?&gt;)/g, '<span class="syntax-tag">$1</span>');

    // Tint {{cloze}} enclosures so blanks stand out in the raw markdown. Only
    // colour changes are applied here (never font-style/weight/family) — the
    // backdrop must keep identical character metrics to the transparent
    // textarea it sits behind, or the caret would drift out of alignment.
    highlighted = highlighted.replace(
      /(\{\{)([\s\S]*?)(\}\})/g,
      '<span class="syntax-cloze"><span class="syntax-cloze-brace">$1</span>$2<span class="syntax-cloze-brace">$3</span></span>'
    );

    // [[note reference]] — tinted so a link is visible in the raw text too.
    // Colour only, for the same reason as the cloze rule above.
    highlighted = highlighted.replace(
      /\[\[[^[\]\n]*?\]\]/g,
      '<span class="syntax-note-link">$&</span>'
    );

    if (highlighted.endsWith("\n") || highlighted === "") {
      highlighted += " ";
    }

    backdrop.innerHTML = highlighted;
  }

  // One rebuild per frame at most. The mirror only has to be right by the time
  // the frame is painted, so several inputs landing in the same frame (fast
  // typing, autorepeat, a paste followed by a programmatic edit) collapse into a
  // single pass over the text.
  function scheduleSync() {
    if (syncFrame) return;
    syncFrame = requestAnimationFrame(() => {
      syncFrame = 0;
      sync();
    });
  }

  function syncNow() {
    if (syncFrame) {
      cancelAnimationFrame(syncFrame);
      syncFrame = 0;
    }
    sync();
  }

  // Deliberately synchronous, and deliberately NOT rAF-coalesced: the backdrop
  // is the only thing painting visible text, so deferring this by even one frame
  // would tear the text away from the scroll on a fling. Two property writes on
  // an element whose styles are already clean is not what makes scrolling
  // expensive — measuring the mirror was (see scheduleNotesCaretCheck).
  function syncScroll() {
    // Nothing to keep in step in plain mode, and skipping it keeps scrolling a
    // large note free of a per-event write that would force layout.
    if (plainMode) return;
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  }

  textarea.addEventListener("input", scheduleSync);
  textarea.addEventListener("scroll", syncScroll, { passive: true });
  highlightBackdropSync.set(textarea, syncNow);

  // Initialize
  sync();
  syncScroll();
}
