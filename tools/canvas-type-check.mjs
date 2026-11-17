// The Canvas's type, in pure Node: ◐ Canvas → Blocks / Headings / Code /
// Labels (src/ui/style-schema.js), a Block's own type (src/documents/
// block-style.js), and a diagram told its page's colours (src/render/
// diagrams.js).
//
//   node tools/canvas-type-check.mjs
//
// "When changing fonts it only applies to normal texts inside the blocks, but I
// need comprehensive control." The browser half — does each face reach the
// heading, the code, the table and the page number it names, and nothing in
// the Notes — is tools/canvas-blocks-check.mjs's. What is asked here is
// whether the tables agree with each other and with the stylesheets: a control
// that writes a variable no rule reads is a control that does nothing, and a
// Block's style written with all its defaults is bytes on every sync for ever.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-canvas-type-"));

function destamp(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) destamp(full);
    else if (entry.endsWith(".js")) {
      const text = readFileSync(full, "utf8");
      const clean = text.replaceAll("?v=__BUILD__", "");
      if (clean !== text) writeFileSync(full, clean);
    }
  }
}

const results = [];
let failures = 0;
function must(name, fn) {
  let detail;
  try {
    detail = fn();
  } catch (error) {
    detail = `threw: ${error?.message || error}`;
  }
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

const styles = readdirSync(path.join(ROOT, "styles"))
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(path.join(ROOT, "styles", name), "utf8"))
  .join("\n");
