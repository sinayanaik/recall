// Does every image in a note get a control, and does using one rewrite only
// that image?
//
//   node tools/image-controls-check.mjs
//
// The resize grip and the delete button used to be bound to an image by the
// index of the top-level marked token that contained it. Three classes of
// image had no controls at all under that scheme — one in a table cell, one
// wrapped in a link inside a sentence, one inside an HTML block — and no image
// in a lazily built note had them until the whole note was in the DOM. Both
// are now answered by findSourceImages, which finds an image by scanning the
// SOURCE, so this check asks the two questions that scheme has to get right:
//
//   parity   does the scan find exactly the images the renderer renders,
//            in the same order? marked is the oracle: it is the thing that
//            decides what becomes an <img>, so agreeing with it is the whole
//            definition of "found every image and invented none". Fenced and
//            inline code are the interesting half — an `![](…)` in a code
//            block renders as text, and a control that rewrote it would be
//            editing something nobody can see.
//
//   surgery  does committing a width, or a delete, change that image's own
//            slice and NOTHING else in the note? This is what the old path
//            could not promise: it re-emitted the whole note from its token
//            array, so every blank line in a 2.6MB book was re-normalised to
//            change one number.
//
// ── Why this needs no browser ──────────────────────────────────────────────
//
// Every function involved is a pure function of a string. The `?v=__BUILD__`
// query on the app's import specifiers stops Node importing the modules
// directly, so the declarations are lifted out as TEXT with the same scanner
// split-parity uses and evaluated in a scope holding stubs for the two things
// a commit touches beyond the string (the toast, the autosave). If one of them
// ever grows a real DOM dependency this throws on the first call, loudly,
// which is right.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelDecls } from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const marked = require("../vendor/marked-14.1.2/marked.min.js");

// ── Lifting the real code out of the app ───────────────────────────────────

const WANTED = [
  ["src/core/text.js", ["escapeHtml"]],
  ["src/render/inline.js", ["IMG_TOKEN_SOURCE"]],
  ["src/render/preprocess.js", ["FENCE_PATTERN_SOURCE", "fencePattern", "normalizeImageUrl"]],
  ["src/images/surface-controls.js", [
    "IMAGE_RESIZE_MIN_PX", "IMAGE_RESIZE_MAX_PX",
    "decodeMarkupEntities", "parseImgTagAttrs", "parseMarkdownImage",
    "IMAGE_REF_DEFINITION_RE", "imageRefDefinitions", "parseReferenceImage",
    "sourceImagePattern", "findSourceImages",
    "sourceMayHaveImages", "imgTagHtml",
    "sourceImageAt", "pipeRowLinePattern", "imageRemovalRange",
    "replaceSourceImage", "commitSourceImageWidth", "removeSourceImage"
  ]]
];

function liftDeclarations() {
  const parts = [];
  const names = [];
  for (const [file, wanted] of WANTED) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    const decls = new Map(topLevelDecls(src).map((d) => [d.name, d]));
    const missing = wanted.filter((name) => !decls.has(name));
    if (missing.length) {
      console.log(`image-controls-check: ${file} has no ${missing.join(", ")} — nothing to check.`);
      process.exit(1);
    }
    // Declaration ORDER as written, so a const referenced by a later const is
    // already initialised. `text` skips the `export ` keyword, which is exactly
    // what makes these evaluable outside a module.
    parts.push(wanted
      .map((name) => decls.get(name))
      .sort((a, b) => a.start - b.start)
      .map((d) => (d.kind === "function" || d.kind === "class" ? d.text : `${d.kind} ${d.text}`.replace(/^(const|let|var) (const|let|var) /, "$1 ")))
      .join("\n\n"));
    names.push(...wanted);
  }
  const toasts = [];
  const deleted = [];
  const factory = new Function(
    "showToast", "scheduleDeckAutosave", "deckStillReferencesImage", "deleteSupabaseImage",
    `${parts.join("\n\n")}\nreturn { ${names.join(", ")} };`
  );
  const api = factory(
    (message, kind) => toasts.push({ message, kind }),
    () => {},                          // autosave
    () => false,                       // "nothing else in the deck points at it"
    (url) => deleted.push(url)
  );
  return { api, toasts, deleted };
}

