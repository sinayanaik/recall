// Moving rows of a PDF's contents, and reading where a link goes.
//
//   node tools/pdf-toc-arrange-check.mjs
//
// src/documents/pdf-toc-arrange.js is the arithmetic behind dragging a heading
// in the contents drawer — a row moves with everything under it, and dropping
// it into another row nests it — and src/documents/pdf-dest.js turns a PDF
// destination into a page and a height on it, for the links in a page and for
// the contents. Both are pure and import nothing, so they are loaded straight
// from src/ with no browser.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arrange = await import(pathToFileURL(path.join(ROOT, "src/documents/pdf-toc-arrange.js")).href);
const dest = await import(pathToFileURL(path.join(ROOT, "src/documents/pdf-dest.js")).href);

const results = [];
async function must(name, fn) {
  try {
    const answer = await fn();
    results.push([answer === true, name, answer === true ? "" : String(answer)]);
  } catch (error) {
    results.push([false, name, error?.stack || String(error)]);
  }
}

// "A0 B1 C1 D0" — title then depth, which is how the tree reads at a glance.
const rows = (spec) => spec.split(" ").map((token) => ({ title: token[0], depth: Number(token.slice(1)) }));
const show = (entries) => entries.map((entry) => `${entry.title}${entry.depth}`).join(" ");

await must("subtreeEnd is one past a row's last descendant", () => {
  const list = rows("A0 B1 C2 D1 E0");
  const ends = [0, 1, 2, 3, 4].map((index) => arrange.subtreeEnd(list, index)).join(",");
  return ends === "4,3,3,4,5" || `got ${ends}`;
});

await must("a branch moves with everything under it, its shape kept", () => {
  // B (with C under it) to the end, at the top level.
  const moved = arrange.moveSubtree(rows("A0 B1 C2 D0"), 1, 4, 0);
  return show(moved.entries) === "A0 D0 B0 C1" && moved.index === 2 || `got ${show(moved.entries)} @${moved.index}`;
});

await must("dropping a row into another nests it as that row's child", () => {
  // D into A, straight after A, one level deeper.
  const moved = arrange.moveSubtree(rows("A0 B0 C0 D0"), 3, 1, 1);
  return show(moved.entries) === "A0 D1 B0 C0" || `got ${show(moved.entries)}`;
});

await must("a drop inside the branch being carried is not a move", () => {
  const before = rows("A0 B1 C2 D0");
  const moved = arrange.moveSubtree(before, 1, 2, 0);
  return show(moved.entries) === show(before) || `got ${show(moved.entries)}`;
});

await must("depth is clamped to what the rows around the drop allow", () => {
  // Asking for depth 3 at the top of the list gives depth 0; asking for 0 in
  // front of a child gives the child's depth, so the child is not adopted.
  const top = arrange.moveSubtree(rows("A0 B0 C0"), 2, 0, 3);
  const between = arrange.moveSubtree(rows("A0 B1 C0"), 2, 1, 0);
  return (show(top.entries) === "C0 A0 B0" && show(between.entries) === "A0 C1 B1") || `got ${show(top.entries)} / ${show(between.entries)}`;
});

await must("...and to the maximum depth, for the whole branch", () => {
  const moved = arrange.moveSubtree(rows("A0 B1 C2 D3 E0 F1"), 4, 4, 4, 3);
  return show(moved.entries) === "A0 B1 C2 D3 E3 F3" || `got ${show(moved.entries)}`;
});

await must("allowedDepths: no deeper than one under the row above, no shallower than the row below", () => {
  const list = rows("A0 B1 C2");
  const answers = [0, 1, 2, 3].map((at) => {
    const { min, max } = arrange.allowedDepths(list, at);
    return `${min}-${max}`;
  }).join(",");
  return answers === "0-0,1-1,2-2,0-3" || `got ${answers}`;
});

await must("moveUp and moveDown step among siblings only", () => {
  const list = rows("A0 B1 C1 D0");
  const up = arrange.moveUp(list, 2);
  const down = arrange.moveDown(list, 0);
  const firstUp = arrange.moveUp(list, 1);
  return (show(up.entries) === "A0 C1 B1 D0" && show(down.entries) === "D0 A0 B1 C1" && firstUp === null)
    || `got ${show(up.entries)} / ${show(down?.entries || [])} / ${JSON.stringify(firstUp)}`;
});

