const db = require("../lib/db");

console.log("\n========== MEDIATION SESSIONS ==========");

console.log(
  db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = ?
      AND name = ?
  `).get("table", "mediation_sessions")
);

console.log("\n========== EXISTING SESSIONS ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM mediation_sessions
    ORDER BY id
  `).all()
);

console.log("\n========== MEDIATION STATUS ==========");

console.table(
  db.prepare(`
    SELECT
      id,
      code,
      name
    FROM status_master
    WHERE code IN (
      'MEDIATOR_ASSIGNED',
      'MEDIATION_PENDING',
      'MEDIATION_ONGOING',
      'OUTCOME_FORM_PENDING'
    )
    ORDER BY id
  `).all()
);

console.log("\n========== MEDIATION EVENTS ==========");

console.table(
  db.prepare(`
    SELECT
      id,
      code,
      name
    FROM event_types
    WHERE code IN (
      'MEDIATION_DATE_FIXED',
      'MEDIATION_SESSION',
      'EXTENSION',
      'FORM3',
      'FORM4',
      'FORM5'
    )
    ORDER BY id
  `).all()
);

console.log("\n========== CASE 4 ASSIGNMENT ==========");

console.table(
  db.prepare(`
    SELECT
      a.*,
      m.name AS mediator_name
    FROM pim_mediator_assignments a
    JOIN mediators m
      ON m.id = a.mediator_id
    WHERE a.case_id = 4
    ORDER BY a.id DESC
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