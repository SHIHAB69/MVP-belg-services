-- M2 Phase 2 — File 12 of 12: Disable RLS on all M2 tables
-- See docs/specs/m2_schema.md (Decision 16 in the Revision Log).
--
-- ============================================================================
-- WHY THIS FILE EXISTS
-- ============================================================================
-- Supabase production projects ship with a public.ensure_rls event trigger
-- that fires on every CREATE TABLE in the public schema and runs
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` automatically. With M2's 37
-- new tables and zero policies defined yet, that auto-enable would block
-- every non-service-role query (NocoDB if anon-keyed, PostgREST anon access,
-- any iOS-direct queries) immediately on production deploy.
--
-- M2's scope agreement (CLAUDE.md "Approved Schema" + Decision 14):
--   - RLS and security policies are M5 territory ("Security: RLS, JWT,
--     encryption, rate limiting" -- done with security specialist).
--   - Until M5 ships proper policies, the tables behave as they did in MVP:
--     access controlled at the edge function layer (service-role key).
--
-- This file explicitly disables RLS on every M2 table to match the
-- "no security work in M2" agreement. Edge functions (which use the
-- service-role key) bypass RLS regardless of this setting -- but without
-- this file, ANYTHING ELSE hitting the database directly would suddenly
-- be blocked on production.
--
-- ============================================================================
-- WHEN THIS GETS REVERSED
-- ============================================================================
-- M5 will:
--   1. ENABLE RLS on every table again (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`)
--   2. Define proper RLS policies per table (per-user filtering, role-based access)
--   3. Test policies against the real auth flow
-- This file's job is just to prevent the auto-enabled-but-unpoliced state from
-- silently breaking everything before M5 lands.
--
-- ============================================================================
-- WHY STAGING DIDN'T SHOW THIS PROBLEM
-- ============================================================================
-- During the staging wipe (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`),
-- the rls_auto_enable() function and ensure_rls event trigger were also
-- dropped because they live in public. Production retains the trigger; the
-- staging miss is what surfaced the issue (Decision 16).
--
-- ============================================================================
-- IDEMPOTENT
-- ============================================================================
-- DISABLE ROW LEVEL SECURITY on a table where RLS is already disabled is a
-- no-op (no error). Safe to re-run.

-- ----------------------------------------------------------------------------
-- File 01 (geography) — 4 tables
-- ----------------------------------------------------------------------------
ALTER TABLE continents                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE countries                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE states_provinces            DISABLE ROW LEVEL SECURITY;
ALTER TABLE cities                      DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- File 02 (entities) — 7 tables
-- ----------------------------------------------------------------------------
ALTER TABLE users                       DISABLE ROW LEVEL SECURITY;
ALTER TABLE companies                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE brands                      DISABLE ROW LEVEL SECURITY;
ALTER TABLE stores                      DISABLE ROW LEVEL SECURITY;
ALTER TABLE persons                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE groups                      DISABLE ROW LEVEL SECURITY;
ALTER TABLE group_members               DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- File 03 (documents) — 9 tables
-- ----------------------------------------------------------------------------
ALTER TABLE documents                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods             DISABLE ROW LEVEL SECURITY;
ALTER TABLE receipts                    DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                    DISABLE ROW LEVEL SECURITY;
ALTER TABLE payslips                    DISABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statements             DISABLE ROW LEVEL SECURITY;
ALTER TABLE cc_statements               DISABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_transactions      DISABLE ROW LEVEL SECURITY;
ALTER TABLE transactions                DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- File 04 (products) — 8 tables
-- ----------------------------------------------------------------------------
ALTER TABLE product_segments            DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_families            DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_classes             DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_commodities         DISABLE ROW LEVEL SECURITY;
ALTER TABLE products_services           DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_attributes          DISABLE ROW LEVEL SECURITY;
ALTER TABLE products_services_attributes DISABLE ROW LEVEL SECURITY;
ALTER TABLE line_items                  DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- File 05 (tracked_assets) — 3 tables
-- ----------------------------------------------------------------------------
ALTER TABLE tracked_objects             DISABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_services            DISABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_services_recurring  DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- File 06 (context) — 5 tables
-- ----------------------------------------------------------------------------
ALTER TABLE events                      DISABLE ROW LEVEL SECURITY;
ALTER TABLE event_links                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE budgets                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE tags                        DISABLE ROW LEVEL SECURITY;
ALTER TABLE taggables                   DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- File 07 (error_logs) — 1 table
-- ----------------------------------------------------------------------------
ALTER TABLE error_logs                  DISABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Permissions (Decision 17): explicit GRANTs to match Supabase's default auto-grant
-- ============================================================================
-- On fresh Supabase projects, the platform automatically grants ALL on every
-- new public table to postgres/anon/authenticated/service_role via internal
-- triggers. The staging wipe (DROP SCHEMA public CASCADE) destroyed that
-- auto-grant mechanism, leaving the new tables with only postgres/public-role
-- grants — and the edge functions (using service_role) hit "permission denied".
--
-- These GRANTs are idempotent: on production where Supabase already granted,
-- re-granting is a no-op. On a wiped staging schema, they restore the missing
-- service_role access.
--
-- Future-table coverage via ALTER DEFAULT PRIVILEGES so any M3+ migration that
-- adds a table doesn't have to remember to repeat these grants.

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
