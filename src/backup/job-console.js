// The face of a long job: a backup, a share, a restore, an import.
//
// The panel this replaces opened on click and then said one sentence for
// minutes — "Reading your decks…" while the cloud decided whether to answer,
// "Compressing the archive…" while forty papers were deflated for nothing —
// with an indeterminate bar that looks the same whether the job is working or
// wedged. On a library of papers and figures that read as a frozen app, and a
// frozen app is one people force-close half way through writing a backup.
//
// So a job now says what it is doing, all the time:
//
//   • a STEP LIST — every phase the job will go through, ticked with how long
//     it took, so the shape of the wait is visible before it is over;
//   • a CURRENT line — the one deck, image or paper in hand right now, with
//     its size, and where its bytes are coming from;
//   • running COUNTERS, the elapsed time, and an ETA once there is a total;
//   • an ACTIVITY LOG — one line per thing done, warnings in their place
//     rather than rolled into a count at the end, and Copy log when it is over;
//   • WAITS named and timed — "Waiting for the cloud deck list… 6 s" — so a
//     network that is slow is distinguishable from an app that has stopped.
//
// Every method is safe to call on a closed or finished console, and every
// caller holds it as `progress?.…`, so a job run without a panel (the checks,
// a safety backup that runs inside another job) needs no second code path.

import { escapeHtml } from "../core/text.js?v=__BUILD__";

