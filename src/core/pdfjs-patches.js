// ── Fixes to pdf.js, applied to its source as it is loaded ──────────────────
//
// The app loads pdf.js 3.11.174 from the CDN (LIB_URLS.pdfjs in
// src/core/lib-loader.js) and does not vendor it. Where that build draws a page
// wrong and the fix is a few characters, the fix is applied HERE, to the
// library's source text, before it runs — once for the page and once for the
// page renderer's worker, which are handed the same patched copy. A fix whose
// target text is not found is skipped and reported, never half-applied: the
// library then runs exactly as published.
//
// No imports: the checks under tools/ load this file from Node too, so they
// inject the same pdf.js the app runs.
//
// Pinned to the exact minified text of pdfjs-dist@3.11.174/legacy/build/
// pdf.min.js. Moving LIB_URLS.pdfjs to another version means looking at every
// patch below again — tools/pdfjs-patch-check.mjs fails until somebody does.

// ── Tiling patterns bigger than the canvas ("page breaks" in a tall page) ──
//
// The report: "a long single-page PDF shows breaks that the PDF does not
// have" — every few thousand pixels, a hard cut and then a dark fade, on a web
// page saved as one tall PDF page. The page had a fade at the top of its
// scroller (CSS mask-image), which Chrome prints as a tiling pattern whose ONE
// tile is as big as the whole page, used as a soft mask over everything on it.
//
// pdf.js draws a tiling pattern's tile into a canvas of its own, at most
// max(3000, size of the canvas being drawn into) pixels along each side
// (TilingPattern.getSizeAndScale). When a tile is bigger than that, the canvas
// is clamped — but the SCALE the tile is drawn at is not, so the tile is cut off
// after 3000 pixels and then repeated every 3000 pixels. Drawing the whole page
// into one canvas hides it: the canvas is as tall as the tile. Drawing PART of
// a page — the bands a tall page is read in, the detail tile of a zoomed page
// (src/documents/pdf-view.js) — is a canvas far smaller than the tile, and the
// cut-off tile repeats down the page: the fade's start every 3000 pixels, the
// "page breaks". pdf.js 4+ sidesteps it by drawing a single tile directly; this
// build cannot be swapped for it (see LIB_URLS.pdfjs).
//
// The fix: when the tile has to be clamped AND what the tile actually paints
// (its bbox, not merely its step) is too big for the clamp, the tile is drawn
// whole at the scale that fits — softer, but in the right place, which for a
// mask, a gradient or a background is invisible. A tile with a small bbox and a
// huge step (a pattern meant never to repeat) is left exactly as it was: its
// content fits, and shrinking it to fit the empty step would blur it for
// nothing.
const TILING_CALLS_FROM = "v=this.getSizeAndScale(s,this.ctx.canvas.width,b[0]),y=this.getSizeAndScale(a,this.ctx.canvas.height,b[1])";
const TILING_CALLS_TO = "v=this.getSizeAndScale(s,this.ctx.canvas.width,b[0],p-d),y=this.getSizeAndScale(a,this.ctx.canvas.height,b[1],f-u)";
const TILING_SIZE_FROM = "getSizeAndScale(t,e,n){t=Math.abs(t);const i=Math.max(TilingPattern.MAX_PATTERN_SIZE,e);let r=Math.ceil(t*n);r>=i?r=i:n=r/t;return{scale:n,size:r}}";
const TILING_SIZE_TO = "getSizeAndScale(t,e,n,w){t=Math.abs(t);const i=Math.max(TilingPattern.MAX_PATTERN_SIZE,e);let r=Math.ceil(t*n);if(r>=i){r=i;if(Math.abs(w||0)*n>=i)n=r/t}else n=r/t;return{scale:n,size:r}}";

