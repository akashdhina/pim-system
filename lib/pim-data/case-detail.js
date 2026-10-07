/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL data-access for case detail - Batch 2's migrated read-only
 * route (GET /api/pim/case/[id]). Mirrors app/api/pim/case/[id]/route.js's
 * SQLite implementation function-for-function and preserves its exact
 * response shape: { case, parties, addresses, advocates, statusHistory,
 * docket, tasks, notices, serviceAttempts, responses, fees, feeSummary,
 * mediatorAssignments, sessions, cumulativeDurationMinutes, outcome,
 * documents, warnings }.
 *
 * 15 independent SELECT queries (plus 1 inside getWarnings), same as the
 * SQLite version - not consolidated into fewer JOINed queries, which would
 * risk multiplying one-to-many rows the current design deliberately avoids
 * by querying each relation separately (see docs/phase6-migration-design.md
 * step 6 in the batch instructions). They're run concurrently via
 * Promise.all rather than sequentially, since postgres.js is async and none
 * of these reads depends on another's result except getCase (checked first,
 * for the 404 case) - this changes nothing about the data returned.
 *
 * No mutations here - GET only, matching the route it backs.
 */

const { getSql } = require("../pim-postgres");

async function getCase(caseId) {
  const sql = getSql();
  const [row] = await sql`
    SELECT
      c.*,
      COALESCE(c.entry_type, 'NEW') AS entry_type,
      s.code AS status_code,
      s.name AS status_name,
      dc.name AS dispute_category_name
    FROM pim_cases c
    LEFT JOIN status_master s
      ON s.id = c.current_status_id
    LEFT JOIN dispute_categories dc
      ON dc.id = c.dispute_category_id
    WHERE c.id = ${caseId}
  `;
  return row || null;
}

async function getParties(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      cp.id AS case_party_id,
      cp.party_id,
      cp.role,
      cp.is_primary,
      cp.active_from,
      cp.active_to,
      p.name,
      p.entity_type,
      p.registration_no,
      p.contact_phone,
      p.email
    FROM pim_case_parties cp
    JOIN pim_parties p
      ON p.id = cp.party_id
    WHERE cp.case_id = ${caseId}
    ORDER BY
      CASE cp.role
        WHEN 'APPLICANT' THEN 1
        WHEN 'OPPOSITE_PARTY' THEN 2
        ELSE 3
      END,
      cp.is_primary DESC,
      cp.id
  `;
}

async function getAddresses(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      cp.party_id,
      cp.role,
      a.*
    FROM pim_case_parties cp
    JOIN pim_addresses a
      ON a.party_id = cp.party_id
    WHERE cp.case_id = ${caseId}
    ORDER BY cp.id, a.id
  `;
}

async function getAdvocates(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      ca.id AS case_advocate_id,
      ca.party_id,
      ca.advocate_id,
      ca.role,
      ca.from_date,
      ca.to_date,
      ca.remarks,
      a.name AS advocate_name,
      a.enrollment_no,
      a.phone,
      a.email,
      a.address
    FROM pim_case_advocates ca
    JOIN pim_advocates a
      ON a.id = ca.advocate_id
    WHERE ca.case_id = ${caseId}
    ORDER BY ca.id
  `;
}

async function getStatusHistory(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      h.id,
      h.from_status_id,
      fs.code AS from_status_code,
      fs.name AS from_status_name,
      h.to_status_id,
      ts.code AS to_status_code,
      ts.name AS to_status_name,
      h.changed_at,
      h.reason,
      h.changed_by
    FROM pim_status_history h
    LEFT JOIN status_master fs
      ON fs.id = h.from_status_id
    JOIN status_master ts
      ON ts.id = h.to_status_id
    WHERE h.case_id = ${caseId}
    ORDER BY h.id
  `;
}

