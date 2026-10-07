# Mediator Reassignment — PostgreSQL Port

Status: **code-complete, tested (10/10)**. 2026-10-07, production-completion
sprint — final closure batch.

## What this closes

This was the one remaining genuinely SQLite-authoritative operational
write identified by the final route trace earlier today:
`app/api/pim/mediator/reassign/[id]/route.js`, distinct from mediator
*assignment* (ported earlier this sprint). With this batch, **zero**
operational PIM case-management writes remain SQLite-authoritative.

## What it does (unchanged from the SQLite original)

`lib/pim-data/mediator-assignment.js`'s `reassignMediatorTx`/`Pg` ports
the SQLite route statement-for-statement — no redesign:

- Case must be at `MEDIATOR_ASSIGNED`, `MEDIATION_PENDING`, or
  `MEDIATION_ONGOING` (Rule 5: no reassignment on a terminal case,
  including `CLOSED_NON_STARTER`, which never had an active
  mediation-stage assignment to reassign in the first place).
- An `ACTIVE` assignment must already exist for the case.
- The replacement mediator must be different from the currently active
  one, must exist, must be active, and must be within panel validity.
- The **old** assignment is never deleted or overwritten — it is set to
  `status = 'ENDED'` with the reassignment reason appended to its
  `remarks` (never replacing prior remarks).
- The **new** assignment row's `replacement_for_assignment_id` points at
  the old assignment's id, making the chain reconstructable.
- Case status and pending tasks are **intentionally unchanged** —
  reassignment swaps who is handling the case at its current stage; it
  is not a stage transition. Whichever `FIRST_MEDIATION`/
  `SESSION_RECORD`/`OUTCOME_FORM` task is already pending stays exactly
  as it was.
- Existing `mediation_sessions` rows are never touched — they keep
  pointing at the **old** `assignment_id`, so who actually conducted
  each already-recorded sitting remains historically accurate.

The case row is locked first (`FOR UPDATE OF c`), matching every other
mutation this sprint — ending the old assignment and inserting the new
one happen inside that single lock, so exactly one `ACTIVE` assignment
exists for the case at any observable point.

## Verified (`scripts/test-pim-mediator-reassignment-postgres.js`, 10/10 passing)

Valid reassignment (history preserved, correct `replacement_for_assignment_id`,
exactly one `ACTIVE` assignment survives); inactive/expired/same-mediator
replacements all rejected with nothing changed; existing mediation
sessions keep pointing at the old assignment after reassignment, with no
session orphaned or lost; pending tasks are completely undisturbed
(verified by before/after count equality, not an absolute count — the
case also carries intake's own auto-generated task, unrelated to
mediator assignment); a rejected reassignment leaves assignments, tasks,
and docket byte-for-byte unchanged (atomicity); reassignment is rejected
from a terminal/non-reassignable status.

**Concurrency** (the one that needed a second look): two concurrent
reassignments to *different* target mediators are not actually a
conflict — serialized by the case-row lock, "A→X then X→Y" are both
individually valid sequential transitions, and there is no reason the
second should fail. The real concurrency invariant is two concurrent
attempts at the *identical* transition (A→X twice): the loser, after the
lock releases and it re-reads state, must see X already active and be
rejected by the same-mediator guard — never silently double-applied,
never leaving two `ACTIVE` rows. Verified directly with
`Promise.allSettled` on two simultaneous identical-target reassignments.

## Confirmed: zero operational SQLite case-management writes remain

Final route trace (grepping for `db.prepare`/`db.transaction` specifically
inside exported `GET`/`POST`/`PUT`/`PATCH`/`DELETE` handlers, not just
file-level imports) across every `app/api/pim/**/route.js` found raw
SQLite calls in exactly five files, all legitimately non-operational:
`audit/route.js` (read-only audit-log viewer), `backups/[backupId]/download/route.js`
(backup file download), `health/route.js`, `system-info/route.js`, and
the deliberate fallback branch in `documents/download/[caseId]/[documentId]/route.js`
(tries the Postgres no-storage downloaders first; falls through to a
legacy local-file read only for a document type none of today's work
touches).

## Known pre-existing migration-history drift (not introduced today, not fixed)

The remote `pim-system` Supabase project's `schema_migrations` table
records every migration under the timestamp it was actually *applied*
at, which differs from the local file's timestamp for nearly the entire
history — all 12 original setup migrations, plus the Batch 5J and Legal
KB migrations, each have a different local-filename version than their
remote-recorded version. One migration
(`20260930093508_pim_number_sequences_and_staff_numbering_master_data`)
has no local file at all — its original SQL text was not available to
reconstruct today. This was not introduced this session and was not
mass-corrected today (renaming a dozen historical files during a wrap-up
batch is a disproportionate risk for a cosmetic-looking mismatch whose
full implication isn't certain). It **is** a real latent risk: anyone
later running Supabase CLI's `db push`/`db diff` against this project may
see these as unapplied and attempt to reapply already-existing schema.
Today's own two migrations (`manual_pim_numbering`,
`mediation_fee_payments`) were made to match their remote version
exactly, breaking from the inherited pattern deliberately — recommended
practice going forward, not reverted.
