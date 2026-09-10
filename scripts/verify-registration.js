const db = require("../lib/db");

console.log("\nCASE");
console.table(
  db.prepare(`
    SELECT
      id,
      pim_number,
      registration_date,
      secretary_decision,
      secretary_decision_date,
      current_status_id,
      statutory_due_date,
      internal_60_day_date
    FROM pim_cases
    WHERE id = 3
  `).all()
);

console.log("\nSTATUS HISTORY");
console.table(
  db.prepare(`
    SELECT
      id,
      case_id,
      from_status_id,
      to_status_id,
      changed_at,
      reason
    FROM pim_status_history
    WHERE case_id = 3
    ORDER BY id
  `).all()
);

console.log("\nDOCKET");
console.table(
  db.prepare(`
    SELECT
      id,
      case_id,
      docket_date,
      event_type_id,
      entry_text,
      next_date,
      action_required
    FROM pim_docket
    WHERE case_id = 3
    ORDER BY id
  `).all()
);

console.log("\nTASKS");
console.table(
  db.prepare(`
    SELECT
      id,
      case_id,
      task_type_code,
      description,
      status,
      completed_date,
      due_date,
      auto_generated
    FROM pim_tasks
    WHERE case_id = 3
    ORDER BY id
  `).all()
);

db.close();