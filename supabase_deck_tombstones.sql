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
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE deleted_decks ALTER COLUMN user_id SET DEFAULT auth.uid();

-- Earlier versions declared user_id without a foreign key, leaving tombstones
-- behind after the account that made them was deleted. Skipped if any row
-- already points at a user that no longer exists.
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

-- Every read of this table is filtered by user_id through the policy below, and
-- the primary key is deck_id, so without this each read is a full scan.
CREATE INDEX IF NOT EXISTS deleted_decks_user_id_idx
  ON deleted_decks (user_id);

ALTER TABLE deleted_decks ENABLE ROW LEVEL SECURITY;

-- auth.uid() is wrapped in a scalar subquery so the planner evaluates it once
-- per statement (an InitPlan) instead of once per row. Must stay identical to
-- the policy in supabase_schema.sql, or whichever file ran last wins.
DROP POLICY IF EXISTS "Users manage own deck tombstones" ON deleted_decks;
CREATE POLICY "Users manage own deck tombstones" ON deleted_decks
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

COMMENT ON TABLE deleted_decks IS
  'Cross-device delete tombstones for the static flashcard app — records that a deck id was deleted so other devices do not resurrect it.';
