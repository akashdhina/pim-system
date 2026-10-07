# Phase 6 Batch 5J — Service Result / Address Correction (Implementation)

**Scope (approved): `SERVICE_PENDING → record service result → derive the appropriate next state/task`, plus `ADDRESS_CORRECTION_PENDING → record corrected/new address → fresh Initial notice → continue the existing workflow`.** OP-response/consent, mediation fee, mediator assignment, mediation sessions, outcomes, honorarium, the Nodal Officer module, and the SOP limitation module are explicitly **not** part of this batch — see `docs/phase6-sop-2026-frozen-rules.md`.

This document records what was actually built, verified, and corrected. The pre-implementation audit is `docs/phase6-batch5j-service-result-planning.md` — read that first for the full reconciliation against SOP clauses 5–6; this document covers the implementation itself.

## 1. Final service state machine (PostgreSQL, as implemented)

```
SERVICE_PENDING
   │  POST /api/pim/service/[id]  { serviceAttemptId, result }
   │
   ├─ DELIVERED ────────────────────────────────────────────────
   │     notice.status → SERVED; case stays SERVICE_PENDING
   │     docket: NOTICE_DELIVERED
   │
   └─ RETURNED (returnReason required; OTHER needs remarks +
       administrativeAction) ──────────────────────────────────
         notice.status → RETURNED
         status_history: SERVICE_PENDING → NOTICE_RETURNED
         docket: NOTICE_RETURNED
         │
         ├─ FORM_2_FINAL  ─────────────────────────────────────
         │     case.current_status_id → NOTICE_RETURNED  (RESTS HERE —
         │     the intentional correction, §3)
         │     NONSTARTER_FORM3 handoff task created/maintained
         │
         ├─ ADDRESSEE_LEFT / INSUFFICIENT_ADDRESS / OTHER→SEEK ─
         │     case → ADDRESS_CORRECTION_PENDING
         │     ADDRESS_CORRECTION task created; docket: ADDRESS_REQUESTED
         │
         └─ UNCLAIMED / REFUSED_BY_ADDRESSEE / OTHER→PROCEED ──
               case → FINAL_NOTICE_PENDING
               FINAL_NOTICE_FOLLOWUP task created

ADDRESS_CORRECTION_PENDING
   │  POST /api/pim/address-correction/[id]  { serviceAttemptId, decision }
   │
   ├─ CORRECTED_ADDRESS_RECEIVED ────────────────────────────────
   │     old address flipped (is_current=false), never deleted
   │     new address inserted, is_current=true
   │     fresh Initial notice created via 5I's createFreshNoticeTx
   │       (original returned notice untouched)
   │     case → FORM2_PENDING  (re-enters 5I's Prepare/Generate/Issue)
   │
   └─ NO_CORRECTED_ADDRESS (confirmed=true, remarks required) ───
         case → FINAL_NOTICE_PENDING
         FINAL_NOTICE_FOLLOWUP task created
```

A notice reaching `SERVED` leaves the case at `SERVICE_PENDING` — OP response/appearance is the next stage, and it is explicitly **not** migrated by this batch (confirmed by test 2).

## 2. SOP mapping (clauses 5–6)

| SOP element | Implementation |
|---|---|
| Service by post | Fully implemented (unchanged from the pre-existing design, now PostgreSQL) |
| Service by email | Not implemented — `dispatch_mode` remains free text with no enum constraint, so this stays additive for later (§7) |
| Private notice | Not implemented in this batch — deferred per the frozen rules (§6) |
| Updated contact details considered for service | The address-correction workflow (§4) |
| OP fails to appear / no response → final notice | Two independent paths: (a) the OP-response stage's own inference (unmigrated, out of scope), (b) this batch's direct RETURNED→FINAL_NOTICE_PENDING routing for postal failure reasons |
| Service impossible despite reasonable attempts → non-starter eligible | A returned Final Notice (the last "reasonable attempt" in the sequence) directly maintains the NONSTARTER_FORM3 handoff task (§3) |
| OP refuses/unwilling → non-starter eligible | Postal refusal (`REFUSED_BY_ADDRESSEE`) is kept strictly distinct from OP refusal (`OP_REFUSED`, a different, unmigrated workflow) — confirmed by test 4: no `OP_%` status is ever touched by a service-result call |
| Contact-particulars affidavit (clause 5(a)) | Implemented at Form-2 Prepare time, notice-scoped (§5) |

## 3. Intentional NOTICE_RETURNED correction (not a parity bug)

