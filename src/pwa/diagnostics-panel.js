// ☰ → Diagnostics: how the PDF reader is doing on THIS device.
//
// It used to be a section at the bottom of App Info — a monospaced readout
// with five buttons in one row under it, which on a phone ran off the side of
// the sheet ("Diagnostics: off" cut in half). It is its own sheet now, built
// for a phone first: two switches with a line saying what each does, the two
// tests as full-width buttons that say how long they take, and the readout
// last, with Copy beside its heading.
//
// What it reads and drives lives in src/documents/pdf-timing.js, which
// imports nothing; this module is only the sheet.

import { pdfDiagnosticsOn, pdfPicturePagesOn, pdfReaderTestAvailable, pdfTimingReport, runPdfReaderTest, runPdfSlowProbe, setPdfDiagnostics, setPdfPicturePages } from "../documents/pdf-timing.js?v=__BUILD__";
import { runningVersionLabel } from "./release-info.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

export const diagnosticsBtn = document.getElementById("diagnosticsBtn");
export const diagnosticsModal = document.getElementById("diagnosticsModal");
export const diagnosticsCloseBtn = document.getElementById("diagnosticsCloseBtn");
const diagnosticsRecordToggle = document.getElementById("diagnosticsRecordToggle");
const diagnosticsPicturesToggle = document.getElementById("diagnosticsPicturesToggle");
const diagnosticsReaderTestBtn = document.getElementById("diagnosticsReaderTestBtn");
const diagnosticsProbeBtn = document.getElementById("diagnosticsProbeBtn");
const diagnosticsCopyBtn = document.getElementById("diagnosticsCopyBtn");
const diagnosticsReadout = document.getElementById("diagnosticsReadout");

let diagnosticsTestRunning = false;

// The readout, with the app version on top so a pasted copy says which build
// it came from.
function diagnosticsText() {
  return `Recall ${runningVersionLabel()}\n${pdfTimingReport()}`;
}

function paintDiagnosticsPanel() {
  if (diagnosticsRecordToggle) diagnosticsRecordToggle.checked = pdfDiagnosticsOn();
  if (diagnosticsPicturesToggle) diagnosticsPicturesToggle.checked = pdfPicturePagesOn();
  const busy = diagnosticsTestRunning;
  [diagnosticsReaderTestBtn, diagnosticsProbeBtn, diagnosticsPicturesToggle].forEach((control) => {
    if (control) control.disabled = busy;
  });
  if (diagnosticsReadout) diagnosticsReadout.textContent = diagnosticsText();
}

export function openDiagnosticsPanel() {
  if (!diagnosticsModal) return;
  paintDiagnosticsPanel();
  if (diagnosticsModal.hidden) {
    diagnosticsModal.hidden = false;
    lockPageScroll();
  }
}

export function closeDiagnosticsPanel() {
  if (!diagnosticsModal || diagnosticsModal.hidden) return;
  diagnosticsModal.hidden = true;
  unlockPageScroll();
}

function toggleRecording() {
  setPdfDiagnostics(Boolean(diagnosticsRecordToggle?.checked));
  paintDiagnosticsPanel();
  showToast(pdfDiagnosticsOn() ? "Recording PDF timings until you turn this off" : "Diagnostics off: nothing is recorded", "info");
}

async function togglePicturePages() {
  await setPdfPicturePages(Boolean(diagnosticsPicturesToggle?.checked));
  paintDiagnosticsPanel();
}

// Both tests scroll the paper behind this sheet, so the sheet gets out of the
// way while one runs and comes back with the result at the end of the
// readout.
async function runDiagnosticsTest(run, startMessage) {
  if (diagnosticsTestRunning) return;
  if (!pdfReaderTestAvailable()) {
    showToast("Open a PDF on the PDF tab, then run this from ☰ → Diagnostics", "info");
    return;
  }
  diagnosticsTestRunning = true;
  closeDiagnosticsPanel();
  showToast(startMessage, "info");
  try {
    await run();
  } catch (error) {
    console.warn("A diagnostics test failed", error);
  } finally {
    diagnosticsTestRunning = false;
  }
  openDiagnosticsPanel();
  diagnosticsReadout?.scrollIntoView?.({ block: "end" });
}

export function copyDiagnostics() {
  const text = diagnosticsText();
  if (diagnosticsReadout) diagnosticsReadout.textContent = text;
  const selectIt = () => {
    // No clipboard API (an http:// LAN address is not a secure context): leave
    // the text selected so the system's own copy is one tap away.
    if (!diagnosticsReadout) return;
    const range = document.createRange();
    range.selectNodeContents(diagnosticsReadout);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    showToast("Selected — use your device's Copy");
  };
  if (!navigator.clipboard?.writeText) {
    selectIt();
    return;
  }
  navigator.clipboard.writeText(text).then(() => showToast("Diagnostics copied"), selectIt);
}

export function initDiagnosticsPanel() {
  diagnosticsBtn?.addEventListener("click", openDiagnosticsPanel);
  diagnosticsCloseBtn?.addEventListener("click", closeDiagnosticsPanel);
  diagnosticsRecordToggle?.addEventListener("change", toggleRecording);
  diagnosticsPicturesToggle?.addEventListener("change", () => { togglePicturePages(); });
  diagnosticsReaderTestBtn?.addEventListener("click", () => {
    runDiagnosticsTest(runPdfReaderTest, "Reader test: scrolling and zooming the open PDF — hands off for about 15 seconds");
  });
  diagnosticsProbeBtn?.addEventListener("click", () => {
    runDiagnosticsTest(runPdfSlowProbe, "Finding what's slow: scrolling the open PDF ten times — hands off for about 45 seconds");
  });
  diagnosticsCopyBtn?.addEventListener("click", copyDiagnostics);
  diagnosticsModal?.addEventListener("click", (event) => {
    if (event.target === diagnosticsModal) closeDiagnosticsPanel();
  });
  diagnosticsModal?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeDiagnosticsPanel();
    }
  });
}
