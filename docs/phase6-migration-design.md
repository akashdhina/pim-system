# Phase 6 Design & SQLite Dependency Audit (read-only — no code changed)

Status: design document only. No routes, `lib/` files, or migrations were touched while producing this. Phase 5 (Storage) is skipped by design per the revised plan; documents are generated on demand and never persisted to Supabase Storage or any permanent cloud location.

## 1. Complete SQLite dependency map

Every one of the 50 files under `app/api/pim/**/route.js`, plus every `lib/pim-*.js` module, was inventoried for `db.prepare`/`db.transaction`/`lastInsertRowid`/SQLite-specific SQL. Full per-route detail (table/verb/line numbers) is preserved below; the cross-cutting findings that shape the architecture follow after.

### 1.1 Module → tables → CRUD → transaction → SQLite-specific → Supabase plan

| Module/route group | Tables touched | CRUD | Transaction? | SQLite-specific | Supabase plan |
|---|---|---|---|---|---|
| `lib/db.js` | — (connection only) | — | — | `PRAGMA foreign_keys = ON` | Replaced by `lib/pim-data/client.js` (postgres.js pool); FKs are always enforced in Postgres, no PRAGMA needed |
| `lib/pim.js` (`received`) | pim_cases, pim_parties, pim_case_parties, pim_addresses, pim_advocates, pim_case_advocates, pim_fees, status_master, event_types, pim_status_history, pim_docket, task_types, pim_tasks | INSERT (8 tables) | Yes, 1 transaction, ~10 statements | `lastInsertRowid` ×3 (case, party, advocate) | `sql.begin()`, `RETURNING id` |
| `lib/pim-approval.js` | pim_cases, status_master, event_types, pim_status_history, pim_docket, task_types, pim_tasks | SELECT, UPDATE, INSERT | Yes | PIM-number generation via `MAX+1` over a `LIKE` scan (race-prone even in SQLite — flagged, not fixed here) | `sql.begin()`; consider `SELECT ... FOR UPDATE` or a Postgres sequence for the number generator as a hardening opportunity |
| `lib/pim-scrutiny.js` | pim_cases, status_master, pim_tasks, pim_task_history, pim_scrutiny, pim_scrutiny_attempts | SELECT (re-read inside tx), UPDATE, INSERT | Yes — **re-reads case status inside the transaction** to guard against a stale double-click | `MAX(attempt_no)+1` pattern | Must preserve the re-read-then-check-then-write pattern; only a real transaction (not sequential REST calls) does this correctly |
| `lib/pim-op-response.js` (shared helpers, no own transaction) | pim_status_history, pim_cases, pim_docket, pim_responses, pim_fees, pim_tasks, pim_task_history | SELECT/INSERT/UPDATE | No (caller wraps) | `CURRENT_TIMESTAMP` literal | Ports 1:1 into `lib/pim-data/workflow-helpers.js` + `responses.js` |
| `lib/pim-nonstarter.js` | pim_cases, pim_outcomes, nonstarter_reasons, pim_responses, pim_service_attempts, pim_notices, pim_status_history, pim_docket, pim_tasks | SELECT, INSERT, UPDATE | Wrapped by caller (`nonstarter/[id]/route.js`) | `CURRENT_TIMESTAMP` literal | Straightforward port; fact-inference SELECTs are pure reads |
| `lib/pim-fresh-notice.js` (shared, no own transaction) | pim_notices | SELECT, INSERT | No (caller wraps) | none | Straightforward port |
| `lib/pim-document.js` | pim_cases, pim_outcomes, nonstarter_reasons, pim_parties, pim_case_parties, pim_mediator_assignments, mediators, mediation_sessions, pim_notices, pim_addresses, users | SELECT only (writes to `pim_documents` happen in the calling routes, not here) | No | none | Reads port to the data layer; **file generation itself needs no DB/Storage change at all** — see §5 |
| `lib/pim-reports.js` | all case-family tables, dynamically per report | SELECT (dynamic SQL builder) | No | **Heaviest concentration of `julianday()`/`date()` arithmetic in the app** — 13 report definitions | Deliberately ported last (§6, phase 12); each `julianday(a) - julianday(b)` → `(a::date - b::date)`; `date(x,'+N day')` → `x::date + interval 'N day'` |
| `lib/pim-users.js` | users, pim_user_sessions, audit_log | SELECT, INSERT, UPDATE | No explicit `db.transaction()`, but `ensureLastAdminSafe()` is a real cross-row invariant | none | **Stays on SQLite** — see §3 (auth strategy). Not part of the case-data migration at all. |
| `lib/pim-settings.js` | system_settings, audit_log | SELECT, UPSERT (`ON CONFLICT`) | Yes, 1 transaction | `ON CONFLICT ... DO UPDATE` (direct Postgres equivalent, no change needed) | Simple port |
| `lib/pim-legacy-import.js` | ~10 tables (cases, parties, addresses, advocates, scrutiny, notices, service_attempts, responses, fees, mediator_assignments, mediation_sessions, outcomes, tasks, task_history, docket, status_history, audit_log) | INSERT (mostly), some UPDATE | Yes, 1 large transaction reconstructing an entire case history | `MAX+1` scans, several `lastInsertRowid` chains | Deliberately ported last (§6, phase 14) — every individual write path it touches will already be proven by the phases before it |
| `lib/pim-backup.js` | — (whole-database file operations, `PRAGMA integrity_check`/`foreign_key_check`) | — | — | Entirely SQLite-native (`better-sqlite3`'s `.backup()`, both PRAGMAs) | **No Postgres equivalent or migration** — Supabase provides its own backup/PITR; this module simply stops applying once SQLite is retired (§7) |
| `app/api/pim/case/[id]`, `cases`, `dashboard`, `tasks`, `search`, `audit` | 15–16 SELECTs each, read-only | SELECT only | No | `date()`, `date(?,'+N day')` in ORDER BY/WHERE (dashboard has the densest concentration); dynamic WHERE-array construction in `cases`, `tasks`, `audit` | Phase 2 of §6 — highest value, lowest risk |
| `mediators`, `mediators/[id]` | mediators, audit_log | SELECT, INSERT, UPDATE | **No** — audit_log INSERT is a separate, un-transacted statement after the write (flagged inconsistency, present in the SQLite app today) | Dynamic `SET` column-list construction (`mediators/[id]` PATCH) — the single clearest example of dynamic-column UPDATE in the codebase | Fix the missing transaction wrapper while porting (bringing it in line with every other mutation route, not a scope-creep redesign — it's closing an existing gap using the same pattern already used everywhere else) |
| `form2/[id]`, `form2/issue/[id]`, `documents/form2/[id]`, `address-correction/[id]`, `service/[id]` | pim_notices, pim_service_attempts, pim_addresses, pim_documents, pim_cases, pim_status_history, pim_docket, pim_tasks, pim_task_history | SELECT/INSERT/UPDATE | Yes, per-route | `INSERT OR IGNORE` (address-correction only), `CURRENT_TIMESTAMP` literals | `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING` |
| `response/[id]`, `consent/[id]` | pim_responses, pim_cases, pim_status_history, pim_docket, pim_fees, pim_tasks | SELECT/INSERT/UPDATE (via `lib/pim-op-response.js`) | Yes | none inline | Straightforward port |
| `nonstarter/[id]`, `nonstarter/form3/[id]`, `nonstarter/authority/[id]` | pim_outcomes, pim_documents, pim_tasks, pim_task_history, pim_cases, pim_status_history, pim_docket | SELECT/INSERT/UPDATE | Yes | `time('now')`, `CURRENT_TIMESTAMP` literals | `time('now')` → `CURRENT_TIME`/`now()::time` |
| `mediator/[id]`, `mediator/reassign/[id]`, `mediation/[id]`, `mediation/next/[id]`, `mediation/session/[id]` (largest transaction in the app, ~640 lines), `fee/[id]` | pim_mediator_assignments, mediators, mediation_sessions, pim_cases, pim_status_history, pim_docket, pim_tasks, pim_task_history, pim_fees | SELECT/INSERT/UPDATE | Yes, per-route (session/[id] is the single most complex) | `char(10)`, `CURRENT_TIMESTAMP` literals | Ported after the transaction mechanism is proven on simpler cases (§6, phase 10) |
| `outcome/[id]`, `outcome/approve/[id]`, `documents/outcome/[id]` | pim_outcomes, pim_cases, pim_status_history, pim_docket, pim_tasks, pim_task_history, pim_documents | SELECT/INSERT/UPDATE | Yes (one un-transacted UPDATE flagged in `documents/outcome/[id]` reuse path — same fix-while-porting note as `mediators`) | `CURRENT_TIMESTAMP` literal | Straightforward port once mediation/outcomes precede it |
| `reports/route.js`, `reports/monthly/route.js` | dynamic, via `lib/pim-reports.js` | SELECT only | No | `date(?, '+1 month', '-1 day')` — the single clearest SQLite-date-arithmetic example needing direct translation | §6 phase 12 |
| `system-info/route.js` | pim_cases (count only) | SELECT | No | **`PRAGMA integrity_check` / `PRAGMA foreign_key_check` — no Postgres equivalent at all** | This page's data-integrity story must be redesigned (e.g. `get_advisors`-style checks, or simply removed) when ported — flagged, not solved here |
| `users/*`, `auth/*`, `settings`, `approval`, `import`, `received`, `scrutiny/[id]` | (delegate entirely to their lib module) | — | — | — | Same as their lib module above |

Full per-file line-number detail (all 50 routes) was produced during this audit and is available on request if you want it preserved as a separate reference file — I kept this document to the level of detail actually needed for the architecture decisions below rather than reproducing all ~50 entries verbatim.

### 1.2 Cross-cutting findings

1. **12 of 50 route files have zero inline SQL** — they delegate entirely to a `lib/` module. The bulk of remaining SQLite surface lives in `lib/pim.js`, `pim-scrutiny.js`, `pim-settings.js`, `pim-users.js`, `pim-op-response.js`, `pim-nonstarter.js`, `pim-legacy-import.js`, `pim-document.js`, `pim-reports.js`.
2. **SQLite-only `PRAGMA` statements** exist only in `system-info/route.js` — no Postgres equivalent exists; this page needs a redesigned data-integrity story, not a translation.
3. **SQLite date-arithmetic** (`date(?, '+N day/month')`, `julianday()`, `time('now')`, `CURRENT_TIMESTAMP` literals, `char(10)`) appears across ~20 of the 38 files with inline SQL. Heaviest in `dashboard`, `reports/monthly`, `lib/pim-reports.js`.
4. **`INSERT OR IGNORE`** appears exactly once (`address-correction/[id]`). **No `ON CONFLICT`/`INSERT OR REPLACE`** elsewhere except `lib/pim-settings.js`'s already-Postgres-compatible upsert.
5. **Dynamic SQL construction** (WHERE-arrays, whitelisted `ORDER BY`, or dynamic `SET` lists) exists in exactly 6 places: `audit`, `cases`, `tasks`, `mediators`, `mediators/[id]` (highest-risk — dynamic UPDATE column list), and `lib/pim-reports.js`'s report-query builder.
6. **Two un-transacted multi-statement writes** exist today, inconsistent with the rest of the codebase: `mediators`/`mediators/[id]` (write + audit_log insert as separate statements) and the reuse-path UPDATE in `documents/outcome/[id]`. Porting is the natural moment to wrap these correctly — not new scope, just applying the pattern already used everywhere else in the app.
7. **Duplicated helper functions** (`getStatusId`, `getEventId`, `addDocket`, `addStatusHistory`, `today()`, task-completion helpers) are independently redefined in `lib/pim-op-response.js`, `lib/pim-nonstarter.js`, and inline in roughly 15 route files — the same INSERT/UPDATE bodies copy-pasted, not divergent logic. Consolidating these into one shared module is low-risk (they're already identical) and directly serves "avoid spreading raw queries" — this is item 1 of the migration order (§6).
8. **`lib/pim-scrutiny.js`'s `saveScrutiny`** re-reads case status *inside* its transaction specifically to guard against a stale double-click using old browser state. This is the clearest proof point in the whole app that the transaction mechanism must support genuine read-then-check-then-write atomicity, not just "fire several inserts and hope."

## 2. Proposed Supabase data-access architecture

```
API route (app/api/pim/**)
   ↓ (unchanged: requirePermission(request, "X") — SQLite-backed, see §3)
lib/pim-data/<domain>.js   (new — mirrors today's lib/pim-*.js module boundaries)
   ↓
lib/pim-data/client.js     (new — postgres.js pool + withTransaction() helper)
   ↓
PostgreSQL (pim-system project)
```

- **`lib/pim-data/`**, not a single `lib/pim-supabase-db.js` — mirrors the existing `lib/pim-*.js` split (cases, scrutiny, approval, notices, responses, fees, mediation, outcomes, nonstarter, tasks, documents-metadata, reports, users, settings, legacy-import, dashboard, search, audit) so each ported module keeps the same exported function names/signatures/return shapes as its SQLite counterpart wherever practical. That's what makes the "keep both, test both, then switch" strategy in §9 mechanical rather than a rewrite: a route changes one `require(...)` line, not its logic.
- **`lib/pim-data/client.js`** exports a shared connection pool (see §3 for the driver choice) and a `withTransaction(fn)` helper wrapping `sql.begin(async (tx) => { ... })`, used everywhere `db.transaction(() => {...})()` is used today.
- **`lib/pim-data/workflow-helpers.js`** consolidates the duplicated `getStatusId`/`getEventId`/`addStatusHistory`/`addDocket`/`completeTask`/`getPendingTask`/`createPendingTaskIfNotExists` functions (finding 7, §1.2) into one canonical set, used by every domain module — closing an existing inconsistency rather than introducing a new pattern.
- **UI components never gain a direct Supabase dependency** — confirmed during this audit that no `app/pim/**` page currently touches the database directly (everything goes through `fetch('/api/pim/...')`), so this architecture doesn't need to guard against that; it already isn't happening.

## 3. Transaction strategy

**Supabase's REST client (`@supabase/supabase-js`) cannot do this at all** — each `.from(table).insert(...)` call is an independent HTTP request; there is no way to compose several of them into one atomic commit across tables. This isn't a preference, it's a hard capability gap, confirmed against every one of the ~25 distinct `db.transaction()` blocks found in §1 (ranging from ~5 statements to `mediation/session/[id]`'s ~15-statement, 4-way-branching transaction).

**Decision: a direct, server-side PostgreSQL connection using a proper driver (`postgres` — "postgres.js" — recommended over `pg` for its cleaner async/tagged-template API), using Supabase's transaction-pooler connection string**, not the REST API, for every operation that is currently a `db.transaction()`. This is option (b) from your instructions ("a server-side PostgreSQL transaction using an appropriate driver"), and it's the only option that preserves every existing invariant — including the read-then-check-then-write pattern in `pim-scrutiny.js` (finding 8, §1.2) — without rewriting validated JS business logic into PL/pgSQL.

**Why not Postgres RPC functions (option a) as the general mechanism**: rewriting ~25 JS transactional functions (some, like `mediation/session/[id]`, hundreds of lines with multiple conditional branches) into PL/pgSQL would mean re-implementing already-correct, already-tested business logic in a second language, which is exactly the "fragile SQL replica" risk Phase 4 already declined to take for the permission map. Keeping the logic in JS and only swapping how it talks to the database is lower-risk. (A narrow RPC function remains a reasonable *future* choice for a specific hot path if ever needed — not a blanket strategy now.)

**Practical notes for implementation (not done in this phase):**
- Use Supabase's **transaction pooler** (port 6543, pgbouncer transaction mode) rather than a direct/session connection — the right choice for Next.js's serverless-style request lifecycle, avoiding connection exhaustion.
- `lastInsertRowid` → `INSERT ... RETURNING id`, everywhere (§1 table, "SQLite-specific" column, `lastInsertRowid` entries).
- `MAX(...)+1` numbering patterns (PIM number generation, scrutiny attempt numbers) keep their exact current logic inside the transaction (same as today) — not silently upgraded to Postgres sequences, since that would change concurrency behavior beyond what's being asked. Flagged as a **future hardening opportunity**, not in-scope now.

## 4. Authentication integration strategy

**Key finding: Phase 6 does not need to cut over login/sessions to Supabase Auth at all.** `requirePermission(request, "PERMISSION")` in every route is a separate, self-contained authorization gate that runs *before* any data access and doesn't care which database the data later comes from. So:

- `users` and `pim_user_sessions` **stay on SQLite**, unchanged, indefinitely (or until a separate, later decision to cut over — not part of this plan). This directly satisfies "the existing SQLite application must continue working."
- `lib/pim-auth.js`, `getCurrentUser()`, `requirePermission()`, the login/logout/change-password routes — **none of these change** in Phase 6.
- Every ported `lib/pim-data/*.js` function keeps taking a plain `userId` (the SQLite-resolved integer id) exactly as today's `lib/pim-*.js` functions do, and passes it straight through to `changed_by`/`entered_by`/`created_by`/etc. — no identity-resolution complexity needed.

**Concrete blocker this surfaces, worth fixing in batch 1**: Postgres's `users` table (created structurally in Phase 2, deliberately left unseeded in Phase 3 for security-hygiene reasons — no password hashes committed) currently has **zero rows**. Every ported write that sets `changed_by`/`entered_by`/`prepared_by`/etc. references `users(id)` as a foreign key — those inserts will fail against an empty `users` table. Batch 1 needs a small sync step: copy the SQLite `users` table's non-secret columns (`id`, `username`, `display_name`, `designation`, `role_code`, `active`) into Postgres `users`, explicitly **excluding `password_hash`** (Postgres `users` is never used for authentication in this design — it exists purely as an FK-attribution target), kept in sync going forward as legacy accounts are added/changed. This is new, small, clearly-scoped work this audit surfaced — not yet implemented.

**RLS implication**: because `users`/`pim_user_sessions` deliberately have zero RLS policies (Phase 4, unchanged — nothing should read password hashes via a Supabase client), and Postgres `users` will now hold real (non-secret) rows for FK purposes, this remains correct and safe — the deny-all posture on those two tables was never about the data being absent, it was about no client needing to read them via PostgREST.

## 5. Document-generation/download strategy (no Storage)

This is a **simplification**, not a new capability to build. Re-reading `lib/pim-document.js`: `docxtemplater`/`pizzip` already operate entirely on in-memory `Buffer`s — the template is read into a buffer (`fs.readFileSync`), and the rendered output is already produced as a buffer (`zip.generate({ type: "nodebuffer", ... })`). The **only** thing the current code does beyond that is an extra, avoidable step: `fs.mkdirSync(...)` + `fs.writeFileSync(filePath, outputBuffer)` to persist it under `storage/pim/...`, plus inserting a `pim_documents` row whose `file_path` points at that file for later re-download.

**Target flow** (confirmed no filesystem write is actually required by the DOCX library):
```
requirePermission(request, "GENERATE_DOCUMENT")  [unchanged]
   → load case/notice/outcome data via lib/pim-data/*  [Postgres, ported]
   → lib/pim-document.js renders the template to a Buffer  [unchanged rendering logic]
   → route returns the Buffer directly as the HTTP response body
     (Content-Disposition: attachment; same filename convention as today)
   → nothing is written to disk; nothing is uploaded anywhere
```
`lib/pim-document.js`'s generate functions change their return shape from `{ ..., filePath, fileName }` to `{ ..., buffer, fileName }` — everything about template selection, field mapping, Form-2/3/4/5 formatting, and numbering logic is **untouched**, per your instruction to preserve it as the source of truth.

**`pim_documents` metadata — genuinely still needed, not just for history.** Three real business dependencies on this table were confirmed during this audit, not just an audit trail:
- `outcome/approve/[id]/route.js` enforces that a Form IV/V document **already exists** (`SELECT ... FROM pim_documents WHERE document_type = ... AND is_current = 1`) before allowing SETTLED/FAILED case closure — a real statutory gate, not cosmetic.
- `pim_notices.document_id`/`pim_outcomes.document_id` track "which document is current for this notice/outcome," driving the demote-old/insert-new versioning logic across `form2`, `form3`, `outcome` document routes.
- The reports module (`documents`, `non_starters`, `settlements`, `failures`) shows "Available"/"Not available" labels keyed off `pim_documents` rows.

So `pim_documents` stays as a real metadata/audit table — only `file_path` stops pointing at a real persisted file. **Two things I'm flagging as open decisions for whenever the Documents phase of §6 actually happens, not deciding here:**
1. **What goes in `file_path`** once nothing is written to disk — it's `NOT NULL` today and I was told not to alter that column in this phase. A descriptive non-path value (matching the existing naming convention, e.g. `"FORM-2-N{noticeId}-v{version}"` as a label rather than a real path) satisfies the constraint without lying about persistence — but that's a decision for the implementation, flagged here rather than made unilaterally.
2. **What "re-download" means without persisted bytes.** Today, downloading twice returns the identical bytes generated the first time. Under the new model, a second download call *regenerates* from current database state — which could differ subtly from the original generation if underlying case data (e.g. office settings' `default_mediation_venue`) changed in between. Whether that's acceptable, or whether "regenerate a new version" (bumping `version_no`, today's existing behavior) should be the *only* way to get updated content while a plain "download the current version" always reproduces the original bytes some other way, is a real product question this architecture change raises. I'm surfacing it, not resolving it.

## 6. Route migration order (revised from your proposed 17-step list)

I validated your proposed order against the actual dependency graph from §1 and found two steps that don't correspond to independently-portable code units — "Parties/addresses/advocates" and "Tasks/docket/status history" are never written as standalone operations; they're always embedded inside whichever workflow transaction needs them (case intake, legacy import, every status-transition route respectively). Restructured:

1. **Common data-access infrastructure** — `lib/pim-data/client.js`, `lib/pim-data/workflow-helpers.js` (consolidating finding 7), the `users` sync step (§4). No routes switch yet; nothing user-facing changes.
2. **Read-only queries** — case detail, cases list, dashboard, tasks list, search, audit list, document *download* (metadata + generate-and-stream, per §5). Pure SELECT, zero transaction risk, highest immediate verifiable value (every screen renders through these). Party/address/advocate reads ship here as part of case detail, not as a separate phase.
3. **Users/settings** — `lib/pim-users.js` (incl. `ensureLastAdminSafe`), `lib/pim-settings.js`. Low-risk, no case-data dependency.
4. **Case intake** (`lib/pim.js`) — the first real transactional write; inherently includes party/address/advocate/fee writes (they don't exist as a separable step).
5. **Approval/registration** (`lib/pim-approval.js`) — depends on intake.
6. **Scrutiny** (`lib/pim-scrutiny.js`) — depends on intake; the module that proves the transaction mechanism handles read-then-check-then-write correctly (finding 8).
7. **Notices/service** (`lib/pim-fresh-notice.js`, `form2/*`, `service/[id]`, `address-correction/[id]`) — depends on approval. Form-2 document generation ships here.
8. **Responses/consent** (`lib/pim-op-response.js`, `response/[id]`, `consent/[id]`) — depends on notices/service.
9. **Non-starter workflow** (`lib/pim-nonstarter.js`, `nonstarter/*`) — depends on responses (most reasons are inferred from response/service-attempt facts). Form-3 document generation ships here.
10. **Mediation** (`mediator/*`, `mediation/*`, `fee/[id]`) — depends on responses; deliberately sequenced late since it includes the largest, most complex transaction in the app.
11. **Outcomes** (`outcome/*`) — depends on mediation. Form-4/5 document generation ships here.
12. **Reports** (`lib/pim-reports.js`) — deliberately last among reads: the heaviest concentration of date-arithmetic rewriting (not just driver-swapping), safest once every underlying table's Postgres shape is already proven by phases 2–11.
13. **Legacy import** (`lib/pim-legacy-import.js`) — deliberately last overall: the single largest, most complex transaction, touching every table above. By this point every individual write path it needs has already been individually proven, reducing its own risk to "does the orchestration transaction work," not "do these writes work." Tested with controlled data (`pim_cases` has zero real rows today, confirmed).
14. **Retire the SQLite runtime dependency** — only after every phase above ships and passes the gate in your instructions (new-case creation, complete workflow, document generation, reports, auth, authorization, legacy import, tests). `database/pim.db` and `database/schema.sql` are kept, not deleted, even after this — matches your standing instruction.

## 7. Service-role usage plan / RLS implications

Two tiers, deliberately not one:

- **Writes** — every operation in §1 that's currently a `db.transaction()`, plus simple single-statement writes: go through the **privileged, direct Postgres connection** from §3, used *only after* `requirePermission()` has already authorized the request. This is the same design Phase 4 already anticipated ("writes stay where the transaction lives: the Next.js server layer, using a privileged connection") — not a new decision, executing on one already made. RLS write policies remain absent by design (Phase 4); this connection doesn't need them and doesn't bypass anything RLS was supposed to enforce, because RLS was deliberately never asked to enforce writes.
- **Reads** — two viable paths, and I'm not picking one unilaterally because it's coupled to a decision outside this phase's scope:
  - **(a) Same privileged connection as writes** (simplest, consistent, correct today): `requirePermission("READ_CASE")` etc. already gates every GET route before any query runs, so this preserves exact current behavior with the least new moving parts. **This is what I'd start with for batch 1**, since the login flow doesn't yet issue real Supabase Auth sessions (Phase 3 deliberately left the custom cookie system live) — there's no user JWT available to build an RLS-scoped read client from yet.
  - **(b) The RLS-respecting authenticated client** (defense-in-depth, using Phase 4's real policies as designed): becomes available once — and only once — login itself is cut over to issue genuine Supabase Auth sessions. That's a bigger decision than a database-driver swap and isn't part of this design; flagging it as a valuable **future** hardening step once/if that cutover happens, not blocking Phase 6.
- **PostgreSQL RPC**: not used as a general mechanism (§3) — reserved for a specific future hot path if one ever justifies it.
- **No operation uses the service-role REST client (`@supabase/supabase-js` + `SUPABASE_SERVICE_ROLE_KEY`) directly for case data** — it can't do multi-statement transactions anyway (§3), and privileged access for reads/writes both come from the direct Postgres connection instead, which is a separate credential (a database connection string/password) with the same tier of care, not the same key. `SUPABASE_SERVICE_ROLE_KEY` stays reserved for what it's already used for (Phase 3's `lib/supabase-service.js`, `pim_profiles` resolution and user provisioning) — this design doesn't add new uses of it.

## 8. Test strategy

Per module, in the order of §6:
1. Keep the SQLite implementation (`lib/pim-*.js`) fully intact and callable — never removed until §6 step 14.
2. Build the Postgres equivalent in `lib/pim-data/*.js` alongside it, same exported signature.
3. For each business scenario the module handles (e.g. scrutiny: COMPLETE path, DEFECT path, the stale-double-click guard specifically), run it against both implementations with the same input.
4. Compare: returned data shape, and the resulting row state in each database (row counts, key column values) — not just "did it not throw."
5. Only after a module's tests pass do routes that use it switch their import from `lib/pim-X` to `lib/pim-data/X`. Switch is per-route, not a global flag, so a regression is isolated to the one route that just changed.

This mirrors your instruction directly ("do not migrate everything first and test only at the end") and is the same discipline already used across Phases 1–4 in this migration (build → verify → apply → verify again before moving on).

## 9. Files that will be modified in the first implementation batch (§6 step 1) — when it actually starts

**New** (no existing file touched yet):
- `lib/pim-data/client.js`
- `lib/pim-data/workflow-helpers.js`
- `scripts/sync-users-to-postgres.js`
- `package.json` / `package-lock.json` — add the `postgres` dependency
- `.env.local` — add a server-only direct-Postgres connection string (needs the database password, a secret I can't retrieve myself via any available tool — same category as `SUPABASE_SERVICE_ROLE_KEY` in Phases 3/4)

**Not modified in batch 1**: any `route.js` file, any existing `lib/pim-*.js` file, `lib/db.js`, `database/pim.db`, `database/schema.sql`, any existing migration file. Those start changing at §6 step 2 onward, one module at a time, per §8.

---

Nothing in this document has been applied — no dependency installed, no file beyond this one written, no migration created. Stopping here as instructed.
