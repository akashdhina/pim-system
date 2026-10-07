# Phase 6 Batch 5H-b — Staff-Operated PIM-Number Assignment

Replaces T3 (`lib/pim-approval.js`'s `approvePimRegistration`/`generatePimNumber` — Secretary approval) with a staff-operated, concurrency-safe PostgreSQL allocator. T3's SQLite code is left completely unchanged as a historical/rollback reference, not called anywhere in this batch.

## 1. What changed and why

The pre-existing `generatePimNumber()` computed the next number by scanning `pim_cases.pim_number` with `MAX(...)+1` over a `LIKE` pattern — unsafe under real concurrency and tied to Secretary-approval semantics this project no longer has (PIM is staff-operated; see the Batch 5H-a/5H audit). This batch replaces it with an explicit, atomic PostgreSQL sequence-state table and a staff-facing assignment screen.

## 2. Format (confirmed business rule)

```
PIM/{running_number}/{year}   — no zero-padding
```
Examples: `PIM/1/2026`, `PIM/88/2026`, `PIM/119/2026`. **Not** the legacy code's `PIM/{year}/{padded number}` format. `formatPimNumber(prefix, number, year)` in `lib/pim-data/pim-numbering.js` renders this; the numeric counter itself (`pim_number_sequences.last_number`) is stored separately as a plain integer, never formatted.

## 3. Schema

```sql
CREATE TABLE pim_number_sequences (
  year            INTEGER PRIMARY KEY,
  last_number     INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  initialized_by  BIGINT REFERENCES users(id),
  initialized_at  TIMESTAMPTZ,
  updated_by      BIGINT REFERENCES users(id),
  updated_at      TIMESTAMPTZ
);
```

`last_number` is the **sole authoritative state**: the last number already consumed, never the next number to issue (`last_number = 118` ⟹ next preview is `PIM/119/2026` — verified by dedicated test before any production use). RLS enabled, matching every other table's convention (`pim_read_active_profile`, SELECT-only for `authenticated`; the app's own direct-Postgres connection bypasses RLS, same as everywhere else in this migration).

New master rows (both additive, nothing renamed or removed): `status_master` gains `PIM_NUMBER_PENDING` (id 29) as the staff-operated replacement for `SECRETARY_APPROVAL_PENDING` (id 4, left in place for any legacy-imported case); `event_types` gains `PIM_NUMBER_ASSIGNED` (id 68, category `INSTITUTION`) alongside the existing `PIM_REGISTERED`/`SECRETARY_APPROVAL` events.

## 4. The allocator — `lib/pim-data/pim-numbering.js`

- `previewNextPimNumber(year)` — read-only, never increments `last_number`.
- `initializePimSequencePg(year, lastNumber, userId)` — one-time per year; a second attempt on an already-initialized year fails with a clear business error (relies on the `year` primary key, not an `ON CONFLICT`).
- `assignPimNumberPg(caseId, userId)` — the T3-replacement transaction.

**Same-case concurrency** (the specific property this design centers on): the case row is locked with `SELECT ... FOR UPDATE` **before** the sequence table is ever touched. Two concurrent requests for the *same* case serialize there — the loser only proceeds after the winner's full transaction (through `FORM2_PENDING`) commits, at which point it re-reads the now-current row and fails on the ordinary status guard, never reaching the sequence `UPDATE`. Verified live: exactly one number consumed per case, never two.

**Different-case concurrency**: each locks its own case row (no contention), then both race for the same year's sequence row — `UPDATE pim_number_sequences SET last_number = last_number + 1 ... RETURNING` is itself atomically serialized by PostgreSQL's own MVCC row-level locking, the same "guarded UPDATE" property T2's task-completion guard already relies on. Verified live: two simultaneous different-case assignments always produce sequential, unique numbers.

**Rollback**: the entire operation (lock, sequence increment, case update, status history, docket, FORM2 task) runs inside one `withTransaction(...)` call. A downstream failure rolls the sequence increment back too — verified live via a forced FK violation after the increment.

**Year boundary**: no auto-rollover. An uninitialized year fails cleanly with "sequence not initialized," never silently creating a `last_number = 0` row — opening a year is `INITIALIZE_PIM_SEQUENCE`'s job, deliberately separate from ordinary `ASSIGN_PIM_NUMBER` staff work.

**REGISTERED remains transient**: exactly as T3 already did, the case is written through `PIM_NUMBER_PENDING → REGISTERED → FORM2_PENDING` in the same transaction, with `REGISTERED` recorded as real status-history evidence but never the resting `current_status_id`.

