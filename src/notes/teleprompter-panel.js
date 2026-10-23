// The teleprompter's surface: the reading band over the note, the bar at the
// foot of it, and the settings sheet the bar's ⚙ opens.
//
// Two teleprompters draw with it: the note's (src/notes/teleprompter.js) and
// the PDF's (src/documents/pdf-teleprompter.js). It is built for one `kind` at
// a time — the PDF's sheet has no type to set and a layout to choose instead —
// and there is only ever one: building it for the other kind first evicts the
// session that had it, through that session's own `evict` handler.
//
// What either does lives in its own module; this file only draws. It is
// handed two callbacks when it is built — action(name) for the bar's buttons
// and setting(key, value, { commit }) for the sheet — and it imports nothing of
// that module's, so the edge runs one way: the session reaches in to paint, the
// surface reaches back only through what it was given.
//
// ── Inside the stage, on purpose ───────────────────────────────────────────
//
// All three are children of the stage (#notesStage, or #documentStage for a
// PDF), which is already the positioned box the contents drawer is placed
// against (styles/11-chrome.css). So they leave with it: Cards, a PDF, the raw
// editor and Home all hide the notes stage, and none of them needs telling to
// take the teleprompter away with it.
//
// ── The band is never measured while the text moves ────────────────────────
//
// The raw editor once drew a band on its reading line and it was taken out
// because it was re-measured on every frame of every scroll, which made long
// notes stutter (the note above "No editor guides" in src/main.js). This band
// is positioned by four CSS variables over the note's box, written on a resize
// or a settings change and at no other time. The text scrolls under it; it
// never moves with the text.

// Every number in the sheet. `min`..`max` is only where the SLIDER runs — the
// comfortable range, so a drag is not a hunt — and the box beside it takes any
// value at all inside `floor`..`ceiling`, which are not taste but sense: no
// speed of nought, no width past the whole column, no band below the screen.
// `decimals` is how finely a typed value is kept. The session clamps stored
// values to the same, which is why this lives here, where both sides read it.
export const TELEPROMPTER_RANGES = {
  wpm: { label: "Speed", min: 60, max: 600, step: 10, floor: 1, ceiling: 5000, decimals: 0, unit: "wpm", less: "Slower", more: "Faster" },
  fontSize: { label: "Size", min: 12, max: 56, step: 1, floor: 4, ceiling: 400, decimals: 1, unit: "px", less: "Smaller", more: "Bigger" },
  lineHeight: { label: "Spacing", min: 1.2, max: 2.4, step: 0.1, floor: 0.8, ceiling: 6, decimals: 2, unit: "×", less: "Tighter", more: "Looser" },
  width: { label: "Width", min: 40, max: 100, step: 5, floor: 10, ceiling: 100, decimals: 0, unit: "%", less: "Narrower", more: "Wider" },
  bandPos: { label: "Height", min: 15, max: 60, step: 1, floor: 0, ceiling: 100, decimals: 0, unit: "%", less: "Higher", more: "Lower" },
  bandSize: { label: "Size", min: 1, max: 6, step: 0.5, floor: 0.5, ceiling: 20, decimals: 1, unit: "lines", less: "Thinner", more: "Thicker" },
  dim: { label: "Dim", min: 0, max: 80, step: 5, floor: 0, ceiling: 100, decimals: 0, unit: "%", less: "Less", more: "More" }
};

export const TELEPROMPTER_FONTS = [
  ["notes", "Same as Notes"],
  ["serif", "Serif"],
  ["sans", "Sans"],
  ["mono", "Mono"]
];

export const TELEPROMPTER_COUNTDOWNS = [0, 3, 5];

export const TELEPROMPTER_AUTO_RESUMES = [0, 3, 5, 10];

// The PDF's layout: find the columns on each page, or take the reader's word.
export const TELEPROMPTER_COLUMNS = [
  ["auto", "Auto"],
  ["one", "One"],
  ["two", "Two"]
];

// What the bar says at the end, per kind.
const END_TEXT = {
  notes: "End of the notes",
  pdf: "End of the PDF"
};

// After this long with the text moving and nobody near the bar, it fades back
// so it is not the brightest thing below the band.
const BAR_FADE_MS = 2500;

let teleprompterPanel = null;

function tpNode(tag, className, attributes = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.entries(attributes).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  });
  return node;
}

