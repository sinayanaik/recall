// Does an animated image survive the upload path as an animation?
//
//   node tools/animated-image-check.mjs
//
// Every upload is offered to compressImageToPreset, and anything it decides to
// re-encode goes through a <canvas> — which keeps the first frame and nothing
// else. Only `image/gif` used to be exempt, and "GIFs" from Tenor, Giphy and
// phone keyboards are mostly animated WebP, sometimes APNG or animated AVIF:
// every one of those was stored as a still. The decision is now made from the
// file's bytes, for every format a browser animates, and this asks that
// decision directly — pure Node, byte fixtures built here, no browser.
//
// It also asks the paste path's two URL rules (src/images/paste.js): which
// addresses are worth fetching the original from, and which are worth linking
// to when the site refuses to hand the original over.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelDecls } from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WANTED = [
  ["src/images/compress.js", [
    "gifFrameCount", "ascii", "sniffImageType", "webpIsAnimated", "pngIsAnimated",
    "avifBrands", "avifIsAnimated", "isAnimatedImage", "withSniffedType"
  ]],
  ["src/images/paste.js", ["looksAnimatedUrl", "cannotAnimateUrl"]]
];

function lift() {
  const parts = [];
  const names = [];
  for (const [file, wanted] of WANTED) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    const decls = new Map(topLevelDecls(src).map((d) => [d.name, d]));
    const missing = wanted.filter((name) => !decls.has(name));
    if (missing.length) {
      console.log(`animated-image-check: ${file} has no ${missing.join(", ")} — nothing to check.`);
      process.exit(1);
    }
    parts.push(wanted
      .map((name) => decls.get(name))
      .sort((a, b) => a.start - b.start)
      .map((d) => (d.kind === "function" || d.kind === "class" ? d.text : `${d.kind} ${d.text}`.replace(/^(const|let|var) (const|let|var) /, "$1 ")))
      .join("\n\n"));
    names.push(...wanted);
  }
  return new Function(`${parts.join("\n\n")}\nreturn { ${names.join(", ")} };`)();
}

const api = lift();

// ── Fixtures ───────────────────────────────────────────────────────────────

const bytes = (...pieces) => new Uint8Array(pieces.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)));
const le32 = (n) => [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF];
const be32 = (n) => [(n >>> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];

// GIF: header, a 2-entry global colour table, then 1x1 frames.
const gifHead = ["GIF89a", [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255]];
const gifFrame = [[0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00], [0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0x00], [0x02, 0x02, 0x44, 0x01, 0x00]];
const netscape = [[0x21, 0xFF, 0x0B], "NETSCAPE2.0", [0x03, 0x01, 0x00, 0x00, 0x00]];
const GIF_STILL = bytes(...gifHead, ...gifFrame, [0x3B]);
const GIF_ANIMATED = bytes(...gifHead, ...netscape, ...gifFrame, ...gifFrame, ...gifFrame, [0x3B]);
const GIF_TRUNCATED = GIF_ANIMATED.slice(0, 30);

// WebP: RIFF container, chunks padded to even length.
const chunk = (fourcc, payload) => [fourcc, le32(payload.length), payload, payload.length & 1 ? [0] : []].flat();
const riff = (...chunks) => {
  const body = bytes("WEBP", ...chunks.flat());
  return bytes("RIFF", le32(body.length), [...body]);
};
const vp8x = (flags) => chunk("VP8X", [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP_LOSSY = riff(chunk("VP8 ", new Array(10).fill(0)));
const WEBP_LOSSLESS = riff(chunk("VP8L", new Array(5).fill(0)));
const WEBP_EXTENDED_STILL = riff(vp8x(0x10), chunk("ALPH", [0, 0, 0]), chunk("VP8 ", new Array(10).fill(0)));
const WEBP_ANIMATED = riff(vp8x(0x02), chunk("ANIM", [0, 0, 0, 0, 0, 0]), chunk("ANMF", new Array(16).fill(0)), chunk("ANMF", new Array(16).fill(0)));
const WEBP_ANIM_NO_FLAG = riff(vp8x(0x00), chunk("ANIM", [0, 0, 0, 0, 0, 0]), chunk("ANMF", new Array(16).fill(0)));

// PNG: signature, then length/type/data/crc chunks (crc is not checked).
const pngChunk = (type, data) => [be32(data.length), type, data, [0, 0, 0, 0]];
const PNG_SIG = [[0x89], "PNG", [0x0D, 0x0A, 0x1A, 0x0A]];
const IHDR = pngChunk("IHDR", new Array(13).fill(0));
const PNG_STILL = bytes(...PNG_SIG, ...IHDR, ...pngChunk("IDAT", [1, 2, 3]), ...pngChunk("IEND", []));
const APNG = bytes(...PNG_SIG, ...IHDR, ...pngChunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]), ...pngChunk("IDAT", [1, 2, 3]), ...pngChunk("IEND", []));
const PNG_MALFORMED = bytes(...PNG_SIG, [0xFF, 0xFF, 0xFF, 0xFF], "junk", [1, 2, 3]);

// AVIF: an ISO-BMFF ftyp box — major brand, minor version, compatible brands.
const ftyp = (major, ...compatible) => {
  const body = [major, [0, 0, 0, 0], ...compatible];
  const size = 8 + body.reduce((n, p) => n + (typeof p === "string" ? p.length : p.length), 0);
  return bytes(be32(size), "ftyp", ...body, be32(8), "mdat");
};
const AVIF_STILL = ftyp("avif", "mif1", "miaf");
const AVIF_ANIMATED = ftyp("avis", "avif", "msf1");
const AVIF_ANIMATED_COMPAT = ftyp("avif", "mif1", "avis");

const JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0, 0, 16], "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const GARBAGE = bytes("this is not an image at all");

