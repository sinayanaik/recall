// fontkit and the @fontsource fonts the app's Markdown → PDF uses, on disk,
// for a check to use.
//
// The app loads them from jsdelivr (LIB_URLS.fontkit, FONT_CDN_BASE + the
// paths in src/documents/md-pdf/fonts-core.js). A check may have no route to
// a CDN, so the same versions are fetched once from npm and cached under /tmp
// — the same arrangement as tools/pdflib-source.mjs.
//
// The versions here must match LIB_URLS.fontkit in src/core/lib-loader.js and
// MD_FONT_VERSION in src/documents/md-pdf/fonts-core.js.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const FONTKIT_VERSION = "1.1.1";
export const FONTSOURCE_VERSION = "5.3.0";
const CACHE_DIR = "/tmp/recall-fontkit";
const FONT_PACKAGES = ["noto-sans", "noto-serif", "jetbrains-mono", "noto-sans-math", "noto-sans-symbols-2"];

function unpack(spec, dir) {
  const target = path.join(CACHE_DIR, dir);
  if (existsSync(path.join(target, "package.json"))) return target;
  mkdirSync(target, { recursive: true });
  const name = execFileSync("npm", ["pack", spec], { cwd: CACHE_DIR, encoding: "utf8" }).trim().split("\n").pop();
  execFileSync("tar", ["xzf", name, "-C", target, "--strip-components=1"], { cwd: CACHE_DIR, stdio: "ignore" });
  return target;
}

export function fontkitSource() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const dir = unpack(`@pdf-lib/fontkit@${FONTKIT_VERSION}`, `pdf-lib-fontkit-${FONTKIT_VERSION}`);
  return readFileSync(path.join(dir, "dist/fontkit.umd.min.js"), "utf8");
}

// The bytes of a font file named as fonts-core's facePath names it
// ("noto-sans@5.3.0/files/noto-sans-latin-400-normal.woff"), or null.
export function fontFile(relative) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const m = String(relative).match(/^([a-z0-9-]+)@([\d.]+)\/(.+)$/);
  if (!m || !FONT_PACKAGES.includes(m[1])) return null;
  const dir = unpack(`@fontsource/${m[1]}@${m[2]}`, `${m[1]}-${m[2]}`);
  const file = path.join(dir, m[3]);
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
}
