# Recall Clipper

A tiny, standalone Chrome/Brave extension that lets you **pick or trim any part of
a web page and copy it as clean GFM Markdown** — ready to paste straight into the
**Study Notes** of a new deck in the [Recall](../recall) app.

It is completely **separate from the Recall web app**: its own folder, its own
code, no shared files, no network calls, no account. The only thing the two have
in common is the Markdown *format* — Recall Clipper produces exactly the GFM
flavour Recall's notes renderer understands (headings, lists, tables, fenced code
with language, `~~strikethrough~~`, images, and `$…$` / `$$…$$` math).

---

## Install (unpacked)

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `recall-clipper/` folder.
4. Pin the teal **Recall Clipper** icon to the toolbar if you like.

No build step. Works fully offline. Nothing is uploaded anywhere.

---

## Use

1. Go to any web page.
2. Click the **Recall Clipper** toolbar icon (or press **Alt+Shift+M**). A small
   toolbar appears at the top of the page and the tool turns on.
3. Pick your content — the picker actually **sculpts the live page** so what you
   see is what you'll copy:
   - **➕ Select** (default, or press **S**): click any block to **keep** it. Each
     kept block gets a persistent teal box with a **number** (✓ 1, ✓ 2 …) showing
     the order it will appear. Click again to unkeep.
   - **🎯 Isolate** (toggle): once you've kept some blocks, Isolate **hides
     everything else on the page**, leaving only your kept content — a live
     preview of the clip. Toggle it off to keep selecting, on to check the result.
   - **🗑 Remove** (press **R**): click any block to **actually delete it from the
     page** — the ad, the "related links" rail, the cookie banner all vanish.
     **Ctrl+Z** puts back the last removed block (press again to keep undoing).
     In Remove mode you don't have to keep anything: **whatever's left on the page
     after your deletions is auto-selected**, so you can just strip a page down to
     the good stuff and hit Copy.
   - Or skip picking entirely and just **highlight text with the mouse**, then hit
     Copy — the current selection is used as a fallback.

   The kept-block boxes are drawn in their own overlay and re-glue to their
   elements every frame, so they stay put while you scroll and survive pages that
   re-render. Every live change (removed blocks, Isolate) is **fully reversible**:
   **Clear** or closing the tool restores the page exactly as it was — the page is
   never left modified once Recall Clipper is off.
4. Choose how **Tables** are clipped (toolbar picker). A Markdown pipe table is a
   rigid grid — its header row fixes the column count and any cell past it is
   dropped — so tables built from merged cells or nested tables (a Wikipedia
   infobox is both) cannot survive the trip as Markdown:
   - **Auto** (default): simple tables become Markdown; only tables that need
     merged/nested cells are kept as HTML. Best of both, and nothing is lost.
   - **HTML — keep layout**: every table keeps its exact structure. Lossless, at
     the price of raw HTML in the Raw Markdown view.
   - **Markdown — flatten**: every table is flattened to a Markdown grid, spans
     expanded and rows padded. All the **values** survive; merged cells become an
     approximation of the original layout.

   The Copy toast reports what each table became ("2 tables as HTML, 1 as
   Markdown"), so the format is never a guess.
5. Click **Preview** to see a **rendered** preview of the Markdown (toggle
   **Rendered / Raw Markdown** at the top of the panel), then **Copy Markdown**
   (or the panel's **Copy**) to put the raw Markdown on your clipboard. The
   preview runs the clipped Markdown through **Recall's own render pipeline**, so
   math, Mermaid/nomnoml diagrams, syntax highlighting and cloze blanks appear
   exactly as they will inside a deck. (Those libraries load the first time you
   open a preview, so the plain **Copy Markdown** path stays instant.)
6. In Recall: create a **＋ New deck**, open its **Notes**, and paste.

Press **Esc** or click **✕** to turn the tool off. Double-click the "Recall
Clipper" label to dock the toolbar to the bottom if it covers something.

---

## What it converts

| Web content | Markdown out |
|---|---|
| Headings, paragraphs, bold/italic | `##`, `**`, `*` |
| Lists (nested), blockquotes | `-`, `>` |
| Code blocks | ` ```lang ` fenced, language preserved — including Medium-style `<pre>` blocks that have no inner `<code>` (kept verbatim, never escaped). When the page declares no language, it's **auto-detected from the code** (python, js/ts, bash, json, sql, css, html, java, c/c++, go, rust, ruby, yaml) |
| Tables | GFM pipe tables when the table fits that grid; **sanitised inline HTML** when it doesn't (merged cells, nested tables — e.g. a Wikipedia infobox), so no cell is ever dropped. Controlled by the **Tables** picker in the toolbar |
| Strikethrough | `~~ ~~` (double tilde, as Recall's renderer needs) |
| Links & images | `[text](url)`, `![alt](url)` (prefers real `data-src` over lazy placeholders) |
| KaTeX math (inline / display) | `$…$` / `$$…$$` (reads the original TeX) |
| `script`, `style`, `iframe`, `svg`, form controls | stripped |
| Reader chrome (Medium's "Press enter or click to view image in full size", "Zoom", …) | stripped, real captions kept |

---

## How it's built

- **Manifest V3**, minimal permissions: `activeTab` + `scripting`. It can only
  touch a tab **after you click the icon on it** — no host permissions, no
  always-on content scripts, no background network.
- `background.js` injects the picker on demand; re-injecting toggles it off.
- `content/picker.js` is the element picker + converter (runs in the page's
  isolated world). `content/picker.css` is its self-contained, `!important`-hardened UI.
- `content/recall-render.js` is a near-verbatim port of Recall's own Markdown
  render pipeline (`preprocessSpecialBlocks` → `marked` → `DOMPurify` →
  KaTeX/Prism/mermaid/nomnoml), so the preview matches a deck instead of merely
  approximating it. Keep it in sync if Recall's `app.js` pipeline changes.
- `vendor/` holds pinned copies of the **same versions Recall uses**, bundled
  locally because MV3 forbids loading them from a CDN:
  - [Turndown](https://github.com/mixmark-io/turndown) `7.1.2` + GFM plugin `1.0.2` (HTML→Markdown)
  - [marked](https://marked.js.org) `14.1.2` + [DOMPurify](https://github.com/cure53/DOMPurify) `3.1.6` (parse + sanitise)
  - `vendor/katex/` [KaTeX](https://katex.org) `0.16.11` (+ `auto-render`, woff2 fonts) — math
  - `vendor/prism/` [Prism](https://prismjs.com) `1.30.0` (core, python, autoloader, `tomorrow` theme) — syntax highlighting
  - `vendor/mermaid/` [mermaid](https://mermaid.js.org) `10.9.1` and `vendor/nomnoml/` [nomnoml](https://nomnoml.com) — diagrams
- The heavy preview libraries (KaTeX/Prism/mermaid/nomnoml) are **injected lazily**
  by `background.js` on the first Preview (`rc-load-preview-libs` message), and
  KaTeX's stylesheet is injected via `insertCSS` with its font URLs rewritten to
  the extension's `web_accessible_resources` fonts — so nothing loads until needed
  and the page's CSP can't block it.
- `tools/generate-icons.js` regenerates the PNG icons (`node tools/generate-icons.js`).

### Regenerating / testing

The conversion rules are plain functions; there's a jsdom-based smoke test in the
project notes that exercises headings, code, tables, math, lazy images and junk
stripping. Nothing in this extension imports from or writes to the Recall app.
