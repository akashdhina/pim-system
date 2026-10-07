/* eslint-disable @typescript-eslint/no-require-imports */

const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  getUser, // SQLite version - kept unused by GET as an instant rollback (Batch 4)
  updateUser,
} = require("../../../../../lib/pim-users");
const {
  getUser: getUserPg,
} = require("../../../../../lib/pim-data/users");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");

function parseId(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error("Invalid user ID.");
    error.status = 400;
    throw error;
  }
  return id;
}

export async function GET(request, { params }) {
  try {
    requirePermission(request, "VIEW_USERS");
    // Batch 4 (Phase 6): migrated to PostgreSQL via lib/pim-data/users.js.
    const user = await getUserPg(parseId(params));

    return Response.json({
      success: true,
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
          error instanceof Error ? error.message : "Unable to load user.",
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}

export async function PATCH(request, { params }) {
  try {
    const actor = requirePermission(request, "MANAGE_USERS");
    const body = await request.json();
    const user = updateUser(parseId(params), body, actor.id);

    return Response.json({
      success: true,
      message: "User updated successfully.",
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
          error instanceof Error ? error.message : "Unable to update user.",
        details: error && error.details ? error.details : undefined,
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}
