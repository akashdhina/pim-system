/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Batch 1 (Phase 6) focused tests for the new PostgreSQL foundation.
 * Follows this repo's plain-script + assert() convention (see
 * scripts/test-auth-lan-http.js, scripts/test-supabase-auth.js,
 * scripts/test-pim-rls.js).
 *
 * Tests 5, 7, 8 need no live PostgreSQL connection and always run.
 * Tests 1, 2, 3, 4, 6 need SUPABASE_DB_URL (server-only; the pim-system
 * project's Transaction Pooler connection string). If it is not set, they
 * are SKIPPED and clearly reported as such - never silently treated as
 * passing.
 *
 * Test data created (and removed regardless of pass/fail): two throwaway
 * rows in `dispute_categories` (currently empty in production - 0 rows,
 * confirmed by the Phase 0/2 audits - so this table carries no real data
 * risk), codes 'TEST-PG-COMMIT-<timestamp>' and 'TEST-PG-ROLLBACK-<timestamp>'.
 * The rollback row must NOT exist after the test; the commit row is
 * explicitly deleted in a `finally` block.
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());
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

// ---------------------------------------------------------------------
// Test 5: SQLite remains functional (unaffected by the new PostgreSQL path).
// ---------------------------------------------------------------------

async function testSqliteStillWorks() {
  await test("5. SQLite remains functional", () => {
    const db = require("../lib/db");
    const row = db.prepare("SELECT 1 AS ok").get();
    assert.strictEqual(row.ok, 1);
  });
}

// ---------------------------------------------------------------------
// Test 7: the migrated route still enforces its permission check first.
// ---------------------------------------------------------------------

async function testPermissionCheckStillFirst() {
  await test(
    "7. GET /api/pim/mediators still calls requirePermission(READ_MEDIATOR) before any data access",
    () => {
      const routeSource = fs.readFileSync(
        path.join(REPO_ROOT, "app/api/pim/mediators/route.js"),
        "utf8"
      );
      const getHandlerMatch = routeSource.match(
        /export async function GET\(request\) \{([\s\S]*?)\n\}/
      );
      assert.ok(getHandlerMatch, "GET handler not found");
      const getBody = getHandlerMatch[1];

      const permissionIndex = getBody.indexOf('requirePermission(request, "READ_MEDIATOR")');
      const dataAccessIndex = getBody.indexOf("listMediators(");

      assert.ok(permissionIndex !== -1, "requirePermission call not found in GET");
      assert.ok(dataAccessIndex !== -1, "listMediators call not found in GET");
      assert.ok(
        permissionIndex < dataAccessIndex,
        "requirePermission must run before listMediators"
      );
    }
  );
}

// ---------------------------------------------------------------------
// Test 8: SUPABASE_DB_URL never reaches client-reachable code.
// ---------------------------------------------------------------------

const ALLOWED_DB_URL_REFERENCES = new Set(
  [
    ".env.local",
    "lib/pim-postgres.js",
    "scripts/sync-users-to-postgres.js",
    "scripts/test-pim-postgres.js",
    "scripts/test-pim-case-detail.js",
    "scripts/test-pim-cases.js",
    "scripts/test-pim-dashboard.js",
    "scripts/test-pim-users.js",
    "scripts/test-pim-settings.js",
    "docs/phase6-migration-design.md",
    "docs/phase6-transaction-readiness.md",
    "docs/phase6-batch5c-intake-migration.md",
    "scripts/test-pim-intake-postgres.js",
    "scripts/test-pim-nonstarter-postgres.js",
    "scripts/test-pim-scrutiny-postgres.js",
    "scripts/test-pim-read-loaders-postgres.js",
    "scripts/test-pim-tasks-search-postgres.js",
    "scripts/test-pim-mediator-registry-postgres.js",
    "scripts/test-pim-numbering-postgres.js",
    "scripts/test-pim-form2-postgres.js",
    "scripts/test-pim-service-postgres.js",
    "scripts/test-pim-response-postgres.js",
  ].map((p) => path.join(REPO_ROOT, p))
);

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "backups",
  "storage",
  "documents",
  "logs",
]);

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.local") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

