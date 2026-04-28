-- M2 Phase 2 — File 10 of 10: Data Migration (Phase 4)
-- See docs/specs/m2_schema.md (Phase 4) and Decisions 1, 4, 5, 9, 10 in the
-- Revision Log for the corrections this file applies.
--
-- ============================================================================
-- WHAT THIS FILE DOES
-- ============================================================================
-- Backfills tester data from the archive.* tables (created by file 00) into
-- the new public.* tables (created by files 01-08). Runs in a single
-- BEGIN/COMMIT transaction; any error rolls everything back to the post-archive
-- state with no partial backfill.
--
-- Step order matches Phase 4 in the spec:
--   4.1   users
--   4.2   documents (DISTINCT ON LATERAL for ocr_results dedup; CASE for
--                    extraction_status per Decision 9; document_type pair
--                    populated per Decision 1 / convention exception)
--   4.3   receipts (legacy txns where document_type defaults to 'receipt')
--   4.3b  invoices (legacy txns where document_type = 'invoice')
--   4.4a  stores  (deduplicated from legacy merchant strings)
--   4.4b  receipts.store_id linkage
--   4.5a  payment_methods (extractor enum mapped per Decision 1 mapping table)
--   4.5b  receipts.payment_method_id linkage
--   4.5c  invoices.payment_method_id linkage (parallel to 4.5b)
--   4.6   transactions (UUIDs preserved; party FKs set; payment_method linked)
--   4.6b  transactions.receiver_store_id linkage from receipts
--   4.7a  line_items expanded from legacy line_items JSONB (real data)
--   4.7b  line_items synthetic placeholders (legacy txns without JSONB)
--   4.8   error_logs (per Decision 3 — kept in public)
--   4.9   verification DO block (raises on count mismatch -> rolls back txn)
--
-- ============================================================================
-- OCR CONVENTION ENFORCEMENT (per CLAUDE.md, Decision 1, and convention fix)
-- ============================================================================
-- Every value sourced from the legacy regex/GPT-4o extractor lands in *_ocr.
-- *_corrected stays NULL — reserved exclusively for human edits via NocoDB or
-- the iOS app. Polluting *_corrected with machine output would corrupt the
-- M3 prompt-training delta signal.
--
-- ONE deliberate exception (per Revision Log "One deliberate exception"):
--   documents.document_type_corrected is populated here from legacy
--   transactions.document_type (defaulting to 'receipt' when null) because
--   it drives subtype routing -- the migration cannot leave it null. Inline
--   comment in step 4.2 calls this out at the SQL site.
--
-- ============================================================================
-- EXPECTED ROW COUNTS (from Phase 1 baseline, see docs/migrations/m2_pre_migration_counts.md)
-- ============================================================================
--   users               87
--   documents           147
--   receipts            113   (70 NULL document_type defaulted + 43 receipt)
--   invoices            1
--   transactions        114
--   line_items          203   (72 placeholders + 131 expanded from JSONB)
--   stores              61    (distinct lowercased merchants)
--   payment_methods     <= 7  (distinct (user, payment_type) pairs; mapping
--                              may collapse debit_card+credit_card to one
--                              'card' row per user)
--   error_logs          34
--
-- The 4.9 DO block enforces all of these except payment_methods (which has
-- variable upper bound) -- mismatches raise EXCEPTION and roll back.
--
-- ============================================================================
-- PRECONDITIONS (must hold when this file runs)
-- ============================================================================
-- 1. File 00 has run -- archive.{anonymous_users_v1_mvp, documents_v1_mvp,
--    ocr_results_v1_mvp, transactions_v1_mvp, error_logs_v1_mvp} all exist.
-- 2. Files 01-08 have run -- all new public.* tables, indexes, and triggers
--    exist and are empty.
-- 3. `archive.transactions_v1_mvp` carries the columns added by the
--    20260404 migration (document_type, address, net_amount, tax_amount,
--    discount_amount, paid_amount, payment_method, payment_status, line_items
--    JSONB) -- verified via Phase 1 schema dump.

BEGIN;

-- ============================================================================
-- 4.1: Migrate users
-- ============================================================================
-- UUIDs preserved by explicit insertion (column DEFAULT does not fire when a
-- value is provided). Existing FK relationships pointing at user IDs survive.
INSERT INTO users (id, session_id_legacy, device_id_legacy, created_at, last_active_at)
SELECT id, session_id, device_id, created_at, last_active_at
FROM archive.anonymous_users_v1_mvp;


