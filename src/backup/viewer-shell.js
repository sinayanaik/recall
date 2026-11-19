// The offline viewer's page, script and stylesheet, as text.
//
// Written into every backup by src/backup/viewer-pack.js as index.html,
// viewer/recall-viewer.js and viewer/recall-viewer.css. Kept as strings in a
// module, not as files fetched at backup time, so a backup made offline — or in
// the Node check, which has no server — writes exactly the same viewer.
//
// The script is a CLASSIC script, not a module: a page opened from a folder on
// disk may not load modules. It defines two functions the data files call
// (RecallViewerLibrary, RecallViewerFile — named in viewer-pack.js too) and
// draws everything with plain DOM. Nothing is saved anywhere but the browser's
// own memory of the theme; the page says so.
//
// One rule for editing the script below: it is a String.raw template, so it
// must contain no backtick and no dollar-brace.

export const VIEWER_INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Recall backup</title>
<link rel="stylesheet" href="viewer/recall-content.css">
<link rel="stylesheet" href="viewer/katex/katex.min.css">
<link rel="stylesheet" href="viewer/recall-viewer.css">
</head>
<body>
<div id="rv-app">
  <main class="rv-boot">
    <h1>Recall backup</h1>
    <p id="rv-boot-message">This page shows what is in a Recall backup, with no internet and no account.</p>
    <p><strong>Nothing showing?</strong> Extract (unzip) the whole backup into a folder first, then open <code>index.html</code> from that folder. A backup ending in <code>.recall</code> is a zip: rename it to <code>.zip</code> to extract it.</p>
    <p>To get these files back into Recall, open Recall and choose My Files → ⋯ → Restore backup (or Import), then pick the backup file itself.</p>
  </main>
</div>
<script src="viewer/recall-viewer.js"></script>
<script src="viewer/library.js"></script>
<script>window.RecallViewerStart && window.RecallViewerStart();</script>
</body>
</html>
`;

export const VIEWER_STYLE_CSS = String.raw`/* Recall offline viewer — the page's own look. The rendered notes are styled by
   recall-content.css (Recall's own stylesheets) when it is there. */
