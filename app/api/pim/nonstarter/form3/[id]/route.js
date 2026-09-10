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

function createTask(
  caseId,
  taskCode,
  description,
  dueDate,
  remarks
) {
  const taskType = db.prepare(`
    SELECT
      id,
      code,
      default_priority
    FROM task_types
    WHERE code = ?
      AND active = 1
    LIMIT 1
  `).get(taskCode);

  if (!taskType) {
    throw new Error(`Task type not found: ${taskCode}`);
  }

  const task = db.prepare(`
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
    description,
    today(),
    dueDate,
    taskType.default_priority || "NORMAL",
    remarks
  );

  return Number(task.lastInsertRowid);
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
    null,
    enteredBy
  );
}

function validateDocumentForCase(
  documentId,
  caseId
) {
  const document = db.prepare(`
    SELECT
      id,
      case_id,
      document_type,
      file_path,
      version_no,
      is_current
    FROM pim_documents
    WHERE id = ?
      AND case_id = ?
      AND document_type = 'FORM_3'
      AND is_current = 1
  `).get(
    documentId,
    caseId
  );

  if (!document) {
    throw new Error(
      "The supplied Form-3 document was not found for this PIM case."
    );
  }

  return document;
}

export async function POST(
  request,
  { params }
) {
  try {
    const user = await requirePermission(
      request,
      "COMPLETE_NONSTARTER_FORM3"
    );

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

    const suppliedDocumentId =
      body.documentId == null
        ? null
        : Number(body.documentId);

    const remarks =
      body.remarks
        ? String(body.remarks).trim()
        : null;

    /*
     * Read the case before generating/completing Form-3.
     */
    const caseData = db.prepare(`
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
      const error = new Error("PIM case not found.");
      error.status = 404;
      throw error;
    }

    if (
      caseData.status_code !==
      "OUTCOME_FORM_PENDING"
    ) {
      const error = new Error(
        `Case is not currently pending Form-3 completion. Current status: ${caseData.status_name}`
      );
      error.status = 409;
      throw error;
    }

    /*
     * Get the non-starter outcome.
     */
    const outcome = db.prepare(`
      SELECT
        o.*,
        nr.code AS reason_code,
        nr.name AS reason_name,
        nr.requires_authority_decision
      FROM pim_outcomes o
      JOIN nonstarter_reasons nr
        ON nr.id = o.nonstarter_reason_id
      WHERE o.case_id = ?
        AND o.outcome_type = 'NON_STARTER'
    `).get(caseId);

    if (!outcome) {
      const error = new Error(
        "Non-starter outcome record was not found."
      );
      error.status = 409;
      throw error;
    }

    /*
     * Find the pending Form-3 task.
     */
    const pendingTask = db.prepare(`
      SELECT
        id,
        status
      FROM pim_tasks
      WHERE case_id = ?
        AND task_type_code = 'NONSTARTER_FORM3'
        AND status = 'PENDING'
      ORDER BY id
      LIMIT 1
    `).get(caseId);

    if (!pendingTask) {
      const error = new Error(
        "Pending NONSTARTER_FORM3 task was not found."
      );
      error.status = 409;
      throw error;
    }

    /*
     * Form-3 document handling.
     *
     * If a document ID was supplied, validate and reuse it.
     * Otherwise reuse the current Form-3 document if one exists.
     * Completion is not allowed to silently generate Form-3.
     */
    let document;

    if (suppliedDocumentId !== null) {
      document = validateDocumentForCase(
        suppliedDocumentId,
        caseId
      );
    } else {
      const existingDocument = db.prepare(`
        SELECT
          id,
          case_id,
          document_type,
          file_path,
          version_no,
          is_current
        FROM pim_documents
        WHERE case_id = ?
          AND document_type = 'FORM_3'
          AND is_current = 1
        ORDER BY version_no DESC, id DESC
        LIMIT 1
      `).get(caseId);

      if (existingDocument) {
        document = validateDocumentForCase(
          existingDocument.id,
          caseId
        );
      } else {
        const error = new Error(
          "A current Form-3 document must be generated before completion."
        );
        error.status = 409;
        throw error;
      }
    }

    /*
     * Database workflow transaction.
     */
    const result = db.transaction(() => {
      if (remarks) {
        /*
         * Update document remarks if supplied.
         */
        db.prepare(`
          UPDATE pim_documents
          SET remarks = ?
          WHERE id = ?
        `).run(
          remarks,
          document.id
        );
      }

      /*
       * Attach Form-3 document to the outcome.
       */
      db.prepare(`
        UPDATE pim_outcomes
        SET
          document_id = ?,
          remarks = CASE
            WHEN ? IS NULL OR ? = ''
            THEN remarks
            ELSE ?
          END
        WHERE id = ?
      `).run(
        document.id,
        remarks,
        remarks,
        remarks,
        outcome.id
      );

      /*
       * Complete the NONSTARTER_FORM3 task.
       */
      db.prepare(`
        UPDATE pim_tasks
        SET
          status = 'COMPLETED',
          completed_date = ?,
          completed_time = time('now'),
          completed_by = ?,
          remarks = ?
        WHERE id = ?
      `).run(
        today(),
        user.id,
        "Form-3 Non-Starter Report completed.",
        pendingTask.id
      );

      /*
       * Task history.
       */
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
        pendingTask.id,
        "PENDING",
        "COMPLETED",
        user.id,
        "Form-3 Non-Starter Report completed."
      );

      /*
       * FORM3 docket event.
       */
      addDocket(
        caseId,
        "FORM3",
        `Form-3 Non-Starter Report completed for ${outcome.reason_name}.`,
        outcome.requires_authority_decision
          ? "Authority decision"
          : "Case closure",
        user.id
      );

      /*
       * Authority-required non-starter reasons.
       */
      if (
        outcome.requires_authority_decision === 1
      ) {
        const authorityPendingId =
          getStatusId(
            "AUTHORITY_DECISION_PENDING"
          );

        const currentStatusId =
          getStatusId(
            "OUTCOME_FORM_PENDING"
          );

        addStatusHistory(
          caseId,
          currentStatusId,
          authorityPendingId,
          `Form-3 completed. Authority decision required for non-starter reason ${outcome.reason_code}.`,
          user.id
        );

        db.prepare(`
          UPDATE pim_cases
          SET
            current_status_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          authorityPendingId,
          caseId
        );

        const authorityTask = db.prepare(`
          SELECT id
          FROM pim_tasks
          WHERE case_id = ?
            AND task_type_code =
              'NONSTARTER_AUTHORITY'
            AND status = 'PENDING'
          LIMIT 1
        `).get(caseId);

        const authorityTaskId =
          authorityTask?.id ||
          createTask(
            caseId,
            "NONSTARTER_AUTHORITY",
            "Authority decision for non-starter closure",
            outcome.outcome_date || today(),
            `Form-3 completed. Authority decision required for ${outcome.reason_name}.`
          );

        return {
          caseId,
          outcomeId: outcome.id,
          form3TaskId: pendingTask.id,
          documentId: document.id,
          authorityTaskId,
          statusCode:
            "AUTHORITY_DECISION_PENDING",
        };
      }

      /*
       * No authority decision required.
       * Close directly as CLOSED_NON_STARTER.
       */
      const currentStatusId =
        getStatusId(
          "OUTCOME_FORM_PENDING"
        );

      const finalStatusId =
        getStatusId(
          "CLOSED_NON_STARTER"
        );

      addStatusHistory(
        caseId,
        currentStatusId,
        finalStatusId,
        `Form-3 completed and non-starter case closed: ${outcome.reason_name}.`,
        user.id
      );

      db.prepare(`
        UPDATE pim_cases
        SET
          current_status_id = ?,
          closed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        finalStatusId,
        caseId
      );

      /*
       * Closure docket.
       */
      addDocket(
        caseId,
        "CLOSURE",
        `PIM case closed as NON_STARTER. Reason: ${outcome.reason_name}.`,
        null,
        user.id
      );

      return {
        caseId,
        outcomeId: outcome.id,
        form3TaskId: pendingTask.id,
        documentId: document.id,
        authorityTaskId: null,
        statusCode:
          "CLOSED_NON_STARTER",
      };
    })();

    return Response.json({
      success: true,
      message:
        result.statusCode ===
        "CLOSED_NON_STARTER"
          ? "Form-3 completed, document stored, and PIM case closed as Non-Starter."
          : "Form-3 completed and document stored. Authority decision is now pending.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Non-starter Form-3 POST error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to complete Form-3.",
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}
