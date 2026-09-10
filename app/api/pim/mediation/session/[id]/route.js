/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  officeDate,
  officeTime,
} = require("../../../../../../lib/pim-time");

function today() {
  return officeDate();
}

function currentTime() {
  return officeTime();
}

function getStatusId(code) {
  const row = db.prepare(`
    SELECT id
    FROM status_master
    WHERE code = ?
  `).get(code);

  if (!row) {
    throw new Error(`Status not found: ${code}`);
  }

  return row.id;
}

function getEventId(code) {
  const row = db.prepare(`
    SELECT id
    FROM event_types
    WHERE code = ?
  `).get(code);

  if (!row) {
    throw new Error(`Event not found: ${code}`);
  }

  return row.id;
}

function getTaskType(code) {
  return db.prepare(`
    SELECT
      id,
      code,
      default_priority
    FROM task_types
    WHERE code = ?
      AND active = 1
    LIMIT 1
  `).get(code);
}

function addStatusHistory(
  caseId,
  fromStatusId,
  toStatusId,
  reason,
  changedBy = null
) {
  db.prepare(`
    INSERT INTO pim_status_history
    (
      case_id,
      from_status_id,
      to_status_id,
      reason,
      changed_by
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    caseId,
    fromStatusId,
    toStatusId,
    reason,
    changedBy
  );
}

function addDocket(
  caseId,
  entryText,
  nextDate = null,
  actionRequired = null,
  enteredBy = null
) {
  const eventId =
    getEventId("MEDIATION_SESSION");

  db.prepare(`
    INSERT INTO pim_docket
    (
      case_id,
      docket_date,
      event_type_id,
      entry_text,
      action_required,
      next_date,
      entered_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    caseId,
    today(),
    eventId,
    entryText,
    actionRequired,
    nextDate,
    enteredBy
  );
}

function timeToMinutes(time) {
  if (!time) {
    return null;
  }

  const match =
    /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
      time
    );

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(
    match[3] || 0
  );

  if (
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return null;
  }

  return (
    hours * 60 +
    minutes +
    seconds / 60
  );
}

function calculateDuration(
  startTime,
  endTime
) {
  const start =
    timeToMinutes(startTime);

  const end =
    timeToMinutes(endTime);

  if (
    start === null ||
    end === null
  ) {
    return null;
  }

  if (end <= start) {
    throw new Error(
      "Actual end time must be later than actual start time."
    );
  }

  return Math.round(end - start);
}

export async function GET(
  request,
  { params }
) {
  try {
    await requirePermission(request, "READ_CASE");

    const { id } = await params;
    const sessionId = Number(id);

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message: "Invalid session ID.",
        },
        { status: 400 }
      );
    }

    const session =
      db.prepare(`
        SELECT
          ms.*,
          c.pim_number,
          c.received_number,
          s.code AS case_status_code,
          s.name AS case_status_name,
          m.name AS mediator_name,
          m.category AS mediator_category,
          m.enrollment_no
        FROM mediation_sessions ms
        JOIN pim_cases c
          ON c.id = ms.case_id
        JOIN status_master s
          ON s.id = c.current_status_id
        JOIN pim_mediator_assignments a
          ON a.id = ms.assignment_id
        JOIN mediators m
          ON m.id = a.mediator_id
        WHERE ms.id = ?
      `).get(sessionId);

    if (!session) {
      return Response.json(
        {
          success: false,
          message:
            "Mediation session not found.",
        },
        { status: 404 }
      );
    }

    return Response.json({
      success: true,
      data: {
        session,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Session GET error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load session.",
      },
      { status: 500 }
    );
  }
}

