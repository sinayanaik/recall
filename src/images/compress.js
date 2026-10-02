// How hard an image is squeezed before it is uploaded.
//
// Every upload used to be re-encoded to one fixed setting — 1600px, WebP at
// 82% — with a toast that said "Optimizing image…" after the upload was already
// under way. It was the right default and it is still the default, but it was
// also the only option, it could not be seen, and it could not be declined: a
// photo you wanted kept at full resolution was downscaled, and a screenshot you
// wanted tiny was not.
//
// So the level is a choice now (see compress-dialog.js, which shows what each
// one actually costs before anything is sent), and this module is the part that
// does the work: the presets, the encode, and the one remembered answer that
// decides which preset the next dialog opens on.

// The default downscale + re-encode (screenshots are often huge PNGs). These
// two numbers ARE the "Balanced" level below — every image already in a note
// was uploaded under exactly them, which is why the default is defined from
// these rather than by repeating the numbers.
export const IMAGE_MAX_DIMENSION = 1600;

export const IMAGE_QUALITY = 0.82;

export const IMAGE_MIME_EXT = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };

// Count a GIF's frames by walking its block structure. Only an ANIMATED gif has
// to skip re-encoding — the canvas path would flatten it to a still — but a
// single-frame GIF is just a picture, and passing every GIF through untouched
// meant a multi-megabyte one was stored and served at full size forever.
// Anything unparseable returns 2, i.e. "treat as animated", which is the answer
// that can only cost bytes rather than destroy the image.
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

// ── Animation in the other formats ─────────────────────────────────────────
// A "GIF" saved from Tenor, Giphy or a phone keyboard is very often not a GIF
// at all but an animated WebP, and some are APNG or animated AVIF. Only
// `image/gif` used to be exempt from the canvas re-encode, so every one of
// those uploaded as its first frame — a still, everywhere, for good. So the
// question is asked of the BYTES, for every format a browser animates, and the
// type is read from them too: a file whose reported type disagrees with its
// contents was otherwise checked against the wrong rule.
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

// RIFF chunks after the 12-byte header. An extended (VP8X) file carries an
// animation flag in its first chunk; ANIM/ANMF are checked as well, so a file
// whose flag is wrong but whose frames are there still counts.
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

// An APNG is a PNG with an acTL chunk before its first IDAT. Anything that
// cannot be walked counts as STILL here, unlike a GIF: almost every PNG is a
// screenshot, and those are exactly the uploads compression is for.
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

// The brands an ISO-BMFF `ftyp` box declares: the major one, then the
// compatible list. `avis` is the image-sequence brand, i.e. animated AVIF.
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

// `type` is the file's reported type, used only when the bytes say nothing
// recognisable — the bytes win whenever they do.
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

// ── The levels ─────────────────────────────────────────────────────────────
// `maxDimension` is the longest side in pixels; `quality` is the WebP/JPEG
// encoder's own 0–1 scale. Both null means "upload the file exactly as it is".
//
// "Balanced" is defined FROM the old constants rather than repeating their
// numbers, so the default this ships with is provably the behaviour every
// existing note's images were uploaded under.
export const IMAGE_COMPRESSION_PRESETS = [
  { id: "original", label: "Original", detail: "No re-encode", maxDimension: null, quality: null },
  { id: "high", label: "High", detail: "2400px · 92%", maxDimension: 2400, quality: 0.92 },
  { id: "balanced", label: "Balanced", detail: `${IMAGE_MAX_DIMENSION}px · ${Math.round(IMAGE_QUALITY * 100)}%`, maxDimension: IMAGE_MAX_DIMENSION, quality: IMAGE_QUALITY },
  { id: "small", label: "Small", detail: "1200px · 70%", maxDimension: 1200, quality: 0.7 },
  { id: "tiny", label: "Tiny", detail: "800px · 55%", maxDimension: 800, quality: 0.55 }
];

export const DEFAULT_IMAGE_COMPRESSION_ID = "balanced";