**The pre-existing SQLite route left a returned Final Notice's case silently at `SERVICE_PENDING`** — it wrote a `pim_status_history` row targeting `NOTICE_RETURNED` but never updated `pim_cases.current_status_id` to match. This was identified during the Batch 5J planning audit and the correction was explicitly approved, not left as a parity requirement.

**What changed, and only there**: `lib/pim-data/service.js`'s `recordServiceResultTx`, in the `notice.notice_type === "FORM_2_FINAL"` branch only, now writes:

```sql
UPDATE pim_cases SET current_status_id = <NOTICE_RETURNED id>, updated_at = CURRENT_TIMESTAMP WHERE id = <caseId>
```

**Why only this one branch**: the two other RETURNED branches (address correction / proceed to Final Notice) already correctly continue to a further resting state (`ADDRESS_CORRECTION_PENDING` / `FINAL_NOTICE_PENDING`) within the same transaction — `NOTICE_RETURNED` genuinely is transient there, the same way `REGISTERED` is deliberately transient in Batch 5H-b (the same transaction immediately continues further). The Final-Notice-returned branch has nothing further to do automatically — the pending `NONSTARTER_FORM3` task (created/maintained exactly as the pre-existing SQLite code already did) is the next-action signal for staff, and the case now correctly reflects that it is waiting there, rather than silently claiming to still be "awaiting service."

**Kept SQLite reference preserves the original (uncorrected) behavior verbatim** — `recordServiceResultSqlite` in `app/api/pim/service/[id]/route.js` is untouched, including the latent inconsistency, per the instruction not to manufacture parity or alter unrelated historical code. The dedicated test suite (§8, tests S and 6) asserts the **new, corrected** PostgreSQL behavior as the contract, not byte-for-byte parity with the kept SQLite baseline on this one point.

**Worklist/UI compatibility updated**: `lib/pim-action-link.js`'s `getCaseAction` fallback switch previously grouped `NOTICE_RETURNED` with `SERVICE_PENDING`/`FINAL_NOTICE_ISSUED` under "Record Service" — a link that would now correctly reject (the case is no longer `SERVICE_PENDING`). Since the case always carries a pending `NONSTARTER_FORM3` task when resting at `NOTICE_RETURNED`, `getCaseAction`'s existing `pending_task_id` branch already routes correctly to `/pim/nonstarter/form3/[id]` before the status-code switch is ever reached; the switch was still corrected (to "Record Non-Starter" / `/pim/nonstarter/form3/[id]`) as the defensive fallback for the rare case where that task is somehow missing. No other worklist, dashboard, or report code needed changes — the case-detail progress stepper (`app/pim/case/[id]/page.tsx`) already grouped `NOTICE_RETURNED` under the "Service" stage, and the dashboard's `service_pending` aggregate bucket already included it; both were already correct, just previously unreachable as a genuine resting state.

## 4. Address-history invariant (preserved and verified)

The required evidence chain — *notice N → address A → service attempt against A → failed/returned result → corrected address B → fresh notice N+1 referencing B, with A, N and its service attempt remaining historically intact* — is preserved exactly, and was not redesigned:

- Old address: flipped `is_current = false`, **never deleted** (test 16).
- New address: inserted fresh, `is_current = true` (test 17).
- Fresh notice: references the **new** address (test 18); the **original** returned notice continues referencing the **old** address, never rewritten (test 19).
- The original service attempt (the failed one) is entirely unchanged by the correction (test 20).
- Fresh-notice creation reuses Batch 5I's `createFreshNoticeTx` directly — **not duplicated**. `lib/pim-data/service.js` contains zero `INSERT INTO pim_notices` statements of its own (statically asserted, test S).

## 5. Affidavit semantics (SOP clause 5(a))

**Schema**: `pim_notices.contact_affidavit_received boolean`, `pim_notices.contact_affidavit_date date` — nullable, notice-scoped (not case- or party-level), per the approved design: the affidavit attests to the contact details used for *this specific notice*, and an address correction genuinely changes what is being attested to.

**Invariant, enforced in code, not just documented**: `lib/pim-data/form2.js`'s `resolveContactAffidavit(contactAffidavitReceived, contactAffidavitDate)`:
- `received` is `true` only when the caller's value is the literal boolean `true` — never inferred from the presence of an address/phone/email, and never implicitly true when the field is simply omitted (test 26).
- When `received` is `false`, `date` is **always** discarded (`NULL`), even if the caller supplied one — the "should normally be NULL" business rule is enforced as a hard rule at this one funnel point, not left to caller discipline (test 25).
- When `received` is `true`, the supplied date is kept (or `NULL` if omitted — the date is optional metadata, not a second required field).

