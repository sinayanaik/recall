// Markdown → PDF: everything on a page that is not a letter, made into
// pictures before the layout runs.
//
//   formulas   KaTeX, the renderer the Notes view uses, pictured with
//              html-to-image (as pdf-region-marks.js pictures a block)
//   diagrams   mermaid and nomnoml through renderDiagramNodes
//              (src/render/enhance.js) — the very function a note draws them with
//   pictures   resolved and inlined by prepareExportImages (src/export/images.js,
//              the PDF/HTML/Word exports' own step: pictures waiting to upload,
//              private bucket links, PDF regions), then re-encoded at the size
//              they print, at the chosen quality — the clipper extension's
//              ladder (recall-clipper/lib/options.js QUALITY): JPEG for a
//              photo, PNG for a picture with see-through parts or few colours
//   glyphs     a word with a character no embedded font has (an emoji, a script
//              that needs shaping) as a small picture the browser's own text
//              engine drew
//
// Each is measured here, in points, and kept for the session: the dialog lays
// the PDF out again on every keystroke, and only what is new is drawn.

import { ensureHtmlToImage, ensureMermaid } from "../../core/lib-loader.js?v=__BUILD__";
import { prepareExportImages } from "../../export/images.js?v=__BUILD__";
import { renderDiagramNodes } from "../../render/enhance.js?v=__BUILD__";
import { normalizeCodeLanguage } from "../../render/code-language.js?v=__BUILD__";
import { configureMermaid, currentThemeId } from "../../ui/theme.js?v=__BUILD__";
import { PDFREF_SCHEME, mountPdfRegionPicture } from "../pdf-region-embed.js?v=__BUILD__";
import { flattenPrismTokens, glyphKey } from "./layout.js?v=__BUILD__";

// Dots per inch a picture is kept at, and its JPEG quality.
export const PICTURE_QUALITY = {
  original: { dpi: null, jpeg: 0.92 },
  high: { dpi: 200, jpeg: 0.85 },
  medium: { dpi: 150, jpeg: 0.75 },
  low: { dpi: 100, jpeg: 0.6 },
  none: null
};

const GLYPH_PX = 48;
const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const TEXT_COLOUR = "#1b1d21";

export function createAssetCache() {
  return { math: new Map(), diagram: new Map(), image: new Map(), glyph: new Map(), fontEmbedCSS: undefined };
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("empty canvas"))), type, quality);
    } catch (error) {
      reject(error);
    }
  });
}

async function canvasBytes(canvas, type, quality) {
  const blob = await canvasBlob(canvas, type, quality);
  return new Uint8Array(await blob.arrayBuffer());
}

