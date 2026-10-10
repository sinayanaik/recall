// Three-way merge, the way a version-control system does it.
//
// Two copies of something that both descend from a common ancestor ("base")
// are put back together by applying BOTH sets of changes. A conflict is only
// what is left when the two touched the same piece of the ancestor and made it
// into different things — everything else is mergeable, and is merged.
//
// Two levels, because prose is not code:
//
//   lines   the unit a person edits markdown in. A paragraph is a line here, so
//           edits to two different paragraphs never meet.
//   words   tried only inside a region where the two sides' LINE edits overlap.
//           Two devices that fixed two different typos in the same paragraph
//           changed the same line, but different words of it — and that is
//           mergeable too. Only when they changed the same words differently is
//           there anything to ask about.
//
// Rules (shared by both levels):
//
//   • edits that touch disjoint ranges of the ancestor          → both applied
//   • an edit that ends where the other begins (adjacent lines)  → both applied
//   • the identical edit on both sides                           → applied once
//   • an insertion at the very edge of the other side's edit    → both applied
//   • two different LINE insertions at the same point            → both kept
//     (the other side's first, then this side's: nothing dropped, and the
//     result is reported as `insertedBoth`, not as a conflict)
//   • anything else that overlaps                                → a conflict
//
// A conflict never invents text. The merged result holds every mergeable change
// from both sides and, in each conflicting region, THIS side's version; the
// other side's version of that region is returned in `conflicts` so the caller
// can keep it (stash, history) and offer it back.
//
// A leaf module: strings and arrays only — no state, no store, no DOM — so the
// sync path can run it on decks that are not open, and tools/ can drive it
// straight from Node.

// Past this many lines (after the common head and tail are trimmed) the merge
// declines rather than risk a quadratic table on a phone. The trim is what keeps
// this generous: two devices' edits to one note differ by paragraphs.
export const MERGE3_MAX_LINES = 4000;

// The word-level pass runs on one overlapping region at a time, and declines
// past this many tokens in the region — it then stays a line-level conflict.
export const MERGE3_MAX_TOKENS = 2500;

// ── Diff ────────────────────────────────────────────────────────────────────

// The edit from `base` to `side` as hunks: base items [start, end) became
// `replacement`. Common head and tail are trimmed before the LCS table is built,
// so the table only ever covers the part that actually differs.
export function diffHunks(base, side, limit = Infinity) {
  let head = 0;
  const maxHead = Math.min(base.length, side.length);
  while (head < maxHead && base[head] === side[head]) head += 1;
  let tail = 0;
  while (
    tail < base.length - head && tail < side.length - head &&
    base[base.length - 1 - tail] === side[side.length - 1 - tail]
  ) tail += 1;
  const a = base.slice(head, base.length - tail);
  const b = side.slice(head, side.length - tail);
  if (!a.length && !b.length) return [];
  if (!a.length || !b.length) return [{ start: head, end: head + a.length, replacement: b }];
  if (a.length > limit || b.length > limit) return null;

  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let hunkA = 0;
  let hunkB = 0;
  const flush = () => {
    if (hunkA === i && hunkB === j) return;
    out.push({ start: head + hunkA, end: head + i, replacement: b.slice(hunkB, j) });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      i += 1; j += 1;
      hunkA = i; hunkB = j;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  i = n; j = m;
  flush();
  return out;
}

// ── Merge of two hunk lists against one base sequence ──────────────────────

// Does hunk `h` belong to the region [rs, re) that is being gathered? Strict
// overlap only: a hunk that merely ends where the region begins (or begins
// where it ends) touches no common base item and is independent.
function joinsRegion(rs, re, h) {
  const hEmpty = h.start === h.end;
  const rEmpty = rs === re;
  if (rEmpty && hEmpty) return h.start === rs;           // same-point insertions
  if (rEmpty) return h.start < rs && rs < h.end;          // insertion inside h
  if (hEmpty) return rs < h.start && h.start < re;        // h inserts inside region
  return h.start < re && rs < h.end;                      // ranges share an item
}

function sideRegion(base, hunks, rs, re) {
  const out = [];
  let cursor = rs;
  for (const h of hunks) {
    out.push(...base.slice(cursor, h.start));
    out.push(...h.replacement);
    cursor = h.end;
  }
  out.push(...base.slice(cursor, re));
  return out;
}

const sameSeq = (a, b) => a.length === b.length && a.every((item, k) => item === b[k]);

// `resolve(baseSeg, localSeg, remoteSeg, { samePointInsert })` is asked about a
// region both sides changed differently; it returns the merged segment, or null
// for a genuine conflict.
function mergeSequences(base, localHunks, remoteHunks, resolve) {
  const all = [
    ...localHunks.map((h) => ({ ...h, side: "local" })),
    ...remoteHunks.map((h) => ({ ...h, side: "remote" }))
  ].sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start) || (x.side === "remote" ? -1 : 1));

  const out = [];
  const conflicts = [];
  let insertedBoth = 0;
  let cursor = 0;
  let k = 0;
  while (k < all.length) {
    let rs = all[k].start;
    let re = all[k].end;
    const group = [all[k]];
    k += 1;
    let grew = true;
    while (grew && k < all.length) {
      grew = false;
      if (joinsRegion(rs, re, all[k])) {
        rs = Math.min(rs, all[k].start);
        re = Math.max(re, all[k].end);
        group.push(all[k]);
        k += 1;
        grew = true;
      }
    }
    out.push(...base.slice(cursor, rs));
    cursor = re;
    const locals = group.filter((h) => h.side === "local");
    const remotes = group.filter((h) => h.side === "remote");
    if (!locals.length || !remotes.length) {
      out.push(...sideRegion(base, group, rs, re));
      continue;
    }
    const baseSeg = base.slice(rs, re);
    const localSeg = sideRegion(base, locals, rs, re);
    const remoteSeg = sideRegion(base, remotes, rs, re);
    if (sameSeq(localSeg, remoteSeg)) {
      out.push(...localSeg);
      continue;
    }
    const samePointInsert = rs === re;
    const resolved = resolve(baseSeg, localSeg, remoteSeg, { samePointInsert });
    if (resolved) {
      if (resolved.insertedBoth) insertedBoth += 1;
      out.push(...resolved.items);
      continue;
    }
    conflicts.push({ at: out.length, base: baseSeg, local: localSeg, remote: remoteSeg });
    out.push(...localSeg);
  }
  out.push(...base.slice(cursor));
  return { out, conflicts, insertedBoth };
}

