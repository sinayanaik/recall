# Recall Clipper

A tiny, standalone Chrome/Brave extension that lets you **pick or trim any part of
a web page and copy it as clean GFM Markdown** — ready to paste straight into the
**Study Notes** of a new deck in the [Recall](../recall) app.

It ships **separately from the Recall web app**: its own folder, no imports, no
build step, no network calls, no account. What the two share is a *format* and a
handful of deliberately duplicated functions — `content/recall-math.js` and
`content/recall-render.js` are ports of Recall's own math scanner and render
pipeline, so "what counts as math" and "what a note looks like" mean the same
thing on both sides. Both files list the `app.js` line each function came from;
keep them in step.

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
4. Click **Preview** to see a **rendered** preview of the Markdown (toggle
   **Rendered / Raw Markdown** at the top of the panel), then **Copy Markdown**
   (or the panel's **Copy**) to put the raw Markdown on your clipboard. The
   preview runs the clipped Markdown through **Recall's own render pipeline**, so
   math, Mermaid/nomnoml diagrams, syntax highlighting and cloze blanks appear
   exactly as they will inside a deck. (Those libraries load the first time you
   open a preview, so the plain **Copy Markdown** path stays instant.)
5. In Recall: create a **＋ New deck**, open its **Notes**, and paste.

The Copy toast reports the decisions the clip had to make — how many tables went
to Markdown and how many to HTML, how many formulas were recovered as LaTeX, and
how many had **no readable source** (those are the only things worth checking by
eye; see *Math*, below).

Press **Esc** or click **✕** to turn the tool off. Double-click the "Recall
Clipper" label to dock the toolbar to the bottom if it covers something.

---

## What it converts

| Web content | Markdown out |
|---|---|
| Headings, paragraphs, bold/italic | `##`, `**`, `*` |
| `div[role="heading"][aria-level]` (SPA docs sites) | a real `#` heading at that level |
| Lists (nested), blockquotes | `-`, `>` — with continuation lines indented to the **actual marker width**, so a two-digit ordered item (`32.  `) doesn't turn its second paragraph into a code block |
| Definition lists (`dl`/`dt`/`dd`) | `- **term** — definition` |
| Code blocks | ` ```lang ` fenced, language preserved — including Medium-style `<pre>` blocks that have no inner `<code>` (kept verbatim, never escaped). When the page declares no language, it's **auto-detected from the code** (python, js/ts, bash, json, sql, css, html, java, c/c++, go, rust, ruby, yaml). Blank lines inside a fence are left exactly as written |
| Tables | GFM pipe tables when the table fits that grid — including tables with **no `<thead>`**, whose first row is promoted to a header when it reads like one; **sanitised inline HTML** when the grid can't hold it (merged cells, nested tables — a Wikipedia infobox is both), so no cell is ever dropped. The source's own colours are stripped from the HTML form; only `text-align`, `vertical-align` and `width` survive, so a table clipped from a dark-themed site is readable in a deck |
| Math (KaTeX, MathJax 2 & 3, Wikipedia, bare MathML) | `$…$` / `$$…$$` — see *Math* below |
| Strikethrough | `~~ ~~` (double tilde, as Recall's renderer needs) |
| `sup` / `sub` | kept as HTML, so `x²` and `H₂O` don't flatten to `x2` and `H2O` |
| `mark`, `u`, `kbd`, `ins` | kept as HTML. A `<mark>` painted with a background colour is matched **by hue** onto Recall's nearest named highlight (`<mark data-color="green">`) |
| `abbr[title]` | `text (expansion)` — the title is unhoverable in a deck |
| `figure` + `figcaption` | the image, then the caption in *italics* directly beneath it |
| `details` / `summary` | a **bold** lead-in plus the body — deliberately **not** `<details>` HTML, which Recall's importer reads as flashcard syntax and would shred an FAQ page into cards |
| Callouts / admonitions (MkDocs, Docusaurus, Bootstrap alerts) | a `>` blockquote with the label in bold |
| Links & images | `[text](url)`, `![alt](url)`. Lazy placeholders (any short `data:` URI) are replaced by the real `data-src`, the **widest** `srcset` candidate, or the enclosing `<picture>`'s sources |
| `iframe` embeds (YouTube, Vimeo, CodePen, Gists) | `[▶ title](url)` — the sanitiser drops the frame on both sides, so the link is what's left to keep |
| Shadow DOM (Lit, Stencil, component-based docs) | clipped — open shadow roots are spliced into the clone in place |
| `script`, `style`, `svg`, `canvas`, form controls | stripped |
| Site chrome (nav, header, footer, sidebar, comments) | stripped **only** on the whole-page "Remove mode" clip, never when you picked or highlighted the content yourself |
| Reader chrome (Medium's "Press enter or click to view image in full size", "Zoom", …) | stripped, real captions kept |

### Math

Every rendered formula is replaced with its **original LaTeX** before anything
else touches the page (`content/recall-math.js`). Order matters and is not
negotiable: KaTeX, MathJax and Wikipedia all park the real TeX in a
`display:none` subtree, so the extraction has to run **before** the noise
scrubber deletes hidden content. Sources, in the order they're tried:

0. **MathJax's own state**, read by `content/mathjax-source.js` — see below.
1. `annotation[encoding="application/x-tex"]` — KaTeX, MathJax's MathML output,
   Wikipedia. This is the author's exact source.
2. MathJax 3: `<mjx-copytext>`, then its `<mjx-assistive-mml>` tree.
3. MathJax 2: the `<script type="math/tex">` beside the rendered span
   (`mode=display` becomes a `$$` block).
4. Wikipedia's `alttext` / fallback-image `alt`, with the `{\displaystyle …}`
   wrapper unwrapped — KaTeX renders that wrapper literally otherwise.
5. Bare **MathML** → LaTeX, via a small converter covering the presentation
   elements (`mfrac msqrt mroot msub msup msubsup munder mover munderover mfenced
   mtable …`) plus the usual operator and Greek characters.

#### Reading MathJax's source (the MAIN-world pass)

A large class of textbook and docs sites — Sphinx, **Jupyter Book**, most course
pages — ship the default MathJax 3 `tex-mml-chtml` bundle, which leaves behind
CHTML glyphs and an assistive-MathML tree and **no TeX at all**: no annotation,
no `mjx-copytext`. Route 5 can still reconstruct LaTeX from the MathML, but a
reconstruction is not the source. `\left[ \begin{array}{c} … \right]` comes back
as `[\begin{matrix} … ]` — the same equation, drawn wrong.

MathJax kept the real string the whole time, on a `MathItem` whose `typesetRoot`
*is* the `<mjx-container>` in the DOM. It's a page global, so it's invisible from
the isolated world content scripts run in. `content/mathjax-source.js` is
therefore injected into the page's **MAIN world** (`world: "MAIN"`, still under
`activeTab` — no new permissions) and copies each formula's source onto its
container as `data-recall-tex`. The picker reads it back off the attribute like
any other markup, and `destroy()` removes every stamp, so the page is left
exactly as it was found.

It runs once when you switch the picker on, and again just before each Copy or
Preview, so formulas typeset in the meantime (a lazily-loaded section, an SPA
route change) are covered. If MAIN-world injection isn't available the clip still
works — it just falls back to the MathML.

Measured end to end, clipping the whole article and parsing every captured span
with the KaTeX a deck ships:

| Page | Formulas | Render clean |
|---|---|---|
| `roboticsbook.org` (Jupyter Book, MathJax 3) | 29 | 29 |
| Wikipedia, *Mass–energy equivalence* | 34 | 34 |
| `ar5iv.labs.arxiv.org` (native MathML) | 142 | 142 |

Anything using `\begin{…}` is emitted as `$$…$$`, because a LaTeX environment
only renders inside display math in Recall. A widget that exposes **no** readable
source leaves its rendered text (or a `[math]` marker) as inline code and is
counted in the Copy toast — never silently deleted.

Two more things happen on the way out:

- **Un-rendered math** — plain `$x_k$` sitting in a paragraph — is lifted out of
  its text node before Turndown runs, so the escaper can't turn it into `$x\_k$`.
- **Currency is protected.** Recall's renderer closes an inline `$…$` on any
  later `$` preceded by a non-space character, scanning up to 1000 characters to
  find one, so a sentence like *"raised $100 million … priced at US$50"* used to
  vanish into a math span. Dollar spans whose content reads as prose rather than
  as a formula have their delimiters escaped.

---

## How it's built

- **Manifest V3**, minimal permissions: `activeTab` + `scripting`. It can only
  touch a tab **after you click the icon on it** — no host permissions, no
  always-on content scripts, no background network.
- `background.js` injects the picker on demand; re-injecting toggles it off.
- `content/picker.js` is the element picker + converter (runs in the page's
  isolated world). `content/picker.css` is its self-contained, `!important`-hardened UI.
- `content/mathjax-source.js` is the only file that runs in the page's **MAIN
  world**, because `MathJax` is a page global. It copies each formula's source
  TeX onto its container and returns how many it stamped.
- `content/recall-math.js` owns everything about math: Recall's own math scanner
  (`mathSpanAt`, `findMathRanges`, `healEscapedTex`, `repairEscapedMathMarkdown`,
  `relaxEscapedBrackets`, `protectMathInDom`) ported from `app.js`, plus the
  MathML→LaTeX converter and `extractPageMath`. Its header lists the exact
  `app.js` line each function came from.
- `content/recall-render.js` is a near-verbatim port of Recall's own Markdown
  render pipeline (`preprocessSpecialBlocks` → `marked` → `DOMPurify` →
  KaTeX/Prism/mermaid/nomnoml + table layout), so the preview matches a deck
  instead of merely approximating it. It carries the same list of `app.js` line
  anchors. **Keep both in sync if Recall's `app.js` pipeline changes** — a drift
  here doesn't break anything loudly, it just makes the preview quietly lie.
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

### Testing

```
node tools/convert.test.mjs            # 77 assertions over 4 fixtures
node tools/convert.test.mjs --print    # …and dump the produced Markdown
node tools/port-sync.mjs               # check the ports against app.js
node tools/port-sync.mjs --show        # …and print anything that drifted, in full
```

**`port-sync.mjs` is the answer to "keep it in sync if `app.js` changes."** A note
in a header is a request; this is a check. It pulls every ported function *and
constant* out of both files and compares them modulo whitespace — 53 of them,
including `SANITIZE_CONFIG`, `INLINE_MATH_MAX_SPAN` and the citation regexes,
which are exactly the values a body can be copied perfectly around and still get
wrong. It exits non-zero on drift. The three deliberate divergences are listed in
its `DIVERGENCES` map with the reason each exists, and an entry there that stops
being true is itself reported — so the allowlist can't quietly rot either.

That is also why the ported functions keep `app.js`'s brace style and line
wrapping rather than the surrounding file's: it lets the comparison stay strict,
so anything it reports is real.

The suite loads each fixture in headless Chromium, injects **exactly** what
`background.js` injects, drives the picker, and asserts on what `convert()`
returns. It has to run in a real browser: every interesting decision the picker
makes is a DOM decision (shadow roots, MathML trees, computed attributes), so a
string-level unit test would prove nothing. Chromium comes from the puppeteer
bundled with `@mermaid-js/mermaid-cli`; set `PUPPETEER_PATH` to use your own.

Fixtures live in `tools/fixtures/`:

| Fixture | Covers |
|---|---|
| `math.html` | Wikipedia (inline, display, multi-row `aligned`), MathJax 2 & 3, KaTeX (with and without MathML), bare MathML, un-rendered `$…$`, currency, prose brackets, `\begin{…}` |
| `mathjax3.html` | the MAIN-world source recovery — a page with no annotation and no copytext, where taking the MathML instead would be visibly worse |
| `structure.html` | ordered-list indentation, nested lists, `dl`, header-less and spanned tables, `sup`/`sub`, `mark`/`u`/`kbd`/`abbr`, `details`, `figure`, callouts, ARIA headings, embeds, lazy images |
| `page.html` | shadow DOM, and the whole-page "Remove mode" clip's site-chrome stripping |

Two assertions are worth more than the rest: every math span in the output is
**parsed with the KaTeX a deck actually ships** (capturing the wrong TeX is not a
success), and the clipped Markdown is run back through `recall-render.js`, which
is how the preview's fidelity to a deck is checked.

`tools/generate-icons.js` regenerates the PNG icons.
Nothing in this extension imports from or writes to the Recall app.
