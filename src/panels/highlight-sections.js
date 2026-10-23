// Which sections the highlight lists are showing — all of them, or the ones
// the reader picked.
//
// ── The ask ─────────────────────────────────────────────────────────────────
//
// "There should be an option to see all highlights from all sections or
// specific sections." A long note or a book carries hundreds of highlights, and
// the lists that show them (the side-by-side pane, the contents drawer's
// Highlights, the export) only ever offered all of them at once.
//
// ── What a section is ───────────────────────────────────────────────────────
//
//   In Notes   a heading, and everything under it down to the next heading at
//              its own level or above — so picking "2 Methods" brings 2.1 and
//              2.2.3 with it. Numbered the way the note view numbers it
//              (sectionHeadingIndexFor in src/notes/chapters.js).
//   In a PDF   an entry in the PDF's own contents (documentOutlineEntries, the
//              list "In this document" shows), reaching from its page to the
//              next entry's. A PDF with no contents — and every Canvas — falls
//              back to pages.
//
// A highlight that comes before the first heading (or the first contents
// entry) is in a section of its own, "Before the first heading", so it can be
// picked like any other rather than dropping out the moment anything is picked.
//
// ── One choice, shared ──────────────────────────────────────────────────────
//
// The pane and the drawer beside the same surface show the same choice: they
// list the same highlights, and two lists that disagree about which ones are in
// play make "the next highlight" mean two different things. The choice goes
// back to All when the pane closes or another file (or another of its PDFs)
// opens — it is made for a task, the way the split itself is. The export dialog
// starts from it and keeps its own copy, so trying an export of one chapter
// does not narrow the pane behind the dialog.

import { state } from "../core/state.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { sectionHeadingIndexFor, sectionIndexForOffset } from "../notes/chapters.js?v=__BUILD__";
import { headingParentsForLevels } from "../notes/heading-numbers.js?v=__BUILD__";
import { documentOutlineEntries } from "../documents/pdf-outline.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, activeDocSlot } from "../documents/doc-slot.js?v=__BUILD__";
import { activePdfId } from "../documents/pdf-multi.js?v=__BUILD__";

export const SECTION_BEFORE_KEY = "__before";

export const SECTION_SURFACES = ["notes", "document"];

// ── The sections of each surface ────────────────────────────────────────────

// Depth from the parent chain, so the picker can indent a row without knowing
// how the parents were found.
function withSectionDepths(sections) {
  sections.forEach((section) => {
    section.depth = section.parentIndex >= 0 ? sections[section.parentIndex].depth + 1 : 0;
  });
  return sections;
}

function beforeFirstSection(title) {
  return { key: SECTION_BEFORE_KEY, title, number: "", parentIndex: -1, parentKey: "", depth: 0 };
}

// The note's sections, in reading order, with the lookup a highlight's offset
// is placed by. `source` is the string highlights are scanned from —
// readerNotesBody(state.notes), the same one every collector scans.
export function noteSectionModel(source = readerNotesBody(state.notes || "")) {
  const headings = sectionHeadingIndexFor(source);
  const sections = withSectionDepths(headings.map((heading) => ({
    key: heading.key,
    title: heading.title,
    number: heading.number,
    parentIndex: heading.parent,
    parentKey: heading.parent >= 0 ? headings[heading.parent].key : ""
  })));
  return {
    surface: "notes",
    before: beforeFirstSection("Before the first heading"),
    sections,
    // A <mark> is placed by its offset; a PDF record, below, by its page.
    keyForOffset(offset) {
      const at = sectionIndexForOffset(headings, offset);
      return at >= 0 ? headings[at].key : SECTION_BEFORE_KEY;
    },
    headingAt(offset) {
      const at = sectionIndexForOffset(headings, offset);
      return at >= 0 ? headings[at] : null;
    }
  };
}

