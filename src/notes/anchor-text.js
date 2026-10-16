// The words a reader sees, from the markdown behind them — for anchors that
// are found again by searching the RENDERED note for their text.
//
// A leaf, so that src/notes/scroll-anchor.js (which samples where the reader
// is) can use it without importing src/notes/anchors.js, which imports it.

// Strip markdown syntax down to the plain text a reader sees — used both to
// build a searchable anchor snippet and to match a card's answer against the
// rendered notes for the content fallback.
export function notesAnchorPlainText(src) {
  return String(src || "")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, "").replace(/```/g, "")) // code fences → inner text
    .replace(/`([^`]*)`/g, "$1")                 // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")        // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")     // links → label
    .replace(/\{\{|\}\}/g, "")                   // cloze braces
    // Highlights are literal <mark>…</mark> pairs living in the markdown, so any
    // snippet taken from highlighted text carries the tags. They have to go
    // BEFORE the emphasis rule below, which eats a tag's ">" and leaves
    // "<markAlpha beta</mark" — a needle that can never appear in the rendered
    // text, so every jump built from it failed. Deliberately mark tags only, not
    // a general tag strip: prose containing "a < b" must survive untouched.
    .replace(/<\/?mark(?:\s[^>]*)?>/g, "")       // highlight tags
    .replace(/[*_~>#]+/g, "")                    // inline emphasis / heading / quote markers
    .replace(/\s+/g, " ")
    .trim();
}

// The `text` of an anchor taken at a raw offset — a bookmark, or the reading
// position — as the rendered note will show it.
//
// Both used to store a bare slice of the markdown, and the rendered-text search
// that finds an anchor again (findRenderedNoteRange) compares against what is
// on screen. An imported book is made of exactly what that loses: emphasis,
// links, and the inline HTML the EPUB import keeps (<sup> footnote markers,
// <span>s, <img>s). Such a needle could never match, so every "Go to bookmark"
// on a book fell back to an estimate and kept re-aiming at it — which is how
// it came to fight the reader's scroll.
//
// Inline tags are stripped here and not in notesAnchorPlainText, whose other
// callers deliberately leave "a < b" prose alone: a tag needs a letter straight
// after the "<", which ordinary comparison text does not have.
const INLINE_TAG_RE = /<\/?[A-Za-z][^<>\n]*>/g;

export function renderedAnchorText(source) {
  return notesAnchorPlainText(String(source || "").replace(INLINE_TAG_RE, ""));
}
