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

export const PDFJS_PATCHES = [
  {
    name: "tiling-pattern-clamp",
    edits: [[TILING_CALLS_FROM, TILING_CALLS_TO], [TILING_SIZE_FROM, TILING_SIZE_TO]]
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
  let text = String(source ?? "");
  const applied = [];
  const missing = [];
  for (const patch of PDFJS_PATCHES) {
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