// The open PDF's sections: its own contents when it has one, pages when not.
//
// `pages` is the pages that carry highlights, for the fallback — a contents of
// every page of a 400-page book would be a list of 400 checkboxes, most of them
// for nothing.
export function documentSectionModel(pages = []) {
  const outline = documentOutlineEntries().filter((entry) => entry.title && entry.page > 0 && !entry.dead);
  if (!outline.length) {
    const sorted = Array.from(new Set(pages.filter((page) => page > 0))).sort((a, b) => a - b);
    const sections = sorted.map((page) => ({ key: `page:${page}`, title: `Page ${page}`, number: "", parentIndex: -1, parentKey: "", depth: 0 }));
    return {
      surface: "document",
      byPage: true,
      before: beforeFirstSection("No page"),
      sections,
      keyForPage(page) {
        return page > 0 ? `page:${page}` : SECTION_BEFORE_KEY;
      }
    };
  }
  // The tree is the contents' own: parents by depth, in the contents' order.
  const parents = headingParentsForLevels(outline.map((entry) => (entry.depth || 0) + 1));
  const seen = new Map();
  const sections = withSectionDepths(outline.map((entry, i) => {
    const base = `${entry.depth || 0}:${entry.title}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { key: n === 1 ? base : `${base}#${n}`, title: entry.title, number: "", page: entry.page, parentIndex: parents[i] };
  }));
  sections.forEach((section) => {
    section.parentKey = section.parentIndex >= 0 ? sections[section.parentIndex].key : "";
  });
  // Which entry a page belongs to: the last one, in PAGE order, that starts on
  // or before it. A contents is not always in page order (an appendix listed
  // first, a reader's own rearrangement), so it is sorted for the lookup and
  // left as it is for the picker, which should read like the contents does.
  const byPage = sections.map((section, i) => ({ page: section.page, i })).sort((a, b) => a.page - b.page || a.i - b.i);
  return {
    surface: "document",
    byPage: false,
    before: beforeFirstSection("Before the first section"),
    sections,
    keyForPage(page) {
      let lo = 0;
      let hi = byPage.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (byPage[mid].page <= page) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best >= 0 ? sections[byPage[best].i].key : SECTION_BEFORE_KEY;
    }
  };
}

export function sectionModelFor(surface, entries = []) {
  if (surface === "document") return documentSectionModel(entries.map((entry) => entry.page || entry.anchor?.page || 0));
  return noteSectionModel();
}

// ── The shared choice ───────────────────────────────────────────────────────
//
// null is All. A Set holds section keys; a highlight is in when its own
// section or any section it sits inside is in the set.
const sectionChoice = { notes: null, document: null };

// What each choice was made ON. A choice read against a different file (or a
// different PDF of the same file) is All — which is the whole of "it resets when
// another file opens", without a hook on every path that opens one.
const sectionChoiceScope = { notes: "", document: "" };

function sectionScopeFor(surface) {
  const deck = state.deckId || state.deckTitle || "";
  if (surface !== "document") return `n|${deck}`;
  return `d|${deck}|${activeDocSlot()}|${activePdfId(state.meta) || ""}`;
}

const sectionListeners = new Set();

export function onSectionsChanged(fn) {
  if (typeof fn === "function") sectionListeners.add(fn);
  return () => sectionListeners.delete(fn);
}

function notifySectionListeners(surface) {
  sectionListeners.forEach((fn) => {
    try { fn(surface); } catch (error) { console.error("Section listener failed", error); }
  });
}

export function selectedSections(surface) {
  const key = surface === "document" ? "document" : "notes";
  if (sectionChoiceScope[key] !== sectionScopeFor(key)) {
    sectionChoice[key] = null;
    sectionChoiceScope[key] = sectionScopeFor(key);
  }
  return sectionChoice[key];
}

export function setSelectedSections(surface, keys) {
  const key = surface === "document" ? "document" : "notes";
  const next = keys && [...keys].length ? new Set(keys) : null;
  const before = selectedSections(key);
  sectionChoice[key] = next;
  sectionChoiceScope[key] = sectionScopeFor(key);
  if (!sameSectionChoice(before, next)) notifySectionListeners(key);
}

export function resetSelectedSections(surface = null) {
  (surface ? [surface] : SECTION_SURFACES).forEach((one) => setSelectedSections(one, null));
}

export function isSectionFilterActive(surface) {
  return Boolean(selectedSections(surface));
}

