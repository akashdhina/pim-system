# Phase 6 Batch 5E — Scrutiny (T2) Migration Mapping

**Scope: only `POST /api/pim/scrutiny/[id]` (T2, `saveScrutiny`). No other mutation, no read-route migration.**

Written **before** implementation, from a fresh read of the current code (not from `docs/phase6-transaction-readiness.md` alone). Section 9 (results) is appended after the tests ran.

## 1. Selected transaction

| | |
|---|---|
| Route | `POST /api/pim/scrutiny/[id]` — `app/api/pim/scrutiny/[id]/route.js`, `requirePermission(request, "COMPLETE_SCRUTINY")` (roles: `aa`, `secretary`, `admin`) |
| SQLite function | `saveScrutiny(caseId, data, userId, dbClient = db)` — `lib/pim-scrutiny.js` (kept **unchanged** as the rollback/reference implementation) |
| PostgreSQL function | `saveScrutinyPg(caseId, data, userId)` — `lib/pim-data/scrutiny.js` (new) |

**Why this is T2.** It is the only scrutiny mutation in the codebase: `grep saveScrutiny` finds exactly one caller (the POST route), and nothing else in `app/` or `lib/` writes `pim_scrutiny` / `pim_scrutiny_attempts` except legacy import (T25, out of scope).

**Deliberately not migrated:** `GET /api/pim/scrutiny/[id]` → `getScrutinyCase` (read-only page loader, same module, unrelated to the T2 mutation). It still reads SQLite. See §8 risk R1.

**No prerequisite refactor was needed.** Batch 5B already gave the SQLite side a `dbClient` parameter; the PostgreSQL side needs nothing from it (it has its own module).

## 2. Exact statement-by-statement contract (SQLite, re-verified)

Pre-transaction: three pure-JS validations, **no database read at all** before the transaction opens.

| # | Step | Throws / guard |
|---|---|---|
| V1 | `Number(caseId)` integer > 0 | `Valid case ID is required.` |
| V2 | `data` is a non-null object | `Scrutiny data is required.` |
| V3 | `data.scrutinyResult ∈ {COMPLETE, DEFECT}` | `Scrutiny result must be COMPLETE or DEFECT.` |

