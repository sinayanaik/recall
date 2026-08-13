// A tiny, dependency-free JavaScript scanner: enough to walk this codebase's
// top level without a parser.
//
// It exists because the repo has no build step and no node_modules, and three
// separate tools need the same one hard part — stepping over comments, strings,
// template literals and regex literals, all of which carry unbalanced braces in
// this code ("{\begin{aligned}", "{{x}}", /\{\{([\s\S]+?)\}\}/). Getting that
// wrong doesn't fail loudly, it silently mis-reads a function body.
//
// The brace-matching half started life inside recall-clipper/tools/port-sync.mjs
// and is now shared from here so there is exactly one copy. port-sync's results
// must not change, so extract()/extractConst()/normalize() below are its
// originals, unmodified.
//
// Consumers:
//   tools/split-parity.mjs               — did the restructure change any code?
//   tools/module-symbols.mjs             — is every cross-module reference imported?
//   recall-clipper/tools/port-sync.mjs   — have the extension's ports drifted?

// Words after which a `/` begins a regex literal rather than a division. The
// character-level test below cannot see these: in `return /^\d+$/.test(x)` the
// preceding character is `n`, so a naive scanner reads the regex as division
// and then lexes its contents as code. Harmless for brace matching (these
// regexes hold no braces) but not for identifier scanning, which would harvest
// `what`, `how`, `why` out of app.js:9195 as if they were variables.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw"
]);