function tpButton(className, action, label, text, extra = {}) {
  return tpNode("button", `tp-btn ${className}`.trim(), {
    type: "button", "data-tp-action": action, title: label, "aria-label": label, text, ...extra
  });
}

// ── The sheet's rows ────────────────────────────────────────────────────────

// −, the slider, + and a box to type the number in: the pen panel's size row
// (src/handwriting/ink-popover.js), for the same reason — a slider alone is a
// poor way to move one step on a phone, and the steps are what people nudge —
// plus the box, for the exact number, or one past either end of the slider.
function tpRangeRow(key) {
  const range = TELEPROMPTER_RANGES[key];
  const row = tpNode("div", "tp-row");
  row.append(
    tpNode("span", "tp-row-label", { text: range.label }),
    tpNode("button", "tp-btn tp-step", { type: "button", "data-tp-step": key, "data-tp-dir": "-1", title: range.less, "aria-label": `${range.less} — ${range.label.toLowerCase()}`, text: "−" }),
    tpNode("input", "tp-slider", {
      type: "range", min: String(range.min), max: String(range.max), step: String(range.step),
      "data-tp-range": key, "aria-label": range.label
    }),
    tpNode("button", "tp-btn tp-step", { type: "button", "data-tp-step": key, "data-tp-dir": "1", title: range.more, "aria-label": `${range.more} — ${range.label.toLowerCase()}`, text: "+" }),
    tpRangeEntry(key, range)
  );
  return row;
}

function tpRangeEntry(key, range) {
  const entry = tpNode("label", "tp-entry");
  entry.append(tpNode("input", "tp-number", {
    type: "number", inputmode: "decimal", step: "any",
    min: String(range.floor), max: String(range.ceiling),
    "data-tp-number": key, "aria-label": `${range.label}${{ "%": " in percent", "×": " as a multiple of the text size" }[range.unit] ?? ` in ${range.unit}`}`
  }));
  entry.append(tpNode("span", "tp-unit", { text: range.unit }));
  return entry;
}

function tpChoiceRow(key, label, choices) {
  const row = tpNode("div", "tp-row tp-choice-row");
  const group = tpNode("div", "tp-choices", { role: "group", "aria-label": label });
  choices.forEach(([value, text]) => {
    group.append(tpNode("button", "tp-btn tp-choice", {
      type: "button", "data-tp-choice": key, "data-tp-choice-value": String(value), "aria-pressed": "false", text
    }));
  });
  row.append(tpNode("span", "tp-row-label", { text: label }), group);
  return row;
}

function tpSwitchRow(key, label, hint) {
  const button = tpNode("button", "tp-btn tp-switch-row", { type: "button", "data-tp-switch": key, "aria-pressed": "false" });
  const text = tpNode("span", "tp-switch-text", { text: label });
  if (hint) text.append(tpNode("span", "tp-switch-hint", { text: hint }));
  button.append(text, tpNode("span", "tp-switch", { "aria-hidden": "true" }));
  return button;
}

function tpSection(title, ...rows) {
  const section = tpNode("section", "tp-sheet-section");
  section.append(tpNode("h4", "tp-sheet-title", { text: title }), ...rows);
  return section;
}

function buildTeleprompterSheet(kind) {
  const sheetNode = tpNode("div", "tp-sheet", { role: "dialog", "aria-label": "Teleprompter settings", id: "teleprompterSheet" });
  sheetNode.hidden = true;
  const head = tpNode("div", "tp-sheet-head");
  head.append(
    tpNode("strong", "tp-sheet-heading", { text: "Teleprompter" }),
    tpButton("tp-sheet-close", "sheet-close", "Close the settings", "×")
  );
  const mine = tpNode("button", "tp-btn tp-use-mine", { type: "button", "data-tp-action": "use-my-speed" });
  mine.hidden = true;
  const body = tpNode("div", "tp-sheet-body");
  body.append(
    tpSection("Pace", tpRangeRow("wpm"), mine),
    kind === "pdf"
      ? tpSection("Layout", tpChoiceRow("columns", "Columns", TELEPROMPTER_COLUMNS),
        tpSwitchRow("zoomColumn", "Zoom to the column", "A column fills the width, and the view follows it"))
      : tpSection("Text", tpRangeRow("fontSize"), tpRangeRow("lineHeight"), tpRangeRow("width"),
        tpChoiceRow("font", "Font", TELEPROMPTER_FONTS)),
    tpSection("Reading band", tpRangeRow("bandPos"), tpRangeRow("bandSize"), tpRangeRow("dim"),
      tpSwitchRow("band", "Show the band", "A soft bar across the line to read")),
    tpSection("While it runs",
      tpChoiceRow("countdown", "Countdown", TELEPROMPTER_COUNTDOWNS.map((n) => [n, n ? `${n} s` : "Off"])),
      tpChoiceRow("autoResume", "Carry on by itself", TELEPROMPTER_AUTO_RESUMES.map((n) => [n, n ? `${n} s` : "Off"])),
      tpSwitchRow("focus", "Hide the header", "Focus mode while it runs"),
      tpSwitchRow("wake", "Keep the screen on", "So a phone does not dim mid-paragraph")),
    tpNode("button", "tp-btn tp-reset", { type: "button", "data-tp-action": "reset", text: "Reset to defaults" })
  );
  sheetNode.append(head, body);
  return { sheetNode, mine };
}

