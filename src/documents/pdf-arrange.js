// Arranging a deck's PDFs — the order the "Switch PDF" dropdown lists them in.
//
// The dropdown itself is a native <select>, and a native select's options
// cannot be dragged on any platform. So the arranging happens here, in a sheet
// of its own: one row per paper, a grip to drag it by, and ↑/↓ for anyone not
// dragging (a keyboard, a screen reader, a hand that would rather tap).
//
// Dragged with POINTER events, not HTML5 drag-and-drop. The All Cards reorder
// (all-cards-edit.js) uses the latter, and it does nothing at all under a
// finger on a phone — which is where a deck with several papers in it is most
// often read.
//
// Nothing is written until Done: Cancel, ×, Escape or a tap outside leave the
// order exactly as it was. The order is written through withPdfOrder as one
// stamped value (see pdf-multi.js) rather than by rearranging meta.pdfs, which
// the sync merge would put back the way it found it.

import { state } from "../core/state.js?v=__BUILD__";
import { deckPdfs, withPdfOrder } from "./pdf-multi.js?v=__BUILD__";
import { renderDocumentPdfSwitcher } from "./pdf-view.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

let openSheet = null;

export function openPdfArrangeSheet() {
  if (openSheet) return;
  const list = deckPdfs(state.meta);
  if (list.length < 2) {
    showToast("This deck has only one PDF", "info");
    return;
  }

  const modal = document.createElement("section");
  modal.className = "category-choice-modal pdf-arrange-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "Arrange PDFs");

  const shell = document.createElement("div");
  shell.className = "category-choice-shell pdf-arrange-shell";
  shell.innerHTML = `
    <div class="category-choice-head">
      <div>
        <h2>Arrange PDFs</h2>
        <p>Drag a paper by its grip, or use the arrows. The switcher lists them in this order.</p>
      </div>
      <button type="button" data-arrange-cancel aria-label="Close without saving">&#215;</button>
    </div>
    <ol class="pdf-arrange-list" data-arrange-list></ol>
    <div class="category-choice-actions">
      <button type="button" data-arrange-cancel>Cancel</button>
      <button type="button" data-arrange-save>Done</button>
    </div>
  `;
  const listEl = shell.querySelector("[data-arrange-list]");
  list.forEach((entry) => listEl.appendChild(arrangeRow(entry)));
  refreshArrowStates(listEl);

  const close = (save) => {
    if (save) commitOrder([...listEl.children].map((row) => row.dataset.pdfId));
    modal.remove();
    document.removeEventListener("keydown", onKey, true);
    unlockPageScroll();
    openSheet = null;
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(false);
  };

  shell.querySelectorAll("[data-arrange-cancel]").forEach((button) => {
    button.addEventListener("click", () => close(false));
  });
  shell.querySelector("[data-arrange-save]").addEventListener("click", () => close(true));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close(false);
  });
  listEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-arrange-move]");
    if (!button) return;
    const row = button.closest(".pdf-arrange-row");
    const delta = Number(button.dataset.arrangeMove);
    moveRow(listEl, row, delta);
    // Focus follows the paper, not the slot: pressing ↓ three times walks one
    // paper three places, which is what a keyboard user meant by it.
    const again = row.querySelector(`[data-arrange-move="${delta}"]`);
    (again && !again.disabled ? again : row.querySelector("[data-arrange-move]:not(:disabled)"))?.focus();
  });
  listEl.addEventListener("pointerdown", (event) => {
    const grip = event.target.closest(".pdf-arrange-grip");
    if (grip) beginRowDrag(listEl, grip.closest(".pdf-arrange-row"), grip, event);
  });

  modal.appendChild(shell);
  document.body.appendChild(modal);
  document.addEventListener("keydown", onKey, true);
  lockPageScroll();
  openSheet = modal;
  shell.querySelector("[data-arrange-save]").focus();
}

