/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Shared PostgreSQL workflow helpers - Batch 5D.
 *
 * Postgres-native equivalents of the generic (non-business-specific)
 * functions in lib/pim-op-response.js (getStatusId, getEventId,
 * addStatusHistory, addDocket, getPendingTask,
 * createPendingTaskIfNotExists) that Batch 5B made SQLite-transaction-
 * aware via a trailing `dbClient = db` parameter.
 *
 * These are NOT interchangeable with the SQLite versions - see
 * docs/phase6-transaction-readiness.md and
 * docs/phase6-batch5b-helper-inventory.md: a PostgreSQL transaction
 * client (postgres.js's tagged-template `tx`) has a fundamentally
 * different shape than better-sqlite3's `db` (async vs sync, no
 * `.prepare()`/`.run()`/`.get()`, no `lastInsertRowid`), so passing one
 * into a helper written for the other would not just be wrong, it
 * would not even type-check as a plausible call. Every function here
 * takes `tx` as its first, required argument - there is no default
 * parameter, because postgres.js has no single shared "default
 * connection" a caller could accidentally omit and silently fall back
 * to the way SQLite's dbClient=db can.
 *
 * Scope: only the 6 functions Batch 5D's target transaction (T7, non-
 * starter record) actually needs. lib/pim-op-response.js has several
 * more (insertResponse, ensureMediationFee, transitionStatus,
 * completeTask, completeTaskIfPending, createNonStarterHandoff,
 * requireIssuedNoticeForParty, ...) - those belong to whichever future
 * batch actually migrates the transaction that needs them, not built
 * speculatively here.
 */

const { officeDate } = require("../pim-time");

async function getStatusId(tx, code) {
  const [row] = await tx`SELECT id FROM status_master WHERE code = ${code}`;

  if (!row) {
    throw new Error(`Status not found: ${code}`);
  }

  return row.id;
}

async function getEventId(tx, code) {
  const [row] = await tx`SELECT id FROM event_types WHERE code = ${code}`;

  if (!row) {
    throw new Error(`Event not found: ${code}`);
  }

  return row.id;
}

async function addStatusHistory(tx, caseId, fromStatusId, toStatusId, reason, userId = null) {
  await tx`
    INSERT INTO pim_status_history (case_id, from_status_id, to_status_id, reason, changed_by)
    VALUES (${caseId}, ${fromStatusId}, ${toStatusId}, ${reason}, ${userId})
  `;
}

async function addDocket(tx, caseId, eventCode, entryText, actionRequired = null, nextDate = null, userId = null) {
  const eventId = await getEventId(tx, eventCode);

  await tx`
    INSERT INTO pim_docket (case_id, docket_date, event_type_id, entry_text, action_required, next_date, entered_by)
    VALUES (${caseId}, ${officeDate()}, ${eventId}, ${entryText}, ${actionRequired}, ${nextDate}, ${userId})
  `;
}

async function getPendingTask(tx, caseId, taskTypeCode) {
  const [row] = await tx`
    SELECT id, status
    FROM pim_tasks
    WHERE case_id = ${caseId}
      AND task_type_code = ${taskTypeCode}
      AND status = 'PENDING'
    ORDER BY id DESC
    LIMIT 1
  `;

  return row || null;
}

/*
 * Matches lib/pim-op-response.js's createPendingTaskIfNotExists exactly:
 * re-checks for an existing pending task of this type immediately
 * before inserting (dedup), and only creates a new row if none exists.
 *
 * KNOWN GAP, carried forward unchanged (not fixed in this batch): this
 * "read, then write" dedup has no unique-index backstop in either
 * database (confirmed live: pim_tasks has no unique constraint on
 * (case_id, task_type_code, status)). It is safe today only because
 * better-sqlite3's transactions serialize the whole process; that
 * property does not hold for PostgreSQL's real connection concurrency.
 * See docs/phase6-transaction-readiness.md section I and the Batch 5D
 * report - flagged for a future concurrency-hardening batch, not
 * silently patched here.
 */
async function createPendingTaskIfNotExists(tx, caseId, taskTypeCode, description, dueDate, remarks = null) {
  const existing = await getPendingTask(tx, caseId, taskTypeCode);

  if (existing) {
    return existing.id;
  }

  const [taskType] = await tx`SELECT id, default_priority FROM task_types WHERE code = ${taskTypeCode}`;

  const [task] = await tx`
    INSERT INTO pim_tasks (
      case_id, task_type_id, task_type_code, description,
      created_date, due_date, priority, status, auto_generated, remarks
    )
    VALUES (
      ${caseId}, ${taskType ? taskType.id : null}, ${taskTypeCode}, ${description},
      ${officeDate()}, ${dueDate}, ${taskType ? taskType.default_priority : "NORMAL"},
      'PENDING', true, ${remarks}
    )
    RETURNING id
  `;

  return task.id;
}

module.exports = {
  getStatusId,
  getEventId,
  addStatusHistory,
  addDocket,
  getPendingTask,
  createPendingTaskIfNotExists,
};
