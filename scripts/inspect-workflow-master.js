const db = require("../lib/db");

console.log("\n========== NON-STARTER EVENTS ==========");

console.table(
  db.prepare(`
    SELECT id, code, name
    FROM event_types
    WHERE
      code LIKE '%NON%'
      OR name LIKE '%Non-Starter%'
      OR name LIKE '%Non Starter%'
    ORDER BY id
  `).all()
);

console.log("\n========== NON-STARTER TASK TYPES ==========");

console.table(
  db.prepare(`
    SELECT
      id,
      code,
      name,
      default_priority,
      active
    FROM task_types
    WHERE
      code LIKE '%NON%'
      OR name LIKE '%Non-Starter%'
      OR name LIKE '%Non Starter%'
    ORDER BY id
  `).all()
);

console.log("\n========== NON-STARTER STATUSES ==========");

console.table(
  db.prepare(`
    SELECT id, code, name
    FROM status_master
    WHERE code IN (
      'OUTCOME_FORM_PENDING',
      'CLOSED_NON_STARTER',
      'AUTHORITY_DECISION_PENDING'
    )
    ORDER BY id
  `).all()
);

db.close();