// ── The bar ─────────────────────────────────────────────────────────────────

function buildTeleprompterBar(kind) {
  const bar = tpNode("div", "tp-bar", { role: "toolbar", "aria-label": "Teleprompter" });
  const play = tpButton("tp-play", "play", "Pause (Space)", "");
  const playIcon = tpNode("span", "tp-play-ico", { "aria-hidden": "true" });
  const playLabel = tpNode("span", "tp-play-label");
  play.append(playIcon, playLabel);

  const speed = tpNode("div", "tp-speed");
  const readout = tpNode("span", "tp-speed-read");
  const wpm = tpNode("span", "tp-wpm");
  const left = tpNode("span", "tp-left");
  readout.append(wpm, left);
  speed.append(
    tpButton("tp-slower", "slower", "Slower (↓)", "−"),
    readout,
    tpButton("tp-faster", "faster", "Faster (↑)", "+")
  );

  // A PDF's type is the page's own; zooming is the pager's and the column's.
  const size = tpNode("div", "tp-size");
  size.append(
    tpButton("tp-smaller", "smaller", "Smaller text (−)", "A−"),
    tpButton("tp-bigger", "bigger", "Bigger text (+)", "A+")
  );
  size.hidden = kind === "pdf";

  const settings = tpButton("tp-settings", "settings", "Teleprompter settings", "⚙", { "aria-expanded": "false", "aria-controls": "teleprompterSheet" });
  const close = tpButton("tp-close", "exit", "Leave the teleprompter (Esc)", "✕");

  // What the bar says at the end of the note, in place of the controls.
  const end = tpNode("div", "tp-end");
  end.append(
    tpNode("span", "tp-end-text", { text: END_TEXT[kind] || END_TEXT.notes }),
    tpButton("tp-again", "again", "Start again from the top", "↺ From the top"),
    tpButton("tp-done", "exit", "Leave the teleprompter", "Done")
  );

  const status = tpNode("span", "tp-status", { "aria-live": "polite" });
  bar.append(play, speed, size, settings, close, end, status);
  return { bar, play, playLabel, wpm, left, settings, status };
}

function buildTeleprompterOverlay() {
  const overlayNode = tpNode("div", "tp-overlay", { "aria-hidden": "true" });
  const count = tpNode("div", "tp-countdown");
  count.hidden = true;
  overlayNode.append(
    tpNode("div", "tp-dim tp-dim-top"),
    tpNode("div", "tp-band"),
    tpNode("div", "tp-dim tp-dim-bottom"),
    count
  );
  return { overlayNode, count };
}

// ── Built and taken down ────────────────────────────────────────────────────

// A slider previews on every `input` and is kept on `change`. A typed number
// is taken on `change` alone — Enter, or leaving the box — so the text does not
// re-size under the reader at every digit of "28".
// A slider fires `input` for every pixel of a drag, and each preview re-lays
// out the whole note under the new type (and holds the reader's line), which
// is a full restyle of a book per event. One preview a frame is all the eye can
// see; the drag's own `change` lands the exact value at once.
let pendingSliderPreview = null;
let sliderPreviewFrame = 0;

function flushSliderPreview() {
  sliderPreviewFrame = 0;
  const pending = pendingSliderPreview;
  pendingSliderPreview = null;
  if (pending && teleprompterPanel) teleprompterPanel.handlers.setting(pending.key, pending.value, { commit: false });
}

