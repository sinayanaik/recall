// Status line, toasts, button spinners, and the confirm/prompt modals.
//
// Everything the app says to the user that is not a panel of its own.

import { el } from "../core/dom.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "./overlays.js?v=__BUILD__";

export function setStatus(message, type = "info") {
  el.statusText.textContent = message;
  el.statusText.classList.toggle("error", type === "error");
}

// ── Swipe to dismiss ──────────────────────────────────────────────────────
//
// A notification that can only be TAPPED away is a notification whose way out
// nobody on a phone guesses: every other one on the device leaves with a flick.
// Used by the toasts below and by the update banner, so the two pop-ups the app
// has behave the same under a finger.
//
// The node follows the finger sideways (or down, for `axis: "xy"` on a toast
// anchored to the bottom), fading as it goes, and leaves past ~35% of its width
// or on a flick; anything less springs back. A press that never moves past the
// intent distance is left alone, so it still lands as an ordinary click.
// Thresholds are swipeConfig's (src/cards/swipe.js), so a flick that turns a
// card turns a notification too.
const SWIPE_INTENT_PX = 12;
const SWIPE_FLICK_VELOCITY = 0.42; // px per ms
const SWIPE_FLICK_DISTANCE = 34;
const SWIPE_COMMIT_FRACTION = 0.35;

export function enableSwipeDismiss(node, { onDismiss, axis = "x", onHold = null, onRelease = null } = {}) {
  if (!node) return;
  let start = null;
  let dragging = false;
  let suppressClickUntil = 0;
  node.addEventListener("click", (event) => {
    if (Date.now() >= suppressClickUntil) return;
    event.stopPropagation();
    event.preventDefault();
  }, true);

  const reset = () => {
    node.classList.remove("is-dragging");
    node.style.transform = "";
    node.style.opacity = "";
  };

  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    // A press on a button inside (×, an action) is that button's, not a drag.
    if (event.target.closest?.("button") && event.target.closest("button") !== node) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId, lastX: event.clientX, lastY: event.clientY, lastT: event.timeStamp, vx: 0, vy: 0 };
    dragging = false;
    onHold?.();
  });

  node.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!dragging) {
      const sideways = Math.abs(dx) > SWIPE_INTENT_PX && Math.abs(dx) > Math.abs(dy);
      const downward = axis === "xy" && dy > SWIPE_INTENT_PX && dy > Math.abs(dx);
      if (!sideways && !downward) return;
      dragging = sideways ? "x" : "y";
      node.classList.add("is-dragging");
      try { node.setPointerCapture(event.pointerId); } catch (_) { /* already released */ }
    }
    const dt = Math.max(1, event.timeStamp - start.lastT);
    start.vx = (event.clientX - start.lastX) / dt;
    start.vy = (event.clientY - start.lastY) / dt;
    start.lastX = event.clientX;
    start.lastY = event.clientY;
    start.lastT = event.timeStamp;
    const travel = dragging === "x" ? dx : Math.max(0, dy);
    const span = dragging === "x" ? node.offsetWidth : node.offsetHeight * 2;
    node.style.transform = dragging === "x" ? `translateX(${dx}px)` : `translateY(${travel}px)`;
    node.style.opacity = String(Math.max(0.15, 1 - Math.abs(travel) / Math.max(1, span)));
  });

  const finish = (event) => {
    if (!start || event.pointerId !== start.id) return;
    const was = dragging;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const { vx, vy } = start;
    start = null;
    dragging = false;
    onRelease?.();
    if (!was) return;
    // Swallow the click this release may produce: the drag was the gesture, and
    // a tap-to-dismiss handler would otherwise fire on a spring-back.
    suppressClickUntil = Date.now() + 350;
    const commit = was === "x"
      ? Math.abs(dx) > node.offsetWidth * SWIPE_COMMIT_FRACTION
        || (Math.abs(vx) > SWIPE_FLICK_VELOCITY && Math.abs(dx) > SWIPE_FLICK_DISTANCE && Math.sign(vx) === Math.sign(dx))
      : dy > node.offsetHeight * 0.6 || (vy > SWIPE_FLICK_VELOCITY && dy > SWIPE_FLICK_DISTANCE);
    if (event.type === "pointercancel" || !commit) {
      reset();
      return;
    }
    node.classList.remove("is-dragging");
    node.classList.add("is-swiped");
    node.style.transform = was === "x"
      ? `translateX(${Math.sign(dx) * (node.offsetWidth + 40)}px)`
      : `translateY(${node.offsetHeight + 40}px)`;
    node.style.opacity = "0";
    onDismiss?.();
  };
  node.addEventListener("pointerup", finish);
  node.addEventListener("pointercancel", finish);
  // A press that wanders off without ever becoming a drag has no capture, so its
  // pointerup lands elsewhere — let it go here, or the hold would never end.
  node.addEventListener("pointerleave", (event) => {
    if (!start || dragging || event.pointerId !== start.id) return;
    start = null;
    onRelease?.();
  });
}

