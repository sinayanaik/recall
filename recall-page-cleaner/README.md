# Recall Page Cleaner

A Chrome / Edge / Brave extension that **cleans up a web page in place**: it
removes ads, cookie banners, popups, sticky bars, share buttons, comments,
"related" rails and newsletter boxes. Once the page is clean, Recall Clipper
or Recall Web to PDF can work on it.

Nothing leaves the page until you press **Apply**. Every removal can be
undone, and **Restore page** puts back everything the cleaner removed.

## Install

The easiest way is from the Recall app: open **☰ → Extensions** and download
**Recall Page Cleaner**. Then:

1. Unzip it. You get a `recall-page-cleaner` folder.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the folder.

To update, download it again, replace the folder, and press the reload arrow on
the extension's card. You can also load this folder straight from a copy of the
repository.

## Use

Click the toolbar icon, or press **Alt+Shift+C**. A toolbar appears on the
page.

- **Auto** marks everything the chosen level would remove:
  - **Gentle**: popups, overlays, cookie banners and ads.
  - **Balanced** (the default): Gentle, plus sticky headers and footers, share
    buttons, comments, related links and newsletter boxes.
  - **Reader**: only the main article is kept.

  Click a red block to keep it, or click any other block to mark it too. A
  chip such as `Ad ×4` unmarks a whole group at once.
- **Manual**: a dashed outline follows the mouse. Click a block to mark it;
  marked blocks are **blurred and covered in red**. Keys:
  - **↑** widens the selection to the parent block, and **↓** narrows it back.
  - **Space** marks the outlined block.
  - **K** keeps only that block and marks everything else.
- **Enter** or **Apply** removes the marked blocks. **Ctrl+Z** and
  **Ctrl+Shift+Z** undo and redo, including Apply.
- **Remember for this site**: the blocks you remove are saved as rules for
  that site. They are removed automatically the next time you open the
  cleaner there, and **Forget site** clears them.
- After Apply, the toolbar offers the next step:
  - **Save as PDF** hands the page to Recall Web to PDF.
  - To clip it as Markdown, press **Alt+Shift+M** for Recall Clipper.

**Esc** closes the toolbar. The page stays cleaned.

A marked block that covers most of the screen, such as a dark backdrop, lets
clicks through to the page underneath it. Unmark it from its chip.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Inject the cleaner into the tab you clicked it on, and nowhere else. Nothing runs on a page until you click. |
| `storage` | Your mode and level, and the per-site rules you chose to remember. Stored on your device only. |

The extension makes no network requests. Its fixed ID
(`klhlbnklncdmdlgepekhegakilnccgji`, set by the `key` in `manifest.json`) is
how Recall Web to PDF knows a print request really came from the cleaner.

## Files

- `content/cleaner-core.js` is the rule engine: what counts as an ad, an
  overlay, a share bar, and which block is the article. **Recall Web to PDF
  ships a byte-identical copy** for its own "Clean first" option, and
  `tools/extensions-check.mjs` fails if the two copies differ.
- `content/cleaner-ui.js` is the toolbar, marking, apply and undo.
- `content/cleaner.css` blurs marked blocks. It is the only style the
  cleaner adds to the page itself; the toolbar lives in a shadow root.
- `tools/fixtures/clutter.html` is the page `tools/extensions-browser-check.mjs`
  cleans.
