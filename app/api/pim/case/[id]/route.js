/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  getCaseDetail,
} = require("../../../../../lib/pim-data/case-detail");

/*
 * Batch 2 (Phase 6): GET below now calls lib/pim-data/case-detail.js
 * (PostgreSQL). The SQLite query functions below are kept, unused by GET,
 * purely as an instant rollback - see app/api/pim/mediators/route.js for
 * the same pattern established in Batch 1.
 */
function getCase(caseId) {
  return db.prepare(`
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
    WHERE c.id = ?
  `).get(caseId);
}

function getParties(caseId) {
  return db.prepare(`
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
    WHERE cp.case_id = ?
    ORDER BY
      CASE cp.role
        WHEN 'APPLICANT' THEN 1
        WHEN 'OPPOSITE_PARTY' THEN 2
        ELSE 3
      END,
      cp.is_primary DESC,
      cp.id
  `).all(caseId);
}

function getAddresses(caseId) {
  return db.prepare(`
    SELECT
      cp.party_id,
      cp.role,
      a.*
    FROM pim_case_parties cp
    JOIN pim_addresses a
      ON a.party_id = cp.party_id
    WHERE cp.case_id = ?
    ORDER BY cp.id, a.id
  `).all(caseId);
}

function getAdvocates(caseId) {
  return db.prepare(`
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
    WHERE ca.case_id = ?
    ORDER BY ca.id
  `).all(caseId);
}

function getStatusHistory(caseId) {
  return db.prepare(`
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
    WHERE h.case_id = ?
    ORDER BY h.id
  `).all(caseId);
}

function getDocket(caseId) {
  return db.prepare(`
    SELECT
      d.*,
      e.code AS event_code,
      e.name AS event_name,
      e.category AS event_category
    FROM pim_docket d
    LEFT JOIN event_types e
      ON e.id = d.event_type_id
    WHERE d.case_id = ?
    ORDER BY d.id
  `).all(caseId);
}

function getTasks(caseId) {
  return db.prepare(`
    SELECT
      t.*,
      tt.code AS task_type_code_master,
      tt.name AS task_type_name
    FROM pim_tasks t
    LEFT JOIN task_types tt
      ON tt.id = t.task_type_id
    WHERE t.case_id = ?
    ORDER BY
      CASE t.status
        WHEN 'PENDING' THEN 1
        WHEN 'IN_PROGRESS' THEN 2
        ELSE 3
      END,
      t.id
  `).all(caseId);
}

function getNotices(caseId) {
  return db.prepare(`
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
     AND d.is_current = 1
    WHERE n.case_id = ?
    ORDER BY n.id
  `).all(caseId);
}

function getServiceAttempts(caseId) {
  return db.prepare(`
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
    ORDER BY sa.id
  `).all(caseId);
}

function getResponses(caseId) {
  return db.prepare(`
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
    WHERE r.case_id = ?
    ORDER BY r.id
  `).all(caseId);
}

function getFees(caseId) {
  return db.prepare(`
    SELECT
      f.*,
      p.name AS party_name
    FROM pim_fees f
    LEFT JOIN pim_parties p
      ON p.id = f.party_id
    WHERE f.case_id = ?
    ORDER BY f.id
  `).all(caseId);
}

function getMediatorAssignments(caseId) {
  return db.prepare(`
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
    WHERE ma.case_id = ?
    ORDER BY ma.id DESC
  `).all(caseId);
}

function getSessions(caseId) {
  return db.prepare(`
    SELECT
      ms.*,
      ma.mediator_id,
      m.name AS mediator_name
    FROM mediation_sessions ms
    JOIN pim_mediator_assignments ma
      ON ma.id = ms.assignment_id
    JOIN mediators m
      ON m.id = ma.mediator_id
    WHERE ms.case_id = ?
    ORDER BY ms.sitting_number
  `).all(caseId);
}

function getOutcome(caseId) {
  return db.prepare(`
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
    WHERE o.case_id = ?
  `).get(caseId) || null;
}

function getDocuments(caseId) {
  return db.prepare(`
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
    WHERE d.case_id = ?
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
  `).all(caseId);
}

/*
 * Phase 6.1 locked the rule that there is exactly one case-level
 * MEDIATION_FEE row. This derives the due/received/balance/status
 * summary from that single row, kept explicitly separate from
 * APPLICATION_FEE so the two can never be confused on screen.
 */
function getFeeSummary(fees) {
  const mediationFeeRow = fees.find(
    (fee) => fee.fee_type === "MEDIATION_FEE"
  );
  const applicationFeeRow = fees.find(
    (fee) => fee.fee_type === "APPLICATION_FEE"
  );

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
 * Read-only operational warnings, scoped to this one case, using
 * the same invariants as scripts/audit-production-readiness.js
 * (not a separate/contradictory ruleset). Never mutates data.
 */
function getWarnings(caseId, caseData, { tasks, outcome, documents, mediatorAssignments, sessions, notices }) {
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
    pendingByType.set(
      task.task_type_code,
      (pendingByType.get(task.task_type_code) || 0) + 1
    );
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

    if (
      requiredDocType &&
      TERMINAL_STATUS_CODES.has(caseData.status_code)
    ) {
      const hasCurrentDoc = documents.some(
        (doc) =>
          doc.normalized_document_type === requiredDocType &&
          doc.is_current === 1 &&
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

  const activeAssignments = mediatorAssignments.filter(
    (assignment) => assignment.status === "ACTIVE"
  );
  if (activeAssignments.length > 1) {
    warnings.push({
      code: "duplicate-current-mediator-assignment",
      message: `${activeAssignments.length} concurrent ACTIVE mediator assignments exist for this case.`,
    });
  }

  const documentTypeCounts = new Map();
  for (const doc of documents) {
    if (doc.is_current !== 1) continue;
    documentTypeCounts.set(
      doc.normalized_document_type,
      (documentTypeCounts.get(doc.normalized_document_type) || 0) + 1
    );
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
   * getSessions() inner-joins pim_mediator_assignments, so an
   * orphaned session (bad/missing assignment_id) would simply be
   * absent from the sessions array rather than present with a
   * null mediator - compare counts directly instead.
   */
  const actualSessionCount = db
    .prepare(`SELECT COUNT(*) AS n FROM mediation_sessions WHERE case_id = ?`)
    .get(caseId).n;

  if (actualSessionCount > sessions.length) {
    warnings.push({
      code: "session-missing-assignment",
      message: `${actualSessionCount - sessions.length} mediation sitting(s) could not be resolved to a mediator assignment.`,
    });
  }

  for (const notice of notices) {
    if (
      ["DISPATCHED", "SERVED"].includes(notice.status) &&
      !notice.current_document_has_file
    ) {
      warnings.push({
        code: "notice-without-current-document",
        message: `${notice.notice_type === "FORM_2_FINAL" ? "Final" : "Initial"} notice #${notice.id} (recipient: ${notice.recipient_name || "-"}) is issued but has no current generated document on file.`,
      });
    }
  }

  return warnings;
}

export async function GET(request, { params }) {
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

    // Batch 2 (Phase 6): migrated to PostgreSQL via lib/pim-data/case-detail.js.
    // The permission check above is unchanged - still the SQLite-backed
    // lib/pim-auth.js session/user resolution, run before any data access.
    const data = await getCaseDetail(caseId);

    if (!data) {
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
      data,
    });
  } catch (error) {
    console.error(
      "PIM Case GET error:",
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
            : "Unable to load PIM case.",
      },
      { status: 500 }
    );
  }
}
