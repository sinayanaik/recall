// What version is running, and what version the origin would serve now.
//
// The running version is a constant compiled into the build, NOT a read of the
// <script src> attribute — that attribute is the URL the page asked for and
// says nothing about the bytes that answered. When the worker had to fall back
// across releases, reading it reported the new version while old code ran.

import { BUILD_STAMP, BUILD_TIME, IS_DEV_BUILD } from "../core/build.js?v=__BUILD__";

// The running build's version. Normally the commit SHA above; "dev" for an
// unstamped checkout, "unknown" only if this file was somehow loaded without one.
export function runningAppVersion() {
  if (IS_DEV_BUILD) return "dev";
  return BUILD_STAMP || "unknown";
}

// The build time as a human would read it, or "" when there is nothing honest
// to show — an unstamped checkout, or a value sed never reached.
export function runningBuildTime() {
  if (IS_DEV_BUILD || !BUILD_TIME || BUILD_TIME.startsWith("__")) return "";
  const when = new Date(BUILD_TIME);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

// What the "Installed version" row says: the commit, and when that commit was
// made. Both come from the deploy, so neither can be stale relative to the
// other the way a typed stamp and a typed date could.
export function runningVersionLabel() {
  const version = runningAppVersion();
  const builtAt = runningBuildTime();
  return builtAt ? `${version} · ${builtAt}` : version;
}

// What the page REQUESTED, as distinct from what it got. Compared against
// BUILD_STAMP to catch a cross-release fallback the worker didn't report — the
// message needs a controller and an open channel, and neither is guaranteed on
// the very load that went wrong.
export function requestedAppVersion() {
  const src = document.querySelector('script[src*="main.js"]')?.getAttribute("src") || "";
  return src.match(/[?&]v=([^&]+)/)?.[1] || null;
}

// Where the source of truth lives. One place, so a fork edits one line.
export const GITHUB_REPO = { owner: "sinayanaik", repo: "recall", branch: "main" };

export const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}`;

// The release stamp as it appears in index.html — the SAME string the running
// page's <script src> carries, which is the whole point: the old check compared
// index.html's ?v= against sw.js's CACHE_NAME, two hand-maintained numbers in
// five different places. Whenever they drifted, the app announced "Update
// available" forever and offered a Reload button that could not possibly fix
// it, because there was no newer build to reload into.
//
// Since the deploy substitutes a commit SHA, that stamp IS the deployed commit,
// which is why the repo half of this check no longer has to download a file to
// read a version out of it.
export const RELEASE_STAMP_RE = /src\/main\.js\?v=([^"'&\s]+)/;

// `const` is part of the pattern deliberately: the cache name no longer carries
// a "v" prefix, so a bare `CACHE_NAME\s*=` would also match sw.js's
// IMAGE_CACHE_NAME ("recall-images-v1") and report the image cache as a second,
// disagreeing release version.
export const CACHE_NAME_RE = /const CACHE_NAME\s*=\s*"recall-([^"]+)"/;

export function stampFromHtml(text) {
  return text.match(RELEASE_STAMP_RE)?.[1] || null;
}

// Every ?v= in a served index.html, plus sw.js's CACHE_NAME. All must agree for
// a release to be coherent.
//
// sw.js's APP_SHELL entries are deliberately NOT read any more: they are now
// built from CACHE_NAME (`./app.js?v=${STAMP}`) rather than typed out, so there
// is nothing left there to disagree. Scanning for them regardless was actively
// wrong — the pattern matched the template literal and captured "${STAMP}`," as
// a stamp, so every build reported itself inconsistent and the modal refused to
// compare anything at all.
export function releaseStampsIn(html, sw) {
  const stamps = [];
  if (html) {
    for (const match of html.matchAll(/(?:app|styles)\.(?:js|css)\?v=([^"'&\s]+)/g)) {
      stamps.push({ where: "index.html", stamp: match[1] });
    }
  }
  if (sw) {
    const cacheName = sw.match(CACHE_NAME_RE);
    if (cacheName) stamps.push({ where: "sw.js CACHE_NAME", stamp: cacheName[1] });
    // A literal stamp here means an older sw.js that still hand-maintains them,
    // which is exactly the drift worth reporting. The template form contains
    // "${" and is skipped.
    for (const match of sw.matchAll(/\.\/(?:app|styles)\.(?:js|css)\?v=([^"'&\s`]+)/g)) {
      if (match[1].includes("${")) continue;
      stamps.push({ where: "sw.js APP_SHELL", stamp: match[1] });
    }
  }
  return stamps;
}

// Every request this check makes is bounded. Without it the modal's rows sit on
// "checking…" for as long as the network cares to hang — and a version
// indicator that can silently never finish is exactly the thing it exists not
// to be. A timeout is a real answer ("couldn't reach it"); no answer is not.
export const UPDATE_CHECK_TIMEOUT_MS = 8000;

export function updateCheckSignal() {
  try {
    return AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
  } catch (_) {
    return undefined; // pre-2022 engine: fall back to an unbounded fetch
  }
}

// Same-origin fetch for the update check, on UPDATE_CHECK_TIMEOUT_MS. Renamed
// from `fetchText` because a second function of that name existed 4,000 lines
// up for URL imports; see fetchImportText for what that collision cost.
export async function fetchReleaseText(url, options = {}) {
  const response = await fetch(url, { signal: updateCheckSignal(), ...options });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.text();
}

// What this origin would hand a visitor arriving right now. `no-store` keeps
// both the browser's HTTP cache and the service worker's cached copy out of the
// answer — and sw.js exempts itself from interception outright (see its fetch
// handler), so neither file can come back stale.
export async function fetchLiveRelease() {
  const [html, sw] = await Promise.all([
    fetchReleaseText("./index.html", { cache: "no-store" }),
    fetchReleaseText("./sw.js", { cache: "no-store" }).catch(() => null)
  ]);
  return { stamp: stampFromHtml(html), html, sw };
}

// The repo itself: the newest commit on the branch. Cross-origin and not a CDN
// asset, so the service worker's fetch handler returns early and never touches
// this.
//
// This used to additionally download index.html and sw.js from
// raw.githubusercontent.com at that commit, purely to read a hand-typed stamp
// out of them. It no longer has to: the deployed version IS the short SHA, so
// the commit listing already answers the question and two round-trips per check
// disappeared with it.
export let githubReleaseCache = { at: 0, value: null };

// Setter: an imported binding is read-only, and the App Info modal fills this cache when it checks for a release.
export function setGithubReleaseCache(value) {
  githubReleaseCache = value;
}

export const GITHUB_CACHE_MS = 5 * 60 * 1000;

export function githubHeaders() {
  return { Accept: "application/vnd.github+json" };
}

// 403 and 429 are the unauthenticated rate limit (60/hr, shared per IP), not a
// broken repo — worth saying so rather than reporting the repo as unreachable.
export function throwIfRateLimited(response) {
  if (response.status === 403 || response.status === 429) {
    throw Object.assign(new Error("rate limited"), { rateLimited: true });
  }
}

export async function fetchRepoRelease() {
  if (githubReleaseCache.value && Date.now() - githubReleaseCache.at < GITHUB_CACHE_MS) {
    return githubReleaseCache.value;
  }
  const commitResponse = await fetch(`${GITHUB_API}/commits/${GITHUB_REPO.branch}`, { headers: githubHeaders(), cache: "no-store", signal: updateCheckSignal() });
  throwIfRateLimited(commitResponse);
  if (!commitResponse.ok) throw new Error(`commits -> ${commitResponse.status}`);
  const commit = await commitResponse.json();

  const value = {
    // Seven characters, matching what the deploy writes into the files, so the
    // two are directly comparable without normalising either side.
    sha: String(commit.sha || "").slice(0, 7),
    date: commit.commit?.author?.date || commit.commit?.committer?.date || null,
    subject: String(commit.commit?.message || "").split("\n")[0]
  };
  setGithubReleaseCache({ at: Date.now(), value });
  return value;
}

// Which way round two commits sit. Answers the one question that decides
// between "Pages hasn't published your push yet" and "you're running something
// that isn't on the branch at all" — and answers it from git's actual history
// rather than, as the old code did, by comparing two YYYYMMDD-NN strings
// lexically and hoping the author's typed dates ran in the right order.
//
// Returns GitHub's own status: "identical", "ahead" (deployed is an ancestor of
// HEAD, i.e. the branch has moved on), "behind", or "diverged". Plus two of our
// own, and the difference between them matters:
//
//   "absent"  — 404. The sha is not in this repo at all, which is a real answer.
//   "unknown" — rate limited, offline, timed out. NOT an answer.
//
// Collapsing those two was tempting and wrong: the repo row can come from the
// 5-minute cache while this call is the one that trips the 60/hr rate limit,
// and reporting "this build isn't on the branch" because GitHub declined to
// say is exactly the kind of confident-but-baseless claim this whole rewrite
// exists to remove.
export async function compareCommits(base, head) {
  try {
    const response = await fetch(`${GITHUB_API}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, {
      headers: githubHeaders(),
      cache: "no-store",
      signal: updateCheckSignal()
    });
    if (response.status === 404) return "absent";
    if (!response.ok) return "unknown";
    const body = await response.json();
    return body?.status || "unknown";
  } catch (_) {
    return "unknown";
  }
}
