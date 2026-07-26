# Recall — Setup Guide

Recall is a static flashcard and study-notes web app backed by **your own Supabase project**. Three core files, no build step, no framework, no npm — you serve a folder and the app runs.

> [!NOTE]
> **Looking for how to *use* Recall?** It's documented inside the app: open the **☰** menu → **? Help & Guide**. Twelve sections cover loading decks, study notes, studying, keyboard shortcuts, swipe gestures, editing and formatting, clozes, images, quick notes, progress, the All Cards panel, sync, offline behaviour, card format and themes.
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

**The first load needs internet** — the app pulls its libraries (marked, DOMPurify, KaTeX, Prism, Mermaid, nomnoml, JSZip, Turndown, Panzoom, supabase-js) from `cdn.jsdelivr.net`, and sign-in obviously needs the network. After that first successful load, the service worker has cached everything and the app works offline.

---

## Step 1 — Put the files on a web server

There's nothing to build. Deploy the folder as-is.

> [!IMPORTANT]
> **Don't open `index.html` by double-clicking it.** On a `file://` URL Supabase Auth rejects the origin *and* the service worker refuses to register, so you get neither sign-in nor offline support. It must be served over HTTP.

Pick whichever suits you:

| | How | HTTPS | Installable + offline |
|---|---|---|---|
| **Local** | `cd recall && python3 -m http.server 8080`, then open `http://localhost:8080` | no | **yes** — `localhost` counts as a secure context |
| **Local, reached from your phone over Wi-Fi** | Same command, open `http://192.168.x.x:8080` | no | **no** — a bare LAN IP is not a secure context, so the service worker never registers |
| **GitHub Pages** | Push the repo → **Settings → Pages** → pick the branch → `https://<user>.github.io/<repo>/` | yes | yes |
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

This is the only SQL you need — one run creates all four tables, every column, the indexes the sync depends on, all Row Level Security policies, and the `images` storage bucket with its policies. The same thing also ships in this repo as **`supabase_setup.sql`** if you'd rather copy from the file; the two are identical.

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
-- This supersedes the older per-feature files, which still ship only so that
-- anyone following older setup notes finds what they reference:
--   supabase_schema.sql · supabase_image_storage.sql · supabase_deck_notes.sql
--   supabase_deck_categories.sql · supabase_deck_tombstones.sql
--   supabase_quick_notes.sql · supabase_style_settings.sql
-- You do not need any of them. Running one afterwards is a no-op.
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
  -- Small deck-level JSON bag. The special quick_notes deck keeps its managed
  -- subject set under "quickNoteCategories" and its pinned-from source
  -- positions under "noteAnchors".
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_card_index INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- app.js never sets user_id explicitly — it relies on this default. Without
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
-- 7. Image storage — the `images` bucket
-- ============================================================================
-- Pasted, dropped, picked and EPUB-imported images live in your own project
-- rather than a third-party host, which is also what makes deleting one from
-- inside the app possible.
INSERT INTO storage.buckets (id, name, public)
VALUES ('images', 'images', true)
ON CONFLICT (id) DO NOTHING;

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
  -- (app.js prefixes every upload path with auth.uid()), so one account's
  -- session can never write into — or, via the delete policy, remove from —
  -- another account's images.
  --
  -- Only the FIRST path segment is checked, which is what lets app.js file
  -- uploads into per-source subfolders underneath it:
  --   {uid}/books/{book-slug}--{importId}/{NNNN}-{figure}.webp   (EPUB import)
  --   {uid}/decks/{deck-slug}--{localDeckId}/{ts}-{rand}.webp   (paste/drop)
  --   {uid}/unfiled/{ts}-{rand}.webp                            (no owner yet)
  -- No policy change is needed for that nesting, and objects still sitting at
  -- the old flat {uid}/{ts}-{rand}.ext remain readable and deletable.
  DROP POLICY IF EXISTS "Authenticated users can upload their own images" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can delete their own images" ON storage.objects;
  DROP POLICY IF EXISTS "Anyone can view images" ON storage.objects;

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

  -- Images are embedded as plain public URLs directly in the markdown, so read
  -- access has to be open: there is no signed-in context when a card is later
  -- rendered from a synced copy on another device, or from the offline cache.
  CREATE POLICY "Anyone can view images"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'images');
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
COMMENT ON TABLE app_style_settings IS 'Per-user layout/typography settings (row id = auth.uid()), plus a legacy shared ''global'' row that accounts with no style of their own inherit. Colours are deliberately not included — themes live in CSS.';
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
| 5 | Paste an image into a card or the notes | It uploads and renders within a second or two | Step 3 — section 7 of the SQL (the `images` bucket) |

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

