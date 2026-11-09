// Recall Web Clipper — the toolbar popup.
//
// Three things to do with the page: Clean this page and Copy as Markdown start
// their on-page tool and close the popup; Save as PDF opens its settings here.
// The few settings most people change are on top; everything else is under
// "More options".
//
// Every PDF control carries the option's key as its `name` (margins.* for the
// per-side margins), so reading and writing the form is generic. data-show
// attributes ("paper=custom", "imageQuality!=none", "a=b|c") hide what does
// not apply. Options are remembered in chrome.storage.sync as "last", and
// named presets as "presets"; the built-in presets in lib/options.js cannot be
// deleted. Saving hands the job to the background (pdf-job.js), so closing
// the popup — or clicking the page to pick a block or move a page break —
// does not stop it.
//
// The footer follows the job, never the long-running start message: while the
// page waits for the reader it offers "Save PDF now" and Cancel; while the
// PDF is made, Cancel; after a failed save, "Save again". Every call to the
// background has a time limit, and if the background does not answer the
// footer falls back to a working "Save as PDF" — it is never left disabled.

import { DEFAULTS, BUILTIN_PRESETS, normalize, geometry, imageSettings, pageLengthIn } from "./lib/options.js";

const form = document.getElementById("form");
const presetSelect = document.getElementById("preset");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const goBtn = document.getElementById("go");
const finishBtn = document.getElementById("finish");
const againBtn = document.getElementById("again");
const cancelBtn = document.getElementById("cancel");
const linkMargins = document.getElementById("linkMargins");
const pdfButton = document.getElementById("actPdf");
const pdfFooter = document.getElementById("pdfFooter");
const blockedEl = document.getElementById("blocked");

let userPresets = {};
let tabId = null;

// ---------------------------------------------------------------- form <-> options

function controls() {
  return [...form.querySelectorAll("[name]")];
}

function readForm() {
  const o = { margins: {} };
  for (const el of controls()) {
    const [key, sub] = el.name.split(".");
    let value;
    if (el.type === "checkbox") value = el.checked;
    else if (el.type === "radio") { if (!el.checked) continue; value = el.value; }
    else if (el.type === "number" || el.type === "range") value = Number(el.value);
    else value = el.value;
    if (sub) o[key][sub] = value; else o[key] = value;
  }
  return normalize(o);
}

function writeForm(options) {
  const o = normalize(options);
  for (const el of controls()) {
    const [key, sub] = el.name.split(".");
    const value = sub ? o[key][sub] : o[key];
    if (el.type === "checkbox") el.checked = Boolean(value);
    else if (el.type === "radio") el.checked = String(value) === el.value;
    else el.value = value;
  }
  const m = o.margins;
  linkMargins.checked = m.top === m.right && m.right === m.bottom && m.bottom === m.left;
  refresh();
}

function refresh() {
  const o = readForm();
  // data-show: "key=a|b" or "key!=a|b"; several conditions joined by "|" across keys
  // ("header!=none|footer!=none") mean ANY.
  form.querySelectorAll("[data-show]").forEach((el) => {
    const rules = el.getAttribute("data-show");
    const any = rules.includes("!=") && rules.split("|").every((r) => r.includes("!="))
      ? rules.split("|").some((r) => { const [k, v] = r.split("!="); return String(o[k]) !== v; })
      : (() => {
        const neg = rules.includes("!=");
        const [k, vs] = rules.split(neg ? "!=" : "=");
        const hit = vs.split("|").includes(String(o[k]));
        return neg ? !hit : hit;
      })();
    el.hidden = !any;
  });
  form.querySelectorAll("output[data-for]").forEach((out) => {
    const input = form.querySelector(`[name="${out.dataset.for}"]`);
    out.textContent = input ? input.value : "";
  });
  form.querySelectorAll(".unit").forEach((u) => { u.textContent = o.marginUnit; });
  summaryEl.textContent = summarize(o);
}

function summarize(o) {
  const g = geometry(o);
  const fmt = (inches) => (o.marginUnit === "in" ? `${inches.toFixed(2)} in` : `${Math.round(inches * 25.4)} mm`);
  const m = g.margin;
  const margins = [m.top, m.right, m.bottom, m.left].every((v) => v === 0)
    ? "no margins"
    : `margins ${fmt(m.top)} / ${fmt(m.right)} / ${fmt(m.bottom)} / ${fmt(m.left)}`;
  const pages = o.layout === "smart"
    ? `pages ${fmt(g.paperWidthIn)} wide, up to ${fmt(pageLengthIn(o, g))} long`
    : o.layout === "continuous" ? `one page ${fmt(g.paperWidthIn)} wide` : `${o.paper === "custom" ? "custom" : o.paper} pages`;
  const img = imageSettings(o);
  const images = o.imageQuality === "none" ? "no images" : img && img.dpi ? `images ≤ ${img.dpi} DPI` : "original images";
  return `${pages} · ${margins} · laid out ${g.layoutWidthPx} px wide at ${Math.round(g.scale * 100)}% · ${images}`;
}

