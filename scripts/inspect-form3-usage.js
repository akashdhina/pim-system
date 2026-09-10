const db = require("../lib/db");

console.log("\n========== FORM3 EVENT ==========");

console.table(
  db.prepare(`
    SELECT id, code, name, category, active
    FROM event_types
    WHERE code = 'FORM3'
  `).all()
);

console.log("\n========== FORM3 DOCKET ENTRIES ==========");

console.table(
  db.prepare(`
    SELECT
      d.id,
      d.case_id,
      d.docket_date,
      d.entry_text,
      d.action_required
    FROM pim_docket d
    JOIN event_types e
      ON e.id = d.event_type_id
    WHERE e.code = 'FORM3'
    ORDER BY d.id
  `).all()
);

db.close();