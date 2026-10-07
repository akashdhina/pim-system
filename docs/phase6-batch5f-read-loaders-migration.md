# Phase 6 Batch 5F — Scrutiny & Non-Starter read loaders (GET) → PostgreSQL

**Scope: only `GET /api/pim/scrutiny/[id]` and `GET /api/pim/nonstarter/[id]`.** No mutation was touched (T1/T2/T7 unchanged, byte-for-byte), no schema change, no auth/session change.

**This is not "the PIM migration is done."** It closes one specific gap and leaves other reads on SQLite — see §10.

## 1. The problem this batch closes

After Batch 5E the write side was PostgreSQL but two page loaders were still SQLite:

```
T1 POST  → PostgreSQL          T1 POST  → PostgreSQL
Scrutiny GET → SQLite  ✗       Non-Starter GET → SQLite  ✗
T2 POST  → PostgreSQL          T7 POST  → PostgreSQL
```

A case created by T1 lives only in PostgreSQL, so a SQLite-backed GET could never load it (or, worse, on a numeric-id collision would show a *different* SQLite case). Now:

```
T1 (PG) → Scrutiny GET (PG) → T2 (PG)
T1 (PG) → Non-Starter GET (PG) → T7 (PG)
```

This is **proven end-to-end** through the real route handlers (tests J and R, §8), not merely translated.

## 2. What was migrated

| Route | Old source | New PostgreSQL module | Consumed by |
|---|---|---|---|
| `GET /api/pim/scrutiny/[id]` | `lib/pim-scrutiny.js` `getScrutinyCase()` | `lib/pim-data/scrutiny-read.js` `getScrutinyCasePg()` | `app/pim/scrutiny/[id]/page.tsx` **and** `app/pim/approval/[id]/page.tsx` |
| `GET /api/pim/nonstarter/[id]` | inline queries in the route + `getCase` / `getActiveNonStarterReasons` / `inferNonStarterContext` (`lib/pim-nonstarter.js`) | `lib/pim-data/nonstarter-read.js` `getNonStarterViewPg()` | `app/pim/nonstarter/form3/[id]/page.tsx` and `app/pim/nonstarter/authority/[id]/page.tsx` |
| (shared) | — | `lib/pim-data/wire-compat.js` | both loaders |

Both loaders are **read-only**: shared `getSql()` client, no transaction, no lock, no write, no SQLite, no fallback and no supplementing from SQLite.

## 3. Scrutiny GET — exact contract

Response `data` = `{ case, parties, fees, documents, scrutiny, docket }` (six keys; `scrutiny` is *omitted* from the JSON when no row exists — see §6).

| Field | SQLite (original) | PostgreSQL | UI consumer |
|---|---|---|---|
| `case` | `SELECT c.*, sm.code AS status_code, sm.name AS status_name FROM pim_cases c LEFT JOIN status_master sm ON sm.id=c.current_status_id WHERE c.id=? LIMIT 1` → throws `PIM case not found.` | same SQL; same throw | id, pim_number, received/application dates, claim_amount, status_code/name (scrutiny page); + registration_date, secretary_decision*, scrutiny_status, due dates (approval page) |
| `parties[]` | `SELECT cp.id AS case_party_id, cp.party_id, cp.role, cp.sequence_no, cp.is_primary, p.name, p.entity_type FROM pim_case_parties cp JOIN pim_parties p … WHERE cp.case_id=? ORDER BY <role rank>, cp.sequence_no` | same + final tiebreaker `cp.id` (§6) | `party.is_primary === 1` → "Primary" badge |
| `parties[].addresses[]` | per party: `SELECT * FROM pim_addresses WHERE party_id=? ORDER BY id` | one query for the whole case (`party_id IN (case's parties)` `ORDER BY party_id, id`), grouped per party | address_type, address_line1/2, village_town, district, state, pincode |
| `parties[].advocates[]` | per party: `SELECT ca.*, a.name AS advocate_name, a.enrollment_no, a.phone, a.email, a.address AS advocate_address FROM pim_case_advocates ca JOIN pim_advocates a … WHERE ca.case_id=? AND ca.party_id=? AND ca.to_date IS NULL ORDER BY ca.id` | one query for the case (`ca.case_id=? AND ca.to_date IS NULL ORDER BY ca.id`), grouped by `party_id` | id (= case_advocates id, from `ca.*`), advocate_name, enrollment_no, phone, email, advocate_address |
| `fees[]` | `SELECT * FROM pim_fees WHERE case_id=? ORDER BY id` | same | application-fee card |
| `documents[]` | `SELECT * FROM pim_documents WHERE case_id=? ORDER BY id` | same | documents list |
| `scrutiny` | `SELECT * FROM pim_scrutiny WHERE case_id=? LIMIT 1` → row or `undefined` | same; `undefined` preserved | checklist + result; approval page shows `scrutinised_at` as raw text |
| `docket[]` | `SELECT d.*, e.code AS event_code, e.name AS event_name FROM pim_docket d LEFT JOIN event_types e … WHERE d.case_id=? ORDER BY d.id DESC` | same | docket_date, entry_text, event_name (+ action_required on approval) |

