/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL port of outcome document generation/download (Form IV -
 * Settlement, Form V - Failure Report), production-completion sprint,
 * 2026-10-07: app/api/pim/documents/outcome/[id]/route.js and the
 * outcome-document branch of app/api/pim/documents/download/[caseId]/
 * [documentId]/route.js. See docs/phase6-outcome-documents-migration.md.
 *
 * Follows the SAME no-storage model Batch 5I established for Form-2
 * (lib/pim-data/form2.js): generation resolves render_data ONCE and
 * stores it (plus metadata) in pim_documents.render_data (jsonb) -
 * file_path is always NULL for a row this module writes. No DOCX buffer
 * is rendered and no file is ever written to local disk at generation
 * time; rendering is deferred entirely to download, from the frozen
 * render_data snapshot. This is deliberate, not a shortcut: a shared
 * local filesystem cannot be relied on across instances, which is why
 * Batch 5I chose this model over lib/pim-document.js's original
 * SQLite-era local-file write - continued here, not re-decided.
 *
 * renderOutcomeTemplate (lib/pim-document.js) is reused as-is - it is a
 * pure function (template path + a label->value object in, a DOCX buffer
 * out) with no database coupling, so it works unchanged against
 * PostgreSQL-sourced data.
 */

const path = require("path");
const { withTransaction, getSql } = require("../pim-postgres");
const { officeDate } = require("../pim-time");
const { getOutcomeDocumentType, renderOutcomeTemplate } = require("../pim-document");
const { getSettings } = require("./settings");

function parseRenderData(value) {
  if (value == null) return null;
  return typeof value === "string" ? JSON.parse(value) : value;
}

function documentToWire(row) {
  if (!row) return null;
  return { ...row, render_data: parseRenderData(row.render_data) };
}

function formatDate(value) {
  if (!value) return "";
  const s = String(value);
  const [year, month, day] = s.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : s;
}

async function getPrimaryPartyTx(tx, caseId, role) {
  const [row] = await tx`
    SELECT p.id, p.name
    FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseId} AND cp.role = ${role} AND cp.is_primary = true AND cp.active_to IS NULL
    ORDER BY cp.sequence_no, cp.id LIMIT 1
  `;
  return row || null;
}

/*
 * Mirrors lib/pim-document.js's getOutcomeDocumentData exactly (same
 * required fields, same error messages), reading PostgreSQL instead of
 * SQLite.
 */
