// "This is what will be uploaded" — the confirm step in front of every image
// upload.
//
// Pasting, dropping or picking an image used to upload it on the spot, with a
// toast that said "Optimizing image…" once it was already in flight. Nobody
// could see what the optimizing did, choose differently, or say no. This dialog
// is the answer: pick a level, see each file's real before and after size
// (they are real — the sizes shown ARE the encoded blobs, and confirming
// uploads exactly those), then confirm.
//
// One dialog per batch, never one per file: a bulk pick of twenty photos is one
// setting for all twenty. Cancelling inserts nothing and uploads nothing.

import { formatStorageBytes } from "../core/text.js?v=__BUILD__";
import {
  IMAGE_COMPRESSION_PRESETS, IMAGE_DIMENSION_MAX, IMAGE_DIMENSION_MIN,
  IMAGE_QUALITY_MAX, IMAGE_QUALITY_MIN, normalizeImageCompressionChoice,
  prepareImagesForUpload, readImageCompressionChoice, writeImageCompressionChoice
} from "./compress.js?v=__BUILD__";
import { setImagePickerActive } from "./upload.js?v=__BUILD__";

// How many files get a row of their own. Past this the list would be longer
// than the screen and slower to build than the encode it describes; the total
// line still covers every file.
export const COMPRESS_ROW_LIMIT = 12;

// Re-encoding on every pixel of slider travel would queue dozens of passes over
// every file. The sliders commit on release, and this catches the rest — a
// keyboard-driven slider fires `change` per arrow key.
export const COMPRESS_SLIDER_SETTLE_MS = 250;

// The row of level buttons, shared with the EPUB import's own preview modal
// (an import is a bulk upload of hundreds of figures, and it asks the same
// question once, in its own dialog, rather than opening a second one).
// `onPick` gets the chosen level; `select` paints which one is current.
export function imageCompressionLevels(onPick) {
  const element = document.createElement("div");
  element.className = "image-compress-levels";
  element.setAttribute("role", "radiogroup");
  element.setAttribute("aria-label", "Compression level");
  IMAGE_COMPRESSION_PRESETS.forEach((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-compress-level";
    button.dataset.compressLevel = preset.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    button.innerHTML = "<strong></strong><small></small>";
    button.querySelector("strong").textContent = preset.label;
    button.querySelector("small").textContent = preset.detail;
    button.addEventListener("click", () => onPick(normalizeImageCompressionChoice({ id: preset.id })));
    element.appendChild(button);
  });
  const select = (choice) => {
    element.querySelectorAll(".image-compress-level").forEach((button) => {
      const on = button.dataset.compressLevel === choice?.id;
      button.classList.toggle("is-selected", on);
      button.setAttribute("aria-checked", on ? "true" : "false");
    });
  };
  return { element, select };
}

export function compressionSavingLabel(fromBytes, toBytes) {
  if (!fromBytes || toBytes == null) return "";
  const saved = (fromBytes - toBytes) / fromBytes;
  if (Math.abs(saved) < 0.005) return "same size";
  // Capped at 99: a 6MB screenshot of flat colour really does come back as 8KB,
  // and rounding that to "−100%" reads as "the picture is gone" rather than as
  // "almost all of it was air".
  const delta = saved > 0 ? Math.min(99, Math.round(saved * 100)) : -Math.round(-saved * 100);
  return delta > 0 ? `−${delta}%` : `+${Math.abs(delta)}%`;
}

export function compressionSizeLabel(result) {
  const from = result.sourceFile?.size ?? 0;
  const to = result.file?.size ?? 0;
  if (result.skipped) return `${formatStorageBytes(from)} · ${result.reason}`;
  return `${formatStorageBytes(from)} → ${formatStorageBytes(to)} (${compressionSavingLabel(from, to)})`;
}

export function compressionDimensionLabel(result) {
  if (!result.sourceWidth || !result.sourceHeight) return "";
  const from = `${result.sourceWidth}×${result.sourceHeight}`;
  if (result.skipped || !result.width || (result.width === result.sourceWidth && result.height === result.sourceHeight)) return from;
  return `${from} → ${result.width}×${result.height}`;
}

