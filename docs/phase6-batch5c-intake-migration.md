# Phase 6 Batch 5C — New Application Intake (T1) Migration Mapping

**Scope: this document establishes the exact current SQLite intake contract (batch item 2) and maps every statement to its PostgreSQL implementation. Only T1 (`POST /api/pim/received`) is migrated in this batch.**

## 1. Source of truth

Verified against the actual code, not assumed from `docs/phase6-transaction-readiness.md` alone:
- `lib/pim.js:65-265` — `createReceivedPimApplication(data, userId = null, dbClient = db)` (the `dbClient` parameter was added in Batch 5B; this batch adds the genuinely new PostgreSQL implementation alongside it, in `lib/pim-data/intake.js`).
- `app/api/pim/received/route.js` — the only route that calls it.
- Live PostgreSQL schema, re-verified via the Supabase MCP `execute_sql`/`list_tables` tools against project `qqjmmxfvfrrzxirxtgtc` and cross-checked against `supabase/migrations/20260917020200_case_core.sql`, `20260917020300_scrutiny_workflow.sql`, `20260917020400_notice_service_response_fee.sql`, `20260917020000_reference_and_lookup_tables.sql`.

The statement count and table list in `docs/phase6-transaction-readiness.md` §B (14 statements minimum, 10 tables) is confirmed accurate against the actual current code — no drift found since that audit.

## 2. Exact statement-by-statement contract

| # | Statement | Input | Output | Generated ID | FK dependency | Later statements depend on it? | Failure rolls back whole tx? |
|---|---|---|---|---|---|---|---|
| 1 | `INSERT INTO pim_cases (...)` | `receivedNumber`, `receivedDate`, `applicationDate`, `claimAmount`, `disputeDescription` | new case row, `pim_number=NULL` | `pim_cases.id` | none | Yes — every later statement needs `caseId` | Yes |
| 2 | `INSERT INTO pim_parties` (loop, applicants) | `party.name`, `party.entityType` | new party row | `pim_parties.id` | none | Yes — feeds statement 3, and conditionally 4/5 | Yes |
| 3 | `INSERT INTO pim_case_parties` (loop, applicants) | `caseId`, `partyId`, role=`APPLICANT`, `sequence_no`, `is_primary` | link row | none | `pim_cases.id`, `pim_parties.id` | Statement 8 (`getPrimaryPartyId`) reads this | Yes |
| 4 | `INSERT INTO pim_addresses` (loop, conditional on `addressLine1`) | address fields | new address row | `pim_addresses.id` (unused downstream) | `pim_parties.id` | No | Yes |
| 5 | `INSERT INTO pim_advocates` (loop, conditional on `advocate.name`) | advocate fields | new advocate row | `pim_advocates.id` | none | Yes — feeds statement 6 | Yes |
| 6 | `INSERT INTO pim_case_advocates` (loop, conditional, paired with 5) | `caseId`, `partyId`, `advocateId`, `from_date` | link row | none | `pim_cases.id`, `pim_parties.id`, `pim_advocates.id` | No | Yes |
| 2'-6' | Same as 2-6, repeated for `oppositeParties` | — | — | — | — | — | Yes |
| 7 | `SELECT party_id FROM pim_case_parties WHERE ... role='APPLICANT' AND is_primary` (conditional, only if `applicationFee` supplied) | `caseId` | primary applicant's `party_id` | none | reads statement 3's rows | Yes — feeds statement 8 | n/a (read) |
| 8 | `INSERT INTO pim_fees` (conditional, only if `applicationFee` supplied) | fee fields, `applicantPartyId` from 7 | new fee row | `pim_fees.id` (unused downstream) | `pim_cases.id`, `pim_parties.id` (nullable) | No | Yes |
| 9 | `SELECT id FROM status_master WHERE code='RECEIVED'` | — | status id | none | reference data, must pre-exist | Yes — feeds 10 and 11; **hard guard, throws if missing** | Yes (guard) |
| 10 | `UPDATE pim_cases SET current_status_id=?` | statement 9's id, `caseId` | — | none | `status_master.id` | No | Yes |
| 11 | `INSERT INTO pim_status_history` | `caseId`, `to_status_id`=statement 9's id, `userId` | new row | none | `status_master.id`, `users.id` (nullable) | No | Yes |
| 12 | `SELECT id FROM event_types WHERE code='APPLICATION_RECEIVED'` | — | event id | none | reference data, must pre-exist | Yes — feeds 13; **hard guard, throws if missing** | Yes (guard) |
| 13 | `INSERT INTO pim_docket` | `caseId`, statement 12's id, `userId` | new row | none | `event_types.id`, `users.id` (nullable) | No | Yes |
| 14 | `SELECT id FROM task_types WHERE code='SCRUTINY'` | — | task type id or `undefined` | none | reference data, **not** a hard guard — falls back to `NULL` if missing | Yes — feeds 15 | n/a (read, never throws) |
| 15 | `INSERT INTO pim_tasks` | `caseId`, statement 14's id (nullable) | new task row | `pim_tasks.id` (unused downstream) | `pim_cases.id`, `task_types.id` (nullable) | No | Yes |

Minimum happy path (1 applicant, 1 opposite party, no address, no advocate, with application fee): **14 statements** (1 case insert + 2×party-insert + 2×case_party-insert + 1 primary-party-select + 1 fee-insert + 1 status-select + 1 case-update + 1 status-history-insert + 1 event-select + 1 docket-insert + 1 task-type-select + 1 task-insert = 14). Confirmed identical to the readiness audit's count. Every address (+1) and every advocate (+2) adds statements beyond this minimum, exactly as documented.

