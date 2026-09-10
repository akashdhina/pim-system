const db = require("../lib/db");

console.log("\n========== ACTIVE MEDIATION CASES ==========");

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
    WHERE s.code = 'MEDIATION_ONGOING'
    ORDER BY c.id
  `).all()
);

db.close();