async function getDocket(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      d.*,
      e.code AS event_code,
      e.name AS event_name,
      e.category AS event_category
    FROM pim_docket d
    LEFT JOIN event_types e
      ON e.id = d.event_type_id
    WHERE d.case_id = ${caseId}
    ORDER BY d.id
  `;
}

async function getTasks(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      t.*,
      tt.code AS task_type_code_master,
      tt.name AS task_type_name
    FROM pim_tasks t
    LEFT JOIN task_types tt
      ON tt.id = t.task_type_id
    WHERE t.case_id = ${caseId}
    ORDER BY
      CASE t.status
        WHEN 'PENDING' THEN 1
        WHEN 'IN_PROGRESS' THEN 2
        ELSE 3
      END,
      t.id
  `;
}

async function getNotices(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      n.*,
      p.name AS recipient_name,
      a.address_line1,
      a.address_line2,
      a.village_town,
      a.district,
      a.state,
      a.pincode,
      d.id AS current_document_id,
      d.version_no AS current_document_version_no,
      CASE
        WHEN d.file_path IS NOT NULL AND d.file_path <> '' THEN 1
        ELSE 0
      END AS current_document_has_file
    FROM pim_notices n
    LEFT JOIN pim_parties p
      ON p.id = n.recipient_party_id
    LEFT JOIN pim_addresses a
      ON a.id = n.address_id
    LEFT JOIN pim_documents d
      ON d.notice_id = n.id
     AND d.is_current = true
    WHERE n.case_id = ${caseId}
    ORDER BY n.id
  `;
}

async function getServiceAttempts(caseId) {
  const sql = getSql();
  return sql`
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
    WHERE n.case_id = ${caseId}
    ORDER BY sa.id
  `;
}

async function getResponses(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      r.*,
      p.name AS party_name,
      cp.role
    FROM pim_responses r
    JOIN pim_parties p
      ON p.id = r.party_id
    LEFT JOIN pim_case_parties cp
      ON cp.case_id = r.case_id
     AND cp.party_id = r.party_id
     AND cp.active_to IS NULL
    WHERE r.case_id = ${caseId}
    ORDER BY r.id
  `;
}

async function getFees(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      f.*,
      p.name AS party_name
    FROM pim_fees f
    LEFT JOIN pim_parties p
      ON p.id = f.party_id
    WHERE f.case_id = ${caseId}
    ORDER BY f.id
  `;
}

async function getMediatorAssignments(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      ma.*,
      m.name AS mediator_name,
      m.category AS mediator_category,
      m.enrollment_no,
      m.contact_phone,
      m.email
    FROM pim_mediator_assignments ma
    JOIN mediators m
      ON m.id = ma.mediator_id
    WHERE ma.case_id = ${caseId}
    ORDER BY ma.id DESC
  `;
}

