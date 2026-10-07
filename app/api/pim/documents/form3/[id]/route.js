/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative, no-storage model (production-completion
 * sprint, 2026-10-07). See lib/pim-data/form3-documents.js. Replaces
 * the SQLite local-file-writing implementation entirely - no SQLite
 * read/write and no filesystem write remain here.
 */

const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  generateForm3DocumentPg,
} = require("../../../../../../lib/pim-data/form3-documents");

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "GENERATE_DOCUMENT");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json();
    const ruleReference = body.ruleReference == null ? null : String(body.ruleReference).trim();
    const regenerate = body.regenerate === true;

    const result = await generateForm3DocumentPg(caseId, { ruleReference, regenerate }, user.id);

    return Response.json({
      success: true,
      message: result.reused ? "Existing current Form-3 document reused." : "Form-3 generated successfully.",
      data: {
        documentId: result.document.id,
        documentType: "FORM_3",
        documentTitle: result.document.document_title,
        versionNo: result.document.version_no,
        downloadUrl: `/api/pim/documents/download/${caseId}/${result.document.id}`,
      },
    });
  } catch (error) {
    console.error("Form-3 document generation error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to generate Form-3." },
      { status: 400 }
    );
  }
}
