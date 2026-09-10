/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("./db");
const {
  ROLES,
  hashPassword,
  validatePassword,
} = require("./pim-auth");

function nowIso() {
  return new Date().toISOString();
}

function sanitizeUser(row) {
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
    active_sessions: Number(row.active_sessions || 0),
  };
}

function auditUser(action, recordId, oldValue, newValue, changedBy, reason) {
  db.prepare(`
    INSERT INTO audit_log (
      table_name,
      record_id,
      action,
      old_value,
      new_value,
      changed_by,
      reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "users",
    recordId,
    action,
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null,
    changedBy || null,
    reason
  );
}

function validateRole(role) {
  if (!ROLES.includes(role)) {
    const error = new Error("Role is not valid.");
    error.status = 400;
    throw error;
  }
}

function activeAdminCount(exceptUserId = null) {
  return db.prepare(`
    SELECT COUNT(*) AS total
    FROM users
    WHERE active = 1
      AND role_code = 'admin'
      AND (? IS NULL OR id <> ?)
  `).get(exceptUserId, exceptUserId).total;
}

function ensureLastAdminSafe(userId, nextRole, nextActive) {
  const current = db.prepare(`
    SELECT id, role_code, active
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!current) {
    const error = new Error("User not found.");
    error.status = 404;
    throw error;
  }

  const isCurrentlyActiveAdmin =
    current.active === 1 && current.role_code === "admin";
  const remainsActiveAdmin =
    nextActive === 1 && nextRole === "admin";

  if (isCurrentlyActiveAdmin && !remainsActiveAdmin && activeAdminCount(userId) < 1) {
    const error = new Error("Cannot remove or deactivate the last active admin.");
    error.status = 409;
    throw error;
  }
}

function listUsers({ search = "", role = "", active = "", page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = {};

  if (search) {
    where.push(`
      (
        username LIKE @search
        OR display_name LIKE @search
        OR designation LIKE @search
      )
    `);
    params.search = `%${search}%`;
  }

  if (role) {
    validateRole(role);
    where.push("role_code = @role");
    params.role = role;
  }

  if (active === "1" || active === "0") {
    where.push("active = @active");
    params.active = Number(active);
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 25));
  params.limit = safePageSize;
  params.offset = (safePage - 1) * safePageSize;

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM users
    ${clause}
  `).get(params).total;

  const rows = db.prepare(`
    SELECT
      users.id,
      users.username,
      users.display_name,
      users.designation,
      users.role_code,
      users.active,
      users.failed_login_count,
      users.locked_until,
      users.last_login_at,
      users.password_changed_at,
      users.must_change_password,
      users.created_at,
      users.updated_at,
      (
        SELECT COUNT(*)
        FROM pim_user_sessions sessions
        WHERE sessions.user_id = users.id
          AND sessions.revoked_at IS NULL
          AND sessions.expires_at > datetime('now')
      ) AS active_sessions
    FROM users
    ${clause}
    ORDER BY username ASC
    LIMIT @limit OFFSET @offset
  `).all(params);

  return {
    data: rows.map(sanitizeUser),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    },
  };
}

function getUser(userId) {
  const row = db.prepare(`
    SELECT
      users.id,
      users.username,
      users.display_name,
      users.designation,
      users.role_code,
      users.active,
      users.failed_login_count,
      users.locked_until,
      users.last_login_at,
      users.password_changed_at,
      users.must_change_password,
      users.created_at,
      users.updated_at,
      (
        SELECT COUNT(*)
        FROM pim_user_sessions sessions
        WHERE sessions.user_id = users.id
          AND sessions.revoked_at IS NULL
          AND sessions.expires_at > datetime('now')
      ) AS active_sessions
    FROM users
    WHERE users.id = ?
  `).get(userId);

  if (!row) {
    const error = new Error("User not found.");
    error.status = 404;
    throw error;
  }

  return sanitizeUser(row);
}

function validateUserInput(input, { creating = false } = {}) {
  const errors = {};
  const username = String(input.username || "").trim().toLowerCase();
  const displayName = String(input.display_name || "").trim();
  const designation = String(input.designation || "").trim();
  const role = String(input.role_code || "").trim();

  if (creating && !/^[a-z0-9._-]{2,40}$/.test(username)) {
    errors.username = "Username must be 2-40 lowercase letters, numbers, dots, hyphens, or underscores.";
  }

  if (!displayName) errors.display_name = "Display name is required.";
  if (!designation) errors.designation = "Designation is required.";
  if (!ROLES.includes(role)) errors.role_code = "Role is not valid.";

  if (creating) {
    Object.assign(
      errors,
      validatePassword(input.temporary_password, input.confirm_password)
    );
  }

  return errors;
}

function createUser(input, changedBy) {
  const errors = validateUserInput(input, { creating: true });
  if (Object.keys(errors).length) {
    const error = new Error("User validation failed.");
    error.status = 400;
    error.details = errors;
    throw error;
  }

  const username = String(input.username).trim().toLowerCase();
  const displayName = String(input.display_name).trim();
  const designation = String(input.designation).trim();
  const role = String(input.role_code).trim();
  const active = input.active === false ? 0 : 1;
  const passwordHash = hashPassword(input.temporary_password);

  try {
    const result = db.prepare(`
      INSERT INTO users (
        username,
        display_name,
        designation,
        role_code,
        password_hash,
        active,
        must_change_password,
        password_changed_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      username,
      displayName,
      designation,
      role,
      passwordHash,
      active,
      nowIso()
    );

    const user = getUser(result.lastInsertRowid);
    auditUser("INSERT", user.id, null, user, changedBy, "User created.");
    return user;
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      const duplicate = new Error("Username is already in use.");
      duplicate.status = 409;
      throw duplicate;
    }

    throw error;
  }
}

