/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5H-b: opens (or mid-year onboards) a year's PIM-number
 * sequence. Deliberately separate from and more restricted than
 * POST /api/pim/pim-number (ordinary assignment) - see
 * docs/phase6-batch5h-b-pim-numbering.md. Not a routine action: a year
 * can only be initialized once (lib/pim-data/pim-numbering.js's
 * initializePimSequencePg relies on the year primary key to reject a
 * second attempt with a clear business error, not a silent overwrite).
 */

const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  initializePimSequencePg,
} = require("../../../../../lib/pim-data/pim-numbering");

function validationError(message) {
  return Response.json({ success: false, message }, { status: 400 });
}

export async function POST(request) {
  try {
    const user = requirePermission(request, "INITIALIZE_PIM_SEQUENCE");

    const body = await request.json().catch(() => ({}));
    const year = Number(body.year);
    const lastNumber = Number(body.lastNumber);

    if (!Number.isInteger(year)) {
      return validationError("Valid year is required.");
    }
    if (!Number.isInteger(lastNumber) || lastNumber < 0) {
      return validationError("last_number must be a whole number, zero or greater.");
    }

    const row = await initializePimSequencePg(year, lastNumber, user.id);

    return Response.json({
      success: true,
      message: `PIM-number sequence for ${year} initialized.`,
      data: row,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("PIM number sequence initialization error:", error);

    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unable to initialize the PIM-number sequence.",
      },
      { status: 400 }
    );
  }
}