// ── Cases ──────────────────────────────────────────────────────────────────

const CASES = [
  // [label, bytes, reported type, expected sniffed type, expected animated]
  ["still GIF", GIF_STILL, "image/gif", "image/gif", false],
  ["animated GIF", GIF_ANIMATED, "image/gif", "image/gif", true],
  ["truncated GIF counts as animated", GIF_TRUNCATED, "image/gif", "image/gif", true],
  ["animated GIF labelled image/png", GIF_ANIMATED, "image/png", "image/gif", true],
  ["animated GIF with no type", GIF_ANIMATED, "", "image/gif", true],
  ["lossy WebP", WEBP_LOSSY, "image/webp", "image/webp", false],
  ["lossless WebP", WEBP_LOSSLESS, "image/webp", "image/webp", false],
  ["extended still WebP", WEBP_EXTENDED_STILL, "image/webp", "image/webp", false],
  ["animated WebP", WEBP_ANIMATED, "image/webp", "image/webp", true],
  ["animated WebP labelled image/gif", WEBP_ANIMATED, "image/gif", "image/webp", true],
  ["animated WebP without the VP8X flag", WEBP_ANIM_NO_FLAG, "image/webp", "image/webp", true],
  ["still PNG", PNG_STILL, "image/png", "image/png", false],
  ["APNG", APNG, "image/png", "image/png", true],
  ["APNG labelled image/apng", APNG, "image/apng", "image/png", true],
  ["malformed PNG counts as still", PNG_MALFORMED, "image/png", "image/png", false],
  ["still AVIF", AVIF_STILL, "image/avif", "image/avif", false],
  ["animated AVIF (avis major brand)", AVIF_ANIMATED, "image/avif", "image/avif", true],
  ["animated AVIF (avis compatible brand)", AVIF_ANIMATED_COMPAT, "image/avif", "image/avif", true],
  ["JPEG", JPEG, "image/jpeg", "image/jpeg", false],
  ["garbage labelled image/gif counts as animated", GARBAGE, "image/gif", "", true],
  ["garbage labelled image/png counts as still", GARBAGE, "image/png", "", false],
  ["garbage labelled image/jpeg", GARBAGE, "image/jpeg", "", false]
];

const URL_CASES = [
  // [url, looksAnimated, cannotAnimate]
  ["https://media.tenor.com/abc/cat.gif", true, false],
  ["https://media.giphy.com/media/xyz/giphy.webp", true, false],
  ["https://media4.giphy.com/media/xyz/200w?cid=1", true, false],
  ["https://example.com/anim.apng", true, false],
  ["https://example.com/pic.GIF?x=1#y", true, false],
  ["https://example.com/image", false, false],
  ["https://example.com/shot.png", false, false],
  ["https://example.com/photo.jpg", false, true],
  ["https://example.com/photo.JPEG?w=800", false, true],
  ["https://example.com/logo.svg", false, true],
  ["not a url", false, true]
];

let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) return;
  failed += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
};

for (const [label, data, type, sniffed, animated] of CASES) {
  const gotType = api.sniffImageType(data);
  check(`${label}: sniffed type`, gotType === sniffed, `got ${JSON.stringify(gotType)}, want ${JSON.stringify(sniffed)}`);
  const gotAnimated = api.isAnimatedImage(data, type);
  check(`${label}: animated`, gotAnimated === animated, `got ${gotAnimated}, want ${animated}`);
}

for (const [url, named, still] of URL_CASES) {
  check(`looksAnimatedUrl(${url})`, api.looksAnimatedUrl(url) === named, `want ${named}`);
  check(`cannotAnimateUrl(${url})`, api.cannotAnimateUrl(url) === still, `want ${still}`);
}

// A file whose label disagrees with its bytes is relabelled — type and
// extension both, since the extension is what the stored object is named by —
// and one whose label is right is handed back as the very same object.
{
  const mislabelled = new File([WEBP_ANIMATED], "funny.gif", { type: "image/gif" });
  const fixed = api.withSniffedType(mislabelled, WEBP_ANIMATED);
  check("withSniffedType relabels a WebP named .gif", fixed.type === "image/webp" && fixed.name === "funny.webp", `got ${fixed.type} ${fixed.name}`);
  check("withSniffedType keeps the bytes", fixed.size === WEBP_ANIMATED.length);
  const right = new File([GIF_ANIMATED], "ok.gif", { type: "image/gif" });
  check("withSniffedType leaves a correct label alone", api.withSniffedType(right, GIF_ANIMATED) === right);
  const unknown = new File([GARBAGE], "x.bin", { type: "image/gif" });
  check("withSniffedType leaves unrecognisable bytes alone", api.withSniffedType(unknown, GARBAGE) === unknown);
}

const total = CASES.length * 2 + URL_CASES.length * 2 + 4;
console.log(`CHECK: ${total} assertions · ${failed} failed`);
process.exit(failed ? 1 : 0);
