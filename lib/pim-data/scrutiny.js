/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5E's migrated mutation:
 * scrutiny save (transaction T2 in docs/phase6-transaction-readiness.md) -
 * lib/pim-scrutiny.js's saveScrutiny(), matched statement-for-statement,
 * guard-for-guard and error-message-for-error-message. See
 * docs/phase6-batch5e-scrutiny-migration.md for the full mapping.
 *
 * Runs entirely inside one withTransaction(...) callback - every
 * statement uses the transaction-scoped `tx` client (directly, or via
 * addStatusHistory from lib/pim-data/workflow-helpers.js, which also only
 * ever uses the `tx` it is given). Nothing in this file reads or writes
 * SQLite, and nothing calls getSql() a second time inside the
 * transaction. The acting user's identity is resolved via SQLite (auth)
 * BEFORE this function is invoked - unchanged, see
 * app/api/pim/scrutiny/[id]/route.js - and only the already-resolved
 * numeric userId crosses that boundary, as a plain value.
 *
 * Structure: saveScrutinyPg() validates (pure JS, no database read, same
 * as SQLite) and then opens the transaction; saveScrutinyTx() is the
 * transaction body. They are split only so the tests can run the exact
 * T2 statements inside a caller-owned transaction and force a failure
 * AFTER every T2 write has happened, to prove a late failure rolls all of
 * them back. Production code only ever calls saveScrutinyPg().
 *
 * T2 does NOT generate a PIM number (that is T3/approval, and the
 * MAX+1-over-LIKE hazard the readiness audit flagged does not apply
 * here), creates no task (it completes the existing pending SCRUTINY
 * task), and generates no ID that a later statement consumes - the
 * SQLite version has zero lastInsertRowid uses - so there is no
 * RETURNING id conversion to make other than the row-count check on the
 * task-completion UPDATE.
 *
 * Helper reuse (see the Batch 5E doc, section 4): only addStatusHistory
 * is reused from workflow-helpers.js. getStatusId/getEventId/addDocket
 * there use different missing-row error messages than T2's contract, and
 * getPendingTask there orders newest-first where T2 orders oldest-first,
 * so blindly reusing them would silently change behavior. The
 * T2-specific equivalents below are deliberately local.
 */

const { withTransaction } = require("../pim-postgres");
const { officeDate, officeTime } = require("../pim-time");
const { addStatusHistory } = require("./workflow-helpers");

/*
 * lib/pim-scrutiny.js tags three errors with statusCode = 409. The route
 * only maps error.status 401/403 (authErrorResponse), so today every
 * thrown error still returns HTTP 400 - the tag is informational. It is
 * reproduced exactly so nothing that inspects it can drift.
 */
function conflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

async function getStatusIdPg(tx, code) {
  const [row] = await tx`
    SELECT id
    FROM status_master
    WHERE code = ${code}
    LIMIT 1
  `;

  if (!row) {
    throw new Error(`Status '${code}' is missing.`);
  }

  return row.id;
}

async function getEventIdPg(tx, code) {
  const [row] = await tx`
    SELECT id
    FROM event_types
    WHERE code = ${code}
    LIMIT 1
  `;

  if (!row) {
    throw new Error(`Event '${code}' is missing.`);
  }

  return row.id;
}

async function getCaseForScrutinyPg(tx, caseId) {
  const [row] = await tx`
    SELECT
      c.*,
      sm.code AS status_code,
      sm.name AS status_name
    FROM pim_cases c
    LEFT JOIN status_master sm
      ON sm.id = c.current_status_id
    WHERE c.id = ${caseId}
    LIMIT 1
  `;

  if (!row) {
    throw new Error("PIM case not found.");
  }

  return row;
}

async function getExistingScrutinyPg(tx, caseId) {
  const [row] = await tx`
    SELECT *
    FROM pim_scrutiny
    WHERE case_id = ${caseId}
    LIMIT 1
  `;

  return row || null;
}

/*
 * ORDER BY id ASC (oldest pending task first) - identical to
 * lib/pim-scrutiny.js. NOT interchangeable with
 * workflow-helpers.js's getPendingTask, which orders id DESC.
 */
