// Markdown, in a box, on a page you write on by hand.
//
// The reason a notebook needs these at all: handwriting is quick and unreadable
// by anything, typed text is slow and readable by everything, and a page of
// working usually wants both — a derivation in your own hand with the statement
// of the problem typed above it, or a diagram with a heading. So a box is
// markdown rendered through the same pipeline every other surface uses, dropped
// where you put it and moved and resized with a finger.
//
// ── What a box is NOT ─────────────────────────────────────────────────────
//
// It is not part of the deck's note. Its text lives in meta.textBoxes and
// nowhere else, which is a deliberate trade and worth writing down because it
// has a cost: what you type in a box is not reachable from search, from
// [[links]], or from the notes view. The notebook's own export renders them, so
// a page is never write-only — but if that ever stops being enough, the fix is
// to give a box a slice of `notes` the way a highlight note has one, not to
// bolt a second index onto this file.
//
// ── Pointer mechanics ─────────────────────────────────────────────────────
//
// Modelled on the image resize grip in src/images/surface-controls.js, and for
// the same three reasons it is written the way it is: setPointerCapture so a
// fast drag that leaves the element keeps the gesture, an rAF throttle so a
// drag is one style write per frame rather than one per event, and the
// document-level listeners removed in the up handler — a leaked pointermove
// listener is the "stray UI element that follows the cursor" bug.
//
// Every press here stops propagating. The page under a box is a drawing
// surface, and a press meant to move a box that also drew a stroke would be
// both, every time.

import { HW_BOX_MIN_HEIGHT, HW_BOX_MIN_WIDTH, freshHandwritingId } from "./pages.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";

export const HW_BOX_DEFAULT_WIDTH = 300;
export const HW_BOX_DEFAULT_HEIGHT = 120;

export function makeHandwritingBox({ page, x, y, taken = null }) {
  return {
    id: freshHandwritingId("hb", taken),
    page,
    x: Math.round(x),
    y: Math.round(y),
    w: HW_BOX_DEFAULT_WIDTH,
    h: HW_BOX_DEFAULT_HEIGHT,
    z: 0,
    md: "",
    at: Date.now()
  };
}

function buildBoxElement(box) {
  const el = document.createElement("div");
  el.className = "hw-box";
  el.dataset.hwBox = box.id;

  const bar = document.createElement("div");
  bar.className = "hw-box-bar";
  bar.dataset.hwBoxAction = "drag";
  bar.title = "Drag to move";

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "hw-box-btn";
  edit.dataset.hwBoxAction = "edit";
  edit.title = "Edit this text";
  edit.setAttribute("aria-label", "Edit this text");
  edit.innerHTML = "&#9998;";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "hw-box-btn is-danger";
  remove.dataset.hwBoxAction = "delete";
  remove.title = "Delete this box";
  remove.setAttribute("aria-label", "Delete this box");
  remove.innerHTML = "&#128465;";
  bar.append(edit, remove);

  const body = document.createElement("div");
  body.className = "hw-box-body rendered";

  const area = document.createElement("textarea");
  area.className = "hw-box-edit";
  area.hidden = true;
  area.setAttribute("aria-label", "Text box markdown");

  const grip = document.createElement("span");
  grip.className = "hw-box-grip";
  grip.dataset.hwBoxAction = "resize";
  grip.title = "Drag to resize";

  el.append(bar, body, area, grip);
  return el;
}

