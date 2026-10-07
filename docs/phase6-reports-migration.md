# Operational Reports — PostgreSQL Port

Status: **code-complete, parity-tested**. 2026-10-07, production-completion sprint.

`lib/pim-reports.js`'s 14 report definitions are reused directly as
dialect-neutral metadata (columns, filters, sortColumns, dateColumn,
defaultSort/Direction, searchColumns, tieBreaker). `lib/pim-data/reports.js`
overrides only the SQL fragments that are genuinely SQLite dialect, report
by report — no generic textual SQL translator, each override is an
explicit, understood substitution for the one real incompatibility it
fixes. `app/api/pim/reports/route.js` and `app/api/pim/reports/monthly/route.js`
are rewritten to call it exclusively; the SQLite module is left completely
unchanged as the historical/rollback reference and parity baseline.

## Dialect translations made

| SQLite | PostgreSQL | Reports affected |
|---|---|---|
| `julianday(a) - julianday(b)` | `(a::date - b::date)` | `overdue`, `monitoring`, `address_correction`, `outcomes` |
| `date(x, '+7 day')` | `(x::date + 7)` | `monitoring` |
| `date(col)` wrapping an already-`date` column (pure ORDER BY noise) | removed | `pending`, `address_correction`, `final_notice_pending` |
| `col = 1` / `col = 0` on real PostgreSQL boolean columns | `col = true` / `col = false` | `mediators`, `sessions`, `documents`, `non_starters`, `settlements`, `failures` |
| `MAX(a, b)` — SQLite's 2-argument **scalar** max | `GREATEST(a, b)` — PostgreSQL's `MAX` is aggregate-only, this is a real incompatibility, not a style choice | `fees_pending` |
| `LIKE` | `ILIKE` | every report's search (`addSearchPg`) — PostgreSQL's `LIKE` is case-sensitive, SQLite's is not by default; this preserves existing behavior, it does not change it |
| Postgres's ORDER BY NULL default (`NULLS LAST` for ASC, `NULLS FIRST` for DESC) | explicit `NULLS FIRST` for ASC / `NULLS LAST` for DESC, matching SQLite's "NULL is the smallest value" convention | every report, applied once at the shared `ORDER BY` construction site |

## The no-storage model required one more fix, not just a translation

`documents`, `non_starters`, `settlements`, and `failures` all had a "does
a document exist" check requiring `file_path IS NOT NULL`. Under the
no-storage model this sprint built for Form-2/3/4/5
(`docs/phase6-form3-documents-migration.md`,
`docs/phase6-outcome-documents-migration.md`), `file_path` is **never**
set — left unfixed, these reports would show zero documents for every
case migrated this sprint. Widened to `(file_path IS NOT NULL AND
file_path <> '') OR render_data IS NOT NULL`, the same fix already
applied to `lib/pim-data/outcome.js`'s `approveOutcomeTx`.

## Parity testing, not just "it executes"

`scripts/test-pim-reports-parity.js` inserts an equivalent fixture into
**both** engines (SQLite directly via `lib/db.js`, PostgreSQL via the
already-tested modules) and asserts the computed values match exactly —
not merely that neither engine throws:

- date subtraction/aging (`overdue.days_overdue`) — exact match.
- date-boundary classification (`monitoring.days_remaining`/
  `monitoring_status`) across due-today, due-in-3-days, and overdue
  fixtures — exact match on all three.
- 2-arg `MAX` vs `GREATEST` (`fees_pending.balance`) for a partial payment
  and an overpayment — exact match, including that both engines exclude
  a fully-paid row from the report identically.
- `LIKE` vs `ILIKE` — a mixed-case name matches an opposite-case search
  term in both engines.
- NULL ordering (`pending`, sorted by `due_date` ascending) — a NULL
  `due_date` sorts first in both engines.

All 6 parity checks pass. `scripts/test-pim-reports-postgres.js`'s
broader 16-assertion suite (one smoke-test pass across all 14 reports
plus report-specific behavioral checks) also passes, confirming no
regression from the `NULLS FIRST`/`LAST` change.

## Confirmed not present (not fabricated as "passing")

`strftime()`, `GROUP_CONCAT`, `IFNULL`, and `COLLATE` do not appear
anywhere in `lib/pim-reports.js` (grep-verified). No test was written for
them — there is nothing to translate.

## Known limitation, explicitly flagged, not silently redesigned

`fees_pending` and the monthly report's `feePaidCases` both query the
**legacy** `pim_fees` table (`fee_type = 'MEDIATION_FEE'`,
`amount_received >= amount_due`). This sprint's mediation-fee migration
(`docs/phase6-mediation-fee-migration.md`) moved real payment recording to
the new `pim_fee_payments` per-payment table, and deliberately never
writes to `pim_fees` for `MEDIATION_FEE` going forward. That means these
two report figures will not reflect any mediation fee paid through the
new Postgres path — they will only ever show the (now-frozen) legacy
rows. This is a real, known gap: fixing it would mean deriving these two
figures from `pim_fee_payments` instead, which is a product decision
about report semantics, not a dialect translation, and is left for a
dedicated follow-up rather than redesigned silently inside this batch.
