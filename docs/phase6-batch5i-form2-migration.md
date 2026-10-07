# Phase 6 Batch 5I — Form II Workflow (No-Storage Document Model)

**Scope: `FORM2_PENDING → Prepare → Generate/version → Issue/Dispatch (incl. the first `pim_service_attempts` row) → SERVICE_PENDING`.** Service-result processing, returned-post handling, address correction, the fresh-notice/Final-Notice cycle, OP response/consent, mediation fee, mediator assignment, mediation sessions, outcomes, honorarium, the Nodal Officer model, and the SOP limitation module are explicitly **not** part of this batch — see `docs/phase6-sop-2026-frozen-rules.md` for why several of those are deliberately deferred project rules, not oversights.

This document records what Batch 5I built and what this session verified/fixed on top of it; see §8 for the session-specific work.

## 1. Why this batch, and why no-Storage

Phase 5 (Storage) was already skipped by design per `docs/phase6-migration-design.md` §5 — documents are generated on demand, never persisted to Supabase Storage or any permanent cloud location. Batch 5I is the first batch that actually exercises that design for a real document-generating workflow (Form II), extending the **generate-to-buffer, never-to-disk** pattern already proven for `lib/pim-document.js`'s DOCX rendering (`docxtemplater`/`pizzip` operate entirely on in-memory buffers) into the PostgreSQL write path.

## 2. Schema — the only DDL this batch applies

```sql
alter table pim_documents alter column file_path drop not null;
alter table pim_documents add column render_data jsonb;
```

Applied live to the `pim-system` Supabase project (`qqjmmxfvfrrzxirxtgtc`) as migration `20260930113901_form2_documents_no_storage_model`; mirrored locally at `supabase/migrations/20260930113901_form2_documents_no_storage_model.sql` (added during this session — the migration was already live but had no matching local file before this).

**No additional DDL was required.** Concurrency analysis (§4) found that row-level locking (`SELECT ... FOR UPDATE`) fully serializes every invariant this batch depends on — the same conclusion Batch 5E/T2 reached for its own concurrency analysis. No new unique constraint or partial index was added for `pim_documents(notice_id, version_no)` or "one current document per notice" — see §4 for why this is safe, not an oversight.

## 3. Module shape

```
app/api/pim/form2/[id]/route.js              GET (data loader) / POST (Prepare)
app/api/pim/documents/form2/[id]/route.js     POST (Generate/regenerate)
app/api/pim/form2/issue/[id]/route.js         POST (Issue/dispatch)
app/api/pim/documents/download/[caseId]/[documentId]/route.js   GET (download) — shared with every other document type
   ↓
lib/pim-data/form2.js   (new, PostgreSQL-only)
   ↓
lib/pim-postgres.js (withTransaction / getSql), lib/pim-data/workflow-helpers.js (getStatusId/addStatusHistory/addDocket),
lib/pim-document.js (renderForm2Template / buildForm2RenderValues / form2DocumentTitle — unchanged rendering logic, reused as-is)
```

Every route's original SQLite function is kept, unused, as the instant-rollback/historical-baseline reference (`prepareForm2Sqlite`, `issueForm2Sqlite`, `generateForm2Sqlite`) — same convention as every prior Phase 6 batch.

## 4. Concurrency — the three invariants and their proofs

**A. Concurrent duplicate Prepare (same case + party + notice type).** `prepareForm2NoticeTx` locks the **case** row (`SELECT ... FOR UPDATE`) before re-checking the case's status and querying for an existing active notice. Two concurrent Prepare calls for the same case serialize there; the loser re-reads the now-committed state and correctly rejects on the ordinary "already exists" guard. Proven live: `test [C]` — two concurrent Prepare calls for the same case+party+type, exactly one succeeds.

**B. Concurrent regeneration producing duplicate `version_no`/multiple `is_current` rows.** `generateForm2DocumentTx` locks the **notice** row before computing `MAX(version_no)+1` and before flipping the previous current row to `is_current = false`. This closes two races at once: a plain `MAX+1` read is only safe because nothing else can be reading/writing `pim_documents` for this notice concurrently, and a non-regenerate call correctly sees the first call's committed document and short-circuits to `reused: true` rather than creating a duplicate. Proven live: `test [H]` — two concurrent forced regenerations of the same notice produce sequential, distinct versions with exactly one `is_current`.

