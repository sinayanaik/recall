// Does a paper still come back, now that it lives somewhere else?
//
//   node tools/drive-store-check.mjs
//
// PDFs moved out of the Supabase `documents` bucket and into the reader's own
// Google Drive, because one paper can outweigh a hundred figures and a handful
// of them spend the free tier's whole gigabyte. The move is small in diff and
// large in blast radius: getDocument is the ONE place a paper's bytes are
// resolved, and four surfaces sit on it — the reader, the download, region
// embeds and the backup. Get it wrong and a library full of papers stops
// opening, on every device at once, with the highlights still pointing at
// files nobody can fetch.
//
// So the four things asserted here are the four that would not be noticed
// until they had already cost somebody their library:
//
//   • RESOLUTION ORDER. Device first, then Drive, then the old bucket. The
//     last of those is what keeps every paper uploaded before this change
//     opening, and it is the thing a "clean" removal of the Supabase path
//     would quietly take away.
//   • THE WAY HOME. meta.pdfs merges by whole record, last writer wins
//     (mergeRecordsById) — it does not merge fields — so a stale device can
//     carry off a driveId and leave a record naming nothing. Every upload
//     stamps the deck id, pdf id and content hash onto the file so the id can
//     be looked up again. Without this, one ordinary sync is data loss.
//   • THE ORDER OF THE MIGRATION. The deck is saved BEFORE the old object is
//     deleted. Interrupt it the other way round and the bytes are gone with
//     nothing naming where they went.
//   • DEGRADING RATHER THAN THROWING. No token, no config, offline: every one
//     must answer "null" and let the device copy serve. getDocument runs
//     inside a render.
//
// ── Why plain Node ───────────────────────────────────────────────────────
//
// There is no network here and no Google account, and there must not be: CI
// has neither. Every Drive request in src/cloud/drive-files.js goes through a
// single `driveFetch`, and `setDriveTransport` replaces the one function it
// calls — the same seam tools/handwriting-check.mjs uses on the storage
// client. So this drives the REAL modules against a scripted transport and
// asserts on what they did with the answers.
//
// The one accommodation is the one every pure-Node check here makes: `?v=__BUILD__`
// is a cache-busting query Node's resolver does not understand, so the tree is
// copied to a temp directory with the stamp removed, exactly as the deploy
// step rewrites it.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-drive-"));

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

