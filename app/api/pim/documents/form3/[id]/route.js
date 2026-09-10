const db = require("../../../../../../lib/db");
const {
  generateForm3,
} = require("../../../../../../lib/pim-document");
const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");

export const runtime = "nodejs";

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

    const body = await request.json();

    const ruleReference =
      body.ruleReference == null
        ? null
        : String(body.ruleReference).trim();

    /*
     * Version is computed before generating the physical file so
     * generateForm3() can name it FORM-3-v<n>.docx directly -
     * prior versions are never overwritten.
     */
    const nextVersionRow = db.prepare(`
      SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version
      FROM pim_documents
      WHERE case_id = ?
        AND document_type = 'FORM_3'
    `).get(caseId);

    const nextVersion = nextVersionRow.next_version;

    const generated = generateForm3({
      caseId,
      ruleReference,
      versionNo: nextVersion,
    });

    const document = db.transaction(() => {
      const existingCurrent = db.prepare(`
        SELECT id
        FROM pim_documents
        WHERE case_id = ?
          AND document_type = 'FORM_3'
          AND is_current = 1
        ORDER BY version_no DESC, id DESC
        LIMIT 1
      `).get(caseId);

      if (existingCurrent) {
        db.prepare(`
          UPDATE pim_documents
          SET is_current = 0
          WHERE id = ?
        `).run(existingCurrent.id);
      }

      const result = db.prepare(`
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
        "FORM_3",
        "Form 3: Non-Starter Report",
        generated.data.outcome.outcome_date,
        generated.filePath,
        1,
        nextVersion,
        1,
        `Generated for non-starter reason: ${
          generated.data.outcome.reason_name ||
          generated.data.outcome.reason_text ||
          ""
        }`,
        user.id
      );

      return {
        id: Number(result.lastInsertRowid),
        versionNo: nextVersion,
        filePath: generated.filePath,
      };
    })();

    return Response.json({
      success: true,
      message: "Form-3 generated successfully.",
      data: {
        documentId: document.id,
        documentType: "FORM_3",
        documentTitle:
          "Form 3: Non-Starter Report",
        versionNo: document.versionNo,
        filePath: document.filePath,
        pimNumber:
          generated.data.caseData.pim_number,
      },
    });
  } catch (error) {
    console.error(
      "Form-3 document generation error:",
      error
    );

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    if (error && error.properties) {
      console.error(
        "Docxtemplater properties:",
        JSON.stringify(
          error.properties,
          null,
          2
        )
      );
    }

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to generate Form-3.",
        details:
          error && error.properties
            ? error.properties
            : null,
      },
      { status: 400 }
    );
  }
}