export async function POST(
  request,
  { params }
) {
  try {
    const user = await requirePermission(request, "RECORD_MEDIATION_SESSION");

    const { id } = await params;
    const sessionId = Number(id);

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message: "Invalid session ID.",
        },
        { status: 400 }
      );
    }

    const body =
      await request.json();

    const actualDate =
      body.actualDate
        ? String(body.actualDate).trim()
        : today();

    const applicantPresent =
      body.applicantPresent
        ? 1
        : 0;

    const oppositePartyPresent =
      body.oppositePartyPresent
        ? 1
        : 0;

    const actualStartTime =
      body.actualStartTime
        ? String(
            body.actualStartTime
          ).trim()
        : null;

    const actualEndTime =
      body.actualEndTime
        ? String(
            body.actualEndTime
          ).trim()
        : null;

    const nextDate =
      body.nextDate
        ? String(body.nextDate).trim()
        : null;

    const administrativeRemarks =
      body.administrativeRemarks
        ? String(
            body.administrativeRemarks
          ).trim()
        : null;

    /*
     * Minimal staff-recorded next-step signal (rule 10). Purely
     * descriptive - it never creates an outcome, never generates
     * Form IV/V, and never changes which status/task the existing
     * state machine already computes from bothPresent/nextDate.
     * Only meaningful when concluding mediation (no next sitting).
     */
    const NEXT_ACTION_LABELS = {
      READY_FOR_SETTLEMENT: "Ready for settlement outcome",
      READY_FOR_FAILURE: "Ready for failure outcome",
    };

    const nextAction =
      body.nextAction &&
      NEXT_ACTION_LABELS[body.nextAction]
        ? body.nextAction
        : null;

    if (!actualDate) {
      return Response.json(
        {
          success: false,
          message:
            "Actual session date is required.",
        },
        { status: 400 }
      );
    }

    const result =
      db.transaction(() => {
        const session =
          db.prepare(`
            SELECT
              ms.*,
              c.pim_number,
              c.current_status_id,
              s.code AS case_status_code,
              s.name AS case_status_name,
              a.mediator_id,
              m.name AS mediator_name
            FROM mediation_sessions ms
            JOIN pim_cases c
              ON c.id = ms.case_id
            JOIN status_master s
              ON s.id = c.current_status_id
            JOIN pim_mediator_assignments a
              ON a.id = ms.assignment_id
            JOIN mediators m
              ON m.id = a.mediator_id
            WHERE ms.id = ?
          `).get(sessionId);

        if (!session) {
          throw new Error(
            "Mediation session not found."
          );
        }

        if (
          session.session_status !==
          "SCHEDULED"
        ) {
          return {
            conflict: true,
            message:
              `This session has already been recorded. Current session status: ${session.session_status}`,
          };
        }

        if (
          session.case_status_code !==
            "MEDIATION_PENDING" &&
          session.case_status_code !==
            "MEDIATION_ONGOING"
        ) {
          return {
            conflict: true,
            message:
              `This case is not currently available for session recording. Current status: ${session.case_status_name}`,
          };
        }

        if (actualDate > today()) {
          throw new Error(
            "Actual session date cannot be a future date."
          );
        }

        if (
          session.scheduled_date &&
          actualDate < session.scheduled_date
        ) {
          throw new Error(
            "Actual session date cannot be earlier than the scheduled date."
          );
        }

        const bothPresent =
          applicantPresent === 1 &&
          oppositePartyPresent === 1;

        let effectiveSession = 0;
        let durationMinutes = null;
        let sessionStatus =
          "ADJOURNED";

        if (bothPresent) {
          if (
            !actualStartTime ||
            !actualEndTime
          ) {
            throw new Error(
              "Actual start time and actual end time are required when both parties are present."
            );
          }

          durationMinutes =
            calculateDuration(
              actualStartTime,
              actualEndTime
            );

          effectiveSession = 1;
          sessionStatus = "COMPLETED";
        } else {
          if (
            actualStartTime ||
            actualEndTime
          ) {
            throw new Error(
              "Actual start/end time must not be recorded for an ineffective session."
            );
          }

          effectiveSession = 0;
          durationMinutes = null;
          sessionStatus = "ADJOURNED";

          if (!nextDate) {
            throw new Error(
              "Next date is required when the session is adjourned."
            );
          }
        }

        const recordedRemarks =
          effectiveSession && !nextDate && nextAction
            ? [
                administrativeRemarks,
                `Staff assessment: ${NEXT_ACTION_LABELS[nextAction]}.`,
              ]
                .filter(Boolean)
                .join(" ")
            : administrativeRemarks;

        /*
         * Structured next-action (Phase 9) - the authoritative
         * source going forward. FURTHER_MEDIATION is derived from
         * the same structural fact the rest of this route already
         * used to decide the branch (effective + nextDate), never
         * from free text. SETTLEMENT/FAILURE come only from the
         * validated nextAction value, never parsed from remarks.
         */
        const recordedNextAction = !effectiveSession
          ? null
          : nextDate
            ? "FURTHER_MEDIATION"
            : nextAction || null;

        db.prepare(`
          UPDATE mediation_sessions
          SET
            actual_date = ?,
            applicant_present = ?,
            opposite_party_present = ?,
            effective_session = ?,
            actual_start_time = ?,
            actual_end_time = ?,
            duration_minutes = ?,
            next_date = ?,
            session_status = ?,
            next_action = ?,
            administrative_remarks = ?,
            recorded_by = ?
          WHERE id = ?
        `).run(
          actualDate,
          applicantPresent,
          oppositePartyPresent,
          effectiveSession,
          actualStartTime,
          actualEndTime,
          durationMinutes,
          nextDate,
          sessionStatus,
          recordedNextAction,
          recordedRemarks,
          user.id,
          sessionId
        );

        /*
         * COMPLETE THE TASK FOR THE SESSION JUST RECORDED.
         *
         * Match the pending SESSION_RECORD task to the
         * session's scheduled date. This prevents the old
         * task from remaining pending after the sitting is
         * actually recorded.
         */
        const currentTask =
          db.prepare(`
            SELECT id
            FROM pim_tasks
            WHERE case_id = ?
              AND task_type_code IN (
                'SESSION_RECORD',
                'FIRST_MEDIATION'
              )
              AND status = 'PENDING'
              AND due_date = ?
            ORDER BY
              CASE task_type_code
                WHEN 'SESSION_RECORD' THEN 1
                WHEN 'FIRST_MEDIATION' THEN 2
                ELSE 3
              END,
              id ASC
            LIMIT 1
          `).get(
            session.case_id,
            session.scheduled_date
          );

        let completedTaskId =
          null;

        if (currentTask) {
          completedTaskId =
            currentTask.id;

          db.prepare(`
            UPDATE pim_tasks
            SET
              status = 'COMPLETED',
              completed_date = ?,
              completed_time = ?,
              completed_by = ?,
              remarks = ?
            WHERE id = ?
          `).run(
            today(),
            currentTime(),
            user.id,
            `Mediation sitting ${session.sitting_number} recorded.`,
            currentTask.id
          );

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
            currentTask.id,
            "PENDING",
            "COMPLETED",
            user.id,
            `Mediation sitting ${session.sitting_number} recorded.`
          );
        }

        /*
         * EFFECTIVE SESSION
         *
         * MEDIATION_PENDING -> MEDIATION_ONGOING
         *
         * If the case is already MEDIATION_ONGOING,
         * do not create a duplicate status transition.
         */
        if (effectiveSession) {
          if (
            session.case_status_code !==
            "MEDIATION_ONGOING"
          ) {
            const fromStatusId =
              getStatusId(
                session.case_status_code
              );

            const toStatusId =
              getStatusId(
                "MEDIATION_ONGOING"
              );

            addStatusHistory(
              session.case_id,
              fromStatusId,
              toStatusId,
              `Effective mediation session ${session.sitting_number} recorded. Duration: ${durationMinutes} minutes.`,
              user.id
            );

            db.prepare(`
              UPDATE pim_cases
              SET
                current_status_id = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(
              toStatusId,
              session.case_id
            );
          }

          addDocket(
            session.case_id,
            `Effective mediation session ${session.sitting_number} recorded on ${actualDate}. Both parties were present. Duration: ${durationMinutes} minutes.`,
            nextDate,
            nextDate
              ? "Next mediation sitting"
              : null,
            user.id
          );
        } else {
          /*
           * INEFFECTIVE SESSION
           *
           * A recorded sitting means mediation has started.
           * Keep or move the case into MEDIATION_ONGOING
           * while the next sitting is pending.
           */
          if (
            session.case_status_code !==
            "MEDIATION_ONGOING"
          ) {
            const fromStatusId =
              getStatusId(
                session.case_status_code
              );

            const toStatusId =
              getStatusId(
                "MEDIATION_ONGOING"
              );

            addStatusHistory(
              session.case_id,
              fromStatusId,
              toStatusId,
              `Ineffective mediation sitting ${session.sitting_number} recorded; next sitting fixed.`,
              user.id
            );

            db.prepare(`
              UPDATE pim_cases
              SET
                current_status_id = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(
              toStatusId,
              session.case_id
            );
          }

          addDocket(
            session.case_id,
            `Mediation sitting ${session.sitting_number} recorded as ineffective. Applicant present: ${applicantPresent ? "Yes" : "No"}; Opposite party present: ${oppositePartyPresent ? "Yes" : "No"}.`,
            nextDate,
            "Next mediation sitting",
            user.id
          );
        }

        /*
         * CREATE THE NEXT SESSION_RECORD TASK.
         *
         * This is a NEW task for the NEW sitting date.
         * Never reuse the task that was just completed.
         */
        let nextTaskId = null;
        let nextSessionId = null;
        let nextSittingNumber = null;
        let outcomeTaskId = null;
        let finalStatusCode = "MEDIATION_ONGOING";

        if (nextDate) {
          const duplicateNextSession =
            db.prepare(`
              SELECT
                id,
                sitting_number
              FROM mediation_sessions
              WHERE case_id = ?
                AND session_status = 'SCHEDULED'
                AND scheduled_date = ?
              LIMIT 1
            `).get(
              session.case_id,
              nextDate
            );

          if (duplicateNextSession) {
            nextSessionId =
              duplicateNextSession.id;
            nextSittingNumber =
              duplicateNextSession.sitting_number;
          } else {
            nextSittingNumber =
              session.sitting_number + 1;

            /*
             * Phase 9 fix: look up the CURRENTLY active mediator
             * assignment rather than copying session.assignment_id.
             * If a reassignment happened since the session being
             * recorded was first scheduled, the next sitting must
             * be attributed to the new active mediator, not the
             * one who conducted the sitting just completed.
             */
            const activeAssignment =
              db.prepare(`
                SELECT id
                FROM pim_mediator_assignments
                WHERE case_id = ?
                  AND status = 'ACTIVE'
                ORDER BY id DESC
                LIMIT 1
              `).get(session.case_id);

            const nextAssignmentId =
              activeAssignment
                ? activeAssignment.id
                : session.assignment_id;

            const nextSession =
              db.prepare(`
                INSERT INTO mediation_sessions
                (
                  case_id,
                  assignment_id,
                  sitting_number,
                  scheduled_date,
                  actual_date,
                  applicant_present,
                  opposite_party_present,
                  effective_session,
                  actual_start_time,
                  actual_end_time,
                  duration_minutes,
                  next_date,
                  session_status,
                  administrative_remarks,
                  report_received,
                  report_date,
                  recorded_by
                )
                VALUES
                (?, ?, ?, ?, NULL, 0, 0, 0,
                 NULL, NULL, NULL, NULL,
                 'SCHEDULED', NULL, 0, NULL, ?)
              `).run(
                session.case_id,
                nextAssignmentId,
                nextSittingNumber,
                nextDate,
                user.id
              );

            nextSessionId =
              Number(
                nextSession.lastInsertRowid
              );
          }

          const duplicateNextTask =
            db.prepare(`
              SELECT id
              FROM pim_tasks
              WHERE case_id = ?
                AND task_type_code =
                  'SESSION_RECORD'
                AND status = 'PENDING'
                AND due_date = ?
              LIMIT 1
            `).get(
              session.case_id,
              nextDate
            );

          if (duplicateNextTask) {
            nextTaskId =
              duplicateNextTask.id;
          } else {
            const taskType =
              getTaskType(
                "SESSION_RECORD"
              );

            if (!taskType) {
              throw new Error(
                "Active SESSION_RECORD task type not found."
              );
            }

            const nextTask =
              db.prepare(`
                INSERT INTO pim_tasks
                (
                  case_id,
                  task_type_id,
                  task_type_code,
                  description,
                  created_date,
                  due_date,
                  priority,
                  status,
                  auto_generated,
                  remarks
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)
              `).run(
                session.case_id,
                taskType.id,
                taskType.code,
                `Record mediation sitting ${nextSittingNumber}.`,
                today(),
                nextDate,
                taskType.default_priority ||
                  "NORMAL",
                `Next mediation sitting fixed for ${nextDate}.`
              );

            nextTaskId =
              Number(
                nextTask.lastInsertRowid
              );
          }
        } else {
          const outcomeStatusId =
            getStatusId(
              "OUTCOME_FORM_PENDING"
            );

          const fromOutcomeStatusId =
            getStatusId(
              "MEDIATION_ONGOING"
            );

          addStatusHistory(
            session.case_id,
            fromOutcomeStatusId,
            outcomeStatusId,
            `Mediation concluded after sitting ${session.sitting_number}; outcome form pending.`,
            user.id
          );

          db.prepare(`
            UPDATE pim_cases
            SET
              current_status_id = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            outcomeStatusId,
            session.case_id
          );

          addDocket(
            session.case_id,
            `Mediation concluded after sitting ${session.sitting_number}.${
              nextAction
                ? ` Staff assessment: ${NEXT_ACTION_LABELS[nextAction]}.`
                : ""
            } Outcome form pending.`,
            null,
            "Outcome form",
            user.id
          );

          const duplicateOutcomeTask =
            db.prepare(`
              SELECT id
              FROM pim_tasks
              WHERE case_id = ?
                AND task_type_code =
                  'OUTCOME_FORM'
                AND status = 'PENDING'
              ORDER BY id DESC
              LIMIT 1
            `).get(session.case_id);

          if (duplicateOutcomeTask) {
            outcomeTaskId =
              duplicateOutcomeTask.id;
          } else {
            const outcomeTaskType =
              getTaskType(
                "OUTCOME_FORM"
              );

            if (!outcomeTaskType) {
              throw new Error(
                "Active OUTCOME_FORM task type not found."
              );
            }

            const outcomeTask =
              db.prepare(`
                INSERT INTO pim_tasks
                (
                  case_id,
                  task_type_id,
                  task_type_code,
                  description,
                  created_date,
                  due_date,
                  priority,
                  status,
                  auto_generated,
                  remarks
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)
              `).run(
                session.case_id,
                outcomeTaskType.id,
                outcomeTaskType.code,
                "Record mediation outcome and complete the PIM outcome form.",
                today(),
                actualDate,
                outcomeTaskType.default_priority ||
                  "NORMAL",
                `Mediation concluded after sitting ${session.sitting_number}.`
              );

            outcomeTaskId =
              Number(
                outcomeTask.lastInsertRowid
              );
          }

          finalStatusCode =
            "OUTCOME_FORM_PENDING";
        }
        return {
          sessionId,
          nextSessionId,
          caseId: session.case_id,
          sittingNumber:
            session.sitting_number,
          actualDate,
          applicantPresent:
            applicantPresent === 1,
          oppositePartyPresent:
            oppositePartyPresent === 1,
          effectiveSession:
            effectiveSession === 1,
          actualStartTime,
          actualEndTime,
          durationMinutes,
          nextDate,
          sessionStatus,
          completedTaskId,
          nextTaskId,
          outcomeTaskId,
          statusCode: finalStatusCode,
        };
      })();

    if (result.conflict) {
      return Response.json(
        {
          success: false,
          message: result.message,
        },
        { status: 409 }
      );
    }

    return Response.json({
      success: true,
      message:
        result.effectiveSession
          ? "Effective mediation session recorded successfully."
          : "Mediation sitting recorded as ineffective.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Session POST error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to record mediation session.",
      },
      { status: 400 }
    );
  }
}
