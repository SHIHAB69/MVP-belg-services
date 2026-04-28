# CLAUDE.md — Project Context for Claude Code

> **Always read this file first.** It contains the full project context, current state, decisions made, and working agreements. Do not skip it.

---

## Deployment Status — PAUSED 2026-04-28 ~22:00

M2 deployment paused at Phase A.GO checkpoint due to local filesystem corruption. `.git/index` unreadable (data block corruption / stuck-I/O on the file — NOT iCloud, NOT disk space).

**Phase A state when paused:**
- A0–A7: ✓ all green (verified against production at amngfletxzqaokmhccxe)
- A2 backup: `backups/pre_m2_deploy_schema_20260428_161201.sql` (8.2 KB) + `backups/pre_m2_deploy_data_20260428_161201.sql` (270 KB). Timestamp: `20260428_161201`
- A3 row counts captured to `/tmp/m2_pre_deploy_counts.txt` (lost on reboot) AND mirrored to `~/m2_pre_deploy_counts_20260428.txt` (persistent). Production counts at 16:12: anonymous_users=88, documents=159, ocr_results=156, transactions=125, error_logs=35
- A4: NocoDB rogue junction `_nc_m2m_documents_ocr_results` exists but empty (file 00 will drop it)
- A5a: testers notified
- A5b: SKIPPED — Nicolas not available; C10/C11 deferred. Runbook F3 updated to gate the `m2-shipped-` tag on retroactive C10/C11 execution.
- A6: OPENAI_API_KEY confirmed set on production
- A7: production DB connection works (PostgreSQL 17.6 via session pooler)
- A8.1: ✗ FAILED — `.git/index` unreadable. Two zombie git processes (PIDs 20906, 20907) stuck in uninterruptible kernel I/O wait holding the file open. Even `cat .git/index > /dev/null` and `cp` to `/tmp` time out. Blast radius confirmed CONTAINED — all 12 migration SQL files, all 7 edge function `index.ts` files, and both A2 backup files read cleanly.
- A.GO: NO-GO (item 8 ✗)

