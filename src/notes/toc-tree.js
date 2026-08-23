// The contents tree, drawn once for both things that have one.
//
// A note's contents and a paper's contents are the same control — a flat list of
// rows with the tree drawn by rail spans, a twisty on every branch, folds
// carried by key rather than by index — and they were two implementations of it.
// The notes one (buildNotesToc, src/notes/toc.js) had the rail, the folding, the
// fold-all button and the scroll-spy; the document one
// (src/documents/pdf-outline.js) had a flat <li><button> with a padding-left per
// depth and nothing else. A reader who had used one had not used the other,
// which is the opposite of what the drawer's own header comment promises.
//
// So the parts that are genuinely the same live here and both surfaces call
// them. What stays with each surface is what actually differs: where the entries
// come from, what a row jumps to, and how "where am I now" is answered.
//
// ── The list is FLAT ───────────────────────────────────────────────────────
//
// One <li> per entry, with the tree drawn by .notes-toc-rail spans rather than
// by nesting — so folding cannot be "hide the child <ul>". The parent/child
// relation the DOM does not carry is computed here (tocParentsFromDepths) and
// applied as nothing more than [hidden] on the rows under a folded ancestor.
// styles/17-toc-fold.css is the other half and is written against exactly these
// class names, which is why they are constants rather than strings typed twice.

export const TOC_ROW_CLASS = "notes-toc-item";

export const TOC_LINK_CLASS = "notes-toc-link";

export const TOC_TWISTY_CLASS = "notes-toc-twisty";

// Nesting deeper than this is folded into its parent's level rather than
// indented further. Books do go five deep, and at that point the indent is
// eating the drawer's width without telling the reader anything.
export const TOC_MAX_DEPTH = 4;

// Is `depths[i]` the last item among its own sibling group? (No later entry
// at the same depth before the group is closed by something shallower.)
export function tocIsLastSibling(depths, i) {
  const depth = depths[i];
  for (let j = i + 1; j < depths.length; j++) {
    if (depths[j] < depth) return true;
    if (depths[j] === depth) return false;
  }
  return true;
}

// Does the ancestor guide line at `depth` still have a later sibling coming
// (i.e. should the vertical rail continue straight through this row at that
// column), or has that branch already closed?
export function tocGuideContinues(depths, i, depth) {
  for (let j = i + 1; j < depths.length; j++) {
    if (depths[j] < depth) return false;
    if (depths[j] === depth) return true;
  }
  return false;
}

// Levels (1-6 for markdown, or a derived rank for a PDF) → depths, with the
// shallowest normalised to 0 so a note that starts at ## still indents from the
// left edge rather than looking pushed-in.
export function tocDepthsFromLevels(levels) {
  if (!levels.length) return [];
  const min = levels.reduce((low, level) => Math.min(low, level), Infinity);
  return levels.map((level) => Math.min(level - min, TOC_MAX_DEPTH));
}

// A row's parent is the nearest earlier row shallower than it.
//
// Walks DOWN for the nearest open ancestor rather than reading depth-1
// directly: depths are not guaranteed contiguous — a note that goes from #
// straight to ###, or a paper whose type sizes skip a rank — leaves a hole, and
// a hole read as "no parent" would make a row unfoldable from the section above.
export function tocParentsFromDepths(depths) {
  const openAtDepth = [];
  return depths.map((depth, index) => {
    openAtDepth.length = depth;
    let parent = -1;
    for (let d = depth - 1; d >= 0; d -= 1) {
      if (openAtDepth[d] !== undefined) { parent = openAtDepth[d]; break; }
    }
    openAtDepth[depth] = index;
    return parent;
  });
}

// A row is a branch when the very next one is deeper, which is the only way a
// child can begin.
export function tocBranchesFromDepths(depths) {
  return depths.map((depth, index) => index + 1 < depths.length && depths[index + 1] > depth);
}

// Is any ancestor of `index` folded? Walks the parent chain rather than
// consulting a per-row flag, so folding a branch needs no bookkeeping on the
// rows below it.
export function tocRowIsHidden(parents, keys, collapsed, index) {
  for (let p = parents[index]; p >= 0; p = parents[p]) {
    if (collapsed.has(keys[p])) return true;
  }
  return false;
}

// Which branches are folded, carried across a rebuild by KEY rather than by
// index: an edit that adds a paragraph renumbers every row after it, and the
// reader's folds would jump one row up the tree each time.
//
// A key that is NOT in `known` is new and starts folded — which is what makes a
// drawer open as an outline instead of as several hundred rows, and, because
// the sets are pruned to the current list's own keys, is also what resets the
// folds when a different note or a different paper opens.
export function tocCarryFolds({ keys, branches, known, collapsed }) {
  const nextKnown = new Set();
  const nextCollapsed = new Set();
  keys.forEach((key, index) => {
    if (!branches[index]) return;
    nextKnown.add(key);
    if (!known.has(key) || collapsed.has(key)) nextCollapsed.add(key);
  });
  return { known: nextKnown, collapsed: nextCollapsed };
}

