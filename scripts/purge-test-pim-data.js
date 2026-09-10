/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const db = require("../lib/db");

const REQUIRED_CONFIRMATION =
  "DELETE_ALL_EXISTING_PIM_CASE_DATA";

if (
  process.env.PIM_PURGE_CONFIRM !==
  REQUIRED_CONFIRMATION
) {
  console.error(
    "Purge refused. Set PIM_PURGE_CONFIRM=" +
      REQUIRED_CONFIRMATION
  );
  process.exit(1);
}

const root = process.cwd();
const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-");

const quarantineRoot = path.join(
  root,
  "storage",
  "_purged-test-data",
  timestamp
);

function tableExists(tableName) {
  return Boolean(
    db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
    `).get(tableName)
  );
}

function columnExists(tableName, columnName) {
  if (!tableExists(tableName)) return false;

  return db
    .prepare(`PRAGMA table_info("${tableName}")`)
    .all()
    .some((column) => column.name === columnName);
}

function count(tableName) {
  if (!tableExists(tableName)) return 0;

  return db
    .prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`)
    .get().count;
}

function runIfTableExists(tableName, sql, ...params) {
  if (!tableExists(tableName)) return;

  db.prepare(sql).run(...params);
}

const cases = tableExists("pim_cases")
  ? db.prepare(`
      SELECT
        id,
        pim_number,
        registration_date,
        application_date
      FROM pim_cases
      ORDER BY id
    `).all()
  : [];

console.log("Cases selected for deletion:");
console.table(cases);

console.log("Current transactional counts:");
for (const table of [
  "pim_cases",
  "pim_case_parties",
  "pim_parties",
  "pim_addresses",
  "pim_case_advocates",
  "pim_advocates",
  "pim_notices",
  "pim_service_attempts",
  "pim_responses",
  "pim_fees",
  "pim_mediator_assignments",
  "mediation_sessions",
  "pim_outcomes",
  "pim_documents",
  "pim_tasks",
  "pim_task_history",
  "pim_docket",
  "pim_status_history",
]) {
  console.log(`${table}: ${count(table)}`);
}

/*
 * Preserve generated test files by moving their case folders
 * into a quarantine folder.
 */
fs.mkdirSync(quarantineRoot, {
  recursive: true,
});

for (const caseRow of cases) {
  const pimNumber =
    caseRow.pim_number ||
    `CASE-${caseRow.id}`;

  const safePimNumber = pimNumber.replace(
    /[^a-zA-Z0-9_-]/g,
    "-"
  );

  const year = String(
    caseRow.registration_date ||
      caseRow.application_date ||
      ""
  ).slice(0, 4);

  if (!year) continue;

  const sourceDirectory = path.join(
    root,
    "storage",
    "pim",
    year,
    safePimNumber
  );

  if (!fs.existsSync(sourceDirectory)) {
    continue;
  }

  const destinationDirectory = path.join(
    quarantineRoot,
    `${caseRow.id}-${safePimNumber}`
  );

  fs.renameSync(
    sourceDirectory,
    destinationDirectory
  );

  console.log(
    `Quarantined: ${sourceDirectory}`
  );
}

