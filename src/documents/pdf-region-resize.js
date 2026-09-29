// Resizing a card's picture of a captured PDF region, and remembering it.
//
// pdf-region.js captures a region; pdf-region-embed.js renders it. This is
// the third leg: a drag-corner handle on the rendered picture, the same
// pointer-drag idiom already built for the "Make a flashcard" panels
// (beginFrameCardResize, src/notes/frame-card.js), and the plumbing to
// write the chosen width back into whichever card the picture came from —
// so it holds the next time that card is shown, not just for this viewing.
//
// Only mounted where a resize can actually be saved against something: a
// card already has a stable id and field to write into on the Study face and
// in All Cards, and the Notes view has the note itself (see
// enhanceRenderedMarkdown's allow-list). The "Make a flashcard" modal's own
// unsaved preview, and every export/print render, get no handle — there is
// nothing yet, or nothing interactive, to persist a resize against.

import { state } from "../core/state.js?v=__BUILD__";
import { scheduleLiveQuestionFit } from "../cards/question-fit.js?v=__BUILD__";
import { mountPdfRegionEmbed, pdfRegionRefMarkdown } from "./pdf-region-embed.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// A region typically holds a whole figure/table plus a real text layer, so
// the floor sits above the generic image-resize floor elsewhere in the app —
// smaller than this and the handle itself is most of what's left to grab.
export const REGION_RESIZE_MIN_WIDTH = 160;

// `.pdf-region-embed { max-width: 100% }` already keeps a card face from
// visually overflowing regardless of what's stored — this ceiling is only
// about not persisting an absurd request.
export const REGION_RESIZE_MAX_WIDTH = 1200;

// ── The Notes view ──────────────────────────────────────────────────────────
//
// The note is written through renderTargetConfig("notes") — the one choke
// point for a rendered-view edit to it (undo snapshot, an open raw editor kept
// in step, the history baseline, the pinned re-render). Registered by
// src/main.js rather than imported: render-toolbar.js reaches this module back
// through render/enhance.js, the same reason the All Cards row height is told
// by an event below rather than by an import.
let notesSurfaceProvider = null;

export function setRegionResizeNotesSurface(fn) {
  notesSurfaceProvider = typeof fn === "function" ? fn : null;
}

function clampWidth(value) {
  return Math.min(REGION_RESIZE_MAX_WIDTH, Math.max(REGION_RESIZE_MIN_WIDTH, value));
}

// Which card + field a mounted embed belongs to, read off the live DOM —
// Study always shows exactly one card (state.cards[state.current]) and the
// face it's in says which side; All Cards rows already carry a stable id.
function resolveRegionEmbedTarget(wrapper) {
  const allCardItem = wrapper.closest(".all-card[data-card-id]");
  if (allCardItem) {
    const fieldContainer = wrapper.closest(".all-card-question, .all-card-answer");
    const side = fieldContainer?.classList.contains("all-card-question") ? "question" : "answer";
    return { scope: "all-cards", cardId: allCardItem.dataset.cardId, side, item: allCardItem, fieldContainer };
  }
  const fieldContainer = wrapper.closest(".card-question, .card-answer");
  if (fieldContainer) {
    const side = fieldContainer.classList.contains("card-question") ? "question" : "answer";
    return { scope: "study", side, fieldContainer };
  }
  const notesView = wrapper.closest("#notesView");
  if (notesView && notesSurfaceProvider) return { scope: "notes", fieldContainer: notesView };
  return null;
}

// The part of a ref that is searched for in the source: `](pdfref:…)`, not
// the whole `![](…)`, so a ref the reader gave alt text to is still found — and
// with its closing paren, so `pdfref:12:a,b,c,d` never matches the front of a
// longer ref (`…:pdfB`, `…::480`) that happens to start the same way.
function refNeedle(markdownRef) {
  return `](${markdownRef.slice(4, -1)})`;
}

function refOffsets(text, needle) {
  const offsets = [];
  let cursor = 0;
  for (;;) {
    const found = text.indexOf(needle, cursor);
    if (found === -1) return offsets;
    offsets.push(found);
    cursor = found + needle.length;
  }
}

// A card's question/answer is always rendered from one whole string in one
// pass, so replacing the Nth occurrence in the DOM is replacing the Nth
// occurrence in the source. A long note is NOT — it is built span by span, and
// copies sitting in unbuilt spans are not on screen to be counted — so a DOM
// ordinal is only applied when the screen holds exactly as many copies as the
// source does (the same guard sourceImageAt keeps for images). Otherwise the
// answer is null and the caller says so, rather than resizing a different copy.
// The common case (one region, once) never reaches the ordinal at all.
function replaceRefOccurrence(text, originalRef, newRef, wrapper, fieldContainer) {
  if (!text) return null;
  const needle = refNeedle(originalRef);
  const offsets = refOffsets(text, needle);
  if (!offsets.length) return null;
  const splice = (at) => text.slice(0, at) + refNeedle(newRef) + text.slice(at + needle.length);
  if (offsets.length === 1) return splice(offsets[0]);

  const duplicates = fieldContainer
    ? Array.from(fieldContainer.querySelectorAll(".pdf-region-embed[data-pdf-ref]"))
      .filter((node) => node.dataset.pdfRef === originalRef)
    : [wrapper];
  if (duplicates.length !== offsets.length) return null;
  const at = duplicates.indexOf(wrapper);
  return at === -1 ? null : splice(offsets[at]);
}

