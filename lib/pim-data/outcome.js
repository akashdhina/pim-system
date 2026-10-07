/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL port of the mediation outcome / terminal closure workflow
 * (production-completion sprint, 2026-10-07):
 * app/api/pim/outcome/[id]/route.js (record SETTLED/FAILED/WITHDRAWN) and
 * app/api/pim/outcome/approve/[id]/route.js (approve + close). See
 * docs/phase6-outcome-closure-migration.md.
 *
 * Matches the SQLite originals statement-for-statement. In particular,
 * preserved exactly as found, not "fixed":
 *   - recordOutcomeTx's addStatusHistory only fires when
 *     status_code !== 'OUTCOME_FORM_PENDING', which can never be true
 *     given the entry guard a few lines above requires exactly that
 *     status - dead code in the original, kept dead here rather than
 *     removed, per "preserve business semantics, don't redesign."
 *   - approveOutcomeTx requires a current FORM_4 (SETTLED) or FORM_5
 *     (FAILED) document to already exist before allowing closure - this
 *     module never generates one itself (document generation is a
 *     separate, not-yet-migrated batch).
 *   - NON_STARTER is explicitly out of scope here (rejected by
 *     recordOutcomeTx with the same message) - it has its own dedicated
 *     workflow (lib/pim-data/nonstarter.js).
 */

const { withTransaction, getSql } = require("../pim-postgres");
const { officeDate, officeTime } = require("../pim-time");
const { getStatusId, addStatusHistory, addDocket } = require("./workflow-helpers");

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function getCompletedSessionSummaryTx(tx, caseId) {
  const [row] = await tx`
    SELECT
      COUNT(*)::int AS total_sittings,
      SUM(CASE WHEN effective_session = true THEN 1 ELSE 0 END)::int AS effective_sittings,
      COALESCE(SUM(CASE WHEN effective_session = true THEN COALESCE(duration_minutes, 0) ELSE 0 END), 0)::int AS effective_duration_minutes,
      MAX(actual_date) AS last_actual_date
    FROM mediation_sessions
    WHERE case_id = ${caseId} AND session_status = 'COMPLETED'
  `;
  return row;
}

// ---------------------------------------------------------------------
// Record outcome (SETTLED / FAILED / WITHDRAWN)
// ---------------------------------------------------------------------

