// "How should it look?" — asked at the moment of exporting to PDF, Word or
// HTML, with the last answer already chosen so a reader who always wants the
// same look presses Export and is done.
//
// Two places ask: #exportThemeModal, in front of every ⇓ row that makes a
// styled file, and a row inside the highlights dialog, which already asks its
// own questions and should not open a second dialog on top of itself. Both are
// painted from EXPORT_THEMES (src/export/themes.js), so a look added there
// appears in both.

import { el } from "../core/dom.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";
import { EXPORT_THEMES, loadExportTheme, normalizeExportTheme, saveExportTheme } from "./themes.js?v=__BUILD__";

// One radio card per look: its name, what it looks like in a sentence, and a
// small drawing of a page in it (styles/82-export-themes.css).
export function paintExportThemeOptions(container, name, selected = loadExportTheme()) {
  if (!container) return;
  const chosen = normalizeExportTheme(selected);
  container.replaceChildren(...Object.values(EXPORT_THEMES).map((theme) => {
    const label = document.createElement("label");
    label.className = "export-theme-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = theme.id;
    input.checked = theme.id === chosen;
    const swatch = document.createElement("span");
    swatch.className = `export-theme-swatch is-${theme.id}`;
    swatch.setAttribute("aria-hidden", "true");
    swatch.innerHTML = "<i></i><i></i><i></i>";
    const text = document.createElement("span");
    text.className = "export-theme-text";
    const strong = document.createElement("strong");
    strong.textContent = theme.label;
    const small = document.createElement("small");
    small.textContent = theme.description;
    text.append(strong, small);
    label.append(input, swatch, text);
    return label;
  }));
}

export function chosenExportTheme(container) {
  return normalizeExportTheme(container?.querySelector("input[type=radio]:checked")?.value);
}

let settlePending = null;
let dialogWired = false;

function settleExportTheme(theme) {
  const resolve = settlePending;
  settlePending = null;
  if (el.exportThemeModal && !el.exportThemeModal.hidden) {
    el.exportThemeModal.hidden = true;
    unlockPageScroll();
  }
  if (theme) saveExportTheme(theme);
  resolve?.(theme);
}

function wireExportThemeDialog() {
  if (dialogWired) return;
  dialogWired = true;
  el.exportThemeCancelBtn?.addEventListener("click", () => settleExportTheme(null));
  el.exportThemeConfirmBtn?.addEventListener("click", () => settleExportTheme(chosenExportTheme(el.exportThemeOptions)));
  // Enter exports with what is chosen, from anywhere in the dialog — the radio
  // cards are the only thing in it that takes focus besides the two buttons.
  el.exportThemeModal?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.closest?.("button")) return;
    event.preventDefault();
    settleExportTheme(chosenExportTheme(el.exportThemeOptions));
  });
  // A click on the backdrop is a cancel, as it is for the app's other dialogs.
  el.exportThemeModal?.addEventListener("click", (event) => {
    if (event.target === el.exportThemeModal) settleExportTheme(null);
  });
}

export function isExportThemeDialogOpen() {
  return Boolean(el.exportThemeModal && !el.exportThemeModal.hidden);
}

export function cancelExportThemeDialog() {
  settleExportTheme(null);
}

// Resolves to the chosen look's id (and remembers it), or to null when the
// reader cancels. With no dialog in the page, the last look is the answer.
export function askExportTheme({ title = "Export style" } = {}) {
  if (!el.exportThemeModal || !el.exportThemeOptions) return Promise.resolve(loadExportTheme());
  wireExportThemeDialog();
  // A second ask while one is open replaces it; the first is a cancel.
  if (settlePending) settleExportTheme(null);
  paintExportThemeOptions(el.exportThemeOptions, "exportTheme");
  if (el.exportThemeTitle) el.exportThemeTitle.textContent = title;
  el.exportThemeModal.hidden = false;
  lockPageScroll();
  el.exportThemeOptions.querySelector("input:checked")?.focus();
  return new Promise((resolve) => { settlePending = resolve; });
}
