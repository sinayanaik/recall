// Markdown → PDF, in the browser: the steps in order, with what they keep.
//
//   markdown ─ preprocessSpecialBlocks (the Notes view's own pass) ─ marked's
//   lexer ─ blocks ─ fonts (md-pdf/fonts.js) ─ pictures (md-pdf/assets.js) ─
//   layout (one continuous column of rows) ─ plan (page breaks) ─ bytes
//
// A session keeps the fonts and pictures it has made, so the dialog can lay the
// markdown out again on every edit and pay only for what changed. The planner
// and the writer are cheap; the layout is a few milliseconds a page.

import { ensurePdfLib } from "../../core/lib-loader.js?v=__BUILD__";
import { preprocessSpecialBlocks } from "../../render/preprocess.js?v=__BUILD__";
import { createAssetCache, prepareAssets } from "./assets.js?v=__BUILD__";
import { planPages, previewPlan } from "./breaks.js?v=__BUILD__";
import { createFontSet, facesNeeded } from "./fonts-core.js?v=__BUILD__";
import { MD_PDF_OFFLINE_FACES, loadFaces } from "./fonts.js?v=__BUILD__";
import { blocksFromTokens, collectNeeds, layoutMarkdown, normalizeMdPdfOptions, pageGeometry } from "./layout.js?v=__BUILD__";
import { writeMarkdownPdf } from "./writer.js?v=__BUILD__";

export class MdPdfError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// The first heading's words, or the first line's: what a PDF made from this
// markdown is called unless it is named.
export function markdownTitle(markdown) {
  const text = String(markdown || "");
  const heading = text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  const line = heading ? heading[1] : (text.split("\n").find((l) => l.trim()) || "");
  return line.replace(/[*_`[\]]/g, "").replace(/\]\([^)]*\)/g, "").trim().slice(0, 80);
}

export function createMdPdfSession() {
  const cache = createAssetCache();

  // Markdown and options → a laid-out column, ready to plan and write.
  async function layout(markdown, options, { match = null, onProgress = () => {} } = {}) {
    if (typeof window.marked?.lexer !== "function") throw new MdPdfError("marked", "The markdown reader did not load");
    const o = normalizeMdPdfOptions(options);
    const geometry = pageGeometry(o, match);
    const blocks = blocksFromTokens(window.marked.lexer(preprocessSpecialBlocks(markdown || "")));
    const needs = collectNeeds(blocks);
    const body = o.font === "serif" ? "serif" : "sans";
    const faces = new Set(MD_PDF_OFFLINE_FACES.filter((face) => face.startsWith(`${body}|`) || face.startsWith("mono|")));
    for (const item of needs.text) facesNeeded(item.text, item.family === "body" ? body : item.family, item.bold, item.italic, faces);
    onProgress("Loading the fonts…");
    let loaded;
    try {
      loaded = await loadFaces(faces);
    } catch (error) {
      throw new MdPdfError("fonts", "The PDF fonts need a connection the first time");
    }
    if (![...loaded.fonts.keys()].some((face) => face.startsWith(`${body}|latin|400|normal`))) {
      throw new MdPdfError("fonts", "The PDF fonts need a connection the first time");
    }
    const fontSet = createFontSet(loaded.fonts);
    const { assets, images } = await prepareAssets({ needs, options: o, geometry, fontSet, cache, onProgress });
    const flow = layoutMarkdown({ blocks, fontSet, options: o, geometry, assets });
    return { flow, fontSet, fontBytes: loaded.bytes, images, options: o, missingFaces: loaded.missing };
  }

  function plan(laid, cuts = null) {
    return planPages(laid.flow, { cuts });
  }

  async function write(laid, thePlan, { title = "", part = null, deferInternalLinks = false, preview = false } = {}) {
    if (!(await ensurePdfLib())) throw new MdPdfError("pdf-lib", "The PDF writer did not load");
    const usePlan = preview ? previewPlan(laid.flow) : thePlan;
    if (!usePlan.pages.length) throw new MdPdfError("empty", "There is nothing to put in a PDF yet");
    return writeMarkdownPdf({
      PDFLib: window.PDFLib,
      fontkit: window.fontkit,
      flow: laid.flow,
      plan: usePlan,
      fontBytes: laid.fontBytes,
      images: laid.images,
      title,
      part,
      deferInternalLinks,
      pageNumbers: preview ? false : null
    });
  }

  return { layout, plan, write, cache };
}