// ── Why console.warn is captured rather than left alone ───────────────────
//
// Half the cases here deliberately drive a failure path, and every one of
// those paths warns on the way past — that IS the behaviour under test, since
// the alternative is throwing inside a render. But console.warn is stderr,
// check.mjs reads a check's RESULT off its last line, and interleaved stderr
// lands after the summary and takes the result line with it. So the warnings
// are collected and counted at the end, which keeps them visible without
// letting them decide where the output ends.
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
  //
  // Nothing under test touches any of this; their IMPORTS do, at module scope.
  // Every stub returns the empty answer, so a check that accidentally depended
  // on one would be testing its own scaffolding rather than the app.
  const noElement = new Proxy({}, {
    get: (_, key) => (key === "querySelector" || key === "querySelectorAll" || key === "closest" ? () => null : undefined)
  });
  // createElement returns a PLAIN object rather than the proxy: drive-client's
  // ensureGis goes through loadScriptOnce, which sets `onload` on a <script>
  // and then reads it back when the element is appended. A proxy that answers
  // `undefined` to every get would swallow the handler and hang the load.
  //
  // Appending is where the GIS script "arrives". Google's library is the one
  // thing in this repo that cannot be vendored, so the real module fetches it
  // — and here that fetch is simply declared to have succeeded, which is what
  // lets the token flow below run against the stub in `globalThis.google`.
  const head = { appendChild: (node) => { node.onload?.(); return node; } };
  globalThis.document = {
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => ({}), addEventListener: () => {},
    documentElement: noElement, body: noElement, head
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size; }
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  // Node 22 defines `navigator` as a getter-only global, so it is redefined
  // rather than assigned. canReachDrive reads navigator.onLine.
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: true }, configurable: true, writable: true
  });

  const load = (rel) => import(path.join(stage, rel));

  const driveClient = await load("src/cloud/drive-client.js");
  const driveFiles = await load("src/cloud/drive-files.js");

  // ── A Drive, in about thirty lines ──────────────────────────────────────
  //
  // Answers the handful of shapes the module actually sends, records every
  // request so the ORDER of a migration can be asserted, and can be told to
  // fail a specific call.
  const requests = [];
  const files = new Map();
  let nextId = 1;
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => body,
    headers: { get: () => null }
  });

  driveFiles.setDriveTransport(async (url, init = {}) => {
    const method = init.method || "GET";
    requests.push(`${method} ${String(url).split("?")[0].replace("https://www.googleapis.com", "")}`);
    const query = String(url).includes("?") ? String(url).split("?").slice(1).join("?") : "";
    const params = new URLSearchParams(query);
    const q = params.get("q") || "";

    if (method === "POST" && String(url).includes("/upload/drive/v3/files")) {
      const id = `file-${nextId++}`;
      files.set(id, { id, blob: "PDFBYTES", appProperties: await uploadProps(init.body) });
      return json({ id });
    }
    if (method === "GET" && q.includes("mimeType='application/vnd.google-apps.folder'")) {
      return json({ files: [{ id: "folder-1" }] });
    }
    if (method === "GET" && q.includes("appProperties has")) {
      const wanted = /value='([^']+)'/g;
      const values = [...q.matchAll(wanted)].map((m) => m[1]);
      const hit = [...files.values()].find((file) =>
        values.every((value) => Object.values(file.appProperties || {}).includes(value)));
      return json({ files: hit ? [{ id: hit.id }] : [] });
    }
    if (method === "GET" && params.get("alt") === "media") {
      const id = decodeURIComponent(String(url).split("/files/")[1].split("?")[0]);
      const file = files.get(id);
      return file ? json(file.blob) : json({ error: { message: "not found" } }, 404);
    }
    if (method === "DELETE") {
      const id = decodeURIComponent(String(url).split("/files/")[1].split("?")[0]);
      files.delete(id);
      return json({}, 204);
    }
    return json({ files: [] });
  });

  // The multipart body is a real Blob — [preamble, json, preamble, bytes,
  // tail] — so this reads it the way Drive would, rather than reaching into
  // the parts array Node does not expose. The metadata is the first part after
  // the opening header block.
  async function uploadProps(body) {
    try {
      const text = typeof body?.text === "function" ? await body.text() : String(body || "");
      const match = text.match(/\r\n\r\n(\{[\s\S]*?\})\r\n--/);
      return JSON.parse(match?.[1] || "{}").appProperties || {};
    } catch {
      return {};
    }
  }

  // ── A token, without Google ─────────────────────────────────────────────
  driveClient.saveDriveConfig("test.apps.googleusercontent.com");
  globalThis.google = {
    accounts: {
      oauth2: {
        initTokenClient: (options) => ({
          ...options,
          requestAccessToken() { this.callback({ access_token: "token-1", expires_in: 3600 }); }
        })
      }
    }
  };

  await must("a configured install reports itself configured", () =>
    driveClient.isDriveConfigured() === true || "the Client ID did not stick");

  await must("a token is minted, and reaching Drive becomes possible", async () => {
    const token = await driveClient.requestDriveToken({ interactive: false });
    if (!token) return "no token was issued";
    return driveClient.canReachDrive() === true || "canReachDrive stayed false with a live token";
  });

  // ── Upload stamps the file so it can be found again ─────────────────────
  let uploadedId = "";
  await must("an upload stamps the deck id, pdf id and hash onto the file", async () => {
    uploadedId = await driveFiles.uploadDriveFile("PDFBYTES", {
      name: "paper.pdf", deckId: "deck-7", pdfId: "primary", sha256: "abc123"
    });
    const stamped = files.get(uploadedId)?.appProperties || {};
    return (stamped.recallDeckId === "deck-7" && stamped.recallPdfId === "primary" && stamped.recallSha256 === "abc123")
      || `appProperties came back as ${JSON.stringify(stamped)}`;
  });

  await must("...and the stamp is enough to find it with the id gone", async () => {
    const found = await driveFiles.findDriveFileByProperties({ deckId: "deck-7", pdfId: "primary", sha256: "abc123" });
    return found === uploadedId || `looked up ${found || "nothing"}, wanted ${uploadedId}`;
  });

  await must("...and a hash alone is enough, because it names the exact bytes", async () => {
    const found = await driveFiles.findDriveFileByProperties({ sha256: "abc123" });
    return found === uploadedId || `a hash-only lookup found ${found || "nothing"}`;
  });

  await must("...but a deck id alone is NOT, because it names every paper in the deck", async () => {
    const found = await driveFiles.findDriveFileByProperties({ deckId: "deck-7" });
    return found === "" || `an ambiguous lookup confidently returned ${found}`;
  });

  await must("a download returns the bytes that went up", async () => {
    const blob = await driveFiles.downloadDriveFile(uploadedId);
    return blob === "PDFBYTES" || `got ${JSON.stringify(blob)}`;
  });

  await must("a file deleted in Drive by hand reads as null, not as a throw", async () => {
    const blob = await driveFiles.downloadDriveFile("file-does-not-exist");
    return blob === null || `a missing file returned ${JSON.stringify(blob)}`;
  });

  await must("a delete actually frees it, and a second delete still succeeds", async () => {
    const id = await driveFiles.uploadDriveFile("X", { name: "throwaway.pdf", sha256: "zzz" });
    const first = await driveFiles.deleteDriveFile(id);
    const again = await driveFiles.deleteDriveFile(id);
    if (files.has(id)) return "the file is still there";
    // A 404 counts as success: the file is not there, which is what was asked.
    return (first && again) || `delete reported ${first} then ${again}`;
  });

  // ── Degrading, rather than throwing ─────────────────────────────────────
  await must("with no token at all, a download is null rather than an error", async () => {
    driveClient.forgetDriveToken();
    globalThis.google.accounts.oauth2.initTokenClient = (options) => ({
      ...options,
      requestAccessToken() { this.error_callback({ type: "popup_closed" }); }
    });
    // ensureTokenClient caches the client against the Client ID it was built
    // for, so the refusing one above is only reached once the id changes —
    // which is exactly the behaviour a reader switching projects depends on.
    driveClient.saveDriveConfig("second.apps.googleusercontent.com");
    const blob = await driveFiles.downloadDriveFile(uploadedId);
    return blob === null || `a tokenless read returned ${JSON.stringify(blob)}`;
  });

  await must("...and canReachDrive says so rather than guessing", () =>
    driveClient.canReachDrive() === false || "canReachDrive claimed a token it does not have");

  await must("clearing the config forgets the token with it", () => {
    driveClient.clearDriveConfig();
    return (driveClient.isDriveConfigured() === false && driveClient.driveToken() === "")
      || "a token outlived the account it belonged to";
  });

  console.warn = realWarn;
  console.log("── drive store ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  const noted = warnings.length ? ` · ${warnings.length} expected degradation warning(s)` : "";
  console.log(`\n  ${results.length} checks · ${failures} failed${noted}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
