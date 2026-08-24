// An EPUB, built by hand, for tools/epub-import-check.mjs.
//
// Generated rather than checked in as a binary, for the same reason
// tools/pdf-fixture.mjs generates its PDF: every property the check asserts —
// how many chapters this book becomes, which of them is cut out of the middle
// of a file, which figure is spelled one way in the manifest and another in the
// archive — is decided HERE, in readable source, instead of being a fact about
// an opaque file someone once exported from Calibre.
//
// It is a real EPUB: an uncompressed `mimetype` first, META-INF/container.xml,
// an OPF package document with a manifest and a spine, an EPUB3 nav document,
// XHTML chapters, and three real PNGs. JSZip opens it exactly as it opens any
// other book.
//
// Four things about the shape are deliberate, and each one is a branch of
// src/import/epub.js that nothing else in tools/ reaches:
//
//   1. the spine opens with a page the table of contents does not name, so
//      planEpubChapters has to prepend its synthetic front-matter marker and
//      resolveEpubMarkerTitles has to name it from the page itself — past a
//      <title>Unknown</title> that isGenericEpubTitle exists to refuse;
//   2. ONE physical file holds two chapters, split at a TOC anchor, so
//      convertEpubChapters has to cut it with a Range — and the anchor points
//      straight at a heading whose text is the chapter's own title, which
//      isEpubDuplicateHeadingNode exists to skip;
//   3. one figure's href is percent-encoded and its archive entry is not
//      ("quiet%20machine.png" → `quiet machine.png`), and one figure is the
//      other way round: the archive entry itself carries the percent sign
//      ("fig%201.png"), which only resolveEpubPathRaw's spelling finds;
//   4. the cover's art is an <svg><image xlink:href>, not an <img>, and the
//      last chapter re-uses the same file with an EMPTY alt — the two shapes
//      that make a book's pictures vanish from the preview when they are
//      handled as if they were plain <img> tags.

import zlib from "node:zlib";

export const BOOK_TITLE = "A Field Guide to Quiet Machines";

export const BOOK_AUTHOR = "Marguerite Vale";

// The chapter titles the import must produce, in order. The leading page is not
// in the book's table of contents at all: its name has to come from its own
// heading. Numbering is applied by convertEpubChapters after empty chapters are
// dropped, and is padded to the width of the count — five chapters means one
// digit, so "1." rather than "01.".
export const FIXTURE_CHAPTER_TITLES = [
  "Frontispiece",
  "Opening the case",
  "The governor",
  "The escapement",
  "Closing the case"
];

export function numberedChapterTitles(titles = FIXTURE_CHAPTER_TITLES) {
  const width = String(titles.length).length;
  return titles.map((title, i) => `${String(i + 1).padStart(width, "0")}. ${title}`);
}

// A sentence per chapter that appears in that chapter and nowhere else, so an
// assertion about "did this chapter's text land in this deck" cannot be
// satisfied by the wrong chapter.
export const FIXTURE_CHAPTER_MARKERS = {
  "Frontispiece": "plate of the regulator",
  "Opening the case": "unscrew the four brass pillars",
  "The governor": "spins until the arms lift",
  "The escapement": "gives back one tooth at a time",
  "Closing the case": "settle the lid without pinching"
};

// ── CRC-32 ─────────────────────────────────────────────────────────────────
// The zip central directory and every PNG chunk want the same checksum, so
// there is one of it.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── A PNG, by hand ─────────────────────────────────────────────────────────
// 8-bit RGB, one zlib-compressed IDAT. Real pixels rather than a 1x1 dot: the
// import DECODES every figure to re-encode it at the chosen compression level,
// and a picture with no area to lose says nothing about whether that worked.
function pngChunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function buildPng(width, height, paint) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// ── A zip, by hand ─────────────────────────────────────────────────────────
// Deflated, except the `mimetype` entry, which the EPUB specification requires
// to be first and stored. Writing it properly is not pedantry: it is the one
// part of the container a reader validates before anything else, and a fixture
// that cheats there is a fixture that cannot be opened by anything but us.
function zipEntry(name, bytes, { store = false } = {}) {
  const nameBytes = Buffer.from(name, "utf8");
  const body = store ? bytes : zlib.deflateRawSync(bytes);
  return { name: nameBytes, body, crc: crc32(bytes), size: bytes.length, method: store ? 0 : 8 };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(30 + entry.name.length);
    header.writeUInt32LE(0x04034B50, 0);
    header.writeUInt16LE(20, 4);            // version needed
    header.writeUInt16LE(0, 6);             // flags
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(0, 10);            // mod time
    header.writeUInt16LE(0x21, 12);         // mod date: 1980-01-01
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.body.length, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(entry.name.length, 26);
    header.writeUInt16LE(0, 28);            // extra length
    entry.name.copy(header, 30);
    locals.push(header, entry.body);

    const central = Buffer.alloc(46 + entry.name.length);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0, 8);            // flags
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.body.length, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30);           // extra
    central.writeUInt16LE(0, 32);           // comment
    central.writeUInt16LE(0, 34);           // disk number
    central.writeUInt16LE(0, 36);           // internal attrs
    central.writeUInt32LE(0, 38);           // external attrs
    central.writeUInt32LE(offset, 42);
    entry.name.copy(central, 46);
    centrals.push(central);

    offset += header.length + entry.body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ── The book ───────────────────────────────────────────────────────────────
