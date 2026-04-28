# M2 Production Deployment Runbook

> **Window:** 1–2 hours of focused work, plus a low-traffic block for the deployment itself (Phase B) — recommend evening or weekend.
> **Risk:** HIGH. Schema-rewriting migration with data backfill. Reversible only via the pre-staged backup.
> **Pre-staged rollback:** Phase E. Read it BEFORE starting Phase B.
> **Author:** Shihab. Reviewer: Nicolas (heads-up before window opens).
> **Status:** Draft (2026-04-28).

---

## ⏸ Deployment paused 2026-04-28 (resuming next session)

**Why paused:** Phase A.GO blocked at item 8 — local filesystem corruption / stuck-I/O on `.git/index`. After freeing disk pressure (was 98% full, now 79%), `git status` continued to fail with `Operation timed out`. Diagnosis ruled out iCloud (no fileprovider xattrs), confirmed two zombie `git` processes (PIDs 20906, 20907) stuck in uninterruptible kernel I/O wait holding `.git/index` open. `cat .git/index` and `cp` to `/tmp` both fail with the same timeout — these zombies cannot be cleared from userland.

**Blast radius confirmed CONTAINED to `.git/index`:** all 12 migration SQL files, all 7 edge-function `index.ts` files, and both A2 backup files (`pre_m2_deploy_*_20260428_161201.sql`) read cleanly. Production database is unaffected (server-side state).

**Phase A state preserved for resumption:**
- A0 (production access): still valid — `.env`, password, CLI link unchanged.
- A2 (backup): files intact but will be re-taken tomorrow per "fresh backup" rule.
- A3 (row counts captured to `/tmp/m2_pre_deploy_counts.txt`): production will drift overnight — re-run tomorrow.
- A4 (NocoDB junction): empty rogue table, file 00 will drop it — unchanged unless NocoDB recreates it.
- A5a (testers notified): heads-up sent; no separate notice needed tomorrow unless deployment time changes materially.
- A5b (Nicolas C10/C11): already deferred per Phase F3 update.
- A6 (OPENAI_API_KEY): set on production — unchanged.
- A7 (DB connectivity): still valid.
- A8 (file inventory): files OK; only `git status` blocked.

**Resumption plan (next session):**
1. Reboot Mac to clear the zombie git processes.
2. Verify `git status` returns clean and `cat .git/index` succeeds.
3. If still broken: Option C (`rm .git/index && git reset` — non-destructive, working tree on disk is the source of truth) OR `fsck_apfs` from recovery mode OR run deployment from a different machine.
4. Re-run **A2** (fresh backup, new timestamp) and **A3** (fresh production row counts).
5. A8.1 re-check with working `git status`.
6. Re-take the A.GO call with all 8 items green.
7. Then Phase B onward.

**No production database changes were made on 2026-04-28.** Pause point is pre-Phase-B.

---

---

## Phase A — Pre-deployment (hours/days before, or first 20 min of the window)

### A0. Verify you have production access RIGHT NOW

Before anything else, confirm the three things you'll need throughout the deployment.

```bash
# 1. Production .env exists and has SUPABASE_DB_URL set
test -f .env && echo "✓ .env present" || { echo "✗ NO .env — populate before continuing"; exit 1; }
grep -q '^SUPABASE_DB_URL=' .env && echo "✓ SUPABASE_DB_URL set" || { echo "✗ SUPABASE_DB_URL missing"; exit 1; }

# 2. Password actually works (production DB connection check)
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "SELECT current_database(), current_user;" \
  && echo "✓ DB connection works" \
  || { echo "✗ DB auth failed — reset password via dashboard, update .env, retry"; exit 1; }

# 3. CLI linked to production
ref=$(cat supabase/.temp/project-ref 2>/dev/null)
[ "$ref" = "amngfletxzqaokmhccxe" ] && echo "✓ CLI linked to production" \
  || { echo "✗ CLI linked to '$ref' (not production); run: supabase link --project-ref amngfletxzqaokmhccxe"; exit 1; }
```

**Expected:** all three lines print `✓`.

**Verify:** if any line printed `✗`, fix the underlying issue before proceeding. The deployment cannot run without these three.

**Common gotchas:**
- `.env` was deleted/never created → populate from password manager
- Password is the old one we rotated → reset via dashboard, update `.env`
- CLI linked to staging from earlier work → re-link to production

**Rollback:** N/A (read-only checks).

---

### A1. (Re-)verify the Supabase CLI is linked to production

A0 already checked this. If you skipped A0, run:

```bash
cat supabase/.temp/project-ref
```

**Expected output:** `amngfletxzqaokmhccxe` (the production ref).

**Rollback:** N/A.

---

### A2. Take a fresh production backup

The Phase 1 backup (`pre_m2_schema_20260426_131445.sql`) is ~2 days old. Take a fresh one — this is your **only** rollback artifact for Phase E.

