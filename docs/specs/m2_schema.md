# Milestone 2 Specification — Build Supabase Schema + Migrate Data

> **Read `CLAUDE.md` at the repo root before reading this spec.** That file contains the project context. This spec assumes you have it.

---

## Objective

Implement the approved 31-object schema in Supabase, migrate existing tester data without loss, and verify the iOS app continues to work without changes.

## Revision Log

**2026-04-26 — applied 7 decisions from spec review:**

1. **GPT-4o vision pipeline preserved.** The current `upload` function already runs GPT-4o vision (not regex). M2 keeps the model call, prompt, parsing, and JSON contract untouched — only the database write layer is rewritten to fan extracted fields out across the new schema. M3 still adds the multi-LLM router and feedback loops on top.
2. **`chat`, `documents`, `document-file` are in scope.** They read the legacy `public.documents` / `public.transactions` directly and would break the moment Phase 3 runs. They get updated in the same deploy as `register`/`upload`/`ask`, preserving response shapes byte-for-byte. `realtime-session` also reviewed (its tool handlers query the same tables).
3. **`error_logs` lives in `public`.** Added to Phase 2 as its own migration file; the old `error_logs` table is still snapshotted to `archive` for parity, and Phase 4 backfills the new `public.error_logs` from it.
4. **`ocr_results` duplicate handling.** Phase 4.2 uses `DISTINCT ON (d.id) … ORDER BY o.created_at DESC` to pick the most recent OCR row per document and avoid PK violations on `documents.id`.
5. **Full mapping of legacy extractor columns.** All 9 columns the recent migration added to `transactions` (`document_type`, `address`, `net_amount`, `tax_amount`, `discount_amount`, `paid_amount`, `payment_method`, `payment_status`, `line_items` JSONB) are now mapped: scalar fields land in `documents` / `receipts` / `payment_methods` / `stores`, and the `line_items` JSONB array is expanded into real `line_items` rows (no placeholder flag) when present. The legacy placeholder pattern is kept only for old rows that have no JSONB array.
6. **Spec is canonical over the diagram.** If the M1 diagram (`docs/diagrams/PFIS_Milestone1_Schema.pdf`) and this spec disagree on a field or relationship, this spec wins. The diagram is the approved high-level structure; this spec is the implementation contract.
7. **Open questions don't block.** Per Nicolas's "continuous delivery" preference, ambiguous fields land with `-- TODO: confirm with Nicolas` comments and the open questions go to the NocoDB backlog. Implementation proceeds on sensible defaults.

**Convention correctness fix applied throughout:** legacy MVP values from the regex/GPT-4o extractor write to `*_ocr` columns, never `*_corrected`. The `*_corrected` columns stay NULL until a human edits via NocoDB or the iOS app. This aligns with the CLAUDE.md non-negotiable rule that `*_corrected` is reserved for human edits — and crucially, it preserves the `_ocr` ↔ `_corrected` delta that the M3 prompt-training pipeline relies on. Polluting `*_corrected` with machine output would corrupt the training signal.

**One deliberate exception to that rule:** `documents.document_type_corrected` for migrated rows is populated with the legacy `archive.transactions_v1_mvp.document_type` value (defaulting to `'receipt'` when null), not left NULL. The column drives subtype routing — which row gets a `receipts` vs `invoices` insert, which iOS detail screen renders — so the migration cannot leave it null. This is a conscious routing-default trade-off, not a human correction; the inline SQL in Phase 4.2 calls it out so future readers don't mistake it for a convention violation.

**2026-04-26 — post-Phase-1 amendments (after row counts captured):**

