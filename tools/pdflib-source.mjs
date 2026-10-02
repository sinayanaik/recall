// The pdf-lib the app ships, on disk, for a check to inject.
//
// The app loads it from jsdelivr (LIB_URLS.pdfLib) when a region is saved as a
// PDF, and the service worker precaches it. A check may have no route to a CDN,
// so the same version is fetched once from npm and cached under /tmp — the
// same arrangement as tools/pdfjs-source.mjs, and for the same reason.
//
// The version here must match LIB_URLS.pdfLib in src/core/lib-loader.js.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const PDFLIB_VERSION = "1.17.1";
const CACHE_DIR = "/tmp/recall-pdflib";

export function pdflibSource() {
  const main = path.join(CACHE_DIR, "package/dist/pdf-lib.min.js");
  if (!existsSync(main)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tarball = `pdf-lib-${PDFLIB_VERSION}.tgz`;
    if (!existsSync(path.join(CACHE_DIR, tarball))) {
      execFileSync("npm", ["pack", `pdf-lib@${PDFLIB_VERSION}`], { cwd: CACHE_DIR, stdio: "ignore" });
    }
    execFileSync("tar", ["xzf", tarball, "package/dist/pdf-lib.min.js"], { cwd: CACHE_DIR, stdio: "ignore" });
  }
  return readFileSync(main, "utf8");
}
