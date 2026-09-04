// The pdf.js the app ships, on disk, for a check to inject.
//
// The app loads it from jsdelivr (LIB_URLS.pdfjs) and the service worker
// precaches it, which is right for a browser and useless to a check running on a
// machine that may have no route to a CDN at all. So the same version is fetched
// once from npm and cached under /tmp, exactly as epub-preview-check.mjs caches
// jszip — and then INJECTED, which also means a check exercises ensurePdfJs's
// "the library is already on window" path rather than depending on a network
// fetch mid-run.
//
// Here rather than in one of the checks because there are two of them now:
// tools/pdf-preview-check.mjs, which reads somebody else's paper, and
// tools/handwriting-check.mjs, which writes on one this app generated. Two
// copies of a version number is two chances for a check to pass against a
// different pdf.js than the app ships, which is a check that proves nothing.
//
// The version here must match LIB_URLS.pdfjs in src/core/lib-loader.js.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const PDFJS_VERSION = "3.11.174";
const CACHE_DIR = "/tmp/recall-pdfjs";

export function pdfjsSources() {
  const build = path.join(CACHE_DIR, "package/legacy/build");
  const main = path.join(build, "pdf.min.js");
  const worker = path.join(build, "pdf.worker.min.js");
  if (!existsSync(main) || !existsSync(worker)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tarball = `pdfjs-dist-${PDFJS_VERSION}.tgz`;
    if (!existsSync(path.join(CACHE_DIR, tarball))) {
      execFileSync("npm", ["pack", `pdfjs-dist@${PDFJS_VERSION}`], { cwd: CACHE_DIR, stdio: "ignore" });
    }
    execFileSync("tar", [
      "xzf", tarball,
      "package/legacy/build/pdf.min.js",
      "package/legacy/build/pdf.worker.min.js"
    ], { cwd: CACHE_DIR, stdio: "ignore" });
  }
  return { main: readFileSync(main, "utf8"), worker: readFileSync(worker, "utf8") };
}
