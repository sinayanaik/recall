// Turning {{…}} into cloze markup at render time.

// Convert {{cloze}} spans into hidden fill-in-the-blank markup. Rendered as a
// redaction bar that reveals its text when tapped (see the .cloze click handler).
// Runs before protectMath so any math inside a cloze ($x$) still gets processed.
export function applyClozeMarkup(text) {
  return String(text).replace(
    /\{\{([\s\S]+?)\}\}/g,
    (_match, inner) =>
      `<span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">${inner}</span>`
  );
}
