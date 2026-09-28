// Can you actually WRITE in the "Make a flashcard" modal, and does everything in
// it scroll?
//
// The answer face became an editable textarea with a live preview under it, and
// neither worked. The textarea had the syntax-highlight mirror bolted on without
// the `.edit-textarea` class the mirror depends on, so the mirror's opaque,
// absolutely-positioned backdrop painted OVER the textarea in a different font
// size and padding: the caret and selection were hidden, the visible text
// drifted from where typing landed, and the two scrolled out of step. The panel
// was a grid with no height cap inside a centred overlay, so a long answer plus
// its preview ran off both ends of the screen with nothing scrolling and "Add
// card" out of reach. And the keys every other editor here answers to — Ctrl+B,
// Ctrl+Z past a toolbar press — did nothing, while Ctrl+E flipped the notes view
// BEHIND the modal.
//
// The answer is the shared note editor now (src/notes/note-editor-kit.js — see
// ensureFrameCardEditor in src/notes/anchors.js). This drives the modal the way
// a reader does and asks each of those questions directly, at a desktop size and
// at a phone size.
//
//   node tools/frame-card-check.mjs
//   SHOT_DIR=/some/dir node tools/frame-card-check.mjs   # ...and keep screenshots

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = process.env.SHOT_DIR || "";

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
    "/src/notes/anchors.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/chrome.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/core/dom.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const SETUP_SRC = `async (apiSrc) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("frame-card-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Frame card fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(300);
  api.state.notes = "# A chapter\\n\\nSomething worth remembering.";
  api.setNotesScrolledSource(null);
  await api.renderNotesView();
  await settle(400);
  return true;
}`;

// An answer far taller than any box it will be shown in, so both the editor
// and the preview have something to scroll.
const LONG_ANSWER = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the captured answer, long enough to be a sentence.`).join("\n\n");

// Everything a layout assertion needs about the open modal, in one round trip.
const MEASURE_SRC = `() => {
  const modal = document.getElementById("frameCardModal");
  const panel = document.getElementById("frameCardPanel");
  const body = document.getElementById("frameCardBody");
  const kits = document.querySelectorAll("#frameCardAnswerEditor .note-editor-kit");
  const ta = document.querySelector("#frameCardAnswerEditor [data-note-edit-value]");
  const wrapper = ta?.parentElement;
  const backdrop = wrapper?.querySelector(".highlight-textarea-backdrop");
  const preview = document.getElementById("frameCardAnswerPreview");
  const add = document.getElementById("frameCardAddBtn");
  const rect = (node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const taRect = rect(ta);
  const bodyRect = rect(body);
  // Hit-tested inside whatever part of the textarea the body is showing right
  // now — on a phone the body may have scrolled to the focused question.
  const bandTop = Math.max(taRect.top, bodyRect.top);
  const bandBottom = Math.min(taRect.bottom, bodyRect.bottom);
  const hit = bandBottom - bandTop > 10
    ? document.elementFromPoint(taRect.left + taRect.width / 2, (bandTop + bandBottom) / 2)
    : null;
  const toolbarRect = rect(kits[0].querySelector(".edit-toolbar"));
  const cs = (node) => getComputedStyle(node);
  const metrics = (node) => { const s = cs(node); return [s.fontSize, s.fontFamily, s.lineHeight, s.paddingTop, s.paddingLeft, s.whiteSpace].join("|"); };
  return {
    open: !modal.hidden,
    kitCount: kits.length,
    modesHidden: Boolean(kits[0]?.querySelector(".note-editor-modes")?.hidden),
    toolbar: Boolean(kits[0]?.querySelector(".edit-toolbar button[data-action=bold]")),
    isEditTextarea: ta.classList.contains("edit-textarea"),
    value: ta.value,
    hitIsTextarea: hit === ta,
    hitDesc: hit ? hit.tagName + "." + hit.className : "none",
    sameMetrics: metrics(ta) === metrics(backdrop),
    metricsTa: metrics(ta),
    metricsBackdrop: metrics(backdrop),
    ta: { client: ta.clientHeight, scroll: ta.scrollHeight, scrollTop: ta.scrollTop, height: taRect.height },
    wrapperHeight: wrapper.getBoundingClientRect().height,
    backdropScrollTop: backdrop.scrollTop,
    preview: { hidden: preview.hidden, client: preview.clientHeight, scroll: preview.scrollHeight, scrollTop: preview.scrollTop, overflowY: cs(preview).overflowY },
    body: { client: body.clientHeight, scroll: body.scrollHeight, overflowY: cs(body).overflowY },
    panel: rect(panel),
    toolbarInView: toolbarRect.top >= bodyRect.top - 0.5 && toolbarRect.bottom <= bodyRect.bottom + 0.5,
    questionInView: (() => { const q = rect(document.getElementById("frameCardQuestionInput")); return q.top >= bodyRect.top - 0.5 && q.bottom <= bodyRect.bottom + 0.5; })(),
    add: rect(add),
    viewport: { width: innerWidth, height: innerHeight },
    focusIsAnswer: document.activeElement === ta,
    focusIsQuestion: document.activeElement === document.getElementById("frameCardQuestionInput")
  };
}`;

