const db = require("../lib/db");

console.log("\n========== PIM FEES ==========");

const feeSchema = db
  .prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = ?
      AND name = ?
  `)
  .get("table", "pim_fees");

console.log(feeSchema);

console.log("\n========== CASE 4 STATUS ==========");

console.table(
  db
    .prepare(`
      SELECT
        c.id,
        c.pim_number,
        s.code AS status_code,
        s.name AS status_name
      FROM pim_cases c
      JOIN status_master s
        ON s.id = c.current_status_id
      WHERE c.id = ?
    `)
    .get(4)
);

console.log("\n========== CASE 4 RESPONSES ==========");

console.table(
  db
    .prepare(`
      SELECT *
      FROM pim_responses
      WHERE case_id = ?
      ORDER BY id DESC
    `)
    .all(4)
);

console.log("\n========== CASE 4 FEES ==========");

console.table(
  db
    .prepare(`
      SELECT *
      FROM pim_fees
      WHERE case_id = ?
      ORDER BY id DESC
    `)
    .all(4)
);

db.close();