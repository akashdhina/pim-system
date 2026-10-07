# Phase 6 Batch 5D — Non-Starter Outcome Recording (T7) Migration Mapping

**Scope: only `POST /api/pim/nonstarter/[id]` (T7, `recordNonStarter`). No other mutation.**

## 1. Target selection (Step 2)

Compared against the actual current code (not assumed from the prior audit) in `lib/pim-op-response.js`, `lib/pim-nonstarter.js`, `lib/pim-approval.js`:

| Candidate | Statements | PIM-number involvement | Guard placement | Branch complexity | Verdict |
|---|---|---|---|---|---|
| T3 — Approval (`lib/pim-approval.js`) | ~16-18 | **Yes** — calls `generatePimNumber()`, the exact MAX+1-over-`LIKE`-scan hazard Step 6 forbids blindly porting | all inside | moderate | Rejected: would force an unscoped PIM-number concurrency-design sub-project into this batch |
| T10 — OP response (`lib/pim-op-response.js`, via `response/[id]/route.js`) | 10-18, branch-heavy | none | all inside | 5 response-type branches, each with different writes | Rejected: highest shared-helper fan-out, needs a real issued-notice+service-attempt fixture to exercise meaningfully |
| T11 — Consent (`lib/pim-op-response.js`, via `consent/[id]/route.js`) | 9-13 | none | **split** — case-status guard before the transaction opens, response-row guard inside | 2 branches | Rejected: the readiness audit's single clearest TOCTOU exposure in the whole app; redesigning that guard placement is its own piece of work, not appropriate to bundle into "migrate the next mutation" |
| **T7 — Non-starter record (`lib/pim-nonstarter.js`, via `nonstarter/[id]/route.js`)** | ~9-12 | **none** — verified by re-reading the code, no call to `generatePimNumber` anywhere in the chain | all inside (re-verified: every guard read happens inside the route's `db.transaction()` today) | 2 branches (auto-triggered vs manual reason), no nesting | **Selected** |

T7 additionally has a **live, verified DB-level backstop** for its one real idempotency invariant (`pim_outcomes_case_id_key: UNIQUE (case_id)`, confirmed via `pg_constraint`), and its `MANUAL_REASON_CODES` branch (`BOTH_PARTIES_NOT_WILLING`, `MEDIATION_FEE_NOT_SUBMITTED`) needs no notice/response/service-attempt history at all — so it is the only one of the four candidates fully testable end-to-end without first building a multi-stage fixture. It also required building a small, genuinely reusable Postgres-native workflow-helper layer (`getStatusId`, `getEventId`, `addStatusHistory`, `addDocket`, `getPendingTask`, `createPendingTaskIfNotExists`) that every one of the rejected candidates will need too — directly satisfying the "provides useful reusable infrastructure for subsequent mutations" selection criterion.

No prerequisite refactor was required before this migration could proceed safely.

## 2. Exact statement-by-statement contract

Re-verified against `lib/pim-nonstarter.js` (Batch 5B state) and `app/api/pim/nonstarter/[id]/route.js`, not assumed from the Batch 5A audit.

| # | Statement | Hard guard (throws)? | Depends on |
|---|---|---|---|
| 1 | `SELECT c.*, s.code, s.name FROM pim_cases c LEFT JOIN status_master s ... WHERE c.id=?` | case not found | — |
| 2 | (JS) `TERMINAL_STATUS_CODES.has(status_code)` | already closed | #1 |
| 3 | (JS) `status_code IN ('OUTCOME_FORM_PENDING','AUTHORITY_DECISION_PENDING')` | already recorded | #1 |
| 4 | `SELECT id FROM pim_outcomes WHERE case_id=?` | outcome already exists | — |
| 5 | `SELECT ... FROM nonstarter_reasons WHERE id=? AND active` (or `code=?`) | reason not found/inactive | request input |
| 6-8 | `inferNonStarterContext`: up to 3 sequential SELECTs across `pim_responses`/`pim_notices`/`pim_service_attempts`, first match wins | never throws | — |
| 9 | (JS) auto-triggered branch: `getPendingTask(caseId,'NONSTARTER_FORM3')` | missing handoff task | #5, #6-8 |
| 9b | (JS) reason/context mismatch check | context contradicts submitted reason | #6-8, #9 |
| 9c | (JS) manual-reason branch: `MANUAL_REASON_CODES.has(reason.code)` | unsupported reason | #5 |
| 10 | `INSERT INTO pim_outcomes (...) RETURNING id` | — | #5 |
| 11 | `SELECT id FROM status_master WHERE code='OUTCOME_FORM_PENDING'` | status missing | reference data |
| 12 | `SELECT id FROM status_master WHERE code=<caseData.status_code>` | status missing | #1 |
| 13 | `INSERT INTO pim_status_history` | — | #11, #12 |
| 14 | `UPDATE pim_cases SET current_status_id, outcome_type, outcome_date, updated_at` | — | #11 |
| 15 | `SELECT id FROM event_types WHERE code='NONSTARTER_RECORDED'` | event missing | reference data |
| 16 | `INSERT INTO pim_docket` | — | #15 |
| 17 | `SELECT` pending `NONSTARTER_FORM3` task (dedup re-check) | never throws | — |
| 18 | (conditional) `SELECT task_types WHERE code='NONSTARTER_FORM3'` + `INSERT INTO pim_tasks ... RETURNING id` | — | #17 |

Minimum path (manual reason, no existing pending task): **12 statements**. Auto-triggered-reason path adds the 3-branch context inference (up to 3 more reads) plus the pending-task guard read: **up to 15**. Both within the readiness audit's "~9-12" estimate; confirmed accurate, not assumed.

## 3. `RETURNING id` conversions (batch item 6/Step 6)

```
SQLite (lib/pim-nonstarter.js, unchanged, kept as instant rollback):
  INSERT pim_outcomes -> outcome.lastInsertRowid -> outcomeId (return-value only, not chained)
  INSERT pim_tasks (createPendingTaskIfNotExists) -> result.lastInsertRowid -> form3TaskId (return-value only)

PostgreSQL (lib/pim-data/nonstarter.js + lib/pim-data/workflow-helpers.js, new):
  INSERT INTO pim_outcomes (...) RETURNING id -> outcomeId
  INSERT INTO pim_tasks (...) RETURNING id -> form3TaskId (only when no existing pending task is reused)
```

Neither generated id is consumed by a later statement within this transaction (both are return-value-only, matching SQLite exactly) — no insert-to-insert FK chain exists in T7, unlike T1's address→notice or document-metadata chains. No `SELECT MAX(id)`, no inferred/timing-based id lookup anywhere.

**No PIM-number generation of any kind occurs in T7** — confirmed by direct re-read of `lib/pim-nonstarter.js`: no reference to `generatePimNumber` anywhere in the file or its dependency chain. This is a distinct transaction from T3 (approval), which owns PIM numbering; T7 only ever reads a case that already has (or doesn't have) a `pim_number`, and never touches that column.

## 4. Date/time handling (Step 7)

`resolvedOutcomeDate = outcomeDate || officeDate()` — `officeDate()` (Asia/Kolkata calendar date) is used identically to the SQLite version (which gets it via `lib/pim-op-response.js`'s `today()`, itself `officeDate()`). The Postgres version imports `officeDate()` directly from `lib/pim-time.js` rather than going through the SQLite-shaped `today()` wrapper — same underlying pure function, same value, no `CURRENT_DATE` substitution anywhere. `pim_cases.updated_at = CURRENT_TIMESTAMP` is preserved verbatim (valid, equivalent SQL in both engines). No UTC/IST inconsistency exists in T7's own code (unlike several other transactions the readiness audit flagged) and none was introduced.

## 5. Concurrency/invariants (Step 9)

- **`pim_outcomes.case_id` uniqueness** — backed by a real DB constraint in both engines (SQLite: `UNIQUE(case_id)` in `database/schema.sql`; PostgreSQL: `pim_outcomes_case_id_key UNIQUE (case_id)`, verified live via `pg_constraint`). No new constraint needed.
- **"At most one pending `NONSTARTER_FORM3` task per case" dedup** — enforced only by the `getPendingTask`-then-conditionally-`INSERT` pattern in `createPendingTaskIfNotExists`, in **both** engines. No unique index exists on `pim_tasks` for `(case_id, task_type_code, status)` in either database (verified live via `pg_constraint` — none found). This is a **pre-existing gap, not introduced by this migration**, already documented in `docs/phase6-transaction-readiness.md` §I as a systemic pattern affecting many transactions. Per Step 9, this is reported here rather than silently patched with a new constraint: a future concurrency-hardening batch should address it (a partial unique index on `pim_tasks(case_id, task_type_code) WHERE status='PENDING'` would be the natural fix, but that is a schema change requiring separate review, not performed in this batch).

No schema change was made or is required to migrate T7 safely as a single-request operation; the above dedup gap is a pre-existing, documented, not-yet-hardened concurrency risk under multi-connection load, carried forward unchanged.

## 6. Authorization/API contract (Step 8)

`requirePermission(request, "RECORD_OUTCOME")` still runs first, unchanged, before any data access. Request body shape, response JSON shape (`{success, message, data: result}`), HTTP status codes (200 success / 400 on any thrown error, matching the route's existing generic catch), and every error message string are preserved verbatim from the SQLite version.