const purge = db.transaction(() => {
  /*
   * Indirect child tables must be cleared first.
   */
  if (
    tableExists("pim_task_history") &&
    tableExists("pim_tasks")
  ) {
    db.prepare(`
      DELETE FROM pim_task_history
      WHERE task_id IN (
        SELECT id
        FROM pim_tasks
        WHERE case_id IN (
          SELECT id FROM pim_cases
        )
      )
    `).run();
  }

  if (
    tableExists("pim_service_attempts") &&
    tableExists("pim_notices")
  ) {
    db.prepare(`
      DELETE FROM pim_service_attempts
      WHERE notice_id IN (
        SELECT id
        FROM pim_notices
        WHERE case_id IN (
          SELECT id FROM pim_cases
        )
      )
    `).run();
  }

  /*
   * Delete tables that directly belong to a case.
   */
  const directCaseTables = [
    "pim_documents",
    "pim_outcomes",
    "mediation_sessions",
    "pim_mediator_assignments",
    "pim_fees",
    "pim_responses",
    "pim_notices",
    "pim_tasks",
    "pim_docket",
    "pim_status_history",
    "pim_case_advocates",
    "pim_case_parties",
  ];

  for (const tableName of directCaseTables) {
    if (
      tableExists(tableName) &&
      columnExists(tableName, "case_id")
    ) {
      db.prepare(`
        DELETE FROM "${tableName}"
        WHERE case_id IN (
          SELECT id FROM pim_cases
        )
      `).run();
    }
  }

  /*
   * Remove audit entries tied to case workflow tables.
   * User/settings/security audit entries are preserved.
   */
  if (tableExists("audit_log")) {
    const caseAuditTables = [
      "pim_cases",
      "pim_case_parties",
      "pim_parties",
      "pim_addresses",
      "pim_case_advocates",
      "pim_advocates",
      "pim_notices",
      "pim_service_attempts",
      "pim_responses",
      "pim_fees",
      "pim_mediator_assignments",
      "mediation_sessions",
      "pim_outcomes",
      "pim_documents",
      "pim_tasks",
      "pim_task_history",
      "pim_docket",
      "pim_status_history",
    ];

    const placeholders = caseAuditTables
      .map(() => "?")
      .join(",");

    db.prepare(`
      DELETE FROM audit_log
      WHERE table_name IN (${placeholders})
    `).run(...caseAuditTables);
  }

  /*
   * Delete case headers last.
   */
  runIfTableExists(
    "pim_cases",
    `DELETE FROM pim_cases`
  );

  /*
   * Remove orphaned case-specific records.
   * These are safe only when no case relationship remains.
   */
  if (
    tableExists("pim_addresses") &&
    tableExists("pim_parties") &&
    columnExists("pim_parties", "address_id")
  ) {
    db.prepare(`
      DELETE FROM pim_addresses
      WHERE id NOT IN (
        SELECT DISTINCT address_id
        FROM pim_parties
        WHERE address_id IS NOT NULL
      )
    `).run();
  }

  if (
    tableExists("pim_parties") &&
    tableExists("pim_case_parties")
  ) {
    db.prepare(`
      DELETE FROM pim_parties
      WHERE id NOT IN (
        SELECT DISTINCT party_id
        FROM pim_case_parties
      )
    `).run();
  }

  if (
    tableExists("pim_advocates") &&
    tableExists("pim_case_advocates")
  ) {
    db.prepare(`
      DELETE FROM pim_advocates
      WHERE id NOT IN (
        SELECT DISTINCT advocate_id
        FROM pim_case_advocates
      )
    `).run();
  }

  /*
   * Remove obvious unassigned test mediators only.
   * Real mediator master records are preserved.
   */
  if (
    tableExists("mediators") &&
    tableExists("pim_mediator_assignments")
  ) {
    db.prepare(`
      DELETE FROM mediators
      WHERE (
        UPPER(name) LIKE 'TEST%'
        OR UPPER(enrollment_no) LIKE 'TEST%'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pim_mediator_assignments a
        WHERE a.mediator_id = mediators.id
      )
    `).run();
  }
});

try {
  purge();
} catch (error) {
  console.error("Purge failed. Database transaction rolled back.");
  console.error(error);
  console.error(
    `Test document quarantine may exist at: ${quarantineRoot}`
  );
  process.exit(1);
}

const integrity = db
  .prepare("PRAGMA integrity_check")
  .all();

const foreignKeys = db
  .prepare("PRAGMA foreign_key_check")
  .all();

console.log("Purge completed.");
console.log("Integrity check:");
console.table(integrity);

console.log("Foreign-key check:");
console.table(foreignKeys);

console.log(
  `Remaining PIM cases: ${count("pim_cases")}`
);

console.log(
  `Quarantined test documents: ${quarantineRoot}`
);

if (
  integrity.some(
    (row) => Object.values(row)[0] !== "ok"
  ) ||
  foreignKeys.length > 0
) {
  console.error(
    "Post-purge validation failed. Restore the backup."
  );
  process.exitCode = 1;
}