function sameSectionChoice(a, b) {
  if (!a || !b) return a === b;
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

// ── Filtering ───────────────────────────────────────────────────────────────

function sectionParentKeys(model) {
  const map = new Map();
  model.sections.forEach((section) => map.set(section.key, section.parentKey || ""));
  return map;
}

// Is `key`, or a section it is inside, in `chosenKeys`?
function sectionCoveredBy(chosenKeys, parents, key) {
  let at = key;
  let guard = 0;
  while (at && guard++ < 64) {
    if (chosenKeys.has(at)) return true;
    at = parents.get(at) || "";
  }
  return false;
}

// A predicate over entries carrying `section`. With no choice made it keeps
// everything and costs nothing.
export function sectionFilterFor(model, chosenKeys) {
  if (!chosenKeys) return () => true;
  const parents = sectionParentKeys(model);
  return (entry) => sectionCoveredBy(chosenKeys, parents, entry?.section || SECTION_BEFORE_KEY);
}

// The shared choice applied to one surface's entries.
export function filterBySections(surface, entries, model = sectionModelFor(surface, entries)) {
  const keys = selectedSections(surface);
  if (!keys) return entries;
  return entries.filter(sectionFilterFor(model, keys));
}

// How many entries each section holds, counting its subsections — what the
// picker prints beside each row.
export function sectionCounts(model, entries) {
  const parents = sectionParentKeys(model);
  const counts = new Map();
  entries.forEach((entry) => {
    let at = entry?.section || SECTION_BEFORE_KEY;
    let guard = 0;
    while (at && guard++ < 64) {
      counts.set(at, (counts.get(at) || 0) + 1);
      at = parents.get(at) || "";
    }
  });
  return counts;
}

// ── The picker ──────────────────────────────────────────────────────────────
//
// A button that says what is showing ("All sections", "1.2 Methods",
// "3 sections"), and a checklist shaped like the contents under it. Ticking a
// section ticks what is inside it too — shown ticked and greyed, since it is
// already covered — and ticking nothing at all is All.
//
// Two shapes: "popover" for the pane head and the drawer, where there is no
// room to leave a tree open, and "inline" for the export dialog, which is a form
// and has the room.

export const SECTION_PICKER_CLASS = "section-picker";

function sectionRowLabel(section) {
  // The number is drawn by the stylesheet (.hl-section-number), so the label
  // follows the Number headings setting without being rebuilt.
  return section.title;
}

function sectionSummaryFor(model, keys) {
  if (!keys) return "All sections";
  const known = [...keys];
  if (known.length === 1) {
    const section = known[0] === SECTION_BEFORE_KEY ? model.before : model.sections.find((one) => one.key === known[0]);
    if (section) return section;
  }
  return known.length === 1 ? "1 section" : `${known.length} sections`;
}

function paintSectionSummary(button, model, keys) {
  const summary = sectionSummaryFor(model, keys);
  const label = button.querySelector(".section-picker-label");
  label.textContent = "";
  if (typeof summary === "string") {
    label.textContent = summary;
  } else {
    if (summary.number) {
      const number = document.createElement("span");
      number.className = "hl-section-number";
      number.dataset.headingNumber = summary.number;
      label.appendChild(number);
    }
    label.append(sectionRowLabel(summary));
  }
  button.classList.toggle("is-filtered", Boolean(keys));
  button.title = keys ? "Showing the highlights in the sections you picked" : "Pick the sections whose highlights are shown";
}

// One checklist: an "All sections" row, then a row per section. `read` and
// `write` are the choice it edits — the shared one, or the export's own copy.
function buildSectionChecklist(list, { model, counts, read, write, heading = "" }) {
  const keys = read();
  const parents = sectionParentKeys(model);
  const rows = [];
  if (model.sections.length || (counts.get(SECTION_BEFORE_KEY) || 0) > 0) {
    if (heading) {
      const head = document.createElement("li");
      head.className = "section-picker-group";
      head.textContent = heading;
      list.appendChild(head);
    }
  }

  const all = sectionRowFor({ label: "All sections", count: null, depth: 0, key: "" });
  all.input.checked = !keys;
  all.li.classList.add("is-all");
  list.appendChild(all.li);

  const ordered = [];
  if ((counts.get(SECTION_BEFORE_KEY) || 0) > 0) ordered.push(model.before);
  ordered.push(...model.sections);
  ordered.forEach((section) => {
    const row = sectionRowFor({
      label: sectionRowLabel(section),
      number: section.number,
      count: counts.get(section.key) || 0,
      depth: section.depth,
      key: section.key
    });
    if (!(counts.get(section.key) || 0)) row.li.classList.add("is-empty");
    rows.push({ row, section });
    list.appendChild(row.li);
  });

  const paint = () => {
    const current = read();
    all.input.checked = !current;
    rows.forEach(({ row, section }) => {
      const own = Boolean(current?.has(section.key));
      const covered = !own && Boolean(current) && sectionCoveredBy(current, parents, section.parentKey);
      row.input.checked = own || covered;
      row.input.disabled = covered;
      row.li.classList.toggle("is-covered", covered);
    });
  };

  all.input.addEventListener("change", () => {
    // "All" can only be turned ON from here — unticking it with nothing else
    // ticked would be asking for no highlights at all.
    write(null);
    paint();
  });
  rows.forEach(({ row, section }) => {
    row.input.addEventListener("change", () => {
      const next = new Set(read() || []);
      if (row.input.checked) {
        next.add(section.key);
        // A section now covered by this one need not be listed on its own.
        rows.forEach(({ section: other }) => {
          if (other.key !== section.key && sectionCoveredBy(new Set([section.key]), parents, other.parentKey)) next.delete(other.key);
        });
      } else {
        next.delete(section.key);
      }
      write(next.size ? next : null);
      paint();
    });
  });
  paint();
  return { paint };
}

let sectionRowSerial = 0;

function sectionRowFor({ label, number = "", count, depth, key }) {
  const li = document.createElement("li");
  li.className = "section-picker-row";
  li.style.setProperty("--section-depth", String(depth));
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = `section-pick-${(sectionRowSerial += 1)}`;
  if (key) input.dataset.sectionKey = key;
  const text = document.createElement("label");
  text.className = "section-picker-text";
  text.htmlFor = input.id;
  if (number) {
    const n = document.createElement("span");
    n.className = "hl-section-number";
    n.dataset.headingNumber = number;
    text.appendChild(n);
  }
  text.append(label);
  li.append(input, text);
  if (count != null) {
    const badge = document.createElement("span");
    badge.className = "section-picker-count";
    badge.textContent = String(count);
    badge.setAttribute("aria-label", count === 1 ? "1 highlight" : `${count} highlights`);
    li.appendChild(badge);
  }
  return { li, input };
}

// The pane's and the drawer's picker. `entries()` is that list's highlights
// BEFORE any section filter — the counts are of everything, so a reader can see
// what each section holds before they pick it.
export function mountSectionPicker(host, { surface, entries }) {
  if (!host) return null;
  const surfaceOf = typeof surface === "function" ? surface : () => surface;
  const wrap = document.createElement("div");
  wrap.className = SECTION_PICKER_CLASS;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "section-picker-btn";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = '<span class="section-picker-label"></span><span class="section-picker-caret" aria-hidden="true">▾</span>';
  const pop = document.createElement("div");
  pop.className = "section-picker-pop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Show highlights from these sections");
  const list = document.createElement("ul");
  list.className = "section-picker-list";
  pop.appendChild(list);
  wrap.append(button, pop);
  host.appendChild(wrap);

  const model = () => {
    const all = entries() || [];
    return { all, model: sectionModelFor(surfaceOf(), all) };
  };

  const refresh = () => {
    const { model: m } = model();
    paintSectionSummary(button, m, selectedSections(surfaceOf()));
    // The picker is offered only when there is something to pick between.
    wrap.hidden = !m.sections.length && !selectedSections(surfaceOf());
    if (!pop.hidden) fill();
  };

  const fill = () => {
    const { all, model: m } = model();
    list.innerHTML = "";
    buildSectionChecklist(list, {
      model: m,
      counts: sectionCounts(m, all),
      read: () => selectedSections(surfaceOf()),
      write: (keys) => setSelectedSections(surfaceOf(), keys)
    });
  };

  const close = ({ focus = false } = {}) => {
    if (pop.hidden) return;
    pop.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (focus) button.focus();
  };
  const outside = (event) => {
    if (!wrap.contains(event.target)) close();
  };
  const open = () => {
    fill();
    pop.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    pop.querySelector("input:not(:disabled)")?.focus();
  };

  button.addEventListener("click", () => {
    if (pop.hidden) open();
    else close();
  });
  pop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close({ focus: true });
    }
  });
  wrap.addEventListener("focusout", (event) => {
    if (event.relatedTarget && !wrap.contains(event.relatedTarget)) close();
  });

  const unlisten = onSectionsChanged((changed) => {
    if (changed === surfaceOf()) refresh();
  });
  refresh();
  return { refresh, close, destroy: () => { unlisten(); wrap.remove(); } };
}

