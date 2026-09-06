// The `pre-modular` tag, resolved once and in one place.
//
// Six checks compare the tree against the commit this app was before it was
// split out of a single app.js. Each of them reached for the tag itself, with
// its own `git show` or `git archive`, and each of them failed differently when
// the tag was not there:
//
//   split-parity  caught the throw and exited 2 with a sentence
//   css-parity    did not, and died at module top level with a Node stack trace
//                 forty lines long, which check.mjs then printed as the
//                 check's "summary"
//   the other four never got that far, because they skip on puppeteer first
//
// And "not there" is the ORDINARY case, not a broken checkout: `git clone`
// fetches tags reachable from the branches it fetches, and a shallow or
// single-branch clone — which is what CI and every container does — fetches
// none. So the two checks that do reach the tag are red on arrival, on a tree
// with nothing wrong with it.
//
// That is not a cosmetic complaint. Commit af39740 is the receipt: css-parity
// "has been red for months", and because it was red nobody was reading it when
// `split-css.mjs` — run without --check, which re-cuts the thirteen slices from
// this same tag — silently deleted three load-bearing rules. Twice. A gate that
// is always red reports nothing.
//
// So: find the tag, fetch it once if the remote has it, and if neither works
// say so in ONE line that names the command to run.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BASE_REF = "pre-modular";

const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

function resolves(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch (_) {
    return false;
  }
}

// Only ever attempted once per process, and never for a ref that looks like a
// sha or a branch — a fetch is a network call, and a check that silently makes
// one per run is a check that fails differently on a plane.
let fetchAttempted = false;

/**
 * Resolve the baseline ref, fetching the tag from origin if this clone does not
 * carry it. Returns the ref name; throws with a one-line, actionable message.
 */
export function resolveBaseline(ref = DEFAULT_BASE_REF) {
  if (resolves(ref)) return ref;

  if (!fetchAttempted && ref === DEFAULT_BASE_REF) {
    fetchAttempted = true;
    try {
      // --depth=1: the tag's tree is all any caller wants; its history is not.
      git(["fetch", "--depth=1", "--no-tags", "origin", "tag", ref], { timeout: 120000 });
    } catch (_) { /* reported below, with the remedy */ }
    if (resolves(ref)) return ref;
  }

  throw new Error(
    `baseline ref '${ref}' is not in this clone. Run: git fetch --depth=1 origin tag ${ref}`
  );
}

/** `git show <ref>:<file>`, with the same resolution and the same one-line failure. */
export function baselineFile(file, ref = DEFAULT_BASE_REF) {
  const resolved = resolveBaseline(ref);
  return execFileSync("git", ["show", `${resolved}:${file}`], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024
  }).toString();
}

/** `git archive <ref> | tar -x -C <dir>`, ditto. */
export function baselineTreeInto(dir, ref = DEFAULT_BASE_REF) {
  const resolved = resolveBaseline(ref);
  execFileSync("bash", ["-c", `git archive ${resolved} | tar -x -C ${dir}`], { cwd: ROOT });
  return dir;
}

/**
 * The shape every caller wants at module top level: resolve, or print the one
 * line and exit 2. Exit 2 rather than 1 so a missing baseline reads differently
 * from a real parity failure.
 */
export function requireBaseline(ref = DEFAULT_BASE_REF) {
  try {
    return resolveBaseline(ref);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
