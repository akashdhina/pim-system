/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Controlled correction of an already-assigned PIM number. Normal staff
 * cannot silently edit pim_number once set (app/api/pim/pim-number/route.js
 * only ever assigns when none exists) - this is the only path that can
 * change it, and every call is audited in pim_number_corrections
 * (old number, new number, reason, who, when). See
 * lib/pim-data/pim-numbering.js's correctPimNumberPg and
 * docs/phase6-manual-pim-numbering.md.
 */

const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  correctPimNumberPg,
} = require("../../../../../../lib/pim-data/pim-numbering");

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "ASSIGN_PIM_NUMBER");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const runningNumber = Number(body.runningNumber);
    const year = Number(body.year);
    const reason = body.reason ? String(body.reason).trim() : "";

    const result = await correctPimNumberPg(caseId, runningNumber, year, reason, user.id);

    return Response.json({
      success: true,
      message: `PIM number corrected to ${result.newPimNumber}.`,
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("PIM number correction error:", error);

    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unable to correct the PIM number.",
      },
      { status: 400 }
    );
  }
}
