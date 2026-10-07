/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL port of the mediator-ASSIGNMENT workflow (production-
 * completion sprint, 2026-10-07) - app/api/pim/mediator/[id]/route.js.
 * Not to be confused with lib/pim-data/mediator-registry.js, which is
 * the mediator PROFILE registry (CRUD on the `mediators` table) and was
 * already PostgreSQL-authoritative; this module is the missing piece -
 * assigning an approved mediator to a specific case
 * (MEDIATOR_ASSIGNMENT_PENDING -> MEDIATOR_ASSIGNED). Without this, a
 * case created through the already-migrated Postgres intake/fee path
 * could never reach MEDIATOR_ASSIGNED, since the SQLite route operates
 * against an entirely separate database with no knowledge of that case.
 *
 * Matches the SQLite original statement-for-statement: durable
 * MEDIATOR_ASSIGNMENT_PENDING -> MEDIATOR_ASSIGNED only (does not
 * shortcut to MEDIATION_PENDING - that transition belongs to
 * lib/pim-data/mediation.js's fixFirstMediationDateTx, unchanged).
 */

const { withTransaction, getSql } = require("../pim-postgres");
const { officeDate, officeTime } = require("../pim-time");
const {
  getStatusId, addStatusHistory, addDocket, getPendingTask,
} = require("./workflow-helpers");

async function completeTaskTx(tx, task, userId, remarks) {
  const updated = await tx`
    UPDATE pim_tasks
    SET status = 'COMPLETED', completed_date = ${officeDate()}, completed_time = ${officeTime()}, completed_by = ${userId}, remarks = ${remarks}
    WHERE id = ${task.id} AND status = 'PENDING'
    RETURNING id
  `;
  if (updated.length === 1) {
    await tx`
      INSERT INTO pim_task_history (task_id, old_status, new_status, changed_by, remarks)
      VALUES (${task.id}, 'PENDING', 'COMPLETED', ${userId}, ${remarks})
    `;
  }
  return updated.length === 1;
}

async function assignMediatorTx(tx, caseId, input, userId) {
  const {
    mediatorId, assignmentOrderNo = null, firstMediationDate = null,
    deviationFromRotation = false, deviationReason = null, remarks = null,
  } = input;

  if (!Number.isInteger(mediatorId) || mediatorId <= 0) {
    throw new Error("A valid mediator must be selected.");
  }
  if (deviationFromRotation && !deviationReason) {
    throw new Error("Deviation reason is required when rotation is overridden.");
  }

  const [caseRow] = await tx`
    SELECT c.id, c.pim_number, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (caseRow.status_code !== "MEDIATOR_ASSIGNMENT_PENDING") {
    throw new Error(`This case is not currently available for mediator assignment. Current status: ${caseRow.status_name}`);
  }

  const [mediator] = await tx`SELECT * FROM mediators WHERE id = ${mediatorId}`;
  if (!mediator) throw new Error("Selected mediator does not exist.");
  if (mediator.active !== true) throw new Error("Inactive mediators cannot be newly assigned.");
  if (mediator.panel_valid_until && mediator.panel_valid_until < officeDate()) {
    throw new Error("Mediator panel validity has expired; assignment is blocked.");
  }

  const [activeAssignment] = await tx`SELECT id FROM pim_mediator_assignments WHERE case_id = ${caseId} AND status = 'ACTIVE' LIMIT 1`;
  if (activeAssignment) throw new Error("An active mediator is already assigned to this case.");

  const [assignment] = await tx`
    INSERT INTO pim_mediator_assignments
      (case_id, mediator_id, assignment_date, assignment_order_no, first_mediation_date, rotation_suggestion_no, deviation_from_rotation, deviation_reason, status, remarks)
    VALUES
      (${caseId}, ${mediatorId}, ${officeDate()}, ${assignmentOrderNo}, ${firstMediationDate}, ${mediator.rotation_order}, ${Boolean(deviationFromRotation)}, ${deviationReason}, 'ACTIVE', ${remarks})
    RETURNING id
  `;

  const fromStatusId = await getStatusId(tx, "MEDIATOR_ASSIGNMENT_PENDING");
  const assignedStatusId = await getStatusId(tx, "MEDIATOR_ASSIGNED");

  await addStatusHistory(tx, caseId, fromStatusId, assignedStatusId, `Mediator ${mediator.name} assigned.`, userId);
  await tx`UPDATE pim_cases SET current_status_id = ${assignedStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

  await addDocket(
    tx, caseId, "MEDIATOR_ASSIGNED",
    `Mediator ${mediator.name} assigned to PIM case ${caseRow.pim_number}.`,
    "First mediation", null, userId
  );

  const task = await getPendingTask(tx, caseId, "MEDIATOR_ASSIGNMENT");
  if (task) {
    await completeTaskTx(tx, task, userId, `Mediator ${mediator.name} assigned.`);
  }

  const existingFirstTask = await getPendingTask(tx, caseId, "FIRST_MEDIATION");
  let firstMediationTaskId;
  if (existingFirstTask) {
    firstMediationTaskId = existingFirstTask.id;
  } else {
    const [taskType] = await tx`SELECT id, default_priority FROM task_types WHERE code = 'FIRST_MEDIATION' AND active = true LIMIT 1`;
    if (!taskType) throw new Error("Active FIRST_MEDIATION task type not found.");
    const [firstTask] = await tx`
      INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated, remarks)
      VALUES (${caseId}, ${taskType.id}, 'FIRST_MEDIATION', 'Fix and conduct the first mediation session.', ${officeDate()}, ${firstMediationDate || officeDate()}, ${taskType.default_priority || "NORMAL"}, 'PENDING', true, 'Automatically generated after mediator assignment.')
      RETURNING id
    `;
    firstMediationTaskId = firstTask.id;
  }

  return {
    caseId, assignmentId: assignment.id, mediatorId, mediatorName: mediator.name,
    firstMediationTaskId, statusCode: "MEDIATOR_ASSIGNED",
  };
}

async function assignMediatorPg(caseId, input, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) throw new Error("Valid case ID is required.");
  return withTransaction((tx) => assignMediatorTx(tx, numericCaseId, { ...input, mediatorId: Number(input.mediatorId) }, userId));
}

const REASSIGNABLE_STATUSES = new Set(["MEDIATOR_ASSIGNED", "MEDIATION_PENDING", "MEDIATION_ONGOING"]);

/*
 * PostgreSQL port of app/api/pim/mediator/reassign/[id]/route.js
 * (production-completion sprint, 2026-10-07). Matches the SQLite
 * original's validation order, guards, and effects exactly - no
 * redesign:
 *
 *   - case must be at one of the three reassignable statuses (Rule 5:
 *     no reassignment on a terminal case, including CLOSED_NON_STARTER,
 *     which never had an active mediation-stage assignment to reassign
 *     in the first place);
 *   - an ACTIVE assignment must already exist;
 *   - the replacement mediator must be a different mediator, must
 *     exist, must be active, and must be within panel validity;
 *   - the OLD assignment is never deleted or overwritten - it is set to
 *     'ENDED' with an appended remark, preserving it as history;
 *   - the NEW assignment row's replacement_for_assignment_id points at
 *     the old assignment's id, making the chain reconstructable;
 *   - exactly one assignment is ever ACTIVE for the case at a time (the
 *     UPDATE ends the old one BEFORE the INSERT creates the new one, in
 *     the same locked transaction);
 *   - existing mediation_sessions rows are never touched - they keep
 *     pointing at the OLD assignment_id, so who actually conducted each
 *     already-recorded past sitting remains historically accurate;
 *   - case status and pending tasks are intentionally UNCHANGED -
 *     reassignment swaps who is handling the case at its current stage;
 *     it is not a stage transition, and whichever FIRST_MEDIATION/
 *     SESSION_RECORD/OUTCOME_FORM task is already pending stays exactly
 *     as it was.
 */
async function reassignMediatorTx(tx, caseId, { mediatorId: newMediatorId, reason }, userId) {
  if (!Number.isInteger(newMediatorId) || newMediatorId <= 0) {
    throw new Error("A valid mediator must be selected.");
  }
  if (!reason) {
    throw new Error("A reason for reassignment is required.");
  }

  const [caseRow] = await tx`
    SELECT c.id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (!REASSIGNABLE_STATUSES.has(caseRow.status_code)) {
    throw new Error(`This case is not currently available for mediator reassignment. Current status: ${caseRow.status_name}`);
  }

  const [currentAssignment] = await tx`
    SELECT a.*, m.name AS mediator_name
    FROM pim_mediator_assignments a JOIN mediators m ON m.id = a.mediator_id
    WHERE a.case_id = ${caseId} AND a.status = 'ACTIVE'
    ORDER BY a.id DESC LIMIT 1
  `;
  if (!currentAssignment) throw new Error("No active mediator assignment exists for this case to reassign.");

  if (currentAssignment.mediator_id === newMediatorId) {
    throw new Error("Cannot reassign to the same mediator that is already active on this case.");
  }

  const [newMediator] = await tx`SELECT * FROM mediators WHERE id = ${newMediatorId}`;
  if (!newMediator) throw new Error("Selected mediator does not exist.");
  if (newMediator.active !== true) throw new Error("Inactive mediators cannot be newly assigned.");
  if (newMediator.panel_valid_until && newMediator.panel_valid_until < officeDate()) {
    throw new Error("Mediator panel validity has expired; assignment is blocked.");
  }

  await tx`
    UPDATE pim_mediator_assignments
    SET status = 'ENDED', remarks = TRIM(COALESCE(remarks || chr(10), '') || ${`Reassigned to ${newMediator.name} on ${officeDate()}: ${reason}`})
    WHERE id = ${currentAssignment.id}
  `;

  const [inserted] = await tx`
    INSERT INTO pim_mediator_assignments
      (case_id, mediator_id, assignment_date, appointed_by, status, replacement_for_assignment_id, remarks)
    VALUES
      (${caseId}, ${newMediatorId}, ${officeDate()}, ${userId}, 'ACTIVE', ${currentAssignment.id}, ${`Reassigned from ${currentAssignment.mediator_name}: ${reason}`})
    RETURNING id
  `;

  await addDocket(
    tx, caseId,
    "MEDIATOR_ASSIGNED",
    `Mediator reassigned from ${currentAssignment.mediator_name} to ${newMediator.name}. Reason: ${reason}`,
    null, null, userId
  );

  return {
    caseId,
    oldAssignmentId: currentAssignment.id,
    oldMediatorId: currentAssignment.mediator_id,
    oldMediatorName: currentAssignment.mediator_name,
    newAssignmentId: inserted.id,
    newMediatorId,
    newMediatorName: newMediator.name,
    statusCode: caseRow.status_code,
  };
}

async function reassignMediatorPg(caseId, input, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) throw new Error("Valid case ID is required.");
  return withTransaction((tx) => reassignMediatorTx(tx, numericCaseId, { ...input, mediatorId: Number(input.mediatorId) }, userId));
}

async function getMediatorAssignmentDataPg(caseId) {
  const sql = getSql();

  const [caseRow] = await sql`
    SELECT c.*, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;
  if (!caseRow) return null;

  const mediators = await sql`
    SELECT id, name, category, enrollment_no, contact_phone, email, empanelment_order_no, empanelment_date, panel_valid_until, active, rotation_order, conflict_declaration_date, remarks
    FROM mediators
    WHERE active = true AND (panel_valid_until IS NULL OR panel_valid_until >= ${officeDate()})
    ORDER BY CASE WHEN rotation_order IS NULL THEN 999999 ELSE rotation_order END, id
  `;

  const assignments = await sql`
    SELECT a.*, m.name AS mediator_name, m.category AS mediator_category, m.enrollment_no
    FROM pim_mediator_assignments a JOIN mediators m ON m.id = a.mediator_id
    WHERE a.case_id = ${caseId}
    ORDER BY a.id DESC
  `;

  const [pendingTask] = await sql`
    SELECT * FROM pim_tasks
    WHERE case_id = ${caseId} AND task_type_code IN ('MEDIATOR_ASSIGNMENT', 'FIRST_MEDIATION') AND status = 'PENDING'
    ORDER BY CASE task_type_code WHEN 'FIRST_MEDIATION' THEN 1 WHEN 'MEDIATOR_ASSIGNMENT' THEN 2 ELSE 3 END, id DESC
    LIMIT 1
  `;

  return { case: caseRow, mediators, assignments, pendingTask: pendingTask || null };
}

module.exports = {
  assignMediatorTx,
  assignMediatorPg,
  reassignMediatorTx,
  reassignMediatorPg,
  getMediatorAssignmentDataPg,
};
