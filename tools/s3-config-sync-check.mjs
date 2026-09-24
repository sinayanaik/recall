// Do the bucket keys reach the reader's other devices — and ONLY theirs?
//
//   node tools/s3-config-sync-check.mjs
//
// "It says successfully connected to bucket but the pdfs are not syncing multi
// device." The upload had worked. The bucket held every paper. The second
// device had simply never been given the four values, because they lived in
// the localStorage of the device they were typed into and nowhere else — so
// every paper there read as missing.
//
// src/cloud/s3-config-sync.js carries them through one Supabase row per
// account. What is asserted here is the part that would hurt if it were wrong,
// and would not be noticed until it had:
//
//   • THE HAPPY PATH. A device that was set up before this change publishes its
//     keys without anybody retyping them, and a device that has none adopts
//     them — and a paper opened on that device before its first sync still
//     finds them.
//   • NOTHING UNTESTED GOES UP. The panel saves typed values before it tests
//     them; publishing that copy would break every other device on a typo.
//   • FORGET MEANS EVERYWHERE, and stays meant: a device still holding the old
//     keys must not refill a forgotten account on its next sync.
//   • ONE ACCOUNT'S SECRET NEVER LANDS IN ANOTHER'S ROW on a shared device.
//   • A CLOCK RUNNING FAST on one device cannot undo a change just made on the
//     other.
//   • A PROJECT WITHOUT THE TABLE degrades to per-device keys and says so,
//     rather than throwing into a sync.
//
// Plain Node, like s3-store-check.mjs: the Supabase client is replaced with an
// in-memory table, and "devices" are separate localStorage maps swapped in and
// out, so two devices and one account are driven through the REAL module.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-s3cfg-"));

function destamp(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) destamp(full);
    else if (entry.endsWith(".js")) {
      const text = readFileSync(full, "utf8");
      const clean = text.replaceAll("?v=__BUILD__", "");
      if (clean !== text) writeFileSync(full, clean);
    }
  }
}

const results = [];
let failures = 0;
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };

