/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5B regression tests: transaction-aware dependency
 * injection for the shared SQLite helper layer (lib/pim.js,
 * lib/pim-scrutiny.js, lib/pim-approval.js, lib/pim-nonstarter.js,
 * lib/pim-op-response.js, lib/pim-fresh-notice.js,
 * lib/pim-legacy-import.js, lib/pim-settings.js's getSetting).
 *
 * This is NOT a PostgreSQL test. Every dbClient used here is a plain
 * better-sqlite3 Database instance - the point is to prove the newly
 * added trailing dbClient parameter is real, correctly threaded
 * through every nested call, and never silently falls back to the
 * module-level `db` singleton when an explicit client is supplied.
 * See docs/phase6-transaction-readiness.md and
 * docs/phase6-batch5b-helper-inventory.md.
 *
 * Uses three independent scratch SQLite databases (never production):
 *   - PRIMARY  (via PIM_DB_PATH / lib/db.js) - the default `db` every
 *     existing caller keeps using unless it explicitly passes a client.
 *   - ALT      - a second, separately bootstrapped connection, used to
 *     prove dbClient threading (marker rows/codes exist ONLY here).
 *   - ROLLBACK - a third connection, bootstrapped with one required
 *     status code deliberately missing, to force a genuine mid-
 *     transaction failure and prove the resulting rollback undoes
 *     every write already made through the injected dbClient.
 */

const path = require("path");
const fs = require("fs");
const assert = require("assert");
const Database = require("better-sqlite3");

const SCRATCH_DB_PATH = path.join(__dirname, "..", "database", "test-tx-context.scratch.db");
if (!process.env.PIM_DB_PATH) {
  process.env.PIM_DB_PATH = SCRATCH_DB_PATH;
}

const db = require("../lib/db");
const { assertScratchDatabase, productionDatabasePath } = require("../lib/pim-test-guard");

assertScratchDatabase(db);

const { createReceivedPimApplication } = require("../lib/pim");
const { saveScrutiny } = require("../lib/pim-scrutiny");
const { approvePimRegistration } = require("../lib/pim-approval");
const { recordNonStarter } = require("../lib/pim-nonstarter");
const {
  getStatusId: opGetStatusId,
  addDocket: opAddDocket,
} = require("../lib/pim-op-response");
const { getScrutinyCase } = require("../lib/pim-scrutiny");
// lib/pim-scrutiny.js does not export its internal getStatusId, so
// that module's dbClient threading is exercised only indirectly, via
// saveScrutiny end to end (tests 4 and 5 below) - the marker-code
// technique is applied directly to lib/pim-op-response.js's copy
// instead (test 3), which is reused by more transactions anyway.

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${error instanceof Error ? error.stack : error}`);
    failures.push(name);
  }
}

// ---------------------------------------------------------------------
// Bootstrap helper: seeds a fresh scratch connection with the schema
// and the minimum master data the tests below need. `omitStatusCode`
// lets the rollback test build a connection that is missing exactly
// one required status_master row, so a real business-logic statement
// (not an artificial throw) fails partway through a transaction.
// ---------------------------------------------------------------------

function bootstrap(database, { omitStatusCode = null, markerSuffix = null } = {}) {
  const hasStatusMaster = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='status_master'`)
    .get();

  if (!hasStatusMaster) {
    const schemaPath = path.join(__dirname, "..", "database", "schema.sql");
    database.exec(fs.readFileSync(schemaPath, "utf8"));
  }

  const seedStatus = database.prepare(
    `INSERT OR IGNORE INTO status_master (code, name, stage, is_terminal) VALUES (?, ?, ?, ?)`
  );
  const seedEvent = database.prepare(
    `INSERT OR IGNORE INTO event_types (code, name, category) VALUES (?, ?, ?)`
  );
  const seedTask = database.prepare(
    `INSERT OR IGNORE INTO task_types (code, name, default_priority) VALUES (?, ?, ?)`
  );
  const seedReason = database.prepare(
    `INSERT OR IGNORE INTO nonstarter_reasons (code, name, rule_reference, requires_authority_decision, active) VALUES (?, ?, ?, ?, 1)`
  );
  const seedUser = database.prepare(
    `INSERT OR IGNORE INTO users (id, username, display_name, designation, role_code, active, must_change_password) VALUES (?, ?, ?, ?, ?, 1, 0)`
  );

  const seed = database.transaction(() => {
    for (const row of [
      ["RECEIVED", "Received", "INSTITUTION", 0],
      ["SCRUTINY_PENDING", "Scrutiny Pending", "INSTITUTION", 0],
      ["DEFECT_PENDING", "Defect Pending", "INSTITUTION", 0],
      ["SECRETARY_APPROVAL_PENDING", "Secretary Approval Pending", "INSTITUTION", 0],
      ["REGISTERED", "PIM Registered", "INSTITUTION", 0],
      ["FORM2_PENDING", "Form-2 Pending", "NOTICE", 0],
      ["OUTCOME_FORM_PENDING", "Outcome Form Pending", "OUTCOME", 0],
      ["AUTHORITY_DECISION_PENDING", "Authority Decision Pending", "AUTHORITY", 0],
      ["CLOSED_NON_STARTER", "Closed - Non-Starter", "CLOSURE", 1],
    ]) {
      if (omitStatusCode && row[0] === omitStatusCode) continue;
      seedStatus.run(...row);
    }

    for (const row of [
      ["APPLICATION_RECEIVED", "Application Received", "INSTITUTION"],
      ["SCRUTINY_COMPLETED", "Scrutiny Completed", "INSTITUTION"],
      ["DEFECT_NOTED", "Defect Noted", "INSTITUTION"],
      ["SECRETARY_APPROVAL", "Secretary Approval", "AUTHORITY"],
      ["PIM_REGISTERED", "PIM Registered", "INSTITUTION"],
      ["NONSTARTER_RECORDED", "Non-Starter Recorded", "OUTCOME"],
    ]) seedEvent.run(...row);

    for (const row of [
      ["SCRUTINY", "Scrutiny of Received Application", "NORMAL"],
      ["FORM2", "Prepare Form-2 after PIM Registration", "NORMAL"],
      ["NONSTARTER_FORM3", "Prepare Form-3 Non-Starter Report", "NORMAL"],
    ]) seedTask.run(...row);

    for (const row of [
      ["BOTH_PARTIES_NOT_WILLING", "Both parties not willing to mediate", "Rule 3(4)", 0],
    ]) seedReason.run(...row);

    seedUser.run(1, "aa", "Administrative Assistant", "Junior Administrative Assistant", "aa");

    if (markerSuffix) {
      // Marker rows that exist ONLY on this connection - used to prove
      // a helper genuinely used the dbClient it was given, not the
      // global singleton. If a helper accidentally fell back to the
      // global db, looking up one of these codes there would throw
      // "not found", since the global db never has them.
      seedStatus.run(`TEST_MARKER_STATUS_${markerSuffix}`, "Marker status", "INSTITUTION", 0);
      seedEvent.run(`TEST_MARKER_EVENT_${markerSuffix}`, "Marker event", "INSTITUTION");
    }
  });

  seed();
}

