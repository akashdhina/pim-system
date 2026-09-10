const fs = require("fs");
const db = require("../../../../../../lib/db");
const {
  generateOutcomeDocument,
  getOutcomeDocumentType,
} = require("../../../../../../lib/pim-document");
const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");

export const runtime = "nodejs";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getCase(caseId) {
  return db.prepare(`
    SELECT
      c.*,
      s.code AS status_code,
      s.name AS status_name,
      s.is_terminal
    FROM pim_cases c
    JOIN status_master s
      ON s.id = c.current_status_id
    WHERE c.id = ?
  `).get(caseId);
}

function getOutcome(caseId) {
  return db.prepare(`
    SELECT *
    FROM pim_outcomes
    WHERE case_id = ?
  `).get(caseId);
}

function getCurrentDocument(caseId, documentType) {
  return db.prepare(`
    SELECT *
    FROM pim_documents
    WHERE case_id = ?
      AND document_type = ?
      AND is_current = 1
      AND file_path IS NOT NULL
      AND file_path <> ''
    ORDER BY version_no DESC, id DESC
    LIMIT 1
  `).get(caseId, documentType);
}

function serializeDocument(document) {
  return {
    documentId: document.id,
    documentType: document.document_type,
    documentTitle: document.document_title,
    documentDate: document.document_date,
    versionNo: document.version_no,
    isCurrent: document.is_current,
    downloadUrl:
      `/api/pim/documents/download/${document.case_id}/${document.id}`,
  };
}

export async function POST(
  request,
  { params }
) {
  try {
    const user = requirePermission(
      request,
      "GENERATE_DOCUMENT"
    );

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

    const body = await request.json().catch(
      () => ({})
    );

    const regenerate =
      body.regenerate === true;

    const caseData = getCase(caseId);

    if (!caseData) {
      throw new Error("PIM case not found.");
    }

    const outcome = getOutcome(caseId);

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

    if (outcome.outcome_type === "WITHDRAWN") {
      throw new Error(
        "Approved withdrawal document template is not configured."
      );
    }

    const config =
      getOutcomeDocumentType(
        outcome.outcome_type
      );

    /*
     * Phase 8 correction: generation must be possible BEFORE
     * closure - closing the case is gated on the document
     * already existing (see /api/pim/outcome/approve/[id]), not
     * the other way around. Otherwise a case could never
     * generate its required Form IV/Form V at all (closure
     * requires a document; document generation required
     * closure). Regeneration after closure remains allowed too.
     */
    const expectedClosedStatusCode =
      outcome.outcome_type === "SETTLED"
        ? "CLOSED_SETTLED"
        : outcome.outcome_type === "FAILED"
          ? "CLOSED_FAILED"
          : null;

    const canGenerate =
      caseData.status_code === "OUTCOME_FORM_PENDING" ||
      (expectedClosedStatusCode &&
        caseData.status_code === expectedClosedStatusCode);

    if (!canGenerate) {
      throw new Error(
        `Outcome document generation is not available from the current case status: ${caseData.status_name}`
      );
    }

    const currentDocument = getCurrentDocument(
      caseId,
      config.documentType
    );

    if (
      currentDocument &&
      !regenerate &&
      fs.existsSync(currentDocument.file_path)
    ) {
      if (
        outcome.document_id !==
        currentDocument.id
      ) {
        db.prepare(`
          UPDATE pim_outcomes
          SET document_id = ?
          WHERE id = ?
        `).run(
          currentDocument.id,
          outcome.id
        );
      }

      return Response.json({
        success: true,
        message:
          "Existing current outcome document reused.",
        data: {
          reused: true,
          ...serializeDocument(
            currentDocument
          ),
        },
      });
    }

    const versionRow = db.prepare(`
      SELECT
        COALESCE(MAX(version_no), 0) + 1
          AS next_version
      FROM pim_documents
      WHERE case_id = ?
        AND document_type = ?
    `).get(caseId, config.documentType);

    const nextVersion =
      versionRow.next_version;

    const generated = generateOutcomeDocument({
      caseId,
      versionNo: nextVersion,
    });

    const document = db.transaction(() => {
      db.prepare(`
        UPDATE pim_documents
        SET is_current = 0
        WHERE case_id = ?
          AND document_type = ?
          AND is_current = 1
      `).run(caseId, config.documentType);

      const inserted = db.prepare(`
        INSERT INTO pim_documents
        (
          case_id,
          document_type,
          document_title,
          document_date,
          file_path,
          generated_by_system,
          version_no,
          is_current,
          remarks,
          created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        caseId,
        generated.documentType,
        generated.documentTitle,
        outcome.outcome_date || today(),
        generated.filePath,
        1,
        nextVersion,
        1,
        `Generated from approved ${outcome.outcome_type} outcome.`,
        user.id
      );

      const documentId = Number(
        inserted.lastInsertRowid
      );

      db.prepare(`
        UPDATE pim_outcomes
        SET document_id = ?
        WHERE id = ?
      `).run(
        documentId,
        outcome.id
      );

      return db.prepare(`
        SELECT *
        FROM pim_documents
        WHERE id = ?
      `).get(documentId);
    })();

    return Response.json({
      success: true,
      message:
        `${generated.documentTitle} generated successfully.`,
      data: {
        reused: false,
        ...serializeDocument(document),
      },
    });
  } catch (error) {
    console.error(
      "Outcome document generation error:",
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
            : "Unable to generate outcome document.",
      },
      { status: 400 }
    );
  }
}
