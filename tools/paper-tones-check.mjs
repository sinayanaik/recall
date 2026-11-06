// The paper tones, in pure Node: src/format/paper-tones.js (what each tone is
// under each theme, and how a colour is kept readable on it) and the one hook
// src/render/annot-shapes.js gives it (shapePrimitives' `recolor`).
//
//   node tools/paper-tones-check.mjs
//
// The questions a browser is the wrong instrument for: does every tone resolve
// under every theme, do White and Black keep the picture keys every kept picture
// was filed under, is a dark page never pure black, does a colour that reads stay
// exactly as picked, does one that does not become one that does, and is a shape
// drawn byte-for-byte as before when nobody asks for a recolour.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-paper-"));

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

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));
  const P = await import(path.join(stage, "src/format/paper-tones.js"));
  const S = await import(path.join(stage, "src/render/annot-shapes.js"));
  const { themeCatalog } = await import(path.join(stage, "src/ui/theme-catalog.js"));
  const { INK_PEN_HEX, INK_PEN_HEX_DARK } = await import(path.join(stage, "src/format/ink-colors.js"));

  const floor = P.parseHex(P.PAPER_DARK_FLOOR);

  must("every tone resolves under every theme, to a polarity, a colour and a key", () => {
    const bad = [];
    themeCatalog.forEach((theme) => {
      P.PAPER_TONE_IDS.forEach((id) => {
        const tone = P.resolvePaperTone(id, theme.id);
        if (tone.id !== id) bad.push(`${theme.id}/${id}: id ${tone.id}`);
        if (typeof tone.dark !== "boolean") bad.push(`${theme.id}/${id}: dark is ${tone.dark}`);
        if (!/^#[0-9a-f]{6}$/.test(tone.bg)) bad.push(`${theme.id}/${id}: bg ${tone.bg}`);
        if (!/^(light|dark)(~[0-9a-f]{6})?$/.test(tone.key)) bad.push(`${theme.id}/${id}: key ${tone.key}`);
        const parts = P.paperKeyParts(tone.key);
        if (parts.dark !== tone.dark || parts.tint !== tone.tint) bad.push(`${theme.id}/${id}: key ${tone.key} reads back as ${JSON.stringify(parts)}`);
        if (P.paperKeyBg(tone.key) !== tone.bg) bad.push(`${theme.id}/${id}: key bg ${P.paperKeyBg(tone.key)} ≠ ${tone.bg}`);
      });
    });
    return bad.length ? bad.slice(0, 6).join("; ") : true;
  });

  must("White and Black keep the keys every kept picture was filed under", () => {
    const white = P.resolvePaperTone("white");
    const black = P.resolvePaperTone("black");
    if (white.key !== "light" || white.tint !== null || white.dark) return `White is ${JSON.stringify(white)}`;
    if (black.key !== "dark" || black.tint !== null || !black.dark) return `Black is ${JSON.stringify(black)}`;
    return true;
  });

  must("Sepia and Dim are tinted, light and dark", () => {
    const sepia = P.resolvePaperTone("sepia");
    const dim = P.resolvePaperTone("dim");
    if (sepia.dark || !sepia.tint || !sepia.key.startsWith("light~")) return `Sepia is ${JSON.stringify(sepia)}`;
    if (!dim.dark || !dim.tint || !dim.key.startsWith("dark~")) return `Dim is ${JSON.stringify(dim)}`;
    return true;
  });

  must("a dark paper is never pure black (that is how a cleared canvas is recognised)", () => {
    const bad = [];
    themeCatalog.forEach((theme) => {
      P.PAPER_TONE_IDS.forEach((id) => {
        const tone = P.resolvePaperTone(id, theme.id);
        if (!tone.dark) return;
        const rgb = P.parseHex(tone.bg);
        if (rgb.some((v, i) => v < floor[i])) bad.push(`${theme.id}/${id}: ${tone.bg}`);
      });
    });
    return bad.length ? bad.join(", ") : true;
  });

  must("Match theme takes the theme's polarity and its panel colour", () => {
    const bad = [];
    themeCatalog.forEach((theme) => {
      const tone = P.resolvePaperTone("theme", theme.id);
      if (tone.dark !== (theme.mode === "dark")) bad.push(`${theme.id}: dark ${tone.dark}`);
      const panel = P.parseHex(theme.colors.panel);
      const got = P.parseHex(tone.bg);
      // Either the panel itself, or — within a hair of plain white or black —
      // the plain paper, which costs no second set of kept pictures.
      const plain = P.parseHex(tone.dark ? P.PAPER_DARK_FLOOR : P.PAPER_WHITE);
      const same = (a, b, slack) => a.every((v, i) => Math.abs(v - b[i]) <= slack);
      if (!same(got, panel, 0) && !(same(got, plain, 0) && same(panel, plain, 3))) bad.push(`${theme.id}: ${tone.bg} for panel ${theme.colors.panel}`);
    });
    return bad.length ? bad.join(", ") : true;
  });

  must("Navy, Forest and Bronze no longer share one black page", () => {
    const keys = new Set(["dark-navy", "dark-forest", "dark-bronze"].map((id) => P.resolvePaperTone("theme", id).key));
    return keys.size === 3 || `keys: ${[...keys].join(", ")}`;
  });

  must("an unknown tone falls back to the default asked for", () => {
    if (P.normalizePaperToneId("neon") !== "white") return "unknown → not white";
    if (P.normalizePaperToneId("neon", "theme") !== "theme") return "unknown → not the given fallback";
    return P.resolvePaperTone("neon").id === "white" || "resolvePaperTone did not fall back";
  });

  must("paperKey and paperKeyParts are inverses", () => {
    const cases = [[false, null], [true, null], [false, "#f4ecd8"], [true, "#26282d"]];
    for (const [dark, tint] of cases) {
      const key = P.paperKey(dark, tint);
      const back = P.paperKeyParts(key);
      if (back.dark !== dark || back.tint !== tint) return `${dark}/${tint} → ${key} → ${JSON.stringify(back)}`;
    }
    return P.paperKeyParts("garbage").dark === false || "garbage read as dark";
  });

  // ── Readable on the paper ──────────────────────────────────────────────
  const papers = ["#ffffff", "#f4ecd8", "#26282d", "#030303", "#121a2b"];

  must("a colour that already reads is painted exactly as picked", () => {
    const pairs = [["#000000", "#ffffff"], ["#dc2626", "#ffffff"], ["#ffffff", "#030303"], ["#f87171", "#26282d"], ["#1e90ff", "#030303"], ["#16181d", "#f4ecd8"]];
    for (const [colour, bg] of pairs) {
      if (P.readableOnPaper(colour, bg) !== colour) return `${colour} on ${bg} became ${P.readableOnPaper(colour, bg)}`;
    }
    return true;
  });

  must("every colour ends up readable on every paper", () => {
    const bad = [];
    const colours = ["#000000", "#ffffff", "#808080", "#777777", "#16181d", "#e8eaed", "#fde68a", "#1e3a8a", "#7f1d1d", "#ffff00", "#00ff00", "#0000ff"];
    colours.forEach((colour) => papers.forEach((bg) => {
      const out = P.readableOnPaper(colour, bg);
      const ratio = P.contrastRatio(out, bg);
      if (ratio < P.PAPER_MIN_CONTRAST - 0.01) bad.push(`${colour} on ${bg} → ${out} (${ratio.toFixed(2)})`);
    }));
    return bad.length ? bad.slice(0, 6).join("; ") : true;
  });

  must("black on Black becomes a light colour, and a dark red stays red", () => {
    const black = P.readableOnPaper("#000000", "#030303");
    if (P.relativeLuminance(black) < 0.5) return `black became ${black}`;
    const red = P.readableOnPaper("#7f1d1d", "#030303");
    const [r, g, b] = P.parseHex(red);
    if (!(r > g && r > b)) return `a dark red became ${red}`;
    return true;
  });

  must("the palette pens already read on their own paper (so only custom colours ever move)", () => {
    const bad = [];
    Object.entries(INK_PEN_HEX).forEach(([token, hex]) => ["#ffffff", "#f4ecd8"].forEach((bg) => {
      if (P.readableOnPaper(hex, bg) !== hex) bad.push(`light ${token} on ${bg}`);
    }));
    Object.entries(INK_PEN_HEX_DARK).forEach(([token, hex]) => ["#030303", "#26282d", "#121a2b"].forEach((bg) => {
      if (P.readableOnPaper(hex, bg) !== hex) bad.push(`dark ${token} on ${bg}`);
    }));
    return bad.length ? bad.join(", ") : true;
  });

  must("paperRecolor passes anything that is not a hex straight through", () => {
    const recolor = P.paperRecolor("#030303");
    if (recolor("none") !== "none" || recolor("transparent") !== "transparent" || recolor("var(--x)") !== "var(--x)") return "a non-hex was changed";
    if (P.paperRecolor("not a colour") !== null) return "a recolour was made for no paper";
    return recolor("#000000") !== "#000000" || "black on Black was not recoloured";
  });

  // ── Shapes ─────────────────────────────────────────────────────────────
  const shapes = [
    { type: "line", p: [[0, 0], [50, 50]], stroke: "#000000", heads: ["none", "filled"] },
    { type: "rect", p: [[0, 0], [50, 50]], stroke: "#000000", fill: "#000000" },
    { type: "text", p: [[0, 0], [100, 20]], stroke: "#000000", text: "Hello", border: true, font: { size: 11, color: "#111111" } },
    { type: "callout", p: [[0, 0], [100, 20], [150, 80]], stroke: "#000000", text: "Note" },
    { type: "sticky", p: [[0, 0]], stroke: "#e0b400" }
  ];

  must("without a recolour, a shape is drawn exactly as before", () => {
    for (const shape of shapes) {
      const a = JSON.stringify(S.shapePrimitives(shape));
      const b = JSON.stringify(S.shapePrimitives(shape, {}));
      const c = JSON.stringify(S.shapePrimitives(shape, { recolor: null }));
      if (a !== b || a !== c) return `${shape.type} changed`;
    }
    return true;
  });

  must("with a recolour, a shape's ink goes through it — lines, borders, heads, words — and its washes do not", () => {
    const recolor = () => "#abcdef";
    for (const shape of shapes.slice(0, 4)) {
      const prims = S.shapePrimitives(shape, { recolor });
      for (const prim of prims) {
        if (prim.kind === "poly" && prim.width > 0 && prim.stroke !== "#abcdef") return `${shape.type}: stroke ${prim.stroke} was not recoloured`;
        if (prim.kind === "text" && prim.color !== "#abcdef") return `${shape.type}: words ${prim.color} were not recoloured`;
      }
    }
    const head = S.shapePrimitives(shapes[0], { recolor }).find((prim) => prim.closed && prim.fill);
    if (!head || head.fill !== "#abcdef") return "a filled arrowhead kept its old fill";
    const box = S.shapePrimitives(shapes[1], { recolor }).find((prim) => prim.kind === "poly");
    if (box.fill !== "#000000") return "a box's wash was recoloured";
    const covered = { ...shapes[2], fill: "#ffffff", fillOpacity: 1 };
    const words = S.shapePrimitives(covered, { recolor }).find((prim) => prim.kind === "text");
    return words.color === "#111111" || "words over an opaque fill were recoloured";
  });

  must("a black text box and its border are readable on Black, and untouched on White", () => {
    const text = shapes[2];
    const onBlack = S.shapePrimitives(text, { recolor: P.paperRecolor("#030303") });
    const onWhite = S.shapePrimitives(text, { recolor: P.paperRecolor("#ffffff") });
    const border = (prims) => prims.find((prim) => prim.kind === "poly");
    const words = (prims) => prims.find((prim) => prim.kind === "text");
    if (P.contrastRatio(border(onBlack).stroke, "#030303") < P.PAPER_MIN_CONTRAST) return `border on Black is ${border(onBlack).stroke}`;
    if (P.contrastRatio(words(onBlack).color, "#030303") < P.PAPER_MIN_CONTRAST) return `words on Black are ${words(onBlack).color}`;
    if (border(onWhite).stroke !== "#000000" || words(onWhite).color !== "#111111") return "the White copy was changed";
    return true;
  });

  must("a sticky note's own yellow is not touched on any paper", () => {
    return papers.every((bg) => S.shapePrimitives(shapes[4], { recolor: P.paperRecolor(bg) })[0].color === "#e0b400") || "the sticky's yellow moved";
  });

  console.log("── paper tones ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