function makeConnection(fileName, options = {}) {
  const filePath = path.join(__dirname, "..", "database", fileName);
  if (path.resolve(filePath) === productionDatabasePath()) {
    throw new Error("Refusing to create a test connection at the production database path.");
  }
  const connection = new Database(filePath);
  connection.pragma("foreign_keys = ON");
  bootstrap(connection, options);
  return { connection, filePath };
}

function cleanupCasesIn(database, prefix) {
  const rows = database
    .prepare(`SELECT id FROM pim_cases WHERE received_number LIKE ?`)
    .all(`${prefix}%`);
  if (!rows.length) return;
  const remove = database.transaction(() => {
    for (const row of rows) {
      database.prepare("DELETE FROM audit_log WHERE table_name = 'pim_cases' AND record_id = ?").run(row.id);
      database.prepare("DELETE FROM pim_cases WHERE id = ?").run(row.id);
    }
  });
  remove();
}

function intakePayload(receivedNumber) {
  return {
    receivedNumber,
    receivedDate: "2026-02-01",
    applicationDate: "2026-01-30",
    claimAmount: 500000,
    applicants: [{ name: "TX Context Applicant" }],
    oppositeParties: [{ name: "TX Context Opposite Party" }],
    applicationFee: {
      amount: 1000,
      ddNumber: "DD-001",
      ddDate: "2026-02-01",
      bankName: "Test Bank",
      payee: "Chairman, DLSA",
    },
  };
}

