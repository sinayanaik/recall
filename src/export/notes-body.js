// The deck's notes as they should leave this app.
//
// Highlight notes are STORED in a fenced block of HTML comments at the end of
// the note (src/format/notes-fence.js), which is the right container inside the
// app — it has an unambiguous boundary, it renders as nothing, and it can be
// sliced off the raw editor. It is the wrong thing to hand someone as a file.
//
// So an export puts them back the way the first version of this feature stored
// them: a `## Highlight Notes` section with a `### [hn-xxxx] “excerpt”` per
// note, appended after a horizontal rule. That form is ordinary markdown, it
// reads as prose in any editor, and — because setHighlightNoteInSource still
// parses it — a note exported today and imported back tomorrow arrives with
// every note still attached to every highlight.
//
// One seam, so the four notes exporters (markdown, HTML, .docx and the print
// path) cannot drift on it. NOT used by src/export/sql.js: that one reproduces
// the database ROW, and the row's `notes` column is the note exactly as stored.

import { highlightNotesSectionMarkdown } from "../format/highlight-notes.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";

export function notesForExport() {
  const body = readerNotesBody(state.notes || "").replace(/\s+$/, "");
  const section = highlightNotesSectionMarkdown(state.notes || "");
  if (!section) return body;
  return body ? `${body}\n\n---\n\n${section}` : section;
}
