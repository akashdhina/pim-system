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
const {
  issueForm2NoticePg,
} = require("../../../../../../lib/pim-data/form2");

function today() {
  return officeDate();
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
  const eventId =
    getEventId(eventCode);

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

/*
 * The ORIGINAL SQLite POST body, kept unused as an instant rollback and
 * as the authentic SQLite baseline for scripts/test-pim-form2-postgres.js.
 * Not called by POST.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function issueForm2Sqlite(caseId, { noticeId, addressId, dispatchMode, postalReceiptNo, trackingNo, remarks }, userId) {
  return db.transaction(() => {
    const caseRow = db.prepare(`
      SELECT c.*, s.code AS status_code, s.name AS status_name
      FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
      WHERE c.id = ?
    `).get(caseId);

    if (!caseRow) {
      throw new Error("PIM case not found.");
    }

    const notice = db.prepare(`
      SELECT n.*, p.name AS recipient_name, d.id AS generated_document_id, d.file_path AS generated_file_path
      FROM pim_notices n
      LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
      LEFT JOIN pim_documents d ON d.id = n.document_id AND d.case_id = n.case_id
      WHERE n.id = ? AND n.case_id = ?
    `).get(noticeId, caseId);

    if (!notice) {
      throw new Error("Form-2 notice not found.");
    }

    const isFinal = notice.notice_type === "FORM_2_FINAL";
    const pendingStatusCode = isFinal ? "FINAL_NOTICE_PENDING" : "FORM2_PENDING";
    const issuedStatusCode = isFinal ? "FINAL_NOTICE_ISSUED" : "FORM2_ISSUED";

    if (caseRow.status_code !== pendingStatusCode) {
      throw new Error(
        isFinal
          ? `This case is not available for Final Notice issue. Current status: ${caseRow.status_name}`
          : `This case is not available for Form-2 issue. Current status: ${caseRow.status_name}`
      );
    }

    if (notice.status !== "PREPARED") {
      return { conflict: true, message: `This notice cannot be issued. Current notice status: ${notice.status}` };
    }

    if (!notice.generated_document_id || !notice.generated_file_path) {
      throw new Error(
        isFinal
          ? "Generate the official Final Notice document before issuing and dispatching this notice."
          : "Generate the official Form-2 document before issuing and dispatching this notice."
      );
    }

    let resolvedAddressId;

    if (isFinal) {
      if (!notice.address_id) {
        throw new Error("This Final Notice has no address on record. Re-prepare it with a selected address.");
      }
      resolvedAddressId = notice.address_id;
    } else {
      if (!Number.isInteger(addressId) || addressId <= 0) {
        throw new Error("Service address is required.");
      }
      const address = db.prepare(`
        SELECT * FROM pim_addresses WHERE id = ? AND party_id = ? AND is_current = 1
      `).get(addressId, notice.recipient_party_id);

      if (!address) {
        throw new Error("Selected address is not a current address of the notice recipient.");
      }
      resolvedAddressId = addressId;
    }

    db.prepare(`
      UPDATE pim_notices SET status = 'DISPATCHED', dispatch_date = ?, remarks = COALESCE(?, remarks)
      WHERE id = ?
    `).run(today(), remarks, noticeId);

    const service = db.prepare(`
      INSERT INTO pim_service_attempts
        (notice_id, address_id, dispatch_mode, dispatch_date, postal_receipt_no, tracking_no, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(noticeId, resolvedAddressId, dispatchMode, today(), postalReceiptNo, trackingNo, remarks);

    const issuedStatusId = getStatusId(issuedStatusCode);
    const servicePendingStatusId = getStatusId("SERVICE_PENDING");
    const pendingStatusId = getStatusId(pendingStatusCode);

    addStatusHistory(
      caseId, pendingStatusId, issuedStatusId,
      isFinal ? "Final Notice issued/dispatched for service." : "Form-2 issued/dispatched for service.",
      userId
    );
    addStatusHistory(
      caseId, issuedStatusId, servicePendingStatusId,
      isFinal ? "Final Notice dispatch recorded; service pending." : "Form-2 dispatch recorded; service pending.",
      userId
    );

    db.prepare(`
      UPDATE pim_cases SET current_status_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(servicePendingStatusId, caseId);

    addDocket(
      caseId, isFinal ? "FINAL_NOTICE" : "FORM2_DISPATCHED",
      isFinal
        ? `Final Notice dispatched to ${notice.recipient_name || "opposite party"}.`
        : `Form-2 dispatched to ${notice.recipient_name || "opposite party"}.`,
      "Service pending", userId
    );

    const taskTypeCode = isFinal ? "FINAL_NOTICE_FOLLOWUP" : "FORM2";
    const task = db.prepare(`
      SELECT id, status FROM pim_tasks
      WHERE case_id = ? AND task_type_code = ? AND status = 'PENDING'
      ORDER BY id DESC LIMIT 1
    `).get(caseId, taskTypeCode);

    if (task) {
      db.prepare(`
        UPDATE pim_tasks SET status = 'COMPLETED', completed_date = ?, completed_time = ?, completed_by = ?
        WHERE id = ?
      `).run(today(), officeTime(), userId, task.id);

      db.prepare(`
        INSERT INTO pim_task_history (task_id, old_status, new_status, changed_by, remarks)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        task.id, task.status, "COMPLETED", userId,
        isFinal ? "Final Notice issued and dispatch recorded." : "Form-2 issued and dispatch recorded."
      );
    }

    return {
      caseId, noticeId, documentId: notice.generated_document_id,
      serviceAttemptId: service.lastInsertRowid, dispatchDate: today(), dispatchMode,
      statusCode: "SERVICE_PENDING",
    };
  })();
}

export async function POST(
  request,
  { params }
) {
  try {
    const user = requirePermission(
      request,
      "ISSUE_NOTICE"
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

    const noticeId =
      Number(body.noticeId);

    const addressId =
      Number(body.addressId);

    const dispatchMode =
      String(
        body.dispatchMode ||
          "REGISTERED_POST"
      ).trim();

    const postalReceiptNo =
      body.postalReceiptNo
        ? String(
            body.postalReceiptNo
          ).trim()
        : null;

    const trackingNo =
      body.trackingNo
        ? String(
            body.trackingNo
          ).trim()
        : null;

    const remarks =
      body.remarks
        ? String(body.remarks).trim()
        : null;

    if (
      !Number.isInteger(noticeId) ||
      noticeId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message: "Invalid notice ID.",
        },
        { status: 400 }
      );
    }

    // Batch 5I (Phase 6): migrated to PostgreSQL via lib/pim-data/form2.js.
    const result = await issueForm2NoticePg(caseId, {
      noticeId, addressId, dispatchMode, postalReceiptNo, trackingNo, remarks,
    }, user.id);

    return Response.json({
      ...(result.conflict
        ? {
            success: false,
            message: result.message,
          }
        : {
            success: true,
            message:
              "Form-2 issued and dispatch recorded successfully.",
            data: result,
          }),
    }, result.conflict ? { status: 409 } : undefined);
  } catch (error) {
    console.error(
      "Form-2 issue error:",
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
            : "Unable to issue Form-2.",
      },
      { status: 400 }
    );
  }
}
