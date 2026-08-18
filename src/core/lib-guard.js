// Is each library the first render depends on actually here?
//
// index.html loads marked, DOMPurify and KaTeX as parser-blocking <script>
// tags, and until they were vendored those were requests to a third-party CDN
// that could simply not answer. The failure that produced was far worse than a
// missing feature: main.js called `marked.setOptions(...)` at MODULE SCOPE, so
// an absent `marked` was a ReferenceError during evaluation of the entry
// module — before registerServiceWorker(), before bootApp(), before anything
// could unhide a screen. The whole app died silently with a blank page and no
// console message a user would ever see.
//
// Vendoring makes that very unlikely. This makes it survivable, which is not
// the same thing: a content blocker, a half-written cache entry or a
// partially-installed PWA can still take one file out, and the correct answer
// to that is a sentence naming the file, not an empty screen.
//
// A leaf module: it imports nothing, for the same reason src/core/build.js
// doesn't. Anything it imported could be part of a cycle, and a cycle whose
// top-level const is read during evaluation throws on a temporal-dead-zone
// access — which is the exact class of failure this file exists to catch.

// name -> what the app loses without it. Ordered by how early it bites.
const BOOT_LIBRARIES = [
  ["marked", "vendor/marked-14.1.2/marked.min.js", "rendering any note or card"],
  ["DOMPurify", "vendor/dompurify-3.1.6/purify.min.js", "rendering any note or card"],
  ["katex", "vendor/katex-0.16.11/katex.min.js", "showing formulas"]
];

export function missingBootLibraries() {
  return BOOT_LIBRARIES.filter(([global]) => typeof window[global] === "undefined");
}

// True when the two libraries every render goes through are present. Callers on
// the render path use this to degrade to plain text instead of throwing — see
// renderMarkdownBlocks and preprocessSpecialBlocks.
export function markdownLibrariesReady() {
  return typeof window.marked !== "undefined" && typeof window.DOMPurify !== "undefined";
}

// Replace the boot placeholder with something that names what is missing.
// Deliberately built with DOM calls and inline styles rather than innerHTML and
// a class: at the moment this runs, the stylesheets may not have arrived either,
// and this is the last thing that gets to speak.
export function reportMissingBootLibraries(missing) {
  const host = document.getElementById("bootSkeleton");
  if (!host) return;
  const spinner = host.querySelector(".boot-spinner");
  if (spinner) spinner.remove();
  const slow = host.querySelector(".boot-slow");
  if (slow) {
    slow.style.opacity = "1";
    slow.textContent =
      `Recall couldn't load ${missing.length === 1 ? "a file it needs" : "some files it needs"}: ` +
      `${missing.map(([, file]) => file).join(", ")}. That usually means a content blocker, or an ` +
      "app install that didn't finish. Your decks are stored on this device and are not affected.";
  }
  const retry = document.getElementById("bootSkeletonRetry");
  if (retry) retry.hidden = false;
}

// Called once from main.js, before anything touches one of these globals.
// Returns true when the app may carry on booting.
//
// marked and DOMPurify are fatal together: every view in the app is markdown.
// KaTeX alone is not — a note without formulas reads perfectly — so its absence
// is a warning, and enhance.js already skips math when it isn't there.
export function assertBootLibraries() {
  const missing = missingBootLibraries();
  if (!missing.length) return true;
  console.error("Missing boot libraries:", missing.map(([, file]) => file).join(", "));
  if (markdownLibrariesReady()) return true;
  reportMissingBootLibraries(missing);
  return false;
}
