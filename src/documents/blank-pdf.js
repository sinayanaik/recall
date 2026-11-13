// Blank paper, as a real PDF.
//
// The Handwritten Notes surface is the Document surface — the same pdf.js
// rendering, the same pen, the same coordinates. That is the whole point of it:
// writing on a paper already worked, and a notebook is a paper you have not
// written the words of yet. What it needs is a file, so this makes one.
//
// ── Why the app writes a PDF rather than drawing one ──────────────────────
//
// Because everything downstream is built on `meta.pdf` being a real document
// with real bytes: pdf.js lays out the pages, src/documents/pdf-ink.js stores
// strokes in that document's user space (which is what makes them survive a
// zoom, a rotate and a second device), the annotated export re-rasterises those
// pages, the device store keeps the bytes, and the backup packs them. A notebook
// made of anything else would need a second version of every one of those.
//
// So: no library. A PDF with no fonts and no images is a few hundred bytes of
// ASCII with a byte-offset table at the end, and that table is the only part
// with a trap in it — every offset is counted in BYTES, so the file is built as
// a latin1 string and every character in it has to be one byte. Nothing here
// emits anything above U+00FF; the page content is numbers and operators.
//
// tools/pdf-fixture.mjs writes one of these in Node for the checks, and this is
// deliberately NOT that file: it runs in the browser, it draws paper rather than
// text, and the fixture's job is to be a stand-in for somebody else's document
// while this one's is to be ours.

// A4 in PDF points (72 per inch), which is the paper this app's print pipeline
// already lays out for (installPdfPrintStyle), so a notebook page exported or
// printed is 1:1 rather than rescaled.
export const BLANK_PAGE_WIDTH = 595;
export const BLANK_PAGE_HEIGHT = 842;

// What the paper looks like, as a number.
//
// The sheet is DRAWN, so it can be redrawn — that is the property the whole
// module rests on, and it is what makes changing the grid a thing that can reach
// notebooks that already exist rather than only new ones. A notebook records the
// version it was drawn at; a notebook drawn at an older one is redrawn on the
// next press of Write, through the same writeNotebookPdf that changing the paper
// already calls. The page box does not change between versions and must not, so
// nothing written on it moves.
//
//   1  the first sheet: a flat 5mm grid, a blue-grey rule
//   2  a 5mm grid with a heavier line every 2cm, and greys that are still a grid
//      after `filter: invert(1)` — the first one inverted to near-black on black
export const BLANK_PAPER_VERSION = 2;

export const BLANK_PAPERS = ["grid", "ruled", "blank"];
export const BLANK_PAPER_DEFAULT = "grid";

// In points. A ruled pitch of 24pt is a line a 10-12pt hand writes on without
// crowding; the grid is 16pt, which is 5mm — real squared paper.
//
// ── ...and why 5mm alone was not enough ────────────────────────────────────
//
// 16pt is right on paper and wrong on a phone, and both statements are about the
// same number. A4 is 595pt wide and a portrait phone is about 390px, so the page
// is laid out at ~63%: the 5mm square lands at 10px with a 0.5pt line drawn at a
// third of a pixel. That is not a grid, it is a grey wash — and it was reported
// as one.
//
// Real squared paper has the same problem at arm's length and solves it the same
// way: a heavier line every fourth square. The minor grid stays 5mm and gets
// LIGHTER, so it stops competing with what is written on it; the major line
// every 2cm is what the eye actually reads the page by, and it survives being
// drawn at 63% because it is drawn to.
const RULE_PITCH = 24;
const GRID_PITCH = 16;

// The squares a Canvas's grid paper is ruled in, from its corner — what a box
// dragged on it settles onto (src/documents/pdf-guides.js).
export const CANVAS_GRID_PITCH = GRID_PITCH;
const GRID_MAJOR_EVERY = 4;
const MARGIN_X = 56;

// ── The greys, which have to work upside down ──────────────────────────────
//
// A notebook's paper follows the theme, and on a dark theme that is done with
// `filter: invert(1)` over the rendered canvas (styles/36-document.css). An
// invert preserves the ARITHMETIC difference between the line and the page —
// 0.86 on 1.0 becomes 0.14 on 0.0, and 0.14 either way — so it is not the
// contrast that changes. What changes is how much of it the eye gets: the same
// step is much harder to see near black than near white, which is why the old
// 0.86 grid read as squared paper on a light theme and as nothing at all on a
// dark one.
//
// So the values below are not the old ones adjusted for the invert; they are
// chosen for the darker of the two readings and then checked on the lighter.
const GRID_MINOR_GREY = 0.80;
const GRID_MAJOR_GREY = 0.62;
const RULE_GREY = 0.72;
const MARGIN_GREY = [0.86, 0.55, 0.55];

export function normalizeBlankPaper(kind) {
  return BLANK_PAPERS.includes(kind) ? kind : BLANK_PAPER_DEFAULT;
}

