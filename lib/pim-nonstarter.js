/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Centralized Non-Starter service (Phase 5).
 *
 * Single place that:
 *  - knows which of the 5 configured non-starter reasons the
 *    current case facts actually support (so staff can't record
 *    e.g. "Mediation Fee Not Submitted" for a Final-Notice
 *    absence case);
 *  - records the one case-level pim_outcomes row;
 *  - reuses the Phase 4 NONSTARTER_FORM3 handoff task instead of
 *    creating a second one.
 *
 * Form-3 generation/completion and the authority-decision branch
 * remain in their existing routes (app/api/pim/nonstarter/form3
 * and .../authority) - those were already built correctly and are
 * reused as-is, not duplicated here.
 */

const db = require("./db");
const {
  today,
  getStatusId,
  addStatusHistory,
  addDocket,
  getPendingTask,
  createPendingTaskIfNotExists,
} = require("./pim-op-response");

const TERMINAL_STATUS_CODES = new Set([
  "CLOSED_SETTLED",
  "CLOSED_FAILED",
  "CLOSED_NON_STARTER",
  "WITHDRAWN",
]);

/*
 * Reasons Phase 4 already creates a NONSTARTER_FORM3 handoff
 * task for (OP refusal, Final Notice absence/return, alternate-
 * date absence). Recording one of these requires that handoff
 * task to actually exist - it is the proof the underlying case
 * fact was genuinely established, not merely asserted.
 */
const AUTO_TRIGGERED_REASON_CODES = new Set([
  "FINAL_NOTICE_UNACKNOWLEDGED",
  "OP_REFUSED_MEDIATION",
  "OP_FAILED_TO_APPEAR_AFTER_TIME",
]);

/*
 * Reasons with no automatic Phase 4 trigger - staff invokes
 * these directly from an open, non-terminal, pre-outcome case.
 */
const MANUAL_REASON_CODES = new Set([
  "BOTH_PARTIES_NOT_WILLING",
  "MEDIATION_FEE_NOT_SUBMITTED",
]);

/*
 * Every function below that touches the database takes an optional
 * trailing dbClient parameter, defaulting to the module-level SQLite
 * singleton. This is preparation for a future PostgreSQL transaction
 * client (see docs/phase6-transaction-readiness.md and
 * docs/phase6-batch5b-helper-inventory.md) - it does not change any
 * existing behavior, since every existing caller omits the argument
 * and gets the same `db` singleton as before. recordNonStarter never
 * opens its own transaction - it is always called from inside the
 * route's own db.transaction(() => recordNonStarter({...}))(), so the
 * dbClient it receives must be threaded through every nested call
 * exactly as received, never re-defaulted.
 */

function getCase(caseId, dbClient = db) {
  return dbClient
    .prepare(`
      SELECT c.*, s.code AS status_code, s.name AS status_name
      FROM pim_cases c
      LEFT JOIN status_master s ON s.id = c.current_status_id
      WHERE c.id = ?
    `)
    .get(caseId);
}

function getActiveNonStarterReasons() {
  return db
    .prepare(`
      SELECT id, code, name, rule_reference, requires_authority_decision, remarks
      FROM nonstarter_reasons
      WHERE active = 1
      ORDER BY id
    `)
    .all();
}

function getReasonByCode(code, dbClient = db) {
  return dbClient
    .prepare(`
      SELECT id, code, name, rule_reference, requires_authority_decision
      FROM nonstarter_reasons
      WHERE code = ? AND active = 1
    `)
    .get(code);
}

function getReasonById(id, dbClient = db) {
  return dbClient
    .prepare(`
      SELECT id, code, name, rule_reference, requires_authority_decision
      FROM nonstarter_reasons
      WHERE id = ? AND active = 1
    `)
    .get(id);
}

/*
 * Determines which non-starter reason the CURRENT case facts
 * actually support, by reading the same tables Phase 2/3/4 wrote
 * to (pim_responses, pim_service_attempts, pim_notices) - never
 * re-deriving or fabricating a fact.
 *
 * Returns { reasonCode, party, notice, evidence } or
 * { reasonCode: null, ... } when nothing automatic applies (the
 * two manual reasons have no case-fact signature to infer from).
 */