Inside the single transaction (13 SQL statements: 6 reads + 7 writes — the readiness audit's "~9-10" was an undercount; its table list is correct):

| # | Statement | R/W | Guard (throws) |
|---|---|---|---|
| 1 | `SELECT c.*, sm.code AS status_code, sm.name AS status_name FROM pim_cases c LEFT JOIN status_master sm … WHERE c.id=? LIMIT 1` | R | not found → `PIM case not found.` |
| 2 | (JS) `status_code ∈ {RECEIVED, SCRUTINY_PENDING}` | — | `This case is not available for scrutiny. Current status: <status_name>` (`statusCode=409`) |
| 3 | `SELECT id,status,task_type_code FROM pim_tasks WHERE case_id=? AND task_type_code='SCRUTINY' AND status='PENDING' ORDER BY id LIMIT 1` | R | none → `Pending SCRUTINY task was not found.` (`409`) |
| 4 | (JS) `ddAmount` coercion | — | `DD amount must be a valid non-negative number.` |
| 5 | (JS) build `scrutiny` object (flags → 1/0, trims, `scrutinised_at = new Date().toISOString()`) | — | — |
| 6 | (JS) DEFECT requires trimmed `defectDetails` | — | `Defect details are required when scrutiny result is DEFECT.` |
| 7 | `SELECT * FROM pim_scrutiny WHERE case_id=? LIMIT 1` | R | — |
| 8 | existing → `UPDATE pim_scrutiny … WHERE case_id=?`; else `INSERT INTO pim_scrutiny (…)` | W | — |
| 9 | `SELECT COALESCE(MAX(attempt_no),0)+1 FROM pim_scrutiny_attempts WHERE case_id=?` then `INSERT INTO pim_scrutiny_attempts (…)` (both branches of 8) | R+W | — |
| 10 | (JS) result → next status / event / texts | — | — |
| 11 | `SELECT id FROM status_master WHERE code=<next>` | R | `Status '<code>' is missing.` |
| 12 | `UPDATE pim_cases SET current_status_id=?, scrutiny_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?` | W | — |
| 13 | `INSERT INTO pim_status_history (case_id, from_status_id=<status read in 1>, to_status_id, reason, changed_by)` | W | — |
| 14 | `SELECT id FROM event_types WHERE code=<event>` | R | `Event '<code>' is missing.` |
| 15 | `INSERT INTO pim_docket (case_id, docket_date=officeDate(), event_type_id, entry_text, action_required, next_date=rectificationDate‖null, entered_by)` | W | — |
| 16 | `UPDATE pim_tasks SET status='COMPLETED', completed_date=officeDate(), completed_time=officeTime(), completed_by, remarks WHERE id=? AND status='PENDING'`; `changes !== 1` → throw; then `INSERT INTO pim_task_history (task_id, 'PENDING','COMPLETED', changed_by, remarks)` | W | `The pending scrutiny task could not be completed.` (`409`) |

Returns `{ caseId, status, scrutinyResult, completedTaskId, nextTaskId: null }`.

**Tables touched (9):** `pim_cases` (R/W), `status_master` (R), `event_types` (R), `pim_tasks` (R/W), `pim_scrutiny` (R/W), `pim_scrutiny_attempts` (R/W), `pim_status_history` (W), `pim_docket` (W), `pim_task_history` (W).
**Not touched:** `audit_log` (T2 has no audit_log write — verified by grep; trail is status_history/docket/task_history), `pim_notices`, `pim_responses`, `pim_outcomes`, `pim_documents`, `pim_fees`.

`error.statusCode = 409` is set on three errors, but the route's catch only maps `error.status` 401/403 (`authErrorResponse`); every other thrown error returns HTTP **400**. So 409 is informational today. The PG version sets it identically so nothing that inspects it can drift.

## 3. Status / docket / task / attempt mapping

| Result | Case status (from → to) | `pim_cases.scrutiny_status` | Docket event | Docket `entry_text` / `action_required` | Status-history reason | Task remarks |
|---|---|---|---|---|---|---|
| COMPLETE | {RECEIVED ‖ SCRUTINY_PENDING} → `SECRETARY_APPROVAL_PENDING` | `COMPLETE` | `SCRUTINY_COMPLETED` | "Scrutiny completed and file put up for Secretary approval." / "Secretary approval" | "Scrutiny completed; file put up for Secretary approval." | "Scrutiny completed and file put up for Secretary approval." |
| DEFECT | {RECEIVED ‖ SCRUTINY_PENDING} → `DEFECT_PENDING` | `DEFECT` | `DEFECT_NOTED` | "Defect / rectification required during scrutiny." / "Rectification required" | `defect_details` ‖ "Defect / rectification required." | "Scrutiny completed with defects requiring rectification." |

- **Tasks:** completes the existing pending `SCRUTINY` task (`PENDING → COMPLETED`, plus one `pim_task_history` row). **Creates no task** — `nextTaskId` is always `null` (no `SECRETARY_APPROVAL` task type exists; the next action is resolved from the case status).
- **Docket:** exactly one entry per call.
- **Scrutiny attempt:** exactly one `pim_scrutiny_attempts` row per call (both branches), `attempt_no = MAX+1` (starts at 1). `form1_complete` and `vakalat_available` are never populated by any caller (always `NULL`; the `pim_scrutiny` INSERT omits them).
- **`pim_scrutiny`:** one current-state row per case (`INSERT` first time, `UPDATE` thereafter).
- **User attribution FKs** (all = `userId`, all `REFERENCES users(id)`): `pim_scrutiny.scrutinised_by`, `pim_scrutiny_attempts.scrutinised_by`, `pim_status_history.changed_by`, `pim_docket.entered_by`, `pim_tasks.completed_by`, `pim_task_history.changed_by`.

## 4. Helpers: reuse decision (`lib/pim-data/workflow-helpers.js`)

Reviewed function by function against T2 semantics — **not** reused merely for a matching name:

| Helper | Decision | Reason |
|---|---|---|
| `addStatusHistory(tx, …)` | **Reused** | Byte-for-byte the same statement as T2's inline INSERT; no error message involved. |
| `getStatusId` | Not reused | Throws `Status not found: X`; T2's contract is `Status 'X' is missing.` — reusing it would change an error message. |
| `getEventId` / `addDocket` | Not reused | `addDocket` does its own `getEventId` with the `Event not found: X` message; T2's contract is `Event 'X' is missing.` |
| `getPendingTask` | **Not reused — real semantic mismatch** | Helper orders `id DESC` (newest); T2 orders `id` ASC (oldest). With duplicate pending tasks the two would complete *different* tasks. |
| `createPendingTaskIfNotExists` | N/A | T2 creates no task. |
| `completeTask` | No PG equivalent exists | SQLite's is local to `lib/pim-scrutiny.js` with a scrutiny-specific message; ported locally. |

`workflow-helpers.js` is **not modified** (zero risk to Batch 5D). The T2-specific lookups/guards live in `lib/pim-data/scrutiny.js`; none is generic enough to be shared as-is (each carries scrutiny-specific messages/ordering).

## 5. `RETURNING id` / generated IDs

`grep lastInsertRowid lib/pim-scrutiny.js` → **0 occurrences**. T2 has no same-transaction insert→insert ID chain: every child row references either the case id (input) or the task id (read by statement 3, not generated). So there is **no `lastInsertRowid` to convert** and no ID inference of any kind (no `SELECT MAX(id)`, no latest-row lookup).

The single SQLite-result-object dependency is `updated.changes !== 1` in `completeTask`. PG equivalent: `UPDATE … RETURNING id` and require exactly one returned row.

## 6. PIM number, dates, engine-specific SQL

- **No PIM-number generation** anywhere in T2 (`generatePimNumber` belongs to T3). Nothing added.
- **Dates:** `officeDate()` for `docket_date` and `completed_date`; `officeTime()` for `completed_time` — called separately in the same order as SQLite. `scrutinised_at` stays `new Date().toISOString()` (a UTC *instant*, correct for a `timestamptz`; same value written to `pim_scrutiny` and the attempt row). `updated_at = CURRENT_TIMESTAMP` kept verbatim. **No `CURRENT_DATE`.** No UTC/IST inconsistency found inside T2 (unlike T4/T8/T15/T16/T18/T19/T21) — nothing carried forward.
- **Checklist flags** are PG `smallint` (Phase 2 deliberately kept tri-state semantics), so they are written as `1`/`0` exactly like SQLite — no boolean conversion.
- **Engine strictness difference (documented, preserved, not "fixed"):** SQLite stores any text in `dd_date` / `rectification_date`; PG `date` rejects malformed input, which aborts (and fully rolls back) the transaction with a PG parse error. The UI uses `<input type="date">`, so this is reachable only through direct API misuse.
- No `time('now')`, `datetime('now')`, `char(10)`, `julianday()`, `AUTOINCREMENT` in T2.

## 7. Concurrency / invariants (Step 10)

SQLite's whole-database write serialization protects, implicitly, every read-then-write in T2. Under PostgreSQL (`READ COMMITTED`, real parallel connections) each was checked against what the live schema already enforces (verified via `pg_constraint`, Batch 5E probe):

| Invariant | SQLite protection | PostgreSQL backstop (already in place) |
|---|---|---|
| One T2 commit per pending SCRUTINY task (double-click / repeated submit) | serialization → 2nd caller hits the status guard | `UPDATE pim_tasks … AND status='PENDING'` + exactly-one-row check. Row lock serializes; the loser re-evaluates the WHERE after the winner commits → 0 rows → throws → **whole transaction rolls back**. It is the *last* write, so nothing the loser wrote can survive. |
| One `pim_scrutiny` row per case | serialization | `pim_scrutiny_case_id_key UNIQUE (case_id)` |
| No duplicate `attempt_no` (`MAX+1`) | serialization | `pim_scrutiny_attempts_case_id_attempt_no_key UNIQUE (case_id, attempt_no)` |
| Status sequencing (`RECEIVED`/`SCRUTINY_PENDING` only) | serialization | Stale status read is harmless: a transaction acting on stale state cannot commit past the task guard above. |
| Task duplication | n/a | T2 creates no tasks. |
| Docket / status-history duplication | serialization | Only a committed T2 writes them; at most one T2 commits per pending task (row 1). |

**Conclusion: no new constraint or locking is genuinely required for correctness**, so no schema change was made and I did not stop. Two things are reported rather than fixed:

1. **Race-window error text differs from SQLite.** In a true simultaneous double-submit, the loser gets `The pending scrutiny task could not be completed.` or a raw unique-violation, whereas SQLite's serialization would give it `This case is not available for scrutiny. Current status: …`. Sequential repeats (the normal double-click, where the 2nd request arrives after the 1st commits) give the **identical** SQLite message. Exact race-window parity would need `SELECT … FOR UPDATE` on the case row in statement 1. That is a locking mechanism, so it is documented as an optional hardening for review, **not applied**.
2. **Pre-existing gap, not introduced here:** `pim_tasks` has no unique index on `(case_id, task_type_code) WHERE status='PENDING'` (affects task *creation* in T1/T7/others, not T2, which only completes).

**Pre-transaction reads / guards:** none touch the database. The only pre-transaction step outside T2's pure validation is the route's `requirePermission` (SQLite session auth, unchanged) and the integer case-id check.

## 8. Risks / gaps found (not fixed — out of scope)

- **R1 — scrutiny page loader still reads SQLite.** `GET /api/pim/scrutiny/[id]` → `getScrutinyCase` reads SQLite, so the scrutiny *page* cannot load a case created by T1 (which lives only in PostgreSQL). The POST now writes PostgreSQL. Verified read-only: SQLite production `pim_cases` is empty (0 rows) and PG's `pim_cases` is empty, so no data is stranded and there is no numeric-ID collision today. The same split already exists for `GET /api/pim/nonstarter/[id]` after 5D. Needs a read-side batch before real users scrutinise PG cases through the UI. **Closed in Batch 5F** (`docs/phase6-batch5f-read-loaders-migration.md`): the scrutiny and non-starter GETs now read PostgreSQL.
- **R2 — race-window message parity** (see §7.1).
- **R3 — engine strictness on `date` inputs** (see §6).
- **R4 — orphaned server-side transactions.** `idle_in_transaction_session_timeout` is `0` on the project and the pooler did not reap a stranded `idle in transaction` backend in 15+ minutes (see §9). A dropped connection mid-request can therefore leave row locks that block later work on that case. Applies to every migrated transaction, not just T2. Config decision, not made here.

## 9. Results

### Files

| | |
|---|---|
| Created | `lib/pim-data/scrutiny.js`, `scripts/test-pim-scrutiny-postgres.js`, this document |
| Modified | `app/api/pim/scrutiny/[id]/route.js` (POST now `await saveScrutinyPg(...)`; SQLite `saveScrutiny` still imported, marked, unused; standard `no-require-imports` directive added, matching the T7 route) · `scripts/test-pim-postgres.js` (one line: added the new test script to that test's DB-connection-variable allowlist — every batch has done this; test 8a scans the whole repo) |
| Byte-identical to before | `lib/pim-scrutiny.js`, `lib/pim-data/{workflow-helpers,intake,nonstarter}.js`, `lib/pim.js`, `lib/pim-nonstarter.js`, `lib/pim-op-response.js`, `lib/pim-postgres.js`, `lib/pim-time.js`, the T1 and T7 routes (verified by `git hash-object` before/after) |

### Dedicated test — `node scripts/test-pim-scrutiny-postgres.js` (44 passed, 0 failed)

| | Result | What proves it |
|---|---|---|
| A success | PASS | Real T1 fixture → COMPLETE and DEFECT; every row/column/FK/attribution asserted straight from the tables |
| B rollback | PASS | (1) all 7 T2 writes made inside a caller-owned transaction and verified visible, *then* a forced throw → whole case identical to before (T1 rows untouched, not asserted zero); (2) sentinel invalid `userId` (FK); (3) natural late failure under real concurrency (see J) |
| C id linkage | PASS | Every child row references the exact case/task/status/event ids; T2 has **zero** `lastInsertRowid` (grep-asserted) so **zero `RETURNING id` conversions** were needed beyond the task-UPDATE row count |
| D repeated scrutiny | PASS | Repeat is rejected by the status guard with SQLite's exact message; still exactly one attempt/docket/history row |
| E permission | PASS | The **real route handler** driven with real `requirePermission`: no identity → 401, `chairman` → 403 (both leave PG untouched); `aa` → 200 with the unchanged response shape and the SQLite-resolved `user.id` in all six FK columns; error contract unchanged (HTTP 400) |
| F dates | PASS | `officeDate()` for docket/completed dates, `HH:MM:SS` time, plain `YYYY-MM-DD` strings round-trip, `scrutinised_at` a real instant |
| G status | PASS | RECEIVED→SECRETARY_APPROVAL_PENDING, SCRUTINY_PENDING→DEFECT_PENDING, exact ids; other statuses rejected with exact message |
| H tasks | PASS | Completes the pending task, creates none; no-pending-task guard; duplicates → **oldest** completed |
| I docket | PASS | Exactly one entry per call, exact event/text/action/`next_date` for both results |
| J invariants | PASS | Catalog check of the backstop constraints + 6 attribution FKs; deterministic lock-holder race (below); 5× free double-submit; validation writes nothing; re-scrutiny (existing-row branch, `attempt_no` 1→2); no PIM number / no `audit_log` / no new task |
| P parity | PASS | 13 scenarios run on **both engines**; normalized transcripts (rows, ids stripped, dates tokenized, user tokenized, error message + `statusCode`) compared with `deepStrictEqual` |
| S static | PASS | route ordering; SQLite import kept; module never touches SQLite / `getSql()` / `CURRENT_DATE`; only `addStatusHistory` reused |
| RESIDUE | PASS | exact-ID verification of 17 table/column pairs + row counts of 21 tables equal the pre-run baseline (all 0) |

Concurrency, observed live (not just reasoned):
- **Lock-holder race** (deterministic, no mocking): a second connection holds the pending task's row lock; T2 does *all* its writes, parks on the guarded UPDATE (`pg_stat_activity` confirmed a lock wait), the holder commits, T2's UPDATE matches 0 rows and throws `The pending scrutiny task could not be completed.` (`statusCode 409`); every earlier write rolled back.
- **Free double-submit ×5:** exactly one commits every time. The loser's error was `duplicate key value violates unique constraint "pim_scrutiny_case_id_key"` — i.e. the DB backstop fired, integrity held, but the *message* differs from SQLite's (risk R2).

### Rest of the suite (each script run individually)

| Script | Result |
|---|---|
| test-pim-scrutiny-postgres (this batch) | 44 passed |
| test-pim-postgres (Batch 1) | 10 passed (after the allowlist line above; it had failed 8a) |
| test-pim-intake-postgres (5C) | 15 passed, 1 pre-existing SKIP (PIM-number: N/A to T1) |
| test-pim-nonstarter-postgres (5D) | 11 passed |
| test-pim-tx-context (5B) | 8 passed |
| test-legacy-import, test-auth-lan-http | passed |
| test-pim-cases / -case-detail / -dashboard / -users / -settings | pass; live sections SKIP (they don't call `loadEnvConfig` — known, deliberately not touched) |
| test-pim-rls, test-supabase-auth | pass; live sections SKIP (no service-role key in a plain run) |
| **Not run, deliberately** | `test-pim.js`, `test-received-pim.js` (insert sample cases into the **production** SQLite file, no scratch guard), `test-mediators-smoke.js` (needs a dev server, writes production SQLite) |

`npx tsc --noEmit` clean · `npm run build` succeeded (one pre-existing Turbopack warning at `lib/db.js:13`) · lint: 155 → 153 problems (107 → 104 errors, 48 → 49 warnings): the route's 3 pre-existing `no-require-imports` errors are gone, +1 warning for the intentionally-unused SQLite import.

### Infrastructure findings (not T2 defects)

- The Supabase pooler was **intermittently flaky from this machine** (first-connection `ECONNRESET`/`CONNECT_TIMEOUT`, mid-run DNS `ENOTFOUND`). Three earlier runs were cut short by it.
- A dropped client connection **stranded a server-side transaction `idle in transaction`** holding row locks; Supavisor did not reap it in 15+ minutes and `idle_in_transaction_session_timeout` is `0` on this project. It blocked cleanup until the two orphaned backends (provably this test's own, by last-query text) were terminated. This can happen to *any* transaction in the app, not only T2 — recommend a role-level `idle_in_transaction_session_timeout` (a config decision, not made here).
- Consequently the test script records every fixture case id in a manifest the instant it is created, cleans by exact ids in one batched transaction (with a prefix guard and a `lock_timeout`), retries only connectivity-class errors, and supports `node scripts/test-pim-scrutiny-postgres.js --cleanup-only` to remove stranded fixtures by exact id.
- The full run takes ~9 minutes against the remote pooler.