**Capture point**: both Initial and Final Form-2 Prepare (`prepareForm2NoticeTx`, covering both the direct-insert Initial path and the `createFreshNoticeTx`-routed Final path) accept and store these fields — confirmed by test 24 (received + date) and test 15's Final Notice Prepare (which goes through the same `resolveContactAffidavit` funnel). The UI (`app/pim/form2/[id]/page.tsx`) gained a checkbox + conditional date field so the workflow can actually capture this through the real form, not just the API (test 27 confirms the GET/read path exposes it correctly, serialized as `1`/`0` per this app's established boolean-wire convention, with no `render_data` or other unrelated field leaking onto the notice row).

**No document-upload machinery was built** — exactly the boolean + date pair approved, nothing more.

## 6. Concurrency / locking order

Every mutating function in `lib/pim-data/service.js` locks the **case row first** (`SELECT ... FOR UPDATE OF c`), re-checks its status, then locks the **notice row** (`FOR UPDATE OF n`, via a shared `loadAttemptForCorrectionTx` helper for the two address-correction decisions) before re-checking notice/service-attempt state — the same case-then-notice order Batch 5I's `issueForm2NoticeTx` already established. Verified live, not just by code inspection:

| Race | Proof |
|---|---|
| Duplicate service-result submission (same attempt) | Test 7 (sequential double-submit → 409) |
| Conflicting simultaneous service results (same attempt) | Tests 8 (identical) and 9 (conflicting DELIVERED vs. RETURNED) — exactly one commits in both cases |
| Service result racing address correction (same case) | Test 22 — the address-correction call wins the case-row lock race; the concurrent service-result call is cleanly rejected, never racing the address write itself |
| Duplicate Final Notice creation | Test 15 — Batch 5I's own Prepare guard (reused, not reimplemented) rejects a second Final Notice for the same case+party |
| Two requests advancing the same case differently | Covered by the case-row lock in every scenario above — whichever commits first leaves the loser's post-lock re-read unable to satisfy its own status guard |
| Duplicate follow-up tasks/docket/history | Test 14 (task dedup via the reused `createPendingTaskIfNotExists`), tests 11/12 (exact docket/history counts, not merely presence) |

**No new database constraint was added beyond the approved migration.** `pg_constraint`/`pg_indexes` on `pim_documents`, `pim_notices`, `pim_service_attempts` were queried live before writing this module; row-level locking fully serializes every invariant this module depends on, the same conclusion reached for Batch 5I and Batch 5E/T2 before it. This was checked, not assumed.

**Transactional invariant**: each of the three mutations (`recordServiceResultTx`, `recordCorrectedAddressTx`, `recordNoCorrectedAddressTx`) runs inside exactly one `withTransaction(...)` call, containing every one of its business consequences (service-attempt update, notice state, case status, status history, docket, task completion/creation) atomically. A downstream failure rolls back the entire transition — proven live by test 10 (a forced failure after every write, including a mid-transaction visibility check, followed by full rollback verification).

## 7. SOP-aware forward compatibility (checked, not built)

