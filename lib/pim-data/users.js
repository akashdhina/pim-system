/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL data-access for user identity reads - Batch 4
 * (GET /api/pim/users, GET /api/pim/users/[id]). Read-only: no create/
 * update/reset-password/revoke-sessions here (those stay in lib/pim-users.js
 * against SQLite, unchanged, including ensureLastAdminSafe).
 *
 * Deliberate hybrid read, not an oversight: identity fields (id, username,
 * display_name, designation, role_code, active, failed_login_count,
 * locked_until, last_login_at, password_changed_at, must_change_password,
 * created_at, updated_at) come from PostgreSQL users. `active_sessions`
 * does NOT - it is read from SQLite's pim_user_sessions via lib/db.js,
 * unchanged. Sessions are explicitly out of scope for this batch (auth
 * stays SQLite-authoritative), and PostgreSQL's pim_user_sessions table is
 * intentionally never populated (Phase 4 RLS design, Phase 6 design doc) -
 * porting this one subquery to PostgreSQL would silently make
 * active_sessions always read 0 for every user, which is a real regression
 * for the admin user-list screen, not a faithful migration. Reading it
 * from SQLite instead is not "migrating sessions"; it is correctly leaving
 * sessions exactly where they already are and reading them from there.
 *
 * password_hash is never selected here, matching the SQLite version.
 */

const { getSql } = require("../pim-postgres");
const db = require("../db");
const { ROLES } = require("../pim-auth");

function activeSessionCountsFor(userIds) {
  if (userIds.length === 0) return new Map();

  const placeholders = userIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT user_id, COUNT(*) AS count
       FROM pim_user_sessions
       WHERE user_id IN (${placeholders})
         AND revoked_at IS NULL
         AND expires_at > datetime('now')
       GROUP BY user_id`
    )
    .all(...userIds);

  return new Map(rows.map((row) => [row.user_id, row.count]));
}

function sanitizeUser(row, activeSessions) {
  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    designation: row.designation,
    role_code: row.role_code,
    active: Boolean(row.active),
    failed_login_count: Number(row.failed_login_count || 0),
    locked_until: row.locked_until || null,
    last_login_at: row.last_login_at || null,
    password_changed_at: row.password_changed_at || null,
    must_change_password: Boolean(row.must_change_password),
    created_at: row.created_at,
    updated_at: row.updated_at,
    active_sessions: Number(activeSessions || 0),
  };
}

function validateRole(role) {
  if (!ROLES.includes(role)) {
    const error = new Error("Role is not valid.");
    error.status = 400;
    throw error;
  }
}

async function listUsers({ search = "", role = "", active = "", page = 1, pageSize = 25 } = {}) {
  const sql = getSql();

  if (role) validateRole(role);

  const conditions = [];
  if (search) {
    const like = `%${search}%`;
    conditions.push(sql`(username LIKE ${like} OR display_name LIKE ${like} OR designation LIKE ${like})`);
  }
  if (role) conditions.push(sql`role_code = ${role}`);
  // users.active is a native boolean in PostgreSQL (Phase 2), unlike
  // SQLite's INTEGER CHECK(0,1) - the "1"/"0" query-string value maps to true/false.
  if (active === "1" || active === "0") conditions.push(sql`active = ${active === "1"}`);

  const whereClause =
    conditions.length === 0
      ? sql``
      : conditions.reduce((acc, cond, i) => (i === 0 ? sql`WHERE ${cond}` : sql`${acc} AND ${cond}`));

  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const offset = (safePage - 1) * safePageSize;

  const [{ count: total }] = await sql`SELECT COUNT(*)::int AS count FROM users ${whereClause}`;

  // username is NOT NULL - no NULL-ordering divergence to account for here.
  const rows = await sql`
    SELECT id, username, display_name, designation, role_code, active,
      failed_login_count, locked_until, last_login_at, password_changed_at,
      must_change_password, created_at, updated_at
    FROM users
    ${whereClause}
    ORDER BY username ASC
    LIMIT ${safePageSize} OFFSET ${offset}
  `;

  const sessionCounts = activeSessionCountsFor(rows.map((row) => row.id));

  return {
    data: rows.map((row) => sanitizeUser(row, sessionCounts.get(row.id))),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    },
  };
}

async function getUser(userId) {
  const sql = getSql();

  const [row] = await sql`
    SELECT id, username, display_name, designation, role_code, active,
      failed_login_count, locked_until, last_login_at, password_changed_at,
      must_change_password, created_at, updated_at
    FROM users
    WHERE id = ${userId}
  `;

  if (!row) {
    const error = new Error("User not found.");
    error.status = 404;
    throw error;
  }

  const sessionCounts = activeSessionCountsFor([userId]);
  return sanitizeUser(row, sessionCounts.get(userId));
}

module.exports = {
  listUsers,
  getUser,
};
