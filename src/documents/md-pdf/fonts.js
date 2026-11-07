// Markdown → PDF: the font files, fetched in the browser.
//
// Which files a document needs is fonts-core.js's business (pure); this only
// fetches them — from the same @fontsource CDN the Style panel's webfonts come
// from (FONT_CDN_BASE), so the service worker caches each the first time it is
// used (isCdnAsset in sw.js) and the four that set a page of English are
// precached outright (MD_PDF_OFFLINE_FACES, listed in sw.js's CDN_ASSETS) — and
// turns each .woff into the plain TrueType fontkit reads correctly (woff.js).
//
// Kept for the session: a dialog that re-lays the PDF out on every keystroke
// asks for the same faces again and again.

import { FONT_CDN_BASE, ensureFontkit } from "../../core/lib-loader.js?v=__BUILD__";
import { facePath } from "./fonts-core.js?v=__BUILD__";
import { woffToSfnt } from "./woff.js?v=__BUILD__";

export const MD_PDF_OFFLINE_FACES = [
  "sans|latin|400|normal",
  "sans|latin|700|normal",
  "sans|latin|400|italic",
  "mono|latin|400|normal"
];

const bytesCache = new Map(); // face → Promise<Uint8Array | null>
const fontCache = new Map();  // face → fontkit font

async function inflateWoffTable(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function fetchFace(face) {
  let pending = bytesCache.get(face);
  if (pending) return pending;
  pending = (async () => {
    const path = facePath(face);
    if (!path) return null;
    try {
      const response = await fetch(`${FONT_CDN_BASE}${path}`, { mode: "cors" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await woffToSfnt(new Uint8Array(await response.arrayBuffer()), inflateWoffTable);
    } catch (error) {
      console.warn("Could not load a font for the PDF", face, error);
      // Not cached as a failure: back online, the next build asks again.
      bytesCache.delete(face);
      return null;
    }
  })();
  bytesCache.set(face, pending);
  return pending;
}

// The faces asked for, loaded: { bytes: Map face → TrueType bytes, fonts: Map
// face → fontkit font, missing: [face] }. Throws only when fontkit itself
// cannot be loaded (offline before it was ever fetched).
export async function loadFaces(faces) {
  if (!(await ensureFontkit())) {
    const error = new Error("fontkit unavailable");
    error.code = "fontkit";
    throw error;
  }
  const bytes = new Map();
  const fonts = new Map();
  const missing = [];
  await Promise.all([...faces].map(async (face) => {
    const data = await fetchFace(face);
    if (!data) { missing.push(face); return; }
    bytes.set(face, data);
    let font = fontCache.get(face);
    if (!font) {
      try {
        font = window.fontkit.create(data);
        fontCache.set(face, font);
      } catch (error) {
        console.warn("Could not read a font for the PDF", face, error);
        missing.push(face);
        return;
      }
    }
    fonts.set(face, font);
  }));
  return { bytes, fonts, missing };
}
