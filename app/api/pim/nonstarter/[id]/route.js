/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  getCase,
  getActiveNonStarterReasons,
  inferNonStarterContext,
  recordNonStarter,
} = require("../../../../../lib/pim-nonstarter");

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

export async function GET(
  request,
  { params }
) {
  try {
    requirePermission(request, "READ_CASE");

    const { id } = await params;
    const caseId = Number(id);

    if (
      !Number.isInteger(caseId) ||
      caseId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    const caseData = getCase(caseId);

    if (!caseData) {
      return Response.json(
        {
          success: false,
          message: "PIM case not found.",
        },
        { status: 404 }
      );
    }

    const outcome = db.prepare(`
      SELECT
        o.*,
        nr.code AS nonstarter_reason_code,
        nr.name AS nonstarter_reason_name,
        nr.rule_reference,
        nr.requires_authority_decision
      FROM pim_outcomes o
      LEFT JOIN nonstarter_reasons nr
        ON nr.id = o.nonstarter_reason_id
      WHERE o.case_id = ?
    `).get(caseId);

    const tasks = db.prepare(`
      SELECT *
      FROM pim_tasks
      WHERE case_id = ?
      ORDER BY id
    `).all(caseId);

    const context = outcome ? null : inferNonStarterContext(caseId);

    return Response.json({
      success: true,
      data: {
        case: caseData,
        outcome: outcome || null,
        nonstarterReasons: getActiveNonStarterReasons(),
        tasks,
        context,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Non-starter GET error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load non-starter data.",
      },
      { status: 500 }
    );
  }
}

export async function POST(
  request,
  { params }
) {
  try {
    const user = requirePermission(request, "RECORD_OUTCOME");

    const { id } = await params;
    const caseId = Number(id);

    if (
      !Number.isInteger(caseId) ||
      caseId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    const body = await request.json();

    const outcomeDate = normalizeOptionalText(body.outcomeDate);
    const formNo = normalizeOptionalText(body.formNo);
    const remarks = normalizeOptionalText(body.remarks);

    const reasonId =
      body.nonstarterReasonId ?? body.reasonId ?? null;

    const reasonCode =
      normalizeOptionalText(body.nonstarterReasonCode) ||
      normalizeOptionalText(body.reasonCode);

    if (reasonId == null && !reasonCode) {
      return Response.json(
        {
          success: false,
          message: "A non-starter reason is required.",
        },
        { status: 400 }
      );
    }

    const result = db.transaction(() =>
      recordNonStarter({
        caseId,
        reasonId: reasonId != null ? Number(reasonId) : null,
        reasonCode,
        outcomeDate,
        formNo,
        remarks,
        userId: user.id,
      })
    )();

    return Response.json({
      success: true,
      message:
        "Non-starter outcome recorded successfully. Form-3 is now pending.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error(
      "Non-starter POST error:",
      error
    );

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to record non-starter outcome.",
      },
      { status: 400 }
    );
  }
}
