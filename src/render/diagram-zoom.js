// Opening a diagram full screen, with pinch/drag pan and zoom.

import { el } from "../core/dom.js?v=__BUILD__";
import { flushDeferredWork } from "./deferred-work.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

export function addDiagramZoomControl(node) {
  if (node.closest("#printRoot")) return;
  if (node.parentElement?.classList.contains("diagram-shell")) return;

  const shell = document.createElement("div");
  shell.className = "diagram-shell";
  if (node.classList.contains("nomnoml-light-theme")) {
    shell.classList.add("nomnoml-light-shell");
  }
  const button = document.createElement("button");
  button.className = "diagram-zoom";
  button.type = "button";
  button.textContent = "Zoom";
  button.addEventListener("click", async () => {
    // A diagram whose drawing is still queued (below the fold in a long note)
    // has nothing to zoom into yet — draw it first.
    if (node.classList.contains("is-diagram-pending")) await flushDeferredWork(node);
    openDiagramModal(node);
  });

  node.parentNode.insertBefore(shell, node);
  shell.appendChild(node);
  shell.appendChild(button);
}

export let currentDiagramZoom = null;

export const diagramZoomRange = {
  min: 0.2,
  max: 8
};

export function clampDiagramScale(value) {
  return Math.min(diagramZoomRange.max, Math.max(diagramZoomRange.min, value));
}

export function diagramViewportCenter() {
  const rect = el.diagramModalBody.getBoundingClientRect();
  return {
    x: rect.width / 2,
    y: rect.height / 2
  };
}

export function diagramLocalPoint(point) {
  if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
    return { x: point.x, y: point.y };
  }
  const rect = el.diagramModalBody.getBoundingClientRect();
  return {
    x: point.clientX - rect.left,
    y: point.clientY - rect.top
  };
}

export function zoomDiagramTo(scale, focalPoint = diagramViewportCenter()) {
  if (!currentDiagramZoom) return;
  const nextScale = clampDiagramScale(scale);
  const focal = diagramLocalPoint(focalPoint);
  const anchorX = (focal.x - currentDiagramZoom.x) / currentDiagramZoom.scale;
  const anchorY = (focal.y - currentDiagramZoom.y) / currentDiagramZoom.scale;
  currentDiagramZoom.scale = nextScale;
  currentDiagramZoom.x = focal.x - anchorX * nextScale;
  currentDiagramZoom.y = focal.y - anchorY * nextScale;
  applyDiagramTransform();
}

export function zoomDiagramBy(multiplier) {
  if (!currentDiagramZoom) return;
  zoomDiagramTo(currentDiagramZoom.scale * multiplier);
}

export function diagramPointers() {
  return Array.from(currentDiagramZoom?.pointers.values() || []);
}

export function pointerDistance(points) {
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

export function pointerCenter(points) {
  return {
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2
  };
}

export function isVectorDiagramContent(content) {
  return content instanceof SVGElement;
}

export function baseDiagramSize(content) {
  const rect = content.getBoundingClientRect();
  const viewBox = content instanceof SVGElement ? content.viewBox?.baseVal : null;
  if (viewBox?.width && viewBox?.height) {
    return {
      width: viewBox.width,
      height: viewBox.height
    };
  }
  if (content instanceof HTMLImageElement && content.naturalWidth && content.naturalHeight) {
    return {
      width: content.naturalWidth,
      height: content.naturalHeight
    };
  }
  return {
    width: rect.width || Number(content.getAttribute("width")) || 1,
    height: rect.height || Number(content.getAttribute("height")) || 1
  };
}

export function applyDiagramTransform() {
  if (!currentDiagramZoom?.content) return;
  const { content, scale, x, y, baseWidth, baseHeight, isVector } = currentDiagramZoom;
  if (isVector) {
    content.style.width = `${baseWidth}px`;
    content.style.height = `${baseHeight}px`;
  }

  content.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${x}, ${y})`;
}

export function beginDiagramPan(point) {
  if (!currentDiagramZoom) return;
  const local = diagramLocalPoint(point);
  currentDiagramZoom.mode = "pan";
  currentDiagramZoom.panStartX = currentDiagramZoom.x;
  currentDiagramZoom.panStartY = currentDiagramZoom.y;
  currentDiagramZoom.pointerStartX = local.x;
  currentDiagramZoom.pointerStartY = local.y;
}

export function beginDiagramPinch() {
  if (!currentDiagramZoom) return;
  const points = diagramPointers();
  if (points.length < 2) return;

  const center = pointerCenter(points);
  currentDiagramZoom.mode = "pinch";
  currentDiagramZoom.pinchStartDistance = pointerDistance(points) || 1;
  currentDiagramZoom.pinchStartScale = currentDiagramZoom.scale;
  currentDiagramZoom.pinchAnchorX = (center.x - currentDiagramZoom.x) / currentDiagramZoom.scale;
  currentDiagramZoom.pinchAnchorY = (center.y - currentDiagramZoom.y) / currentDiagramZoom.scale;
}

export function centerDiagramContent(content) {
  if (!currentDiagramZoom || currentDiagramZoom.content !== content) return;
  const bodyRect = el.diagramModalBody.getBoundingClientRect();
  const { width, height } = baseDiagramSize(content);
  currentDiagramZoom.baseWidth = width;
  currentDiagramZoom.baseHeight = height;
  const fitPadding = 24;
  const fitScale = Math.min(
    1,
    Math.max(0.1, (bodyRect.width - fitPadding * 2) / Math.max(width, 1)),
    Math.max(0.1, (bodyRect.height - fitPadding * 2) / Math.max(height, 1))
  );

  currentDiagramZoom.scale = clampDiagramScale(fitScale);
  currentDiagramZoom.x = (bodyRect.width - width * currentDiagramZoom.scale) / 2;
  currentDiagramZoom.y = (bodyRect.height - height * currentDiagramZoom.scale) / 2;
  applyDiagramTransform();
}

export function initializeDiagramZoom(content) {
  const { width, height } = baseDiagramSize(content);
  currentDiagramZoom = {
    content,
    isVector: isVectorDiagramContent(content),
    baseWidth: width,
    baseHeight: height,
    scale: 1,
    x: 0,
    y: 0,
    pointers: new Map(),
    mode: "",
    panStartX: 0,
    panStartY: 0,
    pointerStartX: 0,
    pointerStartY: 0,
    pinchStartDistance: 1,
    pinchStartScale: 1,
    pinchAnchorX: 0,
    pinchAnchorY: 0
  };
  requestAnimationFrame(() => centerDiagramContent(content));
}

export function resetDiagramZoom() {
  currentDiagramZoom = null;
}

export function openDiagramModal(node) {
  lockPageScroll();
  el.diagramModalBody.innerHTML = "";
  el.diagramModalBody.classList.remove("nomnoml-light-modal-body");
  if (node.tagName === "IMG") {
    el.diagramModalBody.appendChild(node.cloneNode(true));
  } else {
    el.diagramModalBody.innerHTML = node.innerHTML;
  }
  el.diagramModal.hidden = false;
  
  const content = el.diagramModalBody.querySelector("svg, img");
  if (content) {
    content.classList.add("diagram-zoom-content");
    if (content.classList.contains("nomnoml-light-svg")) {
      el.diagramModalBody.classList.add("nomnoml-light-modal-body");
    }
    initializeDiagramZoom(content);
  }
}

export function closeDiagramModal() {
  el.diagramModal.hidden = true;
  el.diagramModalBody.innerHTML = "";
  el.diagramModalBody.classList.remove("nomnoml-light-modal-body");
  resetDiagramZoom();
  unlockPageScroll();
}