export function createHandwritingBoxes({ paper, getBoxes, onChange }) {
  let editing = null;

  function pageHost(pageId) {
    return paper.pageElement(pageId);
  }

  function place(el, box) {
    const scale = paper.scale();
    el.style.left = `${box.x * scale}px`;
    el.style.top = `${box.y * scale}px`;
    el.style.width = `${box.w * scale}px`;
    el.style.height = `${box.h * scale}px`;
    // The text scales with the paper, or a box that fitted its page at one zoom
    // overflows it at the next. One custom property, read by the rules in
    // styles/53-handwriting.css.
    el.style.setProperty("--hw-scale", String(scale));
    el.style.zIndex = String(10 + (Number(box.z) || 0));
  }

  function paint(el, box) {
    const body = el.querySelector(".hw-box-body");
    const area = el.querySelector(".hw-box-edit");
    if (editing === box.id) {
      area.hidden = false;
      body.hidden = true;
      return;
    }
    area.hidden = true;
    body.hidden = false;
    // An empty box says so rather than being an invisible rectangle you cannot
    // find again — which is exactly what a box added and not yet typed into is.
    body.innerHTML = box.md.trim()
      ? markdownToSafeHtml(box.md)
      : '<p class="hw-box-empty">Empty — press ✎ to write</p>';
  }

  function render() {
    const boxes = getBoxes();
    const wanted = new Set(boxes.map((box) => box.id));
    [...document.querySelectorAll(".hw-box")].forEach((el) => {
      if (!wanted.has(el.dataset.hwBox)) el.remove();
    });
    boxes.forEach((box) => {
      const host = pageHost(box.page);
      if (!host) return;
      let el = host.querySelector(`.hw-box[data-hw-box="${box.id}"]`);
      if (!el) {
        el = buildBoxElement(box);
        host.appendChild(el);
      }
      place(el, box);
      paint(el, box);
    });
  }

  // ── Editing ──────────────────────────────────────────────────────────────

  function beginEdit(id) {
    const box = getBoxes().find((entry) => entry.id === id);
    if (!box) return;
    editing = id;
    render();
    const el = document.querySelector(`.hw-box[data-hw-box="${id}"]`);
    const area = el?.querySelector(".hw-box-edit");
    if (!area) return;
    area.value = box.md;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function commitEdit() {
    if (!editing) return;
    const id = editing;
    const el = document.querySelector(`.hw-box[data-hw-box="${id}"]`);
    const area = el?.querySelector(".hw-box-edit");
    const next = area ? area.value : null;
    editing = null;
    if (next === null) { render(); return; }
    const boxes = getBoxes();
    const box = boxes.find((entry) => entry.id === id);
    if (box && box.md !== next) {
      onChange(boxes.map((entry) => (entry.id === id ? { ...entry, md: next, at: Date.now() } : entry)));
    }
    render();
  }

  // ── Dragging and resizing ────────────────────────────────────────────────

  function beginGesture(event, el, mode) {
    const id = el.dataset.hwBox;
    const box = getBoxes().find((entry) => entry.id === id);
    if (!box) return;
    const scale = paper.scale();
    const start = { x: event.clientX, y: event.clientY, box: { ...box } };
    let frame = 0;
    let live = { ...box };

    const apply = () => {
      frame = 0;
      place(el, live);
    };

    const move = (moveEvent) => {
      const dx = (moveEvent.clientX - start.x) / scale;
      const dy = (moveEvent.clientY - start.y) / scale;
      if (mode === "drag") {
        live = { ...start.box, x: Math.round(start.box.x + dx), y: Math.round(start.box.y + dy) };
      } else {
        live = {
          ...start.box,
          w: Math.round(Math.max(HW_BOX_MIN_WIDTH, start.box.w + dx)),
          h: Math.round(Math.max(HW_BOX_MIN_HEIGHT, start.box.h + dy))
        };
      }
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const finish = () => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      try { el.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
      place(el, live);
      // Only when something actually moved. A press that ended where it started
      // must not cost an autosave and a push.
      if (live.x === box.x && live.y === box.y && live.w === box.w && live.h === box.h) return;
      onChange(getBoxes().map((entry) => (entry.id === id ? { ...entry, ...live, at: Date.now() } : entry)));
    };

    try { el.setPointerCapture(event.pointerId); } catch (_) { /* synthetic */ }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  }

  // One delegated listener over the whole scroller, the pattern every other
  // control surface in this app follows. Capture phase, because the page under
  // it takes its own pointerdown in capture to start a stroke.
  function onPointerDown(event) {
    const el = event.target.closest?.(".hw-box");
    if (!el) return true;
    const action = event.target.closest("[data-hw-box-action]")?.dataset.hwBoxAction;
    // A press inside the text of a box that is being edited is a press in a
    // textarea, and belongs to the textarea.
    if (!action && editing === el.dataset.hwBox) { event.stopPropagation(); return false; }
    event.preventDefault();
    event.stopPropagation();
    if (action === "edit") { commitEdit(); beginEdit(el.dataset.hwBox); return false; }
    if (action === "delete") { onChange(getBoxes().filter((entry) => entry.id !== el.dataset.hwBox), { removed: el.dataset.hwBox }); return false; }
    if (action === "drag" || action === "resize") { commitEdit(); beginGesture(event, el, action === "drag" ? "drag" : "resize"); return false; }
    return false;
  }

  return {
    render,
    onPointerDown,
    commitEdit,
    isEditing: () => Boolean(editing),
    reposition: () => {
      getBoxes().forEach((box) => {
        const el = document.querySelector(`.hw-box[data-hw-box="${box.id}"]`);
        if (el) place(el, box);
      });
    }
  };
}
