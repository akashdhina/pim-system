/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * See lib/pim-data/nonstarter.js's completeNonStarterForm3Pg. Replaces
 * the SQLite db.transaction body - no SQLite read or write remains here.
 */

const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  completeNonStarterForm3Pg,
} = require("../../../../../../lib/pim-data/nonstarter");

export async function POST(request, { params }) {
  try {
    const user = await requirePermission(request, "COMPLETE_NONSTARTER_FORM3");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json();
    const documentId = body.documentId == null ? null : Number(body.documentId);
    const remarks = body.remarks ? String(body.remarks).trim() : null;

    const result = await completeNonStarterForm3Pg(caseId, { documentId, remarks }, user.id);

    return Response.json({
      success: true,
      message:
        result.statusCode === "CLOSED_NON_STARTER"
          ? "Form-3 completed, document stored, and PIM case closed as Non-Starter."
          : "Form-3 completed and document stored. Authority decision is now pending.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Non-starter Form-3 POST error:", error);

    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unable to complete Form-3.",
      },
      { status: 400 }
    );
  }
}
