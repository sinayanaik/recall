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

  const reply = (status, body = "") => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    blob: async () => body,
    headers: { get: () => null }
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
    if (method === "HEAD") return objects.has(key) ? reply(200) : reply(404);
    if (method === "DELETE") {
      const had = objects.delete(key);
      return reply(had ? 204 : 404);
    }
    if (method === "GET" && key) {
      return objects.has(key) ? reply(200, objects.get(key)) : reply(404, "<Error><Code>NoSuchKey</Code></Error>");
    }
    // A listing. XML, because that is what the module parses.
    const rows = [...objects.entries()].map(([name, body]) => `
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
    return blob === "PDFBYTES" || `got ${blob}`;
  });

  await must("getDocument reaches the bucket when the device has no copy", async () => {
    const blob = await pdfStore.getDocument("deck-missing", { id: "pdf-1", sha256: HASH, s3Key: locator.s3Key });
    return blob === "PDFBYTES" || `got ${blob}`;
  });

  await must("...and caches it on the device, so the next open costs nothing", async () => {
    const before = requests.length;
    const blob = await pdfStore.getDocument("deck-missing", { id: "pdf-1", sha256: HASH, s3Key: locator.s3Key });
    if (blob !== "PDFBYTES") return `got ${blob}`;
    return requests.length === before || `it went back to the bucket: ${requests.slice(before).join(", ")}`;
  });

  // ── The way home ────────────────────────────────────────────────────────

  await must("a record whose s3Key was lost to a merge still finds its paper", async () => {
    // No s3Key on the record and no device copy: the key has to be rebuilt
    // from the pdf id and the hash, both of which survived the merge.
    const blob = await pdfStore.getDocument("deck-never-seen", { id: "pdf-1", sha256: HASH });
    return blob === "PDFBYTES" || `got ${blob}`;
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
    return blob === "NEWBYTES" || `the stale copy was served: ${blob}`;
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

  await must("a move uploads, records the key, and only THEN sweeps the old copy", async () => {
    await deckWith("deck-legacy", { path: "uid/pdfs/x/paper.pdf" });
    const [job] = (await migration.planDocumentMigration()).filter((j) => j.deckLocalId === "deck-legacy");
    // The device holds the bytes, which is the ordinary case — the reader has
    // been reading this paper — so the move costs no download. It is filed
    // under migrationStoreKey rather than the bare deck id: a second PDF in a
    // deck lives under a composed key, and putting it anywhere else here would
    // test a lookup the app never performs.
    await pdfStore.putDocument({
      deckLocalId: migration.migrationStoreKey(job),
      blob: "LEGACYBYTES", sha256: HASH, name: "paper.pdf", at: Date.now()
    });
    requests.length = 0;
    const result = await migration.migrateDocumentToS3(job);
    if (!result.moved) return `it did not move: ${result.reason}`;
    const entry = await entryOf("deck-legacy");
    if (!entry.s3Key) return "the deck was not told where the paper went";
    // The legacy sweep is a Supabase call, not an S3 one, so what this proves
    // is the half that belongs to the bucket: the PUT happened, and the deck
    // carries the key it wrote.
    const put = requests.findIndex((line) => line.startsWith("PUT"));
    if (put === -1) return `nothing was uploaded: ${requests.join(", ")}`;
    return entry.path === "uid/pdfs/x/paper.pdf"
      || "the old locator was erased — it is the record of where those bytes were";
  });

  await must("interrupted after the save, the next run only sweeps — it does not re-upload", async () => {
    await deckWith("deck-half", { path: "uid/pdfs/x/paper.pdf", s3Key: `recall/pdf-m/${HASH}.pdf` });
    const [job] = (await migration.planDocumentMigration()).filter((j) => j.deckLocalId === "deck-half");
    if (!job) return "the half-finished move was not offered again";
    requests.length = 0;
    await migration.migrateDocumentToS3(job);
    return !requests.some((line) => line.startsWith("PUT"))
      || `it uploaded a second copy: ${requests.join(", ")}`;
  });

  await must("interrupted before the save, the next run finds the object and does not upload twice", async () => {
    objects.set(`recall/pdf-m/${HASH}.pdf`, "LEGACYBYTES");
    await deckWith("deck-orphan", { path: "uid/pdfs/x/paper.pdf" });
    const [job] = (await migration.planDocumentMigration()).filter((j) => j.deckLocalId === "deck-orphan");
    await pdfStore.putDocument({
      deckLocalId: migration.migrationStoreKey(job),
      blob: "LEGACYBYTES", sha256: HASH, name: "paper.pdf", at: Date.now()
    });
    requests.length = 0;
    await migration.migrateDocumentToS3(job);
    const head = requests.filter((line) => line.startsWith("HEAD")).length;
    const put = requests.filter((line) => line.startsWith("PUT")).length;
    if (!head) return `it never checked whether the object was there: ${requests.join(", ")}`;
    if (put) return `it uploaded a duplicate: ${requests.join(", ")}`;
    return (await entryOf("deck-orphan")).s3Key === `recall/pdf-m/${HASH}.pdf`
      || "the deck was not told about the object that was already there";
  });

  await must("a move that cannot read the bytes changes nothing", async () => {
    objects.clear();
    await deckWith("deck-unreadable", { path: "uid/pdfs/gone/paper.pdf" });
    const [job] = (await migration.planDocumentMigration()).filter((j) => j.deckLocalId === "deck-unreadable");
    const result = await migration.migrateDocumentToS3(job);
    if (result.moved) return "it claimed to move a paper it could not read";
    const entry = await entryOf("deck-unreadable");
    return entry.path === "uid/pdfs/gone/paper.pdf" && !entry.s3Key
      || "a failed move still edited the deck";
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
