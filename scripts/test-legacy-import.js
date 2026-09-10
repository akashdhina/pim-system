/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");

/*
 * This script mutates whatever database it points at (it inserts and
 * deletes legacy-import test cases). It must never run against
 * production by accident, so unless the caller has explicitly set
 * PIM_DB_PATH, it defaults to a dedicated scratch file and bootstraps
 * the schema/master data there on first use.
 */
const SCRATCH_DB_PATH = path.join(__dirname, "..", "database", "test-legacy-import.scratch.db");
if (!process.env.PIM_DB_PATH) {
  process.env.PIM_DB_PATH = SCRATCH_DB_PATH;
}

const assert = require("assert");
const db = require("../lib/db");
const { assertScratchDatabase } = require("../lib/pim-test-guard");

assertScratchDatabase(db);
bootstrapScratchSchema(db);

const { importLegacyCase } = require("../lib/pim-legacy-import");

function bootstrapScratchSchema(database) {
  const hasStatusMaster = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='status_master'`)
    .get();

  if (!hasStatusMaster) {
    const schemaPath = path.join(__dirname, "..", "database", "schema.sql");
    database.exec(fs.readFileSync(schemaPath, "utf8"));
  }

  const seedStatus = database.prepare(`INSERT OR IGNORE INTO status_master (code, name, stage, is_terminal) VALUES (?, ?, ?, ?)`);
  const seedEvent = database.prepare(`INSERT OR IGNORE INTO event_types (code, name, category) VALUES (?, ?, ?)`);
  const seedTask = database.prepare(`INSERT OR IGNORE INTO task_types (code, name, default_priority) VALUES (?, ?, ?)`);
  const seedReason = database.prepare(`INSERT OR IGNORE INTO nonstarter_reasons (code, name, rule_reference, requires_authority_decision, active) VALUES (?, ?, ?, ?, 1)`);
  const seedUser = database.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, designation, role_code, active, must_change_password) VALUES (?, ?, ?, ?, ?, 1, 0)`);

  const seed = database.transaction(() => {
    for (const row of [
      ["RECEIVED", "Received", "INSTITUTION", 0],
      ["SCRUTINY_PENDING", "Scrutiny Pending", "INSTITUTION", 0],
      ["SECRETARY_APPROVAL_PENDING", "Secretary Approval Pending", "INSTITUTION", 0],
      ["REGISTERED", "PIM Registered", "INSTITUTION", 0],
      ["FORM2_PENDING", "Form-2 Pending", "NOTICE", 0],
      ["SERVICE_PENDING", "Service Pending", "NOTICE", 0],
      ["FEE_PENDING", "Mediation Fee Pending", "FEE", 0],
      ["MEDIATOR_ASSIGNMENT_PENDING", "Mediator Assignment Pending", "MEDIATOR", 0],
      ["MEDIATOR_ASSIGNED", "Mediator Assigned", "MEDIATOR", 0],
      ["MEDIATION_PENDING", "First Mediation Pending", "MEDIATION", 0],
      ["MEDIATION_ONGOING", "Mediation Ongoing", "MEDIATION", 0],
      ["OUTCOME_FORM_PENDING", "Outcome Form Pending", "OUTCOME", 0],
      ["AUTHORITY_DECISION_PENDING", "Authority Decision Pending", "AUTHORITY", 0],
      ["CLOSED_NON_STARTER", "Closed - Non-Starter", "CLOSURE", 1],
      ["CLOSED_SETTLED", "Closed - Settled", "CLOSURE", 1],
      ["CLOSED_FAILED", "Closed - Failed", "CLOSURE", 1],
      ["WITHDRAWN", "Withdrawn", "CLOSURE", 1],
    ]) seedStatus.run(...row);

    for (const row of [
      ["APPLICATION_RECEIVED", "Application Received", "INSTITUTION"],
      ["SCRUTINY_COMPLETED", "Scrutiny Completed", "INSTITUTION"],
      ["SECRETARY_APPROVAL", "Secretary Approval", "AUTHORITY"],
      ["PIM_REGISTERED", "PIM Registered", "INSTITUTION"],
      ["FORM2_DISPATCHED", "Form-2 Dispatched", "NOTICE"],
      ["OP_CONSENT", "OP Consent Recorded", "RESPONSE"],
      ["MEDIATION_FEE_RECEIVED", "Mediation Fee Received", "FEE"],
      ["MEDIATOR_ASSIGNED", "Mediator Assigned", "MEDIATOR"],
      ["MEDIATION_DATE_FIXED", "Mediation Date Fixed", "MEDIATION"],
      ["MEDIATION_SESSION", "Mediation Session", "MEDIATION"],
      ["FORM3", "Form-3 Issued", "OUTCOME"],
      ["CLOSURE", "Case Closed", "OUTCOME"],
    ]) seedEvent.run(...row);

    for (const row of [
      ["SCRUTINY", "Scrutiny of Received Application", "NORMAL"],
      ["FORM2", "Prepare Form-2 after PIM Registration", "NORMAL"],
      ["MEDIATOR_ASSIGNMENT", "Mediator Assignment", "NORMAL"],
      ["FIRST_MEDIATION", "First Mediation", "NORMAL"],
      ["SESSION_RECORD", "Mediation Session Record", "NORMAL"],
      ["OUTCOME_FORM", "Outcome Form", "URGENT"],
      ["NONSTARTER_AUTHORITY", "Authority Decision on Non-Starter", "NORMAL"],
    ]) seedTask.run(...row);

    for (const row of [
      ["FINAL_NOTICE_UNACKNOWLEDGED", "Final notice remained unacknowledged / no response received", "Rule 3(3)-(4)", 0],
      ["OP_REFUSED_MEDIATION", "Opposite party refused to participate in mediation", "Rule 3(4)", 0],
    ]) seedReason.run(...row);

    seedUser.run(1, "aa", "Administrative Assistant", "Junior Administrative Assistant", "aa");
  });

  seed();
}

