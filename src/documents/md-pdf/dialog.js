// Markdown → PDF: the dialog.
//
// One sheet: the markdown on the left (pasted, typed, the file's Notes, a .md
// file from the device, or the text selected in Notes), the options under it,
// and on the right the PDF as it will be — live, drawn by the same pdf.js that
// shows every PDF in this app, with the page breaks on it.
//
// ── The page breaks, by hand ───────────────────────────────────────────────
//
// The clipper extension's Smart pages editor (recall-clipper/content/
// prepare.js, editBreaks), on a PDF instead of a web page. The preview is the
// column as one continuous strip, each page shaded with its number and how full
// it is (amber when it runs over the chosen length), and every break a dashed
// line:
//   • drag a line to move it — it snaps to the nearest clean place (before a
//     heading, between paragraphs); hold Alt to put it anywhere between lines;
//   • click the page to add a break at the nearest clean place;
//   • ✕ on a line removes it; ↑ / ↓ move the last one touched, Delete removes it;
//   • Undo / Redo (Ctrl+Z, Ctrl+Shift+Z), and Auto to plan them again.
// The breaks are remembered by the paragraph under them, so the markdown can
// still be edited after they are placed, and they are kept with the PDF so
// "Edit markdown…" opens on them again.

import { ensurePdfJs, ensurePdfLib } from "../../core/lib-loader.js?v=__BUILD__";
import { state } from "../../core/state.js?v=__BUILD__";
import { notesForExport } from "../../export/notes-body.js?v=__BUILD__";
import { showToast } from "../../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../../ui/overlays.js?v=__BUILD__";
import { activeDocSlot, DOC_SLOT_DOC } from "../doc-slot.js?v=__BUILD__";
import { deckPdfById, pdfStoreKey } from "../pdf-multi.js?v=__BUILD__";
import { getDocument } from "../pdf-store.js?v=__BUILD__";
import { currentDocumentPage, openDocumentPdfId } from "../pdf-view.js?v=__BUILD__";
import { cutCandidates, nearestCandidate, previewPlan, stepCandidate } from "./breaks.js?v=__BUILD__";
import { MdPdfError, createMdPdfSession, markdownTitle } from "./build.js?v=__BUILD__";
import { MD_PDF_DEFAULTS, normalizeMdPdfOptions } from "./layout.js?v=__BUILD__";
import { pageSizeAt } from "./parts.js?v=__BUILD__";
import { openPdfParts, rebuildWholePdf, removePartFromOpenPdf, saveNewMarkdownPdf, spliceIntoOpenPdf } from "./save.js?v=__BUILD__";

const OPTIONS_KEY = "recall-md-pdf-options";
// The strip left of the preview's pages that holds their numbers, in CSS px —
// the same as .md-pdf-pages' padding-left in styles/96-md-pdf.css.
const PREVIEW_GUTTER = 40;

const CHOICES = {
  layout: [["smart", "Smart pages"], ["paper", "Paper pages"], ["long", "One long page"]],
  pageLength: [["half", "Half A4"], ["a4", "A4"], ["2a4", "2 × A4"], ["custom", "Custom"]],
  paper: [["A4", "A4"], ["Letter", "Letter"], ["Legal", "Legal"], ["A5", "A5"], ["match", "Match this PDF"]],
  columns: [["1", "One"], ["2", "Two"]],
  breakBefore: [["none", "None"], ["h1", "H1"], ["h2", "H2"], ["h3", "H3"]],
  margin: [["none", "None"], ["narrow", "Narrow"], ["normal", "Normal"], ["wide", "Wide"]],
  font: [["sans", "Sans"], ["serif", "Serif"]],
  pictures: [["original", "Original"], ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["none", "None"]]
};

const LABELS = {
  layout: "Pages",
  pageLength: "Page length",
  paper: "Page size",
  columns: "Columns",
  breakBefore: "New page before",
  margin: "Margins",
  font: "Font",
  pictures: "Pictures"
};

const HINTS = {
  smart: "Each page about the length you choose, cut before a heading or between paragraphs, and trimmed to its content — the smallest PDF.",
  paper: "Full sheets of one size, for printing.",
  long: "One page as tall as everything (a page over 200 inches is split)."
};

let mdDialog = null;
let mdSession = null;
let mdState = null;

function loadOptions() {
  try {
    return normalizeMdPdfOptions(JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}"));
  } catch {
    return normalizeMdPdfOptions({});
  }
}

function storeOptions(options) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // A private window: the defaults next time.
  }
}

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

function chipGroup(name) {
  const chips = CHOICES[name].map(([value, label]) => (
    `<button type="button" class="pdf-margins-chip" data-md-opt="${name}" data-value="${value}" aria-pressed="false">${esc(label)}</button>`
  )).join("");
  return `<div class="md-pdf-field" data-md-field="${name}"><span class="md-pdf-label">${LABELS[name]}</span><div class="md-pdf-chips" role="group" aria-label="${LABELS[name]}">${chips}</div></div>`;
}

