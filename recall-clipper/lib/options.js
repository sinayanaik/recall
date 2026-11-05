// Every option the popup's Save as PDF offers, its default, the built-in
// presets, and the page geometry they add up to. Shared by popup.js and
// pdf-job.js so the two can never disagree about what an option means.

export const PAPERS = {
  A4: [210, 297],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  A3: [297, 420],
  A5: [148, 210],
  Tabloid: [279.4, 431.8]
};

export const MM_PER_IN = 25.4;
export const CSS_PX_PER_IN = 96;
// The tallest page most PDF viewers will show (the PDF spec's 14 400 units).
export const MAX_PAGE_IN = 200;

// dpi null: the picture's own size. "Original" still re-encodes WebP and AVIF
// (as JPEG at 92%), which Chrome would otherwise store as raw pixels.
export const QUALITY = {
  original: { dpi: null, jpeg: 92 },
  high: { dpi: 200, jpeg: 85 },
  medium: { dpi: 150, jpeg: 75 },
  low: { dpi: 100, jpeg: 60 },
  none: null
};

export const DEFAULTS = Object.freeze({
  // Capture
  capture: "page",              // page | selection | element | visible
  clean: "gentle",              // off | gentle | balanced | reader
  // Layout
  layout: "smart",              // smart | continuous | paged
  pageLength: "a4",             // screen | a4 | 2a4 | custom (smart pages: how tall one page may be)
  customPageLength: 297,        // in marginUnit
  adjustBreaks: true,           // show the page breaks on the page before saving
  paper: "A4",                  // A4 | Letter | Legal | A3 | A5 | Tabloid | custom
  customWidth: 210,             // in marginUnit
  customHeight: 297,
  orientation: "portrait",      // portrait | landscape
  // Margins
  marginPreset: "sides",        // none | sides | topbottom | all | custom
  marginUnit: "mm",             // mm | in
  marginSize: 12,
  margins: { top: 12, right: 12, bottom: 12, left: 12 },
  // Scale & typography
  scaleMode: "percent",         // percent | width
  scale: 100,
  layoutWidth: "1024",          // 1280 | 1024 | 768 | 390 | custom
  customLayoutWidth: 1100,
  textSize: 100,
  wrapCode: true,
  // Media & colour
  media: "print",               // print | screen
  colorScheme: "page",          // page | light | dark
  backgrounds: true,
  forceLight: false,
  effects: false,               // keep shadows and blur effects (each becomes a picture in the PDF)
  fonts: "auto",                // auto | page | standard (auto: variable fonts → the page's fallback font)
  // Images
  imageQuality: "high",         // original | high | medium | low | custom | none
  customDpi: 200,
  customJpeg: 85,
  grayscale: false,
  minImagePx: 0,
  lazyLoad: true,
  lazyWaitMs: 800,
  // Page handling
  hideFixed: true,
  expand: true,
  avoidBreaks: true,
  breakBefore: "none",          // none | h1 | h2
  embeds: "placeholder",        // placeholder | keep | hide
  // Extras
  header: "none",               // none | title | url | title-url | custom
  headerCustom: "{title}",
  footer: "none",               // none | page | date-page | url-page | custom
  footerCustom: "{page} / {pages}",
  hfFontSize: 8,
  linkUrls: false,
  outline: true,
  tagged: false,                // several times bigger and slower; bookmarks no longer need it
  banner: true,
  filename: "{title} - {site}",
  subfolder: "",
  saveAs: false,
  showAfter: false
});

