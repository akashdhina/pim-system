/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5J's service-result /
 * address-correction workflow - SERVICE_PENDING through to the case's
 * next meaningful downstream state. See
 * docs/phase6-batch5j-form2-service-migration.md.
 *
 * Scope (approved plan): recordServiceResultTx (DELIVERED / RETURNED /
 * TRACKING_UPDATE) and the two address-correction decisions
 * (CORRECTED_ADDRESS_RECEIVED / NO_CORRECTED_ADDRESS). OP-response/
 * consent, mediation fee, mediator assignment, mediation sessions,
 * outcomes and honorarium are explicitly NOT part of this batch.
 *
 * Intentional correction, not a parity bug: a returned FINAL notice now
 * writes pim_cases.current_status_id = NOTICE_RETURNED (not left
 * silently at SERVICE_PENDING, the pre-existing SQLite behavior the
 * earlier audit flagged). NOTICE_RETURNED is a genuine resting state
 * here - unlike REGISTERED (Batch 5H-b), which is transient only
 * because the SAME transaction immediately continues to FORM2_PENDING,
 * a returned Final Notice has nothing further to do automatically; the
 * pending NONSTARTER_FORM3 handoff task (created/maintained exactly as
 * before) is the next-action signal for staff. The two OTHER return
 * branches (address correction / proceed to Final Notice) are left
 * exactly as the SQLite original: NOTICE_RETURNED is still only a
 * status-history hop there, because those branches' transactions
 * immediately continue to a further resting state in the same call -
 * this fix touches only the one branch the audit identified, nothing
 * else.
 *
 * Concurrency: every mutating function locks the case row FIRST
 * (SELECT ... FOR UPDATE), re-checks its status, then locks the
 * relevant notice row (FOR UPDATE OF n) before re-checking notice/
 * service-attempt state - the same case-then-notice order
 * issueForm2NoticeTx (Batch 5I) already established. No new DB
 * constraint was added beyond the approved migration (contact-affidavit
 * columns + the NO_CORRECTED_ADDRESS event row); row-level locking
 * fully serializes every invariant this module depends on, confirmed
 * live against pg_constraint/pg_indexes before writing this module
 * (see the batch document's concurrency section).
 */

const { withTransaction, getSql } = require("../pim-postgres");
const { officeDate, officeTime } = require("../pim-time");
const { getStatusId, addStatusHistory, addDocket, getPendingTask, createPendingTaskIfNotExists } = require("./workflow-helpers");
const { toWire } = require("./wire-compat");
const { createFreshNoticeTx } = require("./form2");

const CASE_WIRE = { timestamps: ["updated_at", "created_at"] };
const ADDRESS_WIRE = { flags: ["is_current"] };
const NOTICE_WIRE = { flags: ["contact_affidavit_received"] };

const ALLOWED_RETURN_REASONS = new Set([
  "ADDRESSEE_LEFT",
  "INSUFFICIENT_ADDRESS",
  "UNCLAIMED",
  "REFUSED_BY_ADDRESSEE",
  "OTHER",
]);

const ADDRESS_CORRECTION_REASONS = new Set(["ADDRESSEE_LEFT", "INSUFFICIENT_ADDRESS"]);
const FINAL_NOTICE_REASONS = new Set(["UNCLAIMED", "REFUSED_BY_ADDRESSEE"]);

/*
 * Guarded completion: WHERE status='PENDING' + a row-count check, so
 * this can never double-complete even under a race - same invariant as
 * lib/pim-data/scrutiny.js's completeTaskPg / form2.js's task
 * completion in issueForm2NoticeTx. Not promoted to workflow-helpers.js
 * (scope: only what T7's batch needed, per that module's own header) -
 * kept local, matching form2.js's own precedent of inlining this
 * pattern rather than growing the shared module speculatively.
 */
async function completeTaskTx(tx, task, userId, remarks) {
  const updated = await tx`
    UPDATE pim_tasks
    SET status = 'COMPLETED', completed_date = ${officeDate()}, completed_time = ${officeTime()}, completed_by = ${userId}
    WHERE id = ${task.id} AND status = 'PENDING'
    RETURNING id
  `;
  if (updated.length === 1) {
    await tx`
      INSERT INTO pim_task_history (task_id, old_status, new_status, changed_by, remarks)
      VALUES (${task.id}, 'PENDING', 'COMPLETED', ${userId}, ${remarks})
    `;
  }
  return updated.length === 1;
}

// ---------------------------------------------------------------------
// GET loaders
// ---------------------------------------------------------------------

async function getCasePg(client, caseId) {
  const [row] = await client`
    SELECT c.*, s.code AS status_code, s.name AS status_name
    FROM pim_cases c
    LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;
  return row ? toWire(row, CASE_WIRE) : null;
}

async function getServiceAttemptsPg(client, caseId) {
  const rows = await client`
    SELECT
      sa.*,
      n.notice_type, n.form_no, n.notice_date, n.appearance_date, n.appearance_time,
      n.status AS notice_status,
      p.name AS recipient_name,
      a.address_type, a.address_line1, a.address_line2, a.village_town, a.district, a.state, a.pincode
    FROM pim_service_attempts sa
    JOIN pim_notices n ON n.id = sa.notice_id
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    LEFT JOIN pim_addresses a ON a.id = sa.address_id
    WHERE n.case_id = ${caseId}
    ORDER BY sa.id DESC
  `;
  return rows;
}

async function getNoticesPg(client, caseId) {
  const rows = await client`
    SELECT n.*, p.name AS recipient_name
    FROM pim_notices n
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    WHERE n.case_id = ${caseId}
    ORDER BY n.id DESC
  `;
  return rows.map((r) => toWire(r, NOTICE_WIRE));
}

async function getServiceDataPg(caseId) {
  const sql = getSql();
  const caseData = await getCasePg(sql, caseId);
  if (!caseData) return null;

  const [notices, serviceAttempts] = await Promise.all([
    getNoticesPg(sql, caseId),
    getServiceAttemptsPg(sql, caseId),
  ]);

  return { case: caseData, notices, serviceAttempts };
}

async function getRecipientAddressesPg(client, partyId) {
  const rows = await client`
    SELECT * FROM pim_addresses
    WHERE party_id = ${partyId}
    ORDER BY is_current DESC, id DESC
  `;
  return rows.map((a) => toWire(a, ADDRESS_WIRE));
}

async function getCandidateServiceAttemptsPg(client, caseId) {
  const rows = await client`
    SELECT
      sa.id AS service_attempt_id, sa.return_reason, sa.postal_endorsement,
      sa.returned_date, sa.remarks AS service_remarks,
      n.id AS notice_id, n.notice_type, n.notice_date, n.recipient_party_id,
      n.address_id AS notice_address_id,
      p.name AS recipient_name
    FROM pim_service_attempts sa
    JOIN pim_notices n ON n.id = sa.notice_id
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    WHERE n.case_id = ${caseId}
      AND n.status = 'RETURNED'
      AND NOT EXISTS (
        SELECT 1 FROM pim_notices fresh
        WHERE fresh.case_id = n.case_id
          AND fresh.recipient_party_id = n.recipient_party_id
          AND fresh.notice_type = 'FORM_2_INITIAL'
          AND fresh.id > n.id
      )
    ORDER BY sa.id DESC
  `;
  return rows;
}

async function getAddressCorrectionDataPg(caseId) {
  const sql = getSql();
  const caseData = await getCasePg(sql, caseId);
  if (!caseData) return null;

  const candidates = await getCandidateServiceAttemptsPg(sql, caseId);
  const candidatesWithAddresses = await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      recipientAddresses: await getRecipientAddressesPg(sql, candidate.recipient_party_id),
    }))
  );

  return { case: caseData, candidates: candidatesWithAddresses };
}

// ---------------------------------------------------------------------
// Service result - DELIVERED / RETURNED / TRACKING_UPDATE
// ---------------------------------------------------------------------

async function recordServiceResultTx(tx, caseId, input, userId) {
  const {
    serviceAttemptId, result, trackingStatus = null, postalEndorsement = null,
    deliveredDate = null, returnedDate = null, remarks = null,
    returnReason = null, administrativeAction = null,
  } = input;

  // Lock the case row FIRST - closes the "service result racing with
  // address correction" and "two requests advancing the same case
  // differently" races: both routes gate on mutually exclusive case
  // statuses, so whichever request commits first leaves the loser's
  // post-lock re-read unable to satisfy its own guard.
  const [caseRow] = await tx`
    SELECT c.id, c.current_status_id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (caseRow.status_code !== "SERVICE_PENDING") {
    return {
      conflict: true,
      message: `This case is not available for service tracking. Current status: ${caseRow.status_name}`,
    };
  }

  // Lock the notice row via the service attempt - closes "duplicate
  // service-result submission" and "two users recording conflicting
  // outcomes" for the SAME attempt: the loser re-reads notice_status
  // after the winner commits and hits the ordinary status guard below.
  const [attempt] = await tx`
    SELECT
      sa.id AS service_attempt_id, n.id AS notice_id, n.status AS notice_status,
      n.notice_type, n.recipient_party_id, p.name AS recipient_name
    FROM pim_service_attempts sa
    JOIN pim_notices n ON n.id = sa.notice_id
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    WHERE sa.id = ${serviceAttemptId} AND n.case_id = ${caseId}
    FOR UPDATE OF n
  `;
  if (!attempt) throw new Error("Service attempt not found for this case.");

  if (attempt.notice_status !== "DISPATCHED") {
    return {
      conflict: true,
      message: `This notice is not available for service tracking. Current notice status: ${attempt.notice_status}`,
    };
  }

  if (result === "DELIVERED" && !deliveredDate) {
    throw new Error("Delivered date is required.");
  }
  if (result === "RETURNED" && !returnedDate) {
    throw new Error("Returned date is required.");
  }

  await tx`
    UPDATE pim_service_attempts
    SET
      tracking_status = ${trackingStatus},
      postal_endorsement = ${postalEndorsement},
      return_reason = ${result === "RETURNED" ? returnReason : null},
      delivered_date = ${deliveredDate},
      returned_date = ${returnedDate},
      remarks = COALESCE(${remarks}, remarks)
    WHERE id = ${serviceAttemptId}
  `;

  if (result === "DELIVERED") {
    await tx`UPDATE pim_notices SET status = 'SERVED' WHERE id = ${attempt.notice_id}`;

    await addDocket(
      tx, caseId, "NOTICE_DELIVERED",
      `Form-2 notice delivered to ${attempt.recipient_name || "opposite party"}.`,
      "Await opposite party response / appearance", null, userId
    );

    return {
      result, caseId, serviceAttemptId, noticeId: attempt.notice_id,
      caseStatus: "SERVICE_PENDING", noticeStatus: "SERVED",
    };
  }

  if (result === "RETURNED") {
    await tx`UPDATE pim_notices SET status = 'RETURNED' WHERE id = ${attempt.notice_id}`;

    const servicePendingStatusId = await getStatusId(tx, "SERVICE_PENDING");
    const returnedStatusId = await getStatusId(tx, "NOTICE_RETURNED");

    await addStatusHistory(
      tx, caseId, servicePendingStatusId, returnedStatusId,
      "Form-2 notice returned after service attempt.", userId
    );

    await addDocket(
      tx, caseId, "NOTICE_RETURNED",
      `Form-2 notice returned for ${attempt.recipient_name || "opposite party"} (${returnReason}).`,
      "Address / service correction", null, userId
    );

    if (attempt.notice_type === "FORM_2_FINAL") {
      /*
       * INTENTIONAL CORRECTION (approved, not a parity bug): persist
       * the case at NOTICE_RETURNED rather than silently leaving
       * current_status_id at SERVICE_PENDING, which is what the
       * pre-existing SQLite route did. This is this branch's only
       * change versus the SQLite original - the two OTHER return
       * branches below are untouched, since they already correctly
       * continue to a further resting state in this same transaction.
       */
      await tx`
        UPDATE pim_cases SET current_status_id = ${returnedStatusId}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${caseId}
      `;

      /*
       * Maintain (not duplicate) the NONSTARTER_FORM3 handoff task -
       * exactly what lib/pim-op-response.js's createNonStarterHandoff
       * already does on SQLite: a thin, dedup'd createPendingTaskIfNotExists
       * call, not a new task type or a new mechanism.
       */
      await createPendingTaskIfNotExists(
        tx, caseId, "NONSTARTER_FORM3",
        `Non-starter handoff: Final Notice returned (${returnReason}); remained unacknowledged. (${attempt.recipient_name || "opposite party"}).`,
        officeDate(),
        `Final Notice returned (${returnReason}); remained unacknowledged.`
      );

      return {
        result, caseId, serviceAttemptId, noticeId: attempt.notice_id, returnReason,
        caseStatus: "NOTICE_RETURNED", noticeStatus: "RETURNED",
      };
    }

    const seekCorrectedAddress =
      ADDRESS_CORRECTION_REASONS.has(returnReason) ||
      (returnReason === "OTHER" && administrativeAction === "SEEK_CORRECTED_ADDRESS");

    const proceedToFinalNotice =
      FINAL_NOTICE_REASONS.has(returnReason) ||
      (returnReason === "OTHER" && administrativeAction === "PROCEED_TO_FINAL_NOTICE");

    if (seekCorrectedAddress) {
      const addressCorrectionStatusId = await getStatusId(tx, "ADDRESS_CORRECTION_PENDING");

      await addStatusHistory(
        tx, caseId, returnedStatusId, addressCorrectionStatusId,
        `Corrected address required (${returnReason}).`, userId
      );

      await tx`
        UPDATE pim_cases SET current_status_id = ${addressCorrectionStatusId}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${caseId}
      `;

      await createPendingTaskIfNotExists(
        tx, caseId, "ADDRESS_CORRECTION",
        `Obtain corrected address for ${attempt.recipient_name || "opposite party"}.`,
        officeDate()
      );

      await addDocket(
        tx, caseId, "ADDRESS_REQUESTED",
        `Corrected address requested for ${attempt.recipient_name || "opposite party"}.`,
        "Obtain corrected address", null, userId
      );

      return {
        result, caseId, serviceAttemptId, noticeId: attempt.notice_id, returnReason,
        caseStatus: "ADDRESS_CORRECTION_PENDING", noticeStatus: "RETURNED",
      };
    }

    if (proceedToFinalNotice) {
      const finalNoticeStatusId = await getStatusId(tx, "FINAL_NOTICE_PENDING");

      await addStatusHistory(
        tx, caseId, returnedStatusId, finalNoticeStatusId,
        `Routed to Final Notice follow-up (${returnReason}).`, userId
      );

      await tx`
        UPDATE pim_cases SET current_status_id = ${finalNoticeStatusId}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${caseId}
      `;

      await createPendingTaskIfNotExists(
        tx, caseId, "FINAL_NOTICE_FOLLOWUP",
        `Final Notice follow-up for ${attempt.recipient_name || "opposite party"}.`,
        officeDate()
      );

      return {
        result, caseId, serviceAttemptId, noticeId: attempt.notice_id, returnReason,
        caseStatus: "FINAL_NOTICE_PENDING", noticeStatus: "RETURNED",
      };
    }

    throw new Error("Unable to determine the administrative branch for this returned notice.");
  }

  // TRACKING_UPDATE - no status change.
  return {
    result, caseId, serviceAttemptId, noticeId: attempt.notice_id,
    caseStatus: "SERVICE_PENDING", noticeStatus: "DISPATCHED",
  };
}

async function recordServiceResultPg(caseId, input, userId) {
  return withTransaction((tx) => recordServiceResultTx(tx, caseId, input, userId));
}

// ---------------------------------------------------------------------
// Address correction - CORRECTED_ADDRESS_RECEIVED / NO_CORRECTED_ADDRESS
// ---------------------------------------------------------------------

async function loadAttemptForCorrectionTx(tx, caseId, serviceAttemptId) {
  const [row] = await tx`
    SELECT
      sa.id AS service_attempt_id, n.id AS notice_id, n.case_id,
      n.status AS notice_status, n.recipient_party_id, p.name AS recipient_name
    FROM pim_service_attempts sa
    JOIN pim_notices n ON n.id = sa.notice_id
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    WHERE sa.id = ${serviceAttemptId} AND n.case_id = ${caseId}
    FOR UPDATE OF n
  `;
  return row || null;
}

async function recordCorrectedAddressTx(tx, caseId, input, userId) {
  const {
    serviceAttemptId, partyId, addressLine1, addressLine2 = null, villageTown = null,
    district = null, state = null, pincode = null, addressType = "POSTAL",
    appearanceDate, appearanceTime, remarks = null,
  } = input;

  const [caseRow] = await tx`
    SELECT c.id, c.current_status_id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (caseRow.status_code !== "ADDRESS_CORRECTION_PENDING") {
    return {
      conflict: true,
      message: `This case is not awaiting address correction. Current status: ${caseRow.status_name}`,
    };
  }

  const attempt = await loadAttemptForCorrectionTx(tx, caseId, serviceAttemptId);
  if (!attempt) throw new Error("Service attempt not found for this case.");

  if (attempt.notice_status !== "RETURNED") {
    return {
      conflict: true,
      message: `This notice is not available for address correction. Current notice status: ${attempt.notice_status}`,
    };
  }

  if (attempt.recipient_party_id !== partyId) {
    throw new Error("Selected opposite party does not match the recipient of the returned notice.");
  }

  const pendingTask = await getPendingTask(tx, caseId, "ADDRESS_CORRECTION");

  /*
   * Preserve address history: flip only the previously current
   * address(es) of the same type for this party, never delete - the
   * exact invariant the task's §6 (address history) requires.
   */
  await tx`
    UPDATE pim_addresses SET is_current = false
    WHERE party_id = ${partyId} AND address_type = ${addressType} AND is_current = true
  `;

  const [{ id: newAddressId }] = await tx`
    INSERT INTO pim_addresses
      (party_id, address_type, address_line1, address_line2, village_town, district, state, pincode, is_current, source, remarks)
    VALUES
      (${partyId}, ${addressType}, ${addressLine1}, ${addressLine2}, ${villageTown}, ${district}, ${state}, ${pincode}, true, 'ADDRESS_CORRECTION', ${remarks})
    RETURNING id
  `;

  if (pendingTask) {
    await completeTaskTx(tx, pendingTask, userId, "Corrected address received.");
  }

  await addDocket(
    tx, caseId, "CORRECTED_ADDRESS_RECEIVED",
    `Corrected address received for ${attempt.recipient_name || "opposite party"}.`,
    "Fresh Initial Form-2 notice", null, userId
  );

  // Reused verbatim, per the task's explicit instruction not to
  // duplicate it - the SAME function Batch 5I already proved correct
  // (including its own built-in duplicate-active-notice guard).
  const freshNoticeId = await createFreshNoticeTx(tx, {
    caseId, recipientPartyId: partyId, addressId: newAddressId, noticeType: "FORM_2_INITIAL",
    noticeDate: officeDate(), appearanceDate, appearanceTime,
    preparedBy: userId, remarks: "Fresh Initial Form-2 notice after address correction.",
  });

  await addDocket(
    tx, caseId, "FRESH_FORM2",
    `Fresh Initial Form-2 notice prepared for ${attempt.recipient_name || "opposite party"} using corrected address.`,
    "Issue/dispatch fresh Form-2", null, userId
  );

  const addressCorrectionStatusId = await getStatusId(tx, "ADDRESS_CORRECTION_PENDING");
  const form2PendingStatusId = await getStatusId(tx, "FORM2_PENDING");

  await addStatusHistory(
    tx, caseId, addressCorrectionStatusId, form2PendingStatusId,
    "Corrected address received; fresh Initial Form-2 notice prepared.", userId
  );

  await tx`
    UPDATE pim_cases SET current_status_id = ${form2PendingStatusId}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${caseId}
  `;

  return {
    caseId, originalNoticeId: attempt.notice_id, originalServiceAttemptId: serviceAttemptId,
    newAddressId, freshNoticeId, recipientPartyId: partyId, caseStatus: "FORM2_PENDING",
  };
}

async function recordCorrectedAddressPg(caseId, input, userId) {
  return withTransaction((tx) => recordCorrectedAddressTx(tx, caseId, input, userId));
}

async function recordNoCorrectedAddressTx(tx, caseId, input, userId) {
  const { serviceAttemptId, remarks } = input;

  const [caseRow] = await tx`
    SELECT c.id, c.current_status_id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (caseRow.status_code !== "ADDRESS_CORRECTION_PENDING") {
    return {
      conflict: true,
      message: `This case is not awaiting address correction. Current status: ${caseRow.status_name}`,
    };
  }

  const attempt = await loadAttemptForCorrectionTx(tx, caseId, serviceAttemptId);
  if (!attempt) throw new Error("Service attempt not found for this case.");

  if (attempt.notice_status !== "RETURNED") {
    return {
      conflict: true,
      message: `This notice is not available for address correction. Current notice status: ${attempt.notice_status}`,
    };
  }

  const pendingTask = await getPendingTask(tx, caseId, "ADDRESS_CORRECTION");
  if (pendingTask) {
    await completeTaskTx(tx, pendingTask, userId, remarks);
  }

  await addDocket(
    tx, caseId, "NO_CORRECTED_ADDRESS",
    `No corrected address available for ${attempt.recipient_name || "opposite party"}. ${remarks}`,
    "Proceed to Final Notice", null, userId
  );

  const addressCorrectionStatusId = await getStatusId(tx, "ADDRESS_CORRECTION_PENDING");
  const finalNoticeStatusId = await getStatusId(tx, "FINAL_NOTICE_PENDING");

  await addStatusHistory(
    tx, caseId, addressCorrectionStatusId, finalNoticeStatusId,
    `No corrected address available. ${remarks}`, userId
  );

  await tx`
    UPDATE pim_cases SET current_status_id = ${finalNoticeStatusId}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${caseId}
  `;

  await createPendingTaskIfNotExists(
    tx, caseId, "FINAL_NOTICE_FOLLOWUP",
    `Final Notice follow-up for ${attempt.recipient_name || "opposite party"}.`,
    officeDate()
  );

  return {
    caseId, originalNoticeId: attempt.notice_id, originalServiceAttemptId: serviceAttemptId,
    caseStatus: "FINAL_NOTICE_PENDING",
  };
}

async function recordNoCorrectedAddressPg(caseId, input, userId) {
  return withTransaction((tx) => recordNoCorrectedAddressTx(tx, caseId, input, userId));
}

module.exports = {
  ALLOWED_RETURN_REASONS,
  getServiceDataPg,
  recordServiceResultTx,
  recordServiceResultPg,
  getAddressCorrectionDataPg,
  recordCorrectedAddressTx,
  recordCorrectedAddressPg,
  recordNoCorrectedAddressTx,
  recordNoCorrectedAddressPg,
};
