/* eslint-disable @typescript-eslint/no-require-imports */

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
      AND active = 1
  `).get(code);

  if (!row) {
    throw new Error(`Event not found: ${code}`);
  }

  return row.id;
}

function addDocket(caseId, eventCode, entryText, enteredBy) {
  db.prepare(`
    INSERT INTO pim_docket (
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
    getEventId(eventCode),
    entryText,
    null,
    null,
    enteredBy
  );
}

function addStatusHistory(caseId, fromStatusId, toStatusId, reason, changedBy) {
  db.prepare(`
    INSERT INTO pim_status_history (
      case_id,
      from_status_id,
      to_status_id,
      reason,
      changed_by
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(caseId, fromStatusId, toStatusId, reason, changedBy);
}

export async function POST(request, { params }) {
  try {
    const user = requirePermission(
      request,
      "APPROVE_NONSTARTER_AUTHORITY"
    );
    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    const body = await request.json();
    const remarks = body.remarks ? String(body.remarks).trim() : null;

    const result = db.transaction(() => {
      const caseData = db.prepare(`
        SELECT
          c.id,
          c.current_status_id,
          c.pim_number,
          s.code AS status_code,
          s.name AS status_name
        FROM pim_cases c
        JOIN status_master s ON s.id = c.current_status_id
        WHERE c.id = ?
      `).get(caseId);

      if (!caseData) {
        const error = new Error("PIM case not found.");
        error.status = 404;
        throw error;
      }

      if (caseData.status_code !== "AUTHORITY_DECISION_PENDING") {
        const error = new Error(
          `Case is not pending authority decision. Current status: ${caseData.status_name}`
        );
        error.status = 409;
        throw error;
      }

      const outcome = db.prepare(`
        SELECT
          o.*,
          nr.code AS reason_code,
          nr.name AS reason_name,
          nr.requires_authority_decision
        FROM pim_outcomes o
        JOIN nonstarter_reasons nr ON nr.id = o.nonstarter_reason_id
        WHERE o.case_id = ?
          AND o.outcome_type = 'NON_STARTER'
      `).get(caseId);

      if (!outcome) {
        const error = new Error("Non-starter outcome was not found.");
        error.status = 409;
        throw error;
      }

      if (outcome.approved_by) {
        const error = new Error("Authority decision has already been recorded.");
        error.status = 409;
        throw error;
      }

      if (outcome.requires_authority_decision !== 1) {
        const error = new Error(
          "This non-starter reason does not require authority decision."
        );
        error.status = 409;
        throw error;
      }

      if (!outcome.document_id) {
        const error = new Error("Form-3 document must be completed first.");
        error.status = 409;
        throw error;
      }

      const document = db.prepare(`
        SELECT id
        FROM pim_documents
        WHERE id = ?
          AND case_id = ?
          AND document_type = 'FORM_3'
          AND is_current = 1
      `).get(outcome.document_id, caseId);

      if (!document) {
        const error = new Error("Current Form-3 document was not found.");
        error.status = 409;
        throw error;
      }

      const authorityTask = db.prepare(`
        SELECT id
        FROM pim_tasks
        WHERE case_id = ?
          AND task_type_code = 'NONSTARTER_AUTHORITY'
          AND status = 'PENDING'
        ORDER BY id
        LIMIT 1
      `).get(caseId);

      if (!authorityTask) {
        const error = new Error("Pending NONSTARTER_AUTHORITY task was not found.");
        error.status = 409;
        throw error;
      }

      db.prepare(`
        UPDATE pim_tasks
        SET status = 'COMPLETED',
            completed_date = ?,
            completed_time = time('now'),
            completed_by = ?,
            remarks = ?
        WHERE id = ?
      `).run(
        today(),
        user.id,
        remarks || "Authority decision recorded.",
        authorityTask.id
      );

      db.prepare(`
        INSERT INTO pim_task_history (
          task_id,
          old_status,
          new_status,
          changed_by,
          remarks
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(
        authorityTask.id,
        "PENDING",
        "COMPLETED",
        user.id,
        remarks || "Authority decision recorded."
      );

      db.prepare(`
        UPDATE pim_outcomes
        SET approved_by = ?,
            remarks = CASE
              WHEN ? IS NULL OR ? = ''
              THEN remarks
              ELSE ?
            END
        WHERE id = ?
      `).run(user.id, remarks, remarks, remarks, outcome.id);

      const closedStatusId = getStatusId("CLOSED_NON_STARTER");

      addStatusHistory(
        caseId,
        caseData.current_status_id,
        closedStatusId,
        remarks || `Authority approved non-starter closure: ${outcome.reason_code}.`,
        user.id
      );

      db.prepare(`
        UPDATE pim_cases
        SET current_status_id = ?,
            closed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(closedStatusId, caseId);

      addDocket(
        caseId,
        "AUTHORITY_DECISION",
        remarks || `Authority decision recorded for non-starter reason: ${outcome.reason_name}.`,
        user.id
      );

      addDocket(
        caseId,
        "CLOSURE",
        `PIM case closed as NON_STARTER after authority decision. Reason: ${outcome.reason_name}.`,
        user.id
      );

      return {
        caseId,
        outcomeId: outcome.id,
        authorityTaskId: authorityTask.id,
        documentId: outcome.document_id,
        statusCode: "CLOSED_NON_STARTER",
      };
    })();

    return Response.json({
      success: true,
      message: "Authority decision recorded and case closed as Non-Starter.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Non-starter authority POST error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to record authority decision.",
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}
