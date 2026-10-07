/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL port of Form-3 (Non-Starter Report) document generation
 * (production-completion sprint, 2026-10-07):
 * app/api/pim/documents/form3/[id]/route.js and the Form-3 branch of
 * app/api/pim/documents/download/[caseId]/[documentId]/route.js. See
 * docs/phase6-form3-documents-migration.md.
 *
 * Same no-storage model as lib/pim-data/form2.js (Batch 5I) and
 * lib/pim-data/outcome-documents.js (this sprint, earlier batch):
 * generation resolves render_data ONCE and stores it (plus metadata) in
 * pim_documents.render_data (jsonb) - file_path is always NULL. No DOCX
 * buffer is produced and no file is ever written to local disk at
 * generation time; rendering is deferred to download, from the frozen
 * snapshot.
 *
 * renderForm3Template (lib/pim-document.js) is reused as-is - a pure
 * function (template path + a flat values object in, a DOCX buffer out)
 * with no database coupling.
 */

const path = require("path");
const { withTransaction, getSql } = require("../pim-postgres");
const { formatDate, renderForm3Template } = require("../pim-document");

const TEMPLATE_PATH = path.join(process.cwd(), "templates", "pim", "form3.docx");
const ALLOWED_RULE_REFERENCES = new Set(["3(4)", "3(6)"]);
const GENERATION_ALLOWED_STATUSES = new Set(["CLOSED_NON_STARTER", "OUTCOME_FORM_PENDING", "AUTHORITY_DECISION_PENDING"]);

function parseRenderData(value) {
  if (value == null) return null;
  return typeof value === "string" ? JSON.parse(value) : value;
}

function documentToWire(row) {
  if (!row) return null;
  return { ...row, render_data: parseRenderData(row.render_data) };
}

/*
 * Mirrors lib/pim-document.js's getForm3Data exactly (same required
 * facts, same error messages), reading PostgreSQL instead of SQLite.
 */
async function resolveForm3RenderInputsTx(tx, caseId) {
  const [caseData] = await tx`
    SELECT c.id, c.pim_number, c.received_number, c.application_date, c.registration_date,
           c.current_status_id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;
  if (!caseData) throw new Error("PIM case not found.");

  const [outcome] = await tx`
    SELECT o.id, o.outcome_type, o.form_no, o.outcome_date, o.reason_text, o.settlement_terms,
           nr.code AS reason_code, nr.name AS reason_name
    FROM pim_outcomes o LEFT JOIN nonstarter_reasons nr ON nr.id = o.nonstarter_reason_id
    WHERE o.case_id = ${caseId} AND o.outcome_type = 'NON_STARTER'
  `;
  if (!outcome) throw new Error("Non-starter outcome record was not found.");

  const [applicant] = await tx`
    SELECT p.id, p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseId} AND cp.role = 'APPLICANT' AND cp.is_primary = true
    ORDER BY cp.sequence_no, cp.id LIMIT 1
  `;
  if (!applicant) throw new Error("Primary applicant was not found.");

  const [oppositeParty] = await tx`
    SELECT p.id, p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseId} AND cp.role = 'OPPOSITE_PARTY' AND cp.is_primary = true
    ORDER BY cp.sequence_no, cp.id LIMIT 1
  `;
  if (!oppositeParty) throw new Error("Primary opposite party was not found.");

  const [notice] = await tx`
    SELECT id, notice_date, appearance_date, appearance_time FROM pim_notices
    WHERE case_id = ${caseId} ORDER BY id DESC LIMIT 1
  `;
  if (!notice) throw new Error("Form-2 notice record was not found.");

  return { caseData, outcome, applicant, oppositeParty, notice };
}

function buildForm3RenderValues(data, ruleReference) {
  return {
    applicant_name: data.applicant.name,
    application_date: formatDate(data.caseData.application_date),
    opposite_party_name: data.oppositeParty.name,
    appearance_date: formatDate(data.notice.appearance_date),
    rule_reference: ruleReference,
    nonstarter_reason: data.outcome.reason_text || data.outcome.reason_name || "",
    outcome_date: formatDate(data.outcome.outcome_date),
  };
}

/*
 * Lock the case row first, matching every other Batch 5D+ mutation and
 * the outcome-documents/form2 generators - serializes concurrent
 * Generate calls for the same case.
 */
async function generateForm3DocumentTx(tx, caseId, { ruleReference, regenerate = false } = {}, userId) {
  if (!ruleReference) throw new Error("Rule reference is required for Form-3 generation.");
  if (!ALLOWED_RULE_REFERENCES.has(ruleReference)) throw new Error("Rule reference must be 3(4) or 3(6).");

  const [caseRow] = await tx`
    SELECT c.id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (!GENERATION_ALLOWED_STATUSES.has(caseRow.status_code)) {
    throw new Error(`Form-3 cannot be generated from status ${caseRow.status_name || caseRow.status_code}.`);
  }

  const [existingCurrent] = await tx`
    SELECT * FROM pim_documents
    WHERE case_id = ${caseId} AND document_type = 'FORM_3' AND is_current = true
    ORDER BY version_no DESC, id DESC LIMIT 1
  `;

  if (!regenerate && existingCurrent && existingCurrent.render_data) {
    return { reused: true, caseId, document: documentToWire(existingCurrent) };
  }

  const data = await resolveForm3RenderInputsTx(tx, caseId);
  const renderData = buildForm3RenderValues(data, ruleReference);

  const [{ next_version: versionNo }] = await tx`
    SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version FROM pim_documents WHERE case_id = ${caseId} AND document_type = 'FORM_3'
  `;

  if (existingCurrent) {
    await tx`UPDATE pim_documents SET is_current = false WHERE id = ${existingCurrent.id}`;
  }

  const remarksText = `Generated for non-starter reason: ${data.outcome.reason_name || data.outcome.reason_text || ""}`;

  const [document] = await tx`
    INSERT INTO pim_documents
      (case_id, document_type, document_title, document_date, file_path, generated_by_system, version_no, is_current, remarks, created_by, render_data)
    VALUES
      (${caseId}, 'FORM_3', 'Form 3: Non-Starter Report', ${data.outcome.outcome_date}, NULL, true, ${versionNo}, true, ${remarksText}, ${userId}, ${JSON.stringify(renderData)}::jsonb)
    RETURNING *
  `;

  return { reused: false, caseId, document: documentToWire(document) };
}

async function generateForm3DocumentPg(caseId, options, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) throw new Error("Valid case ID is required.");
  return withTransaction((tx) => generateForm3DocumentTx(tx, numericCaseId, options, userId));
}

async function downloadForm3DocumentPg(caseId, documentId) {
  const sql = getSql();
  const [document] = await sql`
    SELECT * FROM pim_documents WHERE id = ${documentId} AND case_id = ${caseId} AND document_type = 'FORM_3'
  `;
  if (!document) return null;

  const wired = documentToWire(document);
  if (!wired.render_data) return { document: wired, buffer: null };

  const buffer = renderForm3Template(TEMPLATE_PATH, wired.render_data);
  const fileName = `FORM-3-C${caseId}-v${document.version_no}.docx`;

  return { document: wired, buffer, fileName };
}

module.exports = {
  generateForm3DocumentTx,
  generateForm3DocumentPg,
  downloadForm3DocumentPg,
};