`supabase_schema.sql`, `supabase_image_storage.sql`, `supabase_deck_categories.sql`, `supabase_deck_notes.sql`, `supabase_deck_tombstones.sql`, `supabase_quick_notes.sql` and `supabase_style_settings.sql` still ship, so that anyone following older setup notes or an older copy of this README still finds what they reference. **You don't need any of them** — `supabase_setup.sql` is their union, and running one afterwards is a no-op.

The one thing not folded in is the 40-odd seeded layout defaults in `supabase_style_settings.sql`, which pre-fill the shared `global` style row. That's cosmetic and optional: without it the app uses its own built-in defaults.

---

## More than one person on one project

One deployment can serve any number of accounts. Each signs in with their own email, and Row Level Security means each sees only their own decks, cards, notes, tombstones and images — verified by policy, not by app code.

Two shared things to be aware of:

- **The `images` bucket is world-readable.** It has to be: an image is embedded as a plain public URL in the markdown, and there's no signed-in context when a card is rendered on another device or from the offline cache. Anyone with the URL can view that image, though nobody can *list* the bucket, and paths are random. Writes and deletes are confined to each user's own uid-named folder.
- **The legacy `global` style row is readable by everyone.** It holds layout numbers only — fonts, sizes, spacing — never any deck content, and no account can write to it.

Everything else is per-account. To keep libraries fully separate, give each person their own Supabase project instead.

---

## Notes for self-hosters

**If you edit the files, two things will bite you:**

- **The `?v=` stamps must match.** `index.html` loads `styles.css?v=…` and `app.js?v=…`, and `sw.js` precaches those exact URLs in `APP_SHELL`. The cache is keyed on the full URL, so if they drift, the service worker precaches a file the page never requests and your change may never reach an offline user. Bump `CACHE_NAME` in `sw.js` **and** the `?v=` in both files together, to the same value.
- **CDN libraries are pinned by version** in `index.html` and precached by `sw.js`. Change a version in one place and you must change it in the other, or that library won't be there offline.

**Backups.** The library lives in two places, and neither is a backup of the other on its own:

- Supabase gives you database backups on paid plans; on the free tier, use **My Decks → ⋯ → Export All → Backup (.zip)** for a full copy of every deck and note.
- That same zip restores through **My Decks → ⋯ → Restore backup**. Restore is *additive* — it merges, never wipes.
- **The images are inside the zip**, not linked from it: every picture a deck references is packed into `assets/`, with `assets/index.json` mapping each original URL to its file. So the archive works for someone who has no access to your Supabase project at all — restoring it copies those files onto their device and, if they have their own project, uploads them there on the next sync. Images already belonging to the project the restoring device is configured against keep their URLs (nothing is duplicated); they are just seeded into the offline cache. Older archives with no `assets/` folder still restore exactly as before.
- **The archive mirrors your library**, so it's browsable outside the app and restores back into the same shape:

  ```
  manifest.json                              every deck, folder and image
  decks/Science/Cell Biology/Mitosis-a1.json one file per deck, inside its folder path
  assets/Mitosis--a1/0001-spindle.webp       that deck's images, named like its Storage folder
  assets/index.json                          image reference → packed file
  ```

  Restoring puts decks back into those folders and files each restored image into this device's own `decks/{slug}--{id}` Storage folder. **A hand-made zip works too**: drop deck `.json` files into folders of your own naming and restore reads the folder path as the deck's folder (a deck that carries its own category keeps it). Files at the root land in *Uncategorized*, and `__MACOSX/`, `.DS_Store` and non-deck JSON are ignored. The restore preview names the folder each deck will land in before anything is written.

