-- ============================================================================
-- Staging MVP seed — synthetic test data for M2 staging verification (B1 path)
-- ============================================================================
--
-- Runs AFTER the MVP schema is in place. Apply order on staging:
--   PRE-STEP A: schema.sql                                         (5 base tables)
--   PRE-STEP B: 20260222100000_add_ai_summary_to_documents.sql     (documents.ai_summary)
--   PRE-STEP C: 20260223100000_add_city_country_to_transactions.sql
--   PRE-STEP D: 20260404100000_extend_transactions_extraction_fields.sql
--   PRE-STEP E: THIS FILE                                          (synthetic data)
--   THEN:      11 M2 migration files in timestamp order            (file 00 -> 11)
--
-- ============================================================================
-- WHY SYNTHETIC (B1) NOT PROD-SNAPSHOT (B2)
-- ============================================================================
-- Per Decision in docs/migrations/m2_phase6_preflight.md (locked 2026-04-27):
--   Synthetic data lets us deliberately construct the edge cases we need.
--   Production has uneven edge case coverage. No PII risk. Fast to reset.
--
-- ============================================================================
-- WHAT THIS SEED REPRODUCES (Phase 1 patterns at smaller scale)
-- ============================================================================
--   10 users    (vs 87 in production)
--   15 documents (vs 147)
--   13 ocr_results (2 docs without OCR — Phase 1 had 2)
--   12 transactions (3 documents are orphans — Phase 1 had 33 orphans)
--    5 error_logs (vs 34)
--
-- Edge case coverage:
--   * 3 orphan documents (no transaction)            -> tests Decision 9 'failed' status
--   * 2 transactions with NULL merchant              -> tests "no store created" branch
--   * 5 transactions with non-empty line_items JSONB -> tests Phase 4.7a expansion (15 elements total)
--   * 7 transactions with NULL/empty line_items      -> tests Phase 4.7b placeholder branch
--   * 1 invoice + 5 explicit 'receipt' + 6 NULL doc_type -> tests subtype routing (Phase 4.3 / 4.3b)
--   * Mixed currencies (EUR, GBP, USD)                -> tests currency normalization
--   * Mixed payment_methods incl. NULL, 'debit_card', 'credit_card', 'cash', 'mobile_payment',
--     'bank_transfer'                                 -> tests Decision 1 enum mapping
--                                                       and Decision 10 NULLS NOT DISTINCT
--   * Same brand, different location ("Carrefour" vs "Carrefour Market Mariakerke")
--                                                    -> tests open question 3 (merchant location dedup)
--
-- ============================================================================
-- IDEMPOTENCY
-- ============================================================================
-- TRUNCATE wipes everything before insert so this script is safe to re-run.
-- All UUIDs are deterministic (entity-prefixed) so they're easy to spot in
-- queries and predictable across runs.
--
-- UUID convention used here:
--   11111111-... = users         (last segment is sequence number 1..10)
--   22222222-... = documents     (1..15)
--   33333333-... = transactions  (1..12, sequence matches document number)
--   44444444-... = ocr_results   (sequence matches document number)
--   55555555-... = error_logs    (1..5)
--
-- NOTE on the rogue NocoDB junction table found in production
-- (_nc_m2m_documents_ocr_results, Decision 8): NOT recreated on staging.
-- File 00's `DROP TABLE IF EXISTS` makes the absence harmless — IF EXISTS
-- means a non-existent table is a no-op.
--
-- ============================================================================

BEGIN;

TRUNCATE TABLE error_logs, transactions, ocr_results, documents, anonymous_users
    RESTART IDENTITY CASCADE;

