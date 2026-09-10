/* eslint-disable @typescript-eslint/no-require-imports */

const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  revokeSessions,
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
    const actor = requirePermission(request, "REVOKE_USER_SESSION");
    const revokedSessions = revokeSessions(parseId(params), actor.id);

    return Response.json({
      success: true,
      message: "Sessions revoked successfully.",
      data: {
        revokedSessions,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Unable to revoke sessions.",
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}
