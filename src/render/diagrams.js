// Diagram theming. Colours are baked into the source before rendering because
// neither mermaid nor nomnoml reads them back off the page.

import { cssVariableColor } from "../ui/theme.js?v=__BUILD__";

// `palette` is the page's own colours when the diagram is on a PDF or Canvas
// page (diagramPaletteFor, src/format/paper-palette.js) — the paper's card and
// words, not the theme's, which was a dark theme's boxes on White paper. The
// font stays Arial: nomnoml sizes its boxes by estimating text widths for it,
// and styles/06-rendered.css draws its text in Arial to match.
export function nomnomlThemeDefaults(print = false, palette = null) {
  if (palette && !print) {
    return {
      background: palette.card,
      fill: [palette.card, palette.panel, palette.panel2, palette.card].join("; "),
      stroke: palette.text,
      font: "Arial",
      fontSize: "12",
      lineWidth: "1.4"
    };
  }
  return {
    background: cssVariableColor(print ? "--print-surface" : "--card", "#ffffff"),
    fill: [
      cssVariableColor(print ? "--print-surface" : "--card", "#ffffff"),
      cssVariableColor(print ? "--print-panel" : "--panel", "#fffdf8"),
      cssVariableColor(print ? "--print-panel-2" : "--panel-2", "#f3f6fb"),
      cssVariableColor(print ? "--print-question" : "--card-answer", "#eaf7f3")
    ].join("; "),
    stroke: cssVariableColor(print ? "--print-text" : "--text", "#263238"),
    font: "Arial",
    fontSize: "12",
    lineWidth: "1.4"
  };
}

export function sourceWithNomnomlTheme(source, print = false, palette = null) {
  const diagramSource = String(source || "").trim();
  const configured = new Set();

  diagramSource.split("\n").forEach((line) => {
    const match = line.trim().match(/^#([A-Za-z][A-Za-z0-9_]*)\s*:/);
    if (match) configured.add(match[1].toLowerCase());
  });

  const injected = Object.entries(nomnomlThemeDefaults(print, palette))
    .filter(([key]) => !configured.has(key.toLowerCase()))
    .map(([key, value]) => `#${key}: ${value}`);

  return injected.length ? `${injected.join("\n")}\n${diagramSource}` : diagramSource;
}

// ── mermaid on a page ─────────────────────────────────────────────────────
//
// mermaid is configured once, for the whole app, from the theme
// (configureMermaid, src/ui/theme.js) — right for a note, and a dark theme's
// boxes and pale words on a White Canvas page. A diagram on a page is told its
// page's colours instead, in a directive at the head of its own source: per
// diagram, so nothing about the app-wide configuration changes under a note
// that is rendering at the same moment. A diagram that carries its own
// configuration (an init directive, or a front-matter `config:`) keeps it.
export function sourceWithMermaidPalette(source, palette, fontFamily = "") {
  const text = String(source || "");
  if (!palette) return text;
  if (/%%\{\s*init(?:ialize)?\s*:/i.test(text)) return text;
  const frontMatter = /^\s*---\r?\n[\s\S]*?\r?\n---[^\n]*(?:\r?\n|$)/.exec(text);
  if (frontMatter && /(^|\n)\s*config\s*:/.test(frontMatter[0])) return text;
  const themeVariables = {
    darkMode: Boolean(palette.dark),
    background: palette.bg,
    primaryColor: palette.card,
    primaryTextColor: palette.text,
    primaryBorderColor: palette.accent,
    lineColor: palette.muted,
    secondaryColor: palette.panel2,
    tertiaryColor: palette.bg,
    edgeLabelBackground: palette.panel,
    clusterBkg: palette.panel,
    clusterBorder: palette.line,
    textColor: palette.text,
    titleColor: palette.text
  };
  if (fontFamily) themeVariables.fontFamily = fontFamily;
  const directive = `%%{init: ${JSON.stringify({ theme: "base", themeVariables })}}%%\n`;
  return frontMatter
    ? `${frontMatter[0]}${directive}${text.slice(frontMatter[0].length)}`
    : `${directive}${text}`;
}
