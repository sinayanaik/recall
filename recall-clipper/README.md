# Recall Web Clipper

One Chrome / Edge / Brave extension that brings web pages into the
[Recall](../README.md) app. Click its icon on any page and choose:

| | Shortcut | |
|---|---|---|
| 🧹 **Clean this page** | Alt+Shift+C | Remove ads, popups, cookie banners and clutter in place. Everything can be undone. |
| 📋 **Copy as Markdown** | Alt+Shift+M | Pick or trim any part of the page and copy it as clean GFM Markdown, ready to paste into a file's **Notes**. |
| 📄 **Save as PDF** | Alt+Shift+P | A PDF with selectable text, cut into pages in the right places, that **My Files → Import** names after the page with a link back to it. |

Alt+Shift+O opens the popup. It replaces the three separate extensions there
used to be (Recall Clipper, Recall Web to PDF and Recall Page Cleaner): if you
had those, remove them from `chrome://extensions`.

It ships **separately from the Recall web app**: its own folder, no imports, no
build step, no account, and nothing is uploaded anywhere. What the two share is
a *format* and a handful of deliberately duplicated functions —
`content/recall-math.js` and `content/recall-render.js` are ports of Recall's
own math scanner and render pipeline, so "what counts as math" and "what a note
looks like" mean the same thing on both sides. Both files list the `src/`
module each function came from; keep them in step.

---

## Install (unpacked)

The easiest way is from the Recall app itself: **☰ → Extensions → Recall Web
Clipper → Download .zip**, then unzip it and load the folder as below.

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `recall-clipper/` folder (the unzipped
   download, or this folder in a copy of the repository).
4. Pin the icon to the toolbar if you like.

To update, download it again, replace the folder, and press the reload arrow on
the extension's card.

---

## Clean this page

A toolbar appears on the page.

- **Auto** marks everything the chosen level would remove:
  - **Gentle**: popups, overlays, cookie banners and ads.
  - **Balanced** (the default): Gentle, plus sticky headers and footers, share
    buttons, comments, related links and newsletter boxes.
  - **Reader**: only the main article is kept.

  Click a red block to keep it, or click any other block to mark it too. A
  chip such as `Ad ×4` unmarks a whole group at once.
- **Manual**: a dashed outline follows the mouse. Click a block to mark it;
  marked blocks are **blurred and covered in red**. **↑** widens to the parent
  block, **↓** narrows back, **Space** marks, **K** keeps only that block.
- **Enter** or **Apply** removes the marked blocks. **Ctrl+Z** and
  **Ctrl+Shift+Z** undo and redo, including Apply. **Restore page** puts back
  everything the cleaner removed.
- **Remember for this site** saves what you remove as rules for that site; they
  are applied the next time you clean there, and **Forget site** clears them.
- After Apply, **Save as PDF** prints the cleaned page with your last PDF
  options, and **Copy as Markdown** opens the picker on it.

**Esc** closes the toolbar; the page stays cleaned.

## Save as PDF

The popup shows the few settings most people change:

