/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Batch 2 (Phase 6) focused tests for lib/pim-data/case-detail.js.
 * Follows this repo's plain-script + assert() convention (see
 * scripts/test-pim-postgres.js et al.).
 *
 * Tests that need no live PostgreSQL connection always run. Tests that
 * build a reference case need SUPABASE_DB_URL; if it is not set, they are
 * SKIPPED and clearly reported as such.
 *
 * pim_cases has zero real rows in production today (confirmed in the
 * Phase 0/2 audits and again at the start of this batch), so "parity"
 * cannot be shown from empty results - this script builds ONE clearly
 * marked reference case (pim_number 'TEST-BATCH2-CASE', party names
 * prefixed "TEST ", advocate name "TEST Advocate Batch2") directly in the
 * pim-system project, exercising every relation the route reads
 * (2 parties, 2 addresses, 1 advocate, 2 status-history rows, 2 docket
 * entries - one with a NULL event_type_id, 2 tasks - one with a NULL
 * task_type_id, 1 notice, 1 service attempt, 1 response, 2 fees, 1
 * mediator assignment against a REAL seeded mediator (id 12, not a new
 * test mediator), 2 mediation sessions - one effective with a duration,
 * one not, 1 outcome, 1 document marked current), then removes every row
 * in a `finally` block regardless of pass/fail. This exact fixture was
 * hand-verified against the live database via the Supabase MCP tools
 * before being encoded here (see the Batch 2 report for those results).
 *
 * This is the same self-cleaning production-insert pattern already used
 * successfully in scripts/test-pim-rls.js and Batch 1's
 * scripts/test-pim-postgres.js, extended to a full reference case instead
 * of single rows.
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

// ---------------------------------------------------------------------
// Credential-independent: permission check still runs before data access.
// ---------------------------------------------------------------------

async function testPermissionCheckStillFirst() {
  await test(
    '7. GET /api/pim/case/[id] still calls requirePermission(READ_CASE) before any data access',
    () => {
      const routeSource = fs.readFileSync(
        path.join(REPO_ROOT, "app/api/pim/case/[id]/route.js"),
        "utf8"
      );
      const getHandlerMatch = routeSource.match(
        /export async function GET\(request, \{ params \}\) \{([\s\S]*?)\n\}/
      );
      assert.ok(getHandlerMatch, "GET handler not found");
      const getBody = getHandlerMatch[1];

      const permissionIndex = getBody.indexOf('requirePermission(request, "READ_CASE")');
      const dataAccessIndex = getBody.indexOf("getCaseDetail(");

      assert.ok(permissionIndex !== -1, "requirePermission call not found in GET");
      assert.ok(dataAccessIndex !== -1, "getCaseDetail call not found in GET");
      assert.ok(permissionIndex < dataAccessIndex, "requirePermission must run before getCaseDetail");
    }
  );
}

async function testNoRawSqlConcatenation() {
  await test("SQL parameterization: case-detail.js never string-concatenates a value into a query", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/case-detail.js"), "utf8");
    // Every WHERE clause in this file filters by case/notice id via a
    // tagged-template interpolation (${caseId}), which postgres.js always
    // binds as a real parameter - never via string concatenation (`+`)
    // building a WHERE clause, which is the pattern that would be unsafe.
    const suspiciousConcatenation = /WHERE[^`]*['"]\s*\+|['"]\s*\+[^`]*WHERE/i.test(source);
    assert.strictEqual(suspiciousConcatenation, false);
  });
}

// ---------------------------------------------------------------------
// Connection-dependent tests.
// ---------------------------------------------------------------------

