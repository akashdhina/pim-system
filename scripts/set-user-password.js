/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../lib/db");
const {
  hashPassword,
  validatePassword,
} = require("../lib/pim-auth");

const username = String(process.argv[2] || "").trim().toLowerCase();
const temporaryPassword = process.env.PIM_TEMP_PASSWORD || "";
const confirmation =
  process.env.PIM_TEMP_PASSWORD_CONFIRM || temporaryPassword;

if (!username) {
  console.error("Usage: node scripts\\set-user-password.js <username>");
  console.error("Set PIM_TEMP_PASSWORD in the environment before running.");
  process.exit(1);
}

const errors = validatePassword(temporaryPassword, confirmation);
if (Object.keys(errors).length) {
  console.error("Password validation failed.");
  for (const message of Object.values(errors)) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

const user = db.prepare(`
  SELECT id, username
  FROM users
  WHERE lower(username) = ?
`).get(username);

if (!user) {
  console.error("User was not found.");
  process.exit(1);
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
`).run(hashPassword(temporaryPassword), new Date().toISOString(), user.id);

db.prepare(`
  UPDATE pim_user_sessions
  SET revoked_at = ?
  WHERE user_id = ?
    AND revoked_at IS NULL
`).run(new Date().toISOString(), user.id);

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
  user.id,
  "PASSWORD_RESET",
  null,
  JSON.stringify({ username: user.username, must_change_password: true }),
  null,
  "Temporary password set by setup script."
);

console.log(`Temporary password set for ${user.username}.`);
console.log("The user must change this password at next login.");