**C. Concurrent Issue creating duplicate service attempts/history/docket/task completion.** `issueForm2NoticeTx` locks the **notice** row (`FOR UPDATE OF n`) and the **case** row (`FOR UPDATE OF c`) before re-checking notice status (`PREPARED`) and case status. The loser re-reads `notice.status` after the winner commits and rejects on the ordinary "this notice cannot be issued" guard — never reaching a second `pim_service_attempts` insert, a second status-history pair, or a second task completion. The task-completion step itself additionally uses the guarded-UPDATE pattern already established in `lib/pim-data/scrutiny.js` (`WHERE status='PENDING'` + row-count check), so it can never double-complete even under a race this notice-level lock somehow didn't fully prevent. Proven live: `test [Q]` — same-notice concurrent Issue, exactly one commits, exactly one service attempt, no duplicate history/docket/task.

**Why no new DB constraint was added.** As in Batch 5E's T2 analysis, row-level locking that serializes every actual write path makes an additional unique constraint redundant for correctness — it would only add defense-in-depth, not close a real gap. This was checked, not assumed: `pg_constraint`/`pg_indexes` on `pim_documents` and `pim_notices` were queried live during this session (§8) and confirmed no backstop constraint exists beyond the primary key and FKs — and none is needed, because the lock ordering (case → nothing else, for Prepare; notice → nothing else, for Generate; notice → case, for Issue) fully serializes every concurrent pair that could otherwise race. This is reported here, per the task's instruction, rather than silently adding DDL beyond the one approved migration.

**Rollback.** All three mutations run inside one `withTransaction(...)` call each; a downstream failure rolls back every earlier write in the same call. Proven live: `test [V]` (three scenarios — Prepare, Generate, Issue, each with a forced failure after some writes already happened inside the transaction, each shown to roll back completely).

## 5. The no-Storage document model in detail

- **Generate** resolves `render_data` once (case/applicant/opposite-party/address values at that moment) and stores it as frozen JSONB plus metadata. `file_path` is always `NULL` for a row this module writes. No document buffer is rendered at Generate time — rendering is deferred entirely to Download.
- **Download** renders solely from the frozen `render_data` snapshot — never from `file_path` (always null here), never by re-reading current party/case/address data. A **historical** (non-current) version remains downloadable and reproduces its own frozen content even after a later edit (e.g. an address correction) would have produced different output had the renderer read live data. Proven live: `test [J]`, `[K]`, `[L]`.
- **postgres.js jsonb handling** (a genuine footgun, documented in both `lib/pim-data/form2.js` and the test file): this project's configured client returns a `jsonb` column as a raw JSON **string**, not an auto-parsed object. Every write casts an explicit `JSON.stringify(...)::jsonb`; every read goes through `parseRenderData()`/`documentToWire()`, never `row.render_data` directly. Missing this handling would silently produce `undefined` for every key on read, not a thrown error — called out explicitly because it is easy to miss.
- **Versioning is scoped by `notice_id`, not `case_id`.** A case can have more than one Form-2 notice (Initial, Fresh Initial, Final — each opposite party gets its own), each with an independent version lineage. Generating/regenerating one notice's document never flips another notice's current document. Proven live: `test [I]`.
- **No local file is written anywhere in this path.** Proven live: `test [M]` (no `storage/pim` file is created by any PostgreSQL Form-2 operation during a full test run).
- **The shared download route falls back cleanly.** `downloadForm2DocumentPg` returns `null` (not a throw) for any document id it doesn't own — a Form-3/4/5 document, a SQLite-only document, or a genuinely missing one — so `app/api/pim/documents/download/[caseId]/[documentId]/route.js` still serves every other document type through the original SQLite/local-file logic, unchanged. Proven live: `test [U]`.

## 6. SOP-aware forward compatibility (not implemented, only kept open)

