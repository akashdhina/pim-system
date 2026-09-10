/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  officeDate,
  officeTime,
} = require("../../../../../lib/pim-time");

function today() {
  return officeDate();
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

function getCase(caseId) {
  return db.prepare(`
    SELECT
      c.*,
      s.code AS status_code,
      s.name AS status_name
    FROM pim_cases c
    JOIN status_master s
      ON s.id = c.current_status_id
    WHERE c.id = ?
  `).get(caseId);
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
  enteredBy = null
) {
  const eventId =
    getEventId("MEDIATOR_ASSIGNED");

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
    "First mediation",
    null,
    enteredBy
  );
}

export async function GET(
  request,
  { params }
) {
  try {
    await requirePermission(request, "READ_CASE");

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

    const caseData =
      getCase(caseId);

    if (!caseData) {
      return Response.json(
        {
          success: false,
          message: "PIM case not found.",
        },
        { status: 404 }
      );
    }

    const mediators =
      db.prepare(`
        SELECT
          id,
          name,
          category,
          enrollment_no,
          contact_phone,
          email,
          empanelment_order_no,
          empanelment_date,
          panel_valid_until,
          active,
          rotation_order,
          conflict_declaration_date,
          remarks
        FROM mediators
        WHERE active = 1
          AND (
            panel_valid_until IS NULL
            OR panel_valid_until >= ?
          )
        ORDER BY
          CASE
            WHEN rotation_order IS NULL
            THEN 999999
            ELSE rotation_order
          END,
          id
      `).all(today());

    const assignments =
      db.prepare(`
        SELECT
          a.*,
          m.name AS mediator_name,
          m.category AS mediator_category,
          m.enrollment_no
        FROM pim_mediator_assignments a
        JOIN mediators m
          ON m.id = a.mediator_id
        WHERE a.case_id = ?
        ORDER BY a.id DESC
      `).all(caseId);

    const pendingTask =
      db.prepare(`
        SELECT *
        FROM pim_tasks
        WHERE case_id = ?
          AND task_type_code IN (
            'MEDIATOR_ASSIGNMENT',
            'FIRST_MEDIATION'
          )
          AND status = 'PENDING'
        ORDER BY
          CASE task_type_code
            WHEN 'FIRST_MEDIATION' THEN 1
            WHEN 'MEDIATOR_ASSIGNMENT' THEN 2
            ELSE 3
          END,
          id DESC
        LIMIT 1
      `).get(caseId);

    return Response.json({
      success: true,
      data: {
        case: caseData,
        mediators,
        assignments,
        pendingTask: pendingTask || null,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Mediator GET error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load mediator assignment data.",
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
    const user = await requirePermission(request, "ASSIGN_MEDIATOR");

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

    const mediatorId =
      Number(body.mediatorId);

    const assignmentOrderNo =
      body.assignmentOrderNo
        ? String(
            body.assignmentOrderNo
          ).trim()
        : null;

    const firstMediationDate =
      body.firstMediationDate
        ? String(
            body.firstMediationDate
          ).trim()
        : null;

    const deviationFromRotation =
      body.deviationFromRotation
        ? 1
        : 0;

    const deviationReason =
      body.deviationReason
        ? String(
            body.deviationReason
          ).trim()
        : null;

    const remarks =
      body.remarks
        ? String(body.remarks).trim()
        : null;

    if (
      !Number.isInteger(
        mediatorId
      ) ||
      mediatorId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message:
            "A valid mediator must be selected.",
        },
        { status: 400 }
      );
    }

    if (
      deviationFromRotation &&
      !deviationReason
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Deviation reason is required when rotation is overridden.",
        },
        { status: 400 }
      );
    }

    const result =
      db.transaction(() => {
        const caseData =
          getCase(caseId);

        if (!caseData) {
          throw new Error(
            "PIM case not found."
          );
        }

        if (
          caseData.status_code !==
          "MEDIATOR_ASSIGNMENT_PENDING"
        ) {
          throw new Error(
            `This case is not currently available for mediator assignment. Current status: ${caseData.status_name}`
          );
        }

        const mediator =
          db.prepare(`
            SELECT *
            FROM mediators
            WHERE id = ?
          `).get(mediatorId);

        if (!mediator) {
          throw new Error(
            "Selected mediator does not exist."
          );
        }

        if (mediator.active !== 1) {
          throw new Error(
            "Inactive mediators cannot be newly assigned."
          );
        }

        if (
          mediator.panel_valid_until &&
          mediator.panel_valid_until < today()
        ) {
          throw new Error(
            "Mediator panel validity has expired; assignment is blocked."
          );
        }

        /*
         * Prevent two active mediator assignments
         * for the same case.
         */
        const activeAssignment =
          db.prepare(`
            SELECT id
            FROM pim_mediator_assignments
            WHERE case_id = ?
              AND status = 'ACTIVE'
            LIMIT 1
          `).get(caseId);

        if (activeAssignment) {
          throw new Error(
            "An active mediator is already assigned to this case."
          );
        }

        const assignment =
          db.prepare(`
            INSERT INTO pim_mediator_assignments
            (
              case_id,
              mediator_id,
              assignment_date,
              assignment_order_no,
              first_mediation_date,
              appointed_by,
              rotation_suggestion_no,
              deviation_from_rotation,
              deviation_reason,
              status,
              remarks
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
          `).run(
            caseId,
            mediatorId,
            today(),
            assignmentOrderNo,
            firstMediationDate,
            null,
            mediator.rotation_order,
            deviationFromRotation,
            deviationReason,
            remarks
          );

        const assignmentId =
          Number(
            assignment.lastInsertRowid
          );

        const fromStatusId =
          getStatusId(
            "MEDIATOR_ASSIGNMENT_PENDING"
          );

        const assignedStatusId =
          getStatusId(
            "MEDIATOR_ASSIGNED"
          );

        /*
         * MEDIATOR_ASSIGNMENT_PENDING → MEDIATOR_ASSIGNED (durable)
         *
         * Phase 7 audit correction: an earlier change briefly
         * auto-advanced this all the way to MEDIATION_PENDING in
         * the same request. That broke the existing, working
         * "fix first mediation date" step (app/api/pim/mediation/
         * [id]/route.js), which requires the case to actually be
         * sitting at MEDIATOR_ASSIGNED, creates the first
         * mediation_sessions row, completes FIRST_MEDIATION, and
         * only then moves the case on to MEDIATION_PENDING. That
         * pre-existing route is the real MEDIATOR_ASSIGNED →
         * MEDIATION_PENDING transition; this route must not
         * shortcut past it.
         */
        addStatusHistory(
          caseId,
          fromStatusId,
          assignedStatusId,
          `Mediator ${mediator.name} assigned.`,
          user.id
        );

        db.prepare(`
          UPDATE pim_cases
          SET
            current_status_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          assignedStatusId,
          caseId
        );

        addDocket(
          caseId,
          `Mediator ${mediator.name} assigned to PIM case ${caseData.pim_number}.`,
          user.id
        );

        /*
         * Complete the pending mediator-assignment task.
         */
        const task =
          db.prepare(`
            SELECT id
            FROM pim_tasks
            WHERE case_id = ?
              AND task_type_code =
                'MEDIATOR_ASSIGNMENT'
              AND status = 'PENDING'
            ORDER BY id DESC
            LIMIT 1
          `).get(caseId);

        if (task) {
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
            officeTime(),
            user.id,
            `Mediator ${mediator.name} assigned.`,
            task.id
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
            task.id,
            "PENDING",
            "COMPLETED",
            user.id,
            `Mediator ${mediator.name} assigned.`
          );
        }

        /*
         * Create first mediation task.
         */
        let firstMediationTaskId =
          null;

        const existingFirstTask =
          db.prepare(`
            SELECT id
            FROM pim_tasks
            WHERE case_id = ?
              AND task_type_code =
                'FIRST_MEDIATION'
              AND status = 'PENDING'
            LIMIT 1
          `).get(caseId);

        if (existingFirstTask) {
          firstMediationTaskId =
            existingFirstTask.id;
        } else {
          const taskType =
            db.prepare(`
              SELECT
                id,
                code,
                default_priority
              FROM task_types
              WHERE code =
                'FIRST_MEDIATION'
                AND active = 1
              LIMIT 1
            `).get();

          if (!taskType) {
            throw new Error(
              "Active FIRST_MEDIATION task type not found."
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
              VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)
            `).run(
              caseId,
              taskType.id,
              taskType.code,
              "Fix and conduct the first mediation session.",
              today(),
              firstMediationDate ||
                today(),
              taskType.default_priority ||
                "NORMAL",
              "Automatically generated after mediator assignment."
            );

          firstMediationTaskId =
            Number(
              task.lastInsertRowid
            );
        }

        return {
          caseId,
          assignmentId,
          mediatorId,
          mediatorName:
            mediator.name,
          firstMediationTaskId,
          statusCode:
            "MEDIATOR_ASSIGNED",
        };
      })();

    return Response.json({
      success: true,
      message:
        "Mediator assigned successfully. Fix the first mediation date to proceed.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Mediator POST error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to assign mediator.",
      },
      { status: 400 }
    );
  }
}

