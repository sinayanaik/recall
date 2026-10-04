// Whether the home dashboard is on screen, and who wants to know.
//
// A leaf on purpose. The dashboard itself (src/ui/home.js) reaches into the
// library, the deck loaders and half the panels; the things that only need to
// ask "is home showing?" — the update flow above all, which is registered from
// the boot path — must not drag that graph in behind them. So the flag, the
// show/hide and the hooks live here, and home.js plugs its renderer in.

let homeVisible = false;
// Opened on purpose (the ⌂ buttons) over a deck that is still loaded, as
// opposed to shown because nothing is open. Only the automatic kind gives way
// on its own when a deck appears; the deliberate kind stays until the reader
// picks something or goes back.
let homeExplicit = false;
let renderHook = null;
const shownHooks = [];

export function isHomeVisible() {
  return homeVisible;
}

// home.js registers the painter. Kept as a hook so showHome() can be called
// from anywhere without importing the dashboard.
export function setHomeRenderHook(fn) {
  renderHook = typeof fn === "function" ? fn : null;
}

// Things that want to run each time home comes on screen — the update flow
// uses it to apply a release that was waiting for a safe moment.
export function onHomeShown(fn) {
  if (typeof fn === "function") shownHooks.push(fn);
}

function syncHomeChrome() {
  document.documentElement.classList.toggle("is-home", homeVisible);
  for (const id of ["appHomeBtn", "homeBtn"]) {
    const button = document.getElementById(id);
    if (!button) continue;
    if (homeVisible) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

// Re-entrant calls are dropped: the painter refreshes the sync rows, and the
// sync rows' own updater asks for a repaint of home.
let painting = false;

export function renderHomeIfVisible() {
  if (!homeVisible || painting) return;
  painting = true;
  try { renderHook?.(); } catch (error) { console.warn("Could not paint the home screen", error); }
  finally { painting = false; }
}

// For the library's own writers: a sync or a delete can rewrite the deck index
// many times in a burst, and home only needs to be right once it settles.
let repaintTimer = 0;

export function scheduleHomeRender() {
  if (!homeVisible || repaintTimer) return;
  repaintTimer = setTimeout(() => {
    repaintTimer = 0;
    renderHomeIfVisible();
  }, 60);
}

export function showHome({ explicit = false } = {}) {
  const view = document.getElementById("homeView");
  if (!view) return;
  const wasVisible = homeVisible;
  if (!wasVisible || explicit) homeExplicit = explicit;
  homeVisible = true;
  view.hidden = false;
  syncHomeChrome();
  renderHomeIfVisible();
  if (wasVisible) return;
  view.scrollTop = 0;
  for (const fn of shownHooks) {
    try { fn(); } catch (error) { console.warn("Home hook failed", error); }
  }
}

export function hideHome() {
  if (!homeVisible) return;
  homeVisible = false;
  homeExplicit = false;
  const view = document.getElementById("homeView");
  if (view) view.hidden = true;
  syncHomeChrome();
}

// A deck is on screen now. Home steps aside if it was only standing in for "no
// deck open"; one the reader opened on purpose stays put — a background sync
// repainting the deck underneath is not a reason to yank it away.
export function releaseAutomaticHome() {
  if (homeVisible && !homeExplicit) hideHome();
}
