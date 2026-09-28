// Can you actually WRITE in a "Make a flashcard" panel, does everything in it
// scroll — and can you still use the page behind it, with several open?
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
// Then the next report: with it open, the PDF or the notes behind it could not
// be scrolled at all. It was a modal — a fixed layer over the whole screen that
// caught every wheel and touch, plus a page-scroll lock — and there could only
// ever be one, so making a second card from something further down the page
// meant throwing the first draft away.
//
// Each request is its own panel now (src/notes/frame-card.js), in a layer that
// passes every event through to the page, docked as a bottom sheet on a phone.
// This drives them the way a reader does and asks each of those questions
// directly, at a desktop size and at a phone size.
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
    "/src/notes/frame-card.js?v=__BUILD__",
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

// A note long enough to scroll, so "can you still scroll the page behind" has
// something to answer with.
const LONG_NOTE = ["# A chapter", ""].concat(
  Array.from({ length: 160 }, (_, i) => `Paragraph ${i + 1} of the notes behind the panel, with enough words in it to wrap onto a second line on a phone.`)
).join("\n\n");

const SETUP_SRC = `async (apiSrc, note) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  // The panels, and which one is in front: the highest z-index in the layer.
  const panels = () => [...document.querySelectorAll("#frameCardLayer .frame-card-panel")];
  const front = () => panels().reduce((a, b) => (!a || Number(b.style.zIndex) > Number(a.style.zIndex) ? b : a), null);
  const answerOf = (panel) => panel.querySelector("[data-note-edit-value]");
  window.__recall = { api, settle, panels, front, answerOf };
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
  api.state.notes = note;
  api.setNotesScrolledSource(null);
  await api.renderNotesView();
  await settle(500);
  return true;
}`;

