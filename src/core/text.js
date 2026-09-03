export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Coerces first: callers pass deck titles, statuses and error messages straight
// through, any of which can be undefined on a partial record — and a throw here
// takes down whichever list/report was being built around it.
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function encodeAttribute(value) {
  return escapeHtml(encodeURIComponent(value));
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

// ── The two characters the cloud cannot carry ─────────────────────────────
//
// Postgres refuses U+0000 inside text and jsonb (SQLSTATE 22P05, "unsupported
// Unicode escape sequence — \u0000 cannot be converted to text"), and PostgREST
// parses the WHOLE request body as JSON, so one NUL anywhere in a deck's title,
// notes or meta bag fails that deck's entire push. pdf.js is where they come
// from: a document string with no UTF-16 BOM is decoded byte-by-byte through
// PDFDocEncoding, so a UTF-16BE title comes back as "\u0000M\u0000o\u0000d…",
// invisible on screen and fatal on the wire; a glyph whose cmap maps to 0 puts
// the same character inside page text. The same broken mappings emit unpaired
// surrogates, which JSON.stringify passes through as \udXXX and Postgres
// rejects with the same error.
//
// DELIBERATELY NARROWER THAN escapeXml above, which strips the rest of C0
// because XML 1.0 forbids it — a document-format rule, not a database one.
// Postgres accepts \t and \n happily, every markdown card is full of them, and
// stripping them here would rewrite text that syncs fine today (see
// src/sync/text-repair.js for why rewriting text is not free). Valid surrogate
// PAIRS — emoji, CJK ext-B, the math alphanumerics — are kept untouched.
//
// Dropped rather than replaced with U+FFFD, the convention escapeXml already
// sets: a visible "�" in the middle of a book's title is a worse outcome than
// an invisible nothing.
//
// Pair alternative FIRST so a valid pair is matched (and handed back whole)
// before the lone-surrogate alternative can see half of it. No lookbehind —
// older iOS Safari does not have it, and this runs on phones.
const INVALID_SYNC_TEXT_RE = /\u0000|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
// The prefilter is a SEPARATE non-global regex: a /g regex carries lastIndex
// between .test() calls, so consecutive tests on the same pattern alternate
// true/false. Clean text — which is almost all text — costs one native scan
// and allocates nothing.
const INVALID_SYNC_TEXT_PRESENT_RE = /[\u0000\uD800-\uDFFF]/;

export function stripInvalidUnicode(value) {
  const text = String(value ?? "");
  if (!INVALID_SYNC_TEXT_PRESENT_RE.test(text)) return text;
  return text.replace(INVALID_SYNC_TEXT_RE, (match) => (match.length === 2 ? match : ""));
}

// Depth cap: `meta` is JSON by construction (it round-trips through
// structuredClone and the cloud), so it cannot actually be cyclic — but a cap
// is one line and a stack overflow inside a sync is not worth the elegance.
const SANITIZE_MAX_DEPTH = 64;

// The same strip over a whole jsonb bag — strings, arrays, plain objects, and
// object KEYS (a key with a NUL in it is rejected exactly like a value).
//
// Returns the input BY REFERENCE when nothing changed, which is the contract
// callers depend on twice over: `sanitizeUnicodeDeep(meta) !== meta` is how the
// repair decides whether a deck is worth writing back, and a clean meta bag —
// 400 table-of-contents entries plus every highlight in a book — is walked
// without allocating a single object.
export function sanitizeUnicodeDeep(value, depth = 0) {
  if (typeof value === "string") return stripInvalidUnicode(value);
  if (!value || typeof value !== "object" || depth >= SANITIZE_MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const clean = sanitizeUnicodeDeep(item, depth + 1);
      if (clean !== item) changed = true;
      return clean;
    });
    return changed ? next : value;
  }
  let changed = false;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    const cleanKey = stripInvalidUnicode(key);
    const cleanItem = sanitizeUnicodeDeep(item, depth + 1);
    if (cleanKey !== key || cleanItem !== item) changed = true;
    // Two keys that collapse onto the same name after the strip resolve
    // last-wins. Both were unreachable to the cloud before this — the row they
    // were in never landed at all — so either is an improvement, and inventing
    // a disambiguating name would put a string in the bag that nothing reads.
    next[cleanKey] = cleanItem;
  }
  return changed ? next : value;
}

export function hex6(value, fallback) {
  const clean = String(value || "").replace(/^#/, "").trim();
  return /^[0-9a-fA-F]{6}$/.test(clean) ? clean.toUpperCase() : fallback;
}

// ── A cheap content fingerprint ───────────────────────────────────────────
//
// FNV-1a, 32-bit, base-36. Not a checksum and never a security claim: what it is
// for is "has this string changed since I last painted it", where the strings are
// note bodies and the alternative is keeping a second copy of every one of them
// in a data attribute.
//
// Here, in the one module that imports nothing, because three surfaces ask that
// question about the same notes and a name means one thing across this tree
// (tools/module-symbols.mjs): the inline highlight notes, the printed page
// notes, and the document deck's Notes tab.
export function hash32(text) {
  let h = 0x811c9dc5;
  const value = String(text ?? "");
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Bytes as a person reads them. Lives here rather than beside the storage panel
// that first needed it, because core/ imports nothing: the image compression
// dialog needs the same formatting, and reaching into a panel module for it
// would have made a cycle out of a six-line function.
export function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
