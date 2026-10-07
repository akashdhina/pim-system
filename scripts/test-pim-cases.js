/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Batch 3 (Phase 6) focused tests for lib/pim-data/cases.js.
 * Follows this repo's plain-script + assert() convention.
 *
 * pim_cases has zero real rows in production - this script builds 3
 * clearly marked reference cases (pim_number 'TEST-B3-CASE-A/B/C') directly
 * in pim-system, exercising different statuses (SCRUTINY_PENDING open,
 * CLOSED_SETTLED closed, FORM2_PENDING open), different received/
 * registration dates, one with full relations (A: 2 parties, 1 task due
 * today), one completely bare (B: no relations at all), and one with
 * partial relations plus a task with a NULL due_date alongside one with a
 * future due_date (C - this specific pair exists to prove the NULLS FIRST
 * fix in lib/pim-data/cases.js actually matters: hand-verified via the
 * Supabase MCP tools before this script was written that WITHOUT NULLS
 * FIRST, Postgres picks the wrong task - see the Batch 3 report). Removed
 * in a `finally` block regardless of pass/fail.
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
    "GET /api/pim/cases still calls requirePermission(READ_CASE) before any data access",
    () => {
      const routeSource = fs.readFileSync(path.join(REPO_ROOT, "app/api/pim/cases/route.js"), "utf8");
      const getHandlerMatch = routeSource.match(/export async function GET\(request\) \{([\s\S]*?)\n\}/);
      assert.ok(getHandlerMatch, "GET handler not found");
      const getBody = getHandlerMatch[1];
      const permissionIndex = getBody.indexOf('requirePermission(request, "READ_CASE")');
      const dataAccessIndex = getBody.indexOf("listCases(");
      assert.ok(permissionIndex !== -1 && dataAccessIndex !== -1 && permissionIndex < dataAccessIndex);
    }
  );
}

async function buildFixture(sql) {
  const [{ id: scrutinyPending }] = await sql`SELECT id FROM status_master WHERE code = 'SCRUTINY_PENDING'`;
  const [{ id: closedSettled }] = await sql`SELECT id FROM status_master WHERE code = 'CLOSED_SETTLED'`;
  const [{ id: form2Pending }] = await sql`SELECT id FROM status_master WHERE code = 'FORM2_PENDING'`;
  const [{ id: taskTypeScrutiny }] = await sql`SELECT id FROM task_types WHERE code = 'SCRUTINY'`;

  const [{ id: caseA }] = await sql`
    INSERT INTO pim_cases (entry_type, pim_number, received_number, received_date, application_date, registration_date, current_status_id, internal_60_day_date, priority)
    VALUES ('NEW', 'TEST-B3-CASE-A', 'TEST-B3-RCV-A', '2026-01-05', '2026-01-05', '2026-01-07', ${scrutinyPending}, (CURRENT_DATE + 3), 'NORMAL')
    RETURNING id
  `;
  const [{ id: applicantA }] = await sql`INSERT INTO pim_parties (name, entity_type) VALUES ('TEST B3 Applicant A', 'INDIVIDUAL') RETURNING id`;
  const [{ id: opA }] = await sql`INSERT INTO pim_parties (name, entity_type) VALUES ('TEST B3 Opposite A', 'COMPANY') RETURNING id`;
  await sql`INSERT INTO pim_case_parties (case_id, party_id, role, sequence_no, is_primary) VALUES (${caseA}, ${applicantA}, 'APPLICANT', 1, true)`;
  await sql`INSERT INTO pim_case_parties (case_id, party_id, role, sequence_no, is_primary) VALUES (${caseA}, ${opA}, 'OPPOSITE_PARTY', 1, true)`;
  await sql`INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, status, auto_generated) VALUES (${caseA}, ${taskTypeScrutiny}, 'SCRUTINY', 'Scrutiny for case A', '2026-01-05', CURRENT_DATE, 'PENDING', true)`;

  const [{ id: caseB }] = await sql`
    INSERT INTO pim_cases (entry_type, pim_number, received_number, received_date, application_date, current_status_id, outcome_type, outcome_date, closed_at, priority)
    VALUES ('NEW', 'TEST-B3-CASE-B', 'TEST-B3-RCV-B', '2025-12-01', '2025-12-01', ${closedSettled}, 'SETTLED', '2026-01-01', now(), 'NORMAL')
    RETURNING id
  `;

  const [{ id: caseC }] = await sql`
    INSERT INTO pim_cases (entry_type, pim_number, received_number, received_date, application_date, current_status_id, internal_60_day_date, priority)
    VALUES ('NEW', 'TEST-B3-CASE-C', 'TEST-B3-RCV-C', '2026-01-10', '2026-01-10', ${form2Pending}, (CURRENT_DATE - 5), 'URGENT')
    RETURNING id
  `;
  const [{ id: applicantC }] = await sql`INSERT INTO pim_parties (name, entity_type) VALUES ('TEST B3 Applicant C', 'INDIVIDUAL') RETURNING id`;
  await sql`INSERT INTO pim_case_parties (case_id, party_id, role, sequence_no, is_primary) VALUES (${caseC}, ${applicantC}, 'APPLICANT', 1, true)`;
  await sql`INSERT INTO pim_tasks (case_id, task_type_code, description, created_date, due_date, status, auto_generated) VALUES (${caseC}, 'MANUAL', 'Task with a future due date', '2026-01-10', (CURRENT_DATE + 10), 'PENDING', false)`;
  await sql`INSERT INTO pim_tasks (case_id, task_type_code, description, created_date, due_date, status, auto_generated) VALUES (${caseC}, 'MANUAL', 'Task with NO due date - should sort first', '2026-01-10', NULL, 'PENDING', false)`;

  return { caseA, caseB, caseC, applicantA, opA, applicantC };
}

