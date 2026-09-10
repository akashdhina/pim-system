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

    const url = new URL(request.url);
    const page = positiveInt(
      url.searchParams.get("page"),
      1,
      100000
    );
    const pageSize = positiveInt(
      url.searchParams.get("pageSize"),
      20,
      100
    );
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];

    addLike(
      where,
      params,
      "c.pim_number",
      url.searchParams.get("pimNumber")
    );
    addLike(
      where,
      params,
      "c.received_number",
      url.searchParams.get("receivedNumber")
    );

    const partyName = String(
      url.searchParams.get("partyName") || ""
    ).trim();
    if (partyName) {
      where.push(`
        EXISTS (
          SELECT 1
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND p.name LIKE ?
        )
      `);
      params.push(`%${partyName}%`);
    }

    const status = String(
      url.searchParams.get("status") || ""
    ).trim();
    if (status) {
      where.push("s.code = ?");
      params.push(status);
    }

    const outcome = String(
      url.searchParams.get("outcome") || ""
    ).trim();
    if (outcome) {
      where.push("c.outcome_type = ?");
      params.push(outcome);
    }

    const registrationFrom =
      url.searchParams.get("registrationFrom");
    if (registrationFrom) {
      where.push("c.registration_date >= ?");
      params.push(registrationFrom);
    }

    const registrationTo =
      url.searchParams.get("registrationTo");
    if (registrationTo) {
      where.push("c.registration_date <= ?");
      params.push(registrationTo);
    }

    const openClosed = String(
      url.searchParams.get("openClosed") || ""
    ).trim();
    if (openClosed === "open") {
      where.push(
        `s.code NOT IN (${CLOSED_STATUSES.map(() => "?").join(",")})`
      );
      params.push(...CLOSED_STATUSES);
    } else if (openClosed === "closed") {
      where.push(
        `s.code IN (${CLOSED_STATUSES.map(() => "?").join(",")})`
      );
      params.push(...CLOSED_STATUSES);
    }

    const deadline = String(
      url.searchParams.get("deadline") || ""
    ).trim();
    if (deadline === "overdue") {
      where.push(
        "c.internal_60_day_date IS NOT NULL AND c.internal_60_day_date < ?"
      );
      params.push(today());
    } else if (deadline === "approaching") {
      where.push(
        "c.internal_60_day_date IS NOT NULL AND c.internal_60_day_date BETWEEN ? AND date(?, '+7 day')"
      );
      params.push(today(), today());
    } else if (deadline === "due") {
      where.push("c.internal_60_day_date IS NOT NULL");
    }

    const whereSql = where.length
      ? `WHERE ${where.join(" AND ")}`
      : "";

    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM pim_cases c
      JOIN status_master s
        ON s.id = c.current_status_id
      ${whereSql}
    `).get(...params).count;

    const rows = db.prepare(`
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.registration_date,
        c.internal_60_day_date,
        c.priority,
        c.outcome_type,
        s.code AS status_code,
        s.name AS status_name,
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
          SELECT p.name
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND cp.role = 'OPPOSITE_PARTY'
          ORDER BY cp.is_primary DESC, cp.sequence_no
          LIMIT 1
        ) AS opposite_party_name
      FROM pim_cases c
      JOIN status_master s
        ON s.id = c.current_status_id
      ${whereSql}
      ORDER BY COALESCE(c.registration_date, c.received_date) DESC,
        c.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const data = rows.map((row) => {
      const pending = pendingTaskForCase(row.id);
      const enriched = {
        ...row,
        ...pending,
      };

      return {
        ...enriched,
        action: getCaseAction(enriched),
      };
    });

    return Response.json({
      success: true,
      data: {
        rows: data,
        pagination: {
          page,
          pageSize,
          total: count || 0,
          totalPages: Math.max(
            1,
            Math.ceil((count || 0) / pageSize)
          ),
        },
      },
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
