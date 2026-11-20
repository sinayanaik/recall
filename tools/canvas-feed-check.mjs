// To the Canvas — where the Blocks go (src/documents/canvas-flow.js). Pure
// Node, no browser; the app itself is tools/canvas-feed-browser-check.mjs.
//
//   node tools/canvas-feed-check.mjs
//
// What has to hold:
//
//   • the first new thing goes under the lowest thing already on the last
//     page, or at the top of an empty one, inside the page's margins;
//   • each next one goes under the last, a gap between, none overlapping;
//   • one that does not fit starts a new page, and the count of new pages is
//     what the Canvas is told to add; one taller than a page still goes, at the
//     top of a page of its own;
//   • a card is one row: its question at the left, its answer to its right
//     with room for the arrow between, both tops level;
//   • a drop puts the top-left corner where it was let go, kept on the page.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flow = await import(pathToFileURL(path.join(ROOT, "src/documents/canvas-flow.js")).href);

let failures = 0;
let ran = 0;
function must(label, fn) {
  ran += 1;
  let result;
  try { result = fn(); } catch (error) { result = String(error?.stack || error); }
  const ok = result === true;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : `  ${typeof result === "string" ? result : JSON.stringify(result)}`}`);
}

const A4 = [0, 0, 595, 842];
const page = (n, margins = {}) => ({ page: n, box: A4, margins });
const { flowOntoCanvas, flowContentBox, placeAtPoint, lowestEdge, FLOW_EDGE, FLOW_FOOT, FLOW_GAP, FLOW_AFTER_EXISTING, FLOW_PAIR_GAP } = flow;
const topOf = (place, h) => place.y + h;

must("an empty page starts at its top, inside the edge", () => {
  const { places, newPages } = flowOntoCanvas({ pages: [page(1)], lowest: null, items: [{ w: 200, h: 50 }] });
  return newPages === 0 && places[0].page === 1 && places[0].x === FLOW_EDGE && topOf(places[0], 50) === 842 - FLOW_EDGE || JSON.stringify(places);
});

must("the page's own margins win when they are wider (ruled paper)", () => {
  const { places } = flowOntoCanvas({ pages: [page(1, { top: 24, left: 56, right: 32 })], items: [{ w: 100, h: 20 }] });
  return places[0].x === 56 && topOf(places[0], 20) === 842 - FLOW_EDGE || JSON.stringify(places);
});

must("under what is already there, with a gap", () => {
  const { places } = flowOntoCanvas({ pages: [page(1)], lowest: 600, items: [{ w: 100, h: 40 }] });
  return topOf(places[0], 40) === 600 - FLOW_AFTER_EXISTING || JSON.stringify(places);
});

must("stacked down the page, none overlapping", () => {
  const items = [{ w: 100, h: 40 }, { w: 200, h: 80 }, { w: 150, h: 10 }];
  const { places } = flowOntoCanvas({ pages: [page(1)], items });
  return places.every((place, i) => i === 0 || topOf(place, items[i].h) === places[i - 1].y - FLOW_GAP) || JSON.stringify(places);
});

must("onto a new page when the last is full, and says how many", () => {
  const items = Array.from({ length: 7 }, () => ({ w: 200, h: 200 }));
  const { places, newPages } = flowOntoCanvas({ pages: [page(1)], lowest: 300, items });
  const pages = places.map((place) => place.page);
  const ok = newPages === Math.max(...pages) - 1 && pages[0] === 1 && pages.every((p, i) => i === 0 || p >= pages[i - 1])
    && places.every((place) => place.y >= FLOW_FOOT);
  return ok || JSON.stringify({ newPages, pages, ys: places.map((p) => p.y) });
});

must("a new page starts at its top", () => {
  const { places } = flowOntoCanvas({ pages: [page(4)], lowest: 100, items: [{ w: 100, h: 200 }] });
  return places[0].page === 5 && topOf(places[0], 200) === 842 - FLOW_EDGE || JSON.stringify(places);
});

must("something taller than a page goes at the top of its own page", () => {
  const { places, newPages } = flowOntoCanvas({ pages: [page(1)], lowest: 700, items: [{ w: 100, h: 2000 }] });
  return places[0].page === 2 && newPages === 1 && topOf(places[0], 2000) === 842 - FLOW_EDGE || JSON.stringify(places);
});

must("...but on an empty page it stays on that page", () => {
  const { places, newPages } = flowOntoCanvas({ pages: [page(1)], lowest: null, items: [{ w: 100, h: 2000 }] });
  return places[0].page === 1 && newPages === 0 || JSON.stringify(places);
});

must("a card is one row: question, the arrow's room, answer, tops level", () => {
  const { places } = flowOntoCanvas({ pages: [page(1)], items: [{ pair: [{ w: 120, h: 40 }, { w: 150, h: 70 }] }, { w: 100, h: 20 }] });
  const [card, next] = places;
  const [q, a] = card.parts;
  return (a.x === q.x + 120 + FLOW_PAIR_GAP && q.y + 40 === a.y + 70 && topOf(next, 20) === Math.min(q.y, a.y) - FLOW_GAP) || JSON.stringify(places);
});

must("the content box keeps the page number's room at the foot", () => {
  const content = flowContentBox(A4, {});
  return content.bottom === FLOW_FOOT && content.left === FLOW_EDGE && content.right === 595 - FLOW_EDGE || JSON.stringify(content);
});

must("a drop puts the top-left corner at the point", () => {
  const place = placeAtPoint({ box: A4, at: { page: 2, x: 200, y: 500 }, item: { w: 100, h: 40 } });
  return place.page === 2 && place.x === 200 && place.y === 460 || JSON.stringify(place);
});

must("...and keeps it on the page", () => {
  const place = placeAtPoint({ box: A4, at: { page: 1, x: 580, y: 20 }, item: { w: 100, h: 40 } });
  return place.x + 100 <= 595 - 12 && place.y >= 12 || JSON.stringify(place);
});

must("the lowest edge of what is on a page", () => {
  return lowestEdge([[0, 500, 10, 520], [5, 480, 9, 700], [1, 900, 2, 950]]) === 480 && lowestEdge([]) === null;
});

console.log(`\ncanvas-feed-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
