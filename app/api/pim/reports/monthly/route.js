/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * Replaces the SQLite db.prepare(...).get() calls, including the one
 * date-math call (SQLite's `date(?, '+1 month', '-1 day')` for month-end)
 * - computed here in pure JS instead, since it needs no database
 * round-trip at all.
 */

const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  officeDate,
} = require("../../../../../lib/pim-time");
const {
  getSql,
} = require("../../../../../lib/pim-postgres");

function parseMonth(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(text)) return text;
  return officeDate().slice(0, 7);
}

function monthBounds(month) {
  const [year, monthNum] = month.split("-").map(Number);
  const start = `${month}-01`;
  // Day 0 of the following month = the last day of this month.
  const lastDay = new Date(year, monthNum, 0).getDate();
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

export async function GET(request) {
  try {
    requirePermission(request, "READ_CASE");

    const url = new URL(request.url);
    const month = parseMonth(url.searchParams.get("month"));
    const { start, end } = monthBounds(month);
    const sql = getSql();

    const [
      [{ count: opening }],
      [{ count: newCases }],
      [disposalBreakdown],
      [{ count: actualClosing }],
      [{ count: initialNoticesIssued }],
      [{ count: finalNoticesIssued }],
      [{ count: feePaidCases }],
      [{ count: mediationsCommenced }],
      [{ count: sittingsHeld }],
    ] = await Promise.all([
      sql`
        SELECT COUNT(*)::int AS count FROM pim_cases c
        WHERE c.registration_date IS NOT NULL AND c.registration_date < ${start}
          AND (c.closed_at IS NULL OR c.closed_at >= ${start})
      `,
      sql`
        SELECT COUNT(*)::int AS count FROM pim_cases c
        WHERE c.registration_date IS NOT NULL AND c.registration_date BETWEEN ${start} AND ${end}
      `,
      sql`
        SELECT
          COUNT(*)::int AS total,
          SUM(CASE WHEN c.outcome_type = 'SETTLED' THEN 1 ELSE 0 END)::int AS settled,
          SUM(CASE WHEN c.outcome_type = 'FAILED' THEN 1 ELSE 0 END)::int AS failed,
          SUM(CASE WHEN c.outcome_type = 'NON_STARTER' THEN 1 ELSE 0 END)::int AS non_starter,
          SUM(CASE WHEN c.outcome_type = 'WITHDRAWN' THEN 1 ELSE 0 END)::int AS withdrawn
        FROM pim_cases c
        WHERE c.closed_at IS NOT NULL AND c.closed_at BETWEEN ${start} AND ${end}
      `,
      sql`
        SELECT COUNT(*)::int AS count FROM pim_cases c
        WHERE c.registration_date IS NOT NULL AND c.registration_date <= ${end}
          AND (c.closed_at IS NULL OR c.closed_at > ${end})
      `,
      sql`SELECT COUNT(*)::int AS count FROM pim_notices n WHERE n.notice_type = 'FORM_2_INITIAL' AND n.notice_date BETWEEN ${start} AND ${end}`,
      sql`SELECT COUNT(*)::int AS count FROM pim_notices n WHERE n.notice_type = 'FORM_2_FINAL' AND n.notice_date BETWEEN ${start} AND ${end}`,
      sql`
        SELECT COUNT(DISTINCT f.case_id)::int AS count FROM pim_fees f
        WHERE f.fee_type = 'MEDIATION_FEE' AND f.received_date BETWEEN ${start} AND ${end}
          AND f.amount_due IS NOT NULL AND f.amount_received >= f.amount_due
      `,
      sql`SELECT COUNT(DISTINCT ms.case_id)::int AS count FROM mediation_sessions ms WHERE ms.sitting_number = 1 AND ms.actual_date BETWEEN ${start} AND ${end}`,
      sql`SELECT COUNT(*)::int AS count FROM mediation_sessions ms WHERE ms.actual_date BETWEEN ${start} AND ${end}`,
    ]);

    const disposals = disposalBreakdown.total || 0;
    const expectedClosing = opening + newCases - disposals;

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
        message: error instanceof Error ? error.message : "Unable to load monthly report.",
      },
      { status: 500 }
    );
  }
}