-- ----------------------------------------------------------------------------
-- 10 users
-- ----------------------------------------------------------------------------
INSERT INTO anonymous_users (id, session_id, device_id, created_at, last_active_at) VALUES
  ('11111111-1111-1111-a111-000000000001', 'session-u1-abc',  'device-u1-iphone15',     '2026-01-15T09:00:00Z', '2026-04-25T15:30:00Z'),
  ('11111111-1111-1111-a111-000000000002', 'session-u2-def',  'device-u2-iphone14',     '2026-02-01T10:30:00Z', '2026-04-26T09:15:00Z'),
  ('11111111-1111-1111-a111-000000000003', 'session-u3-ghi',  NULL,                     '2026-02-10T14:20:00Z', '2026-04-20T11:45:00Z'),
  ('11111111-1111-1111-a111-000000000004', NULL,              'device-u4-iphone15',     '2026-02-15T08:00:00Z', '2026-04-22T16:20:00Z'),
  ('11111111-1111-1111-a111-000000000005', 'session-u5-jkl',  'device-u5-iphonese',     '2026-03-01T12:00:00Z', '2026-04-25T13:00:00Z'),
  ('11111111-1111-1111-a111-000000000006', 'session-u6-mno',  'device-u6-iphone16',     '2026-03-05T16:45:00Z', '2026-04-26T10:30:00Z'),
  ('11111111-1111-1111-a111-000000000007', 'session-u7-pqr',  'device-u7-iphone15pro',  '2026-03-10T09:30:00Z', '2026-04-26T14:00:00Z'),
  ('11111111-1111-1111-a111-000000000008', 'session-u8-stu',  'device-u8-ipadair',      '2026-03-15T11:15:00Z', '2026-04-25T18:45:00Z'),
  ('11111111-1111-1111-a111-000000000009', NULL,              NULL,                     '2026-03-20T13:00:00Z', '2026-04-23T09:00:00Z'),
  ('11111111-1111-1111-a111-000000000010', 'session-u10-vwx', 'device-u10-iphone14pro', '2026-03-25T15:30:00Z', '2026-04-26T11:30:00Z');