Per the task's explicit boundary, none of the following were built in this batch — they were only checked for accidental foreclosure:

- **Service by post vs. email** — `pim_service_attempts.dispatch_mode` is free `TEXT` (default `'REGISTERED_POST'`, no `CHECK` enum constraint found on this column), so an `'EMAIL'` value can be added later with zero schema change.
- **Private notice** — nothing in this batch's schema or code assumes `dispatch_mode`/`pim_notices` can only ever represent post/email; a `'PRIVATE_NOTICE'` value and an Authority-permission record (per `docs/phase6-sop-2026-frozen-rules.md` rule 6) can be added additively.
- **Applicant contact-detail affidavit** — this batch does not touch `pim_parties`/intake at all; nothing here forecloses the affidavit field planned under rule 5.
- **Multiple notices for the same case** — already true today (Initial + Final, and the existing Fresh-Notice re-issue cycle via `lib/pim-fresh-notice.js`/`createFreshNoticeTx`), and this batch's `notice_id`-scoped versioning (§5) is what makes that safe rather than something that would need revisiting.

## 7. Dedicated test suite — `scripts/test-pim-form2-postgres.js`

28 tests, letters A–V plus S (static) and RESIDUE. Full matrix in §8's run log. Highlights beyond the concurrency tests already covered in §4:

- **[A]–[D]**: Prepare — success shape, duplicate rejection, wrong-case-status rejection.
- **[E]–[G]**: Generate — first version, reuse without `regenerate`, forced `regenerate=true` creates a new version and flips `is_current` while keeping the previous version's row intact.
- **[N]–[P]**: Issue — success through `SERVICE_PENDING` with exact two status-history hops and task completion, rejection with no generated document, rejection on wrong case status.
- **[T]**: permission denial (no identity → 401; `chairman`, not staff → 403) writes nothing, on both Prepare and Download.
- **[RESIDUE]**: exact-id fixture cleanup, zero leftover rows, **production year-2026 PIM sequence (`last_number = 118`) and `PIM/119/2026` confirmed untouched** after every run in this batch's own test and every regression suite re-run in §8.

Production safety, stated in the test file's own header comment and independently confirmed during this session (§8): this suite never calls the PIM-number allocator and never touches year 2026 — every fixture case is created directly at `FORM2_PENDING` by hand-setting `current_status_id` after a plain T1 intake, never through PIM-number assignment.

## 8. This session's work: verification, one regression fix, and full regression sweep

The schema (§2), `lib/pim-data/form2.js`, the four routes, and `scripts/test-pim-form2-postgres.js` were all already present and substantially complete at the start of this session (uncommitted working-tree state). This session's work was:

