# Recall

A static web app for learning something for the first time: write freeform **Study Notes** per deck, highlight any fact in them to make it a flashcard answer (you frame the question), then study the deck as swipeable Markdown flashcards — with Supabase-backed cloud storage and multi-user authentication. No build step, no framework — just open it in a browser.

---

## Table of Contents

- [Features](#features)
- [Self-Hosting](#self-hosting)
- [Supabase Setup](#supabase-setup)
- [First Launch](#first-launch)
- [Card Formats](#card-formats)
- [Importing Decks](#importing-decks)
- [Toolbar Reference](#toolbar-reference)
- [Studying](#studying)
- [Editing & Formatting Cards](#editing--formatting-cards)
- [Study Notes](#study-notes)
- [Images](#images)
- [Quick Notes](#quick-notes)
- [All Cards Panel](#all-cards-panel)
- [Exporting](#exporting)
- [My Decks & Cloud Sync](#my-decks--cloud-sync)
- [Notifications](#notifications)
- [Style Settings](#style-settings)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [PWA / Offline Support](#pwa--offline-support)
- [Architecture](#architecture)

---

## Features

- **Markdown rendering** — full GFM, tables, code blocks with syntax highlighting (Prism), LaTeX math (KaTeX), Mermaid diagrams, and nomnoml diagrams. Any rendered diagram or image opens in a **zoomable pan/zoom viewer** (Panzoom).
- **Multiple import sources** — paste Markdown, upload `.md` / `.txt` / `.json` / `.zip`, fetch from a raw URL, or use Jina Reader for public web pages. Each source can either **start a new deck** or **append to the current one**.
- **Swipe + keyboard navigation** — swipe left/right on mobile, arrow keys on desktop; plus **Shuffle** and **Restart** for the current session
- **Known / Review categorization** — cards can be marked Known or Review and replayed in filtered sessions (All / Review only / Known only / Uncategorized)
- **Two ways to format** — edit a card's raw Markdown with a rich **edit-mode toolbar** (bold, italic, underline, strikethrough, code, cloze fill-in-the-blanks, fonts, text colours, bullet lists, image insert, clear), *or* select text right in the rendered view and use the **format-in-place toolbar** (B/I/U/S, code, cloze, plus text-colour and highlight split-buttons) with no need to enter edit mode
- **Cloze fill-in-the-blanks** — hide any span as `{{…}}`; tap a cloze to reveal it, or flip **all** clozes on a card (or in the notes) at once with the 👀/🙈 button
- **Image paste & upload** — paste, drag-and-drop, or pick any image while editing; it's optimized in-browser (WebP) and uploaded to your own **Supabase Storage** bucket, then inserted as Markdown — no separate key, and images are actually deletable (🗑) since it's your own storage. Public Google Drive share links are auto-embedded so they render directly. In Study Notes, an image on its own line can be **resized by dragging the blue corner grip** (with a live size badge); images stay centered, and writing images separated by `|` on one line renders them **side by side**.
- **Study Notes per deck** — every deck carries a freeform Markdown notes document (Cards ⇄ Notes toggle in the study view). Study first, then highlight any fact in the rendered notes and tap **+ Make card**: the selection becomes the card's *answer* and you're prompted to frame the *question* that should recall it. Long notes get an auto-generated, collapsible **table of contents** (☰) with scroll-spy and click-to-jump. Notes sync to the cloud with the deck and travel inside Markdown/JSON exports. *(Existing Supabase projects: run `supabase_deck_notes.sql` once in the SQL Editor.)*
- **Quick Notes** — select any text while editing an answer and save it straight to a dedicated `quick_notes` cloud deck with one click
- **Toast confirmations** — every cloud action (sync, load, delete, rename, quick note) pops a toast so you always know it worked
- **All Cards panel** — browse, search, and edit every card in a deck at once
- **Automatic two-way cloud sync** — every deck is mirrored to Supabase and back in the background, with **last-write-wins per deck** (by `updated_at`); no manual push/pull, and a **Sync Now** button forces a reconcile on demand. Saving to the device is automatic too
- **Unified My Decks library with nested folders & three views** — one panel lists every deck (on-device *and* cloud-only), each with a live sync-status badge; load, rename, categorize, export, or delete from here. Switch how you browse with a **view switcher — `Grid · Folder · Tree`** — and a **`▦ Tiles / ☰ List` display toggle**: **Grid** shows every deck flat, **Folder** is a Finder-style drill-down with a breadcrumb (double-click a folder to enter), and **Tree** is the full collapsible hierarchy. Create a deck (**＋ New deck**, opens a blank deck in notes mode filed under the current folder) or a **＋ New folder** right from the toolbar or any folder, and search decks by title. Decks are organized by a `/`-delimited **category path** (e.g. `Math/Calculus/Derivatives`), so legacy flat categories simply become top-level folders — no migration needed. **Drag a deck onto a folder to file it, or drag a whole folder onto another to re-parent it**; rename and delete folders inline (deleting a folder moves its decks up to the parent, never deletes them). Folders start **folded by default** (an Expand/Collapse-all toggle is in Tree view), the view/display/expansion choices persist per device, and folder paths sync across devices inside each deck's `category`. *(On touch devices, use a deck's category menu instead of drag-and-drop; empty folders you create are device-local until a deck lands in them.)* Deletes propagate across devices via durable **delete tombstones**, so a deck removed on one device stays removed everywhere
- **Multi-user auth with per-user isolation** — email + password login; Row Level Security scopes every deck, card, and tombstone to its owner, so each account sees only its own data. No credentials stored in the source code
- **Per-project config** — Supabase URL and anon key are entered at first launch and stored in `localStorage`; swap them anytime
- **In-app Help & Guide** — a built-in walkthrough of every button and workflow
- **Rich exports** — cards as **Cornell PDF, Standalone HTML, Word (.docx), Markdown, JSON, or SQL**, and study notes as **PDF, Standalone HTML, Word (.docx), or Markdown** — for the current deck, any single deck, a selection, or the whole library from My Decks
- **Themes** — 10 built-in themes (7 dark, 3 light) with a full style editor for fonts, sizes, spacing, and layout (separate desktop / mobile profiles)
- **PWA** — installable on desktop and mobile, works offline after first load

---

## Self-Hosting

The app's core is three files — `index.html`, `styles.css`, `app.js` — with `sw.js` and `manifest.webmanifest` (plus `icons/` and `fevicon.png`) enabling the installable PWA, and the `supabase_*.sql` files for backend setup. All JS/CSS dependencies are loaded from CDN at runtime. Deploy the whole folder as-is; there is no build step.

### Option 1 — Local (development / personal use)

```bash
git clone <repo-url>
cd recall
python3 -m http.server 8080
```

Open `http://localhost:8080` in your browser.

> **Do not open `index.html` directly as a `file://` URL.** Supabase Auth blocks requests from `file://` origins. Always serve over HTTP.

### Option 2 — GitHub Pages

1. Push the repo to GitHub
2. Go to **Settings → Pages**
3. Set source to the branch containing the files
4. Access at `https://<your-username>.github.io/<repo-name>/`

### Option 3 — Netlify / Vercel

Drag and drop the project folder into Netlify Drop, or connect the GitHub repo. No build command or output directory needed.

---

## Supabase Setup

Each deployment needs its own Supabase project. The app connects to whichever project the user configures on first launch.

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com) → New project.

### 2. Create the tables and policies

Everything the app needs is in the `.sql` files shipped in this repo. Open the **SQL Editor** in your Supabase dashboard and run these files **in order** — each is safe to re-run:

| Order | File | What it creates |
|---|---|---|
| 1 | `supabase_schema.sql` | The `decks`, `cards`, and `app_style_settings` tables, indexes, **per-user Row Level Security** (each row carries a `user_id` defaulting to `auth.uid()`; policies scope every deck/card to its owner) |
| 2 | `supabase_style_settings.sql` | Enriches the one-row global `app_style_settings` document — adds the JSON `CHECK` constraint, an `updated_at` trigger, and seeds sensible layout defaults |
| 3 | `supabase_deck_tombstones.sql` | The `deleted_decks` table — durable cross-device **delete tombstones** so a deck removed on one device is not resurrected by another |

> **Row Level Security is per user**, not shared. Each account sees only its own decks, cards, and tombstones. (The one exception is the global `app_style_settings` row, which is intentionally shared across everyone on the deployment — it holds only layout/size settings, no content.)

**Upgrading an existing deployment?** If your project predates some of these columns/tables, run only the migration files you need — each adds missing pieces without touching existing data:

- `supabase_deck_categories.sql` — adds the `category` and `last_accessed_at` columns used to group and sort decks
- `supabase_deck_notes.sql` — adds the per-deck `notes` column (Study Notes)
- `supabase_deck_tombstones.sql` — adds cross-device delete tombstones
- `supabase_quick_notes.sql` — adds `cards.category` (per-note subject label) and `decks.meta` (managed category set) for the [Quick Notes board](#quick-notes)
- `supabase_image_storage.sql` — creates the `images` Storage bucket + RLS policies used for [image upload](#images) (see below)

(A brand-new project created with `supabase_schema.sql` already includes the `category`, `notes`, and `last_accessed_at` columns, so the first two migrations are only for older deployments. `supabase_quick_notes.sql` is always needed for the Quick Notes board's categories, on new and old projects alike. `supabase_image_storage.sql` is always needed too, since Storage buckets aren't part of `supabase_schema.sql`.)

### 3. Create a user account

In Supabase Dashboard → **Authentication → Users → Add user**.  
Enter an email and password. The user is created immediately — no email required.

To allow self sign-up from the app: **Authentication → Providers → Email → turn off "Confirm email"**.

### 4. Get your API credentials

In Supabase Dashboard → **Project Settings → API**:

| Field | Looks like |
|---|---|
| **Project URL** | `https://xxxxx.supabase.co` |
| **anon / public key** | `sb_publishable_...` or `eyJ...` (long string) |

You will paste these into the app on first launch.

---

## First Launch

1. Open the app — a **Connect your Supabase project** screen appears
2. Paste your **Project URL** and **Anon Key** → click **Connect**
   - The app runs a quick test query to confirm the credentials work before saving them
3. The **Sign In** screen appears — log in with the email and password you created in the dashboard
4. The main app loads

Credentials are saved in your browser's `localStorage`. On every subsequent visit the app skips setup and goes straight to the login screen.

**To switch to a different Supabase project** — click **"Change Supabase project"** at the bottom of the login screen. This clears the saved credentials and shows the setup screen again.

---

## Card Formats

The app supports multiple Markdown input formats. The two formats below cover the vast majority of use cases.

### Format 1 — `::` Delimited blocks (recommended)

Wrap each card in `::` markers and separate the front from the back with `---`:

```markdown
::
What is the powerhouse of the cell?
---
The mitochondria.
::

::
Explain Newton's second law.
---
**F = ma** — force equals mass times acceleration.

This means a larger force is needed to accelerate a heavier object.
::
```

- Everything before `---` → front of the card (question)
- Everything after `---` → back of the card (answer)
- Both sides render full Markdown (bold, code blocks, LaTeX, diagrams, etc.)
- Blank lines around `::` and `---` are optional

### Format 2 — Heading-based

Any `##`, `###`, or `####` heading becomes the front of a card. The content below it (until the next heading) becomes the back:

```markdown
## What is photosynthesis?

The process by which plants convert sunlight into glucose
using CO₂ and water.

### What is osmosis?

The movement of water across a semi-permeable membrane
from a region of low solute concentration to high.
```

This format works well for importing existing study notes or Wikipedia-style documents without reformatting them.

### Format 3 — Notion toggle export (blockquote style)

When you export a Notion page as Markdown, toggles appear as blockquotes. The app detects this and treats them as cards:

```markdown
> What is the capital of France?
Paris.

> Define entropy.
A measure of disorder or randomness in a thermodynamic system.
```

---

## Importing Decks

Open the menu (**☰**, top-left) and click **Import from File** to open the Import panel. The panel has three groups: **URL**, **Local**, and (once you paste or pick a file) a **paste editor with live preview**.

### New deck vs. add to current deck

Every import method comes in two flavours — the difference is only whether the cards **replace** the current deck or **append** to it:

| Action | What it does |
|---|---|
| **📁 Import Deck** / **📋 (next to it)** | Starts a **new deck** from the file or pasted Markdown (replaces what's open) |
| **📄 Import Cards** / **📋 (next to it)** | **Appends** the imported cards to the deck you already have open |

### Import methods

#### Fetch from URL
Paste a URL into the **URL** field and click **Fetch**. A raw Markdown URL is parsed directly; for a public web page (not raw Markdown), the app falls back to **Jina Reader** automatically to extract readable content.

> **Notion pages:** Public pages work via Jina Reader. Private pages must be exported as Markdown first — the Notion API requires a secret token that a static app cannot safely hold.

#### Upload a file
Click **Import Deck** / **Import Cards** (or drag and drop onto the panel). Supported formats:

| File type | What happens |
|---|---|
| `.md` / `.markdown` / `.txt` | Parsed as Markdown using the [card formats](#card-formats) above |
| `.json` | Re-imported with full card state (statuses, positions, study notes) |
| `.zip` | All `.md` and `.json` files inside are listed in a **selector** where you tick which decks to load |

If a single file contains **multiple decks**, a *Select Decks to Import* dialog lists them so you can choose which ones to bring in.

#### Paste Markdown
Click the **📋** button next to **Import Deck** (new deck) or **Import Cards** (append). In the paste editor:

1. Paste your raw Markdown on the left
2. Click **Preview Cards** — the right pane shows how many cards were detected and how each splits into question/answer
3. Click **Import Pasted Deck** to load them

---

## Toolbar Reference

All actions live in a single **menu drawer**, opened with the **☰** button in the top-left (on every screen size). The drawer is grouped into three sections:

### Decks

| Button | Action |
|---|---|
| **+ New Deck** | Clears the current deck and starts a blank one |
| **⇧ Import from File** | Opens the Import panel to load cards from a file, URL, or paste |
| **📚 My Decks** | Opens the unified deck library — every deck, on-device *and* cloud-only, with a live sync status; load, rename, or delete (see [My Decks & Cloud Sync](#my-decks--cloud-sync)) |
| **⟳ Sync Now** | Forces an immediate two-way reconcile with the cloud (sync is otherwise automatic) |

### Study

| Button | Action |
|---|---|
| **≡ Browse All Cards** | Opens the All Cards panel — browse and edit every card at once |
| **📝 Study Notes** | Switches to the deck's freeform notes view (also reachable via the Cards ⇄ Notes toggle) |
| **⇓ Export Cards…** | Opens the card export menu — **Cornell PDF, Standalone HTML, Word (.docx), Markdown, JSON, or SQL** (see [Exporting](#exporting)) |
| **⇓ Export Notes…** | Opens the notes export menu — **PDF, Standalone HTML, Word (.docx), or Markdown** (disabled until the deck has notes) |

### App

| Button | Action |
|---|---|
| **○ Themes** | Opens the Style Settings panel to pick a theme and customise fonts, sizes, and layout |
| **? Help & Guide** | Opens the in-app walkthrough of every feature |
| **→ Sign Out** | Signs out of the current session and returns to the login screen |

> **Saving is automatic.** There is no "Save to Device" or "Sync to Cloud" button — every edit is written to the on-device library and mirrored to the cloud in the background. The **sync indicator** next to the deck title shows the current state, and **Sync Now** forces a reconcile if you don't want to wait.

### Study view buttons

The row of five buttons under the card:

| Button | Action |
|---|---|
| **❌ Review** | Marks the current card as Review (needs more practice) — shortcut `R` |
| **← Prev** | Previous card — shortcut `←` / `↑` |
| **+ Add** | Adds a new blank card after the current position |
| **Next →** | Next card — shortcut `→` / `↓` |
| **✅ Known** | Marks the current card as Known — shortcut `K` |

Deck-wide utilities (below that row):

| Button | Action |
|---|---|
| **⇄ Shuffle** | Randomizes the order of the current session |
| **⟳ Restart** | Restarts the session from the first card |
| **👀 Reveal clozes** | Flips every cloze on the current card open at once; press again (🙈) to hide them all (you can still tap any single cloze) |

On the card faces themselves:

| Button | Action |
|---|---|
| **✎ / 👁** (edit toggle, each face) | Toggles that face between rendered view and raw-edit mode (`Ctrl`/`⌘`+`E`). The edit toolbar shows in edit mode; the [format-in-place toolbar](#editing--formatting-cards) shows in rendered mode |
| **🗑** | Deletes the current card (on the question face) |
| **✎** next to the deck title / category | Renames the deck, or edits its category inline, from the header |

### End-of-deck replay buttons

These appear when you reach the last card:

| Button | Action |
|---|---|
| **All cards** | Restarts with all cards in the deck |
| **Review only** | Restarts the session with only Review-marked cards |
| **Known only** | Restarts with only Known-marked cards |
| **Uncategorized** | Restarts with cards not yet marked either way |

---

## Studying

- **Flip the card** — click/tap the card, or press `Space` / `Enter`
- **Navigate** — swipe left (next) or right (previous) on mobile; `→` / `↓` and `←` / `↑` on desktop
- **Mark Known** — click **✅ Known** (or press `K`); the card is counted in the Known pile
- **Mark Review** — click **❌ Review** (or press `R`); the card is counted in the Review pile
- **Shuffle / Restart** — **⇄ Shuffle** randomizes the order; **⟳ Restart** returns to the first card
- **Reveal clozes** — **👀 Reveal clozes** flips every fill-in-the-blank on the card open at once (🙈 to hide them again)
- **Progress bar** — the segmented bar at the top of the card area shows Known (green), Review (red), and remaining progress
- **Score display** — the header shows `Known X / Review Y` as a live count, and each card carries a status badge
- **Replay** — when you reach the last card, replay buttons let you restart with **All cards**, **Review only**, **Known only**, or **Uncategorized**

---

## Editing & Formatting Cards

There are **two** ways to format a card face — you rarely need to leave the rendered view.

### Format-in-place (rendered view)

Above each rendered card face — and above the Study Notes preview — sits a compact **format-in-place toolbar**. Select some text right in the rendered output and click a button to format it *without entering edit mode*:

| Button | Formatting |
|---|---|
| **B** / **I** / **U** / **S** | Bold, Italic, Underline, Strikethrough |
| **&lt;/&gt;** | Inline code |
| **🎨** (split button) | Text colour — click the paint side to apply the current default colour in one tap, or the ▾ side (which shows a live swatch) to pick a different colour, which becomes the new default |
| **🖍️** (split button) | Highlight — same split-button behaviour for a background highlight colour |
| **[…]** | Cloze the selection in place (tap again on the same text to un-cloze) |

Your chosen default colours are remembered in `localStorage`. Formatting is written back into the deck's Markdown source and auto-saved. (Selections must fall entirely inside the rendered text; for structural edits, use edit mode.)

### Raw edit mode

Enter edit mode on the question or answer face in either of two ways:

- Click the **pencil** (✎) icon on that face, or
- **Long-press** the card with a mouse (desktop only), or press `Ctrl`/`⌘`+`E`

> **On touch devices**, long-press is reserved for selecting text, so use the **pencil** (✎) icon to enter or leave edit mode.

While editing, a fuller **formatting toolbar** appears above the text. Select a span of text, then click a button to wrap it in Markdown/HTML:

| Button | Formatting |
|---|---|
| **B** / **I** / **U** | Bold, Italic, Underline |
| **S** | Strikethrough |
| **&lt;/&gt;** | Inline code |
| **[…]** | Cloze — hide the selection as a fill-in-the-blank (`{{text}}`); tap it on the card to reveal, or use the **👀 Reveal clozes** button under the card to flip them all at once (press again to hide them all — 🙈). Revealed cloze text uses a distinct italic-serif font — no highlight box — so you can still tell which words were blanks. |
| **Aa** | Font family picker |
| **🎨** | Text colour (includes "Clear colour") |
| **-** | Toggle bullet list |
| **🖼️** | Insert an image — opens a file picker and uploads to your Supabase project (see [Images](#images)) |
| **Tx** | Clear all formatting from the selection |
| **📌** | Save the selection as a Quick Note (answer toolbar only — see below) |

Click the **save** (💾) icon to commit. Edits are also committed automatically whenever you navigate away from the card.

---

## Study Notes

Every deck carries a freeform **Study Notes** document alongside its cards — the idea is to *learn first, card later*. Switch with the **Cards ⇄ Notes** toggle at the top of the study area, or **Study Notes** in the menu.

- **Write in full Markdown** — headings, tables, LaTeX math, code, Mermaid/nomnoml diagrams, and pasted/resized images all render just like on a card. Toggle the ✎ pencil to switch between writing and the rendered preview.
- **Highlight → + Make card** — select any fact in the rendered notes (text, images, math). A floating **+ Make card** pill shows how much is captured; tapping it opens a dialog where the selection is previewed as the card's **answer** and you frame the **question** that should recall it (`Ctrl`/`⌘`+`Enter` to add). The **➕** button in the notes header does the same for the current selection.
- **Cloze in notes** — the same `[…]` cloze tools work here; the **👀** button in the notes header reveals/hides every cloze in the notes at once.
- **Notes travel with the deck** — they auto-save, sync to the cloud, and are embedded inside Markdown and JSON exports. They can also be exported on their own (see [Exporting](#exporting)).

### Table of contents

When your notes contain Markdown headings, a **☰** button appears at the left of the notes header. It opens a sliding **"On this page"** drawer that mirrors your headings:

- **Nested by level** — headings indent by depth (normalized to the shallowest level), with graduated dots.
- **Click to jump** — selecting an entry smooth-scrolls that heading to the top of the notes and briefly flashes it.
- **Scroll-spy** — the entry for the section you're currently reading stays highlighted as you scroll.
- **Easy dismiss** — close it with the **✕**, the `Escape` key, another tap of **☰**, or by clicking anywhere outside the drawer. On phones it also closes after you pick a heading.

The TOC rebuilds automatically every time the notes render, and hides itself while you're in raw-edit mode.

---

## Images

You can add images to any card without hand-writing URLs. While editing, insert an image three ways:

- **Paste** — copy any image (a screenshot, or an image from a webpage) and press `Ctrl`/`Cmd` + `V` in the editor
- **Drag & drop** — drag an image file from your file manager onto the editor (desktop)
- **Toolbar 🖼️** — tap the image button to open a file picker; on phones and tablets this offers your **camera or photo library**

Before uploading, the image is **optimized in your browser** — downscaled to a max of 1600px on its longest edge and re-encoded to WebP (quality ~0.82) — which typically shrinks screenshots dramatically. Animated GIFs and SVGs are uploaded untouched, and if the "optimized" version isn't actually smaller the original is kept. The result is uploaded to the `images` bucket in **your own Supabase project** and a Markdown `![](…)` link is inserted at the cursor.

### No separate image key

Images are stored in the same Supabase project as your decks, so there's no second API key to manage — run `supabase_image_storage.sql` once (see [step 2](#2-create-the-tables-and-policies)) and the sign-in you already use for sync also unlocks uploads. Uploads require a network connection.

Hover a rendered image and use its 🗑 button to remove it — since it's your own storage (not a third-party host), this actually deletes the file, not just the reference in your notes.

### Google Drive images

Public Google Drive share links are embedded automatically — just paste the link as an image:

```markdown
![](https://drive.google.com/file/d/FILE_ID/view?usp=drivesdk)
```

The app rewrites it to a directly-embeddable form (`https://drive.google.com/thumbnail?id=FILE_ID&sz=w1000`) at render time, so the file shows instead of a broken image. The file must be shared as **"Anyone with the link"**.

### Resizing images in Notes

An image that sits on its own line in the rendered **Study Notes** is resizable: a small **blue grip** appears at its bottom-right corner — drag it to set the width, with a live badge showing the size in pixels and as a percent of the notes column. Images are always centered. The width is stored as an absolute pixel size in the deck's Markdown (`<img style="width:…">`), so it stays put regardless of window size and travels with exports and cloud sync.

An image pasted in the middle of a sentence, or nested inside a list or quote, shows a single **"Move to own line"** button first — one click promotes it to its own block, and the resize grip then appears.

### Side-by-side images

To place images in a row, write them on one line separated by `|`:

```markdown
![](first.png) | ![](second.png) | ![](third.png)
```

They render side by side, and each stays individually resizable via its corner grip. (The line must be *only* images and `|` separators — a `|` in ordinary prose, or a Markdown table row, is left alone.) Resizing one image in a `|` row rewrites that line into an explicit `<div class="notes-img-row">…</div>` block so it can carry the per-image width; it renders identically.

---

## Quick Notes

Quick Notes let you capture a snippet of an answer into a separate deck without interrupting your study flow.

1. Open an **answer** in edit mode (pencil icon — or mouse long-press on desktop — then flip to the answer side)
2. **Select** the text you want to keep
3. Click the **📌** button at the end of the formatting toolbar

The selection is saved as a new card in a dedicated **`quick_notes`** cloud deck, which is created automatically the first time you use the feature. The selected text becomes the card's **question**, leaving the **answer blank** for you to fill in later. A toast confirms the save, and you can open the `quick_notes` deck any time from **My Decks**.

> **Requires sign-in.** Quick Notes are stored as a cloud deck in Supabase, so you must be logged in. If you are not connected/signed in, a toast explains why the note could not be saved.

### The Quick Notes board

Because quick notes are meant to be **skimmed at a glance across all your decks** rather than drilled like flashcards, they get their own surface instead of the known/unknown study flow. Open it from **📓 Quick Notes** in the toolbar (Study section). The board:

- Shows every pinned snippet, **newest first**, grouped into **subject categories you define** (not the study Known/Review status).
- Each card carries a coloured accent for its category, a **↪ source link** back to the exact spot it was pinned from (across decks), and a dropdown to (re)assign its category inline.
- A **filter bar** with live counts lets you focus on one subject — or **Uncategorized**.
- **⚙ Manage categories** opens a small editor to add, rename, recolour, and delete categories. Deleting a category leaves its notes as *Uncategorized* (never deletes notes).

Categories and per-note assignments sync to Supabase (`decks.meta` + `cards.category`) and are mirrored locally, so the board works offline too. Run **`supabase_quick_notes.sql`** once to add those columns to an existing project.

---

## All Cards Panel

Click **Browse All Cards** in the menu to open a full list of every card in the current deck.

- **Search** — type in the search box to filter cards by question or answer text
- **Toggle answers** — click **Show All Answers** / **Hide All Answers** to expand or collapse every answer at once
- **Edit inline** — click the pencil icon on any card to edit the question or answer directly in the list
- **Delete a card** — click the **✕** button on a card row
- **Status badges** — each card shows its current Known / Review / Uncategorized status

---

## Exporting

### Export Cards

Click **Export Cards…** in the menu and pick a format. Export covers the whole current deck:

| Format | Description |
|---|---|
| **Cornell PDF** | Printable Cornell Notes layout — question on the left column, answer on the right. Opens a print dialog automatically. |
| **Standalone HTML** | A single self-contained `.html` file — all styles inlined, images embedded as data URIs, and math/Mermaid/nomnoml diagrams baked to static markup, so it renders anywhere with no network |
| **Word (.docx)** | A real Word document (WordprocessingML) built from the Cornell layout, with images embedded |
| **Markdown** | The deck as a `.md` file using `::` block format (study notes ride along inside an HTML comment block) |
| **JSON** | Full deck with card statuses, positions, and study notes — can be re-imported into this app |
| **SQL** | `INSERT … ON CONFLICT` statements for the `decks`/`cards` tables — restore or seed a Supabase project directly |

### Export Notes

When a deck has Study Notes, **Export Notes…** in the menu (disabled otherwise) exports just the notes document — as **PDF** (printable), **Standalone HTML**, **Word (.docx)**, or **Markdown**. Headings, math, diagrams, and images are all rendered/baked into the output.

### Exporting from My Decks

Any deck in the library — not just the one currently open — can be exported from **My Decks**: per-deck **Export**, bulk **Export** for a selection, or **Export All** for the whole library (on-device *and* cloud). All six card formats are available in each of those menus.

---

## My Decks & Cloud Sync

Sync is **automatic and two-way**. Every deck lives in an on-device library *and* is mirrored to your Supabase account in the background — there is no manual "push" or "pull", and no Overwrite/Merge prompt.

### How reconciliation works

- **Last-write-wins per deck.** When a deck exists both locally and in the cloud, whichever copy has the newer `updated_at` timestamp wins the *whole deck* — its title, category, cards, and study notes replace the older side. (Conflict resolution is deck-level, not field-level: if the same deck is edited on two devices between syncs, the later save wins and the other side's edits to that deck are dropped.)
- **Runs on its own.** A reconcile fires shortly after you sign in and whenever the device comes back online. **Sync Now** in the menu forces one immediately.
- **Delete tombstones.** Deleting a deck records a durable tombstone in the `deleted_decks` table, so the deletion propagates to your other devices instead of a stale copy re-uploading and resurrecting the deck. (Requires `supabase_deck_tombstones.sql`; without it, deletes only apply on the device that made them.)
- **Offline-friendly.** Because every cloud deck is copied onto the device, the whole library stays available offline; changes reconcile when the connection returns.

### The My Decks panel

Open **My Decks** from the menu. It lists **every** deck — those saved on this device and those that exist only in the cloud — in one table:

| Column | Shows |
|---|---|
| **Select** | Checkbox for bulk actions (header checkbox selects all) |
| **Title** / **Category** | Deck name and an inline **category editor** — pick an existing category or create a new one right in the row (📝 next to the count means it has study notes) |
| **Cards** | Card count |
| **Saved** | When the on-device copy was last written (or ☁ Cloud for cloud-only decks) |
| **Sync** | Live status — **In sync**, **☁ Cloud only** (not pulled down yet), **Local only** (not backed up), or pending changes |

A **category filter** above the table narrows the list, and **Export All** downloads the whole library (on-device *and* cloud) as Cornell PDF, Standalone HTML, Word (.docx), Markdown, JSON, or SQL.

Per-deck actions:

| Action | What it does |
|---|---|
| **Load** | Opens that deck into the study view (pulls it down first if it's cloud-only) |
| **Export** | Downloads that one deck as Cornell PDF, Standalone HTML, Word (.docx), Markdown, JSON, or SQL — works offline for on-device decks |
| **Rename** | Renames the deck (updates the cloud immediately when reachable, otherwise on the next reconcile) |
| **Delete** | Removes the deck from this device **and** the cloud (via a tombstone); if the cloud delete can't complete now, it retries on the next sync |
| **⟳ Refresh** | Re-reads the on-device library and re-checks cloud status |

Selecting one or more decks reveals the **bulk action bar**: **Load** (opens the selection as one combined deck), **Categorize** (set a category on all selected decks at once), **Export** (one file covering the selection), and **Delete**.

---

## Notifications

Every action that touches the cloud gives you immediate, unmistakable feedback through a **toast** — a small notification that slides in at the top-center of the screen and dismisses itself after a couple of seconds (click it to dismiss early). Because toasts are not tied to the button you clicked, you get confirmation no matter where the action was triggered from.

| Result | Example toast |
|---|---|
| **Success** | ✓ "Loaded *Deck*", "Saved to quick_notes", "Deck deleted everywhere", "Deck renamed" |
| **Info** | ⓘ "Deleted here — cloud delete will retry on next sync" |
| **Error** | ✕ "Couldn't load deck", "Couldn't save quick note" |

Toasts appear for loading, deleting, and renaming decks, saving Quick Notes, and background sync results. A **sync report** additionally summarises what each reconcile pulled, pushed, or failed on. The sync indicator next to the deck title always reflects the current state.

---

## Style Settings

Click **Themes** in the menu to open the style panel.

The panel exposes the theme picker plus grouped sliders and selects:

| Group | What it changes |
|---|---|
| **Theme** | Switches between the 10 built-in themes (7 dark, 3 light): AMOLED Black / Emerald / Violet, Forest, Graphite, Navy, Bronze (dark) and Paper, Snow, Ink (light) |
| **Typography** | Base font family/size/line-height, raw-Markdown editor font size, and code font size/line-height |
| **Layout Percentages** | App width/height, card width, card max height, modal width, visual (image/diagram) max width, and import-box height — all as a percent of the screen |
| **Spacing And Shape** | Section gaps and panel/card padding |
| **Question** / **Answer And Card** | Per-face font family, fill %, max font size, line height, horizontal/vertical alignment, weight, and padding |
| **Buttons And Inputs** | Button gap and the corner radii for cards, panels, buttons, and inputs |

Actions at the bottom of the panel:

| Button | What it does |
|---|---|
| **Apply** | Applies the edited settings to the current view |
| **Sync Up** | Saves your current style settings to Supabase so they apply on every device |
| **Sync Down** | Loads the last-synced style from Supabase (overwrites local settings) |

Style profiles are separate for desktop and mobile, so the card can look different on different screen sizes. Themes control colours; the **Aa** layout settings (sizes, spacing) are stored in the shared global `app_style_settings` row.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` / `Enter` | Flip card (show answer / hide answer) |
| `→` / `↓` | Next card |
| `←` / `↑` | Previous card |
| `K` | Mark current card Known |
| `R` | Mark current card for Review |
| `Ctrl`/`⌘` + `E` | Toggle edit / rendered view (focused card face) |
| `Ctrl`/`⌘` + `Enter` | Add the card in the *Make a flashcard from notes* dialog |
| `Escape` | Close any open panel, modal, or the notes table of contents |

---

## PWA / Offline Support

When served over HTTPS (GitHub Pages, Netlify, etc.), the app registers a service worker and can be installed as a PWA:

- **Desktop** — browser shows an "Install app" button in the address bar
- **Mobile** — use "Add to Home Screen" in the browser menu

### Working offline

The service worker **precaches the entire dependency set on first load** — the app shell (HTML/CSS/JS, manifest, icons) plus every CDN library (marked, DOMPurify, KaTeX + all its math fonts, Prism core + Python + the common language grammars, Mermaid, nomnoml + graphre, JSZip, Turndown + the GFM plugin, Panzoom, the Supabase client). So after a single online visit the app is fully self-contained: math, diagrams, syntax highlighting, and exports all work with no connection, not just the features you happened to exercise while online.

- **Registers unconditionally** — the worker installs on the login/setup screen too, before you sign in or configure a cloud project, so the offline cache is in place from the very first visit.
- **Stays signed in** — your session is read from local storage, so you reach your decks instead of the login wall. (You must have signed in online at least once; a fresh sign-in/sign-up still needs the network.)
- **Working deck is never lost** — every edit is auto-saved to the **My Decks** library (debounced, plus a final flush when the tab is hidden or closed), so nothing is lost if the app is closed mid-session. A reload starts on the clean home screen by design; reopen your deck from **My Decks**.
- **Full library offline** — because every cloud deck is mirrored onto the device automatically, **My Decks** works fully offline; you can load, rename, and delete saved decks with no connection.
- An **Offline** badge appears (bottom-left) whenever you lose connection.

A first-time login still needs the network, and any edits made offline (including deletes) reconcile with the cloud automatically once the connection returns. Remote user content that isn't part of the app itself — images hosted on Supabase Storage/Google Drive, `Fetch from URL`, and the Jina Reader import — naturally still needs a connection.

---

## Architecture

| Concern | Approach |
|---|---|
| Framework | None — plain HTML + CSS + JS, no build step |
| Markdown rendering | [marked](https://marked.js.org/) + [DOMPurify](https://github.com/cure53/DOMPurify) |
| Math | [KaTeX](https://katex.org/) via `auto-render` |
| Diagrams | [Mermaid](https://mermaid.js.org/) + [nomnoml](https://nomnoml.com/) (with its [graphre](https://github.com/skanaar/graphre) layout engine) |
| Code highlighting | [Prism](https://prismjs.com/) — core + Python, plus the autoloader for other languages |
| Diagram / image zoom | [Panzoom](https://github.com/timmywil/panzoom) in the diagram modal |
| Document export | Print-to-PDF (Cornell layout), self-contained **Standalone HTML** (styles inlined, images as data URIs, diagrams/math baked to static markup), and **Word `.docx`** (hand-built WordprocessingML) — for both cards and notes |
| ZIP import/export | [JSZip](https://stuk.github.io/jszip/) |
| Markdown export | [Turndown](https://github.com/mixmark-io/turndown) + [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) |
| Database | [Supabase](https://supabase.com/) (Postgres + Auth + per-user RLS) — schema in `supabase_schema.sql`, migrations in the other `supabase_*.sql` files |
| Auth | Supabase email + password (`signInWithPassword` / `signUp`) |
| Cloud sync | Automatic two-way reconcile, last-write-wins per deck by `updated_at`; cross-device delete tombstones in `deleted_decks` |
| Config storage | `localStorage` — Supabase URL, anon key, and format-toolbar colour defaults never touch the source code |
| Image hosting | Supabase Storage, in the user's own project (browser-side WebP optimization before upload, RLS-scoped per-user delete); public Google Drive links rewritten to embeddable form at render time |
| Offline | Service worker (`sw.js`) + Cache API; full dependency set precached; full deck library mirrored on-device |
| Deployment | Any static host — GitHub Pages, Netlify, Vercel, local server |

The entire application logic lives in `app.js` (`index.html` + `styles.css` for markup and styling). There are no modules, no transpilation, and no runtime dependencies beyond what the CDN `<script>` tags load.