function onSheetInput(event, commit) {
  if (!teleprompterPanel) return;
  const slider = event.target.closest?.("[data-tp-range]");
  if (slider) {
    const key = slider.dataset.tpRange;
    const box = teleprompterPanel.sheet.querySelector(`[data-tp-number="${key}"]`);
    if (box) box.value = slider.value;
    if (!commit) {
      pendingSliderPreview = { key, value: Number(slider.value) };
      if (!sliderPreviewFrame) sliderPreviewFrame = requestAnimationFrame(flushSliderPreview);
      return;
    }
    if (sliderPreviewFrame) cancelAnimationFrame(sliderPreviewFrame);
    sliderPreviewFrame = 0;
    pendingSliderPreview = null;
    teleprompterPanel.handlers.setting(key, Number(slider.value), { commit });
    return;
  }
  const box = event.target.closest?.("[data-tp-number]");
  if (!box || !commit) return;
  const value = Number(box.value);
  // An empty or unreadable box puts back what was there.
  if (box.value.trim() === "" || !Number.isFinite(value)) {
    box.value = box.dataset.tpShown || "";
    return;
  }
  teleprompterPanel.handlers.setting(box.dataset.tpNumber, value, { commit: true });
}

function onPanelClick(event) {
  if (!teleprompterPanel) return;
  wakeTeleprompterBar();
  const step = event.target.closest("[data-tp-step]");
  if (step) {
    const key = step.dataset.tpStep;
    const range = TELEPROMPTER_RANGES[key];
    // From the box, not the slider: the box holds the real value, which may be
    // past either end of the slider.
    const box = teleprompterPanel.sheet.querySelector(`[data-tp-number="${key}"]`);
    const current = Number(box?.dataset.tpShown);
    const next = Math.min(range.ceiling, Math.max(range.floor, current + Number(step.dataset.tpDir) * range.step));
    teleprompterPanel.handlers.setting(key, Math.round(next * 100) / 100, { commit: true });
    return;
  }
  const choice = event.target.closest("[data-tp-choice]");
  if (choice) {
    const raw = choice.dataset.tpChoiceValue;
    teleprompterPanel.handlers.setting(choice.dataset.tpChoice, /^\d+$/.test(raw) ? Number(raw) : raw, { commit: true });
    return;
  }
  const toggle = event.target.closest("[data-tp-switch]");
  if (toggle) {
    teleprompterPanel.handlers.setting(toggle.dataset.tpSwitch, toggle.getAttribute("aria-pressed") !== "true", { commit: true });
    return;
  }
  const button = event.target.closest("[data-tp-action]");
  if (button) teleprompterPanel.handlers.action(button.dataset.tpAction);
}

// `handlers.evict`, when given, is how the panel takes itself back from this
// session for the other kind: it should end the session (which removes the
// panel) without moving anything on a surface the reader is not looking at.
export function ensureTeleprompterPanel(stage, handlers, kind = "notes") {
  if (teleprompterPanel && teleprompterPanel.kind === kind && teleprompterPanel.stage === stage) {
    teleprompterPanel.handlers = handlers;
    return teleprompterPanel;
  }
  if (teleprompterPanel) {
    const previous = teleprompterPanel.handlers;
    if (previous !== handlers) previous?.evict?.();
    removeTeleprompterPanel();
  }
  const { overlayNode, count } = buildTeleprompterOverlay();
  const bar = buildTeleprompterBar(kind);
  const { sheetNode, mine } = buildTeleprompterSheet(kind);
  overlayNode.dataset.kind = kind;
  bar.bar.dataset.kind = kind;
  stage.append(overlayNode, bar.bar, sheetNode);
  teleprompterPanel = { ...bar, overlay: overlayNode, count, sheet: sheetNode, mine, stage, handlers, kind, fadeTimer: 0 };
  bar.bar.addEventListener("click", onPanelClick);
  sheetNode.addEventListener("click", onPanelClick);
  sheetNode.addEventListener("input", (event) => onSheetInput(event, false));
  sheetNode.addEventListener("change", (event) => onSheetInput(event, true));
  // The bar comes back to full strength the moment a pointer or the keyboard
  // is near it; CSS does the same for :hover and :focus-within, this re-arms
  // the fade so it does not drop away again under a finger about to press.
  bar.bar.addEventListener("pointerenter", wakeTeleprompterBar);
  bar.bar.addEventListener("focusin", wakeTeleprompterBar);
  return teleprompterPanel;
}

