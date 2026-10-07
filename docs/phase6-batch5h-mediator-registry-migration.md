# Phase 6 Batch 5H-a — Mediator Registry (PostgreSQL) + Panel Reconciliation

**Scope: the mediator roster only** — `POST /api/pim/mediators` (create) and `GET`/`PATCH /api/pim/mediators/[id]` (single-record view/edit), plus, as a follow-on correction within the same batch, a validation fix and a one-time reconciliation of the real mediator master to the five approved panel members.

**Not in scope**: case-level mediator *assignment* (`/api/pim/mediator/[id]`, a different route, still SQLite-backed — see §5), Batch 5H-b (yearly PIM-number allocation), T3, authentication/session architecture.

## 1. Background — why the Secretary/Judge workflow was set aside

An earlier pass through this batch began migrating T3 (`lib/pim-approval.js`, "Secretary approval") before a business-rules review established that PIM has no operational Secretary/Judge role: the software is staff-operated throughout. That finding paused the T3 work and redirected this batch onto the mediator registry instead — a genuinely standalone roster entity, not gated by case workflow status or T3 at all. `MANAGE_MEDIATOR` was broadened from `["secretary", "admin"]` to `["aa", "secretary", "admin"]` (the `secretary` role/account itself is left in place as legacy infrastructure, not removed) so ordinary staff can maintain the mediator roster directly.

## 2. What was migrated (PostgreSQL)

| Route | Old source | New PostgreSQL module |
|---|---|---|
| `POST /api/pim/mediators` | inline insert in the route (kept as `postMediatorSqlite`, unused) | `lib/pim-data/mediator-registry.js` → `createMediatorPg()` |
| `GET /api/pim/mediators/[id]` | inline aggregate query (kept as `getMediatorSqlite`/`getMediatorDetailSqlite`, unused) | `lib/pim-data/mediator-registry-read.js` → `getMediatorDetailPg()` |
| `PATCH /api/pim/mediators/[id]` | inline update (kept as `duplicateActiveEnrollmentSqlite`, unused) | `lib/pim-data/mediator-registry.js` → `checkDuplicateActiveEnrollmentPg()` / `updateMediatorPg()` |

`GET /api/pim/mediators` (the list endpoint) was already PostgreSQL from Batch 1 and is untouched here.

Each mutation runs inside one `withTransaction(...)`: the mediator INSERT/UPDATE and its `audit_log` row commit or roll back together. The SQLite originals did **not** wrap these two statements in a transaction at all — a pre-existing gap where a failed audit insert could leave the mediator write committed with no audit trail. Wrapping both writes here is strictly safer and changes no observable success-path behavior.

Sessions are ordered `COALESCE(actual_date, scheduled_date) DESC NULLS LAST` — the opposite-direction fix from the usual `NULLS FIRST` translation, needed because this is a `DESC` sort with SQLite's NULL-sorts-last-in-DESC semantics.

## 3. Validation correction — enrollment number is not mandatory

While reconciling the real mediator master against the five-member approved panel, the two existing real records (Rajesh id 13, Ravikumar id 12) were found to already have `enrollment_no = NULL` — meaning they were never created through the application's own POST route, which unconditionally rejected any create with no enrollment number (`validateMediatorInput()` in `app/api/pim/mediators/route.js`), and whose PATCH counterpart (`validatePatch()` in `mediators/[id]/route.js`) carried the identical bug — meaning **any** edit to either existing record, even one that never touched `enrollment_no`, would have been rejected outright, since the current stored value is null.

The database schema itself has never required it: `enrollment_no` is a nullable column with no `UNIQUE` constraint (only a primary key on `id`).

**Fix** (both `app/api/pim/mediators/route.js` and `app/api/pim/mediators/[id]/route.js`):
- `name` remains required.
- `category` is now explicitly required in the validator too (previously unchecked; in practice `parseMediatorBody()` already defaults it to `"ADVOCATE MEDIATOR"` when omitted, so this guard cannot actually be triggered through the real route — it is a defensive check on the validation function itself, confirmed by a direct unit test).
- `enrollment_no` is no longer required on either create or edit. When one **is** supplied, all existing validation still applies (the active-duplicate-enrollment conflict check is unchanged and still fires — confirmed live).
- No enrollment number was invented for any record, existing or new.

## 4. The five-member approved panel

Confirmed business rule: the PIM mediator panel is exactly —

| id | Name | Category | Active | Enrollment No. |
|---|---|---|---|---|
| 12 | Mr.R.Ravikumar | ADVOCATE MEDIATOR | true | NULL (pre-existing, unchanged) |
| 13 | Mr.H.Rajesh | ADVOCATE MEDIATOR | true | NULL (pre-existing, unchanged) |
| 50 | Mr. Narayanan Kutty | ADVOCATE MEDIATOR | true | NULL |
| 51 | Mrs. Latha Subramaniam | ADVOCATE MEDIATOR | true | NULL |
| 52 | Mr. K. Viswanath | ADVOCATE MEDIATOR | true | NULL |

