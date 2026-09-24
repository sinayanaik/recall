// Does a paper still come back, now that it lives somewhere else again?
//
//   node tools/s3-store-check.mjs
//
// PDFs have now moved twice: out of the Supabase `documents` bucket into
// Google Drive, and out of Drive into an S3-compatible bucket the reader
// supplies. The second move is small in diff and large in blast radius for the
// same reason the first one was — getDocument is the ONE place a paper's bytes
// are resolved, and four surfaces sit on it — but it carries an extra risk the
// first did not: there are now THREE backends to read, and the two older ones
// hold papers that nothing else can reach.
//
// So the things asserted here are the ones that would not be noticed until
// they had already cost somebody their library:
//
//   • RESOLUTION ORDER. Device, then the bucket, then Drive, then the old
//     Supabase bucket. The last two are what keep every paper uploaded before
//     this change opening, and they are exactly what a "clean" removal of the
//     legacy paths would quietly take away.
//   • THE WAY HOME. meta.pdfs merges by whole record, last writer wins
//     (mergeRecordsById) — it does not merge fields — so a stale device can
//     carry off an s3Key and leave a record naming nothing. Drive answered
//     this with a metadata query; here the key is DERIVED from the pdf id and
//     the content hash, both of which are on the record, so it is recomputed.
//     Without this, one ordinary sync is data loss.
//   • THE ORDER OF THE MIGRATION. The deck is saved BEFORE the old copy is
//     deleted. Interrupt it the other way round and the bytes are gone with
//     nothing naming where they went. Both interrupted states are driven.
//   • NO SECOND UPLOAD. A run that uploaded and then failed to record must not
//     upload again on the next pass — that is how a 100MB paper becomes 300MB
//     of bucket.
//   • DEGRADING RATHER THAN THROWING. Nothing configured, offline, no https:
//     every one must answer "null" and let the device copy serve. getDocument
//     runs inside a render.
//
// ── Why plain Node ───────────────────────────────────────────────────────
//
// There is no network here and no bucket, and there must not be: CI has
// neither. Every request in src/cloud/s3-files.js goes through a single
// `s3Fetch`, and `setS3Transport` replaces the one function it calls — the
// same seam tools/drive-store-check.mjs uses. So this drives the REAL modules
// against a scripted transport and asserts on what they did with the answers.
//
// The signature itself is not re-checked here; tools/s3-sign-check.mjs pins it
// against AWS's published vector. What this file cares about is that the right
// verb reached the right key in the right order.

import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-s3-"));

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

