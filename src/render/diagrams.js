// Diagram theming. Colours are baked into the source before rendering because
// neither mermaid nor nomnoml reads them back off the page.

import { cssVariableColor } from "../ui/theme.js?v=__BUILD__";

export function nomnomlThemeDefaults(print = false) {
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

export function sourceWithNomnomlTheme(source, print = false) {
  const diagramSource = String(source || "").trim();
  const configured = new Set();

  diagramSource.split("\n").forEach((line) => {
    const match = line.trim().match(/^#([A-Za-z][A-Za-z0-9_]*)\s*:/);
    if (match) configured.add(match[1].toLowerCase());
  });

  const injected = Object.entries(nomnomlThemeDefaults(print))
    .filter(([key]) => !configured.has(key.toLowerCase()))
    .map(([key, value]) => `#${key}: ${value}`);

  return injected.length ? `${injected.join("\n")}\n${diagramSource}` : diagramSource;
}
