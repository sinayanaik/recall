// The question asked before any backup or package is made — of the whole
// library, one file, a folder, or a set of files and folders picked in My Files.
//
// One dialog for every scope, so the choices cannot drift between them:
//
//   • what goes in — the PDFs and Canvas pages, the pictures;
//   • the pictures from other websites — downloaded too (through the public
//     image proxy when a site refuses), and optionally saved into the library
//     itself, so the files stop depending on those sites at all
//     (src/images/keep-web-images.js);
//   • the offline viewer — index.html, to open the backup in any browser with
//     no Recall (src/backup/viewer-pack.js);
//   • .zip or .recall — the same file either way;
//   • for a file or a folder, who it is for: a backup for yourself keeps your
//     study progress; a copy for somebody else leaves it out.
//
// Papers and pictures are on by default because a package without them is a
// package of dead links and highlights on nothing.

import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { exportLibraryBackupZip, exportRecallPackage } from "./backup.js?v=__BUILD__";

export function defaultPackageTitle(titles = []) {
  const list = titles.filter(Boolean);
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} & ${list[1]}`;
  if (list.length > 2) return `${list[0]} and ${list.length - 1} more`;
  return "Recall files";
}

const countLabel = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// `scope` is "library", "folder" or "files"; `purpose` is "backup" or "share"
// (the default answer to "who is it for" — the reader can change it).
export function showBackupOptions({ scope = "files", count = 1, title = "", folder = "", purpose = "backup" } = {}) {
  return new Promise((resolve) => {
    const isLibrary = scope === "library";
    const what = isLibrary ? "your whole library"
      : scope === "folder" ? `the folder “${folder || title}” (${countLabel(count, "file")})`
        : countLabel(count, "file");
    const modal = document.createElement("section");
    modal.className = "category-choice-modal share-options-modal";
    modal.setAttribute("aria-label", isLibrary ? "Back up library" : "Back up or share");
    const shell = document.createElement("div");
    shell.className = "category-choice-shell share-options-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2>${isLibrary ? "Back up your library" : `Back up or share ${escapeHtml(what)}`}</h2>
          <p>One file with everything in it — cards, notes, PDFs, Canvas pages, highlights, pen and pictures — that opens in Recall, and in any browser on its own.</p>
        </div>
        <button type="button" data-share-cancel aria-label="Close">&#215;</button>
      </div>
      ${isLibrary ? "" : `
      <fieldset class="share-options-purpose">
        <legend>Who is it for?</legend>
        <label class="share-options-check"><input type="radio" name="share-purpose" value="backup" data-share-purpose="backup"${purpose === "share" ? "" : " checked"}> Me — a backup (keeps my study progress, bookmarks and reading places)</label>
        <label class="share-options-check"><input type="radio" name="share-purpose" value="share" data-share-purpose="share"${purpose === "share" ? " checked" : ""}> Someone else — a copy to share (no progress)</label>
      </fieldset>
      <label class="share-options-field">Name
        <input type="text" data-share-title maxlength="120" value="${escapeHtml(title)}">
      </label>`}
      <label class="share-options-check"><input type="checkbox" data-share-papers checked> Include the PDFs and Canvas pages</label>
      <label class="share-options-check"><input type="checkbox" data-share-images checked> Include the pictures</label>
      <label class="share-options-check share-options-sub"><input type="checkbox" data-share-web checked> Download pictures from other websites too, so the backup holds them, not just their links</label>
      <label class="share-options-check share-options-sub"><input type="checkbox" data-share-keep-web> Also save those web pictures into my files, so the files stop depending on the websites</label>
      <label class="share-options-check"><input type="checkbox" data-share-viewer checked> Add an offline viewer (index.html) — unzip the backup and open it in any browser to read every file, no Recall or internet needed</label>
      <label class="share-options-check"><input type="checkbox" data-share-zip> Save as .zip instead of .recall (the same file; a .zip opens with a double-click on a computer)</label>
      <p class="restore-note">${isLibrary
        ? "Restore it later from My Files → ⋯ → Restore backup. Nothing tied to your sign-in goes in the file."
        : "Nothing tied to your account goes in the file — no sign-in, no storage links. Opening it in Recall (My Files → ⋯ → Import) brings the files in; importing it again later offers to update them instead of duplicating them."}
      Web pictures a site refuses to hand over are fetched through wsrv.nl, a public image proxy, which sees only the picture's address.</p>
      <div class="category-choice-actions">
        <button type="button" data-share-cancel>Cancel</button>
        <button type="button" class="import-action-primary" data-share-confirm>${isLibrary ? "Back up" : "Create file"}</button>
      </div>
    `;
    const cleanup = (value) => {
      modal.remove();
      resolve(value);
    };
    const images = shell.querySelector("[data-share-images]");
    const web = shell.querySelector("[data-share-web]");
    const keepWeb = shell.querySelector("[data-share-keep-web]");
    // The web-picture choices only mean something when pictures go in at all.
    const syncImages = () => {
      web.disabled = !images.checked;
      keepWeb.disabled = !images.checked;
    };
    images.addEventListener("change", syncImages);
    syncImages();
    shell.querySelectorAll("[data-share-cancel]").forEach((button) => button.addEventListener("click", () => cleanup(null)));
    shell.querySelector("[data-share-confirm]").addEventListener("click", () => {
      const chosenPurpose = isLibrary ? "backup" : (shell.querySelector("[data-share-purpose]:checked")?.value || purpose);
      cleanup({
        scope,
        purpose: chosenPurpose,
        title: isLibrary ? "" : (String(shell.querySelector("[data-share-title]").value || "").trim() || title),
        includeDocuments: shell.querySelector("[data-share-papers]").checked,
        includeImages: images.checked,
        webImagesViaProxy: images.checked && web.checked,
        keepWebImages: images.checked && keepWeb.checked,
        includeViewer: shell.querySelector("[data-share-viewer]").checked,
        asZip: shell.querySelector("[data-share-zip]").checked,
        includeProgress: chosenPurpose === "backup"
      });
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });
    modal.appendChild(shell);
    document.body.appendChild(modal);
    shell.querySelector("[data-share-confirm]").focus?.();
  });
}

