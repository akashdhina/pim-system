/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  officeDate,
} = require("../../../../../lib/pim-time");

function parseMonth(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(text)) return text;
  return officeDate().slice(0, 7);
}

function monthBounds(month) {
  const start = `${month}-01`;
  const end = db
    .prepare(`SELECT date(?, '+1 month', '-1 day') AS value`)
    .get(start).value;
  return { start, end };
}

export async function GET(request) {
  try {
    requirePermission(request, "READ_CASE");

    const url = new URL(request.url);
    const month = parseMonth(url.searchParams.get("month"));
    const { start, end } = monthBounds(month);

    const opening = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM pim_cases c
        WHERE c.registration_date IS NOT NULL
          AND c.registration_date < ?
          AND (c.closed_at IS NULL OR c.closed_at >= ?)
      `
      )
      .get(start, start).count;

    const newCases = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM pim_cases c
        WHERE c.registration_date IS NOT NULL
          AND c.registration_date BETWEEN ? AND ?
      `
      )
      .get(start, end).count;

    const disposalBreakdown = db
      .prepare(
        `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN c.outcome_type = 'SETTLED' THEN 1 ELSE 0 END) AS settled,
          SUM(CASE WHEN c.outcome_type = 'FAILED' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN c.outcome_type = 'NON_STARTER' THEN 1 ELSE 0 END) AS non_starter,
          SUM(CASE WHEN c.outcome_type = 'WITHDRAWN' THEN 1 ELSE 0 END) AS withdrawn
        FROM pim_cases c
        WHERE c.closed_at IS NOT NULL
          AND c.closed_at BETWEEN ? AND ?
      `
      )
      .get(start, end);

    const disposals = disposalBreakdown.total || 0;
    const expectedClosing = opening + newCases - disposals;

    const actualClosing = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM pim_cases c
        WHERE c.registration_date IS NOT NULL
          AND c.registration_date <= ?
          AND (c.closed_at IS NULL OR c.closed_at > ?)
      `
      )
      .get(end, end).count;

    const initialNoticesIssued = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM pim_notices n
        WHERE n.notice_type = 'FORM_2_INITIAL'
          AND n.notice_date BETWEEN ? AND ?
      `
      )
      .get(start, end).count;

    const finalNoticesIssued = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM pim_notices n
        WHERE n.notice_type = 'FORM_2_FINAL'
          AND n.notice_date BETWEEN ? AND ?
      `
      )
      .get(start, end).count;

    const feePaidCases = db
      .prepare(
        `
        SELECT COUNT(DISTINCT f.case_id) AS count
        FROM pim_fees f
        WHERE f.fee_type = 'MEDIATION_FEE'
          AND f.received_date BETWEEN ? AND ?
          AND f.amount_due IS NOT NULL
          AND f.amount_received >= f.amount_due
      `
      )
      .get(start, end).count;

    const mediationsCommenced = db
      .prepare(
        `
        SELECT COUNT(DISTINCT ms.case_id) AS count
        FROM mediation_sessions ms
        WHERE ms.sitting_number = 1
          AND ms.actual_date BETWEEN ? AND ?
      `
      )
      .get(start, end).count;

    const sittingsHeld = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM mediation_sessions ms
        WHERE ms.actual_date BETWEEN ? AND ?
      `
      )
      .get(start, end).count;

    return Response.json({
      success: true,
      data: {
        month,
        periodStart: start,
        periodEnd: end,
        openingBalance: opening,
        newCases,
        disposals,
        disposalBreakdown: {
          settled: disposalBreakdown.settled || 0,
          failed: disposalBreakdown.failed || 0,
          nonStarter: disposalBreakdown.non_starter || 0,
          withdrawn: disposalBreakdown.withdrawn || 0,
        },
        closingBalance: expectedClosing,
        reconciliation: {
          expectedClosing,
          actualClosing,
          matches: expectedClosing === actualClosing,
        },
        initialNoticesIssued,
        finalNoticesIssued,
        feePaidCases,
        mediationsCommenced,
        sittingsHeld,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error("PIM monthly report error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load monthly report.",
      },
      { status: 500 }
    );
  }
}
