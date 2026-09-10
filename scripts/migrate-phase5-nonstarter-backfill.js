/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Phase 5 Non-Starter backfill.
 * Additive/non-destructive. Safe to re-run (idempotent).
 *
 * The centralized Non-Starter workflow (Phase 5) requires a
 * pending NONSTARTER_FORM3 task as proof that a case genuinely
 * reached an auto-triggered non-starter condition. Cases that
 * reached OP_REFUSED before Phase 4/5 existed never got that
 * task created, so the workflow would otherwise have no way to
 * pick them up.
 *
 * This migration ONLY creates a pending NONSTARTER_FORM3 task
 * for a case that is:
 *   - currently at status OP_REFUSED,
 *   - has no pending NONSTARTER_FORM3 task already,
 *   - has no outcome row yet.
 * It never touches case status, status history, or outcome data,
 * and never fabricates dates/details - the task's due date is
 * simply today's office date, matching how Phase 4 creates the
 * same task automatically.
 */

const db = require("../lib/db");
const { officeDate } = require("../lib/pim-time");

function today() {
  return officeDate();
}

function getPendingTask(caseId, taskTypeCode) {
  return db
    .prepare(`
      SELECT id
      FROM pim_tasks
      WHERE case_id = ?
        AND task_type_code = ?
        AND status = 'PENDING'
      LIMIT 1
    `)
    .get(caseId, taskTypeCode);
}

const report = {
  candidates: [],
  tasksCreated: [],
  alreadyHadTask: [],
  alreadyHadOutcome: [],
};

const migrate = db.transaction(() => {
  const candidates = db
    .prepare(`
      SELECT c.id, c.pim_number, c.received_number
      FROM pim_cases c
      JOIN status_master s ON s.id = c.current_status_id
      WHERE s.code = 'OP_REFUSED'
    `)
    .all();

  report.candidates = candidates.map((c) => ({
    id: c.id,
    pim_number: c.pim_number,
    received_number: c.received_number,
  }));

  const taskType = db
    .prepare("SELECT id, default_priority FROM task_types WHERE code = 'NONSTARTER_FORM3'")
    .get();

  if (!taskType) {
    throw new Error(
      "task_types row for NONSTARTER_FORM3 is missing - cannot backfill."
    );
  }

  for (const caseRow of candidates) {
    const existingOutcome = db
      .prepare(`SELECT id FROM pim_outcomes WHERE case_id = ?`)
      .get(caseRow.id);

    if (existingOutcome) {
      report.alreadyHadOutcome.push(caseRow.pim_number || caseRow.id);
      continue;
    }

    const existingTask = getPendingTask(caseRow.id, "NONSTARTER_FORM3");

    if (existingTask) {
      report.alreadyHadTask.push(caseRow.pim_number || caseRow.id);
      continue;
    }

    const result = db.prepare(`
      INSERT INTO pim_tasks
      (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated, remarks)
      VALUES (?, ?, 'NONSTARTER_FORM3', ?, ?, ?, ?, 'PENDING', 1, ?)
    `).run(
      caseRow.id,
      taskType.id,
      "Prepare Form-3 Non-Starter Report.",
      today(),
      today(),
      taskType.default_priority || "NORMAL",
      "Backfilled by Phase 5 migration: case was already at OP_REFUSED with no pending handoff task."
    );

    report.tasksCreated.push({
      caseId: caseRow.id,
      pimNumber: caseRow.pim_number,
      taskId: Number(result.lastInsertRowid),
    });
  }
});

migrate();

console.log(JSON.stringify(report, null, 2));