1. **Confirmed the migration was genuinely already applied** to the live `pim-system` project (not `dlsa-mis` — verified project id before every Supabase call) via `list_migrations`/`information_schema.columns`, and added the missing local mirror file (`supabase/migrations/20260930113901_form2_documents_no_storage_model.sql`) so a fresh clone reaches the same schema.
2. **Ran the concurrency analysis independently** (§4's "why no new DB constraint" paragraph) rather than taking the existing code's comments at face value — queried `pg_constraint`/`pg_indexes` live on `pim_documents`/`pim_notices` and confirmed no backstop beyond PK/FKs exists, and confirmed this is safe given the lock ordering already in place. No additional DDL was applied.
3. **Ran the dedicated 5I suite** (`scripts/test-pim-form2-postgres.js`): first attempt hit a transient `ECONNRESET` mid-run (test `[C]`) — the same known Supavisor pooler flakiness documented in every prior batch's report — cleaned two stale fixture case ids left behind (`--cleanup-only`), re-ran: **28 passed, 0 failed**.
4. **Found and fixed one genuine regression** while running the full regression sweep: `scripts/test-pim-read-loaders-postgres.js` (Batch 5F's own suite, covering the scrutiny-page `GET`) started failing test `[G]` ("null semantics... every nullable column stays null") because `lib/pim-data/scrutiny-read.js`'s `documents` query used `SELECT *`, which now picks up the new `render_data` column and serializes `"render_data": null` on every document row — a field the SQLite baseline has no equivalent of at all, breaking the established parity contract. **Fix**: changed that one query from `SELECT *` to the explicit pre-5I column list (`id, case_id, notice_id, document_type, document_title, document_date, file_path, generated_by_system, version_no, is_current, remarks, created_by, created_at`), in `lib/pim-data/scrutiny-read.js`. This is the only code change made outside `lib/pim-data/form2.js`'s own pre-existing files. Re-ran: **27 passed, 0 failed**. (`lib/pim-data/case-detail.js`'s own `pim_documents` query already used an explicit column list, not `SELECT *`, so it was never affected; `lib/pim-data/form2.js`'s own `SELECT *` reads of `pim_documents` are correct as-is — that module is supposed to see `render_data`.)
5. **Re-ran `scripts/test-pim-form2-postgres.js` after the fix** to confirm no interaction: 28 passed, 0 failed, unchanged.
6. **Ran every other regression suite individually** (never in parallel, matching established project doctrine for pooler load):

| Suite | Result |
|---|---|
| `test-pim-form2-postgres.js` (this batch) | **28 passed, 0 failed** |
| `test-pim-tx-context.js` | 8 passed |
| `test-pim-postgres.js` (Batch 1) | 10 passed |
| `test-pim-intake-postgres.js` (5C) | 15 passed |
| `test-pim-nonstarter-postgres.js` (5D) | 11 passed |
| `test-pim-scrutiny-postgres.js` (5E) | 44 passed |
| `test-pim-numbering-postgres.js` (5H-b) | 26 passed (1 N/A, by design — no SQLite counterpart exists for T3's replacement) |
| `test-pim-mediator-registry-postgres.js` (5H-a) | 30 passed |
| `test-pim-tasks-search-postgres.js` (5G) | 35 passed |
| `test-pim-read-loaders-postgres.js` (5F) | **27 passed, 0 failed** (after the fix in step 4; failed 1/27 before it) |

7. **`npx tsc --noEmit`**: clean.
8. **`npm run build`**: succeeded; every route (including the four Form-2 routes) listed in the build's route manifest.
9. **`npx eslint .`**: 160 problems (107 errors, 53 warnings) — the increase from the previously recorded 154/104/50 baseline (Batch 5H-a) is new-file growth following the codebase's existing, already-accepted `require()`-style-import convention (every new script and `lib/pim-data/*.js` file triggers the same pre-existing `@typescript-eslint/no-require-imports` rule every prior batch's files also trigger) — not a new category of lint issue. No `.eslintrc` or lint config was touched.
10. **Production-safety checks performed directly against the `pim-system` Supabase project** (id `qqjmmxfvfrrzxirxtgtc`; `dlsa-mis`, id `qpuucszfnzcymtgtzzsp`, was never queried or touched): `pim_number_sequences` shows exactly one row, `last_number = 118`, `updated_at` unchanged since its original 2026-09-30 initialization — confirming no PIM number (including `PIM/119/2026`) was consumed by any test run in this session. `pim_cases` is empty after this session's work, consistent with every prior batch's own stated production-safety doctrine (no batch's test suite calls the PIM-number allocator against the real year, and `pim_cases` was repeatedly confirmed at zero real rows at prior audit points); the row-count fluctuation observed mid-session was stale test-fixture residue from prior interrupted runs, cleaned by each suite's own exact-id manifest-based cleanup — not a deletion of real data (cross-checked against the untouched `pim_number_sequences` state, since any case that had reached real PIM-number assignment would have advanced that sequence).

## 9. What is NOT done (explicitly out of scope, per the task boundary)

Service-result recording, returned-post handling, the address-correction route, the fresh-notice cycle beyond what already existed, final-notice follow-up, OP response, consent, mediation-fee workflow, mediator assignment, mediation sessions, outcomes, honorarium, the Nodal Officer module, and the SOP limitation module are all untouched by this batch, per `docs/phase6-sop-2026-frozen-rules.md` and the task's explicit batch boundary. The final state this batch leaves every exercised case at is `SERVICE_PENDING` — nothing in this batch's code advances a case past that status.