async function cleanupFixture(sql) {
  await sql`DELETE FROM pim_tasks WHERE case_id IN (SELECT id FROM pim_cases WHERE pim_number LIKE 'TEST-B3-%')`;
  await sql`DELETE FROM pim_case_parties WHERE case_id IN (SELECT id FROM pim_cases WHERE pim_number LIKE 'TEST-B3-%')`;
  await sql`DELETE FROM pim_cases WHERE pim_number LIKE 'TEST-B3-%'`;
  await sql`DELETE FROM pim_parties WHERE name LIKE 'TEST B3 %'`;
}

async function runConnectionDependentTests() {
  const { getSql } = require("../lib/pim-postgres");
  const { listCases } = require("../lib/pim-data/cases");
  const sql = getSql();

  await test("PostgreSQL connection works (cases module)", async () => {
    const [{ ok }] = await sql`SELECT 1 AS ok`;
    assert.strictEqual(ok, 1);
  });

  await test("empty result: filtering to a pim_number that matches nothing returns zero rows, not an error", async () => {
    const result = await listCases(new URLSearchParams({ pimNumber: "NO-SUCH-CASE-XYZ" }));
    assert.deepStrictEqual(result.rows, []);
    assert.strictEqual(result.pagination.total, 0);
  });

  let ids = null;
  try {
    ids = await buildFixture(sql);

    await test("filtering: pimNumber, status, and partyName filters each isolate the right case", async () => {
      const byPimNumber = await listCases(new URLSearchParams({ pimNumber: "TEST-B3-CASE-A" }));
      assert.strictEqual(byPimNumber.rows.length, 1);
      assert.strictEqual(byPimNumber.rows[0].id, ids.caseA);

      const byStatus = await listCases(new URLSearchParams({ status: "CLOSED_SETTLED", pimNumber: "TEST-B3" }));
      assert.strictEqual(byStatus.rows.length, 1);
      assert.strictEqual(byStatus.rows[0].id, ids.caseB);

      const byParty = await listCases(new URLSearchParams({ partyName: "TEST B3 Applicant C" }));
      assert.strictEqual(byParty.rows.length, 1);
      assert.strictEqual(byParty.rows[0].id, ids.caseC);
    });

    await test("status/category filtering: openClosed=open/closed", async () => {
      const open = await listCases(new URLSearchParams({ openClosed: "open", pimNumber: "TEST-B3" }));
      assert.deepStrictEqual(open.rows.map((r) => r.id).sort(), [ids.caseA, ids.caseC].sort());

      const closed = await listCases(new URLSearchParams({ openClosed: "closed", pimNumber: "TEST-B3" }));
      assert.deepStrictEqual(closed.rows.map((r) => r.id), [ids.caseB]);
    });

    await test("date filtering: deadline=approaching (case A) and deadline=overdue (case C)", async () => {
      const approaching = await listCases(new URLSearchParams({ deadline: "approaching", pimNumber: "TEST-B3" }));
      assert.deepStrictEqual(approaching.rows.map((r) => r.id), [ids.caseA]);

      const overdue = await listCases(new URLSearchParams({ deadline: "overdue", pimNumber: "TEST-B3" }));
      assert.deepStrictEqual(overdue.rows.map((r) => r.id), [ids.caseC]);
    });

    await test("sorting/ordering: default order is COALESCE(registration_date, received_date) DESC, id DESC (C, A, B)", async () => {
      const result = await listCases(new URLSearchParams({ pimNumber: "TEST-B3" }));
      assert.deepStrictEqual(result.rows.map((r) => r.id), [ids.caseC, ids.caseA, ids.caseB]);
    });

    // Note: unlike lib/pim-data/mediators.js, the SQLite cases route has no
    // sort/direction parameter at all - only page/pageSize, whose invalid-
    // input handling (positiveInt's fallback) is what's actually tested here.
    await test("invalid pagination input: unsupported pageSize/page values fall back to the same defaults as SQLite", async () => {
      const result = await listCases(new URLSearchParams({ pimNumber: "TEST-B3", page: "not-a-number", pageSize: "-5" }));
      assert.strictEqual(result.pagination.page, 1);
      assert.strictEqual(result.pagination.pageSize, 20);
    });

    await test("pagination: page 1 (size 2) and page 2 (size 2) partition the 3 matching cases with a stable total", async () => {
      const page1 = await listCases(new URLSearchParams({ pimNumber: "TEST-B3", pageSize: "2", page: "1" }));
      const page2 = await listCases(new URLSearchParams({ pimNumber: "TEST-B3", pageSize: "2", page: "2" }));
      assert.strictEqual(page1.rows.length, 2);
      assert.strictEqual(page2.rows.length, 1);
      assert.strictEqual(page1.pagination.total, 3);
      assert.strictEqual(page2.pagination.total, 3);
      assert.strictEqual(page1.pagination.totalPages, 2);
      const allIds = [...page1.rows, ...page2.rows].map((r) => r.id);
      assert.deepStrictEqual(allIds, [ids.caseC, ids.caseA, ids.caseB], "pagination must not reorder or duplicate rows");
    });

    await test("total count: matches the unpaginated row count for a filtered query", async () => {
      const result = await listCases(new URLSearchParams({ openClosed: "open", pimNumber: "TEST-B3" }));
      assert.strictEqual(result.pagination.total, 2);
    });

    await test("nullable relationships: case B (bare) has null applicant/opposite names and no pending task fields", async () => {
      const result = await listCases(new URLSearchParams({ pimNumber: "TEST-B3-CASE-B" }));
      const row = result.rows[0];
      assert.strictEqual(row.applicant_name, null);
      assert.strictEqual(row.opposite_party_name, null);
      assert.strictEqual(row.pending_task_id, undefined);
    });

    await test("NULLS FIRST fix: case C's pending-task pick is the NULL-due-date task, matching SQLite's default ordering", async () => {
      const result = await listCases(new URLSearchParams({ pimNumber: "TEST-B3-CASE-C" }));
      const row = result.rows[0];
      assert.strictEqual(row.pending_task_due_date, null);
      assert.ok(row.pending_task_description.includes("should sort first"));
    });

    await test("response shape: rows carry an `action` object from lib/pim-action-link.js", async () => {
      const result = await listCases(new URLSearchParams({ pimNumber: "TEST-B3-CASE-A" }));
      assert.ok(result.rows[0].action);
      assert.ok(typeof result.rows[0].action.label === "string");
    });
  } finally {
    if (ids) {
      try {
        await cleanupFixture(sql);
      } catch (cleanupError) {
        console.error("WARNING: failed to clean up the Batch 3 cases fixture:", cleanupError.message);
        console.error("Check pim-system for leftover rows with pim_number LIKE 'TEST-B3-%'.");
      }
    }
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  await testPermissionCheckStillFirst();

  if (!process.env.SUPABASE_DB_URL) {
    for (const name of [
      "PostgreSQL connection works (cases module)",
      "empty result: filtering to a pim_number that matches nothing returns zero rows, not an error",
      "filtering: pimNumber, status, and partyName filters each isolate the right case",
      "status/category filtering: openClosed=open/closed",
      "date filtering: deadline=approaching (case A) and deadline=overdue (case C)",
      "sorting/ordering: default order is COALESCE(registration_date, received_date) DESC, id DESC (C, A, B)",
      "invalid pagination input: unsupported pageSize/page values fall back to the same defaults as SQLite",
      "pagination: page 1 (size 2) and page 2 (size 2) partition the 3 matching cases with a stable total",
      "total count: matches the unpaginated row count for a filtered query",
      "nullable relationships: case B (bare) has null applicant/opposite names and no pending task fields",
      "NULLS FIRST fix: case C's pending-task pick is the NULL-due-date task, matching SQLite's default ordering",
      "response shape: rows carry an `action` object from lib/pim-action-link.js",
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
