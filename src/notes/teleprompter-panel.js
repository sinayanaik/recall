// The teleprompter's surface: the reading band over the note, the bar at the
// foot of it, and the settings sheet the bar's ⚙ opens.
//
// What it does lives in src/notes/teleprompter.js; this file only draws. It is
// handed two callbacks when it is built — action(name) for the bar's buttons
// and setting(key, value, { commit }) for the sheet — and it imports nothing of
// that module's, so the edge runs one way: the session reaches in to paint, the
// surface reaches back only through what it was given.
//
// ── Inside #notesStage, on purpose ─────────────────────────────────────────
//
// All three are children of the stage, which is already the positioned box the
// contents drawer is placed against (styles/11-chrome.css). So they leave with
// it: Cards, a PDF, the raw editor and Home all hide the stage, and none of them
// needs telling to take the teleprompter away with it.
//
// ── The band is never measured while the text moves ────────────────────────
//
// The raw editor once drew a band on its reading line and it was taken out
// because it was re-measured on every frame of every scroll, which made long
// notes stutter (the note above "No editor guides" in src/main.js). This band
// is positioned by four CSS variables over the note's box, written on a resize
// or a settings change and at no other time. The text scrolls under it; it
// never moves with the text.

// Every slider in the sheet. The session clamps stored values to these too,
// which is why they live here, where both sides can read them.
export const TELEPROMPTER_RANGES = {
  wpm: { label: "Speed", min: 60, max: 600, step: 10, unit: "wpm", less: "Slower", more: "Faster" },
  fontSize: { label: "Size", min: 12, max: 56, step: 1, unit: "px", less: "Smaller", more: "Bigger" },
  lineHeight: { label: "Spacing", min: 1.2, max: 2.4, step: 0.1, unit: "", less: "Tighter", more: "Looser" },
  width: { label: "Width", min: 40, max: 100, step: 5, unit: "%", less: "Narrower", more: "Wider" },
  bandPos: { label: "Height", min: 15, max: 60, step: 1, unit: "%", less: "Higher", more: "Lower" },
  dim: { label: "Dim", min: 0, max: 80, step: 5, unit: "%", less: "Less", more: "More" }
};

export const TELEPROMPTER_FONTS = [
  ["notes", "Same as Notes"],
  ["serif", "Serif"],
  ["sans", "Sans"],
  ["mono", "Mono"]
];

export const TELEPROMPTER_COUNTDOWNS = [0, 3, 5];

export const TELEPROMPTER_AUTO_RESUMES = [0, 3, 5, 10];

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

export function formatTeleprompterValue(key, value) {
  const range = TELEPROMPTER_RANGES[key];
  if (key === "lineHeight") return Number(value).toFixed(1);
  if (key === "dim" && !value) return "Off";
  return `${value}${range?.unit ? (range.unit === "%" ? "%" : ` ${range.unit}`) : ""}`;
}

// ── The sheet's rows ────────────────────────────────────────────────────────

// −, the slider, + and the value: the pen panel's size row
// (src/handwriting/ink-popover.js), for the same reason — a slider alone is a
// poor way to move one step on a phone, and the steps are what people nudge.
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
    tpNode("output", "tp-row-value", { "data-tp-value": key })
  );
  return row;
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

