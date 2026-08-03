-- Recovery for decks lost to the "deleted from another device" sync bug.
-- Run in the Supabase SQL Editor. Read the whole file before running anything:
-- step 3 deletes rows, so steps 1 and 2 exist to make sure you only delete the
-- wrong ones.
--
-- ── What went wrong ─────────────────────────────────────────────────────────
-- Every table here is RLS-scoped to auth.uid(), so a query that reaches Supabase
-- without a valid user token is NOT rejected — it succeeds and matches nothing.
-- The old sync read that empty result as "every deck was deleted on another
-- device": it removed the local copies, and then wrote a row into deleted_decks
-- for each one. Those rows are permanent and shared, so every other device read
-- them as a real deletion and dropped its copies too. One bad read on one
-- device, and the library went everywhere.
--
-- The app no longer does any of that (it verifies the session before reading,
-- refuses to treat an empty result as deletions, requires an absence to be seen
-- by two syncs minutes apart, asks before any large removal, and never publishes
-- a deletion it merely inferred). But rows written by the OLD code are still
-- sitting in deleted_decks, and they will go on suppressing those decks on every
-- device — including on a restore from backup. This file clears them.
--
-- ── What this can and cannot get back ───────────────────────────────────────
-- It CANNOT resurrect deck contents from the cloud: the deck rows were really
-- deleted there, and Postgres has nothing left to read. What it does is remove
-- the block, so a copy that survived somewhere else can come back:
--
--   • a device that still lists the decks (one that hasn't synced since, or has
--     been offline) re-uploads them on its next sync once the tombstones are
--     gone — this is the main path, and the reason to act before syncing it;
--   • a Backup .zip restored from the app (a restore already retires tombstones
--     for the decks it brings back, so that path works either way);
--   • a Supabase PITR / daily backup restore, if your plan has one — the only
--     route that recovers decks no device still holds. Check that FIRST if the
--     decks are gone everywhere; the window is time-limited.
--
-- If a device still holds the decks: do NOT sync it until step 3 has run.
--
-- ── Before you start: your user id ──────────────────────────────────────────
-- The SQL Editor runs as `postgres`, not as you, so auth.uid() is NULL here and
-- anything filtered on it would silently match nothing. Every query below
-- resolves your id from your login email instead. Set it once, in each query
-- that has the line — SQL has no session variables you can rely on here.
--
--   → Replace 'you@example.com' throughout with the email you sign in with.
--
-- Check it resolves before anything else. This must return exactly one row:
SELECT id, email FROM auth.users WHERE email = 'you@example.com';


-- ── Step 1: how much is tombstoned, and when did it happen? ─────────────────
-- The bug deleted a whole library at once, so it shows up as a big cluster of
-- rows sharing a timestamp to the second. A few scattered rows are your own real
-- deletions — leave those alone.
SELECT
  date_trunc('minute', deleted_at) AS deleted_minute,
  count(*)                         AS decks_tombstoned,
  min(deleted_at)                  AS first,
  max(deleted_at)                  AS last
FROM deleted_decks
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')
GROUP BY 1
ORDER BY 1 DESC;


-- ── Step 2: list the suspect rows before deleting them ─────────────────────
-- Set the window to bracket the cluster step 1 showed. Tombstones whose deck is
-- still present in `decks` aren't the problem, so they're filtered out.
SELECT t.deck_id, t.deleted_at
FROM deleted_decks t
WHERE t.user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')
  AND t.deleted_at >= '2026-01-01 00:00:00+00'   -- ← set to just before the incident
  AND t.deleted_at <  '2030-01-01 00:00:00+00'   -- ← set to just after it
  AND NOT EXISTS (SELECT 1 FROM decks d WHERE d.id = t.deck_id AND d.user_id = t.user_id)
ORDER BY t.deleted_at DESC;


-- ── Step 3: clear them ─────────────────────────────────────────────────────
-- Same predicate as step 2. Run step 2 first and check the list is what you
-- expect — this is the irreversible half.
DELETE FROM deleted_decks t
WHERE t.user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')
  AND t.deleted_at >= '2026-01-01 00:00:00+00'   -- ← same window as step 2
  AND t.deleted_at <  '2030-01-01 00:00:00+00'
  AND NOT EXISTS (SELECT 1 FROM decks d WHERE d.id = t.deck_id AND d.user_id = t.user_id);

-- Nuclear option — every deletion record you have, real ones included. Only
-- worth it if you're confident you never deliberately deleted a deck. The cost
-- of being wrong is that decks you DID delete come back from whichever device
-- still holds a copy; no data is lost either way.
--   DELETE FROM deleted_decks
--   WHERE user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com');


-- ── Step 4: on each device, in this order ──────────────────────────────────
--   1. Open Recall on the device that still HAS the decks and tap Sync Now.
--      It re-uploads them. Confirm with step 5 that they're back in the cloud.
--   2. Only then sync the other devices, so they pull rather than push.
--
-- Each device also keeps its own local copy of these tombstones, which the SQL
-- above cannot reach. Recall retires a local tombstone once the deck is back in
-- the cloud, so step 1 clears them on its own. On a device that stays stubbornly
-- empty, restoring a Backup .zip explicitly retires them for the decks it
-- brings back.


-- ── Step 5: confirm ────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM decks
     WHERE user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')) AS decks_in_cloud,
  (SELECT count(*) FROM deleted_decks
     WHERE user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com')) AS tombstones_left;

-- Separately worth checking: deck rows whose user_id was never set are invisible
-- to RLS, so the app sees them as missing no matter what deleted_decks says —
-- which the old code also read as "deleted elsewhere". This should return 0; if
-- it doesn't, run the UPDATE described in supabase_setup.sql to claim them.
SELECT count(*) AS decks_with_no_owner FROM decks WHERE user_id IS NULL;
