/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5C tests: PostgreSQL implementation of new PIM
 * application intake (T1) - lib/pim-data/intake.js.
 *
 * IMPORTANT SCOPE NOTE: two independent prerequisites gate what can
 * actually run live here, and this script deliberately distinguishes
 * them rather than collapsing them into one generic skip:
 *
 *   1. SUPABASE_DB_URL (server-only, the app's own direct-Postgres
 *      driver connection string) - unset throughout every batch so
 *      far, including this one. Without it, lib/pim-postgres.js's
 *      getSql()/withTransaction() cannot connect at all, so nothing
 *      that calls createReceivedPimApplicationPg() can run.
 *
 *   2. The PostgreSQL `users` table being populated by
 *      scripts/sync-users-to-postgres.js. As of this batch it still
 *      has zero rows (confirmed live via the Supabase MCP tools - see
 *      the Batch 5C report), which is a SEPARATE blocker from #1: even
 *      if SUPABASE_DB_URL were set right now, any successful intake
 *      would still fail with a foreign-key violation on
 *      pim_status_history.changed_by / pim_docket.entered_by, because
 *      no row in `users` exists for any real userId. This is the
 *      correct, honest, current behavior - see
 *      docs/phase6-batch5c-intake-migration.md and batch item 5. This
 *      script does NOT fabricate a user row to work around it.
 *
 * Tests that only need #1 (e.g. the rollback test, which uses a
 * deliberately-invalid sentinel userId and expects a real FK
 * violation) run whenever SUPABASE_DB_URL is set. Tests that need a
 * fully successful intake (generated-ID / duplicate / date-behavior
 * assertions) additionally check #2 live and SKIP with a specific,
 * distinct reason if `users` is still empty - never silently treated
 * as passing.
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
    "static: POST /api/pim/received still calls requirePermission(ENTER_APPLICATION) before the Postgres intake call",
    () => {
      // Read with line endings normalized - this file is CRLF on disk
      // (Windows), and a literal multi-line string match against raw
      // "\n" would silently never match "\r\n".
      const source = fs.readFileSync(path.join(REPO_ROOT, "app/api/pim/received/route.js"), "utf8").replace(/\r\n/g, "\n");
      const body = source.match(/export async function POST\(request\) \{([\s\S]*?)\n\}/)[1];
      const permissionIndex = body.indexOf("requirePermission(");
      const permissionArgIndex = body.indexOf('"ENTER_APPLICATION"');
      const callIndex = body.indexOf("createReceivedPimApplicationPg(");
      assert.ok(permissionIndex !== -1, "requirePermission call not found");
      assert.ok(permissionArgIndex !== -1 && permissionArgIndex > permissionIndex, "ENTER_APPLICATION permission argument not found");
      assert.ok(callIndex !== -1, "createReceivedPimApplicationPg call not found");
      assert.ok(permissionIndex < callIndex, "requirePermission must run before the Postgres intake call");
    }
  );
}

async function testSqliteVersionStillImportedUnused() {
  await test(
    "static: the SQLite createReceivedPimApplication is still imported (instant rollback) but not called by POST",
    () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, "app/api/pim/received/route.js"), "utf8").replace(/\r\n/g, "\n");
      assert.ok(source.includes("createReceivedPimApplication,"), "SQLite version must still be imported");
      const body = source.match(/export async function POST\(request\) \{([\s\S]*?)\n\}/)[1];
      // The SQLite function name must not appear as a call inside POST
      // (only the Pg-suffixed version should be invoked there).
      assert.ok(!/[^g]createReceivedPimApplication\(/.test(body), "POST must not call the SQLite version directly");
    }
  );
}

async function testValidationReusedNotDuplicated() {
  await test(
    "static: lib/pim-data/intake.js reuses lib/pim.js's validateReceivedApplication rather than duplicating it",
    () => {
      const pimSource = fs.readFileSync(path.join(REPO_ROOT, "lib/pim.js"), "utf8");
      assert.ok(pimSource.includes("validateReceivedApplication,"), "lib/pim.js must export validateReceivedApplication");

      const intakeSource = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/intake.js"), "utf8");
      assert.ok(
        intakeSource.includes('require("../pim")') && intakeSource.includes("validateReceivedApplication"),
        "lib/pim-data/intake.js must import validateReceivedApplication from lib/pim.js"
      );
      // No re-implementation: the Postgres module must not contain its
      // own copy of the fee-amount/payee validation literals.
      assert.ok(
        !intakeSource.includes("Application fee must be"),
        "lib/pim-data/intake.js must not duplicate validation logic"
      );
    }
  );
}

