# M2 Phase 6 — Staging Test Preflight

> Captured before any staging-environment work begins. Lives at
> `docs/migrations/m2_phase6_preflight.md`. Update as items are completed
> or as scope evolves during staging work.

## Purpose

Apply all 11 M2 migration files + the 7 updated edge functions to a
staging Supabase project, verify the migration runs cleanly, seed
realistic test data matching production shape, and run an end-to-end
smoke test before any production deployment.

Strategy: Option 2 from the Phase 5 wrap-up — **disposable second
Supabase project** on free tier. No Docker, no production risk, real
Postgres 17 environment. Delete the staging project when done.

---

## What Phase 5 produced (the deployable surface)

### 11 migration files in `supabase/migrations/`

| File | Purpose |
|------|---------|
| `20260426140000_m2_00_archive_old_tables.sql` | Drop NocoDB junction; move 5 MVP tables to `archive` schema |
| `20260426140001_m2_01_geography.sql` | 4 tables: continents, countries, states_provinces, cities |
| `20260426140002_m2_02_entities.sql` | 7 tables: users, companies, brands, stores, persons, groups, group_members |
| `20260426140003_m2_03_documents.sql` | 9 tables: documents + 6 subtypes + payment_methods + recurring_transactions + transactions |
| `20260426140004_m2_04_products.sql` | 8 tables: UNSPSC 4-level + products_services + attributes + line_items |
| `20260426140005_m2_05_tracked_assets.sql` | 3 tables: tracked_objects, tracked_services, junction |
| `20260426140006_m2_06_context.sql` | 5 tables: events, event_links, budgets, tags, taggables |
| `20260426140007_m2_07_error_logs.sql` | 1 table: error_logs (kept in public per Decision 3) |
| `20260426140008_m2_08_indexes_and_triggers.sql` | trigger_set_updated_at function + 30 triggers + 58 indexes |
| `20260426140010_m2_10_data_migration.sql` | Atomic backfill from archive to new tables (Phase 4 in spec) |
| `20260426140011_m2_11_upload_fan_out_fn.sql` | `upload_extraction_fan_out()` Postgres function for atomic upload fan-out |

> Note: file 09 deliberately unused per Decision 12 (m2_09 was reassigned to m2_00 to fix the ordering bug).

### 7 updated edge functions in `supabase/functions/`

| Function | Migration status | Notes |
|----------|------------------|-------|
| `register` | ✅ Migrated | Inserts into `users`; preserves `session_id`/`device_id` from body if iOS sends them |
| `documents` | ✅ Migrated | GET joins receipts/invoices/stores; DELETE relies on schema CASCADE (Decision 13) |
| `document-file` | ✅ No changes needed | All 4 referenced columns exist with same names in new schema |
| `ask` | ✅ Migrated | COALESCE(_corrected, _ocr) + flatten helper; preserves all 7 query types verbatim |
| `chat` | ✅ Migrated | Tool definitions byte-identical; tool implementations rewritten to fan across new schema |
| `realtime-session` | ✅ No changes needed | No DB access; only creates OpenAI Realtime session |
| `upload` | ✅ Migrated | GPT-4o pipeline preserved; DB fan-out moved to atomic RPC (`upload_extraction_fan_out`) |

---

## Preflight checklist

Each item below must be ✅ before the corresponding staging step runs.
Mark items off as you complete them; flag blockers with a `⚠️` line.

### A. Staging Supabase project credentials

- [ ] Created a new Supabase project (free tier) named `clear-staging` (or similar)
- [ ] Captured the project ref (similar shape to `amngfletxzqaokmhccxe`)
- [ ] Captured the staging Session pooler URI (`postgresql://postgres.<ref>:<password>@aws-X-<region>.pooler.supabase.com:5432/postgres`)
- [ ] Saved staging DB password to a password manager (NOT committed to repo)
- [ ] Verified pg connection: `psql "$SUPABASE_DB_URL_STAGING" -c "SELECT version();"` returns Postgres 17.x
- [ ] `supabase link --project-ref <staging-ref>` successful (so CLI talks to staging by default)
- [ ] **Production link confirmed safe**: working directory's linked project must be staging during this work, not the production `amngfletxzqaokmhccxe` project. Verify with `cat supabase/.temp/project-ref` after linking

