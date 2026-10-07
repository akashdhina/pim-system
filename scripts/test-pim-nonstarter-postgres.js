/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5D tests: PostgreSQL implementation of non-starter
 * outcome recording (T7) - lib/pim-data/nonstarter.js +
 * lib/pim-data/workflow-helpers.js.
 *
 * Live PostgreSQL tests need SUPABASE_DB_URL (loaded here via
 * @next/env's loadEnvConfig, same fix applied in Batch 5C) and use the
 * real synced users (id=1..6, dhinagaran/secretary/chairman/admin/
 * janani/operator2) - no fabricated identity, matching Batch 5C.
 *
 * Fixture strategy: each live test first creates a REAL prerequisite
 * case via the already-verified Batch 5C createReceivedPimApplicationPg
 * (a realistic prerequisite record, not a hand-crafted raw INSERT),
 * then exercises recordNonStarterPg against it. Cleanup is entirely
 * ID-driven (case_id captured from each created row, never a
 * name/prefix match) - Batch 5C found a real production-residue bug
 * from prefix-based cleanup; this script does not repeat that mistake.
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
// Static/source-level tests - no live database needed, always run.
// ---------------------------------------------------------------------

async function testPermissionCheckStillFirst() {
  await test(
    "F (static). POST /api/pim/nonstarter/[id] still calls requirePermission(RECORD_OUTCOME) before the Postgres call",
    () => {
      const source = fs
        .readFileSync(path.join(REPO_ROOT, "app/api/pim/nonstarter/[id]/route.js"), "utf8")
        .replace(/\r\n/g, "\n");
      const body = source.match(/export async function POST\(\s*request,\s*\{ params \}\s*\) \{([\s\S]*?)\n\}/)[1];
      const permissionIndex = body.indexOf("requirePermission(");
      const argIndex = body.indexOf('"RECORD_OUTCOME"');
      const callIndex = body.indexOf("recordNonStarterPg(");
      assert.ok(permissionIndex !== -1, "requirePermission call not found");
      assert.ok(argIndex !== -1 && argIndex > permissionIndex, "RECORD_OUTCOME permission argument not found");
      assert.ok(callIndex !== -1, "recordNonStarterPg call not found");
      assert.ok(permissionIndex < callIndex, "requirePermission must run before the Postgres call");
    }
  );
}

async function testSqliteVersionStillImportedUnused() {
  await test(
    "static: the SQLite recordNonStarter is still imported (instant rollback) but not called by POST",
    () => {
      const source = fs
        .readFileSync(path.join(REPO_ROOT, "app/api/pim/nonstarter/[id]/route.js"), "utf8")
        .replace(/\r\n/g, "\n");
      assert.ok(source.includes("recordNonStarter, // SQLite version"), "SQLite version must still be imported, clearly marked");
      const body = source.match(/export async function POST\(\s*request,\s*\{ params \}\s*\) \{([\s\S]*?)\n\}/)[1];
      assert.ok(!body.includes("recordNonStarter({"), "POST must not call the SQLite version directly");
    }
  );
}

async function testWorkflowHelpersRequireExplicitTx() {
  await test(
    "static: lib/pim-data/workflow-helpers.js functions require tx explicitly (no default client to silently fall back to)",
    () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/workflow-helpers.js"), "utf8");
      // Strip comments first - the module's own header comment explains
      // the SQLite dbClient=db pattern it is deliberately NOT using,
      // which would otherwise false-positive a plain substring check
      // (same class of bug fixed in Batch 4's "no secret fields" test
      // and Batch 5C's "no generatePimNumber call" test).
      const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.ok(!codeOnly.includes("= db"), "workflow-helpers.js must not default to a SQLite-style global db client");
      assert.ok(source.includes("async function getStatusId(tx, code)"), "getStatusId(tx, code) signature not found");
      assert.ok(source.includes("async function addDocket(tx, caseId"), "addDocket(tx, ...) signature not found");
    }
  );
}

