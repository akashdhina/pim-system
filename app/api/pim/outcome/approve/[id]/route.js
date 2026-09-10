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

function addStatusHistory(
  caseId,
  fromStatusId,
  toStatusId,
  reason,
  userId = null
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
    userId
  );
}

function addDocket(caseId, entryText, userId = null) {
  const eventId =
    getEventId("FORM5");

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
    null,
    null,
    userId
  );
}

export async function GET(
  request,
  { params }
) {
  try {
    requirePermission(request, "READ_CASE");

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

    const data = db.prepare(`
      SELECT
        c.id AS case_id,
        c.pim_number,
        c.received_number,
        c.outcome_type AS case_outcome_type,
        c.outcome_date AS case_outcome_date,
        c.closed_at,
        s.code AS status_code,
        s.name AS status_name,

        o.id AS outcome_id,
        o.outcome_type,
        o.form_no,
        o.outcome_date,
        o.nonstarter_reason_id,
        o.reason_text,
        o.settlement_terms,
        o.prepared_by,
        o.verified_by,
        o.approved_by,
        o.document_id,
        o.sent_to_applicant,
        o.sent_to_opposite_party,
        o.remarks AS outcome_remarks

      FROM pim_cases c

      JOIN status_master s
        ON s.id = c.current_status_id

      LEFT JOIN pim_outcomes o
        ON o.case_id = c.id

      WHERE c.id = ?
    `).get(caseId);

    if (!data) {
      return Response.json(
        {
          success: false,
          message: "PIM case not found.",
        },
        { status: 404 }
      );
    }

    return Response.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(
      "Outcome approval GET error:",
      error
    );

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load outcome approval data.",
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
    const user = requirePermission(
      request,
      "APPROVE_OUTCOME"
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

    const body =
      await request.json();

    const remarks =
      body.remarks
        ? String(body.remarks).trim()
        : null;

    const result =
      db.transaction(() => {
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
          throw new Error(
            "PIM case not found."
          );
        }

        if (
          caseData.status_code !==
          "OUTCOME_FORM_PENDING"
        ) {
          return {
            conflict: true,
            message:
              `This case is not currently pending outcome approval. Current status: ${caseData.status_name}`,
          };
        }

        const outcome =
          db.prepare(`
            SELECT *
            FROM pim_outcomes
            WHERE case_id = ?
          `).get(caseId);

        if (!outcome) {
          throw new Error(
            "No mediation outcome has been recorded for this case."
          );
        }

        /*
         * NON_STARTER requires an authority
         * decision according to the configured
         * reason. Do not close it here unless
         * the required authority workflow exists.
         */
        if (
          outcome.outcome_type ===
          "NON_STARTER"
        ) {
          if (
            !outcome.nonstarter_reason_id
          ) {
            throw new Error(
              "Non-starter reason is missing."
            );
          }

          const reason =
            db.prepare(`
              SELECT
                id,
                name,
                requires_authority_decision
              FROM nonstarter_reasons
              WHERE id = ?
            `).get(
              outcome.nonstarter_reason_id
            );

          if (!reason) {
            throw new Error(
              "Configured non-starter reason was not found."
            );
          }

          if (
            reason.requires_authority_decision ===
            1
          ) {
            throw new Error(
              "This non-starter outcome requires an authority decision before closure."
            );
          }
        }

        /*
         * Phase 8 invariant: a terminal SETTLED/FAILED status
         * must never exist without its required statutory
         * document already generated. Verify a current Form IV
         * (SETTLED) or Form V (FAILED) document exists before
         * allowing closure - a failed/skipped document generation
         * must never leave the case terminal regardless.
         */
        if (
          outcome.outcome_type === "SETTLED" ||
          outcome.outcome_type === "FAILED"
        ) {
          const requiredDocumentType =
            outcome.outcome_type === "SETTLED"
              ? "FORM_4"
              : "FORM_5";

          const currentDocument =
            db.prepare(`
              SELECT id, file_path
              FROM pim_documents
              WHERE case_id = ?
                AND document_type = ?
                AND is_current = 1
              ORDER BY version_no DESC, id DESC
              LIMIT 1
            `).get(caseId, requiredDocumentType);

          if (
            !currentDocument ||
            !currentDocument.file_path
          ) {
            throw new Error(
              `${
                requiredDocumentType === "FORM_4"
                  ? "Form IV (Settlement)"
                  : "Form V (Failure Report)"
              } must be generated before this case can be closed.`
            );
          }
        }

        let finalStatusCode;

        switch (
          outcome.outcome_type
        ) {
          case "SETTLED":
            finalStatusCode =
              "CLOSED_SETTLED";
            break;

          case "FAILED":
            finalStatusCode =
              "CLOSED_FAILED";
            break;

          case "WITHDRAWN":
            finalStatusCode =
              "WITHDRAWN";
            break;

          case "NON_STARTER":
            finalStatusCode =
              "CLOSED_NON_STARTER";
            break;

          default:
            throw new Error(
              `Unsupported outcome type: ${outcome.outcome_type}`
            );
        }

        const finalStatusId =
          getStatusId(
            finalStatusCode
          );

        const currentStatusId =
          getStatusId(
            "OUTCOME_FORM_PENDING"
          );

        /*
         * Mark the outcome as verified/approved.
         */
        db.prepare(`
          UPDATE pim_outcomes
          SET
            verified_by = ?,
            approved_by = ?,
            remarks = CASE
              WHEN ? IS NULL OR ? = ''
              THEN remarks
              ELSE ?
            END
          WHERE id = ?
        `).run(
          outcome.verified_by || user.id,
          user.id,
          remarks,
          remarks,
          remarks,
          outcome.id
        );

        /*
         * Final status transition.
         */
        addStatusHistory(
          caseId,
          currentStatusId,
          finalStatusId,
          `Outcome form approved and case closed as ${outcome.outcome_type}.`,
          user.id
        );

        /*
         * Close the case.
         */
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
         * Complete any pending outcome task.
         */
        const pendingTasks =
          db.prepare(`
            SELECT id
            FROM pim_tasks
            WHERE case_id = ?
              AND status = 'PENDING'
              AND (
                task_type_code = 'OUTCOME_FORM'
                OR description LIKE '%outcome form%'
              )
          `).all(caseId);

        for (
          const task of pendingTasks
        ) {
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
            "Outcome form approved and case closed.",
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
            "Outcome form approved and case closed."
          );
        }

        /*
         * Record final docket entry.
         */
        addDocket(
          caseId,
          `PIM case closed as ${outcome.outcome_type}. Outcome form approved.`,
          user.id
        );

        return {
          caseId,
          pimNumber:
            caseData.pim_number,
          outcomeId:
            outcome.id,
          outcomeType:
            outcome.outcome_type,
          finalStatusCode,
          closedDate:
            today(),
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
        `PIM outcome approved and case closed as ${result.outcomeType}.`,
      data: result,
    });
  } catch (error) {
    console.error(
      "Outcome approval POST error:",
      error
    );

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to approve outcome.",
      },
      { status: 400 }
    );
  }
}
