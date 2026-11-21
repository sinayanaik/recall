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
  onDelete = () => {}
} = {}) {
  // A second press on the same page's button closes its menu.
  const again = pageMenu?.anchor === anchor;
  closeCanvasPageMenu();
  if (again || !anchor) return null;

  const root = document.createElement("div");
  root.className = "canvas-page-menu";
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", `Page ${page} of ${total}`);

  const heading = document.createElement("div");
  heading.className = "canvas-page-menu-heading";
  heading.textContent = `Page ${page} of ${total}`;

  const onlyPage = total < 2;
  root.append(
    heading,
    menuItem("up", "Move up", { disabled: page <= 1, title: page <= 1 ? "This is the first page" : `Swap page ${page} with page ${page - 1}` }),
    menuItem("down", "Move down", { disabled: page >= total, title: page >= total ? "This is the last page" : `Swap page ${page} with page ${page + 1}` }),
    menuItem("duplicate", "Duplicate", { title: `A copy of page ${page}, right after it` }),
    menuItem("setup", "Page setup…", { title: `Page ${page}'s size, paper and lines` }),
    menuItem("delete", "Delete page", {
      danger: true,
      disabled: onlyPage,
      title: onlyPage ? "A canvas keeps at least one page" : `Delete page ${page} and everything on it`
    })
  );
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
    // Right-aligned with the button, which sits at the page's right edge.
    const left = Math.min(
      Math.max(margin, box.right - size.width),
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
    if (action === "up") onPageUp();
    else if (action === "down") onPageDown();
    else if (action === "duplicate") onDuplicate();
    else if (action === "setup") onSetup();
    else if (action === "delete") onDelete();
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