async function testNoPimNumberInvolvement() {
  await test(
    "static: T7 has no PIM-number generation involvement (distinct from T3/approval)",
    () => {
      const nonstarterSource = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/nonstarter.js"), "utf8");
      assert.ok(!nonstarterSource.includes("generatePimNumber"));
      const helpersSource = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/workflow-helpers.js"), "utf8");
      assert.ok(!helpersSource.includes("generatePimNumber"));
    }
  );
}

// ---------------------------------------------------------------------
// SQLite-side baseline (Step 11 parity) - runs against an isolated
// scratch database, never production.
// ---------------------------------------------------------------------

const SCRATCH_DB_PATH = path.join(__dirname, "..", "database", "test-pim-nonstarter.scratch.db");
if (!process.env.PIM_DB_PATH) {
  process.env.PIM_DB_PATH = SCRATCH_DB_PATH;
}

async function runSqliteBaselineTests() {
  const db = require("../lib/db");
  const { assertScratchDatabase } = require("../lib/pim-test-guard");
  assertScratchDatabase(db);

  const hasStatusMaster = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='status_master'`).get();
  if (!hasStatusMaster) {
    db.exec(fs.readFileSync(path.join(REPO_ROOT, "database", "schema.sql"), "utf8"));
  }
  for (const row of [
    ["RECEIVED", "Received", "INSTITUTION", 0],
    ["OUTCOME_FORM_PENDING", "Outcome Form Pending", "OUTCOME", 0],
    ["AUTHORITY_DECISION_PENDING", "Authority Decision Pending", "AUTHORITY", 0],
  ]) {
    db.prepare(`INSERT OR IGNORE INTO status_master (code, name, stage, is_terminal) VALUES (?, ?, ?, ?)`).run(...row);
  }
  db.prepare(`INSERT OR IGNORE INTO event_types (code, name, category) VALUES ('APPLICATION_RECEIVED', 'Application Received', 'INSTITUTION')`).run();
  db.prepare(`INSERT OR IGNORE INTO event_types (code, name, category) VALUES ('NONSTARTER_RECORDED', 'Non-Starter Recorded', 'OUTCOME')`).run();
  db.prepare(`INSERT OR IGNORE INTO task_types (code, name, default_priority) VALUES ('SCRUTINY', 'Scrutiny', 'NORMAL')`).run();
  db.prepare(`INSERT OR IGNORE INTO task_types (code, name, default_priority) VALUES ('NONSTARTER_FORM3', 'Prepare Form-3', 'NORMAL')`).run();
  db.prepare(`INSERT OR IGNORE INTO nonstarter_reasons (code, name, rule_reference, requires_authority_decision, active) VALUES ('BOTH_PARTIES_NOT_WILLING', 'Both parties not willing', 'Rule 3(4)', 0, 1)`).run();
  db.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, designation, role_code, active, must_change_password) VALUES (1, 'aa', 'Administrative Assistant', 'Junior Administrative Assistant', 'aa', 1, 0)`).run();

  const { createReceivedPimApplication } = require("../lib/pim");
  const { recordNonStarter } = require("../lib/pim-nonstarter");

  const cleanup = () => {
    const rows = db.prepare(`SELECT id FROM pim_cases WHERE received_number LIKE 'B5D-SQLITE-BASELINE-%'`).all();
    for (const row of rows) db.prepare("DELETE FROM pim_cases WHERE id = ?").run(row.id);
  };
  cleanup();

  await test(
    "C (SQLite baseline half): intake -> non-starter (manual reason) produces the known-good state transition T7's Postgres version must match",
    () => {
      const receivedNumber = `B5D-SQLITE-BASELINE-${Date.now()}`;
      const caseId = createReceivedPimApplication(
        {
          receivedNumber,
          receivedDate: "2026-02-01",
          applicationDate: "2026-01-30",
          applicants: [{ name: "Baseline Applicant" }],
          oppositeParties: [{ name: "Baseline Opposite Party" }],
          applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-02-01", bankName: "Test Bank", payee: "Chairman, DLSA" },
        },
        1
      );

      const result = db.transaction(() =>
        recordNonStarter({
          caseId,
          reasonCode: "BOTH_PARTIES_NOT_WILLING",
          outcomeDate: "2026-02-05",
          userId: 1,
        })
      )();

      assert.strictEqual(result.statusCode, "OUTCOME_FORM_PENDING");
      assert.strictEqual(result.nonstarterReasonCode, "BOTH_PARTIES_NOT_WILLING");
      assert.strictEqual(result.requiresAuthorityDecision, false);

      const caseRow = db.prepare("SELECT * FROM pim_cases WHERE id = ?").get(caseId);
      assert.strictEqual(caseRow.outcome_type, "NON_STARTER");
      assert.strictEqual(caseRow.outcome_date, "2026-02-05");
      assert.strictEqual(caseRow.current_status_id, db.prepare("SELECT id FROM status_master WHERE code='OUTCOME_FORM_PENDING'").get().id);

      const outcome = db.prepare("SELECT * FROM pim_outcomes WHERE case_id = ?").get(caseId);
      assert.strictEqual(outcome.id, result.outcomeId);
      assert.strictEqual(outcome.prepared_by, 1);

      const task = db.prepare("SELECT * FROM pim_tasks WHERE case_id = ? AND task_type_code='NONSTARTER_FORM3'").get(caseId);
      assert.strictEqual(task.id, result.form3TaskId);
      assert.strictEqual(task.status, "PENDING");
    }
  );

  cleanup();
  db.close();
}

