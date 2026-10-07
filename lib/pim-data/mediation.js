/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL port of the mediation-session workflow (production-
 * completion sprint, 2026-10-07): app/api/pim/mediation/[id]/route.js
 * (fix first mediation date), app/api/pim/mediation/session/[id]/route.js
 * (record a sitting), app/api/pim/mediation/next/[id]/route.js (fix the
 * next sitting). See docs/phase6-mediation-sessions-migration.md.
 *
 * Matches the SQLite originals statement-for-statement and branch-for-
 * branch - no redesign. The only representational change is boolean
 * columns (applicant_present, opposite_party_present, effective_session,
 * report_received are real PostgreSQL booleans here, not SQLite 0/1) -
 * every comparison and write uses true/false, never 1/0.
 *
 * Every mutating function locks the case row first (FOR UPDATE OF c),
 * matching every other Batch 5D+ module's concurrency pattern.
 */

const { withTransaction, getSql } = require("../pim-postgres");
const { officeDate, officeTime } = require("../pim-time");
const {
  getStatusId, addStatusHistory, addDocket, getPendingTask,
} = require("./workflow-helpers");

const NEXT_ACTION_LABELS = {
  READY_FOR_SETTLEMENT: "Ready for settlement outcome",
  READY_FOR_FAILURE: "Ready for failure outcome",
};

function timeToMinutes(time) {
  if (!time) return null;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 60 + minutes + seconds / 60;
}

function calculateDuration(startTime, endTime) {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (start === null || end === null) return null;
  if (end <= start) {
    throw new Error("Actual end time must be later than actual start time.");
  }
  return Math.round(end - start);
}

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

async function getActiveAssignmentTx(tx, caseId) {
  const [assignment] = await tx`
    SELECT a.*, m.name AS mediator_name, m.category AS mediator_category, m.enrollment_no, m.contact_phone, m.email
    FROM pim_mediator_assignments a JOIN mediators m ON m.id = a.mediator_id
    WHERE a.case_id = ${caseId} AND a.status = 'ACTIVE'
    ORDER BY a.id DESC LIMIT 1
  `;
  return assignment || null;
}

async function createTaskTx(tx, caseId, taskTypeCode, description, dueDate, remarks) {
  const [taskType] = await tx`SELECT id, default_priority FROM task_types WHERE code = ${taskTypeCode} AND active = true LIMIT 1`;
  if (!taskType) throw new Error(`Active ${taskTypeCode} task type not found.`);
  const [task] = await tx`
    INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated, remarks)
    VALUES (${caseId}, ${taskType.id}, ${taskTypeCode}, ${description}, ${officeDate()}, ${dueDate}, ${taskType.default_priority || "NORMAL"}, 'PENDING', true, ${remarks})
    RETURNING id
  `;
  return task.id;
}

// ---------------------------------------------------------------------
// Fix first mediation date: MEDIATOR_ASSIGNED -> MEDIATION_PENDING
// ---------------------------------------------------------------------