function updateUser(userId, input, changedBy) {
  const current = getUser(userId);
  const next = {
    display_name:
      input.display_name === undefined
        ? current.display_name
        : String(input.display_name).trim(),
    designation:
      input.designation === undefined
        ? current.designation
        : String(input.designation).trim(),
    role_code:
      input.role_code === undefined
        ? current.role_code
        : String(input.role_code).trim(),
    active:
      input.active === undefined
        ? Number(current.active)
        : input.active
          ? 1
          : 0,
    must_change_password:
      input.must_change_password === undefined
        ? Number(current.must_change_password)
        : input.must_change_password
          ? 1
          : 0,
    failed_login_count:
      input.reset_lock ? 0 : Number(current.failed_login_count || 0),
    locked_until: input.reset_lock ? null : current.locked_until,
  };

  const errors = validateUserInput(
    {
      username: current.username,
      display_name: next.display_name,
      designation: next.designation,
      role_code: next.role_code,
    },
    { creating: false }
  );
  if (Object.keys(errors).length) {
    const error = new Error("User validation failed.");
    error.status = 400;
    error.details = errors;
    throw error;
  }

  ensureLastAdminSafe(userId, next.role_code, next.active);

  db.prepare(`
    UPDATE users
    SET display_name = ?,
        designation = ?,
        role_code = ?,
        active = ?,
        must_change_password = ?,
        failed_login_count = ?,
        locked_until = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    next.display_name,
    next.designation,
    next.role_code,
    next.active,
    next.must_change_password,
    next.failed_login_count,
    next.locked_until,
    userId
  );

  const updated = getUser(userId);
  auditUser("UPDATE", userId, current, updated, changedBy, "User updated.");
  return updated;
}

function resetPassword(userId, input, changedBy) {
  const current = getUser(userId);
  const errors = validatePassword(input.temporary_password, input.confirm_password);
  if (Object.keys(errors).length) {
    const error = new Error("Password validation failed.");
    error.status = 400;
    error.details = errors;
    throw error;
  }

  db.prepare(`
    UPDATE users
    SET password_hash = ?,
        must_change_password = 1,
        failed_login_count = 0,
        locked_until = NULL,
        password_changed_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hashPassword(input.temporary_password), nowIso(), userId);

  const revoked = revokeSessions(userId, changedBy, "Password reset revoked active sessions.");
  const updated = getUser(userId);
  auditUser(
    "PASSWORD_RESET",
    userId,
    null,
    { username: current.username, must_change_password: true, revoked },
    changedBy,
    "Temporary password issued."
  );

  return updated;
}

function revokeSessions(userId, changedBy, reason = "User sessions revoked.") {
  getUser(userId);
  const result = db.prepare(`
    UPDATE pim_user_sessions
    SET revoked_at = ?
    WHERE user_id = ?
      AND revoked_at IS NULL
  `).run(nowIso(), userId);

  auditUser(
    "REVOKE_SESSIONS",
    userId,
    null,
    { revokedSessions: result.changes },
    changedBy,
    reason
  );

  return result.changes;
}

module.exports = {
  createUser,
  getUser,
  listUsers,
  resetPassword,
  revokeSessions,
  updateUser,
};
