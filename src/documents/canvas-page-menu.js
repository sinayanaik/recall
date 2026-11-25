// "Page k ⋯" under a Canvas page (appendPageMenuButton, ./pdf-view.js): the
// page's own verbs, in a small menu beside the button that opened it.
//
// ⋯ → Canvas pages offers the same rows, but from the top of the screen, where
// "this page" has to be worked out from the scroll position — and a reader
// scrolled to page 2 of two was asked to delete page 1. Here the page is the
// one the button is under, and the menu says so in its heading.
//
// Callbacks rather than the verbs themselves, as block-actions-popover.js
// does: src/handwriting/board.js owns them and imports this module, never the
// reverse. The placement is that popover's too — under the anchor if there is
// room and over it if not, clamped to the viewport, re-placed on scroll.

let pageMenu = null;
let pageMenuFrame = 0;

export function isCanvasPageMenuOpen() {
  return Boolean(pageMenu);
}

export function closeCanvasPageMenu() {
  if (!pageMenu) return false;
  window.removeEventListener("resize", pageMenu.place);
  document.removeEventListener("scroll", pageMenu.onPageMenuScroll, true);
  document.removeEventListener("pointerdown", pageMenu.onPageMenuOutside, true);
  document.removeEventListener("keydown", pageMenu.onPageMenuKey, true);
  if (pageMenuFrame) {
    cancelAnimationFrame(pageMenuFrame);
    pageMenuFrame = 0;
  }
  pageMenu.anchor?.setAttribute("aria-expanded", "false");
  pageMenu.root.remove();
  pageMenu = null;
  return true;
}

function menuItem(action, label, { danger = false, disabled = false, title = label } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `canvas-page-menu-item${danger ? " is-danger" : ""}`;
  button.dataset.pageMenuAction = action;
  button.setAttribute("role", "menuitem");
  button.title = title;
  button.textContent = label;
  if (disabled) button.disabled = true;
  return button;
}

export function openCanvasPageMenu({
  anchor,
  page,
  total,
  onPageUp = () => {},
  onPageDown = () => {},
  onDuplicate = () => {},
  onSetup = () => {},
  onDelete = () => {},
  // This page alone as a PDF or a web page (src/export/run.js). Offered when
  // given; the Pages panel and the gap's "Page k ⋯" both give them.
  onExportPdf = null,
  onExportHtml = null
} = {}) {
  const onlyPage = total < 2;
  const items = [
    ["up", "Move up", { disabled: page <= 1, title: page <= 1 ? "This is the first page" : `Swap page ${page} with page ${page - 1}` }],
    ["down", "Move down", { disabled: page >= total, title: page >= total ? "This is the last page" : `Swap page ${page} with page ${page + 1}` }],
    ["duplicate", "Duplicate", { title: `A copy of page ${page}, right after it` }],
    ["setup", "Page setup…", { title: `Page ${page}'s size, paper and lines` }]
  ];
  if (onExportPdf) items.push(["export-pdf", "Export this page as PDF", { title: `Page ${page} alone, as a PDF, exactly as it looks` }]);
  if (onExportHtml) items.push(["export-html", "Export this page as a web page", { title: `Page ${page} alone, as one file that opens in any browser` }]);
  items.push(["delete", "Delete page", {
    danger: true,
    disabled: onlyPage,
    title: onlyPage ? "A canvas keeps at least one page" : `Delete page ${page} and everything on it`
  }]);
  const actions = {
    up: onPageUp,
    down: onPageDown,
    duplicate: onDuplicate,
    setup: onSetup,
    delete: onDelete,
    "export-pdf": onExportPdf,
    "export-html": onExportHtml
  };
  return openCanvasMenu({
    anchor,
    heading: `Page ${page} of ${total}`,
    items,
    onChoose: (action) => actions[action]?.()
  });
}

// The same small menu with any rows: `items` is [action, label, { danger,
// disabled, title }] and `onChoose(action)` is told which was pressed. The
// Pages panel's Export… is one (src/documents/canvas-pages-panel.js).
export function openCanvasMenu({ anchor, heading: headingText = "", items = [], onChoose = () => {} } = {}) {
  // A second press on the same button closes its menu.
  const again = pageMenu?.anchor === anchor;
  closeCanvasPageMenu();
  if (again || !anchor) return null;

  const root = document.createElement("div");
  root.className = "canvas-page-menu";
  root.setAttribute("role", "menu");
  if (headingText) root.setAttribute("aria-label", headingText);

  if (headingText) {
    const heading = document.createElement("div");
    heading.className = "canvas-page-menu-heading";
    heading.textContent = headingText;
    root.append(heading);
  }
  items.forEach(([action, label, options]) => root.append(menuItem(action, label, options)));
  document.body.appendChild(root);
  anchor.setAttribute("aria-expanded", "true");

  const place = () => {
    if (!anchor.isConnected) { closeCanvasPageMenu(); return; }
    const box = anchor.getBoundingClientRect();
    const size = root.getBoundingClientRect();
    const margin = 8;
    const below = box.bottom + 6;
    const top = below + size.height > window.innerHeight - margin
      ? Math.max(margin, box.top - size.height - 6)
      : below;
    // Right-aligned with the button, unless that would run off the left of
    // the screen (a thumbnail in the Pages panel, at the left edge).
    const left = Math.min(
      Math.max(margin, box.right - size.width < margin ? box.left : box.right - size.width),
      Math.max(margin, window.innerWidth - size.width - margin)
    );
    root.style.top = `${Math.round(top)}px`;
    root.style.left = `${Math.round(left)}px`;
  };

  // pointerdown, not click, and preventDefault — a press here must not travel
  // on to the paper underneath and start a stroke (see block-actions-popover).
  root.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.target.closest("[data-page-menu-action]");
    if (!button || button.disabled) return;
    choose(button.dataset.pageMenuAction);
  });
  // ...and the keyboard's Enter or Space, which is a click with no pointer.
  root.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const button = event.target.closest("[data-page-menu-action]");
    if (!button || button.disabled) return;
    choose(button.dataset.pageMenuAction);
  });

  function choose(action) {
    closeCanvasPageMenu();
    onChoose(action);
  }

  const onPageMenuScroll = () => {
    if (pageMenuFrame) return;
    pageMenuFrame = requestAnimationFrame(() => {
      pageMenuFrame = 0;
      place();
    });
  };
  // A press anywhere else closes it — but not the button that opened it, whose
  // own click toggles it (the `again` check above).
  const onPageMenuOutside = (event) => {
    if (root.contains(event.target) || anchor.contains(event.target)) return;
    closeCanvasPageMenu();
  };
  const onPageMenuKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeCanvasPageMenu();
    anchor.focus?.();
  };

  pageMenu = { root, anchor, place, onPageMenuScroll, onPageMenuOutside, onPageMenuKey };
  place();
  window.addEventListener("resize", place);
  document.addEventListener("scroll", onPageMenuScroll, true);
  document.addEventListener("pointerdown", onPageMenuOutside, true);
  document.addEventListener("keydown", onPageMenuKey, true);
  root.querySelector("[data-page-menu-action]:not([disabled])")?.focus({ preventScroll: true });
  return pageMenu;
}