-- ----------------------------------------------------------------------------
-- 15 documents (3 will be orphans: doc 5, 7, 13)
-- ----------------------------------------------------------------------------
INSERT INTO documents (id, user_id, file_path, file_url, mime_type, file_size, ai_summary, created_at, updated_at) VALUES
  ('22222222-2222-2222-a222-000000000001', '11111111-1111-1111-a111-000000000001', 'u1/doc1.jpg', 'https://staging.example/storage/u1/doc1.jpg', 'image/jpeg',     102400, 'Grocery receipt from Aldi', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z'),
  ('22222222-2222-2222-a222-000000000002', '11111111-1111-1111-a111-000000000001', 'u1/doc2.pdf', 'https://staging.example/storage/u1/doc2.pdf', 'application/pdf', 254100, 'Carrefour weekly shop, 3 items',         '2026-04-05T11:30:00Z', '2026-04-05T11:30:00Z'),
  ('22222222-2222-2222-a222-000000000003', '11111111-1111-1111-a111-000000000002', 'u2/doc3.jpg', 'https://staging.example/storage/u2/doc3.jpg', 'image/jpeg',      88300, NULL,                                     '2026-04-08T09:15:00Z', '2026-04-08T09:15:00Z'),
  ('22222222-2222-2222-a222-000000000004', '11111111-1111-1111-a111-000000000002', 'u2/doc4.png', 'https://staging.example/storage/u2/doc4.png', 'image/png',      125700, 'Tesco UK store, 2 items',                '2026-04-10T14:45:00Z', '2026-04-10T14:45:00Z'),
  ('22222222-2222-2222-a222-000000000005', '11111111-1111-1111-a111-000000000003', 'u3/doc5.jpg', 'https://staging.example/storage/u3/doc5.jpg', 'image/jpeg',      94200, 'Document uploaded but extraction failed -- partial receipt photo', '2026-04-11T08:00:00Z', '2026-04-11T08:00:00Z'),  -- ORPHAN: no transaction
  ('22222222-2222-2222-a222-000000000006', '11111111-1111-1111-a111-000000000004', 'u4/doc6.jpg', 'https://staging.example/storage/u4/doc6.jpg', 'image/jpeg',     113800, 'Albert Heijn (NL chain in BE)',         '2026-04-12T16:20:00Z', '2026-04-12T16:20:00Z'),
  ('22222222-2222-2222-a222-000000000007', '11111111-1111-1111-a111-000000000004', 'u4/doc7.pdf', 'https://staging.example/storage/u4/doc7.pdf', 'application/pdf', 198400, NULL,                                     '2026-04-13T07:50:00Z', '2026-04-13T07:50:00Z'),  -- ORPHAN: no transaction; ALSO no OCR
  ('22222222-2222-2222-a222-000000000008', '11111111-1111-1111-a111-000000000005', 'u5/doc8.jpg', 'https://staging.example/storage/u5/doc8.jpg', 'image/jpeg',     142200, 'Carrefour Market Mariakerke (specific location)', '2026-04-15T17:00:00Z', '2026-04-15T17:00:00Z'),
  ('22222222-2222-2222-a222-000000000009', '11111111-1111-1111-a111-000000000006', 'u6/doc9.jpg', 'https://staging.example/storage/u6/doc9.jpg', 'image/jpeg',      67500, 'McDonalds quick lunch',                  '2026-04-18T12:30:00Z', '2026-04-18T12:30:00Z'),
  ('22222222-2222-2222-a222-000000000010', '11111111-1111-1111-a111-000000000006', 'u6/doc10.pdf','https://staging.example/storage/u6/doc10.pdf','application/pdf', 311200, 'Acme Consulting invoice (Q2 retainer)',  '2026-04-20T10:00:00Z', '2026-04-20T10:00:00Z'),
  ('22222222-2222-2222-a222-000000000011', '11111111-1111-1111-a111-000000000007', 'u7/doc11.jpg','https://staging.example/storage/u7/doc11.jpg','image/jpeg',      78900, 'Lidl quick stop',                        '2026-04-22T18:15:00Z', '2026-04-22T18:15:00Z'),  -- NO OCR result (matches Phase 1 "2 docs without OCR")
  ('22222222-2222-2222-a222-000000000012', '11111111-1111-1111-a111-000000000008', 'u8/doc12.jpg','https://staging.example/storage/u8/doc12.jpg','image/jpeg',     105400, NULL,                                     '2026-03-25T14:00:00Z', '2026-03-25T14:00:00Z'),
  ('22222222-2222-2222-a222-000000000013', '11111111-1111-1111-a111-000000000009', 'u9/doc13.jpg','https://staging.example/storage/u9/doc13.jpg','image/jpeg',      54300, 'Receipt was too blurry to extract',      '2026-04-23T09:30:00Z', '2026-04-23T09:30:00Z'),  -- ORPHAN: no transaction
  ('22222222-2222-2222-a222-000000000014', '11111111-1111-1111-a111-000000000010', 'u10/doc14.pdf','https://staging.example/storage/u10/doc14.pdf','application/pdf', 287100, 'Delhaize big weekly shop, 5 items',     '2026-04-24T15:45:00Z', '2026-04-24T15:45:00Z'),
  ('22222222-2222-2222-a222-000000000015', '11111111-1111-1111-a111-000000000010', 'u10/doc15.jpg','https://staging.example/storage/u10/doc15.jpg','image/jpeg',     91600, 'Bol.com online order confirmation',      '2026-04-25T19:20:00Z', '2026-04-25T19:20:00Z');

-- ----------------------------------------------------------------------------
-- 13 ocr_results (every document EXCEPT doc7 and doc11)
--   - doc7 is also an orphan (no transaction)
--   - doc11 has a transaction but no OCR row (the "with-tx-but-no-OCR" pattern)
-- ----------------------------------------------------------------------------
INSERT INTO ocr_results (id, document_id, raw_text, ocr_version) VALUES
  ('44444444-4444-4444-a444-000000000001', '22222222-2222-2222-a222-000000000001', 'ALDI BRUSSELS  Brood 2.50  Kaas 5.00  TOTAL 23.50 EUR', '1.0'),
  ('44444444-4444-4444-a444-000000000002', '22222222-2222-2222-a222-000000000002', 'CARREFOUR GENT  Bread x2 3.00  Cheese 12.40  Wine x6 72.00  TOTAL 87.40 EUR', '1.0'),
  ('44444444-4444-4444-a444-000000000003', '22222222-2222-2222-a222-000000000003', '[unreadable] TOTAL 12.00 EUR', '1.0'),
  ('44444444-4444-4444-a444-000000000004', '22222222-2222-2222-a222-000000000004', 'TESCO LONDON  Pasta x4 5.20  Salmon 40.00  TOTAL 45.20 GBP', '1.0'),
  ('44444444-4444-4444-a444-000000000005', '22222222-2222-2222-a222-000000000005', 'partial photo, only header readable', '1.0'),
  ('44444444-4444-4444-a444-000000000006', '22222222-2222-2222-a222-000000000006', 'ALBERT HEIJN ANTWERPEN  TOTAL 65.30 EUR', '1.0'),
  ('44444444-4444-4444-a444-000000000008', '22222222-2222-2222-a222-000000000008', 'CARREFOUR MARKET MARIAKERKE  Beef 50.00  Wine x5 75.50  Cheese 32.99  Bread 15.38  TOTAL 173.87 EUR', '1.0'),
  ('44444444-4444-4444-a444-000000000009', '22222222-2222-2222-a222-000000000009', 'McDONALDS BRUSSELS  Big Mac Menu  TOTAL 8.95 EUR', '1.0'),
  ('44444444-4444-4444-a444-000000000010', '22222222-2222-2222-a222-000000000010', 'ACME CONSULTING LLC  INVOICE 2026-Q2-001  Retainer Q2 2026  TOTAL 1500.00 USD', '1.0'),
  ('44444444-4444-4444-a444-000000000012', '22222222-2222-2222-a222-000000000012', 'unknown merchant TOTAL 14.50 EUR', '1.0'),
  ('44444444-4444-4444-a444-000000000013', '22222222-2222-2222-a222-000000000013', 'too blurry', '1.0'),
  ('44444444-4444-4444-a444-000000000014', '22222222-2222-2222-a222-000000000014', 'DELHAIZE GENT  Items x5  TOTAL 124.95 EUR', '1.0'),
  ('44444444-4444-4444-a444-000000000015', '22222222-2222-2222-a222-000000000015', 'BOL.COM Online Order  TOTAL 89.99 EUR', '1.0');

-- ----------------------------------------------------------------------------
-- 12 transactions (one per non-orphan document; docs 5, 7, 13 have no tx)
--
-- document_type breakdown:
--    5 explicit 'receipt' (doc 1, 3, 8, 9, 15)
--    1 'invoice'          (doc 10)
--    6 NULL               (doc 2, 4, 6, 11, 12, 14)
-- merchant breakdown:
--   10 with merchant
--    2 NULL merchant (doc 3, 12)  -- tests "no store" branch
-- payment_method breakdown:
--    debit_card  : doc 1, 4, 8, 14   (4)
--    credit_card : doc 2, 11         (2) -- collapses with debit_card -> 'card' under same user
--    cash        : doc 3, 9          (2)
--    mobile_pay  : doc 6             (1)
--    bank_xfer   : doc 10            (1)
--    NULL        : doc 12, 15        (2)  -- excluded from payment_methods INSERT
-- line_items breakdown:
--    5 with non-empty array : doc 2 (3 items), doc 4 (2), doc 8 (4), doc 11 (1), doc 14 (5) = 15 elements
--    7 NULL                 : doc 1, 3, 6, 9, 10, 12, 15
-- ----------------------------------------------------------------------------
INSERT INTO transactions (
    id, document_id, amount, currency, merchant, category, description, transaction_date, city, country,
    document_type, address, net_amount, tax_amount, discount_amount, paid_amount, payment_method, payment_status,
    line_items, parser_version, prompt_version, created_at, updated_at
) VALUES
  -- doc1: Aldi Brussels, simple receipt, no line_items
  ('33333333-3333-3333-a333-000000000001', '22222222-2222-2222-a222-000000000001',
    23.50, 'EUR', 'Aldi', 'Groceries', 'Quick grocery run', '2026-04-01', 'Brussels', 'Belgium',
    'receipt', 'Rue de la Loi 100, 1000 Brussels', 19.50, 4.00, 0.00, NULL, 'debit_card', 'completed',
    NULL, '3.0.0', '3.0.0', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z'),
  -- doc2: Carrefour Gent, with line_items (3 items)
  ('33333333-3333-3333-a333-000000000002', '22222222-2222-2222-a222-000000000002',
    87.40, 'EUR', 'Carrefour', 'Groceries', 'Weekly shop', '2026-04-05', 'Gent', 'Belgium',
    NULL, 'Korenlei 5, 9000 Gent', 72.20, 15.20, 0.00, NULL, 'credit_card', 'completed',
    '[{"product_name": "Bread", "quantity": 2, "unit_price": 1.50, "total_price": 3.00}, {"product_name": "Cheese 500g", "quantity": 1, "unit_price": 12.40, "total_price": 12.40}, {"product_name": "Wine bottle", "quantity": 6, "unit_price": 12.00, "total_price": 72.00}]'::jsonb,
    '3.0.0', '3.0.0', '2026-04-05T11:30:00Z', '2026-04-05T11:30:00Z'),
  -- doc3: NULL merchant (edge case 1), no line_items, cash
  ('33333333-3333-3333-a333-000000000003', '22222222-2222-2222-a222-000000000003',
    12.00, 'EUR', NULL, NULL, 'Receipt with merchant unreadable', '2026-04-08', NULL, NULL,
    'receipt', NULL, NULL, NULL, 0.00, NULL, 'cash', 'completed',
    NULL, '3.0.0', '3.0.0', '2026-04-08T09:15:00Z', '2026-04-08T09:15:00Z'),
  -- doc4: Tesco London (GBP currency), line_items (2 items), debit_card
  ('33333333-3333-3333-a333-000000000004', '22222222-2222-2222-a222-000000000004',
    45.20, 'GBP', 'Tesco', 'Groceries', 'UK store visit', '2026-04-10', 'London', 'UK',
    NULL, '12 Oxford Street, London', 37.67, 7.53, 0.00, NULL, 'debit_card', 'completed',
    '[{"product_name": "Pasta", "quantity": 4, "unit_price": 1.30, "total_price": 5.20}, {"product_name": "Fresh salmon", "quantity": 1, "unit_price": 40.00, "total_price": 40.00}]'::jsonb,
    '3.0.0', '3.0.0', '2026-04-10T14:45:00Z', '2026-04-10T14:45:00Z'),
  -- doc6: Albert Heijn Antwerp, no line_items, mobile_payment
  ('33333333-3333-3333-a333-000000000006', '22222222-2222-2222-a222-000000000006',
    65.30, 'EUR', 'Albert Heijn', 'Groceries', NULL, '2026-04-12', 'Antwerp', 'Belgium',
    NULL, 'Meir 50, 2000 Antwerpen', 54.42, 10.88, 0.00, NULL, 'mobile_payment', 'completed',
    NULL, '3.0.0', '3.0.0', '2026-04-12T16:20:00Z', '2026-04-12T16:20:00Z'),
  -- doc8: Carrefour Market Mariakerke (different location from Carrefour above), line_items (4)
  ('33333333-3333-3333-a333-000000000008', '22222222-2222-2222-a222-000000000008',
    173.87, 'EUR', 'Carrefour Market Mariakerke', 'Groceries', 'Big shop with discounts', '2026-04-15', 'Mariakerke', 'Belgium',
    'receipt', 'Brugsesteenweg 200, 9030 Mariakerke', 144.89, 28.98, 5.00, NULL, 'debit_card', 'completed',
    '[{"product_name": "Premium beef 1kg", "quantity": 1, "unit_price": 50.00, "total_price": 50.00}, {"product_name": "Wine bottle", "quantity": 5, "unit_price": 15.10, "total_price": 75.50}, {"product_name": "Cheese assortment", "quantity": 1, "unit_price": 32.99, "total_price": 32.99}, {"product_name": "Bread basket", "quantity": 2, "unit_price": 7.69, "total_price": 15.38}]'::jsonb,
    '3.0.0', '3.0.0', '2026-04-15T17:00:00Z', '2026-04-15T17:00:00Z'),
  -- doc9: McDonalds Brussels, no line_items, cash
  ('33333333-3333-3333-a333-000000000009', '22222222-2222-2222-a222-000000000009',
    8.95, 'EUR', 'McDonalds', 'Restaurant', 'Quick lunch', '2026-04-18', 'Brussels', 'Belgium',
    'receipt', 'Avenue Louise 200, 1050 Brussels', 7.40, 1.55, 0.00, NULL, 'cash', 'completed',
    NULL, '3.0.0', '3.0.0', '2026-04-18T12:30:00Z', '2026-04-18T12:30:00Z'),
  -- doc10: Acme Consulting INVOICE (USD), no line_items, bank_transfer (the 1 invoice case)
  ('33333333-3333-3333-a333-000000000010', '22222222-2222-2222-a222-000000000010',
    1500.00, 'USD', 'Acme Consulting', 'Consulting', 'Q2 retainer invoice', '2026-04-20', 'New York', 'USA',
    'invoice', '350 5th Ave, New York, NY 10118', 1500.00, 0.00, 0.00, 0.00, 'bank_transfer', 'not_paid',
    NULL, '3.0.0', '3.0.0', '2026-04-20T10:00:00Z', '2026-04-20T10:00:00Z'),
  -- doc11: Lidl Brussels, line_items (1), credit_card. THIS DOC HAS NO ocr_results row.
  ('33333333-3333-3333-a333-000000000011', '22222222-2222-2222-a222-000000000011',
    32.10, 'EUR', 'Lidl', 'Groceries', 'Quick stop', '2026-04-22', 'Brussels', 'Belgium',
    NULL, 'Boulevard Anspach 100, 1000 Brussels', 26.78, 5.32, 0.00, NULL, 'credit_card', 'completed',
    '[{"product_name": "Mixed snacks pack", "quantity": 1, "unit_price": 32.10, "total_price": 32.10}]'::jsonb,
    '3.0.0', '3.0.0', '2026-04-22T18:15:00Z', '2026-04-22T18:15:00Z'),
  -- doc12: NULL merchant (edge case 2), NULL payment_method, no line_items
  ('33333333-3333-3333-a333-000000000012', '22222222-2222-2222-a222-000000000012',
    14.50, 'EUR', NULL, NULL, 'Receipt with no recognizable merchant', '2026-03-25', NULL, NULL,
    NULL, NULL, NULL, NULL, 0.00, NULL, NULL, NULL,
    NULL, '3.0.0', '3.0.0', '2026-03-25T14:00:00Z', '2026-03-25T14:00:00Z'),
  -- doc14: Delhaize Gent, line_items (5 items, biggest receipt)
  ('33333333-3333-3333-a333-000000000014', '22222222-2222-2222-a222-000000000014',
    124.95, 'EUR', 'Delhaize', 'Groceries', 'Family weekly shop', '2026-04-24', 'Gent', 'Belgium',
    NULL, 'Vrijdagmarkt 10, 9000 Gent', 104.13, 20.82, 2.50, NULL, 'debit_card', 'completed',
    '[{"product_name": "Milk 1L", "quantity": 4, "unit_price": 1.20, "total_price": 4.80}, {"product_name": "Eggs 12-pack", "quantity": 2, "unit_price": 3.50, "total_price": 7.00}, {"product_name": "Chicken thighs 1kg", "quantity": 2, "unit_price": 8.99, "total_price": 17.98}, {"product_name": "Pasta sauce", "quantity": 3, "unit_price": 2.85, "total_price": 8.55}, {"product_name": "Olive oil 1L", "quantity": 1, "unit_price": 12.99, "total_price": 12.99}]'::jsonb,
    '3.0.0', '3.0.0', '2026-04-24T15:45:00Z', '2026-04-24T15:45:00Z'),
  -- doc15: Bol.com online order, no line_items, NULL payment_method
  ('33333333-3333-3333-a333-000000000015', '22222222-2222-2222-a222-000000000015',
    89.99, 'EUR', 'Bol.com', 'Online Shopping', 'Order confirmation email', '2026-04-25', NULL, NULL,
    'receipt', NULL, 74.37, 15.62, 0.00, 89.99, NULL, 'completed',
    NULL, '3.0.0', '3.0.0', '2026-04-25T19:20:00Z', '2026-04-25T19:20:00Z');

-- ----------------------------------------------------------------------------
-- 5 error_logs
--    - 1 STORAGE_UPLOAD_ERROR (no document_id)
--    - 1 EXTRACTION_FAILED for orphan doc7
--    - 1 TRANSACTION_CREATE_ERROR for doc12
--    - 1 OCR_SAVE_ERROR for doc11 (the with-tx-but-no-OCR doc)
--    - 1 DOCUMENT_CREATE_ERROR with NULL document_id and NULL user_id
-- ----------------------------------------------------------------------------
INSERT INTO error_logs (id, document_id, user_id, error_type, error_message, stack_trace, context, created_at) VALUES
  ('55555555-5555-5555-a555-000000000001', NULL, '11111111-1111-1111-a111-000000000001',
    'STORAGE_UPLOAD_ERROR', 'Bucket not found',
    'StorageError: Bucket not found\n  at upload (line 339)', '{"filePath": "u1/orphan.jpg"}'::jsonb,
    '2026-04-02T10:30:00Z'),
  ('55555555-5555-5555-a555-000000000002', '22222222-2222-2222-a222-000000000007', '11111111-1111-1111-a111-000000000004',
    'EXTRACTION_FAILED', 'OpenAI returned no data for this document',
    NULL, NULL,
    '2026-04-13T07:55:00Z'),
  ('55555555-5555-5555-a555-000000000003', '22222222-2222-2222-a222-000000000012', '11111111-1111-1111-a111-000000000008',
    'TRANSACTION_CREATE_ERROR', 'numeric field overflow on amount',
    'PgError 22003\n  at insert.transactions (line 423)', '{"amount": "99999999999.99"}'::jsonb,
    '2026-03-25T14:05:00Z'),
  ('55555555-5555-5555-a555-000000000004', '22222222-2222-2222-a222-000000000011', '11111111-1111-1111-a111-000000000007',
    'OCR_SAVE_ERROR', 'connection timeout to ocr_results',
    NULL, '{"rawTextLength": 1240}'::jsonb,
    '2026-04-22T18:18:00Z'),
  ('55555555-5555-5555-a555-000000000005', NULL, NULL,
    'DOCUMENT_CREATE_ERROR', 'invalid user_id format',
    NULL, NULL,
    '2026-04-19T08:00:00Z');

-- ----------------------------------------------------------------------------
-- Verification (raises on count mismatch -> rolls back txn)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_users               INT;
    v_docs                INT;
    v_ocr                 INT;
    v_tx                  INT;
    v_errs                INT;
    v_orphan_docs         INT;
    v_null_merchant_tx    INT;
    v_tx_with_jsonb       INT;
    v_tx_without_jsonb    INT;
    v_total_jsonb_items   INT;
    v_distinct_merchants  INT;
    v_doc_types           TEXT;
BEGIN
    SELECT COUNT(*) INTO v_users FROM anonymous_users;
    SELECT COUNT(*) INTO v_docs  FROM documents;
    SELECT COUNT(*) INTO v_ocr   FROM ocr_results;
    SELECT COUNT(*) INTO v_tx    FROM transactions;
    SELECT COUNT(*) INTO v_errs  FROM error_logs;

    SELECT COUNT(*) INTO v_orphan_docs
    FROM documents d
    LEFT JOIN transactions t ON t.document_id = d.id
    WHERE t.id IS NULL;

    SELECT COUNT(*) INTO v_null_merchant_tx FROM transactions WHERE merchant IS NULL;

    SELECT COUNT(*) INTO v_tx_with_jsonb
    FROM transactions
    WHERE line_items IS NOT NULL
      AND jsonb_typeof(line_items) = 'array'
      AND jsonb_array_length(line_items) > 0;

    SELECT COUNT(*) INTO v_tx_without_jsonb
    FROM transactions
    WHERE line_items IS NULL
       OR jsonb_typeof(line_items) != 'array'
       OR jsonb_array_length(line_items) = 0;

    SELECT COALESCE(SUM(jsonb_array_length(line_items)), 0) INTO v_total_jsonb_items
    FROM transactions
    WHERE line_items IS NOT NULL AND jsonb_typeof(line_items) = 'array';

    SELECT COUNT(DISTINCT lower(trim(merchant))) INTO v_distinct_merchants
    FROM transactions
    WHERE merchant IS NOT NULL AND length(trim(merchant)) > 0;

    SELECT string_agg(t || ':' || c::text, ', ' ORDER BY t)
      INTO v_doc_types
      FROM (
        SELECT COALESCE(NULLIF(document_type, ''), '<NULL>') AS t, COUNT(*) AS c
        FROM transactions GROUP BY 1
      ) sub;

    -- Hard assertions: any mismatch raises and rolls back the txn.
    IF v_users != 10 THEN RAISE EXCEPTION 'Expected 10 users, got %', v_users; END IF;
    IF v_docs  != 15 THEN RAISE EXCEPTION 'Expected 15 documents, got %', v_docs; END IF;
    IF v_ocr   != 13 THEN RAISE EXCEPTION 'Expected 13 ocr_results, got %', v_ocr; END IF;
    IF v_tx    != 12 THEN RAISE EXCEPTION 'Expected 12 transactions, got %', v_tx; END IF;
    IF v_errs  != 5  THEN RAISE EXCEPTION 'Expected 5 error_logs, got %', v_errs; END IF;
    IF v_orphan_docs        != 3  THEN RAISE EXCEPTION 'Expected 3 orphan documents, got %', v_orphan_docs; END IF;
    IF v_null_merchant_tx   != 2  THEN RAISE EXCEPTION 'Expected 2 NULL-merchant transactions, got %', v_null_merchant_tx; END IF;
    IF v_tx_with_jsonb      != 5  THEN RAISE EXCEPTION 'Expected 5 transactions with line_items JSONB, got %', v_tx_with_jsonb; END IF;
    IF v_tx_without_jsonb   != 7  THEN RAISE EXCEPTION 'Expected 7 transactions without line_items JSONB, got %', v_tx_without_jsonb; END IF;
    IF v_total_jsonb_items  != 15 THEN RAISE EXCEPTION 'Expected 15 total JSONB line item elements, got %', v_total_jsonb_items; END IF;
    IF v_distinct_merchants != 10 THEN RAISE EXCEPTION 'Expected 10 distinct merchants, got %', v_distinct_merchants; END IF;

    RAISE NOTICE '--- Staging seed verification ---';
    RAISE NOTICE 'users:               %', v_users;
    RAISE NOTICE 'documents:           %', v_docs;
    RAISE NOTICE 'ocr_results:         %', v_ocr;
    RAISE NOTICE 'transactions:        %', v_tx;
    RAISE NOTICE 'error_logs:          %', v_errs;
    RAISE NOTICE 'orphan documents:    %', v_orphan_docs;
    RAISE NOTICE 'NULL-merchant txns:  %', v_null_merchant_tx;
    RAISE NOTICE 'tx with JSONB items: %  (totalling % elements)', v_tx_with_jsonb, v_total_jsonb_items;
    RAISE NOTICE 'tx without JSONB:    %', v_tx_without_jsonb;
    RAISE NOTICE 'distinct merchants:  %', v_distinct_merchants;
    RAISE NOTICE 'document_type breakdown: %', v_doc_types;
    RAISE NOTICE '--- post-M2 expected counts (for reference, asserted by file 10''s 4.9 DO block) ---';
    RAISE NOTICE 'users (new):     10';
    RAISE NOTICE 'documents (new): 15';
    RAISE NOTICE 'transactions (new): 12';
    RAISE NOTICE 'receipts:        11  (5 explicit + 6 NULL defaulted)';
    RAISE NOTICE 'invoices:        1';
    RAISE NOTICE 'line_items:      22  (15 expanded from JSONB + 7 placeholders)';
    RAISE NOTICE 'stores:          10  (distinct lowercased non-NULL merchants)';
    RAISE NOTICE 'payment_methods: <= 9 (mapping may collapse debit_card+credit_card to ''card'' per user)';
    RAISE NOTICE 'error_logs:      5';
END $$;

COMMIT;
