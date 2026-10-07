const db = require("./db");
const {
  officeDate,
  officeTime,
} = require("./pim-time");

/*
 * Every function below that touches the database takes an optional
 * trailing dbClient parameter, defaulting to the module-level SQLite
 * singleton. This is preparation for a future PostgreSQL transaction
 * client (see docs/phase6-transaction-readiness.md and
 * docs/phase6-batch5b-helper-inventory.md) - it does not change any
 * existing behavior, since every existing caller omits the argument
 * and gets the same `db` singleton as before. dbClient is always a
 * synchronous better-sqlite3-shaped object in this batch; nothing
 * here pretends SQLite and PostgreSQL transactions are interchangeable.
 */

function getStatusId(code, dbClient = db) {
  const row = dbClient
    .prepare(`
      SELECT id
      FROM status_master
      WHERE code = ?
      LIMIT 1
    `)
    .get(code);

  if (!row) {
    throw new Error(`Status '${code}' is missing.`);
  }

  return row.id;
}

function getEventId(code, dbClient = db) {
  const row = dbClient
    .prepare(`
      SELECT id
      FROM event_types
      WHERE code = ?
      LIMIT 1
    `)
    .get(code);

  if (!row) {
    throw new Error(`Event '${code}' is missing.`);
  }

  return row.id;
}

function getCaseForScrutiny(caseId, dbClient = db) {
  const row = dbClient
    .prepare(`
      SELECT
        c.*,
        sm.code AS status_code,
        sm.name AS status_name
      FROM pim_cases c
      LEFT JOIN status_master sm
        ON sm.id = c.current_status_id
      WHERE c.id = ?
      LIMIT 1
    `)
    .get(caseId);

  if (!row) {
    throw new Error("PIM case not found.");
  }

  return row;
}

function getExistingScrutiny(caseId, dbClient = db) {
  return dbClient
    .prepare(`
      SELECT *
      FROM pim_scrutiny
      WHERE case_id = ?
      LIMIT 1
    `)
    .get(caseId);
}

function getPendingTask(
  caseId,
  taskTypeCode,
  dbClient = db
) {
  return dbClient
    .prepare(`
      SELECT
        id,
        status,
        task_type_code
      FROM pim_tasks
      WHERE case_id = ?
        AND task_type_code = ?
        AND status = 'PENDING'
      ORDER BY id
      LIMIT 1
    `)
    .get(
      caseId,
      taskTypeCode
    );
}

function completeTask({
  taskId,
  completedBy,
  remarks,
}, dbClient = db) {
  const updated = dbClient
    .prepare(`
      UPDATE pim_tasks
      SET
        status = 'COMPLETED',
        completed_date = ?,
        completed_time = ?,
        completed_by = ?,
        remarks = ?
      WHERE id = ?
        AND status = 'PENDING'
    `)
    .run(
      officeDate(),
      officeTime(),
      completedBy,
      remarks,
      taskId
    );

  if (updated.changes !== 1) {
    const error = new Error(
      "The pending scrutiny task could not be completed."
    );
    error.statusCode = 409;
    throw error;
  }

  dbClient.prepare(`
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
    taskId,
    "PENDING",
    "COMPLETED",
    completedBy,
    remarks
  );
}

function insertScrutinyAttempt(caseId, scrutiny, dbClient = db) {
  const nextAttemptNo =
    dbClient
      .prepare(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next
         FROM pim_scrutiny_attempts
         WHERE case_id = ?`
      )
      .get(caseId).next;

  dbClient.prepare(`
    INSERT INTO pim_scrutiny_attempts (
      case_id, attempt_no, form1_complete, application_fee_received,
      dd_number, dd_date, dd_bank, dd_amount, dd_payee_correct, dd_valid,
      vakalat_available, opposite_party_address_available,
      commercial_dispute_checked, territorial_jurisdiction_checked,
      supporting_documents_checked, scrutiny_result, defect_details,
      rectification_date, scrutinised_by, scrutinised_at
    )
    VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `).run(
    caseId,
    nextAttemptNo,
    scrutiny.form1_complete ?? null,
    scrutiny.application_fee_received,
    scrutiny.dd_number,
    scrutiny.dd_date,
    scrutiny.dd_bank,
    scrutiny.dd_amount,
    scrutiny.dd_payee_correct,
    scrutiny.dd_valid,
    scrutiny.vakalat_available ?? null,
    scrutiny.opposite_party_address_available,
    scrutiny.commercial_dispute_checked,
    scrutiny.territorial_jurisdiction_checked,
    scrutiny.supporting_documents_checked,
    scrutiny.scrutiny_result,
    scrutiny.defect_details,
    scrutiny.rectification_date,
    scrutiny.scrutinised_by,
    scrutiny.scrutinised_at
  );
}