The three new records were created through the **real POST route** (not a raw SQL insert) — invoked directly with the production dev-identity mechanism (`x-pim-user-id`, gated to non-production `NODE_ENV` in `lib/pim-auth.js`'s `getDevelopmentUser()`), acting as user id 1 (a real active `aa`-role staff account), exactly the code path a staff member's browser session would exercise. Every optional field beyond `name`/`category`/`active` (`enrollment_no`, `contact_phone`, `email`, `empanelment_order_no`, `empanelment_date`, `panel_valid_until`, `rotation_order`, `conflict_declaration_date`, `remarks`) is `NULL` — no information was fabricated.

The two existing records (ids 12/13) were **not** altered — their stored values (including the "Mr.X.Surname", no-space naming convention) were left exactly as found. The three new records use the names as confirmed verbatim, with a space after the title — a formatting difference from the existing two, left as-is since normalizing either style is a naming decision for the user to make, not one this batch took unilaterally.

## 5. Mediator master vs. case-level assignment — still two different things

The mediator **master/roster** (this batch) and case-level mediator **assignment** (`POST/GET /api/pim/mediator/[id]`, a different route) remain architecturally separate, as already established in Batch 1/5H's design:

- Roster maintenance (add/edit a mediator, active/inactive status) is now fully PostgreSQL, staff-operated, independent of any case.
- Case-level assignment is still SQLite-backed and reads its **own** `mediators` table — a mediator created via this batch's PostgreSQL POST route is not yet visible there (confirmed by a dedicated test: `getMediatorDetailPg` and the real GET route both 404 on a SQLite-only mediator, proving no silent cross-engine fallback in either direction). Migrating case-level assignment to select from the PostgreSQL mediator master (rather than free text) is future work, not part of this batch.
- Active/inactive semantics are unchanged: active mediators are selectable for new work; inactive ones remain visible on historical records and are never deleted.

## 6. Tests — `scripts/test-pim-mediator-registry-postgres.js`

Architecture follows 5F/5G/T1 closely: SQLite baseline is the original kept code, loaded from the real route files (not re-implemented); exact-ID fixture tracking with a recovery manifest and `--cleanup-only`; real route handlers driven through `requirePermission`; per-test timeout so a pooler stall fails loudly; bounded retries only for connectivity-class errors.

**Fixture vs. real-data distinction** (important once the panel became real production data): the five approved mediators are asserted by exact id/name, never touched by fixture cleanup (guarded by a `TB5H`-tag substring check that cannot match any approved name), and the residue check now expects exactly these five rows — not baseline-equality — same treatment the panel already got everywhere else in this suite.

Final result: **30 passed, 0 failed** — `PANEL` (roster shape/no-duplicates/ids 12-13 preserved/null defaults on the three new rows), `A`–`M` (create/view/edit, not-found, permissions under the staff model, real-route contract, SQLite/PostgreSQL parity, null semantics, boolean semantics, timestamp/date formats, assignment/session ordering, rollback atomicity, PostgreSQL-authoritativeness), `N` (create with no enrollment number succeeds, both directly and through the real route), `O` (a *supplied* enrollment number still triggers the active-duplicate conflict), `P` (missing name still rejected), `Q` (the validator's own category-required guard), `RESIDUE` (zero leftover fixtures; mediators back to exactly the five approved rows), `S` (static contract checks).

## 7. Regression suite (re-confirmed after the validation correction)

Two pre-existing test scripts hardcoded the old "exactly 2 real mediators" baseline and needed the same update as this batch's own suite — **not** product regressions, just stale fixtures of the prior mediator count:

- `scripts/test-pim-postgres.js` (Batch 1) test 6 — updated to expect all five approved names.
- `scripts/test-pim-tasks-search-postgres.js` (Batch 5G) — its baseline assertion, residue check, and a comment updated from 2 → 5.

Final results, all green:

| Suite | Result |
|---|---|
| Batch 1 (`test-pim-postgres.js`) | 10/10 |
| 5G (`test-pim-tasks-search-postgres.js`) | 35/35 |
| 5F (`test-pim-read-loaders-postgres.js`) | 27/27 |
| 5E (`test-pim-scrutiny-postgres.js`) | 44/44 |
| T7 (`test-pim-case-detail.js`) | 12/12 |
| T1 (`test-pim-intake-postgres.js`) | 15/15 |
| tx-context (`test-pim-tx-context.js`) | 8/8 |
| tsc --noEmit | clean |
| next build | clean |
| eslint | 154 problems (104 errors, 50 warnings) — unchanged from the pre-existing baseline |

A number of transient `ECONNRESET`/`CONNECTION_CLOSED` failures occurred during these runs (the project's known Supavisor pooler flakiness); each was diagnosed against `pg_stat_activity` and the fixture manifest before any retry, confirming zero residue and no orphaned transactions in every case, per this project's established doctrine of never treating a connectivity error as a silent pass.
