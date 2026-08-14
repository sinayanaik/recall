// Does the identifier scanner actually see every reference?
//
//   node tools/scanner-audit.mjs
//
// module-symbols is only as good as referencedIdentifiers(): a name the scanner
// never reports is a cross-module reference nobody checks. That is not
// hypothetical — the scanner skipped anything preceded by /[.?]\s*$/, meaning
// to skip `.foo` and `?.foo`, and thereby skipped every `cond ? foo : bar` as
// well. Thirteen missing imports hid behind it, each a ReferenceError on some
// path, and every one of them was reported as clean.
//
// So this audits the auditor. For every top-level name any module owns, if the
// name appears as a whole word in another module's REAL code (comments and
// strings blanked) and the scanner does not report it, say so.
//
// Object-literal keys are excluded, because `{ allCardsFilter: … }` is a key and
// not a reference — the scanner is right to skip those, and counting them would
// bury a real finding in noise.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blankLiterals, referencedIdentifiers, topLevelDecls } from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
if (!existsSync(SRC)) { console.log("No src/ — nothing to audit."); process.exit(0); }

const walk = (d, o = []) => {
  for (const e of readdirSync(d).sort()) {
    const f = path.join(d, e);
    statSync(f).isDirectory() ? walk(f, o) : e.endsWith(".js") && o.push(f);
  }
  return o;
};

const files = walk(SRC);
const owner = new Map();
for (const f of files) {
  for (const d of topLevelDecls(readFileSync(f, "utf8"))) {
    if (!owner.has(d.name)) owner.set(d.name, path.relative(ROOT, f));
  }
}

const findings = [];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  // Import lines are stripped from BOTH sides. A name only present in
  // `import { foo } from …` is "seen" by the scanner from that line alone, which
  // would mask a blind spot in how the name is USED further down — the ternary
  // hole hid behind exactly that.
  const raw = readFileSync(f, "utf8")
    .split("\n").filter((l) => !/^import\s.+from\s*["'][^"']+["'];\s*$/.test(l)).join("\n");
  const blanked = blankLiterals(raw);
  const seen = referencedIdentifiers(raw);
  const own = new Set(topLevelDecls(raw).map((d) => d.name));

  for (const [name, from] of owner) {
    // Deliberately NOT skipping names this file imports. A blind spot must be
    // detectable on its own, not only when it happens to coincide with a
    // missing import — otherwise fixing the imports hides the hole that let
    // them go missing, and the next one is invisible again.
    if (from === rel || own.has(name) || seen.has(name)) continue;
    const re = new RegExp(`(^|[^\\w$.])${name}($|[^\\w$])`, "g");
    let m;
    while ((m = re.exec(blanked))) {
      const at = m.index + m[1].length;
      const after = blanked.slice(at + name.length, at + name.length + 3);
      const before = blanked.slice(Math.max(0, at - 40), at);
      // An object-literal key, not a reference.
      if (/^\s*:/.test(after) && /[{,]\s*$/.test(before)) continue;
      findings.push(`${rel}: ${name} (owned by ${from}) — «${raw.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, " ")}»`);
      break;
    }
  }
}

if (findings.length) {
  console.log(`SCANNER BLIND SPOT (${findings.length}) — these appear in code but referencedIdentifiers never reports them:`);
  for (const line of findings.slice(0, 25)) console.log("  " + line);
  if (findings.length > 25) console.log(`  … and ${findings.length - 25} more`);
} else {
  console.log(`scanner sees every cross-module reference (${owner.size} symbols over ${files.length} modules)`);
}
process.exit(findings.length ? 1 : 0);