8. **Drop the rogue NocoDB junction table.** `public._nc_m2m_documents_ocr_results` was found in the live database (auto-created by the NocoDB UI when an M:M link was configured). It violates the "Supabase owns ALL schema definition" rule from CLAUDE.md. The table is empty, so dropping it loses no data. Phase 3 (archive) now starts with `DROP TABLE IF EXISTS public._nc_m2m_documents_ocr_results;`. **Follow-up needed (not blocking):** ask Nicolas to remove the corresponding M:M link inside the NocoDB UI, otherwise NocoDB may recreate the table on its next sync.
9. **`extraction_status = 'failed'` for orphan documents.** Phase 1 found 33 documents (147 − 114) with file uploads but no transaction row — the extraction effectively failed for them. The original Phase 4.2 SQL marked every migrated document `'completed'`, which is wrong for those 33. Phase 4.2 now uses a `CASE` to distinguish: `'completed'` if a legacy transaction exists, `'failed'` otherwise. M3's re-extraction can use this status to know which documents to retry.
10. **`payment_methods` UNIQUE uses `NULLS NOT DISTINCT`.** Standard Postgres treats NULLs as distinct in UNIQUE constraints, which silently breaks the upload function's `ON CONFLICT DO NOTHING` dedup whenever the extractor returns a null `payment_method` (the GPT-4o prompt explicitly allows null). Postgres 15+ supports `UNIQUE NULLS NOT DISTINCT` to flip this behaviour; we're on 17 so it's available. The single keyword keeps dedup working as the spec intends with no structural change. If we ever migrate to a Postgres version below 15 (extremely unlikely), this becomes a partial unique index (`CREATE UNIQUE INDEX … WHERE payment_type_corrected IS NULL AND card_last4 IS NULL`) instead.
11. **`taggables.taggable_type` CHECK enum drops `'merchant'`.** The new schema uses `stores` (file 02), not merchants — there is no `merchants` table for the `'merchant'` enum value to reference. Including it in the CHECK constraint creates a dead branch that no code path can ever produce, and would confuse future developers asking why merchant is separate from store. If a `merchants` table is added later (no current plans), an `ALTER TABLE … DROP CONSTRAINT / ADD CONSTRAINT` pair re-adds the value in one migration.
12. **Archive migration file renamed from `m2_09` to `m2_00` to fix a critical ordering bug.** Files 03 and 07 contain `CREATE TABLE` statements for `documents`, `transactions`, and `error_logs` — names that already exist in the MVP schema. Without `IF NOT EXISTS`, those `CREATE TABLE`s fail with "relation already exists" the moment file 03 runs. The archive step (which frees those names by moving the old tables to the `archive` schema) was originally sequenced as file 09, after the conflicting `CREATE TABLE`s. Renaming to `m2_00` makes it run first. Rejected alternatives: (a) `IF NOT EXISTS` silently accepts old tables and breaks downstream column references; (b) inline archive moves scatter the logic across multiple files and complicate rollback; (c) `DROP` instead of archive loses the 30-day safety net. The spec's Phase numbering still refers to this as Phase 3 for narrative consistency — execution order is timestamp-based in `supabase/migrations/`.
13. **`transactions.document_id` changed from `ON DELETE SET NULL` to `ON DELETE CASCADE`.** The original spec had `SET NULL` on the theory that orphan transactions might be useful (e.g., a transaction whose source document was accidentally deleted could remain in the user's history). In practice this creates orphan rows that pollute the database — every delete path (edge functions, NocoDB operator deletes, future cleanup scripts, manual SQL) would have to remember to delete the transaction first. `CASCADE` matches MVP behavior, ensures consistency across all delete paths, and matches the user expectation: deleting a receipt removes the transaction it represents. NocoDB-driven deletes by Nicolas are the specific case that motivated the change (those bypass any edge-function-level workaround).
14. **Behavior delta accepted: 1 migrated invoice will have NULL `merchant` and `address` in the `documents` endpoint response.** The MVP returned the legacy `transactions.merchant` / `transactions.address` directly. The new schema routes these via `stores.name_ocr` / `stores.address_ocr` linked through `receipts.store_id`, but the 1 migrated invoice has no store linkage — `vendor_company_id` stays NULL during migration because we don't dedupe legacy merchant strings into companies (M3+ work). Affects 0.7% of the dataset (1 of 147 documents). The single affected user can re-upload the invoice or Nicolas can correct it via NocoDB in 30 seconds. A one-row backfill migration is not justified by the cost.
15. **file 10's `payment_method` linkage (steps 4.5b, 4.5c) changed from raw-value match to corrected-value match.** The 4.5a dedup with `ON CONFLICT` collapses different raw values into a single corrected row, keeping only one raw value. With raw-value matching (`pm.payment_type_ocr = t.payment_method`), the dedup loser's transactions can't find the surviving row and end up with `payment_method_id = NULL`. The runtime function in file 11 (`upload_extraction_fan_out`) already used the corrected-value pattern; file 10 now matches for consistency. Caught during staging test (`UPDATE 8` vs expected `UPDATE 9` on a u1 with both `debit_card` and `credit_card` transactions). Estimated production impact: 1+ orphaned FK linkages per user who paid with both card types. Invisible to iOS until someone filters by payment method via `chat`/`ask`.
16. **file 12 added to explicitly DISABLE ROW LEVEL SECURITY on every new public-schema table.** Supabase production projects ship with a `public.ensure_rls` event trigger that auto-enables RLS on any `CREATE TABLE` in `public`. Our 37 new tables would land with RLS enabled but zero policies — blocking every non-service-role query (NocoDB if anon-keyed, PostgREST anon access, any iOS direct queries). Since RLS + policies are M5 territory, M2 ships with RLS explicitly disabled to match the staging behavior the smoke tests verified. M5 will reverse this with proper policies. Caught during Phase 6 staging tests: RLS state was off on staging because the schema wipe (`DROP SCHEMA public CASCADE`) dropped the auto-enable trigger; production retains the trigger.
17. **file 12 also adds explicit GRANTs to match Supabase's default auto-grant on `public` tables.** On a fresh production project, Supabase auto-grants `ALL` on every new public table to `postgres`/`anon`/`authenticated`/`service_role` via internal triggers. The staging wipe (`DROP SCHEMA public CASCADE`) destroyed that mechanism, leaving the new tables with only `postgres`/`public`-role grants. The result on staging: edge functions (which connect as `service_role`) hit `permission denied for table users` on the first INSERT. Caught during runtime smoke test of `POST /register`. The GRANTs are idempotent — on production where Supabase already granted, they're no-ops; on staging where they're missing, they restore access. `ALTER DEFAULT PRIVILEGES` is also added so any M3+ table inherits the grants without each migration having to remember.

## Success Criteria

The milestone is complete when ALL of the following are true:

- [ ] All 31 tables exist in the Supabase project with correct columns, types, foreign keys, indexes, and constraints
- [ ] OCR field pair convention applied to every LLM-populated field
- [ ] All existing tester data migrated from old tables to new schema with verified row counts
- [ ] Old tables renamed to `archive` schema (NOT dropped)
- [ ] Edge functions `register`, `upload`, `ask` updated to write to new schema while preserving exact API contract
- [ ] iOS app verified working (smoke test: scan one receipt, ask one question, results match expected)
- [ ] Pre-migration database backup taken and stored
- [ ] Verification queries documented and run successfully

## Non-Goals (Do NOT Do These)

- ❌ Do NOT modify the iOS app in any way
- ❌ Do NOT add new edge functions beyond what's specified
- ❌ Do NOT add LLM-based extraction (that is M3)
- ❌ Do NOT add user-facing features
- ❌ Do NOT enable Row Level Security yet (that is M5)
- ❌ Do NOT drop any old tables, even after migration
- ❌ Do NOT change the API contract of `register`, `upload`, or `ask`

---

## Field Detail Policy

**Conservative fields only.** Per Nicolas's instruction (2026-04-20 meeting), field-level detail can be iterated during this milestone without it being a blocker.

For each table, include:
- Primary key (`id UUID PRIMARY KEY DEFAULT gen_random_uuid()`)
- Foreign keys to parent tables
- Obviously-required fields (names, amounts, dates)
- OCR field pairs for any LLM-populated field
- `created_at TIMESTAMPTZ DEFAULT NOW()` and `updated_at TIMESTAMPTZ DEFAULT NOW()`

For ambiguous fields (e.g. is this nullable? what's the precision?), use sensible defaults and add a `-- TODO: confirm with Nicolas` comment. Do not block on these.

---

## Naming Conventions

Follow these conventions strictly:

- **Table names:** plural snake_case (`stores`, `line_items`, `tracked_objects`)
- **Column names:** singular snake_case (`store_id`, `created_at`)
- **Foreign key columns:** `{referenced_table_singular}_id` (e.g., `city_id`, `user_id`)
- **OCR field pairs:** `{field}_ocr` (raw) and `{field}_corrected` (human edit)
- **Timestamps:** `created_at`, `updated_at` (with auto-update trigger on `updated_at`)
- **Boolean columns:** prefix with `is_` (e.g., `is_recurring`)
- **Enum-like text columns:** use CHECK constraint with allowed values

---

## Phase 1 — Pre-Migration Backup

**Run this BEFORE creating any new tables.**

### Step 1.1: Take Supabase snapshot

If on a Supabase paid plan, trigger a manual point-in-time backup via the dashboard or CLI.

### Step 1.2: Export old tables to SQL dump

```bash
# From local machine with supabase CLI configured
supabase db dump --schema public > backups/pre_m2_migration_$(date +%Y%m%d_%H%M%S).sql
```

Store the file in:
1. Local `backups/` folder (gitignored)
2. Upload to Google Drive (folder TBD with Nicolas)

### Step 1.3: Document row counts before migration

Run and save the output:

```sql
SELECT 'anonymous_users' AS table_name, COUNT(*) FROM anonymous_users
UNION ALL SELECT 'documents', COUNT(*) FROM documents
UNION ALL SELECT 'ocr_results', COUNT(*) FROM ocr_results
UNION ALL SELECT 'transactions', COUNT(*) FROM transactions
UNION ALL SELECT 'error_logs', COUNT(*) FROM error_logs;
```

Save to `docs/migrations/m2_pre_migration_counts.md`. These will be compared against post-migration counts.

---

## Phase 2 — Create New Schema

Create migrations in `supabase/migrations/`. One file per logical group, prefixed with timestamp.

### Migration File Order

Per Decision 12 (Revision Log), the archive step runs FIRST (file `m2_00_`),
not last, because files `m2_03_` and `m2_07_` reuse the legacy table names
`documents`, `transactions`, and `error_logs`. Sequence number `m2_09_` is
unused — it was reassigned to `m2_00_`.

0. `YYYYMMDDHHMMSS_m2_00_archive_old_tables.sql` — Move old tables to archive schema (runs FIRST per Decision 12)
1. `YYYYMMDDHHMMSS_m2_01_geography.sql` — Geography group (4 tables)
2. `YYYYMMDDHHMMSS_m2_02_entities.sql` — Entities group (6 tables + group_members junction)
3. `YYYYMMDDHHMMSS_m2_03_documents.sql` — Documents group (9 tables)
4. `YYYYMMDDHHMMSS_m2_04_products.sql` — Products group (7 tables + products_services_attributes junction)
5. `YYYYMMDDHHMMSS_m2_05_tracked_assets.sql` — Tracked Assets (2 tables + tracked_services_recurring junction)
6. `YYYYMMDDHHMMSS_m2_06_context.sql` — Context group (3 tables + event_links + taggables junctions)
7. `YYYYMMDDHHMMSS_m2_07_error_logs.sql` — error_logs (kept in public; see Decision 3)
8. `YYYYMMDDHHMMSS_m2_08_indexes_and_triggers.sql` — Indexes, updated_at triggers
9. _(unused — sequence number reassigned to `m2_00_` per Decision 12)_
10. `YYYYMMDDHHMMSS_m2_10_data_migration.sql` — Backfill data from archive to new tables
11. `YYYYMMDDHHMMSS_m2_11_upload_fan_out_fn.sql` — `upload_extraction_fan_out()` Postgres function added during Phase 5; gives `upload/` edge function atomic fan-out semantics via a single RPC. Reusable by M3's re-extraction worker.
12. `YYYYMMDDHHMMSS_m2_12_disable_rls.sql` — Explicitly DISABLE ROW LEVEL SECURITY on every M2 table (per Decision 16). Counters Supabase's `ensure_rls` auto-enable event trigger on production. Reversed by M5 with proper policies.

### Group 1 — Geography (4 tables)

```sql
-- continents
CREATE TABLE continents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,           -- e.g. 'EU', 'AS', 'NA'
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- countries
CREATE TABLE countries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    continent_id UUID NOT NULL REFERENCES continents(id),
    iso_code TEXT NOT NULL UNIQUE,       -- ISO 3166-1 alpha-2 (e.g. 'BE', 'BD')
    name TEXT NOT NULL,
    currency_code TEXT,                  -- ISO 4217 (e.g. 'EUR', 'BDT')
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- states_provinces
CREATE TABLE states_provinces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_id UUID NOT NULL REFERENCES countries(id),
    code TEXT,                           -- e.g. 'BRU' for Brussels region
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- cities
CREATE TABLE cities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_province_id UUID NOT NULL REFERENCES states_provinces(id),
    geonames_id BIGINT UNIQUE,           -- GeoNames reference
    name TEXT NOT NULL,
    latitude NUMERIC(9, 6),
    longitude NUMERIC(9, 6),
    timezone TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Note on GeoNames seeding:** Do NOT seed GeoNames data in this migration. Seeding will be a separate task. Tables must exist first.

### Group 2 — Entities (6 tables)

```sql
-- users (replaces anonymous_users; auth integration is M3/M5)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID UNIQUE,             -- TODO: link to auth.users in M5
    session_id_legacy TEXT,               -- preserved from anonymous_users
    device_id_legacy TEXT,                -- preserved from anonymous_users
    email TEXT,
    first_name TEXT,
    last_name TEXT,
    main_currency TEXT DEFAULT 'EUR',     -- TODO: confirm default with Nicolas
    main_language TEXT DEFAULT 'en',
    timezone TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_active_at TIMESTAMPTZ DEFAULT NOW()
);

-- companies
CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name_ocr TEXT,
    legal_name_corrected TEXT,
    registration_number_ocr TEXT,
    registration_number_corrected TEXT,
    country_id UUID REFERENCES countries(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- brands
CREATE TABLE brands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id),  -- nullable
    name_ocr TEXT,
    name_corrected TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- stores
-- Note: city_id is nullable until GeoNames is seeded (separate post-M2 task).
-- Without seeded cities, the upload function and migration cannot resolve city
-- names to city_id. After seeding, a backfill job can populate city_id and the
-- column can be tightened to NOT NULL in a later migration.
CREATE TABLE stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_id UUID REFERENCES cities(id),         -- nullable until GeoNames seeded
    brand_id UUID REFERENCES brands(id),        -- nullable
    name_ocr TEXT,
    name_corrected TEXT,
    address_ocr TEXT,
    address_corrected TEXT,
    -- raw city/country strings as extracted, until GeoNames lookup is wired
    city_name_ocr TEXT,                         -- TODO: drop once city_id is reliable
    country_name_ocr TEXT,                      -- TODO: drop once country lookup is wired
    is_online BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- persons (non-user individuals appearing in financial data)
CREATE TABLE persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name_ocr TEXT,
    name_corrected TEXT,
    contact_info_ocr TEXT,
    contact_info_corrected TEXT,
    city_id UUID REFERENCES cities(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- groups (flexible groupings of users/persons/companies)
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    created_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- group_members (junction for groups M:M users/persons/companies)
CREATE TABLE group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    member_id UUID NOT NULL,
    member_type TEXT NOT NULL CHECK (member_type IN ('user', 'person', 'company')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (group_id, member_id, member_type)
);
```

### Group 3 — Documents & Transactions (9 tables)

```sql
-- documents (parent)
-- document_type follows the OCR pair convention: _ocr stores the raw extractor
-- output (no CHECK), _corrected is the validated routing value used to pick
-- the subtype table (receipts/invoices/etc). App code reads corrected else ocr.
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type_ocr TEXT,                   -- raw extractor output
    document_type_corrected TEXT CHECK (document_type_corrected IN (
        'receipt', 'invoice', 'payslip', 'bank_statement', 'cc_statement', 'other'
    )),
    file_path TEXT NOT NULL,
    file_url TEXT,
    mime_type TEXT,
    file_size BIGINT,
    file_hash TEXT,                           -- for dedup detection
    issue_date_ocr DATE,
    issue_date_corrected DATE,
    issuer_name_ocr TEXT,
    issuer_name_corrected TEXT,
    -- raw transcribed text from the extractor (replaces the standalone ocr_results table)
    full_text_ocr TEXT,
    full_text_corrected TEXT,
    -- free-form extra info from the extractor (the "ai_summary" field of GPT-4o JSON)
    ai_summary_ocr TEXT,
    ai_summary_corrected TEXT,
    -- legacy: text from the old ocr_results.raw_text, preserved for migrated rows.
    -- New uploads write to full_text_ocr; this column is for historical data only.
    ocr_text_legacy TEXT,
    extraction_status TEXT DEFAULT 'pending' CHECK (extraction_status IN (
        'pending', 'processing', 'completed', 'failed'
    )),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- receipts (subtype of documents)
-- Carries the rich monetary breakdown the extractor produces. Every extractor-
-- populated field has its OCR pair. payment_method_id links to payment_methods
-- (created/looked up by upload function), kept here for fast access.
CREATE TABLE receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id),
    payment_method_id UUID REFERENCES payment_methods(id),
    total_amount_ocr NUMERIC(10, 2),
    total_amount_corrected NUMERIC(10, 2),
    net_amount_ocr NUMERIC(10, 2),
    net_amount_corrected NUMERIC(10, 2),
    tax_amount_ocr NUMERIC(10, 2),
    tax_amount_corrected NUMERIC(10, 2),
    discount_amount_ocr NUMERIC(10, 2),
    discount_amount_corrected NUMERIC(10, 2),
    paid_amount_ocr NUMERIC(10, 2),
    paid_amount_corrected NUMERIC(10, 2),
    currency_ocr TEXT,
    currency_corrected TEXT,
    purchase_date_ocr DATE,
    purchase_date_corrected DATE,
    -- payment_status is "completed" | "not_paid" | "other" from extractor; free-text in _ocr
    payment_status_ocr TEXT,
    payment_status_corrected TEXT,
    -- top-level category label from extractor (e.g. "Groceries", "Restaurant").
    -- Future: link to UNSPSC commodity_id; for M2 keep as free text.
    category_ocr TEXT,
    category_corrected TEXT,
    description_ocr TEXT,
    description_corrected TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- invoices (subtype of documents)
-- Same monetary breakdown as receipts. The extractor produces the same JSON
-- regardless of document_type; we route into invoices when document_type
-- (corrected) is 'invoice'.
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    vendor_company_id UUID REFERENCES companies(id),
    payment_method_id UUID REFERENCES payment_methods(id),
    invoice_number_ocr TEXT,
    invoice_number_corrected TEXT,
    due_date_ocr DATE,
    due_date_corrected DATE,
    total_amount_ocr NUMERIC(10, 2),
    total_amount_corrected NUMERIC(10, 2),
    net_amount_ocr NUMERIC(10, 2),
    net_amount_corrected NUMERIC(10, 2),
    tax_amount_ocr NUMERIC(10, 2),
    tax_amount_corrected NUMERIC(10, 2),
    discount_amount_ocr NUMERIC(10, 2),
    discount_amount_corrected NUMERIC(10, 2),
    paid_amount_ocr NUMERIC(10, 2),
    paid_amount_corrected NUMERIC(10, 2),
    currency_ocr TEXT,
    currency_corrected TEXT,
    payment_status_ocr TEXT,
    payment_status_corrected TEXT,
    category_ocr TEXT,
    category_corrected TEXT,
    description_ocr TEXT,
    description_corrected TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- payslips (subtype of documents)
CREATE TABLE payslips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    employer_company_id UUID REFERENCES companies(id),
    pay_period_start_ocr DATE,
    pay_period_start_corrected DATE,
    pay_period_end_ocr DATE,
    pay_period_end_corrected DATE,
    gross_amount_ocr NUMERIC(10, 2),
    gross_amount_corrected NUMERIC(10, 2),
    net_amount_ocr NUMERIC(10, 2),
    net_amount_corrected NUMERIC(10, 2),
    currency_ocr TEXT,
    currency_corrected TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- bank_statements (subtype of documents)
CREATE TABLE bank_statements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    account_number_ocr TEXT,
    account_number_corrected TEXT,
    bank_name_ocr TEXT,
    bank_name_corrected TEXT,
    period_start_ocr DATE,
    period_start_corrected DATE,
    period_end_ocr DATE,
    period_end_corrected DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- cc_statements (subtype of documents)
CREATE TABLE cc_statements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    card_number_last4_ocr TEXT,
    card_number_last4_corrected TEXT,
    issuer_name_ocr TEXT,
    issuer_name_corrected TEXT,
    period_start_ocr DATE,
    period_start_corrected DATE,
    period_end_ocr DATE,
    period_end_corrected DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- payment_methods
-- payment_type uses the OCR pair convention: _ocr stores the raw string from
-- the extractor (which uses a more granular vocabulary like "debit_card",
-- "credit_card", "mobile_payment", "not_paid"); _corrected is the validated,
-- routing-friendly enum value. Mapping happens in app code (see Phase 5.2).
CREATE TABLE payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payment_type_ocr TEXT,                                 -- raw string from extractor
    payment_type_corrected TEXT CHECK (payment_type_corrected IN (
        'card', 'mobile', 'biometric', 'cash', 'bank_transfer', 'other'
    )),
    card_last4 TEXT,
    label TEXT,                              -- user-given name e.g. "My Visa"
    device TEXT,                             -- e.g. 'iPhone', 'Watch', 'Physical Card'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    -- dedup backing for the upload function's ON CONFLICT DO NOTHING.
    -- NULLS NOT DISTINCT (Decision 10): standard Postgres treats NULLs as
    -- distinct in UNIQUE constraints, which silently breaks dedup when the
    -- extractor returns a null payment_method. Postgres 15+ supports this clause.
    UNIQUE NULLS NOT DISTINCT (user_id, payment_type_corrected, card_last4)
);

