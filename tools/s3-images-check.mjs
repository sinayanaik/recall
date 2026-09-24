// Do the figures go to the reader's bucket, come back out of it, and move across
// without a single one being lost?
//
//   node tools/s3-images-check.mjs
//
// Images followed the papers into the reader's own S3-compatible bucket, and
// the design leans on one decision above all: the URL in a note does NOT
// change. Every figure keeps its canonical Supabase identifier; the bucket key
// is a pure function of it (recall-images/<host>/<path>), and the app decides
// per figure which storage to load it from. So the things asserted here are the
// ones that would lose a picture if they were wrong:
//
//   • THE MAPPING. Identifier → key → identifier, for ordinary names and ones
//     the URL has to escape — and the service worker's own rebuild, taken from
//     sw.js itself, lands on the very string the note holds. That is what
//     keeps a figure readable offline after it moved.
//   • WHERE A NEW FIGURE GOES. The bucket when there is one, Supabase when
//     there is not, and Supabase too when the bucket refuses — and a failure is
//     reported as permanent ONLY when both storages refused for good, because
//     the image outbox throws away a queued figure on a permanent failure.
//   • WHERE A FIGURE COMES FROM. The bucket when its index says so; Supabase
//     otherwise; the bucket again when Supabase has nothing to give.
//   • THE MOVE. Copying deletes nothing. Removing the Supabase copies deletes
//     only objects the bucket holds at the same size, only from the set the
//     reader confirmed, and never the offline copy.
//
// Plain Node, the same arrangement as tools/s3-store-check.mjs: the real modules
// against a scripted bucket (setS3Transport) and a scripted Supabase client.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-s3img-"));

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

  // A Cache API, for the offline copies the clean-up must leave alone.
  const cacheEntries = new Map();
  globalThis.caches = {
    open: async () => ({
      put: async (key, value) => { cacheEntries.set(String(key), value); },
      match: async (key) => cacheEntries.get(String(key)) || undefined,
      delete: async (key) => cacheEntries.delete(String(key)),
      keys: async () => [...cacheEntries.keys()].map((url) => ({ url }))
    }),
    delete: async () => true
  };

  // ListObjectsV2 is XML; the same stand-in parser s3-store-check uses.
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

  const s3Config = await load("src/cloud/s3-config.js");
  const s3Files = await load("src/cloud/s3-files.js");
  const s3Images = await load("src/cloud/s3-images.js");
  const clientMod = await load("src/cloud/supabase-client.js");
  const upload = await load("src/images/upload.js");
  const storageUrls = await load("src/cloud/storage-urls.js");
  const imageStorage = await load("src/storage/image-storage.js");

  // ── The bucket ──────────────────────────────────────────────────────────
  const BUCKET = "recall-papers";
  const requests = [];
  const objects = new Map();   // key -> { body, type }
  let failPut = null;
  let failListTimes = 0;
  const reply = (status, body = "", headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    blob: async () => new Blob([body]),
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null }
  });
  const keyFromUrl = (url) => {
    const pathname = new URL(url).pathname;
    const prefix = `/${BUCKET}/`;
    if (!pathname.startsWith(prefix)) return "";
    return pathname.slice(prefix.length).split("/").map((segment) => decodeURIComponent(segment)).join("/");
  };
  s3Files.setS3Transport(async (url, init = {}) => {
    const method = init.method || "GET";
    const key = keyFromUrl(url);
    requests.push(`${method} ${key || "(bucket)"}`);
    if (method === "PUT") {
      if (failPut) {
        const how = failPut;
        failPut = null;
        if (how.throws) throw new TypeError("Failed to fetch");
        return reply(how.status, "<Error><Code>AccessDenied</Code></Error>");
      }
      const body = typeof init.body?.text === "function" ? await init.body.text() : String(init.body);
      objects.set(key, { body, type: init.headers?.["Content-Type"] || "", cache: init.headers?.["Cache-Control"] || "" });
      return reply(200);
    }
    if (method === "HEAD") return objects.has(key) ? reply(200, "", { "content-length": String(objects.get(key).body.length) }) : reply(404);
    if (method === "DELETE") return reply(objects.delete(key) ? 204 : 404);
    if (method === "GET" && key) return objects.has(key) ? reply(200, objects.get(key).body) : reply(404);
    if (failListTimes > 0) { failListTimes -= 1; throw new TypeError("Failed to fetch"); }
    const prefix = new URL(url).searchParams.get("prefix") || "";
    const rows = [...objects.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, object]) => `
      <Contents><Key>${name}</Key><Size>${object.body.length}</Size></Contents>`).join("");
    return reply(200, `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${rows}</ListBucketResult>`);
  });
  s3Config.saveS3Config({
    endpoint: "https://abc123.r2.cloudflarestorage.com",
    bucket: BUCKET,
    region: "auto",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  });

  // ── Supabase ────────────────────────────────────────────────────────────
  const HOST = "ref.supabase.co";
  const UID = "user-1";
  const supabaseImages = new Map();   // path -> body
  const supabaseRemoved = [];
  let supabaseUploadError = null;
  let signable = true;
  let failSupabaseListTimes = 0;
  const publicUrl = (bucket, p) => `https://${HOST}/storage/v1/object/public/${bucket}/${encodeURI(p)}`;
  const fakeSupabase = {
    storage: {
      from: (bucket) => ({
        getPublicUrl: (p) => ({ data: { publicUrl: publicUrl(bucket, p) } }),
        upload: async (p, file) => {
          if (supabaseUploadError) return { data: null, error: supabaseUploadError };
          supabaseImages.set(p, typeof file?.text === "function" ? await file.text() : String(file));
          return { data: { path: p }, error: null };
        },
        list: async (dir, { search, limit = 100, offset = 0 } = {}) => {
          if (failSupabaseListTimes > 0) { failSupabaseListTimes -= 1; throw new Error("Load failed — request timed out (list images)"); }
          const names = new Map();
          for (const [p, body] of supabaseImages) {
            if (!p.startsWith(`${dir}/`)) continue;
            const rest = p.slice(dir.length + 1);
            const first = rest.split("/")[0];
            if (rest.includes("/")) names.set(first, { name: first, id: null });
            else names.set(first, { name: first, id: `id-${p}`, metadata: { size: body.length, mimetype: "image/webp" } });
          }
          const rows = [...names.values()].filter((row) => !search || row.name.startsWith(search)).sort((a, b) => a.name.localeCompare(b.name));
          return { data: rows.slice(offset, offset + limit), error: null };
        },
        remove: async (paths) => {
          for (const p of paths) { supabaseImages.delete(p); supabaseRemoved.push(p); }
          return { data: [], error: null };
        },
        download: async (p) => (supabaseImages.has(p)
          ? { data: new Blob([supabaseImages.get(p)], { type: "image/webp" }), error: null }
          : { data: null, error: { message: "Object not found" } }),
        createSignedUrls: async (paths) => ({
          data: paths.map((p) => (signable && supabaseImages.has(p)
            ? { path: p, signedUrl: `https://${HOST}/storage/v1/object/sign/${bucket}/${encodeURI(p)}?token=t` }
            : { path: p, error: "Either the object does not exist or you do not have access to it", signedUrl: null })),
          error: null
        })
      })
    },
    auth: {
      getSession: async () => ({ data: { session: { user: { id: UID }, access_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null })
    }
  };
  clientMod.setSupabaseClient(fakeSupabase);
  clientMod.setSignedIn(true);

  const imageKey = (p) => `recall-images/${HOST}/${p}`;
  const pic = (text, type = "image/webp") => new Blob([text], { type });

  // ── The mapping ─────────────────────────────────────────────────────────

  await must("an identifier maps to one key and back, spaces and all", () => {
    const p = `${UID}/decks/my deck--ld_1/17a b(1).webp`;
    const canonical = publicUrl("images", p);
    const parts = s3Images.canonicalImageParts(canonical);
    if (!parts || parts.host !== HOST || parts.path !== p) return `parts ${JSON.stringify(parts)}`;
    const key = s3Images.s3ImageKey(parts.host, parts.path);
    if (key !== imageKey(p)) return `key ${key}`;
    const back = s3Images.s3ImagePartsFromKey(key);
    return s3Images.canonicalImageUrlFor(back.host, back.path) === canonical || "the round trip changed the identifier";
  });

  await must("a paper's key and a figure's key never share a prefix", () =>
    !s3Images.s3ImageKey(HOST, `${UID}/unfiled/x.webp`).startsWith(`${s3Files.S3_PREFIX}/`) || "figures would be counted as papers");

  await must("the service worker rebuilds exactly the identifier the note holds, from the bucket URL alone", async () => {
    // Taken from sw.js itself rather than restated here, so the check fails
    // the day the worker and the page stop agreeing.
    const sw = readFileSync(path.join(ROOT, "sw.js"), "utf8");
    const grab = (name) => {
      const at = sw.indexOf(`function ${name}(`);
      if (at === -1) throw new Error(`sw.js has no ${name}`);
      return sw.slice(at, sw.indexOf("\n}\n", at) + 2);
    };
    const reLine = /const BUCKET_IMAGE_PATH_RE = [^\n]+/.exec(sw)?.[0];
    const build = new Function(`${reLine}\n${grab("bucketImageParts")}\n${grab("imageCacheKey")}\nreturn imageCacheKey;`);
    const imageCacheKey = build();
    for (const p of [`${UID}/decks/deck--ld_1/1700000000-abc.webp`, `${UID}/books/a-book--x1/0001-fig name é.png`, `${UID}/loose (1).jpg`]) {
      const signed = await s3Images.s3ImageUrl(HOST, p);
      if (!signed) return "no URL was signed";
      const key = imageCacheKey(signed);
      if (key !== publicUrl("images", p)) return `for ${p}: ${key}`;
    }
    return true;
  });

  // ── New figures ─────────────────────────────────────────────────────────

  await must("a new figure goes to the bucket, under the identifier Supabase would have given it", async () => {
    objects.clear();
    requests.length = 0;
    const url = await upload.uploadImage(pic("FIGURE-ONE"), { folder: "decks/d--1", name: "one" });
    const p = `${UID}/decks/d--1/one.webp`;
    if (url !== publicUrl("images", p)) return `returned ${url}`;
    const stored = objects.get(imageKey(p));
    if (!stored) return `not in the bucket: ${requests.join(", ")}`;
    if (stored.type !== "image/webp") return `stored as ${stored.type}`;
    if (!/immutable/.test(stored.cache)) return "no cache lifetime was set";
    if (supabaseImages.has(p)) return "it went to Supabase as well";
    if (!s3Images.s3ImageIndexHas(HOST, p)) return "the index was not told";
    return cacheEntries.has(url) || "the bytes were not kept for offline";
  });

  await must("a bucket that refuses the upload hands the figure to Supabase instead", async () => {
    failPut = { status: 403 };
    const url = await upload.uploadImage(pic("FIGURE-TWO"), { folder: "decks/d--1", name: "two" });
    return supabaseImages.has(`${UID}/decks/d--1/two.webp`) && url === publicUrl("images", `${UID}/decks/d--1/two.webp`)
      || "the figure was lost to a refusing bucket";
  });

  await must("a dropped connection and a Supabase hiccup is RETRYABLE, never a permanent refusal", async () => {
    failPut = { throws: true };
    supabaseUploadError = { message: "Gateway timeout" };
    try {
      await upload.uploadImage(pic("FIGURE-THREE"), { folder: "decks/d--1", name: "three" });
      return "it claimed to upload";
    } catch (error) {
      if (error.authFailed) return "reported as permanent — the outbox would throw the figure away";
      return error.retryable === true || `not marked retryable: ${JSON.stringify(error)}`;
    } finally {
      supabaseUploadError = null;
    }
  });

  await must("...and only when BOTH refuse for good is it permanent", async () => {
    failPut = { status: 403 };
    supabaseUploadError = { message: "new row violates row-level security policy" };
    try {
      await upload.uploadImage(pic("FIGURE-FOUR"), { folder: "decks/d--1", name: "four" });
      return "it claimed to upload";
    } catch (error) {
      return error.authFailed === true || `not marked permanent: ${JSON.stringify(error)}`;
    } finally {
      supabaseUploadError = null;
    }
  });

  await must("with no bucket set up, a figure goes to Supabase exactly as before", async () => {
    const saved = s3Config.loadS3Config();
    s3Config.clearS3Config({ tombstone: false });
    try {
      requests.length = 0;
      await upload.uploadImage(pic("FIGURE-FIVE"), { folder: "decks/d--1", name: "five" });
      if (requests.length) return `it spoke to a bucket: ${requests.join(", ")}`;
      return supabaseImages.has(`${UID}/decks/d--1/five.webp`) || "it did not reach Supabase";
    } finally {
      s3Config.saveS3Config(saved);
    }
  });

  // ── Where a figure comes from ───────────────────────────────────────────

  await must("a figure the bucket holds loads from the bucket", async () => {
    const canonical = publicUrl("images", `${UID}/decks/d--1/one.webp`);
    const url = (await storageUrls.resolveImageUrls([canonical])).get(canonical) || "";
    return url.startsWith(`https://abc123.r2.cloudflarestorage.com/${BUCKET}/recall-images/`) || `got ${url}`;
  });

  await must("a figure only Supabase holds is signed by Supabase", async () => {
    const canonical = publicUrl("images", `${UID}/decks/d--1/two.webp`);
    const url = (await storageUrls.resolveImageUrls([canonical])).get(canonical) || "";
    return url.includes("/object/sign/") || `got ${url}`;
  });

  await must("a figure Supabase does not have is tried in the bucket, even before the index knows it", async () => {
    const p = `${UID}/decks/d--1/from-another-device.webp`;
    objects.set(imageKey(p), { body: "ELSEWHERE", type: "image/webp", cache: "" });
    const canonical = publicUrl("images", p);
    const url = (await storageUrls.resolveImageUrls([canonical])).get(canonical) || "";
    return url.includes("/recall-images/") || `got ${url}`;
  });

  await must("a HEAD is signed as a HEAD, so the broken-image scan does not call bucket figures gone", async () => {
    const canonical = publicUrl("images", `${UID}/decks/d--1/one.webp`);
    const head = await storageUrls.fetchableStorageUrl(canonical, { method: "HEAD" });
    const get = await storageUrls.fetchableStorageUrl(canonical);
    if (head === get) return "one signature for two verbs";
    return head.includes("/recall-images/") || `got ${head}`;
  });

  await must("...while a HEAD for a figure only Supabase holds goes to Supabase, not to a bucket that would 404", async () => {
    const canonical = publicUrl("images", `${UID}/decks/d--1/two.webp`);
    const head = await storageUrls.fetchableStorageUrl(canonical, { method: "HEAD" });
    return head.includes("/object/sign/") || `got ${head}`;
  });

  await must("offline, the bucket is not asked and the identifier is left for the cache", async () => {
    navigator.onLine = false;
    try {
      const canonical = publicUrl("images", `${UID}/decks/d--1/one.webp`);
      const url = (await storageUrls.resolveImageUrls([canonical])).get(canonical) || "";
      return !url.includes("/recall-images/") || "it handed out a bucket URL with no connection";
    } finally {
      navigator.onLine = true;
    }
  });

  // ── The move ────────────────────────────────────────────────────────────

  await must("the survey counts both sides from full listings", async () => {
    supabaseImages.clear();
    objects.clear();
    supabaseImages.set(`${UID}/decks/d--1/a.webp`, "AAAA");
    supabaseImages.set(`${UID}/decks/d--1/b.webp`, "BBBBBB");
    supabaseImages.set(`${UID}/books/bk--1/0001-c.png`, "CC");
    objects.set(imageKey(`${UID}/decks/d--1/b.webp`), { body: "BBBBBB", type: "image/webp", cache: "" });
    const survey = await imageStorage.surveyImageStorage();
    if (survey.supabase.count !== 3) return `Supabase ${survey.supabase.count}`;
    if (survey.toCopy.length !== 2) return `to copy ${survey.toCopy.length}`;
    return survey.inBoth.length === 1 || `in both ${survey.inBoth.length}`;
  });

  await must("a transient hiccup while listing images in Supabase is retried, not fatal", async () => {
    failSupabaseListTimes = 1;
    try {
      const survey = await imageStorage.surveyImageStorage();
      return survey.supabase.count === 3 || `Supabase ${survey.supabase.count}`;
    } finally {
      failSupabaseListTimes = 0;
    }
  });

  await must("a transient hiccup while listing images in the bucket is retried, not fatal", async () => {
    failListTimes = 1;
    try {
      const survey = await imageStorage.surveyImageStorage();
      return survey.bucket.count === 1 || `bucket ${survey.bucket.count}`;
    } finally {
      failListTimes = 0;
    }
  });

  // The bug report this guards: one retry (two attempts total, both at
  // CLOUD_TIMEOUT_MS) was not enough for a reader whose listing consistently
  // took longer than that on some page — it failed the same way every time.
  // listStorageObjects now gets three attempts at CLOUD_LIST_TIMEOUT_MS, so
  // two failures in a row — which the old defaults could not survive — must
  // still recover on the third.
  await must("two hiccups in a row while listing images in Supabase still recover on the third attempt", async () => {
    failSupabaseListTimes = 2;
    try {
      const survey = await imageStorage.surveyImageStorage();
      return survey.supabase.count === 3 || `Supabase ${survey.supabase.count}`;
    } finally {
      failSupabaseListTimes = 0;
    }
  });

  await must("...and the same for the bucket side of the same survey", async () => {
    failListTimes = 2;
    try {
      const survey = await imageStorage.surveyImageStorage();
      return survey.bucket.count === 1 || `bucket ${survey.bucket.count}`;
    } finally {
      failListTimes = 0;
    }
  });

  await must("the copy puts each figure in the bucket, checked, and deletes nothing anywhere", async () => {
    const survey = await imageStorage.surveyImageStorage();
    supabaseRemoved.length = 0;
    const result = await imageStorage.copyImagesToS3(survey.toCopy, survey.host);
    if (result.copied !== 2 || result.failed) return `result ${JSON.stringify(result)}`;
    if (supabaseRemoved.length) return "the copy deleted something";
    if (supabaseImages.size !== 3) return "Supabase lost a figure";
    return objects.get(imageKey(`${UID}/books/bk--1/0001-c.png`))?.body === "CC" || "a figure did not arrive whole";
  });

  await must("removing the Supabase copies deletes only what the bucket holds at the same size, and only what was confirmed", async () => {
    // One the reader did not confirm, and one whose bucket copy is wrong.
    supabaseImages.set(`${UID}/unfiled/new.webp`, "NEWNEW");
    objects.set(imageKey(`${UID}/unfiled/new.webp`), { body: "NEWNEW", type: "image/webp", cache: "" });
    objects.set(imageKey(`${UID}/decks/d--1/a.webp`), { body: "AA", type: "image/webp", cache: "" });
    const canonicalA = publicUrl("images", `${UID}/decks/d--1/b.webp`);
    cacheEntries.set(canonicalA, "OFFLINE-B");
    supabaseRemoved.length = 0;
    const confirmed = new Set([`${UID}/decks/d--1/a.webp`, `${UID}/decks/d--1/b.webp`, `${UID}/books/bk--1/0001-c.png`]);
    const result = await imageStorage.removeSupabaseImageCopies(confirmed);
    if (supabaseRemoved.includes(`${UID}/decks/d--1/a.webp`)) return "it deleted a figure whose bucket copy is the wrong size";
    if (supabaseRemoved.includes(`${UID}/unfiled/new.webp`)) return "it deleted a figure the reader never confirmed";
    if (!supabaseRemoved.includes(`${UID}/decks/d--1/b.webp`)) return "it kept a figure that was safely in both";
    if (!cacheEntries.has(canonicalA)) return "it threw away the offline copy of a live figure";
    return result.removed === 2 && result.skipped === 1 || `result ${JSON.stringify(result)}`;
  });

  await must("a bucket listing that fails stops the survey rather than reporting everything as missing", async () => {
    // Every listing answers 500 from here on; this is the last case.
    s3Files.setS3Transport(async (url, init = {}) => ((init.method || "GET") === "GET" && !keyFromUrl(url) ? reply(500) : reply(404)));
    try {
      await imageStorage.surveyImageStorage();
      return "a failed listing was read as an empty bucket";
    } catch (error) {
      return /bucket/i.test(error.message) || `threw ${error.message}`;
    }
  });

  console.warn = realWarn;
  console.log("── s3 images ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  const noted = warnings.length ? ` · ${warnings.length} expected degradation warning(s)` : "";
  console.log(`\n  ${results.length} checks · ${failures} failed${noted}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
