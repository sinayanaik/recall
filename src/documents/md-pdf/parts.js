// Markdown → PDF: the markdown kept INSIDE the PDF, and pages spliced in.
//
// A PDF made from markdown, and every run of markdown pages inserted into
// somebody's paper, can be edited again later and its pages remade. What makes
// that possible is the markdown and its options, and they are stored in the
// PDF's own bytes rather than beside them:
//
//   • each page that came from markdown names its PART in its page dictionary
//     (/RecallMd (id)), so where a part's pages are is read off the pages
//     themselves — no page number to keep up to date while other parts are
//     inserted around it;
//   • the catalog holds /RecallMdParts, a dictionary of part id → a compressed
//     stream of JSON: { source, options, cuts, title, v }.
//
// So the source travels wherever the bytes do — the device copy, the cloud
// copy, a backup, another device — with nothing extra to sync, and a PDF
// opened in any other reader is simply a PDF (unknown keys are ignored).
// pdf-lib keeps unknown keys when it rewrites a file, so the margins dialog
// (pdf-margins-core.js) carries them through.
//
// Pure in its inputs (the pdf-lib namespace and bytes in, bytes out), checked
// in Node by tools/md-pdf-check.mjs.

export const MD_PAGE_KEY = "RecallMd";
export const MD_PARTS_KEY = "RecallMdParts";
export const MD_GOTO_KEY = "RecallGoto";
export const MD_PART_VERSION = 1;

function partIdOfPage(PDFLib, page) {
  const value = page.node.get(PDFLib.PDFName.of(MD_PAGE_KEY));
  if (!value) return null;
  if (value instanceof PDFLib.PDFString || value instanceof PDFLib.PDFHexString) return value.decodeText();
  return null;
}

