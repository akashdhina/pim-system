/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * See lib/pim-data/outcome.js. Replaces the SQLite db.transaction body -
 * no SQLite read or write remains here.
 */

const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  getOutcomeApprovalDataPg,
  approveOutcomePg,
} = require("../../../../../../lib/pim-data/outcome");

export async function GET(request, { params }) {
  try {
    requirePermission(request, "READ_CASE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const data = await getOutcomeApprovalDataPg(caseId);

    if (!data) {
      return Response.json({ success: false, message: "PIM case not found." }, { status: 404 });
    }

    return Response.json({ success: true, data });
  } catch (error) {
    console.error("Outcome approval GET error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to load outcome approval data." },
      { status: 500 }
    );
  }
}

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "APPROVE_OUTCOME");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json();
    const remarks = body.remarks ? String(body.remarks).trim() : null;

    const result = await approveOutcomePg(caseId, { remarks }, user.id);

    if (result.conflict) {
      return Response.json({ success: false, message: result.message }, { status: 409 });
    }

    return Response.json({
      success: true,
      message: `PIM outcome approved and case closed as ${result.outcomeType}.`,
      data: result,
    });
  } catch (error) {
    console.error("Outcome approval POST error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to approve outcome." },
      { status: 400 }
    );
  }
}