async function buildReferenceCase(sql) {
  const [{ id: statusReceived }] = await sql`SELECT id FROM status_master WHERE code = 'RECEIVED'`;
  const [{ id: statusScrutiny }] = await sql`SELECT id FROM status_master WHERE code = 'SCRUTINY_PENDING'`;
  const [{ id: eventId }] = await sql`SELECT id FROM event_types WHERE code = 'APPLICATION_RECEIVED'`;
  const [{ id: taskTypeId }] = await sql`SELECT id FROM task_types WHERE code = 'SCRUTINY'`;

  const [{ id: caseId }] = await sql`
    INSERT INTO pim_cases (entry_type, pim_number, received_number, received_date, application_date, current_status_id, claim_amount, priority)
    VALUES ('NEW', 'TEST-BATCH2-CASE', 'TEST-BATCH2-RCV', '2026-01-05', '2026-01-05', ${statusScrutiny}, 450000.50, 'NORMAL')
    RETURNING id
  `;
  const [{ id: applicantId }] = await sql`INSERT INTO pim_parties (name, entity_type) VALUES ('TEST Applicant Batch2', 'INDIVIDUAL') RETURNING id`;
  const [{ id: opId }] = await sql`INSERT INTO pim_parties (name, entity_type) VALUES ('TEST Opposite Party Batch2', 'COMPANY') RETURNING id`;

  await sql`INSERT INTO pim_case_parties (case_id, party_id, role, sequence_no, is_primary) VALUES (${caseId}, ${applicantId}, 'APPLICANT', 1, true)`;
  await sql`INSERT INTO pim_case_parties (case_id, party_id, role, sequence_no, is_primary) VALUES (${caseId}, ${opId}, 'OPPOSITE_PARTY', 1, true)`;

  await sql`INSERT INTO pim_addresses (party_id, address_type, address_line1, district, state, pincode, is_current) VALUES (${applicantId}, 'POSTAL', '1 Test Street', 'The Nilgiris', 'Tamil Nadu', '643001', true)`;
  await sql`INSERT INTO pim_addresses (party_id, address_type, address_line1, district, state, pincode, is_current) VALUES (${opId}, 'POSTAL', '2 Test Avenue', 'The Nilgiris', 'Tamil Nadu', '643002', true)`;

  const [{ id: advocateId }] = await sql`INSERT INTO pim_advocates (name, enrollment_no) VALUES ('TEST Advocate Batch2', 'TN/1234/2020') RETURNING id`;
  await sql`INSERT INTO pim_case_advocates (case_id, party_id, advocate_id, role, from_date) VALUES (${caseId}, ${applicantId}, ${advocateId}, 'COUNSEL', '2026-01-05')`;

  await sql`INSERT INTO pim_status_history (case_id, from_status_id, to_status_id, reason) VALUES (${caseId}, NULL, ${statusReceived}, 'Application received.')`;
  await sql`INSERT INTO pim_status_history (case_id, from_status_id, to_status_id, reason) VALUES (${caseId}, ${statusReceived}, ${statusScrutiny}, 'Sent for scrutiny.')`;

  await sql`INSERT INTO pim_docket (case_id, docket_date, event_type_id, entry_text) VALUES (${caseId}, '2026-01-05', ${eventId}, 'Application received and entered for scrutiny.')`;
  await sql`INSERT INTO pim_docket (case_id, docket_date, event_type_id, entry_text) VALUES (${caseId}, '2026-01-06', NULL, 'Manual docket note with no event type.')`;

  await sql`INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, status, auto_generated) VALUES (${caseId}, ${taskTypeId}, 'SCRUTINY', 'Scrutiny of received application', '2026-01-05', '2026-01-05', 'PENDING', true)`;
  await sql`INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, status, completed_date, auto_generated) VALUES (${caseId}, NULL, 'MANUAL', 'A manually completed task', '2026-01-05', '2026-01-05', 'COMPLETED', '2026-01-06', false)`;

  const [{ id: noticeId }] = await sql`
    INSERT INTO pim_notices (case_id, notice_type, form_no, notice_date, appearance_date, appearance_time, recipient_party_id, status)
    VALUES (${caseId}, 'FORM_2_INITIAL', 'FORM-2', '2026-01-10', '2026-01-20', '10:30 AM', ${opId}, 'DISPATCHED')
    RETURNING id
  `;
  await sql`INSERT INTO pim_service_attempts (notice_id, dispatch_mode, dispatch_date, tracking_no) VALUES (${noticeId}, 'REGISTERED_POST', '2026-01-10', 'TRACK123TEST')`;
  await sql`INSERT INTO pim_responses (case_id, party_id, notice_id, response_date, response_type, consent, mediation_fee_requested) VALUES (${caseId}, ${opId}, ${noticeId}, '2026-01-20', 'APPEARED', 1, 1)`;

  await sql`INSERT INTO pim_fees (case_id, party_id, fee_type, amount_due, amount_received, status) VALUES (${caseId}, ${applicantId}, 'APPLICATION_FEE', 1000, 1000, 'RECEIVED')`;
  await sql`INSERT INTO pim_fees (case_id, party_id, fee_type, amount_due, amount_received, status) VALUES (${caseId}, ${opId}, 'MEDIATION_FEE', 15000, 5000.25, 'PARTIAL')`;

  const [{ id: assignmentId }] = await sql`INSERT INTO pim_mediator_assignments (case_id, mediator_id, assignment_date, status) VALUES (${caseId}, 12, '2026-01-25', 'ACTIVE') RETURNING id`;
  await sql`INSERT INTO mediation_sessions (case_id, assignment_id, sitting_number, scheduled_date, actual_date, applicant_present, opposite_party_present, effective_session, duration_minutes, session_status) VALUES (${caseId}, ${assignmentId}, 1, '2026-02-01', '2026-02-01', true, true, true, 45, 'COMPLETED')`;
  await sql`INSERT INTO mediation_sessions (case_id, assignment_id, sitting_number, scheduled_date, applicant_present, opposite_party_present, effective_session, session_status) VALUES (${caseId}, ${assignmentId}, 2, '2026-02-15', false, false, false, 'SCHEDULED')`;

  await sql`INSERT INTO pim_outcomes (case_id, outcome_type, form_no, outcome_date, settlement_terms, sent_to_applicant, sent_to_opposite_party) VALUES (${caseId}, 'SETTLED', 'FORM-4', '2026-02-01', 'Terms of test settlement.', true, false)`;
  await sql`INSERT INTO pim_documents (case_id, notice_id, document_type, document_title, document_date, file_path, generated_by_system, version_no, is_current) VALUES (${caseId}, ${noticeId}, 'FORM_2', 'Form-2 Initial Notice - TEST Opposite Party Batch2', '2026-01-10', 'storage/pim/2026/TEST-BATCH2-CASE/FORM-2/FORM-2-N1-v1.docx', true, 1, true)`;

  return { caseId, applicantId, opId, advocateId };
}