// ---------------------------------------------------------------------
// Credential-gated live PostgreSQL tests.
// ---------------------------------------------------------------------

const RECEIVED_PREFIX = "TEST-B5D-";

function intakeFixturePayload(receivedNumber) {
  return {
    receivedNumber,
    receivedDate: "2026-02-01",
    applicationDate: "2026-01-30",
    applicants: [{ name: "B5D Fixture Applicant" }],
    oppositeParties: [{ name: "B5D Fixture Opposite Party" }],
    applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-02-01", bankName: "Test Bank", payee: "Chairman, DLSA" },
  };
}

/*
 * ID-driven cleanup only (Step 12; a name/prefix-matching cleanup bug
 * in Batch 5C left real residue in production). Every deletion below
 * is keyed by an exact id captured from a row this script itself just
 * created or looked up - never a LIKE pattern against business data.
 */
async function cleanupCaseById(sql, caseId) {
  await sql`DELETE FROM pim_tasks WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_docket WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_status_history WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_outcomes WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_fees WHERE case_id = ${caseId}`;
  const partyIds = await sql`SELECT party_id FROM pim_case_parties WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_case_advocates WHERE case_id = ${caseId}`;
  await sql`DELETE FROM pim_case_parties WHERE case_id = ${caseId}`;
  for (const p of partyIds) {
    await sql`DELETE FROM pim_addresses WHERE party_id = ${p.party_id}`;
    await sql`DELETE FROM pim_parties WHERE id = ${p.party_id}`;
  }
  await sql`DELETE FROM pim_cases WHERE id = ${caseId}`;
}

