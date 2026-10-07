# Non-Starter Completion Routes — PostgreSQL Port

Status: **code-complete, tested**. 2026-10-07, production-completion sprint.

## The discrepancy this batch fixes

The production-completion audit found that Batch 5D ("T7") had migrated
the *first* step of the non-starter workflow —
`app/api/pim/nonstarter/[id]/route.js`'s `POST`, which calls
`recordNonStarterPg` (`lib/pim-data/nonstarter.js`) — to PostgreSQL, but
the two **follow-on** steps were never ported and remained fully
SQLite-authoritative:

- `app/api/pim/nonstarter/form3/[id]/route.js` — completing the Form-3
  Non-Starter Report, which either closes the case directly
  (`CLOSED_NON_STARTER`) or, for a reason requiring authority decision,
  moves it to `AUTHORITY_DECISION_PENDING`.
- `app/api/pim/nonstarter/authority/[id]/route.js` — recording the
  authority's decision, which closes the case as `CLOSED_NON_STARTER`.

This was not a case of "a PostgreSQL module exists but the route wasn't
switched" (the T7 module genuinely never covered these two
transactions) — it required writing two new transaction functions, not
just rewiring an import.

## What was added

`lib/pim-data/nonstarter.js` gained:

- `completeNonStarterForm3Tx`/`completeNonStarterForm3Pg` — matches the
  SQLite route's validation order exactly: case must be
  `OUTCOME_FORM_PENDING`; the non-starter outcome record must exist; the
  `NONSTARTER_FORM3` task must be the genuine pending one (guarded
  completion: `UPDATE ... WHERE status='PENDING' RETURNING id`, same
  double-completion-proof pattern as every other Batch 5D+ module); a
  **current** Form-3 document must already exist (either supplied or the
  latest current one for the case) — this route never generates one
  itself. Branches on `nonstarter_reasons.requires_authority_decision`,
  which is a real PostgreSQL `boolean` here (compared with `=== true`,
  not SQLite's `=== 1`).
- `recordNonStarterAuthorityDecisionTx`/`recordNonStarterAuthorityDecisionPg`
  — case must be `AUTHORITY_DECISION_PENDING`; the outcome must not
  already have `approved_by` set (idempotency — a second decision on the
  same case is rejected); the reason must actually require authority
  decision; the Form-3 document must already be attached; the
  `NONSTARTER_AUTHORITY` task must be the genuine pending one.

Both routes were rewritten to call these functions and no longer import
`lib/db` (SQLite) at all.

## Verified against live seed data, not assumed

The original test draft assumed `OP_REFUSED_MEDIATION` was an
authority-decision-required reason. Querying the live `pim-system`
project's `nonstarter_reasons` table directly showed this is wrong: only
`MEDIATION_FEE_NOT_SUBMITTED` has `requires_authority_decision = true`;
`OP_REFUSED_MEDIATION`, `FINAL_NOTICE_UNACKNOWLEDGED`, and
`OP_FAILED_TO_APPEAR_AFTER_TIME` are all `false`. The test fixture was
corrected to use `MEDIATION_FEE_NOT_SUBMITTED` for the authority-decision
branch — a reminder that this kind of branching must be verified against
the actual seeded data, not inferred from a reason's name.

## Verified (scripts/test-pim-nonstarter-completion-postgres.js, 7/7 passing)

- A manual, no-authority-decision reason (`BOTH_PARTIES_NOT_WILLING`):
  Form-3 completion closes the case directly as `CLOSED_NON_STARTER`,
  `closed_at` is set, the `NONSTARTER_FORM3` task is completed, no
  pending task remains.
- Form-3 completion without any current Form-3 document on file is
  rejected, case status unchanged.
- A reason requiring authority decision
  (`MEDIATION_FEE_NOT_SUBMITTED`): Form-3 completion moves the case to
  `AUTHORITY_DECISION_PENDING` (not closed yet) and creates exactly one
  `NONSTARTER_AUTHORITY` task.
- The authority decision then closes the case as `CLOSED_NON_STARTER`
  exactly once; a second decision attempt on the same case is rejected
  ("already recorded").
- An authority decision attempted before Form-3 is attached is rejected
  (case is not yet `AUTHORITY_DECISION_PENDING`).

## Out of scope

Form-3 *document generation* itself remains a separate concern (sprint
section 11, "document writes") — these tests attach a fixture document
row directly, matching how the real route already requires a document to
exist beforehand rather than generating one inline.