function buildMdPdfDialog() {
  const section = document.createElement("section");
  section.className = "md-pdf-modal";
  section.id = "mdPdfModal";
  section.hidden = true;
  section.setAttribute("role", "dialog");
  section.setAttribute("aria-modal", "true");
  section.setAttribute("aria-labelledby", "mdPdfTitle");
  section.innerHTML = `
    <div class="md-pdf-sheet">
      <header class="md-pdf-head">
        <h3 class="prompt-modal-title" id="mdPdfTitle">New PDF from Markdown</h3>
        <div class="md-pdf-tabs" role="tablist" aria-label="Show">
          <button type="button" role="tab" data-md-tab="source" aria-selected="true">Markdown</button>
          <button type="button" role="tab" data-md-tab="preview" aria-selected="false">Preview</button>
        </div>
        <button type="button" class="md-pdf-close" data-md-action="cancel" aria-label="Close">✕</button>
      </header>
      <div class="md-pdf-body" data-md-show="source">
        <div class="md-pdf-source">
          <div class="md-pdf-row md-pdf-part" data-md-part-row hidden>
            <label class="md-pdf-label" for="mdPdfPart">Markdown</label>
            <select id="mdPdfPart" class="prompt-modal-input" data-md-part></select>
          </div>
          <div class="md-pdf-row">
            <button type="button" class="pdf-margins-chip" data-md-action="use-notes">Use this file's Notes</button>
            <label class="pdf-margins-chip file-pick">
              <input type="file" accept=".md,.markdown,.mdown,.txt,text/markdown,text/plain" data-md-file hidden>
              <span>Open a .md file…</span>
            </label>
          </div>
          <textarea class="md-pdf-text prompt-modal-input" data-md-text spellcheck="false" placeholder="Paste or type markdown — headings, lists, tables, code, $maths$, mermaid diagrams and pictures all work."></textarea>
          <div class="md-pdf-options">
            ${chipGroup("layout")}
            <p class="md-pdf-hint" data-md-layout-hint></p>
            <div class="md-pdf-field" data-md-field="pageLength">
              <span class="md-pdf-label">Page length</span>
              <div class="md-pdf-chips" role="group" aria-label="Page length">
                ${CHOICES.pageLength.map(([value, label]) => `<button type="button" class="pdf-margins-chip" data-md-opt="pageLength" data-value="${value}" aria-pressed="false">${label}</button>`).join("")}
                <label class="md-pdf-inline" data-md-custom-length hidden><input type="number" class="prompt-modal-input" data-md-num="customLength" min="60" max="5000" step="5" inputmode="numeric"> mm</label>
              </div>
            </div>
            ${chipGroup("paper")}
            ${chipGroup("columns")}
            ${chipGroup("breakBefore")}
            ${chipGroup("margin")}
            <div class="md-pdf-field">
              <span class="md-pdf-label">Text</span>
              <div class="md-pdf-chips">
                <label class="md-pdf-inline"><input type="number" class="prompt-modal-input" data-md-num="textSize" min="7" max="16" step="0.5" inputmode="decimal"> pt</label>
                ${CHOICES.font.map(([value, label]) => `<button type="button" class="pdf-margins-chip" data-md-opt="font" data-value="${value}" aria-pressed="false">${label}</button>`).join("")}
              </div>
            </div>
            ${chipGroup("pictures")}
            <div class="md-pdf-field md-pdf-checks">
              <label><input type="checkbox" data-md-check="bookmarks"> Bookmarks from headings</label>
              <label><input type="checkbox" data-md-check="pageNumbers"> Page numbers</label>
              <label><input type="checkbox" data-md-check="codeColours"> Code colours</label>
            </div>
          </div>
        </div>
        <div class="md-pdf-preview">
          <div class="md-pdf-preview-bar">
            <span class="md-pdf-status" data-md-status aria-live="polite"></span>
            <span class="md-pdf-bar-actions">
              <button type="button" class="pdf-margins-chip" data-md-action="undo" title="Undo (Ctrl+Z)" disabled>Undo</button>
              <button type="button" class="pdf-margins-chip" data-md-action="redo" title="Redo (Ctrl+Shift+Z)" disabled>Redo</button>
              <button type="button" class="pdf-margins-chip" data-md-action="auto" title="Plan the page breaks again">Auto</button>
            </span>
          </div>
          <p class="md-pdf-hint">Drag a page break to move it (Alt: anywhere), click the page to add one, ✕ to remove it.</p>
          <div class="md-pdf-preview-scroll" data-md-scroll tabindex="0" aria-label="Preview of the PDF; page breaks can be moved">
            <div class="md-pdf-pages" data-md-pages></div>
          </div>
        </div>
      </div>
      <footer class="md-pdf-foot">
        <label class="md-pdf-inline" data-md-name-row>Name <input type="text" class="prompt-modal-input" data-md-name maxlength="80" placeholder="Name of the PDF"></label>
        <label class="md-pdf-inline" data-md-at-row hidden>Insert before page <input type="number" class="prompt-modal-input" data-md-at min="1" step="1" inputmode="numeric"> <span data-md-at-of></span></label>
        <span class="md-pdf-meter" data-md-meter></span>
        <span class="md-pdf-foot-actions">
          <button type="button" class="sync-modal-btn is-danger" data-md-action="remove-part" hidden>Take these pages out</button>
          <button type="button" class="sync-modal-btn" data-md-action="cancel">Cancel</button>
          <button type="button" class="sync-modal-btn is-primary" data-md-action="save">Make PDF</button>
        </span>
      </footer>
    </div>`;
  document.body.appendChild(section);
  return section;
}

function mdq(selector) {
  return mdDialog.querySelector(selector);
}

// ── Options in and out of the form ─────────────────────────────────────────

function readOptions() {
  const o = { ...mdState.options };
  mdDialog.querySelectorAll("[data-md-num]").forEach((input) => {
    const value = Number(input.value);
    if (Number.isFinite(value) && input.value !== "") o[input.dataset.mdNum] = value;
  });
  mdDialog.querySelectorAll("[data-md-check]").forEach((input) => { o[input.dataset.mdCheck] = input.checked; });
  return normalizeMdPdfOptions(o);
}

