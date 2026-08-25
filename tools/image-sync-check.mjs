// Does a picture that arrived by SYNC actually appear?
//
//   node tools/image-sync-check.mjs
//
// tools/image-render-check.mjs asks whether a rendered image is visible and
// reachable on the device it was added on. This one asks the question that
// device cannot answer, and that no check covered: everywhere else.
//
// The report it exists for. A note holding an uploaded image showed the picture
// on the device it was added on and a dashed "⚠ Image didn't load" placeholder
// on every device it synced to — permanently, until something else happened to
// re-render that surface.
//
// The cause is an ordering, not an image. Both Storage buckets are private, so
// an <img> needs a SIGNED url, and a signature needs a session. bootApp opens
// this device's own decks BEFORE the session is confirmed — deliberately, so a
// lapsed token is not a blank page — and the render tail runs inside that
// window. There, canSignStorageUrls() is false, resolveStorageImages mints
// nothing, the element keeps the canonical `/object/public/…` url a private
// bucket answers 400 to, and markBrokenImages calls it broken. The one forced
// re-sign that was supposed to rescue it (images/broken.js) returns at its own
// canSignStorageUrls() guard, because that is the very thing that is false.
//
// On the device that UPLOADED the picture none of that shows: its bytes are in
// the service worker's image cache under exactly that canonical url
// (cacheUploadedImageOffline), and the worker is cache-first. Which is the whole
// asymmetry — "it works where I made it".
//
// Four things are asserted here, and the third is what keeps the fix honest:
//
//   1. an image rendered while the session is still being confirmed is NOT
//      called broken;
//   2. when the answer lands it resolves itself, with no re-render;
//   3. an image that genuinely cannot be signed IS still called broken — the
//      report was not disabled, only postponed to when it means something;
//   4. warmDeckImageCache posts SIGNED urls to the worker. It posted canonical
//      ones, which the bucket answers 400 to, so pre-caching a pulled deck's
//      images silently did nothing from the day the buckets were locked down —
//      which is why a synced device had no copy to fall back on either.
//
// Plus the two smaller faults found alongside: a storage path that survives a
// round trip through its own url, and an upload that is read back before its
// url is written into a note.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The canonical form, in the real shape. It has to be a *.supabase.co
// `/object/public/` url and not merely an unreachable one: that shape is what
// SUPABASE_IMAGE_URL_PATTERN scans a deck for and what the service worker
// recognises, so a fixture that fakes the host makes the warm case vacuous.
// The host is blocked at the network layer below, so a request for it fails at
// once — the same answer a private bucket's 400 gives, arrived at faster.
const CANONICAL_PREFIX = "https://fixture.supabase.co/storage/v1/object/public/images/";

const CANONICAL_HOST_BLOCK = "*fixture.supabase.co*";

let failures = 0;
function ok(name, detail = "") {
  console.log(`ok   ${name}${detail ? `  [${detail}]` : ""}`);
}
function fail(name, detail) {
  failures += 1;
  console.log(`FAIL ${name}${detail ? `  [${detail}]` : ""}`);
}
function check(condition, name, detail) {
  if (condition) ok(name, detail);
  else fail(name, detail);
}

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"], { stdio: ["ignore", "pipe", "ignore"] });
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