const { api, toasts, deleted } = liftDeclarations();

// ── The corpus ─────────────────────────────────────────────────────────────
//
// One shape per way an image can sit in a note. The first six are the ones the
// token walker could not see at all.

const SHAPES = {
  standalone: "Before.\n\n![one](https://img.test/1.png)\n\nAfter.\n",
  midSentence: "A line with ![two](https://img.test/2.png) inside it.\n",
  bullet: "- first\n- second ![three](https://img.test/3.png)\n",
  nestedBullet: "- outer\n  - inner ![four](https://img.test/4.png)\n",
  blockquote: "> quoted ![five](https://img.test/5.png) text\n",
  tableCell: "| a | b |\n|---|---|\n| ![six](https://img.test/6.png) | x |\n",
  linkWrapped: "See [![seven](https://img.test/7.png)](https://img.test/page) here.\n",
  htmlBlock: "<div align=\"center\"><img src=\"https://img.test/8.png\" alt=\"eight\"></div>\n",
  heading: "# Title ![nine](https://img.test/9.png)\n",
  twoInAParagraph: "![a](https://img.test/10a.png) ![b](https://img.test/10b.png)\n",
  pipeRow: "![a](https://img.test/11a.png) | ![b](https://img.test/11b.png)\n",
  alreadySized: "<img src=\"https://img.test/12.png\" alt=\"twelve\" style=\"--notes-img-w:320px; width:320px\">\n",
  referenceStyle: "![thirteen][fig]\n\n[fig]: https://img.test/13.png\n",
  entityUrl: "<img src=\"https://img.test/14.png?a=1&amp;b=2\" alt=\"fourteen\">\n",
  sameImageTwice: "![dup](https://img.test/15.png)\n\nmiddle\n\n![dup](https://img.test/15.png)\n",
  fencedCode: "```\n![hidden](https://img.test/no-1.png)\n```\n\n![real](https://img.test/16.png)\n",
  inlineCode: "Write `![hidden](https://img.test/no-2.png)` then ![real](https://img.test/17.png)\n",
  mixedBook: [
    "# Chapter\n",
    "\n",
    "Text with ![a](https://img.test/18a.png) inline.\n",
    "\n",
    "| head |\n|---|\n| ![b](https://img.test/18b.png) |\n",
    "\n",
    "```js\nconst s = \"![c](https://img.test/no-3.png)\";\n```\n",
    "\n",
    "- bullet [![d](https://img.test/18d.png)](https://img.test/page)\n",
    "\n",
    "<div><img src=\"https://img.test/18e.png\" alt=\"e\"></div>\n"
  ].join("")
};

// ── The oracle ─────────────────────────────────────────────────────────────
// What marked turns into an <img>, in document order. This is deliberately not
// the app's render pipeline: preprocessSpecialBlocks only reshapes a `|` row
// into a <div> holding the same images, so the SET is the same and using
// marked alone keeps the oracle independent of the code under test.

function renderedImageUrls(source) {
  const html = marked.parse(source);
  return [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi)].map((m) => api.decodeMarkupEntities(m[1]));
}

function makeSurface(source) {
  const box = { source, renders: 0 };
  return {
    getSource: () => box.source,
    setSource: (value) => { box.source = value; },
    rerender: () => { box.renders += 1; },
    box
  };
}

const failures = [];
let checks = 0;

function assert(ok, message) {
  checks += 1;
  if (!ok) failures.push(message);
}

// ── parity ─────────────────────────────────────────────────────────────────