const reads = (property) => new RegExp(`var\\(\\s*${property.replace(/[-]/g, "\\-")}\\s*[,)]`).test(styles);

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));
  // diagrams.js reads the theme's colours through src/ui/theme.js, which
  // reaches the whole card view; for a diagram ON A PAGE it never asks, so a
  // stand-in that answers the fallback is all this needs.
  writeFileSync(path.join(stage, "src/ui/theme.js"), "export function cssVariableColor(name, fallback) { return fallback; }\n");
  const schema = await import(path.join(stage, "src/ui/style-schema.js"));
  const catalog = await import(path.join(stage, "src/ui/theme-catalog.js"));
  const B = await import(path.join(stage, "src/documents/block-style.js"));
  const D = await import(path.join(stage, "src/render/diagrams.js"));

  const canvasFields = schema.styleControlGroups
    .filter((group) => group.scope === "handwriting")
    .flatMap((group) => group.fields);
  const canvasKeys = canvasFields.map((field) => field.key);

  // ── ◐ Canvas ───────────────────────────────────────────────────────────
  must("◐ Canvas has Blocks, Headings, Code and Labels", () => {
    const titles = schema.styleControlGroups.filter((group) => group.scope === "handwriting").map((group) => group.title);
    const want = ["Blocks", "Headings", "Code", "Labels"];
    return want.every((title) => titles.includes(title)) || `groups: ${titles.join(", ")}`;
  });

  must("...a face for the words, the headings, the code and the labels, each offering every font", () => {
    const faces = ["canvasBlockFontFamily", "canvasHeadingFontFamily", "canvasCodeFontFamily", "canvasLabelFontFamily"];
    const bad = [];
    faces.forEach((key) => {
      const field = schema.styleFieldByKey[key];
      if (!field) { bad.push(`${key}: missing`); return; }
      if (field.type !== "select") bad.push(`${key}: not a select`);
      if (!field.options.includes("inherit")) bad.push(`${key}: no "inherit"`);
      const missing = catalog.fontFamilyOptions.filter((font) => !field.options.includes(font));
      if (missing.length) bad.push(`${key}: lacks ${missing.slice(0, 3).join(", ")}`);
      if (schema.styleDefaults[key] !== "inherit") bad.push(`${key}: defaults to ${schema.styleDefaults[key]}`);
      if (!field.optionLabels?.inherit) bad.push(`${key}: "inherit" has no words`);
    });
    return bad.length ? bad.join("; ") : true;
  });

  must("...and every one of them starts by changing nothing (inherit / auto / the ladder / the paper)", () => {
    const changed = canvasKeys.filter((key) => {
      const value = String(schema.defaultStyleProfiles.desktop[key]);
      if (["inherit", "auto", "ladder", "paper"].includes(value)) return false;
      // The three sizes that were there before this, at their own old values.
      return !["canvasBlockFontSize", "canvasBlockLineHeight", "canvasCodeFontSize"].includes(key);
    });
    return changed.length ? `not a follow state: ${changed.join(", ")}` : true;
  });

  must("...on both profiles alike", () => {
    const differ = canvasKeys.filter((key) => schema.defaultStyleProfiles.desktop[key] !== schema.defaultStyleProfiles.mobile[key]);
    return differ.length ? differ.join(", ") : true;
  });

  must("every variable a Canvas setting writes is read by a stylesheet", () => {
    const written = [
      ...canvasKeys.map((key) => schema.styleCssVariables[key]).filter(Boolean),
      "--canvas-block-font", "--canvas-heading-font", "--canvas-code-font", "--canvas-label-font"
    ];
    const unread = written.filter((property) => !reads(property));
    return unread.length ? `nobody reads ${unread.join(", ")}` : true;
  });

  must("...and every page-wide name they are mapped onto is read where the words are drawn", () => {
    const names = ["--doc-block-font", "--doc-block-weight", "--doc-block-letter-spacing", "--doc-table-scale",
      "--doc-head-font", "--doc-head-weight", "--doc-code-font", "--doc-code-line-height", "--doc-label-font"];
    const unread = names.filter((property) => !reads(property));
    return unread.length ? `nobody reads ${unread.join(", ")}` : true;
  });

  must("...and the two that are attributes, not values, have rules for each of their choices", () => {
    const bad = [];
    ["accent", "text"].forEach((value) => { if (!styles.includes(`data-canvas-heading-ink="${value}"`)) bad.push(`heading colour ${value}`); });
    ["dark", "light"].forEach((value) => { if (!styles.includes(`data-canvas-code-look="${value}"`)) bad.push(`code look ${value}`); });
    return bad.length ? `no rule for ${bad.join(", ")}` : true;
  });

  // ── A Block's own type ─────────────────────────────────────────────────
  must("a Block with nothing set stores nothing", () => {
    const compact = B.compactBlockStyle({});
    if (Object.keys(compact).length) return `{} compacts to ${JSON.stringify(compact)}`;
    return Object.keys(B.compactBlockStyle(B.BLOCK_STYLE_DEFAULT)).length === 0 || "the defaults do not compact away";
  });

  must("...and a Block given a face, a heading colour and a weight stores only those", () => {
    const compact = B.compactBlockStyle({ headFont: "Lora", headInk: "red", weight: 600, fill: "paper" });
    const keys = Object.keys(compact).sort().join(",");
    return keys === "headFont,headInk,weight" || keys;
  });

  must("...and reads back as the whole of it, every other field its default", () => {
    const it = B.normalizeBlockStyle(B.compactBlockStyle({ codeFont: "JetBrains Mono", lineHeight: 1.6, letterSpacing: -0.5 }));
    return (it.codeFont === "JetBrains Mono" && it.lineHeight === 1.6 && it.letterSpacing === -0.5
      && it.fill === "paper" && it.fit === true && it.headFont === "inherit") || JSON.stringify(it);
  });

  must("the new numbers take what can be drawn and refuse what cannot", () => {
    const bad = [];
    const cases = [
      ["normalizeBlockWeight", [[600, 600], ["700", 700], [0, null], [-1, null], [1001, null], ["abc", null], ["", null], [450.6, 451]]],
      ["normalizeBlockLineHeight", [[1.5, 1.5], ["2", 2], [0, null], [-1, null], ["abc", null], ["", null], [1.234, 1.23]]],
      ["normalizeBlockLetterSpacing", [[1, 1], [-0.5, -0.5], [0, null], ["abc", null], ["", null], [0.04, null], [2.26, 2.3]]]
    ];
    cases.forEach(([fn, pairs]) => pairs.forEach(([input, want]) => {
      const got = B[fn](input);
      if (got !== want) bad.push(`${fn}(${JSON.stringify(input)}) = ${got}, not ${want}`);
    }));
    return bad.length ? bad.join("; ") : true;
  });

  must("a heading colour is a pen token or the default, and an unknown one is the default", () => {
    if (B.normalizeBlockHeadInk("red") !== "red") return "red refused";
    if (B.normalizeBlockHeadInk("#ff0000") !== "default") return "a hex was kept";
    if (B.blockHeadInkVar("default") !== null) return "the default names a property";
    return /^--ink-pen-/.test(B.blockHeadInkVar("blue")) || `blue is ${B.blockHeadInkVar("blue")}`;
  });

  must("an unknown face is the default, as the Block's own Face is", () => {
    const it = B.normalizeBlockStyle({ headFont: "Comic Sans of the Future", codeFont: "Fira Code" });
    return (it.headFont === "inherit" && it.codeFont === "Fira Code") || JSON.stringify(it);
  });

  // ── A diagram on a page ────────────────────────────────────────────────
  const palette = { bg: "#ffffff", card: "#ffffff", panel: "#ffffff", panel2: "#f2f2f2", text: "#16181d", muted: "#6f7074", line: "#d4d5d6", accent: "#0b706a", dark: false };

  must("a mermaid diagram on a page is told the page's colours and the Block's face", () => {
    const out = D.sourceWithMermaidPalette("graph TD\nA-->B", palette, "Georgia, serif");
    const head = /^%%\{init: (.*)\}%%\n/.exec(out);
    if (!head) return `no directive: ${out.slice(0, 80)}`;
    const config = JSON.parse(head[1]);
    if (config.themeVariables.primaryTextColor !== "#16181d" || config.themeVariables.primaryBorderColor !== "#0b706a") return JSON.stringify(config);
    if (config.themeVariables.fontFamily !== "Georgia, serif") return "the face was not passed";
    return out.endsWith("graph TD\nA-->B") || "the diagram's own source changed";
  });

  must("...but a diagram that configures itself keeps its own configuration", () => {
    const own = "%%{init: {\"theme\": \"forest\"}}%%\ngraph TD\nA-->B";
    if (D.sourceWithMermaidPalette(own, palette) !== own) return "an init directive was overridden";
    const front = "---\nconfig:\n  theme: forest\n---\ngraph TD\nA-->B";
    return D.sourceWithMermaidPalette(front, palette) === front || "a front-matter config was overridden";
  });

  must("...front matter without a config keeps its place at the top", () => {
    const front = "---\ntitle: Steps\n---\ngraph TD\nA-->B";
    const out = D.sourceWithMermaidPalette(front, palette);
    return (out.startsWith("---\ntitle: Steps\n---\n%%{init:") && out.endsWith("graph TD\nA-->B")) || out;
  });

  must("...and one off a page is left exactly as written", () => {
    return D.sourceWithMermaidPalette("graph TD\nA-->B", null) === "graph TD\nA-->B" || "changed with no palette";
  });

  must("a nomnoml diagram on a page takes the page's colours and keeps Arial", () => {
    const theme = D.nomnomlThemeDefaults(false, palette);
    return (theme.stroke === "#16181d" && theme.background === "#ffffff" && theme.font === "Arial") || JSON.stringify(theme);
  });

  console.log("── canvas type ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
