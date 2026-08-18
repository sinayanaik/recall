// Which of setup / login / app / library-failed is on screen.
//
// One function owns the switch, so two can never be visible at once — and so
// the app shell stays hidden until boot has actually decided, which is what
// stops the logged-out UI painting and accepting clicks it cannot honour.

// One switch for the four mutually exclusive boot states, so a new one can't be
// added by remembering to hide three things somewhere else and forgetting one.
export function showBootScreen(which) {
  // The pre-JavaScript placeholder in index.html. This is the only place that
  // takes it down, for the same reason this function is the only place that
  // unhides a screen: whatever we are about to show IS the answer it was
  // standing in for, and clearing it anywhere else would open a window where
  // neither is on screen.
  try {
    window.__recallBootSkeleton?.clear();
  } catch (error) {
    console.warn("Could not clear the boot placeholder", error);
  }
  const overlays = {
    setup: "setupOverlay",
    login: "loginOverlay",
    library: "offlineBootOverlay"
  };
  for (const [name, id] of Object.entries(overlays)) {
    const node = document.getElementById(id);
    if (node) node.hidden = name !== which;
  }
  const shell = document.querySelector(".app-shell");
  if (shell) shell.hidden = which !== "app";
  const logout = document.getElementById("logoutBtn");
  if (logout) logout.hidden = which !== "app";
}

export function showSetupScreen() { showBootScreen("setup"); }

export function showLoginScreen() { showBootScreen("login"); }

export function showAuthenticatedUI() { showBootScreen("app"); }

export function showLibraryFailedScreen() { showBootScreen("library"); }
