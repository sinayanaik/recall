-- ============================================================
-- Recall — Supabase schema (tables, indexes, Row Level Security)
-- ============================================================
-- Run this in the SQL Editor of your Supabase project. Requires Supabase Auth
-- to be enabled. Each user sees only their own decks, cards, tombstones and
-- style settings.
--
-- SAFE TO RE-RUN, and safe on an EXISTING project. Every statement is either
-- guarded (IF NOT EXISTS / DROP … IF EXISTS first) or additive, so this one file
-- is both the fresh-install schema and the upgrade path. It supersedes the
-- per-feature migrations, which are kept only because app.js names them in its
-- error messages and older setup notes point at them:
--
--   supabase_deck_categories.sql   decks.category, decks.last_accessed_at
--   supabase_deck_notes.sql        decks.notes
--   supabase_deck_tombstones.sql   the deleted_decks table
--   supabase_quick_notes.sql       cards.category, decks.meta
--   supabase_style_settings.sql    per-user app_style_settings + its trigger
--
-- Running any of those after this file is a no-op. The one thing NOT covered
-- here is image upload, which touches storage.buckets and storage.objects:
-- run supabase_image_storage.sql as well.
--
-- Upgrading a pre-auth deployment (no user_id column)? Run this file, then read
-- the notice it raises — see "Claiming existing rows" at the bottom.
-- ============================================================


-- ============================================================
-- decks
-- ============================================================
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  notes TEXT NOT NULL DEFAULT '',
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_card_index INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- app.js never sets user_id explicitly on insert/upsert — it relies on this
  -- default, without which every insert would leave user_id NULL and be
  -- rejected by the "Users manage own decks" WITH CHECK below.
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Columns added after the original release. No-ops on a table this file just
-- created; on an older project, this is what brings it up to date.
ALTER TABLE decks ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Uncategorized';
-- A "/"-delimited folder path (e.g. 'Math/Calculus/Derivatives'). Legacy flat
-- categories are simply single-segment paths, so no data migration is needed.
ALTER TABLE decks ALTER COLUMN category SET DEFAULT 'Uncategorized';

ALTER TABLE decks ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE decks ALTER COLUMN notes SET DEFAULT '';

-- Small deck-level JSON bag. The quick_notes deck keeps its managed category
-- set under "quickNoteCategories" and its pinned-from source anchors under
-- "noteAnchors". Read by the app's select("*") deck load.
ALTER TABLE decks ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE decks ALTER COLUMN meta SET DEFAULT '{}'::jsonb;

ALTER TABLE decks ADD COLUMN IF NOT EXISTS current_card_index INT DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE decks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE decks ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Added WITHOUT NOT NULL, deliberately. auth.uid() is NULL in the SQL Editor
-- (there is no request context), so on a table that already has rows a
-- NOT NULL column with that default fails outright with "column contains null
-- values". The guarded block further down tightens it once the rows have an
-- owner.
ALTER TABLE decks ADD COLUMN IF NOT EXISTS user_id UUID DEFAULT auth.uid();
ALTER TABLE decks ALTER COLUMN user_id SET DEFAULT auth.uid();


-- ============================================================
-- cards
-- ============================================================
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  position INT NOT NULL,
  -- known / review / NULL for uncategorised.
  status TEXT,
  -- Free per-card subject label used by the quick_notes board. NULL on regular
  -- study cards, which use `status` instead.
  category TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- Load-bearing: the sync merges PER CARD on this timestamp (see
  -- mergeCloudCardsIntoSnapshot in app.js), not per deck. Do not add a trigger
  -- to it — see the warning under "No updated_at triggers" below.
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE cards ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- A card with no deck is unreachable: it can't satisfy the RLS policy below
-- (which derives ownership from its deck) and no query in the app would ever
-- return it. Tightened only when the table is actually clean.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cards WHERE deck_id IS NULL) THEN
    RAISE NOTICE 'cards.deck_id left nullable: % orphan row(s) have no deck. Delete them, then re-run this file.',
      (SELECT COUNT(*) FROM cards WHERE deck_id IS NULL);
  ELSE
    ALTER TABLE cards ALTER COLUMN deck_id SET NOT NULL;
  END IF;
END $$;