-- recurring_transactions
CREATE TABLE recurring_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payment_method_id UUID REFERENCES payment_methods(id),
    label TEXT,                              -- e.g. "Netflix subscription"
    amount NUMERIC(10, 2),
    currency TEXT,
    frequency TEXT CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
    start_date DATE,
    end_date DATE,                           -- nullable
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- transactions (the hub; payer/receiver self-link)
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,  -- CASCADE per Decision 13 (matches MVP; prevents orphan transactions across all delete paths)
    counterpart_transaction_id UUID REFERENCES transactions(id),  -- payer↔receiver link
    payment_method_id UUID REFERENCES payment_methods(id),
    recurring_transaction_id UUID REFERENCES recurring_transactions(id),
    direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount_ocr NUMERIC(10, 2),
    amount_corrected NUMERIC(10, 2),
    currency_ocr TEXT,
    currency_corrected TEXT,
    transaction_date_ocr DATE,
    transaction_date_corrected DATE,
    -- party identification (nullable, only one side per row)
    payer_user_id UUID REFERENCES users(id),
    payer_person_id UUID REFERENCES persons(id),
    payer_company_id UUID REFERENCES companies(id),
    receiver_user_id UUID REFERENCES users(id),
    receiver_person_id UUID REFERENCES persons(id),
    receiver_company_id UUID REFERENCES companies(id),
    receiver_store_id UUID REFERENCES stores(id),
    -- legacy preserved
    parser_version_legacy TEXT,
    prompt_version_legacy TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Group 4 — Products & Services (7 tables)

