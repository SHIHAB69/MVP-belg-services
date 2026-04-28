-- M2 Phase 2 — File 05 of 10: Group 5 Tracked Assets
-- See docs/specs/m2_schema.md (Phase 2, Group 5).
--
-- 3 tables:
--   tracked_objects             (cars, properties, appliances; ties optionally
--                                to a purchase transaction + its document)
--   tracked_services            (named buckets like "Streaming subscriptions"
--                                that group N recurring_transactions together)
--   tracked_services_recurring  (M:M junction)
--
-- External deps from earlier files:
--   users (file 02), transactions (file 03), documents (file 03),
--   recurring_transactions (file 03)
--
-- NOT in this file: indexes + triggers (file 08).

-- tracked_objects -- physical assets the user wants to follow over time.
-- Both purchase_transaction_id and purchase_document_id are nullable: the user
-- might add an asset they bought before they were tracking expenses, or one
-- inherited / received as a gift, or one whose receipt was lost.
-- asset_type is free text (no CHECK) so we don't have to enumerate
-- "car / property / appliance / electronics / jewelry / artwork / etc." up
-- front; if an enum becomes useful we can ALTER it in later.
-- purchase_amount is NUMERIC(12, 2) (not 10 like other monetary cols) because
-- tracked objects can be expensive (cars, real estate); spec made this
-- distinction intentionally.
CREATE TABLE tracked_objects (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purchase_transaction_id  UUID REFERENCES transactions(id),         -- nullable; asset may pre-date tracking
    purchase_document_id     UUID REFERENCES documents(id),            -- nullable; receipt may be lost / never existed
    asset_type               TEXT,                                     -- free text e.g. 'car', 'property', 'appliance'
    name                     TEXT NOT NULL,
    description              TEXT,
    purchase_date            DATE,
    purchase_amount          NUMERIC(12, 2),                           -- 12 digits to fit cars / real estate
    currency                 TEXT,
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- tracked_services -- named bundles of recurring_transactions
-- ("Streaming subscriptions", "Cloud storage", "Insurance"). The bundle has
-- a name + description; the actual money flows live in recurring_transactions
-- linked via the junction below.
CREATE TABLE tracked_services (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- tracked_services_recurring -- M:M junction binding tracked_services to
-- recurring_transactions. ON DELETE CASCADE on both sides: removing the
-- bundle drops its bindings (the recurring_transactions stay), and removing
-- a recurring_transaction also drops its membership in any bundle. Neither
-- direction wants to leave orphan junction rows.
CREATE TABLE tracked_services_recurring (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tracked_service_id        UUID NOT NULL REFERENCES tracked_services(id) ON DELETE CASCADE,
    recurring_transaction_id  UUID NOT NULL REFERENCES recurring_transactions(id) ON DELETE CASCADE,
    UNIQUE (tracked_service_id, recurring_transaction_id)
);
