/* eslint-disable @typescript-eslint/no-require-imports */

const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");
const {
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
} = require("../../../../lib/pim-settings");

export async function GET(request) {
  try {
    requirePermission(request, "VIEW_SETTINGS");

    return Response.json({
      success: true,
      data: {
        settings: getSettings(),
        keys: Object.keys(DEFAULT_SETTINGS),
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Settings GET error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load office settings.",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request) {
  try {
    const user = requirePermission(request, "MANAGE_SETTINGS");
    const body = await request.json().catch(() => ({}));
    const settings = updateSettings(body.settings || body, user.id);

    return Response.json({
      success: true,
      message: "Office settings updated successfully.",
      data: { settings },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    const status = error && error.status === 400 ? 400 : 500;

    console.error("Settings PATCH error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to update office settings.",
        details: error && error.details ? error.details : null,
      },
      { status }
    );
  }
}