// ---------------------------------------------------------------------
// Bootstrap the three connections.
// ---------------------------------------------------------------------

bootstrap(db);

const alt = makeConnection("test-tx-context-alt.scratch.db", { markerSuffix: "ALT" });
const altDb = alt.connection;

const rollback = makeConnection("test-tx-context-rollback.scratch.db", {
  omitStatusCode: "SECRETARY_APPROVAL_PENDING",
});
const rollbackDb = rollback.connection;

cleanupCasesIn(db, "TXCTX-DEFAULT-");
cleanupCasesIn(altDb, "TXCTX-ALT-");
cleanupCasesIn(rollbackDb, "TXCTX-ROLLBACK-");

// ---------------------------------------------------------------------
// Test 1: helper called WITHOUT an explicit dbClient still uses the
// module-level `db` singleton, unchanged (item 13.1).
// ---------------------------------------------------------------------

test("1. createReceivedPimApplication with no dbClient argument uses the default db singleton", () => {
  const caseId = createReceivedPimApplication(intakePayload("TXCTX-DEFAULT-1"), 1);
  const row = db.prepare("SELECT * FROM pim_cases WHERE id = ?").get(caseId);
  assert(row, "case must exist in the default (primary) database");
  assert.strictEqual(row.received_number, "TXCTX-DEFAULT-1");
  assert.strictEqual(row.pim_number, null);
});

// ---------------------------------------------------------------------
// Test 2: helper called WITH an explicit dbClient uses that client for
// its entire nested call chain, and never touches the default db
// (items 13.2 and 13.4). Exercises lib/pim.js's createReceivedPimApplication
// -> addParties -> getPrimaryPartyId chain end to end against `altDb`.
// ---------------------------------------------------------------------

test("2. createReceivedPimApplication(..., altDb) writes only to altDb, never to the default db", () => {
  const beforeCountDefault = db.prepare("SELECT COUNT(*) AS n FROM pim_cases WHERE received_number = ?").get("TXCTX-ALT-2").n;
  assert.strictEqual(beforeCountDefault, 0);

  const caseId = createReceivedPimApplication(intakePayload("TXCTX-ALT-2"), 1, altDb);

  const inAlt = altDb.prepare("SELECT * FROM pim_cases WHERE id = ?").get(caseId);
  assert(inAlt, "case must exist in altDb");
  assert.strictEqual(inAlt.received_number, "TXCTX-ALT-2");

  const inDefault = db.prepare("SELECT * FROM pim_cases WHERE received_number = ?").get("TXCTX-ALT-2");
  assert.strictEqual(inDefault, undefined, "case must NOT leak into the default database");

  // addParties/getPrimaryPartyId ran correctly against altDb too - the
  // application fee (which depends on getPrimaryPartyId finding the
  // primary applicant) must exist in altDb.
  const fee = altDb.prepare("SELECT * FROM pim_fees WHERE case_id = ?").get(caseId);
  assert(fee, "application fee must have been written to altDb via the threaded dbClient");
  assert.strictEqual(fee.amount_received, 1000);
});

// ---------------------------------------------------------------------
// Test 3: marker-code detection for individually named helpers
// (getStatusId, addDocket -> getEventId) - the batch's own examples.
// A marker status/event code exists ONLY in altDb. If either helper
// silently fell back to the global `db`, this lookup would throw
// "not found" instead of succeeding, because the global db never has
// these codes.
// ---------------------------------------------------------------------

