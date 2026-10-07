# Phase 6 Batch 5A — Transaction Migration Readiness Audit

**Status: audit/design only. Nothing in this document has been implemented. No route, schema, auth, or session code was changed to produce it.**

Methodology: every `db.transaction(...)` call site in the repo was located by direct grep (not assumed from the prior inventory doc), then the actual route/helper implementation behind each one was read in full — five parallel read-only research passes, cross-checked against `database/schema.sql` and the live-verified Postgres schema. Where this document's findings differ from `docs/phase6-transaction-inventory.md` (the earlier, design-phase inventory), that is called out explicitly — the earlier doc was a useful first pass but undercounted the real transaction surface.

---

## 0. Correction to the prior inventory

`docs/phase6-transaction-inventory.md` documented **11 logical transaction groups** and estimated "~25 multi-statement transactional workflows." A full grep of `db.transaction(` across `app/` and `lib/` finds **26 distinct call sites** — close to that estimate in count, but **not the same set**. Five workflow families existed in the code but had **zero entries** in the prior inventory:

- **Form-2 issuance** (`form2/issue/[id]`) — separate from Form-2 *preparation* (`form2/[id]`), which the prior doc only mentioned in passing under "approval."
- **Document generation** (`documents/outcome/[id]`, `documents/form3/[id]`, `documents/form2/[id]`) — three transactions that combine filesystem `.docx` generation with `pim_documents` metadata writes. Not mentioned at all in the prior doc, despite being directly relevant to the "no Supabase Storage" architecture decision.
- **Address correction** (`address-correction/[id]`, which contains **two** separate `db.transaction()` blocks for its two decision branches) — entirely absent from the prior inventory.
- **Service-attempt tracking** (`service/[id]`) — the prior doc only referenced this as a *read dependency* for the response transaction, not as its own transaction.
- **Non-starter Form-3 completion and authority decision** (`nonstarter/form3/[id]`, `nonstarter/authority/[id]`) — the prior doc's "Non-starter" section only covered the initial outcome-recording step (`nonstarter/[id]`).

This document treats all 26 as first-class entries, organized under the same 10 business-workflow groupings the prior doc used (intake, scrutiny, approval, non-starter, response, consent, mediation, fee, outcome, legacy import), plus the newly-surfaced document-generation and address-correction groups.

**Full list of the 26 `db.transaction()` call sites** (file:line):

| # | Transaction | File:line |
|---|---|---|
| T1 | New application intake | `lib/pim.js:68` |
| T2 | Scrutiny save | `lib/pim-scrutiny.js:237` |
| T3 | Approval / registration | `lib/pim-approval.js:383` |
| T4 | Form-2 prepare | `app/api/pim/form2/[id]/route.js:398` |
| T5 | Form-2 issue/dispatch | `app/api/pim/form2/issue/[id]/route.js:180` |
| T6 | Form-2 document generation | `app/api/pim/documents/form2/[id]/route.js:114` |
| T7 | Non-starter record | `app/api/pim/nonstarter/[id]/route.js:164` |
| T8 | Non-starter Form-3 completion | `app/api/pim/nonstarter/form3/[id]/route.js:348` |
| T9 | Non-starter authority decision | `app/api/pim/nonstarter/authority/[id]/route.js:102` |
| T10 | OP response recording | `app/api/pim/response/[id]/route.js:308` |
| T11 | Consent decision | `app/api/pim/consent/[id]/route.js:96` |
| T12 | Service-attempt tracking | `app/api/pim/service/[id]/route.js:472` |
| T13 | Mediator assignment | `app/api/pim/mediator/[id]/route.js:343` |
| T14 | Mediator reassignment | `app/api/pim/mediator/reassign/[id]/route.js:82` |
| T15 | Mediation first sitting | `app/api/pim/mediation/[id]/route.js:310` |
| T16 | Mediation schedule-next | `app/api/pim/mediation/next/[id]/route.js:125` |
| T17 | Mediation session record | `app/api/pim/mediation/session/[id]/route.js:369` |
| T18 | Fee collection | `app/api/pim/fee/[id]/route.js:315` |
| T19 | Outcome record | `app/api/pim/outcome/[id]/route.js:510` |
| T20 | Outcome approve | `app/api/pim/outcome/approve/[id]/route.js:231` |
| T21 | Documents/outcome (Form IV/V metadata) | `app/api/pim/documents/outcome/[id]/route.js:214` |
| T22 | Documents/Form-3 (non-starter doc metadata) | `app/api/pim/documents/form3/[id]/route.js:67` |
| T23 | Address correction #1 (corrected address received) | `app/api/pim/address-correction/[id]/route.js:399` |
| T24 | Address correction #2 (no corrected address) | `app/api/pim/address-correction/[id]/route.js:561` |
| T25 | Legacy import | `lib/pim-legacy-import.js:882` |
| — | Settings update (PATCH) | `lib/pim-settings.js:176` — **not a workflow transaction**, out of scope for this audit; noted only for completeness. |

None of the 26 deletes any row. `docs/phase6-transaction-inventory.md:149`'s "no transaction deletes a row" claim is confirmed correct across the expanded set too.

---

## A. Transaction matrix (concise reference table)

