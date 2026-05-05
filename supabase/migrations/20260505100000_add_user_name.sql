-- Migration: Add name column to users table for iOS profile capture
-- Context: M2-followup work. iOS app will prompt all users for their
-- name on next launch via a required modal. Required for distinguishing
-- real testers from ghost users. Backwards compatible with existing
-- iOS clients that don't yet send name.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS name_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.users.name IS
  'User-entered name from iOS profile modal. NULL means user has not yet entered their name. Required for identifying real testers vs ghost accounts.';

COMMENT ON COLUMN public.users.name_updated_at IS
  'Timestamp when name was last updated. Tracks profile completion.';

-- Verify
DO $$
DECLARE
  has_name BOOLEAN;
  has_updated_at BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'name'
  ) INTO has_name;

  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'name_updated_at'
  ) INTO has_updated_at;

  IF NOT has_name OR NOT has_updated_at THEN
    RAISE EXCEPTION 'Column add failed: name=%, name_updated_at=%', has_name, has_updated_at;
  END IF;

  RAISE NOTICE 'Verification passed: both columns added';
END $$;
