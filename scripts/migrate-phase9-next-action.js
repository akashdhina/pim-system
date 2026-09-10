/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Phase 9 structured next-action migration.
 * Additive/non-destructive. Safe to re-run (idempotent).
 *
 * - mediation_sessions.next_action (nullable, CHECK-constrained)
 *   Replaces the Phase 7 fixed-phrase-in-remarks signal with a
 *   proper structured column. historical remarks are NEVER
 *   removed or rewritten.
 *
 * Backfill is deliberately narrow - it only sets next_action
 * where the fact is already unambiguous from EXISTING structured
 * columns or from the two exact, machine-generated phrases Phase
 * 7's own code appended (never from arbitrary staff prose):
 *   - administrative_remarks contains the exact phrase
 *     "Ready for settlement outcome" -> READY_FOR_SETTLEMENT
 *   - administrative_remarks contains the exact phrase
 *     "Ready for failure outcome" -> READY_FOR_FAILURE
 *   - COMPLETED, effective, and next_date IS NOT NULL (this is
 *     exactly the structural condition Phase 7's own code used to
 *     decide "further mediation required") -> FURTHER_MEDIATION
 * Anything else is left NULL - never guessed.
 */

const db = require("../lib/db");

function columnExists(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

const report = {
  schemaChanges: [],
  backfill: {
    settlementPhraseMatched: 0,
    failurePhraseMatched: 0,
    furtherMediationStructural: 0,
  },
};

const migrate = db.transaction(() => {
  if (!columnExists("mediation_sessions", "next_action")) {
    db.prepare(`
      ALTER TABLE mediation_sessions ADD COLUMN next_action TEXT
      CHECK (next_action IS NULL OR next_action IN (
        'FURTHER_MEDIATION', 'READY_FOR_SETTLEMENT', 'READY_FOR_FAILURE'
      ))
    `).run();
    report.schemaChanges.push("mediation_sessions.next_action");
  }

  const settlementResult = db.prepare(`
    UPDATE mediation_sessions
    SET next_action = 'READY_FOR_SETTLEMENT'
    WHERE next_action IS NULL
      AND administrative_remarks LIKE '%Ready for settlement outcome%'
  `).run();
  report.backfill.settlementPhraseMatched = settlementResult.changes;

  const failureResult = db.prepare(`
    UPDATE mediation_sessions
    SET next_action = 'READY_FOR_FAILURE'
    WHERE next_action IS NULL
      AND administrative_remarks LIKE '%Ready for failure outcome%'
  `).run();
  report.backfill.failurePhraseMatched = failureResult.changes;

  const furtherResult = db.prepare(`
    UPDATE mediation_sessions
    SET next_action = 'FURTHER_MEDIATION'
    WHERE next_action IS NULL
      AND session_status = 'COMPLETED'
      AND effective_session = 1
      AND next_date IS NOT NULL
  `).run();
  report.backfill.furtherMediationStructural = furtherResult.changes;
});

migrate();

console.log(JSON.stringify(report, null, 2));
