/* eslint-disable @typescript-eslint/no-require-imports */

const {
  assertSafeStateChange,
  authenticateUser,
  createSession,
  sessionCookie,
} = require("../../../../../lib/pim-auth");

export async function POST(request) {
  try {
    assertSafeStateChange(request);

    const body = await request.json();
    const user = authenticateUser(body.username, body.password);
    const session = createSession(user.id, request);

    const response = Response.json({
      success: true,
      user,
      must_change_password: user.must_change_password,
    });

    response.headers.set(
      "Set-Cookie",
      sessionCookie(session.token, session.expiresAt)
    );

    return response;
  } catch (error) {
    const status = error && error.status ? error.status : 400;

    return Response.json(
      {
        success: false,
        message:
          status === 401
            ? "Invalid username or password."
            : error instanceof Error
              ? error.message
              : "Unable to sign in.",
      },
      { status }
    );
  }
}