function getAnyMediatorId() {
  let mediator = db.prepare("SELECT id FROM mediators WHERE active = 1 LIMIT 1").get();
  if (!mediator) {
    const result = db.prepare(`
      INSERT INTO mediators (name, category, enrollment_no, active, rotation_order)
      VALUES ('Legacy Import Test Mediator', 'ADVOCATE MEDIATOR', 'TEST/1', 1, 999)
    `).run();
    mediator = { id: Number(result.lastInsertRowid) };
  }
  return mediator.id;
}

function payload(overrides = {}) {
  const id = Date.now();
  return {
    stageCode: "MEDIATION_ONGOING",
    receivedNumber: `LEGACY-TEST-${id}`,
    pimNumber: `PIM/LEGACY/${id}`,
    receivedDate: "2026-01-02",
    applicationDate: "2026-01-01",
    scrutinyDate: "2026-01-03",
    registrationDate: "2026-01-04",
    form2Date: "2026-01-05",
    appearanceDate: "2026-01-10",
    responseDate: "2026-01-10",
    assignmentDate: "2026-01-12",
    firstMediationDate: "2026-01-15",
    lastSessionDate: "2026-01-15",
    nextMediationDate: "2026-01-22",
    mediatorId: getAnyMediatorId(),
    applicants: [{ name: "Legacy Applicant", addressLine1: "Applicant address" }],
    oppositeParties: [{ name: "Legacy Opposite Party", addressLine1: "OP address" }],
    ...overrides,
  };
}

function cleanupTestCases() {
  const rows = db.prepare(`
    SELECT id
    FROM pim_cases
    WHERE received_number LIKE 'LEGACY-TEST-%'
       OR pim_number LIKE 'PIM/LEGACY/%'
       OR received_number LIKE 'BAD-%'
       OR pim_number LIKE 'PIM/BAD/%'
  `).all();

  const outcomeCaseIds = rows.map((row) => row.id);
  if (outcomeCaseIds.length) {
    db.prepare(
      `DELETE FROM pim_outcomes WHERE case_id IN (${outcomeCaseIds.map(() => "?").join(",")})`
    ).run(...outcomeCaseIds);
  }

  const remove = db.transaction(() => {
    for (const row of rows) {
      db.prepare("DELETE FROM audit_log WHERE table_name = 'pim_cases' AND record_id = ?").run(row.id);
      db.prepare("DELETE FROM pim_cases WHERE id = ?").run(row.id);
    }
  });

  remove();
}