export function mintPartId() {
  return `md${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Every part in the document: its id, its stored data, and its pages (0-based,
// ascending).
export function readParts(PDFLib, doc) {
  const { PDFName, PDFDict, PDFRawStream, decodePDFRawStream } = PDFLib;
  const pagesById = new Map();
  doc.getPages().forEach((page, index) => {
    const id = partIdOfPage(PDFLib, page);
    if (!id) return;
    if (!pagesById.has(id)) pagesById.set(id, []);
    pagesById.get(id).push(index);
  });
  const store = doc.catalog.lookupMaybe(PDFName.of(MD_PARTS_KEY), PDFDict);
  const parts = [];
  const ids = new Set([...pagesById.keys()]);
  if (store) for (const key of store.keys()) ids.add(key.decodeText ? key.decodeText() : key.asString().slice(1));
  for (const id of ids) {
    let data = null;
    if (store) {
      const stream = store.lookupMaybe(PDFName.of(id), PDFRawStream);
      if (stream) {
        try {
          data = JSON.parse(new TextDecoder().decode(decodePDFRawStream(stream).decode()));
        } catch (error) {
          data = null;
        }
      }
    }
    const pages = pagesById.get(id) || [];
    if (!pages.length) continue;
    parts.push({ id, data, pages });
  }
  return parts.sort((a, b) => a.pages[0] - b.pages[0]);
}

export function writePartData(PDFLib, doc, id, data) {
  const { PDFName, PDFDict } = PDFLib;
  let store = doc.catalog.lookupMaybe(PDFName.of(MD_PARTS_KEY), PDFDict);
  if (!store) {
    store = doc.context.obj({});
    doc.catalog.set(PDFName.of(MD_PARTS_KEY), store);
  }
  const json = JSON.stringify({ ...data, v: MD_PART_VERSION });
  const ref = doc.context.register(doc.context.flateStream(new TextEncoder().encode(json)));
  store.set(PDFName.of(id), ref);
}

export function removePartData(PDFLib, doc, id) {
  const { PDFName, PDFDict } = PDFLib;
  const store = doc.catalog.lookupMaybe(PDFName.of(MD_PARTS_KEY), PDFDict);
  if (!store) return;
  const ref = store.get(PDFName.of(id));
  store.delete(PDFName.of(id));
  if (ref instanceof PDFLib.PDFRef) doc.context.delete(ref);
}

export function tagPages(PDFLib, doc, indices, id) {
  const pages = doc.getPages();
  for (const index of indices) {
    pages[index]?.node.set(PDFLib.PDFName.of(MD_PAGE_KEY), PDFLib.PDFString.of(id));
  }
}

// A generated page's links to a heading are written as /RecallGoto [page y]
// (md-pdf/writer.js with deferInternalLinks), not as a /Dest: copying a page
// whose link names ANOTHER page's dictionary drags that page — and through its
// /Parent the whole page tree of the generated file — along with it. Once the
// pages are in place the indices are turned into real destinations.
function resolveGotos(PDFLib, doc, pageIndices, firstIndex) {
  const { PDFName, PDFArray, PDFDict, PDFNumber } = PDFLib;
  const pages = doc.getPages();
  for (const index of pageIndices) {
    const annots = pages[index].node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k += 1) {
      const annot = annots.lookupMaybe(k, PDFDict);
      const target = annot?.lookupMaybe(PDFName.of(MD_GOTO_KEY), PDFArray);
      if (!target) continue;
      const page = target.lookupMaybe(0, PDFNumber)?.asNumber();
      const y = target.lookupMaybe(1, PDFNumber)?.asNumber() ?? 0;
      const dest = pages[firstIndex + (page || 0)];
      annot.delete(PDFName.of(MD_GOTO_KEY));
      if (dest) annot.set(PDFName.of("Dest"), doc.context.obj([dest.ref, PDFName.of("XYZ"), PDFNumber.of(0), PDFNumber.of(y), PDFNumber.of(0)]));
    }
  }
}

export class PartsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Put the generated pages into `baseBytes`.
//
//   at        0-based index to insert before (pageCount appends) — for a new part
//   replaceId the part to replace: its pages are taken out and the new ones go
//             where its first page was
//   removeId  take a part out and insert nothing (genBytes ignored)
//   part      { id, data } for the pages put in
//
// Returns { bytes, from, removed, added, pageCount }: the new pages are
// [from, from + added), and every page that was at or after `from + removed`
// moved by (added − removed).
export async function splicePart(PDFLib, baseBytes, genBytes, { at = null, replaceId = null, removeId = null, part = null } = {}) {
  const { PDFDocument } = PDFLib;
  let base;
  try {
    base = await PDFDocument.load(baseBytes, { updateMetadata: false });
  } catch (error) {
    if (/encrypt/i.test(String(error?.message))) throw new PartsError("encrypted", "This PDF is protected");
    throw error;
  }
  const dropId = replaceId || removeId;
  let from = Math.max(0, Math.min(base.getPageCount(), Number.isInteger(at) ? at : base.getPageCount()));
  let removed = 0;
  if (dropId) {
    const existing = readParts(PDFLib, base).find((p) => p.id === dropId);
    if (!existing) throw new PartsError("missing-part", "Those pages are no longer in this PDF");
    from = existing.pages[0];
    // Highest first, so each index is still right when it is removed.
    for (const index of [...existing.pages].sort((a, b) => b - a)) base.removePage(index);
    removed = existing.pages.length;
    removePartData(PDFLib, base, dropId);
  }
  let added = 0;
  if (!removeId) {
    const gen = await PDFDocument.load(genBytes, { updateMetadata: false });
    const copied = await base.copyPages(gen, gen.getPageIndices());
    copied.forEach((page, k) => base.insertPage(from + k, page));
    added = copied.length;
    const indices = copied.map((_, k) => from + k);
    resolveGotos(PDFLib, base, indices, from);
    if (part) {
      tagPages(PDFLib, base, indices, part.id);
      writePartData(PDFLib, base, part.id, part.data);
    }
  }
  const bytes = await base.save({ useObjectStreams: true });
  return { bytes, from, removed, added, pageCount: base.getPageCount() };
}

// The size of the page `index` (0-based) of a PDF, as [width, height] the
// reader sees it — what "Match this PDF" lays the new pages out to.
export async function pageSizeAt(PDFLib, bytes, index) {
  const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const pages = doc.getPages();
  const page = pages[Math.max(0, Math.min(pages.length - 1, index))];
  if (!page) return null;
  const { width, height } = page.getSize();
  const turned = Math.abs(page.getRotation().angle % 180) === 90;
  return turned ? [height, width] : [width, height];
}
