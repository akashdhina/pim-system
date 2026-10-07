/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * See lib/pim-data/nonstarter.js's recordNonStarterAuthorityDecisionPg.
 * Replaces the SQLite db.transaction body - no SQLite read or write
 * remains here.
 */

const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  recordNonStarterAuthorityDecisionPg,
} = require("../../../../../../lib/pim-data/nonstarter");

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "APPROVE_NONSTARTER_AUTHORITY");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json();
    const remarks = body.remarks ? String(body.remarks).trim() : null;

    const result = await recordNonStarterAuthorityDecisionPg(caseId, { remarks }, user.id);

    return Response.json({
      success: true,
      message: "Authority decision recorded and case closed as Non-Starter.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Non-starter authority POST error:", error);

    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unable to record authority decision.",
      },
      { status: 400 }
    );
  }
}
