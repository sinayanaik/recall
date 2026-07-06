# Recall

A static web app for learning something for the first time: write freeform **Study Notes** per deck, highlight any fact in them to make it a flashcard answer (you frame the question), then study the deck as swipeable Markdown flashcards — with Supabase-backed cloud storage and multi-user authentication. No build step, no framework — just open it in a browser.

*(Formerly "Markdown Flashcards" — existing decks, exports, and local data keep working unchanged.)*

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

- **Markdown rendering** — full GFM, tables, code blocks with syntax highlighting (Prism), LaTeX math (KaTeX), Mermaid diagrams, and nomnoml diagrams
- **Multiple import sources** — paste Markdown, upload `.md` / `.txt` / `.json` / `.zip`, fetch from a raw URL, or use Jina Reader for public web pages
- **Swipe + keyboard navigation** — swipe left/right on mobile, arrow keys on desktop
- **Known / Review categorization** — cards can be marked Known or Review and replayed in filtered sessions
- **Inline card editing** — edit question or answer text directly in the study view, with a rich **formatting toolbar** (bold, italic, underline, strikethrough, code, cloze fill-in-the-blanks, fonts, colours, bullet lists)
- **Image paste & upload** — paste, drag-and-drop, or pick any image while editing; it's uploaded to a free [ImgBB](https://api.imgbb.com/) host and inserted as Markdown. Public Google Drive share links are auto-embedded so they render directly. In Study Notes, an image on its own line can be **resized by dragging the blue corner grip** (with a live size badge); images stay centered, and writing images separated by `|` on one line renders them **side by side**.
- **Study Notes per deck** — every deck carries a freeform Markdown notes document (Cards ⇄ Notes toggle in the study view). Study first, then highlight any fact in the rendered notes and tap **+ Make card**: the selection becomes the card's *answer* and you're prompted to frame the *question* that should recall it. Notes sync to the cloud with the deck and travel inside Markdown/JSON exports. *(Existing Supabase projects: run `supabase_deck_notes.sql` once in the SQL Editor.)*
- **Quick Notes** — select any text while editing an answer and save it straight to a dedicated `quick_notes` cloud deck with one click
- **Toast confirmations** — every cloud action (sync, load, delete, rename, quick note) pops a toast so you always know it worked
- **All Cards panel** — browse, search, and edit every card in a deck at once
- **Automatic two-way cloud sync** — every deck is mirrored to Supabase and back in the background, with **last-write-wins per deck** (by `updated_at`); no manual push/pull, and a **Sync Now** button forces a reconcile on demand. Saving to the device is automatic too
- **Unified My Decks library** — one panel lists every deck (on-device *and* cloud-only), each with a live sync-status badge; load, rename, or delete from here. Deletes propagate across devices via durable **delete tombstones**, so a deck removed on one device stays removed everywhere
- **Multi-user auth with per-user isolation** — email + password login; Row Level Security scopes every deck, card, and tombstone to its owner, so each account sees only its own data. No credentials stored in the source code
- **Per-project config** — Supabase URL and anon key are entered at first launch and stored in `localStorage`; swap them anytime
- **In-app Help & Guide** — a built-in walkthrough of every button and workflow
- **Exports** — Markdown, JSON, SQL, and Cornell Notes PDF — for the current deck, any single deck, a selection, or the whole library from My Decks
- **Themes** — 10 built-in themes (7 dark, 3 light) with a full style editor for fonts, sizes, and layout
- **PWA** — installable on desktop and mobile, works offline after first load

---

## Self-Hosting

The entire app is three files: `index.html`, `styles.css`, `app.js`. All dependencies are loaded from CDN at runtime.

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

(A brand-new project created with `supabase_schema.sql` already includes the `category`, `notes`, and `last_accessed_at` columns, so the first two migrations are only for older deployments.)

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

Open the menu (**☰**, top-left) and click **Import from File** to open the Import panel.

### Import methods

#### Paste Markdown
1. Click **Paste Markdown**
2. Paste your content into the editor
3. Click **Preview** to see how many cards were detected
4. Click **Import** to load the deck

#### Upload a file
Click **Choose file** or drag and drop onto the panel. Supported formats:

| File type | What happens |
|---|---|
| `.md` / `.txt` | Parsed as Markdown using the card formats above |
| `.json` | Re-imported with full card state (statuses, positions) |
| `.zip` | All `.md` and `.json` files inside are listed; choose which decks to load |

#### Fetch from URL
Paste a raw Markdown URL into the URL bar and click **Fetch**.  
For public web pages (not raw Markdown), the app falls back to Jina Reader automatically.

> **Notion pages:** Public pages work via Jina Reader. Private pages must be exported as Markdown first — the Notion API requires a secret token that a static app cannot safely hold.

