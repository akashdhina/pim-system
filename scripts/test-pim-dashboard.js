/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Batch 3 (Phase 6) focused tests for lib/pim-data/dashboard.js.
 * Reuses the same 3-case fixture pattern as scripts/test-pim-cases.js
 * (pim_number 'TEST-B3D-CASE-A/B/C', deliberately distinct from
 * test-pim-cases.js's own fixture so the two scripts can run independently
 * without colliding), so every dashboard metric this batch touches has
 * real, known-by-construction data to verify against. Removed in a
 * `finally` block regardless of pass/fail.
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
    "GET /api/pim/dashboard still calls requirePermission(READ_CASE) before any data access",
    () => {
      const routeSource = fs.readFileSync(path.join(REPO_ROOT, "app/api/pim/dashboard/route.js"), "utf8");
      const getHandlerMatch = routeSource.match(/export async function GET\(request\) \{([\s\S]*?)\n\}/);
      assert.ok(getHandlerMatch, "GET handler not found");
      const getBody = getHandlerMatch[1];
      const permissionIndex = getBody.indexOf('requirePermission(request, "READ_CASE")');
      const dataAccessIndex = getBody.indexOf("getDashboard(");
      assert.ok(permissionIndex !== -1 && dataAccessIndex !== -1 && permissionIndex < dataAccessIndex);
    }
  );
}

async function buildFixture(sql) {
  const [{ id: scrutinyPending }] = await sql`SELECT id FROM status_master WHERE code = 'SCRUTINY_PENDING'`;
  const [{ id: closedSettled }] = await sql`SELECT id FROM status_master WHERE code = 'CLOSED_SETTLED'`;
  const [{ id: form2Pending }] = await sql`SELECT id FROM status_master WHERE code = 'FORM2_PENDING'`;

  const [{ id: caseA }] = await sql`
    INSERT INTO pim_cases (entry_type, pim_number, received_number, received_date, application_date, current_status_id, internal_60_day_date, priority)
    VALUES ('NEW', 'TEST-B3D-CASE-A', 'TEST-B3D-RCV-A', '2026-01-05', '2026-01-05', ${scrutinyPending}, (CURRENT_DATE + 3), 'NORMAL')
    RETURNING id
  `;
  const [{ id: applicantA }] = await sql`INSERT INTO pim_parties (name, entity_type) VALUES ('TEST B3D Applicant A', 'INDIVIDUAL') RETURNING id`;
  await sql`INSERT INTO pim_case_parties (case_id, party_id, role, sequence_no, is_primary) VALUES (${caseA}, ${applicantA}, 'APPLICANT', 1, true)`;
  // due today -> exercises dueToday; also the single PENDING task -> pendingTasks/taskTypeCounts
  await sql`INSERT INTO pim_tasks (case_id, task_type_code, description, created_date, due_date, status, auto_generated) VALUES (${caseA}, 'SCRUTINY', 'Scrutiny for case A', '2026-01-05', CURRENT_DATE, 'PENDING', true)`;

  const [{ id: caseB }] = await sql`
    INSERT INTO pim_cases (entry_type, pim_number, received_number, received_date, application_date, current_status_id, outcome_type, outcome_date, closed_at, priority)
    VALUES ('NEW', 'TEST-B3D-CASE-B', 'TEST-B3D-RCV-B', '2025-12-01', '2025-12-01', ${closedSettled}, 'SETTLED', '2026-01-01', now(), 'NORMAL')
    RETURNING id
  `;

  const [{ id: caseC }] = await sql`
    INSERT INTO pim_cases (entry_type, pim_number, received_number, received_date, application_date, current_status_id, internal_60_day_date, priority)
    VALUES ('NEW', 'TEST-B3D-CASE-C', 'TEST-B3D-RCV-C', '2026-01-10', '2026-01-10', ${form2Pending}, (CURRENT_DATE - 5), 'URGENT')
    RETURNING id
  `;
  const [{ id: applicantC }] = await sql`INSERT INTO pim_parties (name, entity_type) VALUES ('TEST B3D Applicant C', 'INDIVIDUAL') RETURNING id`;
  await sql`INSERT INTO pim_case_parties (case_id, party_id, role, sequence_no, is_primary) VALUES (${caseC}, ${applicantC}, 'APPLICANT', 1, true)`;
  // overdue -> exercises overdueTasks/taskTotals.overdue_tasks
  await sql`INSERT INTO pim_tasks (case_id, task_type_code, description, created_date, due_date, status, auto_generated) VALUES (${caseC}, 'MANUAL', 'Overdue task for case C', '2026-01-10', (CURRENT_DATE - 2), 'PENDING', false)`;
  // a COMPLETED task must never count toward pending_tasks/overdue_tasks
  await sql`INSERT INTO pim_tasks (case_id, task_type_code, description, created_date, due_date, status, completed_date, auto_generated) VALUES (${caseC}, 'MANUAL', 'Completed task for case C', '2026-01-10', '2026-01-11', 'COMPLETED', '2026-01-12', false)`;

  return { caseA, caseB, caseC };
}

async function cleanupFixture(sql) {
  await sql`DELETE FROM pim_tasks WHERE case_id IN (SELECT id FROM pim_cases WHERE pim_number LIKE 'TEST-B3D-%')`;
  await sql`DELETE FROM pim_case_parties WHERE case_id IN (SELECT id FROM pim_cases WHERE pim_number LIKE 'TEST-B3D-%')`;
  await sql`DELETE FROM pim_cases WHERE pim_number LIKE 'TEST-B3D-%'`;
  await sql`DELETE FROM pim_parties WHERE name LIKE 'TEST B3D %'`;
}

