# Phase 6 Batch 5G — Tasks Worklist & Case Search (GET) → PostgreSQL

**Scope: only `GET /api/pim/tasks` and `GET /api/pim/search`.** No mutation was touched (T1/T2/T7 unchanged, byte-for-byte, verified by hash). No schema change. No auth/session change. No PIM-number work.

**This is not "the PIM migration is done."** It closes the last two general-purpose read paths a PostgreSQL case needed to be reachable through the UI without going through a specific case id. Several workflow-stage read paths remain SQLite-backed — see §7.

## 1. The problem this batch closes

After Batch 5F, a case created via T1 could be opened directly (`/pim/case/[id]`, `/pim/scrutiny/[id]`, `/pim/nonstarter/...`), but staff had no PostgreSQL-backed way to *find* it: the worklist (`/pim/tasks`) and case search (`/pim/search`) still read SQLite, so a PostgreSQL case's tasks never appeared in the queue and the case never came up in search. This is the last piece needed before T3 can be worked on with real staff-facing navigation.

## 2. What was migrated

| Route | Old source | New PostgreSQL module | Consumed by |
|---|---|---|---|
| `GET /api/pim/tasks` | inline queries in the route (kept as `getPimTasksSqlite`, unused) | `lib/pim-data/tasks-read.js` → `getPimTasksPg()` | `app/pim/tasks/page.tsx` |
| `GET /api/pim/search` | inline queries in the route (kept as `searchPimCasesSqlite`, unused) | `lib/pim-data/search-read.js` → `searchPimCasesPg()` | `app/pim/search/page.tsx` |

Both loaders are **read-only**: shared `getSql()` client, no transaction, no lock, no write, no SQLite, no fallback, no supplementing from SQLite. Every statement is fully parameterized.

## 3. Tasks GET — exact contract

Response `data` = `{ rows, taskTypes, pagination }`, unchanged.

| Filter/param | Preserved semantics |
|---|---|
| `status` (default `PENDING`; `all` = no filter) | identical |
| `taskType` (`FORM2`/`FORM_2` match **both** codes) | identical |
| `priority`, `overdue` (`1`/`true`), `dueDate`, `caseStatus` | identical |
| `page`/`pageSize` (defaults 1/20, max 100000/100) | identical |

Three statements: `COUNT` → page of rows (`ORDER BY PENDING-first, due_date, id DESC LIMIT/OFFSET`) → `DISTINCT` task types list. Per-row JS still computes `overdue` and `action` (via the unmigrated, shared `lib/pim-action-link.js`).

**Faithful translations** (each verified live, not assumed):
- `ORDER BY date(t.due_date)` — SQLite sorts `NULL` first ascending, PostgreSQL sorts it last → `t.due_date NULLS FIRST`.
- The `taskTypes` distinct list is ordered `COLLATE "C"` — the database's default collation is `en_US.UTF-8`, whose order differs from SQLite's byte order for real codes (probed live: `FORM2` sorts after `FORM_2` under the default collation, before it under `"C"`, matching SQLite).
- `dueDate` is compared as exact text (`to_char(t.due_date,'YYYY-MM-DD') = ?`), matching SQLite's plain text equality — a malformed value matches nothing rather than raising a type error.
- Both engines `.trim()` the `dueDate` filter before comparing (pre-existing, preserved behavior) — a trailing-space value still matches.
- A NUL character in any filter value matches nothing rather than being rejected by PostgreSQL.
- The applicant subquery's `ORDER BY` gains `cp.id` as a final tiebreaker (SQLite's `(is_primary DESC, sequence_no)` has none; PostgreSQL guarantees no order among ties).

**Concurrency** (the Batch 5F pooler finding, treated as a hard constraint): every statement carries a bound parameter, including a trivially-true `${1}::int = 1` predicate kept in the WHERE clause even when no filter is supplied, and in the `taskTypes` subquery — this is what keeps the route safe against the documented pool-of-10 stall on parameterless statement bursts. No parallel bursts anywhere in the loader.

No boolean or `timestamptz` column reaches this response, so `lib/pim-data/wire-compat.js` is not used here — asserted by the tests, not assumed.

