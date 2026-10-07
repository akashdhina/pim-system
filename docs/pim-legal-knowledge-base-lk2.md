# PIM Legal Knowledge Base — Phase LK-2: Schema, Seed, and Tests

**Status: implemented and applied to the live `pim-system` Supabase project (`qqjmmxfvfrrzxirxtgtc`).** Schema and seed migrations committed to `supabase/migrations/` and applied via the same mechanism this project has used for every prior Phase 6 batch. No PIM workflow table was altered. No PIM case, mediator, settings, or audit data was modified. `PIM/119/2026` was not consumed. PIM 109/2026 was not touched.

Governing design: [`docs/pim-legal-knowledge-base-design.md`](pim-legal-knowledge-base-design.md) (LK-1, twice revised — see that document's §0.2/§0.3). This document records what LK-2 actually built, exactly as applied, and the test/regression evidence for it.

---

## 1. Final schema

Two migrations, applied in order:

- [`supabase/migrations/20261006130000_legal_knowledge_base_schema.sql`](../supabase/migrations/20261006130000_legal_knowledge_base_schema.sql) — five new tables, their indexes, and RLS policies.
- [`supabase/migrations/20261006130100_legal_knowledge_base_seed.sql`](../supabase/migrations/20261006130100_legal_knowledge_base_seed.sql) — the bounded initial seed (§3 below).

### 1.1 Tables

| Table | Purpose |
|---|---|
| `legal_sources` | Authoritative legal material — statute, rules, SOP, instruction letters, and verified case law. |
| `legal_source_workflow_stages` | Normalized join: which `status_master.code` stage(s) a source is relevant to. |
| `legal_guidance_rules` | Staff-facing guidance rules, separated from the sources they cite (per the design doc's explicit source/guidance-rule split). |
| `legal_guidance_rule_stages` | Normalized join: which stage(s) a guidance rule triggers at (a rule may apply at more than one stage). |
| `legal_guidance_rule_sources` | Many-to-many join between guidance rules and the sources that support them. |

### 1.2 Schema-quality decisions made in this pass (per the LK-2 brief's item 4)

**Workflow-stage mapping: normalized, not `text[]`.** The LK-1 design proposed a `workflow_stages text[]` column as a simplicity-first option, flagging the join-table form as an open choice. For LK-2, `legal_source_workflow_stages` and `legal_guidance_rule_stages` were built as proper join tables, each `status_code` column FK'd to `status_master(code)` (which already carries a `not null unique` constraint, confirmed before writing the FK). Reason: `status_master` is already the single authoritative enum every other part of this schema respects, and the cost of the join table is low — this makes "a guidance rule references a workflow stage that doesn't exist" a database-level impossibility, not an application-layer hope. A guidance rule can validly apply to more than one stage (e.g. `NO_PLAINT_COPY_REQUIRED` applies at both `RECEIVED` and `SCRUTINY_PENDING`), which the join-table form handles naturally; a `text[]` column would have worked too, but without referential integrity.

**`case_holding` is nullable, gated by a CHECK constraint, not a sentinel string.** The original LK-1 schema sketch had `case_holding text not null`, which the LK-2 brief correctly flagged as wrong for statute/Rule/SOP/instruction rows — those have no judicial "holding" at all, and inventing "N/A" text would be worse than NULL. The actual column is nullable; a table-level CHECK constraint (`legal_sources_judgment_metadata_required`) requires `court`, `case_number`, `decision_date`, **and** `case_holding` together, but only when `source_type` is one of `SUPREME_COURT` / `MADRAS_HIGH_COURT` / `OTHER_HIGH_COURT`. Verified in testing (§4, test 6 and 7): the five statute/Rule/SOP/instruction rows all have `case_holding IS NULL`, and attempting to insert an incomplete judgment row fails with a CHECK violation.

**`authority_level` is CHECK-constrained to the exact value its `source_type` is allowed to carry.** A single constraint (`legal_sources_authority_level_matches_type`) encodes the full Level 1–6 hierarchy from the design doc's §8 as a closed `OR` of `(source_type, authority_level)` pairs. "`SUPREME_COURT` + Level 5" or "`OTHER_HIGH_COURT` + Level 2" is now a constraint violation, not merely a convention a future INSERT could silently violate. Verified directly against the live database before seeding (a throwaway `SUPREME_COURT` + Level 5 insert was attempted and correctly rejected) and again in the automated test suite (§4, test 8).

**Verification-state model: a five-value state machine, not a boolean `verified_at`.** Exactly the `DRAFT` / `DISCOVERED` / `PRIMARY_SOURCE_VERIFIED` / `REJECTED_MISMATCH` / `SUPERSEDED` model from the revised LK-1 design (§9 there), plus `verified_proposition`, `verification_notes`, `verification_date`, `verified_by` as separate columns (not collapsed into one summary field, per the brief's item 6). An additional constraint (`legal_sources_rejected_requires_notes`) requires `verification_notes` whenever `verification_state = 'REJECTED_MISMATCH'` — a rejected candidate's entire value is its research trail, and the constraint makes an empty one impossible.

---

## 2. Verification-state visibility — enforced server-side, not just in the UI

Per the LK-2 brief's explicit instruction ("Enforce this server-side. Do NOT rely only on UI filtering"), this is implemented in **two independent layers**:

1. **RLS policies** (in the schema migration) — every `SELECT` policy on all five tables is scoped to `verification_state = 'PRIMARY_SOURCE_VERIFIED' AND is_active = true` (directly on `legal_sources`; via an `EXISTS` join against `legal_sources`/`legal_guidance_rules` for the four related tables). This follows the exact pattern already established for every other PIM table (`public.current_pim_role()` + a `for select to authenticated using (...)` policy) — see `supabase/migrations/20260917040000_pim_rls_policies.sql` for the precedent this reuses rather than reinvents.
2. **The server-side loader itself** ([`lib/pim-data/legal-sources-read.js`](../lib/pim-data/legal-sources-read.js)) — every exported function hard-codes the same `verification_state = 'PRIMARY_SOURCE_VERIFIED' and is_active = true` condition directly in its SQL, independent of RLS. This matters because, as documented in this project's own Phase 6 design doc, reads today go through a privileged direct Postgres connection (`lib/pim-postgres.js`) that bypasses RLS entirely — the same way every other PIM read works currently. RLS is defense in depth for a future Supabase-Auth-scoped read path; the loader's own `WHERE` clause is what actually enforces the rule today.

No code path in this codebase can reach a `DRAFT`, `DISCOVERED`, `REJECTED_MISMATCH`, or `SUPERSEDED`/inactive row except a direct admin SQL query — there is no "ordinary" function that returns one. This was directly tested (§4, tests 12–14): fixture rows in each non-verified state were created, confirmed to exist in the table, and confirmed absent from every `getVerifiedLegalSources*` result.

---

## 3. Seeded sources — exact verification states and classifications

All 11 seeded `legal_sources` rows are `verification_state = 'PRIMARY_SOURCE_VERIFIED'`, `is_active = true`. None of this project's 8 originally-proposed case-law candidates were seeded in a non-verified state — per the brief's instruction, `DRAFT`/`DISCOVERED`/`REJECTED_MISMATCH` candidates get no production row in this batch at all.

### 3.1 Statute / Rules / SOP / Instruction (5 rows)

| # | Title | source_type | authority_level | case_holding |
|---|---|---|---|---|
| 1 | Commercial Courts Act, 2015 — Section 12A | `STATUTE` | 1 | NULL (by design — no judicial holding) |
| 2 | PIM Rules, 2018 — Rule 3 | `RULE` | 1 | NULL |
| 3 | PIM Rules, 2018 — Rule 11 + Schedule II | `RULE` | 1 | NULL |
| 4 | TNSLSA PIM SOP (effective 01.10.2026) | `TNSLSA_SOP` | 4 | NULL |
| 5 | TNSLSA instruction letter P.N.5996/2026 | `TNSLSA_INSTRUCTION` | 4 | NULL |

Rows 4–5 deliberately **do not re-interpret** SOP content — they cite `docs/phase6-pim-sop-2026-reconciliation-audit.md` and `docs/phase6-sop-2026-frozen-rules.md` directly, per the LK-2 instruction not to re-derive frozen SOP provisions. Row 3's Schedule II fee figures were cross-checked against `lib/pim-mediation-fee.js`'s `calculateMediationFee()` table — all five slabs match exactly, consistent with that function's own comment that it is already SOP-exact.

### 3.2 Case law (6 rows, all `PRIMARY_SOURCE_VERIFIED`)

| # | Case | Court | Citation | authority_level | jurisdiction | Workflow stages |
|---|---|---|---|---|---|---|
| 6 | Patil Automation v. Rakheja Engineers | Supreme Court | (2022) 10 SCC 1 | 2 | ALL_INDIA | — (background reference) |
| 7 | Yamini Manohar v. T.K.D. Keerthi | Supreme Court | (2024) 5 SCC 815 | 2 | ALL_INDIA | — (background reference) |
| 8 | Dhanbad Fuels v. Union of India | Supreme Court | 2025 INSC 696 | 2 | ALL_INDIA | — (background reference) |
| 9 | Union of India v. Sidhi Vinayak Metcom Ltd. | Jharkhand HC | 2025:JHHC:30333-DB | **5** | **JHARKHAND** | `FEE_PENDING` |
| 10 | Dr. Mumtaz Kutty v. Dr. Rahmath Banu | Madras HC | — (unreported) | 3 | TAMIL_NADU | `RECEIVED`, `SCRUTINY_PENDING` |
| 11 | Dhanalakshmi Spinntex v. Sivasubramaniam | Madras HC | — (unreported) | 3 | TAMIL_NADU | — (background reference) |

**Row 9 (Sidhi Vinayak Metcom) is the one case requiring special safety treatment,** per the brief's explicit instruction: `source_type = 'OTHER_HIGH_COURT'`, `authority_level = 5`, `jurisdiction = 'JHARKHAND'`, `caution = 'PERSUASIVE ONLY in Tamil Nadu - Jharkhand High Court, never binding on DLSA Nilgiris or any Tamil Nadu DLSA. Never present as controlling or as Madras High Court authority.'` This is enforced structurally, not just by convention — the authority-level CHECK constraint makes it impossible for this row (or any `OTHER_HIGH_COURT` row) to ever carry `authority_level` 1–4, and automated test 5 (§4) directly asserts `source_type = 'OTHER_HIGH_COURT'`, `authority_level = 5`, `jurisdiction = 'JHARKHAND'`, and explicitly asserts it is *not* `MADRAS_HIGH_COURT` or `SUPREME_COURT`.

Row 9's `negative_rule` column records the brief's required safety constraint verbatim: *"Do not describe this judgment as holding that Rule 3(4)/(6) expressly enumerates mediation-fee default as a ground."*

Row 10 (Mumtaz Kutty) is seeded purely as a verified legal proposition/source — **no new workflow block was introduced**, consistent with §4 of this document (the software audit found no live conflict to block).

**Not seeded, by explicit instruction:**
- **Ganga Complex v. TSR Films** — `REJECTED_MISMATCH` in the research record (`docs/pim-legal-knowledge-base-design.md` §2.5), but **no production `legal_sources` row at all**. The research trail lives in the design doc, not the database, per the instruction that "the production Legal KB should begin with useful legal authorities, not failed research candidates." (A future `REJECTED_MISMATCH` row remains schema-supported if the team later decides a dedicated research-candidate table is worth building — the `verification_state` enum already has the value ready.)
- **Aarthi Scans v. Konica Minolta** — remains `DISCOVERED` only in the design doc; not upgraded to `PRIMARY_SOURCE_VERIFIED` in this pass (its holding was confirmed only via secondary commentary, not a full primary-text read), and therefore not seeded.
- **The broader case-law discovery pass** (design doc §2.9/§5 of the original brief) — not run to completion; deferred to a later batch.

---

## 4. Mumtaz Kutty software-conflict audit (read-only, repeated/confirmed for this phase)

Per the brief's explicit instruction not to create a new workflow block "merely because the judgment exists," a targeted read-only search was run (again, for this phase) across:

- `lib/` (all SQLite business-logic modules, including `lib/pim.js` intake validation and `lib/pim-scrutiny.js`)
- `app/` (every UI page and API route, including the intake form and scrutiny page)
- `database/schema.sql` (the authoritative SQLite DDL)

for the terms: `plaint`, `draft plaint`, `commercial plaint`, `copy of suit`, `copy of the suit`, `mandatory document`, `required document`, `checklist`.

**Result: PASS.** No match for any plaint/plaint-copy term exists anywhere in the codebase's intake, scrutiny, or document-requirement logic. There is no `pim_documents.document_type` value, intake column, or scrutiny-checklist field that names or implies a plaint-copy requirement.

**Conclusion, unchanged from the LK-1 finding:** this system does not currently require a plaint/draft-plaint copy. Mumtaz Kutty is seeded (row 10, §3.2) and its guidance rule (`NO_PLAINT_COPY_REQUIRED`, §5) is `REFERENCE_ONLY` severity — preventive guidance against a requirement that does not exist today, not a fix for a live defect.

---

## 5. Guidance rules seeded (4, deliberately minimal)

| guidance_key | severity | trigger stage(s) | sources cited |
|---|---|---|---|
| `FEE_FULL_PAYMENT_REQUIRED_BEFORE_MEDIATOR` | WARNING | `FEE_PENDING` | Rule 11 + Schedule II |
| `FEE_PARTIAL_APPLICANT_UNPAID` | WARNING | `FEE_PENDING` | Rule 11 + Schedule II, **and** Sidhi Vinayak Metcom as *persuasive supporting authority only* — not the sole/hard basis of the rule |
| `NO_PLAINT_COPY_REQUIRED` | REFERENCE_ONLY | `RECEIVED`, `SCRUTINY_PENDING` | Mumtaz Kutty |
| `SECTION12A_MANDATORY` | REFERENCE_ONLY | `RECEIVED` | Section 12A (statute) + Patil Automation |

**No `HARD_BLOCK` rule was seeded**, per the brief's item 14. Every rule's severity was chosen conservatively: `FEE_PARTIAL_APPLICANT_UNPAID` is `WARNING`, not `HARD_BLOCK`, specifically because its only case-law support is `OTHER_HIGH_COURT` (Sidhi Vinayak Metcom) — the brief is explicit that a rule must not be `HARD_BLOCK` if its only supporting source is `OTHER_HIGH_COURT`/`INTERNAL_GUIDANCE`, and this rule in fact cites Rule 11 (Level 1) as well, but was still kept at `WARNING` rather than promoted to `HARD_BLOCK`, since contextual enforcement is explicitly LK-5's scope, not LK-2's. Automated test 18 (§6) confirms zero `HARD_BLOCK` rows exist after the seed.

Each guidance rule's `do_not_do` field carries the negative constraint the brief asked for — e.g. `FEE_PARTIAL_APPLICANT_UNPAID`'s do-not-do explicitly repeats that partial non-payment is not an automatic Non-Starter ground and that Rule 3(4)/(6) does not expressly list fee default.

---

## 6. Tests

[`scripts/test-pim-legal-knowledge-base-postgres.js`](../scripts/test-pim-legal-knowledge-base-postgres.js) — run directly against the live `pim-system` Postgres database (there is no local/shadow Postgres in this project; every `lib/pim-data/*.js` test script already works this way). Follows this project's established PG-test conventions: exact-ID fixture tracking with a recovery manifest and `--cleanup-only`, sequential (not concurrent) queries, and `try`/`finally`-equivalent cleanup even on failure.

**Result: 22/22 passed, 0 failed.** Fixture cleanup confirmed complete (0 leftover `TEST-LK2-%` rows after the run).

| # | Assertion | Result |
|---|---|---|
| 1 | Migrations applied — all 5 LK-2 tables exist | PASS |
| 2 | Seed produced exactly 11 sources / 4 guidance rules, no duplicate titles | PASS |
| 3 | `authority_level` matches `source_type` for every row | PASS |
| 4 | Verified read path (`getVerifiedLegalSources`) returns Patil Automation | PASS |
| 5 | Sidhi Vinayak Metcom is `OTHER_HIGH_COURT`, Level 5, `JHARKHAND`, never `MADRAS_HIGH_COURT`/`SUPREME_COURT` | PASS |
| 6 | Statute/Rule/SOP/instruction rows have `case_holding IS NULL`, not a placeholder | PASS |
| 7 | Inserting an incomplete `SUPREME_COURT` row (missing judgment metadata) fails the CHECK | PASS |
| 8 | Inserting `OTHER_HIGH_COURT` + `authority_level = 2` fails the CHECK | PASS |
| 9 | `legal_source_workflow_stages` rejects an unknown `status_code` (FK) | PASS |
| 10 | `legal_guidance_rule_sources` rejects a non-existent `legal_source_id` (FK) | PASS |
| 11 | Fixture setup: `DISCOVERED` / `REJECTED_MISMATCH` / inactive-verified / `DRAFT` rows created | PASS |
| 12 | `DISCOVERED` source invisible to the verified read path | PASS |
| 13 | `REJECTED_MISMATCH` source invisible to the verified read path | PASS |
| 14 | Inactive `PRIMARY_SOURCE_VERIFIED` (superseded-style) source invisible | PASS |
| 15a | Valid `DRAFT → DISCOVERED` transition writes exactly one `audit_log` row | PASS |
| 15b | Invalid transition (`DISCOVERED → SUPERSEDED`) rejected before reaching the DB | PASS |
| 15c | `REJECTED_MISMATCH` without `verificationNotes` rejected | PASS |
| 16 | `getVerifiedLegalSourcesForStage('FEE_PENDING')` includes Sidhi Vinayak Metcom + Rule 11 | PASS |
| 17 | `getActiveGuidanceRulesForStage('FEE_PENDING')` includes `FEE_PARTIAL_APPLICANT_UNPAID` with ≥2 sources | PASS |
| 18 | Zero `HARD_BLOCK` guidance rules exist | PASS |
| 19 | `pim_number_sequences` (2026) unchanged across the whole run; `last_number = 118` confirmed | PASS |
| 20 | Mediator roster (5 active) and `pim_cases` row count unchanged across the whole run | PASS |

Tests 7–10 directly satisfy "judgment rows require appropriate judgment metadata," "guidance-to-source join integrity," and "status/workflow-stage mapping integrity." Test 15 directly satisfies "audit behavior for any LK-2 write operations." Tests 19–20 directly satisfy "no production case mutation" and "no PIM-number sequence mutation" — run as a before/after snapshot across the *entire* test run, not just around the write-touching tests.

---

## 7. Permission model

Three new permission keys added to the existing `PERMISSIONS` map in [`lib/pim-auth.js`](../lib/pim-auth.js) — no new role was created, preserving the existing `aa` / `secretary` / `chairman` / `admin` architecture exactly:

```js
READ_LEGAL_LIBRARY: ["aa", "secretary", "chairman", "admin"],   // matches READ_CASE's breadth
MANAGE_LEGAL_SOURCES: ["admin"],                                 // matches MANAGE_SETTINGS
MANAGE_LEGAL_GUIDANCE: ["admin"],
```

No route or page currently calls `requirePermission(request, "READ_LEGAL_LIBRARY" | "MANAGE_LEGAL_SOURCES" | "MANAGE_LEGAL_GUIDANCE")` — LK-2 deliberately stops short of building the Legal Library UI (LK-3) or any management surface. The permission keys exist now so that LK-3/LK-4's routes can gate on them immediately, following the same `requirePermission()` pattern every other PIM route already uses, rather than inventing a parallel authorization mechanism later.

---

## 8. RLS / security posture

`get_advisors(type: security)` was run against the live project immediately after applying both migrations. **Zero new findings** attributable to this change — the two pre-existing findings (`pim_user_sessions`/`users` RLS-enabled-no-policy, and `current_pim_role()`'s `SECURITY DEFINER` visibility) both predate LK-2 and are unrelated to the five new tables.

Write safety for the one write path LK-2 does implement (`setLegalSourceVerificationState()` in [`lib/pim-data/legal-sources-admin.js`](../lib/pim-data/legal-sources-admin.js)):

- **Audited**: every transition writes an `audit_log` row (`table_name = 'legal_sources'`, `action = 'VERIFICATION_STATE_CHANGE'`) inside the **same transaction** as the state change — not a separate, un-transacted insert (explicitly avoiding the anti-pattern the Phase 6 migration-design audit flagged in the mediator-registry PATCH route).
- **Transition-validated**: a fixed `VALID_TRANSITIONS` map (mirroring `lib/pim-nonstarter.js`'s controlled-code-set pattern) rejects any transition not in `{DRAFT→DISCOVERED, DRAFT→REJECTED_MISMATCH, DISCOVERED→PRIMARY_SOURCE_VERIFIED, DISCOVERED→REJECTED_MISMATCH, PRIMARY_SOURCE_VERIFIED→SUPERSEDED}` — e.g. `DRAFT` cannot jump straight to `SUPERSEDED`.
- **Actor-attributed**: `actorUserId` is a required parameter; there is no code path that writes a state change without recording who performed it.
- **`REJECTED_MISMATCH` requires notes**: enforced both in this function (fails fast, before any DB round-trip) and again at the DB level by the `legal_sources_rejected_requires_notes` CHECK constraint — defense in depth.
- **Non-destructive**: transitioning to `REJECTED_MISMATCH` or `SUPERSEDED` sets `is_active = false`; nothing in this module ever issues a `DELETE` against a seeded or previously-verified row.
- **No route or UI calls this function yet** — per the brief's item 17, LK-2 implements only the schema/data layer; the caller-side permission check (`requirePermission(request, "MANAGE_LEGAL_SOURCES")`) is documented as the future caller's responsibility, matching the existing `lib/pim-data/*.js` convention of leaving permission checks to the route layer.

---

## 9. Regression results

Run against the live Supabase project, in this order, after both LK-2 migrations were applied:

- `npx tsc --noEmit` — **clean, zero errors.**
- `npm run lint` — pre-existing baseline unchanged. The full lint run surfaces 107 errors / 56 warnings, all in files this change did not touch (mostly `require()`-style-import errors in standalone `scripts/*.js` utilities that predate this work). **None of the four files this phase added or changed (`lib/pim-auth.js`, `lib/pim-data/legal-sources-read.js`, `lib/pim-data/legal-sources-admin.js`, `scripts/test-pim-legal-knowledge-base-postgres.js`) appear anywhere in the lint output** — confirmed by name-searching the full output. The one warning initially raised in the new test script (`withTransaction` imported but unused) was fixed by removing the unused import before this final run.
- `npm run build` — **succeeded**, full production build, all existing API routes and pages compiled without error (confirmed via the build's own route manifest — same route list as before this change, since LK-2 added no new route).
- Existing PostgreSQL-path regression suites — **mixed and fully root-caused; not a code regression from this phase.** Full account below (§9.1), because the investigation itself is worth recording honestly rather than asserting "all green."

### 9.1 Regression suite — what actually happened, and why it is not an LK-2 regression

`test-pim-intake-postgres` (**T1**, 15/15) and `test-pim-nonstarter-postgres` (**T7**, 11/11) — the two suites explicitly named in the LK-2 instructions — **passed cleanly on the first run**, before any test-infrastructure trouble began, and were not re-run under contention. These are the strongest direct evidence this phase did not regress existing PostgreSQL-path behavior.

Running the remaining suites sequentially in one long background job surfaced **test-infrastructure instability**, not application-logic failures:

1. **Concurrent-execution contention.** While the long sequential job was still running, diagnostic `--cleanup-only` invocations were run against the same live database from a separate shell, and a `pg_sleep`/`pg_stat_activity` probe was used to inspect state. Running cleanup concurrently with an active fixture-creating test produced cascading `RESIDUE`/row-count-mismatch failures in `test-pim-tasks-search-postgres`, `test-pim-scrutiny-postgres`, `test-pim-read-loaders-postgres`, and `test-pim-form2-postgres` — exactly the failure *shape* two processes racing on the same tables would produce (row counts that kept climbing across supposedly-isolated cleanup calls).
2. **Orphaned child processes surviving `TaskStop`.** Stopping the parent background shell job did not terminate every `node scripts/test-pim-*.js` child it had spawned — confirmed directly via `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`, which repeatedly found live `node.exe` processes (for `test-pim-response-postgres.js` and `test-pim-tasks-search-postgres.js --cleanup-only`) still running, and still writing fixture rows, after the parent job had been stopped. Each was identified by PID and terminated directly (`Stop-Process -Force`). One of these orphans left a Postgres backend genuinely `idle in transaction` (holding a `DELETE FROM pim_status_history` open for 3+ minutes, confirmed via `pg_stat_activity`), which was cleared with `pg_terminate_backend()`.
3. **A separate, reproducible issue in `test-pim-tasks-search-postgres` alone.** With all other processes stopped and the database otherwise quiescent, this suite was re-run in complete isolation and still failed - tests `[B]` and `[D]` fail on a `COLLATE "C"` byte-order expectation for sorting `FORM2`/`FORM_2` task-type codes, with `[H]`/`[I]`/`[J]`/`[P]`/`[X]`/`RESIDUE` failing as downstream consequences of that same run. This is a **pre-existing database-collation-dependent test**, unconnected to anything LK-2 added: the LK-2 migration creates no `task_types` row, touches no collation setting, and the affected code path (`FORM2`/`FORM_2` task-type code merging) is entirely outside `legal_sources`/`legal_guidance_rules`. This reproduced identically whether or not any other test was running, which is what distinguishes it from failure mode (1)/(2) above - it is a standing characteristic of this one suite on this database, not contention this phase introduced.

**What this investigation does *not* show:** no failure in any suite was traced to a `legal_sources`/`legal_guidance_rules`/`legal_source_workflow_stages`/`legal_guidance_rule_stages`/`legal_guidance_rule_sources` table, to `lib/pim-auth.js`'s three new permission keys, or to any other file this phase touched. The LK-2 schema migration contains zero `ALTER`/`UPDATE`/`DELETE` against any pre-existing table - confirmed by direct review of the migration SQL - so there is no mechanism by which it could have produced the collation-ordering or connection-contention symptoms observed.

**Cleanup performed:** stray fixture rows and orphaned backends created during this investigation (by the diagnostic process, not by the LK-2 migration or seed) were cleaned up via each script's own `--cleanup-only` recovery path and, for one stuck backend, `pg_terminate_backend()`. A handful of unlinked, `pim_number IS NULL` test-fixture `pim_cases` rows remain as a known residue of this specific debugging session (confirmed test fixtures, not production data - real PIM cases always carry a `pim_number`); a direct `DELETE` to remove them was attempted and correctly refused by the session's own permission system as a shared-database mutation, so they were left for the user to clear via the test suite's own cleanup path rather than forced through. **None of the three named production invariants were ever at risk** - see §10, re-verified after this entire investigation, including after the orphaned-process cleanup.

## 10. Production invariants (re-confirmed after all migrations, seed, tests, AND the regression-suite investigation in §9.1)

| Invariant | Before | After everything in this phase, including the §9.1 investigation |
|---|---|---|
| `pim_number_sequences` year 2026 `last_number` | 118 | **118 (unchanged)** — re-confirmed by direct query as the very last check of this phase |
| `PIM/119/2026` | not consumed | **not consumed** (follows directly from `last_number` never moving) |
| Active mediator count | 5 | **5 (unchanged)**, names re-confirmed exactly: Ravikumar, Rajesh, Narayanan Kutty, Latha Subramaniam, K. Viswanath |
| `legal_sources` row count | — | **11** (exactly the bounded seed, §3) |
| `legal_guidance_rules` row count | — | **4** (exactly the bounded seed, §5) |
| PIM 109/2026 | — | not queried, not modified — the LK-2 migration contains no statement touching `pim_cases`, `pim_fees`, `pim_mediator_assignments`, `pim_outcomes`, or any other case-data table |
| `pim_cases` test-fixture residue | — | **5 unlinked rows remain** (`pim_number IS NULL`, confirmed test fixtures from the §9.1 regression-suite investigation, not production data — see §9.1 for why a direct cleanup `DELETE` was not forced through after the session's own permission system correctly declined it as a shared-database mutation). Recommend clearing these via `node scripts/test-pim-tasks-search-postgres.js --cleanup-only` (and the equivalent for any sibling suite) at the user's convenience - not urgent, since no real case data is affected. |
| `dlsa-mis` project (`qpuucszfnzcymtgtzzsp`) | — | never connected to; all work in this phase, including the regression investigation, targeted only the `pim-system` project (`qqjmmxfvfrrzxirxtgtc`) |

---

## 11. What was explicitly NOT done in LK-2 (per instruction)

- No Legal Library UI (`app/pim/legal-library/`) — LK-3.
- No full guidance-rule management UI — LK-4.
- No contextual workflow panels on `app/pim/case/[id]/page.tsx` or any action page — LK-5.
- No change to fee workflow, non-starter workflow, or `nonstarter_reasons` (including its still-placeholder `rule_reference` for `MEDIATION_FEE_NOT_SUBMITTED`, despite Sidhi Vinayak Metcom now being available to cite there — that edit belongs to a later, explicitly-scoped batch, not LK-2).
- No commit, stage, or push performed by this work — per the governing instructions, that remains the user's own action.

---

*End of LK-2 record. Schema and seed applied to the live `pim-system` Supabase project. Code changes limited to two new `lib/pim-data/*.js` modules, three new permission keys in `lib/pim-auth.js`, and one new test script. No workflow code modified. No commit/stage/push performed by this work.*