#### Load Sample
Click **Load Sample** to instantly load a built-in example deck. Good for trying the app before creating your own content.

### Appending vs replacing
By default importing replaces the current deck. To add cards to an existing deck without replacing it, reopen **Import from File** and choose the append option in the paste editor.

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
| **⇓ Export Cards…** | Opens the export menu — Cornell PDF, Markdown, JSON, or SQL (see [Exporting](#exporting)) |

### App

| Button | Action |
|---|---|
| **○ Themes** | Opens the Style Settings panel to pick a theme and customise fonts, sizes, and layout |
| **? Help & Guide** | Opens the in-app walkthrough of every feature |
| **→ Sign Out** | Signs out of the current session and returns to the login screen |

> **Saving is automatic.** There is no "Save to Device" or "Sync to Cloud" button — every edit is written to the on-device library and mirrored to the cloud in the background. The **sync indicator** next to the deck title shows the current state, and **Sync Now** forces a reconcile if you don't want to wait.

### Study view buttons

| Button | Action |
|---|---|
| **❌ Review** | Marks the current card as Review (needs more practice) — shortcut `R` |
| **✅ Known** | Marks the current card as Known — shortcut `K` |
| **+ Add** | Adds a new blank card after the current position |
| **🗑** | Deletes the current card |
| **✎ / 👁** (edit toggle, each face) | Toggles that face between view and edit mode (shows the formatting toolbar) |

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
- **Progress bar** — the thin bar at the top of the card area shows how far through the deck you are
- **Score display** — the header shows `Known X / Review Y` as a live count

---

## Editing & Formatting Cards

Enter edit mode on the question or answer face in either of two ways:

- Click the **pencil** (✎) icon on that face, or
- **Long-press** the card with a mouse (desktop only)

> **On touch devices**, long-press is reserved for selecting text, so use the **pencil** (✎) icon to enter or leave edit mode.

While editing, a **formatting toolbar** appears above the text. Select a span of text, then click a button to wrap it in Markdown/HTML:

| Button | Formatting |
|---|---|
| **B** / **I** / **U** | Bold, Italic, Underline |
| **S** | Strikethrough |
| **&lt;/&gt;** | Inline code |
| **[…]** | Cloze — hide the selection as a fill-in-the-blank (`{{text}}`); tap it on the card to reveal, or use the **👀 Reveal clozes** button under the card to flip them all at once (press again to hide them all — 🙈). Revealed cloze text uses a distinct italic-serif font — no highlight box — so you can still tell which words were blanks. |
| **Aa** | Font family picker |
| **🎨** | Text colour (includes "Clear colour") |
| **-** | Toggle bullet list |
| **🖼️** | Insert an image — opens a file picker and uploads to ImgBB (see [Images](#images)) |
| **Tx** | Clear all formatting from the selection |
| **📌** | Save the selection as a Quick Note (answer toolbar only — see below) |

Click the **save** (💾) icon to commit. Edits are also committed automatically whenever you navigate away from the card.

---

## Images

You can add images to any card without hand-writing URLs. While editing, insert an image three ways:

- **Paste** — copy any image (a screenshot, or an image from a webpage) and press `Ctrl`/`Cmd` + `V` in the editor
- **Drag & drop** — drag an image file from your file manager onto the editor (desktop)
- **Toolbar 🖼️** — tap the image button to open a file picker; on phones and tablets this offers your **camera or photo library**

Before uploading, the image is **optimized in your browser** — downscaled to a max of 1600px on its longest edge and re-encoded to WebP (quality ~0.82) — which typically shrinks screenshots dramatically. Animated GIFs and SVGs are uploaded untouched, and if the "optimized" version isn't actually smaller the original is kept. The result is uploaded to [ImgBB](https://api.imgbb.com/) — a free, permanent image host — and a Markdown `![](https://i.ibb.co/…)` link is inserted at the cursor.

### ImgBB API key

Image upload needs a free ImgBB API key:

1. Create a free account at [api.imgbb.com](https://api.imgbb.com/) and copy your API key.
2. Enter it in the **ImgBB API key** field on the Supabase setup screen (reachable via **"Change Supabase project"** on the login screen). It's stored in `localStorage`, like the Supabase credentials — never in the source.

If you try to insert an image before setting a key, the app prompts you for it once and remembers it. Uploads require a network connection.

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

Click **Export Cards…** in the menu and pick a format. Export covers the whole current deck:

| Format | Description |
|---|---|
| **Cornell PDF** | Printable Cornell Notes layout — question on the left column, answer on the right. Opens a print dialog automatically. |
| **Markdown** | The deck as a `.md` file using `::` block format |
| **JSON** | Full deck with card statuses and study notes — can be re-imported into this app |
| **SQL** | `INSERT … ON CONFLICT` statements for the `decks`/`cards` tables — restore or seed a Supabase project directly |

Any deck in the library — not just the one currently open — can be exported from **My Decks** (per-deck **Export**, bulk **Export** for a selection, or **Export All**).

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

A **category filter** above the table narrows the list, and **Export All** downloads the whole library (on-device *and* cloud) as Cornell PDF, Markdown, JSON, or SQL.

Per-deck actions:

| Action | What it does |
|---|---|
| **Load** | Opens that deck into the study view (pulls it down first if it's cloud-only) |
| **Export** | Downloads that one deck as Cornell PDF, Markdown, JSON, or SQL — works offline for on-device decks |
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

| Control | What it changes |
|---|---|
| **Theme** | Switches between the 10 built-in themes (7 dark, 3 light) |
| **Question / Answer font** | Font family for the front / back of the card |
| **Question / Answer size** | Font size for the question / answer |
| **Question fill** | What percentage of the card height the front occupies |
| **Card width** | How wide the card is relative to the screen |
| …and more | Spacing, padding, corner radius, line height, and other layout dimensions |
| **Sync Up** | Saves your current style settings to Supabase so they apply on every device |
| **Sync Down** | Loads the last-synced style from Supabase (overwrites local settings) |
| **Apply** | Applies the edited settings to the current view |

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
| `Ctrl`/`⌘` + `E` | Toggle edit / rendered view |
| `Escape` | Close any open panel or modal |

---

## PWA / Offline Support

When served over HTTPS (GitHub Pages, Netlify, etc.), the app registers a service worker and can be installed as a PWA:

- **Desktop** — browser shows an "Install app" button in the address bar
- **Mobile** — use "Add to Home Screen" in the browser menu

### Working offline

The service worker **precaches the entire dependency set on first load** — the app shell plus every CDN library (marked, DOMPurify, KaTeX + all its math fonts, Prism + the common language grammars, Mermaid, nomnoml, JSZip, Turndown, Panzoom, the Supabase client). So after a single online visit the app is fully self-contained: math, diagrams, syntax highlighting, and exports all work with no connection, not just the features you happened to exercise while online.

- **Registers unconditionally** — the worker installs on the login/setup screen too, before you sign in or configure a cloud project, so the offline cache is in place from the very first visit.
- **Stays signed in** — your session is read from local storage, so you reach your decks instead of the login wall. (You must have signed in online at least once; a fresh sign-in/sign-up still needs the network.)
- **Working deck is never lost** — every edit is auto-saved to the **My Decks** library (debounced, plus a final flush when the tab is hidden or closed), so nothing is lost if the app is closed mid-session. A reload starts on the clean home screen by design; reopen your deck from **My Decks**.
- **Full library offline** — because every cloud deck is mirrored onto the device automatically, **My Decks** works fully offline; you can load, rename, and delete saved decks with no connection.
- An **Offline** badge appears (bottom-left) whenever you lose connection.

A first-time login still needs the network, and any edits made offline (including deletes) reconcile with the cloud automatically once the connection returns. Remote user content that isn't part of the app itself — images hosted on ImgBB/Google Drive, `Fetch from URL`, and the Jina Reader import — naturally still needs a connection.

---

## Architecture

| Concern | Approach |
|---|---|
| Framework | None — plain HTML + CSS + JS, no build step |
| Markdown rendering | [marked](https://marked.js.org/) + [DOMPurify](https://github.com/cure53/DOMPurify) |
| Math | [KaTeX](https://katex.org/) via `auto-render` |
| Diagrams | [Mermaid](https://mermaid.js.org/) + [nomnoml](https://nomnoml.com/) |
| Code highlighting | [Prism](https://prismjs.com/) (autoloader) |
| PDF export | Print-to-PDF via a generated standalone document |
| ZIP import/export | [JSZip](https://stuk.github.io/jszip/) |
| Markdown export | [Turndown](https://github.com/mixmark-io/turndown) |
| Database | [Supabase](https://supabase.com/) (Postgres + Auth + per-user RLS) — schema in `supabase_schema.sql`, migrations in the other `supabase_*.sql` files |
| Auth | Supabase email + password (`signInWithPassword` / `signUp`) |
| Cloud sync | Automatic two-way reconcile, last-write-wins per deck by `updated_at`; cross-device delete tombstones in `deleted_decks` |
| Config storage | `localStorage` — Supabase URL, anon key, and ImgBB key never touch the source code |
| Image hosting | [ImgBB](https://api.imgbb.com/) (browser-side WebP optimization before upload) |
| Offline | Service worker (`sw.js`) + Cache API; full deck library mirrored on-device |
| Deployment | Any static host — GitHub Pages, Netlify, Vercel, local server |

The entire application logic lives in `app.js` (`index.html` + `styles.css` for markup and styling). There are no modules, no transpilation, and no runtime dependencies beyond what the CDN `<script>` tags load.
