const {
  approvePimRegistration,
} = require("../../../../lib/pim-approval");
const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");

export async function POST(request) {
  try {
    const user = requirePermission(
      request,
      "APPROVE_REGISTRATION"
    );

    const body = await request.json();

    const caseId = Number(body.caseId);

    if (
      !Number.isInteger(caseId) ||
      caseId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    const result =
      approvePimRegistration(
        caseId,
        user.id,
        body.remarks || null
      );

    return Response.json({
      success: true,
      message:
        "PIM registration approved successfully.",
      data: result,
    });
  } catch (error) {
    console.error(
      "PIM approval error:",
      error
    );

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to approve PIM registration.",
      },
      { status: 400 }
    );
  }
}
