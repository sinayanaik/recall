// Does the SQL in the README still match the SQL in the file?
//
//   node tools/readme-sql-check.mjs
//
// README Step 3 embeds the whole of supabase_setup.sql inline and tells the
// reader, in as many words, that "the two are identical". That sentence was
// true when it was written and is not self-enforcing: the setup file is what a
// developer edits, the README copy is what a user PASTES, and nothing connected
// them.
//
// They drifted the moment PDF documents landed. supabase_setup.sql got the
// bucket flipped to private, a `documents` bucket and owner-scoped read
// policies; the README kept `VALUES ('images', 'images', true)` and the old
// open-read policy, under a heading that had been updated to mention documents.
// So it LOOKED current and was not, and anyone setting up a project by
// following Step 3 — which is the documented path — got the old schema and no
// documents bucket at all.
//
// A comparison is the only thing that keeps a sentence like that honest.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const sql = readFileSync(path.join(ROOT, "supabase_setup.sql"), "utf8").replace(/\n+$/, "");

// The block is found by its own first line rather than by position, so adding a
// paragraph above it does not break this.
const OPEN = "```sql\n-- ============================================================================\n-- Recall — complete Supabase setup.";
const start = readme.indexOf(OPEN);
if (start === -1) {
  console.error("readme-sql-check: could not find the embedded setup SQL block in README.md.");
  console.error("  It starts with a ```sql fence followed by the file's own banner comment.");
  process.exit(1);
}
const bodyStart = start + "```sql\n".length;
const end = readme.indexOf("\n```", bodyStart);
if (end === -1) {
  console.error("readme-sql-check: the embedded SQL block in README.md is never closed.");
  process.exit(1);
}
const embedded = readme.slice(bodyStart, end);

if (embedded === sql) {
  console.log(`README's embedded SQL matches supabase_setup.sql (${sql.split("\n").length} lines)`);
  process.exit(0);
}

// Say WHICH lines differ, not just that they do — the block is 500 lines and
// "they differ" is not a starting point for anyone.
const a = embedded.split("\n");
const b = sql.split("\n");
const diffs = [];
for (let i = 0; i < Math.max(a.length, b.length) && diffs.length < 8; i++) {
  if (a[i] !== b[i]) diffs.push({ line: i + 1, readme: a[i] ?? "(missing)", file: b[i] ?? "(missing)" });
}
console.error(`readme-sql-check: README.md's embedded SQL has drifted from supabase_setup.sql`);
console.error(`  README block: ${a.length} lines · supabase_setup.sql: ${b.length} lines`);
diffs.forEach((d) => {
  console.error(`  line ${d.line}:`);
  console.error(`    README: ${d.readme.slice(0, 100)}`);
  console.error(`    file:   ${d.file.slice(0, 100)}`);
});
console.error("  Fix by replacing the README's ```sql block with supabase_setup.sql verbatim.");
process.exit(1);