// ---------------------------------------------------------------- presets

async function loadStored() {
  try {
    const { last, presets } = await chrome.storage.sync.get(["last", "presets"]);
    userPresets = presets || {};
    return last || {};
  } catch { return {}; }
}

function paintPresets(selected = "") {
  presetSelect.replaceChildren();
  const add = (label, value, group) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    group.append(opt);
  };
  const custom = document.createElement("option");
  custom.value = "";
  custom.textContent = "Your last options";
  presetSelect.append(custom);
  const built = document.createElement("optgroup");
  built.label = "Built in";
  Object.keys(BUILTIN_PRESETS).forEach((name) => add(name, `b:${name}`, built));
  presetSelect.append(built);
  if (Object.keys(userPresets).length) {
    const mine = document.createElement("optgroup");
    mine.label = "Yours";
    Object.keys(userPresets).sort().forEach((name) => add(name, `u:${name}`, mine));
    presetSelect.append(mine);
  }
  presetSelect.value = selected;
}

async function saveLast() {
  try { await chrome.storage.sync.set({ last: readForm() }); } catch { /* sync quota or offline: not fatal */ }
}

presetSelect.addEventListener("change", () => {
  const v = presetSelect.value;
  if (v.startsWith("b:")) writeForm({ ...DEFAULTS, ...BUILTIN_PRESETS[v.slice(2)] });
  else if (v.startsWith("u:")) writeForm(userPresets[v.slice(2)]);
  saveLast();
});

document.getElementById("savePreset").addEventListener("click", async () => {
  const input = document.getElementById("presetName");
  const name = input.value.trim().slice(0, 40);
  if (!name) { input.focus(); return; }
  userPresets[name] = readForm();
  try { await chrome.storage.sync.set({ presets: userPresets }); } catch { /* ignore */ }
  input.value = "";
  paintPresets(`u:${name}`);
  showStatus(`Saved preset “${name}”.`);
});

document.getElementById("deletePreset").addEventListener("click", async () => {
  const v = presetSelect.value;
  if (!v.startsWith("u:")) { showStatus("Choose one of your own presets above to delete it."); return; }
  delete userPresets[v.slice(2)];
  try { await chrome.storage.sync.set({ presets: userPresets }); } catch { /* ignore */ }
  paintPresets("");
  showStatus("Preset deleted.");
});

document.getElementById("resetDefaults").addEventListener("click", () => {
  writeForm(DEFAULTS);
  paintPresets("");
  saveLast();
});

// ---------------------------------------------------------------- events

// The preset picker and its name box live in the form but are not options.
const notAnOption = (t) => !t.name;

form.addEventListener("input", (e) => {
  const t = e.target;
  if (notAnOption(t)) return;
  if (linkMargins.checked && t.name && t.name.startsWith("margins.")) {
    form.querySelectorAll('[name^="margins."]').forEach((el) => { el.value = t.value; });
  }
  presetSelect.value = "";
  refresh();
  saveLast();
});
form.addEventListener("change", (e) => { if (notAnOption(e.target)) return; refresh(); saveLast(); });

function showStatus(text, error = false, waiting = false) {
  statusEl.hidden = !text;
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", error);
  statusEl.classList.toggle("waiting", waiting && !error);
}

// A message to the background that cannot hang the popup.
function ask(msg, ms = 4000) {
  return Promise.race([
    chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: String((err && err.message) || err) })),
    new Promise((r) => setTimeout(() => r(undefined), ms))
  ]);
}

let current = null; // the job as last painted
let starting = false;
let misses = 0;     // status asks in a row that got no answer

function paintJob(job) {
  current = job || null;
  const running = Boolean(job && job.running);
  const phase = running ? job.phase : null;
  const waitingBreaks = phase === "waiting-breaks";
  const waitingPick = phase === "waiting-pick";
  showStatus(job ? job.step : "", Boolean(job && job.error && !job.cancelled), waitingBreaks || waitingPick);
  finishBtn.hidden = !waitingBreaks;
  cancelBtn.hidden = !running;
  cancelBtn.disabled = false;
  againBtn.hidden = running || !(job && job.canSaveAgain);
  againBtn.disabled = Boolean(job && job.phase === "saving");
  goBtn.hidden = waitingBreaks;
  goBtn.disabled = running || starting;
  goBtn.textContent = running ? (waitingPick ? "Waiting for your click…" : "Working…") : "Save as PDF";
  // After a failed save, Save again is the main action; making it again is second.
  const offerAgain = !againBtn.hidden;
  if (offerAgain) goBtn.textContent = "Make it again";
  goBtn.classList.toggle("primary", !offerAgain);
  goBtn.classList.toggle("secondary", offerAgain);
}