export const BUILTIN_PRESETS = {
  "Recall reading (default)": {},
  "One long page": {
    layout: "continuous"
  },
  "Clean article": {
    clean: "reader", layout: "smart", imageQuality: "medium", banner: true, textSize: 105
  },
  "Print A4": {
    clean: "gentle", layout: "paged", paper: "A4", marginPreset: "all", marginSize: 15,
    header: "title-url", footer: "date-page", banner: false
  },
  "Print Letter": {
    clean: "gentle", layout: "paged", paper: "Letter", marginPreset: "all", marginUnit: "in", marginSize: 0.6,
    header: "title-url", footer: "date-page", banner: false
  },
  "Full page as seen": {
    clean: "off", media: "screen", scaleMode: "width", layoutWidth: "1280", imageQuality: "original",
    marginPreset: "none", banner: false, hideFixed: true
  },
  "Compact": {
    clean: "balanced", layout: "paged", imageQuality: "low", grayscale: true, textSize: 90,
    marginPreset: "all", marginSize: 8, banner: false, embeds: "hide"
  }
};

const ENUMS = {
  capture: ["page", "selection", "element", "visible"],
  clean: ["off", "gentle", "balanced", "reader"],
  layout: ["smart", "continuous", "paged"],
  pageLength: ["screen", "a4", "2a4", "custom"],
  paper: [...Object.keys(PAPERS), "custom"],
  orientation: ["portrait", "landscape"],
  marginPreset: ["none", "sides", "topbottom", "all", "custom"],
  marginUnit: ["mm", "in"],
  scaleMode: ["percent", "width"],
  layoutWidth: ["1280", "1024", "768", "390", "custom"],
  media: ["print", "screen"],
  colorScheme: ["page", "light", "dark"],
  fonts: ["auto", "page", "standard"],
  imageQuality: ["original", "high", "medium", "low", "custom", "none"],
  breakBefore: ["none", "h1", "h2"],
  embeds: ["placeholder", "keep", "hide"],
  header: ["none", "title", "url", "title-url", "custom"],
  footer: ["none", "page", "date-page", "url-page", "custom"]
};

const RANGES = {
  customWidth: [10, 5000], customHeight: [10, 5000], customPageLength: [20, 5000], marginSize: [0, 200], scale: [10, 200],
  customLayoutWidth: [240, 4000], textSize: [50, 250], customDpi: [36, 600], customJpeg: [10, 100],
  minImagePx: [0, 2000], lazyWaitMs: [0, 10000], hfFontSize: [5, 16]
};

const clamp = (n, [lo, hi], fallback) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

/** Fills gaps with defaults and clamps everything into range. */
export function normalize(raw = {}) {
  const o = { ...DEFAULTS, ...raw };
  for (const [k, allowed] of Object.entries(ENUMS)) if (!allowed.includes(String(o[k]))) o[k] = DEFAULTS[k];
  for (const [k, range] of Object.entries(RANGES)) o[k] = clamp(o[k], range, DEFAULTS[k]);
  const m = { ...DEFAULTS.margins, ...(raw.margins || {}) };
  o.margins = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, clamp(v, [0, 200], 0)]));
  for (const k of Object.keys(DEFAULTS)) if (typeof DEFAULTS[k] === "boolean") o[k] = Boolean(o[k]);
  o.layoutWidth = String(o.layoutWidth);
  for (const k of ["headerCustom", "footerCustom", "filename", "subfolder"]) o[k] = String(o[k] ?? "").slice(0, 300);
  return o;
}

const toIn = (value, unit) => (unit === "in" ? value : value / MM_PER_IN);

/**
 * Paper and margins in inches, and the width the page is laid out at.
 * @returns {{paperWidthIn, paperHeightIn, margin: {top,right,bottom,left}, printableWidthIn, layoutWidthPx, scale}}
 */
