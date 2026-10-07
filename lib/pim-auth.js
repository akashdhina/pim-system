/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require("crypto");
const db = require("./db");

const SESSION_COOKIE_NAME = "pim_session";
const SESSION_HOURS = 10;
const LAST_SEEN_THROTTLE_MINUTES = 5;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 10;
const ROLES = ["aa", "secretary", "chairman", "admin"];

const PERMISSIONS = {
  ENTER_APPLICATION: ["aa", "admin"],
  IMPORT_LEGACY_CASE: ["secretary", "admin"],
  COMPLETE_SCRUTINY: ["aa", "secretary", "admin"],
  APPROVE_REGISTRATION: ["secretary", "admin"],
  // Batch 5H-b (Phase 6): PIM-number assignment replaces Secretary
  // approval as the staff-operated checkpoint after scrutiny - see
  // docs/phase6-batch5h-b-pim-numbering.md. APPROVE_REGISTRATION above is
  // left in place (legacy infrastructure, unused by the new code), not
  // removed. ASSIGN_PIM_NUMBER is ordinary staff work, same pattern as
  // MANAGE_MEDIATOR (Batch 5H-a). INITIALIZE_PIM_SEQUENCE (opening or
  // correcting a year's starting count) is deliberately more restricted -
  // admin only - since it is not a routine action.
  ASSIGN_PIM_NUMBER: ["aa", "secretary", "admin"],
  INITIALIZE_PIM_SEQUENCE: ["admin"],
  ISSUE_NOTICE: ["aa", "secretary", "admin"],
  RECORD_SERVICE: ["aa", "secretary", "admin"],
  RECORD_RESPONSE: ["aa", "secretary", "admin"],
  RECORD_CONSENT: ["aa", "secretary", "admin"],
  RECORD_FEE: ["aa", "secretary", "admin"],
  ASSIGN_MEDIATOR: ["secretary", "admin"],
  RECORD_MEDIATION_SESSION: ["aa", "secretary", "admin"],
  RECORD_OUTCOME: ["aa", "secretary", "admin"],
  COMPLETE_NONSTARTER_FORM3: ["aa", "secretary", "admin"],
  APPROVE_NONSTARTER_AUTHORITY: ["secretary", "chairman", "admin"],
  VERIFY_OUTCOME: ["secretary", "admin"],
  APPROVE_OUTCOME: ["secretary", "chairman", "admin"],
  GENERATE_DOCUMENT: ["aa", "secretary", "chairman", "admin"],
  DOWNLOAD_DOCUMENT: ["aa", "secretary", "chairman", "admin"],
  READ_CASE: ["aa", "secretary", "chairman", "admin"],
  READ_MEDIATOR: ["aa", "secretary", "chairman", "admin"],
  // Batch 5H-a (Phase 6): mediator-master maintenance is ordinary staff work,
  // not a Secretary/Judge decision - PIM is staff-operated (see
  // docs/phase6-batch5h-mediator-registry-migration.md). Broadened from
  // ["secretary", "admin"] to include "aa"; "secretary" is left in place
  // (not removed - the role/account itself stays, see decision 19) but is
  // no longer REQUIRED for this action.
  MANAGE_MEDIATOR: ["aa", "secretary", "admin"],
  VIEW_SETTINGS: ["secretary", "chairman", "admin"],
  MANAGE_SETTINGS: ["admin"],
  VIEW_BACKUP: ["secretary", "chairman", "admin"],
  CREATE_BACKUP: ["secretary", "admin"],
  DOWNLOAD_BACKUP: ["secretary", "admin"],
  DELETE_BACKUP: ["admin"],
  RESTORE_BACKUP: ["admin"],
  VIEW_USERS: ["admin"],
  MANAGE_USERS: ["admin"],
  RESET_USER_PASSWORD: ["admin"],
  REVOKE_USER_SESSION: ["admin"],
  VIEW_AUDIT: ["secretary", "admin"],
  // Phase LK-2 (Legal Knowledge Base): READ_LEGAL_LIBRARY matches READ_CASE's
  // broad grant - browsing verified legal material is read-only and not
  // gated more tightly than case access itself. MANAGE_LEGAL_SOURCES /
  // MANAGE_LEGAL_GUIDANCE are admin-only for now, same pattern as
  // MANAGE_SETTINGS - see docs/pim-legal-knowledge-base-lk2.md section on
  // the permission model. No new role was created.
  READ_LEGAL_LIBRARY: ["aa", "secretary", "chairman", "admin"],
  MANAGE_LEGAL_SOURCES: ["admin"],
  MANAGE_LEGAL_GUIDANCE: ["admin"],
};

