/* eslint-disable @typescript-eslint/no-require-imports */

const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  createUser,
  listUsers, // SQLite version - kept unused by GET as an instant rollback (Batch 4)
} = require("../../../../lib/pim-users");
const {
  listUsers: listUsersPg,
} = require("../../../../lib/pim-data/users");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");

export async function GET(request) {
  try {
    requirePermission(request, "VIEW_USERS");

    // Batch 4 (Phase 6): migrated to PostgreSQL via lib/pim-data/users.js.
    // The permission check above is unchanged - still the SQLite-backed
    // lib/pim-auth.js session/user resolution, run before any data access.
    const { searchParams } = new URL(request.url);
    const result = await listUsersPg({
      search: searchParams.get("search") || "",
      role: searchParams.get("role") || "",
      active: searchParams.get("active") || "",
      page: Number(searchParams.get("page") || 1),
      pageSize: Number(searchParams.get("pageSize") || 25),
    });

    return Response.json({
      success: true,
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Unable to load users.",
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}

export async function POST(request) {
  try {
    const actor = requirePermission(request, "MANAGE_USERS");
    const body = await request.json();
    const user = createUser(body, actor.id);

    return Response.json(
      {
        success: true,
        message: "User created successfully.",
        data: {
          user,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Unable to create user.",
        details: error && error.details ? error.details : undefined,
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}
