/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * See lib/pim-data/mediation.js. Replaces the SQLite db.transaction body
 * - no SQLite read or write remains here.
 */

const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  fixNextMediationDatePg,
} = require("../../../../../../lib/pim-data/mediation");

export async function POST(request, { params }) {
  try {
    const user = await requirePermission(request, "RECORD_MEDIATION_SESSION");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json();
    const scheduledDate = body.scheduledDate ? String(body.scheduledDate).trim() : null;
    const remarks = body.remarks ? String(body.remarks).trim() : null;

    if (!scheduledDate) {
      return Response.json({ success: false, message: "Next mediation date is required." }, { status: 400 });
    }

    const result = await fixNextMediationDatePg(caseId, { scheduledDate, remarks }, user.id);

    return Response.json({
      success: true,
      message: "Next mediation sitting fixed successfully.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Next mediation error:", error);

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to fix next mediation sitting." },
      { status: 400 }
    );
  }
}