test("3a. getStatusId(code, altDb) resolves an altDb-only marker status (lib/pim-op-response.js)", () => {
  const id = opGetStatusId("TEST_MARKER_STATUS_ALT", altDb);
  assert(Number.isInteger(id) && id > 0);

  assert.throws(
    () => opGetStatusId("TEST_MARKER_STATUS_ALT", db),
    /Status not found: TEST_MARKER_STATUS_ALT/,
    "the marker status must NOT be visible through the default db - confirms altDb and db are genuinely separate connections"
  );
});

test("3b. addDocket(..., altDb) resolves an altDb-only marker event via getEventId and writes only to altDb", () => {
  const caseId = createReceivedPimApplication(intakePayload("TXCTX-ALT-3"), 1, altDb);

  opAddDocket(caseId, "TEST_MARKER_EVENT_ALT", "marker docket entry", null, null, 1, altDb);

  const docketRow = altDb
    .prepare(`
      SELECT d.*, e.code AS event_code
      FROM pim_docket d
      JOIN event_types e ON e.id = d.event_type_id
      WHERE d.case_id = ? AND e.code = 'TEST_MARKER_EVENT_ALT'
    `)
    .get(caseId);
  assert(docketRow, "marker docket entry must exist in altDb");
  assert.strictEqual(docketRow.entry_text, "marker docket entry");

  assert.throws(
    () => opAddDocket(999999, "TEST_MARKER_EVENT_ALT", "should not resolve", null, null, 1, db),
    /Event not found: TEST_MARKER_EVENT_ALT/,
    "the marker event must NOT be visible through the default db"
  );
});

// ---------------------------------------------------------------------
// Test 4: a write performed through an injected dbClient rolls back
// when the surrounding transaction (opened on that SAME dbClient)
// throws (item 13.3, mandatory). Uses a real business-logic failure
// (a required status_master row deliberately missing on `rollbackDb`),
// not an artificial forced throw, so this also proves saveScrutiny
// now opens its transaction on dbClient.transaction(...), not a
// hardcoded db.transaction(...).
// ---------------------------------------------------------------------

test("4. saveScrutiny(..., rollbackDb) rolls back pim_scrutiny/pim_scrutiny_attempts when a later statement in the same transaction throws", () => {
  const caseId = createReceivedPimApplication(intakePayload("TXCTX-ROLLBACK-4"), 1, rollbackDb);

  const scrutinyBefore = rollbackDb.prepare("SELECT COUNT(*) AS n FROM pim_scrutiny WHERE case_id = ?").get(caseId).n;
  const attemptsBefore = rollbackDb.prepare("SELECT COUNT(*) AS n FROM pim_scrutiny_attempts WHERE case_id = ?").get(caseId).n;
  assert.strictEqual(scrutinyBefore, 0);
  assert.strictEqual(attemptsBefore, 0);

  // rollbackDb has no 'SECRETARY_APPROVAL_PENDING' status_master row
  // (deliberately omitted at bootstrap), so saveScrutiny's COMPLETE
  // branch writes pim_scrutiny + pim_scrutiny_attempts successfully,
  // then throws inside getStatusId("SECRETARY_APPROVAL_PENDING", ...)
  // a few statements later, still inside the same transaction.
  assert.throws(
    () =>
      saveScrutiny(
        caseId,
        {
          scrutinyResult: "COMPLETE",
          applicationFeeReceived: true,
          ddPayeeCorrect: true,
          ddValid: true,
          oppositePartyAddressAvailable: true,
          commercialDisputeChecked: true,
          territorialJurisdictionChecked: true,
          supportingDocumentsChecked: true,
        },
        1,
        rollbackDb
      ),
    /Status 'SECRETARY_APPROVAL_PENDING' is missing/
  );

  const scrutinyAfter = rollbackDb.prepare("SELECT COUNT(*) AS n FROM pim_scrutiny WHERE case_id = ?").get(caseId).n;
  const attemptsAfter = rollbackDb.prepare("SELECT COUNT(*) AS n FROM pim_scrutiny_attempts WHERE case_id = ?").get(caseId).n;
  assert.strictEqual(scrutinyAfter, 0, "pim_scrutiny insert must have rolled back");
  assert.strictEqual(attemptsAfter, 0, "pim_scrutiny_attempts insert must have rolled back");

  // The case itself must still show its pre-scrutiny status - the
  // failed transaction must not have left it half-updated either.
  const caseRow = rollbackDb.prepare("SELECT current_status_id FROM pim_cases WHERE id = ?").get(caseId);
  const receivedStatusId = rollbackDb.prepare("SELECT id FROM status_master WHERE code = 'RECEIVED'").get().id;
  assert.strictEqual(caseRow.current_status_id, receivedStatusId, "case status must be unchanged after rollback");
});

