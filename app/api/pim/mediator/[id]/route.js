/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * See lib/pim-data/mediator-assignment.js. Replaces the SQLite
 * db.transaction body - no SQLite read or write remains here.
 */

const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  getMediatorAssignmentDataPg,
  assignMediatorPg,
} = require("../../../../../lib/pim-data/mediator-assignment");

export async function GET(request, { params }) {
  try {
    await requirePermission(request, "READ_CASE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const data = await getMediatorAssignmentDataPg(caseId);

    if (!data) {
      return Response.json({ success: false, message: "PIM case not found." }, { status: 404 });
    }

    return Response.json({ success: true, data });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediator GET error:", error);

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to load mediator assignment data." },
      { status: 500 }
    );
  }
}

export async function POST(request, { params }) {
  try {
    const user = await requirePermission(request, "ASSIGN_MEDIATOR");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json();

    const input = {
      mediatorId: Number(body.mediatorId),
      assignmentOrderNo: body.assignmentOrderNo ? String(body.assignmentOrderNo).trim() : null,
      firstMediationDate: body.firstMediationDate ? String(body.firstMediationDate).trim() : null,
      deviationFromRotation: Boolean(body.deviationFromRotation),
      deviationReason: body.deviationReason ? String(body.deviationReason).trim() : null,
      remarks: body.remarks ? String(body.remarks).trim() : null,
    };

    if (!Number.isInteger(input.mediatorId) || input.mediatorId <= 0) {
      return Response.json({ success: false, message: "A valid mediator must be selected." }, { status: 400 });
    }
    if (input.deviationFromRotation && !input.deviationReason) {
      return Response.json({ success: false, message: "Deviation reason is required when rotation is overridden." }, { status: 400 });
    }

    const result = await assignMediatorPg(caseId, input, user.id);

    return Response.json({
      success: true,
      message: "Mediator assigned successfully. Fix the first mediation date to proceed.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediator POST error:", error);

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to assign mediator." },
      { status: 400 }
    );
  }
}
