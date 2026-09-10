const db = require("../lib/db");

const result = db.transaction(() => {
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO event_types
    (
      code,
      name
    )
    VALUES (?, ?)
  `);

  insertEvent.run(
    "NONSTARTER_RECORDED",
    "Non-Starter Recorded"
  );

  insertEvent.run(
    "FORM3_ISSUED",
    "Form-3 Non-Starter Report Issued"
  );

  insertEvent.run(
    "AUTHORITY_DECISION",
    "Authority Decision"
  );

  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO task_types
    (
      code,
      name,
      default_priority,
      active
    )
    VALUES (?, ?, ?, 1)
  `);

  insertTask.run(
    "NONSTARTER_FORM3",
    "Prepare Form-3 Non-Starter Report",
    "NORMAL"
  );

  insertTask.run(
    "NONSTARTER_AUTHORITY",
    "Authority Decision on Non-Starter",
    "NORMAL"
  );

  return {
    events: db.prepare(`
      SELECT id, code, name
      FROM event_types
      WHERE code IN (
        'NONSTARTER_RECORDED',
        'FORM3_ISSUED',
        'AUTHORITY_DECISION'
      )
      ORDER BY id
    `).all(),

    tasks: db.prepare(`
      SELECT
        id,
        code,
        name,
        default_priority,
        active
      FROM task_types
      WHERE code IN (
        'NONSTARTER_FORM3',
        'NONSTARTER_AUTHORITY'
      )
      ORDER BY id
    `).all(),
  };
})();

console.log("\n========== NON-STARTER WORKFLOW MASTER ==========");

console.log("\nEVENTS:");
console.table(result.events);

console.log("\nTASK TYPES:");
console.table(result.tasks);

db.close();