// Everything, in one command. Run this before every commit.
//
//   node tools/check.mjs
//   node tools/check.mjs --quick     # skip the browser (static checks only)
//   node tools/check.mjs --full      # ...and drive a real install/update/offline cycle
//
// This exists because running the checks individually meant one of them could
// be skipped, and one of them was: a `git checkout` during an unrelated
// experiment reverted an import fix, split-parity still passed (it compares
// declaration bodies, and the bodies were fine), and the commit shipped a
// module importing a name that had moved. The page died at instantiation with
// "does not provide an export named 'resetCardUndoHistory'". Every check needed
// to catch it existed; nothing made running all of them the default.
//
// Each check answers a different question, and none of them subsumes another:
//
//   split-parity    is the code still the same code?
//   module-symbols  does every cross-module reference resolve?
//   css-parity      do the stylesheet slices still reassemble to the original?
//   port-sync       do the extension's copies still match?
//   boot-check      does it actually run?
//   behaviour       does it still produce the same answers?
//   release-check   (--full) does a release reach an existing install, and
//                   does it work offline?

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUICK = process.argv.includes("--quick");
// The release path drives two real service-worker installs and takes ~40s, so
// it is opt-in. Run it before merging — it is the only check that exercises the
// failure this repo has actually shipped: a release that never reaches an
// existing install.
const FULL = process.argv.includes("--full");

const checks = [
  ["split-parity  ", ["node", ["tools/split-parity.mjs"], ROOT]],
  ["module-symbols", ["node", ["tools/module-symbols.mjs"], ROOT]],
  ["css-parity   ", ["node", ["tools/split-css.mjs", "--check"], ROOT]],
  ["port-sync     ", ["node", ["tools/port-sync.mjs"], path.join(ROOT, "recall-clipper")]],
  ...(QUICK ? [] : [
    ["boot-check    ", ["node", ["tools/boot-check.mjs", "--baseline", "main"], ROOT]],
    ["behaviour     ", ["node", ["tools/behaviour-parity.mjs"], ROOT]],
    ...(FULL ? [["release-check ", ["node", ["tools/release-check.mjs"], ROOT]]] : [])
  ])
];

// port-sync has two PRE-EXISTING drifts, present since before the restructure
// began and unrelated to it (the clipper's protectInline has not picked up note
// links, and its SANITIZE_CONFIG lags on ADD_ATTR). Failing every run on them
// would train the eye to ignore a red line, so the expected count is pinned
// here: any OTHER drift, or these two being fixed, changes the number and fails.
const PORT_SYNC_EXPECTED_DRIFT = 2;

let failed = 0;
for (const [label, [cmd, args, cwd]] of checks) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  let ok = r.status === 0;
  let note = "";

  if (label.trim() === "port-sync") {
    const drift = Number(out.match(/(\d+) drifted/)?.[1] ?? -1);
    ok = drift === PORT_SYNC_EXPECTED_DRIFT;
    note = ok ? `(${drift} known pre-existing drift)` : `expected ${PORT_SYNC_EXPECTED_DRIFT} drifted, got ${drift}`;
  } else {
    note = out.trim().split("\n").filter(Boolean).pop() || "";
  }

  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}  ${note}`);
  if (!ok) {
    failed++;
    console.log(out.split("\n").map((l) => `        ${l}`).join("\n"));
  }
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
