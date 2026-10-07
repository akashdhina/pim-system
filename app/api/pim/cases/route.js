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
  officeDate,
} = require("../../../../lib/pim-time");
const {
  listCases,
} = require("../../../../lib/pim-data/cases");

/*
 * Batch 3 (Phase 6): GET below now calls lib/pim-data/cases.js
 * (PostgreSQL). Everything below is kept, unused by GET, purely as an
 * instant rollback - see app/api/pim/mediators/route.js for the pattern
 * established in Batch 1.
 */
const CLOSED_STATUSES = [
  "CLOSED_SETTLED",
  "CLOSED_FAILED",
  "CLOSED_NON_STARTER",
  "WITHDRAWN",
];

function today() {
  return officeDate();
}

function positiveInt(value, fallback, max = 100) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    return fallback;
  }

  return Math.min(number, max);
}

function addLike(where, params, column, value) {
  const text = String(value || "").trim();

  if (!text) return;

  where.push(`${column} LIKE ?`);
  params.push(`%${text}%`);
}

function pendingTaskForCase(caseId) {
  const task = db.prepare(`
    SELECT
      t.id AS pending_task_id,
      t.task_type_code AS pending_task_type_code,
      t.description AS pending_task_description,
      t.due_date AS pending_task_due_date,
      t.priority AS pending_task_priority,
      (
        SELECT ms.id
        FROM mediation_sessions ms
        WHERE ms.case_id = t.case_id
          AND ms.session_status = 'SCHEDULED'
          AND (
            t.due_date IS NULL
            OR ms.scheduled_date = t.due_date
          )
        ORDER BY ms.sitting_number, ms.id
        LIMIT 1
      ) AS pending_session_id
    FROM pim_tasks t
    WHERE t.case_id = ?
      AND t.status = 'PENDING'
    ORDER BY date(t.due_date), t.id
    LIMIT 1
  `).get(caseId);

  return task || {};
}

export async function GET(request) {
  try {
    requirePermission(request, "READ_CASE");

    // Batch 3 (Phase 6): migrated to PostgreSQL via lib/pim-data/cases.js.
    // The permission check above is unchanged - still the SQLite-backed
    // lib/pim-auth.js session/user resolution, run before any data access.
    const url = new URL(request.url);
    const data = await listCases(url.searchParams);

    return Response.json({
      success: true,
      data,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error("PIM cases list error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load PIM cases.",
      },
      { status: 500 }
    );
  }
}
