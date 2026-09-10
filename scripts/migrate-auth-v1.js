/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../lib/db");

const roleByUsername = {
  aa: "aa",
  secretary: "secretary",
  chairman: "chairman",
  admin: "admin",
};

function tableColumns(tableName) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((column) => column.name)
  );
}

function addColumn(tableName, columnName, definition) {
  const columns = tableColumns(tableName);
  if (columns.has(columnName)) return false;

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  return true;
}

function migrate() {
  db.pragma("foreign_keys = ON");

  const changes = [];

  if (addColumn("users", "role_code", "role_code TEXT CHECK (role_code IN ('aa','secretary','chairman','admin'))")) {
    changes.push("users.role_code");
  }
  if (addColumn("users", "password_hash", "password_hash TEXT")) {
    changes.push("users.password_hash");
  }
  if (addColumn("users", "failed_login_count", "failed_login_count INTEGER NOT NULL DEFAULT 0")) {
    changes.push("users.failed_login_count");
  }
  if (addColumn("users", "locked_until", "locked_until TEXT")) {
    changes.push("users.locked_until");
  }
  if (addColumn("users", "last_login_at", "last_login_at TEXT")) {
    changes.push("users.last_login_at");
  }
  if (addColumn("users", "password_changed_at", "password_changed_at TEXT")) {
    changes.push("users.password_changed_at");
  }
  if (addColumn("users", "must_change_password", "must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1))")) {
    changes.push("users.must_change_password");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pim_user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      user_agent TEXT,
      ip_address TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users(username);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON pim_user_sessions(session_token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON pim_user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON pim_user_sessions(expires_at);
  `);

  const updateRole = db.prepare(`
    UPDATE users
    SET role_code = ?
    WHERE username = ?
      AND (role_code IS NULL OR role_code = '')
  `);

  for (const [username, role] of Object.entries(roleByUsername)) {
    updateRole.run(role, username);
  }

  return changes;
}

try {
  const changes = db.transaction(migrate)();

  console.log("Auth v1 migration complete.");
  console.log(`Columns added: ${changes.length ? changes.join(", ") : "none"}`);
  console.log("Session table and auth indexes are ready.");
} catch (error) {
  console.error("Auth v1 migration failed.");
  console.error(error);
  process.exitCode = 1;
}