async function cleanupReferenceCase(sql, ids) {
  if (!ids) return;
  const { caseId, applicantId, opId, advocateId } = ids;
  await sql`DELETE FROM pim_documents WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_service_attempts WHERE notice_id IN (SELECT id FROM pim_notices WHERE case_id = ${caseId})`;
  await sql`DELETE FROM pim_responses WHERE case_id = ${caseId}`;
  await sql`DELETE FROM mediation_sessions WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_outcomes WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_mediator_assignments WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_fees WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_notices WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_addresses WHERE party_id IN (${applicantId}, ${opId})`;
  await sql`DELETE FROM pim_cases WHERE id = ${caseId}`;
  await sql`DELETE FROM pim_advocates WHERE id = ${advocateId}`;
  await sql`DELETE FROM pim_parties WHERE id IN (${applicantId}, ${opId})`;
}

async function runConnectionDependentTests() {
  const { getSql } = require("../lib/pim-postgres");
  const { getCaseDetail } = require("../lib/pim-data/case-detail");
  const sql = getSql();

  await test("PostgreSQL connection works (case-detail module)", async () => {
    const [{ ok }] = await sql`SELECT 1 AS ok`;
    assert.strictEqual(ok, 1);
  });

  await test("missing case: getCaseDetail returns null for a non-existent id", async () => {
    const result = await getCaseDetail(999999999);
    assert.strictEqual(result, null);
  });

  let ids = null;
  try {
    ids = await buildReferenceCase(sql);

    await test("response shape: top-level keys match the SQLite route's contract exactly", async () => {
      const data = await getCaseDetail(ids.caseId);
      assert.deepStrictEqual(
        Object.keys(data).sort(),
        [
          "case", "parties", "addresses", "advocates", "statusHistory", "docket", "tasks",
          "notices", "serviceAttempts", "responses", "fees", "feeSummary", "mediatorAssignments",
          "sessions", "cumulativeDurationMinutes", "outcome", "documents", "warnings",
        ].sort()
      );
    });

    await test("nullable relationships: docket with no event_type_id, task with no task_type_id resolve to null names", async () => {
      const data = await getCaseDetail(ids.caseId);
      const manualDocket = data.docket.find((d) => d.entry_text.includes("no event type"));
      assert.ok(manualDocket);
      assert.strictEqual(manualDocket.event_code, null);
      assert.strictEqual(manualDocket.event_name, null);

      const manualTask = data.tasks.find((t) => t.task_type_code === "MANUAL");
      assert.ok(manualTask);
      assert.strictEqual(manualTask.task_type_code_master, null);
      assert.strictEqual(manualTask.task_type_name, null);

      // outcome.verified_by/approved_by were left NULL - LEFT JOIN users must not fail.
      assert.strictEqual(data.outcome.verified_by_name, null);
      assert.strictEqual(data.outcome.approved_by_name, null);
    });

    await test("multiple related records: 2 parties, 2 status-history rows, 2 docket entries, 2 tasks, 2 fees, 2 sessions - all present and in order", async () => {
      const data = await getCaseDetail(ids.caseId);
      assert.strictEqual(data.parties.length, 2);
      assert.strictEqual(data.parties[0].role, "APPLICANT");
      assert.strictEqual(data.parties[1].role, "OPPOSITE_PARTY");
      assert.strictEqual(data.statusHistory.length, 2);
      assert.strictEqual(data.docket.length, 2);
      assert.strictEqual(data.tasks.length, 2);
      assert.strictEqual(data.tasks[0].status, "PENDING"); // PENDING sorts before COMPLETED
      assert.strictEqual(data.fees.length, 2);
      assert.strictEqual(data.sessions.length, 2);
      assert.strictEqual(data.sessions[0].sitting_number, 1);
      assert.strictEqual(data.sessions[1].sitting_number, 2);
    });

    await test("date fields: business dates come back as plain 'YYYY-MM-DD' strings, not Date objects", async () => {
      const data = await getCaseDetail(ids.caseId);
      assert.strictEqual(data.case.received_date, "2026-01-05");
      assert.strictEqual(typeof data.case.received_date, "string");
      assert.strictEqual(data.notices[0].notice_date, "2026-01-10");
    });

    await test("boolean fields: is_primary/is_current are real booleans; the is_current warnings fix works", async () => {
      const data = await getCaseDetail(ids.caseId);
      assert.strictEqual(typeof data.parties[0].is_primary, "boolean");
      assert.strictEqual(data.parties[0].is_primary, true);
      assert.strictEqual(typeof data.documents[0].is_current, "boolean");
      assert.strictEqual(data.documents[0].is_current, true);
      assert.strictEqual(data.documents[0].has_file, 1);
      // no "duplicate-current-document" or "missing-form_4" warning should
      // fire for this healthy single-current-document fixture
      assert.strictEqual(data.warnings.some((w) => w.code === "duplicate-current-document"), false);
    });

    await test("aggregation: cumulativeDurationMinutes sums only effective sessions with a duration (45, not 45+null)", async () => {
      const data = await getCaseDetail(ids.caseId);
      assert.strictEqual(data.cumulativeDurationMinutes, 45);
    });

    await test("ids: bigint primary keys come back as real numbers, not strings", async () => {
      const data = await getCaseDetail(ids.caseId);
      assert.strictEqual(typeof data.case.id, "number");
      assert.strictEqual(data.case.id, ids.caseId);
    });

    await test("money fields: numeric amounts come back as real numbers, not strings", async () => {
      const data = await getCaseDetail(ids.caseId);
      assert.strictEqual(typeof data.case.claim_amount, "number");
      assert.strictEqual(data.case.claim_amount, 450000.5);
      assert.strictEqual(data.feeSummary.mediationFee.amountDue, 15000);
      assert.strictEqual(data.feeSummary.mediationFee.amountReceived, 5000.25);
      assert.strictEqual(data.feeSummary.mediationFee.balance, 9999.75);
    });
  } finally {
    if (ids) {
      try {
        await cleanupReferenceCase(sql, ids);
      } catch (cleanupError) {
        console.error("WARNING: failed to clean up the Batch 2 reference case:", cleanupError.message);
        console.error("Check pim-system for leftover rows with pim_number = 'TEST-BATCH2-CASE'.");
      }
    }
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  await testPermissionCheckStillFirst();
  await testNoRawSqlConcatenation();

  if (!process.env.SUPABASE_DB_URL) {
    for (const name of [
      "PostgreSQL connection works (case-detail module)",
      "missing case: getCaseDetail returns null for a non-existent id",
      "response shape: top-level keys match the SQLite route's contract exactly",
      "nullable relationships: docket with no event_type_id, task with no task_type_id resolve to null names",
      "multiple related records: 2 parties, 2 status-history rows, 2 docket entries, 2 tasks, 2 fees, 2 sessions - all present and in order",
      "date fields: business dates come back as plain 'YYYY-MM-DD' strings, not Date objects",
      "boolean fields: is_primary/is_current are real booleans; the is_current warnings fix works",
      "aggregation: cumulativeDurationMinutes sums only effective sessions with a duration (45, not 45+null)",
      "ids: bigint primary keys come back as real numbers, not strings",
      "money fields: numeric amounts come back as real numbers, not strings",
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
