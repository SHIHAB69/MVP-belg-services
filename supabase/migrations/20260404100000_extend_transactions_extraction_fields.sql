-- Extend transactions table with full extraction fields
-- New columns support document type, itemised amounts, line items, and payment details.
-- All existing columns (amount, currency, merchant, category, description, transaction_date, city, country)
-- are preserved unchanged. The existing `amount` column now semantically represents total_amount.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS document_type TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS net_amount NUMERIC(10, 2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10, 2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10, 2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(10, 2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_status TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS line_items JSONB;