// ── Words ───────────────────────────────────────────────────────────────────

// Words, runs of whitespace, and single punctuation marks — so a comma added on
// one side and a word changed two words later on the other never meet.
const TOKEN_PATTERN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

export function tokenizeWords(text) {
  return String(text || "").match(TOKEN_PATTERN) || [];
}

// Merge one region at word level. Returns the merged string, or null.
export function mergeWords(base, local, remote) {
  const b = tokenizeWords(base);
  const l = tokenizeWords(local);
  const r = tokenizeWords(remote);
  const lh = diffHunks(b, l, MERGE3_MAX_TOKENS);
  const rh = diffHunks(b, r, MERGE3_MAX_TOKENS);
  if (!lh || !rh) return null;
  // Inside a sentence there is no safe order for two different insertions at
  // one point, so at this level they are a conflict.
  const { out, conflicts } = mergeSequences(b, lh, rh, () => null);
  return conflicts.length ? null : out.join("");
}

// ── Text ────────────────────────────────────────────────────────────────────

function splitLines(text) {
  return String(text ?? "").split("\n");
}

// Merge `local` and `remote`, both derived from `base`.
//
// Returns { merged, conflicts, ok, insertedBoth }:
//   ok          false only when the merge declined (no base, or too large) —
//               then `merged` is `local` and the caller does what it did before.
//   conflicts   [{ base, local, remote, line }] — one entry per region the two
//               sides changed differently; `merged` holds `local` there and
//               every other change from both sides.
//   insertedBoth  how many places both sides inserted different lines at the
//               same point (both kept; informational).
export function mergeText(base, local, remote) {
  const localText = String(local ?? "");
  const remoteText = String(remote ?? "");
  if (base === null || base === undefined) return { merged: localText, conflicts: [], ok: false, insertedBoth: 0 };
  const baseText = String(base);
  if (localText === remoteText) return { merged: localText, conflicts: [], ok: true, insertedBoth: 0 };
  if (localText === baseText) return { merged: remoteText, conflicts: [], ok: true, insertedBoth: 0 };
  if (remoteText === baseText) return { merged: localText, conflicts: [], ok: true, insertedBoth: 0 };

  const b = splitLines(baseText);
  const lh = diffHunks(b, splitLines(localText), MERGE3_MAX_LINES);
  const rh = diffHunks(b, splitLines(remoteText), MERGE3_MAX_LINES);
  if (!lh || !rh) return { merged: localText, conflicts: [], ok: false, insertedBoth: 0 };

  const { out, conflicts, insertedBoth } = mergeSequences(b, lh, rh, (baseSeg, localSeg, remoteSeg, { samePointInsert }) => {
    if (samePointInsert) {
      // Two new paragraphs written at the same spot — commonly both devices
      // appending to the end of a note. Neither is a change to anything the
      // other wrote, so both are kept: the other side's (already shared) first.
      return { items: [...remoteSeg, ...localSeg], insertedBoth: true };
    }
    const words = mergeWords(baseSeg.join("\n"), localSeg.join("\n"), remoteSeg.join("\n"));
    return words === null ? null : { items: words.split("\n") };
  });
  return {
    merged: out.join("\n"),
    conflicts: conflicts.map((c) => ({
      base: c.base.join("\n"),
      local: c.local.join("\n"),
      remote: c.remote.join("\n"),
      line: c.at
    })),
    ok: true,
    insertedBoth
  };
}

