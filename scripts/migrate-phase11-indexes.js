/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Phase 11 reporting indexes.
 * Additive/non-destructive. Safe to re-run (idempotent).
 *
 * Phase 11 reports filter/sort heavily on columns that had no
 * index: pim_cases.registration_date, pim_cases.internal_60_day_date,
 * pim_cases.outcome_type/outcome_date, pim_cases.closed_at,
 * mediators.panel_valid_until, pim_mediator_assignments.status,
 * mediation_sessions.actual_date/scheduled_date, pim_fees.fee_type.
 * No data is modified - index-only.
 */

const db = require("../lib/db");

const statements = [
  "CREATE INDEX IF NOT EXISTS idx_cases_registration_date ON pim_cases(registration_date)",
  "CREATE INDEX IF NOT EXISTS idx_cases_internal_60_day_date ON pim_cases(internal_60_day_date)",
  "CREATE INDEX IF NOT EXISTS idx_cases_outcome ON pim_cases(outcome_type, outcome_date)",
  "CREATE INDEX IF NOT EXISTS idx_cases_closed_at ON pim_cases(closed_at)",
  "CREATE INDEX IF NOT EXISTS idx_mediators_valid_until ON mediators(panel_valid_until)",
  "CREATE INDEX IF NOT EXISTS idx_assignments_status ON pim_mediator_assignments(status)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_date ON mediation_sessions(actual_date, scheduled_date)",
  "CREATE INDEX IF NOT EXISTS idx_fees_type ON pim_fees(fee_type)",
];

const report = { created: [] };

const migrate = db.transaction(() => {
  for (const sql of statements) {
    db.prepare(sql).run();
    report.created.push(sql);
  }
});

migrate();

console.log(JSON.stringify(report, null, 2));
