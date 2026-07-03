-- Run this in Supabase SQL Editor if your existing project already has decks.
--
-- Adds simple deck metadata so Web Decks can be grouped, filtered, and sorted by access.
-- Re-running this file is safe.

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Uncategorized';

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

ALTER TABLE decks
  ALTER COLUMN category SET DEFAULT 'Uncategorized';

ALTER TABLE decks
  ALTER COLUMN last_accessed_at SET DEFAULT NOW();

UPDATE decks
SET category = 'Uncategorized'
WHERE category IS NULL OR btrim(category) = '';

UPDATE decks
SET last_accessed_at = COALESCE(last_accessed_at, updated_at, created_at, NOW())
WHERE last_accessed_at IS NULL;

ALTER TABLE decks
  ALTER COLUMN category SET NOT NULL;

ALTER TABLE decks
  ALTER COLUMN last_accessed_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS decks_category_last_accessed_at_idx
  ON decks (category, last_accessed_at DESC);

CREATE INDEX IF NOT EXISTS decks_last_accessed_at_idx
  ON decks (last_accessed_at DESC);

COMMENT ON COLUMN decks.category IS
  'User-facing deck category used by the static flashcard app for grouping and filtering web decks.';

COMMENT ON COLUMN decks.last_accessed_at IS
  'Automatically updated when a web deck is loaded or synced; used for Web Decks sorting.';