async function must(name, fn) {
  let detail;
  try {
    detail = await fn();
  } catch (error) {
    detail = `threw: ${error?.message || error}`;
  }
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));

  // ── The smallest possible browser, with swappable devices ─────────────────
  const noElement = new Proxy({}, {
    get: (_, key) => (key === "querySelector" || key === "querySelectorAll" || key === "closest" ? () => null : undefined)
  });
  const head = { appendChild: (node) => { node.onload?.(); return node; } };
  globalThis.document = {
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => ({}), addEventListener: () => {},
    documentElement: noElement, body: noElement, head
  };
  // Each device is its own localStorage. `onDevice` swaps which one the app
  // sees, which is all a second device IS as far as these modules can tell.
  const devices = new Map();
  let current = new Map();
  const onDevice = (name) => {
    if (!devices.has(name)) devices.set(name, new Map());
    current = devices.get(name);
  };
  globalThis.localStorage = {
    getItem: (key) => (current.has(key) ? current.get(key) : null),
    setItem: (key, value) => current.set(key, String(value)),
    removeItem: (key) => current.delete(key),
    key: (index) => [...current.keys()][index] ?? null,
    get length() { return current.size; }
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.BroadcastChannel = class { postMessage() {} close() {} addEventListener() {} };
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: true, storage: { estimate: async () => ({ usage: 0, quota: 0 }) } },
    configurable: true, writable: true
  });
  globalThis.fetch = async () => { throw new Error("no network in this check"); };
  // Enough IndexedDB for getDocument's device-store read to answer "nothing".
  globalThis.indexedDB = {
    open() {
      const request = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null, error: null };
      queueMicrotask(() => {
        const rows = new Map();
        request.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({}),
          transaction() {
            const tx = { oncomplete: null };
            queueMicrotask(() => tx.oncomplete?.());
            tx.objectStore = () => ({
              get: (key) => {
                const r = { onsuccess: null, onerror: null, result: undefined };
                queueMicrotask(() => { r.result = rows.get(String(key)); r.onsuccess?.(); });
                return r;
              },
              put: (row) => {
                const r = { onsuccess: null, onerror: null, result: undefined };
                queueMicrotask(() => { rows.set(String(row.deckLocalId), row); r.onsuccess?.(); });
                return r;
              }
            });
            return tx;
          },
          close() {}
        };
        request.onsuccess?.({ target: request });
      });
      return request;
    }
  };

  const load = (rel) => import(path.join(stage, rel));
  const s3Config = await load("src/cloud/s3-config.js");
  const keySync = await load("src/cloud/s3-config-sync.js");
  const clientMod = await load("src/cloud/supabase-client.js");
  const s3Files = await load("src/cloud/s3-files.js");
  const pdfStore = await load("src/documents/pdf-store.js");

  // ── One account's worth of Supabase ───────────────────────────────────────
  //
  // The table the module reads and writes, keyed by user id, plus a switch for
  // "the project never ran the new SQL". Every call is recorded, so "nothing
  // was sent" is something a case can assert rather than infer.
  const USER = "11111111-1111-1111-1111-111111111111";
  const OTHER_USER = "22222222-2222-2222-2222-222222222222";
  const table = new Map();
  const calls = [];
  let tableMissing = false;
  let sessionUser = USER;

  const client = {
    from(name) {
      const query = { op: "select", filters: {}, payload: null };
      const run = () => {
        calls.push(`${query.op} ${name}`);
        if (name !== keySync.S3_CONFIG_TABLE) return { data: [], error: null };
        if (tableMissing) return { data: null, error: { code: "42P01", message: `relation "${name}" does not exist` } };
        if (query.op === "upsert") {
          table.set(query.payload.user_id, { s3_config: query.payload.s3_config, updated_at: query.payload.updated_at });
          return { data: null, error: null };
        }
        const row = table.get(query.filters.user_id);
        return { data: row ? [{ ...row }] : [], error: null };
      };
      const builder = {
        select() { return builder; },
        eq(column, value) { query.filters[column] = value; return builder; },
        upsert(payload) { query.op = "upsert"; query.payload = payload; return builder; },
        abortSignal() { return builder; },
        then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); }
      };
      return builder;
    },
    auth: {
      getSession: async () => ({
        data: {
          session: sessionUser
            ? { user: { id: sessionUser }, access_token: "token", expires_at: Math.floor(Date.now() / 1000) + 3600 }
            : null
        },
        error: null
      })
    }
  };
  clientMod.setSupabaseClient(client);

  const CONFIG = {
    endpoint: "https://abc123.r2.cloudflarestorage.com",
    bucket: "recall-papers",
    region: "auto",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  };
  const CONFIG_2 = { ...CONFIG, accessKeyId: "AKIASECONDKEY0000000", secretAccessKey: "second-secret" };
  const CONFIG_3 = { ...CONFIG, bucket: "recall-papers-3" };

  const announced = [];
  keySync.onS3ConfigAdopted((change) => announced.push(change.kind));

  const cloudConfig = () => table.get(USER)?.s3_config || null;

  // ── A device set up before any of this ────────────────────────────────────

  // A bucket that answers yes to everything, and one that lists but refuses
  // uploads — the policy the old LIST-only test passed.
  const reply = (status) => ({ ok: status >= 200 && status < 300, status, text: async () => "", blob: async () => null });
  const workingBucket = async () => reply(200);
  const readOnlyBucket = async (url, init = {}) => reply((init.method || "GET") === "PUT" ? 403 : 200);

  await must("a device set up before key sync publishes its keys to an empty account, untyped", async () => {
    onDevice("laptop");
    // Exactly what the old saveS3Config wrote: the five values, no timestamp,
    // no owner, no verdict.
    localStorage.setItem(s3Config.S3_CONFIG_STORAGE_KEY, JSON.stringify(CONFIG));
    s3Files.setS3Transport(workingBucket);
    try {
      const result = await keySync.syncS3ConfigWithCloud(USER);
      if (result.status !== "synced") return `status ${result.status}`;
      return keySync.sameS3Config(cloudConfig(), CONFIG) || `the account holds ${JSON.stringify(cloudConfig())}`;
    } finally {
      s3Files.resetS3Transport();
    }
  });

  await must("...and the row carries the five values and nothing of this device's bookkeeping", () => {
    const stored = cloudConfig() || {};
    const keys = Object.keys(stored).sort().join(",");
    return keys === "accessKeyId,bucket,endpoint,region,secretAccessKey" || `row keys: ${keys}`;
  });

  await must("...and the local copy is now owned by the account it went to", () =>
    s3Config.readS3ConfigRecord().ownerId === USER || `owner is ${s3Config.readS3ConfigRecord().ownerId}`);

  await must("a pre-sync device whose keys cannot upload is tested first and kept off the account", async () => {
    const THIRD_USER = "33333333-3333-3333-3333-333333333333";
    onDevice("broken-legacy");
    localStorage.setItem(s3Config.S3_CONFIG_STORAGE_KEY, JSON.stringify(CONFIG_2));
    s3Files.setS3Transport(readOnlyBucket);
    try {
      const result = await keySync.syncS3ConfigWithCloud(THIRD_USER);
      if (table.has(THIRD_USER)) return "keys that cannot upload were handed to every other device";
      if (s3Config.readS3ConfigRecord().verified !== false) return "the failed verdict was not kept, so it would be re-tested every sync";
      return result.status === "unverified" || `status ${result.status}`;
    } finally {
      s3Files.resetS3Transport();
    }
  });

  // ── The second device ─────────────────────────────────────────────────────

  await must("a device with no keys adopts the account's on its first sync", async () => {
    onDevice("phone");
    announced.length = 0;
    const result = await keySync.syncS3ConfigWithCloud(USER);
    if (result.change !== "adopted") return `change was ${result.change}`;
    if (!keySync.sameS3Config(s3Config.loadS3Config(), CONFIG)) return "the phone has no usable keys";
    return announced.includes("adopted") || "nobody was told, so a paper showing 're-attach' would stay that way";
  });

  await must("...and a sync with nothing new changes nothing and announces nothing", async () => {
    announced.length = 0;
    const before = localStorage.getItem(s3Config.S3_CONFIG_STORAGE_KEY);
    const result = await keySync.syncS3ConfigWithCloud(USER);
    if (result.change) return `a no-op sync reported ${result.change}`;
    if (announced.length) return `announced ${announced.join(",")}`;
    return localStorage.getItem(s3Config.S3_CONFIG_STORAGE_KEY) === before || "the local record was rewritten";
  });

  await must("a paper opened before the first sync fetches the keys itself rather than asking to be re-attached", async () => {
    onDevice("tablet");
    const HASH = "c".repeat(64);
    const key = `recall/primary/${HASH}.pdf`;
    s3Files.setS3Transport(async (url, init = {}) => {
      const pathname = decodeURIComponent(new URL(url).pathname);
      const wanted = `/${CONFIG.bucket}/${key}`;
      if ((init.method || "GET") === "GET" && pathname === wanted) {
        return { ok: true, status: 200, blob: async () => "PAPERBYTES", text: async () => "" };
      }
      return { ok: false, status: 404, blob: async () => null, text: async () => "" };
    });
    try {
      // A bare meta.pdf, exactly as import writes it: no id, no s3Key.
      const blob = await pdfStore.getDocument("deck-on-tablet", { name: "paper.pdf", sha256: HASH });
      if (blob !== "PAPERBYTES") return `got ${blob} — the tablet never asked the account for the keys`;
      return s3Config.isS3Configured() || "the keys were used but not kept";
    } finally {
      s3Files.resetS3Transport();
    }
  });

  // ── Nothing untested goes up ──────────────────────────────────────────────

  await must("an untested config is not published, and not overwritten while the reader fixes it", async () => {
    onDevice("phone");
    s3Config.saveS3Config(CONFIG_2, { ownerId: USER, verified: false, updatedAt: Date.now() + 1000 });
    const result = await keySync.syncS3ConfigWithCloud(USER);
    if (!keySync.sameS3Config(cloudConfig(), CONFIG)) return "the untested keys reached the account";
    if (!keySync.sameS3Config(s3Config.loadS3Config(), CONFIG_2)) return "the reader's half-fixed form was replaced";
    return result.status === "unverified" || `status ${result.status}`;
  });

  await must("once it passes the test, pushing it reaches the account and the other device", async () => {
    s3Config.markS3ConfigVerified(USER);
    const pushed = await keySync.pushS3ConfigNow();
    if (pushed.change !== "pushed") return `push said ${pushed.status}/${pushed.change}`;
    if (!keySync.sameS3Config(cloudConfig(), CONFIG_2)) return "the account still holds the old keys";
    onDevice("laptop");
    const result = await keySync.syncS3ConfigWithCloud(USER);
    if (result.change !== "adopted") return `the laptop's pass said ${result.change}`;
    return keySync.sameS3Config(s3Config.loadS3Config(), CONFIG_2) || "the laptop kept the old keys";
  });

  // ── Clocks ────────────────────────────────────────────────────────────────

  await must("a change just made here beats a row stamped by a device whose clock runs fast", async () => {
    // The laptop's clock is an hour ahead, so its last write sits in our future.
    table.set(USER, { s3_config: CONFIG_2, updated_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    onDevice("phone");
    s3Config.saveS3Config(CONFIG_3, { ownerId: USER, verified: true });
    const pushed = await keySync.pushS3ConfigNow();
    if (!keySync.sameS3Config(cloudConfig(), CONFIG_3)) return `the account kept ${cloudConfig()?.bucket} — the reader's change was undone`;
    return pushed.change === "pushed" || `push said ${pushed.change}`;
  });

  // ── Forget ────────────────────────────────────────────────────────────────

  await must("Forget on one device clears the keys on the others", async () => {
    onDevice("phone");
    s3Config.clearS3Config({ ownerId: USER });
    await keySync.pushS3ConfigNow();
    if (!table.has(USER) || table.get(USER).s3_config !== null) return "the account was not told the keys were forgotten";
    onDevice("laptop");
    announced.length = 0;
    const result = await keySync.syncS3ConfigWithCloud(USER);
    if (s3Config.loadS3Config()) return "the laptop kept its keys";
    if (!announced.includes("cleared")) return "the laptop's panel was not told";
    return result.change === "cleared" || `change was ${result.change}`;
  });

  await must("...and a device still holding pre-sync keys does not refill the forgotten account", async () => {
    onDevice("old-desktop");
    localStorage.setItem(s3Config.S3_CONFIG_STORAGE_KEY, JSON.stringify(CONFIG));
    await keySync.syncS3ConfigWithCloud(USER);
    if (cloudConfig() !== null) return "the forgotten keys came back from a device that never heard";
    return s3Config.loadS3Config() === null || "the old desktop kept keys its owner forgot";
  });

  await must("keys saved again after a Forget are published again", async () => {
    onDevice("phone");
    s3Config.saveS3Config(CONFIG, { ownerId: USER, verified: true });
    await keySync.pushS3ConfigNow();
    return keySync.sameS3Config(cloudConfig(), CONFIG) || "a new setup after Forget stayed on this device";
  });

  // ── Shared devices ────────────────────────────────────────────────────────

  await must("another account's keys are never published into this account's empty row", async () => {
    table.delete(OTHER_USER);
    onDevice("shared-desk");
    s3Config.saveS3Config(CONFIG_2, { ownerId: USER, verified: true });
    const result = await keySync.syncS3ConfigWithCloud(OTHER_USER);
    if (table.has(OTHER_USER)) return "one account's secret was written into another account's row";
    if (s3Config.loadS3Config()) return "the previous account's keys were left usable for the next one";
    return result.status === "synced" || `status ${result.status}`;
  });

  await must("...and give way to the signed-in account's own keys", async () => {
    table.set(OTHER_USER, { s3_config: CONFIG_3, updated_at: new Date(1000).toISOString() });
    s3Config.saveS3Config(CONFIG_2, { ownerId: USER, verified: true, updatedAt: Date.now() });
    await keySync.syncS3ConfigWithCloud(OTHER_USER);
    if (!keySync.sameS3Config(s3Config.loadS3Config(), CONFIG_3)) return "the newer stamp of a DIFFERENT account's keys won";
    return s3Config.readS3ConfigRecord().ownerId === OTHER_USER || "the adopted keys were not re-owned";
  });

  // ── Degrading ─────────────────────────────────────────────────────────────

  await must("a project without the table says so and keeps the keys on the device", async () => {
    onDevice("phone");
    tableMissing = true;
    try {
      const result = await keySync.syncS3ConfigWithCloud(USER);
      if (result.status !== "unavailable") return `status ${result.status}`;
      if (keySync.s3ConfigSyncStatus().state !== "unavailable") return "the panel's status was not updated";
      return Boolean(s3Config.loadS3Config()) || "the keys were lost because the table was missing";
    } finally {
      tableMissing = false;
    }
  });

  await must("offline, nothing is attempted", async () => {
    navigator.onLine = false;
    const before = calls.length;
    try {
      const result = await keySync.syncS3ConfigWithCloud(USER);
      if (calls.length !== before) return "a request was made while offline";
      return result.status === "offline" || `status ${result.status}`;
    } finally {
      navigator.onLine = true;
    }
  });

  await must("signed out, a push says so rather than writing as nobody", async () => {
    sessionUser = null;
    const before = calls.length;
    try {
      const result = await keySync.pushS3ConfigNow();
      if (calls.length !== before) return "a request was made with no session";
      return result.status === "signed-out" || `status ${result.status}`;
    } finally {
      sessionUser = USER;
    }
  });

  await must("a client whose .from() throws is survived, not propagated into the sync", async () => {
    clientMod.setSupabaseClient({ from: () => { throw new Error("this stub refuses every query"); }, auth: client.auth });
    try {
      const result = await keySync.syncS3ConfigWithCloud(USER);
      return result.status === "failed" || `status ${result.status}`;
    } finally {
      clientMod.setSupabaseClient(client);
    }
  });

  console.warn = realWarn;
  console.log("── s3 config sync ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  const noted = warnings.length ? ` · ${warnings.length} expected degradation warning(s)` : "";
  console.log(`\n  ${results.length} checks · ${failures} failed${noted}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
