// Do the ten themes and the fifty-one style settings still line up?
//
//   node tools/theme-check.mjs
//
// Two tables decide what the app looks like, and nothing had ever compared
// them to each other:
//
//   src/ui/theme-catalog.js   ten themes, each a palette plus a mode
//   src/ui/style-schema.js    fifty-one settings, their defaults, the CSS
//                             variable each one writes, and the groups the
//                             Style panel lays them out in
//
// tools/style-check.mjs drives the panel in a browser and asks whether a
// setting reaches the element it names — a good question, and one it could only
// ever ask of the settings somebody thought to list. It also skipped itself on
// every machine but one until recently. What neither it nor anything else asked
// is whether the tables are CONSISTENT: whether every setting has a default,
// whether every default is in range, whether every theme defines every colour
// the others do, whether the panel's groups between them mention every setting
// that exists.
//
// Those are facts about two objects, so this is pure Node and cannot skip. The
// half that needs a browser — does a theme's palette actually reach the page,
// and does isDarkThemeActive agree with the rendered background — is
// style-check's, and named at the end rather than left as a silence.
//
// The bug this shape guards against is ce9f73a: the ink SVG resolved
// prefers-color-scheme against the OS rather than against the app's theme, so
// every drawing rendered black on a dark theme. A theme that is one key short
// of its siblings is the same class of fault one step earlier.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-theme-"));

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