// ── Values ──────────────────────────────────────────────────────────────────
//
// The same rules for structured data (a deck's meta bag, its cards): a part one
// side left alone takes the other side's version; a part both changed is merged
// recursively — objects key by key, arrays of id'd records record by record,
// strings as text. A deletion on one side and an edit on the other keeps the
// edit, because an edit is somebody's work and a deletion can be repeated.

export function canonicalJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export const sameValue = (a, b) => a === b || canonicalJson(a) === canonicalJson(b);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const recordKey = (record) => (isPlainObject(record) && record.id !== undefined && record.id !== null ? String(record.id) : null);
const isRecordArray = (v) => Array.isArray(v) && v.length > 0 && v.every((item) => recordKey(item) !== null);

// Returns { value, conflicts } where conflicts is a list of { path, base, local,
// remote } for the leaves both sides changed differently (`value` holds local's
// there). `path` is for reporting only.
export function mergeValues(base, local, remote, path = "") {
  if (sameValue(local, remote)) return { value: local, conflicts: [] };
  if (sameValue(local, base)) return { value: remote, conflicts: [] };
  if (sameValue(remote, base)) return { value: local, conflicts: [] };

  // Deleted on one side, changed on the other: keep the change.
  if (local === undefined) return { value: remote, conflicts: [] };
  if (remote === undefined) return { value: local, conflicts: [] };

  if (typeof local === "string" && typeof remote === "string") {
    const text = mergeText(typeof base === "string" ? base : "", local, remote);
    return {
      value: text.merged,
      conflicts: text.conflicts.map((c) => ({ path, ...c }))
    };
  }

  const baseIsRecords = base === undefined || base === null || isRecordArray(base) || (Array.isArray(base) && !base.length);
  if ((isRecordArray(local) || (Array.isArray(local) && !local.length))
      && (isRecordArray(remote) || (Array.isArray(remote) && !remote.length)) && baseIsRecords) {
    return mergeRecordArrays(Array.isArray(base) ? base : [], local, remote, path);
  }

  if (isPlainObject(local) && isPlainObject(remote)) {
    const b = isPlainObject(base) ? base : {};
    const out = {};
    const conflicts = [];
    for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
      const res = mergeValues(b[key], local[key], remote[key], path ? `${path}.${key}` : key);
      if (res.value !== undefined) out[key] = res.value;
      conflicts.push(...res.conflicts);
    }
    return { value: out, conflicts };
  }

  // Numbers, booleans, plain lists: nothing finer to merge. The local value is
  // the newest intent on this device; the other is reported.
  return { value: local, conflicts: [{ path, base, local, remote }] };
}

// Records by id. Order follows `local` (this device's arrangement), with records
// only the other side has inserted after their nearest preceding neighbour.
function mergeRecordArrays(base, local, remote, path) {
  const baseById = new Map(base.map((r) => [recordKey(r), r]).filter(([k]) => k !== null));
  const localById = new Map(local.map((r) => [recordKey(r), r]));
  const remoteById = new Map(remote.map((r) => [recordKey(r), r]));
  const conflicts = [];
  const resolved = new Map();
  for (const id of new Set([...localById.keys(), ...remoteById.keys()])) {
    const inBase = baseById.has(id);
    const l = localById.get(id);
    const r = remoteById.get(id);
    if (l && r) {
      const res = mergeValues(baseById.get(id), l, r, `${path}[${id}]`);
      conflicts.push(...res.conflicts);
      resolved.set(id, res.value);
    } else if (l) {
      // Absent remotely: deleted there if it was in the base — unless this side
      // changed it since, in which case the change is kept.
      if (!inBase || !sameValue(l, baseById.get(id))) resolved.set(id, l);
    } else if (r) {
      if (!inBase || !sameValue(r, baseById.get(id))) resolved.set(id, r);
    }
  }
  const out = [];
  const placed = new Set();
  for (const record of local) {
    const id = recordKey(record);
    if (resolved.has(id) && !placed.has(id)) { out.push(resolved.get(id)); placed.add(id); }
  }
  // Remote-only records, slotted after the closest record before them in the
  // remote order that is already placed.
  remote.forEach((record, index) => {
    const id = recordKey(record);
    if (!resolved.has(id) || placed.has(id)) return;
    let at = 0;
    for (let k = index - 1; k >= 0; k -= 1) {
      const prev = recordKey(remote[k]);
      const pos = out.findIndex((item) => recordKey(item) === prev);
      if (pos !== -1) { at = pos + 1; break; }
    }
    out.splice(at, 0, resolved.get(id));
    placed.add(id);
  });
  return { value: out, conflicts };
}