## 4. Search GET — exact contract

Response `data` = `{ query, rows }`, unchanged. `q.length < 2` still short-circuits to `{query, rows: []}` **without touching PostgreSQL at all** — verified live (row counts unchanged across the call).

One statement, 8 correlated subqueries, matching `pim_number`, `received_number`, party name/phone/email/registration_no (any role — the original has no role filter here), advocate name/phone/email/enrollment_no, mediator name/phone/email/enrollment_no. `ORDER BY COALESCE(registration_date, received_date) DESC, id DESC`, `LIMIT` (default 20, max 50).

**Search semantics — reproduced exactly, not approximated.** SQLite's `LIKE '%q%'` is ASCII-only case-insensitive (`É` does **not** fold to `é`), treats `%`/`_` in the query as live wildcards, and has no default escape character (backslash is literal). Plain PostgreSQL `LIKE` is case-sensitive; `ILIKE` folds non-ASCII too; both treat backslash as an escape character. None of the three obvious options match SQLite. The form that does, verified against both engines on 5 probe cases before implementation and again through the live loader in this batch's tests:

```sql
translate(column, 'A-Z', 'a-z') LIKE <ascii-lowered pattern> ESCAPE ''
```

**Identifier-quoting check, explicitly demanded and verified, not assumed:** `search-read.js`'s `like()` helper builds each predicate as `` sql`translate(${sql(column)}, ...) LIKE ...` `` where `column` is a constant like `"p.name"`. Dumped the exact SQL postgres.js sends via `.describe()`:

```
SELECT "p"."name" AS col FROM pim_parties p LIMIT 1
```

`sql("p.name")` correctly splits and quotes each part (`"p"."name"`), not a single broken identifier — confirmed both by the raw generated SQL string and by two functional queries that only succeed if the qualified column resolves correctly. No fix was needed. Static test `S` and live test `L` both pin this.

A NUL character in the query matches nothing rather than erroring. The four pending-task subqueries and the row ordering use the same `NULLS FIRST`/tiebreak translations as the tasks loader.

No boolean or `timestamptz` column reaches this response either — asserted, not assumed.

## 5. A note on `hasNul()`

`tasks-read.js`'s `hasNul(text) { return text.includes("\u0000"); }` is authored with a **literal NUL byte embedded in the source file** (confirmed via `codePointAt`, code point 0) rather than the escape sequence `"\u0000"`. It works correctly — verified live — but a raw NUL byte in source is fragile: some editors, diff tools, or copy/paste operations can silently corrupt it. Left as-is per this batch's "don't rewrite absent a proven defect" scope; worth a small cleanup (`"\u0000"` written as the escape sequence, not the raw byte) in a future pass that's already touching this file.

## 6. Tests — `scripts/test-pim-tasks-search-postgres.js`

Architecture follows Batch 5F closely: SQLite baseline is the **original kept code** (`getPimTasksSqlite`, `searchPimCasesSqlite`, loaded from the real route files, not re-implemented), exact-ID fixture tracking with a recovery manifest and `--cleanup-only`, real route handlers driven through `requirePermission`, per-test timeout so a pooler stall fails loudly rather than hanging the run.

