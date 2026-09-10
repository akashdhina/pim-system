const db = require("../lib/db");
const {
  officeDate,
  officeTime,
} = require("../lib/pim-time");

const receivedNumber = "3632/2025";

const repair = db.transaction(() => {
  const caseRow = db.prepare(`
    SELECT
      c.id,
      c.pim_number,
      c.received_number,
      c.current_status_id,
      s.code AS status_code,
      s.name AS status_name
    FROM pim_cases c
    JOIN status_master s
      ON s.id = c.current_status_id
    WHERE c.received_number = ?
    LIMIT 1
  `).get(receivedNumber);

  if (!caseRow) {
    throw new Error(
      `Case with Received No. ${receivedNumber} was not found.`
    );
  }

  if (
    caseRow.status_code !==
    "SECRETARY_APPROVAL_PENDING"
  ) {
    throw new Error(
      `Unexpected current status: ${caseRow.status_code}`
    );
  }

  const scrutinyCompleted = db.prepare(`
    SELECT d.id
    FROM pim_docket d
    JOIN event_types e
      ON e.id = d.event_type_id
    WHERE d.case_id = ?
      AND e.code = 'SCRUTINY_COMPLETED'
    LIMIT 1
  `).get(caseRow.id);

  if (!scrutinyCompleted) {
    throw new Error(
      "SCRUTINY_COMPLETED docket entry was not found. Repair stopped."
    );
  }

  const scrutinyHistory = db.prepare(`
    SELECT h.id
    FROM pim_status_history h
    JOIN status_master ts
      ON ts.id = h.to_status_id
    WHERE h.case_id = ?
      AND ts.code =
        'SECRETARY_APPROVAL_PENDING'
    LIMIT 1
  `).get(caseRow.id);

  if (!scrutinyHistory) {
    throw new Error(
      "Status transition to SECRETARY_APPROVAL_PENDING was not found. Repair stopped."
    );
  }

  const scrutinyTask = db.prepare(`
    SELECT
      id,
      status
    FROM pim_tasks
    WHERE case_id = ?
      AND task_type_code = 'SCRUTINY'
      AND status = 'PENDING'
    ORDER BY id
    LIMIT 1
  `).get(caseRow.id);

  if (!scrutinyTask) {
    return {
      success: true,
      repaired: false,
      message:
        "No stale pending SCRUTINY task exists. No repair was required.",
      caseId: caseRow.id,
      receivedNumber:
        caseRow.received_number,
      status:
        caseRow.status_code,
    };
  }

  const update = db.prepare(`
    UPDATE pim_tasks
    SET
      status = 'COMPLETED',
      completed_date = ?,
      completed_time = ?,
      completed_by = NULL,
      remarks = ?
    WHERE id = ?
      AND status = 'PENDING'
  `).run(
    officeDate(),
    officeTime(),
    "One-time repair: scrutiny had already been completed and the case had moved to Secretary Approval Pending, but the SCRUTINY task remained pending.",
    scrutinyTask.id
  );

  if (update.changes !== 1) {
    throw new Error(
      "The stale SCRUTINY task could not be updated."
    );
  }

  db.prepare(`
    INSERT INTO pim_task_history
    (
      task_id,
      old_status,
      new_status,
      changed_by,
      remarks
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    scrutinyTask.id,
    "PENDING",
    "COMPLETED",
    null,
    "One-time repair of stale SCRUTINY task for Received No. 3632/2025."
  );

  return {
    success: true,
    repaired: true,
    caseId: caseRow.id,
    receivedNumber:
      caseRow.received_number,
    status:
      caseRow.status_code,
    completedScrutinyTaskId:
      scrutinyTask.id,
    nextAction:
      "Secretary approval",
  };
});

console.log(repair());