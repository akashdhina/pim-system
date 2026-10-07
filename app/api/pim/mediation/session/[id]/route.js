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
  getMediationSessionPg,
  recordMediationSessionPg,
} = require("../../../../../../lib/pim-data/mediation");

export async function GET(request, { params }) {
  try {
    await requirePermission(request, "READ_CASE");

    const { id } = await params;
    const sessionId = Number(id);

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return Response.json({ success: false, message: "Invalid session ID." }, { status: 400 });
    }

    const session = await getMediationSessionPg(sessionId);

    if (!session) {
      return Response.json({ success: false, message: "Mediation session not found." }, { status: 404 });
    }

    return Response.json({ success: true, data: { session } });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Session GET error:", error);

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to load session." },
      { status: 500 }
    );
  }
}

export async function POST(request, { params }) {
  try {
    const user = await requirePermission(request, "RECORD_MEDIATION_SESSION");

    const { id } = await params;
    const sessionId = Number(id);

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return Response.json({ success: false, message: "Invalid session ID." }, { status: 400 });
    }

    const body = await request.json();

    const input = {
      actualDate: body.actualDate ? String(body.actualDate).trim() : null,
      applicantPresent: Boolean(body.applicantPresent),
      oppositePartyPresent: Boolean(body.oppositePartyPresent),
      actualStartTime: body.actualStartTime ? String(body.actualStartTime).trim() : null,
      actualEndTime: body.actualEndTime ? String(body.actualEndTime).trim() : null,
      nextDate: body.nextDate ? String(body.nextDate).trim() : null,
      administrativeRemarks: body.administrativeRemarks ? String(body.administrativeRemarks).trim() : null,
      nextAction: body.nextAction || null,
    };

    const result = await recordMediationSessionPg(sessionId, input, user.id);

    if (result.conflict) {
      return Response.json({ success: false, message: result.message }, { status: 409 });
    }

    return Response.json({
      success: true,
      message: result.effectiveSession
        ? "Effective mediation session recorded successfully."
        : "Mediation sitting recorded as ineffective.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Session POST error:", error);

    return Response.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to record mediation session." },
      { status: 400 }
    );
  }
}
