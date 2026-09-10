const db = require("../lib/db");

for (const table of [
  "mediators",
  "pim_mediator_assignments"
]) {
  console.log(`\n========== ${table} ==========`);

  console.log(
    db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = ?
        AND name = ?
    `).get("table", table)
  );

  console.log("\nDATA:");

  try {
    console.table(
      db.prepare(`SELECT * FROM ${table}`).all()
    );
  } catch (error) {
    console.log(error.message);
  }
}

console.log("\n========== CASE 4 STATUS ==========");

console.table(
  db.prepare(`
    SELECT
      c.id,
      c.pim_number,
      s.code AS status_code,
      s.name AS status_name
    FROM pim_cases c
    JOIN status_master s
      ON s.id = c.current_status_id
    WHERE c.id = 4
  `).all()
);

console.log("\n========== CASE 4 TASKS ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM pim_tasks
    WHERE case_id = 4
    ORDER BY id
  `).all()
);

db.close();