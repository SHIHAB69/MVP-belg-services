-- M2 Phase 2 — File 03 of 10: Group 3 Documents & Transactions
-- See docs/specs/m2_schema.md (Phase 2, Group 3).
--
-- 9 tables. Within-file dependency order (NOT the spec text's listing order;
-- the spec lists payment_methods after receipts/invoices, but receipts and
-- invoices both FK to payment_methods, so payment_methods must come first):
--
--   documents -> payment_methods -> receipts
--                                -> invoices
--             -> payslips
--             -> bank_statements
--             -> cc_statements
--             -> recurring_transactions (FKs payment_methods)
--             -> transactions (FKs documents, payment_methods, recurring_transactions,
--                              and self via counterpart_transaction_id)
--
-- External deps from earlier files: users, companies, persons, stores (file 02).
--
-- NOT in this file: indexes + triggers (file 08); GPT-4o JSON fan-out logic
-- in upload (Phase 5.2); the data migration backfill (file 10).

-- documents -- the parent of all uploaded files.
-- document_type uses the OCR pair convention: _ocr keeps the raw extractor
-- string (no CHECK so unknown values still land), _corrected is the validated
-- routing value the app reads to pick a subtype. App reads corrected else ocr.
-- full_text_ocr / ai_summary_ocr replace the standalone ocr_results table for
-- new uploads (Phase 5.2 mapping). ocr_text_legacy holds the raw_text from
-- archive.ocr_results_v1_mvp for migrated rows only.
-- file_hash is the SHA-256 of the file bytes; reserved for dedup detection in
-- a future milestone (per CLAUDE.md target state). Nullable until that runs.
-- extraction_status drives M3 re-extraction: rows marked 'failed' are the
-- 33 orphan documents Phase 1 found (per Decision 9 in the Revision Log).
CREATE TABLE documents (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type_ocr        TEXT,                                          -- raw extractor output, no CHECK
    document_type_corrected  TEXT CHECK (document_type_corrected IN (
        'receipt', 'invoice', 'payslip', 'bank_statement', 'cc_statement', 'other'
    )),
    file_path                TEXT NOT NULL,
    file_url                 TEXT,
    mime_type                TEXT,
    file_size                BIGINT,
    file_hash                TEXT,                                          -- SHA-256 hex; nullable until dedup ships
    issue_date_ocr           DATE,
    issue_date_corrected     DATE,
    issuer_name_ocr          TEXT,
    issuer_name_corrected    TEXT,
    full_text_ocr            TEXT,                                          -- new uploads: GPT-4o "full_text" JSON field
    full_text_corrected      TEXT,
    ai_summary_ocr           TEXT,                                          -- new uploads: GPT-4o "ai_summary" JSON field
    ai_summary_corrected     TEXT,
    ocr_text_legacy          TEXT,                                          -- migrated rows only; from archive.ocr_results_v1_mvp.raw_text
    extraction_status        TEXT DEFAULT 'pending' CHECK (extraction_status IN (
        'pending', 'processing', 'completed', 'failed'
    )),
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- payment_methods -- one row per (user, payment_type, card_last4) triple.
-- Created before receipts/invoices so they can FK to it.
-- payment_type follows the OCR pair convention: _ocr stores the raw extractor
-- string ("debit_card", "credit_card", "mobile_payment", "not_paid"); _corrected
-- is the validated CHECK enum value. The mapping (debit_card -> 'card', etc.)
-- is implemented in app code (Phase 5.2 mapping table) and in the data
-- migration (file 10, Phase 4.5).
--
-- The UNIQUE NULLS NOT DISTINCT (user_id, payment_type_corrected, card_last4)
-- backs the upload function's ON CONFLICT DO NOTHING dedup. The NULLS NOT
-- DISTINCT clause is deliberate (Decision 10 in spec Revision Log): standard
-- Postgres treats NULLs as distinct in UNIQUE constraints, so without it two
-- rows with payment_type_corrected = NULL and card_last4 = NULL would not
-- collide -- silently breaking dedup whenever the extractor returns a null
-- payment_method (which the GPT-4o prompt explicitly allows). Postgres 15+
-- supports this clause; we are on 17.
CREATE TABLE payment_methods (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payment_type_ocr         TEXT,                                          -- raw extractor string
    payment_type_corrected   TEXT CHECK (payment_type_corrected IN (
        'card', 'mobile', 'biometric', 'cash', 'bank_transfer', 'other'
    )),
    card_last4               TEXT,
    label                    TEXT,                                          -- user-given name e.g. "My Visa"
    device                   TEXT,                                          -- e.g. 'iPhone', 'Apple Watch', 'Physical Card'
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE NULLS NOT DISTINCT (user_id, payment_type_corrected, card_last4) -- dedup backing for upload's ON CONFLICT (Decision 10)
);

-- receipts -- subtype of documents. UNIQUE on document_id makes this a strict
-- one-to-one with the parent (no document can have two receipts).
-- Carries the rich monetary breakdown the GPT-4o extractor produces. Every
-- extractor-populated field has its OCR pair so M3 can train on the delta.
-- payment_method_id is a denormalised convenience: the same FK exists on
-- transactions, but receipts is the subtype iOS detail screens read first.
CREATE TABLE receipts (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id                 UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    store_id                    UUID REFERENCES stores(id),
    payment_method_id           UUID REFERENCES payment_methods(id),
    total_amount_ocr            NUMERIC(10, 2),
    total_amount_corrected      NUMERIC(10, 2),
    net_amount_ocr              NUMERIC(10, 2),
    net_amount_corrected        NUMERIC(10, 2),
    tax_amount_ocr              NUMERIC(10, 2),
    tax_amount_corrected        NUMERIC(10, 2),
    discount_amount_ocr         NUMERIC(10, 2),
    discount_amount_corrected   NUMERIC(10, 2),
    paid_amount_ocr             NUMERIC(10, 2),
    paid_amount_corrected       NUMERIC(10, 2),
    currency_ocr                TEXT,
    currency_corrected          TEXT,
    purchase_date_ocr           DATE,                                       -- DROP-of-time per open question #7
    purchase_date_corrected     DATE,
    payment_status_ocr          TEXT,                                       -- "completed" | "not_paid" | "other" from extractor
    payment_status_corrected    TEXT,
    category_ocr                TEXT,                                       -- free text (e.g. "Groceries"); UNSPSC linkage deferred to M3+
    category_corrected          TEXT,
    description_ocr             TEXT,
    description_corrected       TEXT,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- invoices -- subtype of documents. Same monetary breakdown as receipts.
-- The extractor produces the same JSON regardless of document_type; routing
-- (which subtype gets the row) is controlled by document_type_corrected.
-- vendor_company_id NULL on insert during migration (legacy data is not
-- deduplicated into companies), filled via NocoDB or future cleanup.
CREATE TABLE invoices (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id                 UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    vendor_company_id           UUID REFERENCES companies(id),
    payment_method_id           UUID REFERENCES payment_methods(id),
    invoice_number_ocr          TEXT,
    invoice_number_corrected    TEXT,
    due_date_ocr                DATE,
    due_date_corrected          DATE,
    total_amount_ocr            NUMERIC(10, 2),
    total_amount_corrected      NUMERIC(10, 2),
    net_amount_ocr              NUMERIC(10, 2),
    net_amount_corrected        NUMERIC(10, 2),
    tax_amount_ocr              NUMERIC(10, 2),
    tax_amount_corrected        NUMERIC(10, 2),
    discount_amount_ocr         NUMERIC(10, 2),
    discount_amount_corrected   NUMERIC(10, 2),
    paid_amount_ocr             NUMERIC(10, 2),
    paid_amount_corrected       NUMERIC(10, 2),
    currency_ocr                TEXT,
    currency_corrected          TEXT,
    payment_status_ocr          TEXT,
    payment_status_corrected    TEXT,
    category_ocr                TEXT,
    category_corrected          TEXT,
    description_ocr             TEXT,
    description_corrected       TEXT,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- payslips -- subtype of documents. Distinct field set: gross/net amounts and
-- a pay period instead of a transaction date. employer_company_id resolves to
-- companies (extracted by M3+ workflows; nullable here).
CREATE TABLE payslips (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id                 UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    employer_company_id         UUID REFERENCES companies(id),
    pay_period_start_ocr        DATE,
    pay_period_start_corrected  DATE,
    pay_period_end_ocr          DATE,
    pay_period_end_corrected    DATE,
    gross_amount_ocr            NUMERIC(10, 2),
    gross_amount_corrected      NUMERIC(10, 2),
    net_amount_ocr              NUMERIC(10, 2),
    net_amount_corrected        NUMERIC(10, 2),
    currency_ocr                TEXT,
    currency_corrected          TEXT,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- bank_statements -- subtype of documents. Holds account / period header info.
-- Individual statement lines come in as transactions rows linked via
-- transactions.document_id (one statement -> many transactions, each with
-- direction = 'debit' or 'credit').
CREATE TABLE bank_statements (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id                 UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    account_number_ocr          TEXT,
    account_number_corrected    TEXT,
    bank_name_ocr               TEXT,
    bank_name_corrected         TEXT,
    period_start_ocr            DATE,
    period_start_corrected      DATE,
    period_end_ocr              DATE,
    period_end_corrected        DATE,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- cc_statements -- subtype of documents. Same fan-out pattern as bank_statements:
-- statement lines live in transactions, this row carries header info.
-- card_number_last4 is the displayable masked tail; never store the full PAN.
CREATE TABLE cc_statements (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id                     UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    card_number_last4_ocr           TEXT,
    card_number_last4_corrected     TEXT,
    issuer_name_ocr                 TEXT,
    issuer_name_corrected           TEXT,
    period_start_ocr                DATE,
    period_start_corrected          DATE,
    period_end_ocr                  DATE,
    period_end_corrected            DATE,
    created_at                      TIMESTAMPTZ DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ DEFAULT NOW()
);

-- recurring_transactions -- subscription/standing-order templates the user (or
-- M3 detection) groups multiple transactions under. label is the human name
-- ("Netflix subscription"); the actual money movements are transactions rows
-- referencing recurring_transaction_id.
-- end_date nullable -- ongoing subscriptions have no end.
CREATE TABLE recurring_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payment_method_id   UUID REFERENCES payment_methods(id),
    label               TEXT,                                              -- e.g. "Netflix subscription"
    amount              NUMERIC(10, 2),                                    -- typical amount; not OCR-paired (user-curated)
    currency            TEXT,
    frequency           TEXT CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
    start_date          DATE,
    end_date            DATE,                                              -- nullable for open-ended subscriptions
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- transactions -- the financial-flow hub. One row per money movement.
-- A receipt produces 1 (debit). A bank/CC statement produces N. A peer-to-peer
-- transfer produces 2 (a debit on the payer side and a credit on the receiver
-- side), linked via counterpart_transaction_id pointing both ways.
--
-- direction is enforced via CHECK; party identification is intentionally NOT
-- enforced beyond the FKs. The spec convention is "nullable, only one side
-- per row" -- e.g. for direction='debit' we expect payer_user_id (the user
-- who paid) plus a receiver_*_id (where the money went). For migrated MVP
-- data we set payer_user_id and receiver_store_id via Phase 4 backfill.
--
-- counterpart_transaction_id is a self-FK enabling double-entry pairing.
-- Self-FKs on a fresh CREATE TABLE are valid in Postgres (the constraint is
-- evaluated against the same table being created).
--
-- amount_ocr / currency_ocr / transaction_date_ocr capture extractor output;
-- _corrected stays NULL until a human edits it (per OCR convention). Phase 4
-- migration writes legacy values to *_ocr (not *_corrected) -- preserves the
-- training-signal delta for M3 (per Convention Correctness Fix in Revision Log).
--
-- parser_version_legacy / prompt_version_legacy carry the values from the
-- old transactions table; new uploads do NOT populate them (M3 introduces a
-- proper prompt-versioning table that supersedes these strings).
--
-- The id column keeps DEFAULT gen_random_uuid() for new rows, but the Phase 4
-- migration explicitly inserts the legacy transactions.id values to preserve
-- any external references (none today, but defensive).
CREATE TABLE transactions (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id                 UUID REFERENCES documents(id) ON DELETE CASCADE,  -- CASCADE per Decision 13 (matches MVP; prevents orphans across all delete paths)
    counterpart_transaction_id  UUID REFERENCES transactions(id),          -- payer<->receiver double-entry pairing
    payment_method_id           UUID REFERENCES payment_methods(id),
    recurring_transaction_id    UUID REFERENCES recurring_transactions(id),
    direction                   TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount_ocr                  NUMERIC(10, 2),
    amount_corrected            NUMERIC(10, 2),
    currency_ocr                TEXT,
    currency_corrected          TEXT,
    transaction_date_ocr        DATE,                                       -- DROP-of-time per open question #7
    transaction_date_corrected  DATE,
    -- party identification: nullable, populate one side per row
    payer_user_id               UUID REFERENCES users(id),
    payer_person_id             UUID REFERENCES persons(id),
    payer_company_id            UUID REFERENCES companies(id),
    receiver_user_id            UUID REFERENCES users(id),
    receiver_person_id          UUID REFERENCES persons(id),
    receiver_company_id         UUID REFERENCES companies(id),
    receiver_store_id           UUID REFERENCES stores(id),
    -- carried over from archive.transactions_v1_mvp; not populated for new uploads
    parser_version_legacy       TEXT,
    prompt_version_legacy       TEXT,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);
