-- M2 Phase 2 — File 08 of 10: Indexes & Triggers
-- See docs/specs/m2_schema.md (Phase 2, Indexes & Triggers).
--
-- Purely additive: no ALTER TABLE, no schema changes. Three sections:
--   1. trigger_set_updated_at() function (defined once, referenced by every
--      BEFORE UPDATE trigger below).
--   2. set_updated_at triggers on every table that has an updated_at column.
--   3. Indexes on FK columns and common-query composites.
--
-- Tables intentionally skipped by the trigger section (no updated_at):
--   - product_attributes (file 04, deliberate omission documented)
--   - error_logs        (file 07, deliberate omission documented)
--   - All M:M junctions: group_members, products_services_attributes,
--     tracked_services_recurring, event_links, taggables
--     (junction tables only have created_at)
--
-- Tables intentionally skipped by the index section (the constraint already
-- creates a usable index):
--   - UNIQUE columns: continents.code, countries.iso_code, cities.geonames_id,
--     users.auth_user_id, product_segments/families/classes/commodities.unspsc_code
--   - UNIQUE composite leftmost prefixes: payment_methods.user_id (covered by
--     UNIQUE NULLS NOT DISTINCT (user_id, ...)), tags.user_id (covered by
--     UNIQUE (user_id, name)), taggables.tag_id (covered by UNIQUE (tag_id, ...)),
--     event_links.event_id (covered by UNIQUE (event_id, ...)), receipts/
--     invoices/payslips/bank_statements/cc_statements.document_id (each is a
--     UNIQUE column on its own)
--
-- All indexes use IF NOT EXISTS so the file is safe to re-run.

-- ============================================================================
-- 1. updated_at trigger function
-- ============================================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 2. Triggers (30 tables with updated_at)
-- ============================================================================

-- File 01 (geography) — 4 tables
CREATE TRIGGER set_updated_at BEFORE UPDATE ON continents        FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON countries         FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON states_provinces  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON cities            FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- File 02 (entities) — 6 tables (skipped: group_members)
CREATE TRIGGER set_updated_at BEFORE UPDATE ON users      FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON companies  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON brands     FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON stores     FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON persons    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON groups     FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- File 03 (documents) — 9 tables (no skips; transactions has updated_at)
CREATE TRIGGER set_updated_at BEFORE UPDATE ON documents               FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON payment_methods         FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON receipts                FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON invoices                FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON payslips                FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON bank_statements         FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON cc_statements           FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON recurring_transactions  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON transactions            FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- File 04 (products) — 6 tables (skipped: product_attributes, products_services_attributes)
CREATE TRIGGER set_updated_at BEFORE UPDATE ON product_segments     FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON product_families     FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON product_classes      FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON product_commodities  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON products_services    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON line_items           FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- File 05 (tracked_assets) — 2 tables (skipped: tracked_services_recurring)
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tracked_objects   FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tracked_services  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- File 06 (context) — 3 tables (skipped: event_links, taggables)
CREATE TRIGGER set_updated_at BEFORE UPDATE ON events   FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON budgets  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tags     FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- File 07 (error_logs) — 0 tables (no updated_at; deliberate per file 07 comment)


-- ============================================================================
-- 3. Indexes
-- ============================================================================

-- ----------------------------------------------------------------------------
-- File 01 (geography)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_countries_continent_id    ON countries(continent_id);
CREATE INDEX IF NOT EXISTS idx_states_provinces_country  ON states_provinces(country_id);
CREATE INDEX IF NOT EXISTS idx_cities_state_province     ON cities(state_province_id);

-- ----------------------------------------------------------------------------
-- File 02 (entities)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_companies_country_id        ON companies(country_id);
CREATE INDEX IF NOT EXISTS idx_brands_company_id           ON brands(company_id);
CREATE INDEX IF NOT EXISTS idx_stores_city_id              ON stores(city_id);
CREATE INDEX IF NOT EXISTS idx_stores_brand_id             ON stores(brand_id);
CREATE INDEX IF NOT EXISTS idx_persons_city_id             ON persons(city_id);
CREATE INDEX IF NOT EXISTS idx_groups_created_by_user      ON groups(created_by_user_id);
-- group_members: UNIQUE (group_id, member_id, member_type) covers leftmost
-- group_id queries already; we add a polymorphic-lookup index for the reverse
-- direction "find all groups containing this user/person/company".
CREATE INDEX IF NOT EXISTS idx_group_members_polymorphic   ON group_members(member_type, member_id);

-- ----------------------------------------------------------------------------
-- File 03 (documents) — the busiest table set
-- ----------------------------------------------------------------------------
-- documents: composite (user_id, created_at DESC) covers both "list user's
-- recent docs" AND user_id-only lookups (leftmost prefix). Standalone user_id
-- index would be redundant.
CREATE INDEX IF NOT EXISTS idx_documents_user_created      ON documents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_type_corrected    ON documents(document_type_corrected);
CREATE INDEX IF NOT EXISTS idx_documents_status            ON documents(extraction_status);
-- file_hash: full B-tree; supports "do I already have this file?" dedup
-- queries. Most rows will be NULL until the dedup pipeline ships, but a full
-- index handles both NULL exclusion and direct equality lookups.
CREATE INDEX IF NOT EXISTS idx_documents_file_hash         ON documents(file_hash);

