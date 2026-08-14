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

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
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
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.remove("is-visible");
    toast.classList.add("is-leaving");
    setTimeout(() => toast.remove(), 280);
  };
  const timer = setTimeout(dismiss, duration);
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

export function showPromptModal(title, hint, defaultValue, onConfirm, { placeholder = "" } = {}) {
  if (!el.promptModal) {
    // Native prompt has no placeholder, so surface the indicative name as the
    // (rare) fallback's default text.
    const result = prompt(title, defaultValue || placeholder);
    if (result !== null) onConfirm(result);
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
  };
  el.promptModalOkBtn.onclick = () => cleanup(true);
  el.promptModalCancelBtn.onclick = () => cleanup(false);
  el.promptModalInput.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); cleanup(true); }
    if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
  };
}
