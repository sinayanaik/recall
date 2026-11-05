// Is this font file a variable font?
//
// Chrome's PDF backend (Skia) cannot subset a variable font, so it draws every
// glyph of one as a Type 3 font: a little picture per letter. The PDF gets
// bigger, its text slower to draw and blurrier in most readers. Many sites now
// serve variable fonts (one file for every weight), so Save as PDF finds them
// (pdf-job.js reads each @font-face's file through the debugger) and prints
// that text in the page's fallback font instead (content/prepare.js
// replaceFonts).
//
// A variable font has an `fvar` table. Its name is in the table directory,
// which every format keeps uncompressed: TrueType/OpenType, WOFF and WOFF2.
//
// Plain ES module: used by pdf-job.js, and by the app's checks under Node.

// WOFF2's table directory names the common tables by index; `fvar` is 47.
const WOFF2_FVAR = 47;
const WOFF2_GLYF = 10;
const WOFF2_LOCA = 11;

const tagAt = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const u16 = (b, i) => (b[i] << 8) | b[i + 1];

function sfntHasFvar(b) {
  if (b.length < 12) return false;
  const n = u16(b, 4);
  for (let k = 0; k < n; k += 1) {
    const at = 12 + k * 16;
    if (at + 4 > b.length) return false;
    if (tagAt(b, at) === "fvar") return true;
  }
  return false;
}

function woffHasFvar(b) {
  if (b.length < 44) return false;
  const n = u16(b, 12);
  for (let k = 0; k < n; k += 1) {
    const at = 44 + k * 20;
    if (at + 4 > b.length) return false;
    if (tagAt(b, at) === "fvar") return true;
  }
  return false;
}

function woff2HasFvar(b) {
  if (b.length < 48) return false;
  const n = u16(b, 12);
  let i = 48;
  const base128 = () => {
    let value = 0;
    for (let k = 0; k < 5; k += 1) {
      if (i >= b.length) throw new Error("short");
      const byte = b[i++];
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error("bad UIntBase128");
  };
  try {
    for (let k = 0; k < n; k += 1) {
      const flags = b[i++];
      const index = flags & 0x3f;
      const version = flags >> 6;
      let tag = null;
      if (index === 63) { tag = tagAt(b, i); i += 4; }
      if (index === WOFF2_FVAR || tag === "fvar") return true;
      base128(); // origLength
      const glyfOrLoca = index === WOFF2_GLYF || index === WOFF2_LOCA || tag === "glyf" || tag === "loca";
      if (glyfOrLoca ? version === 0 : version !== 0) base128(); // transformLength
    }
  } catch { /* a directory cut short: no fvar found in it */ }
  return false;
}

/** True when `bytes` (a TTF/OTF, WOFF or WOFF2 file) is a variable font. */
export function isVariableFont(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 12) return false;
  const sig = tagAt(b, 0);
  if (sig === "wOF2") return woff2HasFvar(b);
  if (sig === "wOFF") return woffHasFvar(b);
  if (sig === "\0\u0001\0\0" || sig === "OTTO" || sig === "true") return sfntHasFvar(b);
  return false;
}

/**
 * The @font-face rules in a stylesheet's text: [{ family, urls }], `urls`
 * resolved against `baseUrl` (data: URLs kept as they are).
 */
export function fontFaces(cssText, baseUrl) {
  const out = [];
  const text = String(cssText || "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = m[1];
    const fam = /font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i.exec(body);
    if (!fam) continue;
    const family = (fam[1] || fam[2] || fam[3] || "").trim();
    // Up to the next descriptor: a data: URL has a ";" of its own.
    const src = /(?:^|;)\s*src\s*:([\s\S]*?)(?=;\s*[a-z-]+\s*:|;?\s*$)/i.exec(body);
    if (!family || !src) continue;
    const urls = [];
    for (const u of src[1].matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
      const raw = (u[1] ?? u[2] ?? u[3] ?? "").trim();
      if (!raw) continue;
      if (raw.startsWith("data:")) { urls.push(raw); continue; }
      try { urls.push(new URL(raw, baseUrl || undefined).href); } catch { /* unresolvable */ }
    }
    out.push({ family, urls });
  }
  return out;
}