Because these are **list** endpoints with no case-scoping filter (unlike 5F's single-case loaders), every fixture task uses a run-unique `task_type_code` (confirmed unconstrained by FK/CHECK in both schemas) so assertions can isolate exactly the rows a test created, regardless of any other data in the table — except the FORM2/FORM_2 merge fixture, which must use those literal codes.

Six fixture cases were built per engine: an ordering fixture (3 tasks: no due date / overdue / completed), a pagination fixture (5 tasks), a filters fixture (priority/overdue/dueDate/caseStatus targets, case moved to `DEFECT_PENDING`), a task-types fixture (`FORM2` + `FORM_2` + a collation-order probe), a mediator/session fixture (real `mediators`/`pim_mediator_assignments`/`mediation_sessions` rows, cleaned by exact tracked id with a name-tag safety guard so the project's 2 real mediators can never be touched), and a search fixture (applicant name embedding `100%`, a literal underscore, a literal backslash, and a non-ASCII letter, plus advocate/opposite-party names and a directly-set `pim_number`). A seventh case exists **only in SQLite**, proving PostgreSQL-authoritativeness.

| Letters | Result | Covers |
|---|---|---|
| S | 6/6 | GET calls order, no SQLite left in GET, read-only/no-transaction/no-lock/no-fallback, no parameterless statement, `hasNul` correctness, identifier-quoting proof |
| A–I (tasks) | 17/17 | default-status behavior, every filter (incl. FORM2 merge, NUL), pagination + clamping, `taskTypes` collation ordering, `SESSION_RECORD`→`session_id` resolution + action, empty-result shape, wire-format/null assertions, aggregate SQLite parity, real route handler (401/200/no-write), PG-authoritative decoy |
| J–P (search) | 12/12 | short-circuit with zero DB contact, all 8 field-match paths (incl. all 4 advocate and all 4 mediator fields), the full LIKE-semantics truth table (ASCII fold / non-ASCII no-fold / wildcard-as-literal-data / backslash-as-literal / NUL), ordering + limit clamping + empty result, wire-format/null assertions, aggregate SQLite parity, real route handler, PG-authoritative decoy |
| X | 1/1 | both loaders are read-only under repeated calls |
| RESIDUE | 1/1 | see §8 |

**35 passed, 0 failed**, run twice on the final files (once clean, once as the closing confirmation after fixing 6 issues found during the *first* live run — every one was a defect in the **test script itself** — the trailing-space `dueDate` case ignored the pre-existing `.trim()` behavior; the `taskTypes`/search-parity comparisons didn't account for the SQLite-only decoy fixture legitimately appearing on the SQLite side only; a blanket "no booleans" scan didn't exclude `action.missingPage`/`terminal`, which are genuine, unchanged booleans from the shared `lib/pim-action-link.js`; one hard-coded row-count expectation didn't match its own query string; and one assertion forgot that T1 always auto-creates a pending SCRUTINY task. None required touching `tasks-read.js`, `search-read.js`, or either route — confirmed by re-running lint/syntax clean and, for the mutation pass below, by hash).

**Mutation-proof pass** (Step 6): backed up both loader files (sha1 recorded), applied two deliberate defects — removed `NULLS FIRST` from the tasks row ordering, and replaced `search-read.js`'s ASCII-fold `like()` with a naive case-sensitive `LIKE`. Ran the full suite: **11 of 35 tests failed**, every failure traceable to one of the two defects with a specific, actionable message (e.g. *"like() must quote `column` through sql(), not string-interpolate it"*, an exact-order diff showing `Ord B` before `Ord A`, *"pim_number: query ... must match the fixture case via PostgreSQL"*), and zero false positives among the 24 that still passed. Restored both files from backup; `sha1sum` confirmed byte-identical to before mutation.

## 7. Regression suite (each run individually, live)

| Script | Result |
|---|---|
| test-pim-tasks-search-postgres (this batch) | **35 passed, 0 failed** |
| test-pim-read-loaders-postgres (5F) | 27 passed, 0 failed (one run hit an uncaught `ECONNRESET` mid-build — see §8 — recovered via its own `--cleanup-only`, then passed clean on retry) |
| test-pim-scrutiny-postgres (5E) | 44 passed, 0 failed |
| test-pim-nonstarter-postgres (T7) | 11 passed, 0 failed |
| test-pim-intake-postgres (T1) | 15 passed, 0 failed, 1 pre-existing documented SKIP (PIM-number: N/A to T1) |
| test-pim-postgres (Batch 1) | 10 passed, 0 failed (confirms this batch's test script is correctly allowlisted for the DB-connection-variable scan) |
| test-pim-tx-context (5B) | 8 passed, 0 failed |
| test-legacy-import, test-auth-lan-http | passed |
| test-pim-cases / -case-detail / -dashboard / -users / -settings / -rls / -supabase-auth | pass; live sections SKIP (no `loadEnvConfig` / no service-role key in a plain run — known, deliberately untouched) |
| **Not run, on purpose** | `test-pim.js`, `test-received-pim.js` (insert sample cases into the **production** SQLite file), `test-mediators-smoke.js` (needs a dev server, writes production SQLite) |

`npx tsc --noEmit`: clean. `npm run build`: succeeded (one pre-existing Turbopack warning at `lib/db.js:13`, unrelated to this batch). Lint: **154 problems (104 errors, 50 warnings) — identical to the post-5F baseline**; zero new issues from this batch's routes, loaders, or test script.

## 8. Infrastructure incidents

- **Project connectivity gap between sessions.** At the start of this resumed session, `qqjmmxfvfrrzxirxtgtc.supabase.co` returned NXDOMAIN and the pooler rejected the tenant — almost certainly the free-tier project auto-pausing after several days idle. Resolved externally before this session continued; a 9-point read-only verification (SELECT 1, table/reference-data presence, user/mediator/task-type identity match against prior sessions, fixture counts, manifest check, lock/idle-transaction check) confirmed it was the *same* PIM database, not a new or different project, before any test ran.
- **Uncaught `ECONNRESET` during the 5F regression run.** Killed the Node process mid-fixture-build, outside the test's own try/finally (an unhandled promise rejection at the process level, not caught by the harness). Diagnosed as infrastructure (the exact error class documented from Batch 5F), not a product-test failure — the crash carried no assertion, only a raw connection-reset error. The 6 fixture cases already created were found via the test's own manifest (written the instant each case is created) and removed by exact id via `--cleanup-only`; independently re-verified zero residue before retrying. The retry passed clean. No broad or pattern-based cleanup was used anywhere in this incident.
- No stale manifest, idle-in-transaction session, waiting lock, or blocked session remained at the end of the batch (verified independently, after every regression script had run).

## 9. Remaining SQLite-backed PIM read paths after 5G

Derived from the repository, not assumed. PostgreSQL-backed GET routes now: `case/[id]`, `cases`, `dashboard`, `mediators`, `nonstarter/[id]`, `received` (POST only), `scrutiny/[id]`, `search`, `settings`, `tasks`, `users/[id]`, `users`.

Still SQLite-backed:
```
address-correction/[id]      mediation/[id]              response/[id]
audit                        mediation/session/[id]      service/[id]
auth/me                      mediator/[id]               system-info
backups (+ sub-routes)       mediators/[id]
documents/download/[..]/[..] outcome/[id]
fee/[id]                     outcome/approve/[id]
form2/[id]                   reports (+ monthly)
import
```

`auth/me`, `backups/*`, `import`, `system-info`, `audit` are intentionally out of scope for this migration track (auth/session, backups, legacy import tooling, system diagnostics). The workflow-stage routes (`form2`, `service`, `response`, `fee`, `mediator`, `mediation`, `outcome`, `address-correction`) are genuine remaining migration surface — each is a case-detail-style GET analogous to what 5F did for scrutiny/non-starter.

**Batch 2's case-detail wire-compatibility issue is still relevant and unresolved.** `lib/pim-data/case-detail.js` (`GET /api/pim/case/[id]`) still returns raw PostgreSQL booleans and ISO timestamps for `is_current`/`is_primary`/etc., where the Form-3 and Authority pages' `currentForm3()` helper compares `document.is_current === 1`. It is latent today because no PostgreSQL case has documents yet. It must be fixed with `lib/pim-data/wire-compat.js` (already proven correct in 5F and reused here) before or during whichever batch migrates Form-3/document-metadata reads.

## 10. Recommended next batch

**Batch 5H: migrate one workflow-stage case-detail GET** — `form2/[id]` or `service/[id]` are the smallest, most self-contained candidates, following the exact 5F/5G pattern (kept SQLite baseline, `wire-compat.js` for booleans/timestamps, twin-fixture parity, real route-handler tests, exact-ID residue verification). Apply the Batch 2 case-detail boolean/timestamp fix in the same batch if that GET's page reads `pim_documents.is_current`, since it will be the first real exercise of that gap.

The PIM-number allocation design (blocking T3) remains a separate, not-yet-started piece of work, unchanged by this batch.
