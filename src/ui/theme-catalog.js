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

// Is the theme in force a dark one?
//
// Here, in the leaf, rather than beside setTheme: the Document surface needs it
// to decide whether a notebook's paper is a dark page, and it must not import
// src/ui/theme.js to find out — that module reaches the card view and the block
// cache, and the document surface is reached from both.
//
// Read off the catalog rather than off the id's prefix. Every theme today is
// named "dark-…" or "light-…" and a prefix test would work; the day one is not,
// a prefix test would silently give somebody a white page and a white pen.
export function isDarkThemeActive() {
  const id = typeof document !== "undefined" ? (document.documentElement?.dataset?.theme || "") : "";
  const theme = themeCatalog.find((entry) => entry.id === (themeAliases[id] || id));
  // No attribute yet is the app's own default, which is a dark theme
  // (normalizeThemeId falls back to dark-amoled).
  return theme ? theme.mode === "dark" : true;
}

export const themeAliases = {
  dark: "dark-amoled",
  light: "light-paper"
};

// The four "system" entries need nothing but what the OS already ships, so
// they render instantly and work offline from a cold install. Every entry
// after them names a real webfont — the key is looked up in WEBFONT_PACKAGES
// (src/core/lib-loader.js) by resolveFontFamily, which injects its stylesheet
// the moment it's chosen, and the value below is the CSS stack the browser
// paints with WHILE that fetch is in flight (font-display: swap in the
// fetched CSS is what swaps it in the moment the real face lands) and forever
// after if the fetch never lands at all (no connection, a typo in the key).
// The two must name fonts the same way — see the comment on WEBFONT_PACKAGES.
export const fontFamilyChoices = {
  system: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  serif: "Georgia, \"Times New Roman\", Times, serif",
  mono: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",
  rounded: "ui-rounded, \"Avenir Next\", \"Nunito Sans\", Inter, ui-sans-serif, system-ui, sans-serif",

  // ── Sans-serif ──
  Inter: "\"Inter\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  Roboto: "\"Roboto\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  "Open Sans": "\"Open Sans\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  Lato: "\"Lato\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  Montserrat: "\"Montserrat\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  Poppins: "\"Poppins\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  "Work Sans": "\"Work Sans\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  Nunito: "\"Nunito\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  Raleway: "\"Raleway\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  "IBM Plex Sans": "\"IBM Plex Sans\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",

  // ── Serif ──
  Lora: "\"Lora\", Georgia, \"Times New Roman\", Times, serif",
  Merriweather: "\"Merriweather\", Georgia, \"Times New Roman\", Times, serif",
  "Playfair Display": "\"Playfair Display\", Georgia, \"Times New Roman\", Times, serif",
  "PT Serif": "\"PT Serif\", Georgia, \"Times New Roman\", Times, serif",
  "Source Serif 4": "\"Source Serif 4\", Georgia, \"Times New Roman\", Times, serif",
  "Crimson Pro": "\"Crimson Pro\", Georgia, \"Times New Roman\", Times, serif",
  "Libre Baskerville": "\"Libre Baskerville\", Georgia, \"Times New Roman\", Times, serif",
  "EB Garamond": "\"EB Garamond\", Georgia, \"Times New Roman\", Times, serif",

  // ── Monospace ──
  "JetBrains Mono": "\"JetBrains Mono\", \"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",
  "Fira Code": "\"Fira Code\", \"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",
  "Source Code Pro": "\"Source Code Pro\", \"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",
  "IBM Plex Mono": "\"IBM Plex Mono\", \"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",
  "Space Mono": "\"Space Mono\", \"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",

  // ── Rounded ──
  Quicksand: "\"Quicksand\", ui-rounded, \"Avenir Next\", \"Nunito Sans\", sans-serif",
  Comfortaa: "\"Comfortaa\", ui-rounded, \"Avenir Next\", \"Nunito Sans\", sans-serif",
  "Baloo 2": "\"Baloo 2\", ui-rounded, \"Avenir Next\", \"Nunito Sans\", sans-serif",

  // ── Handwriting ──
  Caveat: "\"Caveat\", cursive",
  Kalam: "\"Kalam\", cursive",
  "Patrick Hand": "\"Patrick Hand\", cursive"
};

// The Font select's options, grouped for the <optgroup>s the style panel draws
// them into — a flat 32-entry dropdown is not what "exhaustive" should feel
// like to scroll through. Single source for both the Basics and Notes font
// pickers in style-schema.js; keep new fontFamilyChoices entries listed here
// too; a font missing from every group here still WORKS (fontFamilyChoices is
// what actually resolves it) but is unreachable from either picker.
export const fontFamilyOptionGroups = [
  { label: "System", options: ["system", "serif", "mono", "rounded"] },
  {
    label: "Sans-serif",
    options: ["Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Work Sans", "Nunito", "Raleway", "IBM Plex Sans"]
  },
  {
    label: "Serif",
    options: ["Lora", "Merriweather", "Playfair Display", "PT Serif", "Source Serif 4", "Crimson Pro", "Libre Baskerville", "EB Garamond"]
  },
  { label: "Monospace", options: ["JetBrains Mono", "Fira Code", "Source Code Pro", "IBM Plex Mono", "Space Mono"] },
  { label: "Rounded", options: ["Quicksand", "Comfortaa", "Baloo 2"] },
  { label: "Handwriting", options: ["Caveat", "Kalam", "Patrick Hand"] }
];

export const fontFamilyOptions = fontFamilyOptionGroups.flatMap((group) => group.options);