await must("indent puts a row under the sibling above it; the first sibling cannot", () => {
  const list = rows("A0 B0 C1 D0");
  const indented = arrange.indent(list, 1);
  return (show(indented.entries) === "A0 B1 C2 D0" && arrange.indent(list, 0) === null) || `got ${show(indented.entries)}`;
});

await must("outdent moves a row out after its parent's whole branch, leaving its siblings where they were", () => {
  const out = arrange.outdent(rows("A0 B1 C1 D0"), 1);
  return show(out.entries) === "A0 C1 B0 D0" || `got ${show(out.entries)}`;
});

await must("removing a heading keeps what was under it, a level up", () => {
  const left = arrange.removeEntry(rows("A0 B1 C2 D0"), 1);
  return show(left) === "A0 C1 D0" || `got ${show(left)}`;
});

await must("a bookmark goes after the last row at or before its place, one level under it", () => {
  const list = [
    { title: "A", depth: 0, page: 1 },
    { title: "B", depth: 1, page: 3, ratio: 0.5 },
    { title: "C", depth: 0, page: 7 }
  ];
  const mid = arrange.insertionFor(list, 3, 0.6, 3);
  const early = arrange.insertionFor(list, 3, 0.2, 3);
  const first = arrange.insertionFor(list, 1, 0, 3);
  const before = arrange.insertionFor([{ title: "A", depth: 0, page: 4 }], 2, 0, 3);
  const got = [mid, early, first, before].map((at) => `${at.index}:${at.depth}`).join(",");
  return got === "2:2,1:1,1:1,0:0" || `got ${got}`;
});

// ── Destinations ─────────────────────────────────────────────────────────

await must("destinationTop reads the height out of XYZ, FitH, FitBH and FitR, and nothing else", () => {
  const ref = { num: 4, gen: 0 };
  const got = [
    [ref, { name: "XYZ" }, 72, 640, 0],
    [ref, { name: "FitH" }, 500],
    [ref, { name: "FitBH" }, 400],
    [ref, { name: "FitR" }, 10, 20, 300, 700],
    [ref, { name: "Fit" }],
    [ref, { name: "XYZ" }, null, null, null]
  ].map(dest.destinationTop).join(",");
  return got === "640,500,400,700,," || `got ${got}`;
});

// A pdf.js document's worth of answers, for one 612×792 page per number.
function fakeDoc(pages = 10) {
  const named = { intro: [{ num: 13, gen: 0 }, { name: "XYZ" }, 0, 792 - 198, 0] };
  return {
    numPages: pages,
    getDestination: async (name) => named[name] || null,
    getPageIndex: async (ref) => {
      if (ref?.num === 13) return 2;
      throw new Error("no such page");
    },
    getPage: async () => ({
      getViewport: () => ({
        height: 792,
        // An unrotated page at scale 1: y flips, x passes through.
        convertToViewportPoint: (x, y) => [x, 792 - y]
      })
    })
  };
}

await must("a named destination resolves to its page and how far down it", async () => {
  const { page, ratio } = await dest.resolvePdfDestination(fakeDoc(), "intro");
  return (page === 3 && Math.abs(ratio - 0.25) < 1e-9) || `got ${page} / ${ratio}`;
});

await must("a bare page index is read as 0-based, and one past the end is nowhere", async () => {
  const doc = fakeDoc(5);
  const inside = await dest.resolvePdfDestination(doc, [4, { name: "Fit" }]);
  const outside = await dest.resolvePdfDestination(doc, [5, { name: "Fit" }]);
  return (inside.page === 5 && inside.ratio === 0 && outside.page === 0) || `got ${JSON.stringify([inside, outside])}`;
});

await must("a destination the file does not define resolves to nothing, without throwing", async () => {
  const doc = fakeDoc();
  const missing = await dest.resolvePdfDestination(doc, "nowhere");
  const broken = await dest.resolvePdfDestination(doc, [{ num: 99, gen: 0 }, { name: "XYZ" }, 0, 10, 0]);
  return (missing.page === 0 && broken.page === 0) || `got ${JSON.stringify([missing, broken])}`;
});

await must("the viewer's live viewport is used when it has one", async () => {
  const live = { height: 1584, convertToViewportPoint: (x, y) => [x * 2, (792 - y) * 2] };
  const { ratio } = await dest.resolvePdfDestination(fakeDoc(), "intro", (page) => (page === 3 ? live : null));
  return Math.abs(ratio - 0.25) < 1e-9 || `got ${ratio}`;
});

console.log("── pdf contents arrangement ──");
for (const [ok, name, detail] of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
}
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n  ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