Tables read: `pim_cases`, `status_master`, `pim_case_parties`, `pim_parties`, `pim_addresses`, `pim_case_advocates`, `pim_advocates`, `pim_fees`, `pim_documents`, `pim_scrutiny`, `pim_docket`, `event_types`.

## 4. Non-Starter GET — exact contract

Response `data` = `{ case, outcome, nonstarterReasons, tasks, context }`. It does **not** return parties/addresses/advocates (the pages read those from `GET /api/pim/case/[id]`, migrated in Batch 2).

| Field | SQLite (original route) | PostgreSQL | UI consumer |
|---|---|---|---|
| `case` | `SELECT c.*, s.code AS status_code, s.name AS status_name FROM pim_cases c LEFT JOIN status_master s … WHERE c.id=?` → missing ⇒ **HTTP 404** | same SQL; loader returns `null` ⇒ same 404 | status, dates |
| `outcome` | `SELECT o.*, nr.code AS nonstarter_reason_code, nr.name AS nonstarter_reason_name, nr.rule_reference, nr.requires_authority_decision FROM pim_outcomes o LEFT JOIN nonstarter_reasons nr … WHERE o.case_id=?` → `outcome \|\| null` | same; `null` preserved | rule_reference / reason_code (Form-3 rule label), `requires_authority_decision` (truthiness) |
| `nonstarterReasons` | `SELECT id, code, name, rule_reference, requires_authority_decision, remarks FROM nonstarter_reasons WHERE active = 1 ORDER BY id` | `WHERE active = true ORDER BY id` | reason picker |
| `tasks` | `SELECT * FROM pim_tasks WHERE case_id=? ORDER BY id` | same | `tasks.find(task_type_code === "NONSTARTER_FORM3" / authority)` |
| `context` | `outcome ? null : inferNonStarterContext(caseId)` (3 ordered reads over `pim_responses`, `pim_service_attempts`, `pim_notices`) | `outcome ? null : inferNonStarterContextPg(sql, caseId)` — **reuses T7's Batch-5D function** (verified against SQLite there) | `context.reasonCode/party/notice/evidence` |

Reusing `inferNonStarterContextPg` (rather than a second copy) means the page can never show a different "what actually happened" than T7 enforces when the reason is submitted.

Tables read: `pim_cases`, `status_master`, `pim_outcomes`, `nonstarter_reasons`, `pim_tasks`, `pim_responses`, `pim_parties`, `pim_notices`, `pim_service_attempts`.

## 5. Wire compatibility (`lib/pim-data/wire-compat.js`)

The schema audit (live PG vs `database/schema.sql`, all 18 tables the loaders read) found **identical column sets — no renames** — and only two kinds of representation difference. Both are handled explicitly, per column, so JSON matches what SQLite produced:

