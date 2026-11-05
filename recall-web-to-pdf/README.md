# Recall Web to PDF

A Chrome / Edge / Brave extension that turns any web page into a PDF that
**Recall imports cleanly**. The text stays selectable, the PDF gets bookmarks
from the page's headings, and the title, source address, site and date are
written into the file. You can make one long continuous page or separate
printed pages, and choose your margins and image quality.

## Install

The easiest way is from the Recall app: open **☰ → Extensions** and download
**Recall Web to PDF**. Then:

1. Unzip it. You get a `recall-web-to-pdf` folder.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the folder.

To update, download it again, replace the folder, and press the reload arrow on
the extension's card.

## Use

Click the toolbar icon, or press **Alt+Shift+O**, choose your options, and
press **Save as PDF**. **Alt+Shift+P** saves right away with the options you
used last.

While it works, Chrome shows a bar saying the extension "started debugging this
browser". That is how it prints the page, and the bar goes away when the PDF is
saved.

To bring the PDF into Recall, open **My Files → Import** and choose it. Recall
reads the title, the source address and the capture date from the PDF. The new
file is named after the page, and its Notes start with a link back to the page.

## Options

| Group | What you can set |
|---|---|
| Capture | Whole page, selected text only, a block you pick on the page, or the visible area (that one is a screenshot, so its text is not selectable). **Clean first**: Off, Gentle, Balanced or Reader, using the same rules as Recall Page Cleaner. |
| Layout & margins | **One continuous page** (as tall as the content; a page longer than 200 in is split into a few equally tall pages, cut between blocks) or **separate pages**. Paper: A4, Letter, Legal, A3, A5, Tabloid or custom. Portrait or landscape. **Margins**: none, left and right only (the default, 12 mm), top and bottom only, all sides, or custom per side, in mm or inches. |
| Scale & text | Scale 25–200%, **or** lay the page out at a set width (desktop 1280, laptop 1024, tablet 768, phone 390, or custom), so the site's own responsive layout applies. Text size 70–160%, applied to text only. Wrap long code lines. |
| Colour & styles | The site's print styles or its screen styles. Colour scheme as the page, light or dark. Print backgrounds. Force light. |
| Images | Quality: Original, High (200 DPI, JPEG 85%, the default), Medium (150/75), Low (100/60), Custom, or No images. Grayscale. Drop small images. Load lazy images first. Images are resized to the size they print at. |
| Page handling | Hide fixed bars, which would otherwise repeat on every page. Expand collapsed sections. Don't cut images, tables, code or figures across pages. Start a new page at each H1 or H2. Videos and embeds become a link, stay as they are, or are hidden. |
| Extras | Header and footer: title, address, date, page numbers, or custom text with `{title} {url} {date} {page} {pages}`. Source box on the first page. Bookmarks from headings. Print link addresses after links. Tagged PDF. File name template (`{title} {site} {domain} {date} {time} {author}`). Folder inside Downloads. Ask where to save. Show the file in its folder when done. |
| Presets | Built in: Recall reading (default), Clean article, Print A4, Print Letter, Full page as seen, Compact. You can save your own, and your last options are remembered. |

## Metadata written into every PDF

| Field | Value |
|---|---|
| Title | The page's headline, without the " \| Site name" suffix |
| Author | The byline from the page's metadata or JSON-LD |
| Subject | The page's address (its canonical URL) |
| Keywords | The site name and the page's keywords |
| Creator | `Recall Web to PDF` |
| `/RecallSourceURL`, `/RecallSiteName`, `/RecallCapturedAt`, `/RecallPublished`, `/RecallDescription` | Custom fields Recall reads on import |

`lib/pdf-info.js` writes them as an incremental update. Chrome's PDF is left
byte for byte as it was, with a new Info dictionary and trailer appended.

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Prints the page with Chrome's own PDF engine (`Page.printToPDF`) and lays it out at the width you chose. This is what Chrome's "debugging this browser" bar refers to. |
| `activeTab` | The tab you clicked the icon on. |
| `downloads` | Saves the PDF. |
| `storage` | Your options and presets, synced through your browser profile. |
| *optional* access to all sites | Asked for only when you choose a reduced image quality and press **Allow**. It is needed to read images served from other sites so they can be resized. Without it, only the page's own images are resized. |

Nothing is uploaded anywhere. The fixed ID
(`jcggbcoegkedmplddimgefonccicnihb`, from the `key` in `manifest.json`) lets
Recall Page Cleaner's **Save as PDF** reach this extension. Only the cleaner is
allowed to ask it to print.

## Files

- `background.js` runs each job: attach, prepare, measure, print, restore,
  stamp the metadata, download. Because the job runs here, closing the popup
  does not stop it.
- `content/prepare.js` applies your options to the page in an isolated world,
  then puts every change back.
- `content/cleaner-core.js` is a **byte-identical copy** of Recall Page
  Cleaner's rule engine.
- `lib/options.js` holds every option, its default, the presets and the page
  geometry. `lib/pdf-info.js` writes the metadata. `lib/image-pdf.js` builds
  the PDF for the visible-area screenshot.
- `popup.html`, `popup.css` and `popup.js` are the options popup.

`tools/extensions-browser-check.mjs` in the Recall repository loads this
extension in Chromium and checks the page count, page width, selectable text,
metadata, image resizing and that the page is restored afterwards.
