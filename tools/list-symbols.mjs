// Top-level symbols of a module, in source order: `line  kind  name`.
// Used to carve the split into regions — the file is already grouped by
// feature, so a region is almost always a contiguous run of these.
import { readFileSync } from "node:fs";
import { topLevelDecls } from "./js-scan.mjs";
const file = process.argv[2] || "src/main.js";
for (const d of topLevelDecls(readFileSync(file, "utf8"))) {
  console.log(`${String(d.line).padStart(6)}  ${d.kind.padEnd(8)}  ${d.name}`);
}
