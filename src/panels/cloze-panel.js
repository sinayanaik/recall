// Finding every cloze in the deck, with enough surrounding text to recognise
// it out of context.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { commitNotesEditIfActive, renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

export const CLOZE_SCAN_RE = /\{\{([\s\S]+?)\}\}/g;

// A lone table row / heading / list item isn't valid standalone markdown, so
// normalise it to readable inline text before rendering the context snippet.
export function clozeCleanUnit(unit) {
  let s = String(unit).trim();
  if (s.includes("|") && /\|/.test(s.replace(/^\||\|$/g, ""))) {
    s = s
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
      .join(" · ");
  }
  return s
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

// Table delimiter rows (|---|---|) are dropped so a cloze inside a table gets
// the header row as its "before" context instead of a row of dashes.
export const CLOZE_TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

export const CLOZE_UNIT_SPLIT_RE = /(?<=[.!?])\s+|\n+/g;

export const CLOZE_MASK_CHAR = "";

// A copy of `source` the SAME LENGTH, with every cloze's hidden text blanked
// out. Equal length is the point: unit boundaries found in here are offsets
// into the original, so units can be described as spans instead of rebuilt as
// strings. Blanking also stops a cloze's own punctuation ("{{Rome. Then
// Ravenna}}") from splitting the sentence it is buried in, which is right on
// its own terms: a cloze is one opaque blank, not a sentence boundary.
export function clozeMaskSource(source) {
  const scan = new RegExp(CLOZE_SCAN_RE.source, "g");
  let masked = "";
  let at = 0;
  let m;
  while ((m = scan.exec(source))) {
    const innerLength = m[0].length - 4; // minus the "{{" and "}}"
    masked += source.slice(at, m.index + 2) + CLOZE_MASK_CHAR.repeat(innerLength);
    at = m.index + m[0].length - 2;
  }
  return masked + source.slice(at);
}

// -- Why the unit list is built once per source -----------------------------
// This used to be done per cloze, inside clozeContextParts: rebuild the whole
// document with this one cloze replaced by a marker, split it into lines,
// filter every line, join it back, split THAT into sentence units, then scan
// the units for the marker. Roughly five full copies of the note plus two big
// arrays, once per {{...}} -- O(clozes x note). Opening the cloze panel on a
// long note was not merely slow, it was fatal: measured 161ms at 100KB,
// 2,270ms at 400KB, and at 1MB it exhausted a 4GB heap outright.
//
// The same information, computed once: split the masked source into units and
// remember each one's span. Locating any cloze is then a binary search.
export function clozeUnitIndex(source) {
  const masked = clozeMaskSource(source);
  CLOZE_UNIT_SPLIT_RE.lastIndex = 0;
  const bounds = [];
  let from = 0;
  let m;
  while ((m = CLOZE_UNIT_SPLIT_RE.exec(masked))) {
    bounds.push([from, m.index]);
    from = m.index + m[0].length;
  }
  bounds.push([from, masked.length]);

  const units = [];
  for (const [rawStart, rawEnd] of bounds) {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/.test(source[start])) start += 1;
    while (end > start && /\s/.test(source[end - 1])) end -= 1;
    if (start >= end) continue;
    const text = source.slice(start, end);
    if (CLOZE_TABLE_DELIMITER_RE.test(text)) continue;
    units.push({ start, end, text });
  }
  return units;
}

// The index of the unit containing `offset`, or -1.
export function clozeUnitAt(units, offset) {
  let low = 0;
  let high = units.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (units[mid].end <= offset) low = mid + 1;
    else if (units[mid].start > offset) high = mid - 1;
    else return mid;
  }
  return -1;
}

// Build {prev, cur, next} context around one cloze occurrence. `cur` keeps the
// {{...}} braces so it renders as a live redaction span; neighbours are plain.
export function clozeContextParts(units, source, start, end) {
  const index = clozeUnitAt(units, start);
  if (index === -1) {
    // No unit covers this offset (a dropped delimiter row, or pure whitespace)
    // -- show the cloze on its own rather than losing the row entirely.
    return { prev: "", cur: clozeCleanUnit(source.slice(start, end)), next: "" };
  }
  return {
    prev: index > 0 ? clozeCleanUnit(units[index - 1].text) : "",
    cur: clozeCleanUnit(units[index].text),
    next: index < units.length - 1 ? clozeCleanUnit(units[index + 1].text) : "",
  };
}

// Gather clozes from every source in the deck, grouped by where they live.
export function collectDeckClozes() {
  const groups = [];
  const pushGroup = (label, source) => {
    if (!source || source.indexOf("{{") === -1) return;
    const items = [];
    // A sentence with several clozes yields the SAME context snippet for each
    // (every blank in that sentence is already shown), so collapse duplicates:
    // list each sentence once instead of once per cloze. Keyed on the unit
    // itself rather than on the assembled text, so a sentence with twenty
    // blanks costs one row's work instead of twenty.
    const seen = new Set();
    const units = clozeUnitIndex(source);
    CLOZE_SCAN_RE.lastIndex = 0;
    let m;
    while ((m = CLOZE_SCAN_RE.exec(source))) {
      const unitIndex = clozeUnitAt(units, m.index);
      const key = unitIndex === -1 ? "@" + m.index : "u" + unitIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(clozeContextParts(units, source, m.index, m.index + m[0].length));
    }
    if (items.length) groups.push({ label, items });
  };
  pushGroup("Study Notes", state.notes || "");
  (state.masterCards || []).forEach((card, i) => {
    pushGroup(`Card ${i + 1} · Question`, card.question || "");
    pushGroup(`Card ${i + 1} · Answer`, card.answer || "");
  });
  return groups;
}

// Split a markdown table row into trimmed cell strings (drops the outer pipes).
export function clozeSplitTableRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