async function fixFirstMediationDateTx(tx, caseId, { scheduledDate, remarks = null }, userId) {
  if (!scheduledDate) throw new Error("First mediation date is required.");

  const [caseRow] = await tx`
    SELECT c.id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (caseRow.status_code !== "MEDIATOR_ASSIGNED") {
    throw new Error(`This case is not currently available for fixing the first mediation date. Current status: ${caseRow.status_name}`);
  }

  const assignment = await getActiveAssignmentTx(tx, caseId);
  if (!assignment) throw new Error("No active mediator assignment exists for this case.");

  const [existingSession] = await tx`SELECT id FROM mediation_sessions WHERE case_id = ${caseId} ORDER BY id LIMIT 1`;
  if (existingSession) throw new Error("A mediation session has already been created for this case.");

  const [{ max_number: maxNumber }] = await tx`SELECT COALESCE(MAX(sitting_number), 0) AS max_number FROM mediation_sessions WHERE case_id = ${caseId}`;
  const sittingNumber = Number(maxNumber) + 1;

  const [session] = await tx`
    INSERT INTO mediation_sessions
      (case_id, assignment_id, sitting_number, scheduled_date, applicant_present, opposite_party_present, effective_session, session_status, administrative_remarks, report_received, recorded_by)
    VALUES
      (${caseId}, ${assignment.id}, ${sittingNumber}, ${scheduledDate}, false, false, false, 'SCHEDULED', ${remarks}, false, ${userId})
    RETURNING id
  `;

  await tx`
    UPDATE pim_mediator_assignments
    SET first_mediation_date = ${scheduledDate}, remarks = COALESCE(${remarks}, remarks)
    WHERE id = ${assignment.id}
  `;

  const fromStatusId = await getStatusId(tx, "MEDIATOR_ASSIGNED");
  const toStatusId = await getStatusId(tx, "MEDIATION_PENDING");

  await addStatusHistory(tx, caseId, fromStatusId, toStatusId, `First mediation fixed for ${scheduledDate}.`, userId);
  await tx`UPDATE pim_cases SET current_status_id = ${toStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

  await addDocket(
    tx, caseId, "MEDIATION_DATE_FIXED",
    `First mediation date fixed for ${scheduledDate} before mediator ${assignment.mediator_name}.`,
    "First mediation", scheduledDate, userId
  );

  const task = await getPendingTask(tx, caseId, "FIRST_MEDIATION");
  let completedTaskId = null;
  if (task) {
    await completeTaskTx(tx, task, userId, `First mediation fixed for ${scheduledDate}.`);
    completedTaskId = task.id;
  }

  return {
    caseId, sessionId: session.id, assignmentId: assignment.id, mediatorId: assignment.mediator_id,
    mediatorName: assignment.mediator_name, sittingNumber, scheduledDate, completedTaskId, statusCode: "MEDIATION_PENDING",
  };
}

async function fixFirstMediationDatePg(caseId, input, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) throw new Error("Valid case ID is required.");
  return withTransaction((tx) => fixFirstMediationDateTx(tx, numericCaseId, input, userId));
}

// ---------------------------------------------------------------------
// Fix next mediation sitting (used while MEDIATION_ONGOING, outside the
// inline next-sitting creation recordMediationSessionTx already does)
// ---------------------------------------------------------------------

