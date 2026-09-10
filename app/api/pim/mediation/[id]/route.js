const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");

function today() {
  return new Date().toISOString().slice(0, 10);
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

function getActiveAssignment(caseId) {
  return db.prepare(`
    SELECT
      a.*,
      m.name AS mediator_name,
      m.category AS mediator_category,
      m.enrollment_no,
      m.contact_phone,
      m.email
    FROM pim_mediator_assignments a
    JOIN mediators m
      ON m.id = a.mediator_id
    WHERE a.case_id = ?
      AND a.status = 'ACTIVE'
    ORDER BY a.id DESC
    LIMIT 1
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
  eventCode,
  entryText,
  nextDate = null,
  actionRequired = null,
  enteredBy = null
) {
  const eventId = getEventId(eventCode);

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

function calculateFirstSittingNumber(caseId) {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sitting_number), 0) AS max_number
    FROM mediation_sessions
    WHERE case_id = ?
  `).get(caseId);

  return Number(row.max_number) + 1;
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

    const caseData = getCase(caseId);

    if (!caseData) {
      return Response.json(
        {
          success: false,
          message: "PIM case not found.",
        },
        { status: 404 }
      );
    }

    const assignment =
      getActiveAssignment(caseId);

    const sessions = db.prepare(`
      SELECT
        ms.*,
        m.name AS mediator_name
      FROM mediation_sessions ms
      JOIN pim_mediator_assignments a
        ON a.id = ms.assignment_id
      JOIN mediators m
        ON m.id = a.mediator_id
      WHERE ms.case_id = ?
      ORDER BY ms.sitting_number
    `).all(caseId);

    const pendingTask = db.prepare(`
      SELECT *
      FROM pim_tasks
      WHERE case_id = ?
        AND task_type_code IN (
          'FIRST_MEDIATION',
          'SESSION_RECORD',
          'OUTCOME_FORM'
        )
        AND status = 'PENDING'
      ORDER BY due_date ASC, id ASC
      LIMIT 1
    `).get(caseId);

    const outcome = db.prepare(`
      SELECT *
      FROM pim_outcomes
      WHERE case_id = ?
    `).get(caseId);

    /*
     * Cumulative duration across every EFFECTIVE sitting (both
     * parties present) for this case - an adjourned/ineffective
     * sitting never contributes minutes. This is display/derived
     * data only; Phase 7 does not act on it (no auto-failure).
     */
    const cumulativeDurationMinutes = sessions.reduce(
      (total, session) =>
        session.effective_session &&
        Number.isFinite(session.duration_minutes)
          ? total + Number(session.duration_minutes)
          : total,
      0
    );

    return Response.json({
      success: true,
      data: {
        case: caseData,
        assignment: assignment || null,
        sessions,
        cumulativeDurationMinutes,
        pendingTask: pendingTask || null,
        outcome: outcome || null,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Mediation GET error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load mediation data.",
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

    const body = await request.json();

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
            "First mediation date is required.",
        },
        { status: 400 }
      );
    }

    const result = db.transaction(() => {
      const caseData = getCase(caseId);

      if (!caseData) {
        throw new Error(
          "PIM case not found."
        );
      }

      if (
        caseData.status_code !==
        "MEDIATOR_ASSIGNED"
      ) {
        throw new Error(
          `This case is not currently available for fixing the first mediation date. Current status: ${caseData.status_name}`
        );
      }

      const assignment =
        getActiveAssignment(caseId);

      if (!assignment) {
        throw new Error(
          "No active mediator assignment exists for this case."
        );
      }

      /*
       * Do not allow duplicate first mediation
       * scheduling.
       */
      const existingSession =
        db.prepare(`
          SELECT id
          FROM mediation_sessions
          WHERE case_id = ?
          ORDER BY id
          LIMIT 1
        `).get(caseId);

      if (existingSession) {
        throw new Error(
          "A mediation session has already been created for this case."
        );
      }

      const sittingNumber =
        calculateFirstSittingNumber(caseId);

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
          VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
          caseId,
          assignment.id,
          sittingNumber,
          scheduledDate,
          null,
          null,
          null,
          null,
          null,
          "SCHEDULED",
          remarks,
          null,
          user.id
        );

      const sessionId =
        Number(session.lastInsertRowid);

      /*
       * Store the first mediation date
       * against the mediator assignment too.
       */
      db.prepare(`
        UPDATE pim_mediator_assignments
        SET
          first_mediation_date = ?,
          remarks = CASE
            WHEN ? IS NULL OR ? = ''
            THEN remarks
            ELSE ?
          END
        WHERE id = ?
      `).run(
        scheduledDate,
        remarks,
        remarks,
        remarks,
        assignment.id
      );

      const fromStatusId =
        getStatusId(
          "MEDIATOR_ASSIGNED"
        );

      const toStatusId =
        getStatusId(
          "MEDIATION_PENDING"
        );

      addStatusHistory(
        caseId,
        fromStatusId,
        toStatusId,
        `First mediation fixed for ${scheduledDate}.`,
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
        caseId
      );

      addDocket(
        caseId,
        "MEDIATION_DATE_FIXED",
        `First mediation date fixed for ${scheduledDate} before mediator ${assignment.mediator_name}.`,
        scheduledDate,
        "First mediation",
        user.id
      );

      /*
       * Complete FIRST_MEDIATION task.
       */
      const task = db.prepare(`
        SELECT id
        FROM pim_tasks
        WHERE case_id = ?
          AND task_type_code = 'FIRST_MEDIATION'
          AND status = 'PENDING'
        ORDER BY id DESC
        LIMIT 1
      `).get(caseId);

      if (task) {
        const completedTime =
          new Date()
            .toISOString()
            .slice(11, 19);

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
          completedTime,
          user.id,
          `First mediation fixed for ${scheduledDate}.`,
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
          `First mediation fixed for ${scheduledDate}.`
        );
      }

      return {
        caseId,
        sessionId,
        assignmentId: assignment.id,
        mediatorId: assignment.mediator_id,
        mediatorName: assignment.mediator_name,
        sittingNumber,
        scheduledDate,
        statusCode:
          "MEDIATION_PENDING",
      };
    })();

    return Response.json({
      success: true,
      message:
        "First mediation date fixed successfully. Mediation is now pending.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Mediation POST error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to fix first mediation date.",
      },
      { status: 400 }
    );
  }
}
