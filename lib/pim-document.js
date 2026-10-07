/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const db = require("./db");
const {
  getSettings,
} = require("./pim-settings");

function formatDate(value) {
  if (!value) return "";

  const [year, month, day] = String(value)
    .slice(0, 10)
    .split("-");

  if (!year || !month || !day) {
    return String(value);
  }

  return `${day}/${month}/${year}`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safePimNumber(value, caseId) {
  return String(value || `CASE-${caseId}`).replace(
    /[^a-zA-Z0-9_-]/g,
    "-"
  );
}

function getPrimaryParty(caseId, role) {
  return db.prepare(`
    SELECT
      p.id,
      p.name
    FROM pim_case_parties cp
    JOIN pim_parties p
      ON p.id = cp.party_id
    WHERE cp.case_id = ?
      AND cp.role = ?
      AND cp.is_primary = 1
    ORDER BY cp.sequence_no, cp.id
    LIMIT 1
  `).get(caseId, role);
}

function getOutcomeDocumentType(outcomeType) {
  switch (outcomeType) {
    case "SETTLED":
      return {
        documentType: "FORM_4",
        folderName: "FORM-4",
        templateName: "Form 4.docx",
        title: "Form 4: Settlement",
      };

    case "FAILED":
      return {
        documentType: "FORM_5",
        folderName: "FORM-5",
        templateName: "Form 5.docx",
        title: "Form 5: Failure Report",
      };

    case "WITHDRAWN":
      throw new Error(
        "Approved withdrawal document template is not configured."
      );

    default:
      throw new Error(
        `Unsupported outcome type for normal outcome document: ${outcomeType}`
      );
  }
}

function replaceLabelValue(xml, label, value) {
  if (!value) {
    return xml;
  }

  const escapedLabel =
    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return xml.replace(
    new RegExp(
      `(<w:t[^>]*>)(${escapedLabel})\\s*(</w:t>)`
    ),
    `$1$2 ${escapeXml(value)}$3`
  );
}

function createTextRun(value) {
  return [
    "<w:r>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>',
    '<w:sz w:val="28"/>',
    '<w:szCs w:val="28"/>',
    "</w:rPr>",
    '<w:t xml:space="preserve">',
    ` ${escapeXml(value)}`,
    "</w:t>",
    "</w:r>",
  ].join("");
}

function visibleText(xml) {
  return xml
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function appendValueToLabelParagraph(
  xml,
  label,
  value
) {
  if (!value) {
    return xml;
  }

  let replaced = false;

  return xml.replace(
    /<w:p[\s\S]*?<\/w:p>/g,
    (paragraph) => {
      if (
        replaced ||
        !visibleText(paragraph).includes(label)
      ) {
        return paragraph;
      }

      replaced = true;

      return paragraph.replace(
        "</w:p>",
        `${createTextRun(value)}</w:p>`
      );
    }
  );
}

function renderOutcomeTemplate(templatePath, values) {
  const templateBinary = fs.readFileSync(
    templatePath
  );

  const zip = new PizZip(templateBinary);
  const documentXml =
    zip.file("word/document.xml").asText();

  let nextXml = documentXml;

  for (const [label, value] of Object.entries(
    values
  )) {
    const singleRunXml = replaceLabelValue(
      nextXml,
      label,
      value
    );

    nextXml =
      singleRunXml === nextXml
        ? appendValueToLabelParagraph(
            nextXml,
            label,
            value
          )
        : singleRunXml;
  }

  zip.file("word/document.xml", nextXml);

  return zip.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

function replaceText(xml, needle, value) {
  if (!value) {
    return xml;
  }

  return xml.replace(
    needle,
    escapeXml(value)
  );
}

/*
 * Pure function, no SQLite/filesystem coupling beyond the template file
 * itself - extracted from generateForm3's inline Docxtemplater call so
 * it can be reused by lib/pim-data/form3-documents.js (PostgreSQL,
 * no-Storage render-on-demand) exactly the way renderForm2Template is
 * reused by lib/pim-data/form2.js. Same {{field}} delimiter
 * configuration as the original inline call.
 */
function renderForm3Template(templatePath, values) {
  const templateBinary = fs.readFileSync(templatePath);
  const zip = new PizZip(templateBinary);

  const doc = new Docxtemplater(zip, {
    delimiters: { start: "{{", end: "}}" },
    paragraphLoop: true,
    linebreaks: true,
  });

  doc.render(values);

  return doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

function renderForm2Template(templatePath, values) {
  const templateBinary = fs.readFileSync(templatePath);

  const zip = new PizZip(templateBinary);

  const doc = new Docxtemplater(zip, {
    delimiters: {
      start: "{{",
      end: "}}",
    },
    paragraphLoop: true,
    linebreaks: true,
  });

  doc.render({
    PIM_NUMBER: values.pimNumber,
    APPLICANT_NAME: values.applicantName,
    OPPOSITE_PARTY_NAME: values.oppositePartyName,
    APPEARANCE_DATE: values.appearanceDate,
    APPEARANCE_TIME: values.appearanceTime,
    NOTICE_DATE: values.noticeDate,
    OPPOSITE_PARTY_ADDRESS: values.oppositePartyAddress,
    NOTICE_LABEL: values.noticeLabel,
  });

  return doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

function getForm3Data(caseId) {
  const caseData = db.prepare(`
    SELECT
      c.id,
      c.pim_number,
      c.received_number,
      c.application_date,
      c.registration_date,
      c.current_status_id,
      s.code AS status_code,
      s.name AS status_name
    FROM pim_cases c
    LEFT JOIN status_master s
      ON s.id = c.current_status_id
    WHERE c.id = ?
  `).get(caseId);

  if (!caseData) {
    throw new Error("PIM case not found.");
  }

  const outcome = db.prepare(`
    SELECT
      o.id,
      o.outcome_type,
      o.form_no,
      o.outcome_date,
      o.reason_text,
      o.settlement_terms,
      nr.code AS reason_code,
      nr.name AS reason_name
    FROM pim_outcomes o
    LEFT JOIN nonstarter_reasons nr
      ON nr.id = o.nonstarter_reason_id
    WHERE o.case_id = ?
      AND o.outcome_type = 'NON_STARTER'
  `).get(caseId);

  if (!outcome) {
    throw new Error(
      "Non-starter outcome record was not found."
    );
  }

  const applicant = db.prepare(`
    SELECT
      p.id,
      p.name
    FROM pim_case_parties cp
    JOIN pim_parties p
      ON p.id = cp.party_id
    WHERE cp.case_id = ?
      AND cp.role = 'APPLICANT'
      AND cp.is_primary = 1
    ORDER BY cp.sequence_no, cp.id
    LIMIT 1
  `).get(caseId);

  if (!applicant) {
    throw new Error(
      "Primary applicant was not found."
    );
  }

  const oppositeParty = db.prepare(`
    SELECT
      p.id,
      p.name
    FROM pim_case_parties cp
    JOIN pim_parties p
      ON p.id = cp.party_id
    WHERE cp.case_id = ?
      AND cp.role = 'OPPOSITE_PARTY'
      AND cp.is_primary = 1
    ORDER BY cp.sequence_no, cp.id
    LIMIT 1
  `).get(caseId);

  if (!oppositeParty) {
    throw new Error(
      "Primary opposite party was not found."
    );
  }

  const notice = db.prepare(`
    SELECT
      n.id,
      n.notice_date,
      n.appearance_date,
      n.appearance_time
    FROM pim_notices n
    WHERE n.case_id = ?
    ORDER BY n.id DESC
    LIMIT 1
  `).get(caseId);

  if (!notice) {
    throw new Error(
      "Form-2 notice record was not found."
    );
  }

  return {
    caseData,
    outcome,
    applicant,
    oppositeParty,
    notice,
  };
}

function getOutcomeDocumentData(caseId) {
  const caseData = db.prepare(`
    SELECT
      c.id,
      c.pim_number,
      c.received_number,
      c.application_date,
      c.registration_date,
      c.current_status_id,
      c.outcome_type AS case_outcome_type,
      c.outcome_date AS case_outcome_date,
      c.closed_at,
      s.code AS status_code,
      s.name AS status_name,
      s.is_terminal
    FROM pim_cases c
    LEFT JOIN status_master s
      ON s.id = c.current_status_id
    WHERE c.id = ?
  `).get(caseId);

  if (!caseData) {
    throw new Error("PIM case not found.");
  }

  const outcome = db.prepare(`
    SELECT
      o.*,
      vu.display_name AS verified_by_name,
      vu.designation AS verified_by_designation,
      au.display_name AS approved_by_name,
      au.designation AS approved_by_designation
    FROM pim_outcomes o
    LEFT JOIN users vu
      ON vu.id = o.verified_by
    LEFT JOIN users au
      ON au.id = o.approved_by
    WHERE o.case_id = ?
  `).get(caseId);

  if (!outcome) {
    throw new Error(
      "No mediation outcome has been recorded for this case."
    );
  }

  if (outcome.outcome_type === "NON_STARTER") {
    throw new Error(
      "NON_STARTER documents must be generated through the dedicated non-starter workflow."
    );
  }

  const applicant = getPrimaryParty(
    caseId,
    "APPLICANT"
  );

  if (!applicant) {
    throw new Error(
      "Primary applicant was not found."
    );
  }

  const oppositeParty = getPrimaryParty(
    caseId,
    "OPPOSITE_PARTY"
  );

  if (!oppositeParty) {
    throw new Error(
      "Primary opposite party was not found."
    );
  }

  const assignment = db.prepare(`
    SELECT
      a.*,
      m.name AS mediator_name,
      m.category AS mediator_category,
      m.enrollment_no
    FROM pim_mediator_assignments a
    JOIN mediators m
      ON m.id = a.mediator_id
    WHERE a.case_id = ?
      AND a.status = 'ACTIVE'
    ORDER BY a.id DESC
    LIMIT 1
  `).get(caseId);

  if (!assignment) {
    throw new Error(
      "Active mediator assignment was not found."
    );
  }

  const sessions = db.prepare(`
    SELECT *
    FROM mediation_sessions
    WHERE case_id = ?
      AND session_status = 'COMPLETED'
    ORDER BY sitting_number
  `).all(caseId);

  if (sessions.length === 0) {
    throw new Error(
      "At least one completed mediation session is required for outcome document generation."
    );
  }

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total_sittings,
      SUM(CASE WHEN effective_session = 1 THEN 1 ELSE 0 END) AS effective_sittings,
      COALESCE(
        SUM(
          CASE
            WHEN effective_session = 1
            THEN COALESCE(duration_minutes, 0)
            ELSE 0
          END
        ),
        0
      ) AS effective_duration_minutes
    FROM mediation_sessions
    WHERE case_id = ?
      AND session_status = 'COMPLETED'
  `).get(caseId);

  return {
    caseData,
    outcome,
    applicant,
    oppositeParty,
    assignment,
    sessions,
    summary,
  };
}

function getForm2DocumentData(noticeId) {
  const notice = db.prepare(`
    SELECT
      n.*,
      c.pim_number,
      c.received_number,
      c.application_date,
      c.registration_date,
      p.name AS recipient_name,
      su.display_name AS signed_by_name,
      su.designation AS signed_by_designation
    FROM pim_notices n
    JOIN pim_cases c
      ON c.id = n.case_id
    LEFT JOIN pim_parties p
      ON p.id = n.recipient_party_id
    LEFT JOIN users su
      ON su.id = n.signed_by
    WHERE n.id = ?
  `).get(noticeId);

  if (!notice) {
    throw new Error("Form-2 notice record was not found.");
  }

  if (notice.form_no !== "FORM-2") {
    throw new Error("The selected notice is not a Form-2 notice.");
  }

  if (
    notice.notice_type !== "FORM_2_INITIAL" &&
    notice.notice_type !== "FORM_2_FINAL"
  ) {
    throw new Error(
      `Unsupported Form-2 notice type for document generation: ${notice.notice_type}`
    );
  }

  const applicant = getPrimaryParty(
    notice.case_id,
    "APPLICANT"
  );

  if (!applicant) {
    throw new Error(
      "Primary applicant was not found."
    );
  }

  if (
    !notice.recipient_party_id ||
    !notice.recipient_name
  ) {
    throw new Error(
      "Form-2 recipient opposite party was not found."
    );
  }

  /*
   * Use the exact address this notice was prepared/issued
   * against (Phase 1 pim_notices.address_id) rather than
   * silently re-deriving "the" current address - once a case
   * has more than one notice (Fresh Initial / Final), today's
   * is_current address is no longer guaranteed to be the one
   * this specific notice is addressed to. Older notices created
   * before the address_id column was populated fall back to the
   * current-address lookup.
   */
  const address =
    (notice.address_id
      ? db.prepare(`SELECT * FROM pim_addresses WHERE id = ?`).get(notice.address_id)
      : null) ||
    db.prepare(`
      SELECT *
      FROM pim_addresses
      WHERE party_id = ?
        AND is_current = 1
      ORDER BY
        CASE address_type
          WHEN 'POSTAL' THEN 1
          WHEN 'REGISTERED_OFFICE' THEN 2
          WHEN 'ALTERNATE' THEN 3
          ELSE 4
        END,
        id
      LIMIT 1
    `).get(notice.recipient_party_id) ||
    null;

  return {
    notice,
    applicant,
    oppositeParty: {
      id: notice.recipient_party_id,
      name: notice.recipient_name,
    },
    address,
  };
}

function generateOutcomeDocument({
  caseId,
  versionNo,
}) {
  const data = getOutcomeDocumentData(caseId);
  const officeSettings = getSettings();
  const documentConfig =
    getOutcomeDocumentType(
      data.outcome.outcome_type
    );

  const templatePath = path.join(
    process.cwd(),
    "templates",
    "pim",
    documentConfig.templateName
  );

  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `Official ${documentConfig.title} template not found: ${templatePath}`
    );
  }

  const mediationDates = data.sessions
    .map((session) =>
      formatDate(
        session.actual_date ||
          session.scheduled_date
      )
    )
    .filter(Boolean)
    .join(", ");

  const sittingSummary =
    `${data.summary.total_sittings} sitting(s), ` +
    `${data.summary.effective_sittings || 0} effective, ` +
    `${data.summary.effective_duration_minutes || 0} minutes effective duration`;

  const termsOrReason =
    data.outcome.outcome_type === "SETTLED"
      ? data.outcome.settlement_terms
      : data.outcome.reason_text;

  const outputBuffer = renderOutcomeTemplate(
    templatePath,
    {
      "Name of the Mediator:":
        data.assignment.mediator_name,
      "Name of the applicant:":
        data.applicant.name,
      "Name of the opposite party:":
        data.oppositeParty.name,
      "Date of application for Pre-Institution mediation:":
        formatDate(
          data.caseData.application_date
        ),
      "Venue of mediation:":
        officeSettings.default_mediation_venue,
      "Date(s) of mediation:":
        mediationDates,
      "No. of sittings and duration of sittings:":
        sittingSummary,
      "Reasons for failure:":
        data.outcome.outcome_type === "FAILED"
          ? termsOrReason
          : "",
      "Terms of settlement:":
        data.outcome.outcome_type === "SETTLED"
          ? termsOrReason
          : "",
      "Date:":
        formatDate(
          data.outcome.outcome_date
        ),
    }
  );

  const year = String(
    data.caseData.registration_date ||
      data.caseData.application_date ||
      data.outcome.outcome_date ||
      new Date().getFullYear()
  ).slice(0, 4);

  const storageDirectory = path.join(
    process.cwd(),
    "storage",
    "pim",
    year,
    safePimNumber(
      data.caseData.pim_number,
      caseId
    ),
    documentConfig.folderName
  );

  fs.mkdirSync(storageDirectory, {
    recursive: true,
  });

  const fileName =
    `${documentConfig.folderName}-v${versionNo}.docx`;

  const filePath = path.join(
    storageDirectory,
    fileName
  );

  fs.writeFileSync(filePath, outputBuffer);

  return {
    documentType:
      documentConfig.documentType,
    documentTitle:
      documentConfig.title,
    folderName:
      documentConfig.folderName,
    filePath,
    fileName,
    data,
  };
}

/*
 * The exact template placeholder values Form-2 rendering needs, as a pure
 * function of the data getForm2DocumentData (SQLite) - or its PostgreSQL
 * equivalent, lib/pim-data/form2.js's resolveForm2RenderData - already
 * resolved. Extracted (Batch 5I) so the PostgreSQL path can reuse this
 * exact computation instead of duplicating it: the frozen render_data
 * snapshot a PostgreSQL-generated document stores is exactly this
 * function's return value, and renderForm2Template (below, also now
 * exported) is exactly what re-renders it later - on the SQLite side
 * unchanged, on the PostgreSQL side with no file ever written.
 */
function buildForm2RenderValues(data) {
  const address = data.address
    ? [
        data.address.address_line1,
        data.address.address_line2,
        data.address.village_town,
        data.address.district,
        data.address.state,
        data.address.pincode,
      ]
        .filter(Boolean)
        .join(", ")
    : "";

  const isFinalNotice = data.notice.notice_type === "FORM_2_FINAL";

  return {
    pimNumber: data.notice.pim_number || "",
    applicantName: data.applicant.name,
    oppositePartyName: data.oppositeParty.name,
    noticeDate: formatDate(data.notice.notice_date),
    appearanceDate: formatDate(data.notice.appearance_date),
    appearanceTime: data.notice.appearance_time || "",
    oppositePartyAddress: address,
    noticeLabel: isFinalNotice ? "FINAL NOTICE" : "NOTICE",
  };
}

function form2DocumentTitle(data) {
  const isFinalNotice = data.notice.notice_type === "FORM_2_FINAL";
  return `Form-2 ${isFinalNotice ? "Final" : "Initial"} Notice - ${data.oppositeParty.name}`;
}

function generateForm2Document({
  noticeId,
  versionNo,
}) {
  const data = getForm2DocumentData(noticeId);

  const templatePath = path.join(
    process.cwd(),
    "templates",
    "pim",
    "Form 2.docx"
  );

  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `Official Form-2 template not found: ${templatePath}`
    );
  }

  const year = String(
    data.notice.registration_date ||
      data.notice.application_date ||
      data.notice.notice_date ||
      new Date().getFullYear()
  ).slice(0, 4);

  const storageDirectory = path.join(
    process.cwd(),
    "storage",
    "pim",
    year,
    safePimNumber(
      data.notice.pim_number,
      data.notice.case_id
    ),
    "FORM-2"
  );

  fs.mkdirSync(storageDirectory, {
    recursive: true,
  });

  const outputBuffer = renderForm2Template(
    templatePath,
    buildForm2RenderValues(data)
  );

  /*
   * Disambiguated by noticeId: a case can have more than one
   * Form-2 notice (Initial, Fresh Initial, Final), each with its
   * own version sequence in the same FORM-2 folder.
   */
  const fileName = `FORM-2-N${noticeId}-v${versionNo}.docx`;
  const filePath = path.join(
    storageDirectory,
    fileName
  );

  fs.writeFileSync(filePath, outputBuffer);

  return {
    documentType: "FORM_2",
    documentTitle: form2DocumentTitle(data),
    folderName: "FORM-2",
    filePath,
    fileName,
    data,
  };
}

function generateForm3({
  caseId,
  ruleReference,
  versionNo,
}) {
  if (
    !Number.isInteger(versionNo) ||
    versionNo <= 0
  ) {
    throw new Error(
      "A valid versionNo is required to generate Form-3."
    );
  }

  if (!ruleReference) {
    throw new Error(
      "Rule reference is required for Form-3 generation."
    );
  }

  if (
    ruleReference !== "3(4)" &&
    ruleReference !== "3(6)"
  ) {
    throw new Error(
      "Rule reference must be 3(4) or 3(6)."
    );
  }

  const data = getForm3Data(caseId);

  if (
    data.caseData.status_code !== "CLOSED_NON_STARTER" &&
    data.caseData.status_code !== "OUTCOME_FORM_PENDING" &&
    data.caseData.status_code !== "AUTHORITY_DECISION_PENDING"
  ) {
    throw new Error(
      `Form-3 cannot be generated from status ${
        data.caseData.status_name ||
        data.caseData.status_code
      }.`
    );
  }

  const templatePath = path.join(
    process.cwd(),
    "templates",
    "pim",
    "form3.docx"
  );

  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `Form-3 template not found: ${templatePath}`
    );
  }

  const templateBinary = fs.readFileSync(
    templatePath
  );

  const zip = new PizZip(templateBinary);

  /*
   * IMPORTANT:
   * The Form-3 template uses {{field}} delimiters.
   * Docxtemplater defaults to single {field}
   * delimiters, so explicitly configure {{ and }}.
   */
  const doc = new Docxtemplater(zip, {
    delimiters: {
      start: "{{",
      end: "}}",
    },
    paragraphLoop: true,
    linebreaks: true,
  });

  const reason =
    data.outcome.reason_text ||
    data.outcome.reason_name ||
    "";

  console.log("FORM-3 DATA:", {
    applicant_name:
      data.applicant.name,

    application_date:
      formatDate(
        data.caseData.application_date
      ),

    opposite_party_name:
      data.oppositeParty.name,

    appearance_date:
      formatDate(
        data.notice.appearance_date
      ),

    rule_reference:
      ruleReference,

    nonstarter_reason:
      reason,

    outcome_date:
      formatDate(
        data.outcome.outcome_date
      ),
  });

  doc.render({
    applicant_name:
      data.applicant.name,

    application_date:
      formatDate(
        data.caseData.application_date
      ),

    opposite_party_name:
      data.oppositeParty.name,

    appearance_date:
      formatDate(
        data.notice.appearance_date
      ),

    rule_reference:
      ruleReference,

    nonstarter_reason:
      reason,

    outcome_date:
      formatDate(
        data.outcome.outcome_date
      ),
  });

  const outputBuffer =
    doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

  const pimNumber =
    data.caseData.pim_number ||
    `CASE-${caseId}`;

  const safePimNumber =
    pimNumber.replace(
      /[^a-zA-Z0-9_-]/g,
      "-"
    );

  const storageDirectory =
    path.join(
      process.cwd(),
      "storage",
      "pim",
      String(
        data.caseData.registration_date ||
        data.caseData.application_date ||
        data.caseData.outcome_date
      ).slice(0, 4),
      safePimNumber,
      "FORM-3"
    );

  fs.mkdirSync(
    storageDirectory,
    {
      recursive: true,
    }
  );

  const fileName =
    `FORM-3-v${versionNo}.docx`;

  const filePath =
    path.join(
      storageDirectory,
      fileName
    );

  fs.writeFileSync(
    filePath,
    outputBuffer
  );

  return {
    filePath,
    fileName,
    data,
  };
}

module.exports = {
  generateForm3,
  getForm3Data,
  generateForm2Document,
  getForm2DocumentData,
  generateOutcomeDocument,
  getOutcomeDocumentData,
  getOutcomeDocumentType,
  // Batch 5I: exported for reuse by lib/pim-data/form2.js (PostgreSQL,
  // no-Storage render-on-demand) - pure functions, no SQLite/filesystem
  // access of their own.
  formatDate,
  renderForm2Template,
  buildForm2RenderValues,
  form2DocumentTitle,
  // Production-completion sprint (2026-10-07): exported for reuse by
  // lib/pim-data/outcome-documents.js (PostgreSQL, no-Storage
  // render-on-demand) - pure function, no SQLite/filesystem access of
  // its own.
  renderOutcomeTemplate,
  // Production-completion sprint (2026-10-07): exported for reuse by
  // lib/pim-data/form3-documents.js (PostgreSQL, no-Storage
  // render-on-demand) - pure function, no SQLite/filesystem access of
  // its own.
  renderForm3Template,
};