-- subtype tables: document_id is UNIQUE (auto-indexed). Index only the other FKs.
CREATE INDEX IF NOT EXISTS idx_receipts_store_id              ON receipts(store_id);
CREATE INDEX IF NOT EXISTS idx_receipts_payment_method_id     ON receipts(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_invoices_vendor_company_id     ON invoices(vendor_company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_method_id     ON invoices(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_payslips_employer_company_id   ON payslips(employer_company_id);
-- bank_statements / cc_statements: only document_id, already UNIQUE-indexed.

-- payment_methods: UNIQUE NULLS NOT DISTINCT (user_id, payment_type_corrected,
-- card_last4) covers user_id (leftmost) — no separate index needed.

CREATE INDEX IF NOT EXISTS idx_recurring_transactions_user_id            ON recurring_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_recurring_transactions_payment_method_id  ON recurring_transactions(payment_method_id);

-- transactions: 14 indexed columns (1 self-FK + 6 other FKs + 7 party FKs +
-- transaction_date_corrected for time-sorted listings).
CREATE INDEX IF NOT EXISTS idx_transactions_document_id              ON transactions(document_id);
CREATE INDEX IF NOT EXISTS idx_transactions_counterpart              ON transactions(counterpart_transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_payment_method_id        ON transactions(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_transactions_recurring_id             ON transactions(recurring_transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date_corrected           ON transactions(transaction_date_corrected DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_payer_user_id            ON transactions(payer_user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_payer_person_id          ON transactions(payer_person_id);
CREATE INDEX IF NOT EXISTS idx_transactions_payer_company_id         ON transactions(payer_company_id);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver_user_id         ON transactions(receiver_user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver_person_id       ON transactions(receiver_person_id);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver_company_id      ON transactions(receiver_company_id);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver_store_id        ON transactions(receiver_store_id);

-- ----------------------------------------------------------------------------
-- File 04 (products)
-- ----------------------------------------------------------------------------
-- UNSPSC hierarchy FKs (each unspsc_code is already UNIQUE-indexed).
CREATE INDEX IF NOT EXISTS idx_product_families_segment_id     ON product_families(segment_id);
CREATE INDEX IF NOT EXISTS idx_product_classes_family_id       ON product_classes(family_id);
CREATE INDEX IF NOT EXISTS idx_product_commodities_class_id    ON product_commodities(class_id);

CREATE INDEX IF NOT EXISTS idx_products_services_commodity_id  ON products_services(commodity_id);
CREATE INDEX IF NOT EXISTS idx_products_services_brand_id      ON products_services(brand_id);

-- products_services_attributes: UNIQUE (product_service_id, attribute_id)
-- covers product_service_id leftmost; we add the reverse-direction index
-- "find all products with this attribute".
CREATE INDEX IF NOT EXISTS idx_products_services_attributes_attribute  ON products_services_attributes(attribute_id);

CREATE INDEX IF NOT EXISTS idx_line_items_document_id          ON line_items(document_id);
CREATE INDEX IF NOT EXISTS idx_line_items_product_service_id   ON line_items(product_service_id);

-- ----------------------------------------------------------------------------
-- File 05 (tracked_assets)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tracked_objects_user_id                  ON tracked_objects(user_id);
CREATE INDEX IF NOT EXISTS idx_tracked_objects_purchase_transaction_id  ON tracked_objects(purchase_transaction_id);
CREATE INDEX IF NOT EXISTS idx_tracked_objects_purchase_document_id     ON tracked_objects(purchase_document_id);
CREATE INDEX IF NOT EXISTS idx_tracked_services_user_id                 ON tracked_services(user_id);

-- tracked_services_recurring: UNIQUE (tracked_service_id, recurring_transaction_id)
-- covers leftmost tracked_service_id; add reverse-direction index for
-- "which bundles include this recurring_transaction".
CREATE INDEX IF NOT EXISTS idx_tracked_services_recurring_recurring  ON tracked_services_recurring(recurring_transaction_id);

-- ----------------------------------------------------------------------------
-- File 06 (context)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_events_user_id     ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_group_id    ON events(group_id);
CREATE INDEX IF NOT EXISTS idx_events_start_date  ON events(start_date);

-- event_links: UNIQUE (event_id, linked_id, linked_type) covers leftmost
-- event_id; add polymorphic-lookup index for the reverse direction
-- "find all events linked to this transaction/document".
CREATE INDEX IF NOT EXISTS idx_event_links_polymorphic  ON event_links(linked_type, linked_id);

CREATE INDEX IF NOT EXISTS idx_budgets_user_id       ON budgets(user_id);
CREATE INDEX IF NOT EXISTS idx_budgets_group_id      ON budgets(group_id);
CREATE INDEX IF NOT EXISTS idx_budgets_commodity_id  ON budgets(commodity_id);
CREATE INDEX IF NOT EXISTS idx_budgets_event_id      ON budgets(event_id);

-- tags.user_id is covered by UNIQUE (user_id, name).

-- taggables: UNIQUE (tag_id, taggable_id, taggable_type) covers leftmost
-- tag_id; add polymorphic-lookup index for reverse direction "find all
-- tags attached to this object".
CREATE INDEX IF NOT EXISTS idx_taggables_polymorphic  ON taggables(taggable_type, taggable_id);

-- ----------------------------------------------------------------------------
-- File 07 (error_logs)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_error_logs_document_id  ON error_logs(document_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_user_id      ON error_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at   ON error_logs(created_at DESC);
