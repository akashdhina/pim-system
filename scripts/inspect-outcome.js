const db = require("../lib/db");

console.log("\n========== PIM OUTCOMES ==========");

console.log(
  db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'pim_outcomes'
  `).get()
);

console.log("\n========== CASE 4 OUTCOMES ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM pim_outcomes
    WHERE case_id = 4
    ORDER BY id
  `).all()
);

console.log("\n========== STATUS MASTER ==========");

console.table(
  db.prepare(`
    SELECT id, code, name
    FROM status_master
    ORDER BY id
  `).all()
);

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

db.close();