// The export dialog's picker: both surfaces' sections, laid out in the form,
// starting from the shared choice and editing a copy of it. `read()` hands the
// export what was picked, as { notes, document } with null for All.
export function mountExportSectionPicker(host, { entriesFor }) {
  if (!host) return null;
  host.innerHTML = "";
  const local = {
    notes: selectedSections("notes"),
    document: selectedSections("document")
  };
  const list = document.createElement("ul");
  list.className = "section-picker-list is-inline";
  const groups = [];
  SECTION_SURFACES.forEach((surface) => {
    const all = entriesFor(surface) || [];
    if (!all.length) return;
    groups.push(surface);
    const m = sectionModelFor(surface, all);
    buildSectionChecklist(list, {
      model: m,
      counts: sectionCounts(m, all),
      read: () => local[surface],
      write: (keys) => { local[surface] = keys ? new Set(keys) : null; },
      heading: surface === "notes" ? "Notes" : activeDocSlot() === DOC_SLOT_NOTEBOOK ? "Canvas" : "PDFs"
    });
  });
  // One surface needs no group headings: there is nothing to tell apart.
  if (groups.length < 2) list.querySelectorAll(".section-picker-group").forEach((node) => node.remove());
  host.appendChild(list);
  return {
    read: () => ({ notes: local.notes, document: local.document }),
    hasChoices: () => groups.length > 0
  };
}