function offscreenHost(fontPx) {
  const host = document.createElement("div");
  host.className = "md-pdf-render export-root";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed; left:-20000px; top:0; width:2000px; pointer-events:none; contain:layout style;`
    + ` color:${TEXT_COLOUR}; background:transparent; font-size:${fontPx}px; line-height:1.2;`;
  document.body.appendChild(host);
  return host;
}

async function rasterise(node, cache, { pixelRatio, background = null }) {
  if (cache.fontEmbedCSS === undefined) cache.fontEmbedCSS = await window.htmlToImage.getFontEmbedCSS(node).catch(() => "");
  const rect = node.getBoundingClientRect();
  const canvas = await window.htmlToImage.toCanvas(node, {
    pixelRatio,
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
    fontEmbedCSS: cache.fontEmbedCSS,
    backgroundColor: background || undefined,
    imagePlaceholder: TRANSPARENT_GIF
  });
  // A tainted canvas (a foreignObject a browser treats as cross-origin) throws
  // here rather than when the bytes are wanted.
  canvas.getContext("2d").getImageData(0, 0, 1, 1);
  return { canvas, rect };
}

// ── formulas ────────────────────────────────────────────────────────────────

async function drawMaths(needs, cache, { textSize, pixelRatio }) {
  const todo = [...needs.maths.entries()].filter(([key]) => !cache.math.has(`${key}@${textSize}`));
  if (!todo.length || typeof katex === "undefined") return;
  const host = offscreenHost(textSize * (4 / 3));
  try {
    for (const [key, { tex, display }] of todo) {
      const line = document.createElement("div");
      line.style.cssText = "white-space:nowrap; line-height:normal;";
      const wrap = document.createElement("span");
      wrap.style.cssText = "display:inline-block; padding:0 1px;";
      const strut = document.createElement("span");
      strut.style.cssText = "display:inline-block; width:0; height:0; vertical-align:baseline;";
      line.append(wrap, strut);
      host.appendChild(line);
      try {
        katex.render(tex, wrap, { displayMode: display, throwOnError: false });
        wrap.querySelectorAll(".katex-display").forEach((node) => { node.style.margin = "0"; });
        const box = wrap.getBoundingClientRect();
        const baseline = strut.getBoundingClientRect().bottom;
        // eslint-disable-next-line no-await-in-loop
        const { canvas } = await rasterise(wrap, cache, { pixelRatio });
        // eslint-disable-next-line no-await-in-loop
        const bytes = await canvasBytes(canvas, "image/png");
        cache.math.set(`${key}@${textSize}`, {
          key: `m${cache.math.size}:${textSize}`,
          w: box.width * 0.75,
          h: box.height * 0.75,
          depth: Math.max(0, box.bottom - baseline) * 0.75,
          bytes,
          type: "png"
        });
      } catch (error) {
        console.warn("Could not picture a formula for the PDF", tex, error);
        cache.math.set(`${key}@${textSize}`, null);
      }
      line.remove();
    }
  } finally {
    host.remove();
  }
}

// ── diagrams ────────────────────────────────────────────────────────────────

async function drawDiagrams(needs, cache, { pixelRatio }) {
  const todo = [...needs.diagrams.entries()].filter(([key]) => !cache.diagram.has(key));
  if (!todo.length) return;
  if (todo.some(([, d]) => d.kind === "mermaid")) await ensureMermaid();
  const host = offscreenHost(14);
  host.classList.add("print-root");
  // Drawn in the print palette — dark text on white — whatever the app's theme,
  // as the PDF exports draw them.
  const theme = currentThemeId();
  try {
    if (typeof mermaid !== "undefined") configureMermaid("print");
    for (const [key, diagram] of todo) {
      const node = document.createElement("div");
      node.className = diagram.kind === "mermaid" ? "mermaid" : "nomnoml-diagram";
      node.dataset.diagram = encodeURIComponent(diagram.source);
      node.style.cssText = `display:inline-block; background:#ffffff; ${diagram.width ? `width:${diagram.width}px;` : "max-width:1400px;"}`;
      host.appendChild(node);
      try {
        // eslint-disable-next-line no-await-in-loop
        await renderDiagramNodes([node]);
        const svg = node.querySelector("svg");
        if (!svg) throw new Error("no drawing");
        // eslint-disable-next-line no-await-in-loop
        const { canvas, rect } = await rasterise(node, cache, { pixelRatio, background: "#ffffff" });
        // eslint-disable-next-line no-await-in-loop
        const bytes = await canvasBytes(canvas, "image/png");
        cache.diagram.set(key, { key: `d${cache.diagram.size}`, w: rect.width * 0.75, h: rect.height * 0.75, bytes, type: "png" });
      } catch (error) {
        console.warn("Could not picture a diagram for the PDF", error);
        cache.diagram.set(key, null);
      }
      node.remove();
    }
  } finally {
    if (typeof mermaid !== "undefined") configureMermaid(theme);
    host.remove();
  }
}

// ── pictures ────────────────────────────────────────────────────────────────

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("did not load"));
    img.src = src;
  });
}

// Does a picture need PNG — see-through, or few colours (a diagram, a
// screenshot of text, which JPEG smears)?
function wantsPng(canvas) {
  const sample = document.createElement("canvas");
  sample.width = 48;
  sample.height = 48;
  const ctx = sample.getContext("2d");
  ctx.drawImage(canvas, 0, 0, 48, 48);
  const data = ctx.getImageData(0, 0, 48, 48).data;
  const colours = new Set();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) return true;
    colours.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
  }
  return colours.size <= 48;
}

