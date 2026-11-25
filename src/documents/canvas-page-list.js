// Lists of Canvas pages: which pages an export takes, what they are called in
// a file name, and where every page goes when some are moved, deleted or
// duplicated together (the Pages panel, src/documents/canvas-pages-panel.js;
// moveNotebookPages and friends in src/documents/notebook.js).
//
// Pure — numbers in, numbers out — so it is checked in Node
// (tools/canvas-page-list-check.mjs).

// The pages an export takes, in page order, each once: the ones asked for that
// exist, or every page when none are asked for (or none of them exist).
export function exportPageList(pages, total) {
  const count = Math.max(0, Math.round(Number(total) || 0));
  const all = Array.from({ length: count }, (_, i) => i + 1);
  if (!Array.isArray(pages) && !(pages instanceof Set)) return all;
  const wanted = [...new Set([...pages].map((page) => Math.round(Number(page))))]
    .filter((page) => page >= 1 && page <= count)
    .sort((a, b) => a - b);
  return wanted.length ? wanted : all;
}

// "2-4, 7" for [2, 3, 4, 7]: runs of consecutive pages as ranges.
export function pageListLabel(pages) {
  const sorted = [...new Set([...(pages || [])].map(Number).filter((n) => n >= 1))].sort((a, b) => a - b);
  const runs = [];
  sorted.forEach((page) => {
    const last = runs[runs.length - 1];
    if (last && page === last[1] + 1) last[1] = page;
    else runs.push([page, page]);
  });
  return runs.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(", ");
}

// True when `pages` is every page of a Canvas of `total` (or none at all).
export function isWholeCanvas(pages, total) {
  const list = exportPageList(pages, total);
  return list.length === Math.max(0, Math.round(Number(total) || 0));
}

// The new order when `pages` are lifted out, in their own order, and put down
// just before page `before` (as it is numbered now; `total + 1`, or anything
// past the end, is "after the last page"). Returns the new order as a list of
// old page numbers: order[k - 1] is the old number of what is now page k.
export function pageOrderAfterMove(total, pages, before) {
  const count = Math.max(0, Math.round(Number(total) || 0));
  const identity = Array.from({ length: count }, (_, i) => i + 1);
  if (!Array.isArray(pages) && !(pages instanceof Set)) return identity;
  const moving = [...new Set([...pages].map((page) => Math.round(Number(page))))]
    .filter((page) => page >= 1 && page <= count)
    .sort((a, b) => a - b);
  if (!moving.length) return identity;
  const lifted = new Set(moving);
  const rest = [];
  for (let page = 1; page <= count; page += 1) if (!lifted.has(page)) rest.push(page);
  // Where they go among the pages that stay: before the first of those that
  // is at or after `before`.
  const at = Number(before);
  let index = rest.findIndex((page) => page >= at);
  if (index < 0) index = rest.length;
  return [...rest.slice(0, index), ...moving, ...rest.slice(index)];
}

// A move function (old page → new page) for an order from pageOrderAfterMove,
// as remapNotebookPages takes it. Page numbers not in the order are left as
// they are.
export function moveForOrder(order) {
  const to = new Map();
  (order || []).forEach((oldPage, index) => to.set(Number(oldPage), index + 1));
  return (record) => {
    const on = Number(record?.page) || 0;
    return to.has(on) ? to.get(on) : on;
  };
}

// True when the order changes nothing.
export function isIdentityOrder(order) {
  return (order || []).every((oldPage, index) => Number(oldPage) === index + 1);
}

// The pages in `pages` after `pages` themselves are moved by `order`: where
// each lands, sorted — so a selection follows the pages it picked.
export function pagesAfterOrder(pages, order) {
  const move = moveForOrder(order);
  return [...(pages || [])].map((page) => move({ page })).filter((page) => page >= 1).sort((a, b) => a - b);
}