// The Advanced row's own bounds. The floor on quality is where WebP stops
// being a photograph and starts being an artefact; the floor on the longest
// side is roughly a thumbnail. The ceiling on dimension is deliberately past
// any phone camera — it only ever means "do not downscale this".
export const IMAGE_QUALITY_MIN = 0.3;

export const IMAGE_QUALITY_MAX = 1;

export const IMAGE_DIMENSION_MIN = 200;

export const IMAGE_DIMENSION_MAX = 6000;

export function imageCompressionPreset(id) {
  return IMAGE_COMPRESSION_PRESETS.find((preset) => preset.id === id) || null;
}

// A choice is { id, maxDimension, quality } — a preset by id, or "custom" with
// the two numbers the Advanced sliders produced. Anything unrecognised comes
// back as the default rather than as an upload nobody asked for.
export function normalizeImageCompressionChoice(choice) {
  const preset = imageCompressionPreset(choice?.id);
  if (preset) return { id: preset.id, maxDimension: preset.maxDimension, quality: preset.quality };
  if (choice?.id !== "custom") return normalizeImageCompressionChoice({ id: DEFAULT_IMAGE_COMPRESSION_ID });
  const quality = Number(choice.quality);
  const maxDimension = Number(choice.maxDimension);
  return {
    id: "custom",
    quality: Math.min(IMAGE_QUALITY_MAX, Math.max(IMAGE_QUALITY_MIN, Number.isFinite(quality) ? quality : IMAGE_QUALITY)),
    maxDimension: Math.min(IMAGE_DIMENSION_MAX, Math.max(IMAGE_DIMENSION_MIN, Number.isFinite(maxDimension) ? Math.round(maxDimension) : IMAGE_MAX_DIMENSION))
  };
}

// Identity of a choice, for the dialog's per-file result cache: flipping back
// to a level you have already seen must not re-encode everything.
export function imageCompressionKey(choice) {
  const settings = normalizeImageCompressionChoice(choice);
  return `${settings.id}:${settings.maxDimension}:${settings.quality}`;
}

// ── The remembered answer ──────────────────────────────────────────────────
// Only which level the dialog OPENS on. The dialog itself is not skippable:
// the point of it is that an upload is seen before it happens, and a
// "remember this and stop asking" would give that away one tick at a time.
export const IMAGE_COMPRESSION_KEY = "recall:imageCompression";

export function readImageCompressionChoice() {
  try {
    const stored = JSON.parse(localStorage.getItem(IMAGE_COMPRESSION_KEY) || "null");
    if (stored) return normalizeImageCompressionChoice(stored);
  } catch (_) { /* unreadable or absent — the default is the answer */ }
  return normalizeImageCompressionChoice({ id: DEFAULT_IMAGE_COMPRESSION_ID });
}

export function writeImageCompressionChoice(choice) {
  try {
    localStorage.setItem(IMAGE_COMPRESSION_KEY, JSON.stringify(normalizeImageCompressionChoice(choice)));
  } catch (_) { /* a full or blocked store costs the next dialog its default, nothing more */ }
}

// ── The encode ─────────────────────────────────────────────────────────────
// Result shape, one per file:
//   { file, width, height, sourceWidth, sourceHeight, skipped, reason }
// `file` is what should actually be uploaded — the original itself whenever
// re-encoding it would be wrong or would not help — and `reason` is the plain
// sentence the dialog shows for that case.
export function uncompressedImage(file, reason, sourceWidth = null, sourceHeight = null) {
  return {
    file,
    width: sourceWidth,
    height: sourceHeight,
    sourceWidth,
    sourceHeight,
    skipped: true,
    reason
  };
}

// The same file, relabelled with the type its bytes say it is, so it is stored
// under the right Content-Type and extension (IMAGE_STORAGE_EXT). Unchanged
// when the label was already right or the bytes say nothing recognisable.
export function withSniffedType(file, head) {
  const sniffed = sniffImageType(head);
  if (!sniffed || sniffed === file.type) return file;
  const ext = { "image/gif": "gif", "image/webp": "webp", "image/png": "png", "image/avif": "avif", "image/jpeg": "jpg" }[sniffed];
  const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
  return new File([file], `${baseName}.${ext}`, { type: sniffed });
}