-- ============================================================
-- app_style_settings — one row PER USER, id = the user's auth uid
-- ============================================================
-- The table predates auth and originally held a single shared row, id =
-- 'global'; on a deployment with more than one account that meant whoever
-- synced last silently overwrote everyone else's fonts, sizes and layout. That
-- legacy row is kept READABLE — an account that has never synced a style of its
-- own still inherits it — but is no longer writable. supabase_style_settings.sql
-- additionally seeds it with sensible defaults and adds an updated_at trigger;
-- neither is required, since app.js falls back to its own built-in defaults.
CREATE TABLE IF NOT EXISTS app_style_settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- ============================================================
-- deleted_decks — cross-device delete tombstones
-- ============================================================
-- A deletion recorded only in one device's localStorage is undone by the next
-- device that syncs a still-held copy, so this shared list is what every device
-- checks before trusting an absent cloud row to mean "mine is newer, re-create
-- it". Nothing prunes it automatically, deliberately: a deletion has to outlive
-- any device that might still be holding a stale copy of the deck. A restore
-- retires a single row (flushPendingUntombstones in app.js deletes it).
CREATE TABLE IF NOT EXISTS deleted_decks (
  deck_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE deleted_decks ALTER COLUMN user_id SET DEFAULT auth.uid();

-- Older versions declared user_id without a foreign key, which left tombstones
-- behind after the account that made them was deleted.
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


-- ============================================================
-- Claiming existing rows (pre-auth deployments only)
-- ============================================================
-- If decks.user_id was just added to a table that already had rows, those rows
-- have no owner: RLS hides them from every account, so the app will show an
-- empty library while the data sits there untouched. Assign them, then re-run
-- this file to have user_id tightened to NOT NULL:
--
--   UPDATE decks SET user_id = '<your-auth-user-uuid>' WHERE user_id IS NULL;
--
-- (Your uuid is in Authentication → Users.) Cards need nothing — they inherit
-- ownership through their deck.
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


-- ============================================================
-- Indexes
-- ============================================================
-- Chosen from the queries the app actually issues. Note that RLS means EVERY
-- query is implicitly filtered by user_id, so a useful index has to lead with
-- it — an index on the sort column alone can't be used to satisfy both.
--
--   fetchCloudDeckIndex   decks  ORDER BY updated_at DESC, paged
--   fetchCloudDeckList    decks  ORDER BY last_accessed_at DESC + cards(count)
--   fetchCardsForDecks    cards  WHERE deck_id IN (…) ORDER BY deck_id, position
--   pushDeckRowsToCloud   cards  WHERE deck_id = …
--   readCloudTombstones   deleted_decks  paged

CREATE INDEX IF NOT EXISTS decks_user_id_updated_at_idx
  ON decks (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS decks_user_id_last_accessed_at_idx
  ON decks (user_id, last_accessed_at DESC);

-- The single most important one: Postgres does NOT index a foreign key column
-- automatically, and every sync reads cards by deck_id — including the embedded
-- cards(count) aggregate on the My Decks list, which is one count per deck.
-- Without this, each of those is a sequential scan of the whole cards table.
-- `position` is included so the ORDER BY comes free.
CREATE INDEX IF NOT EXISTS cards_deck_id_position_idx
  ON cards (deck_id, position);

CREATE INDEX IF NOT EXISTS deleted_decks_user_id_idx
  ON deleted_decks (user_id);

-- Superseded by the two user_id-leading indexes above. Neither could serve a
-- real query: nothing filters by category server-side (the app filters the
-- fetched list client-side), and a bare last_accessed_at index can't satisfy the
-- RLS user_id predicate. Dropping them removes write overhead on every upsert.
DROP INDEX IF EXISTS decks_category_last_accessed_at_idx;
DROP INDEX IF EXISTS decks_last_accessed_at_idx;


-- ============================================================
-- No updated_at triggers on decks or cards — on purpose
-- ============================================================
-- app.js writes both timestamps explicitly and depends on the exact values:
-- pushDeckRowsToCloud first upserts the deck row stamped at the UNIX epoch, and
-- only rewrites it with the real time once every card chunk has landed, so an
-- interrupted push leaves the deck looking un-synced and retriable instead of
-- "current" with missing cards. A BEFORE UPDATE trigger setting updated_at =
-- NOW() would overwrite that sentinel and quietly break crash recovery, and
-- would also defeat the per-card merge, which compares the cloud timestamp
-- against the local one. Leave them alone.


-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_style_settings ENABLE ROW LEVEL SECURITY;

-- Postgres has no CREATE POLICY IF NOT EXISTS, so each is dropped first — which
-- is also what makes re-running this file repair a deployment whose policies
-- have drifted. The wide-open "Anyone can …" policies of the pre-auth releases
-- are dropped by name here too: leaving even one in place would OR itself with
-- the per-user policy below and expose every row to every visitor.
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

-- Decks: each user manages only their own rows.
CREATE POLICY "Users manage own decks" ON decks
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- Cards: ownership is derived from the parent deck rather than duplicated onto
-- every card, so a deck that changes hands can't leave its cards behind. This is
-- the predicate that needs cards_deck_id_position_idx to be quick.
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

-- Tombstones: each user manages only their own.
CREATE POLICY "Users manage own deck tombstones" ON deleted_decks
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- Style settings: a user reads their own row plus the legacy shared 'global'
-- one (the fallback for an account that has never synced a style), and may write
-- ONLY their own.
CREATE POLICY "Users manage own app style settings" ON app_style_settings
  FOR ALL TO authenticated
  USING (id = (select auth.uid())::text OR id = 'global')
  WITH CHECK (id = (select auth.uid())::text);


-- ============================================================
-- After this file
-- ============================================================
-- 1. Run supabase_image_storage.sql to enable image upload.
-- 2. Authentication → Providers → Email: turn OFF "Confirm email" if you want
--    the app's own "Create account" button to sign you straight in.
-- ============================================================

COMMENT ON TABLE decks IS 'One row per deck. `category` is a "/"-delimited folder path; `meta` is a JSON bag (quickNoteCategories, noteAnchors); `notes` is the deck''s freeform markdown study notes.';
COMMENT ON TABLE cards IS 'One row per flashcard. Ordered within a deck by `position`. `status` is known/review/NULL; `category` is the quick_notes subject label. `updated_at` drives the per-card sync merge.';
COMMENT ON TABLE deleted_decks IS 'Durable cross-device delete tombstones. Never pruned automatically — a deletion must outlive any device still holding a stale copy.';
