// Words over a picture, invisible and selectable.
//
// A block (src/documents/pdf-blocks.js) or a markdown text box goes into a PDF
// as a picture — the only way to keep a diagram, a formula and the reader's
// own colours exactly as the page shows them. A picture's words cannot be
// selected, copied or searched, so they are laid over it again as TEXT, in
// rendering mode 3 (invisible): drawn by nobody, found by every viewer's
// selection, copy and search. It is how a scanned page is made searchable, and
// the words land where the picture shows them because they are placed through
// the same matrix the picture is (see writeWords).
//
// The words and their boxes come from collectTextRuns
// (src/documents/pdf-region-marks.js), measured on the very node the picture
// was made from.
//
// ── The font ──────────────────────────────────────────────────────────────
//
// Invisible text still needs a font that can ENCODE it: a viewer copies a
// glyph back to a character through the font's ToUnicode map, and Helvetica in
// pdf-lib encodes WinAnsi and nothing else — an arrow, a Greek letter or a
// Hindi word in a block would be lost. So the faces come from the Markdown →
// PDF writer's own set (src/documents/md-pdf/fonts.js): Noto Sans and its
// fallbacks, fetched once and kept by the service worker, embedded as subsets
// of just the characters used. Offline before those were ever fetched, it falls
// back to Helvetica with what Helvetica cannot encode left out — the words
// still select, minus the characters no font could carry.

import { createFontSet, facesNeeded, mdFontFeatures } from "./md-pdf/fonts-core.js?v=__BUILD__";
import { loadFaces } from "./md-pdf/fonts.js?v=__BUILD__";

// The share of a word's line box its font size is, and where in it the
// baseline sits. A browser's range box for a word is about 1.2 em tall with
// the baseline about four fifths of the way down; the glyphs are never drawn,
// so this only has to make a selection cover the word.
const SIZE_OF_BOX = 0.8;
const BASELINE_IN_BOX = 0.8;

// [A B C D E F]: x' = A·x + C·y + E, y' = B·x + D·y + F.
function compose(outer, inner) {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ];
}

function applyMatrix([a, b, c, d, e, f], [x, y]) {
  return [a * x + c * y + e, b * x + d * y + f];
}

// One per output document: the fonts are embedded once and shared by every
// page's words.
export function createInvisibleTextLayer(doc) {
  const P = window.PDFLib;
  let fontSet = null;
  let fontBytes = null;
  const embedded = new Map(); // face → PDFFont
  let helvetica = null;

  // Loads the faces every word in `allWords` needs. Never throws: without the
  // faces, Helvetica carries what it can.
  async function prepare(allWords) {
    const text = allWords.map((word) => word.text).join(" ");
    if (!text.trim()) return;
    try {
      const faces = facesNeeded(`${text} `, "sans", false, false);
      const loaded = await loadFaces(faces);
      if (loaded.fonts.size) {
        fontSet = createFontSet(loaded.fonts);
        fontBytes = loaded.bytes;
        doc.registerFontkit(window.fontkit);
      }
    } catch (error) {
      console.warn("The selectable words fall back to Helvetica", error);
      fontSet = null;
    }
  }

  async function fontFor(face) {
    if (!embedded.has(face)) {
      const bytes = fontBytes?.get(face);
      embedded.set(face, bytes ? await doc.embedFont(bytes, { subset: true, features: mdFontFeatures() }) : null);
    }
    return embedded.get(face);
  }

  // What Helvetica can carry of `text`, the rest LEFT OUT — not turned into
  // "?" the way a drawn label is (pdf-lib-shapes.js encodableText): a "?" is
  // a different word to copy and to search for.
  const helveticaKnows = new Map();
  function helveticaText(text) {
    let out = "";
    for (const ch of String(text || "")) {
      if (!helveticaKnows.has(ch)) {
        try { helvetica.encodeText(ch); helveticaKnows.set(ch, true); } catch (_) { helveticaKnows.set(ch, false); }
      }
      if (helveticaKnows.get(ch)) out += ch;
    }
    return out;
  }

  // The runs one word is shown in: [{ font, text, width at size 1 }].
  async function runsFor(text) {
    if (fontSet) {
      const out = [];
      for (const run of fontSet.splitByFace(text, "sans", false, false)) {
        if (!run.face) continue; // characters no face has: left out
        // eslint-disable-next-line no-await-in-loop
        const font = await fontFor(run.face);
        if (!font) continue;
        out.push({ font, text: run.text, width: fontSet.measure(run.text, run.face, 1) });
      }
      if (out.length) return out;
    }
    if (!helvetica) helvetica = await doc.embedFont(P.StandardFonts.Helvetica);
    const plain = helveticaText(text);
    return plain.trim() ? [{ font: helvetica, text: plain, width: helvetica.widthOfTextAtSize(plain, 1) }] : [];
  }

  // The words of one picture onto `page`. `place` is the matrix the picture is
  // drawn with (the unit square onto its box on the page) and `turn` the turn
  // of a turned text box about its middle, or null; `size` is the picture's
  // box in the words' own space (CSS pixels at scale 1, i.e. points). Returns
  // how many words were written.
  async function writeWords(page, words, { place, turn = null, size }) {
    if (!words?.length || !(size?.w > 0) || !(size?.h > 0)) return 0;
    // The words' space (x right, y DOWN, in points from the box's top-left)
    // onto the unit square the picture is drawn in, then onto the page.
    const local = [1 / size.w, 0, 0, -1 / size.h, 0, 1];
    const toPage = compose(turn || [1, 0, 0, 1, 0, 0], compose(place, local));
    // Across and UP in the words' space, which is y-down, so up is −y.
    const across = [toPage[0], toPage[1]];
    const up = [-toPage[2], -toPage[3]];
    const ops = [P.pushGraphicsState()];
    let written = 0;
    for (const word of words) {
      // A trailing space where the words had one (collectTextRuns says), so
      // copying a line keeps its spacing whatever the viewer's own idea of a
      // word gap is — and "(bold)" does not come out as "( bold )".
      const spaced = word.space === false ? word.text : `${word.text} `;
      // eslint-disable-next-line no-await-in-loop
      const runs = await runsFor(spaced);
      if (!runs.length) continue;
      const fontSize = Math.max(1, word.h * SIZE_OF_BOX);
      const natural = runs.reduce((sum, run) => sum + run.width, 0) * fontSize;
      // Stretched or squeezed to the width the word is drawn at, so a
      // selection covers the word in the picture and not more or less.
      const room = word.w + (spaced === word.text ? 0 : fontSize * 0.25);
      const squeeze = natural > 0 ? Math.max(1, Math.min(1000, (100 * room) / natural)) : 100;
      const [ox, oy] = applyMatrix(toPage, [word.x, word.y + word.h * BASELINE_IN_BOX]);
      ops.push(
        P.beginText(),
        P.setTextRenderingMode(P.TextRenderingMode.Invisible),
        P.setCharacterSqueeze(squeeze),
        P.setTextMatrix(across[0], across[1], up[0], up[1], ox, oy)
      );
      for (const run of runs) {
        const name = page.node.newFontDictionary(run.font.name, run.font.ref);
        ops.push(P.setFontAndSize(name, fontSize), P.showText(run.font.encodeText(run.text)));
      }
      ops.push(P.endText());
      written += 1;
    }
    ops.push(P.popGraphicsState());
    if (written) page.pushOperators(...ops);
    return written;
  }

  return { prepare, writeWords };
}
