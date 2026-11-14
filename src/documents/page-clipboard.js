// Which clipboard a Ctrl+V on a page means: this app's, or the system's.
//
// Two things on a PDF's or a Canvas's page are copied into clipboards this app
// keeps for itself — lassoed handwriting (pdf-ink.js) and picked-up Blocks and
// shapes (canvas-selection.js) — because neither is anything the system
// clipboard can hold. A picture, though, only ever arrives on the system's:
// a screenshot, or one copied out of a web page or another app.
//
// Each Ctrl+V used to be claimed on keydown by whichever in-app clipboard was
// not empty, and the keydown's preventDefault meant the browser never fired the
// paste at all. So copying one line of ink, once, made every screenshot pasted
// afterwards come out as that line of ink again — "Ctrl+V for images is not
// reliable" was exactly this.
//
// Now the keydown only CLAIMS the paste (claimPagePaste), and the paste event
// decides, because it is the one place the system clipboard can be read:
//
//   • it holds this app's own token (written to it at copy time, below): the
//     in-app copy is the latest thing copied — paste it;
//   • it holds a picture and the in-app copy is known to be older — its token
//     was replaced, or the reader has been in another window since: the
//     picture wins, and the ordinary picture path (src/main.js) places it;
//   • it holds something else entirely, over a token we did write: something
//     newer was copied elsewhere that a page cannot take — nothing happens;
//   • otherwise (the token could not be written, and nothing says the system
//     clipboard is newer): the in-app copy, as before.
//
// A browser that fires no paste event for a press on a page that is not
// editable still gets the in-app paste: the pasteClaim runs by itself a moment later.
//
// A leaf: no imports, so pdf-ink.js and canvas-selection.js can both use it.

let lastInAppCopy = null;
let pendingPagePaste = null;

function freshInAppToken(kind) {
  return `recall-${kind}:${Math.random().toString(36).slice(2, 12)}`;
}

// Called when something is copied into one of this app's clipboards. Writes a
// token to the system clipboard so a later paste can tell whether anything was
// copied since; `wrote` says whether that worked (a browser that asks
// permission, or refuses outright, leaves it false).
export function noteInAppCopy(kind) {
  const copy = { kind, token: freshInAppToken(kind), onSystem: false, left: false };
  lastInAppCopy = copy;
  let wrote = Promise.resolve(false);
  try {
    const write = navigator.clipboard?.writeText?.(copy.token);
    if (write) wrote = write.then(() => { copy.onSystem = true; return true; }, () => false);
  } catch (_) { /* no clipboard to write: the rules above cope */ }
  return { token: copy.token, wrote };
}

// From a Ctrl+V keydown that an in-app clipboard would answer. `run` pastes it.
export function claimPagePaste(run) {
  if (pendingPagePaste) clearTimeout(pendingPagePaste.timer);
  const pasteClaim = { run, timer: 0 };
  pasteClaim.timer = setTimeout(() => settlePagePaste(pasteClaim, true), 0);
  pendingPagePaste = pasteClaim;
}

function settlePagePaste(pasteClaim, paste) {
  if (pendingPagePaste !== pasteClaim) return;
  clearTimeout(pasteClaim.timer);
  pendingPagePaste = null;
  if (paste) pasteClaim.run();
}

function clipboardHoldsImage(data) {
  if (!data) return false;
  for (const file of Array.from(data.files || [])) if (String(file?.type || "").startsWith("image/")) return true;
  for (const item of Array.from(data.items || [])) if (item?.kind === "file" && String(item.type || "").startsWith("image/")) return true;
  return false;
}

function pasteIntoField(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']"));
}

function onPagePaste(event) {
  const pasteClaim = pendingPagePaste;
  if (!pasteClaim) return;
  // A field took the press after all: the paste is the field's.
  if (pasteIntoField(event.target)) { settlePagePaste(pasteClaim, false); return; }
  const data = event.clipboardData;
  const text = data?.getData?.("text/plain") || "";
  const copy = lastInAppCopy;
  const ours = Boolean(copy && text === copy.token);
  const systemIsNewer = Boolean(copy && (copy.onSystem || copy.left)) && !ours;
  if (!ours && clipboardHoldsImage(data) && (systemIsNewer || !copy)) { settlePagePaste(pasteClaim, false); return; }
  if (!ours && copy?.onSystem) { settlePagePaste(pasteClaim, false); return; }
  event.preventDefault();
  event.stopImmediatePropagation();
  settlePagePaste(pasteClaim, true);
}

// The reader went to another window or app after copying here: whatever is on
// the system clipboard now may well be newer than the in-app copy.
function onLeftWindow() {
  if (lastInAppCopy) lastInAppCopy.left = true;
}

let pageClipboardInstalled = false;
export function initPageClipboard() {
  if (pageClipboardInstalled) return;
  pageClipboardInstalled = true;
  // On the window, capturing, so this runs before any paste listener on the
  // document — the picture path in src/main.js included.
  window.addEventListener("paste", onPagePaste, true);
  window.addEventListener("blur", onLeftWindow);
  document.addEventListener("visibilitychange", () => { if (document.hidden) onLeftWindow(); });
}