async function recordOutcomeTx(tx, caseId, input, userId) {
  const {
    outcomeType: rawOutcomeType, outcomeDate: rawOutcomeDate = null,
    reasonText = null, settlementTerms = null, formNo = null, remarks = null,
  } = input;

  const outcomeType = rawOutcomeType ? String(rawOutcomeType).trim().toUpperCase() : "";
  const outcomeDate = rawOutcomeDate ? String(rawOutcomeDate).trim() : officeDate();

  if (!["SETTLED", "FAILED", "WITHDRAWN"].includes(outcomeType)) {
    throw new Error("Invalid outcome type. Allowed values: SETTLED, FAILED, WITHDRAWN.");
  }
  if (!outcomeDate || !isIsoDate(outcomeDate)) {
    throw new Error("Outcome date is required in YYYY-MM-DD format.");
  }
  if (outcomeDate > officeDate()) {
    throw new Error("Outcome date cannot be in the future.");
  }

  const [caseRow] = await tx`
    SELECT c.id, c.pim_number, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (caseRow.status_code !== "OUTCOME_FORM_PENDING") {
    throw new Error(`This case is not currently available for outcome recording. Current status: ${caseRow.status_name}`);
  }

  const [existingOutcome] = await tx`SELECT id FROM pim_outcomes WHERE case_id = ${caseId}`;
  if (existingOutcome) throw new Error("An outcome has already been recorded for this case.");

  if (outcomeType === "NON_STARTER") {
    throw new Error("NON_STARTER must be recorded through the dedicated non-starter workflow.");
  }

  const sessionSummary = await getCompletedSessionSummaryTx(tx, caseId);
  if (Number(sessionSummary.total_sittings) < 1) {
    throw new Error("Outcome cannot be recorded before at least one mediation session is completed.");
  }
  if (sessionSummary.last_actual_date && outcomeDate < sessionSummary.last_actual_date) {
    throw new Error("Outcome date cannot be before the last recorded actual mediation date.");
  }

  if (outcomeType === "SETTLED" && !settlementTerms) {
    throw new Error("Settlement terms are required for a SETTLED outcome.");
  }
  if (outcomeType === "FAILED" && !reasonText) {
    throw new Error("Failure reason/details are required for a FAILED outcome.");
  }
  if (outcomeType === "WITHDRAWN" && !reasonText) {
    throw new Error("Withdrawal party/source and reason/details are required for a WITHDRAWN outcome.");
  }

  const [outcome] = await tx`
    INSERT INTO pim_outcomes
      (case_id, outcome_type, form_no, outcome_date, nonstarter_reason_id, reason_text, settlement_terms, prepared_by, verified_by, approved_by, document_id, sent_to_applicant, sent_to_opposite_party, remarks)
    VALUES
      (${caseId}, ${outcomeType}, ${formNo}, ${outcomeDate}, NULL, ${reasonText}, ${settlementTerms}, ${userId}, NULL, NULL, NULL, false, false, ${remarks})
    RETURNING id
  `;

  const toStatusId = await getStatusId(tx, "OUTCOME_FORM_PENDING");

  // Preserved verbatim from the SQLite original: this condition can
  // never be true given the entry guard above already requires
  // status_code === 'OUTCOME_FORM_PENDING' - dead code kept dead.
  if (caseRow.status_code !== "OUTCOME_FORM_PENDING") {
    const fromStatusId = await getStatusId(tx, "MEDIATION_ONGOING");
    await addStatusHistory(tx, caseId, fromStatusId, toStatusId, `Mediation outcome recorded as ${outcomeType}; outcome form pending.`, userId);
  }

  await tx`UPDATE pim_cases SET current_status_id = ${toStatusId}, outcome_type = ${outcomeType}, outcome_date = ${outcomeDate}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

  await addDocket(
    tx, caseId, outcomeType === "SETTLED" ? "FORM4" : outcomeType === "WITHDRAWN" ? "WITHDRAWAL" : "FORM5",
    `Mediation outcome recorded: ${outcomeType}. Outcome form pending.`,
    "Outcome approval", null, userId
  );

  // The pending OUTCOME_FORM task deliberately stays PENDING here
  // (matches the SQLite original) - it is only completed once the
  // required document exists AND the case is closed via approveOutcomeTx.
  const [pendingOutcomeTask] = await tx`
    SELECT id FROM pim_tasks WHERE case_id = ${caseId} AND status = 'PENDING' AND task_type_code = 'OUTCOME_FORM' ORDER BY id DESC LIMIT 1
  `;

  return {
    caseId, outcomeId: outcome.id, outcomeType, outcomeDate, formNo,
    nonstarterReasonId: null, taskId: pendingOutcomeTask ? pendingOutcomeTask.id : null, statusCode: "OUTCOME_FORM_PENDING",
  };
}

async function recordOutcomePg(caseId, input, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) throw new Error("Valid case ID is required.");
  return withTransaction((tx) => recordOutcomeTx(tx, numericCaseId, input, userId));
}

// ---------------------------------------------------------------------
// Approve outcome -> terminal closure
// ---------------------------------------------------------------------

