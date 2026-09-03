# Recall — Setup Guide

Recall is a static flashcard and study-notes web app backed by **your own Supabase project**. No build step, no framework, no npm — you serve a folder and the app runs.

> [!NOTE]
> **Looking for how to *use* Recall?** It's documented inside the app: open the **☰** menu → **? Help & Guide**. Thirteen sections cover loading decks, study notes, documents, handwriting with a stylus, studying, keyboard shortcuts, swipe gestures, editing and formatting, clozes, images, quick notes, progress, the All Cards panel, sync, offline behaviour, card format and themes.
>
> **This README is the setup guide, and nothing else.**

---

## Contents

- [Before you start](#before-you-start)
- [Step 1 — Put the files on a web server](#step-1--put-the-files-on-a-web-server)
- [Step 2 — Create a Supabase project](#step-2--create-a-supabase-project)
- [Step 3 — Run the setup SQL](#step-3--run-the-setup-sql)
- [Step 4 — Let accounts sign in](#step-4--let-accounts-sign-in)
- [Step 5 — Copy your API credentials](#step-5--copy-your-api-credentials)
- [Step 6 — Connect the app and create your account](#step-6--connect-the-app-and-create-your-account)
- [Verify the setup](#verify-the-setup)
- [Troubleshooting](#troubleshooting)
- [Upgrading an existing install](#upgrading-an-existing-install)
- [More than one person on one project](#more-than-one-person-on-one-project)
- [Notes for self-hosters](#notes-for-self-hosters)
- [Reference — what the SQL creates](#reference--what-the-sql-creates)
- [Reference — files in this repo](#reference--files-in-this-repo)

---

## Before you start

Recall is two halves, and it needs both:

| | What | Why |
|---|---|---|
| **The files** | This folder, served over HTTP | The app itself |
| **A backend** | A free [Supabase](https://supabase.com) project | Accounts, deck sync, image hosting |

There is **no local-only mode.** The first screen asks for a Supabase URL and key, and nothing behind it opens until you sign in. Decks are then stored on the device *and* mirrored to your project — the local copy is what makes it work offline, but the project is not optional.

**You need:** a Supabase account, and any way to serve a folder over HTTP. About ten minutes, most of it waiting for the project to provision.

**Your data stays yours.** It's your Supabase project; there is no service in the middle. Row Level Security scopes every row to the account that created it, so several people can share one deployment without seeing each other's libraries.

**Everything the app needs to start is in this repo.** The libraries the first render depends on — marked, DOMPurify, KaTeX (with its fonts), Prism (with 46 grammars) and supabase-js — are served from `vendor/`, same-origin, and precached before the service worker takes over. So the app opens with no network at all, on a connection that hangs, and on a network that blocks `cdn.jsdelivr.net` outright.

They used to be parser-blocking `<script>` tags pointed at that CDN, which meant a blocked or merely *hanging* CDN gave you a blank page — nothing in this app paints before its JavaScript runs. Worse, the worker cached them under a name containing the commit sha, so **every release threw them away**, and any launch without a connection between the update and the next successful download had nothing to load.

The heavy on-demand libraries (Mermaid, JSZip, nomnoml, Turndown) are still fetched from `cdn.jsdelivr.net` the first time you draw a diagram, run a backup or paste rich text — but they now live in a cache a release does not touch, so they are downloaded once rather than once per deploy. Until one has been fetched at least once, that one feature degrades: a diagram renders as its source, a backup asks you to go online. Everything else works.

**Sign-in still needs the network**, once. After that the session is stored on the device, and a launch with no connection opens straight into your library.

---

## Step 1 — Put the files on a web server

There's nothing to build. Deploy the folder as-is.

The one thing a deploy has to do is give each release a version, because versioned assets (`src/main.js?v=…`) are cached first and never revalidated. On GitHub Pages that is handled for you by `.github/workflows/deploy.yml`, which stamps the commit SHA in at publish time — see [Notes for self-hosters](#notes-for-self-hosters) if you deploy some other way.

> [!IMPORTANT]
> **Don't open `index.html` by double-clicking it.** On a `file://` URL Supabase Auth rejects the origin *and* the service worker refuses to register, so you get neither sign-in nor offline support. It must be served over HTTP.

Pick whichever suits you:

| | How | HTTPS | Installable + offline |
|---|---|---|---|
| **Local** | `cd recall && python3 -m http.server 8080`, then open `http://localhost:8080` | no | **yes** — `localhost` counts as a secure context |
| **Local, reached from your phone over Wi-Fi** | Same command, open `http://192.168.x.x:8080` | no | **no** — a bare LAN IP is not a secure context, so the service worker never registers |
| **GitHub Pages** | Push the repo → **Settings → Pages** → set **Source** to **GitHub Actions** → `https://<user>.github.io/<repo>/` | yes | yes |
| **Netlify / Vercel** | Drag the folder into Netlify Drop, or connect the repo. Leave the build command and output directory **empty** | yes | yes |

To try the installable PWA on a phone, use one of the HTTPS rows. The LAN-IP route looks like it works and then silently has no offline cache.

---

## Step 2 — Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. **New project.** Any name and region will do; pick the region nearest you.
3. Save the database password it gives you somewhere safe. The app never uses it, but you'll want it if you ever connect with a SQL client.
4. **Wait for provisioning to finish.** The SQL Editor in the next step will error on a project that is still starting up.

Nothing else in the dashboard needs configuring yet — Auth is enabled by default.

---

## Step 3 — Run the setup SQL

In your project, open **SQL Editor → New query**. Copy **everything** in the block below, paste it in, and click **Run**.

This is the only SQL you need — one run creates all four tables, every column, the indexes the sync depends on, all Row Level Security policies, and the two private storage buckets (`images` and `documents`) with their policies. The same thing also ships in this repo as **`supabase_setup.sql`** if you'd rather copy from the file; the two are identical.

> [!TIP]
> **It's safe to re-run, and safe on a project that already holds decks.** Every statement is guarded or additive, so this is also the upgrade path — run it again after pulling a new version of Recall.
>
> Expect a wall of `NOTICE: … already exists, skipping`. That is what success looks like. Only a line beginning **`ERROR`** is a failure.

```sql
-- ============================================================================
-- Recall — complete Supabase setup. Run this ONE file and nothing else.
-- ============================================================================
-- Paste the whole thing into your project's SQL Editor (Supabase Dashboard →
-- SQL Editor → New query) and run it. It creates every table, column, index,
-- Row Level Security policy and Storage bucket the app needs.
--
-- SAFE TO RE-RUN, and safe on a project that already holds decks. Every
-- statement is guarded or additive, so this file is also the upgrade path:
-- re-run it after pulling a new version of Recall to pick up whatever is new.
-- Lines reading `NOTICE: … already exists, skipping` are what success looks
-- like; only a line beginning `ERROR` is a failure.
--
-- Requires Supabase Auth to be enabled (it is, by default). Each account sees
-- only its own decks, cards, notes, tombstones and images.
--
-- This is the only SQL file in the repo. It replaced seven per-feature files
-- (supabase_schema, _image_storage, _deck_notes, _deck_categories,
-- _deck_tombstones, _quick_notes, _style_settings) and is a strict superset of
-- all of them, so an older setup note that names one of those just means: run
-- this instead.
--
-- Upgrading a deployment old enough to predate authentication? Run this file,
-- then read section 8 at the bottom — there is one manual step.
-- ============================================================================


-- ============================================================================
-- 1. decks — one row per deck
-- ============================================================================
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  -- A "/"-delimited folder path, e.g. 'Math/Calculus/Derivatives'. A legacy
  -- flat category is simply a single-segment path, so no data migration is
  -- ever needed when folders are introduced.
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  -- The deck's freeform markdown study notes.
  notes TEXT NOT NULL DEFAULT '',
  -- Deck-level JSON bag: nine keys belonging to six unrelated features. It is
  -- not the quick_notes-only column this comment used to describe, and the
  -- difference matters to anyone reasoning about a sync — the whole column is
  -- sent on every deck push, so every writer has to merge rather than replace
  -- (src/sync/document-sync.js, mergeDeckMeta). What lives in here:
  --
  --   pdf                  the attached PDF's name, size, page count, sha256
  --                        and storage path — a deck with this key has a
  --                        Document tab, and it is only ever written, never
  --                        removed ("Remove from cloud" sets offloaded: true)
  --   pdfHighlights        one record per highlight on that PDF: page, colour,
  --                        quads, and two independent stamps (at, noteAt)
  --   deletedHighlightIds  { id: iso } tombstones, so a deleted highlight
  --                        stays deleted across devices
  --   pdfToc               a contents read out of the pages, cached so
  --                        re-opening the deck does not scan them again
  --   readingPosition      where the reader got to, with its own `at`
  --   bookmark             the one spot they marked, with its own `at`
  --   linkIds              every id this deck answers to for [[links]] —
  --                        a union across devices, never one device's list
  --   quickNoteCategories  the quick_notes board's managed subject set
  --   noteAnchors          { cardId: anchor }, where each pinned note came from
  --   pages                a handwritten notebook's paper — one record per
  --                        page, with its size, which of the three papers it
  --                        is, and the strokes on it in the same encoded form
  --                        the ink on a PDF page rides in. A deck carrying this
  --                        key IS the notebook: no cards, no note, no file
  --   textBoxes            the draggable markdown boxes on those pages, each
  --                        with the page it belongs to, its box and its own `at`
  --   deletedPageIds       { id: iso } tombstones for the two above, so a page
  --   deletedTextBoxIds    or a box torn out stays torn out across devices
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_card_index INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- the app never sets user_id explicitly — it relies on this default. Without
  -- it every insert would leave user_id NULL and be rejected by the WITH CHECK
  -- of the "Users manage own decks" policy in section 6.
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Columns added after the first release. No-ops on a table this file just
-- created; on an older project these are what bring it up to date.
ALTER TABLE decks ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Uncategorized';
ALTER TABLE decks ALTER COLUMN category SET DEFAULT 'Uncategorized';
ALTER TABLE decks ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE decks ALTER COLUMN notes SET DEFAULT '';
ALTER TABLE decks ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE decks ALTER COLUMN meta SET DEFAULT '{}'::jsonb;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS current_card_index INT DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE decks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE decks ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
-- Paired with the ADD above for the same reason category/notes/meta/user_id are:
-- ADD COLUMN IF NOT EXISTS is a no-op on a project that already has the column,
-- so it cannot give one a default it never had. The superseded
-- supabase_deck_categories.sql carried this line and this file did not, which is
-- the one thing that stopped it being a strict superset of the older per-feature
-- files it replaces.
ALTER TABLE decks ALTER COLUMN last_accessed_at SET DEFAULT NOW();

-- Added WITHOUT NOT NULL, deliberately. auth.uid() is NULL in the SQL Editor
-- (there is no request context), so on a table that already has rows a NOT NULL
-- column with that default fails outright with "column contains null values".
-- Section 8 tightens it once those rows have an owner.
ALTER TABLE decks ADD COLUMN IF NOT EXISTS user_id UUID DEFAULT auth.uid();
ALTER TABLE decks ALTER COLUMN user_id SET DEFAULT auth.uid();


-- ============================================================================
-- 2. cards — one row per flashcard
-- ============================================================================
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  -- Order within the deck.
  position INT NOT NULL,
  -- 'known' / 'review' / NULL for uncategorised.
  status TEXT,
  -- Free per-card subject label used by the quick_notes board. NULL on regular
  -- study cards, which use `status` instead.
  category TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- Load-bearing: the sync merges PER CARD on this timestamp, not per deck, so
  -- two devices editing different cards in the same deck no longer overwrite
  -- each other. Do not add a trigger to it — see section 5.
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE cards ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- A card with no deck is unreachable: it cannot satisfy the policy in section 6
-- (which derives ownership from its deck) and no query in the app would return
-- it. Tightened only when the table is actually clean.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cards WHERE deck_id IS NULL) THEN
    RAISE NOTICE 'cards.deck_id left nullable: % orphan row(s) have no deck. Delete them, then re-run this file.',
      (SELECT COUNT(*) FROM cards WHERE deck_id IS NULL);
  ELSE
    ALTER TABLE cards ALTER COLUMN deck_id SET NOT NULL;
  END IF;
END $$;


-- ============================================================================
-- 3. deleted_decks — cross-device delete tombstones
-- ============================================================================
-- A deletion recorded only in one device's localStorage gets undone by the next
-- device that syncs a copy it still holds. This shared list is what every
-- device checks before treating an absent cloud row as "mine is newer,
-- re-create it". Nothing prunes it automatically, on purpose: a deletion has to
-- outlive any device that might still be holding a stale copy of the deck.
CREATE TABLE IF NOT EXISTS deleted_decks (
  deck_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE deleted_decks ALTER COLUMN user_id SET DEFAULT auth.uid();

-- Earlier versions declared user_id without a foreign key, so tombstones
-- outlived the account that made them. Skipped if any row already points at a
-- user that no longer exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deleted_decks_user_id_fkey' AND conrelid = 'deleted_decks'::regclass
  ) AND NOT EXISTS (
    SELECT 1 FROM deleted_decks d
    WHERE d.user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = d.user_id)
  ) THEN
    ALTER TABLE deleted_decks
      ADD CONSTRAINT deleted_decks_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;


-- ============================================================================
-- 4. app_style_settings — one row PER USER, id = that user's auth uid
-- ============================================================================
-- This table predates authentication and originally held a single shared row,
-- id = 'global'. On a deployment with more than one account that meant whoever
-- synced last silently overwrote everyone else's fonts, sizes and layout. The
-- legacy row is kept READABLE — an account that has never synced a style of its
-- own still inherits it — but is no longer writable.
CREATE TABLE IF NOT EXISTS app_style_settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE app_style_settings ALTER COLUMN settings SET DEFAULT '{}'::jsonb;

-- The app writes a flat JSON object of CSS-variable values. Anything else (an
-- array, a bare string) would be applied as garbage on every device that synced
-- it, so reject it at the door.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_style_settings_object' AND conrelid = 'app_style_settings'::regclass
  ) THEN
    ALTER TABLE app_style_settings
      ADD CONSTRAINT app_style_settings_object CHECK (jsonb_typeof(settings) = 'object');
  END IF;
END $$;

-- Unlike decks and cards, this table's updated_at is only ever displayed
-- ("Loaded <date>" in the style panel), never compared, so a trigger is safe
-- here and keeps the value honest even if a client forgets to send it.
CREATE OR REPLACE FUNCTION set_app_style_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_app_style_settings_updated_at ON app_style_settings;
CREATE TRIGGER set_app_style_settings_updated_at
  BEFORE UPDATE ON app_style_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_app_style_settings_updated_at();


-- ============================================================================
-- 5. Indexes
-- ============================================================================
-- Chosen from the queries the app actually issues. Note that RLS means EVERY
-- query is implicitly filtered by user_id, so a useful index has to LEAD with
-- it — an index on the sort column alone can satisfy neither half.
--
--   deck list, paged      decks          ORDER BY updated_at DESC
--   My Decks library      decks          ORDER BY last_accessed_at DESC
--   card download         cards          WHERE deck_id IN (…) ORDER BY position
--   card push             cards          WHERE deck_id = …
--   tombstone check       deleted_decks  paged read

CREATE INDEX IF NOT EXISTS decks_user_id_updated_at_idx
  ON decks (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS decks_user_id_last_accessed_at_idx
  ON decks (user_id, last_accessed_at DESC);

-- The single most important one. Postgres does NOT index a foreign key column
-- for you, and every sync reads cards by deck_id — including the per-deck card
-- count on the My Decks list, which is one count per deck. Without this, each of
-- those is a sequential scan of the entire cards table. `position` is included
-- so the ORDER BY comes free.
CREATE INDEX IF NOT EXISTS cards_deck_id_position_idx
  ON cards (deck_id, position);

CREATE INDEX IF NOT EXISTS deleted_decks_user_id_idx
  ON deleted_decks (user_id);

-- Superseded by the two user_id-leading indexes above, and unusable in their
-- own right: nothing filters by category server-side (the app filters the
-- fetched list on the device), and a bare last_accessed_at index cannot satisfy
-- the RLS user_id predicate. Dropping them removes write overhead on every save.
DROP INDEX IF EXISTS decks_category_last_accessed_at_idx;
DROP INDEX IF EXISTS decks_last_accessed_at_idx;

-- ----------------------------------------------------------------------------
-- No updated_at trigger on decks or cards — on purpose.
-- ----------------------------------------------------------------------------
-- The app writes both timestamps explicitly and depends on the exact values. A
-- push writes the deck row FIRST stamped at the UNIX epoch, and only rewrites it
-- with the real time once every card has landed, so an interrupted sync leaves
-- the deck looking un-synced and retriable instead of "current" with cards
-- missing. A BEFORE UPDATE trigger setting updated_at = NOW() would overwrite
-- that sentinel and quietly break crash recovery, and would also defeat the
-- per-card merge, which compares the cloud timestamp against the local one.


-- ============================================================================
-- 6. Row Level Security
-- ============================================================================
ALTER TABLE decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_style_settings ENABLE ROW LEVEL SECURITY;

-- Postgres has no CREATE POLICY IF NOT EXISTS, so each policy is dropped first
-- — which is also what lets re-running this file repair a deployment whose
-- policies have drifted. The wide-open "Anyone can …" policies of the pre-auth
-- releases are dropped by name too: leaving even one in place would OR itself
-- with the per-user policy below and expose every row to every visitor.
DROP POLICY IF EXISTS "Anyone can read decks" ON decks;
DROP POLICY IF EXISTS "Anyone can insert decks" ON decks;
DROP POLICY IF EXISTS "Anyone can update decks" ON decks;
DROP POLICY IF EXISTS "Anyone can delete decks" ON decks;
DROP POLICY IF EXISTS "Anyone can read cards" ON cards;
DROP POLICY IF EXISTS "Anyone can insert cards" ON cards;
DROP POLICY IF EXISTS "Anyone can update cards" ON cards;
DROP POLICY IF EXISTS "Anyone can delete cards" ON cards;
DROP POLICY IF EXISTS "Anyone can read app style settings" ON app_style_settings;
DROP POLICY IF EXISTS "Anyone can insert app style settings" ON app_style_settings;
DROP POLICY IF EXISTS "Anyone can update app style settings" ON app_style_settings;
DROP POLICY IF EXISTS "Anyone can delete app style settings" ON app_style_settings;
DROP POLICY IF EXISTS "Signed-in users manage app style settings" ON app_style_settings;

DROP POLICY IF EXISTS "Users manage own decks" ON decks;
DROP POLICY IF EXISTS "Users manage own cards" ON cards;
DROP POLICY IF EXISTS "Users manage own deck tombstones" ON deleted_decks;
DROP POLICY IF EXISTS "Users manage own app style settings" ON app_style_settings;

-- auth.uid() is wrapped in a scalar subquery in every policy below. Called
-- bare, it is re-evaluated once PER ROW; as `(select auth.uid())` the planner
-- hoists it into an InitPlan and runs it once for the whole statement. That is
-- the difference between a fast and a slow bulk upsert — cards go up 50 rows at
-- a time — and it matters most in the cards policy, whose predicate is itself a
-- subquery.

CREATE POLICY "Users manage own decks" ON decks
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- Ownership is derived from the parent deck rather than duplicated onto every
-- card, so a deck can never leave its cards behind. This is the predicate that
-- needs cards_deck_id_position_idx to be quick.
CREATE POLICY "Users manage own cards" ON cards
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM decks
      WHERE decks.id = cards.deck_id AND decks.user_id = (select auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM decks
      WHERE decks.id = cards.deck_id AND decks.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Users manage own deck tombstones" ON deleted_decks
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- A user reads their own row plus the legacy shared 'global' one, and may write
-- ONLY their own.
CREATE POLICY "Users manage own app style settings" ON app_style_settings
  FOR ALL TO authenticated
  USING (id = (select auth.uid())::text OR id = 'global')
  WITH CHECK (id = (select auth.uid())::text);


-- ============================================================================
-- 7. File storage — the `images` and `documents` buckets
-- ============================================================================
-- Pasted, dropped, picked and EPUB-imported images live in your own project
-- rather than a third-party host, which is also what makes deleting one from
-- inside the app possible.
INSERT INTO storage.buckets (id, name, public)
VALUES ('images', 'images', false)
ON CONFLICT (id) DO NOTHING;

-- ── Making the buckets private ──────────────────────────────────────────────
--
-- The `images` bucket shipped public-read, because a rendered `![](url)` had no
-- signed-in context to sign with. It does now: the app resolves a signed URL at
-- render time (src/cloud/storage-urls.js) and falls back to the canonical URL,
-- which its service worker answers from cache, when it cannot.
--
-- The bucket is NOT recreated, renamed or migrated. It is the same bucket,
-- holding the same objects at the same paths — one UPDATE flips the flag, and
-- the policy swap below replaces open read with owner-scoped read. Every URL
-- already sitting in your notes stays byte-identical; only anonymous read goes
-- away. Safe to re-run: an already-private bucket is updated to private again.
--
-- ORDER MATTERS. Run this file only AFTER deploying an app build that resolves
-- signed URLs — on an older build, every image in every note goes blank the
-- moment this statement lands.
UPDATE storage.buckets SET public = false WHERE id IN ('images', 'documents');

-- ── The `documents` bucket ──────────────────────────────────────────────────
--
-- Native PDF decks keep the original PDF as the document rather than extracting
-- it (see README → Documents). Its own bucket, private from the start, so a
-- paper is never anonymously readable and the storage panel can account for
-- documents separately from figures.
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- ── ...and how large a paper it will take ───────────────────────────────────
--
-- The app refuses a PDF over 100MB before it reads a byte of it
-- (MAX_DOCUMENT_BYTES, src/documents/pdf-store.js) and this bucket declared no
-- limit at all, which does NOT mean "no limit" — it means the project-wide
-- default applies, and on a new Supabase project that is 50MB. So a 60MB paper
-- passed the app's own check, imported, rendered, and then failed at the upload:
-- the deck is left readable on that one device with "it's on this device, but
-- not in the cloud", which is the honest message for a network failure and a
-- confusing one for a file that will never fit however many times you retry.
--
-- Stated here so the two agree. A separate UPDATE rather than a column on the
-- INSERT above, so a project that already has the bucket picks it up too, and
-- re-running the file is a no-op either way.
--
-- NOTE: a bucket cannot exceed the project's own upload limit, which lives in
-- the dashboard under Settings → Storage. If yours is still at 50MB, raise it
-- there as well or this line has no effect beyond documenting the intent.
UPDATE storage.buckets SET file_size_limit = 104857600 WHERE id = 'documents';

-- Dropped and recreated by name, exactly like the table policies in section 6 —
-- NOT skipped when already present. An earlier version of this section guarded
-- each policy with `IF NOT EXISTS … THEN CREATE`, which quietly made re-running
-- this file a no-op for anyone whose project had already been set up: a project
-- that ran the older supabase_image_storage.sql kept that file's bare
-- `auth.uid()` bodies forever, so the InitPlan hoisting explained in section 6
-- never reached the one workload that needs it most — an EPUB import inserts a
-- storage object per figure, hundreds in a row, and a bare auth.uid() in the
-- INSERT policy is re-evaluated for every one of them.
--
-- Policies are not data: dropping and recreating them loses nothing, and the
-- whole block is one statement, so the tables are never left uncovered.
DO $$
BEGIN
  -- A signed-in user may write only into a folder named after their own uid
  -- (the app prefixes every upload path with auth.uid()), so one account's
  -- session can never write into — or, via the delete policy, remove from —
  -- another account's images.
  --
  -- Only the FIRST path segment is checked, which is what lets the app file
  -- uploads into per-source subfolders underneath it:
  --   {uid}/books/{book-slug}--{importId}/{NNNN}-{figure}.webp   (EPUB import)
  --   {uid}/decks/{deck-slug}--{localDeckId}/{ts}-{rand}.webp   (paste/drop)
  --   {uid}/unfiled/{ts}-{rand}.webp                            (no owner yet)
  -- No policy change is needed for that nesting, and objects still sitting at
  -- the old flat {uid}/{ts}-{rand}.ext remain readable and deletable.
  DROP POLICY IF EXISTS "Authenticated users can upload their own images" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can delete their own images" ON storage.objects;
  DROP POLICY IF EXISTS "Anyone can view images" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can read their own images" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can upload their own documents" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can delete their own documents" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can read their own documents" ON storage.objects;

  CREATE POLICY "Authenticated users can upload their own images"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'images'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );

  CREATE POLICY "Authenticated users can delete their own images"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'images'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );

  -- Read used to be open to anyone, because a rendered `![](url)` carried no
  -- signed-in context to authenticate with. The app now signs each URL at
  -- render time from the session it already has (src/cloud/storage-urls.js),
  -- so read can be scoped exactly like write is — to the uid folder the object
  -- sits in. The canonical URL in the markdown is unchanged and still works as
  -- an identifier; it simply no longer serves bytes to a stranger who has it.
  --
  -- This policy is also what makes createSignedUrls work at all: signing is
  -- itself a read, so a user who cannot SELECT an object cannot sign it either.
  CREATE POLICY "Authenticated users can read their own images"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
      bucket_id = 'images'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );

  -- The same three, for the documents bucket. Uploads are filed as
  --   {uid}/pdfs/{paper-slug}--{importId}/{name}.pdf
  -- so the first-segment check below covers them exactly as it does images, and
  -- one paper's folder can be inspected or removed as a unit.
  CREATE POLICY "Authenticated users can upload their own documents"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'documents'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );

  CREATE POLICY "Authenticated users can delete their own documents"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'documents'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );

  CREATE POLICY "Authenticated users can read their own documents"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
      bucket_id = 'documents'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );
EXCEPTION
  -- Some projects don't let the SQL Editor's role alter storage.objects. The
  -- EXCEPTION block is a subtransaction, so the DROPs above roll back with it
  -- and the existing policies are left exactly as they were — a project that
  -- can't be upgraded keeps working instead of ending up with no policies and
  -- no image uploads at all.
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Storage policies left unchanged: this role may not alter storage.objects. Existing policies (if any) still apply; otherwise add them under Dashboard → Storage → Policies.';
END $$;


-- ============================================================================
-- 8. Claiming existing rows — pre-auth deployments only
-- ============================================================================
-- If decks.user_id was only just added, to a table that already had rows, then
-- those rows have no owner: RLS hides them from every account, so the app shows
-- an empty library while the data sits there untouched. This file cannot guess
-- who they belong to, so it leaves the column nullable and raises a notice.
--
-- Find your uuid in Authentication → Users, claim the rows, then re-run this
-- file to have the column tightened to NOT NULL:
--
--   UPDATE decks SET user_id = '<your-auth-user-uuid>' WHERE user_id IS NULL;
--
-- Cards need nothing — they inherit ownership through their deck.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM decks WHERE user_id IS NULL) THEN
    RAISE NOTICE 'decks.user_id left nullable: % row(s) have no owner and are hidden by RLS. Run the UPDATE in the comment above this block, then re-run this file.',
      (SELECT COUNT(*) FROM decks WHERE user_id IS NULL);
  ELSE
    ALTER TABLE decks ALTER COLUMN user_id SET NOT NULL;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'decks_user_id_fkey' AND conrelid = 'decks'::regclass
    ) THEN
      ALTER TABLE decks
        ADD CONSTRAINT decks_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;


-- ============================================================================
-- Done. One thing left, in the dashboard rather than here:
-- Authentication → Providers → Email → turn OFF "Confirm email", so the app's
-- own "Create account" button signs you straight in.
-- ============================================================================

COMMENT ON TABLE decks IS 'One row per deck. `category` is a "/"-delimited folder path; `meta` is a JSON bag (quickNoteCategories, noteAnchors); `notes` holds the deck''s freeform markdown study notes.';
COMMENT ON TABLE cards IS 'One row per flashcard, ordered within its deck by `position`. `status` is known/review/NULL; `category` is the quick_notes subject label. `updated_at` drives the per-card sync merge.';
COMMENT ON TABLE deleted_decks IS 'Durable cross-device delete tombstones. Never pruned automatically — a deletion must outlive any device still holding a stale copy.';
COMMENT ON TABLE app_style_settings IS 'Per-user layout/typography settings (row id = auth.uid()), plus a legacy shared ''global'' row that accounts with no style of their own inherit. The theme is stored here too, as a `theme` key holding a theme ID (e.g. ''dark-amoled'') alongside the ''desktop''/''mobile'' profiles, so a device that syncs its style down also gets the theme that went with it. Colour VALUES are still not included — those live in CSS, keyed off that ID.';
```

---

## Step 4 — Let accounts sign in

**Authentication → Providers → Email → turn "Confirm email" OFF.**

Recall's sign-in screen has its own **Create account** button. With email confirmation on, that button creates the account but sign-in then fails until someone clicks a link in an email — which, on a fresh project with no SMTP configured, never arrives. Turning it off makes account creation immediate.

If you'd rather leave confirmation on, create users by hand instead — **Authentication → Users → Add user** — since dashboard-created users are confirmed straight away.

---

## Step 5 — Copy your API credentials

**Project Settings → API.** You need two values:

| Field | Looks like |
|---|---|
| **Project URL** | `https://abcdefghijklm.supabase.co` |
| **anon / public key** | `sb_publishable_…` or `eyJ…` — a long string |

Two things to know:

- **The anon key is meant to be public.** It ships in the client of every Supabase app; Row Level Security is what protects your data, not key secrecy.
- **Never use the `service_role` key.** It bypasses RLS entirely, and pasting it into a browser app would expose every account's data to anyone who opens the page.

> The app's setup form requires a URL of the form `https://<something>.supabase.co`. A custom domain, or a self-hosted Supabase on another hostname, is rejected by that check.

---

## Step 6 — Connect the app and create your account

1. Open the app. The **Connect your Supabase project** screen appears.
2. Paste the **Project URL** and the **anon key**, then click **Connect**.
3. The **Sign In** screen appears. Click **Create account**, enter an email and password, and submit.
4. The app loads.

> [!WARNING]
> **Connect does not verify your credentials.** It only checks their shape — an `https://….supabase.co` URL and a key of at least 20 characters — then saves them to `localStorage`. A mistyped or truncated key is accepted here and fails at sign-in instead, with `Invalid API key`. If that happens, use **Change Supabase project** at the bottom of the sign-in screen and paste both values again.

The credentials live in this browser's `localStorage`, so later visits skip setup and go straight to sign-in. Each browser and device needs connecting once.

---

## Verify the setup

Five checks, in order. Each exercises a different part of what you just configured, so the first one that fails tells you where to look.

| # | Do this | Expected | If it fails |
|---|---|---|---|
| 1 | Sign in | The app loads | Steps 4–6: credentials, or email confirmation |
| 2 | **My Decks → ＋ New deck**, name it, type a line in Notes | The header pill reads **Saved on device** | Local storage only — nothing to do with Supabase. Check the browser isn't in a private window with storage blocked |
| 3 | Click **Sync Now** | The pill turns **Synced** | Step 3 — the SQL didn't run, or ran on a different project |
| 4 | In Supabase, **Table Editor → decks** | Your deck is there, `user_id` filled in | Same as above |
| 5 | Paste an image into a card or the notes | It uploads and renders within a second or two | Step 3 — section 7 of the SQL (the `images` bucket, and its read policy — a private bucket with no read policy uploads fine and shows nothing) |
| 6 | **☰ → App Info → Check my setup** | Every row ticked | Each row names the missing table, column, policy or bucket and what to re-run |

Step 6 is the fastest of the six: it probes the project directly — every table and column this version needs, the RLS policies, the `images` bucket, and whether your account can actually see its own decks — and tells you which part of `supabase_setup.sql` didn't take. It reads only; it never writes. It also runs itself once shortly after your first sign-in, so a half-applied schema announces itself instead of just quietly not working.

Two more worth doing if you plan to use more than one device:

- **Sign in on a second device** and click Sync Now. The deck should appear.
- **Delete a deck on one device**, sync both. It must stay deleted — that's the `deleted_decks` tombstone table doing its job.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Setup screen rejects the URL | It isn't `https://<ref>.supabase.co` | Copy it verbatim from Project Settings → API — no trailing slash, no path |
| Sign-in fails: **Invalid API key** | The anon key is truncated or from another project. Connect never verified it, so this is where a bad paste surfaces | **Change Supabase project**, re-paste both values |
| Sign-in fails: **Invalid login credentials** | The key is fine — the email/password is wrong, or the account doesn't exist | Use **Create account**, or add the user under Authentication → Users |
| Account created, but it says the email isn't confirmed | "Confirm email" is still on | Step 4 |
| **Create account** says "Check your email for a confirmation link" | "Confirm email" is on, and the account genuinely exists but can't sign in yet | Step 4, or click the link. On a project with no SMTP configured that mail never arrives, so turning confirmation off is the real fix |
| **Create account** says the email already has an account | It does — Supabase hides this behind a fake success, so the app infers it from an empty `identities` list | Switch to Sign In |
| "Couldn't load the sign-in library" on launch | `vendor/supabase-js` didn't load — a content blocker, or a half-finished install | Reload. If you already have decks on the device the app opens them anyway and only sync is paused. **Don't** use "Change Supabase project" — your saved settings aren't the problem |
| "Recall couldn't load some files it needs: …" on a near-blank screen | One of the vendored libraries is missing from the install | Reload on a working connection. The named file is the one to look for in devtools → Network |
| Pill reads **Signed out · tap to sign in** | The session lapsed (a refresh token expires after long disuse) | Tap it and sign in again. Nothing was lost — the decks are on the device |
| Something says the app is running a "mixed build" | The service worker had to serve one release's files under another release's URL, usually after a release picked up on a poor connection | Reload on a working connection |
| Sync seems to happen less often than expected | Auto-sync is per-device. It defaults to every 5 minutes, but an explicit **Off** is remembered | ☰ → the auto-sync interval control |
| `NOTICE: … already exists, skipping` when running the SQL | The schema was already applied | Nothing to do — that's a successful re-run. Only `ERROR` lines matter |
| `NOTICE: decks.user_id left nullable: N row(s) have no owner` | A pre-auth project's existing decks have no owner, so RLS hides them | See [Upgrading an existing install](#upgrading-an-existing-install) |
| Library looks empty, but Table Editor shows decks | Those rows' `user_id` is NULL, or belongs to another account | Same as above |
| Decks save locally, **Sync Now** fails | Schema missing, or the app is pointed at a different project | Re-run Step 3, then check Table Editor → `decks` |
| Every image paste fails, or says "Sign in to upload images" | The `images` bucket or its policies are missing | Re-run the SQL — section 7 creates them |
| Style sync says **Style sync blocked — check app_style_settings RLS policy** | Old wide-open policies from a pre-auth deployment | Re-run the SQL; it drops and replaces them |
| Works online, broken or blank offline | No service worker — you're on `file://`, or plain HTTP on a LAN IP | Step 1: serve over HTTPS or from `localhost` |
| A deck deleted on one device comes back | The `deleted_decks` table is missing | Re-run the SQL |
| **Device storage full — clear old decks to keep saving** | `localStorage` quota reached | Delete decks you no longer need from My Decks. Cloud copies are unaffected |
| Sync spins forever on a slow connection | Every cloud call has a timeout and retries | Wait for it to fail, then click Sync Now again. Local edits are never lost by a failed sync |

---

## Upgrading an existing install

**Re-run `supabase_setup.sql`.** It brings any older project up to date on its own: each column is added with `IF NOT EXISTS`, every policy is recreated, missing indexes are created, and the wide-open `"Anyone can …"` policies of the pre-auth releases are dropped by name — leaving even one of those in place would OR itself with the per-user policy and expose every row to every visitor.

Then hard-reload the app (or close every tab) so the service worker picks up the new files.

**Why re-running matters after an update.** The schema tracks the app. The per-card sync merge needs `cards.updated_at`; the Quick Notes board needs `cards.category` and `decks.meta`; folders need `decks.category`; and the current file adds indexes the sync path depends on — in particular `cards (deck_id, position)`, without which every card download *and* every deck's card count on the My Decks list is a sequential scan of the whole `cards` table, because Postgres does not index a foreign key column for you.

**Per-source image folders need no SQL at all.** Uploads are filed into `{uid}/books/…`, `{uid}/decks/…` and `{uid}/unfiled/…` subfolders rather than one flat `{uid}/` folder, and the three storage policies work unchanged: each matches `(storage.foldername(name))[1]`, which is the *first* path segment — [`storage.foldername()` returns every folder a file belongs to](https://supabase.com/docs/guides/storage/schema/helper-functions), so `public/subfolder/avatar.png` gives `['public','subfolder']` and `[1]` is `public`. A deeper key like `{uid}/books/my-book--k3f9/0001-fig1.webp` still presents the uid as segment 1 and is accepted; the segments beneath it are unconstrained by design.

So there is nothing to migrate for the folders themselves, and **nothing about the storage policies should be loosened to accommodate the nesting** — widening the `WITH CHECK` to allow paths whose first segment isn't the uid is exactly what would let one account write into another's images. Images already sitting at the old flat `{uid}/{timestamp}-{random}.ext` keep rendering and stay deletable too, because the app resolves a stored object's path from its URL at any depth.

**⚠️ Order matters for the private-bucket change: deploy the app FIRST, then run the SQL.** Section 7 now sets `images` to private. On a build that predates the signed-URL resolver, that statement makes every image in every note go blank the moment it lands — the markdown still holds a public URL, and there is no longer anything at it. Upload the new files, hard-reload once so the service worker takes them, *then* run the SQL. Nothing in your data changes either way: the same objects stay at the same paths under the same names, and the URLs already written into your notes are byte-identical afterwards.

**The `documents` bucket is new**, and only PDF decks use it. A project that never imports a PDF simply has an empty bucket. Its policies are the same three as `images`, keyed the same way on the first path segment.

**Re-running is still worth it for the storage policies.** Section 7 now drops and recreates its three policies by name, the way section 6 has always done for the table policies, instead of skipping them when they already exist. That guard made re-running a no-op for every project that was already set up — so a project that had run the older `supabase_image_storage.sql` kept that file's bare `auth.uid()` policy bodies indefinitely and never picked up the `(select auth.uid())` form, which Postgres hoists into an InitPlan and evaluates once per statement rather than once per row. An EPUB import is where that bites: it inserts one storage object per figure, hundreds in a row, each one re-running `auth.uid()` under the old bodies. Policies aren't data, so recreating them loses nothing, and if the role running the file isn't allowed to alter `storage.objects`, the whole block rolls back to whatever was already there and prints a `NOTICE` — an upgrade that can't be applied leaves image uploads working rather than stripping their policies.

### The one case that needs a manual step: a deployment older than authentication

On a project that predates auth, `decks` has no `user_id`, and the rows already in it have no owner. RLS then hides them from every account, so the app shows an empty library while the data sits there untouched.

The SQL can't guess who they belong to, so it adds the column, leaves it nullable, and prints:

```
NOTICE:  decks.user_id left nullable: 12 row(s) have no owner and are hidden by RLS.
```

Find your uuid under **Authentication → Users**, claim the rows, then re-run the setup SQL so the column is tightened to `NOT NULL`:

```sql
UPDATE decks SET user_id = '<your-auth-user-uuid>' WHERE user_id IS NULL;
```

Cards need nothing — they inherit ownership through their deck.

### The older per-feature SQL files

The repo used to carry seven more SQL files — `supabase_schema.sql`, `supabase_image_storage.sql`, `supabase_deck_categories.sql`, `supabase_deck_notes.sql`, `supabase_deck_tombstones.sql`, `supabase_quick_notes.sql` and `supabase_style_settings.sql`. They are gone: `supabase_setup.sql` is a verified strict superset of all of them, so following an older setup note just means running the one file instead. The only two things it does *not* create are `decks_category_last_accessed_at_idx` and `decks_last_accessed_at_idx`, which it deliberately drops — nothing filters by category server-side, and under RLS a bare `last_accessed_at` index cannot satisfy the implicit `user_id` predicate, so both were pure write overhead.

The 40-odd seeded layout defaults that `supabase_style_settings.sql` used to write into the shared `global` style row are gone with it. They were cosmetic and optional, and they duplicated `defaultStyleProfiles` in the app — a copy that had to be hand-synced and could only ever drift. The app's own built-in defaults are the single source of truth.

---

## Recovering decks lost to the old cross-device delete bug

Skip this unless a whole library vanished from every device at once. It is a runbook for a bug that no current version of the app can cause.

**What went wrong.** Every table is RLS-scoped to `auth.uid()`, so a query that reaches Supabase without a valid user token is *not* rejected — it succeeds and matches nothing. The old sync read that empty result as "every deck was deleted on another device": it removed the local copies, then wrote a row into `deleted_decks` for each one. Those rows are permanent and shared, so every other device read them as real deletions and dropped its copies too. One bad read on one device took the library everywhere.

The app no longer does any of that — it verifies the session before reading, refuses to treat an empty result as deletions, requires an absence to be seen by two syncs minutes apart, asks before any large removal, and never publishes a deletion it merely inferred. But rows written by the *old* code are still in `deleted_decks`, and they go on suppressing those decks on every device, including on a restore from backup.

**What this can and cannot get back.** It cannot resurrect deck contents from the cloud — those rows were really deleted and Postgres has nothing left to read. It removes the *block*, so a copy that survived elsewhere can come back:

- a device that still lists the decks (offline, or not synced since) re-uploads them on its next sync once the tombstones are gone — the main path, and the reason to act before syncing it;
- a Backup `.zip` restored from the app (a restore retires tombstones for the decks it brings back, so that path works either way);
- a Supabase PITR / daily backup restore, if your plan has one — the only route that recovers decks no device still holds. **Check that first** if the decks are gone everywhere; the window is time-limited.

**If a device still holds the decks, do not sync it until step 3 has run.**

The SQL Editor runs as `postgres`, not as you, so `auth.uid()` is `NULL` there and anything filtered on it would silently match nothing. Every query below resolves your id from your login email instead — replace `you@example.com` throughout. Check it resolves first; this must return exactly one row:

```sql
SELECT id, email FROM auth.users WHERE email = 'you@example.com';
```

**Step 1 — how much is tombstoned, and when.** The bug deleted a whole library at once, so it shows up as a big cluster of rows sharing a timestamp to the second. A few scattered rows are your own real deletions; leave those alone.

```sql
SELECT
  date_trunc('minute', deleted_at) AS deleted_minute,
  count(*)                         AS decks_tombstoned,
  min(deleted_at)                  AS first,
  max(deleted_at)                  AS last
FROM deleted_decks
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')
GROUP BY 1
ORDER BY 1 DESC;
```

**Step 2 — list the suspect rows before deleting them.** Set the window to bracket the cluster from step 1. Tombstones whose deck is still present in `decks` aren't the problem, so they're filtered out.

```sql
SELECT t.deck_id, t.deleted_at
FROM deleted_decks t
WHERE t.user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')
  AND t.deleted_at >= '2026-01-01 00:00:00+00'   -- ← just before the incident
  AND t.deleted_at <  '2030-01-01 00:00:00+00'   -- ← just after it
  AND NOT EXISTS (SELECT 1 FROM decks d WHERE d.id = t.deck_id AND d.user_id = t.user_id)
ORDER BY t.deleted_at DESC;
```

**Step 3 — clear them.** Same predicate as step 2. Run step 2 first and check the list is what you expect; this is the irreversible half.

```sql
DELETE FROM deleted_decks t
WHERE t.user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')
  AND t.deleted_at >= '2026-01-01 00:00:00+00'   -- ← same window as step 2
  AND t.deleted_at <  '2030-01-01 00:00:00+00'
  AND NOT EXISTS (SELECT 1 FROM decks d WHERE d.id = t.deck_id AND d.user_id = t.user_id);
```

The nuclear option clears every deletion record you have, real ones included. Only worth it if you're confident you never deliberately deleted a deck — the cost of being wrong is that decks you *did* delete come back from whichever device still holds a copy. No data is lost either way.

```sql
DELETE FROM deleted_decks
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com');
```

**Step 4 — on each device, in this order.** Open Recall on the device that still *has* the decks and tap **Sync Now**; it re-uploads them. Confirm with step 5 that they're back in the cloud, and only then sync the other devices, so they pull rather than push.

Each device also keeps its own local copy of these tombstones, which the SQL above cannot reach. Recall retires a local tombstone once the deck is back in the cloud, so step 4 clears them on its own. On a device that stays stubbornly empty, restoring a Backup `.zip` explicitly retires them for the decks it brings back.

**Step 5 — confirm.**

```sql
SELECT
  (SELECT count(*) FROM decks
     WHERE user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')) AS decks_in_cloud,
  (SELECT count(*) FROM deleted_decks
     WHERE user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')) AS tombstones_left;
```

Separately worth checking: deck rows whose `user_id` was never set are invisible to RLS, so the app sees them as missing no matter what `deleted_decks` says — which the old code also read as "deleted elsewhere". This should return `0`; if it doesn't, run the `UPDATE` in [the manual upgrade step](#the-one-case-that-needs-a-manual-step-a-deployment-older-than-authentication) to claim them.

```sql
SELECT count(*) AS decks_with_no_owner FROM decks WHERE user_id IS NULL;
```

---

## More than one person on one project

One deployment can serve any number of accounts. Each signs in with their own email, and Row Level Security means each sees only their own decks, cards, notes, tombstones and images — verified by policy, not by app code.

Two shared things to be aware of:

- **Both Storage buckets are private.** `images` used to be world-readable — an image was embedded as a plain public URL in the markdown, and there was no signed-in context when a card was rendered on another device. It isn't any more: the app resolves a signed URL at render time and falls back to the canonical URL, which its own service worker answers from cache, when it can't. Reads, writes and deletes are all confined to each user's own uid-named folder, in `images` and in `documents` alike, so one person's papers and figures are not readable by another even with the URL.
- **The legacy `global` style row is readable by everyone.** It holds layout numbers only — fonts, sizes, spacing — never any deck content, and no account can write to it.

Everything else is per-account. To keep libraries fully separate, give each person their own Supabase project instead.

---

## Notes for self-hosters

**If you edit the files, three things will bite you:**

- **Every shipped change needs a new version, and the deploy writes it — never type one.** It appears as the placeholder `__BUILD__` in `styles.css?v=…` and `src/main.js?v=…` in `index.html`, in `CACHE_NAME` in `sw.js`, in `BUILD_STAMP` in `src/core/build.js` (plus `BUILD_TIME`, the commit's timestamp), and **on every relative import in `src/`** — `from "./core/build.js?v=__BUILD__"`. `.github/workflows/deploy.yml` substitutes the deploying commit's short SHA into all of them and publishes the result to Pages; nothing is committed back, so the version in the deployed files is exactly the commit that produced them.

  The import stamps are not decoration. Without one, a module's URL is identical across releases, so a cache-first service worker (or the browser's own HTTP cache) can hand the *current* release's `main.js` the *previous* release's copy of a dependency. The deploy refuses to publish an unstamped relative import for that reason, and `tools/module-symbols.mjs` catches it before you push.

  This used to be a hand-edited `YYYYMMDD-NN` stamp, and the reason it isn't any more is that versioned assets are cached first and never revalidated. That makes a release load instantly, and makes a *forgotten* bump invisible: existing installs keep being served the bundle they already have, indefinitely. It happened twice in this repo's history, and you cannot catch it locally — on `localhost` the app deliberately unregisters its service worker and deletes every `recall-*` cache, so a version-less deploy always looks correct while you're building it and only ever breaks for other people. A commit SHA cannot be forgotten, because it changes on every commit whether you think about it or not.

  **If you deploy somewhere other than GitHub Pages** (Netlify, Vercel, a plain server), your build step must do the same substitution or every asset ships as `?v=__BUILD__` and stays frozen at that one version forever. The whole of it is:

  ```sh
  sha=$(git rev-parse --short=7 HEAD)
  sed -i "s/__BUILD__/$sha/g" index.html sw.js $(find src -name '*.js')
  sed -i "s|__BUILD_TIME__|$(git show -s --format=%cI HEAD)|g" src/core/build.js
  ```

  An unsubstituted checkout is not broken, just unversioned: App Info reports it as a development build and skips the update check rather than comparing a placeholder against a real commit.

- **Vendored libraries carry their version in the path**, not in a `?v=` stamp — `vendor/katex-0.16.11/katex.min.js`. That makes each URL immutable, which is what lets `sw.js` keep them in `recall-vendor-v1`, a cache the release sweep spares, and never re-download them. Never add `?v=__BUILD__` to a `vendor/` URL; the deploy refuses it. To change a version, edit the manifest in `tools/vendor-sync.mjs` and run it — it downloads, rewrites `vendor/lock.json`, and regenerates `VENDOR_ASSETS` in `sw.js`. `node tools/vendor-sync.mjs --check` verifies the hashes and runs as part of `check.mjs`.

  `@supabase/supabase-js` is pinned to an exact version for a reason worth keeping in mind: it is served cache-first and never revalidated, so back when it was a floating CDN `@2` it froze whatever jsDelivr happened to resolve on the day each user's cache was populated, leaving different people running different auth clients from identical code.

- **The remaining CDN libraries are pinned too**, in `LIB_URLS` (`src/core/lib-loader.js`) and `CDN_ASSETS` (`sw.js`), and the two lists must stay byte-identical — the cache is keyed by exact URL, so a mismatch precaches a file nothing asks for and sends the real request to a network that may not be there. They live in `recall-cdn-v1`, which a release also spares.

- **Nothing on the boot path may be a third-party request.** `index.html` must not carry a blocking `<script src="https://…">` or `<link rel="stylesheet" href="https://…">`. Both `tools/precache-check.mjs` and the deploy workflow refuse one, because the failure it causes — a blank page whenever that origin is slow, blocked or filtered — is invisible to every other check here.

- **A zero-row write is not an error.** PostgREST reports an `UPDATE` that matched nothing as a success, which under Row Level Security is also what "this row isn't yours" looks like. Writers that care use `.select("id")` and check what came back; if you add one, do the same.

**Backups.** The library lives in two places, and neither is a backup of the other on its own:

- Supabase gives you database backups on paid plans; on the free tier, use **My Decks → ⋯ → Export All → Backup (.zip)** for a full copy of everything: every deck and note, the images as real files, **the PDFs themselves**, the folder tree (including folders that hold no decks yet) and where you had got to in each note. The archive stands on its own — nothing in it depends on your Supabase project still being reachable.
- That same zip restores through **My Decks → ⋯ → Restore backup**. Restore is *additive* — it merges, never wipes. It checks the archive against its own `manifest.json` first and says what is missing before writing anything; it merges a deck's highlights, bookmark and note categories key by key rather than taking one side whole, so a *partial* loss is repairable; and it reports only what actually reached the disk.
- The ⋯ menu and **Storage & Data** both show when you last took one. Nothing is scheduled and nothing downloads on its own — a backup is still something you decide to do.
- **The images are inside the zip**, not linked from it: every picture a deck references is packed into `assets/`, with `assets/index.json` mapping each original URL to its file. So the archive works for someone who has no access to your Supabase project at all — restoring it copies those files onto their device and, if they have their own project, uploads them there on the next sync. Images already belonging to the project the restoring device is configured against keep their URLs (nothing is duplicated); they are just seeded into the offline cache. Older archives with no `assets/` folder still restore exactly as before.
- **The archive mirrors your library**, so it's browsable outside the app and restores back into the same shape:

  ```
  manifest.json                              every deck, folder and image
  decks/Science/Cell Biology/Mitosis-a1.json one file per deck, inside its folder path
  assets/Mitosis--a1/0001-spindle.webp       that deck's images, named like its Storage folder
  assets/index.json                          image reference → packed file
  ```

  Restoring puts decks back into those folders and files each restored image into this device's own `decks/{slug}--{id}` Storage folder. **A hand-made zip works too**: drop deck `.json` files into folders of your own naming and restore reads the folder path as the deck's folder (a deck that carries its own category keeps it). Files at the root land in *Uncategorized*, and `__MACOSX/`, `.DS_Store` and non-deck JSON are ignored. The restore preview names the folder each deck will land in before anything is written.

**Starting over.** Use **☰ → Storage & Data** in the app. It shows what the account is holding — decks, cards and delete records in the database, every file in the `images` bucket (grouped by folder, with the unused ones singled out), and what this device keeps locally — and empties any of it: unused images, all images, all cloud decks and cards, this device's copy, or everything at once. Nothing is dropped: tables, columns, indexes, RLS policies, buckets and your account all survive, so the app keeps working and simply starts from empty.

**Putting an image back.** The same panel reports the opposite of an unused image: a **Missing** count, naming files your decks still point at that are no longer in the bucket, so the picture is gone wherever that deck is read. **Restore missing images** puts back every one this device still holds a copy of — the device that uploaded a picture, and any device that has displayed it, keeps its bytes in the offline image cache — re-uploading to the same path, so every note pointing at it is fixed at once with no edit to any markdown. Ones this device has no copy of are left alone and counted, and **My Decks → ⋯ → Check for broken images** says which decks those are in.

Do the storage half here rather than in SQL — Supabase blocks it outright (`ERROR: 42501: Direct deletion from storage tables is not allowed. Use the Storage API instead.`), because rows deleted that way would leave the files themselves orphaned. The panel goes through the Storage API, so the files actually go. Take a backup first (**My Decks → ⋯ → Export All → Backup (.zip)**) — none of it is undoable, and a cloud wipe propagates: every device that had synced those decks drops its copy on its next sync.

**Storage limits.** The free tier's 500 MB database is far more than text decks will ever need; the 1 GB storage quota is the one to watch — and **PDF decks are what will actually spend it**, since a paper is stored whole and unmodified where a figure is a downscaled WebP. **☰ → Storage & Data** has a Documents section listing every stored PDF biggest-first, with a one-tap **Offload** on each: that deletes the cloud copy and keeps the highlights, the notes, the cards and the copy on this device, which makes "finish a paper, download it, offload it" a two-tap loop. If you paste a lot of images, every upload stops at a dialog first: pick a compression level (Original / High / Balanced / Small / Tiny, or your own quality and longest side), see each file's real before and after size, then confirm. **Balanced** — 1600 px, WebP at 82% — is the default and is what every image already in your notes was uploaded at, so typical screenshots land well under 100 KB. A bulk pick, a multi-file drop and a whole EPUB import each ask once, for all of their images together. GIFs and SVGs are passed through untouched to keep them animated/vector.

**Device storage.** Decks are also kept in `localStorage`, which browsers cap at roughly 5–10 MB per origin. Large libraries can hit it; the app then warns and stops auto-saving rather than corrupting anything. Images never go there — only their URLs do.

---

## Reference — what the SQL creates

| Table | Holds | Notable columns |
|---|---|---|
| `decks` | One row per deck | `category` — a `/`-delimited folder path · `notes` — the deck's markdown study notes · `meta` — JSON bag for Quick Notes subjects and note anchors |
| `cards` | One row per flashcard | `position` — order within the deck · `status` — known/review/NULL · `category` — Quick Notes subject label · `updated_at` — drives the **per-card** sync merge |
| `deleted_decks` | Delete tombstones | Never pruned automatically, so a deletion outlives any device still holding a stale copy |
| `app_style_settings` | Layout and typography, one row per user | Keyed on the user's auth uid, plus a legacy shared `global` row used as a fallback |

Plus four indexes (`decks (user_id, updated_at DESC)`, `decks (user_id, last_accessed_at DESC)`, `cards (deck_id, position)`, `deleted_decks (user_id)`), four RLS policies, and two **private** Storage buckets — `images` and `documents` — with three policies each: upload, delete *and read* all confined to the user's own uid-named folder.

`images` was public-read until native PDF documents landed, because a rendered `![](url)` carried no signed-in context to authenticate with. The app now signs each URL at render time from the session it already has (`src/cloud/storage-urls.js`), so read can be scoped exactly like write is. **The URLs in your notes did not change** — the bucket was not recreated, renamed or migrated, one `UPDATE` flipped its `public` flag and one policy swap replaced open read with owner-scoped read. That canonical `…/object/public/images/{uid}/…` string is now an *identifier* rather than a fetchable address: it is still what the markdown holds, still what the offline image cache is keyed by, and still what a delete resolves a path from.

Inside that per-user folder, uploads are filed by where they came from, so a bucket holding thousands of figures is still readable and one source's images can be cleared out as a unit:

| Path | Source |
| --- | --- |
| `{uid}/books/{book-slug}--{importId}/{NNNN}-{figure}.webp` | EPUB import — one folder per import **run**, keeping the book's own image filenames |
| `{uid}/decks/{deck-slug}--{localDeckId}/{ts}-{rand}.webp` | Image pasted or dropped into a deck's notes |
| `{uid}/unfiled/{ts}-{rand}.webp` | No owning deck yet (pasted before the deck's first save) |
| `{uid}/pdfs/{paper-slug}--{importId}/{name}.pdf` | PDF import — in the separate `documents` bucket, one folder per paper |

The `--{id}` suffix is what makes each folder unique: two imports of the same book, or two decks sharing a title, never share a folder. Because the id comes last, renaming a deck starts a new folder but every folder for that deck is still findable by its `localDeckId`. Only the RLS-checked first segment has to be the auth uid, so this nesting needs no policy change, and images already stored flat at `{uid}/{ts}-{rand}.ext` stay readable and deletable.

Two deliberate omissions, both explained in comments in the file: there is **no `updated_at` trigger** on `decks` or `cards` (the app writes an epoch sentinel during a push so an interrupted sync is retriable, and a trigger would overwrite it), and `cards` carries **no `user_id`** (ownership derives from the parent deck, so a deck can't leave its cards behind).

---

## Reference — files in this repo

| File | Role |
|---|---|
| `index.html` | The whole UI, the pre-JavaScript boot placeholder, the vendored `<script>` tags, and the `<link>`s for everything below |
| `src/` | All application logic, as ES modules — 150 files. `src/main.js` is the entry point the page loads and holds no logic of its own; everything else is imported from it |
| `styles/` | All styling, including the 10 themes — 35 files, **loaded in numeric order** |
| `vendor/` | Third-party libraries the first render needs, served same-origin so the app boots with no network. Generated by `tools/vendor-sync.mjs`; do not hand-edit |
| `sw.js` | Service worker — app-shell precache (per release), vendor + CDN + image caches (across releases) |
| `manifest.webmanifest`, `icons/` | PWA install metadata and icons |
| **`supabase_setup.sql`** | **The only SQL file. Run it once; re-run it to upgrade** |
| `tools/` | Development checks — not served, not needed to run the app. `tools/note-shapes.mjs` is the shared corpus of note and edit shapes the two splitter checks are both driven against |

### Checking a change

```sh
node tools/check.mjs           # everything except the release cycle (~1 min)
node tools/check.mjs --quick   # static checks only, no browser (~5s)
node tools/check.mjs --full    # ...and drive a real install / offline / update
```

Forty checks, each answering a different question, and none of them
subsuming another:

| Check | Question |
|---|---|
| `split-parity` | Is the code still the same code as before the split? |
| `scanner-audit` | Does the identifier scanner the next check relies on actually *see* every reference? |
| `module-symbols` | Does every cross-module reference resolve — imported, exported, not assigned, no dead-zone read across a cycle? |
| `css-parity` | Do `styles/*.css` still reassemble to the original stylesheet byte for byte? |
| `port-sync` | Do the browser extension's copied functions still match the app's? |
| `readme-sql` | Does the SQL this README tells you to paste still match `supabase_setup.sql`? The README embeds the whole file and asserts in prose that the two are identical, which is not self-enforcing — they drifted, and the documented setup path handed out the old schema |
| `boot-check` | Does the app boot, and reach the same state as the pre-split build? |
| `behaviour` | Do rendering, math, clozes, card parsing and the text transforms still produce identical output? (150 probes) |
| `sync` | Do the merge primitives behave identically, **and** still refuse to lose data? (43 scenarios + 25 invariants + 11 storage round-trips + 12 concurrency/batching checks) |
| `document-sync` | Do a paper's highlights and the notes written on them actually reach the other device — and stop claiming a conflict every time? Two simulated devices and one in-memory cloud row, driven through the real merge in the order the reconcile calls it: both devices annotating without pulling first, a note written on each for a different highlight, two notes on the *same* highlight settled by their own stamps (and kept side by side when nothing can settle them), a recolour on one device against a note on the other, a deletion that has to stay deleted and take its note with it, a genuinely different notes body that must *still* raise a conflict, a stranded conflict stash folded back in, and convergence — run the round twice and the second must change nothing. Pure Node: the merge is string-and-object work by design, so this needs neither a browser nor the `pre-modular` tag. It also asks whether the deck those annotations live on ever gets **saved**: a paper is the one deck shape that is empty by every other measure — no cards, and a body that is empty because the PDF *is* the document — so a save predicate spelled out twice can disagree about it, and one did. The navigation flush restated it and dropped the last 400ms of highlighting on every PDF deck |
| `text-sanitize` | Can a character that came out of a PDF still stop a whole deck from reaching the cloud? One book would not sync — "unsupported Unicode escape sequence", which is Postgres 22P05 — because pdf.js decodes a document string written as UTF-16BE with no BOM byte-by-byte, putting a U+0000 between every letter of the deck's own title. Invisible in the library, invisible in the report, and fatal to the entire push, since PostgREST parses the whole request body as JSON. So the assertions are about the JSON *body*, not about JavaScript strings: no `\u0000` escape and no half of a surrogate pair without its other half, over a deck's title, notes, cards and the whole `meta` bag including its keys. The harder half is the repair rather than the strip — sanitizing only what goes on the wire uploads the book and leaves this device holding text the cloud does not have, and `normalizeSyncText` does not touch NUL, so every card would read as edited on every sync forever; that failure is asserted too, so removing the local repair fails the check. Plus the things the strip must NOT do: keep newlines, tabs and the rest of C0 (Postgres accepts them, and `escapeXml` strips them for a different format's rules), keep valid emoji and CJK-extension pairs whole, return a clean 400-entry contents cache by reference rather than cloning it on every deck of every sync, and leave the four deliberate in-memory NUL join sentinels alone. Pure Node |
| `ink` | Does handwriting survive being stored, and does the pen refuse what it should? A stroke is quantised to an eighth of a point, delta-encoded, packed into base64url and simplified before it is stored — every one of those loses something on purpose, and what must not be lost is the handwriting. So: a round trip to within one quantisation step, a one-sample stroke still being a dot (a full stop in a margin note), a version this build does not know decoding to *nothing* rather than to a best guess, and seven shapes of corrupted string refused rather than half-read. Then the question a book's sync once turned on: an encoded page is checked in the JSON **body**, not as a JavaScript string, for a `\u0000` escape or half a surrogate pair — the format that ships handwriting into `meta` is a format that could do to a paper what pdf.js's UTF-16 decoding once did to a title. Plus a measured size ceiling, so the encoding cannot quietly regress into re-uploading a megabyte per sync. The other half is the straightener, which is nothing but thresholds, and where the assertions that matter are the REFUSALS: a written word, a scribble, a tick and — the one the size floor was actually moved for — a letter O, which fitted an ellipse at the first threshold tried. Turning somebody's handwriting into a circle is far worse than never offering, so a deliberate ring round one symbol in an equation is asserted as still snapping, on the other side of the same number. Pure Node: the wire format and the shape fitter are both leaves, deliberately, so this needs neither a browser nor the `pre-modular` tag |
| `merged-notes` | When several decks are read as ONE document — a folder opened as one deck, or several ticked in My Decks and loaded together — does every deck get back exactly what it put in? The document is cut apart and written back into those decks on every autosave, so anything the split cannot place is deleted from a real deck 400ms later, with nothing on screen to say so. The half that is invisible until it bites: a deck's notes may END with the fenced highlight-notes block, and that block is *defined* to be last — join five annotated decks and four of them stop being findable, their notes printed as prose in the middle of the reading view. So the tails come off, the entries are unioned into one block, and each is placed back on its own deck. Ten note shapes (prose, annotated, a paper whose body is empty because the PDF is the document, the legacy `## Highlight Notes` form, a section marker quoted inside a code fence, two decks that minted the same `hn-` id, …), every ordered pair of them and all ten at once, plus placement, refusal when a marker is deleted, and convergence. Pure Node |
| `backup` | Is the thing you pressed Backup for actually **in** the file? Nothing here had ever asked. Not one check drove a backup through to a restore, so every feature the app grew after the archive format was written reached it late, partially, or not at all — and the way you found out was needing the backup. The largest of them: a paper's HIGHLIGHTS were in the archive and the PDF they are coordinates into was not, so a restored paper pointed into a private bucket in the original owner's project — the exact failure `backup.js`'s own header says images were inlined to avoid. Worse on the SAME device, where the bytes were sitting on disk under a local id the restore replaced. Beside it: `manifest.json` was written and read by nothing, so empty folders were lost and a zip that had shed half its entries in transit restored the rest and reported success; the meta merge was `{ ...backup, ...local }`, so a PARTIAL loss (fifty of sixty highlights, a cleared bookmark) could not be repaired from a backup that still had them; and `applyRestore` printed "40 decks added" from a synchronous loop over writes that persist in the background. Half of this file is a real backup driven through to a real restore — a paper with highlights and the notes written on them, a deck three folders deep, an empty folder, a reading position, a damaged archive, a hand-made zip — and the other half is a **coverage floor**: it derives the deck-meta keys and IndexedDB databases the app actually writes, and fails on any that `src/backup/archive-format.js` has not classified as carried or deliberately not. So the next `meta.*` key added is a decision someone makes rather than a thing that quietly happens. Pure Node, and it cannot skip: JSZip is a CDN script, so the round trip runs over `src/backup/zip-lite.js` — the app's own stored-zip reader and writer, which is also what makes a backup possible with the CDN blocked — and one case asserts the backup never reaches for a JSZip member that fallback lacks |
| `reconcile` | Does the whole two-way sync behave identically end to end against a stand-in backend? |
| `ui-smoke` | Does the app still *work*? 35 real actions driven through the DOM on both builds and compared step by step |
| `selection` | Can you select text in a note without dragging the app's own chrome in with it? 7 real mouse drags. Also that the selection bar offers every one of its tools in one press, grouped by intent — measured at desktop width and again at 390px, which is where a ⋯ disclosure used to hide half of them behind a second tap |
| `mobile-select` | The same question with a finger. `touch-action` on every reading surface, the card swipe standing down for a dwelling finger (real touch events), containment suspended under a live selection, the paged snap held off, and the selection bar waiting for the drag to finish. The native long press and its two handles are browser UI and do not exist in headless Chrome, so that half is checked by hand on a real Android device |
| `touch-select` | The same question once more, now that the app OWNS the gesture instead of deferring to it. 69 cases of real touch input: a press timed from inside the page (measured at 4x CPU throttle too, because the native path's 3-4 second wait was a main-thread queue), a hesitation before a scroll giving the press back as a scroll while a press held past that window still slides into a selection, the app's own handles asserted against the boundaries they mark before and after a drag, a press in a block's left gutter, drags in both directions past the anchor, edge auto-scroll, and the painted highlight compared pixel by pixel against the same words unselected. Then whether it is STEADY, which is a different question: a selection surviving a scroll while a tap still dismisses it, the handles coming off the glass while the text moves and landing back on their boundaries after it, a boundary scrolled off the top keeping a grip parked at the edge that can still be dragged, thirty touchmoves inside one frame costing one extend rather than thirty, and one finished selection being described once instead of three times. Then whether it can be TAKEN AWAY, which is a third question and the one the reports kept coming back to: a slow deliberate slide off the press keeping its selection where a flick still hands the gesture back, a press refusing to fire onto a sequence the browser has already committed to scrolling, a drag the compositor takes mid-way ending with the words it had rather than smearing across a page it cannot hold, and a thumb brushing the edge band not taking the page away when only a thumb that DWELLS there should. The half `mobile-select` had to check by hand is drivable here, because handles the app draws are DOM elements. Closes by proving a desktop arms none of it and that a mouse drag there still selects |
| `incremental` | When an edit re-splits the note by PATCHING the previous block array instead of re-lexing it, does that give the blocks a full re-lex would? 862 cases over 16 note shapes x 19 edit shapes x 3 positions, plus a coverage floor so a splitter that always refuses cannot pass. Pure Node — it loads the vendored `marked` and lifts the splitters out of `block-cache.js` as text |
| `viewport` | ...and when a note is not lexed at all until the reader comes near each part of it, do those parts add up to the same note? Same corpus, six properties: the spans tile the document and lex to exactly the whole-document blocks; a boundary scan resumed at a safe cut reproduces the full scan's tail; the link-reference prelude derived from the candidate spans alone equals the real one; the heading index agrees with `marked`'s own headings; an edit taken locally leaves cuts that are still real cuts of the edited document; and it takes ordinary edits often enough to be worth having |
| `render-scale` | Does a note still render when it is BIG? Four sizes straddling the 2,000-block chunking threshold, plus how long the thread is blocked while a 2.6MB note opens |
| `interaction` | Once a book-sized note is open, does the app still answer? A press, a selection, the TOC's active row, and a reading position saved and resumed — each measured on a 2.6MB / 24,000-block note at phone size. Also that opening that note did **not** build all of it, and that editing it re-lexes one span rather than the book |
| `large-select` | The touch-selection gesture again, on a note long enough to be built AS IT IS READ — a press taken while the note is still settling, a drag across a span boundary, how many pixels the note travels after a highlight, and that a drag through unread chapters promotes no span while the finger is down and every one it queued the moment that finger lifts. Its fixture used to stop one threshold short by accident: paragraph-then-list all the way down has exactly one safe lexer cut, so a 284KB note took the eager path and this file had never once driven the code a real book runs on |
| `notes-menu` | Can you tell what the notes ⋯ menu's controls do, and which way its modes are set, without pressing one to find out? Eleven cases over ten rows, read the way a reader reads them — the label the CSS actually shows, the switch's own word against `aria-pressed`, the two bookmark drawings compared against each other — at desktop width and again at 390px, plus whether a note printed into a paragraph is drawn any differently from the paragraph it landed in, measured as contrast against the page in a light theme as well as a dark one. Also that no row is laid out outside the box that is supposed to hold it, which is how the last one of them once disappeared |
| `image-controls` | Does every image the renderer renders get a resize grip and a delete button — including the ones in a table cell, a link, or an HTML block — and does using one rewrite that image's own slice of the markdown and nothing else in the note? `marked` is the oracle for what counts as an image. **One press, one picture** is the half that came from the report: a truncated `<img` used to make one slice that ran to the next `>` anywhere in the note, so a single delete took three pictures and a paragraph; an ordinal counted over the shells *on screen* was spent on the slices *in the source*, which on a book built span by span deleted an earlier, off-screen copy instead; and a GFM table row written without leading pipes was converted into a side-by-side image row, taking the table apart. It also asks the question in front of a **hard delete of the stored file** — is anything else still pointing at it? — in both directions, because a substring test got both wrong |
| `image-sync` | Does a picture that arrived by **sync** appear? Both Storage buckets are private, so a rendered `<img>` needs a signed URL and a signature needs a session — and the app opens this device's own decks *before* the session is confirmed, deliberately, so that a lapsed token is not a blank page. That window is where every image in a freshly pulled deck was rendered, found unsignable, and called broken, permanently. It never showed on the device that *uploaded* the picture, whose bytes are in the worker's image cache under the very URL that cannot be fetched — which is the whole of "it works where I made it and nowhere else". Asserts that an image waiting on a signature is not judged, that it resolves itself when the answer lands with no re-render, that one which genuinely cannot be signed **is** still reported, that a pulled deck's images are handed to the worker signed rather than public, and that a storage path survives the round trip through its own percent-encoded URL |
| `mobile-menu` | Does the ☰ drawer still open on a phone with a book on screen? The only check that throttles the CPU and uses a fixture with figures in it, and it times the shared overlay/chrome plumbing directly — all three are why the drawer freeze survived five rounds of profiling |
| `pdf-document` | Does a PDF deck work — imported, rendered, selected, highlighted, saved and read back? The only check that drives the Document surface, and the only one that can catch an anchor that works in the session that made it and nowhere else. It also reports a page that renders zero text items, which is the signal for a scanned PDF with no text layer: readable, but with no selection and no make-card. Side by side is asserted here too: that it opens beside the page and stacks on a phone, that a card's number matches its badge, that pressing a badge reveals that card instead of opening a window over the page, that moving the split to the other reading surface starts at the top of *its* list rather than keeping a position that meant something in a different one, that a real wheel past the end of the pane's list moves neither the page nor the panel behind it (chaining, not sizing — the landscape-phone pair beside it is the sizing half of the same report), and that a card's "Go to →" lands its highlight in the *middle* of the view while a jump to a page number still lands on that page's top |
| `epub-import` | ...and does importing an EPUB still work? The preview modal, the figure uploads and the decks, driven end to end through the app's own `importEpubFile` against a book built by hand (`tools/epub-fixture.mjs`). It exists because none of it ran at all: a figure-quality control added to the preview read an `imageEntries` the modal was never given, so every book carrying a picture — which is every book — died on a `ReferenceError` before the modal reached the screen, and nothing here noticed. The fixture is shaped around the branches nothing else reaches: a front page the contents does not name, two chapters sharing one file and split at an anchor, figures whose archive names and hrefs are spelled differently in both directions, and an import started before the HTML converter has finished loading |
| `style` | Do the style-panel settings still reach the CSS variables they name? |
| `highlight` | Does a highlight land on the copy of the text you actually selected, in both views? And does a highlight that carries a note say so — a numbered, pressable badge, numbered in reading order from the SOURCE rather than from whatever the lazy renderer has built, never shown for an id whose note was deleted by hand, and costing the line it is on exactly zero pixels. Also that the card listed beside the reading surface wears *that same number*: three surfaces print it, and one function has to be where it comes from |
| `note-editor` | Can you format a highlight's note with the keyboard, and does Ctrl+E flip the popup rather than the view behind it? Nothing drove the note popup at all before this file — which is how a key bound to "toggle raw/rendered" came to flip a surface the reader was not looking at while they typed into one floating over it. Runs the same battery against the in-place editor in the side-by-side pane, because the two are one editor now and must not disagree about anything — plus what a PRESS means there: a click leaves the note rendered and selectable, a triple-click crosses to the raw markdown at the word under the pointer rather than at the end of the text, and Ctrl+E flips the two instead of closing the editor. Then the floating pill over both, in raw and in rendered mode: that it appears at all, that it offers formatting and highlight but not cloze or split-out, and that what it writes lands in the note rather than in the note behind it |
| `paged` | Can you reach the end of a note in paged reading mode, at every note length — and does it read as ONE note? Paging used to give the columns one CHAPTER at a time, which is what bounded the layout cost, and which meant every chapter ended partway down a column with the next one starting a page later: "when chapter 4 ends there's still a lot of space remaining in column 2, but the next chapter started one page ahead". The columns are given a SPAN now — a run of consecutive chapters packed to a budget — so a paper is one uninterrupted flow, and where a span does end the boundary is measured onto the page boundary nearest it. Asserted on both shapes: six `##` sections make exactly one wrapper with no section beginning at the top-left of a page, and on a 60-chapter book each span's flow is a whole number of pages with no block lost or repeated at a seam. The old build fails all of them — 616px of blank column at every seam, and `Ch 4/6 · 1/1` |
| `ribbon` | Does the chapter ribbon agree with where the reader is? |
| `toc-binding` | ...and does the Nth row of the **contents** take you to the heading it names? A row is a descriptor scanned out of the source, a jump needs an element, and the two were married by position — which is wrong whenever the two sides disagree about how many headings a note has. `- ## thing` and a raw `<h2>` render as headings the contents deliberately does not carry, so every row after one of them named the heading *before* it; a note built span by span has most of its headings not in the document at all, and the whole-view pass began at descriptor 0 regardless. Ten note shapes in five build states, plus the raw-editor jump, driven through the real modules in a real browser. `viewport` proves the descriptors are right and `ribbon` proves the band tracks the reader; neither can see a row that names one heading and lands on another |
| `precache` | Is every module, stylesheet and vendored file the app needs actually in the worker's precache — and preloaded? |
| `vendor` | Are the vendored libraries present, unmodified, and precached? |
| `offline` | Does the app **start** with no network, a blocked CDN, or a CDN that hangs? |
| `release-check` | Does a release reach an existing install, does it work offline — and does it still work offline *after* the update? |

The browser-driven ones block `cdn.jsdelivr.net` and take a free port from the
OS rather than a fixed one. Both were sources of failures that had nothing to do
with the code. `offline-check` blocks it deliberately, as the thing under test:
it asserts the app still starts, and that nothing on the boot path asked for
that origin at all.

Serve every one of them; `sw.js` and the icons are what make the app installable and usable offline.

### How `src/` is laid out

Still no build step: the browser resolves the imports itself. One folder per
area of the app —

| Folder | What lives there |
|---|---|
| `core/` | Values everything shares: `state`, the `el` DOM map, constants, the build stamp, the on-demand CDN loader, and the one flag that says a finger is mid-gesture on a reading surface. **These import nothing** |
| `cloud/` | The user's Supabase project: config, auth, deck rows, the network policy every call goes through |
| `sync/` | Two-way sync — the per-card merge, tombstones, push/pull, and the deletion guards. `document-sync.js` is the same four things for a paper's annotations: a per-record timestamp, a merge on the pull, a reconcile against the cloud's real row before the push, and a tombstone for a deleted highlight |
| `storage/` | The device's own copy: IndexedDB deck store, autosave, quota, the storage panel |
| `library/` | My Decks: the local index, folders, rows, tiles, drag and drop, and reading a whole folder as one document |
| `render/` | Markdown → HTML: math, clozes, note links, diagrams, tables, and the block cache that keeps huge notes fast. Also the pen: `ink-engine.js` is the stroke engine every drawing surface is driven by (a canvas per host for finished ink, one shared pair over it for the stroke under the nib and the frames drawn ahead of it), `ink-paint.js` turns points into the filled outline that makes a line vary in width, and `ink-shapes.js` decides — reluctantly — when a held stroke meant a circle. Past ~2,000 blocks a note is cut into spans at provably safe lexer boundaries and each span is lexed and built only as the reader comes near it, so opening a note costs a screenful rather than a book (`viewport` above is the proof) |
| `notes/` | The notes view: editing, the caret, scroll anchoring, the foldable TOC and its Highlights section (the tree itself is `toc-tree.js`, drawn for the note's contents and the paper's alike), paged reading (`chapters.js` works out where the SPANS are — what one multi-column flow is given — and `paged-view.js` cuts each span's boundary onto a page boundary), selection — including the touch-selection controller, which owns the gesture on every reading surface including the PDF — links, and the notes attached to highlights: `note-editor-kit.js` is that editor, built once for the popup and for the cards listed beside a reading surface |
| `documents/` | The Document surface: a PDF rendered page by page by pdf.js, its highlights (text runs, dragged regions *and* pen strokes — all stored in PDF user space so they survive a zoom and a reload; `pdf-ink.js` is the pen, including the one rule that makes it work without a mode: a pen draws, a finger scrolls, and a press too short and too still to be either is a tap that passes through), its contents drawer — the file's own outline where it has one, and a contents read out of the type on its pages where it does not, cached on the deck — the notes printed under each page, and the device/cloud store the file itself lives in |
| `cards/` | Studying: the card view, swipe, the All Cards panel, deck actions |
| `editor/` | The raw editor: its highlight mirror, text transforms, toolbars |
| `format/` | Selection-driven formatting: cloze, highlight, locating a rendered selection in the source. `ink-strokes.js` is the wire format for handwriting — quantised, delta-encoded and base64url, because these ride in a JSONB bag that is re-sent whole on every sync and plain JSON would be ten times the size; `ink-svg.js` is the same strokes as a file, with the encoding kept inside the drawing so it can be re-opened. The fenced highlight-note block has two leaves nothing else imports — `notes-fence.js` for where it starts and stops, and `highlight-notes-merge.js` for the one parser, the one writer and the merge, so the sync path and a Node check can read the format without dragging in the surfaces that write it |
| `import/` `export/` | Getting decks in (markdown, zip, EPUB, URL) and out (markdown, PDF, DOCX, HTML, SQL) |
| `images/` | Upload, the compression level chosen before it, the offline outbox, paste and drag handling, in-place resize and delete |
| `backup/` | The whole library as one `.zip` — decks, images, the PDFs themselves, the folder tree and your place in each note — and the additive restore. `archive-format.js` is the leaf that says what the archive IS, including the table of which of the app's data a backup carries and which it deliberately does not; `zip-lite.js` reads and writes an archive with no JSZip, so a backup can be taken with the CDN blocked |
| `quick-notes/` | The Quick Notes deck and its board |
| `ui/` `panels/` `pwa/` | Chrome, overlays, navigation, themes; the cloze panel, the Highlights section each reading panel's own drawer carries, and `highlight-cycle.js` — a continuous editor of every highlight and its note, in a pane beside the paper or the note it is about, with ◀ ▶ to walk through them — or, with the ≡ in its own bar, holding the whole panel on its own, for reading your highlights back without the page beside them. That is a WIDTH and not a view: the deck, the surface and `state.viewMode` are unchanged, and a press on any "Go to →" puts the page back first (a stage with no box has no geometry to scroll to). There is no Highlights *tab* any more: it rendered these very cards, through the same `highlights-editor.js`, somewhere you had to leave the reading surface to reach; the service-worker client and App Info |

**The one rule that matters:** `core/` imports nothing from the rest of the app.
Modules elsewhere import each other freely — that is safe, because what crosses
those edges is function declarations, which are hoisted before any module runs.
What is *not* safe is a top-level `const X = somethingImported` inside a cycle:
it evaluates immediately and throws. Shared values therefore live in a module
that imports nothing. `node tools/module-symbols.mjs` enforces this.
