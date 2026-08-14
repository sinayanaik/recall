// The built-in themes, and the font stacks the style panel offers.

export const themeCatalog = [
  {
    id: "dark-amoled",
    label: "AMOLED Black",
    mode: "dark",
    description: "Pure black with cyan focus",
    colors: { bg: "#000000", panel: "#050606", text: "#f4fbfb", line: "#1a2424", accent: "#27e0d0" }
  },
  {
    id: "dark-amoled-emerald",
    label: "AMOLED Emerald",
    mode: "dark",
    description: "Pure black with green accents",
    colors: { bg: "#000000", panel: "#040705", text: "#f2fbf5", line: "#16251b", accent: "#34d96f" }
  },
  {
    id: "dark-amoled-violet",
    label: "AMOLED Violet",
    mode: "dark",
    description: "Pure black with violet accents",
    colors: { bg: "#000000", panel: "#070408", text: "#fbf5ff", line: "#25172a", accent: "#c084fc" }
  },
  {
    id: "dark-forest",
    label: "Forest Dark",
    mode: "dark",
    description: "Deep green-black panels",
    colors: { bg: "#0d1110", panel: "#131917", text: "#eef5f1", line: "#2b3933", accent: "#55d6bf" }
  },
  {
    id: "dark-graphite",
    label: "Graphite Dark",
    mode: "dark",
    description: "Neutral charcoal and cyan",
    colors: { bg: "#101113", panel: "#181a1d", text: "#f1f3f4", line: "#333841", accent: "#7cc7d8" }
  },
  {
    id: "dark-navy",
    label: "Navy Dark",
    mode: "dark",
    description: "Low-glare blue workspace",
    colors: { bg: "#0b1020", panel: "#121a2b", text: "#eef3fb", line: "#2b3a55", accent: "#8ab4ff" }
  },
  {
    id: "dark-bronze",
    label: "Bronze Dark",
    mode: "dark",
    description: "Dark neutral with amber focus",
    colors: { bg: "#12110d", panel: "#1b1913", text: "#f3f0e7", line: "#3a3427", accent: "#e1b86b" }
  },
  {
    id: "light-paper",
    label: "Paper Light",
    mode: "light",
    description: "Warm paper with teal accents",
    colors: { bg: "#f4f2ec", panel: "#fffdf8", text: "#161a18", line: "#d8d4c8", accent: "#16796c" }
  },
  {
    id: "light-snow",
    label: "Snow Light",
    mode: "light",
    description: "Clean neutral workspace",
    colors: { bg: "#f6f8f9", panel: "#ffffff", text: "#172026", line: "#d8e0e5", accent: "#2c6f91" }
  },
  {
    id: "light-ink",
    label: "Ink Light",
    mode: "light",
    description: "Cool blue-gray contrast",
    colors: { bg: "#f3f5fb", panel: "#ffffff", text: "#151b2a", line: "#d3dbea", accent: "#3f63b5" }
  }
];

export const themeAliases = {
  dark: "dark-amoled",
  light: "light-paper"
};

export const fontFamilyChoices = {
  system: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  serif: "Georgia, \"Times New Roman\", Times, serif",
  mono: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",
  rounded: "ui-rounded, \"Avenir Next\", \"Nunito Sans\", Inter, ui-sans-serif, system-ui, sans-serif"
};