// How long a toast stays up. Long enough to READ: a fixed 2.6s was fine for
// "Saved" and cut a two-line sync error off mid-sentence.
//
// A confirmation is capped at four seconds: it sits over the foot of the
// screen, where the selection pill and the reading bars are, and a "Cloze
// added" still up ten seconds later was the thing the next press landed on.
// An error keeps the longer span — it is the one worth reading to the end.
const TOAST_MAX_VISIBLE = 3;
function toastDuration(message, type) {
  if (type === "error") return Math.min(10000, 5000 + String(message).length * 30);
  return Math.min(4000, 2600 + String(message).length * 20);
}

// ── Never on top of a control ──────────────────────────────────────────────
//
// The bars that sit at the foot of the screen: the selection pill (pinned
// there, or placed under a selection near the bottom), the highlight Adjust
// bar, and either teleprompter's bar. A toast over one of them took the press
// meant for its button (a tap on a toast dismisses it), so the button seemed
// to need pressing twice. The column is lifted clear of whichever is up in the
// lower half of the screen, measured once per toast.
const BOTTOM_BAR_SELECTOR = ".selection-float, .highlight-adjust-bar, .tp-bar";
const TOAST_BASE_BOTTOM_PX = 56;

function liftToastsClearOfBars(container) {
  // Placement only: a toast must show whatever this finds (or fails to).
  try {
    container.style.setProperty("--toast-lift", `${measureToastLift()}px`);
  } catch (_) { /* the default bottom it always had */ }
}

function measureToastLift() {
  let lift = 0;
  const viewport = window.innerHeight || document.documentElement.clientHeight || 0;
  document.querySelectorAll(BOTTOM_BAR_SELECTOR).forEach((bar) => {
    if (bar.hidden || bar.closest("[hidden]")) return;
    const rect = bar.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.top >= viewport) return;
    // A bar stepping aside keeps its box (the touch bar while the view scrolls
    // or its selection is off screen: visibility hidden, opacity 0). Nothing
    // there to press, so nothing to lift the toasts over — lifting anyway put
    // them in the middle of the page, under the next stroke of a pen.
    const style = getComputedStyle(bar);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return;
    // Only bars that live at the foot: anything higher is not in the way.
    if (viewport - rect.top > viewport * 0.5) return;
    lift = Math.max(lift, viewport - rect.top + 8 - TOAST_BASE_BOTTOM_PX);
  });
  return Math.max(0, Math.round(lift));
}

// Transient toast notification, anchored bottom-centre (styles/84-toasts.css),
// used to confirm that web-sync actions (sync, load, delete, rename, export,
// quick note) actually completed — visible regardless of where the triggering
// button lives. Tap ×, tap the toast or swipe it away to dismiss.
//
// `action`: { label, onClick } puts a button on it. A toast with an action is
// asking the reader to DO something, so it stays until it is answered or
// dismissed rather than timing out underneath them.
export function showToast(message, type = "success", { action = null } = {}) {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }

  // ── One message, one toast ────────────────────────────────────────────────
  //
  // Saying a thing five times does not make it five facts. Every caller here is
  // some background loop reporting a condition, and a condition that persists
  // is reported by more than one of them — so an identical message already on
  // screen is the SAME event arriving again, not news. It renews the one that
  // is up (the condition is still true, so it should stay visible for its full
  // span) instead of stacking a duplicate.
  //
  // Defence in depth, deliberately. The signed-out storm that prompted this had
  // its own cause and its own fix in reportBackgroundSyncProblem; this is the
  // floor that stops the NEXT such loop from filling the screen, wherever it
  // turns out to live.
  const existing = [...container.querySelectorAll(".toast")]
    .find((node) => node.dataset.message === message && !node.classList.contains("is-leaving"));
  if (existing) {
    existing.dispatchEvent(new CustomEvent("toast-renew"));
    return;
  }

  // Three at most. A fourth pushes the oldest out rather than growing a column
  // that climbs up over whatever the reader was doing. Plain confirmations go
  // first: one with an action button is still waiting on an answer.
  const live = [...container.querySelectorAll(".toast:not(.is-leaving)")];
  const evictable = [...live.filter((node) => !node.classList.contains("has-action")),
    ...live.filter((node) => node.classList.contains("has-action"))];
  for (const old of evictable.slice(0, Math.max(0, live.length - (TOAST_MAX_VISIBLE - 1)))) {
    old.dispatchEvent(new CustomEvent("toast-dismiss"));
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.dataset.message = message;
  const icon = type === "error" ? "✕" : type === "info" ? "ℹ" : "✓";
  const iconEl = document.createElement("span");
  iconEl.className = "toast-icon";
  iconEl.setAttribute("aria-hidden", "true");
  iconEl.textContent = icon;
  const msgEl = document.createElement("span");
  msgEl.className = "toast-msg";
  msgEl.textContent = message;
  toast.append(iconEl, msgEl);
  if (action?.label) {
    toast.classList.add("has-action");
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "toast-action";
    actionBtn.textContent = action.label;
    actionBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      dismiss();
      try { action.onClick?.(); } catch (error) { console.warn("Toast action failed", error); }
    });
    toast.append(actionBtn);
  }
  // A real button, unlike the ✕ status icon on an error, which only ever LOOKED
  // like one.
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.title = "Dismiss";
  closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss();
  });
  toast.append(closeBtn);
  liftToastsClearOfBars(container);
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("is-visible"));

  const duration = toastDuration(message, type);
  let timer = 0;
  let toastHovered = false;
  let toastFingerDown = false;
  const dismiss = () => {
    clearTimeout(timer);
    if (toast.classList.contains("is-leaving")) return;
    toast.classList.remove("is-visible");
    toast.classList.add("is-leaving");
    setTimeout(() => toast.remove(), 280);
  };
  // `let` and a named restart above, so the renewal path can push the deadline
  // out without rebuilding the node — the toast the reader is mid-way through
  // reading must not blink. Not while it is held (a finger on it, or a mouse
  // over it): it must not leave out from under the hand that is reading it.
  const restart = () => {
    clearTimeout(timer);
    if (action?.label || toastHovered || toastFingerDown) return;
    timer = setTimeout(dismiss, duration);
  };
  restart();
  toast.addEventListener("toast-renew", restart);
  toast.addEventListener("toast-dismiss", dismiss);
  toast.addEventListener("click", dismiss);
  // Mouse only: a touch fires enter on the tap and leave only when something
  // ELSE is touched, which would pin a sprung-back toast on screen.
  toast.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse") return;
    toastHovered = true;
    clearTimeout(timer);
  });
  toast.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse") return;
    toastHovered = false;
    restart();
  });
  enableSwipeDismiss(toast, {
    axis: "xy",
    onDismiss: dismiss,
    onHold: () => { toastFingerDown = true; clearTimeout(timer); },
    onRelease: () => { toastFingerDown = false; restart(); }
  });
}

