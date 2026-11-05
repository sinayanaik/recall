// Recall Page Cleaner — the on-page toolbar, marking and undo.
//
// Injected (with cleaner-core.js before it and cleaner.css alongside) when the
// toolbar icon is clicked. Self-toggling: a second click closes it. Closing
// never puts removed blocks back — the point is a cleaned page that Recall
// Clipper or Recall Web to PDF can then work on — but the undo history
// survives, so reopening the cleaner and pressing Undo (or "Restore page")
// brings everything back.
//
// Marking: a marked block is blurred and covered in red. Nothing leaves the
// page until Apply. Auto mode pre-marks what the chosen level would remove;
// in either mode a click marks or unmarks.

(() => {
  const G = globalThis;
  if (G.__recallCleaner) {
    if (G.__recallCleaner.active) G.__recallCleaner.close();
    else G.__recallCleaner.open();
    return;
  }
  const core = G.__recallCleanerCore;
  if (!core) return;

  const HOST_TAG = "recall-page-cleaner";
  const REASON_MANUAL = "Picked";
  const LEVELS = [["gentle", "Gentle"], ["balanced", "Balanced"], ["reader", "Reader"]];
  const hostname = location.hostname;
  const siteKey = `site:${hostname}`;

  const S = {
    active: false,
    mode: "auto",
    level: "balanced",
    remember: false,
    marks: new Map(),       // Element → reason
    boxes: new Map(),       // Element → overlay box
    history: [],
    redo: [],
    hoverStack: [],
    removedTotal: 0,
    raf: 0,
    host: null,
    root: null,
    els: {}
  };

  // ---------------------------------------------------------------- storage

  const storage = {
    async get(key, fallback) {
      try {
        const out = await chrome.storage.local.get(key);
        return out[key] ?? fallback;
      } catch { return fallback; }
    },
    async set(key, value) {
      try { await chrome.storage.local.set({ [key]: value }); } catch { /* storage is a nicety */ }
    },
    async remove(key) {
      try { await chrome.storage.local.remove(key); } catch { /* ignore */ }
    }
  };

  // ---------------------------------------------------------------- UI

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    .box { position: fixed; box-sizing: border-box; pointer-events: auto; cursor: pointer;
      background: rgba(229, 57, 53, 0.30); border: 2px solid #e53935; border-radius: 3px; }
    .box:hover { background: rgba(229, 57, 53, 0.15); border-style: dashed; }
    .box .tag { position: absolute; top: -1px; left: -1px; font: 600 11px/1.4 system-ui, sans-serif;
      color: #fff; background: #e53935; padding: 1px 6px; border-radius: 0 0 4px 0; white-space: nowrap;
      max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
    .hover { position: fixed; box-sizing: border-box; pointer-events: none; border: 2px dashed #ff7043;
      background: rgba(255, 112, 67, 0.10); display: none; }
    .hover .tag { position: absolute; bottom: 100%; left: -2px; font: 500 11px/1.5 ui-monospace, monospace;
      color: #fff; background: #ff7043; padding: 0 6px; border-radius: 3px 3px 0 0; white-space: nowrap; }
    .bar { position: fixed; right: 16px; top: 16px; width: 360px; max-width: calc(100vw - 32px);
      pointer-events: auto; z-index: 2147483647; box-sizing: border-box;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1d2433;
      background: #fff; border: 1px solid #d6dbe4; border-radius: 12px;
      box-shadow: 0 12px 32px rgba(20, 30, 50, 0.22); padding: 10px 12px; }
    .bar.bottom { top: auto; bottom: 16px; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .row + .row { margin-top: 8px; }
    .title { font-weight: 700; margin-right: auto; display: flex; align-items: center; gap: 6px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #e53935; }
    button, select { font: inherit; color: inherit; }
    button { border: 1px solid #ccd3df; background: #f6f8fb; border-radius: 7px; padding: 4px 9px; cursor: pointer; }
    button:hover:not(:disabled) { background: #eaf0f8; }
    button:disabled { opacity: 0.45; cursor: default; }
    button.primary { background: #e53935; border-color: #c62828; color: #fff; font-weight: 600; }
    button.primary:hover:not(:disabled) { background: #d32f2f; }
    button.icon { padding: 4px 7px; }
    .seg { display: inline-flex; border: 1px solid #ccd3df; border-radius: 8px; overflow: hidden; }
    .seg button { border: 0; border-radius: 0; background: #fff; }
    .seg button[aria-pressed="true"] { background: #1d2433; color: #fff; }
    .count { font-weight: 600; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: #fdecea; color: #b71c1c;
      border: 1px solid #f5c6c4; cursor: pointer; }
    .chip:hover { text-decoration: line-through; }
    .hint { color: #5b6476; font-size: 12px; }
    kbd { font: 11px ui-monospace, monospace; border: 1px solid #ccd3df; border-bottom-width: 2px;
      border-radius: 4px; padding: 0 4px; background: #f6f8fb; }
    .handoff { border-top: 1px solid #e6e9ef; padding-top: 8px; }
    .handoff[hidden] { display: none; }
    label.check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
    .toast { margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: #eef6ff; color: #12395f; font-size: 12px; }
    .toast[hidden] { display: none; }
    .toast button { padding: 1px 6px; font-size: 12px; margin-left: 6px; }
    @media (prefers-color-scheme: dark) {
      .bar { background: #1f2430; color: #e7eaf0; border-color: #394155; }
      button, .seg button { background: #2a3040; border-color: #46506a; }
      button:hover:not(:disabled) { background: #343c50; }
      .seg button[aria-pressed="true"] { background: #e7eaf0; color: #1f2430; }
      .hint { color: #a5adbd; }
      kbd { background: #2a3040; border-color: #46506a; }
      .toast { background: #22344a; color: #d6e6f8; }
      .handoff { border-color: #394155; }
    }
  `;

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "on") Object.entries(v).forEach(([ev, fn]) => el.addEventListener(ev, fn));
      else if (k === "class") el.className = v;
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    children.flat().forEach((c) => el.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return el;
  }

  function buildUi() {
    const host = document.createElement(HOST_TAG);
    host.setAttribute("data-recall-cleaner-ui", "");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;";
    const root = host.attachShadow({ mode: "open" });
    root.append(h("style", {}, CSS));
    const layer = h("div", { class: "layer" });
    const hover = h("div", { class: "hover" }, h("span", { class: "tag" }));
    layer.append(hover);

    const modeAuto = h("button", { type: "button", "aria-pressed": "true", title: "Mark what the chosen level would remove" }, "Auto");
    const modeManual = h("button", { type: "button", "aria-pressed": "false", title: "Click blocks to mark them" }, "Manual");
    const level = h("select", { "aria-label": "How much to remove" },
      ...LEVELS.map(([v, label]) => h("option", { value: v }, label)));
    const count = h("span", { class: "count" }, "0 marked");
    const apply = h("button", { type: "button", class: "primary", title: "Remove the marked blocks (Enter)" }, "Apply");
    const undo = h("button", { type: "button", class: "icon", title: "Undo (Ctrl+Z)", "aria-label": "Undo" }, "↶");
    const redo = h("button", { type: "button", class: "icon", title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo" }, "↷");
    const clear = h("button", { type: "button", title: "Unmark everything" }, "Clear marks");
    const restore = h("button", { type: "button", title: "Put back everything this cleaner removed" }, "Restore page");
    const remember = h("input", { type: "checkbox" });
    const move = h("button", { type: "button", class: "icon", title: "Move this toolbar to the other edge", "aria-label": "Move toolbar" }, "⇅");
    const close = h("button", { type: "button", class: "icon", title: "Close (Esc) — the page stays cleaned", "aria-label": "Close" }, "✕");
    const chips = h("div", { class: "chips" });
    const hint = h("div", { class: "hint" });
    const removedNote = h("span", {});
    const pdf = h("button", { type: "button", title: "Hand this cleaned page to Recall Web to PDF" }, "Save as PDF");
    const handoff = h("div", { class: "handoff", hidden: true },
      h("div", { class: "row" }, removedNote),
      h("div", { class: "row" }, pdf,
        h("span", { class: "hint" }, "Clip as Markdown: press ", h("kbd", {}, "Alt+Shift+M"), " (Recall Clipper)")));
    const toastText = h("span", {});
    const toastAction = h("button", { type: "button", hidden: true });
    const toast = h("div", { class: "toast", hidden: true, role: "status" }, toastText, toastAction);

    const bar = h("div", { class: "bar", role: "toolbar", "aria-label": "Recall Page Cleaner" },
      h("div", { class: "row" },
        h("span", { class: "title" }, h("span", { class: "dot" }), "Page Cleaner"),
        move, close),
      h("div", { class: "row" },
        h("span", { class: "seg" }, modeAuto, modeManual), level),
      h("div", { class: "row" }, count, apply, undo, redo, clear),
      h("div", { class: "row" }, chips),
      h("div", { class: "row" },
        h("label", { class: "check", title: "Save the blocks you remove here and remove them automatically next time" },
          remember, "Remember for this site"),
        restore),
      h("div", { class: "row" }, hint),
      handoff,
      toast);

    root.append(layer, bar);
    document.documentElement.append(host);

    modeAuto.addEventListener("click", () => setMode("auto"));
    modeManual.addEventListener("click", () => setMode("manual"));
    level.addEventListener("change", () => { S.level = level.value; savePrefs(); runAuto(); });
    apply.addEventListener("click", () => applyMarks());
    undo.addEventListener("click", () => undoLast());
    redo.addEventListener("click", () => redoLast());
    clear.addEventListener("click", () => replaceMarks([]));
    restore.addEventListener("click", () => restorePage());
    remember.addEventListener("change", () => { S.remember = remember.checked; savePrefs(); });
    move.addEventListener("click", () => bar.classList.toggle("bottom"));
    close.addEventListener("click", () => closeCleaner());
    pdf.addEventListener("click", () => handOffToPdf());
    toastAction.addEventListener("click", () => { const fn = toastAction._fn; hideToast(); if (fn) fn(); });

    S.host = host;
    S.root = root;
    S.els = { layer, hover, modeAuto, modeManual, level, count, apply, undo, redo, clear, restore, remember, chips, hint, handoff, removedNote, toast, toastText, toastAction, bar, pdf };
  }

  let toastTimer = 0;
  function showToast(text, action) {
    const { toast, toastText, toastAction } = S.els;
    toastText.textContent = text;
    if (action) { toastAction.textContent = action.label; toastAction._fn = action.run; toastAction.hidden = false; }
    else { toastAction.hidden = true; toastAction._fn = null; }
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 9000 : 4000);
  }
  function hideToast() { if (S.els.toast) S.els.toast.hidden = true; }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].filter((c) => !c.startsWith("rpc-")).slice(0, 2);
    if (cls.length) s += `.${cls.join(".")}`;
    const r = el.getBoundingClientRect();
    return `${s.slice(0, 60)} · ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function render() {
    const { count, apply, undo, redo, clear, chips, hint, modeAuto, modeManual, level, handoff, removedNote, remember } = S.els;
    const n = S.marks.size;
    count.textContent = `${n} marked`;
    apply.disabled = n === 0;
    clear.disabled = n === 0;
    undo.disabled = S.history.length === 0;
    redo.disabled = S.redo.length === 0;
    modeAuto.setAttribute("aria-pressed", String(S.mode === "auto"));
    modeManual.setAttribute("aria-pressed", String(S.mode === "manual"));
    level.value = S.level;
    level.hidden = S.mode !== "auto";
    remember.checked = S.remember;
    // One chip per reason; clicking a chip unmarks that whole group.
    const groups = new Map();
    S.marks.forEach((reason) => groups.set(reason, (groups.get(reason) || 0) + 1));
    chips.replaceChildren(...[...groups].map(([reason, k]) =>
      h("span", { class: "chip", title: `Unmark every “${reason}” block`, on: { click: () => unmarkReason(reason) } },
        `${reason} ×${k}`)));
    hint.replaceChildren(...(S.mode === "manual"
      ? ["Click a block to mark it · ", h("kbd", {}, "↑"), " parent · ", h("kbd", {}, "↓"), " child · ",
         h("kbd", {}, "K"), " keep only this · ", h("kbd", {}, "Enter"), " apply · ", h("kbd", {}, "Esc"), " close"]
      : ["Red blocks will be removed. Click one to keep it, or any other block to mark it · ",
         h("kbd", {}, "Enter"), " apply · ", h("kbd", {}, "Esc"), " close"]));
    const removed = liveRemovedCount();
    handoff.hidden = removed === 0;
    removedNote.textContent = `Cleaned: ${removed} block${removed === 1 ? "" : "s"} removed. Next:`;
    syncBoxes();
  }

  function liveRemovedCount() {
    return S.history.reduce((sum, a) => sum + (a.type === "apply" ? a.removed.length : 0), 0);
  }

  // ---------------------------------------------------------------- boxes

  function syncBoxes() {
    // Drop boxes for unmarked elements, add boxes for new marks.
    S.boxes.forEach((box, el) => {
      if (!S.marks.has(el)) { box.remove(); S.boxes.delete(el); el.classList.remove("rpc-marked", "rpc-passthrough"); }
    });
    S.marks.forEach((reason, el) => {
      el.classList.add("rpc-marked");
      let box = S.boxes.get(el);
      if (!box) {
        box = h("div", { class: "box", title: `${reason} — click to keep this block` }, h("span", { class: "tag" }, reason));
        box.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleMark(el); });
        S.els.layer.append(box);
        S.boxes.set(el, box);
      } else {
        box.firstChild.textContent = reason;
      }
    });
    schedule();
  }

  function place(box, el) {
    if (!el.isConnected) { box.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { box.style.display = "none"; return; }
    box.style.display = "block";
    if (box.classList.contains("box")) {
      const big = (Math.min(r.width, innerWidth) * Math.min(r.height, innerHeight)) / (innerWidth * innerHeight) > 0.6;
      box.style.pointerEvents = big ? "none" : "auto";
      el.classList.toggle("rpc-passthrough", big);
    }
    box.style.left = `${Math.max(r.left, -4)}px`;
    box.style.top = `${Math.max(r.top, -4)}px`;
    box.style.width = `${Math.min(r.width, innerWidth + 8)}px`;
    box.style.height = `${Math.min(r.height, r.bottom + 4, innerHeight + 8)}px`;
  }

  // Re-glue the boxes to their elements every frame while anything is shown:
  // pages scroll, reflow and re-render under us.
  function frame() {
    S.raf = 0;
    if (!S.active) return;
    S.boxes.forEach((box, el) => place(box, el));
    const target = S.hoverStack[S.hoverStack.length - 1];
    const { hover } = S.els;
    if (target && target.isConnected && !S.marks.has(target)) {
      place(hover, target);
      hover.firstChild.textContent = describe(target);
    } else {
      hover.style.display = "none";
    }
    if (S.boxes.size || target) schedule();
  }
  function schedule() { if (!S.raf && S.active) S.raf = requestAnimationFrame(frame); }

  // ---------------------------------------------------------------- marking

  function snapshot() { return [...S.marks]; }

  function commit(action) {
    S.history.push(action);
    S.redo = [];
    render();
  }

  function setMarks(entries) {
    S.marks = new Map(entries.filter(([el]) => el.isConnected));
    render();
  }

  function replaceMarks(list) {
    const before = snapshot();
    S.marks = new Map(list.map((c) => [c.el, c.reason]));
    commit({ type: "marks", before, after: snapshot() });
  }

  function markedAncestor(el) {
    for (let p = el.parentElement; p; p = p.parentElement) if (S.marks.has(p)) return p;
    return null;
  }

  function toggleMark(el, reason = REASON_MANUAL) {
    if (!el || el === document.body || el === document.documentElement) return;
    const before = snapshot();
    if (S.marks.has(el)) {
      S.marks.delete(el);
    } else {
      const outer = markedAncestor(el);
      if (outer) { showToast("That block is already inside a marked block."); return; }
      // Marking a block absorbs any marks inside it.
      S.marks.forEach((_r, m) => { if (el.contains(m)) S.marks.delete(m); });
      S.marks.set(el, reason);
    }
    commit({ type: "marks", before, after: snapshot() });
  }

  function unmarkReason(reason) {
    const before = snapshot();
    S.marks.forEach((r, el) => { if (r === reason) S.marks.delete(el); });
    commit({ type: "marks", before, after: snapshot() });
  }

  function keepOnly(el) {
    if (!el || el === document.body) return;
    replaceMarks(core.outsideOf(el, "Not kept"));
    showToast("Everything else is marked. Press Enter to apply.");
  }

  function runAuto() {
    if (S.mode !== "auto") return;
    const list = core.findCandidates(S.level);
    replaceMarks(list);
    if (!list.length) showToast("Nothing to remove at this level. Try a stronger level, or switch to Manual.");
  }

  function setMode(mode) {
    if (S.mode === mode) return;
    S.mode = mode;
    savePrefs();
    document.documentElement.classList.toggle("rpc-manual", mode === "manual");
    if (mode === "auto") runAuto();
    render();
  }

  // ---------------------------------------------------------------- apply / undo

  function removeElements(entries) {
    const removed = [];
    for (const [el, reason] of entries) {
      if (!el.isConnected || !el.parentNode) continue;
      el.classList.remove("rpc-marked", "rpc-passthrough");
      removed.push({ el, reason, parent: el.parentNode, next: el.nextSibling });
      el.remove();
    }
    return removed;
  }

  function putBack(removed) {
    for (let i = removed.length - 1; i >= 0; i -= 1) {
      const { el, parent, next } = removed[i];
      if (!parent.isConnected && parent !== document) continue;
      parent.insertBefore(el, next && next.parentNode === parent ? next : null);
    }
  }

  async function applyMarks({ fromSaved = false } = {}) {
    if (!S.marks.size) return 0;
    const before = snapshot();
    const removed = removeElements(before);
    const unlock = core.unlockScroll();
    S.marks.clear();
    S.hoverStack = [];
    commit({ type: "apply", before, removed, unlock });
    if (S.remember && !fromSaved) await rememberRemoved(removed);
    return removed.length;
  }

  function undoLast() {
    const action = S.history.pop();
    if (!action) return;
    if (action.type === "marks") setMarks(action.before);
    else if (action.type === "apply") {
      putBack(action.removed);
      if (action.unlock) action.unlock();
      setMarks(action.before);
    }
    S.redo.push(action);
    render();
  }

  function redoLast() {
    const action = S.redo.pop();
    if (!action) return;
    if (action.type === "marks") setMarks(action.after);
    else if (action.type === "apply") {
      action.removed = removeElements(action.before);
      action.unlock = core.unlockScroll();
      S.marks.clear();
    }
    S.history.push(action);
    render();
  }

  function restorePage() {
    let n = 0;
    while (S.history.some((a) => a.type === "apply")) { undoLast(); n += 1; }
    S.redo = [];
    replaceMarks([]);
    S.history = [];
    render();
    showToast(n ? "The page is back as it was." : "Nothing has been removed yet.");
  }

  // ---------------------------------------------------------------- site rules

  async function rememberRemoved(removed) {
    const rules = await storage.get(siteKey, { selectors: [] });
    const set = new Set(rules.selectors || []);
    let added = 0;
    // Selectors are written while the node is detached, so build them from a
    // quick re-insert-free path: the parent chain is still recorded.
    for (const { el, parent, next } of removed) {
      parent.insertBefore(el, next && next.parentNode === parent ? next : null);
      const sel = core.selectorFor(el);
      el.remove();
      if (sel && !set.has(sel)) { set.add(sel); added += 1; }
    }
    await storage.set(siteKey, { selectors: [...set].slice(-200), savedAt: Date.now() });
    if (added) showToast(`Saved ${added} rule${added === 1 ? "" : "s"} for ${hostname}.`);
  }

  async function applySavedRules() {
    const rules = await storage.get(siteKey, null);
    if (!rules || !rules.selectors || !rules.selectors.length) return;
    const found = [];
    for (const sel of rules.selectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.closest("[data-recall-cleaner-ui]") || el === document.body || el.contains(document.querySelector("h1")) && core.textLength(el) > 2000) return;
          found.push({ el, reason: "Saved rule" });
        });
      } catch { /* a stale selector */ }
    }
    if (!found.length) return;
    const keep = found.filter((c) => !found.some((o) => o !== c && o.el.contains(c.el)));
    const before = snapshot();
    S.marks = new Map(keep.map((c) => [c.el, c.reason]));
    commit({ type: "marks", before, after: snapshot() });
    const n = await applyMarks({ fromSaved: true });
    showToast(`Removed ${n} block${n === 1 ? "" : "s"} with this site's saved rules.`, {
      label: "Forget site",
      run: async () => {
        await storage.remove(siteKey);
        undoLast();
        showToast(`Forgot the saved rules for ${hostname}.`);
      }
    });
  }

  async function savePrefs() {
    await storage.set("prefs", { mode: S.mode, level: S.level, remember: S.remember });
  }

  // ---------------------------------------------------------------- hand-off

  async function handOffToPdf() {
    const { pdf } = S.els;
    pdf.disabled = true;
    pdf.textContent = "Starting…";
    closeCleaner({ keepToast: true });
    let res = null;
    try { res = await chrome.runtime.sendMessage({ type: "rpc-handoff-pdf" }); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    if (!res || !res.ok) {
      openCleaner();
      showToast("Recall Web to PDF did not answer. Install it from Recall (☰ → Extensions), or click its icon / press Alt+Shift+P.");
    }
    pdf.disabled = false;
    pdf.textContent = "Save as PDF";
  }

  // ---------------------------------------------------------------- events

  const isUi = (e) => e.composedPath().includes(S.host);
  const editable = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  function onMove(e) {
    if (isUi(e)) return;
    const t = e.target;
    if (!(t instanceof Element) || t === document.documentElement) return;
    if (S.hoverStack[0] !== t) S.hoverStack = [t];
    schedule();
  }
  function swallow(e) {
    if (isUi(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  function onClick(e) {
    if (isUi(e)) return;
    swallow(e);
    const target = S.hoverStack[S.hoverStack.length - 1] || e.target;
    if (target instanceof Element) toggleMark(markedAncestor(target) || target);
  }
  function onKey(e) {
    if (isUi(e) && e.key !== "Escape") return;
    if (editable(e.target) && e.key !== "Escape") return;
    const mod = e.ctrlKey || e.metaKey;
    const top = S.hoverStack[S.hoverStack.length - 1];
    let handled = true;
    if (e.key === "Escape") closeCleaner();
    else if (mod && (e.key === "z" || e.key === "Z") && e.shiftKey) redoLast();
    else if (mod && (e.key === "y" || e.key === "Y")) redoLast();
    else if (mod && (e.key === "z" || e.key === "Z")) undoLast();
    else if (e.key === "Enter") applyMarks();
    else if (e.key === "ArrowUp" && top) {
      const p = top.parentElement;
      if (p && p !== document.documentElement) S.hoverStack.push(p);
      schedule();
    } else if (e.key === "ArrowDown" && S.hoverStack.length > 1) { S.hoverStack.pop(); schedule(); }
    else if ((e.key === " " || e.key === "m" || e.key === "M") && top) toggleMark(top);
    else if ((e.key === "k" || e.key === "K") && top) keepOnly(top);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  const LISTENERS = [
    ["mousemove", onMove], ["click", onClick], ["mousedown", swallow], ["mouseup", swallow],
    ["pointerdown", swallow], ["pointerup", swallow], ["auxclick", swallow], ["dblclick", swallow],
    ["keydown", onKey]
  ];

  // ---------------------------------------------------------------- lifecycle

  async function openCleaner() {
    if (S.active) return;
    S.active = true;
    if (!S.host) buildUi();
    else document.documentElement.append(S.host);
    LISTENERS.forEach(([ev, fn]) => window.addEventListener(ev, fn, true));
    document.documentElement.classList.add("rpc-active");
    document.documentElement.classList.toggle("rpc-manual", S.mode === "manual");
    render();
  }

  function closeCleaner({ keepToast = false } = {}) {
    if (!S.active) return;
    S.active = false;
    LISTENERS.forEach(([ev, fn]) => window.removeEventListener(ev, fn, true));
    S.marks.forEach((_r, el) => el.classList.remove("rpc-marked", "rpc-passthrough"));
    S.boxes.forEach((box) => box.remove());
    S.boxes.clear();
    // Marks do not outlive the toolbar; the removals do (Undo still has them).
    if (S.marks.size) { S.marks.clear(); }
    S.hoverStack = [];
    if (!keepToast) hideToast();
    document.documentElement.classList.remove("rpc-active", "rpc-manual");
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.host.remove();
  }

  G.__recallCleaner = {
    get active() { return S.active; },
    open: () => { openCleaner().then(() => { if (S.mode === "auto") runAuto(); }); },
    close: () => closeCleaner(),
    // For tests and the hand-off: the current state, read-only.
    state: () => ({ mode: S.mode, level: S.level, marked: [...S.marks].map(([el, reason]) => ({ el, reason })), removed: liveRemovedCount() }),
    setMode, setLevel: (lv) => { S.level = lv; runAuto(); }, toggleMark, applyMarks, undo: undoLast, redo: redoLast, keepOnly, restorePage
  };

  (async () => {
    const prefs = await storage.get("prefs", {});
    if (prefs.mode === "auto" || prefs.mode === "manual") S.mode = prefs.mode;
    if (LEVELS.some(([v]) => v === prefs.level)) S.level = prefs.level;
    S.remember = Boolean(prefs.remember);
    await openCleaner();
    await applySavedRules();
    if (S.mode === "auto") runAuto();
  })();
})();
