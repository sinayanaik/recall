// The same note open in two windows: nothing either one types may be lost.
//
//   node tools/multi-window-sync-check.mjs
//
// The reported failure: with one note open in two windows (or two tabs) of the
// app, edits made in one were discarded — when the other saved, when it was
// hidden, or when a sync ran. Every save used to write the whole deck from that
// window's memory over whatever was on disk, and a window's memory was never
// refreshed from the other's writes.
//
// This drives two REAL pages of the app, on one origin, in one browser — so
// they share IndexedDB, localStorage, the BroadcastChannel and Web Locks exactly
// as two windows of the installed app do — and asserts on the disk copy and on
// each window's on-screen state after each step:
//
//   • a change in one window reaches the other without anything else happening
//   • edits to different paragraphs in both windows both survive
//   • a card added in one window is not deleted by the other's save
//   • two edits in ONE paragraph, typed in both windows at once, both survive
//   • an armed autosave can no longer write a stale copy over a newer one that
//     a sync just put on disk (the "old copy synced as the latest" report)
//   • a window hidden a moment after the other saved (writing from a cache one
//     save behind) loses neither window's edit
//
// Needs Chrome (see tools/cdp.mjs); a machine without one fails rather than
// skipping, since a check that skips has verified nothing.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, findChrome, launchChrome, openPage } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
}

