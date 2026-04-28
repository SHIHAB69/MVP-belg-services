# M2 Pre-Migration Row Counts

**Captured:** 2026-04-26 13:14 UTC (local: 13:14 CEST)
**Captured by:** Shihab (via Claude Code Phase 1)
**Supabase project ref:** `amngfletxzqaokmhccxe` (region `eu-west-1`, Postgres 17.6)
**Backup file(s):**
- `backups/pre_m2_schema_20260426_131445.sql` (8.2 KB)
- `backups/pre_m2_data_20260426_131445.sql` (249 KB)
- _Off-machine copy:_ _<fill in: Google Drive folder URL once uploaded>_

> Phase 1 of M2. These counts are the canonical baseline. The Phase 4.9 `DO` block in the migration enforces parity against these numbers inside the migration transaction; if any count drifts, the whole migration rolls back.

---

## 1. Core table counts

Source query:
```sql
SELECT 'anonymous_users' AS table_name, COUNT(*) AS row_count FROM anonymous_users
UNION ALL SELECT 'documents',    COUNT(*) FROM documents
UNION ALL SELECT 'ocr_results',  COUNT(*) FROM ocr_results
UNION ALL SELECT 'transactions', COUNT(*) FROM transactions
UNION ALL SELECT 'error_logs',   COUNT(*) FROM error_logs;
```

| table_name        | row_count |
|-------------------|-----------|
| anonymous_users   | **87**    |
| documents         | **147**   |
| ocr_results       | **145**   |
| transactions      | **114**   |
| error_logs        | **34**    |

**Out-of-spec table found in `public` schema** (see §3 anomaly 1):

| table_name                              | row_count |
|------------------------------------------|-----------|
| _nc_m2m_documents_ocr_results (NocoDB)   | 0         |

---

## 2. Diagnostic counts (validate migration assumptions)

### 2.1 — Documents with multiple OCR rows (validates Decision 4: DISTINCT ON)

Source query: see template (`docs/migrations/m2_pre_migration_counts.md` source).

| docs_with_multiple_ocr | docs_with_one_ocr | docs_with_no_ocr | max_ocr_per_doc |
|------------------------|-------------------|------------------|-----------------|
| **0**                  | **145**           | **2**            | **1**           |

**Interpretation:** No documents currently have multiple OCR rows. The `DISTINCT ON` in Phase 4.2 is defensive (handles future drift) but not load-bearing for this dataset. The 2 documents with no OCR will migrate with `documents.ocr_text_legacy = NULL`; that's acceptable since the column is nullable.

### 2.2 — Line items JSONB presence (validates Decision 5: expected line_items count)

| rows_without_line_items | rows_with_line_items | total_line_item_elements |
|-------------------------|----------------------|--------------------------|
| **72**                  | **42**               | **131**                  |

**Expected `line_items` table count after migration** = 72 (placeholders) + 131 (real expansions) = **203**.

### 2.3 — Document type breakdown (validates routing default)

| document_type | count |
|---------------|-------|
| `<NULL>`      | **70**  |
| `receipt`     | **43**  |
| `invoice`     | **1**   |
| **Total**     | **114** ✓ matches transactions count |

**Expected `receipts` table count** = 70 (NULL → defaulted to `'receipt'`) + 43 (already `'receipt'`) = **113**.
**Expected `invoices` table count** = **1**.
**Sum:** 113 + 1 = 114 = transactions count ✓.

### 2.4 — Distinct merchants (validates expected stores count)

| rows_with_merchant | distinct_merchants |
|--------------------|--------------------|
| **101**            | **61**             |

**Expected `stores` table count after migration** = **61**. (13 transactions have NULL merchant — those receipts/invoices will have `store_id = NULL`.)

### 2.5 — Distinct (user, payment_method) pairs (validates expected payment_methods count)

| distinct_user_payment_pairs |
|------------------------------|
| **7**                        |

**Expected `payment_methods` count after migration** ≤ **7**. The dedup `ON CONFLICT (user_id, payment_type_corrected, card_last4)` may collapse `debit_card` and `credit_card` rows into a single `'card'` row per user (since `card_last4` is NULL for all migrated rows).

---

## 3. Notes / anomalies observed

### Anomaly 1 — NocoDB-created junction table in `public` schema

`public._nc_m2m_documents_ocr_results` exists in the live database but is NOT in `schema.sql` and NOT in the M2 spec. The `_nc_m2m_` prefix is NocoDB's convention for many-to-many junction tables, indicating it was auto-created when someone configured an M:M link inside the NocoDB UI.

This **violates the rule in CLAUDE.md** (`Tech Stack Notes`): _"Supabase owns ALL schema definition. NocoDB never creates or alters tables/fields."_

The table is empty (0 rows) so no data is at risk. Decision needed before Phase 3:
1. **Drop it** before migration starts (cleanest — restores spec invariant). Add to Phase 2 prep.
2. **Archive it** alongside the MVP tables in Phase 3 (preserves audit trail of the violation).
3. **Ignore it** and let Phase 3 leave it in `public`.

Recommend option 1, plus a follow-up conversation with Nicolas about removing the M:M link in the NocoDB UI (otherwise NocoDB may recreate the table).

### Anomaly 2 — 33 documents have no transaction

`documents` count (147) − `transactions` count (114) = 33 documents that exist with file references but have no transaction row. This means extraction failed (or never ran) for those uploads.

Per the current Phase 4.2 SQL, all migrated documents get `extraction_status = 'completed'`, which is wrong for these 33. Suggest amending Phase 4.2 to:

```sql
extraction_status = CASE
    WHEN t.id IS NULL THEN 'failed'    -- no transaction → extraction never produced data
    ELSE 'completed'
END,
```

Not a blocker; can be added when we write the actual migration files in Phase 2.

### Anomaly 3 — 2 documents have no OCR result

Documents (147) − ocr_results (145) = 2. These two documents have file uploads but no OCR text. They'll migrate with `ocr_text_legacy = NULL`, which is fine. Likely the same documents as anomaly 2 (failed extractions).
