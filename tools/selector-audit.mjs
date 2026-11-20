// Does every control a browser check presses still exist?
//
//   node tools/selector-audit.mjs
//
// tools/handwriting-check.mjs pressed `#documentInkRail [data-hw-action="add-page"]`
// for five days after f179cd2 moved adding a Canvas page to ＋□, ⋯ and the
// ＋ Page pill. The press found nothing, the evaluate threw, and the check died
// with "no result line" — taking four thousand lines of cases after it along,
// none of which had run since. A browser check is the slowest and the last
// thing to tell you a control has moved, and when it tells you, it can do so by
// not telling you anything at all.
//
// This tells you in a second, with no browser. It reads every
// tools/*-check.mjs for selectors written out in full — `[data-x="value"]`,
// `getElementById("id")`, `querySelector("#id …")` — and requires each value
// to appear somewhere in index.html or src/. A selector built at run time
// (`'[data-pdf-block="' + id + '"]'`) is skipped: its value is data, not a
// control. One that is SUPPOSED to be missing — a check asserting a control is
// gone, or an id the check made itself — goes in ALLOWED with its reason.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// [check file, selector as reported, why it is not in the app]
const ALLOWED = [
  ["browser-check.mjs", "#browserCheckProbe", "made by the check itself, to probe the page"],
  ["export-render-check.mjs", "#exportShotStyle", "a <style> the check adds for its screenshots"],
  ["extensions-browser-check.mjs", "#cookieBanner", "the extension's fixture web page, not the app"],
  ["extensions-browser-check.mjs", "#p1", "the extension's fixture web page"],
  ["extensions-browser-check.mjs", "#section-2", "the extension's fixture web page"],
  ["extensions-browser-check.mjs", "#section-3", "the extension's fixture web page"],
  ["extensions-browser-check.mjs", "#section-12", "the extension's fixture web page"],
  ["extensions-browser-check.mjs", "#hostile-dialog", "the extension's fixture web page"],
  ["extensions-browser-check.mjs", "#hostile-cover", "the extension's fixture web page"],
  ["extensions-browser-check.mjs", "#vid", "the extension's fixture web page"],
  ["extensions-browser-check.mjs", "#thirds", "the extension's fixture web page"],
  ["extensions-browser-check.mjs", "#moving", "the extension's fixture web page"],
  ["extensions-browser-check.mjs", "#closing", "the extension's fixture web page"],
  ["canvas-blocks-check.mjs", '[data-hw-action="add-text"]', "asserts the old Text row is gone"],
  ["canvas-blocks-check.mjs", '[data-pdf-block="turnme"]', "a Block id the check writes"],
  ["canvas-blocks-check.mjs", '[data-pdf-block="tallme"]', "a Block id the check writes"],
  ["canvas-blocks-check.mjs", '[data-pdf-block="shot-carry"]', "a Block id the check writes"],
  ["handwriting-check.mjs", "#focusTabs", "asserts the old focus-mode tab strip is gone"],
  ["handwriting-check.mjs", '[data-ink-recent="#ff8800"]', "a colour the check picks, so it is in the recent row"],
  ["pdf-preview-check.mjs", '[data-rail-action="bookmark-set"]', "asserts the old rail row is gone"],
  ["pdf-preview-check.mjs", "#statusBar", "read with ?. — absent when there is no status line to show"],
  ["pdf-preview-check.mjs", "#attachPdfBtn", "asserts the old drawer row is gone"],
  ["release-check.mjs", "#setupScreen", "read with ?. across releases that had it"],
  ["selection-check.mjs", "#selectionFormatToggleBtn", "asserts the old disclosure is gone"]
];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const app = [
  readFileSync(path.join(ROOT, "index.html"), "utf8"),
  ...walk(path.join(ROOT, "styles")).filter((file) => file.endsWith(".css")).map((file) => readFileSync(file, "utf8")),
  ...walk(path.join(ROOT, "src")).filter((file) => file.endsWith(".js")).map((file) => readFileSync(file, "utf8"))
].join("\n");

