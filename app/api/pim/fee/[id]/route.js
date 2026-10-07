/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative mediation fee route (production-completion
 * sprint, 2026-10-07). See docs/phase6-mediation-fee-migration.md and
 * lib/pim-data/fee.js.
 *
 * Replaces the SQLite implementation's single mutable pim_fees row with
 * immutable per-payment transactions (pim_fee_payments) and a derived
 * per-side summary - never a single cumulative total.
 *
 * GET  -> case + derived fee summary (per side) + full payment list.
 * POST { payingSide, amount, paymentDate?, paymentMode?, ddNumber?,
 *        ddDate?, bankName?, referenceNumber?, remarks? }
 *      -> records ONE payment for ONE side. Submit twice (once per side)
 *         for a single combined receipt covering both sides.
 */

const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  recordFeePaymentPg,
  getFeeDataPg,
} = require("../../../../../lib/pim-data/fee");

export async function GET(request, { params }) {
  try {
    requirePermission(request, "READ_CASE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const data = await getFeeDataPg(caseId);

    if (!data) {
      return Response.json({ success: false, message: "PIM case not found." }, { status: 404 });
    }

    return Response.json({ success: true, data });
  } catch (error) {
    console.error("Fee GET error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unable to load fee data.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "RECORD_FEE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json({ success: false, message: "Invalid case ID." }, { status: 400 });
    }

    const body = await request.json();

    const result = await recordFeePaymentPg(
      caseId,
      {
        payingSide: body.payingSide,
        amount: body.amount,
        paymentDate: body.paymentDate ? String(body.paymentDate).trim() : undefined,
        paymentMode: body.paymentMode ? String(body.paymentMode).trim() : undefined,
        ddNumber: body.ddNumber ? String(body.ddNumber).trim() : null,
        ddDate: body.ddDate ? String(body.ddDate).trim() : null,
        bankName: body.bankName ? String(body.bankName).trim() : null,
        referenceNumber: body.referenceNumber ? String(body.referenceNumber).trim() : null,
        remarks: body.remarks ? String(body.remarks).trim() : null,
      },
      user.id
    );

    return Response.json({
      success: true,
      message:
        result.statusCode === "MEDIATOR_ASSIGNMENT_PENDING"
          ? "Mediation fee received in full from both sides. Mediator assignment is now pending."
          : "Mediation fee payment recorded. Case remains pending until both sides' full share is received.",
      data: result,
    });
  } catch (error) {
    console.error("Fee POST error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unable to record mediation fee.",
      },
      { status: 400 }
    );
  }
}