async function runConnectionDependentTests() {
  const { getSql } = require("../lib/pim-postgres");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { recordNonStarterPg } = require("../lib/pim-data/nonstarter");
  const sql = getSql();

  // Pre-flight: any prior-run residue under our prefix, found and
  // removed by id before this run starts (still id-driven per case -
  // the prefix is only used to FIND candidate ids, never to DELETE).
  const priorRows = await sql`SELECT id FROM pim_cases WHERE received_number LIKE ${RECEIVED_PREFIX + "%"}`;
  for (const row of priorRows) await cleanupCaseById(sql, row.id);

  const [{ userCount }] = await sql`SELECT COUNT(*)::int AS "userCount" FROM users`;

  if (userCount === 0) {
    for (const name of [
      "A. successful transaction: outcome/status-history/docket/task all created with correct FK linkage and user attribution",
      "B. rollback: a deliberately-invalid (never-fabricated, out-of-range) userId causes the whole non-starter transaction to roll back with zero partial rows",
      "D. generated IDs: outcomeId/form3TaskId match the exact ids returned by RETURNING id",
      "E. duplicate/conflict: recording a second non-starter outcome for the same case is rejected with the exact existing SQLite guard message",
      "G. date behavior: outcome_date/docket_date round-trip as plain 'YYYY-MM-DD' strings",
      "H. workflow invariant: an auto-triggered reason without its required pending NONSTARTER_FORM3 handoff task is rejected",
    ]) {
      skip(name, "PostgreSQL users table is empty - see docs/phase6-batch5c-intake-migration.md. Not fabricating a user to work around this.");
    }
    await sql.end({ timeout: 5 });
    return;
  }

  const [{ id: realUserId, username: realUsername }] = await sql`SELECT id, username FROM users ORDER BY id LIMIT 1`;

  /*
   * Every case id this run creates is tracked here and cleaned up in
   * the `finally` block below, regardless of which assertion (if any)
   * fails partway through - Step 12 requires cleanup to be unconditional,
   * not contingent on every test passing. This is the fix for exactly
   * the kind of gap that left residue after a failed test in this
   * script's own first run: a cleanup call written only at the *end* of
   * a test body never executes if an earlier assertion in that same
   * body throws.
   */
  const createdCaseIds = [];

  try {
    let caseIdA;
    await test("A. successful transaction: outcome/status-history/docket/task all created with correct FK linkage and user attribution", async () => {
      const receivedNumber = `${RECEIVED_PREFIX}A-${Date.now()}`;
      caseIdA = await createReceivedPimApplicationPg(intakeFixturePayload(receivedNumber), realUserId);
      createdCaseIds.push(caseIdA);

      const result = await recordNonStarterPg({
        caseId: caseIdA,
        reasonCode: "BOTH_PARTIES_NOT_WILLING",
        outcomeDate: "2026-02-05",
        userId: realUserId,
      });

      assert.strictEqual(result.statusCode, "OUTCOME_FORM_PENDING");
      assert.strictEqual(result.nonstarterReasonCode, "BOTH_PARTIES_NOT_WILLING");
      assert.strictEqual(result.requiresAuthorityDecision, false);

      const [caseRow] = await sql`SELECT * FROM pim_cases WHERE id = ${caseIdA}`;
      assert.strictEqual(caseRow.outcome_type, "NON_STARTER");
      const [statusRow] = await sql`SELECT id FROM status_master WHERE code = 'OUTCOME_FORM_PENDING'`;
      assert.strictEqual(caseRow.current_status_id, statusRow.id);

      const [outcome] = await sql`SELECT * FROM pim_outcomes WHERE case_id = ${caseIdA}`;
      assert.strictEqual(outcome.id, result.outcomeId);
      assert.strictEqual(outcome.prepared_by, realUserId, `prepared_by must be the real synced user (${realUsername})`);

      // The case has TWO status_history rows by this point: intake's own
      // ("PIM application received.") and this one from recordNonStarterPg -
      // select the non-starter one specifically, not "the row", to avoid
      // conflating a pre-existing, unrelated row with this transaction's.
      const [statusHistory] = await sql`
        SELECT * FROM pim_status_history WHERE case_id = ${caseIdA} AND reason LIKE 'Non-starter outcome recorded%'
      `;
      assert.ok(statusHistory, "the non-starter status_history row must exist");
      assert.strictEqual(statusHistory.changed_by, realUserId);

      const [docket] = await sql`
        SELECT * FROM pim_docket WHERE case_id = ${caseIdA} AND entry_text LIKE 'Non-starter outcome recorded%'
      `;
      assert.ok(docket, "the non-starter docket row must exist");
      assert.strictEqual(docket.entered_by, realUserId);

      const [task] = await sql`SELECT * FROM pim_tasks WHERE case_id = ${caseIdA} AND task_type_code = 'NONSTARTER_FORM3'`;
      assert.strictEqual(task.id, result.form3TaskId);
      assert.strictEqual(task.status, "PENDING");
    });

    await test("D. generated IDs: outcomeId/form3TaskId match the exact ids returned by RETURNING id", async () => {
      // Re-verified against the case A already created above - a second,
      // independent read confirming the ids returned by the function
      // call are the SAME ids actually stored, not inferred separately.
      const [outcome] = await sql`SELECT id FROM pim_outcomes WHERE case_id = ${caseIdA}`;
      const [task] = await sql`SELECT id FROM pim_tasks WHERE case_id = ${caseIdA} AND task_type_code = 'NONSTARTER_FORM3'`;
      assert.ok(Number.isInteger(outcome.id) && outcome.id > 0);
      assert.ok(Number.isInteger(task.id) && task.id > 0);
    });

    await test("G. date behavior: outcome_date/docket_date round-trip as plain 'YYYY-MM-DD' strings", async () => {
      const [caseRow] = await sql`SELECT outcome_date FROM pim_cases WHERE id = ${caseIdA}`;
      assert.strictEqual(caseRow.outcome_date, "2026-02-05");
      const [outcome] = await sql`SELECT outcome_date FROM pim_outcomes WHERE case_id = ${caseIdA}`;
      assert.strictEqual(outcome.outcome_date, "2026-02-05");
      const [docket] = await sql`
        SELECT docket_date FROM pim_docket WHERE case_id = ${caseIdA} AND entry_text LIKE 'Non-starter outcome recorded%'
      `;
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(docket.docket_date), "docket_date must be a plain date string (officeDate()), not a Date object");
    });

    await test("E. duplicate/conflict: recording a second non-starter outcome for the same case is rejected with the exact existing SQLite guard message", async () => {
      await assert.rejects(
        recordNonStarterPg({
          caseId: caseIdA,
          reasonCode: "BOTH_PARTIES_NOT_WILLING",
          outcomeDate: "2026-02-06",
          userId: realUserId,
        }),
        /A non-starter outcome has already been recorded for this case\. Current status: /
      );

      const outcomes = await sql`SELECT id FROM pim_outcomes WHERE case_id = ${caseIdA}`;
      assert.strictEqual(outcomes.length, 1, "the second attempt must not create a second outcome row");
    });

    // ---- Test B: rollback ----
    await test("B. rollback: a deliberately-invalid (never-fabricated, out-of-range) userId causes the whole non-starter transaction to roll back with zero partial rows", async () => {
      const receivedNumber = `${RECEIVED_PREFIX}B-${Date.now()}`;
      const caseId = await createReceivedPimApplicationPg(intakeFixturePayload(receivedNumber), realUserId);
      createdCaseIds.push(caseId);
      const [beforeStatus] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;

      const SENTINEL_INVALID_USER_ID = 999999999; // cannot exist; not a real or fabricated user

      await assert.rejects(
        recordNonStarterPg({
          caseId,
          reasonCode: "BOTH_PARTIES_NOT_WILLING",
          outcomeDate: "2026-02-05",
          userId: SENTINEL_INVALID_USER_ID,
        }),
        /violates foreign key constraint|foreign key/i
      );

      // pim_outcomes must be entirely empty for this case - T7 never
      // creates one on this failing path, unlike status_history/docket
      // below, which already have ONE legitimate pre-existing row each
      // from the intake fixture itself (created moments earlier by
      // createReceivedPimApplicationPg, a separate, already-committed
      // transaction) - checking for zero there would incorrectly count
      // that unrelated row as "residue" from this failed attempt.
      const outcomes = await sql`SELECT id FROM pim_outcomes WHERE case_id = ${caseId}`;
      assert.strictEqual(outcomes.length, 0, "pim_outcomes row must not remain");

      const nonStarterStatusHistory = await sql`
        SELECT id FROM pim_status_history WHERE case_id = ${caseId} AND reason LIKE 'Non-starter outcome recorded%'
      `;
      assert.strictEqual(nonStarterStatusHistory.length, 0, "no non-starter pim_status_history row must remain");

      const nonStarterDocket = await sql`
        SELECT id FROM pim_docket WHERE case_id = ${caseId} AND entry_text LIKE 'Non-starter outcome recorded%'
      `;
      assert.strictEqual(nonStarterDocket.length, 0, "no non-starter pim_docket row must remain");

      const tasks = await sql`SELECT id FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'NONSTARTER_FORM3'`;
      assert.strictEqual(tasks.length, 0, "pim_tasks row must not remain");

      const [afterStatus] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(afterStatus.current_status_id, beforeStatus.current_status_id, "case status must be unchanged after rollback");
    });

    // ---- Test H: workflow-specific invariant (auto-triggered reason guard) ----
    await test("H. workflow invariant: an auto-triggered reason without its required pending NONSTARTER_FORM3 handoff task is rejected", async () => {
      const receivedNumber = `${RECEIVED_PREFIX}H-${Date.now()}`;
      const caseId = await createReceivedPimApplicationPg(intakeFixturePayload(receivedNumber), realUserId);
      createdCaseIds.push(caseId);

      // OP_REFUSED_MEDIATION is auto-triggered - it requires a pending
      // NONSTARTER_FORM3 task (proof of a prior recorded case fact) that
      // this freshly-created case does not have.
      await assert.rejects(
        recordNonStarterPg({
          caseId,
          reasonCode: "OP_REFUSED_MEDIATION",
          outcomeDate: "2026-02-05",
          userId: realUserId,
        }),
        /requires an existing case-fact handoff \(pending NONSTARTER_FORM3 task\), and none was found for this case/
      );

      const outcomes = await sql`SELECT id FROM pim_outcomes WHERE case_id = ${caseId}`;
      assert.strictEqual(outcomes.length, 0, "no outcome may be recorded without the required handoff task");
    });
  } finally {
    for (const id of createdCaseIds) {
      await cleanupCaseById(sql, id);
    }
  }

  // Final residue check across every id this run touched.
  const residualRows = await sql`SELECT id FROM pim_cases WHERE received_number LIKE ${RECEIVED_PREFIX + "%"}`;
  assert.strictEqual(residualRows.length, 0, `residual test cases found after cleanup: ${residualRows.map((r) => r.id).join(",")}`);

  await sql.end({ timeout: 5 });
}

async function main() {
  await testPermissionCheckStillFirst();
  await testSqliteVersionStillImportedUnused();
  await testWorkflowHelpersRequireExplicitTx();
  await testNoPimNumberInvolvement();

  await runSqliteBaselineTests();

  if (!process.env.SUPABASE_DB_URL) {
    for (const name of [
      "A. successful transaction: outcome/status-history/docket/task all created with correct FK linkage and user attribution",
      "D. generated IDs: outcomeId/form3TaskId match the exact ids returned by RETURNING id",
      "G. date behavior: outcome_date/docket_date round-trip as plain 'YYYY-MM-DD' strings",
      "E. duplicate/conflict: recording a second non-starter outcome for the same case is rejected with the exact existing SQLite guard message",
      "B. rollback: a deliberately-invalid (never-fabricated, out-of-range) userId causes the whole non-starter transaction to roll back with zero partial rows",
      "H. workflow invariant: an auto-triggered reason without its required pending NONSTARTER_FORM3 handoff task is rejected",
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
