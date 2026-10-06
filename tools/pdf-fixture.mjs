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

// The titles a derived-contents fixture puts at the top of each page. Real
// words rather than "Section N", and deliberately all different: a line whose
// words repeat across the pages is a RUNNING HEAD, and src/documents/pdf-toc.js
// drops those on purpose — a fixture whose headings were formulaic would be
// testing that rule instead of the one it means to.
export const FIXTURE_HEADINGS = [
  "Introduction and motivation",
  "Method",
  "Results on the benchmark",
  "Discussion",
  "Related work",
  "Conclusion"
];

// ...and the numbered subsection under each, distinct for the same reason: a
// numbered line that says the same thing on every page, modulo its digits, is
// furniture and pdf-toc.js drops it as such.
export const FIXTURE_SUBHEADINGS = [
  "What this paper is for",
  "How the model is trained",
  "Accuracy against the baseline",
  "Threats to validity",
  "Where this sits in the literature",
  "What we would do next"
];

// One page's text, as lines. Each page carries a heading and a numbered run of
// sentences, so the check can say exactly how many text items it expects and
// which words are where.
//
// A line is a string at body size, or { text, size } when it is set larger —
// which is the only cue a PDF with no outline gives about what its headings
// are, and therefore the thing the derived contents is read from.
export function fixturePageLines(pageNumber, linesPerPage, { headingSize = 0 } = {}) {
  const lines = [];
  if (headingSize) {
    lines.push({ text: FIXTURE_HEADINGS[(pageNumber - 1) % FIXTURE_HEADINGS.length], size: headingSize });
    // A numbered subsection at BODY size, which is how most papers set one and
    // is the second rule pdf-toc.js reads: "3.1" is one level under "3"
    // whatever size the producer chose for it.
    lines.push(`${pageNumber}.1 ${FIXTURE_SUBHEADINGS[(pageNumber - 1) % FIXTURE_SUBHEADINGS.length]}`);
    for (let i = lines.length; i < linesPerPage; i++) {
      lines.push(`Page ${pageNumber} line ${i} carries a sentence worth selecting.`);
    }
    return lines;
  }
  lines.push(`Section ${pageNumber}: a page of the fixture document`);
  for (let i = 1; i < linesPerPage; i++) {
    lines.push(`Page ${pageNumber} line ${i} carries a sentence worth selecting.`);
  }
  return lines;
}

