// "Share as .recall" — the question asked before a package is made.
//
// Three choices and a name. Papers and pictures are on by default because a
// package without them is a package of dead links and highlights on nothing;
// study progress is off by default because a package is usually for somebody
// else, and a friend opening your deck to find every card already marked known
// is a deck they cannot study.

import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { exportRecallPackage } from "./backup.js?v=__BUILD__";

export function defaultPackageTitle(titles = []) {
  const list = titles.filter(Boolean);
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} & ${list[1]}`;
  if (list.length > 2) return `${list[0]} and ${list.length - 1} more`;
  return "Recall decks";
}

export function showShareOptions({ count = 1, title = "" } = {}) {
  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal share-options-modal";
    modal.setAttribute("aria-label", "Share decks");
    const shell = document.createElement("div");
    shell.className = "category-choice-shell share-options-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2>Share ${count} deck${count === 1 ? "" : "s"} as a .recall file</h2>
          <p>One file with everything in it. Whoever opens it in Recall gets the decks as their own — cards, notes, PDFs, highlights, ink and pictures.</p>
        </div>
        <button type="button" data-share-cancel aria-label="Close">&#215;</button>
      </div>
      <label class="share-options-field">Name
        <input type="text" data-share-title maxlength="120" value="${escapeHtml(title)}">
      </label>
      <label class="share-options-check"><input type="checkbox" data-share-papers checked> Include the PDFs and handwritten notebooks</label>
      <label class="share-options-check"><input type="checkbox" data-share-images checked> Include the pictures</label>
      <label class="share-options-check"><input type="checkbox" data-share-progress> Include my study progress (known / review marks, bookmarks, reading positions)</label>
      <p class="restore-note">Nothing tied to your account goes in the file — no sign-in, no storage links. Importing the same file again later offers to update the decks instead of duplicating them.</p>
      <div class="category-choice-actions">
        <button type="button" data-share-cancel>Cancel</button>
        <button type="button" class="import-action-primary" data-share-confirm>Create file</button>
      </div>
    `;
    const cleanup = (value) => {
      modal.remove();
      resolve(value);
    };
    shell.querySelectorAll("[data-share-cancel]").forEach((button) => button.addEventListener("click", () => cleanup(null)));
    shell.querySelector("[data-share-confirm]").addEventListener("click", () => cleanup({
      title: String(shell.querySelector("[data-share-title]").value || "").trim() || title,
      includeDocuments: shell.querySelector("[data-share-papers]").checked,
      includeImages: shell.querySelector("[data-share-images]").checked,
      includeProgress: shell.querySelector("[data-share-progress]").checked
    }));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });
    modal.appendChild(shell);
    document.body.appendChild(modal);
    shell.querySelector("[data-share-confirm]").focus?.();
  });
}

// Ask, then make the package. `titles` are the chosen decks' names, for the
// default package name; the selections are what My Decks hands every bulk
// action.
export async function shareDecksAsPackage(selections, titles = []) {
  if (!selections?.length) return false;
  const options = await showShareOptions({ count: selections.length, title: defaultPackageTitle(titles) });
  if (!options) return false;
  return exportRecallPackage(selections, options);
}
