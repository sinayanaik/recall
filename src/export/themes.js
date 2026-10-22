// The three looks an export can be given: Plain, Minimal and Fancy.
//
// Asked at the moment of exporting (src/export/theme-dialog.js), remembered for
// the next one. The PDF and HTML exports carry the look as a class on the
// document's wrapper, styled by styles/82-export-themes.css; Word has no CSS,
// so the .docx export reads the `docx` tokens here instead.
//
// A leaf, and pure: nothing here touches `document`, so tools/export-check.mjs
// can import it in Node.

export const EXPORT_THEME_KEY = "recall:exportTheme";

export const EXPORT_THEME_DEFAULT = "minimal";

export const EXPORT_THEMES = {
  plain: {
    id: "plain",
    label: "Plain",
    description: "Black on white, like a printed essay",
    docx: {
      font: "Georgia",
      headingFont: "Georgia",
      // Sized by level, in half-points: with no colour to tell levels apart,
      // size has to.
      headingSizes: [36, 30, 26, 24, 22, 22],
      colored: false,
      shade: false
    }
  },
  minimal: {
    id: "minimal",
    label: "Minimal",
    description: "Clean, with one accent colour",
    docx: {
      font: "Calibri",
      headingFont: "Calibri",
      headingSizes: [34, 28, 25, 23, 22, 22],
      colored: true,
      shade: true,
      // A thin rule under h1 and h2 only — the rest are told apart by size.
      rules: "light"
    }
  },
  fancy: {
    id: "fancy",
    label: "Fancy",
    description: "Your fonts and colours, on white paper",
    docx: {
      font: "Calibri",
      headingFont: "Calibri",
      // One size for every level, with the hierarchy carried by weight, colour
      // and the underline — the ladder styles/06-rendered.css draws on screen.
      headingSizes: [22, 22, 22, 22, 22, 22],
      colored: true,
      shade: true,
      rules: "ladder"
    }
  }
};

export function normalizeExportTheme(id) {
  return Object.hasOwn(EXPORT_THEMES, id) ? id : EXPORT_THEME_DEFAULT;
}

export function exportTheme(id) {
  return EXPORT_THEMES[normalizeExportTheme(id)];
}

export function exportThemeClass(id) {
  return `export-theme-${normalizeExportTheme(id)}`;
}

export function loadExportTheme() {
  try {
    return normalizeExportTheme(globalThis.localStorage?.getItem(EXPORT_THEME_KEY));
  } catch (_) {
    return EXPORT_THEME_DEFAULT;
  }
}

export function saveExportTheme(id) {
  try { globalThis.localStorage?.setItem(EXPORT_THEME_KEY, normalizeExportTheme(id)); } catch (_) {}
}

// The width a picture is shown at in the note, in CSS pixels, or 0 when it was
// never resized and its own width is the answer. A resized picture is written
// as `<img class="has-custom-size" style="--notes-img-w:Npx; width:Npx">`
// (src/images/surface-controls.js); Word has to be told that width, since it
// cannot read the style.
export function customImageWidthPx({ className = "", style = "" } = {}) {
  if (!/(^|\s)has-custom-size(\s|$)/.test(className)) return 0;
  const match = /(?:^|;)\s*width\s*:\s*([\d.]+)px/i.exec(style) || /--notes-img-w\s*:\s*([\d.]+)px/i.exec(style);
  const width = match ? Number(match[1]) : 0;
  return Number.isFinite(width) && width > 0 ? width : 0;
}

// The size a picture is laid out at: its shown width when it has one, its
// natural size otherwise, and the aspect ratio kept either way.
export function displayImageSize(pixelWidth, pixelHeight, shownWidth = 0) {
  const width = Math.max(1, pixelWidth || 1);
  const height = Math.max(1, pixelHeight || 1);
  if (!shownWidth) return { width, height };
  return { width: shownWidth, height: Math.max(1, Math.round(height * shownWidth / width)) };
}