// The paper itself, as a content stream.
//
// Drawn INTO the file rather than laid over it in CSS, and that is a decision
// worth stating: a page whose rules are part of the document prints as the page
// you were writing on, exports as it, and looks the same in any other PDF
// reader. Grey, and light — 0.86 is visible on screen and disappears at a
// glance, which is what paper does.
//
// `box` is where on the page the sheet goes, and how the ruled lines sit in it.
// A Canvas page is the whole sheet at 0,0 — the default, and the output for it
// is byte-for-byte what it always was (tools/pdf-margins-check.mjs holds it
// there, since a notebook's hash is its identity). A PDF's margins
// (src/documents/pdf-margins-core.js) ask for the paper over a page of their
// own size, clipped to the margin, with the ruled lines run edge to edge and no
// margin line: a margin is the space beside the text, not a notebook page.
export function paperStream(kind, {
  x = 0,
  y = 0,
  width = BLANK_PAGE_WIDTH,
  height = BLANK_PAGE_HEIGHT,
  ruleFrom = MARGIN_X,
  ruleInset = 32,
  marginLine = true
} = {}) {
  const n = pdfNumber;
  const out = [];
  // White page. Without it the "page" is whatever the reader's viewer puts
  // behind a transparent one, and dark-page mode inverts a known white rather
  // than a guess.
  out.push("1 1 1 rg", `${n(x)} ${n(y)} ${n(width)} ${n(height)} re`, "f");
  if (kind === "grid") {
    // Two passes rather than one line at a time, because a colour and a width
    // are graphics STATE in a content stream: setting them per line would be
    // two operators per line for a page that has ninety of them. All the minor
    // lines, then all the major ones over the top.
    const minor = [];
    const major = [];
    for (let gx = GRID_PITCH, i = 1; gx < width; gx += GRID_PITCH, i += 1) {
      (i % GRID_MAJOR_EVERY ? minor : major).push(`${n(x + gx)} ${n(y)} m ${n(x + gx)} ${n(y + height)} l S`);
    }
    for (let gy = GRID_PITCH, i = 1; gy < height; gy += GRID_PITCH, i += 1) {
      (i % GRID_MAJOR_EVERY ? minor : major).push(`${n(x)} ${n(y + gy)} m ${n(x + width)} ${n(y + gy)} l S`);
    }
    out.push(`${GRID_MINOR_GREY} ${GRID_MINOR_GREY} ${GRID_MINOR_GREY} RG`, "0.4 w", ...minor);
    out.push(`${GRID_MAJOR_GREY} ${GRID_MAJOR_GREY} ${GRID_MAJOR_GREY} RG`, "0.8 w", ...major);
  } else if (kind === "ruled") {
    // Neutral grey, not the blue-grey this used to be: a tint that reads as
    // paper the right way up reads as a colour cast upside down, and half this
    // app's readers are on a theme that turns the page over.
    out.push(`${RULE_GREY} ${RULE_GREY} ${RULE_GREY} RG`, "0.6 w");
    for (let ry = RULE_PITCH; ry < height - RULE_PITCH; ry += RULE_PITCH) {
      out.push(`${n(x + ruleFrom)} ${n(y + ry)} m ${n(x + width - ruleInset)} ${n(y + ry)} l S`);
    }
    // The margin line, because a ruled page without one is a lined page rather
    // than a notebook — and because it is what tells you which way up the page
    // is when it is scrolled to halfway.
    if (marginLine) {
      out.push(`${MARGIN_GREY.join(" ")} RG`, "0.7 w", `${n(x + ruleFrom)} ${n(y)} m ${n(x + ruleFrom)} ${n(y + height)} l S`);
    }
  }
  return out.join("\n");
}

// A number as a content stream wants it: no exponent, no long binary tail.
// Whole numbers print exactly as they did before this existed.
function pdfNumber(value) {
  return String(Number(Number(value).toFixed(2)));
}

// `pages` blank pages of `paper`. Returns the bytes as a Uint8Array, ready for
// a Blob or a File.
export function buildBlankPdf({ pages = 1, paper = BLANK_PAPER_DEFAULT, title = "Canvas" } = {}) {
  const count = Math.max(1, Math.min(500, Math.round(pages)));
  const kind = normalizeBlankPaper(paper);
  const objects = [];
  const push = (body) => { objects.push(body); return objects.length; };

  // Reserved up front so /Pages can name its kids before they exist — the same
  // ordering tools/pdf-fixture.mjs uses, for the same reason.
  const catalogId = push("");
  const pagesId = push("");

  // ONE content stream, shared by every page. A notebook is the case where every
  // page is identical, and a hundred copies of the same grid is a hundred
  // kilobytes of it — the file has to be re-uploaded on every page added.
  const stream = paperStream(kind);
  const contentId = push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);

  const pageIds = [];
  for (let n = 0; n < count; n += 1) {
    pageIds.push(push(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${BLANK_PAGE_WIDTH} ${BLANK_PAGE_HEIGHT} ] `
      + `/Resources << >> /Contents ${contentId} 0 R >>`
    ));
  }

  const infoId = push(`<< /Title (${pdfString(title)}) /Producer (Recall) >>`);

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

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

  // Latin1, one byte per character, because every offset above was measured in
  // JavaScript string length. A single multi-byte character anywhere in the file
  // moves every offset after it and the xref stops pointing at the objects.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

// Anything a PDF string literal cannot carry raw. Kept minimal on purpose: the
// only string this file writes is a title.
function pdfString(text) {
  return String(text || "").replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e]/g, "");
}

export function blankPdfFile(options = {}) {
  const bytes = buildBlankPdf(options);
  const name = `${(options.name || "handwritten-notes").replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`;
  return new File([bytes], name, { type: "application/pdf" });
}
