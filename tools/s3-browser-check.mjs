// Does the browser send what we signed?
//
//   node tools/s3-browser-check.mjs
//
// tools/s3-sign-check.mjs proves the signature is the string AWS says it
// should be. tools/s3-store-check.mjs proves the modules call the right verb on
// the right key in the right order. Neither can prove the part in between,
// because both of them replace the thing that actually sends the request —
// and between a correct URL and a served object sit a real fetch, a real
// cross-origin hop, and a browser that is entitled to normalise a path, re-
// encode a query or refuse a preflight.
//
// So this runs a real Chrome against a bucket that VERIFIES the signature it
// is handed: it recomputes SigV4 server-side from the same secret and answers
// 403 SignatureDoesNotMatch on any disagreement. Nothing here is stubbed except
// the storage backend's identity.
//
// ── The claim this exists to keep honest ─────────────────────────────────
//
// src/cloud/s3-sign.js gives up header-form SigV4 — the form every server-side
// SDK uses — on the grounds that a presigned URL signs only `host`, so a GET
// carries no custom headers and is therefore a SIMPLE cross-origin request
// with no preflight at all. That is an argument about browser behaviour, and
// it is the reason the reading path is one round trip rather than two. An
// argument like that belongs in a check, not in a comment: so the bucket logs
// every OPTIONS it is asked for, and this asserts that reads produce none.
//
// ── Why it needs a browser when the others do not ────────────────────────
//
// Node's fetch is not the client under test. It does not preflight, it does not
// apply CORS, and it would pass this check while a browser failed it — which is
// precisely the failure mode the whole signing design was chosen to avoid.