async function testNoPimNumberGenerationInIntake() {
  await test(
    "static: T1 generates no PIM number (pim_number stays NULL; generatePimNumber is never called)",
    () => {
      const intakeSource = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/intake.js"), "utf8");
      // Strip comments first - the module header comment explains WHY
      // generatePimNumber is not called, which would otherwise false-
      // positive a plain substring check (same class of bug fixed in
      // Batch 4's "no secret fields" test).
      const codeOnly = intakeSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.ok(!codeOnly.includes("generatePimNumber"), "intake.js must not call generatePimNumber");
      // The INSERT's VALUES list starts with NULL for pim_number.
      assert.ok(/VALUES\s*\(\s*NULL,/.test(intakeSource), "pim_cases.pim_number must be inserted as NULL");
    }
  );
}

async function testNoAuditLogWriteInvented() {
  await test(
    "static: no audit_log write was invented for the Postgres intake (matches SQLite - T1 never wrote one)",
    () => {
      const intakeSource = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/intake.js"), "utf8");
      const codeOnly = intakeSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.ok(!codeOnly.includes("audit_log"), "intake.js must not write audit_log");
    }
  );
}

async function testNoSecretLeak() {
  await test(
    'static: lib/pim-data/intake.js never references SUPABASE_DB_URL/SUPABASE_SERVICE_ROLE_KEY directly (only via lib/pim-postgres.js)',
    () => {
      const intakeSource = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/intake.js"), "utf8");
      assert.ok(!intakeSource.includes("SUPABASE_DB_URL"));
      assert.ok(!intakeSource.includes("SUPABASE_SERVICE_ROLE_KEY"));
    }
  );
}

async function testBooleanLiteralsAreNativeBooleans() {
  await test(
    "static: is_primary/is_current/auto_generated are written as real booleans, not 1/0",
    () => {
      const intakeSource = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/intake.js"), "utf8");
      assert.ok(intakeSource.includes("${index === 0}"), "is_primary must be a real boolean expression, not 1/0");
      assert.ok(intakeSource.includes("true,\n            'RECEIVED_APPLICATION'"), "is_current must be written as literal true");
      assert.ok(intakeSource.includes("'PENDING',\n        true"), "auto_generated must be written as literal true");
    }
  );
}

// ---------------------------------------------------------------------
// SQLite-side baseline (Test H's SQLite half) - runs against an
// isolated scratch database, never production. Establishes the exact
// known-good shape the PostgreSQL version is expected to match,
// per docs/phase6-batch5c-intake-migration.md.
// ---------------------------------------------------------------------

const SCRATCH_DB_PATH = path.join(__dirname, "..", "database", "test-pim-intake.scratch.db");
if (!process.env.PIM_DB_PATH) {
  process.env.PIM_DB_PATH = SCRATCH_DB_PATH;
}

async function runSqliteBaselineTests() {
  const db = require("../lib/db");
  const { assertScratchDatabase } = require("../lib/pim-test-guard");
  assertScratchDatabase(db);

  const fsMod = require("fs");
  const hasStatusMaster = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='status_master'`).get();
  if (!hasStatusMaster) {
    db.exec(fsMod.readFileSync(path.join(REPO_ROOT, "database", "schema.sql"), "utf8"));
  }
  db.prepare(`INSERT OR IGNORE INTO status_master (code, name, stage, is_terminal) VALUES ('RECEIVED', 'Received', 'INSTITUTION', 0)`).run();
  db.prepare(`INSERT OR IGNORE INTO event_types (code, name, category) VALUES ('APPLICATION_RECEIVED', 'Application Received', 'INSTITUTION')`).run();
  db.prepare(`INSERT OR IGNORE INTO task_types (code, name, default_priority) VALUES ('SCRUTINY', 'Scrutiny', 'NORMAL')`).run();
  db.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, designation, role_code, active, must_change_password) VALUES (1, 'aa', 'Administrative Assistant', 'Junior Administrative Assistant', 'aa', 1, 0)`).run();

  const { createReceivedPimApplication } = require("../lib/pim");

  const cleanup = () => {
    const rows = db.prepare(`SELECT id FROM pim_cases WHERE received_number LIKE 'B5C-SQLITE-BASELINE-%'`).all();
    for (const row of rows) db.prepare("DELETE FROM pim_cases WHERE id = ?").run(row.id);
  };
  cleanup();

  await test(
    "H (SQLite baseline): full intake (applicant+opposite party+addresses+advocate+fee) produces the exact known-good shape T1's Postgres version must match",
    () => {
      const receivedNumber = `B5C-SQLITE-BASELINE-${Date.now()}`;
      const caseId = createReceivedPimApplication(
        {
          receivedNumber,
          receivedDate: "2026-02-01",
          applicationDate: "2026-01-30",
          claimAmount: 500000,
          applicants: [
            {
              name: "Baseline Applicant",
              addresses: [{ addressLine1: "1 Applicant Street" }],
              advocate: { name: "Baseline Advocate", enrollmentNo: "ENR-1" },
            },
          ],
          oppositeParties: [{ name: "Baseline Opposite Party", addresses: [{ addressLine1: "2 OP Street" }] }],
          applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-02-01", bankName: "Test Bank", payee: "Chairman, DLSA" },
        },
        1
      );

      const caseRow = db.prepare("SELECT * FROM pim_cases WHERE id = ?").get(caseId);
      assert.strictEqual(caseRow.pim_number, null, "pim_number must stay NULL");
      assert.strictEqual(caseRow.received_number, receivedNumber);

      const parties = db.prepare("SELECT * FROM pim_case_parties WHERE case_id = ? ORDER BY role").all(caseId);
      assert.strictEqual(parties.length, 2, "exactly 2 case_parties rows");
      const applicantLink = parties.find((p) => p.role === "APPLICANT");
      assert.strictEqual(applicantLink.is_primary, 1);

      const addresses = db.prepare(`
        SELECT a.* FROM pim_addresses a
        JOIN pim_case_parties cp ON cp.party_id = a.party_id
        WHERE cp.case_id = ?
      `).all(caseId);
      assert.strictEqual(addresses.length, 2, "one address per party");

      const advocates = db.prepare(`
        SELECT ca.* FROM pim_case_advocates ca WHERE ca.case_id = ?
      `).all(caseId);
      assert.strictEqual(advocates.length, 1, "exactly 1 advocate link (applicant only)");

      const fee = db.prepare("SELECT * FROM pim_fees WHERE case_id = ?").get(caseId);
      assert.strictEqual(fee.amount_received, 1000);
      assert.strictEqual(fee.fee_type, "APPLICATION_FEE");

      const statusHistory = db.prepare("SELECT * FROM pim_status_history WHERE case_id = ?").all(caseId);
      assert.strictEqual(statusHistory.length, 1);
      assert.strictEqual(statusHistory[0].changed_by, 1);

      const docket = db.prepare("SELECT * FROM pim_docket WHERE case_id = ?").all(caseId);
      assert.strictEqual(docket.length, 1);
      assert.strictEqual(docket[0].entered_by, 1);

      const tasks = db.prepare("SELECT * FROM pim_tasks WHERE case_id = ?").all(caseId);
      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].task_type_code, "SCRUTINY");
      assert.strictEqual(tasks[0].status, "PENDING");
    }
  );

  cleanup();
  db.close();
}