const COMMON_WEAK_PASSWORDS = new Set([
  "password",
  "password123",
  "admin123",
  "admin@123",
  "1234567890",
  "qwerty12345",
  "welcome123",
  "dlsa123456",
]);

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function addHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function allowHttpLan() {
  return process.env.PIM_ALLOW_HTTP_LAN === "1";
}

function normalizeRole(user) {
  if (user.role_code && ROLES.includes(user.role_code)) {
    return user.role_code;
  }

  const username = String(user.username || "").toLowerCase();
  const designation = String(user.designation || "").toLowerCase();

  if (username === "admin" || designation.includes("system administrator")) {
    return "admin";
  }

  if (username === "chairman" || designation.includes("chairman")) {
    return "chairman";
  }

  if (username === "secretary" || designation.includes("secretary")) {
    return "secretary";
  }

  return "aa";
}

function parseCookies(request) {
  const cookieHeader = request?.headers?.get("cookie") || "";
  const cookies = {};

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function sanitizeUser(user, session = null) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    designation: user.designation,
    active: user.active,
    role: normalizeRole(user),
    role_code: normalizeRole(user),
    must_change_password: Boolean(user.must_change_password),
    last_login_at: user.last_login_at || null,
    isDevelopmentIdentity: Boolean(user.isDevelopmentIdentity),
    session_expires_at: session?.expires_at || null,
  };
}

function getDevelopmentUser(request) {
  if (isProduction()) return null;

  const headerValue =
    request?.headers?.get("x-pim-user-id") ||
    request?.headers?.get("x-user-id");
  const cookies = parseCookies(request);
  const legacyCookie = cookies.pim_user_id;
  const value = headerValue || legacyCookie || process.env.PIM_DEV_USER_ID;
  const userId = Number(value);

  if (!Number.isInteger(userId) || userId <= 0) return null;

  const user = db.prepare(`
    SELECT id, username, display_name, designation, active, role_code,
           must_change_password, last_login_at
    FROM users
    WHERE id = ?
      AND active = 1
  `).get(userId);

  if (!user) return null;

  return sanitizeUser(
    {
      ...user,
      isDevelopmentIdentity: true,
    },
    null
  );
}

function getSessionUser(request) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const tokenHash = hashToken(token);
  const row = db.prepare(`
    SELECT
      sessions.id AS session_id,
      sessions.expires_at,
      sessions.last_seen_at,
      sessions.revoked_at,
      users.id,
      users.username,
      users.display_name,
      users.designation,
      users.active,
      users.role_code,
      users.must_change_password,
      users.last_login_at
    FROM pim_user_sessions sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.session_token_hash = ?
  `).get(tokenHash);

  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (!row.active) return null;

  const lastSeen = new Date(row.last_seen_at || 0).getTime();
  if (
    Number.isNaN(lastSeen) ||
    Date.now() - lastSeen > LAST_SEEN_THROTTLE_MINUTES * 60 * 1000
  ) {
    db.prepare(`
      UPDATE pim_user_sessions
      SET last_seen_at = ?
      WHERE id = ?
    `).run(nowIso(), row.session_id);
  }

  return sanitizeUser(row, row);
}

function getCurrentUser(request) {
  return getSessionUser(request) || getDevelopmentUser(request);
}

function can(user, permission) {
  if (!user) return false;

  const roles = PERMISSIONS[permission] || [];
  return roles.includes(user.role);
}

