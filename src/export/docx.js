// DOCX export: rendered HTML translated into OOXML, images rasterised, and the
// theme's colours resolved to literal values because Word has no CSS.

import { el } from "../core/dom.js?v=__BUILD__";
import { ensureHtmlToImage } from "../core/lib-loader.js?v=__BUILD__";
import { escapeXml, hex6 } from "../core/text.js?v=__BUILD__";
import { finishExportRoot, prepareExportRoot } from "./html.js?v=__BUILD__";
import { customImageWidthPx, displayImageSize, exportTheme, loadExportTheme } from "./themes.js?v=__BUILD__";
import { buildZipArchive, utf8Bytes } from "./zip.js?v=__BUILD__";

export function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image for Word export"));
    img.src = src;
  });
}

// Re-encodes any image (jpeg/png/gif/webp/whatever a browser can decode) to
// PNG via canvas — guarantees a single, universally Word-safe media type
// regardless of the source format's quirks.
export async function rasterizeToPng(src) {
  const img = await loadImageElement(src);
  const width = img.naturalWidth || img.width || 300;
  const height = img.naturalHeight || img.height || 200;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const buffer = await blob.arrayBuffer();
  return { bytes: new Uint8Array(buffer), widthPx: width, heightPx: height };
}

export async function svgElementToPngBytes(svg) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox?.baseVal;
  const width = Math.max(1, Math.round(rect.width) || Math.round(viewBox?.width) || 400);
  const height = Math.max(1, Math.round(rect.height) || Math.round(viewBox?.height) || 300);
  const clone = svg.cloneNode(true);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const serialized = new XMLSerializer().serializeToString(clone);
  const svgSrc = `data:image/svg+xml;base64,${bytesToBase64(utf8Bytes(serialized))}`;
  return rasterizeToPng(svgSrc);
}

// Walks the already-rendered export DOM once, rasterizing every real <img>
// (embedImagesAsDataUris already turned remote URLs into data: URIs, or
// swapped unreadable ones for a plain <a> fallback link — nothing left to
// do for those) and every <svg> diagram (mermaid/nomnoml) to PNG bytes,
// keyed by element so the XML walk below can look each one up directly.
//
// The SIZE a picture is laid out at is not its pixel size. A picture resized in
// the note keeps the width it was given (customImageWidthPx), one never resized
// is capped at the width the Notes view shows it at, and the PNG itself stays
// at full resolution so it is sharp at that size.
export const DOCX_DEFAULT_IMAGE_MAX_PX = 420;
export const DOCX_REGION_IMAGE_MAX_PX = 520;

function docxImageDisplaySize(img, pixelWidth, pixelHeight) {
  const custom = customImageWidthPx({ className: img.getAttribute("class") || "", style: img.getAttribute("style") || "" });
  if (custom) return displayImageSize(pixelWidth, pixelHeight, custom);
  const cap = img.classList.contains("highlight-export-region") ? DOCX_REGION_IMAGE_MAX_PX : DOCX_DEFAULT_IMAGE_MAX_PX;
  return displayImageSize(pixelWidth, pixelHeight, pixelWidth > cap ? cap : 0);
}

// The point size Word sets body text at (buildDocxStylesXml: 11pt), in CSS
// pixels — what a rendered formula is scaled to, so it sits in the line at the
// size of the text around it rather than at the export render's size.
const DOCX_BODY_TEXT_PX = 11 * 96 / 72;

// A KaTeX formula as a picture. Word has no KaTeX and the TeX source in a
// monospace run is not what anyone wrote the formula for.
async function mathToPng(node, fontEmbedCSS) {
  // The formula itself, not its line: a display formula's container is as wide
  // as the column, and an inline one is an inline box that html-to-image
  // measures as zero wide. Shrink-wrapped for the measurement and the drawing,
  // then put back.
  const target = node.querySelector(".katex") || node;
  const previous = target.style.display;
  target.style.display = "inline-block";
  try {
    const rect = target.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    if (!width || !height) throw new Error("Formula has no size");
    const canvas = await window.htmlToImage.toCanvas(target, {
      pixelRatio: 3,
      width,
      height,
      backgroundColor: "#ffffff",
      fontEmbedCSS,
      style: { margin: "0", color: "#111111" }
    });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Formula did not encode");
    const fontPx = parseFloat(getComputedStyle(target).fontSize) || DOCX_BODY_TEXT_PX;
    const scale = DOCX_BODY_TEXT_PX / fontPx;
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      widthPx: Math.max(1, Math.round(width * scale)),
      heightPx: Math.max(1, Math.round(height * scale))
    };
  } finally {
    target.style.display = previous;
  }
}

