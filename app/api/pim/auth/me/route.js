/* eslint-disable @typescript-eslint/no-require-imports */

const {
  can,
  getCurrentUser,
  permissionSummary,
} = require("../../../../../lib/pim-auth");

export async function GET(request) {
  const user = getCurrentUser(request);

  if (!user) {
    return Response.json(
      {
        success: false,
        user: null,
        permissions: {},
      },
      { status: 401 }
    );
  }

  const permissions = {};

  for (const permission of Object.keys(permissionSummary())) {
    permissions[permission] = can(user, permission);
  }

  return Response.json({
    success: true,
    user,
    permissions,
  });
}