for (const [name, source] of Object.entries(SHAPES)) {
  const want = renderedImageUrls(source);
  const got = api.findSourceImages(source).map((image) => image.url);
  assert(
    got.length === want.length && got.every((url, i) => url === want[i]),
    `${name}: scan found ${JSON.stringify(got)}, the renderer renders ${JSON.stringify(want)}`
  );
  // Every slice has to BE the text it says it is, or a commit splices the
  // wrong range.
  for (const image of api.findSourceImages(source)) {
    assert(
      source.slice(image.start, image.end) === image.raw,
      `${name}: slice [${image.start},${image.end}) is not the raw ${JSON.stringify(image.raw)}`
    );
  }
}

// A committed width has to come back off the tag it was written to.
{
  const [image] = api.findSourceImages(SHAPES.alreadySized);
  assert(image?.widthPx === 320, `alreadySized: read back widthPx ${image?.widthPx}, want 320`);
  assert(image?.alt === "twelve", `alreadySized: read back alt ${JSON.stringify(image?.alt)}`);
}
{
  const [image] = api.findSourceImages(SHAPES.entityUrl);
  assert(image?.url === "https://img.test/14.png?a=1&b=2", `entityUrl: read back ${JSON.stringify(image?.url)}`);
}

// ── surgery: a width commit ────────────────────────────────────────────────

for (const [name, source] of Object.entries(SHAPES)) {
  const images = api.findSourceImages(source);
  for (let nth = 0; nth < images.length; nth += 1) {
    const image = images[nth];
    const sameUrl = images.filter((other) => other.url === image.url);
    const surface = makeSurface(source);
    api.commitSourceImageWidth(surface, { url: image.url, nth: sameUrl.indexOf(image) }, 321);
    const next = surface.getSource();
    const want = source.slice(0, image.start)
      + api.imgTagHtml({ url: image.url, alt: image.alt, widthPx: 321 })
      + source.slice(image.end);
    assert(next === want, `${name} #${nth}: resize wrote\n      ${JSON.stringify(next)}\n      want ${JSON.stringify(want)}`);
    // ...and the note still holds the same images, this one now sized.
    const after = api.findSourceImages(next);
    assert(
      after.length === images.length && after.every((other, i) => other.url === images[i].url),
      `${name} #${nth}: resize changed which images the note holds`
    );
    const resized = after.filter((other) => other.url === image.url)[sameUrl.indexOf(image)];
    assert(resized?.widthPx === 321, `${name} #${nth}: resized image reads back widthPx ${resized?.widthPx}`);
    assert(surface.box.renders === 1, `${name} #${nth}: resize re-rendered ${surface.box.renders} times`);
  }
}

// Sizes are clamped, not trusted.
{
  const surface = makeSurface(SHAPES.standalone);
  api.commitSourceImageWidth(surface, { url: "https://img.test/1.png", nth: 0 }, 99999);
  assert(
    surface.getSource().includes(`--notes-img-w:${api.IMAGE_RESIZE_MAX_PX}px`),
    `clamp: a 99999px drag was not clamped to ${api.IMAGE_RESIZE_MAX_PX}`
  );
}

// ── surgery: a delete ──────────────────────────────────────────────────────

for (const [name, source] of Object.entries(SHAPES)) {
  const images = api.findSourceImages(source);
  for (let nth = 0; nth < images.length; nth += 1) {
    const image = images[nth];
    const sameUrl = images.filter((other) => other.url === image.url);
    const surface = makeSurface(source);
    api.removeSourceImage(surface, { url: image.url, nth: sameUrl.indexOf(image) });
    const next = surface.getSource();
    const after = api.findSourceImages(next);
    const wantUrls = images.filter((_, i) => i !== nth).map((other) => other.url);
    assert(
      after.length === wantUrls.length && after.every((other, i) => other.url === wantUrls[i]),
      `${name} #${nth}: after deleting, the note holds ${JSON.stringify(after.map((o) => o.url))}, want ${JSON.stringify(wantUrls)}`
    );
    // Everything the delete did not aim at is untouched: what is left has to be
    // the note minus a range that CONTAINS the image and nothing but blank
    // space and separators around it.
    const cut = source.length - next.length;
    assert(cut >= image.raw.length, `${name} #${nth}: delete cut ${cut} chars for a ${image.raw.length}-char image`);
    const removedExtra = cut - image.raw.length;
    assert(removedExtra <= 4, `${name} #${nth}: delete cut ${removedExtra} chars beyond the image itself`);
    // No hole where the picture was.
    assert(!/\n{3,}/.test(next), `${name} #${nth}: delete left a blank hole:\n      ${JSON.stringify(next)}`);
    assert(!/^[^\S\n]*\|/m.test(next.replace(/^\|.*\|$/gm, "")), `${name} #${nth}: delete left a stray row separator:\n      ${JSON.stringify(next)}`);
  }
}