function requireUser(request) {
  const user = getCurrentUser(request);

  if (!user) {
    throw new AuthError(401, "Authentication required.");
  }

  return user;
}

function requirePermission(request, permission) {
  assertSafeStateChange(request);
  const user = requireUser(request);

  if (!can(user, permission)) {
    throw new AuthError(403, "You do not have permission to perform this action.");
  }

  return user;
}

function permissionSummary() {
  return PERMISSIONS;
}

function getRequestOrigin(request) {
  const origin = request?.headers?.get("origin");
  if (origin) return origin;

  const referer = request?.headers?.get("referer");
  if (!referer) return null;

  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function expectedOrigin(request) {
  const host =
    request?.headers?.get("x-forwarded-host") ||
    request?.headers?.get("host");
  if (!host) return null;

  const proto =
    request?.headers?.get("x-forwarded-proto") ||
    requestProtocol(request) ||
    (isProduction() ? "https" : "http");

  return `${proto}://${host}`;
}

function requestProtocol(request) {
  try {
    return new URL(request.url).protocol.replace(":", "");
  } catch {
    return null;
  }
}

function assertSafeStateChange(request) {
  const method = String(request?.method || "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;

  const origin = getRequestOrigin(request);
  if (!origin) return;

  const expected = expectedOrigin(request);
  if (expected && origin !== expected) {
    throw new AuthError(403, "Invalid request origin.");
  }
}

function validatePassword(password, confirmation = password) {
  const errors = {};
  const text = String(password || "");

  if (!text) {
    errors.password = "Password is required.";
  } else if (text.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  } else if (COMMON_WEAK_PASSWORDS.has(text.toLowerCase())) {
    errors.password = "Choose a stronger password.";
  }

  if (password !== confirmation) {
    errors.confirmPassword = "Password confirmation does not match.";
  }

  return errors;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
  });

  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.startsWith("scrypt$")) return false;

  const [, nValue, rValue, pValue, saltValue, keyValue] =
    storedHash.split("$");
  if (!saltValue || !keyValue) return false;

  const expected = Buffer.from(keyValue, "base64url");
  const actual = crypto.scryptSync(
    String(password),
    Buffer.from(saltValue, "base64url"),
    expected.length,
    {
      N: Number(nValue),
      r: Number(rValue),
      p: Number(pValue),
    }
  );

  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function auditAuth(action, userId, username, reason) {
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
    "auth",
    userId || 0,
    action,
    null,
    JSON.stringify({ username }),
    userId || null,
    reason
  );
}

