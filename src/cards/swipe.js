// Swipe-to-answer, and the pointer handling that has to tell a swipe apart
// from a scroll, a text selection, a tap on a control, or a diagram pinch.

import { navigateCard } from "./deck-actions.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { applyDiagramTransform, beginDiagramPan, beginDiagramPinch, clampDiagramScale, currentDiagramZoom, diagramLocalPoint, diagramPointers, pointerCenter, pointerDistance, zoomDiagramTo } from "../render/diagram-zoom.js?v=__BUILD__";
import { dismissSwipeHint } from "../ui/deck-header.js?v=__BUILD__";

export function currentCardCanMove() {
  return Boolean(state.previewCard || state.cards[state.current] || (state.cards.length > 0 && state.current === state.cards.length));
}

export function closestElement(target, selector) {
  if (target instanceof Element) return target.closest(selector);
  if (typeof target?.closest === "function") return target.closest(selector);
  if (typeof target?.parentElement?.closest === "function") return target.parentElement.closest(selector);
  return null;
}

// `.notes-img-resize-handle` is a bare <div> (it has to be, so its pointerdown
// can start a drag without a button's own activation behaviour getting in the
// way), so it needs naming here explicitly or dragging an image's corner on a
// card face would also flip the card.
export function isCardActionTarget(target) {
  return Boolean(closestElement(target, "a, button, input, textarea, .cloze, .render-toolbar, .notes-img-resize-handle"));
}

export function isHorizontallyScrollable(node) {
  if (!(node instanceof Element)) return false;
  const styles = window.getComputedStyle(node);
  const allowsHorizontalScroll = !["hidden", "clip", "visible"].includes(styles.overflowX);
  return allowsHorizontalScroll && node.scrollWidth > node.clientWidth + 2;
}

export function horizontalScrollRegion(target) {
  let node = target instanceof Element ? target : target?.parentElement;

  while (node && node !== el.card) {
    if (isHorizontallyScrollable(node)) {
      return node;
    }
    node = node.parentElement;
  }

  return null;
}

export function isHorizontalScrollTarget(target) {
  return Boolean(horizontalScrollRegion(target));
}

export function hasCardTextSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return Boolean((anchorNode && el.card.contains(anchorNode)) || (focusNode && el.card.contains(focusNode)));
}

export function swipeCommitDistance() {
  return Math.min(
    swipeConfig.maxCommitDistance,
    Math.max(swipeConfig.minCommitDistance, el.card.offsetWidth * swipeConfig.widthCommitRatio)
  );
}

export function dragVelocity(current, previous, time) {
  const elapsed = Math.max(time - state.dragLastTime, 1);
  return (current - previous) / elapsed;
}

// ── Standing the swipe down for a press ────────────────────────────────────
//
// A finger resting on a card is about to become a text selection, and the
// preventDefault() in updateSwipe cancels a pending one. The escape at the top
// of updateSwipe has existed for a while and did not work, for two reasons:
//
//   • It tested `!state.dragMoved`, which is STICKY and latches at 6px. Nobody
//     holds a finger inside 6px for a third of a second, so any real press
//     disqualified itself from the escape before it could fire.
//   • It only ran from a move event. By the time a move arrives the gesture may
//     already have latched horizontal intent (12px) and preventDefaulted — the
//     escape was being asked to undo something that had already happened.
//
// So: a real touch slop instead of 6px, measured from the origin rather than
// latched, and a TIMER so the stand-down happens on the clock rather than on
// whatever move event happens to arrive next. `dragMoved` is deliberately left
// alone — finishSwipe reads it to tell a tap from a drag.
let dwellTimer = null;
let dragLeftDwell = false;

export function clearDwellTimer() {
  if (dwellTimer) {
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }
}

