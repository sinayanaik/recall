// Margins on a PDF's pages: the bytes (src/documents/pdf-margins-core.js).
//
//   node tools/pdf-margins-check.mjs
//
// What is asserted is the property everything else rests on: the page grows
// OUTWARD and its origin never moves, so every highlight, stroke and typed box
// stored in the page's user space stays exactly where it was. Then that a
// second change starts from the page as it came (60mm then 40mm is 40mm), that
// "None" gives the original box back with the paper gone, that a page turned
// with /Rotate gets its margin on the side the reader SEES, and that the
// Canvas's own paper (whose bytes are its identity) is unchanged by the paper
// stream learning to draw anywhere.
//
// pdf-lib is the version the app ships (tools/pdflib-source.mjs), evaluated
// here as a CommonJS module; no browser and no network once it is cached.

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pdflibSource } from "./pdflib-source.mjs";
import { buildFixturePdf, PAGE_HEIGHT, PAGE_WIDTH } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(path.join(ROOT, "src/documents/pdf-margins-core.js")).href);
const blank = await import(pathToFileURL(path.join(ROOT, "src/documents/blank-pdf.js")).href);

const cjs = { exports: {} };
new Function("module", "exports", pdflibSource())(cjs, cjs.exports);
const PDFLib = cjs.exports;
const { PDFDocument, PDFName, degrees } = PDFLib;

const results = [];
async function must(name, fn) {
  try {
    const answer = await fn();
    results.push([answer === true, name, answer === true ? "" : String(answer)]);
  } catch (error) {
    results.push([false, name, error?.stack || String(error)]);
  }
}

const mm = (n) => n * core.PT_PER_MM;
const close = (a, b) => Math.abs(a - b) < 0.02;
const sameBox = (got, want) => got.length === 4 && got.every((v, i) => close(v, want[i])) || `got [${got.map((v) => v.toFixed(2))}] want [${want.map((v) => v.toFixed(2))}]`;

async function boxes(bytes, index = 0) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[index];
  const r = (box) => [box.x, box.y, box.x + box.width, box.y + box.height];
  return {
    doc,
    page,
    media: r(page.getMediaBox()),
    crop: r(page.getCropBox()),
    count: doc.getPageCount(),
    contents: page.node.Contents(),
    paper: page.node.get(PDFName.of("RecallMargin")),
    base: page.node.get(PDFName.of("RecallBaseBox"))
  };
}

const fixture = buildFixturePdf({ pages: 3 }).bytes;
const original = [0, 0, PAGE_WIDTH, PAGE_HEIGHT];

await must("a right margin raises only x1, on every page", async () => {
  const { bytes, pages } = await core.applyPdfMargins(PDFLib, fixture, { right: mm(60), paper: "ruled" });
  if (pages !== 3) return `pages ${pages}`;
  for (let i = 0; i < 3; i += 1) {
    const b = await boxes(bytes, i); // eslint-disable-line no-await-in-loop
    const want = [0, 0, PAGE_WIDTH + mm(60), PAGE_HEIGHT];
    const media = sameBox(b.media, want);
    if (media !== true) return `page ${i + 1} media ${media}`;
    const crop = sameBox(b.crop, want);
    if (crop !== true) return `page ${i + 1} crop ${crop}`;
  }
  return true;
});

await must("a left and bottom margin go below the origin — the origin itself does not move", async () => {
  const { bytes } = await core.applyPdfMargins(PDFLib, fixture, { left: mm(20), bottom: mm(10), paper: "blank" });
  const b = await boxes(bytes);
  return sameBox(b.media, [-mm(20), -mm(10), PAGE_WIDTH, PAGE_HEIGHT]);
});

await must("the page's text is still where it was (its content streams are all still there, after the paper)", async () => {
  const before = await boxes(fixture);
  const { bytes } = await core.applyPdfMargins(PDFLib, fixture, { right: mm(40), paper: "grid" });
  const after = await boxes(bytes);
  const was = before.contents instanceof PDFLib.PDFArray ? before.contents.size() : 1;
  const now = after.contents.size();
  if (now !== was + 1) return `${was} streams became ${now}`;
  return String(after.contents.get(0)) === String(after.paper) || "the paper is not first, under the page";
});

await must("a second change starts from the page as it came: 60mm then 40mm is 40mm", async () => {
  const once = await core.applyPdfMargins(PDFLib, fixture, { right: mm(60), paper: "ruled" });
  const twice = await core.applyPdfMargins(PDFLib, once.bytes, { right: mm(40), paper: "grid" });
  const b = await boxes(twice.bytes);
  const box = sameBox(b.media, [0, 0, PAGE_WIDTH + mm(40), PAGE_HEIGHT]);
  if (box !== true) return box;
  const streams = b.contents.size();
  const base = (await boxes(fixture)).contents;
  const want = (base instanceof PDFLib.PDFArray ? base.size() : 1) + 1;
  return streams === want || `${streams} content streams, want ${want} — the old paper was left in`;
});

await must("\"None\" gives the original box back, with the paper and the stored box gone", async () => {
  const once = await core.applyPdfMargins(PDFLib, fixture, { left: mm(30), right: mm(30), paper: "ruled" });
  const none = await core.applyPdfMargins(PDFLib, once.bytes, { paper: "ruled" });
  const b = await boxes(none.bytes);
  const box = sameBox(b.media, original);
  if (box !== true) return box;
  if (b.paper || b.base) return "a margin key was left on the page";
  const streams = b.contents instanceof PDFLib.PDFArray ? b.contents.size() : 1;
  const base = (await boxes(fixture)).contents;
  return streams === (base instanceof PDFLib.PDFArray ? base.size() : 1) || `${streams} content streams after None`;
});

