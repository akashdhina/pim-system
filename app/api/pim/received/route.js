import { NextResponse } from "next/server";

const {
  createReceivedPimApplication,
} = require("../../../../lib/pim");
const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");

export async function POST(request) {
  try {
    const user = requirePermission(
      request,
      "ENTER_APPLICATION"
    );

    const data = await request.json();

    const caseId = createReceivedPimApplication(
      data,
      user.id
    );

    return NextResponse.json(
      {
        success: true,
        caseId,
        message: "Received PIM application saved successfully.",
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("PIM RECEIVED APPLICATION ERROR:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return NextResponse.json(
      {
        success: false,
        message:
          error?.message ||
          "Unable to save received PIM application.",
      },
      { status: 400 }
    );
  }
}
