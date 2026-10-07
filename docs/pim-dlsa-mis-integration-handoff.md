# PIM → DLSA MIS Integration Handoff

Prepared 2026-10-07, at the end of today's production-completion sprint.
This document is for whoever performs the actual integration into
`dlsa-mis` — **not written today**, per the sprint's own instruction not to
touch `dlsa-mis` while PIM's operational workflows were still changing.

## 1. Routes / pages to carry over

All under `app/api/pim/**` (API) and `app/pim/**` (UI). Every route file
is self-contained (relative `require`s only into `lib/`), so the whole
`app/api/pim` and `app/pim` directory trees can move as units. No route
outside these two trees depends on PIM-specific code.

Non-operational/infrastructure routes that should **not** be assumed
PIM-specific when integrating auth: `app/api/pim/auth/**`,
`app/api/pim/backups/**`, `app/api/pim/health`, `app/api/pim/system-info`
— these may need to be reconciled with DLSA MIS's own auth/backup/health
conventions rather than copied verbatim.

## 2. PostgreSQL tables (live project: `pim-system`, id `qqjmmxfvfrrzxirxtgtc`)

Core: `pim_cases`, `pim_parties`, `pim_case_parties`, `pim_addresses`,
`pim_advocates`, `pim_case_advocates`, `pim_notices`,
`pim_service_attempts`, `pim_responses`, `pim_fees`, `pim_fee_payments`
(new this sprint), `pim_mediator_assignments`, `mediation_sessions`,
`pim_outcomes`, `pim_documents`, `pim_tasks`, `pim_task_history`,
`pim_docket`, `pim_status_history`, `pim_number_sequences` (historical/
compatibility only — no longer the allocator), `pim_number_corrections`
(new this sprint), `audit_log`.

Reference/lookup: `status_master`, `event_types`, `task_types`,
`dispute_categories`, `nonstarter_reasons`, `mediators`,
`system_settings`, `users`.