async function drawPictures(needs, cache, { quality, columnWidth }) {
  const level = PICTURE_QUALITY[quality];
  const tag = `${quality}@${Math.round(columnWidth)}`;
  const todo = [...needs.images.keys()].filter((src) => !cache.image.has(`${src}#${tag}`));
  if (!todo.length) return;
  if (!level) {
    todo.forEach((src) => cache.image.set(`${src}#${tag}`, null));
    return;
  }
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed; left:-20000px; top:0; width:1px; height:1px; overflow:hidden;";
  document.body.appendChild(holder);
  try {
    const slots = todo.map((src) => {
      const slot = document.createElement("span");
      const img = document.createElement("img");
      img.setAttribute("src", src);
      img.alt = needs.images.get(src)?.alt || "";
      slot.appendChild(img);
      holder.appendChild(slot);
      return { src, slot };
    });
    // A PDF region (pdfref:) becomes a picture of its crop first, as it does
    // for every export.
    await Promise.all(slots.filter(({ src }) => src.startsWith(PDFREF_SCHEME)).map(({ slot }) => (
      mountPdfRegionPicture(slot.querySelector("img")).catch(() => {})
    )));
    await prepareExportImages(holder, { mode: "pdf" }).catch((error) => console.warn("Could not resolve pictures for the PDF", error));
    for (const { src, slot } of slots) {
      const img = slot.querySelector("img");
      const key = `${src}#${tag}`;
      try {
        if (!img?.getAttribute("src")) throw new Error("no picture");
        // eslint-disable-next-line no-await-in-loop
        const image = await loadImage(img.getAttribute("src"));
        const naturalW = image.naturalWidth;
        const naturalH = image.naturalHeight;
        if (!naturalW || !naturalH) throw new Error("empty picture");
        // The size it prints at: its own, at 96 per inch, no wider than a column.
        const printW = Math.min(naturalW * 0.75, columnWidth);
        const scale = level.dpi ? Math.min(1, (printW / 72) * level.dpi / naturalW) : 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(naturalW * scale));
        canvas.height = Math.max(1, Math.round(naturalH * scale));
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const png = wantsPng(canvas);
        if (!png) {
          // JPEG has no see-through: what was transparent would come out black.
          ctx.globalCompositeOperation = "destination-over";
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        // eslint-disable-next-line no-await-in-loop
        const bytes = png ? await canvasBytes(canvas, "image/png") : await canvasBytes(canvas, "image/jpeg", level.jpeg);
        cache.image.set(key, { key: `i${cache.image.size}`, w: naturalW * 0.75, h: naturalH * 0.75, bytes, type: png ? "png" : "jpg" });
      } catch (error) {
        console.warn("Could not put a picture in the PDF", src, error);
        cache.image.set(key, null);
      }
    }
  } finally {
    holder.remove();
  }
}

// ── words no font draws ─────────────────────────────────────────────────────

const CSS_FAMILY = {
  sans: "\"Noto Sans\", system-ui, -apple-system, \"Segoe UI\", sans-serif",
  serif: "\"Noto Serif\", Georgia, serif",
  mono: "\"JetBrains Mono\", ui-monospace, monospace"
};
const EMOJI = "\"Apple Color Emoji\", \"Segoe UI Emoji\", \"Noto Color Emoji\"";

function glyphWords(needs, fontSet, body) {
  const words = new Map();
  for (const item of needs.text) {
    const family = item.family === "body" ? body : item.family;
    for (const word of String(item.text).split(/\s+/)) {
      if (!word) continue;
      const key = glyphKey(word, family, item.bold, item.italic);
      if (words.has(key)) continue;
      if (fontSet.splitByFace(word, family, item.bold, item.italic).some((run) => !run.face)) {
        words.set(key, { word, family, bold: item.bold, italic: item.italic });
      }
    }
  }
  return words;
}

