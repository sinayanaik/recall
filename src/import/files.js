// Getting importable text out of whatever the user dropped in: a file, a zip,
// a paste, or the sample deck.

import { el } from "../core/dom.js?v=__BUILD__";
import { ensureJsZip } from "../core/lib-loader.js?v=__BUILD__";
import { importEpubFile, isEpubName, isJsonName, isMarkdownName, isZipName, reportEpubImportCrash } from "./epub.js?v=__BUILD__";
import { sampleMarkdown } from "./sample.js?v=__BUILD__";
import { setPendingImportFolder, stageImportSources, stageMarkdownImport } from "./staging.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";

export async function collectMarkdownFromZip(input, prefix = "", depth = 0) {
  if (depth > 4) return [];

  const zip = await JSZip.loadAsync(input);
  const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
  const found = [];

  for (const entry of entries) {
    if (entry.dir) continue;

    const path = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (isMarkdownName(entry.name)) {
      found.push({
        name: path,
        text: await entry.async("text")
      });
      continue;
    }

    if (isZipName(entry.name)) {
      try {
        const nested = await entry.async("arraybuffer");
        found.push(...await collectMarkdownFromZip(nested, path, depth + 1));
      } catch (error) {
        console.warn("Nested zip could not be read", path, error);
      }
    }
  }

  return found;
}

// Pulls every Markdown document out of a zip (including nested zips) as its own
// import source, so a zipped export folder behaves exactly like selecting those
// files by hand.
export async function readZipSources(file) {
  if (!(await ensureJsZip())) {
    setStatus("Zip support did not load. Extract the zip and upload the .md files.", "error");
    return [];
  }
  const markdownFiles = await collectMarkdownFromZip(file);
  if (!markdownFiles.length) {
    setStatus(`No Markdown file found in ${file.name}, including nested zip files.`, "error");
    return [];
  }
  return markdownFiles.map((entry) => ({
    kind: "markdown",
    name: entry.name || file.name,
    markdown: entry.text
  }));
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}`)));
    reader.readAsText(file);
  });
}

// One picked file → zero or more import sources. Zips fan out; everything else
// is a single source. Never throws: an unreadable file is reported and skipped
// so one bad file can't sink a batch of twenty good ones.
export async function readImportSources(file) {
  if (isZipName(file.name) || /zip/i.test(file.type)) {
    try {
      return await readZipSources(file);
    } catch (error) {
      setStatus(`Could not read ${file.name}.`, "error");
      return [];
    }
  }

  let text;
  try {
    text = await readFileText(file);
  } catch (error) {
    setStatus(`Could not read ${file.name}.`, "error");
    return [];
  }

  if (isJsonName(file.name) || file.type === "application/json") {
    try {
      // A JSON export already records its own notes/cards split, so it needs no
      // analysis — only a destination.
      return [{ kind: "snapshot", name: file.name, payload: JSON.parse(text) }];
    } catch (error) {
      setStatus(`${file.name} is not readable Recall JSON.`, "error");
      return [];
    }
  }

  return [{ kind: "markdown", name: file.name, markdown: text }];
}

// Reads everything that was picked and stages it for review. `folderPath` files
// the resulting decks under that folder (the My Decks "Import here" buttons);
// null — every ordinary import — leaves them under their own category.
//
// Nothing is created here: every source except EPUB hands off to the review
// step, where you say whether the files become notes, cards, or both, and
// whether they land as separate decks, one merged deck, or the open one.
export async function loadFiles(fileList, folderPath = null) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  setPendingImportFolder(null);

  // An EPUB *is* a zip, and its "application/epub+zip" type matches the /zip/i
  // test, so it has to be split off before anything else looks at the list.
  const isEpub = (file) => isEpubName(file.name) || /epub/i.test(file.type);
  const epubs = files.filter(isEpub);
  const rest = files.filter((file) => !isEpub(file));

  // An EPUB becomes a whole folder of chapter decks behind its own preview
  // modal, so it can't share the review step. On its own (or several at once)
  // it runs that flow directly; mixed into a batch it is left out and named,
  // rather than silently dropped.
  if (epubs.length && !rest.length) {
    for (const file of epubs) {
      await importEpubFile(file, folderPath).catch(reportEpubImportCrash);
    }
    return;
  }

  if (files.length > 1) setStatus(`Reading ${files.length} files…`);
  const sources = [];
  for (const file of rest) {
    sources.push(...await readImportSources(file));
  }

  stageImportSources(sources, {
    folder: folderPath,
    skipped: epubs.map((file) => `${file.name} — import EPUBs on their own`)
  });
}

export function loadFile(file, folderPath = null) {
  return loadFiles(file ? [file] : [], folderPath);
}

export function loadSample() {
  stageMarkdownImport(sampleMarkdown, { name: "Sample flashcards", folder: null });
}

export function showImportSourceDrawer(which) {
  if (el.importUrlRow) el.importUrlRow.hidden = which !== "url";
  if (el.importPasteRow) el.importPasteRow.hidden = which !== "paste";
  if (el.importPasteSourceBtn) el.importPasteSourceBtn.classList.toggle("is-active", which === "paste");
  if (el.importUrlSourceBtn) el.importUrlSourceBtn.classList.toggle("is-active", which === "url");
  if (which === "paste") window.setTimeout(() => el.pasteMarkdownInput?.focus(), 0);
  if (which === "url") window.setTimeout(() => el.urlInput?.focus(), 0);
}

export function stagePastedMarkdown() {
  const markdown = el.pasteMarkdownInput?.value || "";
  if (!markdown.trim()) {
    setStatus("Paste some Markdown first.", "error");
    el.pasteMarkdownInput?.focus();
    return;
  }
  stageMarkdownImport(markdown, { name: "", folder: null });
}