export async function collectDocxMedia(container) {
  const media = [];
  const elementMedia = new Map();
  let mediaIndex = 0;

  const images = Array.from(container.querySelectorAll("img[src]"));
  for (const img of images) {
    const src = img.getAttribute("src");
    if (!src || !src.startsWith("data:")) continue;
    try {
      const { bytes, widthPx, heightPx } = await rasterizeToPng(src);
      mediaIndex += 1;
      const rId = `rIdImage${mediaIndex}`;
      media.push({ rId, name: `image${mediaIndex}.png`, bytes });
      const shown = docxImageDisplaySize(img, widthPx, heightPx);
      elementMedia.set(img, { rId, widthPx: shown.width, heightPx: shown.height });
    } catch (error) {
      console.warn("Could not rasterize image for Word export:", src, error);
    }
  }

  // Formulas. Inside a formula there is no <svg> of interest, but KaTeX can
  // draw a radical or a long arrow as one — so formulas go first, and the svg
  // pass below skips anything inside one.
  const formulas = Array.from(container.querySelectorAll(".math-inline[data-tex], .math-display[data-tex]"));
  if (formulas.length && await ensureHtmlToImage().catch(() => false)) {
    let fontEmbedCSS;
    for (const node of formulas) {
      try {
        // Measured once and reused, as rasteriseRegionBlocks does: the face is
        // the same for every formula, and fetching it per formula is the slow
        // part.
        // eslint-disable-next-line no-await-in-loop
        if (fontEmbedCSS === undefined) fontEmbedCSS = await window.htmlToImage.getFontEmbedCSS(node).catch(() => "");
        // eslint-disable-next-line no-await-in-loop
        const { bytes, widthPx, heightPx } = await mathToPng(node, fontEmbedCSS);
        mediaIndex += 1;
        const rId = `rIdImage${mediaIndex}`;
        media.push({ rId, name: `image${mediaIndex}.png`, bytes });
        elementMedia.set(node, { rId, widthPx, heightPx });
      } catch (error) {
        console.warn("Could not picture a formula for Word export — keeping its TeX", error);
      }
    }
  }

  const svgs = Array.from(container.querySelectorAll("svg")).filter((svg) => !svg.closest("[data-tex]"));
  for (const svg of svgs) {
    try {
      const { bytes, widthPx, heightPx } = await svgElementToPngBytes(svg);
      mediaIndex += 1;
      const rId = `rIdImage${mediaIndex}`;
      media.push({ rId, name: `image${mediaIndex}.png`, bytes });
      elementMedia.set(svg, { rId, widthPx, heightPx });
    } catch (error) {
      console.warn("Could not rasterize diagram for Word export:", error);
    }
  }

  return { media, elementMedia };
}

export function docxImageExtent(widthPx, heightPx, maxWidthIn) {
  const emuPerPx = 9525;
  const maxWidthEmu = Math.round(maxWidthIn * 914400);
  let widthEmu = Math.round(widthPx * emuPerPx);
  let heightEmu = Math.round(heightPx * emuPerPx);
  if (widthEmu > maxWidthEmu && widthEmu > 0) {
    const scale = maxWidthEmu / widthEmu;
    widthEmu = maxWidthEmu;
    heightEmu = Math.round(heightEmu * scale);
  }
  return { widthEmu: Math.max(1, widthEmu), heightEmu: Math.max(1, heightEmu) };
}

export function ooxmlInlineImageRun(rId, widthEmu, heightEmu, docPrId, name) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="${escapeXml(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escapeXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