**Starting over — emptying the data without dropping anything.** Sometimes you want a clean slate but not a rebuild: no `DROP TABLE`, no re-running `supabase_setup.sql`, no re-creating policies. These statements delete *rows only*. Tables, columns, indexes, RLS policies, triggers, the `images` bucket and its policies, and every user account all survive, so the app keeps working and simply starts filling up again.

> **Take a backup first** (**My Decks → ⋯ → Export All → Backup (.zip)**) — this is not undoable, and the .zip is what puts everything back, images included.
>
> **This propagates to your devices.** A deck a device has confirmed in the cloud at least once, and that is then missing from it, is treated as deleted: the device removes its local copy on the next sync. That is what makes this a real reset rather than a round trip. The exception is a deck that has *never* reached the cloud (no cloud id yet) — that one is pushed up instead, so a device holding unsynced work will re-populate the project with it. Sync every device before you wipe, or clear the device too (below).

Paste into **Supabase → SQL Editor**. Everything, for every account on the project:

```sql
BEGIN;
-- cards is truncated in the same statement as decks because it references it
TRUNCATE TABLE cards, decks, deleted_decks;
-- Optional — also forget synced fonts/sizes/layout. The app falls back to its
-- built-in defaults and re-creates the row on the next style sync.
-- TRUNCATE TABLE app_style_settings;
COMMIT;
```

Just one account, on a project several people share:

```sql
-- Find the uid first:
SELECT id, email FROM auth.users ORDER BY created_at;

BEGIN;
-- Cards go with their decks (cards.deck_id is ON DELETE CASCADE).
DELETE FROM decks              WHERE user_id = 'PASTE-UID-HERE';
DELETE FROM deleted_decks      WHERE user_id = 'PASTE-UID-HERE';
DELETE FROM app_style_settings WHERE id      = 'PASTE-UID-HERE';  -- optional
COMMIT;
```

The uploaded images are separate — they live in Storage, not in a table:

```sql
-- Empty the bucket from Dashboard → Storage → images (select all → delete) so
-- the files themselves are freed. SQL alone removes only the object ROWS and
-- leaves the underlying files orphaned in the storage backend, still counting
-- against your quota.
DELETE FROM storage.objects WHERE bucket_id = 'images';

-- One user's images only (app.js files every upload under {uid}/…):
DELETE FROM storage.objects
WHERE bucket_id = 'images' AND (storage.foldername(name))[1] = 'PASTE-UID-HERE';
```

Check what's left:

```sql
SELECT 'decks' AS what, COUNT(*) FROM decks
UNION ALL SELECT 'cards',              COUNT(*) FROM cards
UNION ALL SELECT 'deleted_decks',      COUNT(*) FROM deleted_decks
UNION ALL SELECT 'app_style_settings', COUNT(*) FROM app_style_settings
UNION ALL SELECT 'images',             COUNT(*) FROM storage.objects WHERE bucket_id = 'images';
```

