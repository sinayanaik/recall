// Bookmarks (a PDF outline) from the page's headings, without a tagged PDF.
//
// Chrome only writes its own outline into a tagged PDF, and tagging a long web
// page makes the PDF several times bigger and slower to make (one structure
// element per run of text). But Chrome writes a named destination, with its
// exact printed page and position, for every element an in-page link points
// at — even a link nobody can see. So content/prepare.js gives each heading an
// id and a hidden link to it (markHeadings), and this appends an /Outlines tree
// that points at those destinations, as an incremental update
// (lib/pdf-objects.js).
//
// Plain ES module: used by pdf-job.js, and by the app's checks under Node.

import { readDoc, readPagesOf, readDestsOf, catalogOf, appendObjects } from "./pdf-objects.js";
import { pdfString } from "./pdf-info.js";

/**
 * Returns new bytes with an outline of `headings` ([{ id, level, text }], in
 * reading order). Headings Chrome wrote no destination for are left out; with
 * none left, or a PDF that cannot be read, `bytes` comes back as it was. A PDF
 * that already has an outline (a tagged print) is left alone too.
 */
export function addOutline(bytes, headings) {
  if (!headings || !headings.length) return bytes;
  const doc = readDoc(bytes);
  if (!doc) return bytes;
  const root = catalogOf(doc);
  if (!root || /\/Outlines\s+\d+\s+\d+\s+R/.test(root.dict)) return bytes;
  const pages = readPagesOf(doc);
  if (!pages) return bytes;
  const dests = readDestsOf(doc, pages);

  const items = [];
  for (const h of headings) {
    const dest = dests.get(h.id);
    const text = String(h.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!dest || !text) continue;
    items.push({ level: Math.max(1, Math.min(6, Number(h.level) || 1)), text, dest: dest.array, children: [] });
  }
  if (!items.length) return bytes;

  // Nest by level: each item under the nearest earlier item of a lower level.
  const top = { level: 0, children: [] };
  const stack = [top];
  for (const item of items) {
    while (stack[stack.length - 1].level >= item.level) stack.pop();
    stack[stack.length - 1].children.push(item);
    stack.push(item);
  }

  let next = doc.trailer.size;
  const outlinesNum = next++;
  const number = (list) => list.forEach((item) => { item.num = next++; number(item.children); });
  number(top.children);
  // Top-level entries open, deeper ones folded, so a long page's outline
  // stays short. An open entry's /Count is how many entries show under it.

  const objects = [];
  const write = (list, parentNum, depth) => {
    list.forEach((item, i) => {
      const parts = [
        `/Title ${pdfString(item.text)}`,
        `/Parent ${parentNum} 0 R`,
        `/Dest ${item.dest}`
      ];
      if (i > 0) parts.push(`/Prev ${list[i - 1].num} 0 R`);
      if (i < list.length - 1) parts.push(`/Next ${list[i + 1].num} 0 R`);
      if (item.children.length) {
        parts.push(`/First ${item.children[0].num} 0 R`, `/Last ${item.children[item.children.length - 1].num} 0 R`);
        parts.push(`/Count ${depth === 0 ? item.children.length : -item.children.length}`);
      }
      objects.push({ num: item.num, body: `<< ${parts.join(" ")} >>` });
      write(item.children, item.num, depth + 1);
    });
  };
  write(top.children, outlinesNum, 0);
  const visible = top.children.reduce((n, item) => n + 1 + item.children.length, 0);
  objects.push({
    num: outlinesNum,
    body: `<< /Type /Outlines /First ${top.children[0].num} 0 R /Last ${top.children[top.children.length - 1].num} 0 R /Count ${visible} >>`
  });

  let catalog = root.dict.replace(/\/(Outlines|PageMode)\s*(\d+\s+\d+\s+R|\/\w+)/g, "");
  catalog = catalog.replace(/>>\s*$/, ` /Outlines ${outlinesNum} 0 R /PageMode /UseOutlines >>`);
  objects.push({ num: root.num, gen: root.gen, body: catalog });
  return appendObjects(bytes, doc, objects, next);
}
