// Work a render owes but has not done yet.
//
// A long note holds hundreds of diagrams, equations and tables. Rendering them
// all on paint freezes the tab, so anything expensive is registered here and
// runs when it approaches the viewport.

import { el } from "../core/dom.js?v=__BUILD__";

// ── Scoped enhancement ─────────────────────────────────────────────────────
// Every enhancement pass below used to take one container and sweep the whole
// thing. The incremental renderer re-renders only the blocks that changed, so
// each pass now takes a LIST of roots instead — either [container] (a full
// render) or just the freshly rendered nodes. `roots` may contain the matches
// themselves (a rendered block can BE the <table>/<img>/.mermaid), so each root
// is tested as well as searched.
export function scopedQueryAll(target, selector) {
  const roots = Array.isArray(target) ? target : [target];
  const found = [];
  roots.forEach((root) => {
    if (!root || root.nodeType !== 1) return;
    if (root.matches(selector)) found.push(root);
    root.querySelectorAll(selector).forEach((node) => found.push(node));
  });
  return found;
}

// ── Viewport-deferred finishing work ───────────────────────────────────────
// Rendering a diagram or auto-fitting a table costs a forced layout of the
// whole (potentially enormous) notes document, and a long note has dozens of
// each — that was 8 of the 9 seconds it took a 230KB note to appear. Neither
// job's result can be seen until you scroll to it, so work that lands below the
// fold is queued and run when it approaches the viewport instead.
//
// Deliberately limited to the notes view (see deferrableRenderRoot): card faces
// are one screen of content, and #printRoot is captured programmatically the
// moment it's built, so both must finish everything up front.
export const DEFERRED_WORK_MARGIN = 1200;

export const deferredWorkRunners = new WeakMap();

export const deferredWorkObservers = new Map();

export const pendingDeferredWork = new Set();

export const readyDeferredWork = new Set();

export let deferredWorkDrainHandle = 0;

// How many images at the top of a note load eagerly, ahead of any intersection.
export const EAGER_IMAGE_COUNT = 3;

export function deferrableRenderRoot(container) {
  // el.notesView is its own scroll port (.notes-rendered), so it's both the
  // "is this deferrable" answer and the intersection root.
  return container === el.notesView ? el.notesView : null;
}

// Runs everything that has come into view. Batched per runner: one mermaid.run
// for six diagrams costs far less than six.
//
// Split out of the IntersectionObserver callback deliberately. Rendering a
// diagram or auto-fitting a table forces a layout of the whole notes document,
// and doing that *inside* the observer callback meant a fling past a few
// diagrams stalled the scroll for as long as they took to draw. DEFERRED_WORK_MARGIN
// is 1200px of runway, so there is ample room to wait for an idle moment.
export function drainReadyDeferredWork() {
  deferredWorkDrainHandle = 0;
  if (!readyDeferredWork.size) return;
  const due = Array.from(readyDeferredWork);
  readyDeferredWork.clear();
  const batches = new Map();
  due.forEach((node) => {
    const run = deferredWorkRunners.get(node);
    // Gone already — flushDeferredWork got here first (print/export).
    if (!run) return;
    deferredWorkRunners.delete(node);
    pendingDeferredWork.delete(node);
    deferredWorkObservers.forEach((observer) => observer.unobserve(node));
    const batch = batches.get(run);
    if (batch) batch.push(node);
    else batches.set(run, [node]);
  });
  batches.forEach((batch, run) => {
    try {
      Promise.resolve(run(batch)).catch((error) => console.warn("Deferred render failed", error));
    } catch (error) {
      console.warn("Deferred render failed", error);
    }
  });
}

export function scheduleDeferredWorkDrain() {
  if (deferredWorkDrainHandle) return;
  if (typeof requestIdleCallback !== "function") {
    deferredWorkDrainHandle = setTimeout(drainReadyDeferredWork, 0);
    return;
  }
  // The timeout is the backstop: a continuous fling never yields an idle period,
  // and the reader must not reach a diagram that is still a blank shell.
  deferredWorkDrainHandle = requestIdleCallback(drainReadyDeferredWork, { timeout: 250 });
}

export function deferredWorkObserver(root) {
  const existing = deferredWorkObservers.get(root);
  if (existing) return existing;
  const observer = new IntersectionObserver(
    (entries) => {
      // Record only. The node stays in pendingDeferredWork and in
      // deferredWorkRunners until it is actually run, which is what keeps
      // flushDeferredWork able to find it if a print/export happens in between.
      let queued = false;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        readyDeferredWork.add(entry.target);
        queued = true;
      });
      if (queued) scheduleDeferredWorkDrain();
    },
    { root, rootMargin: `${DEFERRED_WORK_MARGIN}px 0px` }
  );
  deferredWorkObservers.set(root, observer);
  return observer;
}

