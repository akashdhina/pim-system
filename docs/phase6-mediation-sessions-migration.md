# Mediator Assignment + Mediation Sessions — PostgreSQL Port

Status: **code-complete, tested (13/13)**. 2026-10-07, production-completion sprint.

## A gap the audit missed: mediator-assignment-to-case was still SQLite

The original audit classified "mediator assignment" as `POSTGRES-MIGRATED`
based on `lib/pim-data/mediator-registry.js` and `lib/pim-data/mediators.js`
— but those two modules are the mediator **profile registry** (CRUD on the
`mediators` table). The actual transaction that assigns an approved
mediator to a specific case
(`app/api/pim/mediator/[id]/route.js`: `MEDIATOR_ASSIGNMENT_PENDING` →
`MEDIATOR_ASSIGNED`) was still fully SQLite-authoritative.

This matters more than an ordinary SQLite/Postgres gap: SQLite (`lib/db.js`,
`database/pim.db`) and PostgreSQL (`lib/pim-postgres.js`, the live
`pim-system` Supabase project) are **two entirely separate databases** with
no shared rows. Every case created through the already-migrated Postgres
intake/fee path exists *only* in Postgres — the SQLite mediator-assignment
route would simply report "PIM case not found" for it. This was a real,
blocking hole in the critical path between Fee and Mediation, not a cleanup
item.

`lib/pim-data/mediator-assignment.js` (`assignMediatorPg`) ports it exactly:
same guards (case must be `MEDIATOR_ASSIGNMENT_PENDING`; mediator must be
active and within panel validity; no existing `ACTIVE` assignment for the
case), same effects (status history, `MEDIATOR_ASSIGNED` docket, completes
the pending `MEDIATOR_ASSIGNMENT` task, creates exactly one `FIRST_MEDIATION`
task). `app/api/pim/mediator/[id]/route.js` now calls it; no SQLite read or
write remains in that route.

## Mediation sessions (`lib/pim-data/mediation.js`)

Ports all three routes statement-for-statement, no redesign:

- `fixFirstMediationDateTx`/`Pg` — `app/api/pim/mediation/[id]/route.js`'s
  `POST`: `MEDIATOR_ASSIGNED` → `MEDIATION_PENDING`, creates sitting #1,
  completes `FIRST_MEDIATION`.
- `recordMediationSessionTx`/`Pg` — `app/api/pim/mediation/session/[id]/route.js`'s
  `POST`: the branchy one — effective (both present, duration computed,
  status → `MEDIATION_ONGOING`) vs. ineffective (adjourned, next date
  required) vs. concluding (no next date → `OUTCOME_FORM_PENDING` + exactly
  one `OUTCOME_FORM` task). A conflict (session already recorded, or case
  not in a recordable state) returns `{ conflict: true, message }` rather
  than throwing, matching the original's 409 response.
- `fixNextMediationDateTx`/`Pg` — `app/api/pim/mediation/next/[id]/route.js`'s
  `POST`: fixes a further sitting while `MEDIATION_ONGOING`, rejected if a
  `SCHEDULED` sitting already exists.

The only representational change: `applicant_present`,
`opposite_party_present`, `effective_session`, `report_received` are real
PostgreSQL booleans here, not SQLite's `0`/`1` — every comparison and write
uses `true`/`false`.

Every mutating function locks the case row first (`FOR UPDATE OF c`),
matching every other Batch 5D+ module.

## Verified (`scripts/test-pim-mediation-postgres.js`, 13/13 passing)

Mediator assignment: happy path, inactive mediator rejected, expired panel
rejected, duplicate active assignment rejected. Mediation: first-date fix,
effective session with computed duration and auto-created next sitting,
ineffective session requiring a next date, concluding mediation into
`OUTCOME_FORM_PENDING` with exactly one task, double-recording a session is
a conflict (not an error, nothing changes), `fixNextMediationDatePg`'s
dedup guard, and both read loaders (`getMediationCaseDataPg`'s cumulative
duration only counts effective sessions; `getMediatorAssignmentDataPg`'s
roster/assignment listing).

## Test-cleanup root cause and fix (not a production FK issue)

The first full run hit a foreign-key violation *during test cleanup*
(`pim_mediator_assignments` couldn't be deleted while a `mediation_sessions`
row still referenced it). Investigated against the live FK catalogue
(`information_schema`), not assumed:

- `mediation_sessions.assignment_id → pim_mediator_assignments.id`
  (`NO ACTION`) — correct, intentional production behavior (a mediator
  assignment with recorded sessions should not be casually deletable).
  **Not weakened, not cascaded, not touched.**
- A second, previously-unhandled dependency was found in the same pass:
  `pim_mediator_assignments.replacement_for_assignment_id → pim_mediator_assignments.id`
  (self-referential, for reassignment history) — no earlier cleanup script
  needed to know about it, since no earlier batch ever created
  `pim_mediator_assignments` rows at all. `mediation_sessions` itself has no
  children.

Root cause of the one-off violation: a race between the crashed test
process's last in-flight write and the cleanup transaction that ran
immediately after it — not a wrong delete order (the order was already
correct: sessions before assignments). The fix, applied to
`cleanupCasesByIds` in the test script only:

1. Defensively null out `replacement_for_assignment_id` among the tracked
   assignments before deleting them (closes the previously-unhandled edge,
   even though no fixture exercised it today).
2. Retry the whole fixture-deletion transaction once on a `23503`
   (foreign-key violation) error, after a short delay.

Verified clean afterward: zero fixture rows in `pim_cases`,
`mediators`, `mediation_sessions`, or `pim_mediator_assignments`; the real
2026 `pim_number_sequences` row unchanged at `118`; no `PIM/109/*` or
`PIM/119/*` case touched. The subsequent clean rerun passed 13/13 with no
FK issue.