//
// Figure names are the point of this table. `href` is what the markup says and
// `entry` is what the archive is actually called; they differ in both possible
// directions, which is the pair of cases resolveEpubPath / resolveEpubPathRaw
// exist for and the pair that decides whether a book with a space in a filename
// keeps its pictures.
export const FIXTURE_IMAGES = [
  { href: "images/cover.png", entry: "OEBPS/images/cover.png", path: "OEBPS/images/cover.png", width: 240, height: 160 },
  { href: "images/quiet%20machine.png", entry: "OEBPS/images/quiet machine.png", path: "OEBPS/images/quiet machine.png", width: 200, height: 120 },
  { href: "images/fig%201.png", entry: "OEBPS/images/fig%201.png", path: "OEBPS/images/fig 1.png", width: 160, height: 100 }
];

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:2f9d6a1e-quiet-machines</dc:identifier>
    <dc:title>${BOOK_TITLE}</dc:title>
    <dc:creator>${BOOK_AUTHOR}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
${FIXTURE_IMAGES.map((img, i) => `    <item id="img${i + 1}" href="${img.href}" media-type="image/png"/>`).join("\n")}
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>
`;

// The cover is NOT listed. That omission is the fixture's whole front-matter
// case: a book's table of contents routinely skips its own cover, and the
// import has to notice and cover the gap rather than losing the page.
const NAV_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="ch1.xhtml">Opening the case</a></li>
      <li><a href="ch2.xhtml">The governor</a></li>
      <li><a href="ch2.xhtml#escapement">The escapement</a></li>
      <li><a href="ch3.xhtml">Closing the case</a></li>
    </ol>
  </nav>
</body>
</html>
`;

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title></head>
<body>
${body}
</body>
</html>
`;
}

// <title>Unknown</title> is what a converted book stamps on every page when the
// real one was not preserved — GENERIC_EPUB_TITLE_RE refuses it, so the name of
// this chapter has to come from its <h1>.
const COVER_XHTML = xhtml("Unknown", `  <h1>Frontispiece</h1>
  <div class="cover">
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 240 160" width="240" height="160">
      <image width="240" height="160" xlink:href="images/cover.png"/>
    </svg>
  </div>
  <p>A ${FIXTURE_CHAPTER_MARKERS["Frontispiece"]}, drawn from life.</p>`);

const CH1_XHTML = xhtml("Unknown", `  <h1>Opening the case</h1>
  <p>Begin by laying the movement face down and ${FIXTURE_CHAPTER_MARKERS["Opening the case"]}.</p>
  <p><img src="images/quiet%20machine.png" alt="A quiet machine at rest"/></p>
  <p>Nothing inside is under tension yet, so nothing can spring.</p>`);

// Two chapters in one file. The second begins at #escapement, and that id is on
// a heading whose text is that chapter's own title.
const CH2_XHTML = xhtml("Unknown", `  <h1>The governor</h1>
  <p>The governor ${FIXTURE_CHAPTER_MARKERS["The governor"]} and the train slows to meet them.</p>
  <h2 id="escapement">The escapement</h2>
  <p>An escapement holds the whole train and ${FIXTURE_CHAPTER_MARKERS["The escapement"]}.</p>
  <p><img src="images/fig%201.png" alt="Figure 1: the escape wheel"/></p>`);

// The empty alt is deliberate: it is what an <svg><image> and a full-page plate
// both produce, and "![](…)" is the exact shape the notes renderer's
// footnote-backref cleanup used to eat.
const CH3_XHTML = xhtml("Unknown", `  <h1>Closing the case</h1>
  <p>Finally, ${FIXTURE_CHAPTER_MARKERS["Closing the case"]} against the seconds hand.</p>
  <p><img src="images/cover.png" alt=""/></p>`);

export function buildFixtureEpub() {
  const entries = [
    // First, and stored: the specification's one ordering requirement.
    zipEntry("mimetype", Buffer.from("application/epub+zip", "ascii"), { store: true }),
    zipEntry("META-INF/container.xml", Buffer.from(CONTAINER_XML, "utf8")),
    zipEntry("OEBPS/content.opf", Buffer.from(CONTENT_OPF, "utf8")),
    zipEntry("OEBPS/nav.xhtml", Buffer.from(NAV_XHTML, "utf8")),
    zipEntry("OEBPS/cover.xhtml", Buffer.from(COVER_XHTML, "utf8")),
    zipEntry("OEBPS/ch1.xhtml", Buffer.from(CH1_XHTML, "utf8")),
    zipEntry("OEBPS/ch2.xhtml", Buffer.from(CH2_XHTML, "utf8")),
    zipEntry("OEBPS/ch3.xhtml", Buffer.from(CH3_XHTML, "utf8"))
  ];
  FIXTURE_IMAGES.forEach((img, i) => {
    // Eight-pixel blocks rather than a smooth gradient: real area for the
    // re-encode to work on and a different colour per figure, while still
    // deflating down to a few kilobytes — the whole book is handed to the
    // browser as an array of bytes, and a fixture that is mostly noise makes
    // that transfer the slowest thing in the check.
    const png = buildPng(img.width, img.height, (x, y) => [
      ((x >> 3) * 8) & 0xFF,
      ((y >> 3) * 8) & 0xFF,
      (40 + i * 70) & 0xFF
    ]);
    entries.push(zipEntry(img.entry, png));
  });
  return {
    bytes: new Uint8Array(buildZip(entries)),
    title: BOOK_TITLE,
    author: BOOK_AUTHOR,
    chapters: FIXTURE_CHAPTER_TITLES,
    numbered: numberedChapterTitles(),
    images: FIXTURE_IMAGES,
    spineFiles: 4
  };
}
