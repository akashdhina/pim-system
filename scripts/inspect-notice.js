const db = require("../lib/db");

const tables = [
  "pim_notices",
  "pim_documents",
  "pim_responses",
  "pim_service_attempts",
];

for (const table of tables) {
  console.log(`\n========== ${table} ==========`);

  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(table);

  console.log(row ? row.sql : "TABLE NOT FOUND");
}

console.log("\n========== CASE 3 NOTICE/DOCUMENT DATA ==========");

for (const table of tables) {
  try {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE case_id = ?`)
      .all(3);

    console.log(`\n${table}:`);
    console.dir(rows, { depth: null });
  } catch (error) {
    console.log(
      `${table}: case_id column not available`
    );
  }
}

db.close();