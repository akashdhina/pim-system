/* eslint-disable @typescript-eslint/no-require-imports */

const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  resetPassword,
} = require("../../../../../../lib/pim-users");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");

function parseId(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error("Invalid user ID.");
    error.status = 400;
    throw error;
  }
  return id;
}

export async function POST(request, { params }) {
  try {
    const actor = requirePermission(request, "RESET_USER_PASSWORD");
    const body = await request.json();
    const user = resetPassword(parseId(params), body, actor.id);

    return Response.json({
      success: true,
      message: "Temporary password issued.",
      data: {
        user,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Unable to reset password.",
        details: error && error.details ? error.details : undefined,
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}