export function contentStreamFor(lines) {
  const body = lines
    .map((line, index) => {
      const y = FIRST_BASELINE - index * LINE_HEIGHT;
      const text = typeof line === "string" ? line : line.text;
      const size = typeof line === "string" ? FONT_SIZE : line.size;
      return `BT /F1 ${size} Tf ${MARGIN_LEFT} ${y} Td (${pdfString(text)}) Tj ET`;
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

// ── Words set in more than one font ─────────────────────────────────────────
//
// What a LaTeX paper looks like to pdf.js: a word whose letters come from two
// fonts (small caps, an italic letter, a ligature taken from another font) is
// two or more TEXT ITEMS with nothing between them, because pdf.js starts a new
// item at every font switch. Copying "Abstract: Many applications" off such a
// page used to give "A bs tr act: Man y appl i cations" — a space at every seam.
//
// Each line is a list of [font, text] runs, all in one BT so the text position
// simply advances from one run to the next: no gap, exactly as typeset. The
// second line is on its own baseline, so the check also sees a line break.
export const SPLIT_WORD_LINES = [
  [["F2", "A"], ["F1", "bs"], ["F2", "tr"], ["F1", "act: Man"], ["F2", "y"], ["F1", " appl"], ["F2", "i"], ["F1", "cations in robotics"]],
  [["F1", "require pr"], ["F2", "i"], ["F1", "mitive geometry."]]
];

// ...and what a reader expects on the clipboard for the two of them.
export const SPLIT_WORD_TEXT = "Abstract: Many applications in robotics\nrequire primitive geometry.";

function splitWordStream() {
  return SPLIT_WORD_LINES
    .map((runs, index) => {
      const y = FIRST_BASELINE - index * LINE_HEIGHT;
      const body = runs.map(([font, text]) => `/${font} ${FONT_SIZE} Tf (${pdfString(text)}) Tj`).join(" ");
      return `BT ${MARGIN_LEFT} ${y} Td ${body} ET`;
    })
    .join("\n");
}

// ── Words drawn more than once, on top of themselves ────────────────────────
//
// What The Little Book of Deep Learning does to its underlined index terms: each
// syllable is stamped several times at sub-point offsets (a descender-skipping
// underline clears the rule around g, p and y that way) and then drawn for real.
// pdf.js reports every stamp as a text item, and copying "inductive bias" used
// to give "inininin…ducducduc…tivetivetive…biasbiasbias".
//
// Set in Courier, whose every glyph advances 0.6em, so where each run starts is
// arithmetic rather than a font metric. Each run is [text, stamps]: a run with
// more than one stamp is drawn stamps - 1 times on a circle OVERPRINT_RADIUS
// points across, then once at its true place. The second and third lines are
// the controls the deduplication must leave alone: the same word twice in a row
// ("the the"), the same letter twice in a row as separate runs ("a" "l" "l"),
// and a word that also appears, underlined, on the line above.
export const OVERPRINT_STAMPS = 11;

export const OVERPRINT_RADIUS = 0.4;

const COURIER_ADVANCE = 0.6;

export const OVERPRINT_LINES = [
  [["by crafting the right ", 1], ["in", OVERPRINT_STAMPS], ["duc", OVERPRINT_STAMPS], ["tive", OVERPRINT_STAMPS],
    [" ", 1], ["bias", OVERPRINT_STAMPS], [" in a model,", 1]],
  [["which means that ", 1], ["the", 1], [" ", 1], ["the", 1], [" structure of a", 1], ["l", 1], ["l", 1], [" of it", 1]],
  [["has a bias", 1], [" that fits the data.", 1]]
];

// ...and what a reader expects on the clipboard for them.
export const OVERPRINT_TEXT = "by crafting the right inductive bias in a model,\n"
  + "which means that the the structure of all of it\n"
  + "has a bias that fits the data.";

function overprintStream() {
  const out = [];
  OVERPRINT_LINES.forEach((runs, line) => {
    const y = FIRST_BASELINE - line * LINE_HEIGHT;
    let x = MARGIN_LEFT;
    runs.forEach(([text, stamps]) => {
      for (let stamp = 0; stamp < stamps - 1; stamp += 1) {
        const angle = (2 * Math.PI * stamp) / (stamps - 1);
        const dx = (OVERPRINT_RADIUS * Math.cos(angle)).toFixed(3);
        const dy = (OVERPRINT_RADIUS * Math.sin(angle)).toFixed(3);
        out.push(`BT /F3 ${FONT_SIZE} Tf ${(x + Number(dx)).toFixed(3)} ${(y + Number(dy)).toFixed(3)} Td (${pdfString(text)}) Tj ET`);
      }
      out.push(`BT /F3 ${FONT_SIZE} Tf ${x.toFixed(3)} ${y} Td (${pdfString(text)}) Tj ET`);
      x += text.length * FONT_SIZE * COURIER_ADVANCE;
    });
  });
  return out.join("\n");
}

// ── A scanned page ──────────────────────────────────────────────────────────
//
// What a scan actually is to a PDF reader: one picture per page and not a
// single character — so no text layer, nothing to select, and the reason the
// pen grew a highlighter. Drawn as a grey image one pixel wide and a row per
// point tall, stretched across the measure: each "line" is ten rows of pure
// black where the words would be, and eight of white between lines. Pure black
// and pure white because those are the two values a blend is asked about: a
// band MULTIPLIED with the page leaves black black and tints the white; a band
// painted over the top would grey the black.
const SCAN_LINE_INK = 10;
export const SCAN_MEASURE = 380;
const SCAN_TOP = FIRST_BASELINE + FONT_SIZE;

// The PDF y of the middle of a scanned line's black, and of the white gap
// above it — in user space, as fixtureLineOrigin is.
export function scannedInkY(lineIndex) {
  return SCAN_TOP - (lineIndex * LINE_HEIGHT) - 3 - (SCAN_LINE_INK / 2);
}

// The gap is the eight white rows that end three rows above the line's black:
// rows 18i-5 to 18i+2 from the top, whose middle is one point above the
// line's own top row. Asked for line 1 or later — line 0 has only three white
// rows above it.
export function scannedPaperY(lineIndex) {
  return SCAN_TOP - (lineIndex * LINE_HEIGHT) + 1;
}

function scannedPageImage(linesPerPage) {
  const rows = linesPerPage * LINE_HEIGHT;
  let pixels = "";
  for (let row = 0; row < rows; row += 1) {
    const within = row % LINE_HEIGHT;
    pixels += within >= 3 && within < 3 + SCAN_LINE_INK ? " " : "ÿ";
  }
  return { rows, pixels };
}

// { bytes, pages, linesPerPage, annotation } — everything the check needs to
// know about what it is looking at.
// `annotate: false` builds the SAME document with no Highlight annotation in
// it — which is the ordinary case, and the one that was broken while every
// assertion here passed. A PDF that arrives with annotations gives the deck a
// non-empty note (the imported comments), and an empty note is exactly what
// made a freshly imported paper indistinguishable from an empty deck. A fixture
// that always carries an annotation can never see that.
// `width`/`height` override the page box. The default is Letter portrait, which
// is what every assertion built around fixtureLineOrigin measures against — so
// only pass them for a check that is ABOUT the page's proportions. The one that
// does is the fit-width case: a 16:9 slide is over twice as wide as a phone,
// and "does a page fit across" cannot be asked of a document that already fits.
// `outline: false` builds the same document with NO /Outlines at all, which is
// what a preprint, a scan or anything printed to PDF actually looks like — the
// case src/documents/pdf-toc.js exists for, and one that a fixture which always
// carries an outline can never reach.
// `headingSize` sets the first line of each page in larger type, so there is
// something for that derivation to find.
// `scanned` builds every page as a picture with no text in it (see above).
// `overprint` builds every page as OVERPRINT_LINES: underlined words stamped
// several times on top of themselves (see above).
// `heightForPage` makes a paper whose pages are NOT all one size — a scan, a
// plate section, a landscape figure. It matters because the viewer lays every
// page out at page 1's size until that page is itself parsed, and the real size
// arriving later moves everything below it. A fixture where every page is
// identical cannot see that happen: the correction's delta is exactly 0.
export function buildFixturePdf({
  pages = 4, linesPerPage = 12, annotate = true,
  width = PAGE_WIDTH, height = PAGE_HEIGHT,
  outline = true, headingSize = 0, heightForPage = null, scanned = false, splitWords = false,
  overprint = false
} = {}) {
  const objects = [];       // 1-based; objects[i] is object i+1
  const push = (body) => { objects.push(body); return objects.length; };

  // Reserved up front so /Pages can name its kids before they exist.
  const catalogId = push("");
  const pagesId = push("");
  const fontId = push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const obliqueId = splitWords ? push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>") : 0;
  const courierId = overprint ? push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>") : 0;

  // One Highlight annotation, on page 2, over that page's second line — the
  // shape a reference manager leaves behind, with quadPoints, an RGB colour and
  // a comment. readExistingHighlights is what turns this into a record and its
  // comment into a highlight note.
  const annotatedPage = annotate ? Math.min(2, pages) : 0;
  const annotatedLine = 1;
  const rect = lineRect(annotatedLine);
  const quadPoints = [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]];
  const annotationComment = "A comment that came in with the file.";
  const annotationId = push(
    `<< /Type /Annot /Subtype /Highlight /Rect [${rect.join(" ")}] `
    + `/QuadPoints [${quadPoints.join(" ")}] /C [1 0.83 0] /F 4 `
    + `/Contents (${pdfString(annotationComment)}) >>`
  );

  // One image, shared by every page of a scan.
  const scan = scanned ? scannedPageImage(linesPerPage) : null;
  const scanId = scan
    ? push(`<< /Type /XObject /Subtype /Image /Width 1 /Height ${scan.rows} /ColorSpace /DeviceGray `
      + `/BitsPerComponent 8 /Length ${scan.pixels.length} >>\nstream\n${scan.pixels}\nendstream`)
    : 0;

  const pageIds = [];
  for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
    const stream = scan
      ? `q ${SCAN_MEASURE} 0 0 ${scan.rows} ${MARGIN_LEFT} ${SCAN_TOP - scan.rows} cm /Im1 Do Q`
      : splitWords
        ? splitWordStream()
        : overprint
          ? overprintStream()
          : contentStreamFor(fixturePageLines(pageNumber, linesPerPage, { headingSize }));
    const contentId = push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const annots = pageNumber === annotatedPage ? ` /Annots [${annotationId} 0 R]` : "";
    const pageHeight = typeof heightForPage === "function" ? (heightForPage(pageNumber) || height) : height;
    const fonts = `/F1 ${fontId} 0 R`
      + (obliqueId ? ` /F2 ${obliqueId} 0 R` : "")
      + (courierId ? ` /F3 ${courierId} 0 R` : "");
    const resources = scan ? `<< /XObject << /Im1 ${scanId} 0 R >> >>` : `<< /Font << ${fonts} >> >>`;
    pageIds.push(push(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${pageHeight}] `
      + `/Resources ${resources} /Contents ${contentId} 0 R${annots} >>`
    ));
  }

  // A two-level outline: one entry per page, so the check can assert both that
  // the titles come back and that each destination resolves to the right page.
  let outlineId = 0;
  if (outline) {
    outlineId = push("");
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
  }

  const infoId = push("<< /Title (The Fixture Paper) /Author (Recall Checks) >>");

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outline ? ` /Outlines ${outlineId} 0 R` : ""} >>`;
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
    headings: headingSize
      ? Array.from({ length: pages }, (_, i) => ({
        title: FIXTURE_HEADINGS[i % FIXTURE_HEADINGS.length],
        sub: `${i + 1}.1 ${FIXTURE_SUBHEADINGS[i % FIXTURE_SUBHEADINGS.length]}`
      }))
      : null,
    annotation: annotate
      ? { page: annotatedPage, line: annotatedLine, rect, comment: annotationComment }
      : null
  };
}
