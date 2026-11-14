// The document surface's two stages, for when both of a file's papers are up.
//
// A file has two documents — its PDFs and its Canvas (src/documents/doc-slot.js)
// — and, side by side (src/ui/split-parts.js), both can be on screen at once:
// #documentStage holds one and #documentStageAlt the other, each with its own
// scroller. Exactly one of them is LIVE at a time: `el.documentStage` and
// `el.documentView` point at it, `openPdf` is its document
// (src/documents/pdf-view.js), and every tool — the pen, the blocks, the
// shapes, the selection — acts on it. The other is suspended where it stands,
// still painted, and becomes live the moment the reader reaches for it.
//
// Which leaves the listeners every one of those tools attached ONCE, at boot,
// to the scroller that existed then. This is how they reach the second one:
// bound to both, and let through only on the live one — so a scroll the
// browser fires on the suspended scroller (its width changed under a divider
// drag) is never mistaken for the reader moving the paper they are working on.
//
// A LEAF beside src/core/dom.js, so every document module can import it
// without joining the cycles around pdf-view.js.

import { el } from "../core/dom.js?v=__BUILD__";

// Taken once, at import, before anything re-points `el`.
const PRIMARY_STAGE = el.documentStage;
const PRIMARY_VIEW = el.documentView;
const ALT_STAGE = typeof document !== "undefined" ? document.getElementById("documentStageAlt") : null;
const ALT_VIEW = typeof document !== "undefined" ? document.getElementById("documentViewAlt") : null;

export function documentScrollers() {
  return [PRIMARY_VIEW, ALT_VIEW].filter(Boolean);
}

export function documentStages() {
  return [PRIMARY_STAGE, ALT_STAGE].filter(Boolean);
}

export function primaryDocumentStage() {
  return PRIMARY_STAGE;
}

export function primaryDocumentScroller() {
  return PRIMARY_VIEW;
}

export function alternateDocumentStage() {
  return ALT_STAGE;
}

export function alternateDocumentScroller() {
  return ALT_VIEW;
}

// The scroller inside a stage, and the stage round a scroller.
export function scrollerOfStage(stage) {
  if (stage === PRIMARY_STAGE) return PRIMARY_VIEW;
  if (stage === ALT_STAGE) return ALT_VIEW;
  return null;
}

// Whether `view` is the scroller the tools act on right now.
export function isLiveDocumentScroller(view) {
  return Boolean(view) && view === el.documentView;
}

// `handler`, wrapped to run only while `node` is the live scroller (or stage).
export function liveDocumentHandler(node, handler) {
  return function liveOnly(event) {
    if (node !== el.documentView && node !== el.documentStage) return undefined;
    return handler.call(this, event);
  };
}

// addEventListener on both scrollers, each copy let through only while its
// scroller is live. `handler` sees exactly the event it always saw.
export function onDocumentScrollers(type, handler, options) {
  documentScrollers().forEach((view) => view.addEventListener(type, liveDocumentHandler(view, handler), options));
}

// The same, for the two stages.
export function onDocumentStages(type, handler, options) {
  documentStages().forEach((stage) => stage.addEventListener(type, liveDocumentHandler(stage, handler), options));
}

// Runs `install(view)` once per scroller — for an init function that attaches
// several listeners and reads its own `view` inside them. Wrap each handler in
// liveDocumentHandler(view, …) so it keeps to the live one.
export function forEachDocumentScroller(install) {
  documentScrollers().forEach((view) => install(view));
}