const chrome = findChrome();
if (!chrome) { console.log("frame-card-check: no Chrome on this machine — skipping."); process.exit(0); }

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

let failures = 0;
// Every assertion reached, for the tally at the end. See tools/check.mjs.
let ran = 0;
function check(name, ok, detail = "") {
  ran += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// A real key, through the input pipeline, because the whole question is which
// listener sees it and in what order. Dispatching a synthetic KeyboardEvent
// would answer a different question.
async function press(key, { ctrl = true, shift = false } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const named = { Enter: ["Enter", 13], Escape: ["Escape", 27] }[key];
  const common = named
    ? { modifiers, key, code: named[0], windowsVirtualKeyCode: named[1] }
    : { modifiers, key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  await settle(180);
}

async function shot(name) {
  if (!SHOT_DIR) return;
  const { data } = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(data, "base64"));
}

async function openModal(markdown) {
  await page.evaluate(`async (markdown) => {
    const { api, settle } = window.__recall;
    api.createCardFromNotesSelection(markdown, null);
    await settle(700);
  }`, markdown);
  return page.evaluate(MEASURE_SRC);
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.goto(`${server.base}/index.html`);
  await settle(1200);
  await page.evaluate(SETUP_SRC, API_SRC);

  // ── Desktop: the editor ──────────────────────────────────────────────────
  console.log("desktop 1280×800");
  const first = await openModal(LONG_ANSWER);
  await shot("desktop-open");
  check("the modal opens on the captured answer", first.open && first.value === LONG_ANSWER);
  check("...in the shared note editor, exactly one of it", first.kitCount === 1 && first.isEditTextarea && first.toolbar,
    `kits=${first.kitCount} edit-textarea=${first.isEditTextarea} toolbar=${first.toolbar}`);
  check("...without the kit's Write/Preview switch (the live preview replaces it)", first.modesHidden);
  check("the textarea is what is under the pointer, not the mirror painted over it",
    first.hitIsTextarea, first.hitDesc);
  check("the mirror and the textarea agree on every metric, so the caret sits on the text",
    first.sameMetrics, first.sameMetrics ? "" : `${first.metricsTa} vs ${first.metricsBackdrop}`);
  check("the textarea fills the box it is drawn in",
    Math.abs(first.ta.height - first.wrapperHeight) <= 1, `textarea ${first.ta.height} vs wrapper ${first.wrapperHeight}`);
  check("a long answer overflows the editor rather than growing it without bound",
    first.ta.scroll > first.ta.client + 100 && first.ta.client >= 100, JSON.stringify(first.ta));
  check("the question field has the focus when an answer arrived captured", first.focusIsQuestion);
  check("...and the answer's toolbar and the question are both in view, with nothing scrolled away",
    first.toolbarInView && first.questionInView, `toolbar=${first.toolbarInView} question=${first.questionInView} body=${JSON.stringify(first.body)}`);

  const scrolled = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    const ta = document.querySelector("#frameCardAnswerEditor [data-note-edit-value]");
    const backdrop = ta.parentElement.querySelector(".highlight-textarea-backdrop");
    const preview = document.getElementById("frameCardAnswerPreview");
    ta.scrollTop = 400;
    preview.scrollTop = 300;
    await settle(150);
    return { ta: ta.scrollTop, backdrop: backdrop.scrollTop, preview: preview.scrollTop };
  }`);
  check("the editor scrolls", scrolled.ta > 0, `scrollTop=${scrolled.ta}`);
  check("...and the mirror scrolls with it", scrolled.backdrop === scrolled.ta, `textarea ${scrolled.ta} vs mirror ${scrolled.backdrop}`);

  // ── Desktop: the preview and the panel ───────────────────────────────────
  check("the preview is shown and is its own scroller",
    !first.preview.hidden && first.preview.overflowY === "auto" && first.preview.scroll > first.preview.client,
    JSON.stringify(first.preview));
  check("...and scrolls", scrolled.preview > 0, `scrollTop=${scrolled.preview}`);
  check("the whole panel fits on screen",
    first.panel.top >= 0 && first.panel.bottom <= first.viewport.height + 0.5, JSON.stringify(first.panel));
  check("...with Add card on screen, not clipped off the bottom",
    first.add.top >= 0 && first.add.bottom <= first.viewport.height && first.add.bottom <= first.panel.bottom,
    JSON.stringify(first.add));

  // ── Desktop: writing ─────────────────────────────────────────────────────
  await page.evaluate(`() => {
    const ta = document.querySelector("#frameCardAnswerEditor [data-note-edit-value]");
    ta.focus();
    ta.setSelectionRange(0, "Line 1".length);
  }`);
  await press("b");
  const bolded = await page.evaluate(`() => document.querySelector("#frameCardAnswerEditor [data-note-edit-value]").value`);
  check("Ctrl+B bolds the selection", bolded.startsWith("**Line 1** of the captured answer"), JSON.stringify(bolded.slice(0, 40)));

  await press("z");
  const undone = await page.evaluate(`() => document.querySelector("#frameCardAnswerEditor [data-note-edit-value]").value`);
  check("...and Ctrl+Z steps back over it", undone === LONG_ANSWER, JSON.stringify(undone.slice(0, 40)));

  const viaToolbar = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    const ta = document.querySelector("#frameCardAnswerEditor [data-note-edit-value]");
    ta.focus();
    ta.setSelectionRange("Line 1 of the ".length, "Line 1 of the captured".length);
    document.querySelector("#frameCardAnswerEditor .edit-toolbar button[data-action=italic]").click();
    await settle(100);
    return ta.value.slice(0, 40);
  }`);
  check("the toolbar formats the answer it sits over",
    viaToolbar.startsWith("Line 1 of the *captured* answer"), JSON.stringify(viaToolbar));

  const dropdown = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    const toggle = document.querySelector("#frameCardAnswerEditor .toolbar-dropdown-toggle");
    const menu = toggle.closest(".toolbar-dropdown");
    toggle.click();
    await settle(50);
    const opened = menu.classList.contains("is-open");
    document.querySelector("#frameCardAnswerEditor [data-note-edit-value]").click();
    await settle(50);
    const closed = !menu.classList.contains("is-open");
    toggle.click();
    await settle(50);
    document.getElementById("frameCardQuestionInput").click();
    await settle(50);
    return { opened, closed, closedFromQuestion: !menu.classList.contains("is-open") };
  }`);
  check("a toolbar dropdown opens, and closes again on a click elsewhere",
    dropdown.opened && dropdown.closed, JSON.stringify(dropdown));
  check("...including a click in the question, outside the editor", dropdown.closedFromQuestion);

  const before = await page.evaluate(`() => ({ viewMode: window.__recall.api.state.viewMode, editing: window.__recall.api.isNotesEditing() })`);
  await press("e");
  const toggled = await page.evaluate(`() => ({
    viewMode: window.__recall.api.state.viewMode,
    editing: window.__recall.api.isNotesEditing(),
    previewHidden: document.getElementById("frameCardAnswerPreview").hidden,
    expanded: document.getElementById("frameCardAnswerPreviewLabel").getAttribute("aria-expanded")
  })`);
  check("Ctrl+E folds the preview away", toggled.previewHidden && toggled.expanded === "false", JSON.stringify(toggled));
  check("...and leaves the notes behind the modal exactly as they were",
    toggled.viewMode === before.viewMode && toggled.editing === before.editing,
    `viewMode ${before.viewMode}→${toggled.viewMode}, raw editor ${before.editing}→${toggled.editing}`);
  await press("e");
  const unfolded = await page.evaluate(`() => !document.getElementById("frameCardAnswerPreview").hidden`);
  check("...and again brings it back", unfolded);

  // ── Desktop: moving and resizing, through the real handles ──────────────
  //
  // Real mouse input, because the handles use pointer capture and the question
  // is what the reader's gesture does — not what an inline style would.
  const sizes = `() => {
    const panel = document.getElementById("frameCardPanel");
    const ta = document.querySelector("#frameCardAnswerEditor [data-note-edit-value]");
    const r = (node) => node.getBoundingClientRect();
    const title = r(document.getElementById("frameCardTitlebar"));
    const grip = r(document.getElementById("frameCardResizeHandle"));
    return {
      ta: ta.clientHeight,
      preview: document.getElementById("frameCardAnswerPreview").clientHeight,
      wrapper: r(ta.parentElement).height,
      taBox: r(ta).height,
      panel: r(panel).height,
      panelTop: r(panel).top,
      addBottom: r(document.getElementById("frameCardAddBtn")).bottom,
      panelBottom: r(panel).bottom,
      title: { x: title.left + 60, y: title.top + title.height / 2 },
      grip: { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2 }
    };
  }`;
  async function drag(from, dx, dy) {
    const mouse = (type, x, y, extra = {}) => page.call("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
    await mouse("mouseMoved", from.x, from.y, { button: "none" });
    await mouse("mousePressed", from.x, from.y, { buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 5; i += 1) await mouse("mouseMoved", from.x + dx * i / 5, from.y + dy * i / 5, { buttons: 1 });
    await mouse("mouseReleased", from.x + dx, from.y + dy, { buttons: 0, clickCount: 1 });
    await settle(150);
  }
  const atRest = await page.evaluate(sizes);
  await drag(atRest.title, -200, 10);
  const moved = await page.evaluate(sizes);
  check("dragging the title moves the panel without re-splitting the editor and preview",
    moved.ta === atRest.ta && moved.preview === atRest.preview && moved.panelTop !== atRest.panelTop,
    `editor ${atRest.ta}→${moved.ta}, preview ${atRest.preview}→${moved.preview}`);
  await drag(moved.grip, 0, -260);
  const small = await page.evaluate(sizes);
  await drag(small.grip, 0, 220);
  const tall = await page.evaluate(sizes);
  check("resizing the panel works in both directions",
    small.panel < moved.panel && tall.panel > small.panel, `${moved.panel} → ${small.panel} → ${tall.panel}`);
  check("...a taller panel gives the editor more room", tall.ta > small.ta, `${small.ta} → ${tall.ta}`);
  check("...and the preview too", tall.preview > small.preview, `${small.preview} → ${tall.preview}`);
  check("...and the textarea still fills its box, at either size",
    Math.abs(small.taBox - small.wrapper) <= 1 && Math.abs(tall.taBox - tall.wrapper) <= 1,
    `small ${small.taBox}/${small.wrapper}, tall ${tall.taBox}/${tall.wrapper}`);
  check("...and Add card stays inside the panel, at either size",
    small.addBottom <= small.panelBottom && tall.addBottom <= tall.panelBottom,
    `small ${small.addBottom}/${small.panelBottom}, tall ${tall.addBottom}/${tall.panelBottom}`);
  await shot("desktop-resized");
  // Put it back, so the rest of the run measures the default layout.
  await page.evaluate(`() => {
    const panel = document.getElementById("frameCardPanel");
    panel.removeAttribute("style");
    panel.classList.remove("is-resized");
  }`);
  await settle(50);

  // ── Desktop: the ways out ────────────────────────────────────────────────
  await page.evaluate(`() => {
    const q = document.getElementById("frameCardQuestionInput");
    q.focus();
    q.value = "What does line one say?";
  }`);
  const cardsBefore = await page.evaluate(`() => window.__recall.api.state.masterCards.length`);
  await press("Enter");
  const added = await page.evaluate(`() => ({
    cards: window.__recall.api.state.masterCards.length,
    last: window.__recall.api.state.masterCards.at(-1),
    open: !document.getElementById("frameCardModal").hidden
  })`);
  check("Ctrl+Enter adds exactly one card and closes", added.cards === cardsBefore + 1 && !added.open,
    `cards ${cardsBefore}→${added.cards}, open=${added.open}`);
  check("...with the answer as edited in the editor",
    added.last?.question === "What does line one say?" && added.last?.answer.startsWith("Line 1 of the *captured* answer"),
    JSON.stringify(added.last?.answer?.slice(0, 40)));

  const reopened = await openModal("A short second answer.");
  check("reopening starts on the new text, scrolled to the top",
    reopened.value === "A short second answer." && reopened.ta.scrollTop === 0, JSON.stringify(reopened.ta));
  await press("z");
  const noLeak = await page.evaluate(`() => document.querySelector("#frameCardAnswerEditor [data-note-edit-value]").value`);
  check("...with no undo history carried over from the last card", noLeak === "A short second answer.", JSON.stringify(noLeak));
  const escCards = await page.evaluate(`() => window.__recall.api.state.masterCards.length`);
  await press("Escape", { ctrl: false });
  const escaped = await page.evaluate(`() => ({ cards: window.__recall.api.state.masterCards.length, open: !document.getElementById("frameCardModal").hidden })`);
  check("Escape closes without adding a card", !escaped.open && escaped.cards === escCards, JSON.stringify(escaped));

  const blank = await openModal("");
  const blankState = await page.evaluate(`() => ({
    placeholder: document.querySelector("#frameCardAnswerEditor [data-note-edit-value]").placeholder,
    label: document.getElementById("frameCardAnswerPreviewLabel").hidden,
    preview: document.getElementById("frameCardAnswerPreview").hidden
  })`);
  check("a region with no text opens on a blank answer, focused, with a hint",
    blank.value === "" && blank.focusIsAnswer && blankState.placeholder.length > 0, JSON.stringify({ ...blankState, focus: blank.focusIsAnswer }));
  check("...and no empty preview under it", blankState.label && blankState.preview);
  await press("Escape", { ctrl: false });

  // ── Phone ────────────────────────────────────────────────────────────────
  console.log("phone 390×640");
  await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 640, deviceScaleFactor: 2, mobile: true });
  await settle(400);
  const phone = await openModal(LONG_ANSWER);
  await shot("phone-open");
  check("the panel fits the phone's screen, both ways",
    phone.panel.top >= 0 && phone.panel.bottom <= phone.viewport.height + 0.5
      && phone.panel.left >= 0 && phone.panel.right <= phone.viewport.width + 0.5,
    JSON.stringify(phone.panel));
  check("...with Add card on screen", phone.add.top >= 0 && phone.add.bottom <= phone.viewport.height,
    JSON.stringify(phone.add));
  check("...the textarea still under the finger, not the mirror", phone.hitIsTextarea, phone.hitDesc);
  check("...the editor scrolls inside its own box", phone.ta.scroll > phone.ta.client && phone.ta.client >= 100,
    JSON.stringify(phone.ta));
  check("...and the body between title and buttons scrolls for the rest",
    phone.body.overflowY === "auto" && phone.body.scroll >= phone.body.client, JSON.stringify(phone.body));
  const phoneScroll = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    const body = document.getElementById("frameCardBody");
    body.scrollTop = body.scrollHeight;
    await settle(100);
    const q = document.getElementById("frameCardQuestionInput").getBoundingClientRect();
    const b = body.getBoundingClientRect();
    return { reachable: q.bottom <= b.bottom + 1 && q.top >= b.top - 1, q: q.bottom, body: b.bottom };
  }`);
  check("...down to the question field", phoneScroll.reachable, JSON.stringify(phoneScroll));
  await press("Escape", { ctrl: false });
} finally {
  await client.close?.();
  await launched.close();
  server.proc?.kill();
}

console.log(failures
  ? `\nframe-card-check: ${failures} failure(s)`
  : "\nframe-card-check: the flashcard modal writes and scrolls like the rest of the app");
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