async function resolveOutcomeRenderInputsTx(tx, caseId) {
  const [caseData] = await tx`
    SELECT c.id, c.pim_number, c.received_number, c.application_date, c.registration_date,
           c.current_status_id, c.outcome_type AS case_outcome_type, c.outcome_date AS case_outcome_date, c.closed_at,
           s.code AS status_code, s.name AS status_name, s.is_terminal
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;
  if (!caseData) throw new Error("PIM case not found.");

  const [outcome] = await tx`
    SELECT o.*, vu.display_name AS verified_by_name, vu.designation AS verified_by_designation,
           au.display_name AS approved_by_name, au.designation AS approved_by_designation
    FROM pim_outcomes o
    LEFT JOIN users vu ON vu.id = o.verified_by
    LEFT JOIN users au ON au.id = o.approved_by
    WHERE o.case_id = ${caseId}
  `;
  if (!outcome) throw new Error("No mediation outcome has been recorded for this case.");

  if (outcome.outcome_type === "NON_STARTER") {
    throw new Error("NON_STARTER documents must be generated through the dedicated non-starter workflow.");
  }

  const applicant = await getPrimaryPartyTx(tx, caseId, "APPLICANT");
  if (!applicant) throw new Error("Primary applicant was not found.");

  const oppositeParty = await getPrimaryPartyTx(tx, caseId, "OPPOSITE_PARTY");
  if (!oppositeParty) throw new Error("Primary opposite party was not found.");

  const [assignment] = await tx`
    SELECT a.*, m.name AS mediator_name, m.category AS mediator_category, m.enrollment_no
    FROM pim_mediator_assignments a JOIN mediators m ON m.id = a.mediator_id
    WHERE a.case_id = ${caseId} AND a.status = 'ACTIVE'
    ORDER BY a.id DESC LIMIT 1
  `;
  if (!assignment) throw new Error("Active mediator assignment was not found.");

  const sessions = await tx`
    SELECT * FROM mediation_sessions WHERE case_id = ${caseId} AND session_status = 'COMPLETED' ORDER BY sitting_number
  `;
  if (sessions.length === 0) {
    throw new Error("At least one completed mediation session is required for outcome document generation.");
  }

  const [summary] = await tx`
    SELECT
      COUNT(*)::int AS total_sittings,
      SUM(CASE WHEN effective_session = true THEN 1 ELSE 0 END)::int AS effective_sittings,
      COALESCE(SUM(CASE WHEN effective_session = true THEN COALESCE(duration_minutes, 0) ELSE 0 END), 0)::int AS effective_duration_minutes
    FROM mediation_sessions WHERE case_id = ${caseId} AND session_status = 'COMPLETED'
  `;

  return { caseData, outcome, applicant, oppositeParty, assignment, sessions, summary };
}

function buildOutcomeRenderValues(data, officeSettings) {
  const mediationDates = data.sessions
    .map((session) => formatDate(session.actual_date || session.scheduled_date))
    .filter(Boolean)
    .join(", ");

  const sittingSummary =
    `${data.summary.total_sittings} sitting(s), ` +
    `${data.summary.effective_sittings || 0} effective, ` +
    `${data.summary.effective_duration_minutes || 0} minutes effective duration`;

  const termsOrReason = data.outcome.outcome_type === "SETTLED" ? data.outcome.settlement_terms : data.outcome.reason_text;

  return {
    "Name of the Mediator:": data.assignment.mediator_name,
    "Name of the applicant:": data.applicant.name,
    "Name of the opposite party:": data.oppositeParty.name,
    "Date of application for Pre-Institution mediation:": formatDate(data.caseData.application_date),
    "Venue of mediation:": officeSettings.default_mediation_venue,
    "Date(s) of mediation:": mediationDates,
    "No. of sittings and duration of sittings:": sittingSummary,
    "Reasons for failure:": data.outcome.outcome_type === "FAILED" ? termsOrReason : "",
    "Terms of settlement:": data.outcome.outcome_type === "SETTLED" ? termsOrReason : "",
    "Date:": formatDate(data.outcome.outcome_date),
  };
}

/*
 * Lock the case row first, matching every other Batch 5D+ mutation - this
 * serializes concurrent Generate calls for the same case so a plain
 * MAX(version_no)+1 read stays safe and two concurrent non-regenerate
 * calls correctly converge on the same reused document.
 */
async function generateOutcomeDocumentTx(tx, caseId, { regenerate = false } = {}, userId) {
  const [caseRow] = await tx`
    SELECT c.id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  const [outcome] = await tx`SELECT * FROM pim_outcomes WHERE case_id = ${caseId}`;
  if (!outcome) throw new Error("No mediation outcome has been recorded for this case.");

  if (outcome.outcome_type === "NON_STARTER") {
    throw new Error("NON_STARTER documents must be generated through the dedicated non-starter workflow.");
  }
  if (outcome.outcome_type === "WITHDRAWN") {
    throw new Error("Approved withdrawal document template is not configured.");
  }

  const config = getOutcomeDocumentType(outcome.outcome_type);

  // Generation must be possible BEFORE closure - closure is gated on the
  // document already existing (lib/pim-data/outcome.js's
  // approveOutcomeTx), not the other way around. Regeneration after
  // closure remains allowed too.
  const expectedClosedStatusCode =
    outcome.outcome_type === "SETTLED" ? "CLOSED_SETTLED" : outcome.outcome_type === "FAILED" ? "CLOSED_FAILED" : null;
  const canGenerate =
    caseRow.status_code === "OUTCOME_FORM_PENDING" ||
    (expectedClosedStatusCode && caseRow.status_code === expectedClosedStatusCode);
  if (!canGenerate) {
    throw new Error(`Outcome document generation is not available from the current case status: ${caseRow.status_name}`);
  }

  const [linkedDocument] = outcome.document_id
    ? await tx`SELECT * FROM pim_documents WHERE id = ${outcome.document_id} AND case_id = ${caseId} AND document_type = ${config.documentType}`
    : [null];

  if (!regenerate && linkedDocument && linkedDocument.render_data) {
    return { reused: true, caseId, document: documentToWire(linkedDocument) };
  }

  const data = await resolveOutcomeRenderInputsTx(tx, caseId);
  const officeSettings = await getSettings();
  const renderData = buildOutcomeRenderValues(data, officeSettings);

  const [{ next_version: versionNo }] = await tx`
    SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version FROM pim_documents WHERE case_id = ${caseId} AND document_type = ${config.documentType}
  `;

  await tx`UPDATE pim_documents SET is_current = false WHERE case_id = ${caseId} AND document_type = ${config.documentType} AND is_current = true`;

  const remarksText = regenerate ? `Regenerated ${config.title}.` : `Generated from approved ${outcome.outcome_type} outcome.`;

  const [document] = await tx`
    INSERT INTO pim_documents
      (case_id, document_type, document_title, document_date, file_path, generated_by_system, version_no, is_current, remarks, created_by, render_data)
    VALUES
      (${caseId}, ${config.documentType}, ${config.title}, ${outcome.outcome_date || officeDate()}, NULL, true, ${versionNo}, true, ${remarksText}, ${userId}, ${JSON.stringify(renderData)}::jsonb)
    RETURNING *
  `;

  await tx`UPDATE pim_outcomes SET document_id = ${document.id} WHERE id = ${outcome.id}`;

  return { reused: false, caseId, document: documentToWire(document) };
}

async function generateOutcomeDocumentPg(caseId, options, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) throw new Error("Valid case ID is required.");
  return withTransaction((tx) => generateOutcomeDocumentTx(tx, numericCaseId, options, userId));
}

async function downloadOutcomeDocumentPg(caseId, documentId) {
  const sql = getSql();
  const [document] = await sql`
    SELECT * FROM pim_documents WHERE id = ${documentId} AND case_id = ${caseId} AND document_type IN ('FORM_4', 'FORM_5')
  `;
  if (!document) return null;

  const wired = documentToWire(document);
  if (!wired.render_data) return { document: wired, buffer: null };

  const config = getOutcomeDocumentType(document.document_type === "FORM_4" ? "SETTLED" : "FAILED");
  const templatePath = path.join(process.cwd(), "templates", "pim", config.templateName);
  const buffer = renderOutcomeTemplate(templatePath, wired.render_data);
  const fileName = `${config.folderName}-C${caseId}-v${document.version_no}.docx`;

  return { document: wired, buffer, fileName };
}

module.exports = {
  generateOutcomeDocumentTx,
  generateOutcomeDocumentPg,
  downloadOutcomeDocumentPg,
};
