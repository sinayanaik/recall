// Read-only scan across every deck for image references that no longer
// resolve. Exists because removing an image only checks the CURRENT deck for
// other references before hard-deleting its Storage object (see
// deckStillReferencesImage in images/surface-controls.js) — a picture reused
// across two decks can be deleted out from under the other one, and this is
// the only way to find out it happened. Never deletes or edits anything; it
// only reports, so fixing what it finds (removing the reference, or
// re-adding the picture) stays a manual, per-image decision.

import { mapWithConcurrency } from "../cloud/net.js?v=__BUILD__";
import { fetchableStorageUrl } from "../cloud/storage-urls.js?v=__BUILD__";
import { deckPayloadSnapshot } from "../cloud/web-decks.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME } from "../images/outbox.js?v=__BUILD__";
import { collectBackupImageRefs, collectBackupPayloads, isSupabaseStorageRef } from "./backup.js?v=__BUILD__";

const CHECK_TIMEOUT_MS = 10000;
const CHECK_CONCURRENCY = 6;

// Does this external image still LOAD, even though script can't read it?
//
// A third-party host that sends no Access-Control-Allow-Origin fails every
// fetch() with an indistinguishable `TypeError: Failed to fetch`, whether the
// picture is perfectly fine or long gone — so fetch alone would flag every
// pasted web image as broken and bury the handful that actually are. An <img>
// makes a no-cors request, which those hosts DO answer: it loads if the image
// exists and errors if it doesn't. The bytes stay unreadable to script (which
// is why Backup still can't pack these), but "is it there" gets a real answer.
function probeImageLoads(ref) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => {
      img.onload = null;
      img.onerror = null;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => { img.src = ""; done(false); }, CHECK_TIMEOUT_MS);
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.referrerPolicy = "no-referrer";
    img.src = ref;
  });
}

// One reference's reachability, without pulling its bytes — a HEAD is enough
// to know whether the object/host answers, and costs nothing like the full
// GETs packBackupAssets does. Some hosts don't implement HEAD (405); a
// one-byte ranged GET is the fallback, still far cheaper than the real image.
//
// SIGNED first. The refs handed in are the canonical `/object/public/…` URLs a
// note holds, and the images bucket is private, so asking for one directly is a
// 400 for every picture the user owns — which this reported as `HTTP 400` and
// sorted to the top as "your own dead Storage objects". A tool that answers
// "all of them are broken" is worse than no tool, and it is the first place
// anyone looks when an image does not appear. A no-op for an external link.
async function checkRefReachable(ref) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS);
  try {
    const target = await fetchableStorageUrl(ref);
    let response = await fetch(target, { method: "HEAD", mode: "cors", credentials: "omit", signal: abort.signal });
    if (response.status === 405) {
      response = await fetch(target, {
        method: "GET", mode: "cors", credentials: "omit",
        headers: { Range: "bytes=0-0" }, signal: abort.signal
      });
    }
    if (response.ok || response.status === 206) return { ok: true };
    // A status IS an answer, even an unhappy one — but only trust it as final
    // for our own Storage; a third-party 403/405 may just be how that host
    // greets a cross-origin HEAD, so fall through to the <img> probe.
    if (isSupabaseStorageRef(ref)) return { ok: false, reason: `HTTP ${response.status}` };
    return (await probeImageLoads(ref))
      ? { ok: true }
      : { ok: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    if (isSupabaseStorageRef(ref)) {
      return { ok: false, reason: error?.name === "AbortError" ? "timed out" : "network error" };
    }
    // Almost always CORS rather than a dead link — let the <img> decide.
    return (await probeImageLoads(ref))
      ? { ok: true }
      : { ok: false, reason: "link is dead" };
  } finally {
    clearTimeout(timer);
  }
}

// Every deck this device knows about (on-device + cloud-only — the same set
// Backup packs), scanned for image references, each UNIQUE one checked once.
// Returns { checked, broken }; broken = [{ url, decks, reason, ours }].
// `ours` distinguishes a dead Supabase Storage object (the cross-deck delete
// gap this exists to surface, and fixable by re-adding the picture) from a
// dead third-party link (an expired Facebook CDN url, a host with no CORS —
// nothing on this side to fix).
export async function scanForBrokenImageRefs(onProgress, isCancelled = () => false) {
  const payloads = await collectBackupPayloads();
  const decksByRef = new Map();
  payloads.forEach(({ payload }) => {
    const snapshot = deckPayloadSnapshot(payload);
    const title = payload.deck.title || "Untitled deck";
    collectBackupImageRefs(snapshot).forEach((ref) => {
      if (ref.startsWith(LOCAL_IMAGE_SCHEME)) return; // queued offline, not broken
      if (!decksByRef.has(ref)) decksByRef.set(ref, new Set());
      decksByRef.get(ref).add(title);
    });
  });

  const refs = Array.from(decksByRef.keys());
  let done = 0;
  const broken = [];
  await mapWithConcurrency(refs, CHECK_CONCURRENCY, async (ref) => {
    if (isCancelled()) return;
    const result = await checkRefReachable(ref);
    done += 1;
    onProgress?.(done, refs.length);
    if (!result.ok) {
      broken.push({
        url: ref,
        decks: Array.from(decksByRef.get(ref)).sort(),
        reason: result.reason,
        ours: isSupabaseStorageRef(ref)
      });
    }
  });
  // Your own dead Storage objects first — those are the ones worth acting on.
  broken.sort((a, b) => (a.ours === b.ours ? 0 : a.ours ? -1 : 1));
  return { checked: refs.length, broken };
}

