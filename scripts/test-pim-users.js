/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Batch 4 (Phase 6) focused tests for lib/pim-data/users.js.
 *
 * IMPORTANT SCOPE NOTE: PostgreSQL `users` has zero rows in production
 * right now (scripts/sync-users-to-postgres.js has never been run - it
 * needs the same SUPABASE_DB_URL this script needs, which is not set).
 * This script therefore does NOT attempt a real 6-legacy-user identity
 * comparison - that remains genuinely blocked until the credential exists
 * and the sync is actually run (see the Batch 4 report). What this script
 * verifies instead is that the ported query logic itself is correct: ID
 * preservation, filtering, ordering, NULL handling, and - critically -
 * that no secret field is ever returned. It builds 2 throwaway synthetic
 * users (username 'test-b4-aa'/'test-b4-secretary'), never real people,
 * removed in a `finally` block regardless of pass/fail.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${error instanceof Error ? error.message : error}`);
    failures.push(name);
  }
}

function skip(name, reason) {
  console.log(`SKIP: ${name} (${reason})`);
}

async function testPermissionCheckStillFirst() {
  await test(
    "permission enforcement: GET /api/pim/users and GET /api/pim/users/[id] still call requirePermission(VIEW_USERS) before any data access",
    () => {
      const listSource = fs.readFileSync(path.join(REPO_ROOT, "app/api/pim/users/route.js"), "utf8");
      const listGet = listSource.match(/export async function GET\(request\) \{([\s\S]*?)\n\}/)[1];
      assert.ok(listGet.indexOf('requirePermission(request, "VIEW_USERS")') < listGet.indexOf("listUsersPg("));

      const detailSource = fs.readFileSync(path.join(REPO_ROOT, "app/api/pim/users/[id]/route.js"), "utf8");
      const detailGet = detailSource.match(/export async function GET\(request, \{ params \}\) \{([\s\S]*?)\n\}/)[1];
      assert.ok(detailGet.indexOf('requirePermission(request, "VIEW_USERS")') < detailGet.indexOf("getUserPg("));
    }
  );
}

async function testNoSecretFieldsInModuleSource() {
  await test("no secret fields returned: lib/pim-data/users.js never selects or returns password_hash", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/users.js"), "utf8");
    // Strip comments first - the module deliberately documents in a
    // comment that password_hash is NOT selected, which would otherwise
    // false-positive a plain substring check.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.strictEqual(codeOnly.includes("password_hash"), false);
  });
}

async function buildFixture(sql) {
  const [aa] = await sql`
    INSERT INTO users (username, display_name, designation, role_code, active)
    VALUES ('test-b4-aa', 'TEST B4 AA User', 'Test Operator', 'aa', true)
    RETURNING id
  `;
  const [secretary] = await sql`
    INSERT INTO users (username, display_name, designation, role_code, active)
    VALUES ('test-b4-secretary', 'TEST B4 Secretary', 'Test Secretary', 'secretary', false)
    RETURNING id
  `;
  return { aaId: aa.id, secretaryId: secretary.id };
}

async function cleanupFixture(sql) {
  await sql`DELETE FROM users WHERE username LIKE 'test-b4-%'`;
}

async function runConnectionDependentTests() {
  const { getSql } = require("../lib/pim-postgres");
  const { listUsers, getUser } = require("../lib/pim-data/users");
  const sql = getSql();

  await test("PostgreSQL connection works (users module)", async () => {
    const [{ ok }] = await sql`SELECT 1 AS ok`;
    assert.strictEqual(ok, 1);
  });

  let ids = null;
  try {
    ids = await buildFixture(sql);

    await test("users list/read: listUsers returns our 2 fixture users, filterable by username search", async () => {
      const result = await listUsers({ search: "test-b4" });
      assert.strictEqual(result.data.length, 2);
    });

    await test("ID preservation: getUser(id) returns the exact same id it was queried with", async () => {
      const user = await getUser(ids.aaId);
      assert.strictEqual(user.id, ids.aaId);
    });

    await test("username/display name/designation/role preserved exactly", async () => {
      const user = await getUser(ids.aaId);
      assert.strictEqual(user.username, "test-b4-aa");
      assert.strictEqual(user.display_name, "TEST B4 AA User");
      assert.strictEqual(user.designation, "Test Operator");
      assert.strictEqual(user.role_code, "aa");
    });

    await test("active flag: true/false preserved exactly, filterable via active=1/active=0", async () => {
      const activeUser = await getUser(ids.aaId);
      const inactiveUser = await getUser(ids.secretaryId);
      assert.strictEqual(activeUser.active, true);
      assert.strictEqual(inactiveUser.active, false);

      const onlyActive = await listUsers({ search: "test-b4", active: "1" });
      assert.deepStrictEqual(onlyActive.data.map((u) => u.id), [ids.aaId]);

      const onlyInactive = await listUsers({ search: "test-b4", active: "0" });
      assert.deepStrictEqual(onlyInactive.data.map((u) => u.id), [ids.secretaryId]);
    });

    await test("NULL behavior: locked_until/last_login_at/password_changed_at are null, not undefined or a stray string", async () => {
      const user = await getUser(ids.aaId);
      assert.strictEqual(user.locked_until, null);
      assert.strictEqual(user.last_login_at, null);
      assert.strictEqual(user.password_changed_at, null);
    });

    await test("no secret fields returned: getUser()/listUsers() results never contain password_hash", async () => {
      const user = await getUser(ids.aaId);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(user, "password_hash"), false);

      const list = await listUsers({ search: "test-b4" });
      for (const row of list.data) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(row, "password_hash"), false);
      }
    });

    await test("active_sessions comes from SQLite (0 for a brand-new fixture user with no real session), not a Postgres-side count", async () => {
      const user = await getUser(ids.aaId);
      assert.strictEqual(user.active_sessions, 0);
    });
  } finally {
    if (ids) {
      try {
        await cleanupFixture(sql);
      } catch (cleanupError) {
        console.error("WARNING: failed to clean up the Batch 4 users fixture:", cleanupError.message);
        console.error("Check pim-system for leftover rows with username LIKE 'test-b4-%'.");
      }
    }
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  await testPermissionCheckStillFirst();
  await testNoSecretFieldsInModuleSource();

  if (!process.env.SUPABASE_DB_URL) {
    for (const name of [
      "PostgreSQL connection works (users module)",
      "users list/read: listUsers returns our 2 fixture users, filterable by username search",
      "ID preservation: getUser(id) returns the exact same id it was queried with",
      "username/display name/designation/role preserved exactly",
      "active flag: true/false preserved exactly, filterable via active=1/active=0",
      "NULL behavior: locked_until/last_login_at/password_changed_at are null, not undefined or a stray string",
      "no secret fields returned: getUser()/listUsers() results never contain password_hash",
      "active_sessions comes from SQLite (0 for a brand-new fixture user with no real session), not a Postgres-side count",
    ]) {
      skip(name, "SUPABASE_DB_URL not set in this environment");
    }
  } else {
    await runConnectionDependentTests();
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error("Test run crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