**Clearing a device too.** The cloud is only half the library — each device keeps its own copy. In the browser: DevTools → **Application → Storage → Clear site data** (on a phone, the site's "Delete data" in browser settings). That drops the deck index (`flashcards_local_decks_index_v1`), every deck snapshot (`flashcards_local_deck_v1:*`), the queued-image outbox (IndexedDB `recall-outbox`), and the offline caches (`recall-v…`, `recall-images-v1`). It also clears `flashcards_supabase_config` and your session — so have the project URL and anon key ready to re-enter, and sign in again afterwards.

After all this, restoring a backup works normally: a restore explicitly retires the delete tombstones for anything it brings back, so the decks come home instead of being deleted again on the next sync.

**Storage limits.** The free tier's 500 MB database is far more than text decks will ever need; the 1 GB storage quota is the one to watch if you paste a lot of images. Uploads are downscaled to 1600 px and re-encoded as WebP in the browser first, so typical screenshots land well under 100 KB — but GIFs and SVGs are passed through untouched to keep them animated/vector.

**Device storage.** Decks are also kept in `localStorage`, which browsers cap at roughly 5–10 MB per origin. Large libraries can hit it; the app then warns and stops auto-saving rather than corrupting anything. Images never go there — only their URLs do.

---

## Reference — what the SQL creates

| Table | Holds | Notable columns |
|---|---|---|
| `decks` | One row per deck | `category` — a `/`-delimited folder path · `notes` — the deck's markdown study notes · `meta` — JSON bag for Quick Notes subjects and note anchors |
| `cards` | One row per flashcard | `position` — order within the deck · `status` — known/review/NULL · `category` — Quick Notes subject label · `updated_at` — drives the **per-card** sync merge |
| `deleted_decks` | Delete tombstones | Never pruned automatically, so a deletion outlives any device still holding a stale copy |
| `app_style_settings` | Layout and typography, one row per user | Keyed on the user's auth uid, plus a legacy shared `global` row used as a fallback |

Plus four indexes (`decks (user_id, updated_at DESC)`, `decks (user_id, last_accessed_at DESC)`, `cards (deck_id, position)`, `deleted_decks (user_id)`), four RLS policies, and the public `images` Storage bucket with three policies — upload and delete confined to each user's own folder, read open to all.

Inside that per-user folder, uploads are filed by where they came from, so a bucket holding thousands of figures is still readable and one source's images can be cleared out as a unit:

| Path | Source |
| --- | --- |
| `{uid}/books/{book-slug}--{importId}/{NNNN}-{figure}.webp` | EPUB import — one folder per import **run**, keeping the book's own image filenames |
| `{uid}/decks/{deck-slug}--{localDeckId}/{ts}-{rand}.webp` | Image pasted or dropped into a deck's notes |
| `{uid}/unfiled/{ts}-{rand}.webp` | No owning deck yet (pasted before the deck's first save) |

The `--{id}` suffix is what makes each folder unique: two imports of the same book, or two decks sharing a title, never share a folder. Because the id comes last, renaming a deck starts a new folder but every folder for that deck is still findable by its `localDeckId`. Only the RLS-checked first segment has to be the auth uid, so this nesting needs no policy change, and images already stored flat at `{uid}/{ts}-{rand}.ext` stay readable and deletable.

Two deliberate omissions, both explained in comments in the file: there is **no `updated_at` trigger** on `decks` or `cards` (the app writes an epoch sentinel during a push so an interrupted sync is retriable, and a trigger would overwrite it), and `cards` carries **no `user_id`** (ownership derives from the parent deck, so a deck can't leave its cards behind).

---

## Reference — files in this repo

| File | Role |
|---|---|
| `index.html` | The whole UI, plus the pinned CDN `<script>` tags |
| `app.js` | All application logic |
| `styles.css` | All styling, including the 10 themes |
| `sw.js` | Service worker — app-shell precache, CDN precache, image cache |
| `manifest.webmanifest`, `icons/`, `fevicon.png` | PWA install metadata and icons |
| **`supabase_setup.sql`** | **The only SQL file you need to run** |
| `supabase_schema.sql`, `supabase_image_storage.sql`, `supabase_deck_*.sql`, `supabase_quick_notes.sql`, `supabase_style_settings.sql` | Superseded per-feature files, kept only so older setup notes still resolve. Nothing in the app references them |

Serve every one of them; `sw.js` and the icons are what make the app installable and usable offline.