// A standalone image between two paragraphs takes its whole line with it.
{
  const surface = makeSurface(SHAPES.standalone);
  api.removeSourceImage(surface, { url: "https://img.test/1.png", nth: 0 });
  assert(surface.getSource() === "Before.\n\nAfter.\n", `standalone delete left ${JSON.stringify(surface.getSource())}`);
}

// A side-by-side row loses its separator with the image, not afterwards.
{
  const surface = makeSurface(SHAPES.pipeRow);
  api.removeSourceImage(surface, { url: "https://img.test/11a.png", nth: 0 });
  assert(surface.getSource() === "![b](https://img.test/11b.png)\n", `pipeRow delete left ${JSON.stringify(surface.getSource())}`);
}

// The right copy of a repeated image, not the first one that matches.
{
  const surface = makeSurface(SHAPES.sameImageTwice);
  api.removeSourceImage(surface, { url: "https://img.test/15.png", nth: 1 });
  assert(
    surface.getSource() === "![dup](https://img.test/15.png)\n\nmiddle\n",
    `sameImageTwice: deleting the second copy left ${JSON.stringify(surface.getSource())}`
  );
}

// The storage object is deleted only when nothing else in the deck points at
// it — deckStillReferencesImage is stubbed false above, so this one runs.
{
  deleted.length = 0;
  const surface = makeSurface(SHAPES.standalone);
  api.removeSourceImage(surface, { url: "https://img.test/1.png", nth: 0 });
  assert(deleted.length === 1 && deleted[0] === "https://img.test/1.png", `delete did not offer the storage object: ${JSON.stringify(deleted)}`);
}

// ── the note moved underneath the control ──────────────────────────────────
// A grip is attached to a rendered image and the reader keeps typing. The ref
// is re-resolved against the note as it is NOW, so an edit above the image
// must not send the commit to the wrong place — and an image that has gone
// must not rewrite whatever took its offsets.
{
  const surface = makeSurface(SHAPES.standalone);
  const ref = { url: "https://img.test/1.png", nth: 0 };
  surface.setSource(`A new opening paragraph.\n\n${surface.getSource()}`);
  api.commitSourceImageWidth(surface, ref, 200);
  assert(
    surface.getSource().startsWith("A new opening paragraph.\n\nBefore.\n\n<img src=\"https://img.test/1.png\""),
    `moved image: commit wrote ${JSON.stringify(surface.getSource())}`
  );
}
{
  toasts.length = 0;
  const surface = makeSurface("No images here at all.\n");
  const before = surface.getSource();
  api.commitSourceImageWidth(surface, { url: "https://img.test/gone.png", nth: 0 }, 200);
  assert(surface.getSource() === before, "a commit for a vanished image rewrote the note anyway");
  assert(toasts.length === 1, `a commit for a vanished image said nothing (${toasts.length} toasts)`);
}

// ── Reporting ──────────────────────────────────────────────────────────────

console.log("");
if (failures.length) {
  failures.slice(0, 20).forEach((f) => console.log(`  FAIL  ${f}`));
  if (failures.length > 20) console.log(`  ...and ${failures.length - 20} more`);
}
console.log(
  `${Object.keys(SHAPES).length} note shapes · ${checks} assertions · ${failures.length} failed`
);
process.exit(failures.length ? 1 : 0);