export function removeTeleprompterPanel() {
  if (!teleprompterPanel) return;
  clearTimeout(teleprompterPanel.fadeTimer);
  teleprompterPanel.overlay.remove();
  teleprompterPanel.bar.remove();
  teleprompterPanel.sheet.remove();
  teleprompterPanel = null;
}

// Anything the teleprompter drew. A press there is a press on its controls,
// never the reader interrupting the text.
export function teleprompterPanelContains(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!teleprompterPanel || !element) return false;
  return teleprompterPanel.bar.contains(element) || teleprompterPanel.sheet.contains(element) || teleprompterPanel.overlay.contains(element);
}

// ── Where the band is ───────────────────────────────────────────────────────

// `box` is the note's scrollport inside the stage, and `band` the band's top
// and height inside that: all in px, all measured by the session on a resize
// or a settings change. `bandLeft` and `bandWidth`, when given, narrow the band
// to one column of a PDF; without them it runs the width of the box.
export function placeTeleprompterBand({ top, left, width, height, bandTop, bandHeight, bandLeft = null, bandWidth = null, dim, showBand }) {
  if (!teleprompterPanel) return;
  const style = teleprompterPanel.overlay.style;
  style.setProperty("--tp-box-top", `${top}px`);
  style.setProperty("--tp-box-left", `${left}px`);
  style.setProperty("--tp-box-width", `${width}px`);
  style.setProperty("--tp-box-height", `${height}px`);
  style.setProperty("--tp-band-top", `${bandTop}px`);
  style.setProperty("--tp-band-height", `${bandHeight}px`);
  if (Number.isFinite(bandLeft) && Number.isFinite(bandWidth)) {
    style.setProperty("--tp-band-left", `${bandLeft}px`);
    style.setProperty("--tp-band-width", `${bandWidth}px`);
  } else {
    style.removeProperty("--tp-band-left");
    style.removeProperty("--tp-band-width");
  }
  style.setProperty("--tp-dim", `${dim}%`);
  teleprompterPanel.overlay.classList.toggle("has-band", Boolean(showBand));
}

// ── The sheet ───────────────────────────────────────────────────────────────

export function isTeleprompterSheetOpen() {
  return Boolean(teleprompterPanel && !teleprompterPanel.sheet.hidden);
}

export function openTeleprompterSheet() {
  if (!teleprompterPanel) return;
  teleprompterPanel.sheet.hidden = false;
  teleprompterPanel.settings.setAttribute("aria-expanded", "true");
  // Not painted while it was shut (see paintTeleprompterPanel), so brought up
  // to date as it opens.
  const model = teleprompterPanel.lastModel;
  if (model) paintTeleprompterSheet(model.settings, model.measuredWpm, model.wpm, model.fontSize);
}

export function closeTeleprompterSheet() {
  if (!teleprompterPanel || teleprompterPanel.sheet.hidden) return;
  teleprompterPanel.sheet.hidden = true;
  teleprompterPanel.settings.setAttribute("aria-expanded", "false");
}

export function toggleTeleprompterSheet() {
  if (isTeleprompterSheetOpen()) closeTeleprompterSheet();
  else openTeleprompterSheet();
}

// ── The fade ────────────────────────────────────────────────────────────────

export function wakeTeleprompterBar() {
  if (!teleprompterPanel) return;
  teleprompterPanel.bar.classList.remove("is-faded");
  clearTimeout(teleprompterPanel.fadeTimer);
  teleprompterPanel.fadeTimer = 0;
  if (teleprompterPanel.phase === "playing") {
    teleprompterPanel.fadeTimer = setTimeout(() => {
      // Not while the sheet is open: the reader is looking at the controls.
      if (teleprompterPanel?.phase === "playing" && teleprompterPanel.sheet.hidden) teleprompterPanel.bar.classList.add("is-faded");
    }, BAR_FADE_MS);
  }
}

// ── Painting ────────────────────────────────────────────────────────────────

const PLAY_FACES = {
  countdown: { icon: "▶", label: "Start now", title: "Start now (Space)" },
  playing: { icon: "❚❚", label: "", title: "Pause (Space)" },
  paused: { icon: "▶", label: "Resume", title: "Resume from here (Space)" },
  ended: { icon: "▶", label: "Resume", title: "Resume" }
};

