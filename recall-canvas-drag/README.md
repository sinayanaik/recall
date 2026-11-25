# Recall Drag to Canvas

A Chrome / Edge / Brave extension that lets you drag **any part of any web
page** onto a file's **Canvas** in [Recall](../README.md): a paragraph, a box, a
card, a table, a code listing or a figure. On its own, a web page only lets you
drag a selection, a link or a picture.

| | |
|---|---|
| **Hold Alt** over a page | The part under the pointer is outlined, with a **⠿** grip above its top-left corner |
| **Alt+↑ / Alt+↓** (or Alt and the wheel) | Take in more of the page (the part around it), or less |
| **Drag the ⠿** onto a Canvas page | It lands as **Blocks** where you let go |
| **Shift** held as you let go | It lands as a **picture** of it, exactly as it looked on the page |
| **Alt+Shift+D** | Show the grips without holding Alt, on this tab, until pressed again |

Let go of Alt and the outline stays while the pointer is on it (or on its
grip), so you can drag the grip without holding anything. **Esc** takes the
outline away.

It ships **separately from the Recall web app**: its own folder, no imports, no
build step, no account. Nothing is uploaded anywhere: what you drag goes
straight into Recall, which saves the pictures with your other pictures.

---

## Install (unpacked)

The easiest way is from the Recall app itself: **☰ → Extensions → Recall Drag
to Canvas → Download .zip**, then unzip it and load the folder as below.

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `recall-canvas-drag/` folder (the
   unzipped download, or this folder in a copy of the repository).
4. Reload the pages you already had open: the extension starts in a page when
   the page loads.

To update, download it again, replace the folder, and press the reload arrow on
the extension's card.

---

## What lands on the Canvas

Open a file in Recall with its Canvas on screen (on its own, or side by side
with another part), and drag a grip from another window onto a Canvas page.

**As Blocks** (the default). The part is read the way Recall reads any web
page's HTML: headings, bold and italics, lists, tables, code (with its
language), maths (KaTeX, MathJax, MathML), links and pictures are kept, and
the Block takes the Canvas's own sizes, in the look of the last Block you
styled. Before it leaves the page, the part is cleaned:

- what the page hides (collapsed menus, screen-reader-only text) is left out,
  except the hidden source of a formula;
- scripts, styles, icons and the page's own layout are left out;
- links and picture addresses are made whole, and a picture is taken from the
  source the page actually shows (lazy-loaded pictures included);
- a drawn `<canvas>` (a chart) and a large inline `<svg>` become pictures;
- a button becomes its words, a form field its value, a video its poster
  linked to the video, an embedded frame a link.

The pictures come with the drag, as their own bytes (fetched by the
extension, which the site's own rules do not stop). Recall saves them with
your other pictures and points the Block at its copies, so they stay when the
site moves or removes them. Until then, and when you are signed out, the Block
shows them from the web page.

**As a picture**, with Shift held as you let go. When the part is picked, the
extension takes a picture of it as it is on screen (only what is in the
window; scroll it into view first if it is cut off). That picture lands at the
size the part was on the page, no wider than the Canvas page.

---

## Turning it off

Click the toolbar icon:

- **Show the grips without holding Alt**: this tab only. Same as Alt+Shift+D.
- **Off on this site**: Alt does nothing on that site. Use it on a site that
  needs Alt for itself.
- **On**: turn it off everywhere.

---

## Permissions, and why

- **Read and change all your data on all websites** (`<all_urls>`): the grip
  has to be available on any page you might drag from, so the content script
  runs on every page. It does nothing until you hold Alt or press
  Alt+Shift+D, and it never runs on Recall itself. The same permission lets
  it fetch a page's pictures and take a picture of the visible tab, both only
  for the part you are about to drag.
- **Storage**: the On / Off switches.

---

## How it works

| File | |
|---|---|
| `content/drag.js` | Runs in every page. The outline and grip live in one element in the browser's top layer with a closed shadow root, so no page can cover or restyle them; it is styled with a constructed stylesheet and built node by node, so a strict Content-Security-Policy or Trusted Types does not stop it, and the grip's press is kept from the page's own handlers. Prepares the drag as soon as the outline settles, because a drag's data has to be handed over the moment it starts. |
| `background.js` | Fetches a picture's bytes (`rdc-fetch-image`) and takes the picture of the part (`rdc-capture`, `chrome.tabs.captureVisibleTab` cropped; a PNG, or a JPEG when the PNG would be over 3 MB). Relays Alt+Shift+D. |
| `popup.html` / `popup.js` | The switches. |

The drag carries one JSON value under `application/x-recall-web-clip`:

```json
{ "v": 1, "kind": "Table", "html": "<table>…</table>", "text": "…",
  "title": "Page title", "url": "https://…",
  "images": { "https://…/figure.png": "data:image/png;base64,…" },
  "picture": { "dataUrl": "data:image/png;base64,…", "width": 1400, "height": 600,
               "cssWidth": 700, "cssHeight": 300, "cut": false } }
```

with `text/html` and `text/plain` beside it, so the same drag also drops into
any other app. Recall reads it in `src/documents/canvas-drop.js` and
`src/documents/web-clip-drop.js`.

`tools/canvas-drag-extension-check.mjs` (in the repository) loads this folder
into Chrome and drags a fixture page's card onto a Canvas page with real input,
on another origin.
