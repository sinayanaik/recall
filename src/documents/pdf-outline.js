// The PDF's own table of contents, in the drawer the notes TOC already uses.
//
// Deliberately the same drawer chrome, the same fold-a-section affordance and
// the same "On this page" idiom as src/notes/toc.js — a reader who has used one
// has used the other, and a second, differently-shaped TOC panel for the sake
// of a different document format would be a worse app, not a more capable one.
//
// What it cannot share is where the entries come from. A notes TOC is derived
// from markdown headings; this one comes from the file's outline dictionary,
// whose destinations are page references that have to be resolved through the
// document one at a time.

import { el } from "../core/dom.js?v=__BUILD__";

// Nesting deeper than this is folded into its parent's level rather than
// indented further. Books do go five deep, and at that point the indent is
// eating the drawer's width without telling the reader anything.
export const OUTLINE_MAX_DEPTH = 3;

// Resolving a destination costs a lookup per entry, and a reference work can
// carry thousands. Capped so opening one does not spend a second of main thread
// on a drawer nobody has opened yet; past the cap the entries are still listed,
// they just jump by resolving on demand when tapped.
export const OUTLINE_EAGER_LIMIT = 300;

let outlineEntries = [];

export function documentOutlineEntries() {
  return outlineEntries;
}

export function clearDocumentOutline() {
  outlineEntries = [];
  const list = el.documentOutlineList;
  if (list) list.innerHTML = "";
  if (el.documentOutlineEmpty) el.documentOutlineEmpty.hidden = false;
}

// A pdf.js outline destination → a 1-based page number, or 0 when it cannot be
// resolved (a broken link, or a named destination the file does not define).
export async function outlineDestinationPage(doc, dest) {
  try {
    const resolved = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || !resolved.length) return 0;
    const index = await doc.getPageIndex(resolved[0]);
    return index + 1;
  } catch (_) {
    return 0;
  }
}

export function flattenOutline(items, depth = 0, out = []) {
  (items || []).forEach((item) => {
    out.push({
      title: String(item.title || "").replace(/\s+/g, " ").trim(),
      dest: item.dest,
      depth: Math.min(depth, OUTLINE_MAX_DEPTH),
      page: 0
    });
    if (item.items?.length) flattenOutline(item.items, depth + 1, out);
  });
  return out;
}

export async function buildDocumentOutline(doc) {
  const outline = await doc.getOutline();
  outlineEntries = flattenOutline(outline).filter((entry) => entry.title);
  if (!outlineEntries.length) {
    renderDocumentOutline();
    return outlineEntries;
  }
  // Resolved in order and in the background: the drawer renders immediately
  // with every title in it, and each row becomes a jump as its page lands.
  const eager = outlineEntries.slice(0, OUTLINE_EAGER_LIMIT);
  renderDocumentOutline();
  for (const entry of eager) {
    entry.page = await outlineDestinationPage(doc, entry.dest);
  }
  renderDocumentOutline();
  return outlineEntries;
}

export function renderDocumentOutline() {
  const list = el.documentOutlineList;
  if (!list) return;
  list.innerHTML = "";
  if (el.documentOutlineEmpty) el.documentOutlineEmpty.hidden = outlineEntries.length > 0;
  const frag = document.createDocumentFragment();
  outlineEntries.forEach((entry, index) => {
    const row = document.createElement("li");
    row.className = `document-toc-item is-depth-${entry.depth}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "document-toc-link";
    button.dataset.outlineIndex = String(index);
    button.textContent = entry.title;
    if (entry.page) {
      const page = document.createElement("span");
      page.className = "document-toc-page";
      page.textContent = String(entry.page);
      button.appendChild(page);
    }
    row.appendChild(button);
    frag.appendChild(row);
  });
  list.appendChild(frag);
}
