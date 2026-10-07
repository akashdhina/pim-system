/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Batch 1 (Phase 6): syncs the legacy SQLite `users` table's non-secret
 * identity columns into PostgreSQL `users`, so that FK columns elsewhere
 * (changed_by, entered_by, created_by, approved_by, etc.) can resolve once
 * case-data writes are ported in later batches.
 *
 * Deliberately copies ONLY: id, username, display_name, designation,
 * role_code, active. Never copies password_hash, failed_login_count,
 * locked_until, last_login_at, password_changed_at, must_change_password,
 * or anything from pim_user_sessions - PostgreSQL `users` is never used
 * for authentication in this design (see docs/phase6-migration-design.md
 * section 4), only as an FK-attribution target. The `id` is preserved
 * exactly as in SQLite so existing/future FK references stay compatible.
 *
 * SQLite users
 *   -> id, username, display_name, designation, role_code, active
 *   -> PostgreSQL users (same id, no password_hash)
 *   -> existing FK references (changed_by/entered_by/etc.) now resolve
 *
 * Safe to re-run: upserts by id, never deletes, never touches SQLite.
 *
 * Usage: node scripts/sync-users-to-postgres.js
 * Requires SUPABASE_DB_URL (server-only, see lib/pim-postgres.js).
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const db = require("../lib/db");
const { getSql } = require("../lib/pim-postgres");

async function main() {
  const legacyUsers = db
    .prepare(
      `SELECT id, username, display_name, designation, role_code, active
       FROM users
       ORDER BY id`
    )
    .all();

  if (legacyUsers.length === 0) {
    console.log("No SQLite users found - nothing to sync.");
    return;
  }

  const sql = getSql();
  let synced = 0;

  for (const user of legacyUsers) {
    await sql`
      INSERT INTO users (id, username, display_name, designation, role_code, active)
      OVERRIDING SYSTEM VALUE
      VALUES (${user.id}, ${user.username}, ${user.display_name}, ${user.designation}, ${user.role_code}, ${Boolean(user.active)})
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        display_name = EXCLUDED.display_name,
        designation = EXCLUDED.designation,
        role_code = EXCLUDED.role_code,
        active = EXCLUDED.active,
        updated_at = now()
    `;
    synced += 1;
    console.log(`Synced user id=${user.id} username=${user.username} (no password_hash copied).`);
  }

  // Keep the identity (bigint) sequence past any explicit ids inserted above.
  await sql`SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users))`;

  console.log(`\nDone: ${synced} user identity row(s) synced to PostgreSQL.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("User sync failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
