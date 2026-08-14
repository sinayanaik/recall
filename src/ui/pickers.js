// Two modal choosers that resolve to the user's answer: which folder a deck
// should go in, and which of notes/cards an export should contain.

import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { categoriesFromDecks, refreshKnownWebDeckCategories, webDeckCategories } from "../library/categories.js?v=__BUILD__";
import { normalizeDeckCategory, readKnownFolders } from "../library/folders.js?v=__BUILD__";
import { readLocalDeckIndex, setStatus } from "../main.js?v=__BUILD__";

export async function chooseDeckCategory(currentCategory = defaultDeckCategory) {
  try {
    await refreshKnownWebDeckCategories();
  } catch (error) {
    console.warn("Could not load deck categories", error);
  }

  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal";
    modal.setAttribute("aria-label", "Choose deck category");

    const shell = document.createElement("div");
    shell.className = "category-choice-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2>Deck Category</h2>
          <p>Choose an existing category or create a new one.</p>
        </div>
        <button type="button" data-category-cancel aria-label="Close category editor">&#215;</button>
      </div>
      <label class="category-choice-field">
        <span>Category</span>
        <select data-category-select></select>
      </label>
      <label class="category-choice-field" data-category-new-field hidden>
        <span>New category</span>
        <input type="text" data-category-new autocomplete="off" spellcheck="false">
      </label>
      <div class="category-choice-actions">
        <button type="button" data-category-cancel>Cancel</button>
        <button type="button" data-category-save>Apply</button>
      </div>
    `;

    const select = shell.querySelector("[data-category-select]");
    // Offer every folder that actually exists, not just the ones the cloud knows
    // about: the local library's own categories and the known-folder registry
    // (which is where empty folders live). Without these the picker was just
    // "Uncategorized" + "New category" whenever Supabase was unreachable or the
    // folder had only ever existed on this device — so choosing an existing
    // folder was impossible offline.
    categoriesFromDecks(readLocalDeckIndex(), [
      ...webDeckCategories,
      ...readKnownFolders(),
      currentCategory
    ]).forEach((category) => {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      select.appendChild(option);
    });
    const newOption = document.createElement("option");
    newOption.value = "__new__";
    newOption.textContent = "+ New category";
    select.appendChild(newOption);
    select.value = normalizeDeckCategory(currentCategory);

    const newField = shell.querySelector("[data-category-new-field]");
    const newInput = shell.querySelector("[data-category-new]");
    const cleanup = (value = null) => {
      modal.remove();
      resolve(value);
    };

    select.addEventListener("change", () => {
      newField.hidden = select.value !== "__new__";
      if (!newField.hidden) newInput.focus();
    });
    shell.querySelectorAll("[data-category-cancel]").forEach((button) => {
      button.addEventListener("click", () => cleanup(null));
    });
    shell.querySelector("[data-category-save]").addEventListener("click", () => {
      if (select.value === "__new__" && !newInput.value.trim()) {
        setStatus("Category cannot be empty.", "error");
        newInput.focus();
        return;
      }
      cleanup(normalizeDeckCategory(select.value === "__new__" ? newInput.value : select.value));
    });
    newInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        if (!newInput.value.trim()) {
          setStatus("Category cannot be empty.", "error");
          return;
        }
        cleanup(normalizeDeckCategory(newInput.value));
      }
      if (event.key === "Escape") cleanup(null);
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });

    modal.appendChild(shell);
    document.body.appendChild(modal);
    select.focus();
  });
}

// Asks Cards vs Notes before a bulk export (Export All / multi-select) runs —
// unlike the single active-deck view, which already has separate Export and
// Export Notes buttons, a bulk export otherwise has no way to say which one
// you actually wanted. Resolves "cards" | "notes" | null (cancelled).
export function chooseExportContent() {
  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal";
    modal.setAttribute("aria-label", "Choose what to export");

    const shell = document.createElement("div");
    shell.className = "category-choice-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2>Export</h2>
          <p>What would you like to export?</p>
        </div>
        <button type="button" data-export-content-cancel aria-label="Close">&#215;</button>
      </div>
      <div class="export-content-choices">
        <button type="button" class="export-content-choice" data-export-content="cards">
          <span class="export-content-choice-icon">&#128209;</span>
          <span>Cards</span>
        </button>
        <button type="button" class="export-content-choice" data-export-content="notes">
          <span class="export-content-choice-icon">&#128221;</span>
          <span>Notes</span>
        </button>
      </div>
      <div class="category-choice-actions">
        <button type="button" data-export-content-cancel>Cancel</button>
      </div>
    `;

    const cleanup = (value = null) => {
      modal.remove();
      resolve(value);
    };
    shell.querySelectorAll("[data-export-content-cancel]").forEach((button) => {
      button.addEventListener("click", () => cleanup(null));
    });
    shell.querySelectorAll("[data-export-content]").forEach((button) => {
      button.addEventListener("click", () => cleanup(button.dataset.exportContent));
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });

    modal.appendChild(shell);
    document.body.appendChild(modal);
    shell.querySelector(".export-content-choice")?.focus();
  });
}