const API_SRC = `async () => {
  const paths = [
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cloud/storage-urls.js?v=__BUILD__",
    "/src/pwa/service-worker-client.js?v=__BUILD__",
    "/src/images/upload.js?v=__BUILD__",
    "/src/images/broken.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/render/block-cache.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// A stand-in Storage that behaves like the real one in the two ways that
// matter: getPublicUrl percent-encodes the whole address (which is why the path
// has to be decoded before it can be signed or deleted), and createSignedUrls
// answers per path, so one object's failure is not the batch's.
//
// `live` is a file the static server really serves, so a signature that works
// produces an <img> that genuinely loads — the assertions read naturalWidth,
// not a class we set ourselves.
const SETUP_SRC = `async (apiSrc, prefix, live) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };
  window.__signing = { allowed: true, rowError: false, calls: 0 };
  window.__warmed = [];
  window.__stored = new Map();
  window.__uploads = [];

  const bucket = {
    getPublicUrl: (p) => ({ data: { publicUrl: prefix + encodeURI(String(p ?? "")) } }),
    createSignedUrls: async (paths) => {
      window.__signing.calls += 1;
      if (!window.__signing.allowed) return { data: null, error: { message: "no session" } };
      return {
        data: paths.map((p) => (window.__signing.rowError
          ? { path: p, signedUrl: null, error: "Object not found" }
          : { path: p, signedUrl: live + "?p=" + encodeURIComponent(p), error: null })),
        error: null
      };
    },
    // The read-back behind assertImageStored. Only what the fixture has put in
    // __stored is there — which is how "the upload returned clean and stored
    // nothing" is expressed.
    list: async (dir, options) => {
      const rows = [];
      for (const [key, size] of window.__stored) {
        const cut = key.lastIndexOf("/");
        if (key.slice(0, cut) !== dir) continue;
        const name = key.slice(cut + 1);
        if (options?.search && !name.startsWith(options.search)) continue;
        rows.push({ id: "obj-" + rows.length, name, metadata: { size } });
      }
      return { data: rows, error: null };
    },
    upload: async (p, blob) => {
      window.__uploads.push(p);
      if (window.__uploadStores !== false) window.__stored.set(p, blob.size);
      return { data: { path: p, Id: "id", Key: "images/" + p }, error: null };
    },
    remove: async () => ({ data: [], error: null })
  };

  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("image-sync-check does not touch the database"); },
    storage: { from: () => bucket }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Sync fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  // The picture, written exactly as an upload writes it: the canonical url,
  // empty alt — except for an alt here so an assertion can name it.
  window.__canonical = api.canonicalStorageUrl(api.IMAGE_BUCKET, "u1/decks/fixture--d1/1787587494767-vdl0ezj.gif");
  window.__note = "# Synced\\n\\n![synced](" + window.__canonical + ")\\n";

  // The state a device is in on the launch this bug lives in: a client, a local
  // library open, and the session question still open. setSignedIn(false) closes
  // that question by design, so it is re-opened after — which is the module's
  // own starting state (signingPending is true from the first line of
  // cloud/supabase-client.js, before any auth call has been made).
  window.__renderUnsigned = async () => {
    api.setSignedIn(false);
    api.setSigningPending(true);
    api.state.notes = window.__note;
    api.renderNotesView();
    await settle(1400);
  };

  window.__answerSession = async (signedIn) => {
    api.setSignedIn(signedIn);
    await settle(1600);
  };

  window.__imageState = () => {
    const img = document.querySelector('#notesView img[alt="synced"]');
    if (!img) return null;
    const shell = img.closest(".diagram-shell");
    return {
      src: img.getAttribute("src") || "",
      canonical: img.getAttribute("data-canonical-src") || "",
      unresolved: img.hasAttribute("data-storage-unresolved"),
      settled: img.dataset.imageSettled === "1",
      loaded: Boolean(img.naturalWidth),
      broken: Boolean(shell && shell.classList.contains("has-broken-image")),
      label: (shell && shell.dataset.brokenLabel) || "",
      // The tooltip names the SOURCE rather than the alt text, so it is what
      // proves the verdict was reached about the right object — the src by then
      // is either a signature or a dead canonical url, and neither is readable.
      title: (shell && shell.getAttribute("title")) || ""
    };
  };

  return { images: document.querySelectorAll("#notesView img").length };
}`;

// warmDeckImageCache reads navigator.serviceWorker.controller, which is null
// here (the app unregisters its worker on localhost, deliberately). The
// property is an accessor on the prototype, so an own property on the instance
// shadows it — and what the function posts is then readable.
const WARM_SRC = `async () => {
  const { api, settle } = window.__recall;
  window.__warmed = [];
  // The case before left signing refusing every object; this one is about what
  // gets ASKED for, so put the bucket back to answering.
  window.__signing.rowError = false;
  api.forgetSignedUrls();
  try {
    Object.defineProperty(navigator.serviceWorker, "controller", {
      value: { postMessage: (message) => window.__warmed.push(message) },
      configurable: true
    });
  } catch (error) {
    return { unavailable: String(error && error.message || error) };
  }
  api.setSignedIn(true);
  await api.warmDeckImageCache({ notes: window.__note, cards: [] });
  await settle(300);
  const message = window.__warmed[0] || null;
  return {
    posted: Boolean(message),
    urls: message ? message.urls : [],
    scanned: api.collectDeckImageUrls({ notes: window.__note, cards: [] })
  };
}`;

// The two smaller faults, asked as questions of the functions themselves.
const UNIT_SRC = `async () => {
  const { api } = window.__recall;
  const out = {};

  // A name holding a space and a non-ASCII character. getPublicUrl encodes the
  // whole address; createSignedUrls, remove() and the names list() returns all
  // deal in the raw one — so a path that does not survive this round trip is an
  // object that can never be signed, never deleted, and reads as unreferenced
  // to the orphan sweep that offers to delete it.
  const raw = "u1/decks/fixture--d1/Über note (final).gif";
  const url = api.canonicalStorageUrl(api.IMAGE_BUCKET, raw);
  out.roundTrip = api.storagePathFromUrl(api.IMAGE_BUCKET, url);
  out.roundTripEncoded = url.includes("%C3%9C");
  out.imagePathRoundTrip = api.supabaseImagePathFromUrl(url);

  // An upload that reports success and stores nothing must not hand back a url.
  const blob = new File([new Uint8Array(64)], "a.gif", { type: "image/gif" });
  window.__uploadStores = false;
  try {
    out.unstoredUrl = await api.uploadImageToSupabase(blob, { folder: "decks/fixture--d1" });
    out.unstoredThrew = false;
  } catch (error) {
    out.unstoredThrew = true;
    out.unstoredFlag = Boolean(error && error.notStored);
  }
  // ...and one that does store must still work.
  window.__uploadStores = true;
  try {
    out.storedUrl = await api.uploadImageToSupabase(blob, { folder: "decks/fixture--d1" });
  } catch (error) {
    out.storedError = String(error && error.message || error);
  }
  return out;
}`;

async function run() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("image-sync-check: no Chrome on this machine — skipping.");
    return 0;
  }

  const server = await serveOn(ROOT);
  let browser = null;
  const errors = [];
  try {
    browser = await launchChrome(chrome);
    const client = await connect(browser.wsUrl);
    const page = await openPage(client);
    await emulatePhone(page, { width: 390, height: 844 });
    await page.call("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net*", CANONICAL_HOST_BLOCK] });
    client.on((message) => {
      if (message.sessionId !== page.sessionId) return;
      if (message.method === "Runtime.exceptionThrown") {
        errors.push(message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text || "unknown");
      }
    });

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await page.goto(`${server.base}/index.html`);
    await page.waitFor(() => !document.documentElement.classList.contains("app-booting"),
      { timeout: 60000, label: "boot" });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
      console.log("image-sync-check: markdown libraries never loaded — skipping.");
      return 0;
    }
    await wait(2000);

    const live = `${server.base}/icons/icon-192.png`;
    const setup = await page.evaluate(
      new Function("apiSrc", "prefix", "live", `return (${SETUP_SRC})(apiSrc, prefix, live);`),
      API_SRC, CANONICAL_PREFIX, live
    );
    if (!setup) {
      console.log("image-sync-check: the fixture never set up — nothing below would mean anything.");
      return 1;
    }

    // ── 1. Rendered before the session was confirmed ────────────────────────
    await page.evaluate(() => window.__renderUnsigned());
    const unsigned = await page.evaluate(() => window.__imageState());
    if (!unsigned) {
      fail("the synced image renders", "no <img> in the notes view");
    } else {
      check(unsigned.src.includes("/object/public/"),
        "with no session, the image is left on its canonical URL", unsigned.src.slice(0, 56));
      check(unsigned.unresolved, "...and is marked as waiting for a signature",
        unsigned.unresolved ? "data-storage-unresolved" : "not marked");
      check(!unsigned.broken,
        "...and is NOT called broken, because nothing has asked the bucket yet",
        unsigned.broken ? `placeholder shown: ${unsigned.label}` : "no placeholder");
      check(!unsigned.settled, "...and is not settled, so its error event reaches no verdict either",
        unsigned.settled ? "settled" : "unsettled");
    }

    // ── 2. The answer arrives, and the picture appears on its own ───────────
    await page.evaluate(() => window.__answerSession(true));
    const healed = await page.evaluate(() => window.__imageState());
    if (!healed) {
      fail("the image survives the session answer", "no <img>");
    } else {
      check(healed.src.includes("/icons/icon-192.png"),
        "once the session lands the image is re-signed with no re-render", healed.src.slice(-40));
      check(healed.loaded, "...and actually loads", healed.loaded ? "naturalWidth > 0" : "still blank");
      check(!healed.broken, "...with no placeholder left behind",
        healed.broken ? `still ${healed.label}` : "clean");
      check(!healed.unresolved, "...and is no longer marked as waiting",
        healed.unresolved ? "still marked" : "cleared");
    }

    // ── 3. A picture that genuinely cannot be signed is still reported ──────
    //
    // Signing is possible and the server declines this object — the shape of a
    // storage path with nothing behind it. Postponing the verdict must not have
    // become withholding it.
    const gone = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      window.__signing.rowError = true;
      api.forgetSignedUrls();
      // A DIFFERENT object, deliberately. Re-rendering the note above would
      // reuse an element that already holds a working signature from the case
      // before, and it would go on loading from it — proving nothing about a
      // picture that was never signed at all.
      const missing = api.canonicalStorageUrl(api.IMAGE_BUCKET, "u1/decks/fixture--d1/never-stored.gif");
      api.state.notes = "# Gone\\n\\n![synced](" + missing + ")\\n";
      api.renderNotesView();
      await settle(1800);
      return window.__imageState();
    });
    if (!gone) {
      fail("an unsignable image still renders an element", "no <img>");
    } else {
      check(gone.broken, "an image the bucket declines to sign is still called broken",
        gone.broken ? `placeholder: ${gone.label}` : "no placeholder");
      check(gone.title.includes("never-stored.gif"), "...and says which picture it was",
        gone.title || "no title");
    }

    // ── 4. Warming a pulled deck asks for something fetchable ───────────────
    const warm = await page.evaluate(new Function(`return (${WARM_SRC})();`));
    if (warm?.unavailable) {
      console.log(`image-sync-check: no serviceWorker container to stub (${warm.unavailable}) — skipping the warm case.`);
    } else {
      check(Boolean(warm?.posted), "a pulled deck's images are handed to the worker",
        warm?.posted ? `${warm.urls.length} url(s)` : "nothing posted");
      check(Boolean(warm?.scanned?.length && warm.scanned.every((u) => u.includes("/object/public/"))),
        "...scanned out of the markdown as canonical URLs",
        warm?.scanned ? `${warm.scanned.length} found` : "none");
      check(Boolean(warm?.urls?.length) && warm.urls.every((u) => !u.includes("/object/public/")),
        "...but posted SIGNED, since a private bucket answers a public URL with 400",
        warm?.urls?.length ? warm.urls[0].slice(0, 56) : "none posted");
    }

    // ── The two smaller faults ──────────────────────────────────────────────
    const unit = await page.evaluate(new Function(`return (${UNIT_SRC})();`));
    check(unit?.roundTripEncoded === true, "a canonical URL percent-encodes the object's name",
      unit?.roundTripEncoded ? "encoded" : "not encoded — the fixture proves nothing");
    check(unit?.roundTrip === "u1/decks/fixture--d1/Über note (final).gif",
      "a storage path survives the round trip through its own URL", JSON.stringify(unit?.roundTrip));
    check(unit?.imagePathRoundTrip === "u1/decks/fixture--d1/Über note (final).gif",
      "...by the images bucket's own resolver too, which delete and the orphan sweep use",
      JSON.stringify(unit?.imagePathRoundTrip));
    check(unit?.unstoredThrew === true && unit?.unstoredFlag === true,
      "an upload that stores nothing does not hand back a URL for the note",
      unit?.unstoredThrew ? "threw with notStored" : `returned ${unit?.unstoredUrl}`);
    check(typeof unit?.storedUrl === "string" && unit.storedUrl.includes("/object/public/"),
      "...and an upload that does store still returns its canonical URL",
      unit?.storedUrl ? unit.storedUrl.slice(-40) : unit?.storedError || "no url");

    check(errors.length === 0, "no uncaught exceptions", errors.length ? errors[0] : "clean");
  } finally {
    if (browser) browser.proc.kill();
    server.proc.kill();
  }

  console.log(failures ? `\n${failures} problem(s)` : "\nall good");
  return failures ? 1 : 0;
}

run().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
