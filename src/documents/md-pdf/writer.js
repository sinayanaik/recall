// Markdown → PDF: the bytes.
//
// The pages the planner chose (md-pdf/breaks.js), drawn with pdf-lib: real
// text in the embedded, subsetted fonts (md-pdf/fonts-core.js), backgrounds
// and rules as vector paths, pictures as images. A page of text is a few KB.
//
// Also written, because they cost almost nothing and are what make a long PDF
// usable: the headings as the PDF's bookmarks (/Outlines — what the PDFs tab's
// contents panel, src/documents/pdf-outline.js, and every other reader show),
// links that open (URI) or jump (a #heading link, to the heading's page), and
// page numbers when asked for.
//
// Pure in its inputs: handed the pdf-lib namespace, fontkit, the layout, the
// plan, the font bytes and the picture bytes, it returns bytes — so
// tools/md-pdf-check.mjs drives it in Node with no browser.

import { mdFontFeatures } from "./fonts-core.js?v=__BUILD__";
import { slugify } from "./layout.js?v=__BUILD__";
import { MD_GOTO_KEY, tagPages, writePartData } from "./parts.js?v=__BUILD__";

const mdPdfColour = (PDFLib, value) => {
  const v = String(value || "#000000").replace("#", "");
  const n = parseInt(v.length === 3 ? v.split("").map((c) => c + c).join("") : v, 16) || 0;
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const SAFE_URI = /^(https?:|mailto:|tel:)/i;

// The column pieces of the plan placed on pages: for every row, the page it
// is on and where its top is, in PDF user space (y up).
export function placeRows(flow, plan) {
  const { rows, geometry: g } = flow;
  const places = new Array(rows.length).fill(null);
  plan.pages.forEach((page, p) => {
    page.slices.forEach((s, column) => {
      const slice = plan.slices[s];
      const colX = g.marginX + column * (g.columnWidth + g.gutter);
      const repeat = slice.from > 0 && rows[slice.from].repeat ? rows[slice.from].repeat.h : 0;
      const top = page.height - g.marginTop;
      for (let i = slice.from; i < slice.to; i += 1) {
        places[i] = { page: p, x: colX, top: top - repeat - (rows[i].y - rows[slice.from].y), column };
      }
    });
  });
  return places;
}

// Write the PDF.
//
//   PDFLib, fontkit   the libraries (window.PDFLib, window.fontkit)
//   flow              layoutMarkdown's result
//   plan              planPages' result
//   fontBytes         Map faceKey → Uint8Array (.woff)
//   images            Map key → { bytes: Uint8Array, type: "png" | "jpg" }
//   title             the document title (metadata)
//   part              { id, data } — the markdown this was made from, kept in
//                     the file (md-pdf/parts.js) so it can be edited again
//   deferInternalLinks  write #heading links as page indices, for pages that
//                     will be copied into another PDF (parts.js, splicePart)
//
// Returns { bytes, pageCount, pageSizes, places, textRuns } — textRuns is, per
// page, every text operator as drawn ({ text, x, y, size, face }), which is how
// a rebuilt PDF finds the words its highlights were on again
// (md-pdf/anchors.js).
export async function writeMarkdownPdf({ PDFLib, fontkit, flow, plan, fontBytes, images = new Map(), title = "", author = "Recall", part = null, deferInternalLinks = false, pageNumbers = null }) {
  const { PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, PDFArray } = PDFLib;
  const { rows, geometry: g, options: o } = flow;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  if (title) doc.setTitle(title, { showInWindowTitleBar: true });
  doc.setCreator("Recall");
  doc.setProducer("Recall (markdown)");
  doc.setAuthor(author);

  const fonts = new Map();
  async function fontFor(face) {
    if (fonts.has(face)) return fonts.get(face);
    const bytes = fontBytes.get(face);
    const font = bytes ? await doc.embedFont(bytes, { subset: true, features: mdFontFeatures() }) : null;
    fonts.set(face, font);
    return font;
  }
  const embedded = new Map();
  async function imageFor(key) {
    if (embedded.has(key)) return embedded.get(key);
    const asset = images.get(key);
    let image = null;
    if (asset && asset.bytes) {
      try {
        image = asset.type === "jpg" ? await doc.embedJpg(asset.bytes) : await doc.embedPng(asset.bytes);
      } catch (error) {
        console.warn("Could not embed a picture", key, error);
      }
    }
    embedded.set(key, image);
    return image;
  }

  const places = placeRows(flow, plan);
  const pages = plan.pages.map((page) => doc.addPage([page.width, page.height]));
  const textRuns = pages.map(() => []);
  const linkQueue = [];

  async function drawOps(page, p, ops, x0, top) {
    for (const op of ops) {
      switch (op.t) {
        case "text": {
          const font = await fontFor(op.face);
          if (!font || !op.text) break;
          const x = x0 + op.x;
          const y = top - op.y;
          page.drawText(op.text, { x, y, size: op.size, font, color: mdPdfColour(PDFLib, op.colour) });
          textRuns[p].push({ text: op.text, x, y, size: op.size, face: op.face });
          break;
        }
        case "rect": {
          const opts = { x: x0 + op.x, y: top - op.y - op.h, width: op.w, height: op.h };
          if (op.fill) opts.color = mdPdfColour(PDFLib, op.fill);
          if (op.stroke) { opts.borderColor = mdPdfColour(PDFLib, op.stroke); opts.borderWidth = op.lw || 0.5; }
          page.drawRectangle(opts);
          break;
        }
        case "line":
          page.drawLine({ start: { x: x0 + op.x1, y: top - op.y }, end: { x: x0 + op.x2, y: top - op.y }, thickness: op.lw || 0.5, color: mdPdfColour(PDFLib, op.colour) });
          break;
        case "vline":
          page.drawLine({ start: { x: x0 + op.x, y: top - op.y1 }, end: { x: x0 + op.x, y: top - op.y2 }, thickness: op.lw || 0.5, color: mdPdfColour(PDFLib, op.colour) });
          break;
        case "dot":
          if (op.hollow) page.drawCircle({ x: x0 + op.x, y: top - op.y, size: op.r, borderColor: mdPdfColour(PDFLib, op.colour), borderWidth: 0.6 });
          else page.drawCircle({ x: x0 + op.x, y: top - op.y, size: op.r, color: mdPdfColour(PDFLib, op.colour) });
          break;
        case "square":
          page.drawRectangle({ x: x0 + op.x - op.r, y: top - op.y - op.r, width: op.r * 2, height: op.r * 2, color: mdPdfColour(PDFLib, op.colour) });
          break;
        case "check": {
          const colour = mdPdfColour(PDFLib, op.colour);
          const px = (fx) => x0 + op.x + op.w * fx;
          const py = (fy) => top - op.y - op.h * fy;
          page.drawLine({ start: { x: px(0.2), y: py(0.55) }, end: { x: px(0.42), y: py(0.78) }, thickness: 0.9, color: colour });
          page.drawLine({ start: { x: px(0.42), y: py(0.78) }, end: { x: px(0.82), y: py(0.22) }, thickness: 0.9, color: colour });
          break;
        }
        case "image": {
          const image = await imageFor(op.key);
          if (image) page.drawImage(image, { x: x0 + op.x, y: top - op.y - op.h, width: op.w, height: op.h });
          break;
        }
        case "link":
          linkQueue.push({ p, href: op.href, rect: [x0 + op.x, top - op.y - op.h, x0 + op.x + op.w, top - op.y] });
          break;
        default:
      }
    }
  }

  for (let p = 0; p < plan.pages.length; p += 1) {
    const pageInfo = plan.pages[p];
    const page = pages[p];
    for (let column = 0; column < pageInfo.slices.length; column += 1) {
      const slice = plan.slices[pageInfo.slices[column]];
      const colX = g.marginX + column * (g.columnWidth + g.gutter);
      const sliceTop = page.getHeight() - g.marginTop;
      const startRow = rows[slice.from];
      const repeat = slice.from > 0 && startRow.repeat ? startRow.repeat : null;
      // Backgrounds that run down several rows — a code block's grey, a
      // quote's bar — as ONE shape per page and column, not one per line.
      const spans = new Map();
      for (let i = slice.from; i < slice.to; i += 1) {
        const row = rows[i];
        const rowTop = sliceTop - (repeat ? repeat.h : 0) - (row.y - startRow.y);
        for (const deco of row.decos || []) {
          const span = spans.get(deco.id);
          if (span) span.bottom = rowTop - row.h;
          else spans.set(deco.id, { deco, top: rowTop, bottom: rowTop - row.h });
        }
      }
      for (const { deco, top, bottom } of spans.values()) {
        page.drawRectangle({ x: colX + deco.x, y: bottom, width: deco.w, height: top - bottom, color: mdPdfColour(PDFLib, deco.colour) });
      }
      if (repeat) await drawOps(page, p, repeat.ops, colX, sliceTop);
      for (let i = slice.from; i < slice.to; i += 1) {
        const row = rows[i];
        const rowTop = sliceTop - (repeat ? repeat.h : 0) - (row.y - startRow.y);
        await drawOps(page, p, row.ops, colX, rowTop);
      }
    }
    if (pageNumbers ?? o.pageNumbers) {
      const face = [...fontBytes.keys()].find((key) => /\|latin\|400\|normal$/.test(key) && !key.startsWith("mono")) || [...fontBytes.keys()][0];
      const font = face ? await fontFor(face) : null;
      if (font) {
        const label = `${p + 1} / ${plan.pages.length}`;
        const size = 7.5;
        const w = font.widthOfTextAtSize(label, size);
        page.drawText(label, { x: (page.getWidth() - w) / 2, y: Math.max(6, (g.marginBottom - size) / 2), size, font, color: mdPdfColour(PDFLib, "#8a9099") });
      }
    }
  }

  // ── Links ──────────────────────────────────────────────────────────────
  const pageRefs = pages.map((page) => page.ref);
  const destFor = (rowIndex) => {
    const place = places[rowIndex];
    if (!place) return null;
    return doc.context.obj([pageRefs[place.page], PDFName.of("XYZ"), PDFNumber.of(0), PDFNumber.of(Math.round(place.top + 4)), PDFNumber.of(0)]);
  };
  for (const link of linkQueue) {
    let annot = null;
    if (link.href.startsWith("#")) {
      let slug = link.href.slice(1);
      try { slug = decodeURIComponent(slug); } catch { /* keep it as written */ }
      const rowIndex = flow.anchors.get(slug.toLowerCase()) ?? flow.anchors.get(slugify(slug));
      if (rowIndex !== undefined && deferInternalLinks && places[rowIndex]) {
        const place = places[rowIndex];
        annot = doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: link.rect, Border: [0, 0, 0], [MD_GOTO_KEY]: [place.page, Math.round(place.top + 4)] });
      } else {
        const dest = rowIndex !== undefined ? destFor(rowIndex) : null;
        if (dest) annot = doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: link.rect, Border: [0, 0, 0], Dest: dest });
      }
    } else if (SAFE_URI.test(link.href)) {
      annot = doc.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: link.rect,
        Border: [0, 0, 0],
        A: { Type: "Action", S: "URI", URI: PDFString.of(link.href) }
      });
    }
    if (!annot) continue;
    const page = pages[link.p];
    const ref = doc.context.register(annot);
    let annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
    if (!annots) {
      annots = doc.context.obj([]);
      page.node.set(PDFName.of("Annots"), annots);
    }
    annots.push(ref);
  }

  // ── Bookmarks from the headings ────────────────────────────────────────
  if (o.bookmarks && flow.headings.length) {
    const items = flow.headings
      .map((h) => ({ ...h, dest: destFor(h.row) }))
      .filter((h) => h.dest && h.text);
    if (items.length) {
      const outlinesRef = doc.context.nextRef();
      // A tree by level: each item's parent is the nearest earlier item with a
      // lower level.
      const nodes = items.map((item) => ({ item, ref: doc.context.nextRef(), children: [], parent: null }));
      const root = { ref: outlinesRef, children: [], level: 0 };
      const stack = [root];
      for (const node of nodes) {
        while (stack.length > 1 && stack[stack.length - 1].item.level >= node.item.level) stack.pop();
        const parent = stack[stack.length - 1];
        node.parent = parent;
        parent.children.push(node);
        stack.push(node);
      }
      const count = (node) => node.children.reduce((sum, child) => sum + 1 + count(child), 0);
      const write = (node) => {
        node.children.forEach((child, k) => {
          const dict = {
            Title: PDFHexString.fromText(child.item.text.slice(0, 200)),
            Parent: node.ref,
            Dest: child.item.dest
          };
          if (k > 0) dict.Prev = node.children[k - 1].ref;
          if (k < node.children.length - 1) dict.Next = node.children[k + 1].ref;
          if (child.children.length) {
            dict.First = child.children[0].ref;
            dict.Last = child.children[child.children.length - 1].ref;
            // Negative: closed. Top-level headings open, the rest folded.
            dict.Count = (child.item.level <= 1 ? 1 : -1) * count(child);
          }
          doc.context.assign(child.ref, doc.context.obj(dict));
          write(child);
        });
      };
      write(root);
      doc.context.assign(outlinesRef, doc.context.obj({
        Type: "Outlines",
        First: root.children[0].ref,
        Last: root.children[root.children.length - 1].ref,
        Count: count(root)
      }));
      doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
    }
  }

  if (part && part.id) {
    tagPages(PDFLib, doc, doc.getPageIndices(), part.id);
    writePartData(PDFLib, doc, part.id, part.data || {});
  }
  const bytes = await doc.save({ useObjectStreams: true });
  return {
    bytes,
    pageCount: pages.length,
    pageSizes: plan.pages.map((page) => [page.width, page.height]),
    places,
    textRuns
  };
}