async function getPendingTaskPg(tx, caseId, taskTypeCode) {
  const [row] = await tx`
    SELECT
      id,
      status,
      task_type_code
    FROM pim_tasks
    WHERE case_id = ${caseId}
      AND task_type_code = ${taskTypeCode}
      AND status = 'PENDING'
    ORDER BY id
    LIMIT 1
  `;

  return row || null;
}

/*
 * The `AND status = 'PENDING'` guard plus the exactly-one-row check is
 * the invariant that makes a repeated/simultaneous scrutiny submission
 * safe under PostgreSQL's real concurrency: it is the LAST write of the
 * transaction, the row lock serializes two racers, and the loser
 * re-evaluates the WHERE after the winner commits, matches 0 rows and
 * throws - rolling back everything it wrote before. SQLite's `changes`
 * becomes the number of RETURNING rows here.
 */
async function completeTaskPg(tx, { taskId, completedBy, remarks }) {
  const updated = await tx`
    UPDATE pim_tasks
    SET
      status = 'COMPLETED',
      completed_date = ${officeDate()},
      completed_time = ${officeTime()},
      completed_by = ${completedBy},
      remarks = ${remarks}
    WHERE id = ${taskId}
      AND status = 'PENDING'
    RETURNING id
  `;

  if (updated.length !== 1) {
    throw conflictError("The pending scrutiny task could not be completed.");
  }

  await tx`
    INSERT INTO pim_task_history (
      task_id,
      old_status,
      new_status,
      changed_by,
      remarks
    )
    VALUES (${taskId}, 'PENDING', 'COMPLETED', ${completedBy}, ${remarks})
  `;
}

async function insertScrutinyAttemptPg(tx, caseId, scrutiny) {
  const [{ next_attempt_no: nextAttemptNo }] = await tx`
    SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_attempt_no
    FROM pim_scrutiny_attempts
    WHERE case_id = ${caseId}
  `;

  await tx`
    INSERT INTO pim_scrutiny_attempts (
      case_id, attempt_no, form1_complete, application_fee_received,
      dd_number, dd_date, dd_bank, dd_amount, dd_payee_correct, dd_valid,
      vakalat_available, opposite_party_address_available,
      commercial_dispute_checked, territorial_jurisdiction_checked,
      supporting_documents_checked, scrutiny_result, defect_details,
      rectification_date, scrutinised_by, scrutinised_at
    )
    VALUES (
      ${caseId},
      ${nextAttemptNo},
      ${scrutiny.form1_complete ?? null},
      ${scrutiny.application_fee_received},
      ${scrutiny.dd_number},
      ${scrutiny.dd_date},
      ${scrutiny.dd_bank},
      ${scrutiny.dd_amount},
      ${scrutiny.dd_payee_correct},
      ${scrutiny.dd_valid},
      ${scrutiny.vakalat_available ?? null},
      ${scrutiny.opposite_party_address_available},
      ${scrutiny.commercial_dispute_checked},
      ${scrutiny.territorial_jurisdiction_checked},
      ${scrutiny.supporting_documents_checked},
      ${scrutiny.scrutiny_result},
      ${scrutiny.defect_details},
      ${scrutiny.rectification_date},
      ${scrutiny.scrutinised_by},
      ${scrutiny.scrutinised_at}
    )
  `;
}

/*
 * Pre-transaction validation - pure JS, no database read, same three
 * checks and messages as lib/pim-scrutiny.js's saveScrutiny(). Returns
 * the numeric case id.
 */
function validateScrutinyInput(caseId, data) {
  const numericCaseId = Number(caseId);

  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) {
    throw new Error("Valid case ID is required.");
  }

  if (!data || typeof data !== "object") {
    throw new Error("Scrutiny data is required.");
  }

  if (!["COMPLETE", "DEFECT"].includes(data.scrutinyResult)) {
    throw new Error("Scrutiny result must be COMPLETE or DEFECT.");
  }

  return numericCaseId;
}

/*
 * The T2 transaction body. `tx` MUST be a transaction-scoped client
 * (from withTransaction); every statement below goes through it. Guard
 * order matches SQLite exactly: case -> status -> pending task ->
 * ddAmount -> defect details -> writes.
 */
