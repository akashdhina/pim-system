# Outcome / Settlement / Failure / Closure — PostgreSQL Port

Status: **code-complete, tested (10/10)**. 2026-10-07, production-completion sprint.

## What this covers

`lib/pim-data/outcome.js` ports the two remaining SQLite-authoritative
routes in the terminal-outcome path:

- `app/api/pim/outcome/[id]/route.js` — records the outcome
  (`SETTLED`/`FAILED`/`WITHDRAWN`) while `MEDIATION_ONGOING`'s conclusion
  has already put the case at `OUTCOME_FORM_PENDING`.
- `app/api/pim/outcome/approve/[id]/route.js` — approves the recorded
  outcome and performs the actual terminal closure.

Matches the SQLite originals statement-for-statement — including one piece
of dead code preserved deliberately: `recordOutcomeTx`'s `addStatusHistory`
call is gated on `status_code !== 'OUTCOME_FORM_PENDING'`, which can never
be true given the entry guard a few lines above already requires exactly
that status. The SQLite original has the same unreachable branch; per
"preserve business semantics, don't redesign," it was kept rather than
removed.

## The three outcome types

- **SETTLED** — requires `settlementTerms`. Closure (`approveOutcomeTx`)
  requires a current `FORM_4` document to already exist
  (`pim_documents.document_type = 'FORM_4' AND is_current = true` with a
  non-empty `file_path`) before the case can move to `CLOSED_SETTLED`.
- **FAILED** — requires `reasonText`. Closure requires a current `FORM_5`
  document the same way, before `CLOSED_FAILED`.
- **WITHDRAWN** — requires `reasonText`. **No document requirement** —
  closure goes straight to the `WITHDRAWN` status. This is the sprint's
  "withdrawal" outcome: the existing schema and routes already model it as
  one of `pim_outcomes.outcome_type`'s three non-non-starter values, not a
  separate workflow. No new withdrawal feature was built — `WITHDRAWN` was
  already fully supported in both the data model and (now) the Postgres
  transaction; it simply needed the same SQLite→Postgres port as `SETTLED`/
  `FAILED`.

`NON_STARTER` is explicitly rejected by `recordOutcomeTx` with "must be
recorded through the dedicated non-starter workflow" — that path is
`lib/pim-data/nonstarter.js`, migrated separately (`docs/phase6-batch5d-nonstarter-migration.md`
and `docs/phase6-nonstarter-completion-migration.md`). `approveOutcomeTx`
*does* still handle `NON_STARTER` in its switch (for defensiveness/parity
with the original), but in practice a non-starter case closes through
`completeNonStarterForm3Pg`/`recordNonStarterAuthorityDecisionPg` instead,
never through this route.

## Preconditions enforced (unchanged from SQLite)

- Case must be `OUTCOME_FORM_PENDING` to record an outcome.
- At least one `COMPLETED` mediation session must exist.
- The outcome date cannot be before the last completed session's actual
  date, and cannot be in the future.
- An outcome can only be recorded once per case (`pim_outcomes.case_id` is
  unique).

## Closure effects

- `pim_outcomes.verified_by`/`approved_by` set, `remarks` merged.
- Status history + case closure (`current_status_id`, `closed_at`).
- Every pending task matching `task_type_code = 'OUTCOME_FORM'` **or**
  `description LIKE '%outcome form%'` (the same broad match the SQLite
  original uses) is completed, with task history.
- A closure docket entry is written.

An approval attempt on a case that is not `OUTCOME_FORM_PENDING` (already
closed, or never reached an outcome) returns `{ conflict: true, message }`
— a 409, not a thrown error — matching the original exactly.

## Verified (`scripts/test-pim-outcome-postgres.js`, 10/10 passing)

Each outcome type's required-field validation; the Form IV/V document gate
(rejected without the document, then succeeds once a fixture document is
attached — document *generation* itself remains a separate, not-yet-
migrated concern, same boundary as the non-starter Form-3 tests);
`NON_STARTER` rejected outright; a second outcome on the same case
rejected; an outcome dated before the last session rejected; a repeat
approval on an already-closed case returns a conflict rather than
throwing; the read loader's session summary / `phase7Signal` derivation;
and an explicit rollback-atomicity check — a rejected approval (missing
document) leaves the `pim_outcomes` row and case status completely
unchanged, verified by re-reading both before and after the rejected call.

Fixtures are driven end-to-end through intake → mediator assignment → first
mediation → one completed session, using the already-tested
`lib/pim-data/mediator-assignment.js` and `lib/pim-data/mediation.js`
modules, rather than hand-constructing intermediate status/session rows.

## Out of scope

Form IV/Form V document *generation* — this module only checks that a
current document already exists; producing it is part of the separate
"document writes" batch.