```bash
TS=$(date +%Y%m%d_%H%M%S)
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

/opt/homebrew/opt/postgresql@17/bin/pg_dump "$DB_URL" \
  --schema=public --schema-only --no-owner --no-privileges \
  --file="backups/pre_m2_deploy_schema_${TS}.sql"

/opt/homebrew/opt/postgresql@17/bin/pg_dump "$DB_URL" \
  --schema=public --data-only --no-owner --no-privileges \
  --file="backups/pre_m2_deploy_data_${TS}.sql"

ls -lh backups/pre_m2_deploy_*
echo "--- sanity ---"
grep -c "^CREATE TABLE" "backups/pre_m2_deploy_schema_${TS}.sql"
grep -c "^COPY public" "backups/pre_m2_deploy_data_${TS}.sql"
echo "--- TIMESTAMP TO REMEMBER: $TS ---"
```

**Expected output:**
- Two files, both non-zero. Schema ~8–10 KB, data file size proportional to row count.
- `CREATE TABLE` count: at least **5** (anonymous_users, documents, ocr_results, transactions, error_logs) plus possibly 1 (NocoDB junction if it returned — see A4).
- `COPY public` count: at least **5** non-empty COPY blocks.

**Verify:**
- Both files > 1 KB.
- **Save the timestamp `$TS` somewhere visible** — Phase E rollback commands need it.
- Optional: copy both files to off-machine storage (Google Drive, etc.) for paranoia.

**Rollback:** N/A. If backup fails, **STOP THE DEPLOYMENT** and investigate. Don't proceed without a backup.

---

### A3. Capture pre-migration production row counts

These numbers will be compared against post-migration counts to verify nothing was lost.

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT 'anonymous_users' AS t, COUNT(*) AS rows FROM anonymous_users
  UNION ALL SELECT 'documents',      COUNT(*) FROM documents
  UNION ALL SELECT 'ocr_results',    COUNT(*) FROM ocr_results
  UNION ALL SELECT 'transactions',   COUNT(*) FROM transactions
  UNION ALL SELECT 'error_logs',     COUNT(*) FROM error_logs
  ORDER BY t;
" | tee /tmp/m2_pre_deploy_counts.txt
```

**Expected output:** A table with 5 rows. From Phase 1 baseline:
- `anonymous_users`: ~87 (may have grown — note the new value)
- `documents`: ~147
- `ocr_results`: ~145
- `transactions`: ~114
- `error_logs`: ~34

**Verify:**
- Values are non-zero and look reasonable (production is active).
- Captured to `/tmp/m2_pre_deploy_counts.txt` for reference during smoke test (C-phase).

**Rollback:** N/A (read-only).

---

### A4. Confirm rogue NocoDB junction table handling

Phase 1 found `public._nc_m2m_documents_ocr_results` (empty). Decision 8 + file 00 drop it via `IF EXISTS`. Verify current state:

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='_nc_m2m_documents_ocr_results'
  ) AS rogue_junction_exists;
"

/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT COUNT(*) FROM public._nc_m2m_documents_ocr_results;
" 2>/dev/null || echo "(table absent — already dropped or never recreated)"
```

**Expected output:** Either `rogue_junction_exists = f` (Nicolas removed the M:M link in NocoDB and it never came back) OR `rogue_junction_exists = t` with `count = 0` (still there, still empty — file 00 will drop it).

**Verify:**
- If `t` and count > 0: STOP. The table has data we'd lose. Investigate before proceeding.
- If `t` and count = 0: file 00's DROP will handle it. Continue.
- If `f`: file 00's DROP is a no-op. Continue.

**Follow-up reminder:** if it's still present, Nicolas needs to remove the M:M link in the NocoDB UI post-deploy or the table will get recreated on next NocoDB sync.

**Rollback:** N/A (read-only).

---

### A5. Notify testers AND confirm Nicolas is available for C10/C11

Two sub-tasks here. Both matter.

**5a. Notify TestFlight testers.** Send a brief WhatsApp message to active testers OR post in the testers channel:

> "M2 backend migration starting at <time>. The app may show stale data or fail to upload for ~15 minutes during the deployment window. Will confirm when it's back to normal."

**5b. Confirm Nicolas-availability for C10 (real iOS upload) and C11 (voice mode tests).** These tests require him to actually use the iOS app during the smoke-test window. WhatsApp:

> "M2 deploys at <time>. I'll need you on iOS for ~10 minutes around <time + 30 min> to upload one receipt and test voice mode. Confirm you'll be reachable?"

**Verify:**
- At least one tester acknowledgment OR an explicit "no testers actively using the app right now" decision.
- Nicolas confirms he'll be reachable during the smoke-test window (typically T+30 min to T+45 min from window start).