// One column per ancestor level, plus an elbow connecting up to the parent
// chain and across to this row's dot — the last column is a "├" (more siblings
// follow) or "└" (last child) elbow, columns before it are plain vertical guides
// that only continue if that ancestor branch still has more siblings coming.
export function tocRailHtml(depths, index, depth) {
  let rail = "";
  for (let d = 0; d < depth; d++) {
    if (d === depth - 1) {
      rail += `<span class="notes-toc-elbow" data-last="${tocIsLastSibling(depths, index)}"></span>`;
    } else {
      // Column d represents the ancestor ONE level below it (d+1) — e.g. column
      // 0 for a depth-3 item is its grandparent's level (depth 1), not the
      // root's (depth 0); the root gets no column of its own since depth-0 rows
      // never get a rail at all.
      rail += `<span class="notes-toc-guide" data-state="${tocGuideContinues(depths, index, d + 1) ? "line" : "blank"}"></span>`;
    }
  }
  return rail;
}

// One row: the <li>, its link, and (for a branch) the twisty.
//
// `href` is what decides whether the link is an <a> or a <button>, and the two
// are not interchangeable: a heading in a note HAS a URL and should be
// middle-clickable, and "page 47 of this PDF" does not — a link that goes
// nowhere is a promise the browser cannot keep. Both carry the same class, so
// the delegated click handler on each list is one `closest(".notes-toc-link")`
// either way.
//
// `tail` is an optional node appended inside the link after the text — the page
// number on a document row, and nothing at all on a notes row.
export function tocRowFor({ index, depth, depths, level, text, id, href, branch, tail }) {
  const li = document.createElement("li");
  li.className = TOC_ROW_CLASS;
  // The twisty is positioned against the row, at this row's own indent, so the
  // depth has to be readable from the <li> as well as from the link.
  li.style.setProperty("--toc-depth", String(depth));

  const link = document.createElement(href ? "a" : "button");
  link.className = TOC_LINK_CLASS;
  if (href) link.href = href;
  else link.type = "button";
  link.dataset.tocIndex = String(index);
  link.style.setProperty("--toc-depth", String(depth));

  const rail = tocRailHtml(depths, index, depth);
  link.innerHTML =
    (rail ? `<span class="notes-toc-rail" aria-hidden="true">${rail}</span>` : "")
    + `<span class="notes-toc-dot" data-level="${level}"></span>`
    + `<span class="notes-toc-text"></span>`;
  link.querySelector(".notes-toc-text").textContent = text;
  if (tail) link.appendChild(tail);
  li.appendChild(link);

  // A <button> cannot live inside the <a> — nesting interactive content is
  // invalid and browsers reparent it out of the link, which in a list built with
  // innerHTML lands it somewhere unpredictable. It is a SIBLING of the link,
  // laid over the dot cell, and the row keeps working as one big target
  // everywhere the twisty is not.
  if (branch) {
    li.classList.add("is-branch");
    const twisty = document.createElement("button");
    twisty.type = "button";
    twisty.className = TOC_TWISTY_CLASS;
    twisty.dataset.tocIndex = String(index);
    twisty.dataset.tocLabel = text;
    twisty.innerHTML = '<span class="notes-toc-twisty-glyph" aria-hidden="true">▸</span>';
    li.appendChild(twisty);
  }
  if (id) li.dataset.tocKey = id;
  return { li, link };
}

// Hide every row under a folded ancestor, and say on each branch which way it is
// set. Returns nothing: the caller owns what happens to the lit row afterwards,
// because "where am I now" is the one part of this control the two surfaces
// genuinely answer differently.
export function tocPaintFolding({ items, keys, parents, branches, collapsed }) {
  items.forEach((li, index) => {
    if (!li) return;
    li.hidden = tocRowIsHidden(parents, keys, collapsed, index);
    if (!branches[index]) return;
    const folded = collapsed.has(keys[index]);
    li.dataset.tocCollapsed = folded ? "true" : "false";
    const twisty = li.querySelector(`.${TOC_TWISTY_CLASS}`);
    if (!twisty) return;
    twisty.setAttribute("aria-expanded", folded ? "false" : "true");
    twisty.setAttribute("aria-label", `${folded ? "Expand" : "Collapse"} ${twisty.dataset.tocLabel || "section"}`);
  });
}

// The ⊞ / ⊟ in a drawer's head. Hidden outright when the list has no branch in
// it, because "collapse all" on a flat list is a control that cannot do
// anything.
export function tocPaintFoldAll(button, { anyBranch, allCollapsed }) {
  if (!button) return;
  button.hidden = !anyBranch;
  if (!anyBranch) return;
  button.textContent = allCollapsed ? "⊞" : "⊟";
  button.title = allCollapsed ? "Expand all sections" : "Collapse all sections";
  button.setAttribute("aria-label", button.title);
}
