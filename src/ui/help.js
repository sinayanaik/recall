// The in-app Help & Guide modal.

import { lockPageScroll, unlockPageScroll } from "./overlays.js?v=__BUILD__";

export const helpModal = document.getElementById("helpModal");

export const helpBtn = document.getElementById("helpBtn");

export const helpModalCloseBtn = document.getElementById("helpModalCloseBtn");

export const helpModalCloseFootBtn = document.getElementById("helpModalCloseFootBtn");

export function openHelpModal() {
  if (!helpModal) return;
  helpModal.hidden = false;
  lockPageScroll();
}

export function closeHelpModal() {
  if (!helpModal) return;
  helpModal.hidden = true;
  unlockPageScroll();
}