// The attribute WITH its value — not the value alone, which is how the stale
// `[data-hw-action="add-page"]` passed a first version of this: "add-page"
// is still in the app, as the drawing sheet's `data-ink-action`. Written out
// whole in markup or a selector, or as the value near the attribute's name
// (`dataset.hwAction = "x"`, `{ hwAction: "x" }`, a helper called with
// ("hwAction", "x")), within a line or two.
const NEAR = 160;
function attributeInApp(name, value) {
  if (app.includes(`data-${name}="${value}"`) || app.includes(`data-${name}='${value}'`)) return true;
  const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (const quoted of [`"${value}"`, `'${value}'`, `\`${value}\``]) {
    let at = app.indexOf(quoted);
    while (at !== -1) {
      const around = app.slice(Math.max(0, at - NEAR), at + quoted.length + NEAR);
      if (around.includes(camel) || around.includes(`data-${name}`)) return true;
      at = app.indexOf(quoted, at + 1);
    }
  }
  // Not written beside its attribute. That still passes when the attribute's
  // values are DATA the app fills in from a list or a variable (a page
  // number, a colour, a style picked from an array) — but not when the app
  // spells that attribute's values out one by one and this is not one of
  // them, which is the shape of a control that was taken away.
  if (/^[\d.]+$/.test(value) || value.startsWith("#")) return app.includes(`data-${name}`) || app.includes(camel);
  const spelledOut = new RegExp(`data-${name}="[^"$]+"`).test(app);
  const filledIn = app.includes(`data-${name}="\${`) || app.includes(`dataset.${camel} =`)
    || app.includes(`setAttribute("data-${name}"`) || new RegExp(`["']${camel}["']\\s*,`).test(app);
  if (spelledOut && !filledIn) return false;
  return app.includes(value) && (app.includes(`data-${name}`) || app.includes(camel));
}
function idInApp(id) {
  return app.includes(`"${id}"`) || app.includes(`'${id}'`) || app.includes(`#${id}`) || app.includes(`\`${id}\``);
}

const allowed = new Set(ALLOWED.map(([file, selector]) => `${file} ${selector}`));
const used = new Set();
const missing = [];
let seen = 0;

const checks = readdirSync(path.join(ROOT, "tools")).filter((file) => /-check\.mjs$/.test(file)).sort();
for (const file of checks) {
  const text = readFileSync(path.join(ROOT, "tools", file), "utf8");
  const found = new Map();
  // [data-x="value"] written out in full — not one built by concatenation,
  // whose quote is followed by ' + or ${.
  for (const m of text.matchAll(/\[data-([a-z][a-z-]*)=\\?"([^"\\'$+]+)\\?"\]/g)) {
    found.set(`[data-${m[1]}="${m[2]}"]`, () => attributeInApp(m[1], m[2]));
  }
  for (const m of text.matchAll(/getElementById\(\\?["'`]([A-Za-z][\w-]*)\\?["'`]\)/g)) found.set(`#${m[1]}`, () => idInApp(m[1]));
  for (const m of text.matchAll(/querySelector(?:All)?\(\\?["'`]#([A-Za-z][\w-]*)/g)) found.set(`#${m[1]}`, () => idInApp(m[1]));
  for (const [selector, present] of found) {
    seen += 1;
    const key = `${file} ${selector}`;
    if (allowed.has(key)) { used.add(key); continue; }
    if (!present()) missing.push(`${file}: ${selector}`);
  }
}

let ran = 0;
let failed = 0;
function check(label, ok, detail = "") {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
}

check(`${seen} selectors across ${checks.length} checks were read`, seen > 300 && checks.length > 40, `${seen} selectors, ${checks.length} checks — the scan has stopped seeing them`);
check("every control a check presses or reads is still in the app", missing.length === 0,
  `${missing.length} not found — a control moved, or the check asserts it is gone (then add it to ALLOWED with why):\n        ${missing.join("\n        ")}`);
const stale = ALLOWED.filter(([file, selector]) => !used.has(`${file} ${selector}`)).map(([file, selector]) => `${file}: ${selector}`);
check("no ALLOWED entry outlives the selector it excuses", stale.length === 0, stale.join("\n        "));

console.log(`\n  ${ran} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