// Resolves { choice, items: [{ source, upload }] }, or null if the upload was
// declined. `items` are in the order the files were given, so a caller can
// insert them where it meant to.
export function chooseImageCompression(files, { title = "", subtitle = "" } = {}) {
  const list = Array.from(files || []).filter((file) => file && file.type && file.type.startsWith("image/"));
  if (!list.length) return Promise.resolve(null);

  return new Promise((resolve) => {
    let choice = readImageCompressionChoice();
    const cache = new Map();
    const thumbnails = [];
    let prepared = null;
    let run = 0;
    let settle = null;

    const modal = document.createElement("section");
    modal.className = "category-choice-modal image-compress-modal";
    modal.setAttribute("aria-label", "Upload images");

    const shell = document.createElement("div");
    shell.className = "category-choice-shell image-compress-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2 class="image-compress-title"></h2>
          <p class="image-compress-subtitle"></p>
        </div>
        <button type="button" data-compress-cancel aria-label="Close">&#215;</button>
      </div>
      <details class="image-compress-advanced">
        <summary>Advanced</summary>
        <label class="image-compress-slider">
          <span>Quality</span>
          <input type="range" data-compress-quality
                 min="${Math.round(IMAGE_QUALITY_MIN * 100)}" max="${Math.round(IMAGE_QUALITY_MAX * 100)}" step="1">
          <output data-compress-quality-out></output>
        </label>
        <label class="image-compress-slider">
          <span>Longest side</span>
          <input type="range" data-compress-dimension
                 min="${IMAGE_DIMENSION_MIN}" max="${IMAGE_DIMENSION_MAX}" step="100">
          <output data-compress-dimension-out></output>
        </label>
      </details>
      <p class="image-compress-total" aria-live="polite"></p>
      <ul class="image-compress-list"></ul>
      <div class="category-choice-actions">
        <button type="button" data-compress-cancel>Cancel</button>
        <button type="button" class="import-action-primary" data-compress-confirm disabled>Upload</button>
      </div>
    `;

    const levels = imageCompressionLevels((picked) => {
      choice = picked;
      paintChoice();
      prepare();
    });
    shell.querySelector(".image-compress-advanced").before(levels.element);
    const rows = shell.querySelector(".image-compress-list");
    const totalLine = shell.querySelector(".image-compress-total");
    const confirmBtn = shell.querySelector("[data-compress-confirm]");
    const qualityInput = shell.querySelector("[data-compress-quality]");
    const qualityOut = shell.querySelector("[data-compress-quality-out]");
    const dimensionInput = shell.querySelector("[data-compress-dimension]");
    const dimensionOut = shell.querySelector("[data-compress-dimension-out]");

    shell.querySelector(".image-compress-title").textContent =
      title || (list.length === 1 ? "Upload image" : `Upload ${list.length} images`);
    shell.querySelector(".image-compress-subtitle").textContent =
      subtitle || (list.length === 1
        ? "Choose how much to compress it. Nothing is uploaded until you confirm."
        : "One setting for all of them. Nothing is uploaded until you confirm.");

    // ── Rows ────────────────────────────────────────────────────────────────
    // Built once and updated in place, so switching level does not rebuild the
    // list (or re-decode the thumbnails) under the reader's eyes.
    const rowFor = [];
    list.slice(0, COMPRESS_ROW_LIMIT).forEach((file) => {
      const row = document.createElement("li");
      row.className = "image-compress-row";
      const thumb = document.createElement("img");
      thumb.className = "image-compress-thumb";
      thumb.alt = "";
      const url = URL.createObjectURL(file);
      thumbnails.push(url);
      thumb.src = url;
      const text = document.createElement("div");
      text.className = "image-compress-row-text";
      const name = document.createElement("span");
      name.className = "image-compress-name";
      name.textContent = file.name || "image";
      name.title = name.textContent;
      const size = document.createElement("span");
      size.className = "image-compress-size";
      size.textContent = `${formatStorageBytes(file.size)} → …`;
      const dimensions = document.createElement("span");
      dimensions.className = "image-compress-dimensions";
      text.append(name, size, dimensions);
      row.append(thumb, text);
      rows.appendChild(row);
      rowFor.push({ size, dimensions });
    });
    if (list.length > COMPRESS_ROW_LIMIT) {
      const more = document.createElement("li");
      more.className = "image-compress-more";
      more.textContent = `…and ${list.length - COMPRESS_ROW_LIMIT} more`;
      rows.appendChild(more);
    }

    const paintChoice = () => {
      levels.select(choice);
      const quality = choice.quality ?? IMAGE_QUALITY_MAX;
      const dimension = choice.maxDimension ?? IMAGE_DIMENSION_MAX;
      qualityInput.value = String(Math.round(quality * 100));
      dimensionInput.value = String(dimension);
      qualityOut.textContent = choice.quality ? `${Math.round(quality * 100)}%` : "—";
      dimensionOut.textContent = choice.maxDimension ? `${dimension}px` : "not downscaled";
    };

    const paintResults = (results) => {
      let from = 0;
      let to = 0;
      results.forEach((result, index) => {
        result.sourceFile = list[index];
        from += list[index].size;
        to += result.file?.size || 0;
        const row = rowFor[index];
        if (!row) return;
        row.size.textContent = compressionSizeLabel(result);
        row.dimensions.textContent = compressionDimensionLabel(result);
      });
      const saving = compressionSavingLabel(from, to);
      totalLine.textContent = list.length === 1
        ? `${formatStorageBytes(from)} → ${formatStorageBytes(to)}${saving ? ` (${saving})` : ""}`
        : `${list.length} images · ${formatStorageBytes(from)} → ${formatStorageBytes(to)}${saving ? ` (${saving})` : ""}`;
    };

    const prepare = () => {
      const token = ++run;
      prepared = null;
      confirmBtn.disabled = true;
      prepareImagesForUpload(list, choice, {
        cache,
        cancelled: () => token !== run || !modal.isConnected,
        onProgress: (done, total) => {
          if (token !== run) return;
          if (done < total) totalLine.textContent = `Preparing ${done + 1} of ${total}…`;
        }
      }).then((finished) => {
        if (token !== run || !finished || !modal.isConnected) return;
        prepared = finished;
        paintResults(finished);
        confirmBtn.disabled = false;
      }).catch((error) => {
        if (token !== run) return;
        console.warn("Could not prepare the images for upload", error);
        totalLine.textContent = "Could not read these images — they'll be uploaded as they are.";
        prepared = list.map((file) => ({ file, skipped: true, reason: "kept as it is", sourceFile: file }));
        confirmBtn.disabled = false;
      });
    };

    const scheduleCustomPrepare = () => {
      choice = normalizeImageCompressionChoice({
        id: "custom",
        quality: Number(qualityInput.value) / 100,
        maxDimension: Number(dimensionInput.value)
      });
      paintChoice();
      clearTimeout(settle);
      settle = setTimeout(prepare, COMPRESS_SLIDER_SETTLE_MS);
    };

    [qualityInput, dimensionInput].forEach((input) => {
      // While dragging, only the readouts move — the encode waits for the value
      // to settle (see COMPRESS_SLIDER_SETTLE_MS).
      input.addEventListener("input", () => {
        qualityOut.textContent = `${qualityInput.value}%`;
        dimensionOut.textContent = `${dimensionInput.value}px`;
      });
      input.addEventListener("change", scheduleCustomPrepare);
    });

    const cleanup = (value) => {
      run += 1;
      clearTimeout(settle);
      document.removeEventListener("keydown", onKeyDown, true);
      thumbnails.forEach((url) => URL.revokeObjectURL(url));
      modal.remove();
      // Released only after the modal is gone: the flag is what stops the blur
      // it caused from closing the editor underneath it (see imagePickerActive).
      setImagePickerActive(false);
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup(null);
    };

    shell.querySelectorAll("[data-compress-cancel]").forEach((button) => {
      button.addEventListener("click", () => cleanup(null));
    });
    confirmBtn.addEventListener("click", () => {
      if (!prepared) return;
      writeImageCompressionChoice(choice);
      cleanup({
        choice,
        items: prepared.map((result, index) => ({ source: list[index], upload: result.file || list[index], result }))
      });
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });
    document.addEventListener("keydown", onKeyDown, true);

    // Held for the whole life of the dialog, not just the file picker that may
    // have opened it: this modal takes focus off the textarea being edited.
    setImagePickerActive(true);
    modal.appendChild(shell);
    document.body.appendChild(modal);
    paintChoice();
    prepare();
    confirmBtn.focus();
  });
}
