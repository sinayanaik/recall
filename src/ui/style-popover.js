// A section's own style controls, in a small popover on that section's ◐.
//
// Each part of the app (Cards, Notes, the Highlights pane, highlights in the
// text, the note window, the contents drawer, PDFs, Canvas, All Cards, Quick
// Notes, Home, My Files) has its controls here, reached from a button in its own
// chrome, rather than as one of ~70 rows in a panel opened from the ☰ drawer.
// The ☰ drawer keeps the Theme & App panel for what is true of the whole app.
//
// The controls themselves are built and wired by src/ui/style-settings.js
// (buildStyleScope, wireStyleHost) — the same builder and the same listeners as
// the panel's — so a field behaves the same from wherever it is reached. What
// lives here is only the floating: where it goes, how it gets out of the way, and
// that there is only ever one.
//
// Placement is the block style popover's (src/documents/block-style-bar.js,
// openBlockStylePopover): under the anchor if it fits, over it if not, clamped
// to the viewport, re-placed once per frame on scroll. On a narrow screen it is a
// sheet along the bottom instead, which is where a thumb is and where the
// keyboard does not cover the field being typed in (--kb-inset).

import { state } from "../core/state.js?v=__BUILD__";
import { buildStyleProfileToggle, buildStyleScope, detectStyleProfile, registerStyleHost, unregisterStyleHost, updateStyleControls, wireStyleHost } from "./style-settings.js?v=__BUILD__";
import { styleScopeById } from "./style-schema.js?v=__BUILD__";
import { STYLE_ICON_SVG } from "./style-icon.js?v=__BUILD__";

let sectionPop = null;
let placeFrame = 0;

// Set by src/main.js, so this module needs to import neither the panel (which
// imports this one) nor the other popovers it has to shut.
let openAppPanel = () => {};
let siblingClosers = [];

export function setOpenAppStyleHandler(fn) {
  openAppPanel = typeof fn === "function" ? fn : () => {};
}

export function setSectionStyleSiblings(closers) {
  siblingClosers = Array.isArray(closers) ? closers.filter((fn) => typeof fn === "function") : [];
}

export function isSectionStyleOpen(scope = null) {
  return Boolean(sectionPop && (!scope || sectionPop.scope === scope));
}

export function openSectionStyleScope() {
  return sectionPop?.scope || null;
}

// A narrow screen gets the sheet. The width, not the style profile: a desktop
// window dragged narrow has no room for a floating box either.
function wantsSheet() {
  return window.matchMedia?.("(max-width: 640px)")?.matches ?? window.innerWidth <= 640;
}

export function closeSectionStyle() {
  if (!sectionPop) return false;
  const { root, anchor, place, onScroll, onPointerDown } = sectionPop;
  window.removeEventListener("resize", place);
  document.removeEventListener("scroll", onScroll, true);
  document.removeEventListener("pointerdown", onPointerDown, true);
  if (placeFrame) {
    cancelAnimationFrame(placeFrame);
    placeFrame = 0;
  }
  unregisterStyleHost(root);
  root.remove();
  document.body.classList.remove("style-pop-open");
  anchor?.setAttribute?.("aria-expanded", "false");
  sectionPop = null;
  return true;
}

function buildPopover(scope) {
  const info = styleScopeById[scope] || { label: scope };
  const root = document.createElement("div");
  root.className = "style-pop";
  root.dataset.styleScope = scope;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", `Style: ${info.label}`);
  root.tabIndex = -1;

  const head = document.createElement("div");
  head.className = "style-pop-head";
  const title = document.createElement("h2");
  title.className = "style-pop-title";
  title.innerHTML = STYLE_ICON_SVG;
  title.append(` ${info.label}`);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-button style-pop-close";
  close.dataset.stylePopClose = "";
  close.setAttribute("aria-label", "Close");
  close.title = "Close";
  close.textContent = "×";
  head.append(title, close);

  const body = document.createElement("div");
  body.className = "style-pop-body";
  body.appendChild(buildStyleProfileToggle({ compact: true }));
  // The pen bar keeps its own settings, per tab (src/storage/ink-prefs.js):
  // said here so nobody looks for the pen's colour among the text sizes.
  if (scope === "document" || scope === "handwriting") {
    const note = document.createElement("p");
    note.className = "style-pop-note";
    note.textContent = "The pen, highlighter, Text tool and sticky notes are styled from the chip on the pen's bar.";
    body.appendChild(note);
  }
  body.appendChild(buildStyleScope(scope));

  const foot = document.createElement("div");
  foot.className = "style-pop-foot";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "style-pop-reset";
  reset.dataset.styleResetScope = scope;
  reset.textContent = "Reset this section";
  reset.title = `Put every ${info.label} control back to its default`;
  const app = document.createElement("button");
  app.type = "button";
  app.className = "style-pop-app";
  app.dataset.stylePopApp = "";
  app.textContent = "Theme & App…";
  app.title = "Theme, app-wide sizes, Density and sync";
  foot.append(reset, app);

  root.append(head, body, foot);
  return root;
}