**No fake approval semantics**: the new path never writes `secretary_decision`/`secretary_decision_date` (both stay `NULL`) and never references `SECRETARY_APPROVAL`/`SECRETARY_APPROVAL_PENDING` — verified explicitly by a dedicated test.

## 5. Permissions

```js
ASSIGN_PIM_NUMBER: ["aa", "secretary", "admin"],       // ordinary staff work
INITIALIZE_PIM_SEQUENCE: ["admin"],                     // separately restricted
```
`APPROVE_REGISTRATION` (the old permission) is left in place, unused.

## 6. Legacy import — no competing allocator

`lib/pim-legacy-import.js` previously fell back to `generatePimNumber()` when a legacy case's `pimNumber` was left blank. That fallback is removed: `validateLegacyImport` now rejects any stage requiring `registrationDate` with no `pimNumber` supplied — "PIM number is required for this legacy stage... It cannot be auto-generated." The old and new allocators can never run concurrently against the same year, because the old one is no longer reachable at all.

## 7. T2 — a deliberate divergence in already-shipped code

`lib/pim-data/scrutiny.js`'s COMPLETE branch now targets `PIM_NUMBER_PENDING` with staff-neutral text ("Scrutiny completed; PIM number assignment pending.", action `"Assign PIM number"`). `lib/pim-scrutiny.js` (the frozen SQLite baseline, kept only as a historical/rollback reference) still targets `SECRETARY_APPROVAL_PENDING` — **intentionally not updated to match**, since restoring it would reintroduce the retired Secretary/Judge model. This is a genuine, deliberate parity break, not a bug: both `scripts/test-pim-scrutiny-postgres.js` and `scripts/test-pim-read-loaders-postgres.js` (which independently build COMPLETE-branch fixtures for their own cross-engine comparisons) now explicitly collapse this one known divergence before comparing, so a real regression anywhere else in either suite still fails loudly.

## 8. Routes and UI

- `GET /api/pim/pim-number?year=YYYY` / `POST /api/pim/pim-number` (`{caseId}`) — replaces `POST /api/pim/approval`. Deliberately never accepts a caller-supplied year in production; `assignPimNumberPg`'s `year` parameter always defaults to the real current office year.
- `POST /api/pim/pim-number/initialize` (`{year, lastNumber}`) — `INITIALIZE_PIM_SEQUENCE` only.
- `app/pim/pim-number/[id]/page.tsx` replaces the "Secretary Approval" page — rebranded copy, a live (non-consuming) preview of the next number before the button click, "Assign PIM Number" action.
- Worklist (`lib/pim-action-link.js`), dashboard (`lib/pim-data/dashboard.js`, `app/pim/page.tsx`), case filters (`app/pim/cases/page.tsx`, `app/pim/reports/page.tsx`), and the case-detail progress stepper (`app/pim/case/[id]/page.tsx`) all gained a `PIM_NUMBER_PENDING` entry alongside (not replacing) the legacy `SECRETARY_APPROVAL_PENDING` ones, except the dashboard's own summary card, which was renamed outright (a "Secretary approval: 0" tile forever would be dead UI clutter contradicting the retired role).

## 9. Tests

`scripts/test-pim-numbering-postgres.js` — 26 dedicated tests (letters A–O, S; N marked N/A since, unlike T1/T2, this transaction has no SQLite counterpart at all to be authoritative against), covering: normal assignment, mid-year continuation, preview never consuming, same-case and different-case concurrency, rollback-on-late-failure, existing-number/wrong-status guards, real-route permission checks, the uninitialized-year boundary, a malformed legacy number never perturbing the allocator, exact docket/history/task effects (including the `createPendingTaskIfNotExists` dedup path), `REGISTERED` never resting, and the explicit non-parity assertion against the old Secretary-approval fields. Every disposable test year is derived from the run's own id (`>= 800000`, nowhere near a real calendar year) and independently verified never to leak into a real year.

Regression suite, all re-confirmed green after this batch: Batch 1 (10/10), 5G (35/35), 5F (27/27, after the same T2-divergence fix as 5E), 5E (44/44), T7 (12/12), T1 (15/15), tx-context (8/8), 5H-a (30/30), dashboard (9/9). tsc/build clean; lint at the pre-existing baseline (154/104/50).

## 10. Production 2026 initialization

Approved value: `last_number = 118` (the physical register's next PIM number is `PIM/119/2026`). Applied via `initializePimSequencePg(2026, 118, <admin user id>)` only after every test above passed. Verified live, through the real route: `GET /api/pim/pim-number?year=2026` → `{"initialized":true,"lastNumber":118,"nextNumber":119,"preview":"PIM/119/2026"}`.
