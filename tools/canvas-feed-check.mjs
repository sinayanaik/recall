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
//   • a drop puts the top-left corner where it was let go, kept on the page;
//   • a card laid out "stacked" is its question above its answer;
//   • what goes on the Canvas leaves its sizes behind (canvas-sizing.js) —
//     a picture's width, a diagram's w=, a font size — and keeps its look;
//   • words with no markup join their page's line ends, as a PDF's words do;
//   • a card's style is kept to what it can be (card-canvas-style.js);
//   • a balanced Block's width (block-measure.js) is continuous and never
//     shrinks as words are added: a label keeps its line, a sentence wraps
//     at a comfortable line, a paragraph widens toward the measure.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flow = await import(pathToFileURL(path.join(ROOT, "src/documents/canvas-flow.js")).href);
const sizing = await import(pathToFileURL(path.join(ROOT, "src/documents/canvas-sizing.js")).href);
const cardStyle = await import(pathToFileURL(path.join(ROOT, "src/documents/card-canvas-style.js")).href);
const measure = await import(pathToFileURL(path.join(ROOT, "src/documents/block-measure.js")).href);

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

must("a stacked card: the question on top, the answer under it, the arrow's room between", () => {
  const { places } = flowOntoCanvas({ pages: [page(1)], items: [{ pair: [{ w: 120, h: 40 }, { w: 150, h: 70 }], stacked: true }, { w: 100, h: 20 }] });
  const [card, next] = places;
  const [q, a] = card.parts;
  return (q.x === a.x && q.y - FLOW_PAIR_GAP === a.y + 70 && topOf(next, 20) === a.y - FLOW_GAP) || JSON.stringify(places);
});

must("a stacked card dropped keeps on the page by its whole height", () => {
  const place = placeAtPoint({ box: A4, at: { page: 1, x: 100, y: 60 }, item: { pair: [{ w: 100, h: 40 }, { w: 100, h: 40 }], stacked: true } });
  return place.parts[1].y >= 12 || JSON.stringify(place);
});

must("a picture's width in the Notes is not taken onto the Canvas", () => {
  const md = sizing.canvasSizedMarkdown('Before <img src="https://x.org/a b.png" alt="A cat" class="has-custom-size" style="--notes-img-w:640px; width:640px"> after');
  return md === "Before ![A cat](<https://x.org/a b.png>) after" || md;
});

must("...nor a diagram's w=, while its language stays", () => {
  const md = sizing.canvasSizedMarkdown("```mermaid w=600\ngraph TD; A-->B\n```");
  return md === "```mermaid\ngraph TD; A-->B\n```" || md;
});

must("...nor a font size; the colour stays", () => {
  const md = sizing.canvasSizedMarkdown('<span style="color: red; font-size: 28px">big</span> and <span style="font-size:9px">small</span>');
  return md === '<span style="color: red">big</span> and <span>small</span>' || md;
});

must("...and inside a listing nothing is touched", () => {
  const src = "```html\n<img src=\"a.png\" style=\"width:10px\">\n```";
  return sizing.canvasSizedMarkdown(src) === src || sizing.canvasSizedMarkdown(src);
});

must("what kind of thing it is, for its width", () => {
  const k = sizing.canvasItemKind;
  const got = [k("![](a.png)"), k("```js\nx\n```"), k("```mermaid\ngraph TD\n```"), k("| a | b |\n|---|---|\n| 1 | 2 |"), k("Some words"), k("Words and ![](a.png) with a long sentence that runs on and on well past a caption's length, so it is words.")];
  return JSON.stringify(got) === JSON.stringify(["picture", "code", "diagram", "table", "text", "text"]) || JSON.stringify(got);
});

must("bare words: the page's line ends joined, a hyphen's word joined, paragraphs kept", () => {
  const md = sizing.pdfPlainToMarkdown("The quick brown\nfox jumps over the exam-\nple dog.\n\nA *second* para-\ngraph");
  return md === "The quick brown fox jumps over the example dog.\n\nA \\*second\\* paragraph" || JSON.stringify(md);
});

must("...a bullet starts its own line, and a link alone stays a link", () => {
  const md = sizing.pdfPlainToMarkdown("• one\n• two\n\nhttps://example.org/x");
  return md === "- one\n\n- two\n\n<https://example.org/x>" || JSON.stringify(md);
});

must("a card's style is kept to what it can be", () => {
  const s = cardStyle.normalizeCardCanvasStyle({ q: { fill: "yellow", size: "14pt", nonsense: 1 }, a: { fill: "nope" }, arrow: { color: "red", width: "2.5", dash: "dash", head: "open", route: "curve" }, layout: "stacked" });
  const bad = cardStyle.normalizeCardCanvasStyle({ arrow: { color: "#fff", width: -1, dash: "zig", head: "x", route: "loop" }, layout: "x" });
  return (s.q.fill === "yellow" && s.q.size === 14 && !("nonsense" in s.q) && !("fill" in s.a) && s.arrow.width === 2.5 && s.layout === "stacked"
    && bad.arrow.color === "" && bad.arrow.width === null && bad.arrow.dash === "" && bad.arrow.head === "" && bad.arrow.route === "" && bad.layout === "side") || JSON.stringify({ s, bad });
});

must("the arrow changes only what was chosen", () => {
  const base = { type: "arrow", stroke: "#16181d", width: 1.6, dash: "solid", heads: ["none", "filled"], route: "elbow" };
  const same = cardStyle.cardArrowShape(base, {});
  const changed = cardStyle.cardArrowShape(base, { color: "red", dash: "dot", head: "open", route: "straight" });
  return (JSON.stringify(same) === JSON.stringify(base) && changed.stroke === "#dc2626" && changed.dash === "dot" && changed.heads[1] === "open" && !("route" in changed) && changed.width === 1.6) || JSON.stringify({ same, changed });
});

// ── Balanced width, as a guess from the words (balancedWidthGuess) ──────────
const WORDS = "Spaced repetition works because each review is timed to land just as the memory begins to fade, so the effort of recalling it strengthens the trace more than an easy review would; the intervals grow with each success and shrink after a lapse, which keeps the total time spent small while the material stays within reach for months or years. ".repeat(3);
const guess = (n) => measure.balancedWidthGuess(WORDS.slice(0, n), { cap: 368, min: 20 });

must("a balanced width: a label keeps its own line", () => {
  const w = guess(18);
  return Math.abs(w - 18 * 5.6) < 1 || w;
});

must("...a sentence shorter than the measure still wraps, at a comfortable line", () => {
  const w = guess(60);
  return (w < 60 * 5.6 && w >= 150) || w;
});

must("...never narrower as words are added, and no jump anywhere", () => {
  let last = guess(4);
  for (let n = 5; n <= WORDS.length; n += 1) {
    const w = guess(n);
    if (w < last - 1) return `narrower at ${n}: ${last} → ${w}`;
    if (w > last + 12) return `jumped at ${n}: ${last} → ${w}`;
    last = w;
  }
  return true;
});

must("...a long paragraph widens toward the measure, never past it", () => {
  const mid = guess(340);
  const long = guess(WORDS.length);
  return (mid > guess(120) && long <= 368 && long > mid) || JSON.stringify({ mid, long });
});

console.log(`\ncanvas-feed-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