Nothing in this batch's schema or code forecloses:
- **Service by email** — `dispatch_mode` remains unconstrained free text.
- **Private notice** — no constraint anywhere assumes `dispatch_mode`/`pim_notices` can only ever represent post/email.
- **Multiple notices per case** — already true and already exercised (Initial, Final, fresh-after-correction all coexist, each independently versioned via Batch 5I's notice-scoped document model).

None of these were implemented, per the explicit instruction not to build them merely to satisfy forward compatibility.

## 8. Dedicated test suite — `scripts/test-pim-service-postgres.js`

41 tests (33 numbered scenarios from the approved matrix + 6 static + 1 RESIDUE, with test 28 covering two permission sub-cases and test 2/23 as confirmatory assertions rather than new live calls), **all passing**. Every fixture case is created via the real T1 intake and driven to `SERVICE_PENDING`/`ADDRESS_CORRECTION_PENDING` through Batch 5I's own `prepareForm2NoticePg`/`generateForm2DocumentPg`/`issueForm2NoticePg` — never a shortcut that reimplements or bypasses them, proving the two batches compose correctly.

Notable coverage beyond the matrix's literal wording:
- Test 6 asserts the NOTICE_RETURNED correction in **both** `pim_status_history` and `pim_cases.current_status_id` — the specific property the correction exists to prove.
- Test 29 confirms PostgreSQL-authoritative behavior: a case that exists only in SQLite is "not found" (404) through the real route, never a silent fallback.
- Test 33 confirms the five-mediator approved panel is untouched throughout the run.
- Tests 31/32 independently re-verify the production 2026 sequence and `PIM/119/2026` directly against the database, not merely inferred from the absence of errors.

First run hit a single transient `ECONNRESET` (the same known Supavisor pooler flakiness documented in every prior batch's report) during residue verification; `--cleanup-only` cleared the stale fixtures and a clean re-run passed outright.

### Regression suite (every affected/related suite re-run individually, not in parallel)

| Suite | Result |
|---|---|
| `test-pim-service-postgres.js` (this batch) | **41 passed, 0 failed** |
| `test-pim-form2-postgres.js` (5I) | 28 passed |
| `test-pim-numbering-postgres.js` (5H-b) | 26 passed (1 N/A by design) |
| `test-pim-mediator-registry-postgres.js` (5H-a) | 30 passed |
| `test-pim-scrutiny-postgres.js` (5E) | 44 passed |
| `test-pim-read-loaders-postgres.js` (5F) | 27 passed |
| `test-pim-tasks-search-postgres.js` (5G) | 35 passed |
| `test-pim-nonstarter-postgres.js` (T7) | 11 passed |
| `test-pim-intake-postgres.js` (T1) | 15 passed |
| `test-pim-tx-context.js` | 8 passed |
| `test-pim-postgres.js` (Batch 1) | 10 passed (after adding this batch's test script to its DB-connection-variable allowlist, the same one-line addition every prior batch has made) |
| `test-pim-dashboard.js`, `test-pim-case-detail.js` | Pass; live sections SKIP (pre-existing, documented: these scripts don't call `loadEnvConfig`, unrelated to this batch) |

`npx tsc --noEmit`: clean. `npm run build`: succeeded, all 5J routes present in the route manifest.

**Lint**: finished at exactly **160 problems (107 errors, 53 warnings)** — the frozen baseline, with **zero net increase**. This was not accepted passively: the first `eslint` run after writing this batch's code showed 177 problems (107 errors, 70 warnings, +17 vs. baseline). Every one of the 17 new warnings was individually diagnosed and fixed, not suppressed:
- 15 "unused eslint-disable directive" warnings in the two migrated routes — `// eslint-disable-next-line @typescript-eslint/no-unused-vars` comments that were copied onto helper functions (`getStatusId`, `getEventId`, `addStatusHistory`, `addDocket`, `createPendingTaskIfNotExists`, `getCase`, `loadAttemptForCorrection`) that are, in fact, still called by the kept SQLite baseline functions later in the same file — the disable comments were simply wrong, not needed. Removed.
- 2 genuine `@typescript-eslint/no-unused-vars` in the new test script — `recordCorrectedAddressPg` was imported but only ever exercised through the real route (not called directly), and `ctx3` was assigned but never read. Both fixed by removing the unused binding, not by disabling the rule.
- The one remaining `react-hooks/exhaustive-deps` warning on `app/pim/form2/[id]/page.tsx`'s pre-existing `useEffect(() => { loadData(); }, [id])` was investigated and confirmed to be a pervasive, pre-existing pattern repeated across this app's other pages (e.g. `app/pim/case/[id]/page.tsx`'s own `useEffect`), not introduced by this batch — it only appeared in this batch's grep because the new affidavit `useState` hooks shifted its line number into the search window. Left as-is, consistent with not fixing unrelated pre-existing code.

## 9. Known remaining service gaps (explicitly out of scope, not fixed here)

- **Email service** — no sending mechanism, no destination-email/bounce-evidence columns (§7's planning document has the full design if/when this is built).
- **Private notice / Authority-permission decision model** — deferred to the Nodal Officer design pass, per the frozen rules.
- **The `ASSIGN_MEDIATOR` all-consent/fee-paid guard** and **refund-prevention logic**, flagged as unverified in the original SOP reconciliation audit, remain unverified — unrelated to this batch's scope.
- **Service-result recording, returned-post handling beyond this batch's RETURNED branch, and the OP-response stage itself** remain SQLite-backed and unmigrated, per the explicit batch boundary.

---

*End of implementation record. Migration applied: `pim_notices.contact_affidavit_received`/`contact_affidavit_date` + the `NO_CORRECTED_ADDRESS` event row (id 69), both already live on `pim-system` and mirrored locally at `supabase/migrations/20261006000000_batch5j_contact_affidavit_and_no_corrected_address_event.sql`. No commit/stage/push performed. `dlsa-mis` was never queried or touched. Production 2026 PIM sequence independently re-verified at the end: `last_number = 118`, `updated_at` unchanged since original initialization; `PIM/119/2026` not consumed by any case.*