```sql
-- UNSPSC hierarchy: Segment → Family → Class → Commodity
-- Seed data NOT included here. Will be loaded separately.

CREATE TABLE product_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unspsc_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE product_families (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id UUID NOT NULL REFERENCES product_segments(id),
    unspsc_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE product_classes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES product_families(id),
    unspsc_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE product_commodities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES product_classes(id),
    unspsc_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE products_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commodity_id UUID REFERENCES product_commodities(id),
    brand_id UUID REFERENCES brands(id),
    name_ocr TEXT,
    name_corrected TEXT,
    description_ocr TEXT,
    description_corrected TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE product_attributes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                      -- e.g. 'size', 'colour', 'weight'
    value TEXT NOT NULL,                     -- e.g. '500g', 'red'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (name, value)
);

-- products_services M:M product_attributes
CREATE TABLE products_services_attributes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_service_id UUID NOT NULL REFERENCES products_services(id) ON DELETE CASCADE,
    attribute_id UUID NOT NULL REFERENCES product_attributes(id),
    UNIQUE (product_service_id, attribute_id)
);

CREATE TABLE line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    product_service_id UUID REFERENCES products_services(id),
    name_ocr TEXT,
    name_corrected TEXT,
    quantity_ocr NUMERIC(10, 3),
    quantity_corrected NUMERIC(10, 3),
    unit_price_ocr NUMERIC(10, 2),
    unit_price_corrected NUMERIC(10, 2),
    total_price_ocr NUMERIC(10, 2),
    total_price_corrected NUMERIC(10, 2),
    currency_ocr TEXT,
    currency_corrected TEXT,
    -- migration flag: true if created from MVP transaction without real line item data
    is_mvp_legacy_placeholder BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Group 5 — Tracked Assets (2 tables)

```sql
CREATE TABLE tracked_objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purchase_transaction_id UUID REFERENCES transactions(id),
    purchase_document_id UUID REFERENCES documents(id),
    asset_type TEXT,                         -- e.g. 'car', 'property', 'appliance'
    name TEXT NOT NULL,
    description TEXT,
    purchase_date DATE,
    purchase_amount NUMERIC(12, 2),
    currency TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE tracked_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                      -- e.g. 'Streaming subscriptions'
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- tracked_services M:M recurring_transactions
CREATE TABLE tracked_services_recurring (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tracked_service_id UUID NOT NULL REFERENCES tracked_services(id) ON DELETE CASCADE,
    recurring_transaction_id UUID NOT NULL REFERENCES recurring_transactions(id) ON DELETE CASCADE,
    UNIQUE (tracked_service_id, recurring_transaction_id)
);
```

### Group 6 — Context (3 tables + junction tables)

```sql
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    event_type TEXT,                         -- e.g. 'holiday', 'wedding'
    start_date DATE,
    end_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (user_id IS NOT NULL OR group_id IS NOT NULL)
);

CREATE TABLE event_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    linked_id UUID NOT NULL,
    linked_type TEXT NOT NULL CHECK (linked_type IN ('transaction', 'document')),
    UNIQUE (event_id, linked_id, linked_type)
);

CREATE TABLE budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL,
    period TEXT CHECK (period IN ('weekly', 'monthly', 'quarterly', 'yearly', 'custom')),
    period_start DATE,
    period_end DATE,
    -- TODO: confirm with Nicolas — link budget to category, segment, or event?
    commodity_id UUID REFERENCES product_commodities(id),
    event_id UUID REFERENCES events(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (user_id IS NOT NULL OR group_id IS NOT NULL)
);

CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    colour TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- polymorphic tag attachment.
-- 'merchant' deliberately omitted from the CHECK enum per Decision 11 in the
-- Revision Log: the new schema uses `stores` as the merchant entity, so
-- 'merchant' would be a dead branch no code path can produce.
CREATE TABLE taggables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    taggable_id UUID NOT NULL,
    taggable_type TEXT NOT NULL CHECK (taggable_type IN (
        'transaction', 'document', 'line_item', 'product_service', 'store'
    )),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (tag_id, taggable_id, taggable_type)
);
```

### Group 7 — Error Logs (kept in public, see Decision 3)

Same shape as the legacy MVP `error_logs`, but FKs point at the new `users` and `documents` tables in `public`. The legacy `error_logs` table is still snapshotted to `archive` (Phase 3) and its rows are migrated into this fresh table (Phase 4.6); the snapshot stays for 30+ days as audit history.

```sql
CREATE TABLE error_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    error_type TEXT NOT NULL,
    error_message TEXT NOT NULL,
    stack_trace TEXT,
    context JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Indexes & Triggers

```sql
-- Foreign key indexes (Postgres doesn't auto-index FKs)
CREATE INDEX idx_documents_user_id ON documents(user_id);
CREATE INDEX idx_documents_created_at ON documents(created_at DESC);
CREATE INDEX idx_documents_status ON documents(extraction_status);
CREATE INDEX idx_receipts_document_id ON receipts(document_id);
CREATE INDEX idx_receipts_store_id ON receipts(store_id);
CREATE INDEX idx_invoices_document_id ON invoices(document_id);
CREATE INDEX idx_line_items_document_id ON line_items(document_id);
CREATE INDEX idx_line_items_product_id ON line_items(product_service_id);
CREATE INDEX idx_transactions_document_id ON transactions(document_id);
CREATE INDEX idx_transactions_counterpart ON transactions(counterpart_transaction_id);
CREATE INDEX idx_transactions_date ON transactions(transaction_date_corrected, transaction_date_ocr);
CREATE INDEX idx_stores_city_id ON stores(city_id);
CREATE INDEX idx_stores_brand_id ON stores(brand_id);
CREATE INDEX idx_taggables_lookup ON taggables(taggable_type, taggable_id);
CREATE INDEX idx_event_links_lookup ON event_links(linked_type, linked_id);
CREATE INDEX idx_error_logs_document_id ON error_logs(document_id);
CREATE INDEX idx_error_logs_user_id ON error_logs(user_id);
CREATE INDEX idx_error_logs_created_at ON error_logs(created_at DESC);
CREATE INDEX idx_payment_methods_user_id ON payment_methods(user_id);
CREATE INDEX idx_receipts_payment_method_id ON receipts(payment_method_id);
CREATE INDEX idx_invoices_payment_method_id ON invoices(payment_method_id);
CREATE INDEX idx_documents_type_corrected ON documents(document_type_corrected);
CREATE INDEX idx_documents_user_created ON documents(user_id, created_at DESC);

-- updated_at auto-update trigger
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to every table with updated_at column (loop or repeat per table)
-- Example for one table:
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();
-- Repeat for ALL tables with updated_at column.
```

