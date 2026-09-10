const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(
  __dirname,
  "..",
  "database",
  "pim.db"
);

const db = new Database(dbPath);

try {
  db.pragma("foreign_keys = ON");

  const transaction = db.transaction(() => {
    const testCase = db.prepare(`
      SELECT id
      FROM pim_cases
      WHERE received_number = '122'
    `).get();

    if (!testCase) {
      console.log("Test PIM not found. Nothing to delete.");
      return;
    }

    const caseId = testCase.id;

    const partyRows = db.prepare(`
      SELECT party_id
      FROM pim_case_parties
      WHERE case_id = ?
    `).all(caseId);

    const advocateRows = db.prepare(`
      SELECT advocate_id
      FROM pim_case_advocates
      WHERE case_id = ?
    `).all(caseId);

    // Case-level records
    db.prepare(`DELETE FROM pim_docket WHERE case_id = ?`)
      .run(caseId);

    db.prepare(`DELETE FROM pim_tasks WHERE case_id = ?`)
      .run(caseId);

    db.prepare(`DELETE FROM pim_status_history WHERE case_id = ?`)
      .run(caseId);

    db.prepare(`DELETE FROM pim_fees WHERE case_id = ?`)
      .run(caseId);

    db.prepare(`DELETE FROM pim_notices WHERE case_id = ?`)
      .run(caseId);

    db.prepare(`DELETE FROM pim_responses WHERE case_id = ?`)
      .run(caseId);

    db.prepare(`DELETE FROM pim_scrutiny WHERE case_id = ?`)
      .run(caseId);

    db.prepare(`DELETE FROM pim_documents WHERE case_id = ?`)
      .run(caseId);

    db.prepare(`
      DELETE FROM pim_mediator_assignments
      WHERE case_id = ?
    `).run(caseId);

    db.prepare(`
      DELETE FROM mediation_sessions
      WHERE case_id = ?
    `).run(caseId);

    db.prepare(`
      DELETE FROM pim_outcomes
      WHERE case_id = ?
    `).run(caseId);

    // Case-advocate relationships
    db.prepare(`
      DELETE FROM pim_case_advocates
      WHERE case_id = ?
    `).run(caseId);

    // Case-party relationships
    db.prepare(`
      DELETE FROM pim_case_parties
      WHERE case_id = ?
    `).run(caseId);

    // Addresses and parties
    for (const row of partyRows) {
      db.prepare(`
        DELETE FROM pim_addresses
        WHERE party_id = ?
      `).run(row.party_id);

      db.prepare(`
        DELETE FROM pim_parties
        WHERE id = ?
      `).run(row.party_id);
    }

    // Advocates created only for this test
    for (const row of advocateRows) {
      db.prepare(`
        DELETE FROM pim_advocates
        WHERE id = ?
      `).run(row.advocate_id);
    }

    // Finally delete the case
    db.prepare(`
      DELETE FROM pim_cases
      WHERE id = ?
    `).run(caseId);

    console.log(
      `Test PIM case ${caseId} and dependent test data deleted.`
    );
  });

  transaction();

} catch (error) {
  console.error("TEST DATA CLEANUP FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  db.close();
}