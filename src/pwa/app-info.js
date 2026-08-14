// The App Info modal: installed version, what the origin is serving, and the
// project health check.
//
// The health probe reads only. It exists because a half-applied setup SQL
// otherwise announces itself as a dozen unrelated symptoms scattered across
// the app rather than as one missing column.

import { verifiedCloudUserId } from "../cloud/auth.js?v=__BUILD__";
import { isMissingRelationError } from "../cloud/deck-list.js?v=__BUILD__";
import { abortable, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { IS_DEV_BUILD } from "../core/build.js?v=__BUILD__";
import { readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { GITHUB_REPO, compareCommits, fetchLiveRelease, fetchRepoRelease, releaseStampsIn, runningAppVersion, runningVersionLabel, setGithubReleaseCache } from "./release-info.js?v=__BUILD__";
import { isMixedBuild, serviceWorkerRegistration, updateDownloadFailed, updateIsWaiting } from "./service-worker-client.js?v=__BUILD__";
import { setButtonLoading } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

export const appInfoModal = document.getElementById("appInfoModal");

export const appInfoBtn = document.getElementById("appInfoBtn");

export const appInfoCloseBtn = document.getElementById("appInfoCloseBtn");

export const appInfoVersion = document.getElementById("appInfoVersion");

export const appInfoLatest = document.getElementById("appInfoLatest");

export const appInfoStatus = document.getElementById("appInfoStatus");

export const appInfoRepo = document.getElementById("appInfoRepo");

export const appInfoCommit = document.getElementById("appInfoCommit");

export const appInfoWarning = document.getElementById("appInfoWarning");

export const appInfoCheckBtn = document.getElementById("appInfoCheckBtn");

export const appInfoReloadBtn = document.getElementById("appInfoReloadBtn");

export function setAppInfoStatus(text, cls = "") {
  if (!appInfoStatus) return;
  appInfoStatus.textContent = text;
  appInfoStatus.classList.toggle("is-ok", cls === "ok");
  appInfoStatus.classList.toggle("is-outdated", cls === "outdated");
}

export function setAppInfoWarning(text) {
  if (!appInfoWarning) return;
  appInfoWarning.textContent = text || "";
  appInfoWarning.hidden = !text;
}

// Fills every row. Also pokes the service worker's own update check — when a
// new worker is already waiting, that alone finishes the update
// (controllerchange then reloads the page; see registerServiceWorker).
//
// Three commits get compared, not two:
//   installed — the build this page is actually running (BUILD_STAMP)
//   live      — the build the server would hand a fresh visitor right now
//   repo      — the newest commit on the GitHub branch
//
// Which pair disagrees is what decides the message. installed ≠ live means
// there IS a newer build sitting on the server and reloading gets it. live ≠
// repo means the newest code is pushed but GitHub Pages hasn't published it —
// reloading cannot help, and the old check's "Update available" was a nag that
// no amount of reloading would ever clear.
//
// All three are now commit SHAs written by the deploy, so "same build" is
// literal identity rather than agreement between hand-typed strings.
export let appInfoCheckToken = 0;

export async function refreshAppInfo() {
  if (!appInfoLatest || !appInfoStatus) return;
  const token = ++appInfoCheckToken;
  const running = runningAppVersion();
  if (appInfoVersion) appInfoVersion.textContent = runningVersionLabel();

  appInfoLatest.textContent = "checking…";
  if (appInfoRepo) appInfoRepo.textContent = "checking…";
  if (appInfoCommit) appInfoCommit.textContent = "checking…";
  setAppInfoStatus("");
  setAppInfoWarning("");
  if (appInfoReloadBtn) appInfoReloadBtn.hidden = true;
  if (serviceWorkerRegistration) serviceWorkerRegistration.update().catch(() => {});

  // Both start together, but the same-origin answer is painted the moment it
  // lands rather than waiting on GitHub — it's the one that decides whether to
  // offer Reload, and it must not be held hostage by a slow or blocked API.
  // allSettled, not all: a GitHub outage or rate limit costs us the repo row
  // and nothing else.
  const livePromise = fetchLiveRelease();
  const repoPromise = fetchRepoRelease();
  livePromise
    .then((live) => { if (token === appInfoCheckToken && appInfoLatest) appInfoLatest.textContent = live?.stamp || "unknown"; })
    .catch(() => {});

  const [liveResult, repoResult] = await Promise.allSettled([livePromise, repoPromise]);
  // A second press while the first check is still in flight would otherwise
  // finish later and repaint the rows with the older run's answers.
  if (token !== appInfoCheckToken) return;

  const live = liveResult.status === "fulfilled" ? liveResult.value : null;
  const repo = repoResult.status === "fulfilled" ? repoResult.value : null;

  // An unstamped build has no version, so the "Live site" row would read back
  // the raw placeholder — not an answer. Everything else on this panel is still
  // a real fact and still worth showing: the repo rows say what has been pushed
  // and when, which is the only checkable thing left.
  appInfoLatest.textContent = IS_DEV_BUILD ? "not stamped" : (live?.stamp || "unknown");
  if (appInfoRepo) appInfoRepo.textContent = repo?.sha || (repoResult.reason?.rateLimited ? "unavailable (rate limited)" : "unavailable");
  if (appInfoCommit) {
    appInfoCommit.textContent = repo
      ? `${repo.sha}${repo.date ? ` · ${new Date(repo.date).toLocaleDateString()}` : ""}${repo.subject ? ` · ${repo.subject.slice(0, 60)}` : ""}`
      : "—";
  }

  // Nothing below can compare an unstamped build against anything, but WHY it
  // is unstamped is the useful part, and the two causes are opposite. Served
  // from localhost it is normal and expected. Served from a real host it is a
  // deployment that skipped the stamping step — which is invisible in every
  // other way, ships the same frozen ?v= to every future release, and is
  // exactly the failure this panel should name rather than shrug at.
  if (IS_DEV_BUILD) {
    if (appInfoReloadBtn) appInfoReloadBtn.hidden = true;
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (local) {
      setAppInfoStatus("Running from a local checkout — nothing to compare");
      setAppInfoWarning(
        repo
          ? `Files are served straight from disk, so there is no build version. Newest commit on ${GITHUB_REPO.branch} is ${repo.sha} — compare it against your working tree with git.`
          : "Files are served straight from disk, so there is no build version."
      );
    } else {
      setAppInfoStatus("This deploy was never stamped", "outdated");
      setAppInfoWarning(
        "The site was published without the deploy workflow's stamping step, so every asset URL is a literal placeholder and updates cannot be detected or cache-busted. " +
        "Fix: repo Settings → Pages → Source → \"GitHub Actions\", then re-run the deploy workflow."
      );
    }
    return;
  }

  // The failproof half. One deploy step writes every occurrence, so these can
  // only disagree if the site was published some other way — a half-finished
  // upload, a fork deploying from a branch, a stale file behind a CDN. No
  // comparison built on them would mean anything, so say THAT rather than
  // dressing the inconsistency up as an update.
  const stamps = releaseStampsIn(live?.html, live?.sw);
  const distinct = [...new Set(stamps.map((entry) => entry.stamp))];
  if (distinct.length > 1) {
    // One line per distinct place-and-value; index.html and APP_SHELL each
    // carry the stamp twice, and listing "index.html: X, index.html: X" makes
    // the one entry that actually differs harder to spot, not easier.
    const detail = [...new Set(stamps.map((entry) => `${entry.where}: ${entry.stamp}`))].join(", ");
    setAppInfoWarning(`Build versions disagree on the server — ${detail}. Every one of these is written from the same commit by the deploy workflow, so the site was published from something other than a completed deploy. Re-running it fixes this.`);
    setAppInfoStatus("Can't compare — the deployed build is inconsistent", "outdated");
    return;
  }

  if (!live) {
    setAppInfoStatus("Offline — can't check right now");
    return;
  }
  if (!live.stamp || running === "unknown") {
    setAppInfoStatus("Couldn't read a version to compare");
    return;
  }

  if (running !== live.stamp) {
    setAppInfoStatus("Update available — reload to update", "outdated");
    if (appInfoReloadBtn) appInfoReloadBtn.hidden = false;
    return;
  }

  // Everything below this line compares stamps, and a stamp is only as honest as
  // the assumption that the bundle which ran is the bundle the URL named. These
  // two cases are where that assumption breaks, so they have to be answered
  // before "up to date" is allowed to be said at all.
  if (isMixedBuild()) {
    setAppInfoStatus("Running a mixed build — reload to fix", "outdated");
    setAppInfoWarning(
      "Part of this app was served from an older release than the page itself, so the version above " +
      "is the version that was requested, not the one that ran. Reloading on a working connection fixes it."
    );
    if (appInfoReloadBtn) appInfoReloadBtn.hidden = false;
    return;
  }
  if (updateIsWaiting) {
    setAppInfoStatus("Update downloaded — reload to finish", "outdated");
    if (appInfoReloadBtn) appInfoReloadBtn.hidden = false;
    return;
  }
  if (updateDownloadFailed) {
    setAppInfoStatus("An update couldn't be downloaded — will retry", "outdated");
    setAppInfoWarning(
      "This device started downloading a newer version and didn't finish it. It retries automatically; " +
      "a stronger connection, or freeing up storage, is what usually lets it through."
    );
    return;
  }

  // Running the newest build the server has. The only question left is whether
  // the server has caught up with the repo — and, when it hasn't, WHICH WAY
  // round they sit. A server serving something that isn't on the branch is an
  // ordinary local build or a deploy from somewhere else, not something to warn
  // about; calling that "Pages hasn't published yet" would be exactly backwards.
  //
  // git answers this, so ask git. The old code guessed from string ordering of
  // two hand-typed YYYYMMDD-NN stamps, which was only ever right by convention
  // and said nothing at all once two builds shared a date.
  if (repo?.sha && repo.sha !== live.stamp) {
    const relation = await compareCommits(live.stamp, repo.sha);
    if (token !== appInfoCheckToken) return;
    if (relation === "ahead") {
      // The deployed commit is an ancestor of the branch head: the push landed,
      // the deploy hasn't finished.
      setAppInfoStatus(`Up to date with the live site — GitHub Pages hasn't published ${repo.sha} yet`, "outdated");
      setAppInfoWarning("Nothing to do here: your browser already has the newest build that exists on the server. Pages usually publishes within a couple of minutes of a push.");
    } else if (relation === "identical") {
      // Different short SHAs for the same commit shouldn't happen, but if they
      // do, the honest answer is that there is nothing to update.
      setAppInfoStatus("You're up to date ✓", "ok");
    } else if (relation === "unknown") {
      // Couldn't reach GitHub for the comparison. Everything reloading could
      // fix has already been ruled out above, so the useful half is still true.
      setAppInfoStatus("Up to date with the live site ✓", "ok");
      setAppInfoWarning(`Couldn't ask GitHub how ${live.stamp} relates to ${repo.sha}, so this only compares against the live site.`);
    } else {
      setAppInfoStatus("Up to date — this build isn't on the branch", "ok");
      setAppInfoWarning(`What the server is serving (${live.stamp}) isn't an ancestor of ${GITHUB_REPO.branch} (${repo.sha}) — a build published from somewhere else, or a branch that has been rewritten. Nothing to update.`);
    }
    return;
  }

  setAppInfoStatus(repo ? "You're up to date ✓" : "Up to date with the live site ✓", "ok");
  if (!repo) setAppInfoWarning("Couldn't reach GitHub, so this only compares against the live site.");
}

// ── Supabase project health check ──────────────────────────────────────────
// Every user connects their OWN Supabase project, and the setup form validates
// only the SHAPE of the URL and key — never that the project behind them has the
// schema this app needs. So a half-applied supabase_setup.sql, a storage policy
// block that was skipped because the SQL Editor's role couldn't alter
// storage.objects, or an upgrade from a pre-auth deployment whose rows have no
// user_id all present as "sync just doesn't work", with the real cause reachable
// only through a console the user does not have.
//
// Everything here is read-only: `limit(0)`/`limit(1)` reads and one storage
// list. Nothing is written, so running it can never make a broken project worse.
export const HEALTH_TIMEOUT_MS = 12000;

// PostgREST rejects a select naming a column that doesn't exist, so asking for
// the full column list is itself the column check — no information_schema
// access required (the anon role doesn't have it anyway).
export const HEALTH_TABLES = [
  {
    table: "decks",
    columns: "id, title, category, notes, meta, updated_at, last_accessed_at, current_card_index",
    label: "Decks table"
  },
  {
    table: "cards",
    columns: "id, deck_id, question, answer, position, status, category, updated_at",
    label: "Cards table"
  },
  {
    table: "deleted_decks",
    columns: "deck_id",
    label: "Delete tombstones",
    // The app degrades to local-only deletes without this rather than failing,
    // so it is a warning rather than a hard fault — but a deck deleted on one
    // device silently returning on the next sync is not something a user can
    // diagnose.
    soft: true
  },
  {
    table: "app_style_settings",
    columns: "id",
    label: "Style settings",
    soft: true
  }
];

export const RERUN_SQL = "Re-run supabase_setup.sql in your Supabase project's SQL Editor.";

export async function checkProjectHealth() {
  const results = [];
  const add = (label, status, detail) => results.push({ label, status, detail });

  if (!supabaseClient) {
    add("Connection", "fail", "No Supabase project is connected on this device.");
    return results;
  }
  if (!navigator.onLine) {
    add("Connection", "skip", "You're offline — reconnect to check.");
    return results;
  }

  const userId = await verifiedCloudUserId();
  if (!userId) {
    // Worth stopping for: under RLS every check below would come back
    // empty-and-successful, so an unauthenticated run would report a perfectly
    // healthy project as perfectly healthy while nothing actually worked.
    add("Signed in", "fail", "Not signed in, so nothing below can be checked. Sign in and try again.");
    return results;
  }
  add("Signed in", "ok", "Your session is valid.");

  for (const spec of HEALTH_TABLES) {
    try {
      const { error } = await withTimeout(
        abortable((signal) =>
          supabaseClient.from(spec.table).select(spec.columns).limit(1).abortSignal(signal)
        ),
        HEALTH_TIMEOUT_MS,
        `check ${spec.table}`
      );
      if (error) throw error;
      add(spec.label, "ok", `\`${spec.table}\` is present with every column this version needs.`);
    } catch (error) {
      const status = spec.soft ? "warn" : "fail";
      if (isMissingRelationError(error)) {
        add(spec.label, status, `The \`${spec.table}\` table doesn't exist. ${RERUN_SQL}`);
      } else if (String(error?.code || "") === "42703") {
        // The message names the offending column; it is the single most useful
        // string in the whole check, so pass it through rather than paraphrase.
        add(spec.label, status, `A column is missing — ${error.message}. ${RERUN_SQL}`);
      } else if (String(error?.code || "") === "42501") {
        add(spec.label, status, `Permission denied by Row Level Security. ${RERUN_SQL}`);
      } else {
        add(spec.label, status, error?.message || "Couldn't read this table.");
      }
    }
  }

  // Storage. The setup SQL's storage block is wrapped in an EXCEPTION handler
  // that downgrades insufficient_privilege to a NOTICE, so a project can finish
  // setup "successfully" with no image policies at all — after which every
  // upload fails and the outbox entry is discarded.
  try {
    const { error } = await withTimeout(
      supabaseClient.storage.from("images").list("", { limit: 1 }),
      HEALTH_TIMEOUT_MS,
      "check images bucket"
    );
    if (error) throw error;
    add("Image storage", "ok", "The `images` bucket is reachable.");
  } catch (error) {
    add(
      "Image storage",
      "warn",
      `The \`images\` bucket isn't reachable (${error?.message || "unknown error"}), so pasted images can't upload. ` +
      "Section 7 of supabase_setup.sql creates it and its policies."
    );
  }

  // The pre-auth-upgrade case. Rows whose user_id is NULL are hidden by RLS, so
  // the client cannot see them directly — it can only notice the shape they
  // make: this device is holding decks it previously confirmed in the cloud,
  // and the cloud now reports none at all.
  try {
    const { data, error } = await withTimeout(
      abortable((signal) => supabaseClient.from("decks").select("id").limit(1).abortSignal(signal)),
      HEALTH_TIMEOUT_MS,
      "check deck visibility"
    );
    if (error) throw error;
    const syncedLocally = readLocalDeckIndex().filter((entry) => entry.deckId && entry.lastSyncedAt).length;
    if ((!data || data.length === 0) && syncedLocally > 0) {
      add(
        "Deck ownership",
        "fail",
        `This device has ${syncedLocally} deck${syncedLocally === 1 ? "" : "s"} it previously synced, but your account ` +
        "can see none in the cloud. On a project upgraded from before sign-in existed, the existing rows have no owner " +
        "and RLS hides them. Section 8 of supabase_setup.sql has the one-line UPDATE that claims them."
      );
    } else {
      add("Deck ownership", "ok", "Your account can read its own decks.");
    }
  } catch (_) {
    // The table checks above already reported whatever is wrong here.
  }

  return results;
}

export const appInfoHealthList = document.getElementById("appInfoHealthList");

export const appInfoHealthSummary = document.getElementById("appInfoHealthSummary");

export const appInfoHealthBtn = document.getElementById("appInfoHealthBtn");

export function renderProjectHealth(results) {
  if (!appInfoHealthList) return;
  appInfoHealthList.textContent = "";
  const glyph = { ok: "✓", warn: "!", fail: "✕", skip: "–" };
  for (const row of results) {
    const li = document.createElement("li");
    li.className = `app-info-health-item is-${row.status}`;
    const mark = document.createElement("span");
    mark.className = "app-info-health-mark";
    mark.textContent = glyph[row.status] || "–";
    const body = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = row.label;
    body.append(name, document.createTextNode(` — ${row.detail}`));
    li.append(mark, body);
    appInfoHealthList.appendChild(li);
  }
  if (!appInfoHealthSummary) return;
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  if (failed) {
    appInfoHealthSummary.textContent =
      `${failed} problem${failed === 1 ? "" : "s"} will stop syncing from working properly. ${RERUN_SQL} It is safe to re-run and safe on a project that already holds decks.`;
    appInfoHealthSummary.hidden = false;
  } else if (warned) {
    appInfoHealthSummary.textContent =
      `Syncing works, but ${warned} feature${warned === 1 ? " is" : "s are"} degraded. ${RERUN_SQL}`;
    appInfoHealthSummary.hidden = false;
  } else {
    appInfoHealthSummary.hidden = true;
  }
}

export let healthCheckInFlight = false;

export async function runProjectHealthCheck() {
  if (healthCheckInFlight) return;
  healthCheckInFlight = true;
  if (appInfoHealthBtn) setButtonLoading(appInfoHealthBtn, true, "Checking…");
  if (appInfoHealthList) appInfoHealthList.textContent = "";
  if (appInfoHealthSummary) appInfoHealthSummary.hidden = true;
  try {
    renderProjectHealth(await checkProjectHealth());
  } catch (error) {
    console.warn("Project health check failed", error);
    renderProjectHealth([{ label: "Check", status: "fail", detail: error?.message || "Couldn't complete the check." }]);
  } finally {
    healthCheckInFlight = false;
    if (appInfoHealthBtn) setButtonLoading(appInfoHealthBtn, false);
  }
}

export function openAppInfoModal() {
  if (!appInfoModal) return;
  if (appInfoVersion) appInfoVersion.textContent = runningVersionLabel();
  appInfoModal.hidden = false;
  lockPageScroll();
  refreshAppInfo();
}

// "Check for updates" should mean it. The 5-minute GitHub cache exists to keep
// the modal's automatic refresh off the 60/hr budget — a deliberate press has
// to be able to look past it.
export function forceRefreshAppInfo() {
  setGithubReleaseCache({ at: 0, value: null });
  return refreshAppInfo();
}

export function closeAppInfoModal() {
  if (!appInfoModal) return;
  appInfoModal.hidden = true;
  unlockPageScroll();
}
