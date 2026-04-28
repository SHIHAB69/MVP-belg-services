-- M2 Phase 2 — File 04 of 10: Group 4 Products & Services
-- See docs/specs/m2_schema.md (Phase 2, Group 4).
--
-- 8 tables. Within-file dependency order:
--   product_segments -> product_families -> product_classes -> product_commodities
--   product_attributes (no in-group deps)
--   products_services (FK product_commodities, brands [file 02])
--   products_services_attributes (FK products_services, product_attributes)
--   line_items (FK documents [file 03], products_services)
--
-- The first four tables form the UNSPSC 4-level catalogue (Segment > Family
-- > Class > Commodity). Seed data is NOT loaded here -- separate post-M2 task.
-- Tables exist empty; products_services.commodity_id stays NULL until seeded.
--
-- NOT in this file: indexes + triggers (file 08); UNSPSC seed data; the
-- data migration backfill (file 10) which expands legacy line_items JSONB
-- into real line_items rows.

-- product_segments -- top of the UNSPSC hierarchy.
-- unspsc_code is UNIQUE so seeding can upsert by code and duplicate seed rows
-- fail loudly. Same pattern repeats on each level below.
CREATE TABLE product_segments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unspsc_code  TEXT NOT NULL UNIQUE,                       -- UNSPSC 2-digit segment (e.g. '50' = Food, Beverage and Tobacco)
    name         TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- product_families -- 4-digit UNSPSC families (segment + 2 more digits).
CREATE TABLE product_families (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id   UUID NOT NULL REFERENCES product_segments(id),
    unspsc_code  TEXT NOT NULL UNIQUE,                       -- 4-digit family code
    name         TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- product_classes -- 6-digit UNSPSC classes (family + 2 more digits).
CREATE TABLE product_classes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id    UUID NOT NULL REFERENCES product_families(id),
    unspsc_code  TEXT NOT NULL UNIQUE,                       -- 6-digit class code
    name         TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- product_commodities -- 8-digit UNSPSC commodities (class + 2 more digits).
-- The leaf of the UNSPSC catalogue; products_services.commodity_id points here.
CREATE TABLE product_commodities (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id     UUID NOT NULL REFERENCES product_classes(id),
    unspsc_code  TEXT NOT NULL UNIQUE,                       -- 8-digit commodity code
    name         TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- product_attributes -- key/value bag for product properties (size, colour,
-- weight, etc.). UNIQUE (name, value) means each distinct attribute value
-- exists once globally, then gets attached to many products via the junction.
-- This intentionally NOT versioned per product -- if "500g" applies to flour
-- and to coffee, both reference the same product_attributes row.
--
-- updated_at deliberately omitted: (name, value) is the natural key and never
-- changes. A "modified" attribute is a different attribute (a new row). The
-- per-table set_updated_at trigger in file 08 must SKIP this table.
CREATE TABLE product_attributes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,                               -- attribute name e.g. 'size', 'colour', 'weight'
    value       TEXT NOT NULL,                               -- attribute value e.g. '500g', 'red', '1L'
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (name, value)                                     -- each attribute value exists once globally
);

-- products_services -- the canonical product/service catalogue (deduplicated
-- across all uploads). Line items eventually link to one of these via
-- line_items.product_service_id once M3's product-resolution logic ships.
-- Both name and description follow the OCR pair convention so M3 can train
-- on operator/user corrections.
-- commodity_id nullable until UNSPSC is seeded; brand_id nullable for
-- non-branded items (commodities, generics).
CREATE TABLE products_services (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commodity_id             UUID REFERENCES product_commodities(id),    -- nullable until UNSPSC seeded
    brand_id                 UUID REFERENCES brands(id),                 -- nullable for non-branded items
    name_ocr                 TEXT,
    name_corrected           TEXT,
    description_ocr          TEXT,
    description_corrected    TEXT,
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- products_services_attributes -- M:M junction between products_services and
-- product_attributes. UNIQUE (product_service_id, attribute_id) prevents the
-- same attribute being attached twice to the same product.
-- ON DELETE CASCADE on product_service_id: if a product is removed, drop its
-- attribute links. attribute rows themselves persist (they're shared).
CREATE TABLE products_services_attributes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_service_id  UUID NOT NULL REFERENCES products_services(id) ON DELETE CASCADE,
    attribute_id        UUID NOT NULL REFERENCES product_attributes(id),
    UNIQUE (product_service_id, attribute_id)
);

-- line_items -- the bridge between Documents <-> Products <-> Transactions.
-- One row per item on a receipt/invoice (one row per element of the GPT-4o
-- line_items JSON array per Phase 5.2 mapping).
--
-- product_service_id nullable: real extracted line items don't link to a
-- products_services row until M3's resolution logic runs. Until then they're
-- standalone rows with name_ocr populated from the extractor.
--
-- is_mvp_legacy_placeholder distinguishes:
--   - real extracted line items (FALSE): from GPT-4o JSON line_items array,
--     either at upload time or from the legacy transactions.line_items JSONB
--     during the Phase 4.7a expansion
--   - placeholder rows (TRUE): created by Phase 4.7b for legacy transactions
--     that have no JSONB line_items array -- one synthetic row per transaction
--     so the document still has at least one line item visible. M3 can
--     re-extract from documents.full_text_ocr and replace these.
--
-- Quantities are NUMERIC(10,3) (3 decimals) to support fractional units like
-- "0.250 kg" or "1.5 L". Prices are NUMERIC(10,2) consistent with all other
-- monetary columns in the schema.
CREATE TABLE line_items (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id                     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    product_service_id              UUID REFERENCES products_services(id),     -- nullable until M3 product-resolution
    name_ocr                        TEXT,
    name_corrected                  TEXT,
    quantity_ocr                    NUMERIC(10, 3),                            -- 3 decimals for fractional units
    quantity_corrected              NUMERIC(10, 3),
    unit_price_ocr                  NUMERIC(10, 2),
    unit_price_corrected            NUMERIC(10, 2),
    total_price_ocr                 NUMERIC(10, 2),
    total_price_corrected           NUMERIC(10, 2),
    currency_ocr                    TEXT,
    currency_corrected              TEXT,
    is_mvp_legacy_placeholder       BOOLEAN DEFAULT FALSE,                     -- TRUE for synthetic rows from Phase 4.7b
    created_at                      TIMESTAMPTZ DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ DEFAULT NOW()
);
