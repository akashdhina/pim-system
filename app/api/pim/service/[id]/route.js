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
} = require("../../../../../lib/pim-time");
const {
  createNonStarterHandoff,
} = require("../../../../../lib/pim-op-response");

function today() {
  return officeDate();
}

function getStatusId(code) {
  const row = db
    .prepare(
      "SELECT id FROM status_master WHERE code = ?"
    )
    .get(code);

  if (!row) {
    throw new Error(`Status not found: ${code}`);
  }

  return row.id;
}

function getEventId(code) {
  const row = db
    .prepare(
      "SELECT id FROM event_types WHERE code = ?"
    )
    .get(code);

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

function addDocket(
  caseId,
  eventCode,
  entryText,
  actionRequired = null,
  userId = null
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
    userId
  );
}

const ALLOWED_RETURN_REASONS = [
  "ADDRESSEE_LEFT",
  "INSUFFICIENT_ADDRESS",
  "UNCLAIMED",
  "REFUSED_BY_ADDRESSEE",
  "OTHER",
];

const ADDRESS_CORRECTION_REASONS = new Set([
  "ADDRESSEE_LEFT",
  "INSUFFICIENT_ADDRESS",
]);

const FINAL_NOTICE_REASONS = new Set([
  "UNCLAIMED",
  "REFUSED_BY_ADDRESSEE",
]);

const ALLOWED_OTHER_ACTIONS = [
  "SEEK_CORRECTED_ADDRESS",
  "PROCEED_TO_FINAL_NOTICE",
];

function createPendingTaskIfNotExists(
  caseId,
  taskTypeCode,
  description,
  dueDate
) {
  const existing = db
    .prepare(`
      SELECT id
      FROM pim_tasks
      WHERE case_id = ?
        AND task_type_code = ?
        AND status = 'PENDING'
      LIMIT 1
    `)
    .get(caseId, taskTypeCode);

  if (existing) {
    return existing.id;
  }

  const taskType = db
    .prepare(
      "SELECT id, default_priority FROM task_types WHERE code = ?"
    )
    .get(taskTypeCode);

  const result = db.prepare(`
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
      auto_generated
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1)
  `).run(
    caseId,
    taskType ? taskType.id : null,
    taskTypeCode,
    description,
    today(),
    dueDate,
    taskType ? taskType.default_priority : "NORMAL"
  );

  return Number(result.lastInsertRowid);
}

function getCase(caseId) {
  return db
    .prepare(`
      SELECT
        c.*,
        s.code AS status_code,
        s.name AS status_name
      FROM pim_cases c
      LEFT JOIN status_master s
        ON s.id = c.current_status_id
      WHERE c.id = ?
    `)
    .get(caseId);
}

function getServiceAttempts(caseId) {
  return db
    .prepare(`
      SELECT
        sa.*,
        n.notice_type,
        n.form_no,
        n.notice_date,
        n.appearance_date,
        n.appearance_time,
        n.status AS notice_status,
        p.name AS recipient_name,
        a.address_type,
        a.address_line1,
        a.address_line2,
        a.village_town,
        a.district,
        a.state,
        a.pincode
      FROM pim_service_attempts sa
      JOIN pim_notices n
        ON n.id = sa.notice_id
      LEFT JOIN pim_parties p
        ON p.id = n.recipient_party_id
      LEFT JOIN pim_addresses a
        ON a.id = sa.address_id
      WHERE n.case_id = ?
      ORDER BY sa.id DESC
    `)
    .all(caseId);
}

