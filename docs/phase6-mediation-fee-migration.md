# Mediation Fee Migration (per-payment model)

Status: **code-complete, tested**. 2026-10-07, production-completion sprint.

## What changed and why

`app/api/pim/fee/[id]/route.js` was SQLite-authoritative, keeping **one
mutable `pim_fees` row per case** for the mediation fee. Each new payment
simply added its amount onto a single `amount_received` total:

- there was no way to tell how much either side (applicant vs. opposite
  party) had actually paid — only a combined cumulative figure;
- a second payer's DD number/date/bank overwrote the first's (the
  `COALESCE` only protected a field the new submission left blank, never
  a field the *other side's earlier* payment had already set).

## The fix: payments are transactions, not case attributes

New table `pim_fee_payments` (migration `20261007000000_mediation_fee_payments.sql`):
`case_id, paying_side, amount, payment_date, payment_mode, dd_number,
dd_date, bank_name, reference_number, remarks, recorded_by, created_at`.
Every payment is an `INSERT` and is never updated or deleted by normal
staff workflow (`lib/pim-data/fee.js`: `recordFeePaymentTx`).

`paying_side` is exactly `APPLICANT` or `OP_SIDE` — multiple opposite
parties jointly constitute the OP_SIDE half; no individual OP is ever
modeled as owing a separate share (matches the pre-existing SQLite
route's "shared equally between both sides" rule, which this migration
preserves rather than changes).

## Derived summary, never cached

`deriveFeeSummaryTx` is the only source of truth for what either side has
paid — it sums `pim_fee_payments` by side every time it's called, never
reading or writing a stored total:

```
totalFee, shareAmount,
applicantPaid, applicantOutstanding, applicantOverpaid,
opSidePaid, opSideOutstanding, opSideOverpaid,
totalPaid, totalOutstanding, fullyPaid,
applicantFeeNotPaid, opSideFeeNotPaid   // reason-code booleans for the
                                         // not-yet-built fee-default
                                         // workflow to key off later
```

## Verified business invariants (all covered by `scripts/test-pim-fee-postgres.js`, 12/12 passing)

- Applicant paid, OP unpaid → `FEE_PENDING`, OP's own outstanding share
  correctly reported, applicant's payment untouched by OP's lack of one.
- OP paid, applicant unpaid → `FEE_PENDING`, symmetric.
- Partial payment on either side, in either order → `FEE_PENDING`.
- Both sides' full share paid → **exactly one** transition to
  `MEDIATOR_ASSIGNMENT_PENDING` and **exactly one** `MEDIATOR_ASSIGNMENT`
  task (case row is locked first — `FOR UPDATE OF c` — so two concurrent
  final payments for the same case serialize there; verified directly
  with `Promise.allSettled` on two simultaneous completing payments: both
  payments are recorded, but only one status transition and one task
  result).
- A later, smaller payment never reduces or overwrites an earlier
  payment's own amount/DD number/date/bank (each is its own row).
- Overpayment is reported (`applicantOverpaid`/`opSideOverpaid`), never
  silently absorbed or ignored.
- Invalid `payingSide`/non-positive amount is rejected before any write.
- A payment attempted once the case has already left `FEE_PENDING` is
  rejected.

## What is intentionally unchanged / out of scope

- The legacy `pim_fees` `MEDIATION_FEE` row (created as a `PENDING`
  skeleton by `lib/pim-data/response.js`'s `ensureMediationFeeTx`) is
  **never read or written** by this module. Verified live before this
  migration: every such row in the `pim-system` project has
  `amount_received = 0` — there is no genuine historical payment data
  anywhere in `pim_fees` to lose or reinterpret. `pim_fees` remains
  authoritative for `APPLICATION_FEE` (unrelated, out of scope) and is
  left as a historical/compatibility reference for `MEDIATION_FEE`.
- Fee-default handling (sprint section 4/9: distinguishing
  `APPLICANT_MEDIATION_FEE_NOT_PAID` / `OP_MEDIATION_FEE_NOT_PAID` as
  reason codes, the opportunity-to-pay process, Rule 11 vs. persuasive
  authority) is **not implemented** — this batch only adds the two
  boolean fields (`applicantFeeNotPaid`/`opSideFeeNotPaid`) a future
  fee-default batch can key off, per the planning document's explicit
  deferral.
- The mediator-assignment route itself still gates purely on the case's
  `current_status_id` (must be `MEDIATOR_ASSIGNMENT_PENDING`), the same
  pattern already used everywhere else in this codebase — this migration
  did not add a second, redundant fee check inside that route.

## UI

`app/pim/fee/[id]/page.tsx` was rewritten to match: staff enters either
or both sides' payment in one form; each side that has an amount entered
is submitted as its own `POST` (one payment row per side, not a single
combined submission), and a payment-history list renders every recorded
payment with its own DD/bank details.
