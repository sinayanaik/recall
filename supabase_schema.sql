-- ============================================================
-- Recall (formerly Markdown Flashcards) — Supabase Schema (with Auth)
-- ============================================================
-- Requires Supabase Auth to be enabled on your project.
-- Each user sees only their own decks, cards, and style settings.
-- ============================================================

-- Create Decks Table
CREATE TABLE decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  notes TEXT NOT NULL DEFAULT '',
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create Style Settings Table (one shared row, id = 'global'). This matches
-- supabase_style_settings.sql and the app's syncStyleToWeb/loadStyleFromWeb,
-- which always read/write id: "global" — it is intentionally NOT scoped per
-- user_id (single shared Aa style document across whoever uses this
-- deployment; see supabase_style_settings.sql's header for the rationale).
CREATE TABLE app_style_settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
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

-- Style settings: one shared 'global' row, readable/writable by any signed-in
-- user of this deployment (matches supabase_style_settings.sql's policies).
CREATE POLICY "Signed-in users manage app style settings" ON app_style_settings
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);


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