function getNotices(caseId) {
  return db
    .prepare(`
      SELECT
        n.*,
        p.name AS recipient_name
      FROM pim_notices n
      LEFT JOIN pim_parties p
        ON p.id = n.recipient_party_id
      WHERE n.case_id = ?
      ORDER BY n.id DESC
    `)
    .all(caseId);
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

    return Response.json({
      success: true,
      data: {
        case: caseData,
        notices: getNotices(caseId),
        serviceAttempts:
          getServiceAttempts(caseId),
      },
    });
  } catch (error) {
    console.error(
      "Service GET error:",
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
            : "Unable to load service data.",
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
      "RECORD_SERVICE"
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

    const serviceAttemptId =
      Number(body.serviceAttemptId);

    const result =
      String(body.result || "").trim();

    const trackingStatus =
      body.trackingStatus
        ? String(
            body.trackingStatus
          ).trim()
        : null;

    const postalEndorsement =
      body.postalEndorsement
        ? String(
            body.postalEndorsement
          ).trim()
        : null;

    const deliveredDate =
      body.deliveredDate
        ? String(
            body.deliveredDate
          ).trim()
        : null;

    const returnedDate =
      body.returnedDate
        ? String(
            body.returnedDate
          ).trim()
        : null;

    const remarks =
      body.remarks
        ? String(body.remarks).trim()
        : null;

    const returnReason =
      body.returnReason
        ? String(body.returnReason).trim()
        : null;

    const administrativeAction =
      body.administrativeAction
        ? String(
            body.administrativeAction
          ).trim()
        : null;

    if (
      !Number.isInteger(
        serviceAttemptId
      ) ||
      serviceAttemptId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Invalid service attempt ID.",
        },
        { status: 400 }
      );
    }

    if (
      ![
        "DELIVERED",
        "RETURNED",
        "TRACKING_UPDATE",
      ].includes(result)
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Invalid service result.",
        },
        { status: 400 }
      );
    }

    if (result === "RETURNED") {
      if (
        !ALLOWED_RETURN_REASONS.includes(
          returnReason
        )
      ) {
        return Response.json(
          {
            success: false,
            message:
              "A valid return reason is required when recording a returned notice.",
          },
          { status: 400 }
        );
      }

      if (
        returnReason === "OTHER" &&
        !remarks
      ) {
        return Response.json(
          {
            success: false,
            message:
              "Remarks are required when the return reason is OTHER.",
          },
          { status: 400 }
        );
      }

      if (
        returnReason === "OTHER" &&
        !ALLOWED_OTHER_ACTIONS.includes(
          administrativeAction
        )
      ) {
        return Response.json(
          {
            success: false,
            message:
              "Select whether to seek a corrected address or proceed to the Final Notice for this OTHER return reason.",
          },
          { status: 400 }
        );
      }
    }

    const transaction =
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
          "SERVICE_PENDING"
        ) {
          return {
            conflict: true,
            message:
              `This case is not available for service tracking. Current status: ${caseData.status_name}`,
          };
        }

        const attempt =
          db.prepare(`
            SELECT
              sa.*,
              n.id AS notice_id,
              n.status AS notice_status,
              n.notice_type,
              n.recipient_party_id,
              p.name AS recipient_name
            FROM pim_service_attempts sa
            JOIN pim_notices n
              ON n.id = sa.notice_id
            LEFT JOIN pim_parties p
              ON p.id = n.recipient_party_id
            WHERE sa.id = ?
              AND n.case_id = ?
          `).get(
            serviceAttemptId,
            caseId
          );

        if (!attempt) {
          throw new Error(
            "Service attempt not found for this case."
          );
        }

        if (
          attempt.notice_status !==
          "DISPATCHED"
        ) {
          return {
            conflict: true,
            message:
              `This notice is not available for service tracking. Current notice status: ${attempt.notice_status}`,
          };
        }

        if (
          result === "DELIVERED" &&
          !deliveredDate
        ) {
          throw new Error(
            "Delivered date is required."
          );
        }

        if (
          result === "RETURNED" &&
          !returnedDate
        ) {
          throw new Error(
            "Returned date is required."
          );
        }

        /*
         * Update the existing service attempt.
         */
        db.prepare(`
          UPDATE pim_service_attempts
          SET
            tracking_status = ?,
            postal_endorsement = ?,
            return_reason = ?,
            delivered_date = ?,
            returned_date = ?,
            remarks = COALESCE(?, remarks)
          WHERE id = ?
        `).run(
          trackingStatus,
          postalEndorsement,
          result === "RETURNED"
            ? returnReason
            : null,
          deliveredDate,
          returnedDate,
          remarks,
          serviceAttemptId
        );

        /*
         * DELIVERY
         *
         * Delivery is recorded as a service fact.
         * The case remains in SERVICE_PENDING because
         * the next business step is OP response/appearance.
         */
        if (result === "DELIVERED") {
          db.prepare(`
            UPDATE pim_notices
            SET
              status = 'SERVED'
            WHERE id = ?
          `).run(
            attempt.notice_id
          );

          addDocket(
            caseId,
            "NOTICE_DELIVERED",
            `Form-2 notice delivered to ${attempt.recipient_name || "opposite party"}.`,
            "Await opposite party response / appearance",
            user.id
          );

          return {
            result,
            caseId,
            serviceAttemptId,
            noticeId:
              attempt.notice_id,
            caseStatus:
              "SERVICE_PENDING",
            noticeStatus:
              "SERVED",
          };
        }

        /*
         * RETURNED
         *
         * Do not silently treat a returned notice as
         * failed service and continue the case.
         *
         * The existing workflow has a dedicated
         * NOTICE_RETURNED stage.
         */
        if (result === "RETURNED") {
          const servicePendingStatusId =
            getStatusId(
              "SERVICE_PENDING"
            );

          const returnedStatusId =
            getStatusId(
              "NOTICE_RETURNED"
            );

          db.prepare(`
            UPDATE pim_notices
            SET
              status = 'RETURNED'
            WHERE id = ?
          `).run(
            attempt.notice_id
          );

          addStatusHistory(
            caseId,
            servicePendingStatusId,
            returnedStatusId,
            "Form-2 notice returned after service attempt.",
            user.id
          );

          addDocket(
            caseId,
            "NOTICE_RETURNED",
            `Form-2 notice returned for ${attempt.recipient_name || "opposite party"} (${returnReason}).`,
            "Address / service correction",
            user.id
          );

          /*
           * A returned FINAL notice is never routed back into
           * address correction / a fresh Final Notice - this IS
           * already the Final Notice. Preserve the exact postal
           * return_reason as the service fact (already persisted
           * above) and hand off to the centralized Non-Starter
           * workflow (Phase 5) instead. Case status is left
           * unchanged; the pending NONSTARTER_FORM3 task is the
           * next-action signal.
           */
          if (attempt.notice_type === "FORM_2_FINAL") {
            createNonStarterHandoff(
              caseId,
              attempt.recipient_name,
              `Final Notice returned (${returnReason}); remained unacknowledged.`,
              user.id
            );

            return {
              result,
              caseId,
              serviceAttemptId,
              noticeId:
                attempt.notice_id,
              returnReason,
              caseStatus:
                "SERVICE_PENDING",
              noticeStatus:
                "RETURNED",
            };
          }

          /*
           * Postal refusal of delivery (REFUSED_BY_ADDRESSEE) is a
           * service fact about this notice. It is never treated as
           * OP_REFUSED, which means the opposite party itself
           * refused to participate in mediation - a separate,
           * later workflow owned by the OP-response stage.
           */
          const seekCorrectedAddress =
            ADDRESS_CORRECTION_REASONS.has(
              returnReason
            ) ||
            (returnReason === "OTHER" &&
              administrativeAction ===
                "SEEK_CORRECTED_ADDRESS");

          const proceedToFinalNotice =
            FINAL_NOTICE_REASONS.has(
              returnReason
            ) ||
            (returnReason === "OTHER" &&
              administrativeAction ===
                "PROCEED_TO_FINAL_NOTICE");

          if (seekCorrectedAddress) {
            const addressCorrectionStatusId =
              getStatusId(
                "ADDRESS_CORRECTION_PENDING"
              );

            addStatusHistory(
              caseId,
              returnedStatusId,
              addressCorrectionStatusId,
              `Corrected address required (${returnReason}).`,
              user.id
            );

            db.prepare(`
              UPDATE pim_cases
              SET
                current_status_id = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(
              addressCorrectionStatusId,
              caseId
            );

            createPendingTaskIfNotExists(
              caseId,
              "ADDRESS_CORRECTION",
              `Obtain corrected address for ${attempt.recipient_name || "opposite party"}.`,
              today()
            );

            addDocket(
              caseId,
              "ADDRESS_REQUESTED",
              `Corrected address requested for ${attempt.recipient_name || "opposite party"}.`,
              "Obtain corrected address",
              user.id
            );

            return {
              result,
              caseId,
              serviceAttemptId,
              noticeId:
                attempt.notice_id,
              returnReason,
              caseStatus:
                "ADDRESS_CORRECTION_PENDING",
              noticeStatus:
                "RETURNED",
            };
          }

          if (proceedToFinalNotice) {
            const finalNoticeStatusId =
              getStatusId(
                "FINAL_NOTICE_PENDING"
              );

            addStatusHistory(
              caseId,
              returnedStatusId,
              finalNoticeStatusId,
              `Routed to Final Notice follow-up (${returnReason}).`,
              user.id
            );

            db.prepare(`
              UPDATE pim_cases
              SET
                current_status_id = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(
              finalNoticeStatusId,
              caseId
            );

            createPendingTaskIfNotExists(
              caseId,
              "FINAL_NOTICE_FOLLOWUP",
              `Final Notice follow-up for ${attempt.recipient_name || "opposite party"}.`,
              today()
            );

            return {
              result,
              caseId,
              serviceAttemptId,
              noticeId:
                attempt.notice_id,
              returnReason,
              caseStatus:
                "FINAL_NOTICE_PENDING",
              noticeStatus:
                "RETURNED",
            };
          }

          /*
           * Should not happen given the validation above, but
           * never silently leave the case in a status that has
           * no corresponding pending task.
           */
          throw new Error(
            "Unable to determine the administrative branch for this returned notice."
          );
        }

        /*
         * TRACKING UPDATE
         *
         * No workflow status change.
         */
        return {
          result,
          caseId,
          serviceAttemptId,
          noticeId:
            attempt.notice_id,
          caseStatus:
            "SERVICE_PENDING",
          noticeStatus:
            "DISPATCHED",
        };
      })();

    if (transaction.conflict) {
      return Response.json(
        {
          success: false,
          message: transaction.message,
        },
        { status: 409 }
      );
    }

    return Response.json({
      success: true,
      message:
        result === "DELIVERED"
          ? "Service delivery recorded successfully."
          : result === "RETURNED"
            ? "Notice return recorded successfully."
            : "Tracking update recorded successfully.",
      data: transaction,
    });
  } catch (error) {
    console.error(
      "Service POST error:",
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
            : "Unable to update service.",
      },
      { status: 400 }
    );
  }
}