:root {
  --rv-bg: var(--bg, #f4f2ec);
  --rv-panel: var(--panel, #fffdf8);
  --rv-card: var(--card, #ffffff);
  --rv-text: var(--text, #161a18);
  --rv-muted: var(--muted, #66706b);
  --rv-line: var(--line, #ddd8cc);
  --rv-accent: var(--accent, #0f766e);
  --rv-radius: 10px;
  color-scheme: light;
}
:root[data-rv-mode="dark"] {
  --rv-bg: var(--bg, #101113);
  --rv-panel: var(--panel, #181a1d);
  --rv-card: var(--card, #1d2024);
  --rv-text: var(--text, #f1f3f4);
  --rv-muted: var(--muted, #9aa3a8);
  --rv-line: var(--line, #333841);
  --rv-accent: var(--accent, #7cc7d8);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--rv-bg); color: var(--rv-text); }
body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; overflow-x: hidden; }
a { color: var(--rv-accent); }
button, select, input { font: inherit; color: inherit; }
button { cursor: pointer; }
.rv-boot { max-width: 720px; margin: 10vh auto; padding: 0 16px; }
.rv-top { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 10px 16px; background: var(--rv-panel); border-bottom: 1px solid var(--rv-line); }
.rv-top h1 { font-size: 1.1rem; margin: 0; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-top .rv-sub { color: var(--rv-muted); font-size: 0.85rem; }
.rv-btn { border: 1px solid var(--rv-line); background: var(--rv-card); border-radius: 8px; padding: 5px 11px; line-height: 1.3; }
.rv-btn:hover { border-color: var(--rv-accent); }
.rv-btn[aria-pressed="true"], .rv-btn.is-on { background: var(--rv-accent); color: var(--rv-bg); border-color: var(--rv-accent); }
.rv-btn:disabled { opacity: 0.45; cursor: default; }
.rv-input, .rv-select { border: 1px solid var(--rv-line); background: var(--rv-card); border-radius: 8px; padding: 5px 9px; min-width: 0; }
.rv-wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
.rv-note { background: var(--rv-panel); border: 1px solid var(--rv-line); border-radius: var(--rv-radius); padding: 12px 14px; margin: 0 0 14px; font-size: 0.92rem; }
.rv-note.is-warn { border-color: #d97706; }
.rv-note p { margin: 0.25em 0; }
.rv-search { width: 100%; padding: 9px 12px; font-size: 1rem; margin: 0 0 14px; }
.rv-folder > summary { cursor: pointer; font-weight: 600; padding: 6px 4px; list-style: none; }
.rv-folder > summary::-webkit-details-marker { display: none; }
.rv-folder > summary::before { content: "▸ "; color: var(--rv-muted); }
.rv-folder[open] > summary::before { content: "▾ "; }
.rv-folder .rv-folder { margin-left: 16px; }
.rv-count { color: var(--rv-muted); font-weight: 400; font-size: 0.85rem; }
.rv-folder-none { font-size: 0.95rem; margin: 4px 4px 0; color: var(--rv-muted); font-weight: 600; }
.rv-files { list-style: none; margin: 0 0 6px 16px; padding: 0; }
.rv-file { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 8px 10px; border: 1px solid var(--rv-line);
  background: var(--rv-card); border-radius: var(--rv-radius); margin: 6px 0; cursor: pointer; }
.rv-file:hover, .rv-file:focus { border-color: var(--rv-accent); outline: none; }
.rv-file-title { font-weight: 600; flex: 1 1 220px; min-width: 0; overflow-wrap: anywhere; }
.rv-badge { font-size: 0.78rem; color: var(--rv-muted); border: 1px solid var(--rv-line); border-radius: 999px; padding: 0 8px; white-space: nowrap; }
.rv-snippet { flex-basis: 100%; color: var(--rv-muted); font-size: 0.85rem; overflow-wrap: anywhere; }
.rv-snippet mark { background: #fde68a; color: #111; }
.rv-tabs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rv-tab { border: 1px solid var(--rv-line); background: var(--rv-card); border-radius: 999px; padding: 4px 12px; }
.rv-tab[aria-selected="true"] { background: var(--rv-accent); color: var(--rv-bg); border-color: var(--rv-accent); }
.rv-tab.is-beside { box-shadow: inset 0 0 0 2px var(--rv-accent); }
.rv-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; padding: 14px 16px; }
.rv-body.is-split { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
@media (max-width: 860px) { .rv-body.is-split { grid-template-columns: minmax(0, 1fr); } }
.rv-pane { min-width: 0; background: var(--rv-panel); border: 1px solid var(--rv-line); border-radius: var(--rv-radius); }
.rv-pane-head { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--rv-line); }
.rv-pane-head h2 { font-size: 1rem; margin: 0 auto 0 0; }
.rv-pane-body { padding: 14px 16px; min-width: 0; }
.rv-body.is-split .rv-pane-body { max-height: calc(100vh - 150px); overflow: auto; }
.rv-empty { color: var(--rv-muted); font-style: italic; }
/* Notes */
.rv-notes-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.rv-notes-layout.has-toc { grid-template-columns: minmax(160px, 240px) minmax(0, 1fr); }
@media (max-width: 700px) { .rv-notes-layout.has-toc { grid-template-columns: minmax(0, 1fr); } }
.rv-body.is-split .rv-notes-layout.has-toc { grid-template-columns: minmax(0, 1fr); }
.rv-body.is-split .rv-toc, .rv-notes-layout.has-toc .rv-toc:only-child { position: static; border-right: 0; border-bottom: 1px solid var(--rv-line); max-height: 30vh; padding: 0 0 8px; }
@media (max-width: 700px) { .rv-toc { position: static; border-right: 0; border-bottom: 1px solid var(--rv-line); max-height: 30vh; padding: 0 0 8px; } }
.rv-toc { font-size: 0.88rem; border-right: 1px solid var(--rv-line); padding-right: 10px; max-height: 70vh; overflow: auto; position: sticky; top: 70px; align-self: start; }
.rv-toc a { display: block; padding: 2px 0; text-decoration: none; color: var(--rv-text); overflow-wrap: anywhere; }
.rv-toc a:hover { color: var(--rv-accent); }
.rv-rendered { overflow-wrap: anywhere; }
.rv-rendered img { max-width: 100%; height: auto; cursor: zoom-in; }
.rv-rendered pre { overflow: auto; }
.rv-rendered table { border-collapse: collapse; display: block; overflow-x: auto; }
.rv-rendered th, .rv-rendered td { border: 1px solid var(--rv-line); padding: 4px 8px; }
.rv-rendered mark[data-note] { cursor: help; text-decoration: underline dotted; }
.rv-rendered .cloze { cursor: pointer; }
.rv-rendered .cloze:not(.is-revealed) { color: transparent; background: color-mix(in srgb, var(--rv-accent) 18%, transparent); border-radius: 4px; }
.rv-find-hit { background: #fde68a; color: #111; }
.rv-find-hit.is-current { background: #f59e0b; }
.viewer-plain p { white-space: normal; }
.viewer-missing-picture { color: var(--rv-muted); font-style: italic; }
/* Cards */
.rv-card { border: 1px solid var(--rv-line); background: var(--rv-card); border-radius: var(--rv-radius); padding: 10px 14px; margin: 0 0 10px; }
.rv-card-q { font-weight: 500; }
.rv-card-a { border-top: 1px dashed var(--rv-line); margin-top: 8px; padding-top: 8px; }
.rv-card-meta { display: flex; justify-content: space-between; color: var(--rv-muted); font-size: 0.8rem; margin-bottom: 4px; }
.rv-status-known { color: #16a34a; }
.rv-status-review { color: #d97706; }
.rv-study { max-width: 760px; margin: 0 auto; }
.rv-study .rv-card { min-height: 220px; padding: 18px 22px; font-size: 1.08rem; }
.rv-study-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; margin: 12px 0; }
.rv-study-count { color: var(--rv-muted); min-width: 90px; text-align: center; }
/* PDFs */
.rv-pdf-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 300px); gap: 12px; }
@media (max-width: 860px) { .rv-pdf-layout { grid-template-columns: minmax(0, 1fr); } }
.rv-body.is-split .rv-pdf-layout { grid-template-columns: minmax(0, 1fr); }
.rv-pdf-frame { width: 100%; height: 78vh; border: 1px solid var(--rv-line); border-radius: 8px; background: #fff; }
.rv-marks { font-size: 0.88rem; max-height: 78vh; overflow: auto; }
.rv-mark { border-left: 4px solid var(--rv-line); padding: 4px 8px; margin: 0 0 8px; cursor: pointer; background: var(--rv-card); border-radius: 0 6px 6px 0; }
.rv-mark:hover { background: color-mix(in srgb, var(--rv-accent) 10%, var(--rv-card)); }
.rv-mark-page { color: var(--rv-muted); font-size: 0.78rem; }
.rv-mark-note { color: var(--rv-muted); font-style: italic; white-space: pre-wrap; }
/* Canvas */
.rv-pages { display: flex; flex-direction: column; align-items: center; gap: 18px; }
.rv-page { position: relative; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,.25); background: #fff; overflow: hidden; color: #16181d; }
.rv-page > svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.rv-box { position: absolute; overflow: hidden; transform-origin: 50% 50%; display: flex; flex-direction: column; color: #16181d; }
.rv-box.is-card { border: 1px solid rgba(0,0,0,.18); border-radius: calc(var(--pt, 1) * 4px); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.rv-box.is-outline { border: 1px solid rgba(0,0,0,.45); }
.rv-box.is-shaped { border: 0; box-shadow: none; background: transparent !important; overflow: visible; }
.rv-box.is-shaped > svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.rv-box .rv-rendered { position: relative; line-height: 1.35; }
.rv-box .rv-rendered > :first-child { margin-top: 0; }
.rv-box .rv-rendered > :last-child { margin-bottom: 0; }
.rv-box.is-picture img { width: 100%; height: 100%; object-fit: contain; display: block; }
.rv-words { position: absolute; overflow: visible; line-height: 1.25; transform-origin: 50% 50%; }
.rv-words .rv-rendered p { margin: 0; }
.rv-page-number { position: absolute; left: 0; right: 0; bottom: 1.5%; text-align: center; color: #6b7280; font-size: calc(var(--pt, 1) * 9px); }
.rv-zoom { color: var(--rv-muted); min-width: 52px; text-align: center; }
/* Overlays */
.rv-pop { position: fixed; z-index: 50; max-width: min(420px, calc(100vw - 32px)); background: var(--rv-panel); border: 1px solid var(--rv-line);
  border-radius: var(--rv-radius); padding: 10px 14px; box-shadow: 0 8px 28px rgba(0,0,0,.25); }
.rv-lightbox { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.82); display: flex; align-items: center; justify-content: center; padding: 16px; cursor: zoom-out; }
.rv-lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; background: #fff; }
.rv-foot { color: var(--rv-muted); font-size: 0.8rem; text-align: center; padding: 18px 16px 30px; }
@media print { .rv-top, .rv-pane-head, .rv-foot { display: none; } .rv-pane { border: 0; } }
`;

export const VIEWER_SCRIPT_JS = String.raw`/* Recall offline viewer.
   Opened from index.html with no server, no network and no account. Shows the
   files in a Recall backup: their Cards, Notes, PDFs and Canvas, out of the
   zip itself. Read only: nothing here changes the backup. */
(function () {
  "use strict";
  var lib = null;
  var files = {};
  var waiting = {};
  var view = { file: "", part: "", beside: "", q: "" };
  var studyState = {};
  var app = null;

  var PART_LABEL = { cards: "Cards", notes: "Notes", pdfs: "PDFs", canvas: "Canvas" };
  var PART_ORDER = ["cards", "notes", "pdfs", "canvas"];

  // The theme, the zoom and the contents switch, remembered by this browser
  // for pages opened from this folder. Nothing else is ever stored.
  var STORE_PREFIX = "recall-viewer:";
  function store(key, value) {
    try {
      var box = window.localStorage;
      if (value === undefined) return box.getItem(STORE_PREFIX + key);
      box.setItem(STORE_PREFIX + key, value);
    } catch (e) { return null; }
    return null;
  }

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (kid) { if (kid !== null && kid !== undefined) node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid); });
    return node;
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function fmtDate(iso) { if (!iso) return ""; var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(); }

  // ── Theme ───────────────────────────────────────────────────────────
  function systemDark() { try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { return false; } }
  function applyTheme(id) {
    var root = document.documentElement;
    var theme = (lib && lib.themes || []).filter(function (t) { return t.id === id; })[0];
    if (!id || id === "auto") {
      if (systemDark()) { root.setAttribute("data-theme", "dark-graphite"); root.setAttribute("data-rv-mode", "dark"); }
      else { root.removeAttribute("data-theme"); root.removeAttribute("data-rv-mode"); }
      return;
    }
    if (id === "light") { root.removeAttribute("data-theme"); root.removeAttribute("data-rv-mode"); return; }
    root.setAttribute("data-theme", id);
    if (theme && theme.mode === "dark") root.setAttribute("data-rv-mode", "dark"); else root.removeAttribute("data-rv-mode");
  }
  function themePicker() {
    var current = store("theme") || "auto";
    var select = h("select", { "class": "rv-select", "aria-label": "Theme", onchange: function () { store("theme", select.value); applyTheme(select.value); } }, [
      h("option", { value: "auto", text: "Theme: like this computer" }),
      h("option", { value: "light", text: "Light" })
    ].concat((lib.themes || []).map(function (t) { return h("option", { value: t.id, text: t.label }); })));
    select.value = current;
    return select;
  }

  // ── Routing: the address keeps your place ───────────────────────────
  function readHash() {
    var out = { file: "", part: "", beside: "", q: "" };
    String(location.hash || "").replace(/^#/, "").split("&").forEach(function (pair) {
      var i = pair.indexOf("=");
      if (i < 0) return;
      var k = pair.slice(0, i);
      var v = decodeURIComponent(pair.slice(i + 1));
      if (k in out) out[k] = v;
    });
    return out;
  }
  function go(next) {
    var parts = [];
    ["file", "part", "beside", "q"].forEach(function (k) { if (next[k]) parts.push(k + "=" + encodeURIComponent(next[k])); });
    var hash = "#" + parts.join("&");
    if (location.hash === hash || (hash === "#" && !location.hash)) { route(); return; }
    location.hash = hash;
  }
  function route() {
    view = readHash();
    closeOverlays();
    if (view.file) openFile(view.file); else renderHome();
  }

  // ── Loading a file's data ───────────────────────────────────────────
  function loadFile(id, done) {
    if (files[id]) { done(files[id]); return; }
    (waiting[id] = waiting[id] || []).push(done);
    if (waiting[id].length > 1) return;
    var script = document.createElement("script");
    script.src = "viewer/files/" + id + ".js";
    script.onerror = function () {
      var list = waiting[id] || []; delete waiting[id];
      list.forEach(function (fn) { fn(null); });
    };
    document.body.appendChild(script);
  }
  window.RecallViewerFile = function (id, data) {
    files[id] = data;
    var list = waiting[id] || []; delete waiting[id];
    list.forEach(function (fn) { fn(data); });
  };
  window.RecallViewerLibrary = function (data) { lib = data; };

  // ── Home: the library ───────────────────────────────────────────────
  function filesIn(folder) { return lib.files.filter(function (f) { return (f.folder || "") === folder; }); }
  function badges(f) {
    var out = [];
    if (f.cards) out.push(h("span", { "class": "rv-badge", text: plural(f.cards, "card") }));
    if (f.hasNotes) out.push(h("span", { "class": "rv-badge", text: "Notes" }));
    if (f.pdfs) out.push(h("span", { "class": "rv-badge", text: plural(f.pdfs, "PDF") }));
    if (f.canvasPages) out.push(h("span", { "class": "rv-badge", text: "Canvas · " + plural(f.canvasPages, "page") }));
    return out;
  }
  function fileRow(f, snippet) {
    var row = h("li", { "class": "rv-file", tabindex: "0", role: "link", "data-file": f.id,
      onclick: function () { go({ file: f.id }); },
      onkeydown: function (e) { if (e.key === "Enter") go({ file: f.id }); } },
      [h("span", { "class": "rv-file-title", text: f.title })].concat(badges(f)));
    if (snippet) row.appendChild(snippet);
    return row;
  }
  function folderTree() {
    var sep = "/";
    var root = { name: "", path: "", kids: {}, files: [] };
    lib.files.forEach(function (f) {
      var node = root;
      String(f.folder || "").split(sep).filter(Boolean).forEach(function (seg) {
        var path = node.path ? node.path + sep + seg : seg;
        node = node.kids[seg] = node.kids[seg] || { name: seg, path: path, kids: {}, files: [] };
      });
      node.files.push(f);
    });
    (lib.folders || []).forEach(function (folder) {
      var node = root;
      String(folder || "").split(sep).filter(Boolean).forEach(function (seg) {
        var path = node.path ? node.path + sep + seg : seg;
        node = node.kids[seg] = node.kids[seg] || { name: seg, path: path, kids: {}, files: [] };
      });
    });
    function count(node) { var n = node.files.length; Object.keys(node.kids).forEach(function (k) { n += count(node.kids[k]); }); return n; }
    function draw(node) {
      var bits = [];
      // Files in no folder first, named as such, so they are not read as the
      // last folder's.
      if (node === root && node.files.length && Object.keys(node.kids).length) {
        bits.push(h("h2", { "class": "rv-folder-none", text: "Not in a folder" }));
        bits.push(h("ul", { "class": "rv-files" }, node.files.slice().sort(function (a, b) { return a.title.localeCompare(b.title); }).map(function (f) { return fileRow(f); })));
      }
      Object.keys(node.kids).sort(function (a, b) { return a.localeCompare(b); }).forEach(function (k) {
        var kid = node.kids[k];
        var details = h("details", { "class": "rv-folder", open: true }, [
          h("summary", null, ["📁 " + kid.name + " ", h("span", { "class": "rv-count", text: "(" + plural(count(kid), "file") + ")" })])
        ]);
        draw(kid).forEach(function (b) { details.appendChild(b); });
        bits.push(details);
      });
      if (node.files.length && !(node === root && Object.keys(node.kids).length)) {
        bits.push(h("ul", { "class": "rv-files" }, node.files.slice().sort(function (a, b) { return a.title.localeCompare(b.title); }).map(function (f) { return fileRow(f); })));
      }
      return bits;
    }
    return draw(root);
  }
  function searchResults(q) {
    var words = q.toLowerCase().split(/\s+/).filter(Boolean);
    var hits = lib.files.filter(function (f) { return words.every(function (w) { return f.search.indexOf(w) >= 0 || f.title.toLowerCase().indexOf(w) >= 0; }); });
    if (!hits.length) return [h("p", { "class": "rv-empty", text: "No file has all of those words." })];
    return [h("ul", { "class": "rv-files" }, hits.map(function (f) {
      var at = f.search.indexOf(words[0]);
      var snippet = null;
      if (at >= 0) {
        var from = Math.max(0, at - 60);
        var text = (from ? "…" : "") + f.search.slice(from, at + 120) + "…";
        snippet = h("span", { "class": "rv-snippet" });
        var i = text.indexOf(words[0]);
        snippet.appendChild(document.createTextNode(text.slice(0, i)));
        snippet.appendChild(h("mark", { text: text.slice(i, i + words[0].length) }));
        snippet.appendChild(document.createTextNode(text.slice(i + words[0].length)));
      }
      var row = fileRow(f, snippet);
      row.onclick = function () { go({ file: f.id, q: q }); };
      return row;
    }))];
  }
  function renderHome() {
    document.title = (lib.title || "Recall backup") + " — Recall";
    var cards = 0; lib.files.forEach(function (f) { cards += f.cards || 0; });
    var results = h("div", { "class": "rv-results" });
    var search = h("input", { "class": "rv-input rv-search", type: "search", placeholder: "Search every file's title, Notes and Cards", "aria-label": "Search",
      value: view.q || "",
      oninput: function () { fill(); } });
    function fill() {
      results.innerHTML = "";
      var q = search.value.trim();
      (q ? searchResults(q) : folderTree()).forEach(function (n) { results.appendChild(n); });
    }
    var missing = lib.missing || {};
    var notes = [];
    var isShare = lib.kind === "share";
    notes.push(h("div", { "class": "rv-note" }, [
      h("p", null, [h("strong", { text: "A read-only copy. " }), "Everything here opens offline, from this folder: pictures, PDFs and Canvas pages included. Nothing you do on this page is saved."]),
      h("p", { text: isShare
        ? "To have these files in Recall: open Recall → My Files → ⋯ → Import, and pick the backup file (the .recall or .zip, not this page)."
        : "To put these files back into Recall: open Recall → My Files → ⋯ → Restore backup, and pick the backup file (the .recall or .zip, not this page)." })
    ]));
    var gaps = [];
    if (missing.images) gaps.push(plural(missing.images, "picture") + " could not be copied in, so " + (missing.images === 1 ? "it shows" : "they show") + " from the web when you are online");
    if (missing.pdfs && missing.pdfs.length) gaps.push(plural(missing.pdfs.length, "PDF") + " could not be read when the backup was made (" + missing.pdfs.slice(0, 5).join(", ") + ")");
    if (gaps.length) notes.push(h("div", { "class": "rv-note is-warn" }, gaps.map(function (g) { return h("p", { text: g + "." }); })));

    app.innerHTML = "";
    app.appendChild(h("header", { "class": "rv-top" }, [
      h("h1", { text: lib.title || (isShare ? "Recall files" : "Recall library backup") }),
      h("span", { "class": "rv-sub", text: plural(lib.files.length, "file") + " · " + plural(cards, "card") + (lib.exportedAt ? " · made " + fmtDate(lib.exportedAt) : "") }),
      themePicker()
    ]));
    var wrap = h("main", { "class": "rv-wrap" }, notes.concat([search, results]));
    app.appendChild(wrap);
    app.appendChild(h("footer", { "class": "rv-foot", text: "Recall offline viewer · backup format " + (lib.version || 1) + (lib.build ? " · app build " + lib.build : "") }));
    fill();
    if (view.q) search.focus();
  }

  // ── A file ──────────────────────────────────────────────────────────
  function partsOf(data) {
    var out = [];
    if (data.cards && data.cards.length) out.push("cards");
    if (data.notes) out.push("notes");
    if (data.pdfs && data.pdfs.length) out.push("pdfs");
    if (data.canvas) out.push("canvas");
    return out;
  }
  function openFile(id) {
    var summary = lib.files.filter(function (f) { return f.id === id; })[0];
    if (!summary) { go({}); return; }
    app.innerHTML = "";
    app.appendChild(h("main", { "class": "rv-wrap" }, [h("p", { text: "Opening " + summary.title + "…" })]));
    loadFile(id, function (data) {
      if (!data) {
        app.innerHTML = "";
        app.appendChild(h("main", { "class": "rv-wrap" }, [
          h("p", { text: "This file's page (viewer/files/" + id + ".js) is not in this folder. Extract the whole backup, then open index.html again." }),
          h("button", { "class": "rv-btn", text: "← Library", onclick: function () { go({}); } })
        ]));
        return;
      }
      renderFile(data);
    });
  }
  function renderFile(data) {
    document.title = data.title + " — Recall";
    var parts = partsOf(data);
    var part = parts.indexOf(view.part) >= 0 ? view.part : (parts.indexOf("notes") >= 0 ? "notes" : parts[0]);
    var beside = view.beside && view.beside !== part && parts.indexOf(view.beside) >= 0 ? view.beside : "";
    var tabs = h("div", { "class": "rv-tabs", role: "tablist" }, parts.map(function (p) {
      return h("button", { "class": "rv-tab" + (p === beside ? " is-beside" : ""), role: "tab", "aria-selected": p === part ? "true" : "false", "data-part": p,
        text: PART_LABEL[p] + (p === "cards" ? " (" + data.cards.length + ")" : ""),
        onclick: function () { go({ file: data.id, part: p, beside: beside === p ? "" : beside }); } });
    }));
    var besideSelect = null;
    if (parts.length > 1) {
      besideSelect = h("select", { "class": "rv-select", "aria-label": "Side by side", "data-beside": "",
        onchange: function () { go({ file: data.id, part: part, beside: besideSelect.value }); } },
        [h("option", { value: "", text: "Side by side: off" })].concat(parts.filter(function (p) { return p !== part; }).map(function (p) {
          return h("option", { value: p, text: "Side by side: " + PART_LABEL[p] });
        })));
      besideSelect.value = beside;
    }
    app.innerHTML = "";
    app.appendChild(h("header", { "class": "rv-top" }, [
      h("button", { "class": "rv-btn", text: "← Library", onclick: function () { go({ q: view.q }); } }),
      h("h1", { text: data.title, title: data.folder ? data.folder + " / " + data.title : data.title }),
      tabs,
      besideSelect,
      themePicker()
    ]));
    var body = h("div", { "class": "rv-body" + (beside ? " is-split" : "") });
    if (!parts.length) body.appendChild(h("div", { "class": "rv-pane" }, [h("div", { "class": "rv-pane-body" }, [h("p", { "class": "rv-empty", text: "This file is empty." })])]));
    else {
      body.appendChild(renderPart(data, part));
      if (beside) body.appendChild(renderPart(data, beside));
    }
    app.appendChild(body);
    if (data.updatedAt || data.folder) app.appendChild(h("footer", { "class": "rv-foot", text: (data.folder ? "Folder: " + data.folder + " · " : "") + (data.updatedAt ? "Last changed " + fmtDate(data.updatedAt) : "") }));
    window.scrollTo(0, 0);
  }
  function pane(title, tools, content, part) {
    return h("section", { "class": "rv-pane", "data-pane": part }, [
      h("div", { "class": "rv-pane-head" }, [h("h2", { text: title })].concat(tools || [])),
      h("div", { "class": "rv-pane-body" }, [content])
    ]);
  }
  function renderPart(data, part) {
    if (part === "notes") return notesPane(data);
    if (part === "cards") return cardsPane(data);
    if (part === "pdfs") return pdfsPane(data);
    return canvasPane(data);
  }

  // Wire up what rendered markdown does: clozes reveal, highlight notes show,
  // pictures open big.
  function liven(root, data) {
    root.addEventListener("click", function (e) {
      var cloze = e.target.closest && e.target.closest(".cloze");
      if (cloze) { cloze.classList.toggle("is-revealed"); e.preventDefault(); return; }
      var mark = e.target.closest && e.target.closest("mark[data-note]");
      if (mark && data.highlightNotes && data.highlightNotes[mark.getAttribute("data-note")]) {
        showPop(mark, data.highlightNotes[mark.getAttribute("data-note")]); e.preventDefault(); return;
      }
      if (e.target.tagName === "IMG" && !e.target.closest("a")) { showLightbox(e.target.getAttribute("src"), e.target.getAttribute("alt")); }
    });
    root.querySelectorAll(".cloze").forEach(function (c) {
      c.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { c.classList.toggle("is-revealed"); e.preventDefault(); } });
    });
    root.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (/^recall:|^\[\[/.test(href)) { a.removeAttribute("href"); a.title = "A link to another Recall file — opens in Recall"; }
      else if (!/^#/.test(href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    });
  }

  // ── Notes ───────────────────────────────────────────────────────────
  function notesPane(data) {
    var body = h("div", { "class": "rv-rendered rendered notes-rendered", html: data.notes });
    liven(body, data);
    var headings = Array.prototype.slice.call(body.querySelectorAll("h1, h2, h3, h4"));
    var layout = h("div", { "class": "rv-notes-layout" });
    var toc = null;
    if (headings.length > 1) {
      toc = h("nav", { "class": "rv-toc", "aria-label": "Contents" }, headings.map(function (node, i) {
        if (!node.id) node.id = "rv-h-" + i;
        var depth = Number(node.tagName.slice(1));
        return h("a", { href: "#", style: "padding-left:" + ((depth - 1) * 12) + "px", text: node.textContent,
          onclick: function (e) { e.preventDefault(); node.scrollIntoView({ behavior: "smooth", block: "start" }); } });
      }));
      if (store("toc") !== "off") { layout.classList.add("has-toc"); layout.appendChild(toc); }
    }
    layout.appendChild(body);
    var tools = [];
    if (toc) {
      tools.push(h("button", { "class": "rv-btn", "aria-pressed": layout.classList.contains("has-toc") ? "true" : "false", text: "Contents",
        onclick: function (e) {
          var on = !layout.classList.contains("has-toc");
          layout.classList.toggle("has-toc", on);
          if (on) layout.insertBefore(toc, body); else if (toc.parentNode) toc.parentNode.removeChild(toc);
          e.currentTarget.setAttribute("aria-pressed", on ? "true" : "false");
          store("toc", on ? "on" : "off");
        } }));
    }
    if (body.querySelector(".cloze")) {
      tools.push(h("button", { "class": "rv-btn", text: "Reveal all", onclick: function (e) {
        var all = body.querySelectorAll(".cloze");
        var hide = body.querySelectorAll(".cloze.is-revealed").length === all.length;
        all.forEach(function (c) { c.classList.toggle("is-revealed", !hide); });
        e.currentTarget.textContent = hide ? "Reveal all" : "Hide all";
      } }));
    }
    tools = tools.concat(findTools(body));
    var out = pane("Notes", tools, layout, "notes");
    if (view.q && view.file === data.id) setTimeout(function () { var input = out.querySelector(".rv-find"); if (input) { input.value = view.q; input.dispatchEvent(new Event("input")); } }, 0);
    return out;
  }

  // Find in this part: every hit marked, Enter steps through them.
  function findTools(root) {
    var hits = [];
    var at = -1;
    var count = h("span", { "class": "rv-count" });
    function clear() {
      root.querySelectorAll("mark.rv-find-hit").forEach(function (m) {
        var parent = m.parentNode; parent.replaceChild(document.createTextNode(m.textContent), m); parent.normalize();
      });
      hits = []; at = -1;
    }
    function find(q) {
      clear();
      q = q.trim().toLowerCase();
      if (q.length < 2) { count.textContent = ""; return; }
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(function (node) {
        var text = node.nodeValue;
        var lower = text.toLowerCase();
        var i = lower.indexOf(q);
        if (i < 0 || (node.parentNode && node.parentNode.closest && node.parentNode.closest("script,style,svg,.katex-mathml"))) return;
        var frag = document.createDocumentFragment();
        var last = 0;
        while (i >= 0) {
          frag.appendChild(document.createTextNode(text.slice(last, i)));
          var m = h("mark", { "class": "rv-find-hit", text: text.slice(i, i + q.length) });
          hits.push(m); frag.appendChild(m);
          last = i + q.length; i = lower.indexOf(q, last);
        }
        frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      });
      count.textContent = hits.length ? hits.length + " found" : "none";
      if (hits.length) step(1);
    }
    function step(dir) {
      if (!hits.length) return;
      if (at >= 0) hits[at].classList.remove("is-current");
      at = (at + dir + hits.length) % hits.length;
      hits[at].classList.add("is-current");
      hits[at].scrollIntoView({ block: "center" });
      count.textContent = (at + 1) + " of " + hits.length;
    }
    var timer = 0;
    var input = h("input", { "class": "rv-input rv-find", type: "search", placeholder: "Find", "aria-label": "Find in this part",
      oninput: function () { clearTimeout(timer); timer = setTimeout(function () { find(input.value); }, 180); },
      onkeydown: function (e) { if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); } } });
    return [input, count];
  }

  // ── Cards ───────────────────────────────────────────────────────────
  function statusLabel(s) { return s === "known" ? "Known" : s === "review" ? "Review" : ""; }
  function cardsPane(data) {
    var st = studyState[data.id] = studyState[data.id] || { mode: "list", filter: "all", order: null, at: 0, flipped: false, answers: false };
    var holder = h("div");
    function chosen() {
      var list = data.cards.map(function (c, i) { return i; }).filter(function (i) {
        var s = data.cards[i].status;
        return st.filter === "all" || (st.filter === "none" ? !s : s === st.filter);
      });
      if (st.order) list = st.order.filter(function (i) { return list.indexOf(i) >= 0; });
      return list;
    }
    function face(html, cls) { var node = h("div", { "class": "rv-rendered rendered " + cls, html: html || "<p class=\"rv-empty\">(empty)</p>" }); liven(node, data); return node; }
    function draw() {
      holder.innerHTML = "";
      var list = chosen();
      if (!list.length) { holder.appendChild(h("p", { "class": "rv-empty", text: "No cards match." })); return; }
      if (st.mode === "list") {
        list.forEach(function (i, n) {
          var c = data.cards[i];
          var answer = face(c.a, "rv-card-a");
          answer.hidden = !st.answers;
          var card = h("article", { "class": "rv-card", "data-card": String(i) }, [
            h("div", { "class": "rv-card-meta" }, [h("span", { text: "Card " + (i + 1) }), h("span", { "class": "rv-status-" + c.status, text: statusLabel(c.status) })]),
            face(c.q, "rv-card-q"),
            answer
          ]);
          card.addEventListener("dblclick", function () { answer.hidden = !answer.hidden; });
          holder.appendChild(card);
        });
        return;
      }
      if (st.at >= list.length) st.at = 0;
      var c = data.cards[list[st.at]];
      var card = h("article", { "class": "rv-card", "data-study": "" }, [
        h("div", { "class": "rv-card-meta" }, [h("span", { text: "Card " + (list[st.at] + 1) }), h("span", { "class": "rv-status-" + c.status, text: statusLabel(c.status) })]),
        face(c.q, "rv-card-q")
      ]);
      if (st.flipped) card.appendChild(face(c.a, "rv-card-a"));
      holder.appendChild(h("div", { "class": "rv-study" }, [
        card,
        h("div", { "class": "rv-study-bar" }, [
          h("button", { "class": "rv-btn", text: "← Back", disabled: st.at === 0, onclick: function () { st.at -= 1; st.flipped = false; draw(); } }),
          h("button", { "class": "rv-btn is-on", "data-flip": "", text: st.flipped ? "Hide answer" : "Show answer", onclick: function () { st.flipped = !st.flipped; draw(); } }),
          h("button", { "class": "rv-btn", text: "Next →", disabled: st.at >= list.length - 1, onclick: function () { st.at += 1; st.flipped = false; draw(); } }),
          h("span", { "class": "rv-study-count", text: (st.at + 1) + " / " + list.length })
        ]),
        h("p", { "class": "rv-empty", style: "text-align:center", text: "Space shows the answer, ← → move. Nothing is marked or saved here — study in Recall for that." })
      ]));
    }
    var filter = h("select", { "class": "rv-select", "aria-label": "Which cards", onchange: function () { st.filter = filter.value; st.at = 0; st.flipped = false; draw(); } }, [
      h("option", { value: "all", text: "All cards" }), h("option", { value: "review", text: "Marked Review" }),
      h("option", { value: "known", text: "Marked Known" }), h("option", { value: "none", text: "Not marked" })
    ]);
    filter.value = st.filter;
    var listBtn = h("button", { "class": "rv-btn", text: "List" });
    var studyBtn = h("button", { "class": "rv-btn", "data-mode": "study", text: "Study" });
    var answersBtn = h("button", { "class": "rv-btn", text: "Show answers" });
    function paintMode() {
      listBtn.setAttribute("aria-pressed", st.mode === "list" ? "true" : "false");
      studyBtn.setAttribute("aria-pressed", st.mode === "study" ? "true" : "false");
      answersBtn.hidden = st.mode !== "list";
      answersBtn.textContent = st.answers ? "Hide answers" : "Show answers";
    }
    listBtn.onclick = function () { st.mode = "list"; paintMode(); draw(); };
    studyBtn.onclick = function () { st.mode = "study"; st.flipped = false; paintMode(); draw(); };
    answersBtn.onclick = function () { st.answers = !st.answers; paintMode(); draw(); };
    var shuffle = h("button", { "class": "rv-btn", text: "Shuffle", onclick: function () {
      var order = data.cards.map(function (c, i) { return i; });
      for (var i = order.length - 1; i > 0; i -= 1) { var j = Math.floor(Math.random() * (i + 1)); var t = order[i]; order[i] = order[j]; order[j] = t; }
      st.order = order; st.at = 0; st.flipped = false; draw();
    } });
    paintMode();
    draw();
    var out = pane("Cards", [listBtn, studyBtn, answersBtn, filter, shuffle], holder, "cards");
    out.__study = function (key) {
      if (st.mode !== "study") return false;
      var list = chosen();
      if (key === " " || key === "Enter") { st.flipped = !st.flipped; draw(); return true; }
      if (key === "ArrowRight" && st.at < list.length - 1) { st.at += 1; st.flipped = false; draw(); return true; }
      if (key === "ArrowLeft" && st.at > 0) { st.at -= 1; st.flipped = false; draw(); return true; }
      return false;
    };
    return out;
  }

  // ── PDFs ────────────────────────────────────────────────────────────
  function pdfsPane(data) {
    var which = 0;
    var holder = h("div");
    var picker = null;
    if (data.pdfs.length > 1) {
      picker = h("select", { "class": "rv-select", "aria-label": "Which PDF", onchange: function () { which = Number(picker.value); draw(1); } },
        data.pdfs.map(function (p, i) { return h("option", { value: String(i), text: p.name }); }));
    }
    function draw(page) {
      var pdf = data.pdfs[which];
      holder.innerHTML = "";
      if (!pdf.file) {
        holder.appendChild(h("p", { "class": "rv-note is-warn", text: "This PDF (" + pdf.name + ") is not in the backup — it could not be read when the backup was made, or the backup was made without PDFs. Its highlights are listed below." }));
      }
      var frame = pdf.file ? h("iframe", { "class": "rv-pdf-frame", title: pdf.name, src: pdf.file + (page > 1 ? "#page=" + page : "") }) : null;
      var marks = h("div", { "class": "rv-marks" });
      if (!pdf.marks.length) marks.appendChild(h("p", { "class": "rv-empty", text: "No highlights or pen marks on this PDF." }));
      pdf.marks.forEach(function (m) {
        marks.appendChild(h("div", { "class": "rv-mark", style: m.color ? "border-left-color:" + m.color : null, title: pdf.file ? "Show page " + m.page : null,
          onclick: function () { if (frame) { frame.src = "about:blank"; setTimeout(function () { frame.src = pdf.file + "#page=" + m.page; }, 30); } } }, [
          h("div", { "class": "rv-mark-page", text: m.label + " · page " + m.page }),
          m.text ? h("div", { text: m.text }) : null,
          m.note ? h("div", { "class": "rv-mark-note", text: m.note }) : null
        ]));
      });
      var side = h("div", null, [
        pdf.file ? h("p", null, [h("a", { href: pdf.file, target: "_blank", rel: "noopener", text: "Open " + pdf.name + " on its own" })]) : null,
        h("p", { "class": "rv-count", text: (pdf.pages ? plural(pdf.pages, "page") + " · " : "") + plural(pdf.marks.length, "mark") + (pdf.blocks ? " · " + plural(pdf.blocks, "Block") + " (shown in Recall)" : "") }),
        marks
      ]);
      holder.appendChild(h("div", { "class": "rv-pdf-layout" }, [frame || h("div"), side]));
    }
    draw(1);
    return pane("PDFs", picker ? [picker] : [], holder, "pdfs");
  }

  // ── Canvas ──────────────────────────────────────────────────────────
  function canvasPane(data) {
    var canvas = data.canvas;
    var zoom = Number(store("canvas-zoom")) || 1;
    var pages = h("div", { "class": "rv-pages" });
    var zoomLabel = h("span", { "class": "rv-zoom" });
    function pct(v, of) { return (v / of * 100) + "%"; }
    function sizePages() {
      pages.querySelectorAll(".rv-page").forEach(function (node) {
        var w = Number(node.getAttribute("data-w")) || 595;
        node.style.setProperty("--pt", String(node.clientWidth / w));
      });
    }
    function paint() {
      zoomLabel.textContent = Math.round(zoom * 100) + "%";
      pages.querySelectorAll(".rv-page").forEach(function (node) {
        var w = Number(node.getAttribute("data-w")) || 595;
        node.style.maxWidth = Math.round(w * 1.4 * zoom) + "px";
      });
      sizePages();
    }
    if (!canvas.pages.length) pages.appendChild(h("p", { "class": "rv-empty", text: "This Canvas has no pages yet." }));
    canvas.pages.forEach(function (page) {
      var node = h("div", { "class": "rv-page", "data-page": String(page.n), "data-w": String(page.w), style: "aspect-ratio:" + page.w + " / " + page.h + ";background:" + (page.paper || "#fff") });
      node.innerHTML = page.svg;
      page.boxes.forEach(function (box) {
        var rot = box.rot ? "transform:rotate(" + (-box.rot) + "deg);" : "";
        var place = "left:" + pct(box.x, page.w) + ";top:" + pct(box.y, page.h) + ";width:" + pct(box.w, page.w) + ";height:" + pct(box.h, page.h) + ";" + rot;
        if (box.kind === "words") {
          var words = h("div", { "class": "rv-words", style: place + "font-size:calc(var(--pt) * " + (box.size || 12) + "px);text-align:" + (box.align || "left") + ";" + (box.bold ? "font-weight:700;" : "") + (box.color ? "color:" + box.color + ";" : "") }, [
            h("div", { "class": "rv-rendered rendered", html: box.html || "" })
          ]);
          liven(words, data);
          node.appendChild(words);
          return;
        }
        if (box.kind === "picture") {
          node.appendChild(h("div", { "class": "rv-box is-picture", style: place + "z-index:" + (2 + (box.z || 0)) },
            [box.src ? h("img", { src: box.src, alt: box.alt || "", loading: "lazy", onclick: function () { showLightbox(box.src, box.alt); } }) : h("span", { "class": "viewer-missing-picture", text: "[picture not in this backup]" })]));
          return;
        }
        // A side with no padding of its own has the app's default.
        var pad = [6, 8, 6, 8].map(function (fallback, i) { var v = box.pad && box.pad[i]; return v === null || v === undefined || v === "" ? fallback : v; });
        var frameClass = box.outline ? " is-shaped" : box.frame === "none" ? "" : box.frame === "outline" ? " is-outline" : " is-card";
        var style = place + "z-index:" + (2 + (box.z || 0)) + ";" + (box.fill && !box.outline ? "background:" + box.fill + ";" : "")
          + "padding:" + pad.map(function (p) { return "calc(var(--pt) * " + (Number(p) || 0) + "px)"; }).join(" ") + ";"
          + "font-size:calc(var(--pt) * " + (box.size || 11) + "px);text-align:" + (box.align || "left") + ";"
          + "justify-content:" + (box.valign === "middle" || box.valign === "center" ? "center" : box.valign === "bottom" ? "flex-end" : "flex-start") + ";";
        var el = h("div", { "class": "rv-box" + frameClass, style: style });
        if (box.outline) {
          el.innerHTML = "<svg viewBox=\"0 0 " + box.w + " " + box.h + "\" preserveAspectRatio=\"none\"><path d=\"" + box.outline.edge + "\" fill=\"" + (box.fill && box.fill !== "transparent" ? box.fill : "none") + "\" stroke=\"#4b5563\" stroke-width=\"1\" vector-effect=\"non-scaling-stroke\"/>" + (box.outline.marks ? "<path d=\"" + box.outline.marks + "\" fill=\"none\" stroke=\"#4b5563\" stroke-width=\"1\" vector-effect=\"non-scaling-stroke\"/>" : "") + "</svg>";
        }
        var words2 = h("div", { "class": "rv-rendered rendered", html: box.html || "" });
        el.appendChild(words2);
        liven(words2, data);
        node.appendChild(el);
      });
      if (canvas.numbers) node.appendChild(h("div", { "class": "rv-page-number", text: page.n + " / " + canvas.pages.length }));
      pages.appendChild(node);
    });
    var tools = [
      h("button", { "class": "rv-btn", text: "−", "aria-label": "Zoom out", onclick: function () { zoom = Math.max(0.4, Math.round((zoom - 0.1) * 10) / 10); store("canvas-zoom", String(zoom)); paint(); } }),
      zoomLabel,
      h("button", { "class": "rv-btn", text: "+", "aria-label": "Zoom in", onclick: function () { zoom = Math.min(3, Math.round((zoom + 0.1) * 10) / 10); store("canvas-zoom", String(zoom)); paint(); } })
    ];
    if (canvas.file) tools.push(h("a", { "class": "rv-btn", href: canvas.file, target: "_blank", rel: "noopener", text: "Paper PDF" }));
    var out = pane("Canvas · " + plural(canvas.pages.length, "page"), tools, pages, "canvas");
    setTimeout(paint, 0);
    if (window.ResizeObserver) new ResizeObserver(sizePages).observe(pages); else window.addEventListener("resize", sizePages);
    return out;
  }

  // ── Overlays ────────────────────────────────────────────────────────
  function closeOverlays() { document.querySelectorAll(".rv-pop, .rv-lightbox").forEach(function (n) { n.parentNode.removeChild(n); }); }
  function showPop(anchor, html) {
    closeOverlays();
    var pop = h("div", { "class": "rv-pop rv-rendered rendered", role: "dialog", html: html });
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    var top = r.bottom + 8;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 8);
    pop.style.top = top + "px";
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  }
  function showLightbox(src, alt) {
    if (!src) return;
    closeOverlays();
    document.body.appendChild(h("div", { "class": "rv-lightbox", role: "dialog", "aria-label": alt || "Picture", onclick: closeOverlays }, [h("img", { src: src, alt: alt || "" })]));
  }
  document.addEventListener("click", function (e) {
    if (e.target.closest && !e.target.closest(".rv-pop, mark[data-note]")) document.querySelectorAll(".rv-pop").forEach(function (n) { n.parentNode.removeChild(n); });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeOverlays(); return; }
    var tag = (e.target && e.target.tagName) || "";
    if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
    var cardsPaneNode = document.querySelector('[data-pane="cards"]');
    if (cardsPaneNode && cardsPaneNode.__study && cardsPaneNode.__study(e.key)) e.preventDefault();
  });

  window.RecallViewerStart = function () {
    app = document.getElementById("rv-app");
    if (!lib || !Array.isArray(lib.files)) {
      var msg = document.getElementById("rv-boot-message");
      if (msg) msg.textContent = "The list of files (viewer/library.js) did not load.";
      return;
    }
    applyTheme(store("theme") || "auto");
    try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { if ((store("theme") || "auto") === "auto") applyTheme("auto"); }); } catch (e) { /* older browser */ }
    window.addEventListener("hashchange", route);
    route();
  };
})();
`;
