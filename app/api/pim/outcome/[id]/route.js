/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * See lib/pim-data/outcome.js. Replaces the SQLite db.transaction body -
 * no SQLite read or write remains here.
 */

const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  getOutcomeDataPg,
  recordOutcomePg,
} = require("../../../../../lib/pim-data/outcome");

export async function GET(request, { params }) {
  try {
    requirePermission(request, "READ_CASE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const data = await getOutcomeDataPg(caseId);

    if (!data) {
      return Response.json({ success: false, message: "PIM case not found." }, { status: 404 });
    }

    return Response.json({ success: true, data });
  } catch (error) {
    console.error("Outcome GET error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to load outcome data." },
      { status: 500 }
    );
  }
}

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "RECORD_OUTCOME");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json();

    const input = {
      outcomeType: body.outcomeType,
      outcomeDate: body.outcomeDate ? String(body.outcomeDate).trim() : undefined,
      reasonText: body.reasonText ? String(body.reasonText).trim() : null,
      settlementTerms: body.settlementTerms ? String(body.settlementTerms).trim() : null,
      formNo: body.formNo ? String(body.formNo).trim() : null,
      remarks: body.remarks ? String(body.remarks).trim() : null,
    };

    const result = await recordOutcomePg(caseId, input, user.id);

    return Response.json({
      success: true,
      message: "Mediation outcome recorded successfully. Outcome form is now pending.",
      data: result,
    });
  } catch (error) {
    console.error("Outcome POST error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to record mediation outcome." },
      { status: 400 }
    );
  }
}