// An answer far taller than any box it will be shown in, so both the editor
// and the preview have something to scroll.
const LONG_ANSWER = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the captured answer, long enough to be a sentence.`).join("\n\n");

// Everything a layout assertion needs about the FRONT panel, in one round trip.
const MEASURE_SRC = `() => {
  const { panels, front, answerOf } = window.__recall;
  const panel = front();
  const body = panel.querySelector(".frame-card-body");
  const kits = panel.querySelectorAll(".frame-card-answer-editor .note-editor-kit");
  const ta = answerOf(panel);
  const wrapper = ta?.parentElement;
  const backdrop = wrapper?.querySelector(".highlight-textarea-backdrop");
  const preview = panel.querySelector(".frame-card-answer-preview");
  const question = panel.querySelector(".frame-card-question");
  const add = panel.querySelector(".frame-card-add");
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
  const questionRect = rect(question);
  const cs = (node) => getComputedStyle(node);
  const metrics = (node) => { const s = cs(node); return [s.fontSize, s.fontFamily, s.lineHeight, s.paddingTop, s.paddingLeft, s.whiteSpace].join("|"); };
  return {
    count: panels().length,
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
    preview: { hidden: preview.hidden, client: preview.clientHeight, scroll: preview.scrollHeight, scrollTop: preview.scrollTop, overflowY: cs(preview).overflowY },
    body: { client: body.clientHeight, scroll: body.scrollHeight, overflowY: cs(body).overflowY },
    panel: rect(panel),
    toolbarInView: toolbarRect.top >= bodyRect.top - 0.5 && toolbarRect.bottom <= bodyRect.bottom + 0.5,
    questionInView: questionRect.top >= bodyRect.top - 0.5 && questionRect.bottom <= bodyRect.bottom + 0.5,
    add: rect(add),
    viewport: { width: innerWidth, height: innerHeight },
    scrollLocked: document.documentElement.classList.contains("modal-scroll-lock"),
    focusIsAnswer: document.activeElement === ta,
    focusIsQuestion: document.activeElement === question
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

const mouse = (type, x, y, extra = {}) => page.call("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });

// A press-drag-release through the real input pipeline — the handles use
// pointer capture, and the question is what the reader's gesture does.
async function drag(from, dx, dy) {
  await mouse("mouseMoved", from.x, from.y, { button: "none" });
  await mouse("mousePressed", from.x, from.y, { buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 5; i += 1) await mouse("mouseMoved", from.x + dx * i / 5, from.y + dy * i / 5, { buttons: 1 });
  await mouse("mouseReleased", from.x + dx, from.y + dy, { buttons: 0, clickCount: 1 });
  await settle(150);
}

async function shot(name) {
  if (!SHOT_DIR) return;
  const { data } = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(data, "base64"));
}

async function openPanel(markdown) {
  await page.evaluate(`async (markdown) => {
    const { api, settle } = window.__recall;
    api.createCardFromNotesSelection(markdown, null);
    await settle(700);
  }`, markdown);
  return page.evaluate(MEASURE_SRC);
}

// Can the page BEHIND the panels be used at (x, y)? What is under that point,
// and does a real mouse wheel there scroll the notes?
async function underlayAt(x, y) {
  const before = await page.evaluate(`(x, y) => {
    const hit = document.elementFromPoint(x, y);
    const view = document.getElementById("notesView");
    return { inNotes: Boolean(hit && view.contains(hit)), hit: hit ? hit.tagName + "." + hit.className : "none", top: view.scrollTop };
  }`, x, y);
  await page.call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: 500 });
  await settle(400);
  const after = await page.evaluate(`() => document.getElementById("notesView").scrollTop`);
  // Put the note back where it was, for whatever measures next.
  await page.evaluate(`(top) => { document.getElementById("notesView").scrollTop = top; }`, before.top);
  await settle(100);
  return { ...before, after };
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.goto(`${server.base}/index.html`);
  await settle(1200);
  await page.evaluate(SETUP_SRC, API_SRC, LONG_NOTE);

  // ── Desktop: the editor ──────────────────────────────────────────────────
  console.log("desktop 1280×800");
  const first = await openPanel(LONG_ANSWER);
  await shot("desktop-open");
  check("a panel opens on the captured answer", first.count === 1 && first.value === LONG_ANSWER);
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

  // ── Desktop: the page behind ─────────────────────────────────────────────
  check("opening a panel takes no page-scroll lock", !first.scrollLocked);
  const behind = await underlayAt(first.panel.left - 150, first.panel.top + first.panel.height / 2);
  check("beside the panel, the pointer is over the notes — not an invisible layer",
    behind.inNotes, behind.hit);
  check("...and the mouse wheel there scrolls them", behind.after > behind.top, `${behind.top} → ${behind.after}`);

  const scrolled = await page.evaluate(`async () => {
    const { settle, front, answerOf } = window.__recall;
    const ta = answerOf(front());
    const backdrop = ta.parentElement.querySelector(".highlight-textarea-backdrop");
    const preview = front().querySelector(".frame-card-answer-preview");
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
  const answerValue = `() => window.__recall.answerOf(window.__recall.front()).value`;
  await page.evaluate(`() => {
    const ta = window.__recall.answerOf(window.__recall.front());
    ta.focus();
    ta.setSelectionRange(0, "Line 1".length);
  }`);
  await press("b");
  const bolded = await page.evaluate(answerValue);
  check("Ctrl+B bolds the selection", bolded.startsWith("**Line 1** of the captured answer"), JSON.stringify(bolded.slice(0, 40)));

  await press("z");
  const undone = await page.evaluate(answerValue);
  check("...and Ctrl+Z steps back over it", undone === LONG_ANSWER, JSON.stringify(undone.slice(0, 40)));

  const viaToolbar = await page.evaluate(`async () => {
    const { settle, front, answerOf } = window.__recall;
    const ta = answerOf(front());
    ta.focus();
    ta.setSelectionRange("Line 1 of the ".length, "Line 1 of the captured".length);
    front().querySelector(".edit-toolbar button[data-action=italic]").click();
    await settle(100);
    return ta.value.slice(0, 40);
  }`);
  check("the toolbar formats the answer it sits over",
    viaToolbar.startsWith("Line 1 of the *captured* answer"), JSON.stringify(viaToolbar));

  const dropdown = await page.evaluate(`async () => {
    const { settle, front, answerOf } = window.__recall;
    const toggle = front().querySelector(".toolbar-dropdown-toggle");
    const menu = toggle.closest(".toolbar-dropdown");
    toggle.click();
    await settle(50);
    const opened = menu.classList.contains("is-open");
    answerOf(front()).click();
    await settle(50);
    const closed = !menu.classList.contains("is-open");
    toggle.click();
    await settle(50);
    front().querySelector(".frame-card-question").click();
    await settle(50);
    return { opened, closed, closedFromQuestion: !menu.classList.contains("is-open") };
  }`);
  check("a toolbar dropdown opens, and closes again on a click elsewhere",
    dropdown.opened && dropdown.closed, JSON.stringify(dropdown));
  check("...including a click in the question, outside the editor", dropdown.closedFromQuestion);

  const before = await page.evaluate(`() => ({ viewMode: window.__recall.api.state.viewMode, editing: window.__recall.api.isNotesEditing() })`);
  await press("e");
  const previewState = `() => {
    const p = window.__recall.front();
    return {
      viewMode: window.__recall.api.state.viewMode,
      editing: window.__recall.api.isNotesEditing(),
      previewHidden: p.querySelector(".frame-card-answer-preview").hidden,
      expanded: p.querySelector(".frame-card-preview-label").getAttribute("aria-expanded")
    };
  }`;
  const toggled = await page.evaluate(previewState);
  check("Ctrl+E folds the preview away", toggled.previewHidden && toggled.expanded === "false", JSON.stringify(toggled));
  check("...and leaves the notes behind the panel exactly as they were",
    toggled.viewMode === before.viewMode && toggled.editing === before.editing,
    `viewMode ${before.viewMode}→${toggled.viewMode}, raw editor ${before.editing}→${toggled.editing}`);
  await press("e");
  const unfolded = await page.evaluate(previewState);
  check("...and again brings it back", !unfolded.previewHidden);

  // ── Desktop: moving and resizing, through the real handles ──────────────
  const sizes = `() => {
    const { front, answerOf } = window.__recall;
    const panel = front();
    const ta = answerOf(panel);
    const r = (node) => node.getBoundingClientRect();
    const title = r(panel.querySelector(".frame-card-titlebar"));
    const grip = r(panel.querySelector(".frame-card-resize-handle"));
    return {
      ta: ta.clientHeight,
      preview: panel.querySelector(".frame-card-answer-preview").clientHeight,
      wrapper: r(ta.parentElement).height,
      taBox: r(ta).height,
      panel: r(panel).height,
      panelTop: r(panel).top,
      panelLeft: r(panel).left,
      addBottom: r(panel.querySelector(".frame-card-add")).bottom,
      panelBottom: r(panel).bottom,
      title: { x: title.left + 60, y: title.top + title.height / 2 },
      grip: { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2 }
    };
  }`;
  const atRest = await page.evaluate(sizes);
  await drag(atRest.title, -200, 10);
  const moved = await page.evaluate(sizes);
  check("dragging the title moves the panel without re-splitting the editor and preview",
    moved.ta === atRest.ta && moved.preview === atRest.preview && moved.panelLeft !== atRest.panelLeft,
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

  // ── Desktop: the ways out ────────────────────────────────────────────────
  const cardsBefore = await page.evaluate(`() => window.__recall.api.state.masterCards.length`);
  await page.evaluate(`() => {
    const q = window.__recall.front().querySelector(".frame-card-question");
    q.focus();
  }`);
  // Add with no question: kept open, not thrown away.
  await page.evaluate(`() => window.__recall.front().querySelector(".frame-card-add").click()`);
  await settle(150);
  const refused = await page.evaluate(`() => ({
    count: window.__recall.panels().length,
    cards: window.__recall.api.state.masterCards.length,
    focusIsQuestion: document.activeElement === window.__recall.front().querySelector(".frame-card-question")
  })`);
  check("Add with no question keeps the draft open, with the focus on the question",
    refused.count === 1 && refused.cards === cardsBefore && refused.focusIsQuestion, JSON.stringify(refused));

  await page.evaluate(`() => { window.__recall.front().querySelector(".frame-card-question").value = "What does line one say?"; }`);
  await press("Enter");
  const added = await page.evaluate(`() => ({
    cards: window.__recall.api.state.masterCards.length,
    last: window.__recall.api.state.masterCards.at(-1),
    count: window.__recall.panels().length
  })`);
  check("Ctrl+Enter adds exactly one card and closes the panel", added.cards === cardsBefore + 1 && added.count === 0,
    `cards ${cardsBefore}→${added.cards}, panels=${added.count}`);
  check("...with the answer as edited in the editor",
    added.last?.question === "What does line one say?" && added.last?.answer.startsWith("Line 1 of the *captured* answer"),
    JSON.stringify(added.last?.answer?.slice(0, 40)));

  const reopened = await openPanel("A short second answer.");
  check("the next panel opens where the last one was parked",
    Math.abs(reopened.panel.left - tall.panelLeft) <= 1, `${tall.panelLeft} vs ${reopened.panel.left}`);
  check("...on the new text, scrolled to the top",
    reopened.value === "A short second answer." && reopened.ta.scrollTop === 0, JSON.stringify(reopened.ta));
  await press("z");
  const noLeak = await page.evaluate(answerValue);
  check("...with no undo history carried over from the last card", noLeak === "A short second answer.", JSON.stringify(noLeak));
  const escCards = await page.evaluate(`() => window.__recall.api.state.masterCards.length`);
  await press("Escape", { ctrl: false });
  const escaped = await page.evaluate(`() => ({ cards: window.__recall.api.state.masterCards.length, count: window.__recall.panels().length })`);
  check("Escape closes without adding a card", escaped.count === 0 && escaped.cards === escCards, JSON.stringify(escaped));

  const blank = await openPanel("");
  const blankState = await page.evaluate(`() => {
    const p = window.__recall.front();
    return {
      placeholder: window.__recall.answerOf(p).placeholder,
      label: p.querySelector(".frame-card-preview-label").hidden,
      preview: p.querySelector(".frame-card-answer-preview").hidden
    };
  }`);
  check("a region with no text opens on a blank answer, focused, with a hint",
    blank.value === "" && blank.focusIsAnswer && blankState.placeholder.length > 0, JSON.stringify({ ...blankState, focus: blank.focusIsAnswer }));
  check("...and no empty preview under it", blankState.label && blankState.preview);
  await press("Escape", { ctrl: false });

  // ── Desktop: several drafts at once ──────────────────────────────────────
  //
  // These open where the last panel was parked above, and cascade from there —
  // the same offset a centred first panel would get.
  const a = await openPanel("Alpha answer.");
  await page.evaluate(`() => { window.__recall.front().querySelector(".frame-card-question").value = "Question for alpha?"; }`);
  const panelA = await page.evaluate(`() => {
    const p = window.__recall.front();
    p.dataset.checkName = "A";
    const r = p.getBoundingClientRect();
    return { left: r.left, top: r.top, z: Number(p.style.zIndex) };
  }`);
  const b = await openPanel("Beta answer.");
  const multi = await page.evaluate(`() => {
    const { panels, front } = window.__recall;
    const pa = panels().find((p) => p.dataset.checkName === "A");
    const pb = front();
    const ra = pa.getBoundingClientRect();
    const rb = pb.getBoundingClientRect();
    return {
      count: panels().length,
      aQuestion: pa.querySelector(".frame-card-question").value,
      aAnswer: window.__recall.answerOf(pa).value,
      frontIsB: pb !== pa && window.__recall.answerOf(pb).value === "Beta answer.",
      dx: rb.left - ra.left,
      dy: rb.top - ra.top,
      focusInB: pb.contains(document.activeElement)
    };
  }`);
  await shot("desktop-two-panels");
  check("a second \"Make a flashcard\" opens a second panel beside the first", multi.count === 2 && a.count === 1 && b.count === 2,
    `panels=${multi.count}`);
  check("...leaving the first draft exactly as it was",
    multi.aQuestion === "Question for alpha?" && multi.aAnswer === "Alpha answer.", JSON.stringify({ q: multi.aQuestion, a: multi.aAnswer }));
  check("...with the new one in front, holding the focus", multi.frontIsB && multi.focusInB);
  check("...and offset from the first, so neither hides the other", multi.dx > 10 && multi.dy !== 0,
    `dx=${multi.dx} dy=${multi.dy}`);

  // A press on the first panel's exposed corner brings it forward.
  await mouse("mousePressed", panelA.left + 12, panelA.top + 12, { buttons: 1, clickCount: 1 });
  await mouse("mouseReleased", panelA.left + 12, panelA.top + 12, { buttons: 0, clickCount: 1 });
  await settle(150);
  const raised = await page.evaluate(`() => window.__recall.front().dataset.checkName === "A"`);
  check("pressing the one behind brings it to the front", raised);

  // Add B's card from B, with A still open.
  const cardsMid = await page.evaluate(`() => window.__recall.api.state.masterCards.length`);
  await page.evaluate(`() => {
    const b = window.__recall.panels().find((p) => p.dataset.checkName !== "A");
    const q = b.querySelector(".frame-card-question");
    q.value = "Question for beta?";
    q.focus();
  }`);
  await press("Enter");
  const afterB = await page.evaluate(`() => ({
    cards: window.__recall.api.state.masterCards.length,
    last: window.__recall.api.state.masterCards.at(-1),
    left: window.__recall.panels().map((p) => p.dataset.checkName || "?")
  })`);
  check("Ctrl+Enter in one panel adds that panel's card only",
    afterB.cards === cardsMid + 1 && afterB.last?.question === "Question for beta?" && afterB.last?.answer === "Beta answer.",
    JSON.stringify(afterB.last));
  check("...and closes that panel only", afterB.left.length === 1 && afterB.left[0] === "A", JSON.stringify(afterB.left));
  await page.evaluate(`() => window.__recall.front().querySelector(".frame-card-add").click()`);
  await settle(150);
  const afterA = await page.evaluate(`() => ({
    cards: window.__recall.api.state.masterCards.length,
    last: window.__recall.api.state.masterCards.at(-1),
    count: window.__recall.panels().length
  })`);
  check("...and the other panel's Add still adds its own card",
    afterA.cards === cardsMid + 2 && afterA.last?.question === "Question for alpha?" && afterA.last?.answer === "Alpha answer." && afterA.count === 0,
    JSON.stringify(afterA.last));

  // Escape: inside a panel it closes that one; from the page, the front one.
  await openPanel("One.");
  await openPanel("Two.");
  await press("Escape", { ctrl: false });
  const escInside = await page.evaluate(`() => window.__recall.panels().map((p) => window.__recall.answerOf(p).value)`);
  check("Escape inside a panel closes that panel only", escInside.length === 1 && escInside[0] === "One.", JSON.stringify(escInside));
  await page.evaluate(`() => { document.activeElement?.blur(); }`);
  await press("Escape", { ctrl: false });
  const escOutside = await page.evaluate(`() => window.__recall.panels().length`);
  check("...and from the page behind, the front panel", escOutside === 0, `panels=${escOutside}`);

  // ── Phone ────────────────────────────────────────────────────────────────
  console.log("phone 390×640");
  await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 640, deviceScaleFactor: 2, mobile: true });
  await settle(400);
  const phone = await openPanel(LONG_ANSWER);
  await shot("phone-open");
  check("the panel docks as a bottom sheet: full width, on the bottom edge",
    Math.abs(phone.panel.bottom - phone.viewport.height) <= 1 && phone.panel.left <= 0.5
      && Math.abs(phone.panel.right - phone.viewport.width) <= 0.5,
    JSON.stringify(phone.panel));
  check("...no taller than about 60% of the screen", phone.panel.height <= phone.viewport.height * 0.62 + 1,
    `${phone.panel.height} of ${phone.viewport.height}`);
  const phoneBehind = await underlayAt(phone.viewport.width / 2, phone.panel.top - 40);
  check("...leaving the notes above it under the finger", phoneBehind.inNotes, phoneBehind.hit);
  check("...and scrollable there", phoneBehind.after > phoneBehind.top, `${phoneBehind.top} → ${phoneBehind.after}`);
  check("Add card is on screen", phone.add.top >= 0 && phone.add.bottom <= phone.viewport.height,
    JSON.stringify(phone.add));
  check("the textarea is under the finger, not the mirror", phone.hitIsTextarea, phone.hitDesc);
  check("the editor scrolls inside its own box", phone.ta.scroll > phone.ta.client && phone.ta.client >= 80,
    JSON.stringify(phone.ta));
  check("the sheet's body scrolls for the rest",
    phone.body.overflowY === "auto" && phone.body.scroll >= phone.body.client, JSON.stringify(phone.body));
  const phoneScroll = await page.evaluate(`async () => {
    const { settle, front } = window.__recall;
    const body = front().querySelector(".frame-card-body");
    body.scrollTop = body.scrollHeight;
    await settle(100);
    const q = front().querySelector(".frame-card-question").getBoundingClientRect();
    const b = body.getBoundingClientRect();
    return { reachable: q.bottom <= b.bottom + 1 && q.top >= b.top - 1, q: q.bottom, body: b.bottom };
  }`);
  check("...down to the question field", phoneScroll.reachable, JSON.stringify(phoneScroll));
  const phoneSizes = await page.evaluate(sizes);
  await drag(phoneSizes.title, 0, -120);
  const phoneMoved = await page.evaluate(sizes);
  check("the sheet can still be dragged", phoneMoved.panelTop < phoneSizes.panelTop - 50,
    `${phoneSizes.panelTop} → ${phoneMoved.panelTop}`);
  await press("Escape", { ctrl: false });
} finally {
  await client.close?.();
  await launched.close();
  server.proc?.kill();
}

console.log(failures
  ? `\nframe-card-check: ${failures} failure(s)`
  : "\nframe-card-check: the flashcard panels write, scroll, stack, and leave the page behind usable");
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