| # | Transaction | Statements (approx) | Tables written | Generated IDs (`lastInsertRowid`) | Guards | Audit trail | FS side-effect | Migration risk |
|---|---|---|---|---|---|---|---|---|
| T1 | Intake | ~14, variable w/ parties | pim_cases, pim_parties, pim_case_parties, pim_addresses, pim_advocates, pim_case_advocates, pim_fees, pim_status_history, pim_docket, pim_tasks | 3 (case, party×N, advocate×N) | all inside | status_history/docket | none | **Low–Moderate** |
| T2 | Scrutiny | ~9-10 | pim_scrutiny_attempts, pim_scrutiny, pim_status_history, pim_docket, pim_task_history, pim_tasks(upd), pim_cases(upd) | 0 | all inside (re-reads state — genuine isolation dependency) | status/task history | none | **Moderate** |
| T3 | Approval/registration | ~16-18 | pim_status_history(×2), pim_docket(×2), pim_task_history, pim_tasks, pim_cases(upd×2) | 1 (Form2 task) | all inside | status/task history | none | **High** — PIM-number MAX+1-over-LIKE scan, no unique constraint |
| T4 | Form-2 prepare | ~6-8 | pim_notices, pim_docket | 1-2 (notice) | all inside | docket | none | **Low-Moderate** |
| T5 | Form-2 issue | ~12-14 | pim_service_attempts, pim_status_history(×2), pim_docket, pim_task_history, pim_notices(upd), pim_cases(upd), pim_tasks(upd) | 1 (service attempt) | all inside; one non-throwing "conflict" early-return | status/task history | none | **Moderate** |
| T6 | Form-2 document gen | ~7 | pim_documents, pim_notices(upd) | 1, chained to same-tx UPDATE | mostly inside | none (metadata only) | **yes, inside the DB tx** (unlike T21/T22) | **High** |
| T7 | Non-starter record | ~9-12, variable | pim_outcomes, pim_status_history, pim_docket, pim_tasks | 2 (outcome, task) | all inside | status/docket | none | **Moderate** |
| T8 | Non-starter Form-3 completion | ~11-13 | pim_documents(upd), pim_outcomes(upd), pim_tasks(upd), pim_task_history, pim_docket, pim_status_history, pim_cases(upd), pim_tasks(new, cond.) | 1 (authority task, cond.) | **guards run BEFORE the tx opens** — TOCTOU exposure | task/status/docket | none in *this* tx (doc already generated by T22) | **High** |
| T9 | Non-starter authority decision | ~13 | pim_tasks(upd), pim_task_history, pim_outcomes(upd), pim_status_history, pim_docket(×2), pim_cases(upd) | 0 | all inside | task/status/docket | none | **Moderate** |
| T10 | OP response | ~10-18, branch-heavy | pim_responses, pim_status_history, pim_fees(cond.), pim_docket, pim_tasks(cond.), pim_task_history(cond.) | 3 (response, fee, task) | all inside | status/docket | none | **High** |
| T11 | Consent decision | ~9-13 | pim_responses(upd), pim_status_history, pim_fees(cond.), pim_docket, pim_task_history(cond.) | 1 (fee, cond.) | **split**: case-status guard BEFORE tx, response guard inside — clearest TOCTOU of the audit | status/docket | none | **High** |
| T12 | Service-attempt tracking | 3-17, deeply branched | pim_service_attempts(upd), pim_notices(upd), pim_status_history(cond.), pim_docket(cond.), pim_tasks(cond.) | 1-2 (task, cond.) | all inside; **mixed throw/non-throwing-conflict idiom**, unique among all 26 | status/docket, but **skipped entirely** for TRACKING_UPDATE | none | **High** |
| T13 | Mediator assignment | ~10-15 | pim_mediator_assignments, pim_status_history, pim_docket, pim_task_history(cond.), pim_tasks(cond.), pim_cases(upd) | 2 (assignment, task) | all inside | status/task/docket | none | **Moderate** |
| T14 | Mediator reassignment | 6-7, fixed | pim_mediator_assignments(upd+new), pim_docket | 1 (new assignment) | all inside | docket | none | **Moderate** |
| T15 | Mediation first sitting | ~8-10 | mediation_sessions, pim_mediator_assignments(upd), pim_status_history, pim_docket, pim_task_history(cond.), pim_tasks(upd, cond.), pim_cases(upd) | 1 (session) | all inside | status/task/docket | none | **Moderate-High** (UTC/IST bug found) |
| T16 | Mediation schedule-next | 6-8 | mediation_sessions, pim_docket, pim_tasks(cond.) | 2 (session, task) | all inside | docket only — **no status_history** | none | **Lower-Moderate** |
| T17 | Mediation session record | 8-18, 3 reachable branches | mediation_sessions(upd+cond. new), pim_task_history(cond.), pim_status_history, pim_docket, pim_tasks(cond. upd+new), pim_cases(upd, cond.) | 3 (next session, next task, outcome task) | all inside; **non-throwing conflict returns** for 2 guards | status/task/docket | none | **High** — largest/most complex transaction in the app |
| T18 | Fee collection | 3-15, variable | pim_fees(new-or-upd), pim_status_history(cond.), pim_docket(cond.), pim_tasks(cond.) | 1 (task, cond.) | all inside | status/docket (fully-paid branch only) | none | **Moderate** |
| T19 | Outcome record | ~9 | pim_outcomes, pim_cases(upd), pim_docket | 1 (outcome) | all inside | docket only — **status_history branch is dead code** | none | **Moderate** |
| T20 | Outcome approve | ~9-14 | pim_outcomes(upd), pim_status_history, pim_tasks(upd, loop), pim_task_history(loop), pim_docket, pim_cases(upd) | 0 | all inside; one non-throwing conflict return | status/task/docket | none | **Moderate-High** — statutory Form IV/V gate, zero DB backstop |
| T21 | Documents/outcome | 4 | pim_documents(upd+new), pim_outcomes(upd) | 1, chained to same-tx UPDATE | mostly outside/before | none | **yes, but entirely BEFORE the DB tx opens** | **Moderate** |
| T22 | Documents/Form-3 | 2-3 | pim_documents(upd cond.+new) | 1 | mostly outside/before | none | **yes, before the DB tx opens** | **Lower** |
| T23 | Address correction #1 | ~15-17 | pim_addresses(upd+new), pim_task_history(cond.), pim_docket(×2), pim_notices(new), pim_status_history, pim_cases(upd) | 2 (address, notice) chained | all inside | status/task/docket | none | **Moderate-High** |
| T24 | Address correction #2 | ~10-14 | pim_task_history(cond.), pim_docket, pim_status_history, pim_tasks(cond. new), pim_cases(upd) | 1 (task, cond.) | all inside | status/task/docket | none | **Moderate** |
| T25 | Legacy import | 16 to 60+, highly variable | up to 15 tables, see §7 | 7 (case, party×N, task, notice, assignment, session×2) | all inside | **audit_log** (only transaction of the 26 that writes it) + status/docket | none | **High** |

---

## B. Case intake — detailed lifecycle (batch item 6)

Confirmed by direct code read of `lib/pim.js:65-265` (`createReceivedPimApplication`) — **not** assumed from any prior summary.