---

## Phase 3 — Archive Old Tables

```sql
-- Create archive schema
CREATE SCHEMA IF NOT EXISTS archive;

-- Drop the rogue NocoDB junction table found in Phase 1 (Decision 8).
-- It was auto-created by the NocoDB UI and is not part of the spec. Empty,
-- so no data is lost. Follow-up: ask Nicolas to remove the M:M link in the
-- NocoDB UI so it does not get recreated.
DROP TABLE IF EXISTS public._nc_m2m_documents_ocr_results;

-- Move old tables (do NOT drop)
ALTER TABLE public.anonymous_users SET SCHEMA archive;
ALTER TABLE archive.anonymous_users RENAME TO anonymous_users_v1_mvp;

ALTER TABLE public.documents SET SCHEMA archive;
ALTER TABLE archive.documents RENAME TO documents_v1_mvp;

ALTER TABLE public.ocr_results SET SCHEMA archive;
ALTER TABLE archive.ocr_results RENAME TO ocr_results_v1_mvp;

ALTER TABLE public.transactions SET SCHEMA archive;
ALTER TABLE archive.transactions RENAME TO transactions_v1_mvp;

ALTER TABLE public.error_logs SET SCHEMA archive;
ALTER TABLE archive.error_logs RENAME TO error_logs_v1_mvp;
```

**Important:** This step happens AFTER the new tables are created (Phase 2) but BEFORE data migration (Phase 4). Old table names go to archive so the new `documents` and `transactions` tables can take their place in `public`.

**On `error_logs`:** Per Decision 3, the new `error_logs` lives in `public` (created in Phase 2, file 07). The old `error_logs` is still moved to `archive.error_logs_v1_mvp` here as an audit snapshot (its FKs reference legacy tables that are also in `archive`, so the snapshot remains internally consistent). Phase 4.6 then backfills the new `public.error_logs` from the snapshot.

---

## Phase 4 — Data Migration

Wrap the entire migration in a transaction. If any step fails, the whole thing rolls back.

**OCR convention applied (Decision 1 / Convention fix):** all values from the legacy regex/GPT-4o extractor write to `*_ocr` columns. `*_corrected` columns stay NULL — they are reserved for human edits via NocoDB or the iOS app. The previous draft of this spec wrote to `*_corrected`; that was a convention violation and is fixed below.

**Decision 4 — `ocr_results` deduplication:** old `ocr_results` had no UNIQUE on `document_id`. We pick the most recent OCR row per document via `DISTINCT ON (d.id) … ORDER BY o.created_at DESC` to avoid PK violations on `documents.id`.

**Decision 5 — full mapping of extractor columns:** all 9 columns the recent migration added to `transactions` (`document_type`, `address`, `net_amount`, `tax_amount`, `discount_amount`, `paid_amount`, `payment_method`, `payment_status`, `line_items` JSONB) are mapped: scalar fields land in `documents`, `receipts`, `payment_methods`, and `stores`; the JSONB `line_items` array is expanded into real `line_items` rows when present (no placeholder flag), and the placeholder pattern only kicks in for legacy rows that have an empty/null `line_items` JSONB.

