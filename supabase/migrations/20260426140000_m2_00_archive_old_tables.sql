-- M2 Phase 2 — File 00 of 10: Archive Old MVP Tables (runs FIRST)
-- See docs/specs/m2_schema.md (Phase 3 in the spec text; Decision 12 in the
-- Revision Log explains the file-00 numbering).
--
-- The irreversible bridge between the MVP schema (public.{anonymous_users,
-- documents, ocr_results, transactions, error_logs}) and the new schema in
-- public. Old tables are MOVED (not copied) into the `archive` schema with a
-- `_v1_mvp` suffix. After this file runs, the old table names are free in
-- `public` for the new schema's CREATE TABLE statements.
--
-- Note: filename uses _m2_00_ prefix (not _m2_09_) so this archive step
-- runs BEFORE the new schema creation in files 01-08. See Decision 12 in
-- the spec Revision Log for the rationale. The spec text refers to this
-- as "Phase 3" for narrative clarity, but execution order in
-- supabase/migrations/ is timestamp-based, so the timestamp wins.
--
-- Manual rollback (post-execution of this file, before file 10 runs):
--   ALTER TABLE archive.anonymous_users_v1_mvp SET SCHEMA public;
--   ALTER TABLE public.anonymous_users_v1_mvp  RENAME TO anonymous_users;
--   -- repeat for documents, ocr_results, transactions, error_logs
--   -- then drop any new public.* tables this file's successors created
--
-- *** ALTER TABLE SET SCHEMA holds an ACCESS EXCLUSIVE lock per table. ***
-- Brief blocking for any concurrent reader/writer. iOS edge functions hitting
-- documents/transactions/error_logs during this window will see momentary
-- "relation does not exist" errors. Run during a low-traffic window. The
-- whole file completes in milliseconds at TestFlight scale.

-- Step 1: Drop the rogue NocoDB junction table found in Phase 1 (Decision 8).
-- It was auto-created by the NocoDB UI and is not part of the spec. Empty
-- (verified Phase 1: 0 rows), so no data is lost. Follow-up: ask Nicolas to
-- remove the corresponding M:M link in the NocoDB UI so the table does not
-- get recreated on the next NocoDB sync (open question #8 in the spec).
DROP TABLE IF EXISTS public._nc_m2m_documents_ocr_results;

-- Step 2: Create the archive schema if it does not yet exist.
CREATE SCHEMA IF NOT EXISTS archive;

-- Step 3: Move the 5 MVP tables. Order is leaf-first so that, if execution is
-- interrupted between any two ALTERs, the partially-archived state is still
-- internally consistent (no archive table FKs to a public table that has
-- since moved). Postgres tracks FKs by OID, not schema name, so the FKs
-- themselves survive any order; this is purely about resumability.

-- error_logs: leaf (no other MVP table FKs to it)
ALTER TABLE public.error_logs       SET SCHEMA archive;
ALTER TABLE archive.error_logs      RENAME TO error_logs_v1_mvp;

-- ocr_results: leaf on the receiving side (FKs to documents; nothing FKs to it)
ALTER TABLE public.ocr_results      SET SCHEMA archive;
ALTER TABLE archive.ocr_results     RENAME TO ocr_results_v1_mvp;

-- transactions: leaf on the receiving side (FKs to documents; nothing FKs to it)
ALTER TABLE public.transactions     SET SCHEMA archive;
ALTER TABLE archive.transactions    RENAME TO transactions_v1_mvp;

-- documents: parent of (now-archived) ocr_results, transactions, error_logs
ALTER TABLE public.documents        SET SCHEMA archive;
ALTER TABLE archive.documents       RENAME TO documents_v1_mvp;

-- anonymous_users: root parent (referenced by documents and error_logs)
ALTER TABLE public.anonymous_users  SET SCHEMA archive;
ALTER TABLE archive.anonymous_users RENAME TO anonymous_users_v1_mvp;
