/* eslint-disable @typescript-eslint/no-require-imports */

const {
  assertSafeStateChange,
  changePassword,
  getCurrentUser,
  revokeOtherSessions,
} = require("../../../../../lib/pim-auth");

export async function POST(request) {
  try {
    assertSafeStateChange(request);

    const user = getCurrentUser(request);
    if (!user) {
      return Response.json(
        {
          success: false,
          message: "Authentication required.",
        },
        { status: 401 }
      );
    }

    const body = await request.json();

    changePassword(
      user.id,
      body.currentPassword || "",
      body.newPassword || "",
      body.confirmPassword || "",
      {
        skipCurrentPassword: Boolean(user.must_change_password),
      }
    );

    const revokedSessions = revokeOtherSessions(user.id, request);

    return Response.json({
      success: true,
      message: "Password changed successfully.",
      data: {
        revokedSessions,
      },
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to change password.",
        details: error && error.details ? error.details : undefined,
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}
