# Phase 6 Batch 5K — OP Response / Multi-OP Consent Migration (as-built)

Status: **code-complete**. This document was written retroactively on 2026-10-07
during the production-completion sprint audit, which found the code for this
batch fully implemented but this as-built doc missing. See
`docs/phase6-batch5k-op-response-consent-planning.md` for the original plan.

## What this batch covers

PostgreSQL-authoritative implementation of the opposite-party (OP) response
and consent workflow, from `SERVICE_PENDING`/`OP_APPEARANCE_PENDING` through
the `FEE_PENDING` handoff:

- `lib/pim-data/response.js` — `recordResponseTx`/`recordResponsePg`
  (APPEARED / SOUGHT_TIME / REFUSED / DID_NOT_APPEAR) and
  `recordConsentDecisionTx`/`recordConsentDecisionPg` (the deferred
  CONSENTED/REFUSED decision).
- `app/api/pim/response/[id]/route.js`, `app/api/pim/consent/[id]/route.js` —
  wired to the above.

Out of scope (explicitly deferred to later batches): mediation fee *payment*,
mediator assignment, mediation sessions, outcomes, honorarium.

## The defect this batch fixes

The pre-existing SQLite route transitioned a case to `FEE_PENDING` the moment
the **first** opposite party consented, with no check for how many other
required opposite parties existed or had themselves responded — a confirmed
violation of SOP clause 6(e) ("no referral to mediation without all-party
consent").

## The corrected rule

`deriveConsentAggregateTx` (in `lib/pim-data/response.js`) derives
`ALL_REQUIRED_PARTIES_CONSENTED` **live, from source facts**, every time it is
needed — it is never stored as a persisted boolean on the case row. It:

1. Loads every active opposite party (`pim_case_parties` where
   `role = 'OPPOSITE_PARTY' AND active_to IS NULL`).
2. For each, takes that party's **own latest** `pim_responses` row
   (`DISTINCT ON (party_id) ... ORDER BY party_id, id DESC`).
3. Classifies each required party as consented / refused / unresolved.
4. `gateSatisfied` is true only when every required party is consented and
   none is refused or unresolved.

The `FEE_PENDING` transition (`handleConsentedTx`) only fires when
`gateSatisfied` is true. Examples, matching the sprint brief exactly:

- OP1 consents, OP2 unresolved → case stays at its current response stage
  (docket entry records "awaiting N other required opposite parties").
- OP1 consents, OP2 later consents → on OP2's consent, the aggregate is
  re-derived, now satisfied → exactly one `FEE_PENDING` transition fires.
- OP1 consents, OP2 refuses → `handleRefusedTx` fires for OP2 regardless of
  OP1's state or the case's current status (including from `FEE_PENDING`
  reached via a different party), moving the case to `OP_REFUSED` and creating
  the non-starter handoff task. A refusal is dispositive on its own and is
  never gated by the consent aggregate.

A later refusal remains recordable even after another party's consent has
already moved the case to `FEE_PENDING` — refusal-handling is not restricted
to any particular entry status the way the consent gate is.

## What is NOT stored

No `all_parties_consented` (or equivalent) column exists anywhere on
`pim_cases` or `pim_responses`. Consent state is always re-derived from
`pim_responses` rows at read time (`deriveConsentAggregateTx`), including for
the GET loader (`getResponseDataPg` exposes the same `consentGate` object the
write path uses).

## Applicant consent

Per the planning document's §24, the applicant's consent is already
established by the PIMS application itself (continued by participation, most
concretely fee remittance — a separate, later batch's concern). SOP clause 6's
procedural sequence is written exclusively around the **opposite party's**
appearance/response/consent, so no applicant-consent schema was added. The
consent aggregate is scoped to required opposite parties only, by design.

## Locking / concurrency

Every mutating function locks the case row first
(`SELECT ... FOR UPDATE OF c`) and performs every read/write for that call
inside that single transaction. No separate notice-row or party-row lock is
taken: this module never writes `pim_notices` or `pim_case_parties`, and the
consent-aggregate derivation is scoped to `case_id` and reads only committed
data once the case lock is held (verified against the actual access pattern,
not assumed — see planning doc §16).

## Task / history behavior

- Exactly one `OP_CONSENT_FEE` task is created on the `FEE_PENDING` transition
  (deduplicated via `createPendingTaskIfNotExists`).
- `OP_APPEARANCE_FOLLOWUP` is completed (if pending) on appearance, consent,
  or refusal as appropriate — never left dangling.
- Every transition writes a `pim_status_history` row and a `pim_docket` entry
  describing what happened and, where relevant, how many other required
  parties remain unresolved.

## Tests / regressions

`scripts/test-pim-response-postgres.js` exercises this module against
isolated fixtures. Per the sprint's test-discipline rules, this suite must be
run in isolation (not concurrently with other PostgreSQL fixture suites) and
must leave no fixture residue afterward.

## Known boundary

`ensureMediationFeeTx` in this module creates the `pim_fees` row in `PENDING`
status but never reads or writes `amount_received` — actual fee **payment**
recording is a separate, not-yet-migrated SQLite-authoritative route
(`app/api/pim/fee/[id]/route.js`), addressed in a later batch of this same
sprint.