export async function compressImageToPreset(file, choice) {
  const settings = normalizeImageCompressionChoice(choice);
  const type = (file && file.type) || "";
  if (!type.startsWith("image/")) return uncompressedImage(file, "not an image");
  if (!settings.maxDimension || !settings.quality) return uncompressedImage(file, "kept exactly as it is");
  // SVG is vector: already small, and rasterizing it would be a downgrade.
  if (type === "image/svg+xml") return uncompressedImage(file, "vector — already small");
  // Only an ANIMATED image has to skip this — the canvas path would flatten it
  // to its first frame. A still GIF, WebP or PNG is just a picture. A GIF that
  // cannot be read counts as animated, which can only cost bytes rather than
  // the image (see gifFrameCount).
  let head = null;
  try {
    head = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
  } catch (_) {
    if (type === "image/gif") return uncompressedImage(file, "animated — kept whole");
  }
  if (head && isAnimatedImage(head, type)) {
    return uncompressedImage(withSniffedType(file, head), "animated — kept whole");
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); resolve(uncompressedImage(file, "couldn't be read here")); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const sourceWidth = img.naturalWidth;
      const sourceHeight = img.naturalHeight;
      if (!sourceWidth || !sourceHeight) { resolve(uncompressedImage(file, "couldn't be read here")); return; }
      const scale = Math.min(1, settings.maxDimension / Math.max(sourceWidth, sourceHeight));
      // Whether the re-encode is allowed to lose on bytes alone. If the source
      // is oversized, the downscale is the point: a 4000px JPEG that is already
      // well compressed would otherwise be stored at 4000px and decoded at that
      // size on every single view, on every device.
      const wasDownscaled = scale < 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(uncompressedImage(file, "no canvas here", sourceWidth, sourceHeight)); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const toBlob = (mime) => new Promise((res) => canvas.toBlob(res, mime, settings.quality));
      // WebP keeps transparency and compresses better; fall back to JPEG if it's unsupported.
      toBlob("image/webp")
        .then((blob) => blob || toBlob("image/jpeg"))
        .then((blob) => {
          if (!blob || (blob.size >= file.size && !wasDownscaled)) {
            resolve(uncompressedImage(file, "already smaller than a re-encode", sourceWidth, sourceHeight));
            return;
          }
          const ext = IMAGE_MIME_EXT[blob.type] || "img";
          const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
          resolve({
            file: new File([blob], `${baseName}.${ext}`, { type: blob.type }),
            width: canvas.width,
            height: canvas.height,
            sourceWidth,
            sourceHeight,
            skipped: false,
            reason: ""
          });
        })
        .catch(() => resolve(uncompressedImage(file, "couldn't be re-encoded", sourceWidth, sourceHeight)));
    };
    img.src = url;
  });
}

// Every file at one level, in order, reporting as it goes.
//
// The estimate IS the encode: what the dialog shows is the size of the blob it
// will upload if you confirm, not a guess about it, and confirming uploads
// exactly those blobs. `cache` (a Map of file -> Map of level key -> result)
// is what makes flipping between levels cheap — and holding it in the dialog
// rather than here means it is released with the dialog.
export async function prepareImagesForUpload(files, choice, { onProgress = null, cache = null, cancelled = null } = {}) {
  const key = imageCompressionKey(choice);
  const results = [];
  for (let i = 0; i < files.length; i += 1) {
    if (cancelled?.()) return null;
    const file = files[i];
    const perFile = cache?.get(file);
    const known = perFile?.get(key);
    if (known) {
      results.push(known);
      onProgress?.(i + 1, files.length);
      continue;
    }
    onProgress?.(i, files.length);
    const result = await compressImageToPreset(file, choice);
    if (cancelled?.()) return null;
    if (cache) {
      const store = perFile || new Map();
      store.set(key, result);
      cache.set(file, store);
    }
    results.push(result);
    onProgress?.(i + 1, files.length);
  }
  return results;
}