// Characters after which a `/` begins a regex literal. port-sync's original
// list, kept as-is.
const REGEX_PRECEDING_CHARS = /[(,=:[!&|?+\-*%~^{};\n]/;

function isIdentChar(c) {
  return c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c >= "0" && c <= "9" || c === "_" || c === "$";
}

// The identifier or keyword ending at index `end` (exclusive), or "".
function wordEndingAt(src, end) {
  let i = end;
  while (i > 0 && isIdentChar(src[i - 1])) i--;
  return src.slice(i, end);
}

// Is the `/` at index `i` the start of a regex literal?
function regexStartsAt(src, i, prevChar) {
  if (REGEX_PRECEDING_CHARS.test(prevChar || "\n")) return true;
  if (!isIdentChar(prevChar)) return false;
  // Walk back over the identifier that ends just before this `/`, skipping the
  // whitespace between them.
  let j = i;
  while (j > 0 && /\s/.test(src[j - 1])) j--;
  return REGEX_PRECEDING_KEYWORDS.has(wordEndingAt(src, j));
}

/**
 * Replace every comment, string, template literal and regex literal with spaces
 * of the same length, leaving newlines in place. The result is the same length
 * as the input and has the same line numbering, so offsets and line counts
 * computed against it are valid against the original — but nothing inside a
 * literal can be mistaken for code.
 *
 * Template literals keep their `${…}` interpolations as live code, because the
 * identifiers in there are real references.
 */
export function blankLiterals(src) {
  const out = src.split("");
  const blankAt = (k) => { if (k < out.length && out[k] !== "\n") out[k] = " "; };

  // A stack of frames. "code" frames count braces; "tmpl" frames are inside a
  // template literal's text. `${` pushes a code frame and `}` at depth 0 pops
  // back — and BOTH delimiters get blanked, so a template's braces never reach
  // the brace counting that endOfBlock relies on. Getting that interaction
  // wrong is what makes a scanner silently run a function body to end-of-file.
  const stack = [{ type: "code", depth: 0 }];
  let prev = "";
  let i = 0;

  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];

    if (top.type === "tmpl") {
      if (c === "\\") { blankAt(i); blankAt(i + 1); i += 2; continue; }
      if (c === "`") { blankAt(i); stack.pop(); prev = "`"; i++; continue; }
      if (c === "$" && src[i + 1] === "{") {
        blankAt(i); blankAt(i + 1);
        stack.push({ type: "code", depth: 0 });
        prev = "(";           // an interpolation opens in expression position
        i += 2;
        continue;
      }
      blankAt(i);
      i++;
      continue;
    }

    const two = src.slice(i, i + 2);

    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      for (let k = i; k < stop; k++) blankAt(k);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let k = i; k < stop; k++) blankAt(k);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      for (; k < src.length; k++) {
        if (src[k] === "\\") { k++; continue; }
        if (src[k] === c || src[k] === "\n") break;
      }
      for (let j = i; j <= k && j < src.length; j++) blankAt(j);
      prev = c;
      i = k + 1;
      continue;
    }
    if (c === "`") {
      blankAt(i);
      stack.push({ type: "tmpl" });
      i++;
      continue;
    }
    if (c === "/" && regexStartsAt(src, i, prev)) {
      let k = i + 1;
      let inClass = false;
      let terminated = false;
      for (; k < src.length; k++) {
        if (src[k] === "\\") { k++; continue; }
        if (src[k] === "\n") break;              // unterminated — not a regex
        if (src[k] === "[") inClass = true;
        else if (src[k] === "]") inClass = false;
        else if (src[k] === "/" && !inClass) { terminated = true; break; }
      }
      if (terminated) {
        let end = k + 1;
        while (end < src.length && isIdentChar(src[end])) end++;  // flags
        for (let j = i; j < end; j++) blankAt(j);
        prev = "/";
        i = end;
        continue;
      }
      // Not a regex after all — fall through and treat as a plain character.
    }
    if (c === "{") {
      top.depth++;
    } else if (c === "}") {
      if (top.depth === 0 && stack.length > 1) {
        // Closing a `${…}`: blank it and resume the template's text.
        blankAt(i);
        stack.pop();
        prev = "`";
        i++;
        continue;
      }
      top.depth--;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/**
 * Every top-level declaration in `src`, in source order.
 * Returns [{ name, kind, start, end, line }] where `end` is exclusive.
 *
 * "Top level" means column 0 — this codebase writes every top-level
 * declaration flush left and indents everything else, which is a far more
 * reliable signal here than trying to track scope without a parser.
 */
export function topLevelDecls(src) {
  const blanked = blankLiterals(src);
  const decls = [];
  const re = /^(?:(export)\s+)?(async\s+function|function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m;
  while ((m = re.exec(blanked))) {
    const kind = m[2].startsWith("async") || m[2] === "function" ? "function"
      : m[2] === "class" ? "class"
      : m[2];
    const start = m.index + (m[1] ? m[1].length + 1 : 0);
    const end = kind === "function" || kind === "class"
      ? endOfBlock(blanked, start)
      : endOfStatement(blanked, m.index + m[0].length);
    decls.push({
      name: m[3],
      kind,
      exported: Boolean(m[1]),
      start,
      end,
      line: src.slice(0, m.index).split("\n").length,
      text: src.slice(start, end)
    });
  }
  return decls;
}

// End of a `function f() { … }` / `class C { … }`, from the first `{` after
// `start`. Operates on already-blanked source, so braces are all real.
function endOfBlock(blanked, start) {
  let i = blanked.indexOf("{", start);
  if (i === -1) return blanked.length;
  let depth = 0;
  for (; i < blanked.length; i++) {
    if (blanked[i] === "{") depth++;
    else if (blanked[i] === "}") { depth--; if (!depth) return i + 1; }
  }
  return blanked.length;
}

// End of a `const x = …;` from just after the name: the semicolon that closes
// it at bracket depth 0.
//
// Deliberately NOT falling back to "end of line" for an unterminated statement.
// Blanked template literals keep their newlines (line numbering has to survive),
// so a newline at depth 0 is a routine sight in the middle of a perfectly normal
// multi-line `const X = \`…\`;` — treating it as the end truncated
// DOCX_NUMBERING_XML at its first line. Every top-level declaration in this
// codebase is terminated, so requiring the semicolon is both simpler and right.
function endOfStatement(blanked, from) {
  let depth = 0;
  for (let i = from; i < blanked.length; i++) {
    const c = blanked[i];
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === ";" && depth === 0) return i + 1;
  }
  return blanked.length;
}

/**
 * Identifiers referenced as values in `src`: excludes property accesses
 * (`a.foo`), object-literal keys (`{ foo: 1 }`), shorthand-safe cases, and
 * anything after `import`/`export` bookkeeping. Returns a Set.
 *
 * Deliberately over-inclusive on the safe side — a name reported that turns out
 * to be a local is a false positive the caller filters; a name MISSED would be
 * a missing import that ships.
 */
export function referencedIdentifiers(src) {
  const blanked = blankLiterals(src);
  const found = new Set();
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m;
  while ((m = re.exec(blanked))) {
    const name = m[0];
    const before = blanked.slice(Math.max(0, m.index - 40), m.index);
    // Property access: `.foo`, `?.foo`
    if (/[.?]\s*$/.test(before) && !/\.\.\.\s*$/.test(before)) continue;
    // Object-literal key or label: `foo:` but not `? foo :` and not `case foo:`
    const after = blanked.slice(m.index + name.length, m.index + name.length + 3);
    if (/^\s*:/.test(after) && /[{,]\s*$/.test(before)) continue;
    found.add(name);
  }
  return found;
}

// ── port-sync.mjs originals, unchanged ─────────────────────────────────────
// These are the exact functions port-sync has always used. Kept byte-for-byte
// so moving it onto this module cannot change what it reports.

// Brace-match a function body, stepping over comments, strings, template
// literals and regex literals.
export function extract(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return null;
  const start = m.index;
  let i = src.indexOf("{", start);
  let depth = 0;
  let prev = "";
  for (; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === "//") { i = src.indexOf("\n", i); if (i === -1) return null; continue; }
    if (two === "/*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === c) break;
      }
      prev = c;
      continue;
    }
    if (c === "/" && /[(,=:[!&|?+\-*%~^{};\n]/.test(prev || "\n")) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
      }
      prev = "/";
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) return src.slice(start, i + 1); }
    if (!/\s/.test(c)) prev = c;
  }
  return null;
}

// `const NAME = <expr>;` — scan to the semicolon that closes it at depth 0.
export function extractConst(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*=`).exec(src);
  if (!m) return null;
  const start = m.index;
  let depth = 0;
  let prev = "=";
  for (let i = src.indexOf("=", start) + 1; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === "//") { i = src.indexOf("\n", i); if (i === -1) return null; continue; }
    if (two === "/*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === c) break;
      }
      prev = c;
      continue;
    }
    if (c === "/" && /[(,=:[!&|?+\-*%~^{};\n]/.test(prev || "\n")) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
      }
      prev = "/";
      continue;
    }
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === ";" && depth === 0) return src.slice(start, i + 1);
    if (!/\s/.test(c)) prev = c;
  }
  return null;
}

// Comments are each file's own to write; only the code has to match.
export function normalize(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