function run() {
  cleanupTestCases();

  const result = importLegacyCase(payload(), 1);
  assert.strictEqual(result.currentStatus, "MEDIATION_ONGOING");
  assert.strictEqual(result.pendingTask, "SESSION_RECORD");

  const caseRow = db.prepare("SELECT * FROM pim_cases WHERE id = ?").get(result.caseId);
  assert.strictEqual(caseRow.entry_type, "LEGACY");
  assert.strictEqual(caseRow.current_status_id, db.prepare("SELECT id FROM status_master WHERE code = 'MEDIATION_ONGOING'").get().id);

  const pending = db.prepare("SELECT * FROM pim_tasks WHERE case_id = ? AND status = 'PENDING'").all(result.caseId);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].task_type_code, "SESSION_RECORD");
  assert.strictEqual(pending[0].due_date, "2026-01-22");

  const completed = db.prepare("SELECT task_type_code, completed_date FROM pim_tasks WHERE case_id = ? AND status = 'COMPLETED' ORDER BY id").all(result.caseId);
  assert.deepStrictEqual(completed.map((row) => row.task_type_code), ["SCRUTINY", "FORM2", "MEDIATOR_ASSIGNMENT", "FIRST_MEDIATION"]);
  assert.strictEqual(completed[0].completed_date, "2026-01-03");

  const docketDates = db.prepare("SELECT docket_date FROM pim_docket WHERE case_id = ? ORDER BY id").all(result.caseId).map((row) => row.docket_date);
  assert(docketDates.includes("2026-01-02"));
  const nextDocket = db.prepare("SELECT next_date FROM pim_docket WHERE case_id = ? AND next_date = '2026-01-22'").get(result.caseId);
  assert(nextDocket);

  const audit = db.prepare("SELECT reason FROM audit_log WHERE table_name = 'pim_cases' AND record_id = ? AND action = 'LEGACY_IMPORT'").get(result.caseId);
  assert(audit.reason.includes("workflow was reconstructed from the physical file"));

  assert.throws(
    () => importLegacyCase(payload({ receivedNumber: caseRow.received_number, pimNumber: caseRow.pim_number }), 1),
    /Duplicate import blocked/
  );

  assert.throws(
    () => importLegacyCase(payload({ receivedNumber: `BAD-${Date.now()}`, pimNumber: `PIM\/BAD\/${Date.now()}`, responseDate: "2026-01-01" }), 1),
    /responseDate cannot be earlier than appearanceDate/
  );

  /*
   * Phase 12 regression: importing a case directly at a terminal
   * stage (skipping AUTHORITY_DECISION_PENDING) must still create a
   * pim_outcomes row. An earlier refactor had silently dropped this
   * insert, which would have made every such import fail the
   * production-readiness audit's closed-case-without-outcome check.
   */
  const reasonId = db.prepare("SELECT id FROM nonstarter_reasons WHERE code = 'OP_REFUSED_MEDIATION'").get().id;
  const nonStarterResult = importLegacyCase(
    payload({
      stageCode: "CLOSED_NON_STARTER",
      receivedNumber: `LEGACY-TEST-TERMINAL-${Date.now()}`,
      pimNumber: `PIM/LEGACY/TERMINAL-${Date.now()}`,
      form2Date: undefined,
      appearanceDate: undefined,
      responseDate: undefined,
      assignmentDate: undefined,
      firstMediationDate: undefined,
      lastSessionDate: undefined,
      nextMediationDate: undefined,
      form3Date: "2026-01-10",
      outcomeDate: "2026-01-12",
      nonstarterReasonId: reasonId,
      outcomeReason: "Opposite party did not appear.",
    }),
    1
  );
  const nonStarterOutcome = db.prepare("SELECT * FROM pim_outcomes WHERE case_id = ?").get(nonStarterResult.caseId);
  assert(nonStarterOutcome, "Terminal-stage legacy import must create a pim_outcomes row.");
  assert.strictEqual(nonStarterOutcome.outcome_type, "NON_STARTER");
  assert.strictEqual(nonStarterOutcome.form_no, "FORM-3");
  assert.strictEqual(nonStarterOutcome.nonstarter_reason_id, reasonId);

  const settledResult = importLegacyCase(
    payload({
      stageCode: "CLOSED_SETTLED",
      receivedNumber: `LEGACY-TEST-TERMINAL-${Date.now()}-S`,
      pimNumber: `PIM/LEGACY/TERMINAL-${Date.now()}-S`,
      outcomeDate: "2026-01-25",
      settlementTerms: "Parties agreed to settle in full.",
    }),
    1
  );
  const settledOutcome = db.prepare("SELECT * FROM pim_outcomes WHERE case_id = ?").get(settledResult.caseId);
  assert(settledOutcome, "Settled legacy import must create a pim_outcomes row.");
  assert.strictEqual(settledOutcome.form_no, "FORM-4");
  assert.strictEqual(settledOutcome.settlement_terms, "Parties agreed to settle in full.");

  console.log("Legacy import isolated tests passed.");
}

try {
  run();
} finally {
  cleanupTestCases();
  db.prepare(`
    DELETE FROM mediators
    WHERE name = 'Legacy Import Test Mediator'
      AND NOT EXISTS (
        SELECT 1
        FROM pim_mediator_assignments
        WHERE mediator_id = mediators.id
      )
  `).run();
  db.close();
}