-- ============================================================================
-- 4.2: Migrate documents (preserve UUIDs)
-- ============================================================================
-- DISTINCT-via-LATERAL pattern picks the most recent ocr_results row per
-- document. Phase 1 confirmed 0 docs with multiple OCR rows in the live data,
-- but this is defensive against future drift (the legacy schema had no
-- UNIQUE on ocr_results.document_id).
--
-- LEFT JOIN to archive.transactions_v1_mvp pulls the document_type the
-- extractor produced. NULL/empty defaults to 'receipt' for routing.
--
-- extraction_status uses a CASE per Decision 9: documents with NO legacy
-- transaction ('failed') vs documents WITH a legacy transaction ('completed').
-- Phase 1 found 33 orphan documents (147 docs - 114 txns); they get marked
-- 'failed' so M3's re-extraction can target them.
INSERT INTO documents (
    id, user_id,
    document_type_ocr, document_type_corrected,
    file_path, file_url, mime_type, file_size,
    ocr_text_legacy, extraction_status,
    created_at, updated_at
)
SELECT
    d.id,
    d.user_id,
    t.document_type,                                          -- raw extractor value (may be null) -> _ocr per convention
    -- CONVENTION EXCEPTION: document_type_corrected is set here (not left NULL)
    -- because it drives subtype routing (receipt/invoice/etc). This is a
    -- routing default, not a human correction. See Revision Log "One
    -- deliberate exception to that rule" for the rationale.
    COALESCE(NULLIF(t.document_type, ''), 'receipt'),
    d.file_path,
    d.file_url,
    d.mime_type,
    d.file_size,
    o.raw_text,                                               -- legacy column for migrated rows; full_text_ocr is for new uploads only
    -- Decision 9: orphan documents (no transaction) -> 'failed'; rest -> 'completed'.
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


-- ============================================================================
-- 4.3: Receipts subtype rows (one per legacy transaction routed to 'receipt')
-- ============================================================================
-- Filter routes legacy txns where document_type is NULL/empty/'receipt'.
-- All extractor-populated values go to *_ocr (per convention fix).
-- Per Phase 1 breakdown: 70 NULL + 43 receipt = 113 expected rows.
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
    t.amount,                                                 -- old "amount" = total
    t.net_amount,
    t.tax_amount,
    t.discount_amount,
    t.paid_amount,
    t.currency,
    t.transaction_date,                                       -- DATE column; time portion (if any) dropped per open question #7
    t.payment_status,
    t.category,
    t.description,
    t.created_at,
    t.updated_at
FROM archive.transactions_v1_mvp t
WHERE COALESCE(NULLIF(t.document_type, ''), 'receipt') = 'receipt';


-- ============================================================================
-- 4.3b: Invoices subtype rows (one per legacy txn with document_type='invoice')
-- ============================================================================
-- Per Phase 1 breakdown: 1 expected row.
-- vendor_company_id stays NULL during migration; companies are not deduped
-- from legacy merchant strings (refinement task post-M2).
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


-- ============================================================================
-- 4.4a: Create stores from legacy merchant + address (deduplicated)
-- ============================================================================
-- DISTINCT ON (lower(merchant)) collapses case variants ("ALDI" vs "Aldi")
-- into a single store. ORDER BY ... created_at DESC picks the most recent
-- address/city/country for each merchant (extractor improves over time, so
-- newer values are more reliable).
-- city_id stays NULL until GeoNames seeding (separate task); raw city /
-- country strings preserved in the scaffolding columns for the future
-- backfill job.
-- Per Phase 1 §2.4: 61 distinct merchants expected.
INSERT INTO stores (name_ocr, address_ocr, city_name_ocr, country_name_ocr)
SELECT DISTINCT ON (lower(t.merchant))
    t.merchant,
    t.address,
    t.city,
    t.country
FROM archive.transactions_v1_mvp t
WHERE t.merchant IS NOT NULL AND length(trim(t.merchant)) > 0
ORDER BY lower(t.merchant), t.created_at DESC;


-- ============================================================================
-- 4.4b: Link receipts.store_id (case-insensitive merchant match)
-- ============================================================================
-- 13 transactions in Phase 1 have NULL merchant -- their receipts will keep
-- store_id = NULL (correct; we have no store to link to).
UPDATE receipts r
SET store_id = s.id
FROM archive.transactions_v1_mvp t,
     stores s
WHERE r.document_id = t.document_id
  AND t.merchant IS NOT NULL
  AND lower(s.name_ocr) = lower(t.merchant);