function arrangeRow(entry) {
  const row = document.createElement("li");
  row.className = "pdf-arrange-row";
  row.dataset.pdfId = entry.id;

  const grip = document.createElement("span");
  grip.className = "pdf-arrange-grip";
  grip.setAttribute("aria-hidden", "true");
  grip.textContent = "⠿";

  const name = document.createElement("span");
  name.className = "pdf-arrange-name";
  name.textContent = entry.label || entry.name || "PDF";
  if (entry.label && entry.name && entry.label !== entry.name) name.title = entry.name;

  const up = arrowButton(-1, "↑", `Move "${name.textContent}" up`);
  const down = arrowButton(1, "↓", `Move "${name.textContent}" down`);
  row.append(grip, name, up, down);
  return row;
}

function arrowButton(delta, glyph, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pdf-arrange-move";
  button.dataset.arrangeMove = String(delta);
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = glyph;
  return button;
}

function moveRow(listEl, row, delta) {
  if (!row) return;
  if (delta < 0 && row.previousElementSibling) listEl.insertBefore(row, row.previousElementSibling);
  if (delta > 0 && row.nextElementSibling) listEl.insertBefore(row.nextElementSibling, row);
  refreshArrowStates(listEl);
}

function refreshArrowStates(listEl) {
  const rows = [...listEl.children];
  rows.forEach((row, index) => {
    row.querySelector('[data-arrange-move="-1"]').disabled = index === 0;
    row.querySelector('[data-arrange-move="1"]').disabled = index === rows.length - 1;
  });
}

// ── Dragging a row ──────────────────────────────────────────────────────────
//
// The row follows the pointer with a transform; the list underneath it is
// rearranged in the DOM the moment the pointer crosses the middle of a
// neighbour (the same before/after-the-midpoint rule allCardDropPlacement
// uses). Every move recomputes the transform from where the row now sits
// naturally, so a row that has just been moved in the DOM stays under the
// finger instead of jumping a whole row's height.
function beginRowDrag(listEl, row, grip, event) {
  if (!row || (event.button !== undefined && event.button !== 0)) return;
  event.preventDefault();
  const startY = event.clientY;
  const startTop = row.offsetTop;
  try { grip.setPointerCapture(event.pointerId); } catch (_) { /* synthetic event */ }
  row.classList.add("is-dragging");
  listEl.classList.add("is-arranging");

  const place = (clientY) => {
    row.style.transform = `translateY(${(clientY - startY) - (row.offsetTop - startTop)}px)`;
  };
  const onMove = (moveEvent) => {
    const y = moveEvent.clientY;
    // Several steps in one move are possible (a fast flick past two rows), so
    // keep stepping until neither neighbour's midpoint has been crossed.
    for (let guard = 0; guard < listEl.children.length; guard += 1) {
      const prev = row.previousElementSibling;
      const next = row.nextElementSibling;
      if (prev && y < midpoint(prev)) listEl.insertBefore(row, prev);
      else if (next && y > midpoint(next)) listEl.insertBefore(next, row);
      else break;
    }
    place(y);
  };
  const onUp = (upEvent) => {
    try { grip.releasePointerCapture(upEvent.pointerId); } catch (_) { /* already gone */ }
    grip.removeEventListener("pointermove", onMove);
    grip.removeEventListener("pointerup", onUp);
    grip.removeEventListener("pointercancel", onUp);
    row.classList.remove("is-dragging");
    listEl.classList.remove("is-arranging");
    row.style.transform = "";
    refreshArrowStates(listEl);
  };
  grip.addEventListener("pointermove", onMove);
  grip.addEventListener("pointerup", onUp);
  grip.addEventListener("pointercancel", onUp);
}

function midpoint(node) {
  const rect = node.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

function commitOrder(ids) {
  const before = deckPdfs(state.meta).map((entry) => entry.id);
  if (ids.length === before.length && ids.every((id, index) => id === before[index])) return;
  state.meta = withPdfOrder(state.meta, ids);
  scheduleDeckAutosave();
  renderDocumentPdfSwitcher();
}
