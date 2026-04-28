-- M2 Phase 2 — File 01 of 10: Group 1 Geography
-- See docs/specs/m2_schema.md (Phase 2, Group 1).
--
-- Creates the 4-level GeoNames-aligned geography hierarchy:
--   continents -> countries -> states_provinces -> cities
--
-- Within-file order matters: each table FKs to the previous one.
--
-- NOT in this file (intentional):
--   - GeoNames seed data: separate post-M2 task. Tables exist empty.
--   - updated_at triggers: defined in file 08 (m2_08_indexes_and_triggers.sql)
--     together with the trigger_set_updated_at() function. Splitting them out
--     avoids forward-references to a function that does not yet exist when
--     this file runs.
--   - Indexes: also in file 08.

-- continents -- top of the hierarchy (7 rows after seeding: AF, AN, AS, EU, NA, OC, SA)
CREATE TABLE continents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,                   -- 2-letter continent code (e.g. 'EU', 'AS', 'NA')
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- countries -- ISO 3166-1 nations
-- iso_code is UNIQUE so a future GeoNames seed can upsert by iso_code, and so
-- duplicate seed rows fail loudly instead of silently doubling the catalogue.
CREATE TABLE countries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    continent_id    UUID NOT NULL REFERENCES continents(id),
    iso_code        TEXT NOT NULL UNIQUE,               -- ISO 3166-1 alpha-2 (e.g. 'BE', 'BD', 'US')
    name            TEXT NOT NULL,
    currency_code   TEXT,                               -- ISO 4217 (e.g. 'EUR', 'BDT', 'USD'); nullable for territories without their own currency
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- states_provinces -- ISO 3166-2 subdivisions; not all countries populate this
-- (tiny states / city-states), so we don't enforce per-country uniqueness on
-- (country_id, code) until we know the seed data tolerates it.
CREATE TABLE states_provinces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_id  UUID NOT NULL REFERENCES countries(id),
    code        TEXT,                                   -- e.g. 'BRU' for Brussels region; nullable
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- cities -- the leaf the rest of the schema points at via stores.city_id, persons.city_id
-- geonames_id is UNIQUE-but-nullable: lets us upsert during seed by GeoNames ID
-- and prevents duplicate seed rows, while still allowing manual entries for
-- cities not in GeoNames (which is rare but happens for new municipalities).
-- lat/lon NUMERIC(9,6) gives ~10 cm precision -- well past any analytical need.
CREATE TABLE cities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_province_id   UUID NOT NULL REFERENCES states_provinces(id),
    geonames_id         BIGINT UNIQUE,                  -- GeoNames numeric ID; nullable for non-GeoNames entries
    name                TEXT NOT NULL,
    latitude            NUMERIC(9, 6),                  -- 9 total digits, 6 after the decimal
    longitude           NUMERIC(9, 6),
    timezone            TEXT,                           -- IANA TZ name (e.g. 'Europe/Brussels')
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);