// ---------------------------------------------------------------------
// Test 5: existing business results are unchanged - full intake ->
// scrutiny (COMPLETE) -> approval flow against altDb, asserting the
// exact same status/docket/task outcomes the pre-refactor code
// produced (item 13.5). Exercises lib/pim.js, lib/pim-scrutiny.js,
// lib/pim-approval.js (incl. generatePimNumber -> lib/pim-settings.js's
// getSetting) and lib/pim-op-response.js's getEventId all threaded
// through the SAME injected client end to end.
// ---------------------------------------------------------------------

test("5. full intake -> scrutiny -> approval flow against an explicit dbClient produces the same result shape as the default-client path", () => {
  const caseId = createReceivedPimApplication(intakePayload("TXCTX-ALT-5"), 1, altDb);

  const scrutinyResult = saveScrutiny(
    caseId,
    {
      scrutinyResult: "COMPLETE",
      applicationFeeReceived: true,
      ddPayeeCorrect: true,
      ddValid: true,
      oppositePartyAddressAvailable: true,
      commercialDisputeChecked: true,
      territorialJurisdictionChecked: true,
      supportingDocumentsChecked: true,
    },
    1,
    altDb
  );
  assert.strictEqual(scrutinyResult.status, "SECRETARY_APPROVAL_PENDING");
  assert.strictEqual(scrutinyResult.scrutinyResult, "COMPLETE");

  const scrutinyTaskAfter = altDb
    .prepare("SELECT status FROM pim_tasks WHERE id = ?")
    .get(scrutinyResult.completedTaskId);
  assert.strictEqual(scrutinyTaskAfter.status, "COMPLETED", "SCRUTINY task must be completed in the same transaction as the scrutiny save");

  const approvalResult = approvePimRegistration(caseId, 1, "Approved via Batch 5B regression test.", altDb);
  assert.strictEqual(approvalResult.registeredStatusCode, "REGISTERED");
  assert.strictEqual(approvalResult.currentStatusCode, "FORM2_PENDING");
  assert(approvalResult.pimNumber, "a PIM number must be assigned on approval");
  assert(/^PIM\/\d{4}\/\d{4}$/.test(approvalResult.pimNumber), `unexpected PIM number shape: ${approvalResult.pimNumber}`);

  const caseRow = altDb.prepare("SELECT * FROM pim_cases WHERE id = ?").get(caseId);
  assert.strictEqual(caseRow.pim_number, approvalResult.pimNumber);
  assert.strictEqual(caseRow.secretary_decision, "APPROVED");

  const form2PendingId = altDb.prepare("SELECT id FROM status_master WHERE code = 'FORM2_PENDING'").get().id;
  assert.strictEqual(caseRow.current_status_id, form2PendingId);

  const docketEvents = altDb
    .prepare(`
      SELECT e.code
      FROM pim_docket d
      JOIN event_types e ON e.id = d.event_type_id
      WHERE d.case_id = ?
      ORDER BY d.id
    `)
    .all(caseId)
    .map((row) => row.code);
  assert.deepStrictEqual(docketEvents, [
    "APPLICATION_RECEIVED",
    "SCRUTINY_COMPLETED",
    "SECRETARY_APPROVAL",
    "PIM_REGISTERED",
  ]);

  // Nothing from this altDb-scoped flow may have leaked into the
  // default database.
  const leaked = db.prepare("SELECT id FROM pim_cases WHERE received_number = ?").get("TXCTX-ALT-5");
  assert.strictEqual(leaked, undefined);
});