```sql
BEGIN;

-- ---------------------------------------------------------------------------
-- 4.1: Migrate users
-- ---------------------------------------------------------------------------
INSERT INTO users (id, session_id_legacy, device_id_legacy, created_at, last_active_at)
SELECT id, session_id, device_id, created_at, last_active_at
FROM archive.anonymous_users_v1_mvp;

-- ---------------------------------------------------------------------------
-- 4.2: Migrate documents (preserve UUIDs)
-- DISTINCT ON picks the most recent ocr_result per document — old schema had
-- no UNIQUE on ocr_results.document_id so duplicates are possible.
-- document_type_corrected uses the value from the legacy transaction if present
-- (since the GPT-4o extractor populated it), defaulting to 'receipt' otherwise.
-- ---------------------------------------------------------------------------
INSERT INTO documents (
    id, user_id,
    document_type_ocr, document_type_corrected,
    file_path, file_url, mime_type, file_size,
    ocr_text_legacy, extraction_status, created_at, updated_at
)
SELECT
    d.id,
    d.user_id,
    t.document_type,                                          -- raw extractor value (may be null) → _ocr per convention
    -- CONVENTION EXCEPTION: document_type_corrected is set here (not left NULL)
    -- because it drives subtype routing (receipt/invoice/etc). This is a
    -- routing default, not a human correction. See Revision Log "One deliberate
    -- exception to that rule" for the rationale.
    COALESCE(NULLIF(t.document_type, ''), 'receipt'),
    d.file_path,
    d.file_url,
    d.mime_type,
    d.file_size,
    o.raw_text,                                                -- legacy column for migrated rows
    -- Decision 9: 'failed' for documents with no legacy transaction (extraction
    -- never produced data for them — Phase 1 found 33 such orphans). 'completed'
    -- otherwise. M3 re-extraction can target the 'failed' rows.
    CASE WHEN t.id IS NULL THEN 'failed' ELSE 'completed' END,
    d.created_at,
    d.updated_at
FROM archive.documents_v1_mvp d
LEFT JOIN LATERAL (
    SELECT raw_text
    FROM archive.ocr_results_v1_mvp o2
    WHERE o2.document_id = d.id
    ORDER BY o2.created_at DESC
    LIMIT 1
) o ON TRUE
LEFT JOIN archive.transactions_v1_mvp t ON t.document_id = d.id;

-- ---------------------------------------------------------------------------
-- 4.3: Create receipts records for every migrated document
-- All extractor-populated values go to *_ocr (per OCR convention fix).
-- Maps the full set of legacy transactions columns including the 9 added by
-- the 20260404 migration (net/tax/discount/paid/payment_status/category/etc).
-- ---------------------------------------------------------------------------
INSERT INTO receipts (
    document_id,
    total_amount_ocr, net_amount_ocr, tax_amount_ocr,
    discount_amount_ocr, paid_amount_ocr,
    currency_ocr, purchase_date_ocr,
    payment_status_ocr, category_ocr, description_ocr,
    created_at, updated_at
)
SELECT
    t.document_id,
    t.amount,                                                  -- old "amount" = total
    t.net_amount,
    t.tax_amount,
    t.discount_amount,
    t.paid_amount,
    t.currency,
    t.transaction_date,
    t.payment_status,
    t.category,
    t.description,
    t.created_at,
    t.updated_at
FROM archive.transactions_v1_mvp t
WHERE COALESCE(NULLIF(t.document_type, ''), 'receipt') = 'receipt';

-- ---------------------------------------------------------------------------
-- 4.3b: Same fan-out for invoices (rare in tester data but possible).
-- ---------------------------------------------------------------------------
INSERT INTO invoices (
    document_id,
    total_amount_ocr, net_amount_ocr, tax_amount_ocr,
    discount_amount_ocr, paid_amount_ocr,
    currency_ocr,
    payment_status_ocr, category_ocr, description_ocr,
    created_at, updated_at
)
SELECT
    t.document_id,
    t.amount, t.net_amount, t.tax_amount,
    t.discount_amount, t.paid_amount,
    t.currency,
    t.payment_status, t.category, t.description,
    t.created_at, t.updated_at
FROM archive.transactions_v1_mvp t
WHERE COALESCE(NULLIF(t.document_type, ''), 'receipt') = 'invoice';

-- ---------------------------------------------------------------------------
-- 4.4: Create stores from legacy merchant + address (deduped by lowercased
-- merchant name). city_id stays NULL until GeoNames is seeded; raw city/country
-- strings are kept in stores.city_name_ocr / country_name_ocr for later backfill.
-- ---------------------------------------------------------------------------
INSERT INTO stores (name_ocr, address_ocr, city_name_ocr, country_name_ocr)
SELECT DISTINCT ON (lower(t.merchant))
    t.merchant,
    t.address,
    t.city,
    t.country
FROM archive.transactions_v1_mvp t
WHERE t.merchant IS NOT NULL AND length(trim(t.merchant)) > 0
ORDER BY lower(t.merchant), t.created_at DESC;

-- Link receipts.store_id (case-insensitive merchant match)
UPDATE receipts r
SET store_id = s.id
FROM archive.transactions_v1_mvp t, stores s
WHERE r.document_id = t.document_id
  AND t.merchant IS NOT NULL
  AND lower(s.name_ocr) = lower(t.merchant);

-- And invoices.vendor_company_id stays NULL for now (companies not deduped from
-- legacy merchant strings — that is a refinement task post-M2).

-- ---------------------------------------------------------------------------
-- 4.5: Create payment_methods per (user, payment_type) pair seen in legacy data.
-- Maps the extractor's granular vocabulary into the new CHECK enum:
--   "cash"            → 'cash'
--   "debit_card"      → 'card'
--   "credit_card"     → 'card'
--   "mobile_payment"  → 'mobile'
--   "bank_transfer"   → 'bank_transfer'
--   "not_paid"        → 'other'   -- TODO: confirm with Nicolas
--   "other"           → 'other'
-- ---------------------------------------------------------------------------
INSERT INTO payment_methods (user_id, payment_type_ocr, payment_type_corrected)
SELECT DISTINCT
    d.user_id,
    t.payment_method,
    CASE t.payment_method
        WHEN 'cash'           THEN 'cash'
        WHEN 'debit_card'     THEN 'card'
        WHEN 'credit_card'    THEN 'card'
        WHEN 'mobile_payment' THEN 'mobile'
        WHEN 'bank_transfer'  THEN 'bank_transfer'
        WHEN 'not_paid'       THEN 'other'
        WHEN 'other'          THEN 'other'
        ELSE NULL
    END
FROM archive.transactions_v1_mvp t
JOIN archive.documents_v1_mvp d ON d.id = t.document_id
WHERE t.payment_method IS NOT NULL
ON CONFLICT (user_id, payment_type_corrected, card_last4) DO NOTHING;

-- Link receipts.payment_method_id
UPDATE receipts r
SET payment_method_id = pm.id
FROM archive.transactions_v1_mvp t,
     archive.documents_v1_mvp d,
     payment_methods pm
WHERE r.document_id = t.document_id
  AND d.id = t.document_id
  AND pm.user_id = d.user_id
  AND pm.payment_type_ocr = t.payment_method;

-- ---------------------------------------------------------------------------
-- 4.6: Migrate transactions to new shape (preserve UUIDs).
-- All extractor values go to *_ocr.
-- ---------------------------------------------------------------------------
INSERT INTO transactions (
    id, document_id, direction,
    amount_ocr, currency_ocr, transaction_date_ocr,
    payer_user_id, payment_method_id,
    parser_version_legacy, prompt_version_legacy,
    created_at, updated_at
)
SELECT
    t.id,
    t.document_id,
    'debit',
    t.amount,
    t.currency,
    t.transaction_date,
    d.user_id,
    pm.id,
    t.parser_version,
    t.prompt_version,
    t.created_at,
    t.updated_at
FROM archive.transactions_v1_mvp t
JOIN archive.documents_v1_mvp d ON d.id = t.document_id
LEFT JOIN payment_methods pm
    ON pm.user_id = d.user_id
   AND pm.payment_type_ocr = t.payment_method;

-- Link receivers: receipts → receiver_store_id, invoices → receiver_company_id
UPDATE transactions tx
SET receiver_store_id = r.store_id
FROM receipts r
WHERE r.document_id = tx.document_id
  AND tx.receiver_store_id IS NULL;

-- ---------------------------------------------------------------------------
-- 4.7a: Expand legacy line_items JSONB into real line_items rows where present.
-- These are real extracted data, NOT placeholders — is_mvp_legacy_placeholder = FALSE.
-- ---------------------------------------------------------------------------
INSERT INTO line_items (
    document_id, name_ocr, quantity_ocr, unit_price_ocr, total_price_ocr, currency_ocr,
    is_mvp_legacy_placeholder, created_at, updated_at
)
SELECT
    t.document_id,
    li.product_name,
    li.quantity,
    li.unit_price,
    li.total_price,
    t.currency,
    FALSE,
    t.created_at,
    t.updated_at
FROM archive.transactions_v1_mvp t
CROSS JOIN LATERAL jsonb_to_recordset(t.line_items) AS li(
    product_name TEXT, quantity NUMERIC, unit_price NUMERIC, total_price NUMERIC
)
WHERE t.line_items IS NOT NULL
  AND jsonb_typeof(t.line_items) = 'array'
  AND jsonb_array_length(t.line_items) > 0;

-- ---------------------------------------------------------------------------
-- 4.7b: Placeholder line_items for legacy rows with NO JSONB array (one per
-- transaction). Marked with is_mvp_legacy_placeholder = TRUE so M3 can rerun
-- extraction and replace them.
-- ---------------------------------------------------------------------------
INSERT INTO line_items (
    document_id, name_ocr, total_price_ocr, currency_ocr,
    is_mvp_legacy_placeholder, created_at, updated_at
)
SELECT
    t.document_id,
    COALESCE(t.merchant, t.description, 'Legacy transaction'),
    t.amount,
    t.currency,
    TRUE,
    t.created_at,
    t.updated_at
FROM archive.transactions_v1_mvp t
WHERE t.line_items IS NULL
   OR jsonb_typeof(t.line_items) != 'array'
   OR jsonb_array_length(t.line_items) = 0;

-- ---------------------------------------------------------------------------
-- 4.8: Migrate error_logs (Decision 3: new error_logs lives in public; FKs
-- still resolve because UUIDs are preserved across the migration).
-- ---------------------------------------------------------------------------
INSERT INTO error_logs (id, document_id, user_id, error_type, error_message, stack_trace, context, created_at)
SELECT id, document_id, user_id, error_type, error_message, stack_trace, context, created_at
FROM archive.error_logs_v1_mvp;

-- ---------------------------------------------------------------------------
-- 4.9: Verify row counts match
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    old_users_count       INT;
    new_users_count       INT;
    old_docs_count        INT;
    new_docs_count        INT;
    old_tx_count          INT;
    new_tx_count          INT;
    old_errs_count        INT;
    new_errs_count        INT;
    expected_line_items   INT;
    actual_line_items     INT;
BEGIN
    SELECT COUNT(*) INTO old_users_count FROM archive.anonymous_users_v1_mvp;
    SELECT COUNT(*) INTO new_users_count FROM users;
    SELECT COUNT(*) INTO old_docs_count  FROM archive.documents_v1_mvp;
    SELECT COUNT(*) INTO new_docs_count  FROM documents;
    SELECT COUNT(*) INTO old_tx_count    FROM archive.transactions_v1_mvp;
    SELECT COUNT(*) INTO new_tx_count    FROM transactions;
    SELECT COUNT(*) INTO old_errs_count  FROM archive.error_logs_v1_mvp;
    SELECT COUNT(*) INTO new_errs_count  FROM error_logs;

    -- Line items: one per JSONB element + one placeholder per row without JSONB.
    SELECT
        COALESCE(SUM(
            CASE
                WHEN t.line_items IS NULL OR jsonb_typeof(t.line_items) != 'array' OR jsonb_array_length(t.line_items) = 0
                THEN 1
                ELSE jsonb_array_length(t.line_items)
            END
        ), 0)
    INTO expected_line_items
    FROM archive.transactions_v1_mvp t;

    SELECT COUNT(*) INTO actual_line_items FROM line_items;

    IF old_users_count != new_users_count THEN
        RAISE EXCEPTION 'User count mismatch: old=%, new=%', old_users_count, new_users_count;
    END IF;
    IF old_docs_count != new_docs_count THEN
        RAISE EXCEPTION 'Document count mismatch: old=%, new=%', old_docs_count, new_docs_count;
    END IF;
    IF old_tx_count != new_tx_count THEN
        RAISE EXCEPTION 'Transaction count mismatch: old=%, new=%', old_tx_count, new_tx_count;
    END IF;
    IF old_errs_count != new_errs_count THEN
        RAISE EXCEPTION 'Error log count mismatch: old=%, new=%', old_errs_count, new_errs_count;
    END IF;
    IF expected_line_items != actual_line_items THEN
        RAISE EXCEPTION 'Line item count mismatch: expected=%, actual=%', expected_line_items, actual_line_items;
    END IF;

    RAISE NOTICE 'Migration verification passed: % users, % docs, % transactions, % line_items, % error_logs',
                 new_users_count, new_docs_count, new_tx_count, actual_line_items, new_errs_count;
END $$;

COMMIT;
```

---

