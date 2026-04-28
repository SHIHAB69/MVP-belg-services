-- M2 Phase 2 — File 07 of 10: Group 7 Error Logs (kept in public)
-- See docs/specs/m2_schema.md (Phase 2, Group 7) and Decision 3 in the
-- Revision Log.
--
-- 1 table. Same shape as the legacy MVP error_logs but FKs point at the new
-- public.users and public.documents (not archive.*).
--
-- Decision 3 recap: keep error_logs in public (not archived) so new uploads
-- keep logging here. The legacy error_logs is still snapshotted to
-- archive.error_logs_v1_mvp in file 09 for audit history; its rows are then
-- backfilled into this fresh table by file 10 (Phase 4.8). The snapshot
-- stays for 30+ days.
--
-- NOT in this file: indexes (file 08). No triggers (no updated_at column;
-- see deliberate-omission comment below).

-- error_logs -- write-only audit trail of pipeline errors.
-- ON DELETE SET NULL on both FKs so deleting a user or document leaves the
-- error history intact (just severs the link). Errors should outlive the
-- objects that caused them -- they're forensic data, not foreign-keyed
-- application state.
--
-- updated_at deliberately omitted: error rows are append-only. Once written,
-- they don't get edited. The set_updated_at trigger in file 08 must SKIP
-- this table.
CREATE TABLE error_logs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id    UUID REFERENCES documents(id) ON DELETE SET NULL,
    user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    error_type     TEXT NOT NULL,
    error_message  TEXT NOT NULL,
    stack_trace    TEXT,
    context        JSONB,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
