-- Run this in Supabase SQL Editor if your existing project already has decks.
--
-- Cross-device delete tombstones. Deletion tombstones today live only in each
-- device's localStorage, so a device that hasn't reconciled since a deck was
-- deleted elsewhere still holds its local copy and will push it right back on
-- its next sync, resurrecting a deck another device intentionally deleted.
-- This table is the durable, shared record of "this deck id was deleted" that
-- every device checks before trusting an absent cloud row to mean "mine is
-- newer, re-create it."
--
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS deleted_decks (
  deck_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE deleted_decks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own deck tombstones" ON deleted_decks;
CREATE POLICY "Users manage own deck tombstones" ON deleted_decks
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE deleted_decks IS
  'Cross-device delete tombstones for the static flashcard app — records that a deck id was deleted so other devices do not resurrect it.';
