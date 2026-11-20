// Where Blocks put on the Canvas from the Notes, a PDF or the Cards go
// (src/documents/canvas-feed.js): stacked down the page under whatever is
// already on the last page, onto new pages when that one is full. Pure — page
// boxes and sizes in, places out, in PDF points (y UP, a Block's `y` its
// bottom edge) — so tools/canvas-feed-check.mjs can check it without a page.

// Kept clear round the words on every page, whatever its own margins say.
export const FLOW_EDGE = 36;
// ...and at the foot, the page number's room (CANVAS_NUMBER_BASELINE and its
// size, src/documents/pdf-export.js) and a little more.
export const FLOW_FOOT = 40;
// Between one thing and the next down the page.
export const FLOW_GAP = 14;
// Under what is already on a page before the first new thing.
export const FLOW_AFTER_EXISTING = 24;
// Between a card's question and its answer, the arrow's room.
export const FLOW_PAIR_GAP = 48;

// The box words are laid in on a page: its box `[x0, y0, x1, y1]` less its
// margins (the paper's own, src/documents/canvas-setup.js) and FLOW_EDGE.
export function flowContentBox(box, margins = {}) {
  const [x0, y0, x1, y1] = box;
  const m = (side, least) => Math.max(least, Number(margins?.[side]) || 0);
  return {
    left: x0 + m("left", FLOW_EDGE),
    right: x1 - m("right", FLOW_EDGE),
    top: y1 - m("top", FLOW_EDGE),
    bottom: y0 + m("bottom", FLOW_FOOT)
  };
}

// The widest a single Block, and each half of a card, may be on such a page.
export function flowWidths(content) {
  const width = Math.max(48, content.right - content.left);
  return { single: width, half: Math.max(48, Math.floor((width - FLOW_PAIR_GAP) / 2)) };
}

// The lowest thing on a page, as the y of its bottom edge — or null for an
// empty page. `rects` are `[x0, y0, x1, y1]` boxes of everything on it.
export function lowestEdge(rects) {
  let low = null;
  (rects || []).forEach((rect) => {
    if (!Array.isArray(rect) || rect.length < 4) return;
    const y = Math.min(Number(rect[1]), Number(rect[3]));
    if (!Number.isFinite(y)) return;
    if (low === null || y < low) low = y;
  });
  return low;
}

// The places for `items`, each `{ w, h }` or a card `{ pair: [{ w, h }, { w, h }] }`:
//
//   pages      [{ page, box, margins }] — the Canvas's pages, in order (at least
//              the last one); a page added after it is laid out as it is.
//   lowest     the y of the lowest thing on the last page, or null when empty.
//
// Returns `{ places, newPages }`: each place `{ page, x, y }` for a Block, or
// `{ page, parts: [{ x, y }, { x, y }] }` for a card; `newPages` is how many
// pages have to be added at the end first. Something taller than a whole page
// goes at the top of a page of its own and runs past its foot.
export function flowOntoCanvas({ pages, lowest = null, items }) {
  const last = pages[pages.length - 1];
  if (!last) return { places: [], newPages: 0 };
  let page = Number(last.page);
  let content = flowContentBox(last.box, last.margins);
  let top = lowest === null ? content.top : Math.min(content.top, lowest - FLOW_AFTER_EXISTING);
  let fresh = lowest === null;
  let newPages = 0;
  const places = [];
  const nextPage = () => {
    page += 1;
    newPages += 1;
    content = flowContentBox(last.box, last.margins);
    top = content.top;
    fresh = true;
  };
  (items || []).forEach((item) => {
    const pair = Array.isArray(item?.pair) ? item.pair : null;
    const h = pair ? Math.max(...pair.map((part) => Number(part?.h) || 0)) : Number(item?.h) || 0;
    if (top - h < content.bottom && !fresh) nextPage();
    if (!pair) {
      places.push({ page, x: Math.round(content.left), y: Math.round(top - h) });
    } else {
      const [q, a] = pair;
      const qx = content.left;
      const ax = content.left + (Number(q?.w) || 0) + FLOW_PAIR_GAP;
      places.push({
        page,
        parts: [
          { x: Math.round(qx), y: Math.round(top - (Number(q?.h) || 0)) },
          { x: Math.round(ax), y: Math.round(top - (Number(a?.h) || 0)) }
        ]
      });
    }
    top -= h + FLOW_GAP;
    fresh = false;
  });
  return { places, newPages };
}

// One thing dropped at a point (a drag from beside, src/documents/canvas-drop.js):
// its top-left corner there, kept on the page. Same shape of place as above.
export function placeAtPoint({ box, at, item }) {
  const [x0, y0, x1, y1] = box;
  const pair = Array.isArray(item?.pair) ? item.pair : null;
  const width = pair ? (Number(pair[0]?.w) || 0) + FLOW_PAIR_GAP + (Number(pair[1]?.w) || 0) : Number(item?.w) || 0;
  const h = pair ? Math.max(...pair.map((part) => Number(part?.h) || 0)) : Number(item?.h) || 0;
  const left = Math.max(x0 + 12, Math.min(x1 - width - 12, Number(at?.x) || x0));
  const top = Math.min(y1 - 12, Math.max(y0 + 12 + Math.min(h, y1 - y0 - 24), Number(at?.y) || y1));
  if (!pair) return { page: Number(at?.page) || 1, x: Math.round(left), y: Math.round(top - h) };
  return {
    page: Number(at?.page) || 1,
    parts: [
      { x: Math.round(left), y: Math.round(top - (Number(pair[0]?.h) || 0)) },
      { x: Math.round(left + (Number(pair[0]?.w) || 0) + FLOW_PAIR_GAP), y: Math.round(top - (Number(pair[1]?.h) || 0)) }
    ]
  };
}