const API_SRC = `async () => {
  const paths = [
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// Boots a window into the app with a stand-in for Supabase that is never
// reached (signed in, so the app runs as it does for a real user; offline to
// the cloud, so nothing here depends on a network).
const BOOT_SRC = `async (apiSrc) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__mw = { api, settle };
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("multi-window-sync-check does not touch the network"); },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() {},
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(700);
  return true;
}`;

const chrome = findChrome();
if (!chrome) {
  console.error("multi-window-sync-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome, [], { windowSize: "1280,900" });
const client = await connect(launched.wsUrl);

let failures = 0;
let ran = 0;
function check(name, ok, detail = "") {
  ran += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the disk holds for the deck, read fresh in the page.
const DISK = `async (id) => {
  const { api } = window.__mw;
  const s = await api.readDeckSnapshotFresh(id);
  return s ? { notes: s.notes, cards: s.cards.map((c) => c.id + ":" + c.question + "/" + c.answer), tombstones: Object.keys(s.deletedCardIds || {}) } : null;
}`;
const SCREEN = `() => {
  const { api } = window.__mw;
  return { notes: api.state.notes, cards: api.state.masterCards.map((c) => c.id + ":" + c.question + "/" + c.answer), localId: api.state.localDeckId };
}`;
// An edit as the app makes one: change state, arm the autosave.
const EDIT_NOTES = `(from, to) => {
  const { api } = window.__mw;
  if (!api.state.notes.includes(from)) return "missing: " + from;
  api.state.notes = api.state.notes.replace(from, to);
  api.scheduleDeckAutosave();
  return true;
}`;

try {
  const pageA = await openPage(client);
  await pageA.goto(`${server.base}/index.html`);
  await sleep(1200);
  await pageA.evaluate(BOOT_SRC, API_SRC);

  // One deck, saved in window A.
  const localId = await pageA.evaluate(`async () => {
    const { api, settle } = window.__mw;
    api.createNewDeck({ title: "Two windows", notesMode: true });
    await settle(300);
    api.state.notes = "Paragraph one.\\n\\nParagraph two has a few words in it.\\n\\nParagraph three.";
    api.state.masterCards.push({ id: "card-a", question: "Question A", answer: "Answer A" });
    api.state.cards = api.state.masterCards.slice();
    await api.saveDeckToLibrary({ silent: true });
    await settle(300);
    return api.state.localDeckId;
  }`);
  check("window A saved the deck", Boolean(localId));

  const pageB = await openPage(client);
  await pageB.goto(`${server.base}/index.html`);
  await sleep(1200);
  await pageB.evaluate(BOOT_SRC, API_SRC);
  const opened = await pageB.evaluate(`async (id) => {
    const { api, settle } = window.__mw;
    const ok = await api.loadDeckFromLibrary(id);
    await settle(300);
    return ok;
  }`, localId);
  check("window B opened the same deck", opened === true);

  // ── 1. A change in one window reaches the other ──────────────────────────
  check("A edits paragraph one", (await pageA.evaluate(EDIT_NOTES, "Paragraph one.", "Paragraph one, edited in A.")) === true);
  await sleep(1500);
  const bScreen1 = await pageB.evaluate(SCREEN);
  check("...and window B shows it without doing anything", bScreen1.notes.includes("edited in A"), JSON.stringify(bScreen1.notes));

  // ── 2. Different paragraphs in both windows ──────────────────────────────
  await pageB.evaluate(EDIT_NOTES, "Paragraph three.", "Paragraph three, edited in B.");
  await pageA.evaluate(EDIT_NOTES, "Paragraph one, edited in A.", "Paragraph one, edited in A twice.");
  await sleep(2000);
  const disk2 = await pageA.evaluate(DISK, localId);
  check("both windows' edits are on disk",
    disk2.notes.includes("edited in A twice") && disk2.notes.includes("edited in B"), JSON.stringify(disk2.notes));
  const [aScreen2, bScreen2] = [await pageA.evaluate(SCREEN), await pageB.evaluate(SCREEN)];
  check("...and on both screens",
    aScreen2.notes === disk2.notes && bScreen2.notes === disk2.notes,
    JSON.stringify({ a: aScreen2.notes, b: bScreen2.notes }));

  // ── 3. A card added in one window survives the other's save ──────────────
  await pageB.evaluate(`() => {
    const { api } = window.__mw;
    api.state.masterCards.push({ id: "card-b", question: "Question B", answer: "Answer B" });
    api.state.cards = api.state.masterCards.slice();
    api.scheduleDeckAutosave();
  }`);
  // A saves something unrelated straight after, from its own memory.
  await pageA.evaluate(EDIT_NOTES, "Paragraph three, edited in B.", "Paragraph three, edited in B, then A.");
  await sleep(2000);
  const disk3 = await pageA.evaluate(DISK, localId);
  check("the card added in B is still there after A's save",
    disk3.cards.some((c) => c.startsWith("card-b:")), JSON.stringify(disk3.cards));
  check("...and was not recorded as deleted", !disk3.tombstones.includes("card-b"), JSON.stringify(disk3.tombstones));
  check("...and A's edit landed as well", disk3.notes.includes("edited in B, then A"), JSON.stringify(disk3.notes));

  // ── 4. The same paragraph, typed in both windows at once ─────────────────
  // Neither window has seen the other's edit when it saves: both edits are made
  // against the same paragraph before either autosave fires.
  await Promise.all([
    pageA.evaluate(EDIT_NOTES, "has a few words", "has a FEW words"),
    pageB.evaluate(EDIT_NOTES, "words in it.", "words in it, and more from B.")
  ]);
  await sleep(2500);
  const disk4 = await pageA.evaluate(DISK, localId);
  check("two edits to one paragraph, made at the same moment, are both kept",
    disk4.notes.includes("has a FEW words") && disk4.notes.includes("and more from B"), JSON.stringify(disk4.notes));

  // ── 5. A stale autosave cannot overwrite a newer copy on disk ────────────
  // The "old copy synced as the latest" report: window B has an autosave armed
  // (a scroll arms the lazy one) when a sync writes a newer copy of the deck.
  const disk5 = await pageB.evaluate(`async (id) => {
    const { api, settle } = window.__mw;
    api.scheduleDeckAutosave({ lazy: true });
    const fresh = await api.readDeckSnapshotFresh(id);
    fresh.notes = fresh.notes.replace("Paragraph one", "Paragraph ONE (from another device, via sync)");
    api.writeDeckSnapshot(id, fresh);
    await settle(1500);
    const disk = await api.readDeckSnapshotFresh(id);
    return { disk: disk.notes, screen: api.state.notes };
  }`, localId);
  check("a sync's newer copy stays on disk with an autosave armed",
    disk5.disk.includes("from another device, via sync"), JSON.stringify(disk5.disk));
  check("...and is what the window shows", disk5.screen === disk5.disk, JSON.stringify(disk5));

  // ── 6. Hiding a window flushes through the merge too ─────────────────────
  await pageA.evaluate(EDIT_NOTES, "Paragraph three", "Paragraph THREE");
  await sleep(1200);
  await pageB.evaluate(`async () => {
    const { api } = window.__mw;
    api.saveDeckToLibrarySync({ silent: true });
  }`);
  await sleep(800);
  const disk6 = await pageA.evaluate(DISK, localId);
  check("a window's hide-time flush does not undo the other window's edit",
    disk6.notes.includes("Paragraph THREE") && disk6.notes.includes("via sync"), JSON.stringify(disk6.notes));

  // ── 7. A window hidden before it heard about the other's save ────────────
  //
  // The narrowest race there is: window A saves, and window B is hidden (its
  // emergency flush runs) in the moment before A's change notice reaches it — so
  // B writes from a cached copy that is already one save behind. Simulated by
  // handing B's cache the older copy on purpose. A's save must survive B's
  // flush, and B's own edit must survive too.
  const before7 = await pageB.evaluate(`async (id) => {
    const { api } = window.__mw;
    return api.deckSnapshotCache.get(String(id));
  }`, localId);
  await pageA.evaluate(EDIT_NOTES, "Paragraph THREE", "Paragraph THREE, saved in A just before B hid");
  await sleep(700);
  await pageB.evaluate(`async (id, stale) => {
    const { api } = window.__mw;
    api.deckSnapshotCache.set(String(id), stale);          // B has not heard yet
    api.state.notes = api.state.notes.replace("Paragraph two", "Paragraph TWO (typed in B as it hid)");
    api.saveDeckToLibrarySync({ silent: true });          // the hide-time flush
  }`, localId, before7);
  await sleep(2500);
  const disk7 = await pageA.evaluate(DISK, localId);
  check("A's save survives B's flush from a stale cache",
    disk7.notes.includes("saved in A just before B hid"), JSON.stringify(disk7.notes));
  check("...and B's last edit survives too",
    disk7.notes.includes("typed in B as it hid"), JSON.stringify(disk7.notes));
  const [aScreen7, bScreen7] = [await pageA.evaluate(SCREEN), await pageB.evaluate(SCREEN)];
  check("...and both windows end up showing the same text",
    aScreen7.notes === disk7.notes && bScreen7.notes === disk7.notes, JSON.stringify({ a: aScreen7.notes, b: bScreen7.notes }));

} catch (error) {
  failures += 1;
  console.log(`  FAIL  the check itself failed: ${error.message}`);
} finally {
  client.close();
  await launched.close();
  server.proc.kill();
}

console.log(`\nCHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