export function formatJobBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatJobDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} min ${String(rest).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

// How many log lines stay in the DOM. The full log is kept in memory for Copy
// log; the list shows the most recent, because a library of two thousand
// figures is two thousand rows the browser would otherwise lay out.
export const JOB_LOG_VISIBLE = 400;

export const DEFAULT_JOB_STATS = [
  ["decks", "Decks"],
  ["cards", "Cards"],
  ["images", "Images"],
  ["papers", "Papers"],
  ["size", "Size"],
  ["time", "Time"]
];

export function showJobConsole(title = "Working…", { steps = [], stats = DEFAULT_JOB_STATS, logOpen = true } = {}) {
  const startedAt = Date.now();
  const modal = document.createElement("section");
  modal.className = "category-choice-modal backup-progress-modal job-console-modal";
  modal.setAttribute("aria-label", title);

  const shell = document.createElement("div");
  shell.className = "category-choice-shell backup-progress-shell job-console-shell";
  shell.innerHTML = `
    <div class="category-choice-head">
      <div>
        <h2 class="backup-progress-title"></h2>
        <p class="backup-progress-line" role="status" aria-live="polite">Starting…</p>
      </div>
    </div>
    <ol class="job-steps"></ol>
    <div class="job-progress-track is-indeterminate"><div class="job-progress-fill"></div></div>
    <p class="job-current" aria-live="off"></p>
    <div class="epub-preview-stats job-stats"></div>
    <details class="job-log"${logOpen ? " open" : ""}>
      <summary>Activity <span class="job-log-count">0</span></summary>
      <ol class="job-log-list"></ol>
    </details>
    <p class="backup-progress-note"></p>
    <div class="category-choice-actions job-actions">
      <button type="button" data-job-copy hidden>Copy log</button>
      <button type="button" data-backup-cancel>Cancel</button>
    </div>
  `;
  shell.querySelector(".backup-progress-title").textContent = title;
  const stepList = shell.querySelector(".job-steps");
  stepList.innerHTML = steps.map(([key, label]) => (
    `<li class="job-step" data-job-step="${escapeHtml(key)}">`
    + `<span class="job-step-dot" aria-hidden="true"></span>`
    + `<span class="job-step-label">${escapeHtml(label)}</span>`
    + `<span class="job-step-time"></span></li>`
  )).join("");
  if (!steps.length) stepList.hidden = true;
  shell.querySelector(".job-stats").innerHTML = stats.map(([key, label]) => (
    `<div class="epub-preview-stat"><strong data-backup-stat="${escapeHtml(key)}">${key === "size" || key === "time" ? "—" : "0"}</strong><span>${escapeHtml(label)}</span></div>`
  )).join("");
  modal.appendChild(shell);
  document.body.appendChild(modal);

  const line = shell.querySelector(".backup-progress-line");
  const track = shell.querySelector(".job-progress-track");
  const fill = shell.querySelector(".job-progress-fill");
  const current = shell.querySelector(".job-current");
  const note = shell.querySelector(".backup-progress-note");
  const logList = shell.querySelector(".job-log-list");
  const logCount = shell.querySelector(".job-log-count");
  const cancelButton = shell.querySelector("[data-backup-cancel]");
  const copyButton = shell.querySelector("[data-job-copy]");
  const actions = shell.querySelector(".job-actions");

  let cancelled = false;
  let finished = false;
  let closed = false;
  let activeStep = "";
  let stepStartedAt = startedAt;
  let waitLabel = "";
  let waitStartedAt = 0;
  let eta = null;
  let baseText = "Starting…";
  let etaSuffix = "";
  const entries = [];
  const cancelListeners = new Set();

  const setStat = (key, value) => {
    const cell = shell.querySelector(`[data-backup-stat="${key}"]`);
    if (cell) cell.textContent = String(value);
  };
  const clockTimer = setInterval(() => {
    if (closed) return;
    const elapsed = Date.now() - startedAt;
    setStat("time", formatJobDuration(elapsed));
    if (waitLabel) current.textContent = `${waitLabel}… ${formatJobDuration(Date.now() - waitStartedAt)}${cancelled || finished ? "" : " — Cancel still works"}`;
    // An ETA only once a few seconds of the step have gone by — the first item
    // of anything is slow, and "about 40 min left" off one sample is a lie.
    if (eta && !finished && !cancelled && eta.done > 0 && eta.total > eta.done && Date.now() - eta.since > 3000) {
      const rate = (Date.now() - eta.since) / eta.done;
      etaSuffix = ` · about ${formatJobDuration(rate * (eta.total - eta.done))} left`;
      line.textContent = baseText + etaSuffix;
    }
  }, 1000);

  const stamp = () => formatJobDuration(Date.now() - startedAt).replace(/ /g, "");

  const api = {
    // `fraction` null/undefined keeps the bar in its indeterminate sweep, which
    // is honest about steps whose total isn't known yet.
    update(text, fraction) {
      if (closed || (cancelled && !finished)) return;
      if (text) {
        baseText = text;
        line.textContent = baseText + (eta ? etaSuffix : "");
      }
      if (typeof fraction === "number") {
        track.classList.remove("is-indeterminate");
        fill.style.width = `${Math.min(100, Math.max(0, Math.round(fraction * 100)))}%`;
      } else {
        track.classList.add("is-indeterminate");
      }
    },
    // The one thing in hand right now — a deck, an image, a paper.
    current(text) {
      if (closed) return;
      if (waitLabel) return;
      current.textContent = text || "";
    },
    setStat,
    // A step of the job starts. The previous one is ticked with its time.
    step(key, text) {
      if (closed) return;
      if (activeStep) api.stepDone(activeStep);
      activeStep = key;
      stepStartedAt = Date.now();
      eta = null;
      etaSuffix = "";
      const row = stepList.querySelector(`[data-job-step="${key}"]`);
      row?.classList.add("is-active");
      if (text) api.update(text);
      current.textContent = "";
    },
    stepDone(key, detail = "") {
      if (closed) return;
      const row = stepList.querySelector(`[data-job-step="${key}"]`);
      if (!row) return;
      row.classList.remove("is-active");
      row.classList.add("is-done");
      const time = row.querySelector(".job-step-time");
      if (time) time.textContent = [detail, formatJobDuration(Date.now() - (activeStep === key ? stepStartedAt : Date.now()))].filter(Boolean).join(" · ");
      if (activeStep === key) activeStep = "";
    },
    stepSkipped(key, reason = "skipped") {
      if (closed) return;
      const row = stepList.querySelector(`[data-job-step="${key}"]`);
      if (!row) return;
      row.classList.add("is-skipped");
      const time = row.querySelector(".job-step-time");
      if (time) time.textContent = reason;
    },
    // Counted progress through a step with a known total — drives the bar and
    // the ETA.
    count(done, total, text) {
      if (closed) return;
      if (!eta || eta.total !== total) {
        eta = { done: 0, total, since: Date.now() };
        etaSuffix = "";
      }
      eta.done = done;
      api.update(text, total ? done / total : null);
    },
    log(text, level = "info") {
      const entry = { at: Date.now() - startedAt, level, text: String(text || "") };
      entries.push(entry);
      if (closed) return;
      logCount.textContent = String(entries.length);
      const row = document.createElement("li");
      row.className = `job-log-row is-${level}`;
      const time = document.createElement("span");
      time.className = "job-log-time";
      time.textContent = stamp();
      const body = document.createElement("span");
      body.className = "job-log-text";
      body.textContent = entry.text;
      row.append(time, body);
      logList.append(row);
      while (logList.children.length > JOB_LOG_VISIBLE) logList.firstElementChild?.remove();
      logList.scrollTop = logList.scrollHeight;
    },
    warn(text) { api.log(text, "warn"); },
    error(text) { api.log(text, "error"); },
    logText() {
      return entries.map((entry) => `[${formatJobDuration(entry.at).replace(/ /g, "")}] ${entry.level === "info" ? "" : `${entry.level.toUpperCase()}: `}${entry.text}`).join("\n");
    },
    entries() { return entries.slice(); },
    // A wait with no progress of its own — a network round trip, a library
    // loading. Named, and timed out loud, until the returned stop() is called.
    wait(label) {
      if (closed) return () => {};
      waitLabel = label;
      waitStartedAt = Date.now();
      current.textContent = `${label}…`;
      api.log(`${label}…`);
      return (outcome = "") => {
        const took = Date.now() - waitStartedAt;
        if (waitLabel === label) {
          waitLabel = "";
          current.textContent = "";
        }
        if (outcome || took > 1500) api.log(`${outcome || "Done"} (${formatJobDuration(took)})`);
      };
    },
    note(text, warning = false) {
      if (closed) return;
      note.textContent = text || "";
      note.classList.toggle("is-warning", Boolean(text) && warning);
    },
    cancelled() { return cancelled; },
    onCancel(listener) {
      cancelListeners.add(listener);
      return () => cancelListeners.delete(listener);
    },
    // Leaves the panel up with the finished job's numbers — the point of the
    // whole thing is to be able to see what was done — and turns the escape
    // hatch into the way to dismiss it. `actions` are extra buttons (Share…,
    // Download again) shown beside Done.
    finish(text, { warning = "", actions: extra = [], failed = false } = {}) {
      if (closed) return;
      finished = true;
      if (activeStep) api.stepDone(activeStep);
      waitLabel = "";
      eta = null;
      etaSuffix = "";
      baseText = text;
      line.textContent = text;
      current.textContent = `Finished in ${formatJobDuration(Date.now() - startedAt)}.`;
      track.classList.remove("is-indeterminate");
      track.classList.toggle("is-failed", failed);
      fill.style.width = "100%";
      if (warning) api.note(warning, true);
      copyButton.hidden = !entries.length;
      for (const action of extra) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        if (action.primary) button.className = "import-action-primary";
        button.addEventListener("click", () => action.onClick?.(button));
        actions.insertBefore(button, cancelButton);
      }
      cancelButton.disabled = false;
      cancelButton.textContent = "Done";
      cancelButton.classList.toggle("import-action-primary", !extra.some((action) => action.primary));
      cancelButton.focus?.();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(clockTimer);
      modal.remove();
    },
    get closed() { return closed; }
  };

  cancelButton.addEventListener("click", () => {
    if (finished) {
      api.close();
      return;
    }
    cancelled = true;
    cancelButton.disabled = true;
    line.textContent = "Stopping…";
    api.log("Cancel pressed — stopping after the current item.", "warn");
    for (const listener of cancelListeners) {
      try { listener(); } catch (error) { console.warn("A cancel listener failed", error); }
    }
  });
  copyButton.addEventListener("click", async () => {
    const text = api.logText();
    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = "Copied";
    } catch {
      copyButton.textContent = "Could not copy";
    }
    setTimeout(() => { copyButton.textContent = "Copy log"; }, 1600);
  });

  return api;
}

// A promise that loses to Cancel. For the waits the job cannot interrupt at
// the source (a fetch already in flight): the job stops waiting for it, which
// is what the person pressing Cancel wanted.
export function raceCancel(promise, progress) {
  if (!progress?.onCancel) return promise;
  if (progress.cancelled()) return Promise.reject(new Error("CANCELLED"));
  return new Promise((resolve, reject) => {
    const stop = progress.onCancel(() => reject(new Error("CANCELLED")));
    Promise.resolve(promise).then(
      (value) => { stop(); resolve(value); },
      (error) => { stop(); reject(error); }
    );
  });
}