// Forgets every queued node that is no longer in the document — from the Set,
// from the runner map, and (the part that actually frees memory) from every
// observer still holding it as a target.
export function releaseDetachedDeferredWork() {
  pendingDeferredWork.forEach((node) => {
    if (node.isConnected) return;
    pendingDeferredWork.delete(node);
    readyDeferredWork.delete(node);
    deferredWorkRunners.delete(node);
    deferredWorkObservers.forEach((observer) => observer.unobserve(node));
  });
}

// Drops everything queued for `root`, observers included. Used when the content
// under a scroll root is replaced wholesale (a different note), where the old
// queue describes nodes that no longer exist and re-creating the observer is
// both cheaper and more certain than unobserving them one at a time.
export function releaseDeferredWork(root) {
  const observer = deferredWorkObservers.get(root);
  if (observer) {
    observer.disconnect();
    deferredWorkObservers.delete(root);
  }
  pendingDeferredWork.forEach((node) => {
    if (root && node.isConnected && !(root === node || root.contains(node))) return;
    pendingDeferredWork.delete(node);
    readyDeferredWork.delete(node);
    deferredWorkRunners.delete(node);
  });
}

// Splits `nodes` into the ones already at (or near) the visible part of `root`
// and the ones further away. Every rect is read BEFORE anything is mutated —
// interleaving reads with diagram rendering is what makes this expensive in the
// first place.
export function partitionByViewportProximity(nodes, root) {
  const bounds = root.getBoundingClientRect();
  const top = bounds.top - DEFERRED_WORK_MARGIN;
  const bottom = bounds.bottom + DEFERRED_WORK_MARGIN;
  const near = [];
  const far = [];
  nodes.forEach((node) => {
    const rect = node.getBoundingClientRect();
    if (rect.bottom >= top && rect.top <= bottom) near.push(node);
    else far.push(node);
  });
  return { near, far };
}

// Runs `run` over the nodes near the viewport now and queues the rest. Falls
// back to running everything immediately where there's no root to observe or no
// IntersectionObserver at all.
export function runNearViewportAndDefer(nodes, root, run) {
  if (!nodes.length) return Promise.resolve();
  if (!root || typeof IntersectionObserver !== "function") return Promise.resolve(run(nodes));
  // Nodes dropped by a later render would otherwise sit here forever. Dropping
  // them from the Set is NOT enough on its own: an IntersectionObserver holds a
  // STRONG reference to every target it observes, and these observers are
  // memoized per scroll root (el.notesView, which is never destroyed — see the
  // note on notesScrolledSource), so a target that is only forgotten here stays
  // reachable from the observer for the life of the tab. Since the targets are
  // tables and diagram shells, each one drags its whole detached subtree with
  // it — including rendered mermaid SVGs. That is a real, unbounded,
  // note-after-note memory leak, and it needs the unobserve.
  releaseDetachedDeferredWork();
  const { near, far } = partitionByViewportProximity(nodes, root);
  if (far.length) {
    const observer = deferredWorkObserver(root);
    far.forEach((node) => {
      deferredWorkRunners.set(node, run);
      pendingDeferredWork.add(node);
      observer.observe(node);
    });
  }
  return near.length ? Promise.resolve(run(near)) : Promise.resolve();
}

// Forces queued work inside `root` to run now — for anything that reads the
// rendered result programmatically (zooming a diagram, exporting) instead of
// waiting for it to be scrolled into view.
export async function flushDeferredWork(root) {
  const due = [];
  releaseDetachedDeferredWork();
  pendingDeferredWork.forEach((node) => {
    if (!root || root === node || root.contains(node)) due.push(node);
  });
  const batches = new Map();
  due.forEach((node) => {
    const run = deferredWorkRunners.get(node);
    deferredWorkRunners.delete(node);
    pendingDeferredWork.delete(node);
    readyDeferredWork.delete(node);
    deferredWorkObservers.forEach((observer) => observer.unobserve(node));
    if (!run) return;
    const batch = batches.get(run);
    if (batch) batch.push(node);
    else batches.set(run, [node]);
  });
  for (const [run, batch] of batches) {
    try {
      await run(batch);
    } catch (error) {
      console.warn("Deferred render failed", error);
    }
  }
}