async function refreshStatus() {
  if (tabId == null) return;
  const job = await ask({ type: "rwc-get-status", tabId }, 2500);
  if (job === undefined) {
    // No answer: never leave a dead button behind.
    misses += 1;
    if (misses >= 2) {
      paintJob(current && current.running ? { ...current, step: "The clipper is not answering. Cancel stops it and puts the page back." } : null);
      goBtn.disabled = false;
    }
    return;
  }
  misses = 0;
  paintJob(job);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "rwc-status" && msg.tabId === tabId) { misses = 0; paintJob(msg.job); }
});

// While a job runs, keep asking too: a missed status message must not leave
// the popup showing a step that has long passed.
setInterval(() => { if (current && (current.running || current.phase === "saving")) refreshStatus(); }, 1500);

goBtn.addEventListener("click", async () => {
  const options = readForm();
  await saveLast();
  starting = true;
  paintJob({ running: true, phase: "attaching", step: "Starting…" });
  // The answer comes when the PDF is saved (or not); the footer follows the
  // status messages meanwhile, so the popup may close at any time.
  const started = chrome.runtime.sendMessage({ type: "rwc-start-pdf", tabId, options })
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
  setTimeout(() => { starting = false; refreshStatus(); }, 600);
  const res = await started;
  starting = false;
  if (res && !res.ok) {
    const job = await ask({ type: "rwc-get-status", tabId }, 2500);
    if (job && (job.running || job.error)) paintJob(job);
    else paintJob({ step: res.error || "Something went wrong.", error: true });
  } else refreshStatus();
});

finishBtn.addEventListener("click", async () => {
  finishBtn.disabled = true;
  const res = await ask({ type: "rwc-finish-pdf", tabId });
  finishBtn.disabled = false;
  if (res && !res.ok && res.error) showStatus(res.error, true);
  refreshStatus();
});

cancelBtn.addEventListener("click", async () => {
  cancelBtn.disabled = true;
  showStatus("Cancelling…");
  await ask({ type: "rwc-cancel-pdf", tabId }, 30000);
  cancelBtn.disabled = false;
  await refreshStatus();
  if (!current || current.running) paintJob({ step: "Cancelled.", cancelled: true, error: "Cancelled." });
});

againBtn.addEventListener("click", async () => {
  againBtn.disabled = true;
  showStatus("Saving again…");
  const res = await ask({ type: "rwc-save-again", tabId }, 20 * 60000);
  againBtn.disabled = false;
  if (res && !res.ok && res.error) showStatus(res.error, true);
  refreshStatus();
});

// ---------------------------------------------------------------- the three actions

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/i;
const STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

function showPdfPanel(open) {
  form.hidden = !open;
  pdfFooter.hidden = !open;
  pdfButton.setAttribute("aria-expanded", String(open));
  try { chrome.storage.local.set({ pdfOpen: open }); } catch { /* a nicety */ }
  if (open) refresh();
}

pdfButton.addEventListener("click", () => showPdfPanel(form.hidden));

async function startTool(type) {
  const res = await chrome.runtime.sendMessage({ type, tabId }).catch((err) => ({ ok: false, error: String(err) }));
  if (res && res.ok) window.close();
  else {
    blockedEl.hidden = false;
    blockedEl.textContent = "That could not start on this page. Reload the page and try again.";
  }
}
document.getElementById("actClean").addEventListener("click", () => startTool("rwc-clean"));
document.getElementById("actCopy").addEventListener("click", () => startTool("rwc-copy"));

// ---------------------------------------------------------------- start

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  const last = await loadStored();
  paintPresets("");
  writeForm(last);
  document.body.dataset.ready = "true";
  let pdfOpen = false;
  try { ({ pdfOpen = false } = await chrome.storage.local.get("pdfOpen")); } catch { /* closed */ }
  const url = (tab && tab.url) || "";
  if (!tab || RESTRICTED.test(url) || STORE.test(url) || /^file:/i.test(url)) {
    document.querySelectorAll("button.action, #go, #again").forEach((b) => { b.disabled = true; });
    blockedEl.hidden = false;
    blockedEl.textContent = "Chrome does not let extensions work on this kind of page. Open a web page and try again.";
    return;
  }
  const job = (await ask({ type: "rwc-get-status", tabId }, 2500)) || null;
  // A PDF in progress, or one waiting to be saved again: show it.
  showPdfPanel(Boolean(pdfOpen || (job && (job.running || job.canSaveAgain || job.phase === "saving"))));
  paintJob(job);
})();

// For a reader poking at the console (and the checks): what would be sent.
globalThis.__rwcOptions = () => readForm();