**If Nicolas can't be on-call:** either reschedule the deployment OR proceed with the explicit understanding that C10 and C11 will be deferred to next time Nicolas is available. Update the runbook's Phase F sign-off to reflect this.

**Rollback:** N/A.

---

### A6. Verify `OPENAI_API_KEY` is set on production

The new `upload` function (and `chat`/`ask` LLM fallback) needs this. It's almost certainly already set because current production functions use it, but confirm:

Open <https://supabase.com/dashboard/project/amngfletxzqaokmhccxe/functions/secrets> in browser. Verify `OPENAI_API_KEY` row exists.

**Verify:** key is listed (value is hidden — that's fine).

**Rollback:** N/A. If absent, set it before deploying functions in B6.

---

### A7. Verify production `.env` credentials actually work

(Already done in A0; this is a re-confirmation step that's standalone if you skipped A0.)

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "SELECT current_database(), current_user, substring(version() from '^[^,]*');"
```

**Expected output:** `postgres | postgres | PostgreSQL 17.x …`

**Rollback:** N/A.

---

### A8. Confirm all 12 migration files + 7 edge functions are committed and unchanged

```bash
git status
git log --oneline -5
ls supabase/migrations/202604261400*
ls supabase/functions/*/index.ts | wc -l   # should be 7
```

**Expected output:**
- `git status`: working tree clean (or only this runbook is uncommitted).
- 12 migration files present (00, 01, 02, 03, 04, 05, 06, 07, 08, 10, 11, 12 — file 09 deliberately unused per Decision 12).
- 7 edge function `index.ts` files.

**Verify:** counts match. If anything is uncommitted you didn't expect, investigate before deploying.

**Rollback:** N/A.

---

## Phase A.GO — Go/No-Go Decision (mandatory checkpoint)

Before opening Phase B, every item below must be **green**. If any one is red, **DO NOT PROCEED**.

| # | Check | Source |
|---|---|---|
| 1 | Production access verified (.env, password, CLI link) | A0 |
| 2 | Fresh backup taken AND timestamp recorded | A2 |
| 3 | Pre-migration row counts captured to `/tmp/m2_pre_deploy_counts.txt` | A3 |
| 4 | NocoDB rogue table state confirmed (absent OR empty) | A4 |
| 5 | Testers notified AND Nicolas confirmed on-call | A5 |
| 6 | OPENAI_API_KEY set on production | A6 |
| 7 | Production DB connection works | A7 |
| 8 | All 12 migration files + 7 functions present and clean | A8 |

**Decision:** ⬜ GO  ⬜ NO-GO

If GO: timestamp the decision and proceed to Phase B.
If NO-GO: list the failing items, schedule a follow-up, do NOT enter Phase B.

```
GO/NO-GO timestamp: __________________
Decision by:        __________________ (Shihab)
```

---

## Phase B — Deployment Window (10–15 min)

> **From this point forward, every command is irreversible without invoking Phase E rollback.**
> **Work in a clean terminal. Don't multitask.**

### B0. Tag the pre-deployment commit state

Capture the exact code state being deployed, so rollback can reference what was deployed and why.

```bash
git tag -a "m2-pre-deploy-$(date +%Y%m%d-%H%M%S)" -m "Pre-M2-deploy snapshot. All 12 migration files + 7 edge functions ready to apply." || echo "(tag already exists or git error — investigate before continuing)"
git push --tags
git log --oneline -1
```

**Expected output:** annotated tag created, pushed to origin, latest commit hash printed.

**Verify:**
- `git tag -l "m2-pre-deploy-*"` lists the new tag.
- `git push` succeeded (no auth errors).
- Capture the commit hash printed by `git log --oneline -1` — Phase E3 (edge function rollback via git history) needs this hash.

**Rollback:** harmless to leave the tag if you don't deploy. If you re-attempt later, append a new timestamp.

---

### B1. Apply file 00 (archive old MVP tables)

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" \
  -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260426140000_m2_00_archive_old_tables.sql
```

**Expected output:**
- Possibly: `NOTICE: table "_nc_m2m_documents_ocr_results" does not exist, skipping` (if Nicolas removed the M:M link in NocoDB) OR `DROP TABLE` (if it was still there).
- `CREATE SCHEMA`
- 10 lines of `ALTER TABLE` (5 SET SCHEMA + 5 RENAME pairs).

**Verify:**

```bash
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT
    (SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='archive') AS archive_schema,
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='archive') AS archive_tables,
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public') AS public_tables;
"
```

Expected: `archive_schema=1, archive_tables=5, public_tables=0`.

**Rollback (if file 00 fails midway):**

```bash
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT table_schema, table_name FROM information_schema.tables
  WHERE table_name SIMILAR TO '(anonymous_users|documents|ocr_results|transactions|error_logs)(_v1_mvp)?'
  ORDER BY table_schema, table_name;
"
# For each table that's in archive but should be in public, reverse:
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  ALTER TABLE archive.error_logs_v1_mvp      RENAME TO error_logs;       ALTER TABLE archive.error_logs      SET SCHEMA public;
  ALTER TABLE archive.ocr_results_v1_mvp     RENAME TO ocr_results;      ALTER TABLE archive.ocr_results     SET SCHEMA public;
  ALTER TABLE archive.transactions_v1_mvp    RENAME TO transactions;     ALTER TABLE archive.transactions    SET SCHEMA public;
  ALTER TABLE archive.documents_v1_mvp       RENAME TO documents;        ALTER TABLE archive.documents       SET SCHEMA public;
  ALTER TABLE archive.anonymous_users_v1_mvp RENAME TO anonymous_users;  ALTER TABLE archive.anonymous_users SET SCHEMA public;
  DROP SCHEMA IF EXISTS archive CASCADE;
"
```

(Adjust to skip tables that didn't move.)

---

### B2. Apply files 01–08 (new schema)

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

for f in 01_geography 02_entities 03_documents 04_products 05_tracked_assets 06_context 07_error_logs 08_indexes_and_triggers; do
  num="${f:0:2}"
  echo "=== Applying file ${num} ==="
  /opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" \
    -X -v ON_ERROR_STOP=1 \
    -f "supabase/migrations/202604261400${num}_m2_${f}.sql" || { echo "FAIL on file ${num}"; exit 1; }
done
```

**Expected output:** for each file, a sequence of `CREATE TABLE` (and `CREATE INDEX` / `CREATE TRIGGER` for file 08). No errors. The loop's `|| exit 1` aborts on first failure.

**Verify:**

```bash
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT COUNT(*) AS public_tables FROM information_schema.tables WHERE table_schema='public';
  SELECT COUNT(*) AS triggers FROM pg_trigger WHERE tgname='set_updated_at' AND NOT tgisinternal;
  SELECT COUNT(*) AS indexes FROM pg_indexes WHERE schemaname='public';
"
```

Expected: `public_tables=37`, `triggers=30`, `indexes >= 50`.

**Rollback (if any file in 01–08 fails):**

```bash
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
  GRANT ALL ON SCHEMA public TO postgres;
  GRANT ALL ON SCHEMA public TO public;
"
# Then move the archived MVP tables back per B1 rollback above.
```

---

### B3. Apply file 10 (data migration with built-in assertions)

This is the **highest-risk step**. Wrapped in `BEGIN/COMMIT`. The `DO` block raises `EXCEPTION` if any row count is off — auto-rolls back the entire transaction.

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" \
  -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260426140010_m2_10_data_migration.sql
```

**Expected output (sequence):** `BEGIN` → ~14 `INSERT`/`UPDATE` lines with row counts → `NOTICE: --- M2 data migration verification ---` followed by row counts → `NOTICE: --- all hard assertions passed ---` → `DO` → `COMMIT`.

**Verify:**

```bash
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT 'users' AS t, COUNT(*) AS new_rows FROM users
  UNION ALL SELECT 'documents',       COUNT(*) FROM documents
  UNION ALL SELECT 'receipts',        COUNT(*) FROM receipts
  UNION ALL SELECT 'invoices',        COUNT(*) FROM invoices
  UNION ALL SELECT 'transactions',    COUNT(*) FROM transactions
  UNION ALL SELECT 'line_items',      COUNT(*) FROM line_items
  UNION ALL SELECT 'stores',          COUNT(*) FROM stores
  UNION ALL SELECT 'payment_methods', COUNT(*) FROM payment_methods
  UNION ALL SELECT 'error_logs',      COUNT(*) FROM error_logs
  ORDER BY t;
"
```

Expected (compare against A3 numbers in `/tmp/m2_pre_deploy_counts.txt`):
- `users` count = A3's `anonymous_users` count
- `documents` count = A3's `documents` count
- `transactions` count = A3's `transactions` count
- `receipts + invoices` count = A3's `transactions` count
- `error_logs` count = A3's `error_logs` count

**Rollback (if file 10's DO block raises EXCEPTION):**
- Transaction auto-rolls back. Database state returns to "post-files-01-08, no data backfilled". Error message names which assertion fired. Investigate, fix, retry.
- If you can't fix and need to bail entirely → invoke Phase E2 (full restore from backup).

---

### B4. Apply file 11 (upload fan-out function)

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" \
  -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260426140011_m2_11_upload_fan_out_fn.sql
```

**Expected output:** `CREATE FUNCTION`.

**Verify:**

```bash
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT proname, pronargs FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'upload_extraction_fan_out';
"
```

Expected: `upload_extraction_fan_out | 21`.

**Rollback:**

```bash
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  DROP FUNCTION IF EXISTS public.upload_extraction_fan_out(
    UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, JSONB
  );
"
```

---

### B5. Apply file 12 (RLS disable + GRANTs)

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" \
  -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260426140012_m2_12_disable_rls.sql
```

**Expected output:** 37 `ALTER TABLE`, 4 `GRANT`, 3 `ALTER DEFAULT PRIVILEGES`.

**Verify:**

```bash
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT
    COUNT(*) FILTER (WHERE rowsecurity)     AS rls_enabled,
    COUNT(*) FILTER (WHERE NOT rowsecurity) AS rls_disabled
  FROM pg_tables WHERE schemaname='public';

  SELECT has_table_privilege('service_role', 'public.users', 'INSERT') AS service_role_can_insert;
"
```

Expected: `rls_enabled=0`, `rls_disabled=37`, `service_role_can_insert=t`.

**Rollback:** Re-enabling RLS would block all non-service-role callers. If you need to roll back, invoke Phase E2.

---

### B6. Deploy 7 edge functions

```bash
for fn in register documents document-file ask chat realtime-session upload; do
  echo "=== Deploying $fn ==="
  supabase functions deploy "$fn" --project-ref amngfletxzqaokmhccxe || { echo "FAIL on $fn"; exit 1; }
done
```

**Expected output:** for each function, deploy confirmation. The CLI also prints "You can inspect your deployment in the Dashboard: ..." links.

**Verify:**

```bash
supabase functions list --project-ref amngfletxzqaokmhccxe
```

Expected: all 7 functions listed as `ACTIVE`. Compare `VERSION` numbers against the previous version (each should have incremented).

**Rollback (per E3):** redeploy the previous version from the tag in B0, or use the dashboard's function version history.

---

### B7. Confirm all 7 functions are responding

```bash
ANON=$(grep -E '^SUPABASE_ANON_KEY=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")
URL="https://amngfletxzqaokmhccxe.supabase.co/functions/v1"

for fn in register documents document-file ask chat realtime-session upload; do
  status=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$URL/$fn" -H "apikey: $ANON")
  echo "  $fn: HTTP $status"
done
```

**Expected output:** all 7 return `200` or `204`.

**Verify:** no `404`s.

**Rollback:** if any function returns 404, the deploy didn't take. Re-run B6 for that function.

---

## Phase C — Smoke test (30–45 min)

### Failure-mode triggers

Before running tests, fix the response in your head:

- **Wrong DATA in a response** (e.g., MVP showed EUR 50, new shows EUR 5; merchant name changed; missing transactions for a user who has them): **STOP IMMEDIATELY and invoke Phase E2.** This is a data corruption signature — every additional minute makes recovery harder.
- **Transient errors** (HTTP 502/503/504, "rate limit", network timeout, OpenAI 429): retry the failing test once. If it passes on retry, continue. If it fails twice, escalate as wrong-data.
- **Wrong SHAPE in a response** (missing key, type mismatch like string-instead-of-number): pause, compare to MVP contract, decide. Most often: pre-existing MVP behavior we already accepted (e.g., literal LFs in JSON, see staging notes).
- **Edge function 500 with `permission denied`**: file 12 didn't apply correctly. Re-apply B5 manually.
- **Edge function 500 with other Postgres error**: paste the error here, diagnose before retry.

Production smoke tests mirror staging. **Use a real production user_id** for c–g.

### C1. Test (a) — register, empty body

```bash
ANON=$(grep -E '^SUPABASE_ANON_KEY=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")
URL="https://amngfletxzqaokmhccxe.supabase.co/functions/v1"

curl -s -i -X POST "$URL/register" -H "apikey: $ANON"
```

**Expected:** HTTP 201 + `{"id":"<uuid>","created_at":"<iso>"}`.

### C2. Test (b) — register with body

```bash
curl -s -X POST "$URL/register" \
  -H "apikey: $ANON" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "deploy-smoke-test", "device_id": "deploy-curl"}'

DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT id, session_id_legacy, device_id_legacy
  FROM users
  WHERE session_id_legacy = 'deploy-smoke-test';
"
```

**Expected:** both `_legacy` columns populated.

### C3. Test (c) — documents GET

Pick a real production user with at least 2 documents.

```bash
USER_ID="<paste real production user UUID here>"

curl -s "$URL/documents?user_id=$USER_ID" -H "apikey: $ANON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
docs = d.get('documents', [])
print(f'documents_count: {len(docs)}')
if docs:
  first = docs[0]
  print(f'first doc keys: {sorted(first.keys())}')
  tx = first.get('transaction', {})
  print(f'transaction keys: {sorted(tx.keys())}')
  print(f'amount: {tx.get(\"amount\")} ({type(tx.get(\"amount\")).__name__})')
"
```

**Expected:** GET returns `documents_count > 0`, full transaction object with 18 keys, `amount` is float.

### C4. Test (d) — documents DELETE

**SKIP — DO NOT RUN.** Staging already verified DELETE cascade behavior with the identical schema (file 03's `ON DELETE CASCADE`). Deleting a real production user's document during a smoke test trades known risk (real data loss) for redundant signal (cascade behavior). If you want extra confidence, ask a tester to explicitly delete a document from the iOS app post-deploy and confirm it disappears from NocoDB.

### C5–C11. Tests f.1–f.7 (ask) and g (chat)

Same pattern as staging. Use `$USER_ID` of the real user picked in C3.

```bash
ASK() {
  local question="$1" expected_qtype="$2"
  echo "--- $expected_qtype: $question ---"
  curl -s -X POST "$URL/ask" -H "apikey: $ANON" -H "Content-Type: application/json" \
    -d "{\"user_id\": \"$USER_ID\", \"question\": \"$question\"}" \
    | python3 -c "
import sys, json
r = json.loads(sys.stdin.read(), strict=False)
qt = r.get('query_type')
at = r.get('answer_text', '')[:200]
ok = '✓' if qt == '$expected_qtype' else '✗ EXPECTED $expected_qtype'
print(f'  query_type: {qt}  {ok}')
print(f'  answer: {at}')
"
}

ASK "What is my total spending?"            "total_all"
ASK "What is my total spending today?"      "total_today"
ASK "What is my total spending this week?"  "total_this_week"
ASK "What is my total spending this month?" "total_this_month"
ASK "What is my total spending by category?" "total_by_category"
ASK "Show me my recent transactions"        "recent_transactions"
ASK "Did I overpay for groceries?"          "unknown"

# Test g: chat
echo "--- chat ---"
curl -s -X POST "$URL/chat" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"user_id\": \"$USER_ID\", \"messages\": [{\"role\": \"user\", \"content\": \"how much have I spent total?\"}]}" \
  | python3 -c "
import sys, json
r = json.loads(sys.stdin.read(), strict=False)
print(f'  top-level keys: {sorted(r.keys())}')
print(f'  answer_text first 300 chars: {r.get(\"answer_text\", \"\")[:300]}')
"
```

**Expected:** every `query_type` matches expected; answer_text is plausible. Chat answer mentions actual EUR amounts from the user's data.

### C9. NocoDB spot-check on 3 random testers

Open NocoDB. Pick 3 users at random from `users`. For each:

- Open the user row → verify their linked `documents` count looks right (matches what they had pre-migration)
- Open one document → verify the receipt/invoice subtype + line_items appear
- Verify `created_at` timestamps haven't shifted

**Expected:** data looks the same as pre-migration. If anything is off → wrong-data trigger → STOP and invoke Phase E2.

### C10. End-to-end iOS upload by Nicolas

WhatsApp Nicolas: "Quick test — upload one new receipt via iOS. Anything works (a coffee receipt is fine). Tell me when done."

Then verify in DB:

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT
    d.id, d.created_at, d.extraction_status, d.document_type_corrected,
    r.total_amount_ocr, r.currency_ocr, s.name_ocr AS store
  FROM documents d
  LEFT JOIN receipts r ON r.document_id = d.id
  LEFT JOIN stores   s ON s.id = r.store_id
  WHERE d.user_id = '<Nicolas user_id>'
  ORDER BY d.created_at DESC
  LIMIT 1;
"
```

**Expected:** new row with `extraction_status='completed'`, real values for amount/currency/store name.

**If extraction failed (`extraction_status='failed'`) or fan-out failed:** check `error_logs` for the document. Investigate before deciding rollback vs fix-forward.

### C11. Voice-mode test

Ask Nicolas (or yourself if you have access to the iOS build) to trigger voice mode and ask each prompt:

- "How much did I spend in March?" (`get_total_spending`)
- "What did I spend at [a merchant they have]?" (`get_spending_by_merchant`)
- "Show me my recent transactions" (`get_recent_transactions`)
- "What was my income for 2026?" (`get_total_income`)

**Expected:** at least 3 of 4 work. `get_total_income` may legitimately return "no income data" (the app doesn't track income).

**If any of the first three fail:** invoke Decision-15-equivalent (build a server-side proxy edge function for the failing tools). Do NOT roll back the whole migration — voice mode is repairable forward.

---

## Phase D — Post-deployment (15 min)

### D1. Tell Nicolas M2 is live

WhatsApp:

> "M2 is deployed and smoke-tested. [Specific findings]. iOS app behavior should be unchanged. Flag anything weird in NocoDB or the app."

### D2. Tear down staging Supabase project

Open <https://supabase.com/dashboard/project/lyvfjvmkkcqinbwlepdm/settings/general> → Danger Zone → Delete project. Confirm.

### D3. Delete `.env.staging`

```bash
rm .env.staging
git status   # should NOT show .env.staging (it's gitignored)
```

### D4. Rotate the production DB password

Open <https://supabase.com/dashboard/project/amngfletxzqaokmhccxe/settings/database>. "Reset database password". Save the new password to your password manager. Update `.env`:

```bash
# Edit .env in your editor — replace the password in SUPABASE_DB_URL.
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "SELECT current_user;"
```

### D5. Note the staging password no longer needs rotation

Staging is deleted (D2). The previously-exposed staging password (`cAUEeqIsIcYZROwl`) has nowhere to be valid against. Just remove from your password manager.

### D6. Update CLAUDE.md

```bash
# Open CLAUDE.md in your editor.
# In the Milestones table:
#   M2: change to "✅ COMPLETE — deployed YYYY-MM-DD"
#   M3: change to "🚧 IN PROGRESS — current focus"
git add CLAUDE.md
git commit -m "Mark M2 complete in CLAUDE.md; M3 now current focus"
git push
```

### D7. Tag the deployment commit

```bash
git tag -a "m2-production-deployed-$(date +%Y%m%d)" -m "M2 backend rewrite live in production. See docs/migrations/m2_deployment_runbook.md."
git push --tags
```

---

## Phase E — Rollback procedures (pre-staged, only if needed)

### E1. Mid-deployment rollback (per phase)

Already covered inline above — see "Rollback" sections of B1 through B6. Each phase's rollback restores the previous-step state without touching what came before.

### E2. Full post-deployment rollback (restore from backup)

Use this if data looks corrupted, smoke tests fail badly, or Nicolas reports the iOS app is broken in a way you can't fix forward.

**Timing note:** restore takes ~5 minutes for ~500 KB of data (Phase 1's volume). If production has grown significantly since Phase 1 (Phase 1 had 147 documents, 114 transactions), expect proportionally longer — pg_restore has to rebuild every index after the data load. Plan for 5–15 minutes total. **Do not panic if it feels slow.**

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")
TS=<the timestamp from A2's backup files>

# Step 1: drop everything new
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
  GRANT ALL ON SCHEMA public TO postgres;
  GRANT ALL ON SCHEMA public TO public;
  DROP SCHEMA IF EXISTS archive CASCADE;
"

# Step 2: restore schema then data from the A2 backup
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -f "backups/pre_m2_deploy_schema_${TS}.sql"
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -f "backups/pre_m2_deploy_data_${TS}.sql"

# Step 3: verify pre-migration row counts restored
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT 'anonymous_users' AS t, COUNT(*) FROM anonymous_users
  UNION ALL SELECT 'documents',      COUNT(*) FROM documents
  UNION ALL SELECT 'ocr_results',    COUNT(*) FROM ocr_results
  UNION ALL SELECT 'transactions',   COUNT(*) FROM transactions
  UNION ALL SELECT 'error_logs',     COUNT(*) FROM error_logs
  ORDER BY t;
"
# Compare against /tmp/m2_pre_deploy_counts.txt. Should match exactly.
```

Then restore the previous edge function versions per E3.

### E3. Edge function rollback

**Path A: dashboard (preferred for individual functions)**

For each function: open <https://supabase.com/dashboard/project/amngfletxzqaokmhccxe/functions> → click the function → "Versions" tab → click the previous version → "Restore". One click per function.

**Path B: redeploy from git history**

```bash
# Use the tag from B0 to find the pre-M2 state
PRE_M2_HASH=$(git rev-list -n 1 m2-pre-deploy-<your-timestamp>)

git stash push -m "pre-rollback M2 work" -- supabase/functions/
git checkout "$PRE_M2_HASH"^ -- supabase/functions/   # parent commit = pre-M2 state

for fn in register documents document-file ask chat realtime-session upload; do
  supabase functions deploy "$fn" --project-ref amngfletxzqaokmhccxe || { echo "FAIL on $fn"; exit 1; }
done

# Restore your M2 work afterward
git checkout HEAD -- supabase/functions/
git stash pop
```

After E2 + E3:
- DB is back to MVP state
- Edge functions are back to MVP code
- iOS app should function as before
- M2 work survives in git history; investigate the failure before re-attempting

---

## Phase F — First 24 hours (monitoring + soak time)

M2 is "deployed" once Phase D is complete. M2 is "shipped" once Phase F's 24-hour soak is clean.

### F1. Hourly check on `error_logs` for the first 6 hours, then twice in the next 18

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT
    error_type,
    COUNT(*) AS occurrences,
    MIN(created_at) AS first_seen,
    MAX(created_at) AS last_seen
  FROM error_logs
  WHERE created_at >= NOW() - INTERVAL '1 hour'
  GROUP BY error_type
  ORDER BY occurrences DESC;
"
```

**Expected:**
- Hour 1: a small spike of `EXTRACTION_FAILED` is normal (Decision 9 — orphan documents marked as failed; these are pre-existing). Anything new (e.g., `FAN_OUT_FAILED`, `PERMISSION_DENIED`, `TRANSACTION_CREATE_ERROR`) is a problem.
- Hours 2–6: error volume should be roughly steady-state (matching pre-deployment baseline).
- Beyond hour 6: any sudden spike means investigate.

**If unexpected errors:**
- `FAN_OUT_FAILED`: file 11 RPC issue. Check the error message; might need to redeploy file 11 or investigate the specific transaction.
- `permission denied`: file 12 GRANTs didn't take. Re-apply B5.
- New `EXTRACTION_FAILED` spike: GPT-4o issue or upload function bug. Check OpenAI status page.

### F2. No M3 work for the first 24 hours

Hard rule. Don't start M3 schema design, don't begin the LLM router work, don't touch CLAUDE.md beyond D6's update. The 24-hour window is for catching latent issues, not for jumping to the next milestone.

If something catches fire in F1, you need clean attention to fix it. Mid-M3 context-switch is the worst time to debug a production issue.

### F3. T+24h: declare M2 done

24 hours after Phase D completes:

```bash
DB_URL=$(grep -E '^SUPABASE_DB_URL=' .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//")

# Last check: cumulative error_logs over the 24h window
/opt/homebrew/opt/postgresql@17/bin/psql "$DB_URL" -c "
  SELECT
    error_type,
    COUNT(*) AS total_24h,
    COUNT(*) FILTER (WHERE document_id IS NOT NULL) AS with_document,
    COUNT(DISTINCT user_id) AS distinct_users_affected
  FROM error_logs
  WHERE created_at >= NOW() - INTERVAL '24 hours'
  GROUP BY error_type
  ORDER BY total_24h DESC;
"
```

**Decision (all 3 conditions must hold for ✅ M2 SHIPPED):**
1. **Error volume clean:** All errors are pre-existing types (extraction failures from real bad images, etc.) within normal volume. New error type appeared → investigate before declaring shipped. If non-trivial, do NOT close out — fix forward and rerun F3 24 hours later.
2. **C10 (Nicolas iOS upload) passed:** A real iOS upload by Nicolas produced a `documents` row with `extraction_status='completed'` and a fan-out into `receipts`/`stores`/`transactions`/`line_items`. **If C10 was deferred at A5b** (Nicolas not available during deploy window), this must be retroactively executed before declaring shipped — schedule it during Nicolas's next iOS session and verify via the C10 SQL.
3. **C11 (voice mode) passed:** At least 3 of 4 voice-mode prompts work end-to-end. **If C11 was deferred at A5b**, same rule as C10 — retroactive execution required before sign-off. A C11 hotfix during the soak window is acceptable per the completion checklist (Soak section).

**If C10 or C11 is still pending Nicolas's availability at T+24h:**
- The error-log soak (condition 1) can pass independently — note it in WhatsApp ("24h soak is clean on the data layer, awaiting C10/C11 with Nicolas").
- Do NOT issue the `m2-shipped-` git tag until all 3 conditions are green.
- The completion checklist's "M2 SHIPPED" sign-off line stays unsigned until C10 + C11 both pass.

If shipped:

```bash
git tag -a "m2-shipped-$(date +%Y%m%d)" -m "M2 24h soak clean. Production-stable."
git push --tags
```

WhatsApp Nicolas: "M2 has soaked cleanly for 24h. Considered shipped. Starting M3 prep."

Then add an entry to CLAUDE.md's Decisions Made table (already updated in D6 with the deployment date):

```
| M2 production deploy + 24h soak | Clean ship | YYYY-MM-DD |
```

---

## Worth saying out loud

- **Don't multitask during Phase B.** One terminal, one task.
- **The 4.9 DO block is your safety net.** If file 10 fails, the data didn't get half-migrated. Trust the assertions.
- **The backup is your last line of defense.** Verify it (Phase A2) before touching anything else.
- **Wrong-data triggers Phase E2 immediately.** Don't try to "fix forward" data corruption — restore and investigate.
- **iOS testers can wait.** A 15-minute "uploads broken" window is acceptable. A "wrong data shown" rollback panic is not.

---

## Estimated time per phase

| Phase | Estimate |
|---|---|
| A (pre-deployment) | 20–30 min (mostly waiting on `pg_dump`) |
| A.GO checkpoint | 5 min |
| B (deployment window) | 5–10 min |
| C (smoke test) | 30–45 min |
| D (post-deployment) | 15 min |
| F (first 24 hours) | spread across 24h, ~30 min total active work |
| **Total active time in deploy window** | **75–105 min** |

Add 30 min buffer for unexpected issues = **2-hour window** is the right call.
