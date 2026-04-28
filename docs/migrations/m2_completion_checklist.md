# M2 Completion Checklist

> **Audience:** Nicolas. **One page.** Print it, tick the boxes as they complete.
> Updated: 2026-04-28.

---

## What M2 ships

- New 31-table schema in production replaces the 5-table MVP shape
- 7 edge functions updated to read/write the new schema (iOS contract preserved)
- Tester data migrated, no rows lost
- Old MVP tables preserved in an `archive` schema for 30+ days

iOS testers should see **no observable difference**. The schema change is invisible from the app.

---

## Definition of done — all of these must be ✅

### Build (already complete as of 2026-04-28)

- [x] All 12 migration files written + reviewed (`supabase/migrations/202604261400*.sql`)
- [x] All 7 edge functions rewritten (`supabase/functions/*/index.ts`)
- [x] Spec finalized with 17 decisions captured (`docs/specs/m2_schema.md`)
- [x] Staging end-to-end verified (`docs/migrations/m2_phase6_preflight.md`)
- [x] Deployment runbook written (`docs/migrations/m2_deployment_runbook.md`)

### Deploy (Phase A–D of the runbook)

- [ ] Pre-deployment backup taken and stored
- [ ] All 12 migration files applied to production cleanly
- [ ] file 10's DO block raised no exceptions
- [ ] All 7 edge functions deployed, all `ACTIVE`
- [ ] Smoke test pass: 11 of 11 (Phase C of runbook)
- [ ] iOS upload smoke test by Nicolas: receipt → DB → display works end-to-end
- [ ] Voice mode tested: at least 3 of 4 prompts work

### Soak (Phase F of the runbook)

- [ ] 24 hours of normal `error_logs` volume after deploy
- [ ] No tester reports of broken behavior in the first 24h
- [ ] No new error types in `error_logs` (pre-existing types within normal volume = OK)
- [ ] Voice mode hotfix (if any) deployed and soaked without further regression

### Post-deploy housekeeping

- [ ] Production DB password rotated (the one previously visible in chat)
- [ ] Staging Supabase project deleted
- [ ] `.env.staging` removed from local
- [ ] CLAUDE.md updated: M2 ✅, M3 🚧
- [ ] Nicolas signed off

---

## What you (Nicolas) need to do

### Before the deploy
- [ ] Confirm a 1–2 hour low-traffic window with Shihab
- [ ] Be reachable on iOS during the deployment window for the upload + voice mode smoke tests (~10 min of your time at the smoke-test point)

### During the deploy (when Shihab WhatsApps you)
- [ ] Upload one fresh receipt via iOS (any receipt — a coffee receipt is fine)
- [ ] Trigger voice mode and ask 4 test prompts (Shihab will list them)

### After the deploy
- [ ] Spot-check 3 testers in NocoDB — confirm their data looks right
- [ ] One-time: in NocoDB UI, remove the M:M link between Documents and OCR Results (otherwise NocoDB recreates the rogue junction table on next sync; Shihab will show you which menu)
- [ ] Sign off in WhatsApp once the 24h soak is clean

---

## Open questions still on the NocoDB backlog (M3+ territory)

These are documented in `docs/specs/m2_schema.md` Open Questions section. Not blocking M2 ship.

1. Default `main_currency` for users — EUR? Confirm.
2. Budgets: link to multiple commodities/events, or just one?
3. Where to store backups long-term? (currently local-only on Shihab's machine)
4. Merchant location dedup: "Carrefour Market Mariakerke" vs "Carrefour Gent" — one record or two?
5. `payment_method = "not_paid"` — add to enum or stay mapped to `'other'`?
6. `transaction_date` with time portion — DATE (current) or TIMESTAMPTZ?
7. category mapping to UNSPSC commodities — when?
8. NocoDB M:M link removal — operational cleanup (above)

---

## Where things live

| Document | Location |
|---|---|
| Spec (canonical) | `docs/specs/m2_schema.md` |
| Migration files | `supabase/migrations/202604261400*.sql` |
| Edge functions | `supabase/functions/*/index.ts` |
| Deployment runbook | `docs/migrations/m2_deployment_runbook.md` |
| Staging preflight notes | `docs/migrations/m2_phase6_preflight.md` |
| This checklist | `docs/migrations/m2_completion_checklist.md` |

---

## What's NOT in M2 (for reference — M3 onwards)

- LLM-based extraction with multi-LLM router (M3)
- Self-improving feedback loops (M3)
- Re-extraction worker for documents marked `extraction_status='failed'` (M3)
- Field-level user/operator corrections via the `_ocr` / `_corrected` pair convention (M3 / M4)
- iOS UI updates for new schema (M4)
- Authentication / Supabase Auth (M5)
- Row Level Security policies (M5)
- Bank Account / Open Banking integration (M6)

---

## Sign-off

M2 is **shipped** when:
- Every box above is ticked, OR
- Any unticked box has an explicit waiver written next to it (with date + reason).

```
Date M2 deployed:        __________________
Date M2 24h soak passed: __________________
Signed (Nicolas):        __________________
Signed (Shihab):         __________________
```