await must("reading the margins back from the bytes gives what was asked", async () => {
  const { bytes } = await core.applyPdfMargins(PDFLib, fixture, { top: mm(5), right: mm(60), bottom: 0, left: mm(12) });
  const read = await core.readPdfMargins(PDFLib, bytes);
  const none = await core.readPdfMargins(PDFLib, fixture);
  if (none !== null) return "a PDF with no margins read as having some";
  return (close(read.top, mm(5)) && close(read.right, mm(60)) && close(read.bottom, 0) && close(read.left, mm(12)))
    || JSON.stringify(read);
});

// A page shown turned. The visible right of a /Rotate 90 page is the top of its
// box; of a /Rotate 270 page, the bottom; of /Rotate 180, the left.
for (const [angle, want] of [
  [90, (w, h, m) => [0, 0, w, h + m]],
  [180, (w, h, m) => [-m, 0, w, h]],
  [270, (w, h, m) => [0, -m, w, h]]
]) {
  await must(`a page with /Rotate ${angle} gets its "right" margin on the side the reader sees on the right`, async () => {
    const doc = await PDFDocument.load(fixture);
    for (const page of doc.getPages()) page.setRotation(degrees(angle));
    const turned = await doc.save();
    const { bytes } = await core.applyPdfMargins(PDFLib, turned, { right: mm(50) });
    const b = await boxes(bytes);
    const box = sameBox(b.media, want(PAGE_WIDTH, PAGE_HEIGHT, mm(50)));
    if (box !== true) return box;
    const read = await core.readPdfMargins(PDFLib, bytes);
    return (close(read.right, mm(50)) && close(read.left + read.top + read.bottom, 0)) || `read back ${JSON.stringify(read)}`;
  });
}

await must("the paper is drawn the way up the reader sees it (the turn's matrix maps the seen page onto the box)", async () => {
  const box = [-10, -20, 600, 800];
  for (const angle of [0, 90, 180, 270]) {
    const { matrix: [a, b, c, d, e, f], width, height } = core.seenToUser(box, angle);
    const at = (x, y) => [a * x + c * y + e, b * x + d * y + f];
    // The seen page's four corners land on the box's four corners...
    const corners = [at(0, 0), at(width, 0), at(0, height), at(width, height)];
    const xs = corners.map(([x]) => Math.round(x)).sort((p, q) => p - q);
    const ys = corners.map(([, y]) => Math.round(y)).sort((p, q) => p - q);
    if (xs[0] !== -10 || xs[3] !== 600 || ys[0] !== -20 || ys[3] !== 800) return `${angle}: corners ${JSON.stringify(corners)}`;
  }
  // ...and on a page turned 90° clockwise the seen top-left is the box's
  // top-left turned: user (x0, y0), the bottom-left of the box.
  const { matrix: [a, b, c, d, e, f], height } = core.seenToUser(box, 90);
  const [ux, uy] = [a * 0 + c * height + e, b * 0 + d * height + f];
  return (Math.round(ux) === -10 && Math.round(uy) === -20) || `seen top-left went to ${ux},${uy}`;
});

await must("a spec is clamped: no negative side, nothing over 150mm, an unknown paper is blank", async () => {
  const m = core.normalizeMargins({ top: -5, right: mm(400), bottom: "x", left: mm(10), paper: "dots" });
  return (m.top === 0 && close(m.right, mm(150)) && m.bottom === 0 && close(m.left, mm(10)) && m.paper === "blank") || JSON.stringify(m);
});

await must("the Canvas's own paper is byte-for-byte what it was before the paper stream took a box", async () => {
  // Pinned hashes of buildBlankPdf({ pages: 2, paper }) as written before this
  // change. A notebook's bytes are its identity (its sha256 is how every device
  // knows which pages it holds), so a stream that changed by one space would
  // re-make every Canvas in every library on its next open.
  const pinned = {
    grid: "44bd1c8ac1bfa89c91e3d3bddc758db6f633b93be2df831ea2ae9d2a7db78f68",
    ruled: "9916ca57ba18e328e39a947fdbe5c88c1dffebe6843b1455d4aaddab46ffb8fb",
    blank: "223a35bd659d5bdbf283b93e4ac029979d9cd032184515b24f5ea314b65af3b7"
  };
  const got = {};
  for (const paper of Object.keys(pinned)) {
    got[paper] = createHash("sha256").update(blank.buildBlankPdf({ pages: 2, paper })).digest("hex");
  }
  const wrong = Object.keys(pinned).filter((paper) => pinned[paper] !== got[paper]);
  return !wrong.length || `changed: ${wrong.map((p) => `${p} ${got[p]}`).join(", ")}`;
});

await must("an encrypted PDF is refused rather than half rewritten", async () => {
  // pdf-lib cannot write encryption, so the trailer is given an /Encrypt by hand.
  const doc = await PDFDocument.load(fixture);
  doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2, O: "x", U: "y", P: -4 });
  const locked = await doc.save({ useObjectStreams: false });
  try {
    await core.applyPdfMargins(PDFLib, locked, { right: mm(20) });
    return "it was rewritten";
  } catch (error) {
    return error?.code === "encrypted" || `threw ${error?.message}`;
  }
});

console.log("── pdf margins ──");
for (const [ok, name, detail] of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
}
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n  ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