// Open `scope`'s controls next to `anchor` (or as a sheet, or centred when there
// is nothing on screen to anchor to). Pressing the same ◐ again shuts it.
export function toggleSectionStyle(scope, anchor = null) {
  if (sectionPop && sectionPop.scope === scope && (!anchor || sectionPop.anchor === anchor)) {
    closeSectionStyle();
    return null;
  }
  return openSectionStyle(scope, anchor);
}

export function openSectionStyle(scope, anchor = null) {
  if (!styleScopeById[scope] || scope === "app") {
    openAppPanel();
    return null;
  }
  closeSectionStyle();
  siblingClosers.forEach((fn) => {
    try { fn(); } catch (error) { console.warn("Could not close a popover before the style popover", error); }
  });

  // The controls edit what is on this screen, like the panel does on open.
  state.styleEditProfile = detectStyleProfile();
  state.styleEditProfileFollowsDevice = true;

  const root = buildPopover(scope);
    root.classList.toggle("is-sheet", wantsSheet());
  root.classList.toggle("is-centred", !wantsSheet() && (!anchor || !anchor.isConnected));
  document.body.appendChild(root);
  document.body.classList.add("style-pop-open");
  registerStyleHost(root);
  wireStyleHost(root);
  updateStyleControls();

  const place = () => {
    if (!sectionPop) return;
    if (root.classList.contains("is-sheet") || root.classList.contains("is-centred")) {
      root.style.top = "";
      root.style.left = "";
      return;
    }
    if (!anchor.isConnected || !anchor.getClientRects().length) { closeSectionStyle(); return; }
    const box = anchor.getBoundingClientRect();
    const size = root.getBoundingClientRect();
    const margin = 8;
    const below = box.bottom + margin;
    const top = below + size.height > window.innerHeight - margin
      ? Math.max(margin, box.top - size.height - margin)
      : below;
    // Right-aligned with the anchor where it can be: most ◐ sit at the right
    // end of a head, and a box that grew rightward from there would be clamped
    // straight back over the button that opened it.
    const left = Math.min(
      Math.max(margin, box.right - size.width),
      Math.max(margin, window.innerWidth - size.width - margin)
    );
    root.style.top = `${Math.round(top)}px`;
    root.style.left = `${Math.round(left)}px`;
  };

  const onScroll = (event) => {
    // A scroll INSIDE the popover is the reader reaching its lower fields.
    if (root.contains(event.target)) return;
    if (placeFrame) return;
    placeFrame = requestAnimationFrame(() => {
      placeFrame = 0;
      place();
    });
  };

  // A press anywhere else shuts it — but not the press on its own ◐ (which
  // toggles it, in its own click), and not one in the confirm dialog that
  // "Reset this section" opens over it.
  const onPointerDown = (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (root.contains(target)) return;
    if (anchor && anchor.contains?.(target)) return;
    if (target.closest?.("#confirmModal")) return;
    closeSectionStyle();
  };

  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-style-pop-close]")) { closeSectionStyle(); return; }
    if (event.target.closest("[data-style-pop-app]")) {
      closeSectionStyle();
      openAppPanel();
    }
  });

  // Escape from anywhere inside, including from a box being typed in — the key
  // map in src/main.js stands down for a press inside an <input>, as it must.
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    const back = anchor;
    closeSectionStyle();
    back?.focus?.({ preventScroll: true });
  });

  sectionPop = { scope, root, anchor, place, onScroll, onPointerDown };
  anchor?.setAttribute?.("aria-expanded", "true");
  place();
  window.addEventListener("resize", place);
  document.addEventListener("scroll", onScroll, true);
  // Next tick: the press that opened it is still being dispatched.
  setTimeout(() => {
    if (sectionPop?.root === root) document.addEventListener("pointerdown", onPointerDown, true);
  }, 0);
  // Focus the box, not its first field: on a phone a focused field is a keyboard
  // over half of what was just opened.
  root.focus({ preventScroll: true });
  return sectionPop;
}

// The panel's "Section styles" list: shut the panel, then open that section on
// its own ◐ if one is on screen, so the reader learns where it lives.
export function openSectionStyleFromPanel(scope, closePanel = () => {}) {
  closePanel();
  const anchor = findSectionStyleButton(scope);
  openSectionStyle(scope, anchor);
}

// The ◐ for `scope` that is on screen now, if any. Each carries
// data-style-scope-btn; the view row's one carries whichever of Cards / Notes /
// PDFs / Canvas is showing.
export function findSectionStyleButton(scope) {
  const candidates = document.querySelectorAll(`[data-style-scope-btn="${scope}"]`);
  for (const button of candidates) {
    if (button.getClientRects().length && !button.closest("[hidden]")) return button;
  }
  return null;
}