-- ============================================================================
-- 4.5a: Create payment_methods from legacy data
-- ============================================================================
-- Maps the extractor's granular vocabulary to the new CHECK enum (per
-- Decision 1 / Phase 5.2 mapping):
--   'cash'           -> 'cash'
--   'debit_card'     -> 'card'
--   'credit_card'    -> 'card'
--   'mobile_payment' -> 'mobile'
--   'bank_transfer'  -> 'bank_transfer'
--   'not_paid'       -> 'other'   (open question #6: should we add 'not_paid' to enum?)
--   'other'          -> 'other'
--
-- ON CONFLICT works because the UNIQUE on payment_methods is NULLS NOT
-- DISTINCT (Decision 10): rows with NULL payment_type_corrected and NULL
-- card_last4 collide as expected, instead of inserting duplicates.
-- Per Phase 1 §2.5: <= 7 expected rows (mapping may collapse some).
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


-- ============================================================================
-- 4.5b: Link receipts.payment_method_id
-- ============================================================================
-- Decision 15 fix: match by payment_type_corrected, not payment_type_ocr.
-- The dedup in 4.5a may collapse two raw values (debit_card + credit_card)
-- into a single 'card' row keeping only one raw value. Matching by raw
-- value loses the link for the dedup-loser's transactions. The runtime
-- function (file 11) already uses the corrected-value pattern; file 10
-- now matches.
UPDATE receipts r
SET payment_method_id = pm.id
FROM archive.transactions_v1_mvp t,
     archive.documents_v1_mvp d,
     payment_methods pm
WHERE r.document_id = t.document_id
  AND d.id = t.document_id
  AND pm.user_id = d.user_id
  AND pm.payment_type_corrected IS NOT DISTINCT FROM
      CASE t.payment_method
          WHEN 'cash'           THEN 'cash'
          WHEN 'debit_card'     THEN 'card'
          WHEN 'credit_card'    THEN 'card'
          WHEN 'mobile_payment' THEN 'mobile'
          WHEN 'bank_transfer'  THEN 'bank_transfer'
          WHEN 'not_paid'       THEN 'other'
          WHEN 'other'          THEN 'other'
          ELSE NULL
      END;


-- ============================================================================
-- 4.5c: Link invoices.payment_method_id (same Decision 15 fix as 4.5b)
-- ============================================================================
-- Decision 15 fix: match by payment_type_corrected, not payment_type_ocr.
-- See 4.5b above for full rationale.
UPDATE invoices i
SET payment_method_id = pm.id
FROM archive.transactions_v1_mvp t,
     archive.documents_v1_mvp d,
     payment_methods pm
WHERE i.document_id = t.document_id
  AND d.id = t.document_id
  AND pm.user_id = d.user_id
  AND pm.payment_type_corrected IS NOT DISTINCT FROM
      CASE t.payment_method
          WHEN 'cash'           THEN 'cash'
          WHEN 'debit_card'     THEN 'card'
          WHEN 'credit_card'    THEN 'card'
          WHEN 'mobile_payment' THEN 'mobile'
          WHEN 'bank_transfer'  THEN 'bank_transfer'
          WHEN 'not_paid'       THEN 'other'
          WHEN 'other'          THEN 'other'
          ELSE NULL
      END;


-- ============================================================================
-- 4.6: Migrate transactions to the new shape (preserve UUIDs)
-- ============================================================================
-- All extractor values go to *_ocr.
-- direction = 'debit' for every migrated MVP transaction (legacy data is
-- user-paid receipts; bank statement multi-transaction patterns come later).
-- payer_user_id = the document's owner; receiver_store_id linked in 4.6b.
-- payment_method_id resolved through the same OCR-string match as 4.5b.
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


-- ============================================================================
-- 4.6b: Link transactions.receiver_store_id from receipts
-- ============================================================================
-- For receipt-routed transactions, the receiver is the store that issued the
-- receipt. invoices map to receiver_company_id (via vendor_company_id) but
-- vendor_company_id is NULL during migration, so invoice transactions keep
-- receiver_*_id all NULL until a future cleanup.
UPDATE transactions tx
SET receiver_store_id = r.store_id
FROM receipts r
WHERE r.document_id = tx.document_id
  AND tx.receiver_store_id IS NULL
  AND r.store_id IS NOT NULL;


-- ============================================================================
-- 4.7a: Expand legacy line_items JSONB into real line_items rows
-- ============================================================================
-- Real extracted data, NOT placeholders -- is_mvp_legacy_placeholder = FALSE.
-- jsonb_to_recordset unpacks each element of the array into a row.
-- Per Phase 1 §2.2: 42 transactions have non-empty line_items totalling
-- 131 elements -> 131 rows expected from this step.
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


-- ============================================================================
-- 4.7b: Synthetic line_items placeholders (legacy txns with no JSONB array)
-- ============================================================================
-- One row per legacy txn that has no extracted line items. M3 can re-run
-- extraction from documents.full_text_ocr / files and replace these.
-- Per Phase 1 §2.2: 72 transactions without line_items -> 72 placeholders.
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


-- ============================================================================
-- 4.8: Migrate error_logs (Decision 3 -- new table lives in public)
-- ============================================================================
-- FKs (document_id, user_id) resolve cleanly because UUIDs are preserved
-- across the migration; the new public.documents and public.users hold the
-- same IDs as their archived predecessors did.
INSERT INTO error_logs (id, document_id, user_id, error_type, error_message, stack_trace, context, created_at)
SELECT id, document_id, user_id, error_type, error_message, stack_trace, context, created_at
FROM archive.error_logs_v1_mvp;


-- ============================================================================
-- 4.9: Verification (raises on mismatch -> rolls back the whole transaction)
-- ============================================================================
DO $$
DECLARE
    -- legacy counts (read from archive.*)
    old_users_count       INT;
    old_docs_count        INT;
    old_tx_count          INT;
    old_errs_count        INT;
    expected_line_items   INT;

    -- new counts (read from public.*)
    new_users_count       INT;
    new_docs_count        INT;
    new_receipts_count    INT;
    new_invoices_count    INT;
    new_tx_count          INT;
    actual_line_items     INT;
    new_errs_count        INT;
    new_stores_count      INT;
    new_payment_methods_count INT;
BEGIN
    SELECT COUNT(*) INTO old_users_count FROM archive.anonymous_users_v1_mvp;
    SELECT COUNT(*) INTO old_docs_count  FROM archive.documents_v1_mvp;
    SELECT COUNT(*) INTO old_tx_count    FROM archive.transactions_v1_mvp;
    SELECT COUNT(*) INTO old_errs_count  FROM archive.error_logs_v1_mvp;

    SELECT COUNT(*) INTO new_users_count            FROM users;
    SELECT COUNT(*) INTO new_docs_count             FROM documents;
    SELECT COUNT(*) INTO new_receipts_count         FROM receipts;
    SELECT COUNT(*) INTO new_invoices_count         FROM invoices;
    SELECT COUNT(*) INTO new_tx_count               FROM transactions;
    SELECT COUNT(*) INTO actual_line_items          FROM line_items;
    SELECT COUNT(*) INTO new_errs_count             FROM error_logs;
    SELECT COUNT(*) INTO new_stores_count           FROM stores;
    SELECT COUNT(*) INTO new_payment_methods_count  FROM payment_methods;

    -- expected line_items = (one per JSONB element) + (one placeholder per row without JSONB)
    SELECT
        COALESCE(SUM(
            CASE
                WHEN t.line_items IS NULL
                  OR jsonb_typeof(t.line_items) != 'array'
                  OR jsonb_array_length(t.line_items) = 0
                THEN 1
                ELSE jsonb_array_length(t.line_items)
            END
        ), 0)
    INTO expected_line_items
    FROM archive.transactions_v1_mvp t;

    -- Hard assertions -- any mismatch raises and rolls back the txn.
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
    IF (new_receipts_count + new_invoices_count) != old_tx_count THEN
        RAISE EXCEPTION 'Subtype routing mismatch: receipts(%) + invoices(%) != transactions(%)',
                        new_receipts_count, new_invoices_count, old_tx_count;
    END IF;

    RAISE NOTICE '--- M2 data migration verification ---';
    RAISE NOTICE 'users           : %', new_users_count;
    RAISE NOTICE 'documents       : %', new_docs_count;
    RAISE NOTICE 'receipts        : %', new_receipts_count;
    RAISE NOTICE 'invoices        : %', new_invoices_count;
    RAISE NOTICE 'transactions    : %', new_tx_count;
    RAISE NOTICE 'line_items      : % (expected %)', actual_line_items, expected_line_items;
    RAISE NOTICE 'stores          : %', new_stores_count;
    RAISE NOTICE 'payment_methods : %', new_payment_methods_count;
    RAISE NOTICE 'error_logs      : %', new_errs_count;
    RAISE NOTICE '--- all hard assertions passed ---';
END $$;

COMMIT;
