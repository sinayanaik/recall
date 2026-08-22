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
