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
-- This is the only SQL file in the repo. It replaced seven per-feature files
-- (supabase_schema, _image_storage, _deck_notes, _deck_categories,
-- _deck_tombstones, _quick_notes, _style_settings) and is a strict superset of
-- all of them, so an older setup note that names one of those just means: run
-- this instead.
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
  -- Deck-level JSON bag: nine keys belonging to six unrelated features. It is
  -- not the quick_notes-only column this comment used to describe, and the
  -- difference matters to anyone reasoning about a sync — the whole column is
  -- sent on every deck push, so every writer has to merge rather than replace
  -- (src/sync/document-sync.js, mergeDeckMeta). What lives in here:
  --
  --   pdf                  the attached PDF's name, size, page count, sha256
  --                        and storage path — a deck with this key has a
  --                        Document tab, and it is only ever written, never
  --                        removed ("Remove from cloud" sets offloaded: true)
  --   pdfHighlights        one record per highlight on that PDF: page, colour,
  --                        quads, and two independent stamps (at, noteAt)
  --   deletedHighlightIds  { id: iso } tombstones, so a deleted highlight
  --                        stays deleted across devices
  --   pdfToc               a contents read out of the pages, cached so
  --                        re-opening the deck does not scan them again
  --   readingPosition      where the reader got to, with its own `at`
  --   bookmark             the one spot they marked, with its own `at`
  --   linkIds              every id this deck answers to for [[links]] —
  --                        a union across devices, never one device's list
  --   quickNoteCategories  the quick_notes board's managed subject set
  --   noteAnchors          { cardId: anchor }, where each pinned note came from
  --   pdfBlocks            the draggable markdown blocks on a paper's pages,
  --                        each with its page, its rectangle in that page's
  --                        own POINTS, and its text. Points rather than pixels
  --                        for the reason the quads above are: a position in
  --                        the document survives a zoom and a second device
  --   deletedBlockIds      { id: iso } tombstones, so a block deleted on one
  --                        device stays deleted on the others
  --
  -- A handwritten notebook is the deck's OTHER document: `notebook`, in the same
  -- shape as `pdf` above, holding blank paper this app generated. Two slots
  -- rather than one, because a deck reading somebody's preprint wants pages of
  -- its own beside it — with one slot it was told "this deck already has a PDF".
  -- Its pages are still a real document's pages and its handwriting is still
  -- pdfHighlights like any other; a record's `doc` says which of the two it is a
  -- coordinate into, and no `doc` means the deck's own paper, which is what
  -- every record written before the second slot existed already meant.
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_card_index INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- the app never sets user_id explicitly — it relies on this default. Without
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
-- Paired with the ADD above for the same reason category/notes/meta/user_id are:
-- ADD COLUMN IF NOT EXISTS is a no-op on a project that already has the column,
-- so it cannot give one a default it never had. The superseded
-- supabase_deck_categories.sql carried this line and this file did not, which is
-- the one thing that stopped it being a strict superset of the older per-feature
-- files it replaces.
ALTER TABLE decks ALTER COLUMN last_accessed_at SET DEFAULT NOW();

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
-- 7. File storage — the `images` and `documents` buckets
-- ============================================================================
-- Pasted, dropped, picked and EPUB-imported images live in your own project
-- rather than a third-party host, which is also what makes deleting one from
-- inside the app possible.
INSERT INTO storage.buckets (id, name, public)
VALUES ('images', 'images', false)
ON CONFLICT (id) DO NOTHING;

-- ── Making the buckets private ──────────────────────────────────────────────
--
-- The `images` bucket shipped public-read, because a rendered `![](url)` had no
-- signed-in context to sign with. It does now: the app resolves a signed URL at
-- render time (src/cloud/storage-urls.js) and falls back to the canonical URL,
-- which its service worker answers from cache, when it cannot.
--
-- The bucket is NOT recreated, renamed or migrated. It is the same bucket,
-- holding the same objects at the same paths — one UPDATE flips the flag, and
-- the policy swap below replaces open read with owner-scoped read. Every URL
-- already sitting in your notes stays byte-identical; only anonymous read goes
-- away. Safe to re-run: an already-private bucket is updated to private again.
--
-- ORDER MATTERS. Run this file only AFTER deploying an app build that resolves
-- signed URLs — on an older build, every image in every note goes blank the
-- moment this statement lands.
UPDATE storage.buckets SET public = false WHERE id IN ('images', 'documents');