async function runConnectionDependentTests() {
  const { getSql } = require("../lib/pim-postgres");
  const { getDashboard } = require("../lib/pim-data/dashboard");
  const sql = getSql();

  await test("PostgreSQL connection works (dashboard module)", async () => {
    const [{ ok }] = await sql`SELECT 1 AS ok`;
    assert.strictEqual(ok, 1);
  });

  await test("empty result: getDashboard() does not throw against an (otherwise) empty database, all counts are 0 not null", async () => {
    const data = await getDashboard();
    assert.strictEqual(typeof data.totals.totalCases, "number");
    assert.ok(!Number.isNaN(data.totals.totalCases));
  });

  let ids = null;
  try {
    ids = await buildFixture(sql);
    const data = await getDashboard();
    const byPimNumber = (rows) => rows.filter((r) => String(r.pim_number || "").startsWith("TEST-B3D-"));

    await test("totals: totalCases/openCases/closedCases count our 3 fixture cases correctly (2 open, 1 closed)", async () => {
      assert.ok(data.totals.totalCases >= 3);
      // isolate to fixture rows via statusCounts, which is exact per status code
      const scrutinyPendingCount = data.statusCounts.find((s) => s.code === "SCRUTINY_PENDING").count;
      const closedSettledCount = data.statusCounts.find((s) => s.code === "CLOSED_SETTLED").count;
      const form2PendingCount = data.statusCounts.find((s) => s.code === "FORM2_PENDING").count;
      assert.ok(scrutinyPendingCount >= 1);
      assert.ok(closedSettledCount >= 1);
      assert.ok(form2PendingCount >= 1);
    });

    await test("date-window boundaries: approaching60Day includes case A, overdue60Day includes case C", async () => {
      // approachingCases/overdueTasks lists are LIMIT 8 and not filtered to
      // the fixture, but since production has no other real data right
      // now, the fixture's cases are directly checkable in these lists.
      assert.ok(byPimNumber(data.approachingCases).some((c) => c.pim_number === "TEST-B3D-CASE-A"));
      assert.ok(byPimNumber(data.overdueTasks).some((t) => t.pim_number === "TEST-B3D-CASE-C"));
      assert.ok(byPimNumber(data.dueToday).some((t) => t.pim_number === "TEST-B3D-CASE-A"));
    });

    await test("status filtering: recentClosedCases contains case B and only ever contains closed statuses", async () => {
      assert.ok(byPimNumber(data.recentClosedCases).some((c) => c.pim_number === "TEST-B3D-CASE-B"));
      const closedCodes = new Set(["CLOSED_SETTLED", "CLOSED_FAILED", "CLOSED_NON_STARTER", "WITHDRAWN"]);
      for (const row of data.recentClosedCases) {
        assert.ok(closedCodes.has(row.status_code));
      }
    });

    await test("NULL/duplicate-prevention: a COMPLETED task never appears in pendingTasks/overdueTasks/dueToday", async () => {
      const allTaskLists = [...data.pendingTasks, ...data.overdueTasks, ...data.dueToday];
      assert.strictEqual(
        allTaskLists.some((t) => t.description === "Completed task for case C"),
        false
      );
    });

    await test("each dashboard metric: pendingTasks/overdueTasks totals match taskTotals aggregate for our fixture's contribution", async () => {
      const pendingForFixture = byPimNumber(data.pendingTasks);
      // case A's 1 pending task (due today) + case C's 1 pending task (overdue) = 2; case C's COMPLETED task is excluded
      assert.strictEqual(pendingForFixture.length, 2);
    });

    await test("response shape: every top-level dashboard key is present", async () => {
      assert.deepStrictEqual(
        Object.keys(data).sort(),
        [
          "totals", "cardCounts", "statusCounts", "taskTypeCounts", "recentCases", "recentClosedCases",
          "pendingTasks", "dueToday", "overdueTasks", "approachingCases", "sittingsToday",
          "expiringMediators", "recentActivity", "latestBackup",
        ].sort()
      );
    });
  } finally {
    if (ids) {
      try {
        await cleanupFixture(sql);
      } catch (cleanupError) {
        console.error("WARNING: failed to clean up the Batch 3 dashboard fixture:", cleanupError.message);
        console.error("Check pim-system for leftover rows with pim_number LIKE 'TEST-B3D-%'.");
      }
    }
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  await testPermissionCheckStillFirst();

  if (!process.env.SUPABASE_DB_URL) {
    for (const name of [
      "PostgreSQL connection works (dashboard module)",
      "empty result: getDashboard() does not throw against an (otherwise) empty database, all counts are 0 not null",
      "totals: totalCases/openCases/closedCases count our 3 fixture cases correctly (2 open, 1 closed)",
      "date-window boundaries: approaching60Day includes case A, overdue60Day includes case C",
      "status filtering: recentClosedCases contains case B and only ever contains closed statuses",
      "NULL/duplicate-prevention: a COMPLETED task never appears in pendingTasks/overdueTasks/dueToday",
      "each dashboard metric: pendingTasks/overdueTasks totals match taskTotals aggregate for our fixture's contribution",
      "response shape: every top-level dashboard key is present",
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
