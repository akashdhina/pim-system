/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../lib/db");
const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");

const ALLOWED_SORTS = {
  changed_at: "a.changed_at",
  action: "a.action",
  table_name: "a.table_name",
  user: "u.display_name",
};

const SECRET_FIELDS = /password|token|session/i;

function positiveInt(value, fallback, max = 100) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

function sanitizeJsonText(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    for (const key of Object.keys(parsed)) {
      if (SECRET_FIELDS.test(key)) {
        parsed[key] = "[redacted]";
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return SECRET_FIELDS.test(value) ? "[redacted]" : value;
  }
}

export async function GET(request) {
  try {
    requirePermission(request, "VIEW_AUDIT");

    const url = new URL(request.url);
    const page = positiveInt(url.searchParams.get("page"), 1, 100000);
    const pageSize = positiveInt(url.searchParams.get("pageSize"), 25, 100);
    const offset = (page - 1) * pageSize;
    const where = [];
    const params = {};

    const from = url.searchParams.get("from");
    if (from) {
      where.push("date(a.changed_at) >= date(@from)");
      params.from = from;
    }

    const to = url.searchParams.get("to");
    if (to) {
      where.push("date(a.changed_at) <= date(@to)");
      params.to = to;
    }

    for (const [key, column] of [
      ["userId", "a.changed_by"],
      ["action", "a.action"],
      ["table", "a.table_name"],
      ["recordId", "a.record_id"],
    ]) {
      const value = url.searchParams.get(key);
      if (value) {
        where.push(`${column} = @${key}`);
        params[key] = value;
      }
    }

    const pimNumber = url.searchParams.get("pimNumber");
    if (pimNumber) {
      where.push(`
        (
          c.pim_number LIKE @pimNumber
          OR c.received_number LIKE @pimNumber
        )
      `);
      params.pimNumber = `%${pimNumber}%`;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sort =
      ALLOWED_SORTS[url.searchParams.get("sort") || "changed_at"] ||
      ALLOWED_SORTS.changed_at;
    const direction =
      String(url.searchParams.get("direction") || "desc").toLowerCase() ===
      "asc"
        ? "ASC"
        : "DESC";

    const joinSql = `
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.changed_by
      LEFT JOIN pim_cases c
        ON (
          (a.table_name = 'pim_cases' AND c.id = a.record_id)
          OR (
            a.table_name = 'pim_status_history'
            AND c.id = (
              SELECT case_id FROM pim_status_history WHERE id = a.record_id
            )
          )
          OR (
            a.table_name = 'pim_tasks'
            AND c.id = (
              SELECT case_id FROM pim_tasks WHERE id = a.record_id
            )
          )
        )
    `;

    const total = db.prepare(`
      SELECT COUNT(*) AS total
      ${joinSql}
      ${whereSql}
    `).get(params).total;

    params.limit = pageSize;
    params.offset = offset;

    const rows = db.prepare(`
      SELECT
        a.id,
        a.table_name,
        a.record_id,
        a.action,
        a.old_value,
        a.new_value,
        a.changed_at,
        a.reason,
        u.display_name AS user_display_name,
        u.designation AS user_designation,
        u.role_code AS user_role,
        c.id AS case_id,
        c.pim_number,
        c.received_number
      ${joinSql}
      ${whereSql}
      ORDER BY ${sort} ${direction}, a.id ${direction}
      LIMIT @limit OFFSET @offset
    `).all(params).map((row) => ({
      ...row,
      old_value: sanitizeJsonText(row.old_value),
      new_value: sanitizeJsonText(row.new_value),
    }));

    const users = db.prepare(`
      SELECT id, display_name, designation, role_code
      FROM users
      ORDER BY display_name
    `).all();

    return Response.json({
      success: true,
      data: {
        rows,
        users,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil((total || 0) / pageSize)),
        },
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("PIM audit error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load audit register.",
      },
      { status: 500 }
    );
  }
}
