-- Run this in Supabase SQL Editor if your existing project already has decks/cards.
--
-- Adds the storage the app needs to treat the special `quick_notes` deck as a
-- glanceable, subject-categorised board instead of a normal known/unknown study
-- deck:
--   * cards.category  — a free per-card subject label (only meaningful on
--     quick_notes cards; regular study cards leave it NULL and keep using the
--     existing `status` column for known/review).
--   * decks.meta      — a small JSON bag on the deck row. The quick_notes deck
--     stores its managed category set here, e.g.
--       { "quickNoteCategories": [ { "id": "...", "name": "Math", "color": "#3b82f6" } ] }
--     Pulled automatically by the app's select("*") deck load and mirrored into
--     the local deck snapshot, so categories are both cloud-synced and offline.
--
-- Re-running this file is safe.

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS category TEXT;

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE decks
  ALTER COLUMN meta SET DEFAULT '{}'::jsonb;

UPDATE decks
SET meta = '{}'::jsonb
WHERE meta IS NULL;

ALTER TABLE decks
  ALTER COLUMN meta SET NOT NULL;

COMMENT ON COLUMN cards.category IS
  'Free per-card subject label used by the quick_notes board. NULL for regular study cards, which use the status column (known/review) instead.';

COMMENT ON COLUMN decks.meta IS
  'Small JSON bag of deck-level metadata. The quick_notes deck stores its managed category set under the "quickNoteCategories" key.';