function inferNonStarterContext(caseId, dbClient = db) {
  // 1. An explicit refusal (either the dedicated REFUSED response
  //    type, or APPEARED with consent = 0) - most specific, checked first.
  const refusal = dbClient
    .prepare(`
      SELECT r.*, p.name AS party_name, n.notice_type, n.id AS notice_id
      FROM pim_responses r
      JOIN pim_parties p ON p.id = r.party_id
      LEFT JOIN pim_notices n ON n.id = r.notice_id
      WHERE r.case_id = ?
        AND (r.response_type = 'REFUSED' OR (r.response_type = 'APPEARED' AND r.consent = 0))
      ORDER BY r.id DESC
      LIMIT 1
    `)
    .get(caseId);

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

  // 2. A recorded absence (DID_NOT_APPEAR). Distinguish alternate-date
  //    absence (a SOUGHT_TIME response for the same party exists) from
  //    a Final Notice's own appearance-date absence.
  const absence = dbClient
    .prepare(`
      SELECT r.*, p.name AS party_name, n.notice_type, n.id AS notice_id
      FROM pim_responses r
      JOIN pim_parties p ON p.id = r.party_id
      LEFT JOIN pim_notices n ON n.id = r.notice_id
      WHERE r.case_id = ?
        AND r.response_type = 'DID_NOT_APPEAR'
      ORDER BY r.id DESC
      LIMIT 1
    `)
    .get(caseId);

  if (absence) {
    const soughtTime = dbClient
      .prepare(`
        SELECT id FROM pim_responses
        WHERE case_id = ? AND party_id = ? AND response_type = 'SOUGHT_TIME'
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(caseId, absence.party_id);

    const isAlternateDateAbsence =
      Boolean(soughtTime) && soughtTime.id < absence.id;

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

  // 3. A Final Notice returned by post (no response was ever
  //    possible - the notice never reached the OP).
  const returnedFinal = dbClient
    .prepare(`
      SELECT sa.*, n.id AS notice_id, n.notice_type, n.recipient_party_id, p.name AS party_name
      FROM pim_service_attempts sa
      JOIN pim_notices n ON n.id = sa.notice_id
      LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
      WHERE n.case_id = ?
        AND n.notice_type = 'FORM_2_FINAL'
        AND n.status = 'RETURNED'
      ORDER BY sa.id DESC
      LIMIT 1
    `)
    .get(caseId);

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
 * Records the case-level Non-Starter outcome. Validates:
 *  - reason is one of the 5 configured reasons;
 *  - for auto-triggered reasons, a pending NONSTARTER_FORM3
 *    handoff task actually exists (proof of the underlying fact);
 *  - for auto-triggered reasons, the submitted reason matches
 *    what the case facts actually indicate (no arbitrary mismatch);
 *  - the case isn't already past this stage or terminal;
 *  - no outcome already exists (idempotency / UNIQUE(case_id)).
 * Reuses the existing pending NONSTARTER_FORM3 task rather than
 * creating a duplicate.
 */
function recordNonStarter({ caseId, reasonCode, reasonId, outcomeDate, formNo, remarks, userId }, dbClient = db) {
  const caseData = getCase(caseId, dbClient);

  if (!caseData) {
    throw new Error("PIM case not found.");
  }

  if (TERMINAL_STATUS_CODES.has(caseData.status_code)) {
    throw new Error(
      `This case is already closed (${caseData.status_name}).`
    );
  }

  if (
    caseData.status_code === "OUTCOME_FORM_PENDING" ||
    caseData.status_code === "AUTHORITY_DECISION_PENDING"
  ) {
    throw new Error(
      `A non-starter outcome has already been recorded for this case. Current status: ${caseData.status_name}`
    );
  }

  const existingOutcome = dbClient
    .prepare(`SELECT id FROM pim_outcomes WHERE case_id = ?`)
    .get(caseId);

  if (existingOutcome) {
    throw new Error("An outcome has already been recorded for this case.");
  }

  const reason = reasonId
    ? getReasonById(reasonId, dbClient)
    : getReasonByCode(reasonCode, dbClient);

  if (!reason) {
    throw new Error(
      "Non-starter cannot be recorded because the selected reason is not active or does not exist."
    );
  }

  const context = inferNonStarterContext(caseId, dbClient);

  if (AUTO_TRIGGERED_REASON_CODES.has(reason.code)) {
    const pendingHandoff = getPendingTask(caseId, "NONSTARTER_FORM3", dbClient);

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

  const resolvedOutcomeDate = outcomeDate || today();

  const outcome = dbClient.prepare(`
    INSERT INTO pim_outcomes
    (
      case_id, outcome_type, form_no, outcome_date,
      nonstarter_reason_id, reason_text, settlement_terms,
      prepared_by, verified_by, approved_by, document_id,
      sent_to_applicant, sent_to_opposite_party, remarks
    )
    VALUES (?, 'NON_STARTER', ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 0, 0, ?)
  `).run(
    caseId,
    formNo || null,
    resolvedOutcomeDate,
    reason.id,
    reason.name,
    userId,
    remarks || context.evidence || null
  );

  const outcomeId = Number(outcome.lastInsertRowid);

  const toStatusId = getStatusId("OUTCOME_FORM_PENDING", dbClient);

  addStatusHistory(
    caseId,
    getStatusId(caseData.status_code, dbClient),
    toStatusId,
    `Non-starter outcome recorded: ${reason.code}. Form-3 pending.`,
    userId,
    dbClient
  );

  dbClient.prepare(`
    UPDATE pim_cases
    SET current_status_id = ?, outcome_type = 'NON_STARTER', outcome_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(toStatusId, resolvedOutcomeDate, caseId);

  addDocket(
    caseId,
    "NONSTARTER_RECORDED",
    `Non-starter outcome recorded: ${reason.name}. Form-3 pending.`,
    "Form-3",
    null,
    userId,
    dbClient
  );

  /*
   * Reuse the Phase 4 handoff task if one exists (the normal
   * case for the 3 auto-triggered reasons); only create a new
   * one for the 2 manually-invoked reasons that have no
   * automatic handoff.
   */
  const form3TaskId = createPendingTaskIfNotExists(
    caseId,
    "NONSTARTER_FORM3",
    "Prepare Form-3 Non-Starter Report.",
    resolvedOutcomeDate,
    `Non-starter reason: ${reason.name}.`,
    dbClient
  );

  return {
    caseId,
    outcomeId,
    outcomeType: "NON_STARTER",
    outcomeDate: resolvedOutcomeDate,
    nonstarterReasonId: reason.id,
    nonstarterReasonCode: reason.code,
    requiresAuthorityDecision: reason.requires_authority_decision === 1,
    form3TaskId,
    statusCode: "OUTCOME_FORM_PENDING",
  };
}

module.exports = {
  TERMINAL_STATUS_CODES,
  AUTO_TRIGGERED_REASON_CODES,
  MANUAL_REASON_CODES,
  getCase,
  getActiveNonStarterReasons,
  getReasonByCode,
  getReasonById,
  inferNonStarterContext,
  recordNonStarter,
};
