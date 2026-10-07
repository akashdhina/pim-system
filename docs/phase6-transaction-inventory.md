# Phase 6 Transaction Inventory (documentation only — nothing converted)

Every `db.transaction(...)` block found in the app, in the structure requested: name → route → tables → statement count → reads-before-writes → inserts → updates → deletes → generated IDs → invariant → audit-log writes → failure/rollback behavior. This is the blueprint for Batch 2+; nothing here has been touched or converted.

All failure/rollback behavior is the same mechanism throughout: `better-sqlite3`'s `db.transaction(fn)()` rolls back the entire transaction if `fn` throws (any validation `Error` thrown mid-transaction undoes every statement already run in it). None of these routes catch-and-partially-commit.

---

### 1. New application intake
- **Route**: `POST /api/pim/received` → `lib/pim.js` `createReceivedPimApplication`
- **Tables**: pim_cases, pim_parties, pim_case_parties, pim_addresses, pim_advocates, pim_case_advocates, pim_fees, status_master, pim_status_history, event_types, pim_docket, task_types, pim_tasks
- **Statement count**: ~10, plus 1 INSERT per applicant/opposite-party (parties), 1 per address, 1 per advocate — variable, typically 12-20 for a 1-applicant/1-OP case
- **Reads before writes**: `status_master` (RECEIVED code), `event_types` (APPLICATION_RECEIVED code), `task_types` (SCRUTINY code)
- **Inserts**: pim_cases (1), pim_parties (N), pim_case_parties (N), pim_addresses (0..N), pim_advocates (0..N), pim_case_advocates (0..N), pim_fees (1, application fee), pim_status_history (1), pim_docket (1), pim_tasks (1, SCRUTINY)
- **Updates**: pim_cases (sets `current_status_id` after the row exists, since it needs its own new id first)
- **Deletes**: none
- **Generated IDs**: `pim_cases.id`, each `pim_parties.id`, each `pim_advocates.id` — all via `lastInsertRowid`, several chained (party id feeds `pim_case_parties`/`pim_addresses`/`pim_case_advocates` inserts)
- **Invariant**: a case must never exist without at least one applicant, one opposite party, its RECEIVED status/docket entry, and its SCRUTINY task — a half-created case (e.g. case row but no parties) must never be visible.
- **Audit-log writes**: none in this transaction (case creation itself isn't separately audit-logged beyond the docket/status-history trail).
- **Rollback**: any missing required field (validated before the transaction starts) or a DB error anywhere in the chain undoes the whole case.

### 2. Scrutiny
- **Route**: `POST /api/pim/scrutiny/[id]` → `lib/pim-scrutiny.js` `saveScrutiny`
- **Tables**: pim_cases (read), pim_tasks, pim_task_history, pim_scrutiny, pim_scrutiny_attempts
- **Statement count**: ~6
- **Reads before writes**: **re-reads case status and the pending SCRUTINY task inside the transaction** — deliberately, to guard against a stale double-click using old browser state (see docs/phase6-migration-design.md finding 8). This is the one transaction in the app that most depends on genuine transaction isolation, not just atomicity.
- **Inserts**: pim_scrutiny_attempts (1, always — full history of every attempt, MAX(attempt_no)+1)
- **Updates**: pim_tasks (complete the SCRUTINY task), pim_scrutiny (upsert-by-case-id result)
- **Deletes**: none
- **Generated IDs**: none new (scrutiny_attempts uses a computed `attempt_no`, not exposed elsewhere as an FK)
- **Invariant**: a case must not be scrutinized twice concurrently based on stale state, and every attempt (including a DEFECT one that gets redone) must remain in the historical record.
- **Audit-log writes**: none directly (pim_task_history serves as this operation's own audit trail).
- **Rollback**: case-status mismatch or missing pending task throws before any write.

### 3. Approval / registration
- **Route**: `POST /api/pim/approval` → `lib/pim-approval.js` `approvePimRegistration`
- **Tables**: pim_cases, status_master, event_types, pim_status_history, pim_docket, task_types, pim_tasks
- **Statement count**: ~9
- **Reads before writes**: full `pim_cases` row (status/pim_number guard), 3× `status_master`, 2× `event_types`
- **Inserts**: pim_status_history (×2 — SECRETARY_APPROVAL_PENDING→REGISTERED, then REGISTERED→FORM2_PENDING), pim_docket (×2), pim_tasks (1, FORM2, only if not already pending)
- **Updates**: pim_cases (×2 — first sets `pim_number`/`registration_date`/status, then advances status again)
- **Deletes**: none
- **Generated IDs**: none consumed elsewhere in this transaction (the FORM2 task id is returned but not chained)
- **Invariant**: `pim_number` must be assigned exactly once (guarded by `pim_cases.pim_number IS NOT NULL` check + the column's own UNIQUE constraint), and a case can never be REGISTERED without its FORM2_PENDING follow-up task existing.
- **Audit-log writes**: none directly.
- **Rollback**: wrong current status, or a `pim_number` already present, throws before any write. **Known pre-existing risk, not fixed here**: PIM-number generation is a `MAX+1` scan over a `LIKE` pattern — not safe under two concurrent approvals (flagged in the Phase 6 design doc as a hardening opportunity, not fixed).

### 4. Non-starter
- **Route**: `POST /api/pim/nonstarter/[id]` → `db.transaction(() => recordNonStarter(...))()`, logic in `lib/pim-nonstarter.js`
- **Tables**: pim_cases (read), pim_outcomes, nonstarter_reasons (read), pim_responses/pim_service_attempts/pim_notices (read, fact inference), pim_status_history, pim_cases (update), pim_docket, pim_tasks
- **Statement count**: ~8
- **Reads before writes**: case status guard, existing-outcome guard (UNIQUE(case_id) on pim_outcomes), the active reason lookup, and `inferNonStarterContext()`'s 3-branch fact-inference read (checks for a REFUSED/consent=0 response, then a DID_NOT_APPEAR response, then a returned Final Notice) — this inferred context is what validates the *submitted* reason actually matches recorded case facts for the 3 auto-triggered reasons.
- **Inserts**: pim_outcomes (1), pim_status_history (1), pim_docket (1), pim_tasks (0 or 1 — reuses the existing NONSTARTER_FORM3 handoff task if one already exists rather than duplicating it)
- **Updates**: pim_cases (status → OUTCOME_FORM_PENDING, outcome_type/outcome_date)
- **Deletes**: none
- **Generated IDs**: `pim_outcomes.id`
- **Invariant**: for the 3 auto-triggered reasons, a pending NONSTARTER_FORM3 task (proof the underlying fact was already established, not merely asserted) must already exist, and the submitted reason must match what the case facts actually indicate — an outcome must never be recorded on assertion alone.
- **Audit-log writes**: none directly.
- **Rollback**: any guard failure (wrong status, no matching pending task, reason mismatch, already-terminal case) throws before any write.

### 5. Response (OP appearance/consent/refusal/sought-time)
- **Route**: `POST /api/pim/response/[id]` → helpers in `lib/pim-op-response.js`, transaction wraps them in the route
- **Tables**: pim_responses, pim_cases, pim_status_history, pim_docket, pim_fees, pim_tasks/pim_task_history (varies by branch)
- **Statement count**: 5-9, branch-dependent (APPEARED+consent, APPEARED+refusal, SOUGHT_TIME, REFUSED, DID_NOT_APPEAR)
- **Reads before writes**: `getCase`, `getActiveOppositeParty`, `requireIssuedNoticeForParty` (validates the response is against an actually-issued notice with a recorded service attempt — never an unissued notice or the wrong party's notice), `assertNotPremature`/`assertAlternateDateWithinWindow` where relevant
- **Inserts**: pim_responses (1), plus branch-dependent pim_fees (MEDIATION_FEE row, dedup'd case-wide) and pim_tasks
- **Updates**: pim_cases (status transition, via `transitionStatus`)
- **Deletes**: none
- **Generated IDs**: `pim_responses.id`
- **Invariant**: whichever branch fires, the new response row, the resulting status transition, any fee/task side effect, and the docket entry commit as one event — a status can never advance without the response record that justified it.
- **Audit-log writes**: none directly.
- **Rollback**: an unissued/wrong-party notice, a premature date, or an out-of-window alternate date throws before any write.

### 6. Consent (deferred consent decision)
- **Route**: `POST /api/pim/consent/[id]`
- **Tables**: pim_responses, pim_cases, pim_status_history, pim_docket, pim_fees, pim_tasks (via `lib/pim-op-response.js` helpers)
- **Statement count**: ~6-8, branch-dependent (CONSENTED vs REFUSED)
- **Reads before writes**: latest APPEARED response for the party (must exist, and `consent` must still be null — guards against double-deciding)
- **Inserts/Updates**: `pim_responses.consent` UPDATE (not insert — this fills in a decision on the *existing* appearance row), then CONSENTED→`ensureMediationFee`+status transition, or REFUSED→`createNonStarterHandoff`+status transition; docket entry either way
- **Deletes**: none
- **Generated IDs**: none new in the CONSENTED branch beyond `pim_fees.id` if a fee row didn't already exist
- **Invariant**: a consent decision can be recorded exactly once per appearance response (guarded by `consent IS NOT NULL` check before allowing the update).
- **Audit-log writes**: none directly.
- **Rollback**: no matching APPEARED response, or one already decided, throws before any write.

### 7. Mediation (assignment, sittings, session recording)
- **Routes**: `POST /api/pim/mediator/[id]` (assign), `.../mediator/reassign/[id]`, `.../mediation/[id]` (first sitting), `.../mediation/next/[id]` (schedule next), `.../mediation/session/[id]` (record outcome — the largest transaction in the app)
- **Tables**: pim_mediator_assignments, mediators (read), mediation_sessions, pim_cases, pim_status_history, pim_docket, pim_tasks, pim_task_history
- **Statement count**: assignment ~9, reassignment ~5, first sitting ~9, schedule-next ~7, **session recording ~15**, with up to 4 conditional branches (effective sitting + next date scheduled / effective + concludes / ineffective+ next date / ineffective + concludes)
- **Reads before writes**: active-assignment guards throughout (a case must have exactly one ACTIVE assignment, never zero or two), duplicate-pending-session guards, session/task dedup checks
- **Inserts**: pim_mediator_assignments (assign/reassign), mediation_sessions (each sitting), pim_tasks (FIRST_MEDIATION / SESSION_RECORD / OUTCOME_FORM, each dedup'd), pim_task_history, pim_status_history, pim_docket
- **Updates**: pim_mediator_assignments (status→ENDED on reassignment, `first_mediation_date` on first sitting), mediation_sessions (recording the actual outcome of a sitting), pim_cases (status), pim_tasks (completion)
- **Deletes**: none
- **Generated IDs**: `pim_mediator_assignments.id`, `mediation_sessions.id` (multiple call sites, some conditional), `pim_tasks.id` (multiple, conditional)
- **Invariant**: a case must never have zero or two simultaneously ACTIVE assignments (reassign ends the old one and inserts the new one, linked via `replacement_for_assignment_id`, in the same transaction); a recorded sitting must always leave the case with exactly one actionable next state — either a scheduled next sitting + its task, or the case advanced to OUTCOME_FORM_PENDING + that task, never neither.
- **Audit-log writes**: none directly (status_history/task_history/docket serve as this domain's audit trail).
- **Rollback**: any dedup/active-assignment guard failure throws before any write.

### 8. Fee
- **Route**: `POST /api/pim/fee/[id]`
- **Tables**: pim_fees, pim_cases, status_master, pim_status_history, pim_docket, pim_tasks, task_types
- **Statement count**: ~7-9
- **Reads before writes**: existing `pim_fees` row (case-level MEDIATION_FEE), current case status
- **Inserts**: pim_tasks (MEDIATOR_ASSIGNMENT, only once the fee is *fully* paid), pim_status_history, pim_docket
- **Updates**: pim_fees (cumulative `amount_received`, appended remarks), pim_cases (status→MEDIATOR_ASSIGNMENT_PENDING, only once fully paid)
- **Deletes**: none
- **Generated IDs**: `pim_tasks.id` (conditional)
- **Invariant**: a fully-paid case must never be left without its mediator-assignment task — the payment update and the resulting status/task advance are one commit.
- **Audit-log writes**: none directly.
- **Rollback**: none of the above guards fail silently; a DB error mid-sequence undoes the payment update too (a partial payment record must never exist without its own transaction having actually completed).

### 9. Outcome (recording and approval)
- **Routes**: `POST /api/pim/outcome/[id]` (record), `.../outcome/approve/[id]` (verify/approve/close)
- **Tables**: pim_outcomes, pim_cases, status_master, pim_status_history, pim_docket, pim_documents (read, approve-path gate), pim_tasks/pim_task_history (approve path), nonstarter_reasons (read, approve path)
- **Statement count**: record ~7, approve ~10+ (loops over every matching pending task)
- **Reads before writes**: record — duplicate-outcome guard, completed-session summary; approve — **enforces the mandatory Form IV/V document already exists** (`SELECT ... FROM pim_documents WHERE document_type = ... AND is_current = 1`) before allowing SETTLED/FAILED closure — a real statutory gate, not cosmetic
- **Inserts**: pim_outcomes (record), pim_status_history, pim_docket, pim_task_history (approve, once per completed task)
- **Updates**: pim_cases (outcome_type/date/status, and `closed_at` on approval), pim_outcomes (verified_by/approved_by on approval), pim_tasks (completion loop on approval)
- **Deletes**: none
- **Generated IDs**: `pim_outcomes.id` (record)
- **Invariant**: a case must never show an `outcome_type` without a matching `pim_outcomes` row (record); a case must never close as SETTLED/FAILED without its statutory Form IV/V document already existing (approve) — the OUTCOME_FORM task is deliberately left PENDING by the record step, only completed by approve.
- **Audit-log writes**: none directly.
- **Rollback**: duplicate outcome, missing mandatory document, or wrong case status throws before any write.

### 10. Mediation session (detailed — the largest single transaction)
See item 7; called out separately because at ~15 statements and 4 branches it's the highest-complexity single transaction in the app and the one most worth proving the new transaction mechanism against early in Batch 2, once simpler cases (scrutiny, intake) are already verified.

### 11. Legacy import
- **Route**: `POST /api/pim/import` → `lib/pim-legacy-import.js` `importLegacyCase`
- **Tables**: pim_cases, pim_parties, pim_case_parties, pim_addresses, pim_scrutiny, pim_notices, pim_service_attempts, pim_responses, pim_fees, pim_mediator_assignments, mediation_sessions, pim_outcomes, pim_tasks, pim_task_history, pim_docket, pim_status_history, audit_log — potentially all ~17 workflow tables in one call, depending on how far into the workflow the legacy case had progressed
- **Statement count**: highly variable — as few as ~8 (a case still at RECEIVED) to 30+ (a fully closed legacy case with mediation history)
- **Reads before writes**: duplicate-import guard (matching `pim_number`/`received_number`), the full chronology validation (`validateChronology` — every supplied date must be in order and not in the future) before the transaction even opens
- **Inserts**: proportional to how far the case progressed — every stage function (`addBaseline`, `addScrutiny`, `addRegistration`, `addForm2`, `addResponseAndFee`, `addMediatorAssignment`, `addFirstMediation`, `addOngoingSession`, `addOutcome`) is conditionally called based on which dates were supplied
- **Updates**: pim_cases (final status)
- **Deletes**: none
- **Generated IDs**: `pim_cases.id`, `pim_parties.id` (×N), `pim_mediator_assignments.id`, `mediation_sessions.id` (×1-2), `pim_outcomes.id` — the deepest ID-chaining in the app
- **Invariant**: the entire reconstructed workflow history (every stage the physical file shows the case already passed through) commits as one case, or none of it does — a legacy case can never appear "partially imported."
- **Audit-log writes**: **yes** — one `audit_log` INSERT (action `LEGACY_IMPORT`) recording the full reconstructed state, unlike every other transaction in this inventory.
- **Rollback**: chronology violation, duplicate pim_number/received_number, missing required reason/mediator for the target stage — all validated before or immediately inside the transaction, throwing before commit.
- **Test data note**: `pim_cases` has zero real rows today (confirmed in Phase 0/2 audits) — this transaction will be tested with controlled test data when its turn comes, per your instruction, not real legacy files.

---

## Cross-cutting notes for Batch 2+

- Every transaction above needs the **same** `withTransaction()` mechanism already built and proven in Batch 1 (`lib/pim-postgres.js`) — no transaction here needs anything Batch 1 didn't already establish.
- Three transactions (scrutiny, response, fee/outcome) depend on **guard reads inside the transaction** (re-reading current state to prevent acting on stale data) rather than pure fire-and-forget writes — these are the ones to test most carefully for genuine isolation, not just atomicity.
- Only legacy import writes to `audit_log` from inside a workflow transaction; every other transaction relies on `pim_status_history`/`pim_task_history`/`pim_docket` as its audit trail instead.
- No transaction in this inventory deletes a row.
