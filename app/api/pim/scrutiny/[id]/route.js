/* eslint-disable @typescript-eslint/no-require-imports */

const {
  getScrutinyCase, // SQLite version - kept unused by GET as an instant rollback (Batch 5F)
  saveScrutiny, // SQLite version - kept unused by POST as an instant rollback (Batch 5E)
} = require("../../../../../lib/pim-scrutiny");
const {
  saveScrutinyPg,
} = require("../../../../../lib/pim-data/scrutiny");
const {
  getScrutinyCasePg,
} = require("../../../../../lib/pim-data/scrutiny-read");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");

export async function GET(request, context) {
  try {
    requirePermission(request, "READ_CASE");

    const { id } = await context.params;

    const caseId = Number(id);

    if (!Number.isInteger(caseId)) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    // Batch 5F (Phase 6): migrated to PostgreSQL via lib/pim-data/scrutiny-read.js.
    const data = await getScrutinyCasePg(caseId);

    return Response.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error?.message ||
          "Unable to load scrutiny.",
      },
      { status: 400 }
    );
  }
}

export async function POST(request, context) {
  try {
    const user = requirePermission(
      request,
      "COMPLETE_SCRUTINY"
    );

    const { id } = await context.params;

    const caseId = Number(id);

    if (!Number.isInteger(caseId)) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    const body = await request.json();

    // Batch 5E (Phase 6): migrated to PostgreSQL via lib/pim-data/scrutiny.js.
    const result = await saveScrutinyPg(
      caseId,
      body,
      user.id
    );

    return Response.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error(error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error?.message ||
          "Unable to save scrutiny.",
      },
      { status: 400 }
    );
  }
}