// Half the cases here deliberately drive a failure path, and every one of
// those paths warns on the way past — that IS the behaviour under test, since
// the alternative is throwing inside a render. check.mjs reads a check's
// RESULT off its last line, so the warnings are collected and counted at the
// end rather than left to interleave with it.
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

  // ── The smallest possible browser ───────────────────────────────────────
  const noElement = new Proxy({}, {
    get: (_, key) => (key === "querySelector" || key === "querySelectorAll" || key === "closest" ? () => null : undefined)
  });
  const head = { appendChild: (node) => { node.onload?.(); return node; } };
  globalThis.document = {
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => ({}), addEventListener: () => {},
    documentElement: noElement, body: noElement, head
  };
  const localStore = new Map();
  globalThis.localStorage = {
    getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => localStore.set(key, String(value)),
    removeItem: (key) => localStore.delete(key),
    key: (index) => [...localStore.keys()][index] ?? null,
    get length() { return localStore.size; }
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
  // Nothing here may reach the network. A check that quietly did would be a
  // check with a different result on a train.
  globalThis.fetch = async () => { throw new Error("no network in this check"); };

  // The same IndexedDB as tools/backup-check.mjs: real enough that keys, rows
  // and cursors behave, because the device store IS the fast path under test
  // and faking it away would fake away the behaviour.
  const databases = new Map();
  const settle = (request, run) => {
    queueMicrotask(() => {
      try {
        request.result = run();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
    });
    return request;
  };
  globalThis.indexedDB = {
    open(name) {
      const request = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null, error: null };
      queueMicrotask(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const stores = databases.get(name);
        const db = {
          objectStoreNames: { contains: (store) => stores.has(store) },
          createObjectStore: (store, { keyPath }) => {
            stores.set(store, { keyPath, rows: new Map() });
            return {};
          },
          transaction(store) {
            const tx = { oncomplete: null, onerror: null, onabort: null };
            const table = stores.get(store);
            queueMicrotask(() => tx.oncomplete?.());
            tx.objectStore = () => ({
              put: (row) => settle({}, () => { table.rows.set(String(row[table.keyPath]), row); return undefined; }),
              get: (key) => settle({}, () => table.rows.get(String(key))),
              delete: (key) => settle({}, () => { table.rows.delete(String(key)); return undefined; }),
              getAll: () => settle({}, () => [...table.rows.values()]),
              count: () => settle({}, () => table.rows.size),
              clear: () => settle({}, () => { table.rows.clear(); return undefined; }),
              openCursor: () => {
                const rows = [...table.rows.values()];
                const cursor = { onsuccess: null, onerror: null, result: null };
                let at = 0;
                const step = () => queueMicrotask(() => {
                  cursor.result = at < rows.length ? { value: rows[at++], continue: step } : null;
                  cursor.onsuccess?.({ target: cursor });
                });
                step();
                return cursor;
              }
            });
            return tx;
          },
          close() {}
        };
        request.result = db;
        if (fresh) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    }
  };

  const load = (rel) => import(path.join(stage, rel));

  const s3Config = await load("src/cloud/s3-config.js");
  const s3Files = await load("src/cloud/s3-files.js");
  const pdfStore = await load("src/documents/pdf-store.js");
  const migration = await load("src/storage/document-migration.js");
  const deckStore = await load("src/storage/deck-store.js");

  // ── A bucket, in about forty lines ──────────────────────────────────────
  //
  // Answers the four verbs the module sends, records every request so the
  // ORDER of a migration can be asserted, and can be told to fail a specific
  // one. Keys are read back off the presigned URL's path, which is also a
  // small proof that the signer put them where it said it would.
  const requests = [];
  const objects = new Map();
  let failNext = null;
  const BUCKET = "recall-papers";

  const reply = (status, body = "", headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    blob: async () => new Blob([body]),
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null }
  });

  function keyFromUrl(url) {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const prefix = `/${BUCKET}/`;
    return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
  }

  s3Files.setS3Transport(async (url, init = {}) => {
    const method = init.method || "GET";
    const key = keyFromUrl(url);
    requests.push(`${method} ${key || "(bucket)"}`);
    if (failNext && failNext.method === method) {
      const how = failNext;
      failNext = null;
      if (how.throws) throw new TypeError("Failed to fetch");
      return reply(how.status, how.body || "");
    }
    if (method === "PUT") {
      // Stored as text, because that is what a GET hands back. The body here
      // is whatever pdf-store passed through — a Blob in the browser, the stub
      // below in this check — and keeping the object would make a download
      // return the uploader's own handle rather than bytes.
      objects.set(key, typeof init.body?.text === "function" ? await init.body.text() : String(init.body));
      return reply(200);
    }
    if (method === "HEAD") return objects.has(key) ? reply(200, "", { "content-length": String(objects.get(key).length) }) : reply(404);
    if (method === "DELETE") {
      const had = objects.delete(key);
      return reply(had ? 204 : 404);
    }
    if (method === "GET" && key) {
      return objects.has(key) ? reply(200, objects.get(key)) : reply(404, "<Error><Code>NoSuchKey</Code></Error>");
    }
    // A listing. XML, because that is what the module parses — and filtered
    // by `prefix` the way a real bucket filters it, or nothing about what the
    // app lists OUTSIDE recall/ could be asserted.
    const prefix = new URL(url).searchParams.get("prefix") || "";
    const rows = [...objects.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, body]) => `
      <Contents><Key>${name}</Key><Size>${String(body).length}</Size>
      <LastModified>2026-09-19T00:00:00.000Z</LastModified></Contents>`).join("");
    return reply(200, `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${rows}</ListBucketResult>`);
  });

  // ListObjectsV2 is XML and s3-files parses it with DOMParser, which Node has
  // no equivalent of. This is the smallest thing that answers the four calls
  // parseListing makes — enough to prove the paging and the field mapping,
  // which is what the panel's totals rest on.
  globalThis.DOMParser = class {
    parseFromString(text) {
      const blocks = [...text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => m[1]);
      const pick = (source, tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(source)?.[1] ?? null;
      const node = (source) => ({ querySelector: (tag) => {
        const value = pick(source, tag);
        return value === null ? null : { textContent: value };
      } });
      return {
        querySelector: (tag) => {
          if (tag === "parsererror") return null;
          const value = pick(text, tag);
          return value === null ? null : { textContent: value };
        },
        querySelectorAll: (tag) => (tag === "Contents" ? blocks.map(node) : [])
      };
    }
  };

  const CONFIG = {
    endpoint: "https://abc123.r2.cloudflarestorage.com",
    bucket: BUCKET,
    region: "auto",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  };

  const HASH = "a".repeat(64);
  const OTHER_HASH = "b".repeat(64);
  const blobOf = (text) => ({ size: text.length, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
  // What a read handed back, as text. The bucket answers with a real Blob, as
  // a browser's fetch does; a device copy put by a case below may be a string.
  const textOf = async (value) => (value && typeof value.text === "function" ? value.text() : value);

  // ── Nothing configured ──────────────────────────────────────────────────

  await must("with nothing configured, an install says so", () =>
    s3Config.isS3Configured() === false || "an empty config read as configured");

  await must("...and an upload fails with NO_STORAGE rather than a stack trace", async () => {
    try {
      await pdfStore.uploadDocumentOnce(blobOf("PDFBYTES"), { name: "paper", pdfId: "pdf-1", sha256: HASH });
      return "it uploaded with no bucket configured";
    } catch (error) {
      return error?.message === "NO_STORAGE" || `threw ${error?.message}`;
    }
  });

  await must("...and a read is null rather than a throw, so a render survives it", async () => {
    const blob = await pdfStore.getDocument("", { id: "pdf-1", sha256: HASH, s3Key: "recall/pdf-1/x.pdf" });
    return blob === null || "a read answered with something";
  });

  // ── Configured ──────────────────────────────────────────────────────────

  await must("a saved config is read back, cleaned and complete", () => {
    s3Config.saveS3Config({ ...CONFIG, endpoint: `${CONFIG.endpoint}/`, bucket: `/${BUCKET}/` });
    const saved = s3Config.loadS3Config();
    if (!saved) return "the config did not stick";
    if (saved.endpoint !== CONFIG.endpoint) return `endpoint kept its slash: ${saved.endpoint}`;
    return saved.bucket === BUCKET || `bucket kept its slashes: ${saved.bucket}`;
  });

  await must("a partial config is not a config", () => {
    s3Config.saveS3Config({ ...CONFIG, secretAccessKey: "" });
    const refused = s3Config.loadS3Config() === null;
    s3Config.saveS3Config(CONFIG);
    return refused || "a config with no secret read as usable";
  });

  await must("the key is content-addressed, under the pdf id", () => {
    const key = s3Files.s3DocumentKey({ pdfId: "pdf-1", sha256: HASH });
    return key === `recall/pdf-1/${HASH}.pdf` || `got ${key}`;
  });

  await must("...and there is no key without a hash, rather than a made-up one", () =>
    s3Files.s3DocumentKey({ pdfId: "pdf-1", sha256: "" }) === "" || "a key was invented for unhashed bytes");

  // ── Upload, download, delete ────────────────────────────────────────────

  let locator = null;
  await must("an upload returns an s3Key and puts the bytes under it", async () => {
    locator = await pdfStore.uploadDocumentOnce(blobOf("PDFBYTES"), { name: "paper", pdfId: "pdf-1", sha256: HASH });
    if (locator?.s3Key !== `recall/pdf-1/${HASH}.pdf`) return `locator was ${JSON.stringify(locator)}`;
    return objects.has(locator.s3Key) || "the bucket did not receive it";
  });

  await must("a download returns the bytes that went up", async () => {
    const blob = await s3Files.downloadS3File(locator.s3Key);
    return (await textOf(blob)) === "PDFBYTES" || `got ${blob}`;
  });

  await must("getDocument reaches the bucket when the device has no copy", async () => {
    const blob = await pdfStore.getDocument("deck-missing", { id: "pdf-1", sha256: HASH, s3Key: locator.s3Key });
    return (await textOf(blob)) === "PDFBYTES" || `got ${blob}`;
  });

  await must("...and caches it on the device, so the next open costs nothing", async () => {
    const before = requests.length;
    const blob = await pdfStore.getDocument("deck-missing", { id: "pdf-1", sha256: HASH, s3Key: locator.s3Key });
    if ((await textOf(blob)) !== "PDFBYTES") return `got ${blob}`;
    return requests.length === before || `it went back to the bucket: ${requests.slice(before).join(", ")}`;
  });

  // ── The way home ────────────────────────────────────────────────────────

  await must("a record whose s3Key was lost to a merge still finds its paper", async () => {
    // No s3Key on the record and no device copy: the key has to be rebuilt
    // from the pdf id and the hash, both of which survived the merge.
    const blob = await pdfStore.getDocument("deck-never-seen", { id: "pdf-1", sha256: HASH });
    return (await textOf(blob)) === "PDFBYTES" || `got ${blob}`;
  });

  await must("...but a record with neither an id nor a hash is not guessed at", async () => {
    const blob = await pdfStore.getDocument("deck-never-seen-2", { name: "paper.pdf" });
    return blob === null || "a key was invented from nothing";
  });

  // ── The device copy has to be the RIGHT copy ────────────────────────────

  await must("a device copy whose hash disagrees is ignored, not served", async () => {
    await pdfStore.putDocument({ deckLocalId: "deck-stale", blob: "OLDBYTES", sha256: OTHER_HASH, name: "paper", at: Date.now() });
    objects.set(`recall/pdf-9/${HASH}.pdf`, "NEWBYTES");
    const blob = await pdfStore.getDocument("deck-stale", { id: "pdf-9", sha256: HASH });
    return (await textOf(blob)) === "NEWBYTES" || `the stale copy was served: ${blob}`;
  });

  // ── Offline, and the other degradations ─────────────────────────────────

  await must("offline, a read is null and nothing is attempted", async () => {
    navigator.onLine = false;
    const before = requests.length;
    const blob = await pdfStore.getDocument("deck-offline", { id: "pdf-1", sha256: HASH });
    navigator.onLine = true;
    if (requests.length !== before) return "it tried the network while offline";
    return blob === null || "a read answered while offline";
  });

  await must("offline, an upload says OFFLINE before the bytes move", async () => {
    navigator.onLine = false;
    try {
      await pdfStore.uploadDocumentOnce(blobOf("X"), { name: "p", pdfId: "pdf-2", sha256: OTHER_HASH });
      return "it uploaded while offline";
    } catch (error) {
      return error?.message === "OFFLINE" || `threw ${error?.message}`;
    } finally {
      navigator.onLine = true;
    }
  });

  await must("a missing object reads as null rather than throwing", async () => {
    const blob = await s3Files.downloadS3File("recall/nothing/here.pdf");
    return blob === null || `got ${blob}`;
  });

  await must("a delete frees it, and a second delete still succeeds", async () => {
    const key = `recall/pdf-9/${HASH}.pdf`;
    const first = await s3Files.deleteS3File(key);
    const second = await s3Files.deleteS3File(key);
    if (!first) return "the first delete failed";
    if (objects.has(key)) return "the object survived its delete";
    return second === true || "a second delete reported failure for an object already gone";
  });

  // ── A refusal the reader can act on ─────────────────────────────────────

  await must("a blocked request is reported as a CORS policy, not as a dead network", async () => {
    failNext = { method: "PUT", throws: true };
    try {
      await s3Files.uploadS3File(blobOf("X"), { pdfId: "pdf-3", sha256: OTHER_HASH });
      return "a blocked upload reported success";
    } catch (error) {
      if (!error?.corsLikely) return `the CORS flag was not set: ${error?.message}`;
      return /CORS/i.test(error.message) || `the message does not name it: ${error.message}`;
    }
  });

  await must("...and a 403 is an auth failure the retry loop will not retry", async () => {
    failNext = { method: "PUT", status: 403, body: "<Error><Code>SignatureDoesNotMatch</Code></Error>" };
    try {
      await s3Files.uploadS3File(blobOf("X"), { pdfId: "pdf-3", sha256: OTHER_HASH });
      return "a refused upload reported success";
    } catch (error) {
      if (error?.authFailed !== true) return "authFailed was not set on a 403";
      return /SignatureDoesNotMatch/.test(error.message) || `the code is not in the message: ${error.message}`;
    }
  });

  await must("the connection test names a wrong bucket separately from wrong keys", async () => {
    failNext = { method: "GET", status: 404, body: "<Error><Code>NoSuchBucket</Code></Error>" };
    const missing = await s3Files.testS3Connection();
    failNext = { method: "GET", status: 403, body: "<Error><Code>AccessDenied</Code></Error>" };
    const refused = await s3Files.testS3Connection();
    if (missing.ok || refused.ok) return "a failing test reported success";
    if (!/bucket name/i.test(missing.reason)) return `404 said: ${missing.reason}`;
    return /key/i.test(refused.reason) || `403 said: ${refused.reason}`;
  });

  await must("a working connection tests clean", async () => {
    const result = await s3Files.testS3Connection();
    return result.ok === true || `it failed: ${result.reason}`;
  });

  // ── Accounting ──────────────────────────────────────────────────────────

  await must("the listing totals what Recall put in the bucket", async () => {
    objects.clear();
    objects.set(`recall/pdf-a/${HASH}.pdf`, "1234567890");
    objects.set(`recall/pdf-b/${OTHER_HASH}.pdf`, "12345");
    const usage = await s3Files.s3Usage();
    if (usage.count !== 2) return `counted ${usage.count}`;
    if (usage.bytes !== 15) return `summed ${usage.bytes}`;
    return usage.files.some((file) => file.pdfId === "pdf-a") || "the pdf id was not read back off the key";
  });

  // ── The migration, and both ways of interrupting it ─────────────────────

  await deckStore.initDeckStorage();

  const deckWith = async (id, entry) => {
    await deckStore.writeDeckSnapshot(id, {
      id, title: "A deck", cards: [],
      meta: { pdfs: [{ id: "pdf-m", name: "paper.pdf", size: 8, sha256: HASH, ...entry }] }
    });
  };
  const entryOf = async (id) => (await deckStore.readDeckSnapshot(id))?.meta?.pdfs?.[0] || {};

  await must("a paper still in the old Supabase bucket is planned as a job", async () => {
    await deckWith("deck-legacy", { path: "uid/pdfs/x/paper.pdf" });
    const jobs = (await migration.planDocumentMigration()).filter((job) => job.deckLocalId === "deck-legacy");
    if (jobs.length !== 1) return `planned ${jobs.length} jobs`;
    return jobs[0].source === "storage" || `source was ${jobs[0].source}`;
  });

  await must("a paper in Drive is planned too — the second migration must not strand the first", async () => {
    await deckWith("deck-drive", { driveId: "file-7" });
    const jobs = (await migration.planDocumentMigration()).filter((job) => job.deckLocalId === "deck-drive");
    if (jobs.length !== 1) return `planned ${jobs.length} jobs`;
    return jobs[0].source === "drive" || `source was ${jobs[0].source}`;
  });

  await must("a paper the reader offloaded is left alone", async () => {
    await deckWith("deck-offloaded", { path: "uid/pdfs/x/paper.pdf", offloaded: true });
    const jobs = (await migration.planDocumentMigration()).filter((job) => job.deckLocalId === "deck-offloaded");
    return jobs.length === 0 || "an offloaded paper was queued for the cloud the reader rejected";
  });

  await must("a paper already in the bucket is not planned at all", async () => {
    await deckWith("deck-done", { s3Key: `recall/pdf-m/${HASH}.pdf` });
    const jobs = (await migration.planDocumentMigration()).filter((job) => job.deckLocalId === "deck-done");
    return jobs.length === 0 || "a migrated paper was offered again";
  });

  // ── The move, with an old Supabase bucket that answers ──────────────────
  //
  // Everything below runs against a stand-in Supabase: the old `documents`
  // bucket (list with a search, and remove), and the `decks` table's document
  // fields — which is what the move asks before it deletes anything. Real
  // bytes and real hashes from here on, because the move now hashes what it
  // reads rather than believing the record.
  const hexOf = (text) => createHash("sha256").update(text).digest("hex");
  const LEGACY = "LEGACYBYTES";
  const LEGACY_HASH = hexOf(LEGACY);
  const legacyKey = (pdfId = "pdf-m", hash = LEGACY_HASH) => `recall/${pdfId}/${hash}.pdf`;
  const oldBucket = new Map();
  const cloudDecks = new Map();
  const removedPaths = [];
  const clientMod = await load("src/cloud/supabase-client.js");
  const fakeSupabase = {
    storage: {
      from: (bucket) => ({
        list: async (dir, { search } = {}) => ({
          data: [...oldBucket.entries()]
            .filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
            .filter(([p]) => !search || p.slice(dir.length + 1).startsWith(search))
            .map(([p, body]) => ({ name: p.slice(dir.length + 1), id: `obj-${p}`, metadata: { size: body.length } })),
          error: null
        }),
        remove: async (paths) => {
          for (const p of paths) { oldBucket.delete(p); removedPaths.push(p); }
          return { data: [], error: null };
        },
        getPublicUrl: (p) => ({ data: { publicUrl: `https://ref.supabase.co/storage/v1/object/public/${bucket}/${encodeURI(p)}` } }),
        createSignedUrls: async () => ({ data: [], error: null })
      })
    },
    from: () => {
      const query = { ids: null };
      const builder = {
        select() { return builder; },
        in(_column, ids) { query.ids = ids.map(String); return builder; },
        order() { return builder; },
        range() { return builder; },
        then(resolve, reject) {
          const rows = [...cloudDecks.entries()]
            .filter(([id]) => !query.ids || query.ids.includes(id))
            .map(([id, meta]) => ({ id, pdf: meta.pdf ?? null, pdfs: meta.pdfs ?? null, notebook: meta.notebook ?? null }));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        }
      };
      return builder;
    },
    auth: { getSession: async () => ({ data: { session: null }, error: null }) }
  };
  clientMod.setSupabaseClient(fakeSupabase);
  clientMod.setSignedIn(true);
  const indexLib = await load("src/library/local-library.js");
  const indexDeck = (id, deckId = "") => {
    const index = indexLib.readLocalDeckIndex().filter((row) => row.id !== id);
    index.push({ id, title: id, updatedAt: new Date(0).toISOString(), ...(deckId ? { deckId } : {}) });
    indexLib.writeLocalDeckIndex(index);
  };
  // What a sync would have pushed: the deck's own document records, as the
  // cloud row now holds them.
  const pushDeck = async (id, deckId) => {
    const meta = (await deckStore.readDeckSnapshot(id))?.meta || {};
    cloudDecks.set(deckId, { pdf: meta.pdf, pdfs: meta.pdfs, notebook: meta.notebook });
  };
  const legacyDeck = async (id, entry, { bytes = LEGACY, onDevice = true } = {}) => {
    await deckStore.writeDeckSnapshot(id, {
      id, title: id, cards: [],
      meta: { pdfs: [{ id: "pdf-m", name: "paper.pdf", size: bytes.length, sha256: LEGACY_HASH, ...entry }] }
    });
    if (onDevice) {
      // Filed where a second paper lives — under its pdf id — because that is
      // where the move looks (migrationStoreKey).
      await pdfStore.putDocument({ deckLocalId: `${id}#pdf:pdf-m`, blob: new Blob([bytes]), sha256: entry.sha256 ?? LEGACY_HASH, name: "paper.pdf", at: Date.now() });
    }
  };
  const planned = async (id) => (await migration.planDocumentMigration()).filter((job) => job.deckLocalId === id);

  await must("a move copies, checks the bucket, and only THEN removes the old copy — which it can see the bucket matches", async () => {
    objects.clear();
    oldBucket.set("uid/pdfs/first/paper.pdf", LEGACY);
    await legacyDeck("deck-legacy", { path: "uid/pdfs/first/paper.pdf" });
    const [job] = await planned("deck-legacy");
    requests.length = 0;
    removedPaths.length = 0;
    const result = await migration.migrateDocumentToS3(job);
    if (!result.moved) return `it did not move: ${result.reason}`;
    const entry = await entryOf("deck-legacy");
    if (entry.s3Key !== legacyKey()) return `the deck was not told where the paper went: ${entry.s3Key}`;
    const put = requests.findIndex((line) => line.startsWith("PUT"));
    if (put === -1) return `nothing was uploaded: ${requests.join(", ")}`;
    if (objects.get(legacyKey()) !== LEGACY) return "the bucket does not hold the paper";
    if (!removedPaths.includes("uid/pdfs/first/paper.pdf")) return "the old Supabase copy was not removed";
    return entry.path === "uid/pdfs/first/paper.pdf"
      || "the old locator was erased — it is the record of where those bytes were";
  });

  await must("...and a moved paper is never planned again — the card empties", async () => {
    const again = await planned("deck-legacy");
    if (again.length) return `planned again: ${JSON.stringify(again[0])}`;
    const entry = await entryOf("deck-legacy");
    return entry.retiredLocators?.path === "uid/pdfs/first/paper.pdf" || `no retired marker: ${JSON.stringify(entry)}`;
  });

  await must("a deck in the cloud is not swept until the CLOUD carries the new hash", async () => {
    objects.clear();
    oldBucket.set("uid/pdfs/y/paper.pdf", LEGACY);
    await legacyDeck("deck-cloud", { path: "uid/pdfs/y/paper.pdf", sha256: "" });
    indexDeck("deck-cloud", "cloud-1");
    cloudDecks.set("cloud-1", { pdfs: [{ id: "pdf-m", name: "paper.pdf", size: LEGACY.length, path: "uid/pdfs/y/paper.pdf" }] });
    const [job] = await planned("deck-cloud");
    removedPaths.length = 0;
    // No sync is passed, so the cloud row stays as it was: hashless.
    const result = await migration.migrateDocumentToS3(job);
    if (result.status !== "waiting") return `expected waiting, got ${result.status}: ${result.reason}`;
    if (removedPaths.length) return `it deleted the only copy other devices can find: ${removedPaths.join(", ")}`;
    if (!oldBucket.has("uid/pdfs/y/paper.pdf")) return "the old copy is gone";
    return objects.has(legacyKey()) || "the paper did not even reach the bucket";
  });

  await must("...and once the sync has carried it, the next run finishes the job", async () => {
    const [job] = await planned("deck-cloud");
    if (!job) return "the waiting paper was not offered again";
    removedPaths.length = 0;
    const result = await migration.migrateDocumentToS3(job, { sync: () => pushDeck("deck-cloud", "cloud-1") });
    if (result.status !== "moved") return `expected moved, got ${result.status}: ${result.reason}`;
    return removedPaths.includes("uid/pdfs/y/paper.pdf") || "the old copy was not removed";
  });

  await must("signed out, nothing is deleted — the paper waits in the bucket, safe", async () => {
    objects.clear();
    oldBucket.set("uid/pdfs/z/paper.pdf", LEGACY);
    await legacyDeck("deck-signedout", { path: "uid/pdfs/z/paper.pdf" });
    const [job] = await planned("deck-signedout");
    clientMod.setSignedIn(false);
    removedPaths.length = 0;
    const result = await migration.migrateDocumentToS3(job);
    clientMod.setSignedIn(true);
    if (removedPaths.length) return "it deleted with no way to check the other decks in the cloud";
    if (result.status !== "waiting") return `expected waiting, got ${result.status}`;
    return objects.has(legacyKey()) || "the copy did not happen";
  });

  await must("a Drive copy that cannot be deleted is left in Drive, retired, and named", async () => {
    objects.clear();
    await legacyDeck("deck-drive-left", { driveId: "drive-file-1" });
    const [job] = await planned("deck-drive-left");
    const result = await migration.migrateDocumentToS3(job);
    if (result.status !== "left") return `expected left, got ${result.status}: ${result.reason}`;
    if (result.driveId !== "drive-file-1") return `the Drive file was not named: ${JSON.stringify(result)}`;
    const again = await planned("deck-drive-left");
    return again.length === 0 || "a paper safely in the bucket was offered again for ever";
  });

  await must("a notes-conflict stash is not planned, so it can never delete the real deck's copy", async () => {
    await deckStore.writeDeckSnapshot("deck-real:notes-conflict", {
      id: "deck-real:notes-conflict", title: "stash", cards: [],
      meta: { pdfs: [{ id: "pdf-m", name: "paper.pdf", size: 8, sha256: HASH, path: "uid/pdfs/stash/paper.pdf" }] }
    });
    const jobs = (await migration.planDocumentMigration()).filter((job) => job.deckLocalId.includes("notes-conflict"));
    return jobs.length === 0 || `planned ${jobs.length} stash job(s)`;
  });

  await must("bytes that do not match the record's hash are refused, and nothing is deleted", async () => {
    objects.clear();
    oldBucket.set("uid/pdfs/m/paper.pdf", "SOMEOTHERFILE");
    await legacyDeck("deck-mismatch", { path: "uid/pdfs/m/paper.pdf" }, { bytes: "SOMEOTHERFILE", onDevice: true });
    // The device copy is labelled with the record's hash but is not those
    // bytes — and the old Supabase copy is the same wrong file.
    const [job] = await planned("deck-mismatch");
    removedPaths.length = 0;
    const result = await migration.migrateDocumentToS3(job);
    if (result.moved) return "it moved bytes the deck does not mean";
    if (removedPaths.length) return "it deleted something";
    if ([...objects.keys()].length) return `it uploaded: ${[...objects.keys()].join(", ")}`;
    return !(await entryOf("deck-mismatch")).s3Key || "the deck was pointed at the wrong bytes";
  });

  await must("a recorded key whose object is gone is copied again before anything is deleted", async () => {
    objects.clear();
    oldBucket.set("uid/pdfs/h/paper.pdf", LEGACY);
    await legacyDeck("deck-half", { path: "uid/pdfs/h/paper.pdf", s3Key: legacyKey() });
    const [job] = await planned("deck-half");
    requests.length = 0;
    removedPaths.length = 0;
    const result = await migration.migrateDocumentToS3(job);
    if (!result.moved) return `it did not finish: ${result.reason}`;
    const put = requests.findIndex((line) => line.startsWith("PUT"));
    if (put === -1) return "it swept the old copy with nothing in the bucket";
    return objects.get(legacyKey()) === LEGACY || "the bucket does not hold the paper";
  });

  await must("interrupted before the save, the next run finds the object and does not upload twice", async () => {
    objects.clear();
    objects.set(legacyKey(), LEGACY);
    oldBucket.set("uid/pdfs/o/paper.pdf", LEGACY);
    await legacyDeck("deck-orphan", { path: "uid/pdfs/o/paper.pdf" });
    const [job] = await planned("deck-orphan");
    requests.length = 0;
    await migration.migrateDocumentToS3(job);
    const head = requests.filter((line) => line.startsWith("HEAD")).length;
    const put = requests.filter((line) => line.startsWith("PUT")).length;
    if (!head) return `it never checked whether the object was there: ${requests.join(", ")}`;
    if (put) return `it uploaded a duplicate: ${requests.join(", ")}`;
    return (await entryOf("deck-orphan")).s3Key === legacyKey()
      || "the deck was not told about the object that was already there";
  });

  await must("an old copy another deck still relies on is kept until that deck has moved too", async () => {
    objects.clear();
    oldBucket.set("uid/pdfs/shared/paper.pdf", LEGACY);
    await legacyDeck("deck-share-a", { path: "uid/pdfs/shared/paper.pdf" });
    await legacyDeck("deck-share-b", { path: "uid/pdfs/shared/paper.pdf" }, { onDevice: false });
    const [jobA] = await planned("deck-share-a");
    removedPaths.length = 0;
    const first = await migration.migrateDocumentToS3(jobA);
    if (!first.moved) return `the first deck did not move: ${first.reason}`;
    if (removedPaths.length) return "the copy the second deck still needs was deleted";
    const [jobB] = await planned("deck-share-b");
    if (!jobB) return "the second deck was not offered";
    const second = await migration.migrateDocumentToS3(jobB);
    if (!second.moved) return `the second deck did not move: ${second.reason}`;
    return removedPaths.includes("uid/pdfs/shared/paper.pdf") || "the last deck to move did not free the old copy";
  });

  await must("...and one only a deck in the cloud names is never deleted from here", async () => {
    objects.clear();
    oldBucket.set("uid/pdfs/remote/paper.pdf", LEGACY);
    await legacyDeck("deck-here", { path: "uid/pdfs/remote/paper.pdf" });
    cloudDecks.set("cloud-elsewhere", { pdfs: [{ id: "pdf-m", name: "paper.pdf", path: "uid/pdfs/remote/paper.pdf" }] });
    const [job] = await planned("deck-here");
    removedPaths.length = 0;
    const result = await migration.migrateDocumentToS3(job);
    cloudDecks.delete("cloud-elsewhere");
    if (!result.moved) return `it did not move: ${result.reason}`;
    return !removedPaths.length || "it deleted a copy a deck on another device still names";
  });

  await must("an old Supabase copy that is not the same size as the file moved is kept", async () => {
    objects.clear();
    oldBucket.set("uid/pdfs/s/paper.pdf", "A DIFFERENT, LONGER FILE");
    await legacyDeck("deck-size", { path: "uid/pdfs/s/paper.pdf", sha256: "" });
    const [job] = await planned("deck-size");
    removedPaths.length = 0;
    const result = await migration.migrateDocumentToS3(job);
    if (!result.moved) return `it did not move: ${result.reason}`;
    if (removedPaths.length) return "it deleted a Supabase copy that was not the file it moved";
    return (await planned("deck-size")).length === 0 || "offered again for ever";
  });

  await must("a paper from before hashing existed is hashed on the way, not refused", async () => {
    // The oldest records in a library carry no sha256, and the key IS the
    // hash — so without hashing here they could not be moved at all, which is
    // exactly backwards: they are the ones most likely to still be sitting in
    // Supabase.
    objects.clear();
    oldBucket.set("uid/pdfs/x/old.pdf", "OLDPAPER-NO-HASH");
    await deckStore.writeDeckSnapshot("deck-unhashed", {
      id: "deck-unhashed", title: "A deck", cards: [],
      meta: { pdfs: [{ id: "pdf-old", name: "paper.pdf", size: 16, path: "uid/pdfs/x/old.pdf" }] }
    });
    const [job] = await planned("deck-unhashed");
    if (!job) return "an unhashed paper was not planned";
    await pdfStore.putDocument({
      deckLocalId: migration.migrationStoreKey(job),
      blob: new Blob(["OLDPAPER-NO-HASH"]), sha256: "", name: "paper.pdf", at: Date.now()
    });
    const result = await migration.migrateDocumentToS3(job);
    if (!result.moved) return `it refused: ${result.reason}`;
    const entry = (await deckStore.readDeckSnapshot("deck-unhashed"))?.meta?.pdfs?.[0] || {};
    if (entry.sha256 !== hexOf("OLDPAPER-NO-HASH")) return `the wrong hash was recorded: ${entry.sha256}`;
    // And the recorded hash has to be the one in the key, or the rebuild in
    // pdf-store.js would name an object that does not exist.
    return entry.s3Key === `recall/pdf-old/${entry.sha256}.pdf` || `key and hash disagree: ${entry.s3Key}`;
  });

  await must("a move that cannot read the bytes changes nothing", async () => {
    objects.clear();
    await deckWith("deck-unreadable", { path: "uid/pdfs/gone/paper.pdf" });
    const [job] = await planned("deck-unreadable");
    const result = await migration.migrateDocumentToS3(job);
    if (result.moved) return "it claimed to move a paper it could not read";
    const entry = await entryOf("deck-unreadable");
    return entry.path === "uid/pdfs/gone/paper.pdf" && !entry.s3Key
      || "a failed move still edited the deck";
  });

  await must("\"Remove from cloud\" keeps an old copy another deck still names", async () => {
    oldBucket.set("uid/pdfs/twin/paper.pdf", LEGACY);
    await legacyDeck("deck-rm-a", { path: "uid/pdfs/twin/paper.pdf" });
    await legacyDeck("deck-rm-b", { path: "uid/pdfs/twin/paper.pdf" });
    removedPaths.length = 0;
    const result = await migration.deleteDocumentCopies(
      { name: "paper.pdf", sha256: LEGACY_HASH, path: "uid/pdfs/twin/paper.pdf" },
      { deckLocalId: "deck-rm-a", slot: "doc", pdfId: "pdf-m" }
    );
    if (removedPaths.length) return "the other deck's only cloud copy was deleted";
    return (result.removed && result.shared) || `result ${JSON.stringify(result)}`;
  });

  // Back to a device with no Supabase, for the cases below.
  clientMod.setSignedIn(false);
  clientMod.setSupabaseClient(null);

  await must("the paper count leaves the figures' prefix out", async () => {
    objects.clear();
    objects.set(`recall/pdf-a/${HASH}.pdf`, "PAPER");
    objects.set("recall-images/ref.supabase.co/uid/decks/d--1/pic.webp", "PICTURE");
    const usage = await s3Files.s3Usage();
    return usage.count === 1 || `counted ${usage.count}`;
  });

  // ── Which key a record means ────────────────────────────────────────────
  //
  // The rebuild that runs when a record has lost its s3Key, or never had one.
  // A bare meta.pdf has no id and a notebook never has one; both were uploaded
  // under a fixed id, and the rebuild used to say "unfiled" for both.

  await must("a record with no id rebuilds the key the import uploaded under", () => {
    const key = pdfStore.documentS3Key({ name: "paper.pdf", sha256: HASH });
    return key === `recall/primary/${HASH}.pdf` || `got ${key}`;
  });

  await must("...and a notebook's rebuilds under notebook, not unfiled", () => {
    const key = pdfStore.documentS3Key({ notebook: true, pages: 3, sha256: HASH });
    return key === `recall/notebook/${HASH}.pdf` || `got ${key}`;
  });

  await must("a stored key naming OTHER bytes than the record's hash is not believed", () => {
    const key = pdfStore.documentS3Key({ notebook: true, sha256: HASH, s3Key: `recall/notebook/${OTHER_HASH}.pdf` });
    return key === `recall/notebook/${HASH}.pdf` || `followed the stale key: ${key}`;
  });

  await must("...so a rewritten notebook opens its NEW pages, not the ones the stale key names", async () => {
    objects.set(`recall/notebook/${OTHER_HASH}.pdf`, "OLDPAGES");
    objects.set(`recall/notebook/${HASH}.pdf`, "NEWPAGES");
    const blob = await pdfStore.getDocument("deck-notebook-stale#notebook", {
      notebook: true, sha256: HASH, s3Key: `recall/notebook/${OTHER_HASH}.pdf`
    });
    return (await textOf(blob)) === "NEWPAGES" || `got ${blob} — old pages cached under the new hash`;
  });

  // ── The write half of the connection test ───────────────────────────────

  await must("a bucket that reads but blocks uploads FAILS the connection test and names the policy", async () => {
    failNext = { method: "PUT", throws: true };
    const result = await s3Files.testS3Connection();
    if (result.ok) return "a bucket nobody can upload to tested clean — the 'connected but nothing syncs' bug";
    if (!result.corsLikely) return "the CORS flag was not set";
    return /PUT/.test(result.reason) || `the reason does not say what to allow: ${result.reason}`;
  });

  await must("...and a read-only token fails it too, saying so", async () => {
    failNext = { method: "PUT", status: 403, body: "<Error><Code>AccessDenied</Code></Error>" };
    const result = await s3Files.testS3Connection();
    if (result.ok) return "a read-only token tested clean";
    return /write/i.test(result.reason) || `the reason was: ${result.reason}`;
  });

  await must("...while a refused delete passes with a warning, and the probe never counts as a paper", async () => {
    failNext = { method: "DELETE", status: 403, body: "<Error><Code>AccessDenied</Code></Error>" };
    const result = await s3Files.testS3Connection();
    if (!result.ok) return `it failed outright: ${result.reason}`;
    if (!/delete/i.test(result.warning || "")) return `no warning: ${JSON.stringify(result)}`;
    const usage = await s3Files.s3Usage();
    objects.delete(s3Files.S3_PROBE_KEY);
    return !usage.files.some((file) => file.key === s3Files.S3_PROBE_KEY) || "the probe object was counted as a paper";
  });

  await must("a clean connection test leaves nothing behind", async () => {
    const result = await s3Files.testS3Connection();
    if (!result.ok) return `it failed: ${result.reason}`;
    return !objects.has(s3Files.S3_PROBE_KEY) || "the probe object was left in the bucket";
  });

  // ── Papers that never went up ───────────────────────────────────────────

  const lib = await load("src/library/local-library.js");
  const { state } = await load("src/core/state.js");
  const docSlot = await load("src/documents/doc-slot.js");
  const backfillOf = async (id) => (await migration.planDocumentBackfill()).filter((job) => job.deckLocalId === id);

  await must("a paper imported with no bucket is planned for upload", async () => {
    objects.clear();
    // Exactly what importPdfFile writes when the upload cannot happen: a bare
    // meta.pdf with a hash and no locator at all.
    await deckStore.writeDeckSnapshot("deck-local", {
      id: "deck-local", title: "A paper", cards: [],
      meta: { pdf: { name: "paper.pdf", size: 10, pages: 3, sha256: HASH, path: null } }
    });
    const jobs = await backfillOf("deck-local");
    if (jobs.length !== 1) return `planned ${jobs.length}`;
    return jobs[0].pdfId === "primary" || `pdfId ${jobs[0].pdfId}`;
  });

  await must("...and the migration still does not plan it, so the two never fight over one paper", async () => {
    const jobs = (await migration.planDocumentMigration()).filter((job) => job.deckLocalId === "deck-local");
    return jobs.length === 0 || "the migration planned a paper that has no old source";
  });

  await must("the backfill uploads it from this device, records the key, and bumps the deck for the push", async () => {
    await pdfStore.putDocument({ deckLocalId: "deck-local", blob: "LOCALBYTES", sha256: HASH, name: "paper.pdf", at: Date.now() });
    lib.writeLocalDeckIndex([{ id: "deck-local", title: "A paper", updatedAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: "2026-01-01T00:00:00.000Z" }]);
    requests.length = 0;
    const summary = await migration.backfillDocumentsToS3(await backfillOf("deck-local"));
    if (summary.uploaded !== 1) return `uploaded ${summary.uploaded}: ${JSON.stringify(summary)}`;
    if (objects.get(`recall/primary/${HASH}.pdf`) !== "LOCALBYTES") return "the bytes are not in the bucket under the key other devices derive";
    const snapshot = await deckStore.readDeckSnapshot("deck-local");
    if (snapshot?.meta?.pdf?.s3Key !== `recall/primary/${HASH}.pdf`) return `recorded ${snapshot?.meta?.pdf?.s3Key}`;
    const entry = lib.readLocalDeckIndex().find((row) => row.id === "deck-local");
    return entry.updatedAt > "2026-01-01T00:00:00.000Z" || "updatedAt did not move, so the key would never be pushed";
  });

  await must("...after which it is not planned again", async () => {
    const jobs = await backfillOf("deck-local");
    return jobs.length === 0 || "a recorded paper was planned a second time";
  });

  await must("a paper already in the bucket is recorded with a HEAD, not uploaded twice", async () => {
    objects.set(`recall/pdf-there/${HASH}.pdf`, "ALREADY");
    await deckStore.writeDeckSnapshot("deck-there", {
      id: "deck-there", title: "A deck", cards: [],
      meta: { pdfs: [{ id: "pdf-there", name: "paper.pdf", size: 7, sha256: HASH }] }
    });
    await pdfStore.putDocument({ deckLocalId: "deck-there#pdf:pdf-there", blob: "ALREADY", sha256: HASH, name: "paper.pdf", at: Date.now() });
    requests.length = 0;
    const summary = await migration.backfillDocumentsToS3(await backfillOf("deck-there"));
    if (requests.some((line) => line.startsWith("PUT"))) return `it uploaded again: ${requests.join(", ")}`;
    return summary.recorded === 1 || `summary ${JSON.stringify(summary)}`;
  });

  await must("a paper that is not on this device is skipped without a single request", async () => {
    await deckStore.writeDeckSnapshot("deck-elsewhere", {
      id: "deck-elsewhere", title: "A deck", cards: [],
      meta: { pdf: { name: "far.pdf", size: 5, sha256: OTHER_HASH } }
    });
    requests.length = 0;
    const summary = await migration.backfillDocumentsToS3(await backfillOf("deck-elsewhere"));
    if (requests.length) return `it asked the bucket: ${requests.join(", ")}`;
    return summary.skipped === 1 || `summary ${JSON.stringify(summary)}`;
  });

  await must("...and the panel counts it as waiting on another device, not as on this one", async () => {
    const counts = await migration.countBackfillOnDevice(await backfillOf("deck-elsewhere"));
    return (counts.here === 0 && counts.elsewhere === 1) || `counted ${JSON.stringify(counts)}`;
  });

  await must("an offloaded paper is never put back behind the reader's back", async () => {
    await deckStore.writeDeckSnapshot("deck-gone", {
      id: "deck-gone", title: "A deck", cards: [],
      meta: { pdf: { name: "done.pdf", size: 5, sha256: HASH, offloaded: true } }
    });
    return (await backfillOf("deck-gone")).length === 0 || "an offloaded paper was planned";
  });

  await must("a notes-conflict stash is not planned as a second, missing copy of its deck", async () => {
    await deckStore.writeDeckSnapshot("deck-local:notes-conflict", {
      id: "deck-local:notes-conflict", title: "A paper", cards: [],
      meta: { pdf: { name: "paper.pdf", size: 10, sha256: OTHER_HASH } }
    });
    return (await backfillOf("deck-local:notes-conflict")).length === 0 || "the stash was planned";
  });

  await must("a notebook goes up under notebook, from its own slot on the device", async () => {
    await deckStore.writeDeckSnapshot("deck-nb", {
      id: "deck-nb", title: "Notes", cards: [],
      meta: { notebook: { name: "nb.pdf", size: 6, pages: 2, notebook: true, sha256: OTHER_HASH } }
    });
    await pdfStore.putDocument({
      deckLocalId: docSlot.documentStoreKey("deck-nb", docSlot.DOC_SLOT_NOTEBOOK),
      blob: "NBBYTES", sha256: OTHER_HASH, name: "nb.pdf", at: Date.now()
    });
    const summary = await migration.backfillDocumentsToS3(await backfillOf("deck-nb"));
    if (summary.uploaded !== 1) return `summary ${JSON.stringify(summary)}`;
    return objects.get(`recall/notebook/${OTHER_HASH}.pdf`) === "NBBYTES" || "the notebook is not where other devices look";
  });

  await must("the open deck is patched in memory, so its next autosave cannot revert the key", async () => {
    await deckStore.writeDeckSnapshot("deck-open", {
      id: "deck-open", title: "Open", cards: [],
      meta: { pdf: { name: "open.pdf", size: 4, sha256: OTHER_HASH } }
    });
    await pdfStore.putDocument({ deckLocalId: "deck-open", blob: "OPENBYTES", sha256: OTHER_HASH, name: "open.pdf", at: Date.now() });
    const was = { id: state.localDeckId, meta: state.meta };
    state.localDeckId = "deck-open";
    state.meta = { pdf: { name: "open.pdf", size: 4, sha256: OTHER_HASH } };
    try {
      await migration.backfillDocumentsToS3(await backfillOf("deck-open"));
      return state.meta?.pdf?.s3Key === `recall/primary/${OTHER_HASH}.pdf` || `state.meta.pdf is ${JSON.stringify(state.meta?.pdf)}`;
    } finally {
      state.localDeckId = was.id;
      state.meta = was.meta;
    }
  });

  await must("a refused upload stops the run rather than failing every paper the same way", async () => {
    objects.clear();
    for (const id of ["deck-r1", "deck-r2"]) {
      await deckStore.writeDeckSnapshot(id, {
        id, title: id, cards: [], meta: { pdfs: [{ id: `pdf-${id}`, name: "p.pdf", size: 3, sha256: HASH }] }
      });
      await pdfStore.putDocument({ deckLocalId: `${id}#pdf:pdf-${id}`, blob: "RBYTES", sha256: HASH, name: "p.pdf", at: Date.now() });
    }
    const jobs = [...(await backfillOf("deck-r1")), ...(await backfillOf("deck-r2"))];
    failNext = { method: "PUT", status: 403, body: "<Error><Code>AccessDenied</Code></Error>" };
    requests.length = 0;
    const summary = await migration.backfillDocumentsToS3(jobs);
    const puts = requests.filter((line) => line.startsWith("PUT")).length;
    if (puts !== 1) return `${puts} uploads were attempted after a refusal`;
    return Boolean(summary.stopped) || `the run did not stop: ${JSON.stringify(summary)}`;
  });

  await must("...and the refused paper waits before it is tried again", async () => {
    requests.length = 0;
    const summary = await migration.backfillDocumentsToS3(await backfillOf("deck-r1"));
    if (requests.some((line) => line.startsWith("PUT"))) return "it retried straight away";
    return summary.skipped === 1 || `summary ${JSON.stringify(summary)}`;
  });

  // ── One file, two decks ─────────────────────────────────────────────────

  // Its own hash: other decks above already share recall/primary/<HASH>, and
  // the guard is right to keep that one.
  const TWIN_HASH = "d".repeat(64);

  await must("removing one deck's copy keeps an object another deck still names", async () => {
    objects.clear();
    const key = `recall/primary/${TWIN_HASH}.pdf`;
    objects.set(key, "SHARED");
    for (const id of ["deck-twin-a", "deck-twin-b"]) {
      await deckStore.writeDeckSnapshot(id, {
        id, title: id, cards: [], meta: { pdf: { name: "same.pdf", size: 6, sha256: TWIN_HASH, s3Key: key } }
      });
    }
    const result = await migration.deleteDocumentCopies(
      { name: "same.pdf", sha256: TWIN_HASH, s3Key: key },
      { deckLocalId: "deck-twin-a", slot: docSlot.DOC_SLOT_DOC, pdfId: "primary" }
    );
    if (!objects.has(key)) return "the other deck's paper was deleted out from under it";
    return (result.removed && result.shared) || `result ${JSON.stringify(result)}`;
  });

  await must("...and deletes it once no other deck needs it", async () => {
    const key = `recall/primary/${TWIN_HASH}.pdf`;
    await deckStore.writeDeckSnapshot("deck-twin-b", {
      id: "deck-twin-b", title: "deck-twin-b", cards: [],
      meta: { pdf: { name: "same.pdf", size: 6, sha256: TWIN_HASH, s3Key: key, offloaded: true } }
    });
    const result = await migration.deleteDocumentCopies(
      { name: "same.pdf", sha256: TWIN_HASH, s3Key: key },
      { deckLocalId: "deck-twin-a", slot: docSlot.DOC_SLOT_DOC, pdfId: "primary" }
    );
    if (objects.has(key)) return "an object nothing needs was kept";
    return (result.removed && !result.shared) || `result ${JSON.stringify(result)}`;
  });

  console.warn = realWarn;
  console.log("── s3 store ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  const noted = warnings.length ? ` · ${warnings.length} expected degradation warning(s)` : "";
  console.log(`\n  ${results.length} checks · ${failures} failed${noted}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