async function getSessions(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      ms.*,
      ma.mediator_id,
      m.name AS mediator_name
    FROM mediation_sessions ms
    JOIN pim_mediator_assignments ma
      ON ma.id = ms.assignment_id
    JOIN mediators m
      ON m.id = ma.mediator_id
    WHERE ms.case_id = ${caseId}
    ORDER BY ms.sitting_number
  `;
}

async function getOutcome(caseId) {
  const sql = getSql();
  const [row] = await sql`
    SELECT
      o.*,
      nr.code AS nonstarter_reason_code,
      nr.name AS nonstarter_reason_name,
      nr.rule_reference,
      nr.requires_authority_decision,
      vu.display_name AS verified_by_name,
      vu.designation AS verified_by_designation,
      au.display_name AS approved_by_name,
      au.designation AS approved_by_designation
    FROM pim_outcomes o
    LEFT JOIN nonstarter_reasons nr
      ON nr.id = o.nonstarter_reason_id
    LEFT JOIN users vu
      ON vu.id = o.verified_by
    LEFT JOIN users au
      ON au.id = o.approved_by
    WHERE o.case_id = ${caseId}
  `;
  return row || null;
}

async function getDocuments(caseId) {
  const sql = getSql();
  return sql`
    SELECT
      d.id,
      d.case_id,
      d.notice_id,
      np.name AS notice_recipient_name,
      n.notice_type,
      d.document_type,
      CASE
        WHEN d.document_type = 'FORM2'
        THEN 'FORM_2'
        ELSE d.document_type
      END AS normalized_document_type,
      d.document_title,
      d.document_date,
      CASE
        WHEN d.file_path IS NOT NULL
          AND d.file_path <> ''
        THEN 1
        ELSE 0
      END AS has_file,
      d.generated_by_system,
      d.version_no,
      d.is_current,
      d.remarks,
      d.created_by,
      d.created_at,
      u.display_name AS created_by_name,
      u.designation AS created_by_designation
    FROM pim_documents d
    LEFT JOIN pim_notices n
      ON n.id = d.notice_id
    LEFT JOIN pim_parties np
      ON np.id = n.recipient_party_id
    LEFT JOIN users u
      ON u.id = d.created_by
    WHERE d.case_id = ${caseId}
    ORDER BY
      CASE d.document_type
        WHEN 'FORM2' THEN 1
        WHEN 'FORM_2' THEN 1
        WHEN 'FORM_3' THEN 2
        WHEN 'FORM_4' THEN 3
        WHEN 'FORM_5' THEN 4
        WHEN 'WITHDRAWAL_RECORD' THEN 5
        ELSE 10
      END,
      d.version_no DESC,
      d.id DESC
  `;
}

/*
 * Pure JS post-processing, unchanged from the SQLite route - no query
 * here, just summarizing the already-fetched fees array. Copied verbatim
 * per "do not redesign the response contract."
 */
function getFeeSummary(fees) {
  const mediationFeeRow = fees.find((fee) => fee.fee_type === "MEDIATION_FEE");
  const applicationFeeRow = fees.find((fee) => fee.fee_type === "APPLICATION_FEE");

  function summarize(row) {
    if (!row) return null;

    const due = row.amount_due != null ? Number(row.amount_due) : null;
    const received = Number(row.amount_received || 0);

    return {
      amountDue: due,
      amountReceived: received,
      balance: due != null ? Math.max(due - received, 0) : null,
      status: row.status,
    };
  }

  return {
    mediationFee: summarize(mediationFeeRow),
    applicationFee: summarize(applicationFeeRow),
  };
}

const TERMINAL_STATUS_CODES = new Set([
  "CLOSED_SETTLED",
  "CLOSED_FAILED",
  "CLOSED_NON_STARTER",
  "WITHDRAWN",
]);

/*
 * Same warnings, same codes/messages/conditions as the SQLite route - one
 * deliberate fix: pim_documents.is_current is a native PostgreSQL boolean
 * (Phase 2), not SQLite's INTEGER CHECK(0,1). The SQLite route compared it
 * with `=== 1` / `!== 1`; left as-is here those comparisons would silently
 * always be false/true respectively (true !== 1 in JS), breaking both the
 * "missing current document" and "duplicate current document" warnings.
 * Fixed to `=== true` / `!== true`. has_file/current_document_has_file
 * are SQL-computed CASE...THEN 1 ELSE 0 expressions (not the raw column),
 * so they still come back as 1/0 and need no change.
 */
async function getWarnings(
  caseId,
  caseData,
  { tasks, outcome, documents, mediatorAssignments, sessions, notices }
) {
  const sql = getSql();
  const warnings = [];

  const pendingTasks = tasks.filter((task) => task.status === "PENDING");

  if (TERMINAL_STATUS_CODES.has(caseData.status_code) && pendingTasks.length > 0) {
    warnings.push({
      code: "terminal-case-pending-task",
      message: `This case is closed but still has ${pendingTasks.length} pending task(s).`,
    });
  }

  const pendingByType = new Map();
  for (const task of pendingTasks) {
    pendingByType.set(task.task_type_code, (pendingByType.get(task.task_type_code) || 0) + 1);
  }
  for (const [taskTypeCode, count] of pendingByType) {
    if (count > 1) {
      warnings.push({
        code: "duplicate-pending-task",
        message: `${count} duplicate pending "${taskTypeCode}" tasks exist for this case.`,
      });
    }
  }

  if (outcome) {
    const requiredDocType =
      outcome.outcome_type === "SETTLED"
        ? "FORM_4"
        : outcome.outcome_type === "FAILED"
          ? "FORM_5"
          : outcome.outcome_type === "NON_STARTER"
            ? "FORM_3"
            : null;

    if (requiredDocType && TERMINAL_STATUS_CODES.has(caseData.status_code)) {
      const hasCurrentDoc = documents.some(
        (doc) =>
          doc.normalized_document_type === requiredDocType &&
          doc.is_current === true &&
          doc.has_file === 1
      );

      if (!hasCurrentDoc) {
        warnings.push({
          code: `missing-${requiredDocType.toLowerCase()}`,
          message: `Case is closed as ${outcome.outcome_type} but no current ${requiredDocType.replace("_", "-")} document was found.`,
        });
      }
    }
  }

  const activeAssignments = mediatorAssignments.filter((assignment) => assignment.status === "ACTIVE");
  if (activeAssignments.length > 1) {
    warnings.push({
      code: "duplicate-current-mediator-assignment",
      message: `${activeAssignments.length} concurrent ACTIVE mediator assignments exist for this case.`,
    });
  }

  const documentTypeCounts = new Map();
  for (const doc of documents) {
    if (doc.is_current !== true) continue;
    documentTypeCounts.set(doc.normalized_document_type, (documentTypeCounts.get(doc.normalized_document_type) || 0) + 1);
  }
  for (const [docType, count] of documentTypeCounts) {
    if (count > 1) {
      warnings.push({
        code: "duplicate-current-document",
        message: `${count} current "${docType}" documents exist for this case (expected at most one per notice/case-level document).`,
      });
    }
  }

  /*
   * getSessions() inner-joins pim_mediator_assignments, so an orphaned
   * session (bad/missing assignment_id) would simply be absent from the
   * sessions array rather than present with a null mediator - compare
   * counts directly instead.
   */
  const [{ n: actualSessionCount }] = await sql`
    SELECT COUNT(*) AS n FROM mediation_sessions WHERE case_id = ${caseId}
  `;

  if (actualSessionCount > sessions.length) {
    warnings.push({
      code: "session-missing-assignment",
      message: `${actualSessionCount - sessions.length} mediation sitting(s) could not be resolved to a mediator assignment.`,
    });
  }

  for (const notice of notices) {
    if (["DISPATCHED", "SERVED"].includes(notice.status) && !notice.current_document_has_file) {
      warnings.push({
        code: "notice-without-current-document",
        message: `${notice.notice_type === "FORM_2_FINAL" ? "Final" : "Initial"} notice #${notice.id} (recipient: ${notice.recipient_name || "-"}) is issued but has no current generated document on file.`,
      });
    }
  }

  return warnings;
}

