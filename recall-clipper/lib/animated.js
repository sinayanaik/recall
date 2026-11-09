// Whether a picture's bytes are a moving picture: an animated GIF, WebP, PNG
// (APNG) or AVIF. Save as PDF prints each as one still, and makes it a link
// to the moving original (see shrinkImages in pdf-job.js).
//
// A port of the same functions in Recall's src/images/compress.js — the
// clipper imports nothing from the app — so "animated" means the same thing
// on both sides; tools/extensions-check.mjs asks both the same questions.
// Keep them in step.
//
// Plain ES module: used by pdf-job.js, and by the app's checks under Node.

export function gifFrameCount(bytes) {
  if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return 2;
  let at = 10;
  // Global colour table: flag is the high bit of the packed field at byte 10,
  // and its size is 3 × 2^(N+1) where N is the low three bits.
  if (bytes[at] & 0x80) at += 3 * (1 << ((bytes[at] & 0x07) + 1));
  at += 3; // packed field + background colour index + pixel aspect ratio
  const skipSubBlocks = () => {
    while (at < bytes.length) {
      const size = bytes[at++];
      if (!size) return true;
      at += size;
    }
    return false;
  };
  let frames = 0;
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x3B) break;            // trailer
    if (marker === 0x21) {                 // extension: label, then sub-blocks
      at += 1;
      if (!skipSubBlocks()) return 2;
      continue;
    }
    if (marker !== 0x2C) return 2;         // not a valid block boundary
    frames += 1;
    if (frames > 1) return frames;         // animated — no need to finish
    at += 8;                               // image descriptor, up to its packed field
    const packed = bytes[at++];
    if (packed & 0x80) at += 3 * (1 << ((packed & 0x07) + 1)); // local colour table
    at += 1;                               // LZW minimum code size
    if (!skipSubBlocks()) return 2;
  }
  return frames;
}

const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));

export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return "";
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image/png";
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (avifBrands(bytes).some((brand) => brand === "avif" || brand === "avis")) return "image/avif";
  return "";
}

export function webpIsAnimated(bytes) {
  let at = 12;
  while (at + 8 <= bytes.length) {
    const fourcc = ascii(bytes, at, 4);
    const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
    if (fourcc === "VP8X" && (bytes[at + 8] & 0x02)) return true;
    if (fourcc === "ANIM" || fourcc === "ANMF") return true;
    if (fourcc === "VP8 " || fourcc === "VP8L") return false;
    if (size < 0) return false;
    at += 8 + size + (size & 1);
  }
  return false;
}

export function pngIsAnimated(bytes) {
  let at = 8;
  while (at + 8 <= bytes.length) {
    const size = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    const type = ascii(bytes, at + 4, 4);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + size;
  }
  return false;
}

function avifBrands(bytes) {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return [];
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, size || bytes.length);
  const brands = [ascii(bytes, 8, 4)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(bytes, at, 4));
  return brands;
}

export function avifIsAnimated(bytes) {
  return avifBrands(bytes).includes("avis");
}

export function isAnimatedImage(bytes, type = "") {
  switch (sniffImageType(bytes) || type) {
    case "image/gif": return gifFrameCount(bytes) > 1;
    case "image/webp": return webpIsAnimated(bytes);
    case "image/png":
    case "image/apng": return pngIsAnimated(bytes);
    case "image/avif": return avifIsAnimated(bytes);
    default: return false;
  }
}