| Kind | SQLite | PostgreSQL | Handling | Columns |
|---|---|---|---|---|
| boolean | `INTEGER` 1/0 | `boolean` | `flag()` → 1/0 (null stays null) | `pim_case_parties.is_primary`; `pim_addresses.is_current`; `pim_documents.generated_by_system`, `.is_current`; `pim_outcomes.sent_to_applicant`, `.sent_to_opposite_party`; `nonstarter_reasons.requires_authority_decision`; `pim_tasks.auto_generated` |
| instant | `TEXT` | `timestamptz` (JS `Date`) | `sqliteTimestamp()` → `'YYYY-MM-DD HH:MM:SS'` UTC | `pim_cases.created_at/updated_at/closed_at`, `pim_addresses.created_at`, `pim_documents.created_at`, `pim_docket.created_at` |
| instant (JS-written) | ISO `…T…Z` | `timestamptz` | `isoInstant()` → ISO with ms | `pim_scrutiny.scrutinised_at` |

Everything else already round-trips through `lib/pim-postgres.js`'s type parsers: `bigint`→Number, `numeric`→Number, `date`→`'YYYY-MM-DD'` string, `smallint`→Number.

**Why it is required, not cosmetic:** both the scrutiny page and the approval page render the "Primary" badge only when `party.is_primary === 1`. Returned as PG's `true`, the badge would silently disappear. (Batch 2's case-detail passes booleans through unconverted; a latent `document.is_current === 1` comparison in the Form-3/Authority pages reads that payload — see §10.)

## 6. Deliberate, output-neutral differences

- **N+1 → single queries** for addresses/advocates (2N round trips saved); each party still gets exactly its own rows in the same order.
- **Independent reads run concurrently** (`Promise.all`, ≤ 7 statements, all parameterized — see §9); the case is read first and a missing case stops everything, like SQLite.
- **`cp.id` tiebreaker** on the parties `ORDER BY`. SQLite's `(role rank, sequence_no)` has no tiebreaker, so ties came back in scan order in practice; PostgreSQL guarantees nothing among ties. Pins the same order; changes nothing where SQLite's order was defined.
- **`scrutiny` is `undefined`, not `null`, when there is no row** — SQLite's `getExistingScrutiny()` returned `undefined`, so the key is omitted from the JSON. Preserved exactly (test G).
- **Ids that cannot be a bigint** (e.g. `99999999999999999999` → `1e20`) are "not found", as in SQLite, instead of surfacing a PostgreSQL "out of range" error.
- **The original SQLite non-starter GET body is retained verbatim** as `getNonStarterViewSqlite()` in the route file (unused by GET): instant rollback (same convention as `case/[id]/route.js`) *and* the authentic SQLite baseline for parity — the test loads it from the real route file rather than re-implementing it. For scrutiny the original `getScrutinyCase` is still imported (marked) for the same purpose.

## 7. HTTP / auth contract — unchanged

`requirePermission(request, "READ_CASE")` still runs first (SQLite session auth, untouched). Status codes and messages preserved, including the asymmetry that already existed:

| Case | Scrutiny GET | Non-starter GET |
|---|---|---|
| Missing case | **400** `PIM case not found.` (the SQLite version *threw*; the generic catch returns 400) | **404** `PIM case not found.` |
| Non-integer id | 400 `Invalid case ID.` | 400 `Invalid case ID.` |
| `0` / negative id | falls through to "not found" (400) | 400 `Invalid case ID.` (`<= 0` check) |
| Other error | 400 with the message | 500 with the message |
| No identity / unknown user | 401 `Authentication required.` | same |

## 8. Tests — `scripts/test-pim-read-loaders-postgres.js` (27 tests)

