/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * See lib/pim-data/mediation.js. Replaces the SQLite db.transaction body
 * - no SQLite read or write remains here.
 */

const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  getMediationCaseDataPg,
  fixFirstMediationDatePg,
} = require("../../../../../lib/pim-data/mediation");

export async function GET(request, { params }) {
  try {
    await requirePermission(request, "READ_CASE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const data = await getMediationCaseDataPg(caseId);

    if (!data) {
      return Response.json({ success: false, message: "PIM case not found." }, { status: 404 });
    }

    return Response.json({ success: true, data });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediation GET error:", error);

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to load mediation data." },
      { status: 500 }
    );
  }
}

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
      return Response.json({ success: false, message: "First mediation date is required." }, { status: 400 });
    }

    const result = await fixFirstMediationDatePg(caseId, { scheduledDate, remarks }, user.id);

    return Response.json({
      success: true,
      message: "First mediation date fixed successfully. Mediation is now pending.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediation POST error:", error);

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to fix first mediation date." },
      { status: 400 }
    );
  }
}