function authenticateUser(username, password) {
  const normalizedUsername = String(username || "").trim().toLowerCase();
  if (!normalizedUsername || !password) {
    throw new AuthError(400, "Username and password are required.");
  }

  const user = db.prepare(`
    SELECT id, username, display_name, designation, active, role_code,
           password_hash, failed_login_count, locked_until,
           must_change_password, last_login_at
    FROM users
    WHERE lower(username) = ?
  `).get(normalizedUsername);

  const generic = new AuthError(401, "Invalid username or password.");

  if (!user) {
    auditAuth("LOGIN_FAILED", null, normalizedUsername, "Unknown username.");
    throw generic;
  }

  if (!user.active) {
    auditAuth("LOGIN_FAILED", user.id, user.username, "Inactive user.");
    throw new AuthError(403, "User account is inactive.");
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    auditAuth("LOGIN_FAILED", user.id, user.username, "Account locked.");
    throw new AuthError(429, "Too many failed attempts. Try again later.");
  }

  const verified = verifyPassword(password, user.password_hash);
  if (!verified) {
    const failedCount = Number(user.failed_login_count || 0) + 1;
    const lockedUntil =
      failedCount >= MAX_FAILED_LOGINS ? addMinutes(LOCK_MINUTES) : null;

    db.prepare(`
      UPDATE users
      SET failed_login_count = ?,
          locked_until = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(failedCount, lockedUntil, user.id);

    auditAuth("LOGIN_FAILED", user.id, user.username, "Invalid credentials.");

    if (lockedUntil) {
      throw new AuthError(429, "Too many failed attempts. Try again later.");
    }

    throw generic;
  }

  const loginAt = nowIso();
  db.prepare(`
    UPDATE users
    SET failed_login_count = 0,
        locked_until = NULL,
        last_login_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(loginAt, user.id);

  auditAuth("LOGIN_SUCCESS", user.id, user.username, "User logged in.");

  return sanitizeUser({
    ...user,
    failed_login_count: 0,
    locked_until: null,
    last_login_at: loginAt,
  });
}

function createSession(userId, request) {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = addHours(SESSION_HOURS);
  const userAgent = request?.headers?.get("user-agent") || null;
  const forwardedFor = request?.headers?.get("x-forwarded-for");
  const ipAddress = forwardedFor ? forwardedFor.split(",")[0].trim() : null;
  const createdAt = nowIso();

  db.prepare(`
    INSERT INTO pim_user_sessions (
      session_token_hash,
      user_id,
      created_at,
      expires_at,
      last_seen_at,
      user_agent,
      ip_address
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    userId,
    createdAt,
    expiresAt,
    createdAt,
    userAgent,
    ipAddress
  );

  return {
    token,
    expiresAt,
  };
}

function sessionCookie(token, expiresAt) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];

  if (isProduction() && !allowHttpLan()) parts.push("Secure");

  return parts.join("; ");
}

function clearSessionCookie() {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];

  if (isProduction() && !allowHttpLan()) parts.push("Secure");

  return parts.join("; ");
}

function currentSessionHash(request) {
  const token = parseCookies(request)[SESSION_COOKIE_NAME];
  return token ? hashToken(token) : null;
}

function revokeCurrentSession(request) {
  const tokenHash = currentSessionHash(request);
  if (!tokenHash) return false;

  const result = db.prepare(`
    UPDATE pim_user_sessions
    SET revoked_at = ?
    WHERE session_token_hash = ?
      AND revoked_at IS NULL
  `).run(nowIso(), tokenHash);

  return result.changes > 0;
}

function revokeOtherSessions(userId, request) {
  const tokenHash = currentSessionHash(request);
  const result = db.prepare(`
    UPDATE pim_user_sessions
    SET revoked_at = ?
    WHERE user_id = ?
      AND revoked_at IS NULL
      AND (? IS NULL OR session_token_hash <> ?)
  `).run(nowIso(), userId, tokenHash, tokenHash);

  return result.changes;
}

function changePassword(
  userId,
  currentPassword,
  newPassword,
  confirmPassword,
  options = {}
) {
  const user = db.prepare(`
    SELECT id, username, password_hash
    FROM users
    WHERE id = ?
      AND active = 1
  `).get(userId);

  if (!user) {
    throw new AuthError(401, "Authentication required.");
  }

  if (
    !options.skipCurrentPassword &&
    !verifyPassword(currentPassword, user.password_hash)
  ) {
    throw new AuthError(401, "Current password is incorrect.");
  }

  const errors = validatePassword(newPassword, confirmPassword);
  if (Object.keys(errors).length) {
    const error = new AuthError(400, "Password validation failed.");
    error.details = errors;
    throw error;
  }

  db.prepare(`
    UPDATE users
    SET password_hash = ?,
        must_change_password = 0,
        failed_login_count = 0,
        locked_until = NULL,
        password_changed_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hashPassword(newPassword), nowIso(), userId);

  auditAuth("PASSWORD_CHANGED", userId, user.username, "Password changed.");
}

module.exports = {
  AuthError,
  LOCK_MINUTES,
  MAX_FAILED_LOGINS,
  MIN_PASSWORD_LENGTH,
  ROLES,
  SESSION_COOKIE_NAME,
  assertSafeStateChange,
  authenticateUser,
  can,
  changePassword,
  clearSessionCookie,
  createSession,
  getCurrentUser,
  hashPassword,
  permissionSummary,
  requirePermission,
  requireUser,
  revokeCurrentSession,
  revokeOtherSessions,
  sessionCookie,
  validatePassword,
  verifyPassword,
};