// Writes the new text into whichever of state.cards/state.masterCards hold
// this card — usually the SAME object (state.cards is a slice of
// masterCards), but written into both by id regardless, the same safety net
// saveAllCardEditor (src/cards/all-cards.js) already uses for a text edit.
function commitCardField(target, newText) {
  if (target.scope === "notes") {
    const surface = notesSurfaceProvider?.();
    if (!surface) return false;
    surface.setSource(newText);
    scheduleDeckAutosave();
    return true;
  }
  const cardId = target.scope === "study" ? state.cards[state.current]?.id : target.cardId;
  if (!cardId) return false;
  const masterCard = state.masterCards.find((card) => card.id === cardId);
  const liveCard = state.cards.find((card) => card.id === cardId);
  if (!masterCard && !liveCard) return false;
  if (masterCard) masterCard[target.side] = newText;
  if (liveCard && liveCard !== masterCard) liveCard[target.side] = newText;
  scheduleDeckAutosave();
  return true;
}

function readCardField(target) {
  if (target.scope === "notes") return notesSurfaceProvider?.()?.getSource?.() ?? null;
  if (target.scope === "study") {
    const card = state.cards[state.current];
    return card ? card[target.side] : null;
  }
  const card = state.masterCards.find((c) => c.id === target.cardId);
  return card ? card[target.side] : null;
}

function commitResize(wrapper, target, originalRef, parsed, newWidth) {
  const newRef = pdfRegionRefMarkdown(parsed.page, parsed.rect, parsed.pdfId, newWidth);
  if (newRef === originalRef) return; // a press with no real drag

  const text = readCardField(target);
  if (text == null) {
    showToast("Couldn't find this region's card any more", "error");
    return;
  }
  const updatedText = replaceRefOccurrence(text, originalRef, newRef, wrapper, target.fieldContainer);
  if (updatedText === null) {
    showToast("Couldn't find this region in the card any more", "error");
    return;
  }
  if (!commitCardField(target, updatedText)) {
    showToast("Couldn't save the new size", "error");
    return;
  }

  if (target.scope === "study" && target.side === "question") scheduleLiveQuestionFit();
  // All Cards' Cornell row height is sized to its content — src/main.js
  // listens for this on el.allCardsList and calls adjustCornellRowHeight,
  // imported straight from cards/all-cards.js would cycle back through
  // render/enhance.js into this module.
  if (target.scope === "all-cards") {
    target.item.dispatchEvent(new CustomEvent("pdfregionresize", { bubbles: true }));
  }

  // The note re-renders through its own surface, pinned where the reader is —
  // the same path an image resize takes (replaceSourceImage), so the notes
  // block cache and the DOM can never disagree about which ref is on screen.
  if (target.scope === "notes") {
    notesSurfaceProvider?.()?.rerender?.();
    return;
  }

  // Re-render just this one embed at its new size, in place. A full
  // card/row re-render would tear down the very embed just resized.
  // pdfRegionRefMarkdown wraps the pdfref: URL as a markdown image — an
  // <img>'s src is just the URL inside `![](...)`, the same shape markdown
  // rendering itself would have produced this <img> with in the first place.
  const img = document.createElement("img");
  img.src = newRef.slice(4, -1);
  wrapper.replaceWith(img);
  mountPdfRegionEmbed(img, { resizable: true });
}

function beginResizeDrag(handle, event, wrapper, pageGroup, renderInfo, target, originalRef, parsed) {
  const { nativeWidth, nativeHeight, left, top } = renderInfo;
  const startX = event.clientX;
  const startWidth = wrapper.getBoundingClientRect().width;
  try { handle.setPointerCapture(event.pointerId); } catch (_) { /* synthetic event */ }
  wrapper.classList.add("is-resizing");

  const apply = (widthPx) => {
    const k = widthPx / nativeWidth;
    wrapper.style.width = `${Math.round(widthPx)}px`;
    wrapper.style.height = `${Math.round(nativeHeight * k)}px`;
    pageGroup.style.transform = `scale(${k}) translate(${-left}px, ${-top}px)`;
  };

  let finalWidth = startWidth;
  const onMove = (moveEvent) => {
    finalWidth = clampWidth(startWidth + (moveEvent.clientX - startX));
    apply(finalWidth);
  };
  const cleanup = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onCancel);
    wrapper.classList.remove("is-resizing");
    try { handle.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
  };
  const onUp = () => {
    cleanup();
    commitResize(wrapper, target, originalRef, parsed, Math.round(finalWidth));
  };
  const onCancel = () => {
    cleanup();
    apply(startWidth);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
}

// `renderInfo` is `{ nativeWidth, nativeHeight, left, top }` — the crop's own
// rendered pixel size and its offset within the full page render, exactly
// what mountPdfRegionEmbed already computed to place it; the resize math
// only ever scales uniformly from there, never re-deriving either.
export function attachRegionResizeHandle(wrapper, pageGroup, parsed, renderInfo) {
  const target = resolveRegionEmbedTarget(wrapper);
  if (!target) return; // nowhere to persist a resize against

  const originalRef = pdfRegionRefMarkdown(parsed.page, parsed.rect, parsed.pdfId, parsed.width);
  wrapper.dataset.pdfRef = originalRef;

  const handle = document.createElement("div");
  handle.className = "pdf-region-resize-handle";
  handle.setAttribute("aria-hidden", "true");
  wrapper.appendChild(handle);

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    beginResizeDrag(handle, event, wrapper, pageGroup, renderInfo, target, originalRef, parsed);
  });
}
