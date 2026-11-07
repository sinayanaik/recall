// Markdown → PDF: finding a highlight's words again on remade pages.
//
// Editing the markdown of a PDF made from it remakes its pages, and the words a
// highlight was on have moved — down a line, onto the next page — or gone. A
// highlight is stored as quads on a page (PDF user space) AND as its words
// (`text`), so the words are looked for in the new pages and the quads made
// again where they are now.
//
// The writer (md-pdf/writer.js) returns every text operator it drew
// ({ text, x, y, size, face } per page); with the same measure the layout used,
// each character's x is known exactly, so the new quads are where the glyphs
// are — no text layer, no rendering. Pure.

const SOFT_HYPHEN = /­/g;

function normalize(text) {
  return String(text || "").replace(SOFT_HYPHEN, "").replace(/\s+/g, " ").trim();
}

// The pages' text as one string, with a map from each character back to the
// run (and the character within it) that drew it.
export function textCorpus(pages) {
  let corpus = "";
  const map = [];
  let lastChar = " ";
  const push = (ch, ref) => {
    if (/\s/.test(ch)) {
      if (lastChar === " ") return;
      corpus += " ";
      map.push(null);
      lastChar = " ";
      return;
    }
    corpus += ch;
    map.push(ref);
    lastChar = ch;
  };
  pages.forEach((runs, page) => {
    let previous = null;
    runs.forEach((run, r) => {
      if (previous) {
        const sameLine = Math.abs(previous.y - run.y) < Math.max(1, run.size * 0.3);
        if (!sameLine) push(" ", null);
      }
      // By UTF-16 index, as String.slice measures a prefix.
      for (let i = 0; i < run.text.length; i += 1) {
        const code = run.text.charCodeAt(i);
        if (code >= 0xdc00 && code <= 0xdfff) continue; // low surrogate: its pair already mapped
        const ch = String.fromCodePoint(run.text.codePointAt(i));
        if (ch === "­") continue;
        push(ch, { page, r, i, len: ch.length });
      }
      previous = run;
    });
    push(" ", null);
  });
  return { corpus, map };
}

// Where `text` is drawn on `pages` (per page, writer textRuns): quads
// [{ page, rect: [x0, y0, x1, y1] }] with `page` an index into `pages`, or null.
// `near` (a page index) prefers the occurrence closest to where it was.
export function locateText(pages, text, measure, { near = 0, corpus = null } = {}) {
  const needle = normalize(text);
  if (!needle) return null;
  const built = corpus || textCorpus(pages);
  const hay = built.corpus;
  const hits = [];
  for (let at = hay.indexOf(needle); at !== -1 && hits.length < 50; at = hay.indexOf(needle, at + 1)) hits.push(at);
  if (!hits.length) {
    const lower = hay.toLowerCase();
    const low = needle.toLowerCase();
    for (let at = lower.indexOf(low); at !== -1 && hits.length < 50; at = lower.indexOf(low, at + 1)) hits.push(at);
  }
  if (!hits.length) return null;
  const pageOf = (at) => built.map.slice(at).find(Boolean)?.page ?? 0;
  hits.sort((a, b) => Math.abs(pageOf(a) - near) - Math.abs(pageOf(b) - near));
  const start = hits[0];
  // The characters matched, grouped by run.
  const groups = [];
  for (let k = start; k < start + needle.length; k += 1) {
    const ref = built.map[k];
    if (!ref) continue;
    const last = groups[groups.length - 1];
    if (last && last.page === ref.page && last.r === ref.r) last.to = ref.i + ref.len;
    else groups.push({ page: ref.page, r: ref.r, from: ref.i, to: ref.i + ref.len });
  }
  const quads = [];
  for (const g of groups) {
    const run = pages[g.page][g.r];
    const x0 = run.x + measure(run.text.slice(0, g.from), run.face, run.size);
    const x1 = run.x + measure(run.text.slice(0, g.to), run.face, run.size);
    const rect = [x0, run.y - run.size * 0.24, x1, run.y + run.size * 0.86];
    const last = quads[quads.length - 1];
    // One quad per line: runs of one line (a bold word in a sentence) join.
    if (last && last.page === g.page && Math.abs(last.rect[1] - rect[1]) < run.size * 0.3 && rect[0] - last.rect[2] < run.size * 0.6) {
      last.rect = [Math.min(last.rect[0], rect[0]), Math.min(last.rect[1], rect[1]), Math.max(last.rect[2], rect[2]), Math.max(last.rect[3], rect[3])];
    } else {
      quads.push({ page: g.page, rect });
    }
  }
  return quads.length ? quads.map((q) => ({ page: q.page, rect: q.rect.map((v) => Math.round(v * 100) / 100) })) : null;
}