### B. Seed data plan

**Decision: B1 — synthetic seed script.** Locked in 2026-04-27.

Reasoning:
- Synthetic data lets us deliberately construct the edge cases we need (33 orphans, 13 NULL merchants, JSONB-present/absent split). Production has uneven edge case coverage.
- No PII risk on staging.
- Faster to reset between test runs.
- B2 (sanitized prod snapshot) was the alternative; rejected because production's edge case distribution is incidental, not designed.

The seed script (`supabase/seeds/staging_mvp_seed.sql`, to be drafted in STEP 2) creates:

- ~10 representative users (smaller than production's 87 but enough to cover patterns)
- ~15 documents covering varied `document_types` (NULL, 'receipt', 'invoice')
- The 33-orphan pattern: 2-3 documents with no transaction
- The 13-NULL-merchant pattern: 1-2 transactions with NULL merchant
- JSONB-present vs JSONB-absent split: mix of transactions with `line_items` array vs without
- Mix of `payment_method` values including 'debit_card', 'credit_card', 'cash', 'mobile_payment', NULL
- A handful of error_logs

Checklist:

- [ ] Seed script drafted in `supabase/seeds/staging_mvp_seed.sql`
- [ ] Seed script reviewed before applying to staging
- [ ] Storage bucket `documents` created on staging (same name as production); seed script will reference paths but no real files needed for staging

### C. Edge function deployment to staging

Deploying functions to a linked Supabase project uses `supabase functions deploy <name>`. Each function deploys independently.

- [ ] `OPENAI_API_KEY` set on staging project (Project Settings → Edge Functions → Secrets)
- [ ] `PDF_CONVERT_API_KEY` set on staging project (same place; if absent, the upload function falls back to base64 image rendering only, fine for non-PDF tests)
- [ ] All 7 functions deployable: dry-run `supabase functions deploy register --project-ref <staging-ref> --dry-run` (or actual deploys against staging only)
- [ ] No iOS app changes required (per Decision 13's working agreement); iOS testers still point at PRODUCTION URLs. Staging deploy is server-side only — we'll exercise it via curl

### D. Voice-mode tool fulfillment plan (deferred from realtime-session)

**Decision: defer to staging smoke test.** Locked in 2026-04-27.

Reasoning:
- Real but bounded risk; fix is small if it materializes (server-side proxy edge function = 1-2 hours).
- Staging smoke is the natural discovery point — exercising the 4 voice prompts will tell us in minutes whether iOS-side fulfillment survives.
- Shihab shouldn't context-switch to iOS-repo grep right now; finishing the staging path is higher leverage.

The 4 realtime tools (`get_total_spending`, `get_spending_by_merchant`, `get_recent_transactions`, `get_total_income`) are defined for OpenAI but executed by iOS (or wherever else holds the Realtime client_secret). The fulfillment path will be exercised in section F's smoke checklist (item 12).

If voice-mode breaks during staging:
- **Decision 15 (would be opened)**: build a server-side proxy edge function exposing those 4 tools against the new schema. iOS would need to switch to calling the proxy. Coordinate with Nicolas before iOS change since it touches the no-iOS-changes-for-M2 agreement.

### E. Migration apply order

**Decision: E2 — pre-create MVP shape, then run all 11 files in order.** Locked in 2026-04-27.

Reasoning:
- Staging must mirror production sequence exactly. If file 00 has a bug, E1 wouldn't catch it.
- The cost of pre-creating MVP shape on staging is negligible (one psql run of `schema.sql` + the 3 migration files that production has applied).
- Worth it for the identical-sequence guarantee.

Files apply in timestamp order via `supabase db push --linked` (or via direct `psql` against the staging connection string). Pre-step: run `schema.sql` and the 3 production-historical migrations against staging FIRST to recreate the MVP shape; THEN seed data; THEN apply the 11 M2 files:

```
PRE-STEP A — schema.sql                                     ← 5 MVP tables (anonymous_users, documents, ocr_results, transactions, error_logs)
PRE-STEP B — 20260222100000_add_ai_summary_to_documents.sql ← documents.ai_summary
PRE-STEP C — 20260223100000_add_city_country_to_transactions.sql
PRE-STEP D — 20260404100000_extend_transactions_extraction_fields.sql
PRE-STEP E — supabase/seeds/staging_mvp_seed.sql            ← synthetic data (B1)

Then the M2 migrations:

00 archive_old_tables    ← runs FIRST (Decision 12; frees public.documents/transactions/error_logs names)
01 geography
02 entities
03 documents
04 products
05 tracked_assets
06 context
07 error_logs
08 indexes_and_triggers
10 data_migration        ← runs LAST among the data files (assertions inside)
11 upload_fan_out_fn     ← Postgres function for upload runtime
```

### F. Smoke test checklist (run AFTER staging migration applies cleanly)

1. [ ] Verify all 36 expected tables exist in `public`: `\dt public.*` shows ~36 tables
2. [ ] Verify 5 archived tables exist in `archive`: `\dt archive.*` shows the `*_v1_mvp` tables
3. [ ] Verify file 10's Phase 4.9 DO block raised no exception (look for "all hard assertions passed" in the migration output)
4. [ ] Compare staging row counts against the seed expectations in section B above (same SQL as `docs/migrations/m2_pre_migration_counts.md`)
5. [ ] **`register`**: `curl -X POST https://<staging-ref>.supabase.co/functions/v1/register -H "apikey: <anon-key>"` returns `{ id, created_at }`
6. [ ] **`documents` GET**: `curl "https://<staging-ref>.supabase.co/functions/v1/documents?user_id=<seeded-user>" -H "apikey: <anon-key>"` returns documents array
7. [ ] **`documents` DELETE**: delete one document, verify cascade removes its receipt/invoice/transaction/line_items via spot-check query
8. [ ] **`document-file`**: GET file bytes for a seeded document
9. [ ] **`ask`**: POST 7 questions, one per query type pattern, verify responses are non-empty and grammatically sensible
10. [ ] **`chat`**: POST a multi-turn message exchange exercising both tools
11. [ ] **`upload`**: POST a real receipt image, verify the document → receipt → transaction → line_items chain populates in one transaction (check that `extraction_status` flips from `pending` to `completed`)
12. [ ] **Voice-mode tool fulfillment** (per section D deferral): exercise each of the 4 realtime tools with a deliberate voice-mode interaction:
    - "How much did I spend in March?" (`get_total_spending`)
    - "What did I spend at [merchant]?" (`get_spending_by_merchant`)
    - "Show me my recent transactions" (`get_recent_transactions`)
    - "What was my income for 2026?" (`get_total_income`)
    - Any tool that fails → flag for Decision 15 (proxy edge function vs iOS update)

### G. Rollback plan if staging blows up

Staging is disposable, so rollback = "create a new staging project and try again." But document any unexpected failures in this file under "Issues encountered" before deleting:

- [ ] Issues encountered section ready to receive notes
- [ ] After all preflight items green: tear down staging project, delete its DB connection from `.env`, move to production deployment

---

## Decisions locked in (2026-04-27)

1. **Seed data: B1 — synthetic.** Lets us deliberately construct edge cases; no PII risk; fast to reset.
2. **Migration apply: E2 — pre-create MVP shape, then run all 11 files.** Mirrors production sequence exactly; catches file-00 bugs.
3. **Voice-mode investigation: defer to staging smoke test.** Real but bounded risk; staging is the natural discovery point; not worth context-switching to iOS-repo grep.

---

## After Phase 6 (production deployment) — checklist preview, not part of preflight

This list is here so we don't lose it. It's the M2 wrap-up; needs its own runbook before execution.

- Take a fresh production backup (the April 26 one will be days/weeks old by then)
- Schedule a low-traffic window (file 00 takes ACCESS EXCLUSIVE locks)
- Apply migrations in timestamp order
- Watch the Phase 4.9 DO block output in real time
- If 4.9 raises: investigate, fix, retry — the migration is in a single transaction so there's no partial state
- Deploy the 7 updated edge functions
- TestFlight smoke test (a tester scans one new receipt and asks one question)
- Reset DB password (the password used for Phase 1 is in the chat transcript)

---

## Issues encountered

_(Populate as we run staging.)_
