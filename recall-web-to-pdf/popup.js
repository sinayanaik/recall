// Recall Web to PDF — the options popup.
//
// Every control carries the option's key as its `name` (margins.* for the
// per-side margins), so reading and writing the form is generic. data-show
// attributes ("paper=custom", "imageQuality!=none", "a=b|c") hide what does
// not apply. Options are remembered in chrome.storage.sync as "last", and
// named presets as "presets"; the built-in presets in lib/options.js cannot be
// deleted. Saving hands the job to background.js, so closing the popup (or
// clicking the page to pick a block) does not stop it.

import { DEFAULTS, BUILTIN_PRESETS, normalize, geometry, imageSettings } from "./lib/options.js";

const form = document.getElementById("form");
const presetSelect = document.getElementById("preset");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const goBtn = document.getElementById("go");
const hostNote = document.getElementById("hostNote");
const linkMargins = document.getElementById("linkMargins");

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
  updateHostNote(o);
  summaryEl.textContent = summarize(o);
}

function summarize(o) {
  const g = geometry(o);
  const fmt = (inches) => (o.marginUnit === "in" ? `${inches.toFixed(2)} in` : `${Math.round(inches * 25.4)} mm`);
  const m = g.margin;
  const margins = [m.top, m.right, m.bottom, m.left].every((v) => v === 0)
    ? "no margins"
    : `margins ${fmt(m.top)} / ${fmt(m.right)} / ${fmt(m.bottom)} / ${fmt(m.left)}`;
  const pages = o.layout === "continuous" ? `one page ${fmt(g.paperWidthIn)} wide` : `${o.paper === "custom" ? "custom" : o.paper} pages`;
  const img = imageSettings(o);
  const images = o.imageQuality === "none" ? "no images" : img ? `images ≤ ${img.dpi} DPI` : "original images";
  return `${pages} · ${margins} · laid out ${g.layoutWidthPx} px wide at ${Math.round(g.scale * 100)}% · ${images}`;
}

async function updateHostNote(o) {
  const wants = Boolean(imageSettings(o));
  if (!wants) { hostNote.hidden = true; return; }
  const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
  hostNote.hidden = granted;
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

form.addEventListener("input", (e) => {
  const t = e.target;
  if (linkMargins.checked && t.name && t.name.startsWith("margins.")) {
    form.querySelectorAll('[name^="margins."]').forEach((el) => { el.value = t.value; });
  }
  presetSelect.value = "";
  refresh();
  saveLast();
});
form.addEventListener("change", () => { refresh(); saveLast(); });

document.getElementById("grantHost").addEventListener("click", async () => {
  const ok = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
  showStatus(ok ? "Images from any site can now be resized." : "Without it, only this site’s own images are resized.");
  refresh();
});

function showStatus(text, error = false) {
  statusEl.hidden = !text;
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", error);
}

function paintJob(job) {
  if (!job) return;
  showStatus(job.step || "", Boolean(job.error));
  const running = !job.done && !job.error;
  goBtn.disabled = running;
  goBtn.textContent = running ? "Working…" : "Save as PDF";
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "rwp-status" && msg.tabId === tabId) paintJob(msg.job);
});

goBtn.addEventListener("click", async () => {
  const options = readForm();
  await saveLast();
  if (options.capture === "element") showStatus("Click the block you want on the page…");
  goBtn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "rwp-start", tabId, options }).catch((err) => ({ ok: false, error: String(err) }));
  if (res && !res.ok) paintJob({ step: res.error || "Something went wrong.", error: true });
  goBtn.disabled = false;
  goBtn.textContent = "Save as PDF";
});

// ---------------------------------------------------------------- start

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  const last = await loadStored();
  paintPresets("");
  writeForm(last);
  if (tab && /^(chrome|edge|brave|about|chrome-extension|devtools|view-source|file):/i.test(tab.url || "")) {
    goBtn.disabled = true;
    showStatus("Chrome does not let extensions save this kind of page.", true);
  }
  const job = await chrome.runtime.sendMessage({ type: "rwp-get-status", tabId }).catch(() => null);
  paintJob(job);
})();

// For a reader poking at the console (and the checks): what would be sent.
globalThis.__rwpOptions = () => readForm();