// Find GitHub-style tables in the notes source: a header row, a |---|---| delim
// row, then consecutive pipe rows. Returns header labels + data-row line indices.
export function parseNotesTables(source) {
  const lines = String(source).split("\n");
  const tables = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|")) continue;
    const delim = lines[i + 1];
    if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(delim)) continue;
    const headers = clozeSplitTableRow(lines[i]);
    const rowLines = [];
    let j = i + 2;
    while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
      rowLines.push(j);
      j++;
    }
    tables.push({ headers, rowLines });
    i = j - 1;
  }
  return tables;
}

// Wrap every data cell in one column of one notes table as its own {{cloze}}.
export function clozeNotesTableColumn(tableIndex, colIndex) {
  const lines = (state.notes || "").split("\n");
  const table = parseNotesTables(state.notes || "")[tableIndex];
  if (!table) return;
  let changed = 0;
  table.rowLines.forEach((lineNo) => {
    const cells = clozeSplitTableRow(lines[lineNo]);
    if (colIndex >= cells.length) return;
    const bare = cells[colIndex].trim();
    if (!bare || /^\{\{[\s\S]*\}\}$/.test(bare)) return; // empty or already clozed
    cells[colIndex] = "{{" + bare + "}}";
    lines[lineNo] = "| " + cells.join(" | ") + " |";
    changed++;
  });
  if (!changed) {
    showToast("Those cells are already clozed", "info");
    return;
  }
  state.notes = lines.join("\n");
  if (el.notesEdit) el.notesEdit.value = state.notes;
  scheduleDeckAutosave();
  renderNotesViewPinned();
  showToast(`Clozed ${changed} cell${changed === 1 ? "" : "s"}`);
  renderClozePanel();
}

export function clozeContextNode(markdown, isSide) {
  const node = document.createElement("div");
  node.className = "cloze-ctx" + (isSide ? " is-side" : "");
  node.innerHTML = markdownToSafeHtml(markdown);
  return node;
}

export function renderClozePanel() {
  const body = el.clozeReviewBody;
  if (!body) return;
  body.innerHTML = "";
  const groups = collectDeckClozes();
  const tables = parseNotesTables(state.notes || "");
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  if (el.clozeReviewSummary) {
    el.clozeReviewSummary.textContent =
      total === 0 ? "No clozes yet" : `${total} cloze${total === 1 ? "" : "s"} across this deck`;
  }

  if (tables.length) {
    const sec = document.createElement("section");
    sec.className = "cloze-tables";
    const h = document.createElement("h2");
    h.textContent = "Quick-cloze a notes table column";
    sec.appendChild(h);
    tables.forEach((table, ti) => {
      const row = document.createElement("div");
      row.className = "cloze-table-row";
      const name = document.createElement("span");
      name.className = "cloze-table-name";
      name.textContent = table.headers.filter(Boolean).slice(0, 3).join(" · ") || `Table ${ti + 1}`;
      const select = document.createElement("select");
      table.headers.forEach((hd, ci) => {
        const opt = document.createElement("option");
        opt.value = String(ci);
        opt.textContent = hd || `Column ${ci + 1}`;
        select.appendChild(opt);
      });
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cloze-table-cloze-btn";
      btn.textContent = "Cloze column";
      btn.addEventListener("click", () => clozeNotesTableColumn(ti, Number(select.value)));
      row.append(name, select, btn);
      sec.appendChild(row);
    });
    body.appendChild(sec);
  }

  if (total === 0 && !tables.length) {
    const p = document.createElement("p");
    p.className = "cloze-empty";
    p.textContent =
      "No fill-in-the-blank clozes in this deck yet. Select text in your notes or a card and press […] to hide it as a cloze.";
    body.appendChild(p);
    resetClozePanelBulk();
    return;
  }

  groups.forEach((group) => {
    const sec = document.createElement("section");
    sec.className = "cloze-group";
    const h = document.createElement("h2");
    h.textContent = `${group.label} — ${group.items.length}`;
    sec.appendChild(h);
    group.items.forEach((it) => {
      const item = document.createElement("div");
      item.className = "cloze-item";
      if (it.prev) item.appendChild(clozeContextNode(it.prev, true));
      item.appendChild(clozeContextNode(it.cur, false));
      if (it.next) item.appendChild(clozeContextNode(it.next, true));
      sec.appendChild(item);
    });
    body.appendChild(sec);
  });

  resetClozePanelBulk();
}

// The bulk button is a plain toggle (its own aria-pressed is the source of
// truth), separate from the per-view "flip all clozes" header buttons.
export function resetClozePanelBulk() {
  if (!el.clozeBulkBtn) return;
  el.clozeBulkBtn.setAttribute("aria-pressed", "false");
  el.clozeBulkBtn.textContent = "[A] Reveal all";
}

export function toggleClozePanelAll() {
  if (!el.clozeBulkBtn || !el.clozeReviewBody) return;
  const reveal = el.clozeBulkBtn.getAttribute("aria-pressed") !== "true";
  el.clozeReviewBody.querySelectorAll(".cloze").forEach((c) => c.classList.toggle("is-revealed", reveal));
  el.clozeBulkBtn.setAttribute("aria-pressed", reveal ? "true" : "false");
  el.clozeBulkBtn.textContent = reveal ? "[_] Hide all" : "[A] Reveal all";
}

export function openClozePanel() {
  if (!el.clozePanel) return;
  commitNotesEditIfActive();
  lockPageScroll();
  renderClozePanel();
  el.clozePanel.hidden = false;
}

export function closeClozePanel() {
  if (!el.clozePanel || el.clozePanel.hidden) return;
  el.clozePanel.hidden = true;
  unlockPageScroll();
}