-- ── The `documents` bucket ──────────────────────────────────────────────────
--
-- Native PDF decks keep the original PDF as the document rather than extracting
-- it (see README → Documents). Its own bucket, private from the start, so a
-- paper is never anonymously readable and the storage panel can account for
-- documents separately from figures.
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- ── ...and how large a paper it will take ───────────────────────────────────
--
-- The app refuses a PDF over 100MB before it reads a byte of it
-- (MAX_DOCUMENT_BYTES, src/documents/pdf-store.js) and this bucket declared no
-- limit at all, which does NOT mean "no limit" — it means the project-wide
-- default applies, and on a new Supabase project that is 50MB. So a 60MB paper
-- passed the app's own check, imported, rendered, and then failed at the upload:
-- the deck is left readable on that one device with "it's on this device, but
-- not in the cloud", which is the honest message for a network failure and a
-- confusing one for a file that will never fit however many times you retry.
--
-- Stated here so the two agree. A separate UPDATE rather than a column on the
-- INSERT above, so a project that already has the bucket picks it up too, and
-- re-running the file is a no-op either way.
--
-- NOTE: a bucket cannot exceed the project's own upload limit, which lives in
-- the dashboard under Settings → Storage. If yours is still at 50MB, raise it
-- there as well or this line has no effect beyond documenting the intent.
UPDATE storage.buckets SET file_size_limit = 104857600 WHERE id = 'documents';

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
  -- (the app prefixes every upload path with auth.uid()), so one account's
  -- session can never write into — or, via the delete policy, remove from —
  -- another account's images.
  --
  -- Only the FIRST path segment is checked, which is what lets the app file
  -- uploads into per-source subfolders underneath it:
  --   {uid}/books/{book-slug}--{importId}/{NNNN}-{figure}.webp   (EPUB import)
  --   {uid}/decks/{deck-slug}--{localDeckId}/{ts}-{rand}.webp   (paste/drop)
  --   {uid}/unfiled/{ts}-{rand}.webp                            (no owner yet)
  -- No policy change is needed for that nesting, and objects still sitting at
  -- the old flat {uid}/{ts}-{rand}.ext remain readable and deletable.
  DROP POLICY IF EXISTS "Authenticated users can upload their own images" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can delete their own images" ON storage.objects;
  DROP POLICY IF EXISTS "Anyone can view images" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can read their own images" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can upload their own documents" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can delete their own documents" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can read their own documents" ON storage.objects;

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

  -- Read used to be open to anyone, because a rendered `![](url)` carried no
  -- signed-in context to authenticate with. The app now signs each URL at
  -- render time from the session it already has (src/cloud/storage-urls.js),
  -- so read can be scoped exactly like write is — to the uid folder the object
  -- sits in. The canonical URL in the markdown is unchanged and still works as
  -- an identifier; it simply no longer serves bytes to a stranger who has it.
  --
  -- This policy is also what makes createSignedUrls work at all: signing is
  -- itself a read, so a user who cannot SELECT an object cannot sign it either.
  CREATE POLICY "Authenticated users can read their own images"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
      bucket_id = 'images'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );

  -- The same three, for the documents bucket. Uploads are filed as
  --   {uid}/pdfs/{paper-slug}--{importId}/{name}.pdf
  -- so the first-segment check below covers them exactly as it does images, and
  -- one paper's folder can be inspected or removed as a unit.
  CREATE POLICY "Authenticated users can upload their own documents"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'documents'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );

  CREATE POLICY "Authenticated users can delete their own documents"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'documents'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );

  CREATE POLICY "Authenticated users can read their own documents"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
      bucket_id = 'documents'
      AND (storage.foldername(name))[1] = (select auth.uid())::text
    );
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
COMMENT ON TABLE app_style_settings IS 'Per-user layout/typography settings (row id = auth.uid()), plus a legacy shared ''global'' row that accounts with no style of their own inherit. The theme is stored here too, as a `theme` key holding a theme ID (e.g. ''dark-amoled'') alongside the ''desktop''/''mobile'' profiles, so a device that syncs its style down also gets the theme that went with it. Colour VALUES are still not included — those live in CSS, keyed off that ID.';