function paintMdPdfOptions() {
  const o = mdState.options;
  mdDialog.querySelectorAll("[data-md-opt]").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(String(o[chip.dataset.mdOpt]) === chip.dataset.value));
  });
  mdq("[data-md-num=\"textSize\"]").value = String(o.textSize);
  mdq("[data-md-num=\"customLength\"]").value = String(o.customLength);
  mdDialog.querySelectorAll("[data-md-check]").forEach((input) => { input.checked = Boolean(o[input.dataset.mdCheck]); });
  mdq("[data-md-field=\"pageLength\"]").hidden = o.layout !== "smart";
  mdq("[data-md-custom-length]").hidden = o.pageLength !== "custom";
  mdq("[data-md-layout-hint]").textContent = HINTS[o.layout];
  // "Match this PDF" only means something when there is a PDF the pages go in.
  mdq("[data-md-opt=\"paper\"][data-value=\"match\"]").hidden = mdState.mode === "new" || mdState.wholePdf;
}

// ── The build ──────────────────────────────────────────────────────────────

function mdStatus(text, kind = "") {
  const node = mdq("[data-md-status]");
  node.textContent = text;
  node.dataset.kind = kind;
}

let relayoutTimer = 0;
let meterTimer = 0;
let buildSeq = 0;

function scheduleRelayout(delay = 350) {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayoutMdPdf, delay);
}

async function relayoutMdPdf() {
  const seq = ++buildSeq;
  const markdown = mdq("[data-md-text]").value;
  if (!markdown.trim()) {
    mdState.laid = null;
    mdState.plan = null;
    mdq("[data-md-pages]").innerHTML = "";
    mdq("[data-md-meter]").textContent = "";
    mdStatus("Paste or type some markdown to see the PDF.");
    paintSaveButton();
    return;
  }
  mdStatus("Laying out the pages…");
  try {
    const laid = await mdSession.layout(markdown, mdState.options, {
      match: mdState.match,
      onProgress: (text) => { if (seq === buildSeq) mdStatus(text); },
      isCurrent: () => seq === buildSeq
    });
    if (seq !== buildSeq) return;
    mdState.laid = laid;
    mdState.previewStale = true;
    replan();
    // The preview is a whole PDF written and parsed again: only worth it when
    // it can be seen. On a phone the Markdown tab hides it, and every
    // keystroke there would otherwise pay for a preview nobody looks at (and
    // draw it at a guessed width, wider than the screen). The Preview tab
    // draws it when it is opened.
    if (previewVisible()) await renderMdPdfPreview(seq);
    else mdStatus("");
  } catch (error) {
    if (seq !== buildSeq) return;
    mdState.laid = null;
    mdState.plan = null;
    console.warn("Markdown → PDF failed", error);
    mdStatus(error instanceof MdPdfError && error.code === "fonts"
      ? "The PDF fonts need a connection the first time. Connect once and try again."
      : `Could not lay out the PDF — ${error?.message || "unexpected error"}`, "error");
    paintSaveButton();
  }
}

function previewVisible() {
  const scroll = mdq("[data-md-scroll]");
  return Boolean(scroll && scroll.offsetParent && scroll.clientWidth > 0);
}

// The preview, drawn now if the layout has changed since it was last drawn.
async function showPreviewIfStale() {
  if (!mdState?.laid || !mdState.previewStale || !previewVisible()) return;
  const seq = buildSeq;
  try {
    await renderMdPdfPreview(seq);
  } catch (error) {
    if (seq !== buildSeq) return;
    console.warn("Markdown → PDF preview failed", error);
    mdStatus(`Could not draw the preview — ${error?.message || "unexpected error"}`, "error");
  }
}

function replan() {
  if (!mdState.laid) return;
  mdState.plan = mdSession.plan(mdState.laid, mdState.manualKeys);
  paintOverlay();
  paintSaveButton();
  paintHistoryButtons();
  scheduleMeter();
}

