// DOCX export: rendered HTML translated into OOXML, images rasterised, and the
// theme's colours resolved to literal values because Word has no CSS.

import { escapeXml, hex6 } from "../core/text.js?v=__BUILD__";
import { utf8Bytes } from "./zip.js?v=__BUILD__";

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
      elementMedia.set(img, { rId, widthPx, heightPx });
    } catch (error) {
      console.warn("Could not rasterize image for Word export:", src, error);
    }
  }

  const svgs = Array.from(container.querySelectorAll("svg"));
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

export function ooxmlRunProps(props, theme) {
  const parts = [];
  if (props.bold) parts.push("<w:b/>");
  if (props.italic) parts.push("<w:i/>");
  if (props.underline) parts.push('<w:u w:val="single"/>');
  if (props.strike) parts.push("<w:strike/>");
  if (props.code) {
    parts.push(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="${theme.panel2}"/>`);
  }
  if (props.color) parts.push(`<w:color w:val="${hex6(props.color, theme.text)}"/>`);
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
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
    return ooxmlTextRun(decodeURIComponent(node.dataset.tex), { ...props, code: true }, ctx.theme);
  }
  if (tag === "br") return "<w:r><w:br/></w:r>";
  if (tag === "script" || tag === "style") return "";

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
  if (tag === "del") nextProps.strike = true;
  if (tag === "kbd" || tag === "code") nextProps.code = true;
  if (tag === "font") {
    const color = node.getAttribute("color");
    if (color) nextProps.color = color;
  }

  return Array.from(node.childNodes).map((child) => inlineRunsForNode(child, ctx, nextProps)).join("");
}

export function childInlineRuns(node, ctx, props) {
  return Array.from(node.childNodes).map((child) => inlineRunsForNode(child, ctx, props)).join("");
}

export function ooxmlParagraph(runsXml, pProps = {}) {
  const parts = [];
  if (pProps.styleId) parts.push(`<w:pStyle w:val="${pProps.styleId}"/>`);
  if (pProps.numId) parts.push(`<w:numPr><w:ilvl w:val="${pProps.ilvl || 0}"/><w:numId w:val="${pProps.numId}"/></w:numPr>`);
  if (pProps.jc) parts.push(`<w:jc w:val="${pProps.jc}"/>`);
  if (pProps.indentLeftTwips) parts.push(`<w:ind w:left="${pProps.indentLeftTwips}"/>`);
  const borders = [];
  if (pProps.borderLeftColor) borders.push(`<w:left w:val="single" w:sz="18" w:space="8" w:color="${pProps.borderLeftColor}"/>`);
  if (pProps.borderBottomColor) borders.push(`<w:bottom w:val="single" w:sz="6" w:space="1" w:color="${pProps.borderBottomColor}"/>`);
  if (borders.length) parts.push(`<w:pBdr>${borders.join("")}</w:pBdr>`);
  if (pProps.shadeFill) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${pProps.shadeFill}"/>`);
  if (pProps.spacingAfter != null) parts.push(`<w:spacing w:after="${pProps.spacingAfter}"/>`);
  const pPr = parts.length ? `<w:pPr>${parts.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

export function mergeOverride(base, override) {
  return { ...override, ...base };
}

export function withScope(ctx, patch) {
  return { ...ctx, ...patch };
}

export const DOCX_HEADING_STYLE_BY_LEVEL = { 1: "Heading1", 2: "Heading2", 3: "Heading3", 4: "Heading4", 5: "Heading4", 6: "Heading4" };

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
    return [ooxmlParagraph(runs, mergeOverride({ styleId: DOCX_HEADING_STYLE_BY_LEVEL[Number(tag[1])], spacingAfter: 120 }, ctx.blockOverride))];
  }

  if (tag === "p") {
    const runs = childInlineRuns(node, ctx, ctx.inlineProps);
    return runs ? [ooxmlParagraph(runs, mergeOverride({ spacingAfter: 160 }, ctx.blockOverride))] : [];
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