// ── The operator list a render task drew from ───────────────────────────────
//
// Dark page keeps a page's pictures as they are (src/documents/pdf-image-
// keep.js), and finds them in the operator list pdf.js built to draw the page.
// A RenderTask holds that list on its internal task, in a private field (#m) no
// caller can reach, so asking for it again meant page.getOperatorList(): the
// whole content stream parsed a second time, every image decoded again. This
// adds a read-only getter for the list the render already has. Missing, the
// app falls back to getOperatorList().
const RENDER_TASK_FROM = "class RenderTask{#m=null;constructor(t){this.#m=t;this.onContinue=null}";
const RENDER_TASK_TO = "class RenderTask{#m=null;constructor(t){this.#m=t;this.onContinue=null}get recallOperatorList(){return this.#m.operatorList}";

export const PDFJS_PATCHES = [
  {
    name: "tiling-pattern-clamp",
    edits: [[TILING_CALLS_FROM, TILING_CALLS_TO], [TILING_SIZE_FROM, TILING_SIZE_TO]]
  },
  {
    name: "render-task-operator-list",
    edits: [[RENDER_TASK_FROM, RENDER_TASK_TO]]
  }
];

// ── The worker: where each character of a text item really is ─────────────
//
// The report: on a Hindi PDF exported from Recall, a double-click on संस्कार
// selected a box over "स्कार", and a highlight over अध्यात्मवादी stopped at
// "…वा" while one over इसलिए sat a word to the left. The page was fine. The
// text layer was not where the page is.
//
// Two faults in pdf.js's text extraction (pdf.worker.min.js, the worker that
// answers page.getTextContent()), both fixed here.
//
// 1. A glyph that stands for SEVERAL characters, one of them a combining mark,
//    was given no width. SpecialCharRegExp reads `^(\s)|(\p{Mn})|(\p{Cf})$`:
//    the anchors bind only the first and last alternatives, so the middle one
//    matches a mark ANYWHERE in the glyph's text. Shaped Devanagari is full of
//    such glyphs — every half form (ध्, त्, क्), every conjunct (ज्ञ, क्ष) — and
//    each was taken for a zero-width accent: no advance, no position check.
//    Every one of them made the item narrower than the line it was drawn as
//    (a tenth narrower on a line of the report's text), so every letter after
//    it was placed early, and the gap it left came back as a space in the
//    middle of a word ("क् याें"). The fix makes the mark alternative
//    whole-string: only a glyph that is nothing BUT marks is an accent.
//
// 2. pdf.js knows where every glyph of an item is drawn and keeps only the
//    item's start and total width. The text layer (src/documents/pdf-view.js)
//    then had to spread the item's characters along that width in the
//    BROWSER's font, which places them where its own letters would go — close
//    enough in a Latin font, a whole word out along a line of Hindi. So the
//    worker now also reports `charX` on each item: where each UTF-16 unit of
//    `str` starts along the run, from the item's origin, in the same units as
//    `width`, with one more entry at the end that is the width itself. Only
//    for upright left-to-right runs whose text normalisation and bidi left
//    alone (anything else could not be matched character for character), and
//    absent otherwise — the text layer then does what it always did.
const ZERO_WIDTH_FROM = 'new RegExp("^(\\\\s)|(\\\\p{Mn})|(\\\\p{Cf})$","u")';
const ZERO_WIDTH_TO = 'new RegExp("^(\\\\s)|^(\\\\p{Mn}+)$|(\\\\p{Cf})$","u")';
// Every piece pushed into an item's str gets the advance it starts at, in a
// parallel array: a glyph (its advance already added, hence `- h`), the space
// saveLastChar puts before it, and the space addFakeSpaces puts in a gap.
const CHAR_X_GLYPH_FROM = 'const d=s.unicode;saveLastChar(d)&&u.str.push(" ");u.str.push(d);';
const CHAR_X_GLYPH_TO = 'const d=s.unicode,recallAt=r.vertical?NaN:u.totalWidth+(u.width-h)*u.textAdvanceScale,recallX=u.recallX||(u.recallX=[]);'
  + 'saveLastChar(d)&&(u.str.push(" "),recallX.push(recallAt));u.str.push(d);recallX.push(recallAt);';