function scheduleMeter() {
  clearTimeout(meterTimer);
  meterTimer = setTimeout(async () => {
    if (!mdState?.laid || !mdState.plan?.pages.length) return;
    try {
      const out = await mdSession.write(mdState.laid, mdState.plan, { title: mdq("[data-md-name]").value || "" });
      const kb = Math.max(1, Math.round(out.bytes.length / 1024));
      mdq("[data-md-meter]").textContent = `${out.pageCount} page${out.pageCount === 1 ? "" : "s"} · ${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`}`;
    } catch (error) {
      mdq("[data-md-meter]").textContent = "";
    }
  }, 700);
}

// The continuous strip, drawn by pdf.js — in TILES, and only the ones near the
// screen. A long note is one page up to 200 inches tall; drawn whole at a
// phone's pixel ratio that is a canvas of a hundred megabytes, per page. So
// each page is a box of the right size holding bands of PREVIEW_TILE_PX, a band
// is drawn when it scrolls near (pdf.js renders a slice of a page through a
// transform, as the PDFs tab's own tall-page bands do) and given back when it
// is far away again.
const PREVIEW_TILE_PX = 1200;
let previewDoc = null;
let previewObserver = null;

function releasePreview() {
  previewObserver?.disconnect();
  previewObserver = null;
  if (previewDoc) previewDoc.destroy().catch?.(() => {});
  previewDoc = null;
}

async function drawTile(tile) {
  if (tile.dataset.drawn === "1" || tile.dataset.drawing === "1" || !previewDoc) return;
  tile.dataset.drawing = "1";
  const doc = previewDoc;
  try {
    const page = await doc.getPage(Number(tile.dataset.page));
    const ratio = Number(tile.dataset.ratio);
    const viewport = page.getViewport({ scale: Number(tile.dataset.scale) * ratio });
    const top = Number(tile.dataset.top);
    tile.width = Math.round(viewport.width);
    tile.height = Math.max(1, Math.round(tile.clientHeight * ratio));
    await page.render({
      canvasContext: tile.getContext("2d"),
      viewport,
      transform: [1, 0, 0, 1, 0, -top * ratio]
    }).promise;
    if (doc === previewDoc) tile.dataset.drawn = "1";
  } catch (error) {
    if (!/cancel|destroy/i.test(String(error?.message))) console.warn("Could not draw the preview", error);
  } finally {
    tile.dataset.drawing = "";
  }
}

async function renderMdPdfPreview(seq) {
  const host = mdq("[data-md-pages]");
  const scroll = mdq("[data-md-scroll]");
  const laid = mdState.laid;
  mdStatus("Drawing the preview…");
  const out = await mdSession.write(laid, null, { preview: true });
  if (seq !== buildSeq) return;
  if (!(await ensurePdfJs())) {
    mdStatus("The PDF reader did not load — reconnect once and try again.", "error");
    return;
  }
  const doc = await window.pdfjsLib.getDocument({ data: out.bytes, isEvalSupported: false, verbosity: 0 }).promise;
  if (seq !== buildSeq) {
    doc.destroy();
    return;
  }
  if (!previewVisible()) {
    // Hidden while it was being written (the Markdown tab chosen again):
    // drawn when the Preview tab is opened, at the width it has then.
    doc.destroy();
    mdStatus("");
    return;
  }
  releasePreview();
  previewDoc = doc;
  mdState.previewStale = false;
  // Less the scroll box's padding and the gutter the page numbers sit in
  // (.md-pdf-pages padding), so a label never covers the words it is about.
  const width = Math.max(160, scroll.clientWidth - 16 - PREVIEW_GUTTER);
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const pagesMeta = previewPlan(laid.flow).pages;
  const scale = width / (pagesMeta[0]?.width || 1);
  const frag = document.createDocumentFragment();
  const tiles = [];
  pagesMeta.forEach((meta, index) => {
    const pageBox = document.createElement("div");
    pageBox.className = "md-pdf-page";
    const cssW = Math.round(meta.width * scale);
    const cssH = Math.round(meta.height * scale);
    pageBox.style.width = `${cssW}px`;
    pageBox.style.height = `${cssH}px`;
    for (let top = 0; top < cssH; top += PREVIEW_TILE_PX) {
      const tile = document.createElement("canvas");
      tile.className = "md-pdf-canvas";
      tile.style.top = `${top}px`;
      tile.style.width = `${cssW}px`;
      tile.style.height = `${Math.min(PREVIEW_TILE_PX, cssH - top)}px`;
      Object.assign(tile.dataset, { page: String(index + 1), top: String(top), scale: String(scale), ratio: String(ratio) });
      pageBox.appendChild(tile);
      tiles.push(tile);
    }
    frag.appendChild(pageBox);
  });
  const keep = scroll.scrollTop;
  host.innerHTML = "";
  host.appendChild(frag);
  const overlayEl = document.createElement("div");
  overlayEl.className = "md-pdf-overlay";
  overlayEl.dataset.mdOverlay = "";
  host.appendChild(overlayEl);
  // Where each page box really is: the overlay is placed from these, never
  // from a sum of rounded heights and margins that drifts down a long strip.
  const pageTops = [...host.querySelectorAll(".md-pdf-page")].map((box) => box.offsetTop);
  mdState.preview = { scale, pages: pagesMeta, pageTops };
  scroll.scrollTop = keep;
  previewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const tile = entry.target;
      if (entry.isIntersecting) drawTile(tile);
      else if (tile.dataset.drawn === "1") {
        // Far off screen: its pixels go back.
        tile.width = 0;
        tile.height = 0;
        tile.dataset.drawn = "";
      }
    }
  }, { root: scroll, rootMargin: "1600px 0px" });
  tiles.forEach((tile) => previewObserver.observe(tile));
  paintOverlay();
  mdStatus("");
}

// ── The overlay: pages, breaks, dragging ───────────────────────────────────

// Preview pixels of a point `y` (points, down the column) in row `i`'s slice.
function previewY(rowIndex, offset = 0) {
  const { flow } = mdState.laid;
  const { scale, pageTops } = mdState.preview;
  const plan = previewPlan(flow);
  for (let p = 0; p < plan.pages.length; p += 1) {
    const slice = plan.slices[plan.pages[p].slices[0]];
    if (rowIndex >= slice.from && rowIndex < slice.to) {
      const first = flow.rows[slice.from];
      const repeat = slice.from > 0 && first.repeat ? first.repeat.h : 0;
      return (pageTops[p] || 0) + (flow.geometry.marginTop + repeat + flow.rows[rowIndex].y - first.y + offset) * scale;
    }
  }
  return pageTops[pageTops.length - 1] || 0;
}

// The column y (points) under a preview pixel y.
function columnY(px) {
  const { flow } = mdState.laid;
  const { scale, pageTops } = mdState.preview;
  const plan = previewPlan(flow);
  for (let p = 0; p < plan.pages.length; p += 1) {
    const next = pageTops[p + 1];
    if (next === undefined || px < next || p === plan.pages.length - 1) {
      const slice = plan.slices[plan.pages[p].slices[0]];
      const first = flow.rows[slice.from];
      const repeat = slice.from > 0 && first.repeat ? first.repeat.h : 0;
      return first.y + (px - (pageTops[p] || 0)) / scale - flow.geometry.marginTop - repeat;
    }
  }
  return 0;
}

// A break's line: halfway down the gap between the last row of one page and
// the first of the next — clear of both, where the gap is a heading's or a
// paragraph's space. (Its handle sits in the gutter, .md-pdf-cut-grip, so
// nothing but the thin line itself is drawn over the page.)
function lineYFor(rowIndex) {
  const { rows } = mdState.laid.flow;
  const prev = rows[rowIndex - 1];
  const gapMid = prev ? (prev.y + prev.h + rows[rowIndex].y) / 2 - rows[rowIndex].y : 0;
  return Math.max(0, previewY(rowIndex, gapMid) - 1);
}

function paintOverlay() {
  const overlayEl = mdq("[data-md-overlay]");
  if (!overlayEl || !mdState.laid || !mdState.plan || !mdState.preview) return;
  const { rows } = mdState.laid.flow;
  const { plan } = mdState;
  const two = mdState.options.columns === 2;
  const parts = [];
  plan.pages.forEach((page, p) => {
    page.slices.forEach((s, column) => {
      const slice = plan.slices[s];
      const top = previewY(slice.from);
      const bottom = previewY(slice.to - 1, rows[slice.to - 1].h);
      const fill = Math.round(Math.min(999, (plan.slices[s].h / plan.room) * 100));
      const label = `${p + 1}${two ? (column ? "b" : "a") : ""}`;
      const title = `Page ${p + 1}${two ? `, column ${column + 1}` : ""}${mdState.options.layout === "long" ? "" : ` — ${fill}% of the page length`}`;
      const meta = mdState.options.layout === "long" ? "" : `${fill}%`;
      parts.push(`<div class="md-pdf-band${page.over ? " is-over" : ""}${(p % 2) ? " is-odd" : ""}" style="top:${top}px;height:${Math.max(4, bottom - top)}px" title="${esc(title)}"><span class="md-pdf-band-label"><b>${label}</b>${meta ? `<small>${meta}</small>` : ""}</span></div>`);
    });
  });
  plan.cuts.forEach((rowIndex) => {
    const key = rows[rowIndex].key;
    const y = lineYFor(rowIndex);
    const selected = key === mdState.selectedKey ? " is-selected" : "";
    parts.push(`<div class="md-pdf-cut${selected}" data-cut-key="${esc(key)}" style="top:${y}px"><span class="md-pdf-cut-grip" aria-hidden="true"></span><button type="button" class="md-pdf-cut-remove" data-cut-remove="${esc(key)}" aria-label="Remove this page break">✕</button></div>`);
  });
  overlayEl.innerHTML = parts.join("");
}

function keysNow() {
  return mdState.plan ? mdState.plan.keys.slice() : [];
}

function changeCuts(nextKeys) {
  mdState.history.push(mdState.manualKeys ? mdState.manualKeys.slice() : null);
  mdState.future = [];
  mdState.manualKeys = nextKeys;
  replan();
}

function paintHistoryButtons() {
  mdq("[data-md-action=\"undo\"]").disabled = !mdState.history.length;
  mdq("[data-md-action=\"redo\"]").disabled = !mdState.future.length;
}

function undoMdCuts() {
  if (!mdState.history.length) return;
  mdState.future.push(mdState.manualKeys ? mdState.manualKeys.slice() : null);
  mdState.manualKeys = mdState.history.pop();
  replan();
}

function redoMdCuts() {
  if (!mdState.future.length) return;
  mdState.history.push(mdState.manualKeys ? mdState.manualKeys.slice() : null);
  mdState.manualKeys = mdState.future.pop();
  replan();
}

function mdCutCandidates(any) {
  return cutCandidates(mdState.laid.flow.rows, { any });
}

function indexOfKey(key) {
  return mdState.laid.flow.rows.findIndex((row) => row.key === key);
}

function pointerColumnY(event) {
  const host = mdq("[data-md-pages]");
  const box = host.getBoundingClientRect();
  return columnY(event.clientY - box.top);
}

let mdDrag = null;
// A press on a break line repaints the overlayEl under the pointer, so the click
// that follows lands on the page — and would add a break. Swallowed.
let hushClickUntil = 0;

// The line being dragged is the SAME element the finger came down on: it is
// marked selected and dragging by class, never repainted, because swapping
// the element out from under a touch is how a phone loses the gesture to the
// scroll box. The host captures the pointer, so the moves keep coming however
// far the finger strays.
function markCut(key, { selected = false, dragging = false } = {}) {
  mdDialog.querySelectorAll(".md-pdf-cut").forEach((el) => {
    const mine = el.dataset.cutKey === key;
    el.classList.toggle("is-selected", mine && selected);
    el.classList.toggle("is-dragging", mine && dragging);
  });
}

function onOverlayPointerDown(event) {
  if (!mdState?.laid || !mdState.preview) return;
  if (event.target.closest("[data-cut-remove]")) return;
  const line = event.target.closest("[data-cut-key]");
  if (line) {
    event.preventDefault();
    mdState.selectedKey = line.dataset.cutKey;
    mdDrag = { from: line.dataset.cutKey, pointerId: event.pointerId, moved: false, to: null, clientY: event.clientY };
    hushClickUntil = Date.now() + 10000;
    try { mdq("[data-md-pages]").setPointerCapture(event.pointerId); } catch { /* an old browser: the window listeners still follow */ }
    markCut(mdDrag.from, { selected: true, dragging: true });
    startDragScroll();
  }
}

// Near the top or bottom of the preview while dragging a break, the preview
// scrolls, so a break can be taken to a place that is not on screen.
let dragScrollFrame = 0;
function startDragScroll() {
  cancelAnimationFrame(dragScrollFrame);
  const step = () => {
    if (!mdDrag || !mdState) return;
    const scroll = mdq("[data-md-scroll]");
    const box = scroll.getBoundingClientRect();
    const edge = Math.min(56, box.height / 4);
    let delta = 0;
    if (mdDrag.clientY < box.top + edge) delta = -Math.ceil((box.top + edge - mdDrag.clientY) / 4);
    else if (mdDrag.clientY > box.bottom - edge) delta = Math.ceil((mdDrag.clientY - (box.bottom - edge)) / 4);
    if (delta) {
      const before = scroll.scrollTop;
      scroll.scrollTop += delta;
      if (scroll.scrollTop !== before) moveDragTo(mdDrag.clientY, mdDrag.altKey);
    }
    dragScrollFrame = requestAnimationFrame(step);
  };
  dragScrollFrame = requestAnimationFrame(step);
}

// A click — not a pointerdown, which a finger starting to scroll the preview
// also is — on the page adds a break at the nearest clean place; on ✕, takes
// one away.
function onOverlayClick(event) {
  if (!mdState?.laid || !mdState.preview) return;
  if (Date.now() < hushClickUntil) return;
  const remove = event.target.closest("[data-cut-remove]");
  if (remove) {
    event.preventDefault();
    const key = remove.dataset.cutRemove;
    if (mdState.selectedKey === key) mdState.selectedKey = null;
    changeCuts(keysNow().filter((k) => k !== key));
    return;
  }
  if (event.target.closest("[data-cut-key]") || !event.target.closest("[data-md-overlay]")) return;
  const y = pointerColumnY(event);
  const taken = new Set(keysNow().map(indexOfKey));
  const c = nearestCandidate(mdCutCandidates(event.altKey), y, taken);
  if (!c) return;
  const key = mdState.laid.flow.rows[c.i].key;
  mdState.selectedKey = key;
  changeCuts([...keysNow(), key]);
}

function moveDragTo(clientY, altKey) {
  const y = pointerColumnY({ clientY });
  const others = new Set(keysNow().filter((k) => k !== mdDrag.from).map(indexOfKey));
  const c = nearestCandidate(mdCutCandidates(altKey), y, others);
  if (!c) return;
  mdDrag.to = mdState.laid.flow.rows[c.i].key;
  const line = mdq(`[data-cut-key="${CSS.escape(mdDrag.from)}"]`);
  if (line) {
    line.style.top = `${lineYFor(c.i)}px`;
    line.classList.add("is-dragging");
  }
}

function onPointerMove(event) {
  if (!mdDrag || event.pointerId !== mdDrag.pointerId) return;
  event.preventDefault();
  mdDrag.moved = true;
  mdDrag.clientY = event.clientY;
  mdDrag.altKey = event.altKey;
  moveDragTo(event.clientY, event.altKey);
}

function onPointerUp(event) {
  if (!mdDrag || event.pointerId !== mdDrag.pointerId) return;
  const { from, to } = mdDrag;
  mdDrag = null;
  cancelAnimationFrame(dragScrollFrame);
  hushClickUntil = Date.now() + 350;
  if (to && to !== from) {
    mdState.selectedKey = to;
    changeCuts(keysNow().map((k) => (k === from ? to : k)));
  } else paintOverlay();
}

function onPreviewKey(event) {
  if (!mdState?.laid) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redoMdCuts(); else undoMdCuts();
    return;
  }
  if (mod && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoMdCuts();
    return;
  }
  const key = mdState.selectedKey;
  if (!key || !keysNow().includes(key)) return;
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    mdState.selectedKey = null;
    changeCuts(keysNow().filter((k) => k !== key));
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const i = indexOfKey(key);
    const others = new Set(keysNow().filter((k) => k !== key).map(indexOfKey));
    const c = stepCandidate(mdCutCandidates(event.altKey), mdState.laid.flow.rows[i].y, event.key === "ArrowUp" ? -1 : 1, others);
    if (!c) return;
    const to = mdState.laid.flow.rows[c.i].key;
    mdState.selectedKey = to;
    changeCuts(keysNow().map((k) => (k === key ? to : k)));
  }
}

// ── Opening, saving ─────────────────────────────────────────────────────────

const TITLES = { new: "New PDF from Markdown", insert: "Insert Markdown pages", edit: "Edit markdown" };
const SAVE_LABELS = { new: "Make PDF", insert: "Insert pages", edit: "Remake pages" };

function paintSaveButton() {
  const button = mdq("[data-md-action=\"save\"]");
  button.disabled = !mdState?.plan?.pages.length || mdState.saving;
  button.textContent = mdState?.saving ? "Working…" : SAVE_LABELS[mdState?.mode || "new"];
}

function paintMode() {
  mdq("#mdPdfTitle").textContent = TITLES[mdState.mode];
  mdq("[data-md-name-row]").hidden = mdState.mode !== "new";
  mdq("[data-md-at-row]").hidden = mdState.mode !== "insert";
  mdq("[data-md-action=\"remove-part\"]").hidden = mdState.mode !== "edit" || mdState.wholePdf;
  mdq("[data-md-part-row]").hidden = !(mdState.mode === "edit" && mdState.parts.length > 1);
  paintSaveButton();
}

async function openPdfBytes() {
  const pdfId = openDocumentPdfId();
  const entry = pdfId ? deckPdfById(state.meta, pdfId) : null;
  if (!entry || !state.localDeckId) return null;
  const blob = await getDocument(pdfStoreKey(state.localDeckId, pdfId), entry);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// "Match this PDF": the size of the page the new pages go beside.
async function refreshMatch() {
  if (mdState.mode === "new" || !mdState.baseBytes || !(await ensurePdfLib())) return;
  const at = mdState.mode === "insert" ? Math.max(0, mdState.at - 2) : (mdState.part?.pages[0] ?? 0);
  mdState.match = await pageSizeAt(window.PDFLib, mdState.baseBytes, Math.max(0, at)).catch(() => null);
}

function loadPart(part) {
  mdState.part = part;
  mdState.partId = part.id;
  const data = part.data || {};
  mdq("[data-md-text]").value = data.source || "";
  mdState.options = normalizeMdPdfOptions(data.options || {});
  mdState.manualKeys = Array.isArray(data.cuts) ? data.cuts : null;
  mdState.title = data.title || "";
  mdState.history = [];
  mdState.future = [];
  mdState.wholePdf = part.pages.length >= (mdState.pageCount || 0);
  paintMdPdfOptions();
  paintMode();
}

function closeMdPdfDialog() {
  if (!mdDialog || mdDialog.hidden) return;
  mdDialog.hidden = true;
  unlockPageScroll();
  clearTimeout(relayoutTimer);
  clearTimeout(meterTimer);
  buildSeq += 1;
  releasePreview();
  mdState = null;
}

async function saveMdPdfDialog() {
  if (!mdState?.laid || !mdState.plan?.pages.length || mdState.saving) return;
  mdState.saving = true;
  paintSaveButton();
  const markdown = mdq("[data-md-text]").value;
  const options = mdState.options;
  storeOptions(options);
  // Kept only when placed by hand: an automatic plan is planned again.
  const cuts = mdState.manualKeys ? mdState.plan.keys : null;
  let ok = false;
  try {
    if (mdState.mode === "new") {
      const title = mdq("[data-md-name]").value.trim() || markdownTitle(markdown) || "Markdown";
      ok = await saveNewMarkdownPdf(mdSession, mdState.laid, mdState.plan, { markdown, options, cuts, title });
    } else if (mdState.mode === "insert") {
      ok = await spliceIntoOpenPdf(mdSession, mdState.laid, mdState.plan, { markdown, options, cuts, title: markdownTitle(markdown), at: mdState.at - 1 });
    } else if (mdState.wholePdf) {
      ok = await rebuildWholePdf(mdSession, mdState.laid, mdState.plan, { markdown, options, cuts, title: mdState.title || markdownTitle(markdown), partId: mdState.partId });
    } else {
      ok = await spliceIntoOpenPdf(mdSession, mdState.laid, mdState.plan, { markdown, options, cuts, title: markdownTitle(markdown), partId: mdState.partId });
    }
  } catch (error) {
    console.warn("Markdown → PDF could not be saved", error);
    showToast(`Could not make the PDF — ${error?.message || "unexpected error"}`, "error");
  }
  if (ok) closeMdPdfDialog();
  else if (mdState) {
    mdState.saving = false;
    paintSaveButton();
  }
}

function wireMdPdfDialog() {
  mdDialog.addEventListener("click", async (event) => {
    const opt = event.target.closest("[data-md-opt]");
    if (opt) {
      const name = opt.dataset.mdOpt;
      const value = name === "columns" ? Number(opt.dataset.value) : opt.dataset.value;
      mdState.options = normalizeMdPdfOptions({ ...readOptions(), [name]: value });
      // A different page shape plans the breaks again, as Auto would.
      mdState.manualKeys = null;
      mdState.history = [];
      mdState.future = [];
      paintMdPdfOptions();
      scheduleRelayout(0);
      return;
    }
    const tab = event.target.closest("[data-md-tab]");
    if (tab) {
      mdq(".md-pdf-body").dataset.mdShow = tab.dataset.mdTab;
      mdDialog.querySelectorAll("[data-md-tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      // Opening the preview draws what the edits since have laid out; a
      // layout still to come draws it when it lands.
      if (tab.dataset.mdTab === "preview") {
        if (!mdState.laid) scheduleRelayout(0);
        else showPreviewIfStale();
      }
      return;
    }
    const action = event.target.closest("[data-md-action]")?.dataset.mdAction;
    if (action === "cancel") closeMdPdfDialog();
    else if (action === "save") saveMdPdfDialog();
    else if (action === "auto") { if (mdState.manualKeys) changeCuts(null); }
    else if (action === "undo") undoMdCuts();
    else if (action === "redo") redoMdCuts();
    else if (action === "use-notes") {
      const notes = notesForExport();
      if (!notes.trim()) { showToast("This file has no Notes yet"); return; }
      mdq("[data-md-text]").value = notes;
      if (!mdq("[data-md-name]").value) mdq("[data-md-name]").value = state.deckTitle || markdownTitle(notes);
      scheduleRelayout(0);
    } else if (action === "remove-part") {
      const id = mdState.partId;
      if (await removePartFromOpenPdf(id)) closeMdPdfDialog();
    }
  });
  mdDialog.addEventListener("input", (event) => {
    if (event.target.matches("[data-md-text]")) scheduleRelayout();
    else if (event.target.matches("[data-md-num], [data-md-check]")) {
      mdState.options = readOptions();
      mdState.manualKeys = null;
      paintMdPdfOptions();
      scheduleRelayout(event.target.matches("[data-md-check]") ? 0 : 500);
    } else if (event.target.matches("[data-md-at]")) {
      const max = (mdState.pageCount || 0) + 1;
      mdState.at = Math.max(1, Math.min(max, Math.round(Number(event.target.value) || 1)));
      if (mdState.options.paper === "match") refreshMatch().then(() => scheduleRelayout(0));
    } else if (event.target.matches("[data-md-name]")) scheduleMeter();
  });
  mdDialog.addEventListener("change", async (event) => {
    if (event.target.matches("[data-md-file]")) {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { showToast("That file is too large to make a PDF from (5MB at most)", "error"); return; }
      mdq("[data-md-text]").value = await file.text();
      if (mdState.mode === "new" && !mdq("[data-md-name]").value) mdq("[data-md-name]").value = file.name.replace(/\.(md|markdown|mdown|txt)$/i, "");
      scheduleRelayout(0);
    } else if (event.target.matches("[data-md-part]")) {
      const part = mdState.parts.find((p) => p.id === event.target.value);
      if (part) {
        loadPart(part);
        await refreshMatch();
        scheduleRelayout(0);
      }
    }
  });
  const overlayHost = mdq("[data-md-pages]");
  overlayHost.addEventListener("pointerdown", onOverlayPointerDown);
  overlayHost.addEventListener("click", onOverlayClick);
  window.addEventListener("pointermove", (event) => { if (mdDrag) onPointerMove(event); });
  window.addEventListener("pointerup", (event) => { if (mdDrag) onPointerUp(event); });
  window.addEventListener("pointercancel", () => {
    if (!mdDrag) return;
    mdDrag = null;
    cancelAnimationFrame(dragScrollFrame);
    if (mdState) paintOverlay();
  });
  mdq("[data-md-scroll]").addEventListener("keydown", onPreviewKey);
  mdDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMdPdfDialog();
    }
  });
  // A new width only changes the preview's scale: drawn again, not laid out.
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    if (!mdState || mdDialog.hidden || !mdState.laid) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!mdState?.laid) return;
      mdState.previewStale = true;
      showPreviewIfStale();
    }, 200);
  });
}

// Open the dialog.
//   mode "new"     a new PDF in the file's PDFs list (`source`: markdown to start with)
//   mode "insert"  pages into the PDF on screen
//   mode "edit"    the markdown of the PDF on screen, or of pages inserted in it
export async function openMarkdownPdfDialog({ mode = "new", source = "", title = "" } = {}) {
  if (!state.deckTitle && !state.masterCards?.length && !String(state.notes || "").trim() && !state.localDeckId) {
    showToast("Open or create a file first, then make its PDF", "error");
    return;
  }
  if (mode !== "new" && activeDocSlot() !== DOC_SLOT_DOC) {
    showToast("Open a PDF first", "error");
    return;
  }
  if (!mdDialog) {
    mdDialog = buildMdPdfDialog();
    wireMdPdfDialog();
  }
  if (!mdSession) mdSession = createMdPdfSession();
  mdState = {
    mode,
    options: loadOptions(),
    manualKeys: null,
    history: [],
    future: [],
    laid: null,
    plan: null,
    preview: null,
    previewStale: false,
    match: null,
    selectedKey: null,
    parts: [],
    part: null,
    partId: null,
    wholePdf: false,
    pageCount: 0,
    at: 1,
    baseBytes: null,
    saving: false
  };
  // "Match this PDF" is about a PDF the pages go into; a new PDF has none.
  if (mode === "new" && mdState.options.paper === "match") mdState.options = normalizeMdPdfOptions({ ...mdState.options, paper: "A4" });
  mdq("[data-md-text]").value = source || "";
  mdq("[data-md-name]").value = title || "";
  mdq("[data-md-pages]").innerHTML = "";
  mdq("[data-md-meter]").textContent = "";
  mdq(".md-pdf-body").dataset.mdShow = "source";
  mdDialog.querySelectorAll("[data-md-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.mdTab === "source")));
  if (mode !== "new") {
    mdState.baseBytes = await openPdfBytes();
    if (!mdState.baseBytes) {
      showToast("This device doesn't have a copy of the PDF to change.", "error");
      mdState = null;
      return;
    }
    const pdfId = openDocumentPdfId();
    mdState.pageCount = Number(deckPdfById(state.meta, pdfId)?.pages) || 0;
  }
  if (mode === "insert") {
    // After the page being read, by default.
    mdState.at = Math.min(mdState.pageCount + 1, Math.max(1, currentDocumentPage() + 1));
    mdq("[data-md-at]").value = String(mdState.at);
    mdq("[data-md-at]").max = String(mdState.pageCount + 1);
    mdq("[data-md-at-of]").textContent = `of ${mdState.pageCount + 1}`;
    if (mdState.options.paper === MD_PDF_DEFAULTS.paper) mdState.options = { ...mdState.options, paper: "match" };
  }
  if (mode === "edit") {
    mdState.parts = await openPdfParts();
    if (!mdState.parts.length) {
      showToast("This PDF has no markdown kept in it to edit", "error");
      mdState = null;
      return;
    }
    const select = mdq("[data-md-part]");
    select.innerHTML = mdState.parts.map((p) => {
      const first = p.pages[0] + 1;
      const last = p.pages[p.pages.length - 1] + 1;
      const name = p.data?.title || markdownTitle(p.data?.source) || "Markdown";
      return `<option value="${esc(p.id)}">${esc(name)} — page${first === last ? ` ${first}` : `s ${first}–${last}`}</option>`;
    }).join("");
    const here = currentDocumentPage() - 1;
    const part = mdState.parts.find((p) => p.pages.includes(here)) || mdState.parts[0];
    select.value = part.id;
    loadPart(part);
  }
  paintMdPdfOptions();
  paintMode();
  await refreshMatch();
  mdDialog.hidden = false;
  lockPageScroll();
  requestAnimationFrame(() => mdq("[data-md-text]")?.focus({ preventScroll: true }));
  scheduleRelayout(0);
}

export function isMarkdownPdfDialogOpen() {
  return Boolean(mdDialog && !mdDialog.hidden);
}
