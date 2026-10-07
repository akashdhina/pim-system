/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * See lib/pim-data/mediator-assignment.js's reassignMediatorPg. Replaces
 * the SQLite db.transaction body - no SQLite read or write remains here.
 */

const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  reassignMediatorPg,
} = require("../../../../../../lib/pim-data/mediator-assignment");

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "ASSIGN_MEDIATOR");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json();

    const mediatorId = Number(body.mediatorId);
    const reason = body.reason ? String(body.reason).trim() : null;

    if (!Number.isInteger(mediatorId) || mediatorId <= 0) {
      return Response.json({ success: false, message: "A valid mediator must be selected." }, { status: 400 });
    }
    if (!reason) {
      return Response.json({ success: false, message: "A reason for reassignment is required." }, { status: 400 });
    }

    const result = await reassignMediatorPg(caseId, { mediatorId, reason }, user.id);

    return Response.json({
      success: true,
      message: `Mediator reassigned from ${result.oldMediatorName} to ${result.newMediatorName}.`,
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediator reassignment error:", error);

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to reassign mediator." },
      { status: 400 }
    );
  }
}
