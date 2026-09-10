const db = require("../lib/db");

const tables = [
  "pim_cases",
  "pim_status_history",
  "pim_docket",
  "pim_tasks",
  "pim_task_history",
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

console.log("\n========== SYSTEM SETTINGS ==========");

console.table(
  db.prepare("SELECT * FROM system_settings").all()
);

console.log("\n========== SQLITE SEQUENCES ==========");

console.table(
  db.prepare(
    "SELECT name, seq FROM sqlite_sequence"
  ).all()
);

db.close();