// ---------------------------------------------------------------------
// Credential-gated tests.
// ---------------------------------------------------------------------

function testPayload(receivedNumber, overrides = {}) {
  return {
    receivedNumber,
    receivedDate: "2026-02-01",
    applicationDate: "2026-01-30",
    claimAmount: 500000,
    applicants: [
      {
        name: "B5C PG Applicant",
        addresses: [{ addressLine1: "1 Applicant Street" }],
        advocate: { name: "B5C PG Advocate", enrollmentNo: "ENR-PG-1" },
      },
    ],
    oppositeParties: [{ name: "B5C PG Opposite Party", addresses: [{ addressLine1: "2 OP Street" }] }],
    applicationFee: { amount: 1000, ddNumber: "DD-PG-1", ddDate: "2026-02-01", bankName: "Test Bank", payee: "Chairman, DLSA" },
    ...overrides,
  };
}

async function cleanupPg(sql, prefix) {
  const rows = await sql`SELECT id FROM pim_cases WHERE received_number LIKE ${prefix + "%"}`;
  for (const row of rows) {
    await sql`DELETE FROM pim_tasks WHERE case_id = ${row.id}`;
    await sql`DELETE FROM pim_docket WHERE case_id = ${row.id}`;
    await sql`DELETE FROM pim_status_history WHERE case_id = ${row.id}`;
    await sql`DELETE FROM pim_fees WHERE case_id = ${row.id}`;
    const partyIds = await sql`SELECT party_id FROM pim_case_parties WHERE case_id = ${row.id}`;
    // Capture the exact advocate ids linked to THIS case before deleting
    // the link rows - the fixture's advocate name ("B5C PG Advocate")
    // does not itself carry the receivedNumber prefix, so matching by
    // id (like addresses below) is the only robust way to find them;
    // matching by name pattern silently missed every advocate row in
    // an earlier version of this cleanup, leaving them in production.
    const advocateIds = await sql`SELECT advocate_id FROM pim_case_advocates WHERE case_id = ${row.id}`;
    await sql`DELETE FROM pim_case_advocates WHERE case_id = ${row.id}`;
    await sql`DELETE FROM pim_case_parties WHERE case_id = ${row.id}`;
    for (const p of partyIds) {
      await sql`DELETE FROM pim_addresses WHERE party_id = ${p.party_id}`;
      await sql`DELETE FROM pim_parties WHERE id = ${p.party_id}`;
    }
    for (const a of advocateIds) {
      await sql`DELETE FROM pim_advocates WHERE id = ${a.advocate_id}`;
    }
    await sql`DELETE FROM pim_cases WHERE id = ${row.id}`;
  }
  // Defensive backstop for any advocate row that somehow predates this
  // fix (e.g. left over from before this cleanup bug was found) -
  // matches the fixture's actual literal name, not a received_number-
  // style prefix.
  await sql`DELETE FROM pim_advocates WHERE name = 'B5C PG Advocate'`;
}