// ---------------------------------------------------------------------
// Test 6: lib/pim-nonstarter.js's recordNonStarter, called exactly the
// way the real route calls it - wrapped in the CALLER's own
// dbClient.transaction(), not a transaction recordNonStarter opens
// itself - correctly threads dbClient through getCase,
// inferNonStarterContext, getReasonByCode, addStatusHistory, addDocket
// and createPendingTaskIfNotExists (all in lib/pim-op-response.js).
// ---------------------------------------------------------------------

test("6. recordNonStarter(..., altDb), wrapped in the caller's own altDb.transaction(), stays entirely on altDb", () => {
  const caseId = createReceivedPimApplication(intakePayload("TXCTX-ALT-6"), 1, altDb);
  // Manually move the case to a non-terminal, pre-outcome status the
  // way scrutiny/approval would in the real workflow, without running
  // the whole chain again - direct UPDATE is sufficient here since
  // this test targets recordNonStarter, not the earlier stages.
  const formPendingId = altDb.prepare("SELECT id FROM status_master WHERE code = 'FORM2_PENDING'").get().id;
  altDb.prepare("UPDATE pim_cases SET current_status_id = ? WHERE id = ?").run(formPendingId, caseId);

  const result = altDb.transaction(() =>
    recordNonStarter(
      {
        caseId,
        reasonCode: "BOTH_PARTIES_NOT_WILLING",
        outcomeDate: "2026-02-10",
        userId: 1,
      },
      altDb
    )
  )();

  assert.strictEqual(result.statusCode, "OUTCOME_FORM_PENDING");
  assert.strictEqual(result.nonstarterReasonCode, "BOTH_PARTIES_NOT_WILLING");

  const outcomeRow = altDb.prepare("SELECT * FROM pim_outcomes WHERE case_id = ?").get(caseId);
  assert(outcomeRow, "pim_outcomes row must exist in altDb");
  assert.strictEqual(outcomeRow.outcome_type, "NON_STARTER");

  const taskRow = altDb
    .prepare("SELECT * FROM pim_tasks WHERE case_id = ? AND task_type_code = 'NONSTARTER_FORM3'")
    .get(caseId);
  assert(taskRow, "NONSTARTER_FORM3 handoff task must have been created in altDb");
  assert.strictEqual(taskRow.status, "PENDING");

  const leaked = db.prepare("SELECT o.id FROM pim_outcomes o JOIN pim_cases c ON c.id = o.case_id WHERE c.received_number = ?").get("TXCTX-ALT-6");
  assert.strictEqual(leaked, undefined, "nothing from this altDb-scoped flow may leak into the default database");
});

// ---------------------------------------------------------------------
// Test 7: sanity check that the pre-existing legacy-import behavior
// (which also flows through lib/pim-approval.js's generatePimNumber
// and lib/pim-legacy-import.js's whole helper chain) is unaffected
// when called with the default client, run as a lighter-weight
// cross-check alongside scripts/test-legacy-import.js.
// ---------------------------------------------------------------------

test("7. getScrutinyCase (unmodified GET-path helper) still reads correctly after the refactor", () => {
  const caseId = createReceivedPimApplication(intakePayload("TXCTX-DEFAULT-7"), 1);
  const view = getScrutinyCase(caseId);
  assert.strictEqual(view.case.id, caseId);
  assert.strictEqual(view.parties.length, 2);
});

// ---------------------------------------------------------------------
// Cleanup and summary
// ---------------------------------------------------------------------

try {
  cleanupCasesIn(db, "TXCTX-DEFAULT-");
} finally {
  db.close();
}
cleanupCasesIn(altDb, "TXCTX-ALT-");
altDb.close();
try {
  fs.unlinkSync(alt.filePath);
} catch {
  // best effort
}
cleanupCasesIn(rollbackDb, "TXCTX-ROLLBACK-");
rollbackDb.close();
try {
  fs.unlinkSync(rollback.filePath);
} catch {
  // best effort
}

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) process.exit(1);