// `model`: { phase, wpm, leftText, countdown, tucked, resumeProgress,
// settings, measuredWpm, statusText }.
export function paintTeleprompterPanel(model) {
  if (!teleprompterPanel) return;
  // Called four times a second by each teleprompter's watch, playing or paused,
  // and most of those calls describe exactly what is already on screen. A
  // repaint that changes nothing still dirties the bar and walks the sheet's
  // controls, so it is skipped — unless the sheet is open, where a control the
  // reader has just typed into may need putting back.
  const sheetOpen = !teleprompterPanel.sheet.hidden;
  const signature = JSON.stringify(model);
  if (signature === teleprompterPanel.painted && !sheetOpen) return;
  teleprompterPanel.painted = signature;
  teleprompterPanel.lastModel = model;
  const { phase } = model;
  const phaseChanged = teleprompterPanel.phase !== phase;
  teleprompterPanel.phase = phase;
  teleprompterPanel.bar.dataset.phase = phase;
  teleprompterPanel.overlay.dataset.phase = phase;
  teleprompterPanel.bar.classList.toggle("is-tucked", Boolean(model.tucked));
  teleprompterPanel.overlay.classList.toggle("is-tucked", Boolean(model.tucked));

  const face = PLAY_FACES[phase] || PLAY_FACES.paused;
  teleprompterPanel.play.querySelector(".tp-play-ico").textContent = face.icon;
  teleprompterPanel.playLabel.textContent = face.label;
  teleprompterPanel.play.title = face.title;
  teleprompterPanel.play.setAttribute("aria-label", face.label || "Pause");
  const progress = Number.isFinite(model.resumeProgress) ? Math.max(0, Math.min(1, model.resumeProgress)) : null;
  teleprompterPanel.play.classList.toggle("is-auto-resuming", progress != null);
  teleprompterPanel.play.style.setProperty("--tp-resume-progress", `${Math.round((progress || 0) * 360)}deg`);

  teleprompterPanel.wpm.textContent = `${model.wpm} wpm`;
  // Its room is kept when there is nothing to say: the bar is centred, and a
  // line that came and went made it change width — sliding ⚙ and ✕ sideways
  // under a pointer on its way to them.
  teleprompterPanel.left.textContent = model.leftText || "";
  teleprompterPanel.left.style.visibility = model.leftText ? "" : "hidden";

  teleprompterPanel.count.hidden = phase !== "countdown";
  if (phase === "countdown") teleprompterPanel.count.textContent = String(model.countdown || "");

  if (teleprompterPanel.status.textContent !== model.statusText) teleprompterPanel.status.textContent = model.statusText || "";

  if (phaseChanged) wakeTeleprompterBar();
  if (sheetOpen) paintTeleprompterSheet(model.settings, model.measuredWpm, model.wpm, model.fontSize);
}

function paintTeleprompterSheet(settings, measuredWpm, wpm, fontSize) {
  if (!teleprompterPanel || !settings) return;
  const values = { ...settings, wpm, fontSize };
  Object.keys(TELEPROMPTER_RANGES).forEach((key) => {
    const slider = teleprompterPanel.sheet.querySelector(`[data-tp-range="${key}"]`);
    // Not under the reader's thumb: rewriting a slider's value mid-drag makes
    // it jump back to wherever the last paint thought it was.
    if (slider && document.activeElement !== slider) slider.value = String(values[key]);
    // Nor under the reader's typing.
    const box = teleprompterPanel.sheet.querySelector(`[data-tp-number="${key}"]`);
    if (box) {
      box.dataset.tpShown = String(values[key]);
      if (document.activeElement !== box) box.value = String(values[key]);
    }
  });
  teleprompterPanel.sheet.querySelectorAll("[data-tp-choice]").forEach((button) => {
    const current = String(values[button.dataset.tpChoice]);
    button.setAttribute("aria-pressed", button.dataset.tpChoiceValue === current ? "true" : "false");
  });
  teleprompterPanel.sheet.querySelectorAll("[data-tp-switch]").forEach((button) => {
    button.setAttribute("aria-pressed", values[button.dataset.tpSwitch] ? "true" : "false");
  });
  teleprompterPanel.mine.hidden = !measuredWpm;
  if (measuredWpm) {
    teleprompterPanel.mine.textContent = `Use my reading speed (${measuredWpm} wpm)`;
    teleprompterPanel.mine.disabled = measuredWpm === wpm;
  }
}
