-- M2 Phase 2 — File 02 of 10: Group 2 Entities
-- See docs/specs/m2_schema.md (Phase 2, Group 2).
--
-- 7 tables in dependency order:
--   users -> companies -> brands -> stores -> persons -> groups -> group_members
--
-- External deps from file 01: countries(id), cities(id).
-- Within-file deps: stores -> brands, groups -> users, group_members -> groups.
--
-- NOT in this file: indexes + triggers (file 08); LLM extraction logic (M3).

-- users -- replaces anonymous_users; auth integration happens in M5.
-- The id column keeps DEFAULT gen_random_uuid() for new sign-ups, but the
-- Phase 4 migration explicitly inserts the legacy anonymous_users.id values so
-- existing FK relationships (documents.user_id, error_logs.user_id) survive
-- the schema swap without rewrites.
-- session_id_legacy / device_id_legacy preserve raw values from the old
-- anonymous_users rows; both nullable since we'll mostly stop populating them
-- once real auth lands in M5.
-- auth_user_id is nullable today and gets the FK to auth.users in M5 (not now;
-- Supabase Auth integration is a separate milestone).
CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id       UUID UNIQUE,                     -- TODO (M5): REFERENCES auth.users(id) ON DELETE CASCADE
    session_id_legacy  TEXT,                            -- carried over from anonymous_users.session_id
    device_id_legacy   TEXT,                            -- carried over from anonymous_users.device_id
    email              TEXT,
    first_name         TEXT,
    last_name          TEXT,
    main_currency      TEXT DEFAULT 'EUR',              -- TODO: confirm default with Nicolas (open question #1)
    main_language      TEXT DEFAULT 'en',
    timezone           TEXT,                            -- IANA TZ name (e.g. 'Europe/Brussels')
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW(),
    last_active_at     TIMESTAMPTZ DEFAULT NOW()
);

-- companies -- legal entities issuing invoices, paying salaries, owning brands.
-- Both human-facing fields use the OCR pair convention so prompt-training in
-- M3 can compute the (extracted vs corrected) delta.
CREATE TABLE companies (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name_ocr                  TEXT,
    legal_name_corrected            TEXT,
    registration_number_ocr         TEXT,
    registration_number_corrected   TEXT,
    country_id                      UUID REFERENCES countries(id),
    created_at                      TIMESTAMPTZ DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ DEFAULT NOW()
);

-- brands -- consumer-facing brand names.
-- company_id is nullable: brands can exist without a known parent company
-- (independent labels, white-label products, brands whose owner we haven't
-- resolved yet).
CREATE TABLE brands (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID REFERENCES companies(id),     -- nullable; brand may not have a known parent
    name_ocr        TEXT,
    name_corrected  TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- stores -- physical or online sales locations; the receiver_store_id on transactions.
-- city_id nullable per Decision 1 amendment: GeoNames seed is a separate
-- post-M2 task, so we cannot resolve city names to FKs at upload time yet.
-- city_name_ocr / country_name_ocr capture the raw extractor strings so a
-- post-seed backfill job can resolve them. These two columns are deliberate
-- scaffolding -- no _corrected pair because they exist only until city_id is
-- reliably populated, then they get dropped in a future migration.
-- brand_id nullable: independent local shops without a brand (corner store,
-- single-location restaurant, market stall, etc.).
CREATE TABLE stores (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_id             UUID REFERENCES cities(id),    -- nullable until GeoNames seeded
    brand_id            UUID REFERENCES brands(id),    -- nullable; independent shops
    name_ocr            TEXT,
    name_corrected      TEXT,
    address_ocr         TEXT,
    address_corrected   TEXT,
    city_name_ocr       TEXT,                          -- scaffolding; drop once city_id is reliable
    country_name_ocr    TEXT,                          -- scaffolding; drop once country lookup is wired
    is_online           BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- persons -- non-user humans appearing in financial data (invoice clients,
-- private payers, recipients of money transfers). Anonymous to the extractor;
-- usually filled in / cleaned up by an operator via NocoDB.
CREATE TABLE persons (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name_ocr                TEXT,
    name_corrected          TEXT,
    contact_info_ocr        TEXT,
    contact_info_corrected  TEXT,
    city_id                 UUID REFERENCES cities(id),
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- groups -- flexible buckets for users / persons / companies (households,
-- shared budgets, project teams). created_by_user_id is nullable to allow
-- system-created or migrated groups without a known creator.
CREATE TABLE groups (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    description         TEXT,
    created_by_user_id  UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- group_members -- polymorphic junction. member_id can refer to a row in
-- users, persons, or companies; member_type tells us which.
--
-- DELIBERATE CHOICE: no FK on member_id (Postgres can't constrain a single
-- column to point at three different tables). The CHECK on member_type bounds
-- the polymorphism, and the UNIQUE (group_id, member_id, member_type) prevents
-- duplicate memberships. The trade-off: we lose database-level referential
-- integrity for the member_id reference -- a deleted user/person/company
-- leaves an orphan row here. Accepted for M2; if it bites later, the fix is
-- a periodic cleanup query rather than schema gymnastics.
CREATE TABLE group_members (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    member_id    UUID NOT NULL,                        -- polymorphic; NOT enforced at the DB level (see above)
    member_type  TEXT NOT NULL CHECK (member_type IN ('user', 'person', 'company')),
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (group_id, member_id, member_type)
);
