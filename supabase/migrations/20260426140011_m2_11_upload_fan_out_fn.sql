-- M2 Phase 2 — File 11 of 11: upload_extraction_fan_out() function
-- Added in Phase 5 (edge function migration) to give upload/ atomic
-- fan-out semantics. Postgres functions are implicitly transactional;
-- a failure anywhere inside the body rolls back every INSERT/UPDATE
-- the function performed.
--
-- REUSABILITY: This function is invoked today by the upload edge
-- function only. M3 will introduce a re-extraction worker for the
-- 33 orphan documents (extraction_status='failed') -- that worker
-- should call this same function with the same inputs. The function
-- is intentionally idempotent-friendly: re-running it on a document
-- with existing receipts/transactions/line_items will fail on
-- subtype UNIQUE(document_id) conflict, signaling that a cleanup
-- step (DELETE FROM existing rows) is needed before re-extraction.
-- That cleanup is M3 territory.
--
-- Inputs come from the GPT-4o JSON output (ExtractedReceipt). Every
-- field that's nullable in GPT's output is nullable here too.
--
-- Returns a 1-row table with two booleans the edge function uses to
-- assemble the iOS response payload (transaction_created, ai_summary_generated).

CREATE OR REPLACE FUNCTION public.upload_extraction_fan_out(
    p_document_id      UUID,
    p_user_id          UUID,
    p_full_text        TEXT,
    p_ai_summary       TEXT,
    p_document_type    TEXT,
    p_amount           NUMERIC,
    p_net_amount       NUMERIC,
    p_tax_amount       NUMERIC,
    p_discount_amount  NUMERIC,
    p_paid_amount      NUMERIC,
    p_currency         TEXT,
    p_merchant         TEXT,
    p_address          TEXT,
    p_city             TEXT,
    p_country          TEXT,
    p_category         TEXT,
    p_description      TEXT,
    p_transaction_date DATE,
    p_payment_method   TEXT,
    p_payment_status   TEXT,
    p_line_items       JSONB
)
RETURNS TABLE (
    transaction_created BOOLEAN,
    ai_summary_stored   BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_doc_type_corrected TEXT;
    v_pm_corrected       TEXT;
    v_store_id           UUID;
    v_payment_method_id  UUID;
    v_tx_created         BOOLEAN := FALSE;
    v_ai_stored          BOOLEAN := FALSE;
BEGIN
    -- Normalize document_type for routing. Unknown values default to 'other'
    -- so the CHECK constraint passes; raw extractor value stays in _ocr.
    v_doc_type_corrected := CASE
        WHEN p_document_type IS NULL OR length(trim(p_document_type)) = 0 THEN 'other'
        WHEN p_document_type IN ('receipt', 'invoice', 'payslip', 'bank_statement', 'cc_statement', 'other') THEN p_document_type
        ELSE 'other'
    END;

    -- 1) Update documents with extraction results.
    UPDATE documents SET
        full_text_ocr           = p_full_text,
        ai_summary_ocr          = p_ai_summary,
        document_type_ocr       = p_document_type,
        document_type_corrected = v_doc_type_corrected,
        extraction_status       = 'completed'
    WHERE id = p_document_id;

    v_ai_stored := (p_ai_summary IS NOT NULL AND length(p_ai_summary) > 0);

    -- 2) Resolve store: lookup-or-insert (skip if no merchant).
    --    city_id stays NULL until GeoNames seeded; lookup keys on
    --    (lower(name_ocr), city_id IS NULL) so all unseeded stores collapse
    --    onto one row per merchant name.
    --
    --    TODO post-GeoNames-seed: change lookup to
    --    "lower(name_ocr) = lower(p_merchant) AND city_id IS NOT DISTINCT
    --     FROM v_resolved_city_id" -- and add a backfill migration to
    --    populate city_id on existing rows. Without that backfill, two
    --    Carrefour stores in different cities will still collapse.
    IF p_merchant IS NOT NULL AND length(trim(p_merchant)) > 0 THEN
        SELECT id INTO v_store_id
        FROM stores
        WHERE lower(name_ocr) = lower(p_merchant)
          AND city_id IS NULL
        LIMIT 1;

        IF v_store_id IS NULL THEN
            INSERT INTO stores (name_ocr, address_ocr, city_name_ocr, country_name_ocr)
            VALUES (p_merchant, p_address, p_city, p_country)
            RETURNING id INTO v_store_id;
        END IF;
    END IF;

    -- 3) Resolve payment_method: lookup-or-insert via ON CONFLICT.
    --    Mapping matches the data migration (file 10, step 4.5a) and
    --    Decision 1's Phase 5.2 mapping table.
    IF p_payment_method IS NOT NULL THEN
        v_pm_corrected := CASE p_payment_method
            WHEN 'cash'           THEN 'cash'
            WHEN 'debit_card'     THEN 'card'
            WHEN 'credit_card'    THEN 'card'
            WHEN 'mobile_payment' THEN 'mobile'
            WHEN 'bank_transfer'  THEN 'bank_transfer'
            WHEN 'not_paid'       THEN 'other'
            WHEN 'other'          THEN 'other'
            ELSE NULL
        END;

        INSERT INTO payment_methods (user_id, payment_type_ocr, payment_type_corrected)
        VALUES (p_user_id, p_payment_method, v_pm_corrected)
        ON CONFLICT (user_id, payment_type_corrected, card_last4) DO NOTHING
        RETURNING id INTO v_payment_method_id;

        -- ON CONFLICT DO NOTHING returns no row on collision; SELECT existing.
        -- The constraint is UNIQUE NULLS NOT DISTINCT (Decision 10) so NULLs
        -- on payment_type_corrected / card_last4 collapse correctly.
        IF v_payment_method_id IS NULL THEN
            SELECT id INTO v_payment_method_id
            FROM payment_methods
            WHERE user_id = p_user_id
              AND payment_type_corrected IS NOT DISTINCT FROM v_pm_corrected
              AND card_last4 IS NULL
            LIMIT 1;
        END IF;
    END IF;

    -- 4) Subtype + 5) Transaction + 6) Line items: only when amount is present.
    --    Without amount, GPT-4o failed to extract a financial event; documents
    --    row stays with extraction_status='completed' (text was captured) but
    --    no money flow is recorded.
    IF p_amount IS NOT NULL THEN

        -- 4a) Subtype routing.
        IF v_doc_type_corrected = 'receipt' THEN
            INSERT INTO receipts (
                document_id, store_id, payment_method_id,
                total_amount_ocr, net_amount_ocr, tax_amount_ocr,
                discount_amount_ocr, paid_amount_ocr,
                currency_ocr, purchase_date_ocr,
                payment_status_ocr, category_ocr, description_ocr
            ) VALUES (
                p_document_id, v_store_id, v_payment_method_id,
                p_amount, p_net_amount, p_tax_amount,
                p_discount_amount, p_paid_amount,
                p_currency, p_transaction_date,
                p_payment_status, p_category, p_description
            );
        ELSIF v_doc_type_corrected = 'invoice' THEN
            INSERT INTO invoices (
                document_id, payment_method_id,
                total_amount_ocr, net_amount_ocr, tax_amount_ocr,
                discount_amount_ocr, paid_amount_ocr,
                currency_ocr,
                payment_status_ocr, category_ocr, description_ocr
            ) VALUES (
                p_document_id, v_payment_method_id,
                p_amount, p_net_amount, p_tax_amount,
                p_discount_amount, p_paid_amount,
                p_currency,
                p_payment_status, p_category, p_description
            );
        END IF;
        -- payslips / bank_statements / cc_statements / other: no subtype row
        -- (GPT-4o doesn't extract those subtype-specific fields yet -- M3+).

        -- 5) Transaction. Always created when amount is present.
        --    direction='debit' (user paid); receiver_store_id resolved above.
        INSERT INTO transactions (
            document_id, direction,
            amount_ocr, currency_ocr, transaction_date_ocr,
            payer_user_id, payment_method_id, receiver_store_id
        ) VALUES (
            p_document_id, 'debit',
            p_amount, p_currency, p_transaction_date,
            p_user_id, v_payment_method_id, v_store_id
        );

        -- 6) Line items: one row per element in the JSONB array.
        --    is_mvp_legacy_placeholder = FALSE (these are real extracted data).
        IF p_line_items IS NOT NULL
           AND jsonb_typeof(p_line_items) = 'array'
           AND jsonb_array_length(p_line_items) > 0 THEN
            INSERT INTO line_items (
                document_id, name_ocr, quantity_ocr, unit_price_ocr, total_price_ocr,
                currency_ocr, is_mvp_legacy_placeholder
            )
            SELECT
                p_document_id,
                li.product_name,
                li.quantity,
                li.unit_price,
                li.total_price,
                p_currency,
                FALSE
            FROM jsonb_to_recordset(p_line_items) AS li(
                product_name TEXT, quantity NUMERIC, unit_price NUMERIC, total_price NUMERIC
            );
        END IF;

        v_tx_created := TRUE;
    END IF;

    RETURN QUERY SELECT v_tx_created, v_ai_stored;
END;
$$;
