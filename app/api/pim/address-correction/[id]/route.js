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
  createFreshInitialNotice,
} = require("../../../../../lib/pim-fresh-notice");

function today() {
  return officeDate();
}

function getStatusId(code) {
  const row = db
    .prepare("SELECT id FROM status_master WHERE code = ?")
    .get(code);

  if (!row) {
    throw new Error(`Status not found: ${code}`);
  }

  return row.id;
}

/*
 * NO_CORRECTED_ADDRESS has no existing seeded docket event -
 * the seeded set (ADDRESS_REQUESTED, CORRECTED_ADDRESS_RECEIVED,
 * FRESH_FORM2, FINAL_NOTICE, ...) covers every other Phase 2
 * transition. This additive, idempotent insert is master data,
 * not a schema change.
 */
function ensureNoCorrectedAddressEventType() {
  db.prepare(`
    INSERT OR IGNORE INTO event_types (code, name, category)
    VALUES ('NO_CORRECTED_ADDRESS', 'No Corrected Address Available', 'NOTICE')
  `).run();
}

function getEventId(code) {
  const row = db
    .prepare("SELECT id FROM event_types WHERE code = ?")
    .get(code);

  if (!row) {
    throw new Error(`Event not found: ${code}`);
  }

  return row.id;
}

function addStatusHistory(caseId, fromStatusId, toStatusId, reason, userId) {
  db.prepare(`
    INSERT INTO pim_status_history
    (case_id, from_status_id, to_status_id, reason, changed_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(caseId, fromStatusId, toStatusId, reason, userId);
}

function addDocket(caseId, eventCode, entryText, actionRequired, userId) {
  const eventId = getEventId(eventCode);

  db.prepare(`
    INSERT INTO pim_docket
    (case_id, docket_date, event_type_id, entry_text, action_required, next_date, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(caseId, today(), eventId, entryText, actionRequired, null, userId);
}

function getPendingAddressCorrectionTask(caseId) {
  return db
    .prepare(`
      SELECT id, status
      FROM pim_tasks
      WHERE case_id = ?
        AND task_type_code = 'ADDRESS_CORRECTION'
        AND status = 'PENDING'
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(caseId);
}

function completeTask(task, userId, remarks) {
  db.prepare(`
    UPDATE pim_tasks
    SET
      status = 'COMPLETED',
      completed_date = ?,
      completed_time = ?,
      completed_by = ?
    WHERE id = ?
  `).run(today(), new Date().toISOString().slice(11, 19), userId, task.id);

  db.prepare(`
    INSERT INTO pim_task_history
    (task_id, old_status, new_status, changed_by, remarks)
    VALUES (?, ?, 'COMPLETED', ?, ?)
  `).run(task.id, task.status, userId, remarks);
}

function createPendingTaskIfNotExists(caseId, taskTypeCode, description, dueDate) {
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

  if (existing) return existing.id;

  const taskType = db
    .prepare("SELECT id, default_priority FROM task_types WHERE code = ?")
    .get(taskTypeCode);

  const result = db.prepare(`
    INSERT INTO pim_tasks
    (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
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
      SELECT c.*, s.code AS status_code, s.name AS status_name
      FROM pim_cases c
      LEFT JOIN status_master s ON s.id = c.current_status_id
      WHERE c.id = ?
    `)
    .get(caseId);
}

/*
 * Candidate returned notices for this case that have not yet
 * been resolved by a corrected-address/no-address decision.
 *
 * A returned notice is considered resolved once a later
 * FORM_2_INITIAL notice exists for the same recipient party
 * (the fresh notice created by CORRECTED_ADDRESS_RECEIVED), or
 * once the case has moved past ADDRESS_CORRECTION_PENDING.
 *
 * Multi-OP safety: this never silently picks "the latest"
 * notice when more than one candidate remains - callers of the
 * mutating endpoint below must pass an explicit serviceAttemptId.
 */
function getCandidateServiceAttempts(caseId) {
  return db
    .prepare(`
      SELECT
        sa.id AS service_attempt_id,
        sa.return_reason,
        sa.postal_endorsement,
        sa.returned_date,
        sa.remarks AS service_remarks,
        n.id AS notice_id,
        n.notice_type,
        n.notice_date,
        n.recipient_party_id,
        n.address_id AS notice_address_id,
        p.name AS recipient_name
      FROM pim_service_attempts sa
      JOIN pim_notices n ON n.id = sa.notice_id
      LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
      WHERE n.case_id = ?
        AND n.status = 'RETURNED'
        AND NOT EXISTS (
          SELECT 1
          FROM pim_notices fresh
          WHERE fresh.case_id = n.case_id
            AND fresh.recipient_party_id = n.recipient_party_id
            AND fresh.notice_type = 'FORM_2_INITIAL'
            AND fresh.id > n.id
        )
      ORDER BY sa.id DESC
    `)
    .all(caseId);
}

function getRecipientAddresses(partyId) {
  return db
    .prepare(`
      SELECT *
      FROM pim_addresses
      WHERE party_id = ?
      ORDER BY is_current DESC, id DESC
    `)
    .all(partyId);
}

export async function GET(request, { params }) {
  try {
    requirePermission(request, "READ_CASE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json(
        { success: false, message: "Invalid case ID." },
        { status: 400 }
      );
    }

    const caseData = getCase(caseId);

    if (!caseData) {
      return Response.json(
        { success: false, message: "PIM case not found." },
        { status: 404 }
      );
    }

    const candidates = getCandidateServiceAttempts(caseId);

    const candidatesWithAddresses = candidates.map((candidate) => ({
      ...candidate,
      recipientAddresses: getRecipientAddresses(
        candidate.recipient_party_id
      ),
    }));

    return Response.json({
      success: true,
      data: {
        case: caseData,
        candidates: candidatesWithAddresses,
      },
    });
  } catch (error) {
    console.error("Address correction GET error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load address correction data.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "RECORD_SERVICE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json(
        { success: false, message: "Invalid case ID." },
        { status: 400 }
      );
    }

    const body = await request.json();

    const serviceAttemptId = Number(body.serviceAttemptId);
    const decision = String(body.decision || "").trim();

    if (!Number.isInteger(serviceAttemptId) || serviceAttemptId <= 0) {
      return Response.json(
        {
          success: false,
          message:
            "A specific service attempt must be identified for this address-correction action.",
        },
        { status: 400 }
      );
    }

    if (
      !["CORRECTED_ADDRESS_RECEIVED", "NO_CORRECTED_ADDRESS"].includes(
        decision
      )
    ) {
      return Response.json(
        { success: false, message: "Invalid address-correction decision." },
        { status: 400 }
      );
    }

    if (decision === "CORRECTED_ADDRESS_RECEIVED") {
      ensureNoCorrectedAddressEventType();
      return handleCorrectedAddressReceived(request, user, caseId, serviceAttemptId, body);
    }

    ensureNoCorrectedAddressEventType();
    return handleNoCorrectedAddress(user, caseId, serviceAttemptId, body);
  } catch (error) {
    console.error("Address correction POST error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to process address correction.",
      },
      { status: 400 }
    );
  }
}

function loadAttemptForCorrection(caseId, serviceAttemptId) {
  return db
    .prepare(`
      SELECT
        sa.id AS service_attempt_id,
        n.id AS notice_id,
        n.case_id,
        n.status AS notice_status,
        n.recipient_party_id,
        p.name AS recipient_name
      FROM pim_service_attempts sa
      JOIN pim_notices n ON n.id = sa.notice_id
      LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
      WHERE sa.id = ?
        AND n.case_id = ?
    `)
    .get(serviceAttemptId, caseId);
}

function handleCorrectedAddressReceived(request, user, caseId, serviceAttemptId, body) {
  const partyId = Number(body.partyId);

  const addressLine1 = String(body.addressLine1 || "").trim();
  const addressLine2 = body.addressLine2 ? String(body.addressLine2).trim() : null;
  const villageTown = body.villageTown ? String(body.villageTown).trim() : null;
  const district = body.district ? String(body.district).trim() : null;
  const state = body.state ? String(body.state).trim() : null;
  const pincode = body.pincode ? String(body.pincode).trim() : null;
  const addressType = body.addressType ? String(body.addressType).trim() : "POSTAL";

  const appearanceDate = String(body.appearanceDate || "").trim();
  const appearanceTime = String(body.appearanceTime || "").trim();
  const remarks = body.remarks ? String(body.remarks).trim() : null;

  if (!Number.isInteger(partyId) || partyId <= 0) {
    return Response.json(
      { success: false, message: "Opposite party identification is required." },
      { status: 400 }
    );
  }

  if (!addressLine1) {
    return Response.json(
      { success: false, message: "Corrected address line 1 is required." },
      { status: 400 }
    );
  }

  if (!appearanceDate) {
    return Response.json(
      { success: false, message: "Appearance date for the fresh notice is required." },
      { status: 400 }
    );
  }

  if (!appearanceTime) {
    return Response.json(
      { success: false, message: "Appearance time for the fresh notice is required." },
      { status: 400 }
    );
  }

  const result = db.transaction(() => {
    const caseData = getCase(caseId);

    if (!caseData) {
      throw new Error("PIM case not found.");
    }

    if (caseData.status_code !== "ADDRESS_CORRECTION_PENDING") {
      return {
        conflict: true,
        message: `This case is not awaiting address correction. Current status: ${caseData.status_name}`,
      };
    }

    const attempt = loadAttemptForCorrection(caseId, serviceAttemptId);

    if (!attempt) {
      throw new Error("Service attempt not found for this case.");
    }

    if (attempt.notice_status !== "RETURNED") {
      return {
        conflict: true,
        message: `This notice is not available for address correction. Current notice status: ${attempt.notice_status}`,
      };
    }

    if (attempt.recipient_party_id !== partyId) {
      throw new Error(
        "Selected opposite party does not match the recipient of the returned notice."
      );
    }

    const pendingTask = getPendingAddressCorrectionTask(caseId);

    /*
     * Preserve address history: flip only the previously current
     * address(es) of the same type for this party, never delete.
     */
    db.prepare(`
      UPDATE pim_addresses
      SET is_current = 0
      WHERE party_id = ?
        AND address_type = ?
        AND is_current = 1
    `).run(partyId, addressType);

    const addressResult = db.prepare(`
      INSERT INTO pim_addresses
      (party_id, address_type, address_line1, address_line2, village_town, district, state, pincode, is_current, source, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADDRESS_CORRECTION', ?)
    `).run(
      partyId,
      addressType,
      addressLine1,
      addressLine2,
      villageTown,
      district,
      state,
      pincode,
      remarks
    );

    const newAddressId = Number(addressResult.lastInsertRowid);

    if (pendingTask) {
      completeTask(pendingTask, user.id, "Corrected address received.");
    }

    addDocket(
      caseId,
      "CORRECTED_ADDRESS_RECEIVED",
      `Corrected address received for ${attempt.recipient_name || "opposite party"}.`,
      "Fresh Initial Form-2 notice",
      user.id
    );

    const freshNoticeId = createFreshInitialNotice({
      caseId,
      recipientPartyId: partyId,
      addressId: newAddressId,
      noticeDate: today(),
      appearanceDate,
      appearanceTime,
      preparedBy: user.id,
      remarks: "Fresh Initial Form-2 notice after address correction.",
    });

    addDocket(
      caseId,
      "FRESH_FORM2",
      `Fresh Initial Form-2 notice prepared for ${attempt.recipient_name || "opposite party"} using corrected address.`,
      "Issue/dispatch fresh Form-2",
      user.id
    );

    const addressCorrectionStatusId = getStatusId("ADDRESS_CORRECTION_PENDING");
    const form2PendingStatusId = getStatusId("FORM2_PENDING");

    addStatusHistory(
      caseId,
      addressCorrectionStatusId,
      form2PendingStatusId,
      "Corrected address received; fresh Initial Form-2 notice prepared.",
      user.id
    );

    db.prepare(`
      UPDATE pim_cases
      SET current_status_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(form2PendingStatusId, caseId);

    return {
      caseId,
      originalNoticeId: attempt.notice_id,
      originalServiceAttemptId: serviceAttemptId,
      newAddressId,
      freshNoticeId,
      recipientPartyId: partyId,
      caseStatus: "FORM2_PENDING",
    };
  })();

  if (result.conflict) {
    return Response.json(
      { success: false, message: result.message },
      { status: 409 }
    );
  }

  return Response.json({
    success: true,
    message: "Corrected address recorded and fresh Initial Form-2 notice prepared.",
    data: result,
  });
}

function handleNoCorrectedAddress(user, caseId, serviceAttemptId, body) {
  const confirmed = Boolean(body.confirmed);
  const remarks = body.remarks ? String(body.remarks).trim() : null;

  if (!confirmed) {
    return Response.json(
      {
        success: false,
        message: "Explicit staff confirmation is required to proceed without a corrected address.",
      },
      { status: 400 }
    );
  }

  if (!remarks) {
    return Response.json(
      {
        success: false,
        message: "Remarks are required when no corrected address is available.",
      },
      { status: 400 }
    );
  }

  const result = db.transaction(() => {
    const caseData = getCase(caseId);

    if (!caseData) {
      throw new Error("PIM case not found.");
    }

    if (caseData.status_code !== "ADDRESS_CORRECTION_PENDING") {
      return {
        conflict: true,
        message: `This case is not awaiting address correction. Current status: ${caseData.status_name}`,
      };
    }

    const attempt = loadAttemptForCorrection(caseId, serviceAttemptId);

    if (!attempt) {
      throw new Error("Service attempt not found for this case.");
    }

    if (attempt.notice_status !== "RETURNED") {
      return {
        conflict: true,
        message: `This notice is not available for address correction. Current notice status: ${attempt.notice_status}`,
      };
    }

    const pendingTask = getPendingAddressCorrectionTask(caseId);

    if (pendingTask) {
      completeTask(pendingTask, user.id, remarks);
    }

    addDocket(
      caseId,
      "NO_CORRECTED_ADDRESS",
      `No corrected address available for ${attempt.recipient_name || "opposite party"}. ${remarks}`,
      "Proceed to Final Notice",
      user.id
    );

    const addressCorrectionStatusId = getStatusId("ADDRESS_CORRECTION_PENDING");
    const finalNoticeStatusId = getStatusId("FINAL_NOTICE_PENDING");

    addStatusHistory(
      caseId,
      addressCorrectionStatusId,
      finalNoticeStatusId,
      `No corrected address available. ${remarks}`,
      user.id
    );

    db.prepare(`
      UPDATE pim_cases
      SET current_status_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(finalNoticeStatusId, caseId);

    createPendingTaskIfNotExists(
      caseId,
      "FINAL_NOTICE_FOLLOWUP",
      `Final Notice follow-up for ${attempt.recipient_name || "opposite party"}.`,
      today()
    );

    return {
      caseId,
      originalNoticeId: attempt.notice_id,
      originalServiceAttemptId: serviceAttemptId,
      caseStatus: "FINAL_NOTICE_PENDING",
    };
  })();

  if (result.conflict) {
    return Response.json(
      { success: false, message: result.message },
      { status: 409 }
    );
  }

  return Response.json({
    success: true,
    message: "Recorded: no corrected address available. Routed to Final Notice follow-up.",
    data: result,
  });
}
