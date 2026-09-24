// The block's own actions, at the block — not only in the rail across the top
// of the screen.
//
// #inkRailBlock (src/ui/ink-rail.js) already answers "what can I do with the
// block I picked up", painted the moment one is selected — but it lives in a
// toolbar docked near the top of the page, and it only ever offered three of
// the six things a selected block can actually do: Style, Edit and Delete.
// Duplicate and the two restack verbs have been reachable by keyboard only
// (Ctrl+D, `[`, `]` — see src/main.js) since the day they were written, which
// on a touch or pen device with no keyboard makes them unreachable, full stop.
//
// This is not a replacement for the rail — "in addition to the top bar" is
// the ask, and the rail stays exactly as it is, for the reader who has
// learned to look there. This is the same six actions again, floating
// anchored to the block itself, the way `openBlockStylePopover`
// (./block-style-bar.js) already puts the STYLE controls at the block rather
// than in a window. The placement mechanics below are a deliberate near-copy
// of that popover's rather than a shared import: block-style-bar.js already
// states its own boundary ("this module owns the controls and nothing else"),
// and a quick-actions strip with no value/state model at all — every button
// here is a one-shot verb, not a setting — is a different kind of thing to
// hand it. Duplicating ~30 lines of placement math is the smaller risk next
// to reworking a file that already works.
//
// ── Why this takes callbacks and not the verbs themselves ─────────────────
//
// pdf-blocks.js already owns every action a button here fires (duplicateBlock,
// restackBlock, editBlock, deleteBlock, openSelectedBlockStyle) and it is the
// one caller. Importing them here instead of taking them as callbacks would
// make this module and pdf-blocks.js import each other — the same shape
// block-style-bar.js avoids by taking `onChange` rather than importing
// writeBlockStyle. One direction only: pdf-blocks.js imports this module,
// never the reverse.

let actionsPopover = null;

// The scroll listener's rAF handle — see scrollHandler in
// openBlockActionsPopover for why this exists at all.
let actionsScrollFrame = 0;

export function isBlockActionsPopoverOpen() {
  return Boolean(actionsPopover);
}

export function closeBlockActionsPopover() {
  if (!actionsPopover) return false;
  window.removeEventListener("resize", actionsPopover.place);
  // Capture, because what moves this is the document scroller — not the
  // window — and a scroll event does not bubble. The same reason
  // openBlockStylePopover's own listener is capture too.
  document.removeEventListener("scroll", actionsPopover.scrollHandler, true);
  // A frame can already be in flight (a scroll landed, the rAF is queued, then
  // a row press or Escape closes the popover before it fires) — drop it, or it
  // calls place() against a root that has just been removed from the document.
  if (actionsScrollFrame) {
    cancelAnimationFrame(actionsScrollFrame);
    actionsScrollFrame = 0;
  }
  actionsPopover.root.remove();
  actionsPopover = null;
  return true;
}

function actionButton({ action, label, danger = false }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tool-button block-actions-btn${danger ? " is-danger" : ""}`;
  button.dataset.blockPopoverAction = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = label;
  return button;
}

export function openBlockActionsPopover({
  anchor,
  kind = "text",
  onStyle = () => {},
  onEdit = () => {},
  onDuplicate = () => {},
  onRestackForward = () => {},
  onRestackBack = () => {},
  onDelete = () => {}
} = {}) {
  closeBlockActionsPopover();
  if (!anchor) return null;

  const root = document.createElement("div");
  root.className = "pdf-block-actions-pop";
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Block actions");

  // The same word an image's own Style/Edit buttons wear on the rail
  // (refreshBlockRail, src/ui/ink-rail.js) — "Frame"/"Describe" for a
  // picture, "Style"/"Edit" for text. Kept in step with that rail rather than
  // inventing a second pair of labels for the same distinction.
  const isImage = kind === "image";
  const style = actionButton({ action: "style", label: isImage ? "Frame" : "Style" });
  const edit = actionButton({ action: "edit", label: isImage ? "Describe" : "Edit" });
  const duplicate = actionButton({ action: "duplicate", label: "Duplicate" });
  const back = actionButton({ action: "restack-back", label: "Send back" });
  const forward = actionButton({ action: "restack-forward", label: "Bring forward" });
  const del = actionButton({ action: "delete", label: "Delete", danger: true });
  root.append(style, edit, duplicate, back, forward, del);
  document.body.appendChild(root);

  // ── Placing it — the exact shape openBlockStylePopover already uses ───────
  //
  // Under the block if there is room and over it if there is not, clamped to
  // the viewport in both axes, and re-run on every scroll and resize so a
  // page that moves under it never leaves it pointing at empty air.
  const place = () => {
    if (!anchor.isConnected) { closeBlockActionsPopover(); return; }
    const box = anchor.getBoundingClientRect();
    const size = root.getBoundingClientRect();
    const margin = 8;
    const below = box.bottom + margin;
    const top = below + size.height > window.innerHeight - margin
      ? Math.max(margin, box.top - size.height - margin)
      : below;
    const left = Math.min(
      Math.max(margin, box.left),
      Math.max(margin, window.innerWidth - size.width - margin)
    );
    root.style.top = `${Math.round(top)}px`;
    root.style.left = `${Math.round(left)}px`;
  };

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeBlockActionsPopover();
  });

  // pointerdown, not click, and preventDefault — the same reason every other
  // floating control over this page uses it (the ink rail, the style
  // popover): a press must not travel on to the paper underneath and start a
  // stroke or a drag, and on a stylus the two are a few pixels apart.
  root.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-block-popover-action]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const action = button.dataset.blockPopoverAction;
    if (action === "style") onStyle();
    else if (action === "edit") onEdit();
    else if (action === "duplicate") onDuplicate();
    else if (action === "restack-forward") onRestackForward();
    else if (action === "restack-back") onRestackBack();
    else if (action === "delete") onDelete();
  });

  // Coalesced into one rAF per frame, the same fix (and the same reason)
  // documentScrollFrame in main.js applies to the document view's own scroll
  // handler: a fling delivers scroll events faster than it delivers frames, and
  // `place` forces two getBoundingClientRect() reads plus two style writes —
  // paying that on every raw event instead of once per frame is exactly the
  // kind of per-scroll layout thrash that fix was measured against.
  const scrollHandler = () => {
    if (actionsScrollFrame) return;
    actionsScrollFrame = requestAnimationFrame(() => {
      actionsScrollFrame = 0;
      place();
    });
  };

  actionsPopover = { root, place, scrollHandler };
  place();
  window.addEventListener("resize", place);
  document.addEventListener("scroll", scrollHandler, true);
  return actionsPopover;
}
