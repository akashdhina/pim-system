/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../lib/db");
const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");
const {
  getTaskAction,
} = require("../../../../lib/pim-action-link");
const {
  officeDate,
} = require("../../../../lib/pim-time");
const {
  getPimTasksPg,
} = require("../../../../lib/pim-data/tasks-read");

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

/*
 * Batch 5G (Phase 6): GET below now calls lib/pim-data/tasks-read.js
 * (PostgreSQL). This is the ORIGINAL SQLite GET body, moved verbatim into a
 * function (the only mechanical change: `url.searchParams` became the
 * `searchParams` argument) and kept, unused by GET, purely as an instant
 * rollback (same convention as app/api/pim/nonstarter/[id]/route.js) and as
 * the authentic SQLite baseline for
 * scripts/test-pim-tasks-search-postgres.js. It returns what GET puts under
 * `data`: { rows, taskTypes, pagination }.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getPimTasksSqlite(searchParams) {
  const page = positiveInt(
    searchParams.get("page"),
    1,
    100000
  );
  const pageSize = positiveInt(
    searchParams.get("pageSize"),
    20,
    100
  );
  const offset = (page - 1) * pageSize;

  const where = [];
  const params = [];

  const status = String(
    searchParams.get("status") || "PENDING"
  ).trim();
  if (status && status !== "all") {
    where.push("t.status = ?");
    params.push(status);
  }

  const taskType = String(
    searchParams.get("taskType") || ""
  ).trim();
  if (taskType) {
    if (taskType === "FORM2" || taskType === "FORM_2") {
      where.push("t.task_type_code IN ('FORM2', 'FORM_2')");
    } else {
      where.push("t.task_type_code = ?");
      params.push(taskType);
    }
  }

  const priority = String(
    searchParams.get("priority") || ""
  ).trim();
  if (priority) {
    where.push("t.priority = ?");
    params.push(priority);
  }

  const overdue = String(
    searchParams.get("overdue") || ""
  ).trim();
  if (overdue === "1" || overdue === "true") {
    where.push(
      "t.status = 'PENDING' AND t.due_date IS NOT NULL AND t.due_date < ?"
    );
    params.push(today());
  }

  const dueDate = String(
    searchParams.get("dueDate") || ""
  ).trim();
  if (dueDate) {
    where.push("t.due_date = ?");
    params.push(dueDate);
  }

  const caseStatus = String(
    searchParams.get("caseStatus") || ""
  ).trim();
  if (caseStatus) {
    where.push("s.code = ?");
    params.push(caseStatus);
  }

  const whereSql = where.length
    ? `WHERE ${where.join(" AND ")}`
    : "";

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM pim_tasks t
    JOIN pim_cases c ON c.id = t.case_id
    JOIN status_master s ON s.id = c.current_status_id
    ${whereSql}
  `).get(...params).count;

  const rows = db.prepare(`
    SELECT
      t.id,
      t.case_id,
      t.task_type_code,
      COALESCE(tt.name, t.description) AS task_name,
      t.description,
      t.status,
      t.due_date,
      t.priority,
      t.completed_date,
      c.pim_number,
      c.received_number,
      s.code AS case_status_code,
      s.name AS case_status_name,
      (
        SELECT p.name
        FROM pim_case_parties cp
        JOIN pim_parties p ON p.id = cp.party_id
        WHERE cp.case_id = c.id
          AND cp.role = 'APPLICANT'
        ORDER BY cp.is_primary DESC, cp.sequence_no
        LIMIT 1
      ) AS applicant_name,
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
      ) AS session_id
    FROM pim_tasks t
    JOIN pim_cases c ON c.id = t.case_id
    JOIN status_master s ON s.id = c.current_status_id
    LEFT JOIN task_types tt ON tt.code = t.task_type_code
    ${whereSql}
    ORDER BY
      CASE WHEN t.status = 'PENDING' THEN 0 ELSE 1 END,
      date(t.due_date),
      t.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const taskTypes = db.prepare(`
    SELECT DISTINCT
      t.task_type_code AS code,
      COALESCE(tt.name, t.task_type_code) AS name
    FROM pim_tasks t
    LEFT JOIN task_types tt
      ON tt.code = t.task_type_code
    WHERE t.task_type_code IS NOT NULL
    ORDER BY t.task_type_code
  `).all();

  return {
    rows: rows.map((row) => ({
      ...row,
      overdue:
        row.status === "PENDING" &&
        row.due_date &&
        row.due_date < today()
          ? 1
          : 0,
      action: getTaskAction(row),
    })),
    taskTypes,
    pagination: {
      page,
      pageSize,
      total: count || 0,
      totalPages: Math.max(
        1,
        Math.ceil((count || 0) / pageSize)
      ),
    },
  };
}

export async function GET(request) {
  try {
    requirePermission(request, "READ_CASE");

    const url = new URL(request.url);

    // Batch 5G (Phase 6): migrated to PostgreSQL via lib/pim-data/tasks-read.js.
    const data = await getPimTasksPg(url.searchParams);

    return Response.json({
      success: true,
      data,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error("PIM tasks list error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load PIM tasks.",
      },
      { status: 500 }
    );
  }
}
