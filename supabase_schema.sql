-- ============================================================
-- Recall (formerly Markdown Flashcards) — Supabase Schema (with Auth)
-- ============================================================
-- Requires Supabase Auth to be enabled on your project.
-- Each user sees only their own decks, cards, tombstones, and style settings.
--
-- This file is the whole schema for a FRESH project — the supabase_deck_*.sql /
-- supabase_quick_notes.sql / supabase_style_settings.sql migrations exist only
-- to bring an EXISTING deployment up to it, and running them afterwards is a
-- no-op. The one thing not covered here is image upload, which touches
-- storage.buckets: run supabase_image_storage.sql as well.
-- ============================================================

-- Create Decks Table
CREATE TABLE decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  notes TEXT NOT NULL DEFAULT '',
  -- Small deck-level JSON bag. The quick_notes deck keeps its managed category
  -- set under "quickNoteCategories" and its pinned-from source anchors under
  -- "noteAnchors". Also in supabase_quick_notes.sql, for projects created before
  -- this column existed — a fresh project needs only this file.
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_card_index INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- app.js never sets user_id explicitly on insert/upsert — it relies on this
  -- default, without which every insert would leave user_id NULL and get
  -- rejected by the "Users manage own decks" WITH CHECK below.
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX decks_category_last_accessed_at_idx
  ON decks (category, last_accessed_at DESC);

CREATE INDEX decks_last_accessed_at_idx
  ON decks (last_accessed_at DESC);

-- Create Cards Table
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  deck_id TEXT REFERENCES decks(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  position INT NOT NULL,
  status TEXT,
  -- Free per-card subject label used by the quick_notes board. NULL on regular
  -- study cards, which use `status` (known/review) instead. Also in
  -- supabase_quick_notes.sql for pre-existing projects.
  category TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create Style Settings Table — one row PER USER, keyed on the user's auth id
-- (the app writes styleSettingsRowId(), which is auth.uid()). The table predates
-- auth and originally held a single shared row, id = 'global'; on a multi-account
-- deployment that meant whoever synced last overwrote everyone else's fonts,
-- sizes and layout. That legacy row is kept readable — an account that has never
-- synced a style of its own still inherits it — but is no longer writable.
CREATE TABLE app_style_settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cross-device delete tombstones. A deletion recorded only in one device's
-- localStorage is undone by the next device that syncs a still-held copy, so
-- this shared list is what every device checks before trusting an absent cloud
-- row to mean "mine is newer, re-create it". Also in
-- supabase_deck_tombstones.sql, for projects created before it existed.
CREATE TABLE deleted_decks (
  deck_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_style_settings ENABLE ROW LEVEL SECURITY;

-- Decks: each user manages only their own rows
CREATE POLICY "Users manage own decks" ON decks
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Cards: accessible when the parent deck belongs to the user
CREATE POLICY "Users manage own cards" ON cards
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM decks
      WHERE decks.id = cards.deck_id AND decks.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM decks
      WHERE decks.id = cards.deck_id AND decks.user_id = auth.uid()
    )
  );

-- Tombstones: each user manages only their own. A restore retires them (the
-- app deletes the row) — see flushPendingUntombstones in app.js; nothing else
-- prunes this table, deliberately, since a deletion has to outlive any device
-- that might still be holding a stale copy of the deck.
CREATE POLICY "Users manage own deck tombstones" ON deleted_decks
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Style settings: a user reads their own row plus the legacy shared 'global'
-- one (the fallback for an account that has never synced a style), and may
-- write ONLY their own. `USING (true) WITH CHECK (true)` used to let any
-- signed-in account overwrite every other account's style.
CREATE POLICY "Users manage own app style settings" ON app_style_settings
  FOR ALL TO authenticated
  USING (id = auth.uid()::text OR id = 'global')
  WITH CHECK (id = auth.uid()::text);


-- ============================================================
-- MIGRATION — if you have an existing deployment without auth:
-- ============================================================
-- 1. Add user_id column to existing decks table:
--    ALTER TABLE public.decks
--      ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
--
-- 2. Drop old open policies:
--    DROP POLICY IF EXISTS "Anyone can read decks" ON decks;
--    DROP POLICY IF EXISTS "Anyone can insert decks" ON decks;
--    DROP POLICY IF EXISTS "Anyone can update decks" ON decks;
--    DROP POLICY IF EXISTS "Anyone can delete decks" ON decks;
--    DROP POLICY IF EXISTS "Anyone can read cards" ON cards;
--    DROP POLICY IF EXISTS "Anyone can insert cards" ON cards;
--    DROP POLICY IF EXISTS "Anyone can update cards" ON cards;
--    DROP POLICY IF EXISTS "Anyone can delete cards" ON cards;
--    DROP POLICY IF EXISTS "Anyone can read app style settings" ON app_style_settings;
--    DROP POLICY IF EXISTS "Anyone can insert app style settings" ON app_style_settings;
--    DROP POLICY IF EXISTS "Anyone can update app style settings" ON app_style_settings;
--    DROP POLICY IF EXISTS "Anyone can delete app style settings" ON app_style_settings;
--
-- 3. Create the new policies above.
--
-- 4. Assign existing rows to your user UUID:
--    UPDATE public.decks SET user_id = '<your-user-uuid>' WHERE user_id IS NULL;
--
-- 5. In Supabase Dashboard → Authentication → Providers → Email:
--    Disable "Confirm email" for immediate login after sign-up.
-- ============================================================