// The children of <w:rPr> in the order the schema lays them down (rFonts, b,
// i, strike, color, u, shd, vertAlign) — Word is strict about it, and a file
// with them out of order is one Word offers to "repair".
export function ooxmlRunProps(props, theme) {
  const parts = [];
  if (props.code) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  if (props.bold) parts.push("<w:b/>");
  if (props.italic) parts.push("<w:i/>");
  if (props.strike) parts.push("<w:strike/>");
  if (props.color) parts.push(`<w:color w:val="${hex6(props.color, theme.text)}"/>`);
  if (props.underline) parts.push('<w:u w:val="single"/>');
  // A highlight's own colour wins over code shading: it is what the reader
  // marked.
  const fill = props.highlightFill || (props.code && theme.shade !== false ? theme.panel2 : "");
  if (fill) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`);
  if (props.vertAlign) parts.push(`<w:vertAlign w:val="${props.vertAlign}"/>`);
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

// A highlight's colour on white paper: the hue at the strength
// styles/12-notes.css tints it on screen, mixed into white since Word has no
// transparency. A <mark> with no colour is yellow, as it is on screen.
export const DOCX_MARK_FILL = {
  yellow: "F4E5A6",
  green: "B2ECCA",
  blue: "C0D7FC",
  pink: "F9C8E0",
  orange: "FDD1B2",
  purple: "DCCEFC"
};

// An inline style's colour, as Word wants it, or "" — e.g. the text colour
// picker's <span style="color: …">.
function styleColorHex(value) {
  if (!value) return "";
  const resolved = resolveCssColorValue(value, "");
  return resolved || "";
}

export function ooxmlTextRun(text, props, theme) {
  if (!text) return "";
  return `<w:r>${ooxmlRunProps(props, theme)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

// Recursive inline (run-level) HTML→OOXML walk. `ctx` carries render-wide
// state (media lookup, hyperlink relationships, theme colors, doc-level
// counters); `props` carries the current run formatting inherited from
// ancestor tags (bold/italic/underline/strike/color/monospace) plus the
// max width (in inches) images should be constrained to in this context.
export function inlineRunsForNode(node, ctx, props) {
  if (node.nodeType === Node.TEXT_NODE) {
    return ooxmlTextRun(node.textContent, props, ctx.theme);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();

  if (node.dataset && node.dataset.tex) {
    const info = ctx.elementMedia.get(node);
    if (info) {
      ctx.docPrCounter.value += 1;
      const { widthEmu, heightEmu } = docxImageExtent(info.widthPx, info.heightPx, props.maxWidthIn);
      return ooxmlInlineImageRun(info.rId, widthEmu, heightEmu, ctx.docPrCounter.value, "formula");
    }
    return ooxmlTextRun(decodeURIComponent(node.dataset.tex), { ...props, code: true }, ctx.theme);
  }
  if (tag === "br") return "<w:r><w:br/></w:r>";
  if (tag === "script" || tag === "style") return "";
  // A task list's box, as the character it looks like.
  if (tag === "input" && node.getAttribute("type") === "checkbox") {
    return ooxmlTextRun(node.checked || node.hasAttribute("checked") ? "\u2611 " : "\u2610 ", props, ctx.theme);
  }

  if (tag === "img" || tag === "svg") {
    const info = ctx.elementMedia.get(node);
    if (!info) return "";
    ctx.docPrCounter.value += 1;
    const { widthEmu, heightEmu } = docxImageExtent(info.widthPx, info.heightPx, props.maxWidthIn);
    const name = tag === "img" ? (node.getAttribute("alt") || "image") : "diagram";
    return ooxmlInlineImageRun(info.rId, widthEmu, heightEmu, ctx.docPrCounter.value, name);
  }

  if (tag === "a" && node.getAttribute("href")) {
    const href = node.getAttribute("href");
    const rId = ctx.getHyperlinkRelId(href);
    const linkProps = { ...props, color: ctx.theme.accentStrong, underline: true };
    const inner = Array.from(node.childNodes).map((child) => inlineRunsForNode(child, ctx, linkProps)).join("");
    return `<w:hyperlink r:id="${rId}" w:history="1">${inner || ooxmlTextRun(href, linkProps, ctx.theme)}</w:hyperlink>`;
  }

  const nextProps = { ...props };
  if (tag === "strong" || tag === "b") nextProps.bold = true;
  if (tag === "em" || tag === "i") nextProps.italic = true;
  if (tag === "u") nextProps.underline = true;
  if (tag === "del" || tag === "s" || tag === "strike") nextProps.strike = true;
  if (tag === "kbd" || tag === "code") nextProps.code = true;
  if (tag === "sup") nextProps.vertAlign = "superscript";
  if (tag === "sub") nextProps.vertAlign = "subscript";
  if (tag === "mark") {
    nextProps.highlightFill = DOCX_MARK_FILL[node.getAttribute("data-color")] || DOCX_MARK_FILL.yellow;
  }
  if (tag === "font") {
    const color = node.getAttribute("color");
    if (color) nextProps.color = color;
  }
  // The text and background colour pickers write inline styles. Plain prints
  // in black, so a text colour is dropped there; a background is kept in every
  // look, as a highlight is.
  if (node.style?.color && ctx.theme.colored !== false) {
    const color = styleColorHex(node.style.color);
    if (color) nextProps.color = color;
  }
  if (node.style?.backgroundColor && tag !== "mark") {
    const fill = styleColorHex(node.style.backgroundColor);
    if (fill && fill !== "FFFFFF") nextProps.highlightFill = fill;
  }

  return Array.from(node.childNodes).map((child) => inlineRunsForNode(child, ctx, nextProps)).join("");
}

export function childInlineRuns(node, ctx, props) {
  return Array.from(node.childNodes).map((child) => inlineRunsForNode(child, ctx, props)).join("");
}

// The children of <w:pPr> in schema order (pStyle, numPr, pBdr, shd, spacing,
// ind, jc) — see ooxmlRunProps.
export function ooxmlParagraph(runsXml, pProps = {}) {
  const parts = [];
  if (pProps.styleId) parts.push(`<w:pStyle w:val="${pProps.styleId}"/>`);
  if (pProps.numId) parts.push(`<w:numPr><w:ilvl w:val="${pProps.ilvl || 0}"/><w:numId w:val="${pProps.numId}"/></w:numPr>`);
  const borders = [];
  if (pProps.borderLeftColor) borders.push(`<w:left w:val="single" w:sz="18" w:space="8" w:color="${pProps.borderLeftColor}"/>`);
  if (pProps.borderBottomColor) borders.push(`<w:bottom w:val="single" w:sz="6" w:space="1" w:color="${pProps.borderBottomColor}"/>`);
  if (borders.length) parts.push(`<w:pBdr>${borders.join("")}</w:pBdr>`);
  if (pProps.shadeFill) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${pProps.shadeFill}"/>`);
  if (pProps.spacingAfter != null) parts.push(`<w:spacing w:after="${pProps.spacingAfter}"/>`);
  if (pProps.indentLeftTwips) parts.push(`<w:ind w:left="${pProps.indentLeftTwips}"/>`);
  if (pProps.jc) parts.push(`<w:jc w:val="${pProps.jc}"/>`);
  const pPr = parts.length ? `<w:pPr>${parts.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

// A block's own alignment — `style="text-align: center"` or the older
// `align="center"` — as Word's <w:jc>, or undefined to leave it as inherited.
const DOCX_JC_BY_ALIGN = { left: "left", start: "left", center: "center", right: "right", end: "right", justify: "both" };

export function blockAlignment(node) {
  const value = (node.style?.textAlign || node.getAttribute?.("align") || "").toLowerCase();
  return DOCX_JC_BY_ALIGN[value];
}

// True for a paragraph holding nothing but one picture or formula: it is laid
// out as a figure, centred, as the Notes view shows it. A picture in a sentence
// stays where it is in the sentence.
function isLonePicture(node) {
  const meaningful = Array.from(node.childNodes).filter((child) => child.nodeType === Node.ELEMENT_NODE || child.textContent.trim());
  if (meaningful.length !== 1 || meaningful[0].nodeType !== Node.ELEMENT_NODE) return false;
  const only = meaningful[0];
  return /^(img|svg)$/i.test(only.tagName) || only.classList.contains("math-display");
}

// `base` wins, except where it says nothing: a key left undefined (a paragraph
// with no alignment of its own) keeps the override's value rather than erasing
// it.
export function mergeOverride(base, override) {
  const merged = { ...override };
  Object.entries(base).forEach(([key, value]) => {
    if (value !== undefined) merged[key] = value;
  });
  return merged;
}

export function withScope(ctx, patch) {
  return { ...ctx, ...patch };
}

// Six levels, six styles. h5 and h6 used to fold into Heading4, which was
// harmless while the sizes did the work of telling levels apart and is not now
// that they don't — see buildDocxStylesXml, where all six are one size and the
// hierarchy is carried by weight, colour and the underline, exactly as
// styles/06-rendered.css carries it on screen.
export const DOCX_HEADING_STYLE_BY_LEVEL = { 1: "Heading1", 2: "Heading2", 3: "Heading3", 4: "Heading4", 5: "Heading5", 6: "Heading6" };

export const DOCX_NESTED_BLOCK_TAGS = new Set(["ul", "ol", "p", "pre", "blockquote", "table", "div"]);

export function childBlocks(node, ctx) {
  const blocks = [];
  Array.from(node.childNodes).forEach((child) => {
    blocksForNode(child, ctx).forEach((block) => blocks.push(block));
  });
  return blocks;
}

export function blocksForListItem(li, ctx, numId) {
  const inlineChildren = [];
  const nestedElements = [];
  Array.from(li.childNodes).forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE && DOCX_NESTED_BLOCK_TAGS.has(child.tagName.toLowerCase())) {
      nestedElements.push(child);
    } else {
      inlineChildren.push(child);
    }
  });
  const runs = inlineChildren.map((child) => inlineRunsForNode(child, ctx, ctx.inlineProps)).join("");
  const itemProps = mergeOverride({ numId, ilvl: Math.min(ctx.listDepth, 3), spacingAfter: 40 }, ctx.blockOverride);
  const blocks = [ooxmlParagraph(runs, itemProps)];
  nestedElements.forEach((nested) => {
    const tag = nested.tagName.toLowerCase();
    const nestedCtx = tag === "ul" || tag === "ol" ? withScope(ctx, { listDepth: ctx.listDepth + 1 }) : ctx;
    blocksForNode(nested, nestedCtx).forEach((block) => blocks.push(block));
  });
  return blocks;
}

export function tcXml(cellBlocks, { widthTwips, shadeFill, theme } = {}) {
  const parts = [];
  if (widthTwips) parts.push(`<w:tcW w:w="${widthTwips}" w:type="dxa"/>`);
  if (shadeFill) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${shadeFill}"/>`);
  parts.push(`<w:tcBorders><w:top w:val="single" w:sz="4" w:color="${theme.line}"/><w:left w:val="single" w:sz="4" w:color="${theme.line}"/><w:bottom w:val="single" w:sz="4" w:color="${theme.line}"/><w:right w:val="single" w:sz="4" w:color="${theme.line}"/></w:tcBorders>`);
  const tcPr = `<w:tcPr>${parts.join("")}</w:tcPr>`;
  const body = cellBlocks.length ? cellBlocks.join("") : ooxmlParagraph("");
  return `<w:tc>${tcPr}${body}</w:tc>`;
}

export const DOCX_PAGE_WIDTH_TWIPS = 10080;

export function tableToOoxml(table, ctx) {
  const theme = ctx.theme;
  const borderBlock = `<w:tblBorders><w:top w:val="single" w:sz="4" w:color="${theme.line}"/><w:left w:val="single" w:sz="4" w:color="${theme.line}"/><w:bottom w:val="single" w:sz="4" w:color="${theme.line}"/><w:right w:val="single" w:sz="4" w:color="${theme.line}"/><w:insideH w:val="single" w:sz="4" w:color="${theme.line}"/><w:insideV w:val="single" w:sz="4" w:color="${theme.line}"/></w:tblBorders>`;

  if (table.classList.contains("cornell-flat-row")) {
    const questionTd = table.querySelector(".cornell-flat-question");
    const answerTd = table.querySelector(".cornell-flat-answer");
    const questionWidth = Math.round(DOCX_PAGE_WIDTH_TWIPS * 0.34);
    const answerWidth = DOCX_PAGE_WIDTH_TWIPS - questionWidth;
    const questionBlocks = questionTd ? childBlocks(questionTd, withScope(ctx, { maxWidthIn: questionWidth / 1440 })) : [];
    const answerBlocks = answerTd ? childBlocks(answerTd, withScope(ctx, { maxWidthIn: answerWidth / 1440 })) : [];
    return `<w:tbl><w:tblPr><w:tblW w:w="${DOCX_PAGE_WIDTH_TWIPS}" w:type="dxa"/>${borderBlock}</w:tblPr><w:tblGrid><w:gridCol w:w="${questionWidth}"/><w:gridCol w:w="${answerWidth}"/></w:tblGrid><w:tr>${tcXml(questionBlocks, { widthTwips: questionWidth, shadeFill: theme.panel2, theme })}${tcXml(answerBlocks, { widthTwips: answerWidth, shadeFill: theme.card, theme })}</w:tr></w:tbl>`;
  }

  if (table.classList.contains("flat-export-divider")) {
    const cell = table.querySelector("td") || table;
    const blocks = childBlocks(cell, withScope(ctx, { blockOverride: mergeOverride({ jc: "center" }, ctx.blockOverride) }));
    return `<w:tbl><w:tblPr><w:tblW w:w="${DOCX_PAGE_WIDTH_TWIPS}" w:type="dxa"/><w:tblBorders><w:top w:val="dashed" w:sz="6" w:color="${theme.line}"/><w:left w:val="dashed" w:sz="6" w:color="${theme.line}"/><w:bottom w:val="dashed" w:sz="6" w:color="${theme.line}"/><w:right w:val="dashed" w:sz="6" w:color="${theme.line}"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="${DOCX_PAGE_WIDTH_TWIPS}"/></w:tblGrid><w:tr>${tcXml(blocks, { widthTwips: DOCX_PAGE_WIDTH_TWIPS, theme })}</w:tr></w:tbl>`;
  }

  // Genuine markdown table.
  const rows = Array.from(table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr"));
  const columnCount = rows.reduce((max, row) => Math.max(max, row.children.length), 0) || 1;
  const colWidth = Math.round(DOCX_PAGE_WIDTH_TWIPS / columnCount);
  const cellCtx = withScope(ctx, { maxWidthIn: colWidth / 1440 });
  const rowsXml = rows.map((row) => {
    const cellsXml = Array.from(row.children).map((cell) => {
      const isHeader = cell.tagName.toLowerCase() === "th";
      const blocks = childBlocks(cell, cellCtx);
      return tcXml(blocks.length ? blocks : [ooxmlParagraph(childInlineRuns(cell, cellCtx, cellCtx.inlineProps))], {
        widthTwips: colWidth,
        shadeFill: isHeader ? theme.panel2 : undefined,
        theme
      });
    }).join("");
    return `<w:tr>${cellsXml}</w:tr>`;
  }).join("");

  return `<w:tbl><w:tblPr><w:tblW w:w="${DOCX_PAGE_WIDTH_TWIPS}" w:type="dxa"/>${borderBlock}</w:tblPr><w:tblGrid>${"<w:gridCol w:w=\"" + colWidth + "\"/>".repeat(columnCount)}</w:tblGrid>${rowsXml}</w:tbl>`;
}

// Recursive block-level HTML→OOXML walk, dispatched by tag name. Produces
// an array of block XML strings (each a <w:p> paragraph or a <w:tbl>
// table) — never nested inside one another, matching how WordprocessingML
// requires block content to be siblings under <w:body> or <w:tc>.
export function blocksForNode(node, ctx) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.replace(/\s+/g, " ");
    return text.trim() ? [ooxmlParagraph(ooxmlTextRun(text, ctx.inlineProps, ctx.theme), ctx.blockOverride)] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const tag = node.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "button") return [];

  if (/^h[1-6]$/.test(tag)) {
    const runs = childInlineRuns(node, ctx, ctx.inlineProps);
    return [ooxmlParagraph(runs, mergeOverride({ styleId: DOCX_HEADING_STYLE_BY_LEVEL[Number(tag[1])], spacingAfter: 120, jc: blockAlignment(node) }, ctx.blockOverride))];
  }

  if (tag === "p") {
    const jc = blockAlignment(node) || (isLonePicture(node) ? "center" : undefined);
    // A picture in the middle of a sentence is laid out on its own line in the
    // Notes view (.rendered img is a centred block), so here too: the
    // paragraph is cut around it, and the picture gets a centred paragraph of
    // its own — rather than a 400px picture sitting on one line of text.
    if (!isLonePicture(node) && node.querySelector(":scope > img, :scope > svg, :scope > a > img")) {
      const blocks = [];
      let pending = [];
      const flush = () => {
        // The space either side of the picture belonged between the words and
        // the picture; on a line of its own it would be a leading space.
        if (pending[0]?.nodeType === Node.TEXT_NODE) pending[0] = document.createTextNode(pending[0].textContent.trimStart());
        const last = pending.length - 1;
        if (pending[last]?.nodeType === Node.TEXT_NODE) pending[last] = document.createTextNode(pending[last].textContent.trimEnd());
        const runs = pending.map((child) => inlineRunsForNode(child, ctx, ctx.inlineProps)).join("");
        if (runs && pending.some((child) => child.nodeType !== Node.TEXT_NODE || child.textContent.trim())) {
          blocks.push(ooxmlParagraph(runs, mergeOverride({ spacingAfter: 160, jc: blockAlignment(node) }, ctx.blockOverride)));
        }
        pending = [];
      };
      Array.from(node.childNodes).forEach((child) => {
        const picture = child.nodeType === Node.ELEMENT_NODE
          && (/^(img|svg)$/i.test(child.tagName) || (child.tagName === "A" && child.querySelector(":scope > img")));
        if (!picture) { pending.push(child); return; }
        flush();
        const runs = inlineRunsForNode(child, ctx, ctx.inlineProps);
        if (runs) blocks.push(ooxmlParagraph(runs, mergeOverride({ jc: "center", spacingAfter: 160 }, ctx.blockOverride)));
      });
      flush();
      return blocks;
    }
    const runs = childInlineRuns(node, ctx, ctx.inlineProps);
    return runs ? [ooxmlParagraph(runs, mergeOverride({ spacingAfter: 160, jc }, ctx.blockOverride))] : [];
  }

  // A display formula: one centred paragraph, its picture or its TeX.
  if (node.dataset?.tex) {
    const runs = inlineRunsForNode(node, ctx, ctx.inlineProps);
    return runs ? [ooxmlParagraph(runs, mergeOverride({ jc: "center", spacingAfter: 160 }, ctx.blockOverride))] : [];
  }

  if (tag === "hr") {
    return [ooxmlParagraph("", mergeOverride({ borderBottomColor: ctx.theme.line, spacingAfter: 160 }, ctx.blockOverride))];
  }

  // Diagrams (mermaid/nomnoml) render as a bare <svg> sitting directly
  // inside a block-level wrapper div, not inside a <p> — so unlike an <img>
  // (which marked.js always wraps in a paragraph), this needs its own
  // block case. Without it, the fallback below would descend into the
  // SVG's internal <text> elements and leak out raw diagram label text
  // instead of embedding the rasterized image.
  if (tag === "svg" || tag === "img") {
    const runs = inlineRunsForNode(node, ctx, ctx.inlineProps);
    return runs ? [ooxmlParagraph(runs, mergeOverride({ jc: "center", spacingAfter: 160 }, ctx.blockOverride))] : [];
  }

  if (tag === "blockquote") {
    const nextOverride = mergeOverride({ indentLeftTwips: 360, borderLeftColor: ctx.theme.accent }, ctx.blockOverride);
    return childBlocks(node, withScope(ctx, { blockOverride: nextOverride, inlineProps: { ...ctx.inlineProps, color: ctx.theme.muted } }));
  }

  if (tag === "ul" || tag === "ol") {
    const numId = tag === "ul" ? ctx.bulletNumId : ctx.decimalNumId;
    const blocks = [];
    Array.from(node.children).forEach((li) => {
      if (li.tagName.toLowerCase() !== "li") return;
      blocksForListItem(li, ctx, numId).forEach((block) => blocks.push(block));
    });
    return blocks;
  }

  if (tag === "pre") {
    const codeEl = node.querySelector("code") || node;
    const text = codeEl.textContent.replace(/\n+$/, "");
    const lines = text.length ? text.split("\n") : [""];
    return lines.map((line) => ooxmlParagraph(
      ooxmlTextRun(line || " ", { ...ctx.inlineProps, code: true }, ctx.theme),
      mergeOverride({ shadeFill: ctx.theme.panel2, spacingAfter: 0 }, ctx.blockOverride)
    ));
  }

  if (tag === "table") {
    return [tableToOoxml(node, ctx)];
  }

  const jc = blockAlignment(node);
  if (jc) return childBlocks(node, withScope(ctx, { blockOverride: mergeOverride({ jc }, ctx.blockOverride) }));
  return childBlocks(node, ctx);
}

export function createDocxRenderContext(elementMedia, theme) {
  const hyperlinkCache = new Map();
  const hyperlinks = [];
  return {
    elementMedia,
    theme,
    docPrCounter: { value: 0 },
    hyperlinks,
    getHyperlinkRelId(url) {
      if (hyperlinkCache.has(url)) return hyperlinkCache.get(url);
      const rId = `rIdLink${hyperlinks.length + 1}`;
      hyperlinks.push({ rId, url });
      hyperlinkCache.set(url, rId);
      return rId;
    },
    bulletNumId: 1,
    decimalNumId: 2,
    blockOverride: {},
    inlineProps: { maxWidthIn: DOCX_PAGE_WIDTH_TWIPS / 1440 },
    listDepth: 0
  };
}

// Resolves any valid CSS color expression (a plain hex custom property, a
// var() reference, or a color-mix() expression) to a concrete hex string by
// actually applying it to a real CSS property on a throwaway element and
// reading back the browser's resolved value — custom properties don't
// evaluate functions like color-mix() themselves (they're just substituted
// token text), but a real used property always does.
export function resolveCssColorValue(expression, fallbackHex) {
  if (!expression) return fallbackHex;
  const probe = document.createElement("div");
  probe.style.display = "none";
  probe.style.color = expression;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  // Plain rgb()/rgba() — 0–255 integers.
  const rgbMatch = resolved.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch.slice(1, 4).map((n) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))));
    return [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  // A color-mix() result (used by --print-question/--print-accent-strong)
  // resolves in Chromium to the CSS Color 4 `color(srgb r g b)` syntax —
  // 0–1 floats, not 0–255 — which the rgb() regex above never matches, so
  // this silently fell back to the hardcoded default for every theme.
  const colorFnMatch = resolved.match(/color\([a-z0-9-]+\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (colorFnMatch) {
    const [r, g, b] = colorFnMatch.slice(1, 4).map((n) => Math.max(0, Math.min(255, Math.round(parseFloat(n) * 255))));
    return [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  return fallbackHex;
}

// A Word document page is always white paper — reusing the app's live
// theme colors verbatim would be unreadable for any dark theme (near-white
// text on a white page). The app already solves exactly this problem for
// the Cornell PDF export with a fixed, always-print-safe --print-* palette
// (only its accent tracks the live theme); the .docx export reuses that
// same palette rather than inventing its own.
export function docxThemeFromPrintVars() {
  const computed = getComputedStyle(document.documentElement);
  const raw = (name) => computed.getPropertyValue(name).trim();
  const resolve = (name, fallbackHex) => resolveCssColorValue(raw(name), fallbackHex);
  return {
    card: resolve("--print-surface", "FFFFFF"),
    panel2: resolve("--print-question", "F0EEE7"),
    text: resolve("--print-text", "17201C"),
    muted: resolve("--print-muted", "56645F"),
    line: resolve("--print-line", "B9C9C5"),
    accent: resolve("--print-accent", "16796C"),
    accentStrong: resolve("--print-accent-strong", "0D5E53")
  };
}

// The colours and faces of one look (src/export/themes.js) for Word. Fancy is
// the print palette the PDF uses, with its accent following the app's theme;
// Minimal keeps that accent and nothing else; Plain is black on white.
export function docxThemeFor(themeId) {
  const look = exportTheme(themeId);
  const printVars = docxThemeFromPrintVars();
  const colors = look.id === "plain"
    ? { card: "FFFFFF", panel2: "FFFFFF", text: "111111", muted: "444444", line: "9A9A9A", accent: "111111", accentStrong: "111111" }
    : look.id === "minimal"
      ? { card: "FFFFFF", panel2: "F6F8FA", text: "1F2328", muted: "59636E", line: "D8DEE4", accent: printVars.accent, accentStrong: printVars.accentStrong }
      : printVars;
  return { id: look.id, ...colors, ...look.docx };
}

export const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

export const DOCX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

export const DOCX_NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0">
${[0, 1, 2, 3].map((lvl) => `<w:lvl w:ilvl="${lvl}"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:pPr><w:ind w:left="${720 + lvl * 720}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>`).join("\n")}
</w:abstractNum>
<w:abstractNum w:abstractNumId="1">
${[0, 1, 2, 3].map((lvl) => `<w:lvl w:ilvl="${lvl}"><w:numFmt w:val="decimal"/><w:lvlText w:val="%${lvl + 1}."/><w:pPr><w:ind w:left="${720 + lvl * 720}" w:hanging="360"/></w:pPr></w:lvl>`).join("\n")}
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

// One heading style. `rules` says which levels are underlined and how:
// "ladder" is the Notes view's (styles/06-rendered.css) — every level a
// different rule, colour and weight at one size; "light" is a hairline under
// the two chapter levels; none at all for Plain, where size does the work.
const DOCX_LADDER = [
  { border: "single", sz: 12, colorKey: "accent", textKey: "accentStrong", before: 240, after: 120 },
  { border: "single", sz: 12, colorKey: "accent", textKey: "text", before: 200, after: 100 },
  { border: "single", sz: 8, colorKey: "accentStrong", textKey: "accentStrong", before: 160, after: 80 },
  { border: "dashed", sz: 8, colorKey: "text", textKey: "text", before: 120, after: 60 },
  { border: "dotted", sz: 8, colorKey: "muted", textKey: "muted", before: 120, after: 60 },
  { border: "dotted", sz: 4, colorKey: "line", textKey: "muted", before: 120, after: 60 }
];

function docxHeadingStyleXml(level, theme) {
  const step = DOCX_LADDER[level - 1];
  const size = theme.headingSizes?.[level - 1] || 22;
  let border = "";
  let textColor = theme.text;
  if (theme.rules === "ladder") {
    border = `<w:pBdr><w:bottom w:val="${step.border}" w:sz="${step.sz}" w:space="2" w:color="${theme[step.colorKey]}"/></w:pBdr>`;
    textColor = theme[step.textKey];
  } else if (theme.rules === "light") {
    if (level <= 2) border = `<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="${level === 1 ? theme.accent : theme.line}"/></w:pBdr>`;
    textColor = level === 1 ? theme.accentStrong : level >= 5 ? theme.muted : theme.text;
  }
  const italic = theme.id === "plain" && level >= 5 ? "<w:i/>" : "";
  const font = theme.headingFont ? `<w:rFonts w:ascii="${theme.headingFont}" w:hAnsi="${theme.headingFont}" w:cs="${theme.headingFont}"/>` : "";
  return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/>${border}<w:spacing w:before="${step.before}" w:after="${step.after}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr>${font}<w:b/>${italic}<w:color w:val="${textColor}"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
}

export function buildDocxStylesXml(theme) {
  const font = theme.font || "Calibri";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/><w:color w:val="${theme.text}"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${[1, 2, 3, 4, 5, 6].map((level) => docxHeadingStyleXml(level, theme)).join("\n")}
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="${theme.accentStrong}"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;
}

export function buildDocxCoreXml(title) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>Recall</dc:creator>
<cp:lastModifiedBy>Recall</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

export const DOCX_APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Recall</Application></Properties>`;

export function buildDocxDocumentRelsXml(media, hyperlinks) {
  const mediaRels = media.map(({ rId, name }) => `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`).join("\n");
  const linkRels = hyperlinks.map(({ rId, url }) => `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(url)}" TargetMode="External"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${mediaRels}
${linkRels}
</Relationships>`;
}

export function buildDocxDocumentXml(bodyBlocksXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${bodyBlocksXml}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`;
}

// Ties the whole pipeline together: mounts+renders+embeds bodyHtml (same
// as the HTML/PDF exports), rasterizes its images/diagrams to PNG media
// parts, walks the DOM into WordprocessingML, and zips it all into a real
// .docx byte stream.
//
// `theme` is the look asked for at export time (src/export/themes.js).
export async function buildDocxBytes(bodyHtml, title, { theme: themeId = loadExportTheme() } = {}) {
  const failedImageCount = await prepareExportRoot(bodyHtml, { mode: "docx" });
  const { media, elementMedia } = await collectDocxMedia(el.printRoot);
  const theme = docxThemeFor(themeId);
  const ctx = createDocxRenderContext(elementMedia, theme);
  const bodyBlocksXml = childBlocks(el.printRoot, ctx).join("\n");
  finishExportRoot();

  const documentXml = buildDocxDocumentXml(bodyBlocksXml);
  const documentRelsXml = buildDocxDocumentRelsXml(media, ctx.hyperlinks);
  const stylesXml = buildDocxStylesXml(theme);
  const coreXml = buildDocxCoreXml(title);

  const files = [
    { name: "[Content_Types].xml", data: utf8Bytes(DOCX_CONTENT_TYPES) },
    { name: "_rels/.rels", data: utf8Bytes(DOCX_ROOT_RELS) },
    { name: "docProps/core.xml", data: utf8Bytes(coreXml) },
    { name: "docProps/app.xml", data: utf8Bytes(DOCX_APP_XML) },
    { name: "word/document.xml", data: utf8Bytes(documentXml) },
    { name: "word/styles.xml", data: utf8Bytes(stylesXml) },
    { name: "word/numbering.xml", data: utf8Bytes(DOCX_NUMBERING_XML) },
    { name: "word/_rels/document.xml.rels", data: utf8Bytes(documentRelsXml) },
    ...media.map(({ name, bytes }) => ({ name: `word/media/${name}`, data: bytes }))
  ];

  return { bytes: buildZipArchive(files), failedImageCount };
}