export function setButtonLoading(btn, loading, text = "…") {
  if (!btn) return;
  if (loading) {
    btn._loadingOriginalText = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
  } else {
    if (btn._loadingOriginalText !== undefined) btn.textContent = btn._loadingOriginalText;
    btn.disabled = false;
  }
}

export function showConfirmModal(message, onConfirm, { confirmLabel = "Confirm", danger = false } = {}) {
  if (!el.confirmModal) return onConfirm();
  el.confirmModalMessage.textContent = message;
  el.confirmModalOkBtn.textContent = confirmLabel;
  el.confirmModalOkBtn.classList.toggle("is-danger", danger);
  el.confirmModal.hidden = false;
  lockPageScroll();
  const cleanup = (confirmed) => {
    el.confirmModal.hidden = true;
    unlockPageScroll();
    el.confirmModalOkBtn.onclick = null;
    el.confirmModalCancelBtn.onclick = null;
    if (confirmed) onConfirm();
  };
  el.confirmModalOkBtn.onclick = () => cleanup(true);
  el.confirmModalCancelBtn.onclick = () => cleanup(false);
}

// `onCancel` is optional and exists for callers that are AWAITING an answer —
// the [[ picker wraps this in a promise, and a modal that resolves only when
// confirmed would leave that promise pending forever on a dismissal.
export function showPromptModal(title, hint, defaultValue, onConfirm, { placeholder = "", onCancel = null } = {}) {
  if (!el.promptModal) {
    // Native prompt has no placeholder, so surface the indicative name as the
    // (rare) fallback's default text.
    const result = prompt(title, defaultValue || placeholder);
    if (result !== null) onConfirm(result);
    else onCancel?.();
    return;
  }
  el.promptModalTitle.textContent = title;
  el.promptModalHint.textContent = hint || "";
  el.promptModalHint.hidden = !hint;
  // An empty field with an indicative placeholder (e.g. "New Deck") — nothing to
  // clear before typing — instead of a concrete default the user must delete.
  el.promptModalInput.value = defaultValue || "";
  el.promptModalInput.placeholder = placeholder;
  el.promptModal.hidden = false;
  lockPageScroll();
  requestAnimationFrame(() => el.promptModalInput.focus());
  const cleanup = (confirmed) => {
    el.promptModal.hidden = true;
    unlockPageScroll();
    el.promptModalOkBtn.onclick = null;
    el.promptModalCancelBtn.onclick = null;
    el.promptModalInput.onkeydown = null;
    if (confirmed) onConfirm(el.promptModalInput.value);
    else onCancel?.();
  };
  el.promptModalOkBtn.onclick = () => cleanup(true);
  el.promptModalCancelBtn.onclick = () => cleanup(false);
  el.promptModalInput.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); cleanup(true); }
    if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
  };
}
