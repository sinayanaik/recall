// Making a markdown table fit its column without a horizontal scrollbar, by
// shrinking the font until it does — measured, then batched, because each
// measurement forces layout.

import { deferrableRenderRoot, runNearViewportAndDefer, scopedQueryAll } from "./deferred-work.js?v=__BUILD__";
import { styleMobileMedia } from "../ui/style-tokens.js?v=__BUILD__";

export function markdownTableColumnCount(table) {
  return Array.from(table.rows).reduce((max, row) => {
    const count = Array.from(row.cells).reduce((sum, cell) => sum + Math.max(1, cell.colSpan || 1), 0);
    return Math.max(max, count);
  }, 0);
}

export function tableCellWeight(cell) {
  const text = String(cell.textContent || "").replace(/\s+/g, " ").trim();
  const longestWord = text.split(/\s+/).reduce((max, word) => Math.max(max, word.length), 0);
  return Math.max(4, Math.min(80, text.length * 0.58 + longestWord * 0.9));
}

export function applyMarkdownTableColumns(table) {
  const columnCount = markdownTableColumnCount(table);
  if (!columnCount) return;
  table.style.setProperty("--markdown-table-columns", String(columnCount));

  const weights = Array(columnCount).fill(4);
  Array.from(table.rows).forEach((row) => {
    let columnIndex = 0;
    Array.from(row.cells).forEach((cell) => {
      const span = Math.max(1, cell.colSpan || 1);
      const weight = tableCellWeight(cell) / span;
      for (let offset = 0; offset < span && columnIndex + offset < weights.length; offset += 1) {
        weights[columnIndex + offset] = Math.max(weights[columnIndex + offset], weight);
      }
      columnIndex += span;
    });
  });

  table.querySelector(":scope > colgroup")?.remove();
  const colgroup = document.createElement("colgroup");
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  weights.forEach((weight) => {
    const col = document.createElement("col");
    col.style.width = `${(weight / total) * 100}%`;
    colgroup.appendChild(col);
  });
  table.insertBefore(colgroup, table.firstChild);
}

export function markdownTableHeaderCells(table) {
  if (table.tHead?.rows.length) {
    return Array.from(table.tHead.rows[table.tHead.rows.length - 1].cells);
  }

  return Array.from(table.rows)
    .find((row) => Array.from(row.cells).some((cell) => cell.tagName === "TH"))
    ?.cells || [];
}

export function markdownTableHeaders(table) {
  const labels = [];
  Array.from(markdownTableHeaderCells(table)).forEach((cell) => {
    const label = String(cell.textContent || "").replace(/\s+/g, " ").trim();
    const span = Math.max(1, cell.colSpan || 1);
    for (let index = 0; index < span; index += 1) {
      labels.push(label || `Column ${labels.length + 1}`);
    }
  });
  return labels;
}

export function applyMarkdownTableLabels(table) {
  const labels = markdownTableHeaders(table);
  const columnCount = markdownTableColumnCount(table);
  while (labels.length < columnCount) {
    labels.push(`Column ${labels.length + 1}`);
  }
  if (!labels.length) return;

  const headerCells = new Set(Array.from(markdownTableHeaderCells(table)));
  Array.from(table.rows).forEach((row) => {
    let columnIndex = 0;
    Array.from(row.cells).forEach((cell) => {
      const span = Math.max(1, cell.colSpan || 1);
      if (!headerCells.has(cell)) {
        cell.dataset.label = labels[columnIndex] || `Column ${columnIndex + 1}`;
      }
      columnIndex += span;
    });
  });
}

export function wrapMarkdownTable(table) {
  if (table.parentElement?.classList.contains("markdown-table-wrap")) return table.parentElement;
  const wrapper = document.createElement("div");
  wrapper.className = "markdown-table-wrap";
  table.parentNode.insertBefore(wrapper, table);
  wrapper.appendChild(table);
  return wrapper;
}

export function markdownTableFits(table, wrapper) {
  const allowance = 1;
  if (table.scrollWidth > wrapper.clientWidth + allowance) return false;
  return Array.from(table.cells || table.querySelectorAll("th, td"))
    .every((cell) => cell.scrollWidth <= cell.clientWidth + allowance);
}

// Shrink-to-fit for one table: a binary search over font sizes, each step
// reading layout back. That's up to ten forced layouts of the whole document per
// table, which is why it's deferred until the table is nearly on screen (see
// runNearViewportAndDefer) — a note with 130 tables spent 1.6s of its render
// here, all of it on tables nobody was looking at.
export function fitMarkdownTableFont(table) {
  const wrapper = table.parentElement;
  if (!wrapper?.classList.contains("markdown-table-wrap") || !wrapper.clientWidth) return;

  if (!table.dataset.baseFontSize) {
    table.dataset.baseFontSize = String(parseFloat(getComputedStyle(table).fontSize) || 16);
  }

  const baseFontSize = parseFloat(table.dataset.baseFontSize) || 16;
  const minimumFontSize = 7;
  table.style.fontSize = `${baseFontSize}px`;

  if (styleMobileMedia?.matches) return;

  if (markdownTableFits(table, wrapper)) return;

  let low = minimumFontSize;
  let high = baseFontSize;
  let best = low;

  for (let index = 0; index < 10; index += 1) {
    const mid = (low + high) / 2;
    table.style.fontSize = `${mid}px`;
    if (markdownTableFits(table, wrapper)) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }

  table.style.fontSize = `${Math.max(minimumFontSize, best - 0.25)}px`;
}

export function fitMarkdownTableBatch(tables) {
  tables.forEach(fitMarkdownTableFont);
}

export function fitMarkdownTables(container, roots = null) {
  const tables = scopedQueryAll(roots || container, "table").filter((table) => {
    // Genuine markdown tables always live inside a `.rendered` block. Skip
    // anything else (e.g. the structural <table> the Cornell HTML/Word
    // export uses for its question/answer columns) so this auto-fit pass
    // doesn't reflow layout tables it was never meant to touch.
    if (table.closest("pre") || !table.closest(".rendered")) return false;
    // Cheap, layout-free preparation stays eager: the mobile per-cell labels and
    // the column sizing are pure DOM writes, and a table scrolled past before
    // its fit runs must still be structurally correct.
    wrapMarkdownTable(table);
    applyMarkdownTableLabels(table);
    applyMarkdownTableColumns(table);
    return true;
  });

  runNearViewportAndDefer(tables, deferrableRenderRoot(container), fitMarkdownTableBatch);
}

// Debounced, not just rAF-coalesced. Callers include the style panel's `input`
// handler, which fires continuously while a slider is dragged — and each run
// re-queries every `.rendered` surface and re-fits every table in it, where
// fitMarkdownTableFont is a ~10-step binary search that reads scrollWidth on
// the table and every cell (a forced layout per step). Once per frame of a drag
// is far too often for work whose result only matters once the drag stops.
export const MARKDOWN_TABLE_FIT_DEBOUNCE_MS = 120;

export let markdownTableFitTimer = 0;

export function scheduleMarkdownTableFit() {
  cancelAnimationFrame(markdownTableFitFrame);
  if (markdownTableFitTimer) clearTimeout(markdownTableFitTimer);
  markdownTableFitTimer = setTimeout(() => {
    markdownTableFitTimer = 0;
    markdownTableFitFrame = requestAnimationFrame(() => {
      document.querySelectorAll(".rendered").forEach((node) => fitMarkdownTables(node));
    });
  }, MARKDOWN_TABLE_FIT_DEBOUNCE_MS);
}

export let markdownTableFitFrame = 0;