async function testSecretIsolation() {
  await test("8a. SUPABASE_DB_URL only appears in server-only files", () => {
    const offenders = [];
    walk(REPO_ROOT, (file) => {
      if (!/\.(js|jsx|ts|tsx|md)$/i.test(file) && !file.endsWith(".env.local")) return;
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        return;
      }
      if (text.includes("SUPABASE_DB_URL") && !ALLOWED_DB_URL_REFERENCES.has(file)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    });
    assert.deepStrictEqual(offenders, [], `unexpected references: ${offenders.join(", ")}`);
  });

  await test("8b. no NEXT_PUBLIC_* env var name embeds the DB connection string", () => {
    const envPath = path.join(REPO_ROOT, ".env.local");
    const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const offendingLines = text
      .split("\n")
      .filter((line) => /^NEXT_PUBLIC_.*(DB_URL|DATABASE|CONNECTION)/i.test(line.trim()));
    assert.deepStrictEqual(offendingLines, []);
  });

  await test('8c. no "use client" file imports lib/pim-postgres or lib/pim-data', () => {
    const offenders = [];
    const appDir = path.join(REPO_ROOT, "app");
    if (fs.existsSync(appDir)) {
      walk(appDir, (file) => {
        if (!/\.(jsx?|tsx?)$/.test(file)) return;
        const text = fs.readFileSync(file, "utf8");
        const isClientFile = /^\s*["']use client["'];?/.test(text);
        if (isClientFile && /pim-postgres|pim-data/.test(text)) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      });
    }
    assert.deepStrictEqual(offenders, []);
  });
}

// ---------------------------------------------------------------------
// Tests 1-4, 6: require SUPABASE_DB_URL against the real pim-system project.
// ---------------------------------------------------------------------

async function runConnectionDependentTests() {
  const { getSql, withTransaction } = require("../lib/pim-postgres");
  const { listMediators } = require("../lib/pim-data/mediators");

  const sql = getSql();
  const commitCode = `TEST-PG-COMMIT-${Date.now()}`;
  const rollbackCode = `TEST-PG-ROLLBACK-${Date.now()}`;

  try {
    await test("1. PostgreSQL connection works", async () => {
      const [{ ok }] = await sql`SELECT 1 AS ok`;
      assert.strictEqual(ok, 1);
    });

    await test("2. PostgreSQL parameterized query works", async () => {
      const knownId = 12; // Mr.R.Ravikumar, a real seeded mediator (Phase 2)
      const rows = await sql`SELECT id, name FROM mediators WHERE id = ${knownId}`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, knownId);
      assert.strictEqual(rows[0].name, "Mr.R.Ravikumar");
    });

    await test("3. PostgreSQL transaction BEGIN/COMMIT works", async () => {
      await withTransaction(async (tx) => {
        await tx`INSERT INTO dispute_categories (code, name, active) VALUES (${commitCode}, 'Phase 6 commit test', true)`;
      });
      const rows = await sql`SELECT code FROM dispute_categories WHERE code = ${commitCode}`;
      assert.strictEqual(rows.length, 1, "committed row must be visible after the transaction returns");
    });

    await test("4. PostgreSQL transaction ROLLBACK works", async () => {
      await assert.rejects(
        withTransaction(async (tx) => {
          await tx`INSERT INTO dispute_categories (code, name, active) VALUES (${rollbackCode}, 'Phase 6 rollback test', true)`;
          throw new Error("deliberate failure to force a rollback");
        })
      );
      const rows = await sql`SELECT code FROM dispute_categories WHERE code = ${rollbackCode}`;
      assert.strictEqual(rows.length, 0, "a thrown error inside withTransaction must roll back its insert");
    });

    await test("6. First migrated read-only route (listMediators) returns correct results", async () => {
      // Batch 5H-a (Phase 6) mediator-panel reconciliation: the real mediator
      // master now holds the five approved panel members (Rajesh, Ravikumar,
      // plus Kutty/Subramaniam/Viswanath), not the original two - see
      // docs/phase6-batch5h-mediator-registry-migration.md.
      const result = await listMediators(new URLSearchParams());
      assert.strictEqual(result.rows.length, 5, "all five approved mediators should be returned");
      const names = result.rows.map((r) => r.name).sort();
      assert.deepStrictEqual(names, [
        "Mr. K. Viswanath", "Mr. Narayanan Kutty", "Mr.H.Rajesh", "Mr.R.Ravikumar", "Mrs. Latha Subramaniam",
      ]);
      assert.deepStrictEqual(result.categories, ["ADVOCATE MEDIATOR"]);
      assert.strictEqual(result.pagination.total, 5);
      for (const row of result.rows) {
        assert.strictEqual(typeof row.active, "boolean", "active must be a real boolean, not 0/1");
        assert.strictEqual(row.total_assignments, 0);
        assert.strictEqual(row.total_sessions, 0);
      }
    });
  } finally {
    await sql`DELETE FROM dispute_categories WHERE code IN (${commitCode}, ${rollbackCode})`;
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  await testSqliteStillWorks();
  await testPermissionCheckStillFirst();
  await testSecretIsolation();

  if (!process.env.SUPABASE_DB_URL) {
    skip("1. PostgreSQL connection works", "SUPABASE_DB_URL not set in this environment");
    skip("2. PostgreSQL parameterized query works", "SUPABASE_DB_URL not set in this environment");
    skip("3. PostgreSQL transaction BEGIN/COMMIT works", "SUPABASE_DB_URL not set in this environment");
    skip("4. PostgreSQL transaction ROLLBACK works", "SUPABASE_DB_URL not set in this environment");
    skip("6. First migrated read-only route (listMediators) returns correct results", "SUPABASE_DB_URL not set in this environment");
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