export function geometry(o) {
  let [w, h] = o.paper === "custom"
    ? [toIn(o.customWidth, o.marginUnit), toIn(o.customHeight, o.marginUnit)]
    : PAPERS[o.paper].map((mm) => mm / MM_PER_IN);
  if (o.orientation === "landscape") [w, h] = [h, w];

  const s = toIn(o.marginSize, o.marginUnit);
  const presets = {
    none: { top: 0, right: 0, bottom: 0, left: 0 },
    sides: { top: 0, right: s, bottom: 0, left: s },
    topbottom: { top: s, right: 0, bottom: s, left: 0 },
    all: { top: s, right: s, bottom: s, left: s }
  };
  const margin = o.marginPreset === "custom"
    ? Object.fromEntries(Object.entries(o.margins).map(([k, v]) => [k, toIn(v, o.marginUnit)]))
    : { ...presets[o.marginPreset] };
  // Chrome draws a header or footer inside the margin, so it needs room.
  const HF_MIN = 0.45;
  if (o.header !== "none") margin.top = Math.max(margin.top, HF_MIN);
  if (o.footer !== "none") margin.bottom = Math.max(margin.bottom, HF_MIN);
  // Never let the margins eat the page.
  const maxSide = w * 0.4;
  margin.left = Math.min(margin.left, maxSide);
  margin.right = Math.min(margin.right, maxSide);

  const printableWidthIn = Math.max(0.5, w - margin.left - margin.right);
  let scale;
  if (o.scaleMode === "width") {
    const target = o.layoutWidth === "custom" ? o.customLayoutWidth : Number(o.layoutWidth);
    scale = (printableWidthIn * CSS_PX_PER_IN) / target;
  } else {
    scale = o.scale / 100;
  }
  scale = Math.min(2, Math.max(0.1, scale));
  const layoutWidthPx = Math.round((printableWidthIn * CSS_PX_PER_IN) / scale);
  return { paperWidthIn: w, paperHeightIn: h, margin, printableWidthIn, layoutWidthPx, scale };
}

/**
 * Smart pages: how tall one page may be, in inches of paper (margins included).
 * "screen" is a landscape-shaped page, about what a laptop screen shows at
 * once; "a4" is the chosen paper's own height.
 */
export function pageLengthIn(o, geo = geometry(o), length = o.pageLength) {
  const inches = {
    screen: geo.paperWidthIn * 0.75,
    a4: geo.paperHeightIn,
    "2a4": geo.paperHeightIn * 2,
    custom: toIn(o.customPageLength, o.marginUnit)
  }[length] ?? geo.paperHeightIn;
  return Math.min(MAX_PAGE_IN, Math.max(1, inches));
}

// What pdf-job.js adds below a smart page's measured content, so a page that
// prints a touch taller than it measured is not cut short. Taken off the
// content's share up front, so the finished page is never longer than asked.
export const SMART_SLACK_IN = 0.25;

/**
 * The same, as the height of page CONTENT in the page's own layout pixels —
 * what content/prepare.js plans the page breaks against.
 */
export function pageContentPx(o, geo = geometry(o), length = o.pageLength) {
  const contentIn = Math.max(1, pageLengthIn(o, geo, length) - geo.margin.top - geo.margin.bottom - SMART_SLACK_IN);
  return Math.round((contentIn * CSS_PX_PER_IN) / geo.scale);
}

export function imageSettings(o) {
  if (o.imageQuality === "custom") return { dpi: o.customDpi, jpeg: o.customJpeg };
  return QUALITY[o.imageQuality] || null; // null: no pictures at all
}

const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;

/** "{title} - {site}" → a safe file name (no extension). */
export function fileNameFor(template, facts, when = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const date = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
  const time = `${p(when.getHours())}${p(when.getMinutes())}`;
  let host = "";
  try { host = new URL(facts.url).hostname.replace(/^www\./, ""); } catch { /* keep empty */ }
  const filled = (template || "{title}")
    .replace(/\{title\}/g, facts.title || "")
    .replace(/\{site\}/g, facts.site || host)
    .replace(/\{domain\}/g, host)
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{author\}/g, facts.author || "");
  const clean = filled.replace(UNSAFE, " ").replace(/\s+/g, " ").replace(/^[\s.\-–]+|[\s.\-–]+$/g, "").trim();
  return (clean || "web page").slice(0, 150);
}

export function folderFor(subfolder) {
  return String(subfolder || "")
    .split(/[\\/]+/)
    .map((part) => part.replace(UNSAFE, " ").replace(/^\.+/, "").trim())
    .filter(Boolean)
    .join("/");
}
