-- Run this in Supabase SQL Editor to enable in-app image uploads (paste/drop/EPUB
-- import), replacing the old ImgBB integration. Images are stored in your own
-- Supabase project instead of a third-party host, which is also what makes
-- deleting an image (something ImgBB never allowed from within the app) possible.
--
-- Re-running this file is safe: bucket creation and every policy are guarded so
-- existing setups are left untouched.

INSERT INTO storage.buckets (id, name, public)
VALUES ('images', 'images', true)
ON CONFLICT (id) DO NOTHING;

-- Signed-in users may upload only into a folder named after their own user id
-- (app.js prefixes every upload path with auth.uid()), so one user's session can
-- never write into — or, via the delete policy below, remove — another user's images.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Authenticated users can upload their own images'
  ) THEN
    CREATE POLICY "Authenticated users can upload their own images"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'images'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Authenticated users can delete their own images'
  ) THEN
    CREATE POLICY "Authenticated users can delete their own images"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'images'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;

  -- Images are embedded via public https://…/storage/v1/object/public/images/…
  -- URLs directly in notes markdown (same as ImgBB's public links), so read
  -- access has to be open — there's no signed-in context when a card is later
  -- rendered from a synced/offline copy.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Anyone can view images'
  ) THEN
    CREATE POLICY "Anyone can view images"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'images');
  END IF;
END $$;
