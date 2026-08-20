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
//   scanner-audit   does the scanner module-symbols relies on actually SEE
//                   every reference? (it once did not, and hid 13 of them)
//   module-symbols  does every cross-module reference resolve?
//   css-parity      do the stylesheet slices still reassemble to the original?
//   port-sync       do the extension's copies still match?
//   vendor          are the vendored libraries on disk, unmodified, and
//                   precached? (a hole here is a blank page offline, not a
//                   missing feature — they are blocking tags before main.js)
//   precache        does sw.js precache every module the app imports, and
//                   nothing that no longer exists? (a missing entry breaks the
//                   app OFFLINE only; a stale one stops any worker activating)
//   boot-check      does it actually run?
//   behaviour       does it still produce the same answers?
//   render-scale    does a BIG note still render? (2,000+ blocks takes a
//                   different branch that nothing else here ever reaches — a
//                   total failure of large notes once passed every other check)
//   mobile-menu     does the ☰ drawer still open on a PHONE with a book on
//                   screen? The only check that throttles the CPU and uses a
//                   fixture with figures in it, and it times the shared
//                   overlay/chrome plumbing directly — all three are why the
//                   drawer freeze survived five rounds of profiling
//   style           does a Style panel setting reach the element it names?
//   highlight       does highlighting mark the thing that was SELECTED?
//   paged           can you reach the end of a note in paged reading mode?
//   ribbon          does the caret band sit where the caret is, and stay still
//                   when it should?
//                   (these three assert OUTCOMES rather than parity — a fix
//                   changes the answer, so parity cannot see it by design)
//   sync            do the merge PRIMITIVES behave identically, and still
//                   refuse to lose data? (parity plus invariants — passing one
//                   is not passing the other)
//   reconcile       does the whole two-way sync behave identically end to end,
//                   driven against a stand-in backend?
//   ui-smoke        does the APP still work? 18 real actions — import, flip,
//                   mark known, All Cards, notes, export, sync — driven through
//                   the DOM on both builds and compared step by step
//   selection       can you still select text in a note without dragging the
//                   app's own chrome in with it? Real mouse drags, because
//                   selection is a browser behaviour, not a function
//   mobile-select   the same question with a FINGER: does the app still let go
//                   of the gesture a long press needs? touch-action on the
//                   reading surfaces, the card swipe standing down for a dwell,
//                   containment suspended under a live selection, the page snap
//                   held off, and the bar waiting for the drag to finish. The
//                   native handles themselves are browser UI and absent in
//                   headless Chrome — that half is a real-device check
//   offline         does it START with no network, a blocked CDN, or a CDN
//                   that hangs? (the one question nothing used to ask — every
//                   other check here runs with a working connection, and the
//                   app shipped unable to launch offline because of it)
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
  ["scanner-audit ", ["node", ["tools/scanner-audit.mjs"], ROOT]],
  ["module-symbols", ["node", ["tools/module-symbols.mjs"], ROOT]],
  ["css-parity   ", ["node", ["tools/split-css.mjs", "--check"], ROOT]],
  ["port-sync     ", ["node", ["tools/port-sync.mjs"], path.join(ROOT, "recall-clipper")]],
  ["vendor        ", ["node", ["tools/vendor-sync.mjs", "--check"], ROOT]],
  ["precache      ", ["node", ["tools/precache-check.mjs"], ROOT]],
  ...(QUICK ? [] : [
    ["boot-check    ", ["node", ["tools/boot-check.mjs", "--baseline", "pre-modular"], ROOT]],
    ["behaviour     ", ["node", ["tools/behaviour-parity.mjs"], ROOT]],
    ["sync          ", ["node", ["tools/sync-parity.mjs"], ROOT]],
    ["reconcile     ", ["node", ["tools/reconcile-parity.mjs"], ROOT]],
    ["ui-smoke      ", ["node", ["tools/ui-smoke.mjs"], ROOT]],
    ["selection     ", ["node", ["tools/selection-check.mjs"], ROOT]],
    ["mobile-select ", ["node", ["tools/mobile-selection-check.mjs"], ROOT]],
    ["render-scale  ", ["node", ["tools/render-scale-check.mjs"], ROOT]],
    ["interaction   ", ["node", ["tools/interaction-scale-check.mjs"], ROOT]],
    ["mobile-menu   ", ["node", ["tools/mobile-menu-check.mjs"], ROOT]],
    ["style         ", ["node", ["tools/style-check.mjs"], ROOT]],
    ["highlight     ", ["node", ["tools/highlight-check.mjs"], ROOT]],
    ["paged         ", ["node", ["tools/paged-check.mjs"], ROOT]],
    ["ribbon        ", ["node", ["tools/ribbon-check.mjs"], ROOT]],
    ["offline       ", ["node", ["tools/offline-check.mjs"], ROOT]],
    ...(FULL ? [["release-check ", ["node", ["tools/release-check.mjs"], ROOT]]] : [])
  ])
];

// port-sync has two PRE-EXISTING drifts, present since before the restructure
// began and unrelated to it (the clipper's protectInline has not picked up note
// links, and its SANITIZE_CONFIG lags on ADD_ATTR). Failing every run on them
// would train the eye to ignore a red line, so the expected count is pinned
// here: any OTHER drift, or these two being fixed, changes the number and fails.
const PORT_SYNC_EXPECTED_DRIFT = 2;

// Was 2 while the render ran as one synchronous burst — a 2.6MB note blocked
// the main thread for 382ms and showed nothing at all until it finished. The
// render is now streamed in batches with a frame between them (first visible
// text at ~170ms instead of ~880ms), so those cases pass and this is 0. It must
// never go up again.
const RENDER_SCALE_EXPECTED_FAILURES = 0;

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
  } else if (label.trim() === "render-scale") {
    const failedCases = Number(out.match(/·\s*(\d+) failed/)?.[1] ?? -1);
    ok = failedCases === RENDER_SCALE_EXPECTED_FAILURES;
    note = ok
      ? `${out.trim().split("\n").filter(Boolean).pop()}${failedCases ? ` (${failedCases} known)` : ""}`
      : `expected ${RENDER_SCALE_EXPECTED_FAILURES} known failure(s), got ${failedCases}`;
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