const CHAR_X_SPACE_FROM = 'if(p.initialized){resetLastChars();p.str.push(" ")}return!1}';
const CHAR_X_SPACE_TO = 'if(p.initialized){resetLastChars();p.str.push(" ");(p.recallX||(p.recallX=[])).push(p.vertical?NaN:p.totalWidth+p.width*p.textAdvanceScale)}return!1}';
const CHAR_X_RESET_FROM = "p.initialized=!1;p.str.length=0";
const CHAR_X_RESET_TO = "p.initialized=!1;p.str.length=0;p.recallX&&(p.recallX.length=0)";
const CHAR_X_ITEM_FROM = 'function runBidiTransform(e){let t=e.str.join("");d||(t=(0,r.normalizeUnicode)(t));const a=(0,b.bidi)(t,-1,e.vertical);'
  + "return{str:a.str,dir:a.dir,width:Math.abs(e.totalWidth),height:Math.abs(e.totalHeight),transform:e.transform,fontName:e.fontName,hasEOL:e.hasEOL}}";
const CHAR_X_ITEM_TO = 'function runBidiTransform(e){let t=e.str.join("");const recallRaw=t;d||(t=(0,r.normalizeUnicode)(t));const a=(0,b.bidi)(t,-1,e.vertical);'
  + "const recallItem={str:a.str,dir:a.dir,width:Math.abs(e.totalWidth),height:Math.abs(e.totalHeight),transform:e.transform,fontName:e.fontName,hasEOL:e.hasEOL};"
  + "const recallX=e.recallX;"
  + 'if(recallX&&!e.vertical&&e.totalWidth>0&&recallX.length===e.str.length&&a.str===recallRaw&&a.dir!=="rtl"){'
  + "const recallCx=[];let recallOk=!0;"
  + "for(let recallI=0;recallI<e.str.length;recallI++){const recallAt=recallX[recallI];if(!isFinite(recallAt)){recallOk=!1;break}"
  + "for(let recallJ=0;recallJ<e.str[recallI].length;recallJ++)recallCx.push(Math.round(recallAt*1e3)/1e3)}"
  + "recallCx.push(Math.round(e.totalWidth*1e3)/1e3);"
  + "recallOk&&recallCx.length===a.str.length+1&&(recallItem.charX=recallCx)}"
  + "return recallItem}";

export const PDFJS_WORKER_PATCHES = [
  {
    name: "glyph-with-mark-has-width",
    edits: [[ZERO_WIDTH_FROM, ZERO_WIDTH_TO]]
  },
  {
    name: "text-item-char-x",
    edits: [
      [CHAR_X_GLYPH_FROM, CHAR_X_GLYPH_TO],
      [CHAR_X_SPACE_FROM, CHAR_X_SPACE_TO],
      [CHAR_X_RESET_FROM, CHAR_X_RESET_TO],
      [CHAR_X_ITEM_FROM, CHAR_X_ITEM_TO]
    ]
  }
];

function occurrences(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

// Returns { text, applied, missing }: the source with every patch whose target
// was found exactly once applied, the names of the patches now in it (applied
// here, or already there), and the names that could not be applied.
export function patchPdfjsSource(source) {
  return applyPatches(source, PDFJS_PATCHES);
}

// The same, for pdf.worker.min.js — PDFJS_WORKER_PATCHES above.
export function patchPdfjsWorkerSource(source) {
  return applyPatches(source, PDFJS_WORKER_PATCHES);
}

function applyPatches(source, patches) {
  let text = String(source ?? "");
  const applied = [];
  const missing = [];
  for (const patch of patches) {
    if (patch.edits.every(([, to]) => occurrences(text, to) === 1)) {
      applied.push(patch.name);
      continue;
    }
    if (!patch.edits.every(([from]) => occurrences(text, from) === 1)) {
      missing.push(patch.name);
      continue;
    }
    for (const [from, to] of patch.edits) text = text.replace(from, () => to);
    applied.push(patch.name);
  }
  return { text, applied, missing };
}