## Phase 5 — Update Edge Functions

Update existing edge functions to write to the new schema. **API contract must NOT change.** Same request shapes, same response shapes. Only internals differ.

### 5.1: Update `register` function

Old: inserts into `anonymous_users`. New: inserts into `users` (preserves session_id and device_id legacy fields if iOS sends them, otherwise null).

Same request: `POST /functions/v1/register`, body empty.
Same response: `{ id: UUID, created_at: ISO timestamp }`.

### 5.2: Update `upload` function (Decision 1 — keep GPT-4o vision)

**The current `upload` function already runs GPT-4o vision extraction on the file** (`supabase/functions/upload/index.ts`). Shihab built it intentionally; it is working production code. M3 layers a multi-LLM router and feedback loops on top — M2 leaves the model call alone.

**What does NOT change in M2:**
- The GPT-4o call (model `gpt-4o`, temperature 0, `response_format: { type: 'json_object' }`, `max_tokens: 8192`)
- The `EXTRACTION_SYSTEM` prompt
- The `ExtractedReceipt` JSON shape returned by the model
- The PDF handling (Files API → ConvertAPI fallback)
- The base64 encoding helpers, error handling, OpenAI file cleanup
- The response parsing logic in `extractWithOpenAI()`
- The `register` API contract (iOS still sends `multipart/form-data` with `user_id` + `file`; iOS does **not** send `raw_text`)
- The response shape returned to iOS — byte-identical to today

**What DOES change in M2:**
Only the database write layer between "extraction returned JSON" and "respond to client." Today, fields land in flat columns on `public.transactions` (and a row on `public.ocr_results`). After M2, the same JSON fans out across the new tables per the mapping below.

#### GPT-4o JSON → New schema mapping

Every extractor-populated value lands in the corresponding `*_ocr` column. `*_corrected` columns stay NULL until an operator/end-user edits via NocoDB or the iOS app. This is the OCR convention from CLAUDE.md.

| GPT-4o JSON field        | Type             | Destination table   | Destination column            | Notes |
|--------------------------|------------------|---------------------|-------------------------------|-------|
| `full_text`              | string           | `documents`         | `full_text_ocr`               | Replaces the old `ocr_results.raw_text` write — no row in `ocr_results` for new uploads. |
| `ai_summary`             | string \| null   | `documents`         | `ai_summary_ocr`              |  |
| `document_type`          | enum string      | `documents`         | `document_type_ocr` + `document_type_corrected` | `_corrected` gets the same value (validated against the CHECK enum), enabling subtype routing. Unknown values → `'other'`. |
| `merchant`               | string \| null   | `stores`            | `name_ocr` (lookup or insert) | Lookup by `lower(name_ocr) = lower(merchant) AND city_id IS NOT DISTINCT FROM <resolved>`. Insert if no match. |
| `address`                | string \| null   | `stores`            | `address_ocr`                 | On insert; not updated if store already exists. |
| `city`                   | string \| null   | `stores`            | `city_id` (via lookup) + `city_name_ocr` | `city_id` left NULL if GeoNames not seeded; raw string preserved in `city_name_ocr`. |
| `country`                | string \| null   | `stores`            | `country_name_ocr`            | Used for future GeoNames-aided city resolution. |
| `currency`               | string \| null   | `receipts`/`invoices` + `transactions` | `currency_ocr` on both | Same value written to both subtype and the transaction row. |
| `transaction_date`       | string \| null   | `receipts.purchase_date_ocr` (or `invoices.due_date_ocr` if invoice) + `transactions.transaction_date_ocr` | DATE | Date-only portion stored if a time is present (TIMESTAMPTZ would require a column type change — TODO if Nicolas wants times preserved). |
| `amount`                 | number \| null   | `receipts`/`invoices` + `transactions` | `total_amount_ocr` on subtype, `amount_ocr` on transactions |  |
| `net_amount`             | number \| null   | `receipts`/`invoices` | `net_amount_ocr`            |  |
| `tax_amount`             | number \| null   | `receipts`/`invoices` | `tax_amount_ocr`            |  |
| `discount_amount`        | number           | `receipts`/`invoices` | `discount_amount_ocr`       | Always 0 if no discount per extractor contract. |
| `paid_amount`            | number \| null   | `receipts`/`invoices` | `paid_amount_ocr`           |  |
| `payment_method`         | enum string \| null | `payment_methods` | `payment_type_ocr` (raw) + `payment_type_corrected` (mapped) | Lookup by `(user_id, payment_type_corrected, card_last4)`; insert if no match. Receipt/invoice gets `payment_method_id` FK, transaction also gets it. Mapping: `cash→cash`, `debit_card`/`credit_card→card`, `mobile_payment→mobile`, `bank_transfer→bank_transfer`, `not_paid`/`other→other`. |
| `payment_status`         | enum string \| null | `receipts`/`invoices` | `payment_status_ocr`      |  |
| `category`               | string \| null   | `receipts`/`invoices` | `category_ocr`              | Free-text label (e.g. "Groceries"). UNSPSC commodity linkage deferred. |
| `description`            | string \| null   | `receipts`/`invoices` | `description_ocr`           |  |
| `line_items[].quantity`  | number           | `line_items`        | `quantity_ocr`                | One row per array element. `is_mvp_legacy_placeholder = FALSE` since these are real extracted values. |
| `line_items[].product_name` | string        | `line_items`        | `name_ocr`                    |  |
| `line_items[].unit_price` | number          | `line_items`        | `unit_price_ocr`              |  |
| `line_items[].total_price` | number         | `line_items`        | `total_price_ocr`             |  |

**No fields are dropped.** Every key in the GPT-4o JSON has a destination above.

#### New internal flow

1. Validate `user_id` exists in `users`. (Same as today.)
2. Upload file to `documents` Storage bucket. (Same as today.)
3. Insert `documents` row with `extraction_status = 'pending'`, `file_path`, `file_url`, `mime_type`, `file_size`. Capture the new `documents.id`.
4. For PDFs: try OpenAI Files API; fall back to ConvertAPI image conversion. (Same as today.)
5. Call GPT-4o vision exactly as today. Get back the `ExtractedReceipt` JSON.
6. Inside one transaction (`BEGIN; … COMMIT;`):
   - Update the `documents` row with `full_text_ocr`, `ai_summary_ocr`, `document_type_ocr`, `document_type_corrected` (validated against CHECK enum, default `'other'`), and `extraction_status = 'completed'`.
   - Resolve store: `INSERT … ON CONFLICT (lower(name_ocr), city_id) DO NOTHING RETURNING id` (or SELECT first, INSERT if none). Raw `city`/`country` strings preserved in `stores.city_name_ocr` / `stores.country_name_ocr`.
   - Resolve payment method: `INSERT INTO payment_methods (user_id, payment_type_ocr, payment_type_corrected) VALUES (…) ON CONFLICT (user_id, payment_type_corrected, card_last4) DO NOTHING RETURNING id` (or SELECT first).
   - Insert subtype row (`receipts` if `document_type_corrected = 'receipt'`, `invoices` if `'invoice'`, otherwise skip subtype) with `store_id`, `payment_method_id`, and all monetary `*_ocr` columns from the mapping table.
   - Insert `transactions` row: `direction = 'debit'`, `payer_user_id = user_id`, `receiver_store_id = <resolved>`, `payment_method_id = <resolved>`, `document_id = <new doc id>`, `amount_ocr`, `currency_ocr`, `transaction_date_ocr`.
   - For each entry in `line_items[]`, insert one `line_items` row with the four `*_ocr` columns and `is_mvp_legacy_placeholder = FALSE`.
7. On any DB error inside step 6: roll back the txn, set `documents.extraction_status = 'failed'` outside the txn, log to `error_logs`, return same response shape with `transaction_created = false`.
8. Return the same JSON shape iOS expects today: `{ document_id, file_url, transaction_created, ai_summary_generated, ai_summary? }`.

**No iOS-visible behaviour changes.**

### 5.3: Update `ask` function

Old flow:
- Reads from `transactions` table
- Returns plain text answer

New internal flow:
- Same API contract
- Reads from new schema:
  - `transactions` JOINed with `documents` and `receipts`
  - For "merchant" queries, JOIN with `stores`
  - Currency reads `COALESCE(transactions.currency_corrected, transactions.currency_ocr)` (per OCR convention: prefer corrected if non-null)
- Same response: `{ answer_text, query_type }`

**Do NOT add new query types or richer responses.** That is M4.

### 5.4: Update `chat`, `documents`, `document-file`, and verify `realtime-session` (Decision 2)

