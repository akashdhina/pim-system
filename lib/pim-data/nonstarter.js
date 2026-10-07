/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5D's migrated mutation:
 * non-starter outcome recording (transaction T7 in
 * docs/phase6-transaction-readiness.md) - lib/pim-nonstarter.js's
 * recordNonStarter(), matched statement-for-statement and error-
 * message-for-error-message. See docs/phase6-batch5d-nonstarter-migration.md
 * for the full mapping.
 *
 * Runs entirely inside one withTransaction(...) callback - every
 * statement uses the transaction-scoped `tx` client (directly, or via
 * lib/pim-data/workflow-helpers.js, which also only ever uses the `tx`
 * it's given). Nothing in this file reads or writes SQLite.
 *
 * Unlike the SQLite version (which does not own its own transaction -
 * app/api/pim/nonstarter/[id]/route.js wraps it in
 * db.transaction(() => recordNonStarter(...))()), this Postgres version
 * DOES own its transaction directly via withTransaction(), matching the
 * shape already established by lib/pim-data/intake.js in Batch 5C. The
 * externally observable atomicity is identical either way - everything
 * still commits or rolls back as one unit - only which layer calls
 * "begin the transaction" differs, and that is purely an internal
 * organizational choice, not a behavior change.
 */

const { withTransaction } = require("../pim-postgres");
const { officeDate } = require("../pim-time");
const {
  getStatusId,
  addStatusHistory,
  addDocket,
  getPendingTask,
  createPendingTaskIfNotExists,
} = require("./workflow-helpers");

const TERMINAL_STATUS_CODES = new Set([
  "CLOSED_SETTLED",
  "CLOSED_FAILED",
  "CLOSED_NON_STARTER",
  "WITHDRAWN",
]);

/*
 * Reasons Phase 4 already creates a NONSTARTER_FORM3 handoff task for
 * (OP refusal, Final Notice absence/return, alternate-date absence).
 * Recording one of these requires that handoff task to actually
 * exist - it is the proof the underlying case fact was genuinely
 * established, not merely asserted.
 */
const AUTO_TRIGGERED_REASON_CODES = new Set([
  "FINAL_NOTICE_UNACKNOWLEDGED",
  "OP_REFUSED_MEDIATION",
  "OP_FAILED_TO_APPEAR_AFTER_TIME",
]);

/*
 * Reasons with no automatic Phase 4 trigger - staff invokes these
 * directly from an open, non-terminal, pre-outcome case.
 */
const MANUAL_REASON_CODES = new Set([
  "BOTH_PARTIES_NOT_WILLING",
  "MEDIATION_FEE_NOT_SUBMITTED",
]);

/*
 * Determines which non-starter reason the CURRENT case facts actually
 * support, by reading the same tables Phase 2/3/4 wrote to
 * (pim_responses, pim_service_attempts, pim_notices) - never
 * re-deriving or fabricating a fact. Matches
 * lib/pim-nonstarter.js's inferNonStarterContext() exactly, including
 * its 3-branch precedence order.
 *
 * pim_responses.consent is `smallint` in the live PostgreSQL schema
 * (verified - not boolean, unlike is_primary/is_current elsewhere),
 * so the `r.consent = 0` comparison below is unchanged from SQLite,
 * not a boolean-conversion hack.
 */
async function inferNonStarterContextPg(tx, caseId) {
  const [refusal] = await tx`
    SELECT r.*, p.name AS party_name, n.notice_type, n.id AS notice_id
    FROM pim_responses r
    JOIN pim_parties p ON p.id = r.party_id
    LEFT JOIN pim_notices n ON n.id = r.notice_id
    WHERE r.case_id = ${caseId}
      AND (r.response_type = 'REFUSED' OR (r.response_type = 'APPEARED' AND r.consent = 0))
    ORDER BY r.id DESC
    LIMIT 1
  `;

  if (refusal) {
    return {
      reasonCode: "OP_REFUSED_MEDIATION",
      party: { id: refusal.party_id, name: refusal.party_name },
      notice: refusal.notice_id
        ? { id: refusal.notice_id, notice_type: refusal.notice_type }
        : null,
      evidence: `Opposite party ${refusal.party_name} refused mediation (response #${refusal.id}, ${refusal.response_date}).`,
    };
  }

  const [absence] = await tx`
    SELECT r.*, p.name AS party_name, n.notice_type, n.id AS notice_id
    FROM pim_responses r
    JOIN pim_parties p ON p.id = r.party_id
    LEFT JOIN pim_notices n ON n.id = r.notice_id
    WHERE r.case_id = ${caseId}
      AND r.response_type = 'DID_NOT_APPEAR'
    ORDER BY r.id DESC
    LIMIT 1
  `;

  if (absence) {
    const [soughtTime] = await tx`
      SELECT id FROM pim_responses
      WHERE case_id = ${caseId} AND party_id = ${absence.party_id} AND response_type = 'SOUGHT_TIME'
      ORDER BY id DESC
      LIMIT 1
    `;

    const isAlternateDateAbsence = Boolean(soughtTime) && soughtTime.id < absence.id;

    return {
      reasonCode: isAlternateDateAbsence
        ? "OP_FAILED_TO_APPEAR_AFTER_TIME"
        : "FINAL_NOTICE_UNACKNOWLEDGED",
      party: { id: absence.party_id, name: absence.party_name },
      notice: absence.notice_id
        ? { id: absence.notice_id, notice_type: absence.notice_type }
        : null,
      evidence: isAlternateDateAbsence
        ? `Opposite party ${absence.party_name} did not appear on the alternate date (response #${absence.id}, ${absence.response_date}).`
        : `Opposite party ${absence.party_name} did not appear / no response received (response #${absence.id}, ${absence.response_date}).`,
    };
  }

  const [returnedFinal] = await tx`
    SELECT sa.*, n.id AS notice_id, n.notice_type, n.recipient_party_id, p.name AS party_name
    FROM pim_service_attempts sa
    JOIN pim_notices n ON n.id = sa.notice_id
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    WHERE n.case_id = ${caseId}
      AND n.notice_type = 'FORM_2_FINAL'
      AND n.status = 'RETURNED'
    ORDER BY sa.id DESC
    LIMIT 1
  `;

  if (returnedFinal) {
    return {
      reasonCode: "FINAL_NOTICE_UNACKNOWLEDGED",
      party: { id: returnedFinal.recipient_party_id, name: returnedFinal.party_name },
      notice: { id: returnedFinal.notice_id, notice_type: returnedFinal.notice_type },
      evidence: `Final Notice returned (${returnedFinal.return_reason || "postal failure"}); remained unacknowledged.`,
    };
  }

  return { reasonCode: null, party: null, notice: null, evidence: null };
}

/*
 * Records the case-level Non-Starter outcome. Validates, in the exact
 * order lib/pim-nonstarter.js's recordNonStarter does:
 *  - case exists and is not terminal / not already past this stage;
 *  - no outcome already exists (idempotency - also backed by the live
 *    pim_outcomes.case_id UNIQUE constraint, verified);
 *  - reason is one of the 5 configured reasons;
 *  - for auto-triggered reasons, a pending NONSTARTER_FORM3 handoff
 *    task actually exists, and the submitted reason matches what the
 *    case facts actually indicate.
 * Reuses the existing pending NONSTARTER_FORM3 task rather than
 * creating a duplicate - same dedup pattern, same unresolved
 * concurrency gap, as lib/pim-data/workflow-helpers.js documents.
 */
async function recordNonStarterPg({ caseId, reasonCode, reasonId, outcomeDate, formNo, remarks, userId }) {
  return withTransaction(async (tx) => {
    const [caseData] = await tx`
      SELECT c.*, s.code AS status_code, s.name AS status_name
      FROM pim_cases c
      LEFT JOIN status_master s ON s.id = c.current_status_id
      WHERE c.id = ${caseId}
    `;

    if (!caseData) {
      throw new Error("PIM case not found.");
    }

    if (TERMINAL_STATUS_CODES.has(caseData.status_code)) {
      throw new Error(`This case is already closed (${caseData.status_name}).`);
    }

    if (
      caseData.status_code === "OUTCOME_FORM_PENDING" ||
      caseData.status_code === "AUTHORITY_DECISION_PENDING"
    ) {
      throw new Error(
        `A non-starter outcome has already been recorded for this case. Current status: ${caseData.status_name}`
      );
    }

    const [existingOutcome] = await tx`SELECT id FROM pim_outcomes WHERE case_id = ${caseId}`;

    if (existingOutcome) {
      throw new Error("An outcome has already been recorded for this case.");
    }

    const [reason] = reasonId
      ? await tx`
          SELECT id, code, name, rule_reference, requires_authority_decision
          FROM nonstarter_reasons
          WHERE id = ${reasonId} AND active = true
        `
      : await tx`
          SELECT id, code, name, rule_reference, requires_authority_decision
          FROM nonstarter_reasons
          WHERE code = ${reasonCode} AND active = true
        `;

    if (!reason) {
      throw new Error(
        "Non-starter cannot be recorded because the selected reason is not active or does not exist."
      );
    }

    const context = await inferNonStarterContextPg(tx, caseId);

    if (AUTO_TRIGGERED_REASON_CODES.has(reason.code)) {
      const pendingHandoff = await getPendingTask(tx, caseId, "NONSTARTER_FORM3");

      if (!pendingHandoff) {
        throw new Error(
          `Non-starter reason "${reason.name}" requires an existing case-fact handoff (pending NONSTARTER_FORM3 task), and none was found for this case.`
        );
      }

      if (context.reasonCode && context.reasonCode !== reason.code) {
        throw new Error(
          `The recorded case facts indicate "${context.reasonCode}", not "${reason.code}". Select the reason matching what actually happened.`
        );
      }
    } else if (!MANUAL_REASON_CODES.has(reason.code)) {
      throw new Error(`Unsupported non-starter reason: ${reason.code}`);
    }

    const resolvedOutcomeDate = outcomeDate || officeDate();

    const [outcome] = await tx`
      INSERT INTO pim_outcomes (
        case_id, outcome_type, form_no, outcome_date,
        nonstarter_reason_id, reason_text, settlement_terms,
        prepared_by, verified_by, approved_by, document_id,
        sent_to_applicant, sent_to_opposite_party, remarks
      )
      VALUES (
        ${caseId}, 'NON_STARTER', ${formNo || null}, ${resolvedOutcomeDate},
        ${reason.id}, ${reason.name}, NULL,
        ${userId}, NULL, NULL, NULL,
        false, false, ${remarks || context.evidence || null}
      )
      RETURNING id
    `;

    const outcomeId = outcome.id;

    const toStatusId = await getStatusId(tx, "OUTCOME_FORM_PENDING");
    const fromStatusId = await getStatusId(tx, caseData.status_code);

    await addStatusHistory(
      tx,
      caseId,
      fromStatusId,
      toStatusId,
      `Non-starter outcome recorded: ${reason.code}. Form-3 pending.`,
      userId
    );

    await tx`
      UPDATE pim_cases
      SET current_status_id = ${toStatusId},
          outcome_type = 'NON_STARTER',
          outcome_date = ${resolvedOutcomeDate},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${caseId}
    `;

    await addDocket(
      tx,
      caseId,
      "NONSTARTER_RECORDED",
      `Non-starter outcome recorded: ${reason.name}. Form-3 pending.`,
      "Form-3",
      null,
      userId
    );

    const form3TaskId = await createPendingTaskIfNotExists(
      tx,
      caseId,
      "NONSTARTER_FORM3",
      "Prepare Form-3 Non-Starter Report.",
      resolvedOutcomeDate,
      `Non-starter reason: ${reason.name}.`
    );

    return {
      caseId,
      outcomeId,
      outcomeType: "NON_STARTER",
      outcomeDate: resolvedOutcomeDate,
      nonstarterReasonId: reason.id,
      nonstarterReasonCode: reason.code,
      requiresAuthorityDecision: reason.requires_authority_decision === true,
      form3TaskId,
      statusCode: "OUTCOME_FORM_PENDING",
    };
  });
}

/*
 * PostgreSQL port of app/api/pim/nonstarter/form3/[id]/route.js's
 * db.transaction body (production-completion sprint, 2026-10-07). Matches
 * the SQLite version's validation order and branching exactly: document
 * must already exist (never silently generated here), task must be the
 * genuine pending NONSTARTER_FORM3 handoff, and the terminal branch
 * (authority decision required vs. direct closure) is unchanged.
 *
 * requires_authority_decision is a real PostgreSQL boolean here (unlike
 * SQLite's 0/1) - compared with `=== true`, not `=== 1`.
 */
async function validateForm3DocumentTx(tx, documentId, caseId) {
  const [document] = await tx`
    SELECT id, case_id, document_type, file_path, version_no, is_current
    FROM pim_documents
    WHERE id = ${documentId} AND case_id = ${caseId} AND document_type = 'FORM_3' AND is_current = true
  `;
  if (!document) {
    throw new Error("The supplied Form-3 document was not found for this PIM case.");
  }
  return document;
}

async function completeNonStarterForm3Tx(tx, caseId, { documentId = null, remarks = null }, userId) {
  const [caseData] = await tx`
    SELECT c.id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseData) throw new Error("PIM case not found.");

  if (caseData.status_code !== "OUTCOME_FORM_PENDING") {
    throw new Error(`Case is not currently pending Form-3 completion. Current status: ${caseData.status_name}`);
  }

  const [outcome] = await tx`
    SELECT o.*, nr.code AS reason_code, nr.name AS reason_name, nr.requires_authority_decision
    FROM pim_outcomes o JOIN nonstarter_reasons nr ON nr.id = o.nonstarter_reason_id
    WHERE o.case_id = ${caseId} AND o.outcome_type = 'NON_STARTER'
  `;
  if (!outcome) throw new Error("Non-starter outcome record was not found.");

  const pendingTask = await getPendingTask(tx, caseId, "NONSTARTER_FORM3");
  if (!pendingTask) throw new Error("Pending NONSTARTER_FORM3 task was not found.");

  let document;
  if (documentId !== null) {
    document = await validateForm3DocumentTx(tx, documentId, caseId);
  } else {
    const [existingDocument] = await tx`
      SELECT id FROM pim_documents
      WHERE case_id = ${caseId} AND document_type = 'FORM_3' AND is_current = true
      ORDER BY version_no DESC, id DESC LIMIT 1
    `;
    if (!existingDocument) {
      throw new Error("A current Form-3 document must be generated before completion.");
    }
    document = await validateForm3DocumentTx(tx, existingDocument.id, caseId);
  }

  if (remarks) {
    await tx`UPDATE pim_documents SET remarks = ${remarks} WHERE id = ${document.id}`;
  }

  await tx`
    UPDATE pim_outcomes
    SET document_id = ${document.id}, remarks = COALESCE(${remarks}, remarks)
    WHERE id = ${outcome.id}
  `;

  const updatedTask = await tx`
    UPDATE pim_tasks
    SET status = 'COMPLETED', completed_date = ${officeDate()}, completed_by = ${userId}, remarks = 'Form-3 Non-Starter Report completed.'
    WHERE id = ${pendingTask.id} AND status = 'PENDING'
    RETURNING id
  `;
  if (updatedTask.length !== 1) {
    throw new Error("Pending NONSTARTER_FORM3 task was not found.");
  }
  await tx`
    INSERT INTO pim_task_history (task_id, old_status, new_status, changed_by, remarks)
    VALUES (${pendingTask.id}, 'PENDING', 'COMPLETED', ${userId}, 'Form-3 Non-Starter Report completed.')
  `;

  await addDocket(
    tx, caseId, "FORM3",
    `Form-3 Non-Starter Report completed for ${outcome.reason_name}.`,
    outcome.requires_authority_decision === true ? "Authority decision" : "Case closure",
    null, userId
  );

  if (outcome.requires_authority_decision === true) {
    const authorityPendingId = await getStatusId(tx, "AUTHORITY_DECISION_PENDING");
    const currentStatusId = await getStatusId(tx, "OUTCOME_FORM_PENDING");

    await addStatusHistory(
      tx, caseId, currentStatusId, authorityPendingId,
      `Form-3 completed. Authority decision required for non-starter reason ${outcome.reason_code}.`, userId
    );
    await tx`UPDATE pim_cases SET current_status_id = ${authorityPendingId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

    const authorityTaskId = await createPendingTaskIfNotExists(
      tx, caseId, "NONSTARTER_AUTHORITY", "Authority decision for non-starter closure",
      outcome.outcome_date, `Form-3 completed. Authority decision required for ${outcome.reason_name}.`
    );

    return {
      caseId, outcomeId: outcome.id, form3TaskId: pendingTask.id, documentId: document.id,
      authorityTaskId, statusCode: "AUTHORITY_DECISION_PENDING",
    };
  }

  const currentStatusId = await getStatusId(tx, "OUTCOME_FORM_PENDING");
  const finalStatusId = await getStatusId(tx, "CLOSED_NON_STARTER");

  await addStatusHistory(
    tx, caseId, currentStatusId, finalStatusId,
    `Form-3 completed and non-starter case closed: ${outcome.reason_name}.`, userId
  );
  await tx`UPDATE pim_cases SET current_status_id = ${finalStatusId}, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

  await addDocket(tx, caseId, "CLOSURE", `PIM case closed as NON_STARTER. Reason: ${outcome.reason_name}.`, null, null, userId);

  return {
    caseId, outcomeId: outcome.id, form3TaskId: pendingTask.id, documentId: document.id,
    authorityTaskId: null, statusCode: "CLOSED_NON_STARTER",
  };
}

async function completeNonStarterForm3Pg(caseId, input, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) {
    throw new Error("Valid case ID is required.");
  }
  return withTransaction((tx) => completeNonStarterForm3Tx(tx, numericCaseId, input, userId));
}

/*
 * PostgreSQL port of app/api/pim/nonstarter/authority/[id]/route.js's
 * db.transaction body - the authority decision that closes an
 * AUTHORITY_DECISION_PENDING case as CLOSED_NON_STARTER. Case row locked
 * first, same pattern as every other mutation in this module.
 */
async function recordNonStarterAuthorityDecisionTx(tx, caseId, { remarks = null }, userId) {
  const [caseData] = await tx`
    SELECT c.id, c.current_status_id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseData) throw new Error("PIM case not found.");

  if (caseData.status_code !== "AUTHORITY_DECISION_PENDING") {
    throw new Error(`Case is not pending authority decision. Current status: ${caseData.status_name}`);
  }

  const [outcome] = await tx`
    SELECT o.*, nr.code AS reason_code, nr.name AS reason_name, nr.requires_authority_decision
    FROM pim_outcomes o JOIN nonstarter_reasons nr ON nr.id = o.nonstarter_reason_id
    WHERE o.case_id = ${caseId} AND o.outcome_type = 'NON_STARTER'
  `;
  if (!outcome) throw new Error("Non-starter outcome was not found.");
  if (outcome.approved_by) throw new Error("Authority decision has already been recorded.");
  if (outcome.requires_authority_decision !== true) {
    throw new Error("This non-starter reason does not require authority decision.");
  }
  if (!outcome.document_id) throw new Error("Form-3 document must be completed first.");

  const [document] = await tx`
    SELECT id FROM pim_documents
    WHERE id = ${outcome.document_id} AND case_id = ${caseId} AND document_type = 'FORM_3' AND is_current = true
  `;
  if (!document) throw new Error("Current Form-3 document was not found.");

  const authorityTask = await getPendingTask(tx, caseId, "NONSTARTER_AUTHORITY");
  if (!authorityTask) throw new Error("Pending NONSTARTER_AUTHORITY task was not found.");

  const updatedTask = await tx`
    UPDATE pim_tasks
    SET status = 'COMPLETED', completed_date = ${officeDate()}, completed_by = ${userId},
        remarks = ${remarks || "Authority decision recorded."}
    WHERE id = ${authorityTask.id} AND status = 'PENDING'
    RETURNING id
  `;
  if (updatedTask.length !== 1) throw new Error("Pending NONSTARTER_AUTHORITY task was not found.");

  await tx`
    INSERT INTO pim_task_history (task_id, old_status, new_status, changed_by, remarks)
    VALUES (${authorityTask.id}, 'PENDING', 'COMPLETED', ${userId}, ${remarks || "Authority decision recorded."})
  `;

  await tx`
    UPDATE pim_outcomes
    SET approved_by = ${userId}, remarks = COALESCE(${remarks}, remarks)
    WHERE id = ${outcome.id}
  `;

  const closedStatusId = await getStatusId(tx, "CLOSED_NON_STARTER");

  await addStatusHistory(
    tx, caseId, caseData.current_status_id, closedStatusId,
    remarks || `Authority approved non-starter closure: ${outcome.reason_code}.`, userId
  );

  await tx`UPDATE pim_cases SET current_status_id = ${closedStatusId}, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

  await addDocket(
    tx, caseId, "AUTHORITY_DECISION",
    remarks || `Authority decision recorded for non-starter reason: ${outcome.reason_name}.`, null, null, userId
  );
  await addDocket(
    tx, caseId, "CLOSURE",
    `PIM case closed as NON_STARTER after authority decision. Reason: ${outcome.reason_name}.`, null, null, userId
  );

  return {
    caseId, outcomeId: outcome.id, authorityTaskId: authorityTask.id,
    documentId: outcome.document_id, statusCode: "CLOSED_NON_STARTER",
  };
}

async function recordNonStarterAuthorityDecisionPg(caseId, input, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) {
    throw new Error("Valid case ID is required.");
  }
  return withTransaction((tx) => recordNonStarterAuthorityDecisionTx(tx, numericCaseId, input, userId));
}

module.exports = {
  TERMINAL_STATUS_CODES,
  AUTO_TRIGGERED_REASON_CODES,
  MANUAL_REASON_CODES,
  inferNonStarterContextPg,
  recordNonStarterPg,
  completeNonStarterForm3Tx,
  completeNonStarterForm3Pg,
  recordNonStarterAuthorityDecisionTx,
  recordNonStarterAuthorityDecisionPg,
};
