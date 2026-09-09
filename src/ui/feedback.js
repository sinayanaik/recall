// Status line, toasts, button spinners, and the confirm/prompt modals.
//
// Everything the app says to the user that is not a panel of its own.

import { el } from "../core/dom.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "./overlays.js?v=__BUILD__";

export function setStatus(message, type = "info") {
  el.statusText.textContent = message;
  el.statusText.classList.toggle("error", type === "error");
}

// Transient toast notification, anchored top-center, used to confirm that
// web-sync actions (sync, load, delete, rename, export, quick note) actually
// completed — visible regardless of where the triggering button lives.
export function showToast(message, type = "success") {
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
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("is-visible"));

  const duration = type === "error" ? 4200 : 2600;
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.remove("is-visible");
    toast.classList.add("is-leaving");
    setTimeout(() => toast.remove(), 280);
  };
  // `let` and a named restart above, so the renewal path can push the deadline
  // out without rebuilding the node — the toast the reader is mid-way through
  // reading must not blink.
  const restart = () => {
    clearTimeout(timer);
    timer = setTimeout(dismiss, duration);
  };
  restart();
  toast.addEventListener("toast-renew", restart);
  toast.addEventListener("click", dismiss);
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
