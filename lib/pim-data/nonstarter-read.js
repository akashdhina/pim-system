/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5F's second migrated read
 * loader: the non-starter page loader behind
 * GET /api/pim/nonstarter/[id] (consumed by
 * app/pim/nonstarter/form3/[id]/page.tsx and
 * app/pim/nonstarter/authority/[id]/page.tsx). The SQLite original ran
 * inline in the route; it is kept, verbatim, as getNonStarterViewSqlite()
 * in that route file (rollback + parity baseline). See
 * docs/phase6-batch5f-read-loaders-migration.md for the mapping.
 *
 * READ-ONLY: plain getSql() reads, no transaction, no locks, no writes,
 * no SQLite. PostgreSQL-authoritative for everything returned.
 *
 * Returns null when the case does not exist (the route maps that to its
 * existing HTTP 404), otherwise exactly the object the SQLite route
 * placed under `data`:
 *   { case, outcome (or null), nonstarterReasons, tasks, context (or null) }
 *
 * `context` is inferred by lib/pim-data/nonstarter.js's
 * inferNonStarterContextPg - the SAME function T7 (recordNonStarterPg)
 * uses to validate a submitted reason, verified against SQLite in Batch
 * 5D. Reusing it (rather than a second copy) means the page can never
 * display a different "what actually happened" than the POST enforces.
 * It only reads, and works with any postgres.js client, so passing the
 * shared client (not a transaction) is valid here.
 *
 * Like the SQLite route: the case is read first (missing => stop), and
 * the context is only inferred when no outcome exists.
 */

const { getSql } = require("../pim-postgres");
const { inferNonStarterContextPg } = require("./nonstarter");
const { toWire } = require("./wire-compat");

const CASE_WIRE = { timestamps: ["created_at", "updated_at", "closed_at"] };
const OUTCOME_WIRE = {
  flags: ["sent_to_applicant", "sent_to_opposite_party", "requires_authority_decision"],
};
const REASON_WIRE = { flags: ["requires_authority_decision"] };
const TASK_WIRE = { flags: ["auto_generated"] };

async function getNonStarterViewPg(caseId) {
  /*
   * A value that cannot be a real bigint key is "not found" (as in
   * SQLite), never a PostgreSQL out-of-range error.
   */
  if (!Number.isSafeInteger(caseId)) {
    return null;
  }

  const sql = getSql();

  const [caseRow] = await sql`
    SELECT c.*, s.code AS status_code, s.name AS status_name
    FROM pim_cases c
    LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;

  if (!caseRow) {
    return null;
  }

  const [outcomeRows, taskRows, reasonRows] = await Promise.all([
    sql`
      SELECT
        o.*,
        nr.code AS nonstarter_reason_code,
        nr.name AS nonstarter_reason_name,
        nr.rule_reference,
        nr.requires_authority_decision
      FROM pim_outcomes o
      LEFT JOIN nonstarter_reasons nr
        ON nr.id = o.nonstarter_reason_id
      WHERE o.case_id = ${caseId}
    `,

    sql`
      SELECT *
      FROM pim_tasks
      WHERE case_id = ${caseId}
      ORDER BY id
    `,

    sql`
      SELECT id, code, name, rule_reference, requires_authority_decision, remarks
      FROM nonstarter_reasons
      WHERE active = true
      ORDER BY id
    `,
  ]);

  const outcome = outcomeRows[0] ? toWire(outcomeRows[0], OUTCOME_WIRE) : null;

  const context = outcome ? null : await inferNonStarterContextPg(sql, caseId);

  return {
    case: toWire(caseRow, CASE_WIRE),
    outcome,
    nonstarterReasons: reasonRows.map((reason) => toWire(reason, REASON_WIRE)),
    tasks: taskRows.map((task) => toWire(task, TASK_WIRE)),
    context,
  };
}

module.exports = {
  getNonStarterViewPg,
};