Method: the SQLite baseline is the **original code** (`getScrutinyCase`; the route's retained `getNonStarterViewSqlite`) running on an isolated scratch SQLite seeded with PostgreSQL's own reference rows. **Ten "twin" cases** (rich case with 4 parties/addresses/advocates/fee/2 documents; a status-permutation case; COMPLETE; DEFECT; non-starter recorded; and five non-starter *context* branches — refusal, refusal-by-appearance, absence, absence-after-time, returned Final notice) are built identically on both engines, and the two loader outputs are deep-compared after a JSON round trip (the real wire format). Only engine-generated values are tokenized (row ids, clock instants, the `officeTime()` wall clock); their *formats* are asserted separately. Real route handlers are driven with real `requirePermission`.

| | Result | What proves it |
|---|---|---|
| A | PASS | exact expected scrutiny JSON for a PG case (every field derived from the fixture) |
| B | PASS | missing/overflow/invalid ids: same messages as SQLite; route 400 |
| C | PASS | a case in *any* of 5 statuses still returned, identical to SQLite |
| D | PASS | parties/addresses/advocates parity + each child nested under its own party |
| E | PASS | scrutiny/status/docket parity for COMPLETE and DEFECT (tasks N/A: not in this response) |
| F | PASS | docket id DESC; parties/addresses/documents ASC; parity |
| G | PASS | `scrutiny` key omitted (undefined); every nullable column null |
| H | PASS | plain dates; SQLite timestamp shapes; ISO `scrutinised_at`; 1/0 flags; **no booleans, no Date objects** |
| I | PASS | 401 no identity, 401 unknown user, 200 for an allowed role; permission-before-loader asserted statically |
| J | PASS | **END-TO-END: T1 (PG) → real scrutiny GET → real T2 POST → GET reflects it** |
| K | PASS | exact non-starter JSON (no outcome; all-null context; reasons; pending SCRUTINY task) and (after T7) exact outcome |
| L | PASS | 404 for missing; loader `null`; 400 for invalid ids; non-bigint id ⇒ 404 |
| M | PASS | `context.party` parity for all 5 branches (parties/addresses/advocates N/A: not in this response) |
| N | PASS | parity for all 10 twins + exact reason/notice/evidence for each context branch |
| O | PASS | tasks/reasons ASC; outcome null-vs-object; context null once an outcome exists |
| P | PASS | date/time/flag/type representation for the non-starter payload |
| Q | PASS | auth trio for the non-starter route |
| R | PASS | **END-TO-END: T1 (PG) → real non-starter GET → real T7 POST → GET reflects it** |
| X | PASS | decoy SQLite case with the *same numeric id* is never returned; SQLite-only id ⇒ not found (no fallback); repeated loader calls change no row count |
| S | PASS | 6 static checks (READ_CASE ordering; no SQLite left in either GET; read modules have no transaction/lock/DML; only reuse is `inferNonStarterContextPg`; POSTs untouched) |
| RESIDUE | PASS | see below |

**The tests can fail.** A mutation check temporarily broke the loaders four ways — booleans left as `true/false`, `scrutiny: null` instead of omitted, docket ascending, tasks/reasons descending — and **13 of 27 tests failed**, each mutation caught by a specific assertion (e.g. *"boolean at parties.0.is_primary (SQLite never returned booleans)"*, *"loader must return undefined, not null"*, *"docket must be strictly id DESC"*), including both end-to-end tests. The files were restored from backup and hash-verified identical.

**Residue:** fixture case ids are recorded in a manifest the instant they are created; cleanup is exact-ID, one atomic transaction (`lock_timeout`, test-prefix guard), inside `try/finally`, with `--cleanup-only` recovery. Verification checks 19 table/column pairs by exact tracked ids (cases, parties, addresses, advocates, case-advocates, fees, status history, docket, tasks, task history, scrutiny, attempts, outcomes, notices, service attempts, responses, documents), the row counts of 21 tables against the pre-run baseline (all 0), and for orphaned `idle in transaction` sessions. Clean after every run, including the deliberately failing mutated run.

## 9. Infrastructure findings (not defects in these loaders)

- **Parameterless query bursts larger than the pool (10) hang forever** against this project's transaction pooler. Reproduced 3/3 on both the app client and a bare postgres.js client: 21 concurrent `SELECT COUNT(*) FROM <table>` (or `SELECT pg_sleep(0.05)`) never resolve; the same burst *with a bound parameter* queues and completes; `max_pipeline: 1` does **not** help; a pool larger than the burst does. My first test run stalled on exactly this (a parallelised 21-count harness helper). Consequences: (a) the harness now runs parameterless statements sequentially (21 counts ≈ 6 s), calls the two loaders one at a time, caps fixture-build concurrency at 5 and gives every test a timeout so a stall fails loudly; (b) the loaders are safe as written — every query is parameterized except one small `nonstarter_reasons` list, and each request's burst is ≤ 7 — but **any future `Promise.all` of more than ten parameterless reads would be a landmine**, and `case-detail.js` (Batch 2) fans out 14 (parameterized). `lib/pim-postgres.js` was deliberately not touched.
- The link to the pooler was intermittently degraded (a twin build once took 283 s instead of ~40 s; earlier in the session first connections reset). The test retries connectivity-class errors only, and only for idempotent infra steps.
- Adapters previously swallowed every loader error into data, which turned a transient failure into a confusing `TypeError`. They now swallow only the one *expected* "PIM case not found." error.

## 10. Known limitations — what is still SQLite

- **Read paths a PostgreSQL case still meets on SQLite:** `GET /api/pim/tasks` (the worklist — PG cases' tasks do not appear) and `GET /api/pim/search`; plus the loaders of unmigrated workflows: `form2/[id]`, `service/[id]`, `response/[id]`, `fee/[id]`, `mediator/[id]`, `mediation/[id]`, `mediation/session/[id]`, `outcome/[id]`, `outcome/approve/[id]`, `address-correction/[id]`, `documents/download/...`; also `reports`, `reports/monthly`, `audit`, `import` (GET), `mediators/[id]`. `auth/me` and all session handling stay SQLite by design.
- **Pages now load a PG case but their next action is still SQLite:** the approval page's POST (T3 — needs its own PIM-number design first), the Form-3 page's completion (T8) and document generation, the Authority page's POST (T9). Those POSTs would report "case not found" for a PG-only case.
- **Batch 2's case-detail payload leaks PG types** (`is_current`/`is_primary` as booleans, timestamps as ISO) into pages that compare `=== 1` (`currentForm3()` in the Form-3 and Authority pages). Latent today because no PG case has documents yet; **not changed here** — it should be fixed with the same `wire-compat` helper when the Form-3 flow is migrated.
- `wire-compat` covers exactly the columns these two loaders return. Any future loader must list its own boolean/instant columns; the test's "no booleans anywhere / no Date objects" walkers exist to catch a missed one.
- Race/consistency: the loaders issue several independent statements without a transaction, exactly as the SQLite versions did (no snapshot across them).

## 11. Validation

| Script | Result |
|---|---|
| test-pim-read-loaders-postgres (this batch) | **27 passed, 0 failed** (run twice on the final files; once against deliberately mutated loaders, where 13 failed as intended) |
| test-pim-scrutiny-postgres (5E) | 44 passed — one static check updated: it asserted "GET still SQLite-backed", which this batch intentionally falsifies |
| test-pim-nonstarter-postgres (T7) | 11 passed |
| test-pim-intake-postgres (T1) | 15 passed, 1 pre-existing SKIP (PIM-number: N/A to T1) |
| test-pim-postgres (Batch 1) | 10 passed (needed: this batch's test script added to its DB-variable allowlist, and the 5E doc reworded — 8a scans the whole repo for the connection-variable name) |
| test-pim-tx-context (5B), test-legacy-import, test-auth-lan-http | passed |
| test-pim-cases / -case-detail / -dashboard / -users / -settings | pass; live sections SKIP (they do not call `loadEnvConfig` — known, deliberately not touched) |
| test-pim-rls, test-supabase-auth | pass; live sections SKIP (no service-role key in a plain run) |
| **Intentionally not run** | `test-pim.js`, `test-received-pim.js` (insert sample cases into the **production** SQLite file, no scratch guard), `test-mediators-smoke.js` (needs a dev server; writes production SQLite) |

`npx tsc --noEmit` clean · `npm run build` succeeded · lint: 153 → 154 problems, **errors unchanged at 104**, warnings 49 → 50 (the one new warning is the intentional `getScrutinyCase` rollback import; every file this batch created lints clean).

Post-suite verification (independent process): all 21 tracked tables at 0 rows; no test-prefixed cases; no orphaned `idle in transaction` sessions; no waiting locks and no locks held on `pim_*` tables; no stale fixture manifest. Files that must not change (the T1/T2/T7 mutation modules, `lib/pim*.js`, `lib/pim-auth.js`, the T1 route) and the **POST handler source of both edited routes** are byte-identical to before the batch (`git hash-object` / source hash).