/*
 * Orchestrates all of the above into the exact response shape
 * app/api/pim/case/[id]/route.js's GET handler returns. Returns null if
 * the case does not exist (route maps that to a 404, unchanged).
 */
async function getCaseDetail(caseId) {
  const caseData = await getCase(caseId);
  if (!caseData) return null;

  const [
    parties,
    addresses,
    advocates,
    statusHistory,
    docket,
    tasks,
    notices,
    serviceAttempts,
    responses,
    fees,
    mediatorAssignments,
    sessions,
    outcome,
    documents,
  ] = await Promise.all([
    getParties(caseId),
    getAddresses(caseId),
    getAdvocates(caseId),
    getStatusHistory(caseId),
    getDocket(caseId),
    getTasks(caseId),
    getNotices(caseId),
    getServiceAttempts(caseId),
    getResponses(caseId),
    getFees(caseId),
    getMediatorAssignments(caseId),
    getSessions(caseId),
    getOutcome(caseId),
    getDocuments(caseId),
  ]);

  const cumulativeDurationMinutes = sessions.reduce(
    (total, session) =>
      session.effective_session && Number.isFinite(session.duration_minutes)
        ? total + Number(session.duration_minutes)
        : total,
    0
  );

  const warnings = await getWarnings(caseId, caseData, {
    tasks,
    outcome,
    documents,
    mediatorAssignments,
    sessions,
    notices,
  });

  return {
    case: caseData,
    parties,
    addresses,
    advocates,
    statusHistory,
    docket,
    tasks,
    notices,
    serviceAttempts,
    responses,
    fees,
    feeSummary: getFeeSummary(fees),
    mediatorAssignments,
    sessions,
    cumulativeDurationMinutes,
    outcome,
    documents,
    warnings,
  };
}

module.exports = {
  getCaseDetail,
};