async function approveOutcomeTx(tx, caseId, { remarks = null }, userId) {
  const [caseRow] = await tx`
    SELECT c.*, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (caseRow.status_code !== "OUTCOME_FORM_PENDING") {
    return { conflict: true, message: `This case is not currently pending outcome approval. Current status: ${caseRow.status_name}` };
  }

  const [outcome] = await tx`SELECT * FROM pim_outcomes WHERE case_id = ${caseId}`;
  if (!outcome) throw new Error("No mediation outcome has been recorded for this case.");

  if (outcome.outcome_type === "NON_STARTER") {
    if (!outcome.nonstarter_reason_id) throw new Error("Non-starter reason is missing.");
    const [reason] = await tx`SELECT id, name, requires_authority_decision FROM nonstarter_reasons WHERE id = ${outcome.nonstarter_reason_id}`;
    if (!reason) throw new Error("Configured non-starter reason was not found.");
    if (reason.requires_authority_decision === true) {
      throw new Error("This non-starter outcome requires an authority decision before closure.");
    }
  }

  if (outcome.outcome_type === "SETTLED" || outcome.outcome_type === "FAILED") {
    const requiredDocumentType = outcome.outcome_type === "SETTLED" ? "FORM_4" : "FORM_5";
    const [currentDocument] = await tx`
      SELECT id, file_path, render_data FROM pim_documents
      WHERE case_id = ${caseId} AND document_type = ${requiredDocumentType} AND is_current = true
      ORDER BY version_no DESC, id DESC LIMIT 1
    `;
    // A document counts as generated under EITHER model: the legacy
    // local-file write (file_path) or the no-storage render_data
    // snapshot (lib/pim-data/outcome-documents.js, the only path new
    // Postgres cases use) - never just file_path, which outcome
    // documents generated through the current Postgres path never set.
    if (!currentDocument || (!currentDocument.file_path && !currentDocument.render_data)) {
      throw new Error(`${requiredDocumentType === "FORM_4" ? "Form IV (Settlement)" : "Form V (Failure Report)"} must be generated before this case can be closed.`);
    }
  }

  let finalStatusCode;
  switch (outcome.outcome_type) {
    case "SETTLED": finalStatusCode = "CLOSED_SETTLED"; break;
    case "FAILED": finalStatusCode = "CLOSED_FAILED"; break;
    case "WITHDRAWN": finalStatusCode = "WITHDRAWN"; break;
    case "NON_STARTER": finalStatusCode = "CLOSED_NON_STARTER"; break;
    default: throw new Error(`Unsupported outcome type: ${outcome.outcome_type}`);
  }

  const finalStatusId = await getStatusId(tx, finalStatusCode);
  const currentStatusId = await getStatusId(tx, "OUTCOME_FORM_PENDING");

  await tx`
    UPDATE pim_outcomes
    SET verified_by = ${outcome.verified_by || userId}, approved_by = ${userId}, remarks = COALESCE(${remarks}, remarks)
    WHERE id = ${outcome.id}
  `;

  await addStatusHistory(tx, caseId, currentStatusId, finalStatusId, `Outcome form approved and case closed as ${outcome.outcome_type}.`, userId);

  await tx`UPDATE pim_cases SET current_status_id = ${finalStatusId}, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

  const pendingTasks = await tx`
    SELECT id FROM pim_tasks
    WHERE case_id = ${caseId} AND status = 'PENDING' AND (task_type_code = 'OUTCOME_FORM' OR description LIKE '%outcome form%')
  `;
  for (const task of pendingTasks) {
    await tx`
      UPDATE pim_tasks SET status = 'COMPLETED', completed_date = ${officeDate()}, completed_time = ${officeTime()}, completed_by = ${userId}, remarks = 'Outcome form approved and case closed.'
      WHERE id = ${task.id}
    `;
    await tx`
      INSERT INTO pim_task_history (task_id, old_status, new_status, changed_by, remarks)
      VALUES (${task.id}, 'PENDING', 'COMPLETED', ${userId}, 'Outcome form approved and case closed.')
    `;
  }

  await addDocket(tx, caseId, "FORM5", `PIM case closed as ${outcome.outcome_type}. Outcome form approved.`, null, null, userId);

  return {
    caseId, pimNumber: caseRow.pim_number, outcomeId: outcome.id, outcomeType: outcome.outcome_type,
    finalStatusCode, closedDate: officeDate(),
  };
}

async function approveOutcomePg(caseId, input, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) throw new Error("Valid case ID is required.");
  return withTransaction((tx) => approveOutcomeTx(tx, numericCaseId, input, userId));
}

// ---------------------------------------------------------------------
// Read loaders
// ---------------------------------------------------------------------

