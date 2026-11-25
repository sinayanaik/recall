// Lists of Canvas pages (src/documents/canvas-page-list.js), pure, in Node:
// which pages an export takes, what a file name calls them, and where every
// page goes when some are dragged in the Pages panel.
//
//   node tools/canvas-page-list-check.mjs

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const list = await import(pathToFileURL(path.join(ROOT, "src/documents/canvas-page-list.js")).href);

let ran = 0;
let failed = 0;
function must(label, ok, detail = "") {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `  ${detail}`}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

must("no pages asked for is every page", same(list.exportPageList(null, 3), [1, 2, 3]));
must("pages asked for come back in order, once each, only those that exist", same(list.exportPageList([4, 2, 2, 9, 0], 5), [2, 4]));
must("none that exist is every page", same(list.exportPageList([7], 3), [1, 2, 3]));
must("a Set works as a list", same(list.exportPageList(new Set([3, 1]), 3), [1, 3]));
must("runs of pages read as ranges", list.pageListLabel([7, 2, 3, 4]) === "2-4, 7", list.pageListLabel([7, 2, 3, 4]));
must("every page is the whole Canvas", list.isWholeCanvas([1, 2, 3], 3) && !list.isWholeCanvas([1, 3], 3));

const top = list.pageOrderAfterMove(4, [3], 1);
must("page 3 dragged to the top", same(top, [3, 1, 2, 4]), JSON.stringify(top));
const end = list.pageOrderAfterMove(4, [1], 99);
must("page 1 dragged past the end", same(end, [2, 3, 4, 1]), JSON.stringify(end));
const two = list.pageOrderAfterMove(5, [2, 4], 6);
must("pages 2 and 4 dragged to the end keep their order", same(two, [1, 3, 5, 2, 4]), JSON.stringify(two));
const into = list.pageOrderAfterMove(5, [1, 5], 3);
must("pages 1 and 5 dropped before page 3", same(into, [2, 1, 5, 3, 4]), JSON.stringify(into));
must("dropped where they are changes nothing", list.isIdentityOrder(list.pageOrderAfterMove(4, [2], 2)) && list.isIdentityOrder(list.pageOrderAfterMove(4, [2], 3)));
must("nothing to move changes nothing", list.isIdentityOrder(list.pageOrderAfterMove(4, [], 1)));

const move = list.moveForOrder(top);
must("a record on page 3 goes to page 1, one on page 1 to page 2", move({ page: 3 }) === 1 && move({ page: 1 }) === 2 && move({ page: 4 }) === 4);
must("the pages moved are where they landed", same(list.pagesAfterOrder([2, 4], two), [4, 5]), JSON.stringify(list.pagesAfterOrder([2, 4], two)));

console.log(`\ncanvas-page-list-check: ${ran - failed}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
