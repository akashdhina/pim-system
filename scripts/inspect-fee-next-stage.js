const db = require("../lib/db");

console.log("\n========== SYSTEM SETTINGS ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM system_settings
    ORDER BY setting_key
  `).all()
);

console.log("\n========== MEDIATOR STATUS ==========");

console.table(
  db.prepare(`
    SELECT
      id,
      code,
      name
    FROM status_master
    WHERE code IN (
      'FEE_PENDING',
      'MEDIATOR_ASSIGNMENT_PENDING',
      'MEDIATOR_ASSIGNED'
    )
    ORDER BY id
  `).all()
);

console.log("\n========== MEDIATOR EVENTS ==========");

console.table(
  db.prepare(`
    SELECT
      id,
      code,
      name
    FROM event_types
    WHERE code IN (
      'MEDIATION_FEE_REQUESTED',
      'MEDIATION_FEE_RECEIVED',
      'MEDIATOR_ASSIGNED'
    )
    ORDER BY id
  `).all()
);

console.log("\n========== TASK TYPES ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM task_types
    WHERE code LIKE '%MEDI%'
       OR name LIKE '%Medi%'
    ORDER BY id
  `).all()
);

console.log("\n========== CASE 4 CURRENT TASKS ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM pim_tasks
    WHERE case_id = 4
    ORDER BY id
  `).all()
);

db.close();