- **What to save**: the whole page, the selected text, or a block you pick.
- **Clean first**: Off, Gentle, Balanced or Reader (the same rules as Clean this page).
- **Pages**:
  - **Smart pages** (the default). The page is cut into pages of about the
    length you choose — **one screen**, **one A4 page** (the default), **two A4
    pages**, or a custom length. Each cut goes in the best place near that
    length: before a heading if there is one, between paragraphs otherwise, and
    never through a picture, table, code block, formula or list item. Each page
    is then trimmed to exactly where its own content ends, so no page ends in
    a band of white. A list or a table longer than a page is cut between its
    items or rows (a table's header row repeats on the next page).
    With **Show the page breaks on the page first** (on by default) the page is
    laid out as it will print, each page shaded with its number and how full
    it is (amber when longer than the page length), and the cuts appear as
    dashed lines:
    - **drag** a line to move it — it snaps to the nearest clean place; hold
      **Alt** to put it before any block;
    - **click** the page to add a cut at the nearest clean place;
    - **✕** on a line removes it; **↑ / ↓** move the last cut you touched and
      **Delete** removes it;
    - **Undo / Redo** (Ctrl+Z, Ctrl+Shift+Z), **Auto** to plan the cuts again,
      or another page length;
    - then **Save PDF** (or Enter; Esc cancels).

    The bar with **Save PDF** sits at the top of the window, above anything
    the page shows (it is in the browser's top layer, so no page bar, dialog
    or transform can cover it or push it away). The popup offers the same
    while the breaks are shown — **Save PDF now** and **Cancel** — and
    Alt+Shift+P is Save PDF too.
  - **One long page**: as tall as the content (split into a few pages past
    200 in). Very tall pages are slow to scroll in any PDF reader.
  - **Paper pages**: A4, Letter, Legal, A3, A5, Tabloid or custom.
- **Images**: Original, High, Medium, Low, Custom or none. Every picture
  the print shows — from any site, CSS backgrounds included — is re-encoded
  at the size it prints: JPEG for photos, PNG for pictures with see-through
  parts or few colours (diagrams, screenshots of text). Original keeps each
  size but still turns WebP and AVIF into JPEG.
- **Margins**: none, left and right, top and bottom, all sides, or custom.

**Videos, embeds and moving pictures.** A PDF cannot play anything, so each
one prints as a picture of what it showed on the page, linked to the real
thing. Tap it in Recall's PDFs tab, or click it in any PDF reader, to open it.

- **A video or embed** (YouTube, Vimeo, a tweet, CodePen…) prints at its own
  size and place, with a ▶ on it and a line under it naming the video and its
  address. The picture is the video's **middle frame**: the first is so often
  black, a title card or a fade-in. The video is paused at the middle of its
  length with its controls bar put away, and put back afterwards where it
  was, playing if it was playing. A YouTube embed uses YouTube's own picture
  of the video's middle. A live stream, and a player from another site that
  cannot be moved (Vimeo, say), print the frame they show. If the picture comes out
  one flat colour (the embed never drew, or the video is protected), the
  video's poster is used, or YouTube's own thumbnail. An embed that could not
  load at all, and one with no picture to be had, gets a box with its link.
  The link goes to the video's own page: `youtube.com/watch?v=…` rather than
  the embed address, the post a video sits in, or the video file itself.
- **A canvas** drawn with WebGL (a map, a 3-D chart) would print blank, so it
  prints as a picture of what it showed.
- **A moving picture** (an animated GIF, WebP, PNG or AVIF) prints as its
  middle frame, linked to the moving original, with "▶ Moving picture" under
  it where that does not disturb the layout.

**More options → Videos and embeds** can make each one a box with its link
instead (as before), keep them as Chrome prints them, or hide them; **Picture
of a video or GIF** chooses *Its middle frame* or *The frame the page shows*.

**More options** holds the rest: presets, the visible-area capture, paper size
and orientation, margin sizes, scale or layout width, text size, print or
screen styles, colour scheme, shadows and effects, fonts, picture details,
fixed bars, collapsed sections, breaks before headings, embeds, header and
footer, source box, bookmarks, tagged PDF, file name and folder.

### When something goes wrong

A PDF job never leaves the page or the button stuck:

- **Cancel** is in the popup for as long as a PDF is being made; it stops the
  job and puts the page back as it was.
- A page that stops responding (frozen, or reloaded halfway) ends the job by
  itself with a message saying so, and the next Save as PDF works at once.
  If the clipper itself is stopped by Chrome, the break editor takes itself
  off the page within seconds, and the popup says what happened.
- **Saved** is only shown once Chrome reports the file written. A save that
  fails says why (disk full, folder not allowed, cancelled…) and the popup
  offers **Save again**, which saves the same PDF without making it again.
- With the popup closed, a short note on the page says when the PDF is saved,
  or why not.
- DevTools open on the tab, or a frame another extension (a password manager,
  say) put into the page, used to fail with a bare error. A frame from
  another extension is now taken out of the page while the PDF is made and
  put back afterwards; for DevTools the message says to close it.

### A PDF that opens fast

What makes a printed web page slow to open — in any PDF reader — is mostly
what Chrome's PDF engine cannot keep as vectors or as the original file. Save
as PDF keeps those out by default:

| Cause | What Chrome would write | What Save as PDF does |
|---|---|---|
| A blurred `box-shadow`, `text-shadow`, `filter: blur()`/`drop-shadow()`, `backdrop-filter` | each one a separate 300-DPI picture (a page of cards: hundreds) | leaves them out; **Keep shadows and blur effects** puts them back |
| WebP, AVIF, PNG pictures | their raw pixels, deflated — megabytes per photo | re-encodes each at the size it prints (see Images) |
| Pictures from other sites | could not be re-encoded at all without extra permission | reads them through the debugger it already uses, so no permission is needed |
| A variable web font | a Type 3 font: every letter a little drawing, slower and blurrier | **Fonts → Automatic** prints that text in the page's own fallback font; **Standard fonts only** does it for every web font but code and icon fonts |
| Bookmarks | only in a tagged PDF, which made a long page 5–6× bigger and 3–4× slower to make | bookmarks are written from the headings' named destinations; **Tagged PDF** is off unless you want it for a screen reader |

On a test page with 30 shadowed cards, four large photos from another site, a
variable font, a 120-item list and an 80-row table, the PDF went from 13.6 MB
with 133 pictures to 2.4 MB with 7, and drawing all of its pages in poppler
from 4.0 s to 1.9 s.

While a PDF is made, Chrome shows a bar saying the extension "started debugging
this browser": that is how it prints with Chrome's own engine, and the bar goes
away when the PDF is saved. The page is put back exactly as it was.

Every PDF carries the page's title, author and address, and Recall's own
fields (`/RecallSourceURL`, `/RecallSiteName`, `/RecallCapturedAt`,
`/RecallPublished`, `/RecallDescription`), which the app reads on import.
`lib/pdf-info.js` writes them, `lib/pdf-pages.js` gives each smart page its
own height and `lib/pdf-outline.js` adds the bookmarks — all as incremental
updates, leaving Chrome's bytes as they were.

Two things come back from Chrome itself, through named destinations: Chrome
writes one, with its printed page and position, for every element an in-page
link points at — even a hidden link. `content/prepare.js` gives each heading,
and the end of each smart page's content, an empty marker with an id and a
hidden link to it; the bookmarks point at the headings' destinations, and each
page is trimmed at its end marker (the height measured on screen is the
fallback where a marker cannot go, as between list items).

---

## Copy as Markdown

1. Go to any web page.
2. Click the toolbar icon and choose **Copy as Markdown** (or press **Alt+Shift+M**). A small
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
   never left modified once Copy as Markdown is off.
4. Click **Preview** to see a **rendered** preview of the Markdown (toggle
   **Rendered / Raw Markdown** at the top of the panel), then **Copy Markdown**
   (or the panel's **Copy**) to put the raw Markdown on your clipboard. The
   preview runs the clipped Markdown through **Recall's own render pipeline**, so
   math, Mermaid/nomnoml diagrams, syntax highlighting and cloze blanks appear
   exactly as they will inside a Recall file. (Those libraries load the first time you
   open a preview, so the plain **Copy Markdown** path stays instant.)
5. In Recall: create a **＋ New file**, open its **Notes**, and paste.

The Copy toast reports the decisions the clip had to make — how many tables went
to Markdown and how many to HTML, how many formulas were recovered as LaTeX, and
how many had **no readable source** (those are the only things worth checking by
eye; see *Math*, below).

Press **Esc** or click **✕** to turn the tool off. Double-click the "Copy as
Markdown" label to dock the toolbar to the bottom if it covers something.

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

- **Manifest V3**. It can only touch a tab **after you use it on that tab** —
  no always-on content scripts, no background network. Permissions:

  | Permission | Why |
  |---|---|
  | `activeTab`, `scripting` | Inject the picker or the cleaner into the tab you used it on, and nowhere else. |
  | `debugger` | Save as PDF prints with Chrome's own PDF engine (`Page.printToPDF`) and lays the page out at the print width. This is the "debugging this browser" bar. |
  | `downloads` | Saves the PDF. |
  | `offscreen` | A small hidden page (`offscreen.html`) that hands the finished PDF to downloads as a `blob:` address — a service worker cannot make one. |
  | `storage` | Your PDF options and presets, the cleaner's mode and level, and the per-site cleaning rules you chose to remember. |

  Pictures and fonts from other sites are read through the same debugger
  connection (`Page.getResourceContent`, else `Network.loadNetworkResource`),
  so no access to other sites is asked for.

- `background.js` wires the three jobs: it injects the picker or the cleaner on
  demand (re-injecting toggles either off) and hands PDF jobs to `pdf-job.js`.
- `popup.html`, `popup.css` and `popup.js` are the toolbar popup.
- `pdf-job.js` runs one PDF job per tab: attach, prepare, check the fonts,
  re-encode the pictures, find the page breaks, print, restore, trim the
  pages, add the bookmarks, stamp the metadata, download. Because it runs in
  the service worker, closing the popup does not stop it. It is built not to
  get stuck: every DevTools call has a time limit and stops the moment the
  job is cancelled; the reader's steps (picking a block, the break editor)
  are polled with short calls rather than held open for minutes; a watchdog
  stops a job that makes no progress; one cleanup puts the page back and
  detaches whatever ended the job, before the tab is free again; and the job's
  state is mirrored in `chrome.storage.session`, so a restarted worker can
  tell the popup and clean up. The PDF is printed as a stream, kept in Cache
  Storage until Chrome confirms the download, and downloaded by `blob:`
  address (`offscreen.html`), with a `data:` address as the fallback.
- `content/prepare.js` applies the PDF options to the page in an isolated world,
  plans the smart page breaks and shows them for editing, then puts every
  change back.
- `content/cleaner-core.js` is the cleaning rule engine (used by Clean this page
  and by Save as PDF's "Clean first"); `content/cleaner-ui.js` is the cleaner's
  toolbar, marking, apply and undo; `content/cleaner.css` blurs marked blocks.
- `lib/options.js` holds every PDF option, its default, the presets, the page
  geometry and the smart page lengths. `lib/pdf-info.js` writes the metadata,
  `lib/pdf-pages.js` trims each smart page to its content, `lib/pdf-outline.js`
  writes the bookmarks, `lib/pdf-objects.js` reads and appends PDF objects for
  both, `lib/font-check.js` tells a variable font by its `fvar` table (TTF,
  WOFF or WOFF2) and reads `@font-face` rules, and `lib/image-pdf.js` builds
  the PDF for the visible-area screenshot.
- `content/picker.js` is the element picker + converter (runs in the page's
  isolated world). `content/picker.css` is its self-contained, `!important`-hardened UI.
- `content/mathjax-source.js` is the only file that runs in the page's **MAIN
  world**, because `MathJax` is a page global. It copies each formula's source
  TeX onto its container and returns how many it stamped.
- `content/recall-math.js` owns everything about math: Recall's own math scanner
  (`mathSpanAt`, `findMathRanges`, `healEscapedTex`, `repairEscapedMathMarkdown`,
  `relaxEscapedBrackets`, `protectMathInDom`) ported from Recall's `src/render/*`, plus the
  MathML→LaTeX converter and `extractPageMath`. Its header lists the exact
  `src/` module each function came from.
- `content/recall-render.js` is a near-verbatim port of Recall's own Markdown
  render pipeline (`preprocessSpecialBlocks` → `marked` → `DOMPurify` →
  KaTeX/Prism/mermaid/nomnoml + table layout), so the preview matches a deck
  instead of merely approximating it. It carries the same list of module
  anchors. **Keep both in sync if Recall's render pipeline changes** — a drift
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
node tools/port-sync.mjs               # check the ports against Recall's src/
node tools/port-sync.mjs --show        # …and print anything that drifted, in full
```

**`port-sync.mjs` is the answer to "keep it in sync if Recall changes."** A note
in a header is a request; this is a check. It pulls every ported function *and
constant* out of both files and compares them modulo whitespace — 53 of them,
including `SANITIZE_CONFIG`, `INLINE_MATH_MAX_SPAN` and the citation regexes,
which are exactly the values a body can be copied perfectly around and still get
wrong. It exits non-zero on drift. The three deliberate divergences are listed in
its `DIVERGENCES` map with the reason each exists, and an entry there that stops
being true is itself reported — so the allowlist can't quietly rot either.

That is also why the ported functions keep the app's brace style and line
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
| `clutter.html` | the page `tools/extensions-browser-check.mjs` in the Recall repository cleans and saves as a PDF |
| `long.html` | smart pages, bookmarks and the break editor in the same check |
| `heavy.html` + `variable-font.woff2` | what makes a PDF slow to open — shadows, large WebP/PNG photos from another origin, a variable font (DejaVu Sans, Bitstream Vera licence, cut down to ASCII, with an `fvar` table), a long list and table — in the same check |
| `media.html` + `moving.gif` | videos, embeds and moving pictures in Save as PDF — a playing video (a canvas's stream, inside a link to a post), an embed from the same site, a YouTube embed that cannot load, a WebGL canvas and a two-frame GIF — in the same check |

Two assertions are worth more than the rest: every math span in the output is
**parsed with the KaTeX a deck actually ships** (capturing the wrong TeX is not a
success), and the clipped Markdown is run back through `recall-render.js`, which
is how the preview's fidelity to a deck is checked.

`tools/extensions-check.mjs` (no browser) and `tools/extensions-browser-check.mjs`
(Chromium, the extension loaded unpacked) in the Recall repository check the
cleaner and Save as PDF: what Auto marks, Apply and Undo, smart page breaks and
their editor (drag, add, ✕, undo), page sizes, the trimmed heights, the
bookmarks, the pictures and fonts in the heavy page's PDF against the old
defaults, the metadata, and that the page is restored afterwards. They also
check that nothing gets stuck: the editor's Save PDF is in view and uncovered
on a page that tries to hide it (a transform on `<html>`, a bar at the highest
z-index, a modal dialog) and a real mouse click on it saves; Save PDF now and
Cancel from the popup; Esc leaves no listener behind; a page frozen mid-job
ends the job on its own and frees the tab; a failed download is reported and
Save again saves it; PDFs go to downloads by `blob:` address.

`tools/generate-icons.js` regenerates the PNG icons.
Nothing in this extension imports from or writes to the Recall app.
