/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../lib/db");
const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");
const {
  getCaseAction,
} = require("../../../../lib/pim-action-link");
const {
  searchPimCasesPg,
} = require("../../../../lib/pim-data/search-read");

function positiveInt(value, fallback, max = 50) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

/*
 * Batch 5G (Phase 6): GET below now calls lib/pim-data/search-read.js
 * (PostgreSQL). This is the ORIGINAL SQLite search, moved verbatim into a
 * function and kept, unused by GET, purely as an instant rollback (same
 * convention as app/api/pim/nonstarter/[id]/route.js) and as the authentic
 * SQLite baseline for scripts/test-pim-tasks-search-postgres.js. `q` is the
 * trimmed query (>= 2 chars) and `limit` the clamped limit, as computed in
 * GET; it returns the rows (each with `action`) that GET puts under
 * `data.rows`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function searchPimCasesSqlite(q, limit) {
  const search = `%${q}%`;
  const rows = db.prepare(`
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.internal_60_day_date,
        c.priority,
        s.code AS status_code,
        s.name AS status_name,
        (
          SELECT p.name
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND cp.role = 'APPLICANT'
          ORDER BY cp.is_primary DESC, cp.sequence_no, cp.id
          LIMIT 1
        ) AS applicant_name,
        (
          SELECT p.name
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND cp.role = 'OPPOSITE_PARTY'
          ORDER BY cp.is_primary DESC, cp.sequence_no, cp.id
          LIMIT 1
        ) AS opposite_party_name,
        (
          SELECT t.id
          FROM pim_tasks t
          WHERE t.case_id = c.id
            AND t.status = 'PENDING'
          ORDER BY date(t.due_date), t.id
          LIMIT 1
        ) AS pending_task_id,
        (
          SELECT t.description
          FROM pim_tasks t
          WHERE t.case_id = c.id
            AND t.status = 'PENDING'
          ORDER BY date(t.due_date), t.id
          LIMIT 1
        ) AS pending_task_description,
        (
          SELECT t.task_type_code
          FROM pim_tasks t
          WHERE t.case_id = c.id
            AND t.status = 'PENDING'
          ORDER BY date(t.due_date), t.id
          LIMIT 1
        ) AS pending_task_type_code,
        (
          SELECT t.due_date
          FROM pim_tasks t
          WHERE t.case_id = c.id
            AND t.status = 'PENDING'
          ORDER BY date(t.due_date), t.id
          LIMIT 1
        ) AS pending_task_due_date,
        (
          SELECT ms.id
          FROM pim_tasks t
          JOIN mediation_sessions ms
            ON ms.case_id = t.case_id
          WHERE t.case_id = c.id
            AND t.status = 'PENDING'
            AND t.task_type_code = 'SESSION_RECORD'
            AND ms.session_status = 'SCHEDULED'
            AND (
              t.due_date IS NULL
              OR ms.scheduled_date = t.due_date
            )
          ORDER BY ms.sitting_number, ms.id
          LIMIT 1
        ) AS pending_session_id
      FROM pim_cases c
      JOIN status_master s ON s.id = c.current_status_id
      WHERE
        c.pim_number LIKE @search
        OR c.received_number LIKE @search
        OR EXISTS (
          SELECT 1
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND (
              p.name LIKE @search
              OR p.contact_phone LIKE @search
              OR p.email LIKE @search
              OR p.registration_no LIKE @search
            )
        )
        OR EXISTS (
          SELECT 1
          FROM pim_case_advocates ca
          JOIN pim_advocates a ON a.id = ca.advocate_id
          WHERE ca.case_id = c.id
            AND (
              a.name LIKE @search
              OR a.phone LIKE @search
              OR a.email LIKE @search
              OR a.enrollment_no LIKE @search
            )
        )
        OR EXISTS (
          SELECT 1
          FROM pim_mediator_assignments ma
          JOIN mediators m ON m.id = ma.mediator_id
          WHERE ma.case_id = c.id
            AND (
              m.name LIKE @search
              OR m.contact_phone LIKE @search
              OR m.email LIKE @search
              OR m.enrollment_no LIKE @search
            )
        )
      ORDER BY COALESCE(c.registration_date, c.received_date) DESC, c.id DESC
      LIMIT @limit
    `).all({
    search,
    limit,
  });

  return rows.map((row) => ({
    ...row,
    action: getCaseAction(row),
  }));
}

export async function GET(request) {
  try {
    requirePermission(request, "READ_CASE");

    const url = new URL(request.url);
    const q = String(url.searchParams.get("q") || "").trim();
    const limit = positiveInt(url.searchParams.get("limit"), 20, 50);

    if (q.length < 2) {
      return Response.json({
        success: true,
        data: {
          query: q,
          rows: [],
        },
      });
    }

    // Batch 5G (Phase 6): migrated to PostgreSQL via lib/pim-data/search-read.js.
    const rows = await searchPimCasesPg(q, limit);

    return Response.json({
      success: true,
      data: {
        query: q,
        rows,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("PIM search error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to search PIM cases.",
      },
      { status: 500 }
    );
  }
}