async function saveScrutinyTx(tx, numericCaseId, data, userId = null) {
  /*
   * Re-read inside the transaction (same as SQLite) so a second click
   * cannot act on stale browser state.
   */
  const caseRow = await getCaseForScrutinyPg(tx, numericCaseId);

  if (
    caseRow.status_code !== "RECEIVED" &&
    caseRow.status_code !== "SCRUTINY_PENDING"
  ) {
    throw conflictError(
      `This case is not available for scrutiny. Current status: ${caseRow.status_name}`
    );
  }

  const pendingScrutinyTask = await getPendingTaskPg(
    tx,
    numericCaseId,
    "SCRUTINY"
  );

  if (!pendingScrutinyTask) {
    throw conflictError("Pending SCRUTINY task was not found.");
  }

  const ddAmount =
    data.ddAmount === "" || data.ddAmount === null || data.ddAmount === undefined
      ? null
      : Number(data.ddAmount);

  if (ddAmount !== null && (!Number.isFinite(ddAmount) || ddAmount < 0)) {
    throw new Error("DD amount must be a valid non-negative number.");
  }

  /*
   * The checklist flags are `smallint` columns in PostgreSQL (Phase 2
   * deliberately kept SQLite's 0/1 tri-state rather than boolean), so
   * they are written as 1/0 exactly like SQLite - no conversion.
   * scrutinised_at is a UTC instant (timestamptz), written as the same
   * ISO string SQLite stores.
   */
  const scrutiny = {
    application_fee_received: data.applicationFeeReceived ? 1 : 0,
    dd_number: data.ddNumber ? String(data.ddNumber).trim() : null,
    dd_date: data.ddDate || null,
    dd_bank: data.ddBank ? String(data.ddBank).trim() : null,
    dd_amount: ddAmount,
    dd_payee_correct: data.ddPayeeCorrect ? 1 : 0,
    dd_valid: data.ddValid ? 1 : 0,
    opposite_party_address_available: data.oppositePartyAddressAvailable ? 1 : 0,
    commercial_dispute_checked: data.commercialDisputeChecked ? 1 : 0,
    territorial_jurisdiction_checked: data.territorialJurisdictionChecked ? 1 : 0,
    supporting_documents_checked: data.supportingDocumentsChecked ? 1 : 0,
    scrutiny_result: data.scrutinyResult,
    defect_details:
      data.scrutinyResult === "DEFECT"
        ? String(data.defectDetails || "").trim() || null
        : null,
    rectification_date: data.rectificationDate || null,
    scrutinised_by: userId,
    scrutinised_at: new Date().toISOString(),
  };

  if (data.scrutinyResult === "DEFECT" && !scrutiny.defect_details) {
    throw new Error(
      "Defect details are required when scrutiny result is DEFECT."
    );
  }

  const existing = await getExistingScrutinyPg(tx, numericCaseId);

  if (existing) {
    await tx`
      UPDATE pim_scrutiny
      SET
        application_fee_received = ${scrutiny.application_fee_received},
        dd_number = ${scrutiny.dd_number},
        dd_date = ${scrutiny.dd_date},
        dd_bank = ${scrutiny.dd_bank},
        dd_amount = ${scrutiny.dd_amount},
        dd_payee_correct = ${scrutiny.dd_payee_correct},
        dd_valid = ${scrutiny.dd_valid},
        opposite_party_address_available = ${scrutiny.opposite_party_address_available},
        commercial_dispute_checked = ${scrutiny.commercial_dispute_checked},
        territorial_jurisdiction_checked = ${scrutiny.territorial_jurisdiction_checked},
        supporting_documents_checked = ${scrutiny.supporting_documents_checked},
        scrutiny_result = ${scrutiny.scrutiny_result},
        defect_details = ${scrutiny.defect_details},
        rectification_date = ${scrutiny.rectification_date},
        scrutinised_by = ${scrutiny.scrutinised_by},
        scrutinised_at = ${scrutiny.scrutinised_at}
      WHERE case_id = ${numericCaseId}
    `;
  } else {
    await tx`
      INSERT INTO pim_scrutiny (
        case_id,
        application_fee_received,
        dd_number,
        dd_date,
        dd_bank,
        dd_amount,
        dd_payee_correct,
        dd_valid,
        opposite_party_address_available,
        commercial_dispute_checked,
        territorial_jurisdiction_checked,
        supporting_documents_checked,
        scrutiny_result,
        defect_details,
        rectification_date,
        scrutinised_by,
        scrutinised_at
      )
      VALUES (
        ${numericCaseId},
        ${scrutiny.application_fee_received},
        ${scrutiny.dd_number},
        ${scrutiny.dd_date},
        ${scrutiny.dd_bank},
        ${scrutiny.dd_amount},
        ${scrutiny.dd_payee_correct},
        ${scrutiny.dd_valid},
        ${scrutiny.opposite_party_address_available},
        ${scrutiny.commercial_dispute_checked},
        ${scrutiny.territorial_jurisdiction_checked},
        ${scrutiny.supporting_documents_checked},
        ${scrutiny.scrutiny_result},
        ${scrutiny.defect_details},
        ${scrutiny.rectification_date},
        ${scrutiny.scrutinised_by},
        ${scrutiny.scrutinised_at}
      )
    `;
  }

  // Both SQLite branches append exactly one attempt row after the
  // pim_scrutiny write; a single call after the branch is equivalent.
  await insertScrutinyAttemptPg(tx, numericCaseId, scrutiny);

  let nextStatusCode;
  let eventCode;
  let docketText;
  let reason;
  let actionRequired;
  let taskRemarks;

  if (data.scrutinyResult === "COMPLETE") {
    /*
     * Batch 5H-b (Phase 6): staff-operated PIM-number assignment replaces
     * Secretary approval as the checkpoint after scrutiny - see
     * docs/phase6-batch5h-b-pim-numbering.md. This is a deliberate
     * business-rule change, not just an engine migration: lib/pim-scrutiny.js
     * (the kept SQLite baseline) is intentionally NOT updated to match -
     * it stays frozen as a record of pre-5H-b behavior, so the two
     * engines diverge here on purpose. scripts/test-pim-scrutiny-postgres.js's
     * parity tests account for this explicitly.
     */
    nextStatusCode = "PIM_NUMBER_PENDING";
    eventCode = "SCRUTINY_COMPLETED";
    docketText = "Scrutiny completed; PIM number assignment pending.";
    reason = "Scrutiny completed; PIM number assignment pending.";
    actionRequired = "Assign PIM number";
    taskRemarks = "Scrutiny completed; PIM number assignment pending.";
  } else {
    nextStatusCode = "DEFECT_PENDING";
    eventCode = "DEFECT_NOTED";
    docketText = "Defect / rectification required during scrutiny.";
    reason = scrutiny.defect_details || "Defect / rectification required.";
    actionRequired = "Rectification required";
    taskRemarks = "Scrutiny completed with defects requiring rectification.";
  }

  const nextStatusId = await getStatusIdPg(tx, nextStatusCode);

  await tx`
    UPDATE pim_cases
    SET
      current_status_id = ${nextStatusId},
      scrutiny_status = ${data.scrutinyResult},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${numericCaseId}
  `;

  await addStatusHistory(
    tx,
    numericCaseId,
    caseRow.current_status_id,
    nextStatusId,
    reason,
    userId
  );

  const eventId = await getEventIdPg(tx, eventCode);

  await tx`
    INSERT INTO pim_docket (
      case_id,
      docket_date,
      event_type_id,
      entry_text,
      action_required,
      next_date,
      entered_by
    )
    VALUES (
      ${numericCaseId},
      ${officeDate()},
      ${eventId},
      ${docketText},
      ${actionRequired},
      ${data.rectificationDate || null},
      ${userId}
    )
  `;

  /*
   * Critical workflow fix carried over from SQLite: complete the
   * existing SCRUTINY task in the same transaction.
   */
  await completeTaskPg(tx, {
    taskId: pendingScrutinyTask.id,
    completedBy: userId,
    remarks: taskRemarks,
  });

  /*
   * There is no dedicated task type for PIM-number assignment either
   * (same as the old SECRETARY_APPROVAL gap this replaces); the next
   * action is resolved from case status PIM_NUMBER_PENDING - so
   * nextTaskId is always null.
   */
  return {
    caseId: numericCaseId,
    status: nextStatusCode,
    scrutinyResult: data.scrutinyResult,
    completedTaskId: pendingScrutinyTask.id,
    nextTaskId: null,
  };
}

async function saveScrutinyPg(caseId, data, userId = null) {
  const numericCaseId = validateScrutinyInput(caseId, data);

  return withTransaction(async (tx) =>
    saveScrutinyTx(tx, numericCaseId, data, userId)
  );
}

module.exports = {
  validateScrutinyInput,
  saveScrutinyTx,
  saveScrutinyPg,
};