async function fixNextMediationDateTx(tx, caseId, { scheduledDate, remarks = null }, userId) {
  if (!scheduledDate) throw new Error("Next mediation date is required.");

  const [caseRow] = await tx`
    SELECT c.id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (caseRow.status_code !== "MEDIATION_ONGOING") {
    throw new Error(`This case is not currently available for fixing the next mediation sitting. Current status: ${caseRow.status_name}`);
  }

  const assignment = await getActiveAssignmentTx(tx, caseId);
  if (!assignment) throw new Error("No active mediator assignment exists.");

  const [pendingSession] = await tx`SELECT id FROM mediation_sessions WHERE case_id = ${caseId} AND session_status = 'SCHEDULED' LIMIT 1`;
  if (pendingSession) throw new Error("A scheduled mediation sitting already exists for this case.");

  const [{ next_number: nextNumber }] = await tx`SELECT COALESCE(MAX(sitting_number), 0) + 1 AS next_number FROM mediation_sessions WHERE case_id = ${caseId}`;

  const [session] = await tx`
    INSERT INTO mediation_sessions
      (case_id, assignment_id, sitting_number, scheduled_date, applicant_present, opposite_party_present, effective_session, session_status, administrative_remarks, report_received, recorded_by)
    VALUES
      (${caseId}, ${assignment.id}, ${nextNumber}, ${scheduledDate}, false, false, false, 'SCHEDULED', ${remarks}, false, ${userId})
    RETURNING id
  `;

  await addDocket(
    tx, caseId, "MEDIATION_DATE_FIXED",
    `Mediation sitting ${nextNumber} fixed for ${scheduledDate} before mediator ${assignment.mediator_name}.`,
    "Next mediation sitting", scheduledDate, userId
  );

  const existingTask = await getPendingTask(tx, caseId, "SESSION_RECORD");
  let taskId = existingTask ? existingTask.id : null;
  if (!existingTask) {
    taskId = await createTaskTx(tx, caseId, "SESSION_RECORD", `Record mediation sitting ${nextNumber}.`, scheduledDate, `Sitting ${nextNumber} fixed for ${scheduledDate}.`);
  }

  return { caseId, sessionId: session.id, sittingNumber: nextNumber, scheduledDate, taskId, statusCode: "MEDIATION_ONGOING" };
}

async function fixNextMediationDatePg(caseId, input, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) throw new Error("Valid case ID is required.");
  return withTransaction((tx) => fixNextMediationDateTx(tx, numericCaseId, input, userId));
}

// ---------------------------------------------------------------------
// Record a mediation sitting - the big one
// ---------------------------------------------------------------------

async function recordMediationSessionTx(tx, sessionId, input, userId) {
  const {
    actualDate: rawActualDate, applicantPresent: rawApplicantPresent, oppositePartyPresent: rawOppositePartyPresent,
    actualStartTime = null, actualEndTime = null, nextDate = null, administrativeRemarks = null, nextAction: rawNextAction = null,
  } = input;

  const actualDate = rawActualDate || officeDate();
  if (!actualDate) throw new Error("Actual session date is required.");

  const applicantPresent = Boolean(rawApplicantPresent);
  const oppositePartyPresent = Boolean(rawOppositePartyPresent);
  const nextAction = rawNextAction && NEXT_ACTION_LABELS[rawNextAction] ? rawNextAction : null;

  const [sessionLookup] = await tx`SELECT case_id FROM mediation_sessions WHERE id = ${sessionId}`;
  if (!sessionLookup) throw new Error("Mediation session not found.");

  const [caseRow] = await tx`SELECT id FROM pim_cases WHERE id = ${sessionLookup.case_id} FOR UPDATE OF pim_cases`;
  if (!caseRow) throw new Error("PIM case not found.");

  const [session] = await tx`
    SELECT ms.*, c.pim_number, c.current_status_id, s.code AS case_status_code, s.name AS case_status_name,
           a.id AS assignment_id, a.mediator_id, m.name AS mediator_name
    FROM mediation_sessions ms
    JOIN pim_cases c ON c.id = ms.case_id
    JOIN status_master s ON s.id = c.current_status_id
    JOIN pim_mediator_assignments a ON a.id = ms.assignment_id
    JOIN mediators m ON m.id = a.mediator_id
    WHERE ms.id = ${sessionId}
  `;
  if (!session) throw new Error("Mediation session not found.");

  if (session.session_status !== "SCHEDULED") {
    return { conflict: true, message: `This session has already been recorded. Current session status: ${session.session_status}` };
  }
  if (session.case_status_code !== "MEDIATION_PENDING" && session.case_status_code !== "MEDIATION_ONGOING") {
    return { conflict: true, message: `This case is not currently available for session recording. Current status: ${session.case_status_name}` };
  }

  if (actualDate > officeDate()) throw new Error("Actual session date cannot be a future date.");
  if (session.scheduled_date && actualDate < session.scheduled_date) {
    throw new Error("Actual session date cannot be earlier than the scheduled date.");
  }

  const bothPresent = applicantPresent && oppositePartyPresent;
  let effectiveSession = false;
  let durationMinutes = null;
  let sessionStatus = "ADJOURNED";

  if (bothPresent) {
    if (!actualStartTime || !actualEndTime) {
      throw new Error("Actual start time and actual end time are required when both parties are present.");
    }
    durationMinutes = calculateDuration(actualStartTime, actualEndTime);
    effectiveSession = true;
    sessionStatus = "COMPLETED";
  } else {
    if (actualStartTime || actualEndTime) {
      throw new Error("Actual start/end time must not be recorded for an ineffective session.");
    }
    if (!nextDate) throw new Error("Next date is required when the session is adjourned.");
  }

  const recordedRemarks = effectiveSession && !nextDate && nextAction
    ? [administrativeRemarks, `Staff assessment: ${NEXT_ACTION_LABELS[nextAction]}.`].filter(Boolean).join(" ")
    : administrativeRemarks;

  const recordedNextAction = !effectiveSession ? null : nextDate ? "FURTHER_MEDIATION" : nextAction || null;

  await tx`
    UPDATE mediation_sessions
    SET actual_date = ${actualDate}, applicant_present = ${applicantPresent}, opposite_party_present = ${oppositePartyPresent},
        effective_session = ${effectiveSession}, actual_start_time = ${actualStartTime}, actual_end_time = ${actualEndTime},
        duration_minutes = ${durationMinutes}, next_date = ${nextDate}, session_status = ${sessionStatus},
        next_action = ${recordedNextAction}, administrative_remarks = ${recordedRemarks}, recorded_by = ${userId}
    WHERE id = ${sessionId}
  `;

  const [currentTask] = await tx`
    SELECT id FROM pim_tasks
    WHERE case_id = ${session.case_id} AND task_type_code IN ('SESSION_RECORD', 'FIRST_MEDIATION') AND status = 'PENDING' AND due_date = ${session.scheduled_date}
    ORDER BY CASE task_type_code WHEN 'SESSION_RECORD' THEN 1 WHEN 'FIRST_MEDIATION' THEN 2 ELSE 3 END, id ASC
    LIMIT 1
  `;
  let completedTaskId = null;
  if (currentTask) {
    const done = await completeTaskTx(tx, currentTask, userId, `Mediation sitting ${session.sitting_number} recorded.`);
    if (done) completedTaskId = currentTask.id;
  }

  if (effectiveSession) {
    if (session.case_status_code !== "MEDIATION_ONGOING") {
      const fromStatusId = await getStatusId(tx, session.case_status_code);
      const toStatusId = await getStatusId(tx, "MEDIATION_ONGOING");
      await addStatusHistory(tx, session.case_id, fromStatusId, toStatusId, `Effective mediation session ${session.sitting_number} recorded. Duration: ${durationMinutes} minutes.`, userId);
      await tx`UPDATE pim_cases SET current_status_id = ${toStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${session.case_id}`;
    }
    await addDocket(
      tx, session.case_id, "MEDIATION_SESSION",
      `Effective mediation session ${session.sitting_number} recorded on ${actualDate}. Both parties were present. Duration: ${durationMinutes} minutes.`,
      nextDate ? "Next mediation sitting" : null, nextDate, userId
    );
  } else {
    if (session.case_status_code !== "MEDIATION_ONGOING") {
      const fromStatusId = await getStatusId(tx, session.case_status_code);
      const toStatusId = await getStatusId(tx, "MEDIATION_ONGOING");
      await addStatusHistory(tx, session.case_id, fromStatusId, toStatusId, `Ineffective mediation sitting ${session.sitting_number} recorded; next sitting fixed.`, userId);
      await tx`UPDATE pim_cases SET current_status_id = ${toStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${session.case_id}`;
    }
    await addDocket(
      tx, session.case_id, "MEDIATION_SESSION",
      `Mediation sitting ${session.sitting_number} recorded as ineffective. Applicant present: ${applicantPresent ? "Yes" : "No"}; Opposite party present: ${oppositePartyPresent ? "Yes" : "No"}.`,
      "Next mediation sitting", nextDate, userId
    );
  }

  let nextTaskId = null;
  let nextSessionId = null;
  let outcomeTaskId = null;
  let finalStatusCode = "MEDIATION_ONGOING";

  if (nextDate) {
    const [duplicateNextSession] = await tx`
      SELECT id, sitting_number FROM mediation_sessions WHERE case_id = ${session.case_id} AND session_status = 'SCHEDULED' AND scheduled_date = ${nextDate} LIMIT 1
    `;

    let nextSittingNumber;
    if (duplicateNextSession) {
      nextSessionId = duplicateNextSession.id;
      nextSittingNumber = duplicateNextSession.sitting_number;
    } else {
      nextSittingNumber = session.sitting_number + 1;
      const activeAssignment = await getActiveAssignmentTx(tx, session.case_id);
      const nextAssignmentId = activeAssignment ? activeAssignment.id : session.assignment_id;

      const [nextSession] = await tx`
        INSERT INTO mediation_sessions
          (case_id, assignment_id, sitting_number, scheduled_date, applicant_present, opposite_party_present, effective_session, session_status, report_received, recorded_by)
        VALUES
          (${session.case_id}, ${nextAssignmentId}, ${nextSittingNumber}, ${nextDate}, false, false, false, 'SCHEDULED', false, ${userId})
        RETURNING id
      `;
      nextSessionId = nextSession.id;
    }

    const [duplicateNextTask] = await tx`
      SELECT id FROM pim_tasks WHERE case_id = ${session.case_id} AND task_type_code = 'SESSION_RECORD' AND status = 'PENDING' AND due_date = ${nextDate} LIMIT 1
    `;
    if (duplicateNextTask) {
      nextTaskId = duplicateNextTask.id;
    } else {
      nextTaskId = await createTaskTx(tx, session.case_id, "SESSION_RECORD", `Record mediation sitting ${nextSittingNumber}.`, nextDate, `Next mediation sitting fixed for ${nextDate}.`);
    }
  } else {
    const outcomeStatusId = await getStatusId(tx, "OUTCOME_FORM_PENDING");
    const fromOutcomeStatusId = await getStatusId(tx, "MEDIATION_ONGOING");

    await addStatusHistory(tx, session.case_id, fromOutcomeStatusId, outcomeStatusId, `Mediation concluded after sitting ${session.sitting_number}; outcome form pending.`, userId);
    await tx`UPDATE pim_cases SET current_status_id = ${outcomeStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${session.case_id}`;

    await addDocket(
      tx, session.case_id, "MEDIATION_SESSION",
      `Mediation concluded after sitting ${session.sitting_number}.${nextAction ? ` Staff assessment: ${NEXT_ACTION_LABELS[nextAction]}.` : ""} Outcome form pending.`,
      "Outcome form", null, userId
    );

    const [duplicateOutcomeTask] = await tx`SELECT id FROM pim_tasks WHERE case_id = ${session.case_id} AND task_type_code = 'OUTCOME_FORM' AND status = 'PENDING' ORDER BY id DESC LIMIT 1`;
    if (duplicateOutcomeTask) {
      outcomeTaskId = duplicateOutcomeTask.id;
    } else {
      outcomeTaskId = await createTaskTx(tx, session.case_id, "OUTCOME_FORM", "Record mediation outcome and complete the PIM outcome form.", actualDate, `Mediation concluded after sitting ${session.sitting_number}.`);
    }

    finalStatusCode = "OUTCOME_FORM_PENDING";
  }

  return {
    sessionId, nextSessionId, caseId: session.case_id, sittingNumber: session.sitting_number, actualDate,
    applicantPresent, oppositePartyPresent, effectiveSession, actualStartTime, actualEndTime, durationMinutes,
    nextDate, sessionStatus, completedTaskId, nextTaskId, outcomeTaskId, statusCode: finalStatusCode,
  };
}

async function recordMediationSessionPg(sessionId, input, userId) {
  const numericSessionId = Number(sessionId);
  if (!Number.isInteger(numericSessionId) || numericSessionId <= 0) throw new Error("Valid session ID is required.");
  return withTransaction((tx) => recordMediationSessionTx(tx, numericSessionId, input, userId));
}

// ---------------------------------------------------------------------
// Read loaders
// ---------------------------------------------------------------------

async function getMediationCaseDataPg(caseId) {
  const sql = getSql();

  const [caseRow] = await sql`
    SELECT c.*, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;
  if (!caseRow) return null;

  const assignment = await getActiveAssignmentTx(sql, caseId);

  const sessions = await sql`
    SELECT ms.*, m.name AS mediator_name
    FROM mediation_sessions ms
    JOIN pim_mediator_assignments a ON a.id = ms.assignment_id
    JOIN mediators m ON m.id = a.mediator_id
    WHERE ms.case_id = ${caseId}
    ORDER BY ms.sitting_number
  `;

  const [pendingTask] = await sql`
    SELECT * FROM pim_tasks
    WHERE case_id = ${caseId} AND task_type_code IN ('FIRST_MEDIATION', 'SESSION_RECORD', 'OUTCOME_FORM') AND status = 'PENDING'
    ORDER BY due_date ASC, id ASC LIMIT 1
  `;

  const [outcome] = await sql`SELECT * FROM pim_outcomes WHERE case_id = ${caseId}`;

  const cumulativeDurationMinutes = sessions.reduce(
    (total, s) => (s.effective_session === true && Number.isFinite(s.duration_minutes) ? total + Number(s.duration_minutes) : total),
    0
  );

  return {
    case: caseRow, assignment: assignment || null, sessions, cumulativeDurationMinutes,
    pendingTask: pendingTask || null, outcome: outcome || null,
  };
}

async function getMediationSessionPg(sessionId) {
  const sql = getSql();
  const [session] = await sql`
    SELECT ms.*, c.pim_number, c.received_number, s.code AS case_status_code, s.name AS case_status_name,
           m.name AS mediator_name, m.category AS mediator_category, m.enrollment_no
    FROM mediation_sessions ms
    JOIN pim_cases c ON c.id = ms.case_id
    JOIN status_master s ON s.id = c.current_status_id
    JOIN pim_mediator_assignments a ON a.id = ms.assignment_id
    JOIN mediators m ON m.id = a.mediator_id
    WHERE ms.id = ${sessionId}
  `;
  return session || null;
}

module.exports = {
  fixFirstMediationDateTx,
  fixFirstMediationDatePg,
  fixNextMediationDateTx,
  fixNextMediationDatePg,
  recordMediationSessionTx,
  recordMediationSessionPg,
  getMediationCaseDataPg,
  getMediationSessionPg,
};