async function drawGlyphs(words, cache) {
  for (const [key, { word, family, bold, italic }] of words) {
    if (cache.glyph.has(key)) continue;
    try {
      const font = `${italic ? "italic " : ""}${bold ? 700 : 400} ${GLYPH_PX}px ${CSS_FAMILY[family] || CSS_FAMILY.sans}, ${EMOJI}`;
      const probe = document.createElement("canvas").getContext("2d");
      probe.font = font;
      const m = probe.measureText(word);
      const ascent = Math.ceil(m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || GLYPH_PX * 0.9);
      const descent = Math.ceil(m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || GLYPH_PX * 0.25);
      const width = Math.ceil(Math.max(m.width, 1));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = ascent + descent;
      const ctx = canvas.getContext("2d");
      ctx.font = font;
      ctx.fillStyle = TEXT_COLOUR;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(word, 0, ascent);
      // eslint-disable-next-line no-await-in-loop
      const bytes = await canvasBytes(canvas, "image/png");
      cache.glyph.set(key, {
        key: `g${cache.glyph.size}`,
        wPer: width / GLYPH_PX,
        hPer: (ascent + descent) / GLYPH_PX,
        ascentPer: ascent / GLYPH_PX,
        bytes,
        type: "png"
      });
    } catch (error) {
      console.warn("Could not picture a word for the PDF", word, error);
      cache.glyph.set(key, null);
    }
  }
}

// ── code colours ────────────────────────────────────────────────────────────

function loadPrismLanguages(langs) {
  const names = [...langs].map((lang) => normalizeCodeLanguage(lang)).filter((name) => name && !window.Prism?.languages?.[name]);
  const loader = window.Prism?.plugins?.autoloader;
  if (!names.length || !loader) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    try {
      loader.loadLanguages(names, () => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function prismHighlightForPdf(code, lang) {
  const name = normalizeCodeLanguage(lang);
  const grammar = name && window.Prism?.languages?.[name];
  if (!grammar) return null;
  try {
    return flattenPrismTokens(window.Prism.tokenize(code, grammar));
  } catch {
    return null;
  }
}

// ── all of it ───────────────────────────────────────────────────────────────

// Make every picture the layout will ask for. Returns the `assets` lookups the
// layout takes and the `images` map the writer embeds from.
export async function prepareAssets({ needs, options, geometry, fontSet, cache, onProgress = () => {} }) {
  const level = PICTURE_QUALITY[options.pictures];
  // Formulas and diagrams are line art: never below 150dpi, whatever the
  // photo setting, or a fraction's bar blurs.
  const artRatio = Math.max(1.6, ((level && level.dpi) || 288) / 96);
  const needsHtml = needs.maths.size || needs.diagrams.size;
  if (needsHtml && !(await ensureHtmlToImage())) console.warn("html-to-image unavailable: formulas and diagrams are left as text");
  if (needs.codeLangs.size && options.codeColours) await loadPrismLanguages(needs.codeLangs);
  if (needs.maths.size && window.htmlToImage) {
    onProgress("Drawing the formulas…");
    await drawMaths(needs, cache, { textSize: options.textSize, pixelRatio: artRatio });
  }
  if (needs.diagrams.size && window.htmlToImage) {
    onProgress("Drawing the diagrams…");
    await drawDiagrams(needs, cache, { pixelRatio: artRatio });
  }
  if (needs.images.size) {
    onProgress("Preparing the pictures…");
    await drawPictures(needs, cache, { quality: options.pictures, columnWidth: geometry.columnWidth });
  }
  const words = glyphWords(needs, fontSet, options.font === "serif" ? "serif" : "sans");
  if (words.size) await drawGlyphs(words, cache);

  const tag = `${options.pictures}@${Math.round(geometry.columnWidth)}`;
  const used = new Map();
  const use = (entry) => {
    if (entry) used.set(entry.key, { bytes: entry.bytes, type: entry.type });
    return entry;
  };
  const assets = {
    math: (key) => use(cache.math.get(`${key}@${options.textSize}`) || null),
    diagram: (key) => use(cache.diagram.get(key) || null),
    image: (src) => use(cache.image.get(`${src}#${tag}`) || null),
    glyph: (key) => use(cache.glyph.get(key) || null),
    highlight: options.codeColours ? prismHighlightForPdf : null
  };
  return { assets, images: used };
}