const list = (values, n = 6) => {
  const all = [...values];
  return all.slice(0, n).join(", ") + (all.length > n ? `, …and ${all.length - n} more` : "");
};

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));
  const load = (rel) => import(path.join(stage, rel));

  const schema = await load("src/ui/style-schema.js");
  const catalog = await load("src/ui/theme-catalog.js");

  const themes = catalog.themeCatalog;
  const themeIds = themes.map((t) => t.id);

  // ── The themes agree with each other ────────────────────────────────────
  must("every theme has an id, a label, a mode and a palette", () => {
    const bad = [];
    themes.forEach((theme, i) => {
      if (!theme.id) bad.push(`theme ${i}: no id`);
      if (!theme.label) bad.push(`${theme.id || i}: no label`);
      if (theme.mode !== "dark" && theme.mode !== "light") bad.push(`${theme.id}: mode is ${JSON.stringify(theme.mode)}`);
      if (!theme.colors || typeof theme.colors !== "object") bad.push(`${theme.id}: no colours`);
    });
    return bad.length ? list(bad) : true;
  });

  must("no two themes share an id", () => {
    const seen = new Set();
    const dupes = themeIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    return dupes.length ? `duplicated: ${list(dupes)}` : true;
  });

  // The one that catches a theme one key short of its siblings — which is the
  // shape of ce9f73a, where a colour resolved to nothing and every drawing
  // came out black.
  must("every theme defines every colour the others do", () => {
    const union = new Set();
    for (const theme of themes) for (const key of Object.keys(theme.colors || {})) union.add(key);
    const short = [];
    for (const theme of themes) {
      const missing = [...union].filter((key) => !(key in (theme.colors || {})));
      if (missing.length) short.push(`${theme.id} is missing ${missing.join(", ")}`);
    }
    return short.length ? list(short) : true;
  });

  must("every colour is a value CSS will accept", () => {
    // Hex, rgb()/rgba(), hsl()/hsla(), or a bare keyword. A colour that is none
    // of those resolves to nothing and takes whatever it was painting with it.
    const ok = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)$/;
    const bad = [];
    for (const theme of themes) {
      for (const [key, value] of Object.entries(theme.colors || {})) {
        if (typeof value !== "string" || !ok.test(value.trim())) bad.push(`${theme.id}.${key} = ${JSON.stringify(value)}`);
      }
    }
    return bad.length ? list(bad) : true;
  });

  must("both modes are represented", () => {
    const dark = themes.filter((t) => t.mode === "dark").length;
    const light = themes.filter((t) => t.mode === "light").length;
    if (!dark) return "no dark theme";
    if (!light) return "no light theme";
    return true;
  });

  must("every alias resolves to a theme that exists", () => {
    const dangling = Object.entries(catalog.themeAliases || {})
      .filter(([, target]) => !themeIds.includes(target))
      .map(([alias, target]) => `${alias} -> ${target}`);
    return dangling.length ? list(dangling) : true;
  });

  // isDarkThemeActive takes no argument: it reads
  // document.documentElement.dataset.theme. Which is the point of driving it —
  // ce9f73a is the commit where the ink SVG asked prefers-color-scheme instead,
  // so every drawing came out black on a dark theme, and this is the function
  // that exists so nothing has to ask the OS. Two lines of DOM is all it needs.
  const withTheme = (id, fn) => {
    const saved = globalThis.document;
    globalThis.document = { documentElement: { dataset: id == null ? {} : { theme: String(id) } } };
    try { return fn(); } finally {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
    }
  };

  must("isDarkThemeActive agrees with each theme's own mode", () => {
    const wrong = [];
    for (const theme of themes) {
      const got = withTheme(theme.id, () => catalog.isDarkThemeActive());
      const wanted = theme.mode === "dark";
      if (got !== wanted) wrong.push(`${theme.id}: mode ${theme.mode} but isDarkThemeActive says ${got}`);
    }
    return wrong.length ? list(wrong) : true;
  });

  must("...and through an alias too", () => {
    const wrong = [];
    for (const [alias, target] of Object.entries(catalog.themeAliases || {})) {
      const theme = themes.find((t) => t.id === target);
      if (!theme) continue;
      const got = withTheme(alias, () => catalog.isDarkThemeActive());
      if (got !== (theme.mode === "dark")) wrong.push(`${alias} (-> ${target}, ${theme.mode}) said ${got}`);
    }
    return wrong.length ? list(wrong) : true;
  });

  // The app's own fallback is a dark theme (normalizeThemeId lands on
  // dark-amoled), so an unset or unknown attribute has to answer dark — a false
  // here paints a white pen on a dark page, which is ce9f73a exactly.
  must("...and falls back to dark when the attribute says nothing it knows", () => {
    for (const value of ["no-such-theme", "", null]) {
      const got = withTheme(value, () => catalog.isDarkThemeActive());
      if (typeof got !== "boolean") return `${JSON.stringify(value)} produced ${typeof got}`;
      if (got !== true) return `${JSON.stringify(value)} answered ${got}, not the dark default`;
    }
    return true;
  });

  must("...and answers at all when there is no document", () => {
    const saved = globalThis.document;
    try {
      delete globalThis.document;
      const got = catalog.isDarkThemeActive();
      return typeof got === "boolean" ? true : `produced ${typeof got}`;
    } finally {
      if (saved !== undefined) globalThis.document = saved;
    }
  });

  // ── The style settings agree with each other ────────────────────────────
  must("every field in the schema has a default", () => {
    const missing = Object.keys(schema.styleFieldByKey).filter((k) => !(k in schema.styleDefaults));
    return missing.length ? `no default for ${list(missing)}` : true;
  });

  must("...and every default belongs to a field", () => {
    const orphans = Object.keys(schema.styleDefaults).filter((k) => !(k in schema.styleFieldByKey));
    return orphans.length ? `default with no field: ${list(orphans)}` : true;
  });

  must("every numeric default sits inside its own min/max", () => {
    const outside = [];
    for (const [key, field] of Object.entries(schema.styleFieldByKey)) {
      const value = schema.styleDefaults[key];
      if (typeof value !== "number") continue;
      if (typeof field.min === "number" && value < field.min) outside.push(`${key} = ${value} < min ${field.min}`);
      if (typeof field.max === "number" && value > field.max) outside.push(`${key} = ${value} > max ${field.max}`);
    }
    return outside.length ? list(outside) : true;
  });

  must("every choice default is one of the choices offered", () => {
    const outside = [];
    for (const [key, field] of Object.entries(schema.styleFieldByKey)) {
      const options = field.options || field.choices;
      if (!Array.isArray(options) || !options.length) continue;
      const values = options.map((o) => (o && typeof o === "object" ? o.value : o));
      const value = schema.styleDefaults[key];
      if (!values.includes(value)) outside.push(`${key} = ${JSON.stringify(value)}, not one of ${list(values, 4)}`);
    }
    return outside.length ? list(outside) : true;
  });

  // The panel is built from the groups. A setting in no group is a setting
  // nobody can change; a group naming a setting that no longer exists is a
  // control that writes nowhere.
  must("every setting appears in exactly one Style panel group", () => {
    const seen = new Map();
    for (const group of schema.styleControlGroups) {
      for (const field of group.fields || group.items || []) {
        const key = typeof field === "string" ? field : field.key;
        if (!key) continue;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    const unreachable = Object.keys(schema.styleFieldByKey).filter((k) => !seen.has(k));
    const twice = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    const ghosts = [...seen.keys()].filter((k) => !(k in schema.styleFieldByKey));
    const problems = [];
    if (unreachable.length) problems.push(`in no group: ${list(unreachable)}`);
    if (twice.length) problems.push(`in two groups: ${list(twice)}`);
    if (ghosts.length) problems.push(`grouped but not a field: ${list(ghosts)}`);
    return problems.length ? problems.join(" · ") : true;
  });

  must("every CSS variable a setting writes is a real custom property name", () => {
    const bad = Object.entries(schema.styleCssVariables)
      .filter(([, name]) => typeof name !== "string" || !/^--[a-z0-9-]+$/i.test(name))
      .map(([key, name]) => `${key} -> ${JSON.stringify(name)}`);
    return bad.length ? list(bad) : true;
  });

  must("...and no two settings write the same one", () => {
    const seen = new Map();
    for (const [key, name] of Object.entries(schema.styleCssVariables)) {
      if (!seen.has(name)) seen.set(name, []);
      seen.get(name).push(key);
    }
    const shared = [...seen.entries()].filter(([, keys]) => keys.length > 1)
      .map(([name, keys]) => `${name} <- ${keys.join(", ")}`);
    return shared.length ? list(shared) : true;
  });

  must("every setting that writes a CSS variable is a field", () => {
    const ghosts = Object.keys(schema.styleCssVariables).filter((k) => !(k in schema.styleFieldByKey));
    return ghosts.length ? `writes a variable but is not a field: ${list(ghosts)}` : true;
  });

  // ── The profiles and presets ────────────────────────────────────────────
  must("every default profile sets only keys that exist", () => {
    const bad = [];
    for (const [name, profile] of Object.entries(schema.defaultStyleProfiles || {})) {
      for (const key of Object.keys(profile || {})) {
        if (!(key in schema.styleFieldByKey)) bad.push(`${name}.${key}`);
      }
    }
    return bad.length ? `unknown key(s): ${list(bad)}` : true;
  });

  // styleDensityPresets is two levels deep — surface (desktop/mobile), then
  // density (compact/comfortable/large) — so the settings are the third.
  const densityPresets = () => {
    const out = [];
    for (const [surface, byDensity] of Object.entries(schema.styleDensityPresets || {})) {
      for (const [density, preset] of Object.entries(byDensity || {})) {
        out.push([`${surface}.${density}`, preset || {}]);
      }
    }
    return out;
  };

  must("every density preset sets only keys that exist", () => {
    const bad = [];
    for (const [name, preset] of densityPresets()) {
      for (const key of Object.keys(preset)) {
        if (!(key in schema.styleFieldByKey)) bad.push(`${name}.${key}`);
      }
    }
    return bad.length ? `unknown key(s): ${list(bad)}` : true;
  });

  // Every surface offers the same set of densities, and every density sets the
  // same settings — otherwise switching from desktop to mobile leaves whichever
  // setting the other one did not mention at its previous value, which is how a
  // phone ends up with a desktop's line height.
  must("every surface offers the same densities, setting the same things", () => {
    const surfaces = Object.entries(schema.styleDensityPresets || {});
    if (surfaces.length < 2) return true;
    const [firstName, first] = surfaces[0];
    const densities = Object.keys(first).sort().join(",");
    const keysFor = (preset) => Object.keys(preset || {}).sort().join(",");
    const shape = keysFor(first[Object.keys(first)[0]]);
    const wrong = [];
    for (const [name, byDensity] of surfaces) {
      const got = Object.keys(byDensity).sort().join(",");
      if (got !== densities) wrong.push(`${name} offers ${got}, ${firstName} offers ${densities}`);
      for (const [density, preset] of Object.entries(byDensity)) {
        if (keysFor(preset) !== shape) wrong.push(`${name}.${density} sets a different set of settings`);
      }
    }
    return wrong.length ? list(wrong) : true;
  });

  // The values are CSS lengths ("16px") and unitless ratios ("1.58"), so this
  // asserts they PARSE and carry the unit their field declares — a "16" where
  // "16px" was meant resolves to nothing and the setting silently does not apply.
  must("every value a preset sets parses, with the unit its field declares", () => {
    const bad = [];
    for (const [name, preset] of densityPresets()) {
      for (const [key, value] of Object.entries(preset)) {
        const field = schema.styleFieldByKey[key];
        if (!field) continue;                       // reported by the case above
        const text = String(value).trim();
        if (!text) { bad.push(`${name}.${key} is empty`); continue; }
        if (field.unit) {
          if (!text.endsWith(field.unit)) { bad.push(`${name}.${key} = ${text}, no ${field.unit}`); continue; }
          if (!Number.isFinite(Number(text.slice(0, -field.unit.length)))) bad.push(`${name}.${key} = ${text} does not parse`);
        } else if (!Number.isFinite(Number(text))) {
          bad.push(`${name}.${key} = ${text} is neither a number nor a unit value`);
        }
      }
    }
    return bad.length ? list(bad) : true;
  });

  // ── The fonts the panel offers ──────────────────────────────────────────
  must("every font option belongs to exactly one group", () => {
    const grouped = new Map();
    for (const group of catalog.fontFamilyOptionGroups || []) {
      for (const option of group.options || []) {
        const value = option && typeof option === "object" ? option.value : option;
        grouped.set(value, (grouped.get(value) || 0) + 1);
      }
    }
    const all = (catalog.fontFamilyOptions || []).map((o) => (o && typeof o === "object" ? o.value : o));
    const ungrouped = all.filter((v) => !grouped.has(v));
    const twice = [...grouped.entries()].filter(([, n]) => n > 1).map(([v]) => v);
    const problems = [];
    if (ungrouped.length) problems.push(`in no group: ${list(ungrouped)}`);
    if (twice.length) problems.push(`in two groups: ${list(twice)}`);
    return problems.length ? problems.join(" · ") : true;
  });

  must("every font option resolves to a real family stack", () => {
    const bad = [];
    for (const [key, stack] of Object.entries(catalog.fontFamilyChoices || {})) {
      if (typeof stack !== "string" || !stack.trim()) { bad.push(`${key}: ${JSON.stringify(stack)}`); continue; }
      // A stack with no fallback is one webfont away from the browser's
      // default, which is not what any of these were chosen for.
      if (!stack.includes(",")) bad.push(`${key}: no fallback in ${JSON.stringify(stack)}`);
    }
    return bad.length ? list(bad) : true;
  });

  must("every font the panel offers is one the app can resolve", () => {
    const known = new Set(Object.keys(catalog.fontFamilyChoices || {}));
    const offered = (catalog.fontFamilyOptions || []).map((o) => (o && typeof o === "object" ? o.value : o));
    const dangling = offered.filter((v) => v && !known.has(v));
    return dangling.length ? `offered but unresolvable: ${list(dangling)}` : true;
  });

  // ── A floor ─────────────────────────────────────────────────────────────
  //
  // Every assertion above is of the form "nothing is inconsistent", and all of
  // them pass trivially against empty tables. Say what has to be there.
  must("the tables are not empty", () => {
    if (themes.length < 2) return `${themes.length} theme(s)`;
    if (Object.keys(schema.styleFieldByKey).length < 10) return `${Object.keys(schema.styleFieldByKey).length} field(s)`;
    if (Object.keys(schema.styleCssVariables).length < 10) return `${Object.keys(schema.styleCssVariables).length} variable(s)`;
    if (!schema.styleControlGroups.length) return "no Style panel groups";
    return true;
  });
} catch (error) {
  must(`the check itself: ${error?.message || error}`, () => String(error?.stack || error));
} finally {
  rmSync(stage, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) {
  console.log(ok ? `  ok    ${name}` : `  FAIL  ${name}\n        ${detail}`);
}
// The other half, said out loud: whether a theme's palette actually reaches the
// page, and whether the rendered background agrees with isDarkThemeActive, are
// browser questions and belong to tools/style-check.mjs.
console.log("\nnot covered here: whether a palette reaches the page (that is style-check's)");
console.log(`\n${results.length} checks · ${failures} failed`);
console.log(`CHECK: ${results.length} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
