/* eslint-disable @typescript-eslint/no-require-imports */

const {
  getLegacyImportMetadata,
  importLegacyCase,
  previewLegacyImport,
} = require("../../../../lib/pim-legacy-import");
const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");

export async function GET(request) {
  try {
    requirePermission(request, "IMPORT_LEGACY_CASE");

    return Response.json({
      success: true,
      data: getLegacyImportMetadata(),
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
            : "Unable to load legacy import setup.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const user = requirePermission(
      request,
      "IMPORT_LEGACY_CASE"
    );
    const body = await request.json();

    if (body && body.preview === true) {
      const preview = previewLegacyImport(body, user.id);

      return Response.json({
        success: true,
        message: "Preview generated. No data has been saved yet.",
        data: preview,
      });
    }

    const result = importLegacyCase(body, user.id);

    return Response.json(
      {
        success: true,
        message: "Legacy case imported successfully.",
        data: result,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Legacy import error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    const duplicate =
      error instanceof Error &&
      error.message.includes("Duplicate import blocked");

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to import legacy case.",
      },
      { status: duplicate ? 409 : 400 }
    );
  }
}