function saveScrutiny(
  caseId,
  data,
  userId = null,
  dbClient = db
) {
  const numericCaseId =
    Number(caseId);

  if (
    !Number.isInteger(numericCaseId) ||
    numericCaseId <= 0
  ) {
    throw new Error(
      "Valid case ID is required."
    );
  }

  if (
    !data ||
    typeof data !== "object"
  ) {
    throw new Error(
      "Scrutiny data is required."
    );
  }

  if (
    !["COMPLETE", "DEFECT"].includes(
      data.scrutinyResult
    )
  ) {
    throw new Error(
      "Scrutiny result must be COMPLETE or DEFECT."
    );
  }

  const transaction =
    dbClient.transaction(() => {
      /*
       * Re-read inside the transaction.
       * This prevents a second click from using
       * stale browser state.
       */
      const caseRow =
        getCaseForScrutiny(
          numericCaseId,
          dbClient
        );

      if (
        caseRow.status_code !==
          "RECEIVED" &&
        caseRow.status_code !==
          "SCRUTINY_PENDING"
      ) {
        const error = new Error(
          `This case is not available for scrutiny. Current status: ${caseRow.status_name}`
        );
        error.statusCode = 409;
        throw error;
      }

      const pendingScrutinyTask =
        getPendingTask(
          numericCaseId,
          "SCRUTINY",
          dbClient
        );

      if (!pendingScrutinyTask) {
        const error = new Error(
          "Pending SCRUTINY task was not found."
        );
        error.statusCode = 409;
        throw error;
      }

      const ddAmount =
        data.ddAmount === "" ||
        data.ddAmount === null ||
        data.ddAmount === undefined
          ? null
          : Number(data.ddAmount);

      if (
        ddAmount !== null &&
        (
          !Number.isFinite(ddAmount) ||
          ddAmount < 0
        )
      ) {
        throw new Error(
          "DD amount must be a valid non-negative number."
        );
      }

      const scrutiny = {
        application_fee_received:
          data.applicationFeeReceived
            ? 1
            : 0,

        dd_number:
          data.ddNumber
            ? String(
                data.ddNumber
              ).trim()
            : null,

        dd_date:
          data.ddDate || null,

        dd_bank:
          data.ddBank
            ? String(
                data.ddBank
              ).trim()
            : null,

        dd_amount:
          ddAmount,

        dd_payee_correct:
          data.ddPayeeCorrect
            ? 1
            : 0,

        dd_valid:
          data.ddValid
            ? 1
            : 0,

        opposite_party_address_available:
          data.oppositePartyAddressAvailable
            ? 1
            : 0,

        commercial_dispute_checked:
          data.commercialDisputeChecked
            ? 1
            : 0,

        territorial_jurisdiction_checked:
          data.territorialJurisdictionChecked
            ? 1
            : 0,

        supporting_documents_checked:
          data.supportingDocumentsChecked
            ? 1
            : 0,

        scrutiny_result:
          data.scrutinyResult,

        defect_details:
          data.scrutinyResult ===
          "DEFECT"
            ? String(
                data.defectDetails ||
                  ""
              ).trim() ||
              null
            : null,

        rectification_date:
          data.rectificationDate ||
          null,

        scrutinised_by:
          userId,

        scrutinised_at:
          new Date().toISOString(),
      };

      if (
        data.scrutinyResult ===
          "DEFECT" &&
        !scrutiny.defect_details
      ) {
        throw new Error(
          "Defect details are required when scrutiny result is DEFECT."
        );
      }

      const existing =
        getExistingScrutiny(
          numericCaseId,
          dbClient
        );

      if (existing) {
        dbClient.prepare(`
          UPDATE pim_scrutiny
          SET
            application_fee_received = ?,
            dd_number = ?,
            dd_date = ?,
            dd_bank = ?,
            dd_amount = ?,
            dd_payee_correct = ?,
            dd_valid = ?,
            opposite_party_address_available = ?,
            commercial_dispute_checked = ?,
            territorial_jurisdiction_checked = ?,
            supporting_documents_checked = ?,
            scrutiny_result = ?,
            defect_details = ?,
            rectification_date = ?,
            scrutinised_by = ?,
            scrutinised_at = ?
          WHERE case_id = ?
        `).run(
          scrutiny.application_fee_received,
          scrutiny.dd_number,
          scrutiny.dd_date,
          scrutiny.dd_bank,
          scrutiny.dd_amount,
          scrutiny.dd_payee_correct,
          scrutiny.dd_valid,
          scrutiny.opposite_party_address_available,
          scrutiny.commercial_dispute_checked,
          scrutiny.territorial_jurisdiction_checked,
          scrutiny.supporting_documents_checked,
          scrutiny.scrutiny_result,
          scrutiny.defect_details,
          scrutiny.rectification_date,
          scrutiny.scrutinised_by,
          scrutiny.scrutinised_at,
          numericCaseId
        );

        insertScrutinyAttempt(numericCaseId, scrutiny, dbClient);
      } else {
        dbClient.prepare(`
          INSERT INTO pim_scrutiny
          (
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
          VALUES
          (
            ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          numericCaseId,
          scrutiny.application_fee_received,
          scrutiny.dd_number,
          scrutiny.dd_date,
          scrutiny.dd_bank,
          scrutiny.dd_amount,
          scrutiny.dd_payee_correct,
          scrutiny.dd_valid,
          scrutiny.opposite_party_address_available,
          scrutiny.commercial_dispute_checked,
          scrutiny.territorial_jurisdiction_checked,
          scrutiny.supporting_documents_checked,
          scrutiny.scrutiny_result,
          scrutiny.defect_details,
          scrutiny.rectification_date,
          scrutiny.scrutinised_by,
          scrutiny.scrutinised_at
        );

        insertScrutinyAttempt(numericCaseId, scrutiny, dbClient);
      }

      let nextStatusCode;
      let eventCode;
      let docketText;
      let reason;
      let actionRequired;
      let taskRemarks;

      if (
        data.scrutinyResult ===
        "COMPLETE"
      ) {
        nextStatusCode =
          "SECRETARY_APPROVAL_PENDING";

        eventCode =
          "SCRUTINY_COMPLETED";

        docketText =
          "Scrutiny completed and file put up for Secretary approval.";

        reason =
          "Scrutiny completed; file put up for Secretary approval.";

        actionRequired =
          "Secretary approval";

        taskRemarks =
          "Scrutiny completed and file put up for Secretary approval.";
      } else {
        nextStatusCode =
          "DEFECT_PENDING";

        eventCode =
          "DEFECT_NOTED";

        docketText =
          "Defect / rectification required during scrutiny.";

        reason =
          scrutiny.defect_details ||
          "Defect / rectification required.";

        actionRequired =
          "Rectification required";

        taskRemarks =
          "Scrutiny completed with defects requiring rectification.";
      }

      const nextStatusId =
        getStatusId(
          nextStatusCode,
          dbClient
        );

      dbClient.prepare(`
        UPDATE pim_cases
        SET
          current_status_id = ?,
          scrutiny_status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        nextStatusId,
        data.scrutinyResult,
        numericCaseId
      );

      dbClient.prepare(`
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
        numericCaseId,
        caseRow.current_status_id,
        nextStatusId,
        reason,
        userId
      );

      const eventId =
        getEventId(
          eventCode,
          dbClient
        );

      dbClient.prepare(`
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
        numericCaseId,
        officeDate(),
        eventId,
        docketText,
        actionRequired,
        data.rectificationDate ||
          null,
        userId
      );

      /*
       * Critical workflow fix:
       * complete the existing SCRUTINY task
       * in the same transaction.
       */
      completeTask({
        taskId:
          pendingScrutinyTask.id,
        completedBy:
          userId,
        remarks:
          taskRemarks,
      }, dbClient);

      /*
       * There is currently no SECRETARY_APPROVAL
       * task type in task_types.
       *
       * The next action is therefore resolved from
       * case status SECRETARY_APPROVAL_PENDING.
       */
      return {
        caseId:
          numericCaseId,
        status:
          nextStatusCode,
        scrutinyResult:
          data.scrutinyResult,
        completedTaskId:
          pendingScrutinyTask.id,
        nextTaskId:
          null,
      };
    });

  return transaction();
}

function getScrutinyCase(caseId) {
  const caseRow =
    getCaseForScrutiny(
      caseId
    );

  const parties = db
    .prepare(`
      SELECT
        cp.id AS case_party_id,
        cp.party_id,
        cp.role,
        cp.sequence_no,
        cp.is_primary,
        p.name,
        p.entity_type
      FROM pim_case_parties cp
      JOIN pim_parties p
        ON p.id = cp.party_id
      WHERE cp.case_id = ?
      ORDER BY
        CASE
          WHEN cp.role =
            'APPLICANT'
            THEN 1
          WHEN cp.role =
            'OPPOSITE_PARTY'
            THEN 2
          ELSE 3
        END,
        cp.sequence_no
    `)
    .all(caseId);

  for (const party of parties) {
    party.addresses = db
      .prepare(`
        SELECT *
        FROM pim_addresses
        WHERE party_id = ?
        ORDER BY id
      `)
      .all(
        party.party_id
      );

    party.advocates = db
      .prepare(`
        SELECT
          ca.*,
          a.name AS advocate_name,
          a.enrollment_no,
          a.phone,
          a.email,
          a.address
            AS advocate_address
        FROM pim_case_advocates ca
        JOIN pim_advocates a
          ON a.id =
             ca.advocate_id
        WHERE ca.case_id = ?
          AND ca.party_id = ?
          AND ca.to_date IS NULL
        ORDER BY ca.id
      `)
      .all(
        caseId,
        party.party_id
      );
  }

  const fees = db
    .prepare(`
      SELECT *
      FROM pim_fees
      WHERE case_id = ?
      ORDER BY id
    `)
    .all(caseId);

  const documents = db
    .prepare(`
      SELECT *
      FROM pim_documents
      WHERE case_id = ?
      ORDER BY id
    `)
    .all(caseId);

  const scrutiny =
    getExistingScrutiny(
      caseId
    );

  const docket = db
    .prepare(`
      SELECT
        d.*,
        e.code AS event_code,
        e.name AS event_name
      FROM pim_docket d
      LEFT JOIN event_types e
        ON e.id =
           d.event_type_id
      WHERE d.case_id = ?
      ORDER BY d.id DESC
    `)
    .all(caseId);

  return {
    case: caseRow,
    parties,
    fees,
    documents,
    scrutiny,
    docket,
  };
}

module.exports = {
  saveScrutiny,
  getScrutinyCase,
};