**Tables actually touched, in order:**
1. `pim_cases` — 1 INSERT, `pim_number` explicitly `NULL` (registration happens later, at approval — T3)
2. `pim_parties` — 1 INSERT per applicant + per opposite party (loop)
3. `pim_case_parties` — 1 INSERT per party (links party↔case↔role)
4. `pim_addresses` — 1 INSERT per address with a non-blank `addressLine1` (conditional, nested under each party)
5. `pim_advocates` — 1 INSERT per party that supplies `advocate.name` (conditional)
6. `pim_case_advocates` — paired with #5 (conditional)
7. `pim_fees` — 1 INSERT, application fee, attached to the primary applicant (looked up via `getPrimaryPartyId`)
8. `status_master` — read-only guard (code `RECEIVED` must exist)
9. `pim_cases` — UPDATE `current_status_id` (must happen after #1, since the status lookup needs the case to logically exist first)
10. `pim_status_history` — 1 INSERT
11. `event_types` — read-only guard (code `APPLICATION_RECEIVED` must exist)
12. `pim_docket` — 1 INSERT
13. `task_types` — read-only lookup (code `SCRUTINY`; **not** a hard guard — missing row → `task_type_id` inserted as `NULL`, does not abort)
14. `pim_tasks` — 1 INSERT (SCRUTINY task)

**Not touched by intake, contrary to what could be assumed from a "new case" mental model:** `pim_scrutiny`, `pim_notices`, `pim_responses`, `pim_service_attempts`, `pim_mediator_assignments`, `mediation_sessions`, `pim_outcomes`, `pim_documents`, `audit_log`. Intake creates the case, its parties/addresses/advocates, its application fee, and its first (SCRUTINY) task — nothing from the workflow stages that follow.

Minimum path (1 applicant, 1 opposite party, no address, no advocate) = 14 SQL statements. This is the **lowest-complexity multi-table transaction in the app** (see §6).

---

## C. Generated-ID audit (batch item 3) — every `lastInsertRowid` / `AUTOINCREMENT` occurrence

Verified by direct grep of `lastInsertRowid` across `lib/` and `app/` (23 literal occurrences) plus manual confirmation of what each feeds. **PostgreSQL replacement in every case: `INSERT ... RETURNING id`**, confirmed compatible with the live schema (`id bigint generated always as identity primary key` on every table, verified in Batch 5A's schema reads and prior batches).

| # | File:line | Table | Consumed by (same transaction)? |
|---|---|---|---|
| 1 | `lib/pim.js:92` | pim_cases | Yes — feeds pim_case_parties, pim_addresses(via party), pim_case_advocates, pim_fees, pim_status_history, pim_docket, pim_tasks (all `case_id`) |
| 2 | `lib/pim.js:295` | pim_parties | Yes — feeds pim_case_parties.party_id, pim_addresses.party_id, pim_case_advocates.party_id, and (via re-SELECT in `getPrimaryPartyId`) pim_fees.party_id |
| 3 | `lib/pim.js:369-371` | pim_advocates | Yes — feeds pim_case_advocates.advocate_id |
| 4 | `lib/pim-approval.js:374` | pim_tasks (Form2 task) | No — return-value only |
| 5 | `app/api/pim/form2/[id]/route.js:557` | pim_notices | No — return-value only |
| 6 | `lib/pim-fresh-notice.js:129` | pim_notices (Final path) | No — return-value only |
| 7 | `app/api/pim/form2/issue/[id]/route.js:474`(field) | pim_service_attempts | No — return-value only |
| 8 | `app/api/pim/documents/form2/[id]/route.js:202` | pim_documents | **Yes** — feeds `UPDATE pim_notices SET document_id=?` in the same transaction (the clearest insert→update FK-chain in the whole audit) |
| 9 | `lib/pim-nonstarter.js:303` | pim_outcomes | No — return-value only |
| 10 | `lib/pim-op-response.js:277` (`createPendingTaskIfNotExists`) | pim_tasks | No — return-value only. Reused by T7, T10, T11, T12 |
| 11 | `app/api/pim/nonstarter/form3/[id]/route.js:92` (`createTask`) | pim_tasks (authority) | No — return-value only |
| 12 | `lib/pim-op-response.js:332` (`insertResponse`) | pim_responses | No — return-value only. Reused by T10, T11 |
| 13 | `lib/pim-op-response.js:382` (`ensureMediationFee`) | pim_fees | No new-insert chain — but see the T11 case, where `feeId` *is* surfaced in the response, unlike T10 |
| 14 | `app/api/pim/service/[id]/route.js:181` (`createPendingTaskIfNotExists`) | pim_tasks | No — return-value only |
| 15 | `app/api/pim/mediator/[id]/route.js:441` | pim_mediator_assignments | No — return-value only |
| 16 | `app/api/pim/mediator/[id]/route.js:617` | pim_tasks (FIRST_MEDIATION) | No — return-value only |
| 17 | `app/api/pim/mediator/reassign/[id]/route.js:182` | pim_mediator_assignments | No — return-value only |
| 18 | `app/api/pim/mediation/[id]/route.js:399` | mediation_sessions | No — return-value only |
| 19 | `app/api/pim/mediation/next/[id]/route.js:236` | mediation_sessions | No — return-value only |
| 20 | `app/api/pim/mediation/next/[id]/route.js:317` | pim_tasks | No — return-value only |
| 21-23 | `app/api/pim/mediation/session/[id]/route.js:815,879,981` | mediation_sessions, pim_tasks×2 | No — return-value only in all 3 cases |
| 24 | `app/api/pim/fee/[id]/route.js:538` | pim_tasks | No — return-value only |
| 25 | `app/api/pim/outcome/[id]/route.js:641` | pim_outcomes | No — return-value only |
| 26 | `app/api/pim/documents/outcome/[id]/route.js:252` | pim_documents | **Yes** — feeds `UPDATE pim_outcomes SET document_id=?` in the same transaction |
| 27 | `app/api/pim/documents/form3/[id]/route.js:119` | pim_documents | No — return-value only (Form-3 doesn't populate `pim_outcomes.document_id`, unlike Form IV/V) |
| 28 | `app/api/pim/address-correction/[id]/route.js:462` | pim_addresses | **Yes** — feeds `createFreshInitialNotice`'s `pim_notices.address_id` in the same transaction |
| 29 | `lib/pim-fresh-notice.js:129` (2nd use, address-correction path) | pim_notices | No — return-value only |
| 30 | `app/api/pim/address-correction/[id]/route.js:141` | pim_tasks | No — return-value only |
| 31-37 | `lib/pim-legacy-import.js:347,367,656,729,747,772,922` | pim_tasks, pim_parties, pim_notices, pim_mediator_assignments, mediation_sessions×2, pim_cases | Mixed — `pim_parties.id`(opposite party) feeds pim_notices/pim_responses/pim_fees; `pim_mediator_assignments.id` feeds mediation_sessions.assignment_id (both sittings); `pim_cases.id` feeds everything; task/notice/session ids are otherwise return-value only |

**Only 3 of ~37 occurrences are genuine insert→insert/update FK chains within the same transaction**: `documents/form2` (document id → notices.document_id), `documents/outcome` (document id → outcomes.document_id), and `address-correction/[id]`'s corrected-address branch (address id → notices.address_id). These three are the ones that specifically require sequencing an `await ... RETURNING id` before the dependent statement in the Postgres port — every other occurrence is a simple "insert, read back the id, put it in the JSON response" pattern that converts mechanically.

**Also confirmed, not covered by the `lastInsertRowid` grep**: `lib/pim-approval.js`'s `generatePimNumber()` (`lib/pim-approval.js:120-167`) is a **non-atomic MAX+1-over-`LIKE`-scan** ID-generation pattern — `SELECT pim_number FROM pim_cases WHERE pim_number LIKE ? ORDER BY id DESC`, then JS-side regex + `Math.max`. This is not a `lastInsertRowid` use at all (no autoincrement involved), but it is the single riskiest ID-generation pattern in the app: it has **no unique constraint or sequence backing it**, and is safe today purely because `better-sqlite3` serializes the whole process. **This must not be ported as-is** — see §I (Risks).

---

## D. Transaction-boundary audit (batch item 4)

For every `db.transaction(...)` in the 26-item list, the atomic unit is: *everything the callback does, start to finish*, since none of the routes use nested/partial transactions and none catch-and-partially-commit (confirmed across every agent's read). The meaningful finding here is not "what's atomic" (everything inside the callback, uniformly) but **where the guard reads sit relative to the transaction boundary**, because that determines whether the current code is actually safe under real concurrency or only appears safe because SQLite forces single-writer serialization. Three distinct patterns were found:

**Pattern 1 — All guards inside the transaction (the majority, and the correct/safe pattern to standardize on):** T1, T2, T3, T7, T9, T10, T12, T13, T14, T15, T16, T17, T18, T19, T20, T23, T24, T25. In these, every existence/status/duplicate check re-reads state from inside the open transaction, so a Postgres port that keeps them inside `withTransaction()` preserves the same guard-then-write atomicity (modulo the concurrency hardening in §I).

**Pattern 2 — All guards before the transaction opens:** T8 (`nonstarter/form3/[id]`). Case status, outcome existence, pending-task existence, and Form-3-document validation are all read **before** `db.transaction()` is called (`route.js:225-343`); only the authority-task existence check happens inside. This creates a genuine TOCTOU window today (masked by SQLite's single-process execution) that becomes a real race once Postgres allows concurrent connections. **This pattern should not be ported as-is** — the migration should move these guards inside the new `withTransaction()` callback and re-verify against fresh reads.

**Pattern 3 — Split guards (worst case):** T11 (`consent/[id]`). `getCase` plus the case-status-must-be-`OP_APPEARED` check run **before** the transaction opens (`route.js:64-94`); the response-row-specific checks (`latestResponse` lookup, already-decided guard) run **inside**. Nothing re-verifies the case is still `OP_APPEARED` once inside the transaction — `transitionStatus` blindly writes the target status regardless. This is the **single clearest TOCTOU exposure found in the entire audit** and must be redesigned (not mechanically ported) during migration: either re-query `pim_cases.current_status_id` inside the transaction and compare, or add a `WHERE current_status_id = <expected>` clause to the eventual `UPDATE pim_cases` and check the affected-row count.

**Two non-throwing "conflict" early-returns** were found and must be preserved carefully during the async rewrite, since they are functionally different from a thrown error even though today's SQLite behavior (commit-of-zero-writes vs. rollback-of-zero-writes) is externally indistinguishable:
- T5 (`form2/issue/[id]:247-256`), T17 (`mediation/session/[id]:398-420`, two separate conditions), T20 (`outcome/approve/[id]:249-258`), T12 (`service/[id]:482-491,520-529`, two conditions) — all return `{conflict: true, message}` from inside the transaction callback instead of throwing, and the outer route code checks `result.conflict` to produce an HTTP 409 rather than the generic 400 a thrown error produces. **A naive async port that turns these into `throw` statements would still behave identically today (no writes precede any of them) but changes the code's own documented intent, and would behave differently from today if a future code change ever moved a write earlier in the sequence.** This must be called out to whoever implements the Postgres version of each of these four routes.

**External side effects inside a transaction callback:** T6 (`documents/form2/[id]`) is the **one transaction of the 26 where filesystem I/O happens *inside* the `db.transaction()` callback**, not before it — `generateForm2Document()` (which calls `fs.mkdirSync`/`fs.writeFileSync`) is called between the transaction's opening brace and its first DB write (`app/api/pim/documents/form2/[id]/route.js:114-222`, generation call at `146-150`). This is architecturally different from its two siblings, T21 and T22, where the equivalent filesystem write happens **before** the transaction opens. See §K for the full implication.

---

## E. Smallest complete business transaction (batch item 5) — descriptive classification, not a ranking

Per instruction, these are classified descriptively (lower / moderate / high complexity, with reasons), not ranked "best/worst."

**Lower complexity:**
- **T22 (Documents/Form-3)** — 2-3 statements, single shallow conditional, no FK-chaining beyond the document row itself, no shared-helper dependency, no date-function ambiguity (uses the DB-stored outcome date, not a locally-computed `today()`). The cleanest transaction in the app.
- **T16 (Mediation schedule-next)** — 6-8 statements, no `pim_cases`/`pim_status_history` writes at all (deliberately — the case stays `MEDIATION_ONGOING`), only one 2-way conditional.

**Moderate complexity:**
- **T1 (Intake)** — variable statement count but only 2 real conditional guards after upstream validation, 3 `lastInsertRowid` sites with no cross-chaining beyond the obvious case→party→child pattern, one DB-backed invariant (partial unique index) that ports to Postgres directly. See §B for full detail.
- **T2, T9, T14, T18, T19, T21, T24** — each has a small number of branches, a bounded statement count, and no cross-module shared-helper fan-out.

**High complexity:**
- **T17 (Mediation session record)** — the largest and most branchy transaction in the app (up to 18 statements, 3 reachable outcome branches × 2 status-change sub-branches × 4 independent duplicate-detection guards, 3 `lastInsertRowid` sites, a genuine cross-transaction data dependency on T14 having already committed).
- **T25 (Legacy import)** — 16 to 60+ statements depending on how far the legacy case progressed, 14 helper functions all needing `tx`-threading, the same non-atomic PIM-number generation as T3, the deepest ID-chaining in the app, and the only transaction that writes `audit_log`.
- **T3, T10, T11, T12, T23** — each combines branch-heavy logic with either an unsafe-under-concurrency guard pattern (T3's PIM-number generation, T11/T12's TOCTOU exposure) or cross-module shared-helper fan-out (T10, T11, T12 all depend on `lib/pim-op-response.js`; T23 depends on `lib/pim-fresh-notice.js`).

**Conclusion carried into §G**: T1 (intake) is the only transaction combining *low* branch count, *low* ID-chaining complexity, *no* cross-module helper dependency, and a *already-Postgres-compatible* DB-level invariant — the other "lower complexity" candidate, T22, is trivially small but is a *document-metadata* transaction (fewer distinct business entities, less representative of the transactional patterns the rest of the app needs proven), and T16 never writes `pim_cases`/`pim_status_history` at all, so it wouldn't exercise the status-transition pattern nearly every other workflow transaction depends on.

---

## F. User identity bridge — every write site (batch item 7)

Confirmed via schema grep in this batch: every one of these Postgres FK columns is `references users(id)`: `entered_by`, `changed_by`, `created_by`, `recorded_by`, `verified_by`, `approved_by`, `completed_by`, `scrutinised_by`, `prepared_by`, `signed_by`, `appointed_by`. PostgreSQL `users` currently has **zero rows** — `scripts/sync-users-to-postgres.js` has never run because `SUPABASE_DB_URL` remains unset. **Every one of the 26 transactions that writes an identity column would fail its INSERT/UPDATE with a foreign-key violation today if pointed at Postgres**, until the sync script runs.

Full write-site list, by transaction:

| Column | Table | Written by |
|---|---|---|
| `changed_by` | pim_status_history | T1, T2, T3, T5, T7, T9, T10, T13, T15, T19(dead branch), T20, T23, T24, T25 |
| `entered_by` | pim_docket | T1, T2, T3, T4, T5, T7, T9, T13, T14, T15, T16, T18, T19, T21(no), T23, T24, T25 |
| `completed_by` | pim_tasks | T2, T3, T5, T8, T9, T13, T15, T18, T20, T23(cond.), T24(cond.), T25(cond.) |
| `changed_by` | pim_task_history | T2, T3, T5, T8, T9, T13, T15, T20, T23(cond.), T24(cond.) |
| `scrutinised_by` | pim_scrutiny | T2, T25(cond.) |
| `prepared_by` | pim_notices | T4, T23 (via `createFreshNotice`) |
| `prepared_by` | pim_outcomes | T7, T25 |
| `entered_by` | pim_responses | T10, T25 |
| `appointed_by` | pim_mediator_assignments | T14 (yes), T13 (**always written `null`, not `user.id`** — confirmed bug/gap, flagged separately below), T25 |
| `recorded_by` | mediation_sessions | T15, T16 (scheduling-time semantics), T17 (recording-time semantics — **same column reused for two different real-world events**, T25 |
| `verified_by` / `approved_by` | pim_outcomes | T20 (both), T9 (`approved_by` only) — **`verified_by` is never populated by any of the 26 transactions audited**, a workflow gap independent of migration |
| `created_by` | pim_documents | T6, T21, T22 |

**Specific pre-existing gaps confirmed (not introduced by migration, but relevant to any RLS/attribution design built on top of Postgres identity):**
- `pim_mediator_assignments.appointed_by` is **always `null`** on initial assignment (T13, `route.js:432`) — only reassignment (T14) actually populates it.
- `pim_fees`, `pim_service_attempts`, `pim_notices`(service fields), and `pim_tasks`(creation) have **no identity column at all** for several of their write paths — a partial-payment fee update, a service-attempt result, and most task *creations* (as opposed to completions) are entirely unattributed at the row level; the only trail is the accompanying `pim_docket`/`pim_status_history` row, which itself is sometimes skipped (T12's `TRACKING_UPDATE` branch writes no docket entry at all).
- `pim_responses` (consent decision, T11) — the *decider's* identity is not written to the response row itself (only the original *appearer's* `entered_by` from T10 persists); the consent-decider is only inferable via `pim_status_history.changed_by`/`pim_docket.entered_by` from the same call.

None of this needs to be "fixed" as part of the DB-engine migration — these are pre-existing SQLite-era gaps that should be flagged to the business/product owner, and preserved as-is (not silently patched) unless separately instructed.

---

## G. Audit-log architecture (batch item 8)

Confirmed by direct grep of `INSERT INTO audit_log` across the whole repo (not assumed from the prior inventory): `audit_log` is written from exactly **4** places:
1. `lib/pim-legacy-import.js:306` (`addAudit`, action `LEGACY_IMPORT`) — **the only one of the 26 workflow transactions that touches `audit_log`**, and confirmed (by lexical-scope inspection, not inference) to run **inside** the same `db.transaction()` as the rest of the import (`lib/pim-legacy-import.js:882-1069`), so it commits/rolls back atomically with every case/party/status/task row the import writes.
2. `lib/pim-settings.js:192` (settings PATCH) — outside this audit's workflow-transaction scope, but confirmed to exist.
3. `lib/pim-auth.js:371` (`auditAuth` — login/session events) — auth stays SQLite-only per standing instructions, out of scope.
4. `lib/pim-users.js:37` (`auditUser` — user CRUD) — out of scope per Batch 4/5 instructions (user mutations not migrated).

**None of the other 24 workflow transactions (T1-T24) write to `audit_log`.** They rely entirely on `pim_status_history` / `pim_task_history` / `pim_docket` as their audit trail — confirmed independently by all 5 research agents via direct grep of each file in scope, zero matches every time.

**What this means for PostgreSQL migration, per the batch's explicit ask**: for the one transaction that *does* currently write `audit_log` as part of its atomic business operation (legacy import), the Postgres port must keep that `INSERT INTO audit_log` inside the same `sql.begin()` callback as everything else — audit logging participates in the atomic operation today, and that should not change. For the other 24, no audit_log behavior needs to be replicated (there isn't any) — their existing `pim_status_history`/`pim_task_history`/`pim_docket` writes already serve this purpose, and the same "keep it inside the transaction" rule applies to them for the same reason. **This document does not recommend adding new `audit_log` writes to any of the 24** — that would be a business-logic change beyond a DB-engine migration and is explicitly out of scope per the batch's "no implementation" instruction; it is noted here only as an option available to a future, separately-scoped decision.

---

## H. Date/time audit (batch item 9)

**Correctly IST-aware** (`officeDate()`/`officeTime()` from `lib/pim-time.js`, Asia/Kolkata): T2 (partially — see below), T5, T9, T13, T20, T23, T24, T25.

**Confirmed UTC-based, not IST** (`new Date().toISOString().slice(0,10)` or equivalent, defined locally per-file rather than importing the shared helper): T4 (`form2/[id]`), T3's `todayLocal()` (raw `Date`, distinct from both `officeDate()` and UTC-ISO), T8 (`nonstarter/form3/[id]`), T15 (`mediation/[id]`), T16 (`mediation/next/[id]`), T18 (`fee/[id]`), T19 (`outcome/[id]`), T21 (`documents/outcome/[id]`).

**This is a real, pre-existing, verifiable bug surface independent of the SQLite→Postgres migration**: around the UTC 18:30 boundary (00:00 IST), sibling routes acting on the same case can disagree about "today" by a full calendar day. It was found independently by 3 of the 5 research agents (mediation group, nonstarter group, outcome group), which increases confidence this is real and not a misreading. **Recommendation, not yet implemented**: standardize every transaction on `officeDate()`/`officeTime()` as part of the Postgres port (since the code is being touched anyway), rather than porting the inconsistency forward unchanged. This is a judgment call for the next batch's scope, not decided here.

**SQLite-specific date/time constructs found, needing explicit Postgres rewrites (not just schema changes):**
- `time('now')` (raw SQLite scalar function) — `app/api/pim/nonstarter/form3/[id]/route.js:392`, `app/api/pim/nonstarter/authority/[id]/route.js:202`. No direct Postgres equivalent; needs `to_char(now() AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS')` or, better, replacement with the shared `officeTime()` JS helper (also fixes the IST inconsistency at the same two call sites).
- `char(10)` (SQLite newline function) — `app/api/pim/mediator/reassign/[id]/route.js:159`, `app/api/pim/fee/[id]/route.js:427-429`. Postgres equivalent is `chr(10)`.
- `CURRENT_TIMESTAMP` bare SQL literal — appears in the majority of `pim_cases.updated_at`/`closed_at` UPDATEs across nearly every transaction. Syntactically valid in Postgres too, but the **returned shape changes**: SQLite renders it as a UTC text string; Postgres returns a native `timestamptz`. This is already handled centrally by `lib/pim-postgres.js`'s deliberate choice to leave `timestamptz` parsing at its default (Date-object, lossless via `JSON.stringify`) — confirmed compatible, no further action needed here.
- `julianday()` — **not found** anywhere in the mutation code (only relevant to date-arithmetic, and the app instead uses JS-side `addDays()` with a fixed `+05:30` offset — `lib/pim-time.js:45-55` — which is portable as-is since it's plain JS, not SQL).

**`date` vs `timestamptz` classification, confirmed against the live schema** (not assumed): every column populated by `officeDate()`/user-supplied calendar dates (`received_date`, `application_date`, `registration_date`, `scheduled_date`, `actual_date`, `docket_date`, `document_date`, `outcome_date`, etc.) is Postgres `date` in the applied schema — correct, and already handled by the custom type parser in `lib/pim-postgres.js` (returns a plain `'YYYY-MM-DD'` string, matching SQLite's behavior exactly). Every column populated by `CURRENT_TIMESTAMP`/`datetime('now')`-equivalent instants (`created_at`, `changed_at`, `updated_at`, `closed_at`) is Postgres `timestamptz` — also already correctly handled (default Date-object parsing, deliberately left un-overridden per `lib/pim-postgres.js`'s own header comment). **No schema change is needed or recommended here** — the Phase 2 schema design already got this right.

One genuinely nuanced case, specific to mediation sessions (T17): `actual_start_time`/`actual_end_time` are wall-clock times for a given `actual_date`, stored as plain strings with no combined date+time instant column, and duration is computed by subtracting minutes-of-day in JS (`lib/... mediation/session/[id]/route.js:123-182`). **This must stay `date` + separate time-as-text columns in Postgres, not be "improved" into a `timestamptz`** — doing so would be a semantic change beyond the scope of a DB-engine port.

---

## I. Cross-database (SQLite/Postgres hybrid) dependencies (batch item 10)

**The one confirmed hybrid-read precedent already exists and was deliberately designed, not accidental**: Batch 4's `listUsers`/`getUser` (`lib/pim-data/users.js`) reads identity fields from PostgreSQL but `active_sessions` from SQLite's `pim_user_sessions`, because sessions stay SQLite-authoritative by design. That precedent is a **read-only** GET route, though — none of the 26 workflow transactions in this batch's scope are reads; they are all mutations, and mutations have a stricter constraint: **`withTransaction()` cannot make a write atomic across two separate database engines.** A Postgres transaction commits or rolls back only its own statements; it has no visibility into, and no rollback control over, anything written to SQLite in the same logical operation.

**Audited for this specific risk, across all 26 transactions**: **none of the 26 mutation transactions currently reads SQLite state that would need to remain SQLite-authoritative after a Postgres port**, with one narrow, already-known exception: `requirePermission()`/`can()` (the permission check that runs before every one of the 26 routes) reads the SQLite `users`/session state to authenticate the actor — but this happens **before** the transaction opens, as a separate, prior, already-completed step, not as a read *inside* the transactional business logic. This is the same pattern already established and approved for the read-side migration (Batches 1-4): auth stays SQLite, runs first, and its result (a resolved `user.id`) is simply passed as a plain value into the (eventually Postgres) transaction — no live cross-database read occurs *during* the transaction itself.

**This means none of the 26 transactions are currently "double-database-atomic" in a way `withTransaction()` would need to fake.** The one genuine constraint carried forward is the **identity-bridge prerequisite** already covered in §F: every workflow mutation writes a `*_by` column that's an FK into Postgres `users`, and that FK will not resolve until the sync script runs. This is a **sequencing** dependency (sync must run before any mutation is ported), not an atomicity problem across two databases.

**If a future transaction is ever found that genuinely needs to read live SQLite session/auth state *during* its business-logic write (not just as an upfront permission gate)**, that would need to be flagged as requiring special treatment (e.g., re-verifying the permission check inside the transaction with a fresh read, or restructuring the operation) — none of the 26 audited here fall into that category.

---

## J. External side effects (batch item 11)

Searched for filesystem writes, DOCX/PDF generation, and any operation with an effect outside the database, across the transaction-relevant code paths. Findings, precisely located relative to each transaction's DB-transaction boundary (not assumed — each was independently traced by an agent that also verified my initial finding on T21):

| Transaction | Filesystem write? | Relative to DB tx | Safety implication |
|---|---|---|---|
| T6 (Form-2 document gen) | Yes — `fs.mkdirSync`/`fs.writeFileSync` via `generateForm2Document()` (`lib/pim-document.js:747-790`) | **INSIDE** the `db.transaction()` callback (`documents/form2/[id]/route.js:146-150`, between the transaction's open at `114` and close at `222`) | A DB rollback *after* the file write (e.g., the subsequent `INSERT pim_documents` fails) leaves an orphan file on disk — **but** better-sqlite3's synchronous transaction model means the whole DB write only happens after the (already-completed) file write, so this is not a *new* risk, just an existing one that becomes more visible once the transaction becomes async: a slow/failing filesystem call would hold the Postgres transaction's row locks open longer than necessary. |
| T21 (Documents/outcome) | Yes — same `fs.mkdirSync`/`fs.writeFileSync` pattern, via `generateOutcomeDocument()` | **BEFORE** the `db.transaction()` opens (`documents/outcome/[id]/route.js:209` call, transaction opens at `214`) | Confirmed safe pattern: if the DB transaction later fails, the file is never referenced by any committed DB row (only an orphan file on disk, never a dangling DB pointer to a missing file). If `generateOutcomeDocument()` itself throws, nothing is written to either the filesystem or the DB. |
| T22 (Documents/Form-3) | Yes — same pattern, via `generateForm3()` | **BEFORE** the `db.transaction()` opens (`documents/form3/[id]/route.js:61-65`, transaction opens at `67`) | Same safe pattern as T21. |
| T5 (Form-2 issue) | No direct filesystem write, but **hard-depends** on T4/T6 having already produced a `pim_documents` row with a populated `file_path` — checked via a guard read (`form2/issue/[id]/route.js:258-267`) before dispatch is allowed | n/a | Cross-transaction data dependency, not an atomicity problem — T5 will simply throw (correctly) if T4/T6 hasn't run yet for this notice. |
| T20 (Outcome approve) | No direct filesystem write, but the **statutory gate** requires a current `pim_documents` row (populated by T21) to exist before SETTLED/FAILED closure is allowed (`outcome/approve/[id]/route.js:319-359`) | n/a | Same cross-transaction dependency pattern as T5/T4. This is the legally-significant one — see §G/Risks. |
| All other 21 transactions | None found | — | — |

**Recommendation carried forward, not yet implemented**: preserve the "generate the file first, then record its path in a DB transaction" pattern (T21/T22's shape) as the model for any future document-generation route, and treat T6 as the one that should be *changed* to match that shape during its eventual Postgres port — moving its `fs.writeFileSync` call to before `withTransaction()` opens, both for consistency with its siblings and to avoid holding a Postgres transaction open across a filesystem operation. This is a design recommendation for a later batch, not an action taken here.

**Confirms the standing architecture decision is intact**: `pim_documents.file_path` is (and remains, per the live schema) a local filesystem path (`text not null`), not a Supabase Storage URL — consistent with the "no Supabase Storage" decision from the earlier architecture-change turn. Nothing in this audit found any code path that uploads a generated document anywhere other than local disk under `storage/pim/<year>/<pimNumber>/<FORM-X>/`.

---

## K. PostgreSQL transaction mechanism (batch item 12) — verified

`lib/pim-postgres.js:118-121`:
```js
async function withTransaction(fn) {
  const sql = getSql();
  return sql.begin((tx) => fn(tx));
}
```
Confirmed: this is `postgres.js`'s real `sql.begin()`, issuing actual `BEGIN`/`COMMIT`/`ROLLBACK` over the direct Transaction-Pooler connection (`prepare: false`, per Supabase's pgbouncer requirement, already configured) — **not** a sequence of independent `@supabase/supabase-js` REST calls, and **not** using the anon client for writes. `fn` receives a transaction-scoped `tx` tagged-template client; every statement that must be part of the atomic unit must be issued through `tx`, not the shared `getSql()` client. The intended pattern (`const row = await tx\`INSERT ... RETURNING id\`; ...`) is directly compatible with every transaction audited in this document — no transaction found here needs anything beyond what this mechanism already provides.

**One universal prerequisite found by every research agent, independently, for every one of the 26 transactions**: none of the helper functions these transactions call (`getStatusId`, `getEventId`, `addStatusHistory`, `addDocket`, `completeTask`, `createPendingTaskIfNotExists`, `createFreshNotice`, and all the transaction-local helpers in `lib/pim-nonstarter.js`, `lib/pim-op-response.js`, `lib/pim-approval.js`, `lib/pim-scrutiny.js`, `lib/pim-legacy-import.js`) currently accept a transaction-scoped client — they all call the module-level `db` singleton directly. **Every one of them must be refactored to accept and thread through a `tx` parameter (and become `async`) before any transaction that uses them can be safely ported to `withTransaction()`.** This is flagged once here as the single most repeated, highest-leverage prerequisite across the whole audit (referenced as "Finding A" in the outcome/documents agent's report, and independently identified by all 4 other agents under different names).

Also confirmed safe and unchanged: the direct-Postgres write connection is not subject to the Phase 4 RLS SELECT-only policies (that gate only PostgREST/anon-key access) — already settled in `docs/phase6-migration-design.md` §7, re-confirmed here, no new decision needed.

---

## L. Test strategy for the first mutation (batch item 13)

Applies to whichever transaction is chosen as the first proof-of-transaction implementation (§G below nominates intake, T1). The fixture and test list is written generically so it transfers to T1 specifically:

- **Successful transaction**: happy-path insert with 1 applicant + 1 opposite party, no address, no advocate — assert all 14 rows exist with correct FK linkage.
- **Generated IDs**: assert the returned `caseId` matches the row actually inserted (via a fresh `SELECT`), and that every child row's FK column matches that id — not just that *some* id was returned.
- **All child rows**: assert `pim_parties` (×2), `pim_case_parties` (×2), `pim_fees` (×1), `pim_status_history` (×1), `pim_docket` (×1), `pim_tasks` (×1) all exist and reference the correct `case_id`.
- **FK relationships**: assert `pim_fees.party_id` resolves to the *primary applicant*, not just any party (exercises `getPrimaryPartyId`'s translated logic).
- **Audit entry**: N/A for T1 specifically (T1 doesn't write `audit_log` — confirmed in §G); if a different transaction is chosen, adapt this line.
- **Rollback after an intentional failure**: inject a missing `status_master` row for `RECEIVED` (or a similar guaranteed-throw condition) and assert **zero** rows exist afterward in `pim_cases`, `pim_parties`, `pim_case_parties`, `pim_fees` — this is the mandatory test per the batch's explicit instruction; a happy-path pass alone does not prove the transaction.
- **No partial rows after rollback**: same assertion as above, explicitly re-stated as its own check across every touched table, not just `pim_cases`.
- **Repeated execution / idempotency**: T1 is not naturally idempotent (each call creates a new case) — the relevant test here is that running it twice with different `receivedNumber`s produces two independent, non-interfering cases, not a duplicate-detection test (T1 has no duplicate guard, unlike T25's `preventDuplicate`).
- **Permission denial**: call without `ENTER_APPLICATION` permission (e.g., a `secretary`-only session) and assert a 403/401-shaped rejection before any DB access.
- **Invalid input**: missing `receivedNumber`/`receivedDate`/`applicationDate`, malformed `applicationFee` (wrong `payee` string, missing `ddNumber`) — assert these throw during `validateReceivedApplication`, **before** the transaction ever opens (confirmed in §B/§D as a pre-transaction guard), so no DB write of any kind is attempted.
- **Duplicate/conflict behavior**: N/A for T1 (no uniqueness guard beyond the schema's own constraints); the partial-unique-index test (below) covers the one real invariant.
- **NULL handling**: assert `pim_cases.pim_number IS NULL` after intake (registration hasn't happened yet), and that an applicant with no `advocate.name` produces no `pim_advocates`/`pim_case_advocates` rows at all (not rows with NULL fields).
- **Date/time behavior**: assert `pim_cases.received_date`/`application_date` round-trip as plain `'YYYY-MM-DD'` strings (via the existing `date` type parser), not JS Date objects — this is the same class of assertion already proven correct in Batches 2-3 for the read-side ported routes, and should be re-confirmed on the write side.
- **The partial-unique-index invariant**: insert a case with 2 applicants, assert exactly one has `is_primary=1`, and separately assert that a hand-crafted attempt to insert a second `is_primary=1` row for the same `(case_id, role)` is rejected by Postgres's own constraint (`idx_case_parties_one_primary_per_role`) — proving the DB-level backstop carries over, not just the application-level logic.

---

## M. Production test data policy (batch item 14)

No change from the precedent already established and used successfully in Phases 4 and Batches 1-4: any live-fixture verification against the `pim-system` project must use an unmistakable test identifier (e.g., `TEST-B5-*`/`test-b5-*` prefixes, following the `test-b4-*` convention from Batch 4), the minimum rows required to exercise the transaction, and must be fully deleted with cleanup explicitly verified (a `remaining: 0` check) afterward — via the Supabase MCP `execute_sql` tool, which uses a separate, already-authorized management connection, not the app's own (still-unconfigured) `SUPABASE_DB_URL`. No real PIM case data exists in the live project today (confirmed zero rows in Phase 0/2 and re-confirmed multiple times since), so there is no real-case contamination risk — but the "minimum rows, unmistakable identifier, verified cleanup" discipline still applies to whatever reference data (status_master, event_types, task_types rows) the fixture needs, since those tables *do* already have real production rows from the Phase 2 seed and must not be polluted with test-only codes.

---

## Final Report

### A. Transaction matrix
See §A above — concise table covering all 26 transaction groups.

### B. Case intake analysis
See §B above. Actual statement sequence: case insert → party/address/advocate inserts (loop) → primary-party lookup → fee insert → status guard → status update → status-history insert → event guard → docket insert → task-type lookup → task insert. 14 statements minimum, no hard dependency on any other workflow stage, does **not** touch `pim_scrutiny`/`pim_notices`/`pim_responses`/`pim_mediator_assignments`/`mediation_sessions`/`pim_outcomes`/`pim_documents`/`audit_log`.

### C. Generated-ID analysis
See §C above. 37 `lastInsertRowid` occurrences catalogued across all 26 transactions plus legacy import's deep chain; every one replaces cleanly with `INSERT ... RETURNING id` given the live schema's `bigint generated always as identity` columns. Only 3 occurrences are genuine same-transaction insert→insert/update FK chains (Form-2 doc-gen, outcome doc-gen, address-correction's address→notice link) — these three need careful `await`-ordering in the Postgres port; the other 34 are simple "insert, read back id, return it" patterns.

Separately: `lib/pim-approval.js`'s `generatePimNumber()` is a non-`lastInsertRowid` but equally significant ID-generation risk — a MAX+1-over-`LIKE`-scan with zero unique-constraint backing, used by both T3 (approval) and T25 (legacy import).

### D. Audit-log analysis
See §G above. Only T25 (legacy import) writes `audit_log`, and it does so genuinely inside the same atomic transaction as everything else — confirmed by direct lexical-scope inspection, not inferred. Every other one of the 25 workflow transactions relies exclusively on `pim_status_history`/`pim_task_history`/`pim_docket` as its audit trail. For Postgres migration: keep legacy import's audit_log write inside its `withTransaction()` callback; no new audit_log writes are recommended for the other 25 as part of this migration.

### E. Date/time analysis
See §H above. `officeDate()`/`officeTime()` (Asia/Kolkata) is the correct, intended helper and is used correctly in roughly half the transactions; the other half use a locally-redefined UTC-based `today()` — a genuine pre-existing timezone bug, found independently by 3 separate research passes, that should be resolved (standardized on the shared IST helper) as part of any future write-side port, though that decision is deferred to whichever batch actually implements the first mutation. `time('now')` and `char(10)` are the two concrete SQLite-only SQL constructs requiring rewrite (`to_char(...)`/`officeTime()` and `chr(10)` respectively). `date` vs `timestamptz` column typing in the live schema is already correct and requires no change.

### F. Cross-database dependencies
See §I above. No mutation transaction currently performs a live SQLite read *during* its business-logic write — the only SQLite dependency any of the 26 transactions has is the upfront `requirePermission()` auth check, which completes and resolves to a plain `user.id` value *before* the transaction opens, exactly matching the pattern already approved for the read-side migration. The one real cross-database constraint is sequencing, not atomicity: every workflow mutation writes an FK to Postgres `users`, and none of those FKs will resolve until `scripts/sync-users-to-postgres.js` actually runs (still blocked on the unset `SUPABASE_DB_URL`, unchanged since Batch 1).

### G. First mutation candidate
**New application intake (T1)**, based on the following factual characteristics, not a subjective preference: (1) the only multi-table transaction in the audit with a linear, near-branchless statement sequence after its upstream validation completes (only 2 conditional guards, both abort-only, both structurally always-false in current usage per §E's classification); (2) 3 `lastInsertRowid` sites, none requiring the delicate same-transaction insert→insert FK-chaining that the document-generation and address-correction transactions need; (3) its one DB-level invariant (`idx_case_parties_one_primary_per_role`, a partial unique index) already ports to Postgres syntactically unchanged, giving a real proof point that Postgres-side invariants can be trusted alongside application logic; (4) it does not depend on any other transaction having already run (unlike T5/T20, which hard-depend on document generation, or T15-T17, which depend on T13/T14); (5) it does not touch the higher-risk shared helper modules (`lib/pim-op-response.js`, `lib/pim-fresh-notice.js`) that fan out across 3-4 other transactions each; (6) it exercises the genuinely representative pattern every later transaction will need proven — multi-table insert, case-status write, status-history/docket audit-trail write, and a generated-ID feeding several dependent rows — without also requiring the concurrency hardening that T3's PIM-number generation or T11/T12's TOCTOU guard-placement issues would force to be solved in the same pass.

### H. Migration sequence (next 3-5 mutation batches, in dependency order)
1. **Batch 5B**: Port the shared helper layer first, in isolation — `lib/pim-op-response.js`'s and `lib/pim-nonstarter.js`'s and `lib/pim-approval.js`'s `getStatusId`/`getEventId`/`addStatusHistory`/`addDocket`/`completeTask`/`createPendingTaskIfNotExists` families to accept a `tx` parameter and become `async`, with unit tests against a throwaway Postgres fixture, before any route is touched. This is the single highest-leverage, lowest-risk piece of groundwork identified across the whole audit (referenced by every agent).
2. **Batch 5C**: Implement T1 (intake) end-to-end on Postgres, following §L's test strategy in full, including the mandatory rollback test. Prove the pattern once, thoroughly, before reusing it.
3. **Batch 5D**: Implement T2 (scrutiny) and T13/T14 (mediator assignment/reassignment) — moderate-complexity transactions that reuse the now-proven helper layer and the now-proven `withTransaction()` pattern, while also being the first to require the concurrency-hardening (unique indexes / row locks) flagged in §I's risk list for the "one ACTIVE assignment per case" and similar guard-then-write invariants.
4. **Batch 5E**: Implement T21/T22 (document-metadata transactions) together with a decision on T6's filesystem-write-before-vs-inside-transaction inconsistency (§J) — these are self-contained, low-to-moderate risk, and resolve the one architecturally distinct pattern (fs I/O near a DB transaction) before it's copied into any further routes.
5. **Batch 5F**: Implement T3 (approval) and T25 (legacy import) last among the "core" set, specifically because both share the unsafe `generatePimNumber()` pattern (§C) — this batch's actual first deliverable should be the Postgres-side redesign of PIM-number generation (a `SELECT ... FOR UPDATE` on a counter row, a dedicated sequence, or an advisory lock), tested for real concurrent-request safety, before either transaction is ported.

### I. Risks (must be solved before mutation migration, beyond what's already covered above)
1. **Helper-function `tx`-threading is a hard prerequisite for nearly every transaction** (§K) — until this is done, no transaction beyond the very simplest can be safely ported.
2. **Every "guard read, then write" invariant in the app (one-ACTIVE-assignment-per-case, one-SCHEDULED-session-per-case, one-MEDIATION_FEE-row-per-case, one-pending-task-per-type-per-case, one-is_current-document-per-type, one-primary-applicant-per-case, and `generatePimNumber`'s sequence) is enforced only by application-level SELECT-then-INSERT logic, safe today only because `better-sqlite3` serializes the whole process.** None of these carry that safety property into Postgres's real connection concurrency. Each needs an explicit decision (partial unique index, `SELECT ... FOR UPDATE`, advisory lock, or a Postgres sequence) before its transaction is ported — this is the single largest, most-repeated risk surface in the entire audit, independently surfaced by all 5 research agents.
3. **The TOCTOU guard-placement issues in T8 (guards entirely before the transaction) and T11 (split guards)** need redesign, not mechanical translation (§D).
4. **The non-throwing "conflict" early-return idiom** (T5, T12, T17, T20) must be preserved exactly, with explicit documentation so a future refactor doesn't silently change it (§D).
5. **The user-identity-bridge sequencing dependency** (§F) — no workflow mutation can be ported until `scripts/sync-users-to-postgres.js` actually runs, which itself is blocked on `SUPABASE_DB_URL` (unresolved since Batch 1, unrelated to anything in this batch's control).
6. **The UTC-vs-IST `today()` inconsistency** (§H) is a pre-existing correctness bug, independent of the DB engine, that should be resolved in the same pass as whichever transaction touches each affected route, rather than carried forward silently.
7. **T20's statutory Form IV/V gate has zero DB-level backstop** (§A/§J) — this is the one transaction in the whole audit with direct legal/regulatory consequences if a migration bug ever let a case close without its mandatory document; it warrants the most thorough test coverage of any single transaction when its turn comes.

### J. Stop
This batch is audit/design only. No POST/PATCH/PUT/DELETE route, `lib/db.js`, transaction code, business logic, schema, auth, or session code was modified. The only new file is this document. Waiting for review before any implementation (Batch 5B or otherwise) begins.