**Two hard guards** (statements 9 and 12) — case not found is impossible here since intake always creates a fresh case, but a missing `RECEIVED` status or `APPLICATION_RECEIVED` event aborts the whole transaction. **One soft lookup** (statement 14) — a missing `SCRUTINY` task type does not abort; the task is still created with `task_type_id = NULL`.

**No PIM-number generation of any kind occurs in T1.** `pim_cases.pim_number` is inserted as `NULL` at statement 1 and never touched again in this transaction — confirmed both by the code (no call to `generatePimNumber()` anywhere in `lib/pim.js`) and by the explicit code comment at the top of the original function ("No PIM number is assigned here... Registration/PIM numbering happens only after Secretary approval"). `generatePimNumber()` belongs exclusively to `lib/pim-approval.js`'s `approvePimRegistration` (T3), which is explicitly out of scope for this batch. **This means batch item 7's PIM-number-safety concern and item 17's Test D do not apply to T1** — see the Batch 5C report for the full explanation; this was verified against the actual code, not assumed.

**No `audit_log` write occurs in T1** — confirmed both in this re-read and in the Batch 5A readiness audit (only legacy import writes `audit_log`). No audit entry was invented for the PostgreSQL version, per batch item 11's explicit instruction not to.

**No duplicate/conflict guard exists in current SQLite T1** — confirmed by re-reading the full function: there is no `SELECT` checking for an existing `received_number` before the `INSERT`, and neither SQLite's `database/schema.sql` nor the live PostgreSQL schema has a `UNIQUE` constraint on `pim_cases.received_number` (only `pim_number` is unique, and intake never sets it). Two intakes with an identical `receivedNumber` both succeed today, in both engines. The PostgreSQL version preserves this exact (lack of) behavior — not a gap introduced by this migration, and not fixed here per the batch's "preserve existing behavior" instruction.

## 3. Generated-ID replacements (batch item 6)

```
SQLite (lib/pim.js, unchanged, kept as instant rollback):
  INSERT pim_cases      -> caseResult.lastInsertRowid            -> feeds every later statement's case_id
  INSERT pim_parties    -> partyResult.lastInsertRowid           -> feeds pim_case_parties.party_id,
                                                                     pim_addresses.party_id,
                                                                     pim_case_advocates.party_id
  INSERT pim_advocates  -> advocateResult.lastInsertRowid        -> feeds pim_case_advocates.advocate_id

PostgreSQL (lib/pim-data/intake.js, new):
  INSERT INTO pim_cases (...)     RETURNING id  -> caseId       -> feeds every later statement's case_id
  INSERT INTO pim_parties (...)   RETURNING id  -> partyId      -> feeds pim_case_parties.party_id,
                                                                    pim_addresses.party_id,
                                                                    pim_case_advocates.party_id
  INSERT INTO pim_advocates (...) RETURNING id  -> advocateId   -> feeds pim_case_advocates.advocate_id
```

`pim_addresses.id`, `pim_fees.id`, `pim_tasks.id` are generated by their respective `RETURNING id`-capable inserts in the PostgreSQL version but, exactly like the SQLite version's `lastInsertRowid` for these same three tables, are never consumed by a later statement — only the function's overall `caseId` return value matters downstream. No `SELECT MAX(id)` or any other ID-inference technique was used anywhere.

## 4. Date/time classification (batch item 8)

| Field | Column(s) | Classification | Source |
|---|---|---|---|
| `data.receivedDate` | `pim_cases.received_date`, `pim_fees.received_date`, `pim_docket.docket_date`, `pim_tasks.created_date`/`due_date` | User-entered business date | Request body, validated as required, passed through verbatim |
| `data.applicationDate` | `pim_cases.application_date` | User-entered business date | Request body |
| `data.applicationFee.ddDate` | `pim_fees.dd_date` | User-entered business date | Request body |
| advocate `from_date` | `pim_case_advocates.from_date` | Derived/system date | `new Date().toISOString().slice(0,10)` — **UTC**, not `officeDate()`. This is a pre-existing inconsistency (documented in the readiness audit §H) and was preserved verbatim in the PostgreSQL version, not corrected, per this batch's scope (translation only, no behavior changes) |

No `created_at`/`updated_at` timestamp is explicitly set by any T1 statement — every touched table's `created_at`/`updated_at` (PostgreSQL `timestamptz`, default `now()`) or SQLite equivalent is left to its column default in both engines, so no explicit instant/timestamp handling was needed here at all. No SQLite `datetime('now')`, `date('now')`, `time('now')`, or `julianday()` exists anywhere in the original T1 code (confirmed by re-read) — there was nothing of that kind to avoid carrying forward.

## 5. Boolean/numeric semantics (batch item 9)

- `pim_case_parties.is_primary` (PostgreSQL `boolean`) — SQLite writes `1`/`0`; PostgreSQL version writes the genuine JS boolean `index === 0`, which postgres.js serializes to native `boolean` with no extra handling needed.
- `pim_addresses.is_current` (PostgreSQL `boolean`) — SQLite writes `1`; PostgreSQL version writes literal `true`.
- `pim_tasks.auto_generated` (PostgreSQL `boolean`) — SQLite writes `1`; PostgreSQL version writes literal `true`.
- `pim_cases.claim_amount`, `pim_fees.amount_due`/`amount_received` (PostgreSQL `numeric`) — handled transparently by `lib/pim-postgres.js`'s existing custom type parser (established in Batch 2, unchanged here); no route-specific conversion was added.
- Every generated id (`bigint`) round-trips as a genuine JS number via the same existing custom parser — no `Number(...)` coercion was needed in the new code (added anyway in a couple of spots purely for defensive clarity, matching the SQLite version's own style).

No new route-specific conversion hacks were introduced, per batch item 9's explicit instruction.
