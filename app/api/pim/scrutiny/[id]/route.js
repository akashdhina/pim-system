const {
  getScrutinyCase,
  saveScrutiny,
} = require("../../../../../lib/pim-scrutiny");
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

    const data = getScrutinyCase(caseId);

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

    const result = saveScrutiny(
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
