/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative, no-storage model (production-completion
 * sprint, 2026-10-07). See lib/pim-data/outcome-documents.js. Replaces
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
  generateOutcomeDocumentPg,
} = require("../../../../../../lib/pim-data/outcome-documents");

function serializeDocument(document, caseId) {
  return {
    documentId: document.id,
    documentType: document.document_type,
    documentTitle: document.document_title,
    documentDate: document.document_date,
    versionNo: document.version_no,
    isCurrent: document.is_current,
    downloadUrl: `/api/pim/documents/download/${caseId}/${document.id}`,
  };
}

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "GENERATE_DOCUMENT");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const regenerate = body.regenerate === true;

    const result = await generateOutcomeDocumentPg(caseId, { regenerate }, user.id);

    return Response.json({
      success: true,
      message: result.reused
        ? "Existing current outcome document reused."
        : `${result.document.document_title} generated successfully.`,
      data: {
        reused: result.reused,
        ...serializeDocument(result.document, caseId),
      },
    });
  } catch (error) {
    console.error("Outcome document generation error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to generate outcome document." },
      { status: 400 }
    );
  }
}
