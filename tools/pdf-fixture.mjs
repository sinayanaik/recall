// A PDF, built by hand, for tools/pdf-preview-check.mjs.
//
// Deliberately generated rather than checked in as a binary. A fixture whose
// bytes nobody in this repo can read is a fixture nobody can reason about when
// the check fails — and the properties the check asserts (how many text items
// are on page 3, where the highlight annotation's quad sits, what the outline
// says) are all decided HERE, in plain source, rather than being facts about an
// opaque file someone once exported from Word.
//
// It is a real PDF: a proper object table, a real xref, Helvetica text in a
// content stream, a document outline, and one Highlight annotation of the shape
// Zotero and Preview write. pdf.js parses it exactly as it parses any other.

// US Letter, in PDF points, which is the space every coordinate below is in.
export const PAGE_WIDTH = 612;

export const PAGE_HEIGHT = 792;

export const FONT_SIZE = 12;

export const LINE_HEIGHT = 18;

export const MARGIN_LEFT = 72;

export const FIRST_BASELINE = 720;

// Escaped for a PDF literal string: backslash, and both parens, are the three
// characters that would otherwise end the string early.
function pdfString(text) {
  return String(text).replace(/([\\()])/g, "\\$1");
}

// One page's text, as lines. Each page carries a heading and a numbered run of
// sentences, so the check can say exactly how many text items it expects and
// which words are where.
export function fixturePageLines(pageNumber, linesPerPage) {
  const lines = [`Section ${pageNumber}: a page of the fixture document`];
  for (let i = 1; i < linesPerPage; i++) {
    lines.push(`Page ${pageNumber} line ${i} carries a sentence worth selecting.`);
  }
  return lines;
}

export function contentStreamFor(lines) {
  const body = lines
    .map((line, index) => {
      const y = FIRST_BASELINE - index * LINE_HEIGHT;
      return `BT /F1 ${FONT_SIZE} Tf ${MARGIN_LEFT} ${y} Td (${pdfString(line)}) Tj ET`;
    })
    .join("\n");
  return body;
}

// Where one line of a page was DRAWN: its left edge and its baseline, in PDF
// user space. The check compares a captured quad against these.
//
// Deliberately not a full rectangle. The width of a drawn line is decided by
// Helvetica's own metrics, not by anything in this file, so an "expected" right
// edge would be asserting a font metric rather than the app's coordinate maths.
export function fixtureLineOrigin(lineIndex) {
  return { x0: MARGIN_LEFT, baseline: FIRST_BASELINE - lineIndex * LINE_HEIGHT };
}

// The annotation rectangle written into the file for one line. `width` is a
// generous guess at how far the text runs — an annotation's Rect is allowed to
// be wider than the glyphs under it, and a highlight imported from it is
// expected to cover the line, not to trace it.
export function lineRect(lineIndex, width = 380) {
  const { x0, baseline } = fixtureLineOrigin(lineIndex);
  return [x0, baseline - 3, x0 + width, baseline + FONT_SIZE];
}

// { bytes, pages, linesPerPage, annotation } — everything the check needs to
// know about what it is looking at.
export function buildFixturePdf({ pages = 4, linesPerPage = 12 } = {}) {
  const objects = [];       // 1-based; objects[i] is object i+1
  const push = (body) => { objects.push(body); return objects.length; };

  // Reserved up front so /Pages can name its kids before they exist.
  const catalogId = push("");
  const pagesId = push("");
  const fontId = push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  // One Highlight annotation, on page 2, over that page's second line — the
  // shape a reference manager leaves behind, with quadPoints, an RGB colour and
  // a comment. readExistingHighlights is what turns this into a record and its
  // comment into a highlight note.
  const annotatedPage = Math.min(2, pages);
  const annotatedLine = 1;
  const rect = lineRect(annotatedLine);
  const quadPoints = [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]];
  const annotationComment = "A comment that came in with the file.";
  const annotationId = push(
    `<< /Type /Annot /Subtype /Highlight /Rect [${rect.join(" ")}] `
    + `/QuadPoints [${quadPoints.join(" ")}] /C [1 0.83 0] /F 4 `
    + `/Contents (${pdfString(annotationComment)}) >>`
  );

  const pageIds = [];
  for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
    const stream = contentStreamFor(fixturePageLines(pageNumber, linesPerPage));
    const contentId = push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const annots = pageNumber === annotatedPage ? ` /Annots [${annotationId} 0 R]` : "";
    pageIds.push(push(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
      + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R${annots} >>`
    ));
  }

  // A two-level outline: one entry per page, so the check can assert both that
  // the titles come back and that each destination resolves to the right page.
  const outlineId = push("");
  const outlineItemIds = pageIds.map(() => push(""));
  outlineItemIds.forEach((id, index) => {
    const prev = index > 0 ? ` /Prev ${outlineItemIds[index - 1]} 0 R` : "";
    const next = index < outlineItemIds.length - 1 ? ` /Next ${outlineItemIds[index + 1]} 0 R` : "";
    objects[id - 1] =
      `<< /Title (${pdfString(`Section ${index + 1}`)}) /Parent ${outlineId} 0 R${prev}${next} `
      + `/Dest [${pageIds[index]} 0 R /Fit] >>`;
  });
  objects[outlineId - 1] =
    `<< /Type /Outlines /First ${outlineItemIds[0]} 0 R /Last ${outlineItemIds[outlineItemIds.length - 1]} 0 R `
    + `/Count ${outlineItemIds.length} >>`;

  const infoId = push("<< /Title (The Fixture Paper) /Author (Recall Checks) >>");

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outlineId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  // ── Serialise, tracking byte offsets for the xref ─────────────────────────
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  offsets.forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;

  return {
    // Latin1, not UTF-8: every offset above was measured in JS string length,
    // and only a one-byte-per-character encoding keeps those honest.
    bytes: Uint8Array.from(pdf, (c) => c.charCodeAt(0) & 0xff),
    pages,
    linesPerPage,
    title: "The Fixture Paper",
    annotation: { page: annotatedPage, line: annotatedLine, rect, comment: annotationComment }
  };
}
