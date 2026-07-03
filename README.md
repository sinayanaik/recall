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
- [Web Decks (Cloud Sync)](#web-decks-cloud-sync)
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
- **Toast confirmations** — every cloud action (sync, load, delete, rename, export, quick note) pops a toast so you always know it worked
- **All Cards panel** — browse, search, and edit every card in a deck at once
- **Cloud sync** — push any local deck to Supabase; pull it back on any device
- **Multi-user auth** — email + password login; no credentials stored in the source code
- **Per-project config** — Supabase URL and anon key are entered at first launch and stored in `localStorage`; swap them anytime
- **Exports** — Markdown, JSON, SQL, and Cornell Notes PDF (filtered by Known / Review / All)
- **Themes** — 10 built-in themes (dark and light variants) with a full style editor for fonts, sizes, and colours
- **PWA** — installable on desktop and mobile, works offline after first load

---

## Self-Hosting

The entire app is three files: `index.html`, `styles.css`, `app.js`. All dependencies are loaded from CDN at runtime.

### Option 1 — Local (development / personal use)

```bash
git clone <repo-url>
cd Markdown_Flashcards
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

### 2. Create the tables

Open the **SQL Editor** in your Supabase dashboard and run:

```sql
-- Decks table
CREATE TABLE public.decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  notes TEXT NOT NULL DEFAULT '',
  current_card_index INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX decks_category_last_accessed_at_idx
  ON public.decks (category, last_accessed_at DESC);

CREATE INDEX decks_last_accessed_at_idx
  ON public.decks (last_accessed_at DESC);

-- Cards table
CREATE TABLE public.cards (
  id TEXT PRIMARY KEY,
  deck_id TEXT REFERENCES public.decks(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  position INT NOT NULL,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Style settings table (one shared row keyed to 'global')
CREATE TABLE public.app_style_settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3. Enable Row Level Security and add policies

```sql
-- Enable RLS
ALTER TABLE public.decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_style_settings ENABLE ROW LEVEL SECURITY;

-- Any authenticated (logged-in) user gets full access
CREATE POLICY "Authenticated full access" ON public.decks
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated full access" ON public.cards
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated full access" ON public.app_style_settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

### 4. Create a user account

In Supabase Dashboard → **Authentication → Users → Add user**.  
Enter an email and password. The user is created immediately — no email required.

To allow self sign-up from the app: **Authentication → Providers → Email → turn off "Confirm email"**.

### 5. Get your API credentials

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

Click **Deck → Import** in the top-left toolbar to open the Import panel.

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
By default importing replaces the current deck. To add cards to an existing deck without replacing it, use **Deck → Import** and choose the append option in the paste editor.

---

## Toolbar Reference

### Deck menu (top-left)

| Button | Action |
|---|---|
| **Deck** | Opens the deck menu |
| **New Deck** | Clears the current deck and starts a blank one |
| **Import** | Opens the Import panel to load cards from a file, URL, or paste |
| **Web Decks** | Opens the Web Decks panel to browse and load decks stored in Supabase |
| **My Decks** | Opens the on-device deck library — load, rename, or delete decks saved locally (works offline) |

### Main toolbar buttons

| Button | Action |
|---|---|
| **Save to Device** | Saves the current deck to this device's local library (works offline) |
| **Sync to Cloud** | Syncs the currently loaded local deck to your Supabase database (shows a confirmation toast) |
| **Web Decks** | Opens the Web Decks panel (auto-loads the deck list) |
| **My Decks** | Opens the on-device deck library (works offline) |
| **Export** | Opens the export menu (see [Exporting](#exporting)) |
| **All** | Opens the All Cards panel — browse and edit every card at once |
| **Aa** | Opens the Style Settings panel to customise fonts, sizes, and theme |
| **Sign out** | Signs out of the current session and returns to the login screen |

### Study view buttons

| Button | Action |
|---|---|
| **← Review** | Marks the current card as Review (needs more practice) |
| **Known →** | Marks the current card as Known |
| **✎** (pencil, question side) | Switches the question to edit mode (shows the formatting toolbar) |
| **✎** (pencil, answer side) | Switches the answer to edit mode (formatting toolbar + **📌** Quick Note button) |
| **+** | Adds a new blank card after the current position |
| **✕** | Deletes the current card |
| **◀ ▶** | Navigate to previous / next card |

### End-of-deck replay buttons

These appear when you reach the last card:

| Button | Action |
|---|---|
| **Replay Review** | Restarts the session with only Review-marked cards |
| **Replay Known** | Restarts with only Known-marked cards |
| **Replay Uncategorized** | Restarts with cards not yet marked either way |
| **Replay All** | Restarts with all cards in the deck |

---

## Studying

- **Flip the card** — click/tap the card, or press `Space` / `Enter`
- **Navigate** — swipe left (next) or right (previous) on mobile; `→` / `↓` and `←` / `↑` on desktop
- **Mark Known** — click **Known →** or swipe right past the threshold; the card moves to the Known stack (right panel)
- **Mark Review** — click **← Review** or swipe left past the threshold; the card moves to the Review stack (left panel)
- **Click a card in the stack** — loads that specific card directly
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
| **[…]** | Cloze — hide the selection as a fill-in-the-blank (`{{text}}`); tap it on the card to reveal |
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

The selection is saved as a new card in a dedicated **`quick_notes`** cloud deck, which is created automatically the first time you use the feature. The selected text becomes the card's **question**, leaving the **answer blank** for you to fill in later. A toast confirms the save, and you can open the `quick_notes` deck any time from **Web Decks**.

> **Requires sign-in.** Quick Notes are stored as a cloud deck in Supabase, so you must be logged in. If you are not connected/signed in, a toast explains why the note could not be saved.

---

## All Cards Panel

Click **All** in the toolbar to open a full list of every card in the current deck.

- **Search** — type in the search box to filter cards by question or answer text
- **Toggle answers** — click **Show All Answers** / **Hide All Answers** to expand or collapse every answer at once
- **Edit inline** — click the pencil icon on any card to edit the question or answer directly in the list
- **Delete a card** — click the **✕** button on a card row
- **Status badges** — each card shows its current Known / Review / Uncategorized status

---

## Exporting

Click **Export** in the toolbar. Choose a scope and format:

### Scopes

| Scope | Which cards are included |
|---|---|
| **Known** | Only cards marked as Known |
| **Review** | Only cards marked as Review |
| **All** | Every card in the deck |

### Formats

| Format | Description |
|---|---|
| **Cornell PDF** | Printable Cornell Notes layout — question on the left column, answer on the right. Opens a print dialog automatically. |
| **Markdown** | The deck as a `.md` file using `::` block format |
| **JSON** | Full deck with card statuses — can be re-imported into this app |
| **SQL** | `INSERT` statements compatible with Supabase / PostgreSQL |

---

## Web Decks (Cloud Sync)

Web Decks are decks stored in Supabase. They are available on any device and any browser that is logged into the same account.

### Syncing a local deck to the cloud

1. Load a deck locally (import or create)
2. Click **Sync to Cloud** in the toolbar
3. A preview diff appears showing what changed vs. the existing cloud version
4. Choose **Overwrite** (fully replace the cloud copy) or **Merge** (keep any cloud-only cards)
5. Click **Confirm Sync**

The sync confirmation modal shows:
- Cards that will be **added**
- Cards that will be **updated**
- Cards that will be **deleted**

When the sync finishes, a toast confirms success (or reports the error) — see [Notifications](#notifications).

### Web Decks panel buttons

Open **Deck → Web Decks** to see the panel. The deck list is **fetched automatically every time you open the panel**, so it is never stale — use **Refresh List** any time you want to pull the latest manually.

| Button | Action |
|---|---|
| **Refresh List** | Re-fetches the deck list from Supabase (the list also auto-loads on open) |
| **Load** (per deck) | Loads that deck into the study view |
| Deck title (click) | Opens an inline editor to rename the deck |
| Category badge (click) | Opens a dropdown to change or create a category |
| **Delete** (per deck) | Permanently deletes the deck and all its cards from Supabase |
| Export icon (per deck) | Exports that single deck as Markdown, JSON, SQL, or Cornell PDF |
| **Checkbox** | Select a deck for bulk actions |
| **Load Selected** | Loads all checked decks, merging them into one session |
| **Delete Selected** | Permanently deletes all checked decks |
| **Export Selected** | Exports all checked decks as a single file |
| **Export All** | Exports every deck in the database as a single file |
| Category filter dropdown | Filters the list to show only decks in the selected category |

---

## Notifications

Every action that touches the cloud gives you immediate, unmistakable feedback through a **toast** — a small notification that slides in at the top-center of the screen and dismisses itself after a couple of seconds (click it to dismiss early). Because toasts are not tied to the button you clicked, you get confirmation no matter where the action was triggered from.

| Result | Example toast |
|---|---|
| **Success** | ✓ "Synced *Deck* to cloud · N cards", "Deck loaded", "Saved to quick_notes", "Refreshed · N decks" |
| **Error** | ✕ "Cloud sync failed", "Couldn't load deck", "Couldn't save quick note" |

Toasts appear for syncing, loading, deleting, renaming, re-categorising, exporting (single, selected, and all), refreshing the Web Decks list, and saving Quick Notes. The detailed status text at the bottom of the screen is still updated as well.

---

## Style Settings

Click **Aa** in the toolbar to open the style panel.

| Control | What it changes |
|---|---|
| **Theme** | Switches between 10 built-in colour themes (dark and light variants) |
| **Question font** | Font family for the front of the card |
| **Answer font** | Font family for the back of the card |
| **Question size** | Font size for the question |
| **Answer size** | Font size for the answer |
| **Question fill** | What percentage of the card height the front occupies |
| **Card width** | How wide the card is relative to the screen |
| **Sync Style** | Saves your current style settings to Supabase so they apply on every device |
| **Load Style** | Loads the last-synced style from Supabase (overwrites local settings) |

Style profiles are separate for desktop and mobile, so the card can look different on different screen sizes.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` / `Enter` | Flip card (show answer / hide answer) |
| `→` / `↓` | Next card |
| `←` / `↑` | Previous card |
| `Escape` | Close any open panel or modal |

---

## PWA / Offline Support

When served over HTTPS (GitHub Pages, Netlify, etc.), the app registers a service worker and can be installed as a PWA:

- **Desktop** — browser shows an "Install app" button in the address bar
- **Mobile** — use "Add to Home Screen" in the browser menu

### Working offline

After you've opened the app online at least once (so the app shell and libraries are cached), it stays usable with no connection:

- **Stays signed in** — your session is read from local storage, so you reach your decks instead of the login wall. (You must have signed in online at least once; a fresh sign-in/sign-up still needs the network.)
- **Working deck is never lost** — the current deck is auto-saved to the device and restored on reload, online or off.
- **My Decks (on-device library)** — **Save to Device** stores the current deck locally; open **My Decks** to load, rename, or delete saved decks. All of this works fully offline.
- **Web Decks are mirrored** — any Web Deck you open while online is automatically copied into **My Decks**, so you can study it later offline.
- An **Offline** badge appears (bottom-left) whenever you lose connection.

Cloud-only actions — **Sync to Cloud**, browsing **Web Decks**, and a first-time login — still require an internet connection. Attempting **Sync to Cloud** while offline saves the deck to your device instead.

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
| Database | [Supabase](https://supabase.com/) (Postgres + Auth + RLS) |
| Auth | Supabase email + password (`signInWithPassword`) |
| Config storage | `localStorage` — URL and anon key never touch the source code |
| Offline | Service worker + Cache API |
| Deployment | Any static host — GitHub Pages, Netlify, Vercel, local server |

The entire application logic lives in `app.js`. There are no modules, no transpilation, and no runtime dependencies beyond what the CDN `<script>` tags load.
