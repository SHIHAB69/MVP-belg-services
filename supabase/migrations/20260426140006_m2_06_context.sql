-- M2 Phase 2 — File 06 of 10: Group 6 Context
-- See docs/specs/m2_schema.md (Phase 2, Group 6).
--
-- 5 tables:
--   events       (holidays, weddings, projects; owned by a user OR a group)
--   event_links  (polymorphic: link an event to transactions OR documents)
--   budgets      (spending caps; owned by a user OR a group)
--   tags         (per-user labels)
--   taggables    (polymorphic: attach a tag to many object types)
--
-- External deps from earlier files:
--   users (file 02), groups (file 02), product_commodities (file 04)
--
-- TWO polymorphic junction tables in this file (event_links, taggables).
-- Both follow the same pattern as group_members in file 02 -- read that
-- DELIBERATE CHOICE comment for the rationale; per-table comment blocks
-- below repeat the trade-off summary.
--
-- NOT in this file: indexes + triggers (file 08).

-- events -- a "context bucket" anything financial can be linked to.
-- A holiday in 2026, a wedding budget, a quarterly project. Owned by EITHER
-- a user OR a group, never neither -- enforced via table-level CHECK.
-- Why allow both columns instead of a single owner_id? Because the FK targets
-- are different tables (users vs groups) and Postgres can't FK to "either."
-- Both ON DELETE CASCADE: deleting an owner cascades the events away.
CREATE TABLE events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    group_id    UUID REFERENCES groups(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    event_type  TEXT,                                                  -- e.g. 'holiday', 'wedding', 'project'
    start_date  DATE,
    end_date    DATE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    CHECK (user_id IS NOT NULL OR group_id IS NOT NULL)                -- at least one owner; table-level CHECK
);

-- event_links -- polymorphic: an event can be linked to transactions OR
-- documents (or both, with one row per link). linked_id holds the target
-- row's UUID; linked_type says which table it lives in.
--
-- DELIBERATE CHOICE: no FK on linked_id (Postgres can't constrain a single
-- column to point at multiple tables). Same pattern as group_members in
-- file 02. CHECK on linked_type bounds the polymorphism to ('transaction',
-- 'document'); UNIQUE (event_id, linked_id, linked_type) prevents the same
-- link being added twice. Loss of DB-level RI for linked_id is the accepted
-- trade-off; cleanup-by-cron is the future fix if orphans bite.
CREATE TABLE event_links (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    linked_id    UUID NOT NULL,                                        -- polymorphic; NOT enforced at the DB level
    linked_type  TEXT NOT NULL CHECK (linked_type IN ('transaction', 'document')),
    UNIQUE (event_id, linked_id, linked_type)
);

-- budgets -- spending cap for a user or group, optionally scoped to a
-- commodity (UNSPSC) or to a specific event. Same user-OR-group pattern as
-- events. amount NUMERIC(12, 2) (not 10) consistent with tracked_objects:
-- annual budgets can run high.
--
-- TODO (open question #2 in spec): can a budget link to multiple commodities
-- or events instead of one each? Current shape allows at most one of each.
-- If multi-link is needed later, add budget_commodities / budget_events
-- junctions; until then, single FKs keep the schema small.
CREATE TABLE budgets (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    group_id      UUID REFERENCES groups(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    amount        NUMERIC(12, 2) NOT NULL,
    currency      TEXT NOT NULL,
    period        TEXT CHECK (period IN ('weekly', 'monthly', 'quarterly', 'yearly', 'custom')),
    period_start  DATE,
    period_end    DATE,
    commodity_id  UUID REFERENCES product_commodities(id),             -- optional UNSPSC scope
    event_id      UUID REFERENCES events(id),                          -- optional event scope
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    CHECK (user_id IS NOT NULL OR group_id IS NOT NULL)
);

-- tags -- per-user labels. UNIQUE (user_id, name) means tag names are
-- per-user, not global -- two users can both have a tag named "tax-deductible"
-- and they're separate rows.
CREATE TABLE tags (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    colour      TEXT,                                                  -- optional UI hint e.g. '#ff8800'
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- taggables -- polymorphic attachment of tags to other objects. Same pattern
-- as event_links above and group_members in file 02.
--
-- DELIBERATE CHOICE: no FK on taggable_id (polymorphism limitation; see
-- group_members file 02 for full rationale). UNIQUE (tag_id, taggable_id,
-- taggable_type) prevents duplicate tagging.
--
-- CHECK enum: drops 'merchant' per Decision 11 in spec Revision Log. The new
-- schema uses 'store' as the merchant entity (file 02) -- there is no
-- `merchants` table in M2, so 'merchant' would be a dead branch no code path
-- can produce. If a merchants table is ever added (no current plans), one
-- ALTER ... DROP CONSTRAINT / ADD CONSTRAINT pair re-adds the value.
CREATE TABLE taggables (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tag_id         UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    taggable_id    UUID NOT NULL,                                      -- polymorphic; NOT enforced at the DB level
    taggable_type  TEXT NOT NULL CHECK (taggable_type IN (
        'transaction', 'document', 'line_item', 'product_service', 'store'
    )),
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (tag_id, taggable_id, taggable_type)
);
