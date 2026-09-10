/* eslint-disable @typescript-eslint/no-require-imports */

const {
  assertSafeStateChange,
  clearSessionCookie,
  revokeCurrentSession,
} = require("../../../../../lib/pim-auth");

export async function POST(request) {
  try {
    assertSafeStateChange(request);
    revokeCurrentSession(request);

    const response = Response.json({
      success: true,
      message: "Signed out successfully.",
    });

    response.headers.set("Set-Cookie", clearSessionCookie());

    return response;
  } catch (error) {
    return Response.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Unable to sign out.",
      },
      { status: error && error.status ? error.status : 400 }
    );
  }
}