import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CHROME = findChrome();
if (!CHROME) {
  // Not a skip: a check that cannot run has not passed. See tools/browser.mjs.
  console.error("s3-browser-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const BUCKET = "recall-papers";

// ── The bucket ────────────────────────────────────────────────────────────
//
// The signature check is written from the specification with node:crypto, the
// same way tools/s3-sign-check.mjs writes its reference implementation and for
// the same reason: sharing code with the module under test would make an
// agreement between them prove nothing.
function enc(value, slash = true) {
  let out = "";
  for (const b of Buffer.from(String(value), "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else if (c === "/" && !slash) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function expectedSignature(method, pathname, params, host) {
  const scope = params.get("X-Amz-Credential").split("/").slice(1).join("/");
  const [dateStamp, region, service] = scope.split("/");
  const signed = [...params.entries()]
    .filter(([key]) => key !== "X-Amz-Signature")
    .map(([key, value]) => [enc(key), enc(value)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`).join("&");
  const canonical = `${method}\n${enc(decodeURIComponent(pathname), false)}\n${signed}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const sts = `AWS4-HMAC-SHA256\n${params.get("X-Amz-Date")}\n${scope}\n${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  let key = createHmac("sha256", `AWS4${SECRET}`).update(dateStamp).digest();
  key = createHmac("sha256", key).update(region).digest();
  key = createHmac("sha256", key).update(service).digest();
  key = createHmac("sha256", key).update("aws4_request").digest();
  return createHmac("sha256", key).update(sts).digest("hex");
}

// `methods` is what the bucket's CORS policy allows. The default is the policy
// the app hands out; a narrower one is the misconfiguration that used to test
// clean and then fail every upload.
function startBucket(origin, { methods = "GET,PUT,DELETE,HEAD" } = {}) {
  const objects = new Map();
  const seen = [];
  const cors = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "ETag"
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "OPTIONS") {
      seen.push({ method: "OPTIONS", path: url.pathname });
      res.writeHead(204, cors); res.end(); return;
    }
    seen.push({ method: req.method, path: url.pathname });
    const params = url.searchParams;
    if (params.get("X-Amz-Credential")?.split("/")[0] !== KEY_ID) {
      res.writeHead(403, cors); res.end("<Error><Code>InvalidAccessKeyId</Code></Error>"); return;
    }
    if (expectedSignature(req.method, url.pathname, params, req.headers.host) !== params.get("X-Amz-Signature")) {
      seen.push({ method: "MISMATCH", path: `${req.method} ${url.pathname}` });
      res.writeHead(403, cors); res.end("<Error><Code>SignatureDoesNotMatch</Code></Error>"); return;
    }
    const key = decodeURIComponent(url.pathname).replace(new RegExp(`^/${BUCKET}/?`), "");
    if (req.method === "PUT") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { ...cors, ETag: '"x"' }); res.end(); return;
    }
    if (req.method === "DELETE") {
      res.writeHead(objects.delete(key) ? 204 : 404, cors); res.end(); return;
    }
    if (req.method === "HEAD") { res.writeHead(objects.has(key) ? 200 : 404, cors); res.end(); return; }
    if (key) {
      if (!objects.has(key)) { res.writeHead(404, cors); res.end("<Error><Code>NoSuchKey</Code></Error>"); return; }
      res.writeHead(200, { ...cors, "Content-Type": "application/pdf" }); res.end(objects.get(key)); return;
    }
    const rows = [...objects.entries()].map(([name, body]) =>
      `<Contents><Key>${name}</Key><Size>${body.length}</Size><LastModified>2026-09-19T00:00:00.000Z</LastModified></Contents>`).join("");
    res.writeHead(200, { ...cors, "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${rows}</ListBucketResult>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, port: server.address().port, objects, seen })));
}

function serveApp(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
}

const results = [];
let failures = 0;
function must(name, detail) {
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

const app = await serveApp(ROOT);
await new Promise((r) => setTimeout(r, 800));
const bucket = await startBucket(app.base);
const readOnlyBucket = await startBucket(app.base, { methods: "GET,HEAD" });
const browser = await launch({
  headless: "new", executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.evaluateOnNewDocument((endpoint, bucketName, keyId, secret) => {
    localStorage.setItem("flashcards_supabase_config", JSON.stringify({ url: "https://example.supabase.co", key: "anon" }));
    localStorage.setItem("recall:s3Config", JSON.stringify({
      endpoint, bucket: bucketName, region: "auto", accessKeyId: keyId, secretAccessKey: secret
    }));
  }, `http://127.0.0.1:${bucket.port}`, BUCKET, KEY_ID, SECRET);
  await page.setRequestInterception(true);
  page.on("request", (request) => (
    request.url().includes("cdn.jsdelivr.net") || request.url().includes("supabase.co")
      ? request.abort()
      : request.continue()));
  await page.goto(`${app.base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));

  const out = await page.evaluate(async () => {
    const files = await import("./src/cloud/s3-files.js?v=__BUILD__");
    const store = await import("./src/documents/pdf-store.js?v=__BUILD__");
    const steps = {};
    // A name with an apostrophe in it, because that is the character
    // encodeURIComponent leaves alone and AWS does not — it would be signed one
    // way and requested another, and only a real round trip would show it.
    const body = new Blob([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 1, 2, 3])], { type: "application/pdf" });
    const hash = await store.sha256(body);
    steps.locator = await store.uploadDocumentOnce(body, { name: "O'Neill's review", pdfId: "pdf-e2e", sha256: hash });
    const back = await files.downloadS3File(steps.locator.s3Key);
    steps.bytes = back ? [...new Uint8Array(await back.arrayBuffer())] : null;
    steps.head = await files.headS3File(steps.locator.s3Key);
    steps.usage = await files.s3Usage().then((usage) => ({ count: usage.count, bytes: usage.bytes, pdfId: usage.files[0]?.pdfId }));
    steps.test = await files.testS3Connection();
    // The way home, with no s3Key on the record at all.
    const recovered = await store.getDocument("", { id: "pdf-e2e", sha256: hash });
    steps.recovered = recovered ? recovered.size : null;
    steps.deleted = await files.deleteS3File(steps.locator.s3Key);
    steps.goneAfter = await files.headS3File(steps.locator.s3Key);
    return steps;
  });

  const mismatches = bucket.seen.filter((row) => row.method === "MISMATCH");
  must("every request the browser sent verified against a recomputed signature",
    mismatches.length === 0 || `${mismatches.length}: ${mismatches.map((m) => m.path).join(", ")}`);

  must("the app booted with no page error",
    pageErrors.length === 0 || pageErrors.join(" · "));

  must("an upload lands under the content-addressed key",
    /^recall\/pdf-e2e\/[a-f0-9]{64}\.pdf$/.test(out.locator?.s3Key || "") || `key was ${out.locator?.s3Key}`);

  must("the bytes come back byte for byte",
    String(out.bytes) === String([37, 80, 68, 70, 45, 49, 46, 52, 10, 1, 2, 3]) || `got ${out.bytes}`);

  must("a HEAD finds it", out.head === true || "HEAD said no");

  must("the listing parses, totals and reads the pdf id back off the key",
    (out.usage?.count === 1 && out.usage?.bytes === 12 && out.usage?.pdfId === "pdf-e2e")
      || JSON.stringify(out.usage));

  must("the connection test passes against a bucket that is actually working",
    out.test?.ok === true || out.test?.reason);

  must("a record that lost its s3Key still resolves, over the real network",
    out.recovered === 12 || `got ${out.recovered}`);

  must("a delete frees it", (out.deleted === true && out.goneAfter === false)
    || `deleted=${out.deleted} stillThere=${out.goneAfter}`);

  // ── The claim s3-sign.js rests on ───────────────────────────────────────
  // Which verbs the browser asked permission for first. An OPTIONS is always
  // immediately followed by the request it was asked about, so the pairing is
  // positional rather than inferred.
  const preflighted = new Set();
  bucket.seen.forEach((row, index) => {
    if (row.method === "OPTIONS" && bucket.seen[index + 1]) preflighted.add(bucket.seen[index + 1].method);
  });

  must("reads do not preflight — the whole reason the signature is in the URL",
    (!preflighted.has("GET") && !preflighted.has("HEAD"))
      || `a read was preflighted: ${[...preflighted].join(", ")}`);

  must("...and writes do, which is what the bucket's CORS policy is for",
    (preflighted.has("PUT") && preflighted.has("DELETE"))
      || `only ${[...preflighted].join(", ")} preflighted`);

  // ── Two devices, one account, end to end ────────────────────────────────
  //
  // The report this all answers: "it says connected, but the pdfs are not
  // syncing multi device". Driven here against the real signing bucket:
  //
  //   device A  a paper imported while no upload could happen, keys that were
  //             pasted before key sync existed
  //   the sync  uploads the paper from A, and publishes A's keys to the account
  //   device B  no keys, no copy of the file — only the deck record and the
  //             account — opens the paper anyway
  //
  // B is the same page with A's keys and bytes wiped, which is all a second
  // device is as far as these modules can tell. The account is a stand-in
  // Supabase client holding one row.
  const twoDevices = await page.evaluate(async () => {
    const deckStore = await import("./src/storage/deck-store.js?v=__BUILD__");
    const store = await import("./src/documents/pdf-store.js?v=__BUILD__");
    const migration = await import("./src/storage/document-migration.js?v=__BUILD__");
    const keySync = await import("./src/cloud/s3-config-sync.js?v=__BUILD__");
    const clientMod = await import("./src/cloud/supabase-client.js?v=__BUILD__");
    const USER = "e2e-user";
    let row = null;
    const account = {
      from() {
        const query = { op: "select", payload: null };
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          upsert(payload) { query.op = "upsert"; query.payload = payload; return builder; },
          abortSignal() { return builder; },
          then(resolve, reject) {
            return Promise.resolve().then(() => {
              if (query.op === "upsert") {
                row = { s3_config: query.payload.s3_config, updated_at: query.payload.updated_at };
                return { data: null, error: null };
              }
              return { data: row ? [row] : [], error: null };
            }).then(resolve, reject);
          }
        };
        return builder;
      },
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: USER }, access_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600 } },
          error: null
        })
      }
    };
    const appClient = clientMod.supabaseClient;
    clientMod.setSupabaseClient(account);
    try {
      // ── Device A ──
      const body = new Blob([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 7, 7, 7])], { type: "application/pdf" });
      const hash = await store.sha256(body);
      const record = { name: "e2e.pdf", size: 12, pages: 1, sha256: hash, path: null };
      deckStore.writeDeckSnapshot("e2e-deck", { id: "e2e-deck", title: "E2E", cards: [], meta: { pdf: record } });
      await store.putDocument({ deckLocalId: "e2e-deck", blob: body, sha256: hash, name: "e2e.pdf", at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const keys = await keySync.syncS3ConfigWithCloud(USER);
      const summary = await migration.scheduleDocumentBackfill({ force: true });
      const recorded = (await deckStore.readDeckSnapshot("e2e-deck"))?.meta?.pdf?.s3Key || "";

      // ── Device B ──
      localStorage.removeItem("recall:s3Config");
      await store.deleteLocalDocument("e2e-deck");
      const hadKeys = Boolean(localStorage.getItem("recall:s3Config"));
      // The record as B's sync might have left it: no s3Key at all.
      const opened = await store.getDocument("e2e-deck", record);
      return {
        keys: keys.status,
        published: Boolean(row?.s3_config?.secretAccessKey),
        uploaded: summary?.uploaded || 0,
        recorded,
        hash,
        hadKeys,
        openedBytes: opened ? [...new Uint8Array(await opened.arrayBuffer())] : null,
        keysAfter: Boolean(localStorage.getItem("recall:s3Config"))
      };
    } finally {
      clientMod.setSupabaseClient(appClient);
    }
  });

  must("device A publishes keys it had before key sync, after testing them against the bucket",
    (twoDevices.keys === "synced" && twoDevices.published) || JSON.stringify(twoDevices));

  must("...and uploads the paper it imported while no upload could happen",
    (twoDevices.uploaded === 1 && twoDevices.recorded === `recall/primary/${twoDevices.hash}.pdf`)
      || `uploaded ${twoDevices.uploaded}, recorded ${twoDevices.recorded}`);

  must("device B, with no keys and no copy, opens the paper from the account's keys",
    (!twoDevices.hadKeys && twoDevices.keysAfter
      && String(twoDevices.openedBytes) === String([37, 80, 68, 70, 45, 49, 46, 55, 10, 7, 7, 7]))
      || JSON.stringify(twoDevices));

  // ── A figure, through the real browser ──────────────────────────────────
  //
  // Images follow the papers into the bucket (src/cloud/s3-images.js). Two
  // things a stubbed transport cannot see: that a PUT carrying Cache-Control
  // as well as Content-Type still passes the preflight and the signature, and
  // that the GET URL — deliberately dated to the start of the UTC day so a
  // figure keeps one src all day — is one the bucket accepts. And a HEAD has
  // to be signed as a HEAD, or the broken-image scan calls every figure gone.
  const figure = await page.evaluate(async () => {
    const images = await import("./src/cloud/s3-images.js?v=__BUILD__");
    // Not a *.supabase.co host: this page aborts every request whose URL
    // mentions supabase.co (see the interception above), and a figure's key
    // carries its identifier's host.
    const host = "fixture-project.test";
    const path = "user-1/decks/a deck--ld_1/0001 fig.webp";
    const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 69, 66, 80]);
    try {
      await images.uploadS3Image(host, path, new Blob([bytes], { type: "image/webp" }), { contentType: "image/webp" });
    } catch (error) {
      return { uploadError: String(error?.message || error), key: images.s3ImageKey(host, path), config: Boolean(localStorage.getItem("recall:s3Config")) };
    }
    const getUrl = await images.s3ImageUrl(host, path);
    const got = await fetch(getUrl);
    const headUrl = await images.s3ImageUrl(host, path, { method: "HEAD" });
    const head = await fetch(headUrl, { method: "HEAD" });
    const headWithGetSignature = await fetch(getUrl, { method: "HEAD" });
    return {
      getStatus: got.status,
      bytes: got.ok ? [...new Uint8Array(await got.arrayBuffer())] : null,
      headStatus: head.status,
      mismatchedHead: headWithGetSignature.status,
      dated: new URL(getUrl).searchParams.get("X-Amz-Date") || "",
      key: images.s3ImageKey(host, path)
    };
  });

  must("a figure PUT with Content-Type and Cache-Control passes the preflight and the signature",
    Boolean(bucket.objects.get(figure.key))
      || `nothing stored at ${figure.key}: ${JSON.stringify(figure)} · bucket saw ${JSON.stringify(bucket.seen.slice(-6))}`);

  must("...and its day-dated GET URL is accepted, bytes intact",
    (figure.getStatus === 200 && String(figure.bytes) === String([82, 73, 70, 70, 1, 2, 3, 4, 87, 69, 66, 80])
      && /T000000Z$/.test(figure.dated)) || JSON.stringify(figure));

  must("...and a HEAD signed as a HEAD is answered, where a GET signature is refused",
    (figure.headStatus === 200 && figure.mismatchedHead === 403) || JSON.stringify(figure));

  // ── A CORS policy that allows reading and nothing else ──────────────────
  //
  // The LIST the connection test used to stop at is a simple request — no
  // preflight — so it sailed through a policy like this one, the panel said
  // "Bucket connected", and every upload after that was refused by the browser
  // before it was sent. The test has to try a real PUT to see it.
  const narrow = await page.evaluate(async (endpoint) => {
    const stored = JSON.parse(localStorage.getItem("recall:s3Config"));
    localStorage.setItem("recall:s3Config", JSON.stringify({ ...stored, endpoint }));
    try {
      const files = await import("./src/cloud/s3-files.js?v=__BUILD__");
      const listing = await files.s3Fetch("GET", "", { query: { "list-type": "2", "max-keys": "1" } });
      return { listed: listing.ok, test: await files.testS3Connection() };
    } finally {
      localStorage.setItem("recall:s3Config", JSON.stringify(stored));
    }
  }, `http://127.0.0.1:${readOnlyBucket.port}`);

  must("a bucket whose CORS policy allows only reads still LISTS — which is why a list proved nothing",
    narrow.listed === true || "the list was refused, so this case tests nothing");

  must("...and the connection test now FAILS it, naming PUT, instead of saying connected",
    (narrow.test?.ok === false && /PUT/.test(narrow.test?.reason || ""))
      || `test said ${JSON.stringify(narrow.test)}`);

  const optionsCount = bucket.seen.filter((row) => row.method === "OPTIONS").length;
  const readCount = bucket.seen.filter((row) => row.method === "GET" || row.method === "HEAD").length;
  must(`${readCount} reads cost ${optionsCount} preflights in total`,
    optionsCount < readCount || `${optionsCount} preflights for ${readCount} reads`);
} finally {
  await browser.close().catch(() => {});
  app.proc.kill();
  bucket.server.close();
  readOnlyBucket.server.close();
}

console.log("── s3 in a browser ──");
for (const [ok, name, detail] of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
}
console.log(`\n  ${results.length} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
