// The html-to-image the app ships, on disk, for a check to inject.
//
// The app loads it from jsdelivr (LIB_URLS.htmlToImage) when a region with a
// typed or picture block in it is drawn as pixels, and the service worker
// precaches it. A check may have no route to a CDN, so the same version is
// fetched once from npm and cached under /tmp — the same arrangement as
// tools/pdfjs-source.mjs and tools/pdflib-source.mjs.
//
// The version here must match LIB_URLS.htmlToImage in src/core/lib-loader.js.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const HTMLTOIMAGE_VERSION = "1.11.11";
const CACHE_DIR = "/tmp/recall-htmltoimage";

export function htmlToImageSource() {
  const main = path.join(CACHE_DIR, "package/dist/html-to-image.js");
  if (!existsSync(main)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tarball = `html-to-image-${HTMLTOIMAGE_VERSION}.tgz`;
    if (!existsSync(path.join(CACHE_DIR, tarball))) {
      execFileSync("npm", ["pack", `html-to-image@${HTMLTOIMAGE_VERSION}`], { cwd: CACHE_DIR, stdio: "ignore" });
    }
    execFileSync("tar", ["xzf", tarball, "package/dist/html-to-image.js"], { cwd: CACHE_DIR, stdio: "ignore" });
  }
  return readFileSync(main, "utf8");
}