Legal KB (separate concern, not touched this sprint, explicitly excluded
from today's critical path): tables from
`20261006130000_legal_knowledge_base_schema.sql`.

**Migration history note — read before running any Supabase CLI command
against this project.** Comparing the local `supabase/migrations/`
directory against the live project's `supabase_migrations.schema_migrations`
table found that **nearly the entire migration history has a local
filename timestamp that differs from its remote-recorded applied
version** — all 12 of the original setup migrations
(`reference_and_lookup_tables` through `current_pim_role_revoke_anon`),
plus the Batch 5J contact-affidavit migration and both Legal KB
migrations, each have a different local-filename version than the
version Postgres actually recorded for them. One migration
(`20260930093508_pim_number_sequences_and_staff_numbering_master_data`)
has no local file at all — its original SQL text wasn't available to
reconstruct this session. This predates today's sprint entirely; it was
not introduced today and was not mass-corrected today (renaming a dozen
historical files during a wrap-up batch, without being certain of every
downstream consequence, is a disproportionate risk for what looks like a
cosmetic mismatch but could cause `db push`/`db diff` to treat already-applied
schema as unapplied and attempt to reapply it). Today's own two new
migrations (`manual_pim_numbering`, `mediation_fee_payments`) were
deliberately made to match their remote version exactly — see
`supabase/migrations/20261007060547_manual_pim_numbering.sql` and
`supabase/migrations/20261007061747_mediation_fee_payments.sql` — and
that practice (local filename = remote applied version, always) is the
recommended one going forward. **Before running any Supabase CLI
migration command against this project, reconcile the inherited drift
first** — most likely by re-timestamping the local files to match
`schema_migrations` exactly (the SQL content doesn't need to change, only
the filename), and separately deciding what to do about the one
genuinely missing local file.

## 3. APIs / data modules (`lib/pim-data/*.js`)

The authoritative PostgreSQL business logic, one module per workflow
area. Every one follows the same pattern: `*Tx` functions take a
transaction client and do the real work; `*Pg` functions wrap them in
`withTransaction` (`lib/pim-postgres.js`) for the HTTP route to call.

`intake.js`, `scrutiny.js`/`scrutiny-read.js`, `pim-numbering.js`
(manual-entry + legacy auto-allocator, kept inert), `form2.js`,
`service.js`, `response.js`, `fee.js` (new), `mediator-registry.js` +
`mediator-registry-read.js` (profile CRUD) + `mediator-assignment.js`
(new — case assignment, distinct from the registry), `mediation.js`
(new), `nonstarter.js` + `nonstarter-read.js`, `outcome.js` (new),
`outcome-documents.js` (new), `form3-documents.js` (new), `reports.js`
(new), `case-detail.js`, `cases.js`, `dashboard.js`, `search-read.js`,
`tasks-read.js`, `settings.js`, `users.js`, `workflow-helpers.js` (shared
status/docket/task helpers), `wire-compat.js` (SQLite-shape
compatibility for the read loaders).

`lib/pim-postgres.js` is the single PostgreSQL connection point
(`postgres` npm package, direct connection — not the Supabase REST
client, which cannot provide real multi-statement transactions).
`lib/pim-document.js` holds the pure (no DB access) template-rendering
functions reused by every document generator.

## 4. Permissions

Checked via `requirePermission(request, "PERMISSION_NAME")`
(`lib/pim-auth.js`). Permission names used throughout (grep
`requirePermission(request, "` across `app/api/pim/**` for the
exhaustive list): `READ_CASE`, `RECORD_FEE`, `ASSIGN_MEDIATOR`,
`RECORD_MEDIATION_SESSION`, `RECORD_OUTCOME`, `APPROVE_OUTCOME`,
`GENERATE_DOCUMENT`, `COMPLETE_NONSTARTER_FORM3`,
`APPROVE_NONSTARTER_AUTHORITY`, `ASSIGN_PIM_NUMBER`,
`INITIALIZE_PIM_SEQUENCE`, `ISSUE_NOTICE`, `RECORD_SERVICE`, and others
for scrutiny/intake/settings/users not touched today. Role→permission
mapping lives in `lib/pim-auth.js`'s `permissionSummary()`. DLSA MIS's
own role model will need to be reconciled against this set before
integration — do not assume role names match.

## 5. Environment variables

`SUPABASE_DB_URL` (server-only, the direct Postgres connection string —
**never** expose as `NEXT_PUBLIC_*`, never log, never return in an API
response), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` (used elsewhere in the app, not by the PG
data-access layer directly), `PIM_DB_PATH`/`PIM_DB_LOG` (SQLite, legacy
path), `PIM_ALLOW_HTTP_LAN` (trusted-LAN session support, see
`lib/pim-auth.js`), `PIM_DEV_USER_ID` (dev-only auth bypass — must not
exist in any production environment).

## 6. Auth assumptions

Session/auth itself (`lib/pim-auth.js`) is **not** part of today's
Postgres migration — it was out of scope and untouched. It currently
reads from both SQLite (users/sessions tables predating the Postgres
work) and has its own trusted-LAN HTTP exception (`c60dded`, the commit
immediately before today's sprint started). Whoever integrates needs to
decide whether DLSA MIS's own auth takes over entirely, or whether this
module's session model is preserved as-is for PIM routes specifically.

## 7. Navigation entry point

`app/pim/layout.tsx` + `app/pim/page.tsx` is the top-level entry; every
other `app/pim/**` page is a child route reached from there. No
assumptions about DLSA MIS's own navigation shell were made in any PIM
page — they are plain Next.js pages with their own `<main>` wrapper, not
embedded in a shared layout.

## 8. Dependencies

`postgres` (the PostgreSQL driver — `lib/pim-postgres.js`),
`better-sqlite3` (legacy SQLite, still used by unmigrated
auth/session/backup code and the historical-reference functions kept in
every migrated module), `docxtemplater` + `pizzip` (document rendering,
`lib/pim-document.js` — both the `{{field}}`-delimited templates used by
Form-2/3 and the regex-label renderer used by Form-4/5).

## 9. Reports

14 operational reports plus a monthly statement, all PostgreSQL-
authoritative as of today (`lib/pim-data/reports.js`,
`app/api/pim/reports/**`). See `docs/phase6-reports-migration.md` for the
one explicitly known limitation (`fees_pending` and `feePaidCases` still
reflect only the legacy `pim_fees` table, not `pim_fee_payments`).

## 10. Tests

Every `scripts/test-pim-*-postgres.js` file is a self-contained,
fixture-isolated integration test against the live `pim-system` Postgres
project (never against a separate test database — there isn't one).
Each cleans up its own fixtures and verifies zero residue on exit. Run
them **serially**, never concurrently (the shared connection pooler has
shown instability under concurrent load). `scripts/test-pim-e2e-lifecycle.js`
is the full golden-path + branch coverage test; `scripts/test-pim-reports-parity.js`
is the SQLite-vs-Postgres side-by-side comparison for reports.

## 11. Production data considerations

- As of this sprint's final audit, the live Postgres project contains
  **no genuine production case data** — only 8 stale test fixtures from
  a prior session (2026-10-06), and the SQLite database accessible to
  this session has zero case rows at all. If real historical PIM cases
  (including the one referred to as "PIM 109/2026" in the sprint brief)
  exist, they live in a SQLite file or environment this session did not
  have access to, and have **not** been migrated into Postgres. A
  dedicated legacy-import pass (`lib/pim-legacy-import.js` exists for
  this, but was not run today) will be needed before Postgres can be
  treated as containing the full case history.
- `pim_number_sequences` for 2026 is `last_number = 118` — this is now
  historical/inert (the allocator was replaced this sprint), but should
  still not be altered without reason, in case any rollback to the old
  auto-allocation policy is ever needed.

## 12. What must NOT be duplicated

- Do **not** reintroduce a second PostgreSQL connection path alongside
  `lib/pim-postgres.js` — it is the single point that configures
  SQLite-compatible type parsing (bigint/numeric/date), and a second,
  differently-configured client would silently reintroduce the
  type-shape bugs Batch 2 already found and fixed once.
- Do **not** reintroduce file-based document storage for Form-2/3/4/5 —
  they are deliberately no-storage (`render_data` jsonb, rendered on
  download). Adding a Supabase Storage or local-disk path for these
  would create two sources of truth for the same document.
- Do **not** re-enable `pim_number_sequences` auto-allocation in any new
  code path — the numbering policy is manual-entry-only as of this
  sprint; the auto-allocator functions are kept only as an inert
  rollback reference and must never be called from a live route again.
- Do **not** write case-management data to SQLite from any new PIM code —
  as of today's final closure batch, zero operational case-management
  writes remain SQLite-authoritative; don't reintroduce one.

## 13. Integration order (suggested, not prescribed)

1. Reconcile auth/session model first — every PIM route depends on
   `requirePermission`, and DLSA MIS's own auth needs to either adopt or
   wrap it before anything else will function.
2. Bring over `lib/pim-postgres.js`, `lib/pim-data/**`, `lib/pim-*.js`,
   and the Supabase migrations as a unit — they have no dependency on
   `app/pim/**` and can be verified independently (run the test scripts
   against the target environment's Postgres connection).
3. Bring over `app/api/pim/**`, re-run the full test suite serially
   against the integrated environment.
4. Bring over `app/pim/**` (UI) and wire navigation into DLSA MIS's
   shell.
5. Reconcile the inherited migration-history drift (section 2) before
   running any Supabase CLI migration command against the integrated
   project.
6. Only then consider the legacy-import pass for historical case data,
   if genuine historical cases need to be brought into Postgres.

## 14. Rollback plan

- Every migrated module kept its SQLite-era implementation as an inert,
  clearly-named (`*Sqlite` suffix) function in the same file, never
  called by any live route. Reverting a single workflow to SQLite means
  re-pointing that one route's import back to the old function — no
  code deletion was done anywhere this sprint.
- No destructive migration was run today — every schema change was
  additive (`CREATE TABLE`, `ADD COLUMN IF NOT EXISTS`). Dropping the new
  tables (`pim_fee_payments`, `pim_number_corrections`) and the two new
  `pim_cases` columns (`running_number`, `pim_year`) would fully reverse
  today's schema changes if ever needed, with no data loss beyond what
  was added today.
- `pim_number_sequences` and its auto-allocation code path were
  deliberately left intact and functional, specifically so that
  reverting the numbering policy change is a route-level revert, not a
  data-recovery problem.
