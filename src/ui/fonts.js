// A font CHOICE into the CSS value that paints it, fetching the face if the
// choice names one.
//
// ── Why this is a module of its own, for one function ─────────────────────
//
// It was in src/ui/style-settings.js, which was right while the Style panel was
// the only place in the app where anybody could choose a face. A block on a page
// of handwriting can choose one now (src/documents/block-style.js), and that
// module importing style-settings would drag the cards view, the notes caret,
// the paged reader and the markdown table fitter in behind it for two lines of
// lookup.
//
// The obvious home was ./theme-catalog.js, beside the table this reads, whose
// own comment already describes this function's half of the contract. It cannot
// go there: src/ui/style-schema.js reads that file's consts in a TOP-LEVEL
// initialiser, so the catalogue has to import nothing at all — the rule
// tools/module-symbols.mjs enforces, and which it caught the moment this was
// tried. A function is not a const and would have been safe; the checker is
// answering the more useful question, which is whether the FILE can be reached
// from a cycle at all.
//
// So: the table stays a leaf, and the one function that turns an entry of it
// into something a stylesheet can use lives here, where importing it costs its
// callers nothing but this file.

import { ensureWebfont } from "../core/lib-loader.js?v=__BUILD__";
import { fontFamilyChoices } from "./theme-catalog.js?v=__BUILD__";

// ensureWebfont fires the fetch for a choice that names a real webfont — a
// no-op for the four system entries, for "inherit", and for anything not in the
// packages table — and it is idempotent and cached by URL, so every caller may
// say this as often as it likes. The value returned is the stack the browser
// paints with WHILE that fetch is in flight, and for ever if it never lands.
export function resolveFontFamily(value) {
  ensureWebfont(value);
  return fontFamilyChoices[value] || value;
}
