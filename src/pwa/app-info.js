// The App Info modal: installed version, what the origin is serving, and the
// project health check.
//
// The health probe reads only. It exists because a half-applied setup SQL
// otherwise announces itself as a dozen unrelated symptoms scattered across
// the app rather than as one missing column.

import { getCachedSession, verifiedCloudUserId } from "../cloud/auth.js?v=__BUILD__";
import { isMissingRelationError } from "../cloud/deck-list.js?v=__BUILD__";
import { abortable, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { loadSupabaseConfig, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { IS_DEV_BUILD } from "../core/build.js?v=__BUILD__";
import { readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { probeLocalStorage } from "../storage/health.js?v=__BUILD__";
import { SYNC_CLOCK_SKEW_TOLERANCE_MS, tsMs } from "../sync/stats.js?v=__BUILD__";
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

// ── Which Supabase project this device is connected to ─────────────────────
// The health check below answers "does it work". This answers "which one" —
// and on an app where every install brings its own backend, that is the
// question a failing check is useless without. The URL and key are entered
// once, on a setup screen the user never sees again, and are then only in
// localStorage: until now no surface in the app could read them back, so a
// device pointed at a stale project, a second project, or someone else's
// reported perfectly real failures about a database the user wasn't thinking
// of, with no way to notice the mismatch.

export const appInfoProjectUrl = document.getElementById("appInfoProjectUrl");

export const appInfoProjectRef = document.getElementById("appInfoProjectRef");

export const appInfoProjectKey = document.getElementById("appInfoProjectKey");

export const appInfoProjectAccount = document.getElementById("appInfoProjectAccount");

export const appInfoProjectUserId = document.getElementById("appInfoProjectUserId");

// The project ref is the first label of a hosted Supabase URL
// (https://<ref>.supabase.co) and is what the dashboard URL, the CLI and every
// support thread are keyed on. Returns "" for a self-hosted or proxied URL,
// where the concept simply doesn't apply — better to say nothing than to
// present a hostname fragment as an id that can be looked up.
export function supabaseProjectRef(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!/\.supabase\.(co|in|net)$/.test(host)) return "";
    const ref = host.split(".")[0];
    return ref && ref !== "www" ? ref : "";
  } catch {
    return "";
  }
}

// Enough of the key to tell two projects apart, and not enough to paste
// anywhere. The anon key is public by design — it ships in the page of every
// Supabase app — but a full credential-shaped string on screen invites being
// treated as a secret worth sending to someone, so show it the way a card
// number is shown.
export function maskSupabaseKey(key) {
  const value = String(key || "");
  if (!value) return "";
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

// A legacy Supabase key is a JWT whose payload names the role it acts as. Worth
// reading, because exactly one wrong value here is dangerous rather than
// merely broken: a `service_role` key pasted in place of the anon key works
// perfectly — every screen in the app behaves — while bypassing Row Level
// Security entirely and sitting in localStorage where any script on the origin
// can read it. It cannot be detected from behaviour, only from the key itself.
// Returns "" for the newer `sb_publishable_…` keys, which are not JWTs and
// carry no role to read.
export function supabaseKeyRole(key) {
  const parts = String(key || "").split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload?.role === "string" ? payload.role : "";
  } catch {
    return "";
  }
}

export function setProjectRow(node, text, absent = false) {
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("is-absent", absent);
}

export async function renderSupabaseProjectDetails() {
  const config = loadSupabaseConfig();
  if (!config?.url) {
    setProjectRow(appInfoProjectUrl, "Not connected", true);
    setProjectRow(appInfoProjectRef, "—", true);
    setProjectRow(appInfoProjectKey, "—", true);
    setProjectRow(appInfoProjectAccount, "—", true);
    setProjectRow(appInfoProjectUserId, "—", true);
    return;
  }

  setProjectRow(appInfoProjectUrl, config.url);

  const ref = supabaseProjectRef(config.url);
  if (ref && appInfoProjectRef) {
    // A link, because the ref's only real use is getting to the dashboard for
    // this project — which is where every fix the health check recommends
    // (re-run the SQL, enable email sign-in, create the bucket) has to happen.
    appInfoProjectRef.textContent = "";
    appInfoProjectRef.classList.remove("is-absent");
    const link = document.createElement("a");
    link.href = `https://supabase.com/dashboard/project/${ref}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = ref;
    appInfoProjectRef.appendChild(link);
  } else {
    setProjectRow(appInfoProjectRef, "self-hosted", true);
  }

  const role = supabaseKeyRole(config.key);
  const masked = maskSupabaseKey(config.key) || "missing";
  // Said plainly rather than as a status colour: this is the one row where the
  // value being wrong is a security problem and not a broken feature.
  setProjectRow(
    appInfoProjectKey,
    role && role !== "anon" ? `${masked} — ${role} key, replace it with the anon key` : masked,
    !config.key
  );

  // getCachedSession, not verifiedCloudUserId: this row reports what the device
  // is holding, and a lapsed token is exactly the state worth being able to
  // see here. Whether that session still works is the health check's job.
  const session = await getCachedSession();
  setProjectRow(appInfoProjectAccount, session?.user?.email || "Signed out", !session?.user);
  setProjectRow(appInfoProjectUserId, session?.user?.id || "—", !session?.user);
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

// The rows that mean "the check stopped here and proved nothing" — both are
// early returns in checkProjectHealth. They are not schema problems and must
// never be answered with "re-run the SQL": being signed out is not fixed by
// running SQL, and neither is having no project connected. Exported because
// announceProjectHealthOnce needs the same list to decide whether a background
// run learnt anything worth remembering.
export const HEALTH_BAILOUT_LABELS = ["Connection", "Signed in"];

// ── Whose clock is actually wrong? ─────────────────────────────────────────
//
// reconcileAllDecks raises "Another device's clock is wrong" from a comparison
// that cannot actually attribute the fault: clockSkewedAhead is true when a
// cloud stamp is ahead of THIS device, and a laptop running slow looks exactly
// like another device running fast. Naming the wrong culprit sends the reader
// to check devices that are fine.
//
// The server's clock is the third opinion that settles it, and it costs one
// header. Every HTTP response carries `Date`, and this page's own origin needs
// no project, no session and no body to ask — release-info.js already fetches
// the same file for the build stamp.
//
// Returns null rather than throwing: "we could not ask" is a different answer
// from "the clock is fine", and the caller reports it as a skip rather than a
// pass.
export async function fetchServerTime() {
  try {
    const response = await withTimeout(
      fetch("./index.html", { method: "HEAD", cache: "no-store" }),
      HEALTH_TIMEOUT_MS,
      "read the server's clock"
    );
    const header = response?.headers?.get("date");
    const at = header ? new Date(header).getTime() : NaN;
    return Number.isFinite(at) ? at : null;
  } catch (error) {
    console.warn("Could not read the server's clock", error);
    return null;
  }
}

// Well under SYNC_CLOCK_SKEW_TOLERANCE_MS, which is where the sync stops being
// able to order edits at all: a clock drifting toward that line is worth saying
// out loud before it crosses it, and a `Date` header is only second-accurate so
// anything tighter would report noise.
export const CLOCK_OFFSET_TOLERANCE_MS = 30 * 1000;

// Whole units, largest that still reads as a quantity. "7200 seconds" is a
// number the reader has to do arithmetic on before it means anything.
export function describeDuration(ms) {
  const abs = Math.abs(ms);
  const unit = (value, name) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (abs < 90 * 1000) return unit(Math.max(1, Math.round(abs / 1000)), "second");
  if (abs < 90 * 60 * 1000) return unit(Math.round(abs / 60000), "minute");
  if (abs < 48 * 60 * 60 * 1000) return unit(Math.round(abs / 3600000), "hour");
  return unit(Math.round(abs / 86400000), "day");
}

// The worst stamp sitting in the future, and how many there are, measured
// against whichever clock the caller could get. Same tolerance the sync itself
// uses, so this row agrees with the warning it is trying to explain.
export function summarizeFutureStamps(entries, referenceMs) {
  let worstAt = 0;
  let worstTitle = "";
  let count = 0;
  for (const entry of entries || []) {
    const at = tsMs(entry?.at);
    if (!at || at <= referenceMs + SYNC_CLOCK_SKEW_TOLERANCE_MS) continue;
    count++;
    if (at > worstAt) {
      worstAt = at;
      worstTitle = String(entry?.title || "Untitled deck");
    }
  }
  return { count, worstTitle, aheadMs: worstAt ? worstAt - referenceMs : 0 };
}

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

  // ── Before anything that needs the network, and before every early return
  // below ────────────────────────────────────────────────────────────────────
  //
  // This is the check that explains the other answers rather than joining them.
  // supabase-js keeps the session in localStorage (persistSession, see
  // initSupabaseClient), so a browser refusing writes cannot stay signed in —
  // and the "Not signed in, so nothing below can be checked" return two blocks
  // down is then a SYMPTOM being reported as the diagnosis. Asked first, it
  // names the actual cause; asked after the early returns, it would never be
  // reached on precisely the devices that need it.
  const storage = probeLocalStorage();
  if (storage.writable) {
    add("Browser storage", "ok", "This browser lets Recall save your sign-in and your deck list.");
  } else {
    add("Browser storage", "fail",
      `Recall can't write to this browser's storage, so it can't stay signed in between loads. ${storage.reason}`);
  }

  // ── The clock, and the stamps that depend on it ───────────────────────────
  //
  // Placed with the storage row, ahead of every early return below, and for the
  // same reason: the deck-stamp half needs no network, no project and no
  // session, and the clock half needs only the origin this page came from.
  // Behind the "Not signed in, so nothing below can be checked" return they
  // would be missing from precisely the report trying to explain why.
  const serverNow = navigator.onLine ? await fetchServerTime() : null;
  const localNow = Date.now();
  if (!navigator.onLine) {
    add("Device clock", "skip", "You're offline — reconnect to compare this device's clock with the server's.");
  } else if (serverNow === null) {
    add("Device clock", "skip", "Couldn't read the server's clock to compare against.");
  } else {
    const offset = localNow - serverNow;
    if (Math.abs(offset) <= CLOCK_OFFSET_TOLERANCE_MS) {
      add("Device clock", "ok", "This device's clock agrees with the server's.");
    } else if (offset < 0) {
      add("Device clock", "fail",
        `This device's clock is ${describeDuration(offset)} behind the server's. `
        + "A slow clock makes every deck look as though some other device stamped it in the future, "
        + "so fix the date and time here before suspecting another device.");
    } else {
      add("Device clock", "fail",
        `This device's clock is ${describeDuration(offset)} ahead of the server's. `
        + "A fast clock stamps this device's edits in every other device's future, which is what makes "
        + "them report a clock problem.");
    }
  }

  // Deliberately this device's own index rather than a cloud query: a pull
  // writes the cloud row's stamp straight into the local index entry (see the
  // two-clocks note in sync/stats.js), so a poisoned stamp is already here to be
  // read — with no network, no session and no round trip.
  const reference = serverNow === null ? localNow : serverNow;
  const referenceName = serverNow === null ? "this device's clock" : "the server's clock";
  const future = summarizeFutureStamps(
    readLocalDeckIndex().map((meta) => ({ at: meta?.updatedAt, title: meta?.title })),
    reference
  );
  if (!future.count) {
    add("Deck timestamps", "ok", `No deck is stamped in the future, measured against ${referenceName}.`);
  } else {
    // A warning, not a failure: the project is fine and the decks are intact.
    // What is degraded is the sync's ability to ORDER two edits against these
    // decks, which is what raises the clock toast and keeps re-raising the
    // notes conflict.
    add("Deck timestamps", "warn",
      `${future.count} deck${future.count === 1 ? " is" : "s are"} stamped ahead of ${referenceName} — `
      + `"${future.worstTitle}" by ${describeDuration(future.aheadMs)}. `
      + "Nothing is lost, but until those stamps come back to real time the sync can't order edits "
      + "against those decks — which is what raises the clock warning and the repeating notes conflicts.");
  }

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
  // The standing advice for everything on this list is "re-run the SQL", and
  // for the rows about THIS DEVICE that is both useless and misleading —
  // nothing about the project is wrong. They also explain the rows below them
  // rather than joining them, so they lead and they are counted separately.
  const isLocalRow = (r) => r.label === "Browser storage" || r.label === "Device clock";
  const isBailout = (r) => HEALTH_BAILOUT_LABELS.includes(r.label);
  const storageFailed = results.some((r) => r.label === "Browser storage" && r.status === "fail");
  const clockFailed = results.some((r) => r.label === "Device clock" && r.status === "fail");
  const bailedOut = results.some((r) => r.status === "fail" && isBailout(r));
  // Only the rows that actually describe the PROJECT. The bail-out rows used to
  // be counted here, so a signed-out device was told its schema was broken and
  // sent to re-run SQL that was never the problem.
  const projectFailed = results.filter((r) => r.status === "fail" && !isLocalRow(r) && !isBailout(r)).length;
  if (storageFailed) {
    const others = failed - 1;
    appInfoHealthSummary.textContent =
      "This browser won't let Recall store anything, so your sign-in can't be kept and syncing can't run. "
      + "Nothing is wrong with your decks or your project — check this site's cookie and site-data permissions, "
      + "try a normal (non-private) window, or free up disk space."
      + (others > 0 ? ` ${others} other check${others === 1 ? "" : "s"} could not be trusted while storage is failing.` : "");
    appInfoHealthSummary.hidden = false;
  } else if (clockFailed) {
    appInfoHealthSummary.textContent =
      "This device's own clock is wrong, and every sync comparison is made against it. "
      + "Correct the date and time here first — until that is right, the app cannot tell which device is "
      + "actually at fault, and \"another device's clock is wrong\" may well be about this one."
      + (projectFailed > 0
        ? ` ${projectFailed} project check${projectFailed === 1 ? "" : "s"} also failed. ${RERUN_SQL}`
        : " Nothing is wrong with your project.");
    appInfoHealthSummary.hidden = false;
  } else if (projectFailed) {
    appInfoHealthSummary.textContent =
      `${projectFailed} problem${projectFailed === 1 ? "" : "s"} will stop syncing from working properly. ${RERUN_SQL} It is safe to re-run and safe on a project that already holds decks.`;
    appInfoHealthSummary.hidden = false;
  } else if (bailedOut) {
    // Nothing below the bail-out ran, so there is no verdict on the project to
    // give — and claiming one either way would be a guess. Say what is missing
    // and what would fill it in.
    appInfoHealthSummary.textContent =
      "The project checks couldn't run — the rows above say why. Fix that and check again; "
      + "nothing here says anything is wrong with your project yet.";
    appInfoHealthSummary.hidden = false;
  } else if (warned) {
    // Same split as the failures above: a deck stamped in the future is not a
    // schema problem, so it must not carry the "re-run the SQL" advice. When it
    // is the ONLY warning, that advice would be the whole message and would be
    // entirely wrong.
    const stampsWarned = results.some((r) => r.label === "Deck timestamps" && r.status === "warn");
    const projectWarned = results.filter((r) => r.status === "warn" && r.label !== "Deck timestamps").length;
    appInfoHealthSummary.textContent = stampsWarned && !projectWarned
      ? "Syncing works and nothing is lost, but some decks carry timestamps from the future, so edits on them "
        + "can't be ordered reliably. Check the date and time on every device that uses this project — "
        + "your project itself is fine."
      : `Syncing works, but ${projectWarned} feature${projectWarned === 1 ? " is" : "s are"} degraded. ${RERUN_SQL}`
        + (stampsWarned ? " Some decks are also stamped in the future — check the date and time on your devices." : "");
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
  // Local reads (localStorage config, cached session) — no network, so these
  // rows are filled before the version check has finished its first request.
  renderSupabaseProjectDetails().catch((error) => console.warn("Could not read the Supabase project details", error));
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