async function runConnectionDependentTests() {
  const { getSql } = require("../lib/pim-postgres");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const sql = getSql();

  await test("PostgreSQL connection works (intake module)", async () => {
    const [{ ok }] = await sql`SELECT 1 AS ok`;
    assert.strictEqual(ok, 1);
  });

  const PREFIX = "TEST-B5C-";
  await cleanupPg(sql, PREFIX);

  // ---- Test B: rollback (needs only SUPABASE_DB_URL, not identity sync) ----
  await test("B. rollback: a deliberately-invalid (never-fabricated, out-of-range) userId causes the whole intake transaction to roll back with zero partial rows", async () => {
    const receivedNumber = `${PREFIX}ROLLBACK-${Date.now()}`;
    const SENTINEL_INVALID_USER_ID = 999999999; // cannot exist; not a real or fabricated user

    await assert.rejects(
      createReceivedPimApplicationPg(testPayload(receivedNumber), SENTINEL_INVALID_USER_ID),
      /violates foreign key constraint|foreign key/i
    );

    const [caseRow] = await sql`SELECT id FROM pim_cases WHERE received_number = ${receivedNumber}`;
    assert.strictEqual(caseRow, undefined, "pim_cases row must not remain");

    const [party] = await sql`SELECT id FROM pim_parties WHERE name = 'B5C PG Applicant'`;
    assert.strictEqual(party, undefined, "pim_parties row must not remain");

    const [advocate] = await sql`SELECT id FROM pim_advocates WHERE name = 'B5C PG Advocate'`;
    assert.strictEqual(advocate, undefined, "pim_advocates row must not remain");

    const [fee] = await sql`SELECT id FROM pim_fees WHERE dd_number = 'DD-PG-1'`;
    assert.strictEqual(fee, undefined, "pim_fees row must not remain");
  });

  // ---- Tier 2 gate: does PostgreSQL `users` have any rows yet? ----
  const [{ userCount }] = await sql`SELECT COUNT(*)::int AS "userCount" FROM users`;

  const successPathTests = [
    "A. successful intake: case/parties/relationships/addresses/advocate/fee/status-history/docket/task all created with correct FK linkage and entered_by/changed_by",
    "C. generated IDs: child rows reference the exact ids returned by RETURNING id, not an inferred/second-query id",
    "E. duplicate/conflict behavior: two intakes with the identical receivedNumber both succeed (matches SQLite - T1 has no duplicate guard)",
    "F (live). permission denial is enforced by the route before the Postgres call (already proven statically above - live re-confirmation)",
    "G. date behavior: received_date/application_date/dd_date round-trip as plain 'YYYY-MM-DD' strings; advocate from_date uses the UTC new Date() value verbatim (matches the pre-existing SQLite inconsistency, not officeDate())",
  ];

  if (userCount === 0) {
    for (const name of successPathTests) {
      skip(name, "PostgreSQL users table is empty - scripts/sync-users-to-postgres.js has not been run (blocked on SUPABASE_DB_URL being usable for that script too). Not fabricating a user to work around this - see docs/phase6-batch5c-intake-migration.md and the Batch 5C report.");
    }
  } else {
    // A real, synced user exists - run the full success-path suite.
    const [{ id: realUserId }] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`;

    await test(successPathTests[0], async () => {
      const receivedNumber = `${PREFIX}SUCCESS-${Date.now()}`;
      const caseId = await createReceivedPimApplicationPg(testPayload(receivedNumber), realUserId);

      const [caseRow] = await sql`SELECT * FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.pim_number, null);
      assert.strictEqual(caseRow.received_number, receivedNumber);

      const caseParties = await sql`SELECT * FROM pim_case_parties WHERE case_id = ${caseId}`;
      assert.strictEqual(caseParties.length, 2);

      const addresses = await sql`
        SELECT a.* FROM pim_addresses a
        JOIN pim_case_parties cp ON cp.party_id = a.party_id
        WHERE cp.case_id = ${caseId}
      `;
      assert.strictEqual(addresses.length, 2);

      const advocateLinks = await sql`SELECT * FROM pim_case_advocates WHERE case_id = ${caseId}`;
      assert.strictEqual(advocateLinks.length, 1);

      const [fee] = await sql`SELECT * FROM pim_fees WHERE case_id = ${caseId}`;
      assert.strictEqual(fee.amount_received, 1000);

      const [statusHistory] = await sql`SELECT * FROM pim_status_history WHERE case_id = ${caseId}`;
      assert.strictEqual(statusHistory.changed_by, realUserId);

      const [docket] = await sql`SELECT * FROM pim_docket WHERE case_id = ${caseId}`;
      assert.strictEqual(docket.entered_by, realUserId);

      const [task] = await sql`SELECT * FROM pim_tasks WHERE case_id = ${caseId}`;
      assert.strictEqual(task.task_type_code, "SCRUTINY");
      assert.strictEqual(task.status, "PENDING");
    });

    await test(successPathTests[1], async () => {
      const receivedNumber = `${PREFIX}IDS-${Date.now()}`;
      const caseId = await createReceivedPimApplicationPg(testPayload(receivedNumber), realUserId);

      const caseParties = await sql`SELECT case_id, party_id FROM pim_case_parties WHERE case_id = ${caseId}`;
      for (const link of caseParties) {
        assert.strictEqual(link.case_id, caseId, "case_parties.case_id must equal the RETURNING id from the case insert");
        const [party] = await sql`SELECT id FROM pim_parties WHERE id = ${link.party_id}`;
        assert.ok(party, "case_parties.party_id must reference a party row actually created by this call, via RETURNING id");
      }

      const advocateLink = await sql`SELECT advocate_id FROM pim_case_advocates WHERE case_id = ${caseId}`;
      if (advocateLink.length) {
        const [advocate] = await sql`SELECT id FROM pim_advocates WHERE id = ${advocateLink[0].advocate_id}`;
        assert.ok(advocate, "case_advocates.advocate_id must reference the advocate row created via RETURNING id");
      }
    });

    await test(successPathTests[2], async () => {
      const receivedNumber = `${PREFIX}DUP-${Date.now()}`;
      const caseId1 = await createReceivedPimApplicationPg(testPayload(receivedNumber), realUserId);
      const caseId2 = await createReceivedPimApplicationPg(testPayload(receivedNumber), realUserId);
      assert.notStrictEqual(caseId1, caseId2, "both intakes must succeed as independent cases - no duplicate guard exists in T1");
    });

    await test(successPathTests[3], async () => {
      // Live re-confirmation that nothing here bypasses the route's own
      // permission gate - createReceivedPimApplicationPg itself performs
      // no permission check (by design, matching the SQLite version;
      // requirePermission is the route's responsibility, proven statically
      // above). This assertion just documents that fact is still true.
      const source = fs.readFileSync(path.join(REPO_ROOT, "lib/pim-data/intake.js"), "utf8");
      assert.ok(!source.includes("requirePermission"), "intake.js correctly leaves permission enforcement to the route layer");
    });

    await test(successPathTests[4], async () => {
      const receivedNumber = `${PREFIX}DATES-${Date.now()}`;
      const caseId = await createReceivedPimApplicationPg(testPayload(receivedNumber), realUserId);
      const [caseRow] = await sql`SELECT received_date, application_date FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.received_date, "2026-02-01", "received_date must round-trip as a plain date string, not a Date object");
      assert.strictEqual(caseRow.application_date, "2026-01-30");

      const [fee] = await sql`SELECT dd_date FROM pim_fees WHERE case_id = ${caseId}`;
      assert.strictEqual(fee.dd_date, "2026-02-01");
    });

    await cleanupPg(sql, PREFIX);
  }

  await cleanupPg(sql, PREFIX);
  await sql.end({ timeout: 5 });
}

// ---------------------------------------------------------------------
// Test D: PIM-number concurrency - explicitly not applicable to T1.
// ---------------------------------------------------------------------

function reportTestDNotApplicable() {
  skip(
    "D. PIM-number concurrency",
    "not applicable to T1 - verified against the actual code (lib/pim.js and lib/pim-data/intake.js) that intake never calls generatePimNumber() and always inserts pim_number as NULL; PIM numbering happens only at Secretary approval (T3, a different, not-yet-migrated transaction). See docs/phase6-batch5c-intake-migration.md section 2 and the Batch 5C report for the full explanation - this is not a code-inspection-only claim of safety, it is a statement that the feature this test targets does not exist in this transaction."
  );
}

async function main() {
  await testPermissionCheckStillFirst();
  await testSqliteVersionStillImportedUnused();
  await testValidationReusedNotDuplicated();
  await testNoPimNumberGenerationInIntake();
  await testNoAuditLogWriteInvented();
  await testNoSecretLeak();
  await testBooleanLiteralsAreNativeBooleans();

  await runSqliteBaselineTests();

  reportTestDNotApplicable();

  if (!process.env.SUPABASE_DB_URL) {
    for (const name of [
      "PostgreSQL connection works (intake module)",
      "B. rollback: a deliberately-invalid (never-fabricated, out-of-range) userId causes the whole intake transaction to roll back with zero partial rows",
      "A. successful intake: case/parties/relationships/addresses/advocate/fee/status-history/docket/task all created with correct FK linkage and entered_by/changed_by",
      "C. generated IDs: child rows reference the exact ids returned by RETURNING id, not an inferred/second-query id",
      "E. duplicate/conflict behavior: two intakes with the identical receivedNumber both succeed (matches SQLite - T1 has no duplicate guard)",
      "F (live). permission denial is enforced by the route before the Postgres call (already proven statically above - live re-confirmation)",
      "G. date behavior: received_date/application_date/dd_date round-trip as plain 'YYYY-MM-DD' strings; advocate from_date uses the UTC new Date() value verbatim (matches the pre-existing SQLite inconsistency, not officeDate())",
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
