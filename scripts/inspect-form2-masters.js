const db = require("../lib/db");

console.log("\n========== STATUS ==========");

console.table(
  db.prepare(`
    SELECT id, code, name
    FROM status_master
    WHERE code IN (
      'REGISTERED',
      'FORM2_PENDING',
      'FORM2_ISSUED',
      'SERVICE_PENDING'
    )
  `).all()
);

console.log("\n========== EVENTS ==========");

console.table(
  db.prepare(`
    SELECT id, code, name
    FROM event_types
    WHERE code IN (
      'FORM2_PREPARED',
      'FORM2_DISPATCHED',
      'FRESH_FORM2'
    )
  `).all()
);

console.log("\n========== TASK TYPES ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM task_types
    WHERE code LIKE '%FORM2%'
       OR name LIKE '%Form-2%'
  `).all()
);

db.close();