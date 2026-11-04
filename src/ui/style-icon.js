// The ◐ that every section's style button wears, drawn rather than typed.
//
// U+25D0 is in almost no text face: it falls back to whatever symbol font the
// platform has, at that font's size and weight, and came out a few pixels of
// ink beside the ⇓ it sits next to. Drawn on the 24×24 grid the app's other
// icons use (src/library/my-decks-icons.js has the same shape as "style"), and
// in currentColor, so it takes the pressed and hover colours of its button.
//
// A leaf: no imports, so the mark menu and the note window can use it without
// reaching the style modules.
export const STYLE_ICON_SVG = '<svg class="style-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8Z" fill="currentColor" stroke="none"/></svg>';