// The stand-down itself. resetCardDrag() nulls state.dragPointerId, and BOTH
// move handlers early-return on a pointer id that doesn't match — so once this
// runs, no later move in this gesture can reach updateSwipe and preventDefault
// the selection the reader is in the middle of making. That is the whole point;
// a version that only set a flag would still have to be consulted by the very
// code path that was eating the gesture.
export function dwellRelease() {
  dwellTimer = null;
  if (state.dragging || dragLeftDwell) return;
  if (state.dragPointerId === null) return;
  resetCardDrag();
}

export function beginSwipe(clientX, clientY, pointerId = null, pointerType = "") {
  const time = performance.now();
  state.dragging = false;
  state.dragMoved = false;
  state.dragStartX = clientX;
  state.dragStartY = clientY;
  state.dragCurrentX = clientX;
  state.dragCurrentY = clientY;
  state.dragLastX = clientX;
  state.dragLastY = clientY;
  state.dragStartTime = time;
  state.dragLastTime = time;
  state.dragPointerId = pointerId;
  state.dragPointerType = pointerType;
  state.dragCaptured = false;
  dragLeftDwell = false;
  clearDwellTimer();
  // Mouse only ever wanted the swipe; there is no long press to protect and no
  // native selection a preventDefault could cancel that the mid-drag guard in
  // updateSwipe doesn't already cover.
  if (pointerType !== "mouse") dwellTimer = setTimeout(dwellRelease, swipeConfig.longPressGraceMs);
}

