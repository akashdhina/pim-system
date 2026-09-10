/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");

export async function GET(request) {
  try {
    requirePermission(request, "VIEW_BACKUP");

    const filePath = path.join(
      process.cwd(),
      "documents",
      "sqlite-restore-procedure.md"
    );
    const text = fs.readFileSync(filePath, "utf8");

    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition":
          "inline; filename=\"sqlite-restore-procedure.md\"",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load restore instructions.",
      },
      { status: 500 }
    );
  }
}
