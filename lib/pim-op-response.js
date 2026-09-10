/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Shared helpers for the OP response / appearance / consent /
 * refusal / sought-time workflow (Phase 4). Consolidates logic
 * that was duplicated between the response and consent routes,
 * and centralizes the notice/service validation that both need.
 */

const db = require("./db");
const { officeDate, officeTime, addDays } = require("./pim-time");
const { calculateMediationFee } = require("./pim-mediation-fee");

const MAX_ALTERNATE_DATE_WINDOW_DAYS = 10;

function today() {
  return officeDate();
}

function getStatusId(code) {
  const row = db
    .prepare("SELECT id FROM status_master WHERE code = ?")
    .get(code);

  if (!row) {
    throw new Error(`Status not found: ${code}`);
  }

  return row.id;
}

function getEventId(code) {
  const row = db
    .prepare("SELECT id FROM event_types WHERE code = ?")
    .get(code);

  if (!row) {
    throw new Error(`Event not found: ${code}`);
  }

  return row.id;
}

function addStatusHistory(caseId, fromStatusId, toStatusId, reason, userId = null) {
  db.prepare(`
    INSERT INTO pim_status_history
    (case_id, from_status_id, to_status_id, reason, changed_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(caseId, fromStatusId, toStatusId, reason, userId);
}

function transitionStatus(caseId, fromCode, toCode, reason, userId = null) {
  const toStatusId = getStatusId(toCode);

  addStatusHistory(
    caseId,
    getStatusId(fromCode),
    toStatusId,
    reason,
    userId
  );

  db.prepare(`
    UPDATE pim_cases
    SET current_status_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(toStatusId, caseId);

  return toStatusId;
}

function addDocket(caseId, eventCode, entryText, actionRequired = null, nextDate = null, userId = null) {
  const eventId = getEventId(eventCode);

  db.prepare(`
    INSERT INTO pim_docket
    (case_id, docket_date, event_type_id, entry_text, action_required, next_date, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(caseId, today(), eventId, entryText, actionRequired, nextDate, userId);
}

function getCase(caseId) {
  return db
    .prepare(`
      SELECT c.*, s.code AS status_code, s.name AS status_name
      FROM pim_cases c
      LEFT JOIN status_master s ON s.id = c.current_status_id
      WHERE c.id = ?
    `)
    .get(caseId);
}

function getActiveOppositeParty(caseId, partyId) {
  return db
    .prepare(`
      SELECT cp.id AS case_party_id, p.id AS party_id, p.name
      FROM pim_case_parties cp
      JOIN pim_parties p ON p.id = cp.party_id
      WHERE cp.case_id = ?
        AND cp.party_id = ?
        AND cp.role = 'OPPOSITE_PARTY'
        AND cp.active_to IS NULL
    `)
    .get(caseId, partyId);
}

function loadNotice(caseId, noticeId) {
  return db
    .prepare(`
      SELECT n.*, p.name AS recipient_name
      FROM pim_notices n
      LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
      WHERE n.id = ? AND n.case_id = ?
    `)
    .get(noticeId, caseId);
}

/*
 * Validates that a response/absence can legitimately be recorded
 * against this exact notice for this exact party - never a
 * different opposite party's notice, and never an unissued
 * (still PREPARED) notice.
 */
function requireIssuedNoticeForParty(caseId, partyId, noticeId) {
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    throw new Error(
      "A specific notice must be identified for this OP response."
    );
  }

  const notice = loadNotice(caseId, noticeId);

  if (!notice) {
    throw new Error("Notice not found for this case.");
  }

  if (notice.recipient_party_id !== partyId) {
    throw new Error(
      "Selected notice does not belong to the selected opposite party."
    );
  }

  if (!["DISPATCHED", "SERVED"].includes(notice.status)) {
    throw new Error(
      `This notice has not been issued/served. Current notice status: ${notice.status}. An OP response cannot be recorded against an unissued notice.`
    );
  }

  const serviceAttempt = db
    .prepare(`
      SELECT *
      FROM pim_service_attempts
      WHERE notice_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(noticeId);

  if (!serviceAttempt) {
    throw new Error(
      "No service record exists for this notice. Record service before recording an OP response."
    );
  }

  return { notice, serviceAttempt };
}

function assertNotPremature(dateString, label) {
  if (!dateString) {
    throw new Error(
      `Unable to determine the ${label} date for this case.`
    );
  }

  if (today() < dateString) {
    throw new Error(
      `Cannot record ${label} before ${dateString}.`
    );
  }
}

/*
 * 10-day ceiling on an alternate appearance date, measured from
 * the date the OP's time request is recorded (rule: "not later
 * than 10 days from receipt of the OP's request"). An earlier
 * date is always allowed; 7 days is not a hard default.
 */
function assertAlternateDateWithinWindow(requestDate, alternateDate) {
  const maxDate = addDays(requestDate, MAX_ALTERNATE_DATE_WINDOW_DAYS);

  if (alternateDate > maxDate) {
    throw new Error(
      `The alternate appearance date cannot be more than ${MAX_ALTERNATE_DATE_WINDOW_DAYS} days after the request date (${requestDate}).`
    );
  }
}

function getLatestResponse(caseId, partyId, responseType) {
  return db
    .prepare(`
      SELECT r.*, p.name AS party_name
      FROM pim_responses r
      JOIN pim_parties p ON p.id = r.party_id
      WHERE r.case_id = ?
        AND r.party_id = ?
        AND r.response_type = ?
      ORDER BY r.id DESC
      LIMIT 1
    `)
    .get(caseId, partyId, responseType);
}

function getPendingTask(caseId, taskTypeCode) {
  return db
    .prepare(`
      SELECT id, status
      FROM pim_tasks
      WHERE case_id = ?
        AND task_type_code = ?
        AND status = 'PENDING'
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(caseId, taskTypeCode);
}

function completeTask(task, userId, remarks) {
  db.prepare(`
    UPDATE pim_tasks
    SET status = 'COMPLETED', completed_date = ?, completed_time = ?, completed_by = ?
    WHERE id = ?
  `).run(today(), officeTime(), userId, task.id);

  db.prepare(`
    INSERT INTO pim_task_history
    (task_id, old_status, new_status, changed_by, remarks)
    VALUES (?, ?, 'COMPLETED', ?, ?)
  `).run(task.id, task.status, userId, remarks);
}

function completeTaskIfPending(caseId, taskTypeCode, userId, remarks) {
  const task = getPendingTask(caseId, taskTypeCode);

  if (task) {
    completeTask(task, userId, remarks);
  }

  return Boolean(task);
}

function createPendingTaskIfNotExists(caseId, taskTypeCode, description, dueDate, remarks = null) {
  const existing = getPendingTask(caseId, taskTypeCode);

  if (existing) {
    return existing.id;
  }

  const taskType = db
    .prepare("SELECT id, default_priority FROM task_types WHERE code = ?")
    .get(taskTypeCode);

  const result = db.prepare(`
    INSERT INTO pim_tasks
    (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated, remarks)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)
  `).run(
    caseId,
    taskType ? taskType.id : null,
    taskTypeCode,
    description,
    today(),
    dueDate,
    taskType ? taskType.default_priority : "NORMAL",
    remarks
  );

  return Number(result.lastInsertRowid);
}

/*
 * Phase 4 never creates a pim_outcomes row, never sets
 * CLOSED_NON_STARTER, and never generates Form-3. It only
 * leaves a clean, non-duplicated NONSTARTER_FORM3 task (the
 * existing handoff task type) plus docket/history for Phase 5
 * to pick up.
 */
function createNonStarterHandoff(caseId, partyName, reasonText, userId) {
  return createPendingTaskIfNotExists(
    caseId,
    "NONSTARTER_FORM3",
    `Non-starter handoff: ${reasonText} (${partyName || "opposite party"}).`,
    today(),
    reasonText
  );
}

function insertResponse({
  caseId,
  partyId,
  noticeId,
  responseDate,
  appearanceMode,
  responseType,
  timeRequestedUntil,
  consent,
  mediationFeeRequested,
  remarks,
  userId,
}) {
  const result = db.prepare(`
    INSERT INTO pim_responses
    (
      case_id, party_id, notice_id, response_date, appearance_mode,
      response_type, time_requested_until, consent,
      mediation_fee_requested, remarks, entered_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    caseId,
    partyId,
    noticeId,
    responseDate,
    appearanceMode,
    responseType,
    timeRequestedUntil,
    consent,
    mediationFeeRequested,
    remarks,
    userId
  );

  return Number(result.lastInsertRowid);
}

/*
 * Rule 11's mediation fee is ONE statutory, case-level fee for
 * the proceeding - shared between the two sides, not multiplied
 * per opposite party. Dedup is therefore keyed by case_id alone.
 * party_id is still stored on the row (the party whose consent
 * first triggered it) purely as an audit note, the same way it
 * already records "who paid" on an APPLICATION_FEE row - it is
 * never part of the dedup key for MEDIATION_FEE.
 */
function ensureMediationFee(caseId, partyId, remarksText) {
  const existingFee = db
    .prepare(`
      SELECT id, amount_due
      FROM pim_fees
      WHERE case_id = ?
        AND fee_type = 'MEDIATION_FEE'
      LIMIT 1
    `)
    .get(caseId);

  // amount_due is the FULL statutory Schedule-II fee, computed
  // from the claim amount - never halved, never left null once
  // it can be determined.
  const caseRow = db
    .prepare(`SELECT claim_amount FROM pim_cases WHERE id = ?`)
    .get(caseId);
  const totalFee = caseRow
    ? calculateMediationFee(caseRow.claim_amount)
    : null;

  if (existingFee) {
    if (existingFee.amount_due == null && totalFee != null) {
      db.prepare(`UPDATE pim_fees SET amount_due = ? WHERE id = ?`).run(
        totalFee,
        existingFee.id
      );
    }

    return existingFee.id;
  }

  const fee = db.prepare(`
    INSERT INTO pim_fees
    (case_id, party_id, fee_type, amount_due, amount_received, status, remarks)
    VALUES (?, ?, 'MEDIATION_FEE', ?, 0, 'PENDING', ?)
  `).run(caseId, partyId, totalFee, remarksText);

  return Number(fee.lastInsertRowid);
}

module.exports = {
  MAX_ALTERNATE_DATE_WINDOW_DAYS,
  today,
  getStatusId,
  getEventId,
  addStatusHistory,
  transitionStatus,
  addDocket,
  getCase,
  getActiveOppositeParty,
  loadNotice,
  requireIssuedNoticeForParty,
  assertNotPremature,
  assertAlternateDateWithinWindow,
  getLatestResponse,
  getPendingTask,
  completeTask,
  completeTaskIfPending,
  createPendingTaskIfNotExists,
  createNonStarterHandoff,
  insertResponse,
  ensureMediationFee,
};
