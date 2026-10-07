/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5H-b, superseded 2026-10-07 by the numbering policy
 * reversal: the PIM number is no longer auto-allocated from
 * pim_number_sequences. Staff reads the official running number off the
 * physical PIM/Assignment Register and enters it; this route validates
 * and stores it. See docs/phase6-manual-pim-numbering.md.
 *
 * GET  ?year=YYYY           -> read-only: last registered running number
 *                              for that year (reference only, never
 *                              auto-filled/auto-submitted).
 * POST { caseId, runningNumber, year, confirmGap, confirmLower }
 *                           -> validates and stores the manually-entered
 *                              number. May come back with
 *                              { requiresConfirmation: true, warningType,
 *                              message } instead of writing anything, if
 *                              the number is out of sequence - the caller
 *                              must re-submit with confirmGap/confirmLower
 *                              set once staff has confirmed.
 *
 * assignPimNumberPg (pim_number_sequences auto-increment) is left
 * unchanged in lib/pim-data/pim-numbering.js for historical/rollback
 * reference only - not called from here.
 */

const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");
const {
  officeYear,
} = require("../../../../lib/pim-time");
const {
  getLastRegisteredNumber,
  assignPimNumberManualPg,
} = require("../../../../lib/pim-data/pim-numbering");

function validationError(message) {
  return Response.json({ success: false, message }, { status: 400 });
}

export async function GET(request) {
  try {
    requirePermission(request, "ASSIGN_PIM_NUMBER");

    const url = new URL(request.url);
    const yearParam = url.searchParams.get("year");
    const year = yearParam ? Number(yearParam) : Number(officeYear());

    if (!Number.isInteger(year)) {
      return validationError("Invalid year.");
    }

    const lastRegistered = await getLastRegisteredNumber(year);

    return Response.json({ success: true, data: lastRegistered });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("PIM number lookup error:", error);

    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unable to load the last registered PIM number.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const user = requirePermission(request, "ASSIGN_PIM_NUMBER");

    const body = await request.json().catch(() => ({}));
    const caseId = Number(body.caseId);
    const runningNumber = Number(body.runningNumber);
    const year = body.year ? Number(body.year) : Number(officeYear());

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return validationError("Invalid case ID.");
    }
    if (!Number.isInteger(runningNumber) || runningNumber <= 0) {
      return validationError("Enter the PIM running number from the official register (a positive whole number).");
    }

    const result = await assignPimNumberManualPg(caseId, runningNumber, year, user.id, {
      confirmGap: Boolean(body.confirmGap),
      confirmLower: Boolean(body.confirmLower),
    });

    if (result.requiresConfirmation) {
      return Response.json({ success: true, data: result });
    }

    return Response.json({
      success: true,
      message: "PIM number registered successfully.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("PIM number assignment error:", error);

    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unable to register the PIM number.",
      },
      { status: 400 }
    );
  }
}