// ── UI ──────────────────────────────────────────────────────────────────────
function buildScanModal() {
  const modal = document.createElement("section");
  modal.className = "category-choice-modal broken-images-modal";
  modal.setAttribute("aria-label", "Checking for broken images");

  const shell = document.createElement("div");
  shell.className = "category-choice-shell broken-images-shell";
  shell.innerHTML = `
    <div class="category-choice-head">
      <div>
        <h2>Checking for broken images</h2>
        <p class="backup-progress-line" role="status" aria-live="polite">Reading your decks…</p>
      </div>
    </div>
    <div class="job-progress-track is-indeterminate"><div class="job-progress-fill"></div></div>
    <div class="epub-preview-stats">
      <div class="epub-preview-stat"><strong data-scan-stat="checked">0</strong><span>Checked</span></div>
      <div class="epub-preview-stat"><strong data-scan-stat="broken">0</strong><span>Broken</span></div>
    </div>
    <div class="broken-images-results" hidden></div>
    <div class="category-choice-actions">
      <button type="button" data-scan-cancel>Cancel</button>
    </div>
  `;
  modal.appendChild(shell);
  document.body.appendChild(modal);
  return {
    modal,
    line: shell.querySelector(".backup-progress-line"),
    track: shell.querySelector(".job-progress-track"),
    fill: shell.querySelector(".job-progress-fill"),
    results: shell.querySelector(".broken-images-results"),
    cancelBtn: shell.querySelector("[data-scan-cancel]"),
    setStat(key, value) {
      const cell = shell.querySelector(`[data-scan-stat="${key}"]`);
      if (cell) cell.textContent = String(value);
    }
  };
}

function reasonLabel(item) {
  return item.ours
    ? `Your upload is missing from storage — ${item.reason}`
    : `Web link no longer works — ${item.reason}`;
}

function renderResults(container, broken) {
  container.hidden = false;
  container.innerHTML = "";
  if (!broken.length) {
    const empty = document.createElement("p");
    empty.className = "broken-images-empty";
    empty.textContent = "Every image reference resolved.";
    container.appendChild(empty);
    return;
  }
  const list = document.createElement("ul");
  list.className = "broken-images-list";
  broken.forEach((item) => {
    const li = document.createElement("li");
    li.className = "broken-images-item";

    const url = document.createElement("div");
    url.className = "broken-images-url";
    url.textContent = item.url;
    url.title = item.url;

    const meta = document.createElement("div");
    meta.className = "broken-images-meta";
    meta.textContent = `${reasonLabel(item)} — in: ${item.decks.join(", ")}`;

    li.append(url, meta);
    list.appendChild(li);
  });
  container.appendChild(list);
}

// Builds a plain-text report (one line per broken reference) for the clipboard
// — the list itself is read-only in the modal, so this is the way to actually
// take it somewhere and act on individual entries.
function reportText(result) {
  const lines = [`Checked ${result.checked} image reference(s); ${result.broken.length} broken.`, ""];
  result.broken.forEach((item) => {
    lines.push(`${item.url}`);
    lines.push(`  ${reasonLabel(item)} — in: ${item.decks.join(", ")}`);
  });
  return lines.join("\n");
}

export async function runBrokenImageScan() {
  const ui = buildScanModal();
  let cancelled = false;
  ui.cancelBtn.addEventListener("click", () => {
    if (ui.cancelBtn.textContent === "Close") { ui.modal.remove(); return; }
    cancelled = true;
    ui.cancelBtn.disabled = true;
    ui.line.textContent = "Stopping…";
  });

  let result;
  try {
    result = await scanForBrokenImageRefs((done, total) => {
      if (cancelled) return;
      ui.line.textContent = `Checking images ${done}/${total}…`;
      ui.track.classList.remove("is-indeterminate");
      ui.fill.style.width = `${Math.min(100, Math.max(0, Math.round((done / Math.max(total, 1)) * 100)))}%`;
      ui.setStat("checked", done);
    }, () => cancelled);
  } catch (error) {
    console.error("Broken-image scan failed", error);
    ui.line.textContent = "Could not finish the check.";
    ui.cancelBtn.disabled = false;
    ui.cancelBtn.textContent = "Close";
    return;
  }

  if (cancelled) {
    ui.modal.remove();
    return;
  }

  ui.line.textContent = `Checked ${result.checked} image reference${result.checked === 1 ? "" : "s"}.`;
  ui.setStat("checked", result.checked);
  ui.setStat("broken", result.broken.length);
  ui.track.classList.remove("is-indeterminate");
  ui.fill.style.width = "100%";
  renderResults(ui.results, result.broken);

  ui.cancelBtn.disabled = false;
  ui.cancelBtn.textContent = "Close";

  if (result.broken.length) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "import-action-primary";
    copyBtn.textContent = "Copy list";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(reportText(result));
        copyBtn.textContent = "Copied";
        setTimeout(() => { copyBtn.textContent = "Copy list"; }, 1500);
      } catch (error) {
        console.warn("Could not copy the broken-image report", error);
      }
    });
    ui.cancelBtn.insertAdjacentElement("beforebegin", copyBtn);
  }
}