**Resumption plan for next session:**
1. After reboot, verify `git status` returns clean and `cat .git/index` succeeds.
2. If still broken: Option C (`rm .git/index && git reset` — non-destructive, working tree on disk is the source of truth, HEAD's tree object is healthy in pack files) OR `fsck_apfs` from recovery mode OR run deployment from a different machine.
3. Re-run **A2** (fresh backup, new timestamp) — the 16:12 backup will be too old.
4. Re-run **A3** (fresh production row counts) — production drifts overnight as testers upload.
5. Re-run **A8.1** with working `git status`. A8.2/8.3/8.4 already verified, no need to repeat unless filesystem is suspect.
6. Re-take the A.GO call with all 8 items green.
7. Then Phase B onward per the runbook (`docs/migrations/m2_deployment_runbook.md`, which has its own pause banner at the top).

**No production database changes were made on 2026-04-28.** Pause point is pre-Phase-B. Production state is as captured in A3.

**Do NOT proceed to Phase B until A.GO is fully green with verified disk health.**

---

## Project Overview

**PFIS (Private Finance Intelligence System)** — internally branded as **Clear** — is a personal finance intelligence platform that maps an individual's complete financial life at granular detail. It extracts and connects data from receipts, invoices, bank statements, credit card statements, and product packaging photos into a unified database.

**Owner:** Nicolas Roegiers
**Legal entity:** Wizgo (management company)
**Brand:** Clear (not yet a deposited brand)
**Lead developer:** Shihab (full-time from May 1, 2026)
**Engagement:** First 3 months guaranteed, monthly fee €1,500, ongoing thereafter

---

## What We Are Building (Target State)

A scalable financial intelligence platform with:

- **Document ingestion pipeline** — receipts, invoices, payslips, bank/CC statements, packaging
- **Multi-LLM extraction** — vision-language models extract structured data from images/PDFs
- **Self-improving feedback loops** — operator corrections (NocoDB) + end-user corrections (iOS app), both feed prompt versioning
- **Universal database** — 31 interconnected objects across 6 logical groups
- **In-app chatbot** — natural language queries against the structured data
- **Cross-user price intelligence** — anonymised access to other users' line item data
- **Future: Open Banking / PSD2** — direct bank account connection (Milestone 6)

---

## Current State (MVP)

The current production code is a working MVP with the following capabilities. Everything below will be replaced or significantly expanded.

### Stack
- **Supabase** (PostgreSQL + Edge Functions + Storage) — single source of truth
- **NocoDB** — connected to Supabase for operator-level record management (read/write records, never schema)
- **iOS native app** (Swift) — separate repo, deployed via TestFlight to internal testers (not yet publicly released)
- **Edge functions in Deno/TypeScript**
- **OpenAI GPT-4o-mini** — used by chatbot only, NOT for extraction
- **Figma** — design tool (out of dev scope, designs handed to dev for implementation)

### Database (Current MVP — 5 tables)

```
anonymous_users  — UUID-only, no real auth
documents        — file storage references
ocr_results      — raw OCR text from iOS Vision framework
transactions     — flat: amount/merchant/category/date per document
error_logs       — pipeline errors
```

### Edge Functions (Current — 7 functions)

1. **`register`** — creates anonymous user UUID
2. **`upload`** — receives file from iOS, runs GPT-4o vision extraction producing structured JSON (line_items, document_type, payment fields, net/tax/discount/paid amounts), writes to `public.transactions`
3. **`ask`** — chatbot with hardcoded query patterns + GPT-4o-mini fallback
4. **`chat`** — tool-calling GPT-4o assistant (`search_transactions`, `get_documents_summary`)
5. **`documents`** — GET list and DELETE for user's documents (joins `transactions`)
6. **`document-file`** — serves raw file bytes for in-app preview
7. **`realtime-session`** — OpenAI Realtime voice session endpoint with finance tool handlers

### Critical MVP Limitations (Bottlenecks We Will Address)

These are documented limitations to fix in upcoming milestones. Do not attempt to fix any of these outside the relevant milestone unless explicitly instructed.

1. **Single-pass extraction** — `upload` uses GPT-4o vision but no fallback, no provider switching, no prompt versioning (M3 adds these on top of the working pipeline)
2. **OCR happens on iOS device, not server** — backend never sees the image for extraction (M3)
3. **No multi-LLM router or fallback** — single OpenAI call, no retry, no provider switching (M3)
4. **No structured output enforcement** — no JSON schema validation on LLM output (M3)
5. **Synchronous extraction** — blocks upload response (M2/M3)
6. **No image pre-processing** — phone photos sent raw, hurts accuracy (M3)
7. **Chatbot only knows transactions** — can't answer questions about merchants, products, recurring tx (M4)
8. **Hardcoded regex query patterns** — won't scale, English-only (M4)
9. **No conversation memory** — every chatbot call is stateless (M4)
10. **No answer feedback capture** — no thumbs-up/down, no correction storage (M3/M4)
11. **No token tracking, no cost guardrails** — no per-user limits, no caching (M3)

---

## Approved Schema (31 Objects, 6 Groups)

Nicolas approved this on 2026-04-21. The schema diagram PDF is at `docs/diagrams/PFIS_Milestone1_Schema.pdf`. **This structure is final** — do not propose alternative groupings or rename groups.

### Group 1 — Geography (4 objects, GeoNames seed data)
- Continents, Countries, States/Provinces, Cities
- 4-level hierarchy. City links upward automatically.

### Group 2 — Entities (6 objects)
- Users, Persons, Companies, Groups, Brands, Stores
- Stores link to City + optionally to Brand. Brand can link to Company.

### Group 3 — Documents & Transactions (9 objects)
- Documents (parent), Receipts, Invoices, Payslips, Bank Statements, Credit Card Statements (subtypes)
- Transactions (hub, payer/receiver self-link), Payment Methods, Recurring Transactions
- Three-layer hierarchy: Document → subtype → line records

### Group 4 — Products & Services (7 objects)
- Segments, Families, Classes, Commodities (UNSPSC 4-level hierarchy)
- Products & Services, Attributes, Line Items
- Line Items = the bridge between Documents ↔ Products ↔ Transactions

### Group 5 — Tracked Assets (2 objects)
- Tracked Objects (cars, properties), Tracked Services (subscriptions grouped together)

### Group 6 — Context (3 objects)
- Events (holidays, weddings), Budgets, Tags (polymorphic — attach to any object)

---

## OCR Field Pair Convention (CRITICAL)

**Every field populated by an LLM must exist as TWO columns:**

```sql
field_name_ocr        -- raw model output (never overwritten)
field_name_corrected  -- human-edited value (operator or end-user)
```

- Neither overwrites the other. Both stored permanently.
- Both feed prompt training and quality analysis.
- During schema design, every field must be explicitly marked as OCR-populated or not.
- Reads should prefer `corrected` if non-null, otherwise `ocr`.

This convention is non-negotiable and must be applied uniformly.

---

## Milestones (6 Total)

| # | Milestone | Status |
|---|-----------|--------|
| 1 | Schema Design & Review | ✅ COMPLETE — Nicolas approved 2026-04-21 |
| 2 | Build Supabase Schema + Migrate Data | 🚧 IN PROGRESS — current focus |
| 3 | LLM Enrichment Pipeline + Feedback Layers | ⏳ Next |
| 4 | iOS App Updated (new schema, feedback UI, new chatbot) | ⏳ |
| 5 | Security (RLS, JWT, encryption, rate limiting) | ⏳ Done with security specialist |
| 6 | Bank Account API Integration (Open Banking / PSD2) | ⏳ End of roadmap |

---

## Working Agreements with Nicolas

These are non-technical rules that affect how Claude Code should behave. Read them carefully.

### What Nicolas Wants
- **Continuous delivery over perfection** — proceed with work even if there are minor issues; don't get blocked on details
- **Data quality is the priority** — correct extraction is more important than fancy features
- **Automate everything possible** — minimise manual operator work
- **Weekly strategic call** — Mondays. Technical calls are on-demand separately.

### What Nicolas Wants to Avoid
- **Building features not requested** — Nicolas explicitly owns feature decisions. **DO NOT add user-visible features without explicit instruction.** This applies to all features regardless of size — including small interactions, scanning behaviours, or UI details.
- **Backend complexity becoming a "monster"** — keep things clean and iterative. If something starts feeling tangled, flag it explicitly rather than adding more layers.
- **Over-consultation with David (Nicolas's brother)** — David can review architecture occasionally but is not the decision-maker. Shihab decides.

### iOS App Status
- **TestFlight only** — internal testers, NOT public App Store release
- **Tester data must be preserved** through any migration — testers have uploaded receipts that must not be lost
- **No iOS app changes for Milestone 2** — backend changes only, API contract stays the same
- **iOS app changes happen in Milestone 4** per the brief

### Communication
- **WhatsApp** — quick day-to-day questions and updates
- **NocoDB** — task tracking, bugs, feature backlog, structured product info
- **Weekly video call** — strategic, not technical

---

## Tech Stack Notes

- **Supabase owns ALL schema definition.** NocoDB never creates or alters tables/fields.
- **End users never access NocoDB** (operator only).
- **API keys must be in environment variables only** — never in code, never on the client.
- **Edge functions in Deno/TypeScript** — match existing pattern.
- **Don't introduce new tools/services without prior agreement** with Nicolas.

---

## Reference Documents

- **Project Brief (Apr 2026):** `Project_Brief_Murphy__MayJuly_2026_v1_.pdf` (in Anthropic project files)
- **Schema Diagram (Approved):** `docs/diagrams/PFIS_Milestone1_Schema.pdf`
- **Milestone 2 Spec:** `docs/specs/m2_schema.md` ← READ THIS for current work
- **Legacy Plan (DEPRECATED):** `IMPLEMENTATION_PLAN.md` — old MVP plan, IGNORE

---

## Decisions Made

Quick reference of decisions already locked in. Don't relitigate these without explicit instruction.

| Decision | Choice | When |
|----------|--------|------|
| Schema groups | 6 groups, 31 objects | Approved 2026-04-21 |
| OCR field convention | Pair every LLM field (ocr + corrected) | Brief Apr 2026 |
| Geography source | GeoNames | Brief Apr 2026 |
| Product classification | UNSPSC 4-level | Brief Apr 2026 |
| Transactions structure | Self-link payer/receiver | Brief Apr 2026 |
| Tags | Polymorphic (any object) | Brief Apr 2026 |
| Migration strategy | Migrate tester data, archive old tables for 30+ days | 2026-04-23 |
| iOS app changes for M2 | None (API contract preserved) | 2026-04-23 |
| Multi-LLM provider support | Required (OpenAI + Anthropic + Google), implemented in M3 | Brief Apr 2026 |
| Bank API integration | Deferred to M6 | Brief Apr 2026 |
| GPT-4o vision pipeline | Preserve in M2; M3 adds router/feedback on top | 2026-04-26 |
| Pause M2 deployment due to APFS corruption on `.git/index` | Reboot, verify filesystem, resume tomorrow with fresh Phase A | 2026-04-28 |

---

## Working Style for This Codebase

- **Read the spec before coding.** Every milestone has a spec file in `docs/specs/`. Read it fully before writing any SQL or code.
- **Ask before deviating.** If the spec says "do X" and you think Y is better, flag it — don't just do Y.
- **Preserve backward compatibility for the iOS app.** API endpoints (`register`, `upload`, `ask`) keep the same request/response shape until Milestone 4. Only internals change.
- **Test migrations on a copy first.** Never run untested migration scripts against the production database directly.
- **Verify with row counts.** After any data migration, count rows in old vs new and confirm match.
- **Write idempotent migrations** where possible — they should be safe to run twice.
