const db = require("../../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getStatusId(code) {
  const row = db
    .prepare(`
      SELECT id
      FROM status_master
      WHERE code = ?
    `)
    .get(code);

  if (!row) {
    throw new Error(`Status not found: ${code}`);
  }

  return row.id;
}

function getEventId(code) {
  const row = db
    .prepare(`
      SELECT id
      FROM event_types
      WHERE code = ?
    `)
    .get(code);

  if (!row) {
    throw new Error(`Event not found: ${code}`);
  }

  return row.id;
}

function addDocket(
  caseId,
  entryText,
  nextDate,
  enteredBy = null
) {
  const eventId =
    getEventId("MEDIATION_DATE_FIXED");

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
    "Next mediation sitting",
    nextDate,
    enteredBy
  );
}

export async function POST(
  request,
  { params }
) {
  try {
    const user = await requirePermission(request, "RECORD_MEDIATION_SESSION");

    const { id } = await params;
    const caseId = Number(id);

    if (
      !Number.isInteger(caseId) ||
      caseId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    const body =
      await request.json();

    const scheduledDate =
      body.scheduledDate
        ? String(body.scheduledDate).trim()
        : null;

    const remarks =
      body.remarks
        ? String(body.remarks).trim()
        : null;

    if (!scheduledDate) {
      return Response.json(
        {
          success: false,
          message:
            "Next mediation date is required.",
        },
        { status: 400 }
      );
    }

    const result =
      db.transaction(() => {
        const caseData =
          db.prepare(`
            SELECT
              c.*,
              s.code AS status_code,
              s.name AS status_name
            FROM pim_cases c
            JOIN status_master s
              ON s.id = c.current_status_id
            WHERE c.id = ?
          `).get(caseId);

        if (!caseData) {
          throw new Error(
            "PIM case not found."
          );
        }

        if (
          caseData.status_code !==
          "MEDIATION_ONGOING"
        ) {
          throw new Error(
            `This case is not currently available for fixing the next mediation sitting. Current status: ${caseData.status_name}`
          );
        }

        const assignment =
          db.prepare(`
            SELECT
              a.*,
              m.name AS mediator_name
            FROM pim_mediator_assignments a
            JOIN mediators m
              ON m.id = a.mediator_id
            WHERE a.case_id = ?
              AND a.status = 'ACTIVE'
            ORDER BY a.id DESC
            LIMIT 1
          `).get(caseId);

        if (!assignment) {
          throw new Error(
            "No active mediator assignment exists."
          );
        }

        const pendingSession =
          db.prepare(`
            SELECT id
            FROM mediation_sessions
            WHERE case_id = ?
              AND session_status = 'SCHEDULED'
            LIMIT 1
          `).get(caseId);

        if (pendingSession) {
          throw new Error(
            "A scheduled mediation sitting already exists for this case."
          );
        }

        const nextNumber =
          db.prepare(`
            SELECT
              COALESCE(
                MAX(sitting_number),
                0
              ) + 1 AS next_number
            FROM mediation_sessions
            WHERE case_id = ?
          `).get(caseId).next_number;

        const session =
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
             'SCHEDULED', ?, 0, NULL, ?)
          `).run(
            caseId,
            assignment.id,
            nextNumber,
            scheduledDate,
            remarks,
            user.id
          );

        const sessionId =
          Number(
            session.lastInsertRowid
          );

        addDocket(
          caseId,
          `Mediation sitting ${nextNumber} fixed for ${scheduledDate} before mediator ${assignment.mediator_name}.`,
          scheduledDate,
          user.id
        );

        /*
         * Create a SESSION_RECORD task.
         * Avoid duplicates.
         */
        const existingTask =
          db.prepare(`
            SELECT id
            FROM pim_tasks
            WHERE case_id = ?
              AND task_type_code =
                'SESSION_RECORD'
              AND status = 'PENDING'
            LIMIT 1
          `).get(caseId);

        let taskId =
          existingTask
            ? existingTask.id
            : null;

        if (!existingTask) {
          const taskType =
            db.prepare(`
              SELECT
                id,
                code,
                default_priority
              FROM task_types
              WHERE code =
                'SESSION_RECORD'
                AND active = 1
              LIMIT 1
            `).get();

          if (!taskType) {
            throw new Error(
              "Active SESSION_RECORD task type not found."
            );
          }

          const task =
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
              VALUES
              (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)
            `).run(
              caseId,
              taskType.id,
              taskType.code,
              `Record mediation sitting ${nextNumber}.`,
              today(),
              scheduledDate,
              taskType.default_priority ||
                "NORMAL",
              `Sitting ${nextNumber} fixed for ${scheduledDate}.`
            );

          taskId =
            Number(
              task.lastInsertRowid
            );
        }

        return {
          caseId,
          sessionId,
          sittingNumber:
            nextNumber,
          scheduledDate,
          taskId,
          statusCode:
            "MEDIATION_ONGOING",
        };
      })();

    return Response.json({
      success: true,
      message:
        "Next mediation sitting fixed successfully.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Next mediation error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to fix next mediation sitting.",
      },
      { status: 400 }
    );
  }
}