These functions read `public.documents` and `public.transactions` directly today, and would break the moment Phase 3 archives the legacy tables. They are updated in the same deploy. **Response shapes stay byte-identical** so the iOS app is unaffected.

#### `chat`
Tool implementations (`search_transactions`, `get_documents_summary`) currently SELECT from `documents` and `transactions`. After M2 they must:
- JOIN `transactions` → `documents` → `receipts` (and `invoices` where applicable) → `stores`
- Read amounts/currencies/dates with `COALESCE(*_corrected, *_ocr)`
- Read merchant from `stores.name_corrected` else `stores.name_ocr` else NULL
- Read category from `receipts.category_corrected` else `receipts.category_ocr`
- Keep the JSON response shape returned to the model (the assistant's tool result format) unchanged

#### `documents`
GET returns the document list with embedded transaction; DELETE removes the document and its storage object. After M2:
- The SELECT must hit `documents` LEFT JOIN `receipts`/`invoices` LEFT JOIN `stores`, projecting the same fields the iOS app currently consumes (use `COALESCE(*_corrected, *_ocr)` everywhere)
- DELETE cascades via existing FKs (`receipts`, `transactions`, `line_items` all `ON DELETE CASCADE` from `documents`)
- The response JSON shape stays identical to what iOS currently parses

#### `document-file`
Serves raw file bytes for preview. Reads `documents.file_path` only — no schema-impacting changes needed beyond confirming the row lookup still works against the new `documents` table (it does; PK is preserved).

#### `realtime-session`
Voice session endpoint with its own tool handlers (`get_total_spending`, `get_spending_by_merchant`, `get_recent_transactions`). Same SELECT updates as `chat` apply. The OpenAI Realtime session config and model parameters stay unchanged.

**Verification step before deploy:** smoke-test each function locally against the migrated schema before pushing the deploy. Each function's response should be byte-identical to its current production response for the same inputs (modulo legitimate data changes from the migration).

---

## Phase 6 — Verification

After everything is deployed, run these checks:

### 6.1: Schema verification

```sql
-- Confirm all 31 expected tables exist (plus junction tables)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;
```

Expected count: ~36 tables (31 core objects + a few junction tables: group_members, products_services_attributes, tracked_services_recurring, event_links, taggables).

### 6.2: Row count verification

```sql
-- Must match pre-migration counts (the migration's Phase 4.9 DO block already
-- enforces this inside the transaction; this query is for human review.)
SELECT 'users' AS t, COUNT(*) FROM users
UNION ALL SELECT 'documents',     COUNT(*) FROM documents
UNION ALL SELECT 'receipts',      COUNT(*) FROM receipts
UNION ALL SELECT 'invoices',      COUNT(*) FROM invoices
UNION ALL SELECT 'transactions',  COUNT(*) FROM transactions
UNION ALL SELECT 'line_items',    COUNT(*) FROM line_items
UNION ALL SELECT 'stores',        COUNT(*) FROM stores
UNION ALL SELECT 'payment_methods', COUNT(*) FROM payment_methods
UNION ALL SELECT 'error_logs',    COUNT(*) FROM error_logs;
```

Compare against `docs/migrations/m2_pre_migration_counts.md`. Expected relationships:
- `users` count = old `anonymous_users` count
- `documents` count = old `documents` count
- `receipts` + `invoices` count = old `transactions` count (each old transaction routed to one subtype)
- `transactions` count = old `transactions` count
- `error_logs` count = old `error_logs` count
- `line_items` count = (sum of `jsonb_array_length(line_items)` across old transactions where the array is non-empty) + (count of old transactions with empty/null `line_items`)
- `stores` count = distinct lowercased non-null merchants in old data
- `payment_methods` count ≤ distinct (user_id, payment_type) pairs in old data

### 6.3: Spot-check verification

Pick 3-5 specific test users. For each:

```sql
-- Compare old vs new for one user
SELECT
    (SELECT COUNT(*) FROM archive.documents_v1_mvp WHERE user_id = '<UUID>') AS old_docs,
    (SELECT COUNT(*) FROM documents WHERE user_id = '<UUID>') AS new_docs,
    (SELECT COUNT(*) FROM archive.transactions_v1_mvp t
     JOIN archive.documents_v1_mvp d ON d.id = t.document_id
     WHERE d.user_id = '<UUID>') AS old_tx,
    (SELECT COUNT(*) FROM transactions WHERE payer_user_id = '<UUID>') AS new_tx;
```

All counts must match.

### 6.4: Smoke test from iOS app

- Have a tester scan one new receipt
- Confirm document, receipt, transaction, line_item rows are created in new schema
- Have the same tester ask "what's my total spending?" via chatbot
- Confirm answer includes both old (migrated) and new transactions

### 6.5: NocoDB verification

- Open NocoDB
- Confirm all new tables visible
- Confirm relationships render correctly
- Confirm Nicolas can browse data

---

## Rollback Plan

If anything goes catastrophically wrong:

### Option 1: Transaction rollback (during migration)
The migration is wrapped in `BEGIN/COMMIT`. If anything fails, the whole transaction rolls back automatically. No action needed.

### Option 2: Restore from archive (after migration, before old tables dropped)
```sql
-- Restore old tables to public schema
ALTER TABLE archive.documents_v1_mvp SET SCHEMA public;
ALTER TABLE public.documents_v1_mvp RENAME TO documents;
-- (repeat for all tables)

-- Drop new tables
DROP TABLE public.line_items, public.receipts, ...;

-- Revert edge functions to previous version (from git history)
```

### Option 3: Restore from backup (worst case)
```bash
psql "$DATABASE_URL" < backups/pre_m2_migration_YYYYMMDD_HHMMSS.sql
```

---

## What's NOT in This Milestone (Confirmation)

To prevent scope creep, here's what's explicitly out:

- ❌ LLM-based extraction (M3)
- ❌ Multi-LLM router (M3)
- ❌ Feedback loop UIs in iOS (M4)
- ❌ Field-level user corrections (M3 or M4 — TBD)
- ❌ New chatbot capabilities (M4)
- ❌ Authentication / Supabase Auth (M5)
- ❌ Row Level Security (M5)
- ❌ GeoNames seed data load (separate task post-M2)
- ❌ UNSPSC seed data load (separate task post-M2)
- ❌ Bank API integration (M6)

---

## Open Questions for Nicolas (Document, Don't Block)

Add these to the NocoDB backlog as discussion items, but do not block implementation:

1. Default `main_currency` for users — EUR? Confirm.
2. Can a budget be linked to multiple categories/events, or just one?
3. Where should backups be stored long-term — Google Drive? S3?
4. ~~Should `error_logs` be moved to archive too, or kept in public schema?~~ **RESOLVED 2026-04-26 (Decision 3): kept in public; legacy snapshot to archive.**
5. When existing tester data has `category: "Food"` from the extractor — should we attempt to map to UNSPSC commodity, or leave NULL? **(M2 leaves it as free text in `category_ocr`; UNSPSC linkage is M3+.)**
6. **NEW** — `payment_method = "not_paid"` from the extractor maps to `'other'` in the new CHECK enum. Is that the right home, or should we add a `'not_paid'` option to the enum? **Does not block M2** — the `'other'` default is safe; adding the enum value later is a one-line `ALTER TYPE` / CHECK update.
7. **NEW** — Should the GPT-4o `transaction_date` field, when it includes a time portion (e.g. `"2026-03-05T14:30:00"`), be stored as DATE (current spec) or upgraded to TIMESTAMPTZ on receipts/invoices/transactions? Currently the time portion is dropped. **Does not block M2** — DATE is safe; widening to TIMESTAMPTZ is a non-destructive ALTER if Nicolas wants times preserved later.
8. **NEW (post-Phase-1)** — NocoDB auto-created `public._nc_m2m_documents_ocr_results` and may recreate it after Phase 3 drops it. Nicolas needs to remove the corresponding M:M link inside the NocoDB UI to make the drop permanent. **Does not block M2** — if NocoDB recreates the table it'll just be re-dropped in a future cleanup; data is unaffected.

---

## Estimated Effort

- Phase 1 (backup): 30 minutes
- Phase 2 (schema creation): 4-6 hours
- Phase 3 (archive): 30 minutes
- Phase 4 (data migration): 2-3 hours
- Phase 5 (edge function updates): 4-6 hours
- Phase 6 (verification): 1-2 hours

**Total: ~12-18 hours of focused work.** Likely spread over 2-3 days with testing.