async function getOutcomeDataPg(caseId) {
  const sql = getSql();

  const [caseRow] = await sql`
    SELECT c.*, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;
  if (!caseRow) return null;

  const [outcome, parties, assignment, sessions, sessionSummary, lastEffectiveSession, activeUsers, nonstarterReasons, tasks, documents] = await Promise.all([
    sql`
      SELECT o.*, vu.display_name AS verified_by_name, vu.designation AS verified_by_designation,
             au.display_name AS approved_by_name, au.designation AS approved_by_designation,
             d.document_title, d.document_type, d.document_date, d.version_no AS document_version_no,
             CASE WHEN d.file_path IS NOT NULL AND d.file_path <> '' THEN 1 ELSE 0 END AS document_has_file
      FROM pim_outcomes o
      LEFT JOIN users vu ON vu.id = o.verified_by
      LEFT JOIN users au ON au.id = o.approved_by
      LEFT JOIN pim_documents d ON d.id = o.document_id
      WHERE o.case_id = ${caseId}
    `.then((rows) => rows[0] || null),
    sql`
      SELECT cp.role, cp.is_primary, p.id AS party_id, p.name
      FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
      WHERE cp.case_id = ${caseId}
      ORDER BY CASE cp.role WHEN 'APPLICANT' THEN 1 WHEN 'OPPOSITE_PARTY' THEN 2 ELSE 3 END, cp.is_primary DESC, cp.id
    `,
    sql`
      SELECT a.*, m.name AS mediator_name, m.category AS mediator_category, m.enrollment_no
      FROM pim_mediator_assignments a JOIN mediators m ON m.id = a.mediator_id
      WHERE a.case_id = ${caseId} AND a.status = 'ACTIVE'
      ORDER BY a.id DESC LIMIT 1
    `.then((rows) => rows[0] || null),
    sql`SELECT * FROM mediation_sessions WHERE case_id = ${caseId} ORDER BY sitting_number`,
    getCompletedSessionSummaryTx(sql, caseId),
    sql`
      SELECT next_action, administrative_remarks FROM mediation_sessions
      WHERE case_id = ${caseId} AND effective_session = true AND session_status = 'COMPLETED'
      ORDER BY sitting_number DESC LIMIT 1
    `.then((rows) => rows[0] || null),
    sql`SELECT id, display_name, designation FROM users WHERE active = true ORDER BY id`,
    sql`SELECT id, code, name, rule_reference, requires_authority_decision, active, remarks FROM nonstarter_reasons WHERE active = true ORDER BY id`,
    sql`SELECT * FROM pim_tasks WHERE case_id = ${caseId} ORDER BY id`,
    sql`
      SELECT id, case_id, document_type, document_title, document_date,
             CASE WHEN file_path IS NOT NULL AND file_path <> '' THEN 1 ELSE 0 END AS has_file,
             generated_by_system, version_no, is_current, remarks, created_by, created_at
      FROM pim_documents
      WHERE case_id = ${caseId} AND file_path IS NOT NULL AND file_path <> ''
      ORDER BY is_current DESC, document_type, version_no DESC, id DESC
    `,
  ]);

  let phase7Signal = null;
  if (lastEffectiveSession?.next_action === "READY_FOR_SETTLEMENT") {
    phase7Signal = "SETTLEMENT";
  } else if (lastEffectiveSession?.next_action === "READY_FOR_FAILURE") {
    phase7Signal = "FAILURE";
  } else if (lastEffectiveSession?.next_action == null && lastEffectiveSession?.administrative_remarks) {
    const remarksText = lastEffectiveSession.administrative_remarks;
    if (remarksText.includes("Ready for settlement outcome")) phase7Signal = "SETTLEMENT";
    else if (remarksText.includes("Ready for failure outcome")) phase7Signal = "FAILURE";
  }

  return { case: caseRow, outcome, parties, assignment, sessions, sessionSummary, phase7Signal, activeUsers, nonstarterReasons, tasks, documents };
}

async function getOutcomeApprovalDataPg(caseId) {
  const sql = getSql();
  const [row] = await sql`
    SELECT
      c.id AS case_id, c.pim_number, c.received_number, c.outcome_type AS case_outcome_type, c.outcome_date AS case_outcome_date, c.closed_at,
      s.code AS status_code, s.name AS status_name,
      o.id AS outcome_id, o.outcome_type, o.form_no, o.outcome_date, o.nonstarter_reason_id, o.reason_text, o.settlement_terms,
      o.prepared_by, o.verified_by, o.approved_by, o.document_id, o.sent_to_applicant, o.sent_to_opposite_party, o.remarks AS outcome_remarks
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
    LEFT JOIN pim_outcomes o ON o.case_id = c.id
    WHERE c.id = ${caseId}
  `;
  return row || null;
}

module.exports = {
  recordOutcomeTx,
  recordOutcomePg,
  approveOutcomeTx,
  approveOutcomePg,
  getOutcomeDataPg,
  getOutcomeApprovalDataPg,
};
