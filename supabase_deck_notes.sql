-- Run this in Supabase SQL Editor if your existing project already has decks.
--
-- Adds a freeform per-deck study-notes document (markdown) edited in the app's Notes view.
-- Re-running this file is safe.

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

ALTER TABLE decks
  ALTER COLUMN notes SET DEFAULT '';

UPDATE decks
SET notes = ''
WHERE notes IS NULL;

ALTER TABLE decks
  ALTER COLUMN notes SET NOT NULL;

COMMENT ON COLUMN decks.notes IS
  'Freeform per-deck study notes (markdown), edited in the Notes view of the flashcard app.';