function buildTeleprompterSheet() {
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
    tpSection("Text", tpRangeRow("fontSize"), tpRangeRow("lineHeight"), tpRangeRow("width"),
      tpChoiceRow("font", "Font", TELEPROMPTER_FONTS)),
    tpSection("Reading band", tpRangeRow("bandPos"), tpRangeRow("dim"),
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

function buildTeleprompterBar() {
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

  const size = tpNode("div", "tp-size");
  size.append(
    tpButton("tp-smaller", "smaller", "Smaller text (−)", "A−"),
    tpButton("tp-bigger", "bigger", "Bigger text (+)", "A+")
  );

  const settings = tpButton("tp-settings", "settings", "Teleprompter settings", "⚙", { "aria-expanded": "false", "aria-controls": "teleprompterSheet" });
  const close = tpButton("tp-close", "exit", "Leave the teleprompter (Esc)", "✕");

  // What the bar says at the end of the note, in place of the controls.
  const end = tpNode("div", "tp-end");
  end.append(
    tpNode("span", "tp-end-text", { text: "End of the notes" }),
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

function onSheetInput(event, commit) {
  const slider = event.target.closest?.("[data-tp-range]");
  if (!slider || !teleprompterPanel) return;
  const key = slider.dataset.tpRange;
  const value = Number(slider.value);
  const output = teleprompterPanel.sheet.querySelector(`[data-tp-value="${key}"]`);
  if (output) output.textContent = formatTeleprompterValue(key, value);
  teleprompterPanel.handlers.setting(key, value, { commit });
}

function onPanelClick(event) {
  if (!teleprompterPanel) return;
  wakeTeleprompterBar();
  const step = event.target.closest("[data-tp-step]");
  if (step) {
    const key = step.dataset.tpStep;
    const range = TELEPROMPTER_RANGES[key];
    const slider = teleprompterPanel.sheet.querySelector(`[data-tp-range="${key}"]`);
    const current = Number(slider?.value);
    const next = Math.min(range.max, Math.max(range.min, current + Number(step.dataset.tpDir) * range.step));
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

export function ensureTeleprompterPanel(stage, handlers) {
  if (teleprompterPanel) {
    teleprompterPanel.handlers = handlers;
    return teleprompterPanel;
  }
  const { overlayNode, count } = buildTeleprompterOverlay();
  const bar = buildTeleprompterBar();
  const { sheetNode, mine } = buildTeleprompterSheet();
  stage.append(overlayNode, bar.bar, sheetNode);
  teleprompterPanel = { ...bar, overlay: overlayNode, count, sheet: sheetNode, mine, stage, handlers, fadeTimer: 0 };
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
// or a settings change.
export function placeTeleprompterBand({ top, left, width, height, bandTop, bandHeight, dim, showBand }) {
  if (!teleprompterPanel) return;
  const style = teleprompterPanel.overlay.style;
  style.setProperty("--tp-box-top", `${top}px`);
  style.setProperty("--tp-box-left", `${left}px`);
  style.setProperty("--tp-box-width", `${width}px`);
  style.setProperty("--tp-box-height", `${height}px`);
  style.setProperty("--tp-band-top", `${bandTop}px`);
  style.setProperty("--tp-band-height", `${bandHeight}px`);
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
  const { phase } = model;
  const phaseChanged = teleprompterPanel.phase !== phase;
  teleprompterPanel.phase = phase;
  teleprompterPanel.bar.dataset.phase = phase;
  teleprompterPanel.overlay.dataset.phase = phase;
  teleprompterPanel.bar.classList.toggle("is-tucked", Boolean(model.tucked));

  const face = PLAY_FACES[phase] || PLAY_FACES.paused;
  teleprompterPanel.play.querySelector(".tp-play-ico").textContent = face.icon;
  teleprompterPanel.playLabel.textContent = face.label;
  teleprompterPanel.play.title = face.title;
  teleprompterPanel.play.setAttribute("aria-label", face.label || "Pause");
  const progress = Number.isFinite(model.resumeProgress) ? Math.max(0, Math.min(1, model.resumeProgress)) : null;
  teleprompterPanel.play.classList.toggle("is-auto-resuming", progress != null);
  teleprompterPanel.play.style.setProperty("--tp-resume-progress", `${Math.round((progress || 0) * 360)}deg`);

  teleprompterPanel.wpm.textContent = `${model.wpm} wpm`;
  teleprompterPanel.left.textContent = model.leftText || "";
  teleprompterPanel.left.hidden = !model.leftText;

  teleprompterPanel.count.hidden = phase !== "countdown";
  if (phase === "countdown") teleprompterPanel.count.textContent = String(model.countdown || "");

  if (teleprompterPanel.status.textContent !== model.statusText) teleprompterPanel.status.textContent = model.statusText || "";

  if (phaseChanged) wakeTeleprompterBar();
  paintTeleprompterSheet(model.settings, model.measuredWpm, model.wpm, model.fontSize);
}

function paintTeleprompterSheet(settings, measuredWpm, wpm, fontSize) {
  if (!teleprompterPanel || !settings) return;
  const values = { ...settings, wpm, fontSize };
  Object.keys(TELEPROMPTER_RANGES).forEach((key) => {
    const slider = teleprompterPanel.sheet.querySelector(`[data-tp-range="${key}"]`);
    // Not under the reader's thumb: rewriting a slider's value mid-drag makes
    // it jump back to wherever the last paint thought it was.
    if (slider && document.activeElement !== slider) slider.value = String(values[key]);
    const output = teleprompterPanel.sheet.querySelector(`[data-tp-value="${key}"]`);
    if (output) output.textContent = formatTeleprompterValue(key, values[key]);
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
