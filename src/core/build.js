// The commit this build was deployed from, written into the file itself.
//
// This is a leaf module: it imports nothing. That is a rule, not an accident —
// everything else in src/ may import from core/*, so anything core/* imported
// back would be a cycle, and a cycle whose top-level `const` is read during
// evaluation throws on a temporal-dead-zone access rather than returning
// undefined. This app has already lost an entire boot to exactly that.
//
// Both placeholders are substituted by .github/workflows/deploy.yml from the
// commit being published, so neither is ever typed and neither can describe a
// different build than the one running. The old scheme was a hand-edited
// YYYYMMDD-NN stamp repeated in four files: it drifted, it got forgotten twice
// in a way that stopped releases reaching users entirely, and the date inside
// it was whatever the author happened to type rather than when anything shipped.
//
// It is still a constant rather than a read of the <script src> attribute. That
// attribute is the URL the page ASKED for; it says nothing about the bytes that
// answered. When the service worker had to fall back across releases it served
// the previous bundle under the new URL, and reading the attribute reported the
// new version while old code ran — so the modal cheerfully said "You're up to
// date ✓" to exactly the users who were not.
export const BUILD_STAMP = "__BUILD__";

// When that commit was made, ISO-8601, from git rather than from a human.
export const BUILD_TIME = "__BUILD_TIME__";

// True in any checkout the deploy workflow has not stamped: a local Live Server
// session, a fork served straight off a branch, someone opening index.html from
// disk. There is no version to compare in that case, and saying so is more use
// than comparing the literal placeholder against a real SHA and announcing an
// update that does not exist.
//
// The split string is load-bearing: deploy.yml's substitution is a blind global
// replace, so spelling the placeholder out here would rewrite this comparison
// into `sha === "__" + "BUILD__"` and make it permanently false.
export const IS_DEV_BUILD = BUILD_STAMP === "__" + "BUILD__";
