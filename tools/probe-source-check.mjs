// Does the code these checks send INTO the page still say what it was written
// to say?
//
//   node tools/probe-source-check.mjs
//
// Half the browser checks in this directory hand the page a probe: a large
// chunk of JavaScript, written as a template literal here and eval'd there.
// That is a sound arrangement — it keeps the probe readable, and lets the same
// source run against two builds byte for byte — but it means every line of the
// probe passes through the template literal's own escape rules on the way, and
// those rules are lossy:
//
//     \n   inside `...`  becomes a REAL newline
//     \b   inside `...`  becomes U+0008, a backspace
//     \s   inside `...`  becomes a bare `s` — the backslash is simply dropped
//
// All three are silent. None of them is a syntax error in THIS file. And all
// three have been shipped in tools/highlight-check.mjs:
//
//   • six cases wrote "first line\nsecond line", which put a real newline
//     inside a string literal in the probe SOURCE. That is a SyntaxError, but
//     one raised by the page's own eval — so the whole 57KB probe failed to
//     parse and every one of its seventy-one cases was lost, reported as
//     "SyntaxError: Invalid or unexpected token" with no line and no name
//   • one case matched /<mark\b[^>]*>/, which became /<mark<BS>[^>]*>/ and
//     matched nothing, so a text with a mark in it was reported as having none
//   • one matched /-{3,}\s*$/, which became /-{3,}s*$/ and would only ever have
//     fired on a rule followed by the letter s
//
// The first killed the check outright; the other two are worse, because they
// FAIL rather than error and look exactly like a bug in the app.
//
// So this reads every probe template in tools/ and refuses a single backslash
// where the author meant two. Static, no browser, milliseconds.
//
// Two things it deliberately allows:
//
//   String.raw`…`  is exempt by construction — that is what it is for, and
//                  several checks already use it (ui-smoke's SNAPSHOT/FAKE)
//   ${…}           interpolations are ordinary JavaScript, evaluated HERE, so
//                  a `\n` inside one is correct and is skipped

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "tools");

// Escapes a template literal transforms. \\ is fine (it is the way to write
// one), and so is anything already doubled.
//
//   \n \r \t \f \v \0 \b   — recognised escapes, replaced with a control char
//   \d \s \w \D \S \W \A \Z \p \k — not recognised, so the backslash is DROPPED,
//                                   which quietly rewrites a regex
//   \u \x                  — recognised, and a malformed one is a syntax error
const EATEN = /(?<!\\)\\([nrtfv0bdswDSWAZpk])/g;

// `\uXXXX` and `\xNN` are usually deliberate — a probe comparing against a
// middot writes "·" and means it. Flagging those would be noise, so they
// are allowed when well-formed and reported when not.
const UNICODE_OK = /(?<!\\)\\u\{?[0-9a-fA-F]{1,6}\}?|(?<!\\)\\x[0-9a-fA-F]{2}/g;

// Find every non-raw template literal in a file, with its start offset, by
// scanning rather than by regex — a template can contain backticks inside its
// own ${…} and a regex cannot see that.
function templates(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i === -1) break; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i); if (i === -1) break; i += 1; continue; }
    if (c === '"' || c === "'") {
      for (i += 1; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c !== "`") continue;
    const raw = /String\.raw\s*$/.test(src.slice(Math.max(0, i - 12), i));
    const from = i + 1;
    let depth = 0;
    let j = from;
    for (; j < src.length; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === "$" && src[j + 1] === "{") { depth++; j++; continue; }
      if (src[j] === "}" && depth) { depth--; continue; }
      if (src[j] === "`" && !depth) break;
    }
    // The name it is bound to, if any: `const NAME = \``.
    const bound = src.slice(Math.max(0, i - 80), i).match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:String\.raw\s*)?$/);
    if (!raw) out.push({ from, to: j, body: src.slice(from, j), name: bound?.[1] || null });
    i = j;
  }
  return out;
}

// Blank out ${…} spans: those are evaluated here, not there.
function withoutInterpolations(body) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") { out += depth ? "  " : body.slice(i, i + 2); i++; continue; }
    if (body[i] === "$" && body[i + 1] === "{") { depth++; out += "  "; i++; continue; }
    if (body[i] === "}" && depth) { depth--; out += " "; continue; }
    out += depth ? (body[i] === "\n" ? "\n" : " ") : body[i];
  }
  return out;
}

// Which templates are probes? Not a guess about their contents — a template
// that builds a regex or a chunk of sw.js is ordinary code and its escapes mean
// what they say. A probe is a template BOUND TO A NAME that the same file then
// hands to the page. So: find `const NAME = \`…\`` and keep it only if NAME
// appears inside a page.evaluate / evaluateOnNewDocument / waitForFunction call
// somewhere in the file.
function probeNames(src) {
  const names = new Set();
  // Scan to the MATCHING close paren, counting depth. A regex cannot do this:
  // the first argument is routinely an arrow function whose body contains
  // dozens of parens and semicolons, so a non-greedy `\\)` stops inside the
  // callback and never reaches the probe named after it. That is exactly what
  // the first draft of this file did, which is why its own negative control
  // caught nothing.
  const call = /\.(?:evaluate|evaluateOnNewDocument|waitForFunction|waitFor)\s*\(/g;
  let m;
  while ((m = call.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let quote = null;
    for (; i < src.length && depth; i++) {
      const c = src[i];
      if (quote) {
        if (c === "\\") { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
    }
    for (const ident of src.slice(m.index, i).match(/\b[A-Z][A-Z_0-9]{2,}\b/g) || []) names.add(ident);
  }
  return names;
}


const findings = [];
let scanned = 0;
let templatesScanned = 0;

for (const file of readdirSync(DIR).filter((n) => n.endsWith(".mjs")).sort()) {
  const src = readFileSync(path.join(DIR, file), "utf8");
  scanned += 1;
  const probes = probeNames(src);
  for (const tpl of templates(src)) {
    if (!tpl.name || !probes.has(tpl.name)) continue;
    templatesScanned += 1;
    const cleaned = withoutInterpolations(tpl.body);
    const startLine = src.slice(0, tpl.from).split("\n").length;
    cleaned.split("\n").forEach((line, n) => {
      // A comment inside the probe is prose. The template still eats its
      // backslashes, but a backspace in a comment changes nothing — and the
      // comments that EXPLAIN this rule necessarily spell the escapes out.
      if (/^\s*(\/\/|\*)/.test(line)) return;
      // A well-formed \uXXXX or \xNN is a deliberate character and is allowed.
      const withoutUnicode = line.replace(UNICODE_OK, "  ");
      const bad = [...new Set((withoutUnicode.match(EATEN) || []))];
      if (!bad.length) return;
      findings.push({
        file,
        line: startLine + n,
        escapes: bad.join(" "),
        text: line.trim().slice(0, 120)
      });
    });
  }
}

for (const f of findings) {
  console.log(`  FAIL  ${f.file}:${f.line}  ${f.escapes}`);
  console.log(`        ${f.text}`);
  console.log(`        (inside a page probe: the template literal eats these — write them doubled)`);
}
if (!findings.length) {
  console.log(`probe sources: ${templatesScanned} page probe(s) across ${scanned} tool(s), no eaten escapes`);
}
console.log(`CHECK: ${templatesScanned} checks · ${findings.length} failed`);
process.exit(findings.length ? 1 : 0);