// Kept for anything that still asks the old question.
export function showShareOptions({ count = 1, title = "" } = {}) {
  return showBackupOptions({ scope: "files", count, title, purpose: "share" });
}

// Save the web pictures into the chosen files first, when asked, so the
// package written next holds the stored copies.
async function keepWebPicturesFirst(selections, options) {
  if (!options?.keepWebImages || !selections?.length) return;
  const { keepWebImagesWithFeedback } = await import("../images/keep-web-images.js?v=__BUILD__");
  await keepWebImagesWithFeedback(selections);
}

// Ask, then make the package. `titles` are the chosen files' names, for the
// default package name; the selections are what My Files hands every bulk
// action. `scope`/`folder` only change the wording.
export async function shareDecksAsPackage(selections, titles = [], { scope = "files", folder = "", purpose = "share" } = {}) {
  if (!selections?.length) return false;
  const options = await showBackupOptions({ scope, count: selections.length, title: folder || defaultPackageTitle(titles), folder, purpose });
  if (!options) return false;
  await keepWebPicturesFirst(selections, options);
  return exportRecallPackage(selections, {
    ...options,
    panelTitle: `${options.purpose === "backup" ? "Backing up" : "Packaging"} ${countLabel(selections.length, "file")}`
  });
}

// The same, worded as a backup: a file's or a folder's "Back up…".
export function backUpDecks(selections, titles = [], { scope = "files", folder = "" } = {}) {
  return shareDecksAsPackage(selections, titles, { scope, folder, purpose: "backup" });
}

// My Files → ⋯ → Back up library.
export async function backUpLibraryWithOptions() {
  const options = await showBackupOptions({ scope: "library" });
  if (!options) return false;
  if (options.keepWebImages) {
    const { allMyDeckSelections } = await import("../export/decks.js?v=__BUILD__");
    await keepWebPicturesFirst(await allMyDeckSelections(), options);
  }
  return exportLibraryBackupZip({
    includeImages: options.includeImages,
    includeDocuments: options.includeDocuments,
    includeViewer: options.includeViewer,
    webImagesViaProxy: options.webImagesViaProxy,
    asZip: options.asZip
  });
}
