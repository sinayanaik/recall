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
  ["src/render/inline.js", ["IMG_ALT_SOURCE", "IMG_DEST_SOURCE", "IMG_TOKEN_SOURCE", "imageDestinationUrl"]],
  ["src/render/preprocess.js", [
    "FENCE_OPEN_SOURCE", "fenceOpenPattern", "scanFences",
    "QUOTE_PREFIX_SOURCE", "LIST_ITEM_SOURCE", "HTML_VERBATIM_TAGS",
    "lineAt", "fenceOpenOn", "isFenceCloseOn", "mergeRanges",
    "scanHtmlComments", "scanCodeRegions",
    "normalizeImageUrl"
  ]],
  ["src/images/surface-controls.js", [
    "IMAGE_RESIZE_MIN_PX", "IMAGE_RESIZE_MAX_PX",
    "decodeMarkupEntities", "parseImgTagAttrs", "parseMarkdownImage",
    "IMAGE_REF_DEFINITION_RE", "imageRefDefinitions", "parseReferenceImage",
    "sourceImagePattern", "isEscapedOffset", "findSourceImages",
    "sourceMayHaveImages", "markedImageUrl", "imageMatchKey", "imgTagHtml",
    "sourceImageAt", "sourceImageFor", "pipeRowLinePattern", "imageRemovalRange",
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
  // ── The six the old scanner got wrong ────────────────────────────────────
  // Each of these renders images that had no resize grip and no delete button,
  // or offered a control over text that is not a picture at all. The first two
  // are a truncating token; the last four are a fence scanner that paired ```
  // markers by count wherever they sat.
  parenUrl: "![](https://img.test/Foo_(bar)_19.png)\n",
  bracketAlt: "![see [1]](https://img.test/20.png)\n",
  titledImage: "![alt](https://img.test/21.png \"a title\")\n",
  tildeFence: "~~~\n![hidden](https://img.test/no-4.png)\n~~~\n\n![real](https://img.test/22.png)\n",
  // A bare ``` written inside a sentence, which is how a note ABOUT code talks
  // about fences. It used to open one, and everything to the next marker — the
  // first image included — was read as code.
  strayInlineFence: "Wrap it in ``` fences.\n\n![](https://img.test/23a.png)\n\nOr in ``` these.\n\n![](https://img.test/23b.png)\n",
  unclosedFence: "```js\nconst s = 1;\n\n![hidden](https://img.test/no-5.png)\n",
  quadFence: "````\n```\n![hidden](https://img.test/no-6.png)\n```\n````\n\n![real](https://img.test/24.png)\n",
  indentedFence: "- item\n\n  ```js\n  ![hidden](https://img.test/no-7.png)\n  ```\n\n![real](https://img.test/25.png)\n",
  // ── The rest of what the renderer calls code ─────────────────────────────
  // scanFences answered "where are the fences", which is not the same question
  // as "what will the reader see as text". marked treats all five of these as
  // code or as verbatim HTML, and the scan reported an image for every one —
  // a phantom that shares its URL with the real picture whenever a note quotes
  // its own markdown, which is enough to cost the real one its controls.
  indentedCode: "Text\n\n    ![hidden](https://img.test/no-8.png)\n\n![real](https://img.test/26.png)\n",
  tabIndentedCode: "Text\n\n\t![hidden](https://img.test/no-9.png)\n\n![real](https://img.test/27.png)\n",
  blockquoteFence: "> ```js\n> ![hidden](https://img.test/no-10.png)\n> ```\n\n![real](https://img.test/28.png)\n",
  listIndentedFence: "- item\n\n    ```js\n    ![hidden](https://img.test/no-11.png)\n    ```\n\n![real](https://img.test/29.png)\n",
  htmlComment: "<!--\n![hidden](https://img.test/no-12.png)\n-->\n\n![real](https://img.test/30.png)\n",
  inlineHtmlComment: "Text <!-- ![hidden](https://img.test/no-13.png) --> more.\n\n![real](https://img.test/31.png)\n",
  verbatimHtmlBlock: "<pre>\n![hidden](https://img.test/no-14.png)\n</pre>\n\n![real](https://img.test/32.png)\n",
  escapedImage: "\\![notapicture](https://img.test/no-15.png)\n\n![real](https://img.test/33.png)\n",
  // ...and the shapes that must NOT be mistaken for code. Each of these renders
  // a real picture, and reading its indentation as a code block would take that
  // picture's controls away — the very bug being fixed.
  listContinuation: "- item\n\n    ![real](https://img.test/34.png)\n\n- next\n",
  orderedContinuation: "1. one\n\n   ![real](https://img.test/35.png)\n\n2. two\n",
  lazyWrappedLine: "Some text\n    wrapping with indentation ![real](https://img.test/36.png)\n",
  quotedImage: "> one\n>\n> ![real](https://img.test/37.png)\n",
  // ── URLs the two sides used to spell differently ─────────────────────────
  // marked's cleanUrl percent-encodes an image destination; the markdown does
  // not. Compared raw these missed, and a miss is a picture with a Zoom pill
  // and no grip on every render, forever.
  unicodeUrl: "![a](https://img.test/\u00dcber-38.png)\n",
  spacedUrl: "![a](<https://img.test/space 39.png>)\n",
  encodedUrl: "![a](https://img.test/already%2040.png)\n",
  reservedEncodedUrl: "![a](https://img.test/plus%2B41.png)\n",
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

// Parity is asked of the KEY, not of the two spellings, because the key is what
// enhanceSurfaceImageControls actually pairs on: marked writes the URL through
// its own cleanUrl and the markdown keeps it as written, so `Über.png` on one
// side and `%C3%9Cber.png` on the other are the same picture and have to
// compare equal here or the grip goes missing on screen.
const key = (url) => api.imageMatchKey(url);

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
  const want = renderedImageUrls(source).map(key);
  const got = api.findSourceImages(source).map((image) => key(image.url));
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

// ── The one place the scan still over-reports, deliberately ────────────────
//
// An indented code block INSIDE a list item — "- a", a blank line, then six
// spaces and an image. Six spaces is four past that item's content column, so
// marked reads it as code and renders nothing. Answering that needs the item's
// content column tracked through nesting, and getting THAT wrong in the other
// direction — reading an ordinary list continuation as code — would take a real
// picture's controls away, which is the failure this whole file is about.
//
// So the scan reports an image there and no shell ever matches it. Asserted as
// a DIRECTION rather than an equality, because the two errors are not
// equivalent: a phantom costs nothing a reader can see, and a miss is a picture
// on screen with no grip and no delete button.
{
  const source = "- a\n\n      ![deep](https://img.test/deep.png)\n";
  const rendered = renderedImageUrls(source).map(key);
  const scanned = api.findSourceImages(source).map((image) => key(image.url));
  assert(rendered.length === 0, `deepIndentInsideList: marked now renders ${JSON.stringify(rendered)} — the tolerance below is stale`);
  assert(
    rendered.every((url) => scanned.includes(url)),
    "deepIndentInsideList: the scan missed a picture the renderer draws"
  );
}

// Nothing the scan hands back may be a picture the renderer does NOT draw when
// it also fails to find one it does. Said across the whole corpus, because a
// miss is the failure that reaches a reader.
for (const [name, source] of Object.entries(SHAPES)) {
  const rendered = renderedImageUrls(source).map(key);
  const scanned = api.findSourceImages(source).map((image) => key(image.url));
  assert(
    rendered.every((url) => scanned.includes(url)),
    `${name}: the renderer draws ${JSON.stringify(rendered)} and the scan found ${JSON.stringify(scanned)} — a picture with no slice has no controls`
  );
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
    api.commitSourceImageWidth(surface, { url: key(image.url), nth: sameUrl.indexOf(image) }, 321);
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

// ── recovery: the picture the scan cannot find ─────────────────────────────
//
// Every control is now attached to every image on an editable surface, paired
// or not, so a shell whose slice the scan missed is no longer a picture with no
// grip — it is a grip whose slice has to be found when it is USED. sourceImageFor
// is that second look, and the four cases below are its whole contract.
{
  // A real picture the scan cannot see: an <img> inside a <pre>. marked treats
  // <pre> as verbatim HTML and hands the whole block to the page, so the
  // browser paints a real image and addDiagramZoomControl wraps it in a shell —
  // while scanCodeRegions, correctly for its own question, calls that region
  // code and skips it. On screen, no grip and no delete button, forever.
  const inPre = "<pre><img src=\"https://img.test/30.png\" alt=\"fig\"></pre>\n";
  assert(
    !api.findSourceImages(inPre).some((image) => image.url.includes("30.png")),
    "the <pre> fixture is not the case it exists to be: the strict scan found it"
  );
  const ref = { url: key("https://img.test/30.png"), nth: 0, rendered: true };
  assert(
    api.sourceImageFor(inPre, ref)?.url === "https://img.test/30.png",
    "an image the code-region scan skipped is still found for a shell that exists"
  );
  // ...but not without an element. A ref with no `rendered` on it has no
  // evidence that the renderer disagreed, and for it that text is still code —
  // which is what keeps an `![](…)` inside a fence untouchable.
  assert(
    api.sourceImageFor(inPre, { url: ref.url, nth: 0 }) === null,
    "...and is NOT found without one"
  );

  const surface = makeSurface(inPre);
  api.commitSourceImageWidth(surface, ref, 240);
  assert(
    surface.getSource() === inPre.replace(
      "<img src=\"https://img.test/30.png\" alt=\"fig\">",
      api.imgTagHtml({ url: "https://img.test/30.png", alt: "fig", widthPx: 240 })
    ),
    `recovered resize wrote ${JSON.stringify(surface.getSource())}`
  );
}

{
  // The last resort: the URL on the element and the URL in the markdown have
  // stopped agreeing for a reason nothing here anticipated. Position answers it
  // when the two lists are the same length, and declines when they are not.
  const source = SHAPES.twoInAParagraph;
  const total = api.findSourceImages(source).length;
  const stranger = { url: key("https://img.test/nowhere.png"), nth: 0, index: 1, total, rendered: true };
  assert(
    api.sourceImageFor(source, stranger)?.url === "https://img.test/10b.png",
    "a shell whose URL matches nothing falls back to its position when the counts agree"
  );
  assert(
    api.sourceImageFor(source, { ...stranger, total: total + 1 }) === null,
    "...and declines when they do not"
  );
}

// ── surgery: a delete ──────────────────────────────────────────────────────

for (const [name, source] of Object.entries(SHAPES)) {
  const images = api.findSourceImages(source);
  for (let nth = 0; nth < images.length; nth += 1) {
    const image = images[nth];
    const sameUrl = images.filter((other) => other.url === image.url);
    const surface = makeSurface(source);
    api.removeSourceImage(surface, { url: key(image.url), nth: sameUrl.indexOf(image) });
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
    // A coarse tripwire, and coarse on purpose — the assertion below is the one
    // that decides whether the delete was right. The allowance carries the
    // image line's own indentation, because a picture alone on a line inside a
    // list item takes that indentation with it, and leaving it behind would be
    // the bug rather than the fix.
    const lineIndent = (source.slice(source.lastIndexOf("\n", Math.max(0, image.start - 1)) + 1, image.start).match(/^[ \t]*/) || [""])[0].length;
    const removedExtra = cut - image.raw.length;
    assert(removedExtra <= 4 + lineIndent, `${name} #${nth}: delete cut ${removedExtra} chars beyond the image itself`);
    // Stronger, and the one that matters: whatever came out ALONGSIDE the
    // image can only be white space and at most one row separator. A delete
    // that ate a word, a bullet, a table pipe or a fence would show up here
    // however plausible the surviving text looked.
    const range = api.imageRemovalRange(source, image);
    const collateral = source.slice(range.start, range.end).replace(image.raw, "");
    assert(
      /^[\s|]*$/.test(collateral) && (collateral.match(/\|/g) || []).length <= 1,
      `${name} #${nth}: delete also removed ${JSON.stringify(collateral)}`
    );
    assert(
      source.slice(0, range.start) + source.slice(range.end) === next,
      `${name} #${nth}: delete changed the note outside the range it took`
    );
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

// A table row keeps its own pipes — those are structure, not separators.
{
  const surface = makeSurface(SHAPES.tableCell);
  api.removeSourceImage(surface, { url: "https://img.test/6.png", nth: 0 });
  assert(
    surface.getSource() === "| a | b |\n|---|---|\n|  | x |\n",
    `tableCell delete left ${JSON.stringify(surface.getSource())}`
  );
}

// An image alone on a line under a bullet takes itself, not the bullet.
{
  const surface = makeSurface("- one\n- ![](https://img.test/b.png)\n- three\n");
  api.removeSourceImage(surface, { url: "https://img.test/b.png", nth: 0 });
  assert(
    surface.getSource() === "- one\n- \n- three\n",
    `bullet delete left ${JSON.stringify(surface.getSource())}`
  );
}

// ...and one inside a fence is not an image at all, so nothing can act on it.
{
  const surface = makeSurface(SHAPES.fencedCode);
  const before = surface.getSource();
  api.removeSourceImage(surface, { url: "https://img.test/no-1.png", nth: 0 });
  assert(surface.getSource() === before, "a delete aimed at a fenced-code image rewrote the note");
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