export function resetCardDrag() {
  clearDwellTimer();
  state.dragging = false;
  state.dragPointerId = null;
  state.dragPointerType = "";
  state.dragCaptured = false;
  state.dragMoved = false;
  el.card.classList.remove("is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
  el.card.style.transform = "";
}

export function updateSwipe(clientX, clientY, event) {
  // Never hijack an active text selection — for either mouse-drag or touch
  // (finger dragging the selection handles). preventDefault() on the move
  // event would otherwise cancel the browser's native selection.
  if (hasCardTextSelection()) {
    if (state.dragCaptured && typeof state.dragPointerId === "number") {
      el.card.releasePointerCapture?.(state.dragPointerId);
    }
    resetCardDrag();
    return;
  }

  const time = performance.now();
  const velocityX = dragVelocity(clientX, state.dragLastX, time);
  state.dragCurrentX = clientX;
  state.dragCurrentY = clientY;

  const dx = state.dragCurrentX - state.dragStartX;
  const dy = state.dragCurrentY - state.dragStartY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  state.dragMoved = state.dragMoved || absX > 6 || absY > 6;
  // Has this gesture travelled far enough to stop being a press? Kept separate
  // from dragMoved — which latches at 6px and is read by finishSwipe to tell a
  // tap from a drag — because 6px is finger tremor, not intent. See the block
  // comment above beginSwipe.
  dragLeftDwell = dragLeftDwell || Math.hypot(dx, dy) > swipeConfig.dwellSlopPx;

  // A touch that has dwelled this long without going anywhere is a long-press:
  // the browser is about to hand back a text selection, and the preventDefault()
  // further down cancels a pending one. The hasCardTextSelection() guard at the
  // top of this function can't help, because it only becomes true once the
  // selection already EXISTS — by which point the swipe has been running for a
  // frame or two and eaten the gesture.
  //
  // The dwell timer armed in beginSwipe is what makes this reliable; this is
  // the same test on the move path, for a gesture whose timer has not fired yet.
  if (!state.dragging
      && !dragLeftDwell
      && state.dragPointerType !== "mouse"
      && time - state.dragStartTime > swipeConfig.longPressGraceMs) {
    resetCardDrag();
    return;
  }

  if (!state.dragging) {
    // A slow drift must not latch swipe intent before the dwell can rescue it.
    // intentDistance is 12px and dwellSlopPx is 16, so a finger creeping along
    // at 60px/s crosses 12px at 200ms — well inside the 340ms grace — and the
    // gesture became a swipe that then preventDefaulted the press. On touch the
    // slop is therefore the floor: nothing is intent until the gesture has left
    // the dwell radius. Mouse keeps intentDistance exactly as it was.
    if (state.dragPointerType !== "mouse" && !dragLeftDwell) {
      state.dragLastX = clientX;
      state.dragLastY = clientY;
      state.dragLastTime = time;
      return;
    }
    const hasHorizontalIntent = absX >= swipeConfig.intentDistance && absX >= absY * swipeConfig.intentRatio;
    const hasVerticalIntent = absY >= swipeConfig.intentDistance && absY >= absX * swipeConfig.intentRatio;

    if (!hasHorizontalIntent && !hasVerticalIntent) {
      state.dragLastX = clientX;
      state.dragLastY = clientY;
      state.dragLastTime = time;
      return;
    }

    if (hasVerticalIntent) {
      state.suppressClickUntil = time + 360;
      resetCardDrag();
      return;
    }

    state.dragging = true;
    if (event?.pointerId !== undefined && !state.dragCaptured) {
      if (event.pointerType !== "mouse" || !hasCardTextSelection()) {
        el.card.setPointerCapture?.(event.pointerId);
        state.dragCaptured = true;
      }
    }
    el.card.classList.add("is-dragging");
  }

  if (event?.cancelable && typeof event.preventDefault === "function") {
    if (event.pointerType !== "mouse" || state.dragCaptured) {
      event.preventDefault();
    }
  }

  const direction = dx > 0 ? 1 : -1;
  const resisted = direction * Math.min(absX * swipeConfig.resistance, swipeConfig.maxPreviewOffset);
  const progress = Math.min(absX / swipeCommitDistance(), 1);
  const flicking = absX >= swipeConfig.flickDistance && Math.abs(velocityX) >= swipeConfig.flickVelocity;
  const choosing = progress > 0.45 || flicking;
  el.card.classList.toggle("drag-prev", dx > 0 && choosing);
  el.card.classList.toggle("drag-next", dx < 0 && choosing);
  el.card.style.transform = `translateX(${resisted}px) rotate(${direction * progress * 2.2}deg) scale(${1 - progress * 0.01})`;

  state.dragLastX = clientX;
  state.dragLastY = clientY;
  state.dragLastTime = time;
}

export function finishSwipe() {
  // Ahead of everything, because the committed branch below returns without
  // going through resetCardDrag() — it inlines the reset — so that path would
  // otherwise leave a timer armed to fire into the NEXT card.
  clearDwellTimer();
  const dx = state.dragCurrentX - state.dragStartX;
  const dy = state.dragCurrentY - state.dragStartY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const elapsed = Math.max(performance.now() - state.dragStartTime, 1);
  const averageVelocity = absX / elapsed;
  const committed = state.dragging
    && absX >= absY * swipeConfig.commitRatio
    && (
      absX >= swipeCommitDistance()
      || (absX >= swipeConfig.flickDistance && averageVelocity >= swipeConfig.flickVelocity)
    );

  // Gated on `dragging` — a gesture that showed real directional intent (see
  // hasHorizontalIntent/hasVerticalIntent in updateSwipe) — and NOT on
  // `dragMoved`, which is merely ">6px of travel". A finger tap is rarely
  // pixel-perfect, so the old condition swallowed the click of any tap that
  // wobbled 7px for a full 360ms: the card did not flip and nothing on screen
  // acknowledged the press. That is the purest form of "I clicked and nothing
  // happened", and it was reachable on every tap.
  //
  // The card's own click handler still has an independent 8px isDrag guard, so
  // dropping the low-threshold case here loses no protection against a real
  // swipe being read as a tap.
  if (state.dragging) {
    state.suppressClickUntil = performance.now() + 360;
  }

  if (committed) {
    el.card.classList.remove("is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
    el.card.style.transform = "";
    state.dragging = false;
    state.dragPointerId = null;
    state.dragPointerType = "";
    state.dragCaptured = false;
    state.dragMoved = false;

    navigateCard(dx > 0 ? -1 : 1, dx > 0 ? "prev" : "next");
    return;
  }

  resetCardDrag();
}

export function handlePointerDown(event) {
  if (!currentCardCanMove() || isCardActionTarget(event.target)) return;
  if (isHorizontalScrollTarget(event.target)) return;
  // Touch/pen: an active selection means the user is dragging a selection
  // handle — don't start a swipe. (Mouse keeps its mid-drag guard in updateSwipe
  // so a lingering selection never blocks starting a fresh drag.)
  if (event.pointerType !== "mouse" && hasCardTextSelection()) return;
  dismissSwipeHint();
  beginSwipe(event.clientX, event.clientY, event.pointerId, event.pointerType);
}

export function handlePointerMove(event) {
  if (state.dragPointerId !== event.pointerId) return;
  updateSwipe(event.clientX, event.clientY, event);
}

export function handlePointerUp(event) {
  if (state.dragPointerId !== event.pointerId) return;
  if (state.dragCaptured) el.card.releasePointerCapture?.(event.pointerId);
  finishSwipe();
}

export function handlePointerCancel(event) {
  if (state.dragPointerId === event.pointerId) {
    if (state.dragCaptured) el.card.releasePointerCapture?.(event.pointerId);
    resetCardDrag();
  }
}

export function touchPoint(event) {
  return event.changedTouches?.[0] || event.touches?.[0] || null;
}

export function handleTouchStart(event) {
  if (!currentCardCanMove() || isCardActionTarget(event.target)) return;
  if (isHorizontalScrollTarget(event.target)) return;
  // A selection is already up (e.g. dragging a selection handle after a
  // long-press) — leave the gesture to the browser instead of starting a swipe.
  if (hasCardTextSelection()) return;
  const point = touchPoint(event);
  if (!point) return;
  beginSwipe(point.clientX, point.clientY, "touch", "touch");
}

export function handleTouchMove(event) {
  if (state.dragPointerId !== "touch") return;
  const point = touchPoint(event);
  if (!point) return;
  updateSwipe(point.clientX, point.clientY, event);
}

export function handleTouchEnd() {
  if (state.dragPointerId !== "touch") return;
  finishSwipe();
}

export function handleTouchCancel() {
  if (state.dragPointerId !== "touch") return;
  resetCardDrag();
}

export function preventCancelableScroll(event) {
  if (event.cancelable && typeof event.preventDefault === "function") {
    event.preventDefault();
  }
}

export function styleScrollRegion(target) {
  return closestElement(target, ".style-grid, .all-cards-list, .import-preview-body, .import-decklist-rows, textarea, .import-card, .web-decks-table-wrap, .my-decks-grid, .diagram-modal-body");
}

export function canScrollStyleRegion(region) {
  return Boolean(region && region.scrollHeight > region.clientHeight + 1);
}

export function isStyleRegionAtTop(region) {
  return region.scrollTop <= 0;
}

export function isStyleRegionAtBottom(region) {
  return region.scrollTop + region.clientHeight >= region.scrollHeight - 1;
}

export function containStylePanelScroll(event, deltaY) {
  const region = styleScrollRegion(event.target);
  if (!region || !canScrollStyleRegion(region)) {
    preventCancelableScroll(event);
    return;
  }

  if ((deltaY < 0 && isStyleRegionAtTop(region)) || (deltaY > 0 && isStyleRegionAtBottom(region))) {
    preventCancelableScroll(event);
  }
}

export function handleStylePanelTouchStart(event) {
  const point = event.touches?.[0];
  state.stylePanelTouchY = point ? point.clientY : 0;
}

export function handleStylePanelTouchMove(event) {
  if (event.touches?.length !== 1) return;
  if (closestElement(event.target, "input, button, a, label, textarea, .import-action-btn")) return;

  const point = event.touches[0];
  const previousY = state.stylePanelTouchY || point.clientY;
  const deltaY = previousY - point.clientY;
  state.stylePanelTouchY = point.clientY;
  containStylePanelScroll(event, deltaY);
}

export function handleStylePanelWheel(event) {
  containStylePanelScroll(event, event.deltaY);
}

export function handleDiagramWheel(event) {
  if (!currentDiagramZoom) return;
  preventCancelableScroll(event);
  const direction = event.deltaY > 0 ? 0.9 : 1.1;
  zoomDiagramTo(currentDiagramZoom.scale * direction, event);
}

export function handleDiagramPointerDown(event) {
  const isPrimaryContact = event.button === 0 || event.pointerType === "touch" || event.pointerType === "pen";
  if (!currentDiagramZoom || !isPrimaryContact || event.target.closest("button, a")) return;
  preventCancelableScroll(event);
  el.diagramModalBody.setPointerCapture?.(event.pointerId);
  currentDiagramZoom.pointers.set(event.pointerId, diagramLocalPoint(event));
  el.diagramModalBody.classList.add("is-panning");

  const points = diagramPointers();
  if (points.length >= 2) beginDiagramPinch();
  else beginDiagramPan(points[0]);
}

export function handleDiagramPointerMove(event) {
  if (!currentDiagramZoom?.pointers.has(event.pointerId)) return;
  preventCancelableScroll(event);
  currentDiagramZoom.pointers.set(event.pointerId, diagramLocalPoint(event));

  const points = diagramPointers();
  if (points.length >= 2) {
    if (currentDiagramZoom.mode !== "pinch") beginDiagramPinch();
    const distance = pointerDistance(points) || currentDiagramZoom.pinchStartDistance;
    const center = pointerCenter(points);
    const nextScale = clampDiagramScale(currentDiagramZoom.pinchStartScale * (distance / currentDiagramZoom.pinchStartDistance));
    currentDiagramZoom.scale = nextScale;
    currentDiagramZoom.x = center.x - currentDiagramZoom.pinchAnchorX * nextScale;
    currentDiagramZoom.y = center.y - currentDiagramZoom.pinchAnchorY * nextScale;
    applyDiagramTransform();
    return;
  }

  if (currentDiagramZoom.mode !== "pan") beginDiagramPan(points[0]);
  const local = diagramLocalPoint(event);
  currentDiagramZoom.x = currentDiagramZoom.panStartX + local.x - currentDiagramZoom.pointerStartX;
  currentDiagramZoom.y = currentDiagramZoom.panStartY + local.y - currentDiagramZoom.pointerStartY;
  applyDiagramTransform();
}

export function handleDiagramPointerEnd(event) {
  if (!currentDiagramZoom?.pointers.has(event.pointerId)) return;
  currentDiagramZoom.pointers.delete(event.pointerId);
  el.diagramModalBody.releasePointerCapture?.(event.pointerId);

  const points = diagramPointers();
  if (points.length >= 2) {
    beginDiagramPinch();
  } else if (points.length === 1) {
    beginDiagramPan(points[0]);
  } else {
    currentDiagramZoom.mode = "";
    el.diagramModalBody.classList.remove("is-panning");
  }
}

export const swipeConfig = {
  intentDistance: 12,
  intentRatio: 1.12,
  commitRatio: 1.18,
  minCommitDistance: 66,
  maxCommitDistance: 142,
  widthCommitRatio: 0.18,
  flickDistance: 34,
  flickVelocity: 0.42,
  resistance: 0.74,
  maxPreviewOffset: 128,
  // A finger that has rested this long without travelling is pressing, not
  // swiping — Android's long-press selection is about to fire. See updateSwipe.
  longPressGraceMs: 340,
  // How far "without travelling" is. A real touch slop, not the 6px dragMoved
  // latches at: a thumb resting on glass wanders several pixels, and every one
  // of those presses used to disqualify itself from the long-press escape. See
  // the block comment above beginSwipe.
  dwellSlopPx: 16
};
