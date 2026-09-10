const db = require("../lib/db");

const caseId = 4;

console.log("\n========== CASE ==========");

console.table(
  db.prepare(`
    SELECT
      c.id,
      c.pim_number,
      c.registration_date,
      c.secretary_decision,
      c.secretary_decision_date,
      c.current_status_id,
      s.code AS status_code,
      s.name AS status_name,
      c.internal_60_day_date
    FROM pim_cases c
    LEFT JOIN status_master s
      ON s.id = c.current_status_id
    WHERE c.id = ?
  `).all(caseId)
);

console.log("\n========== STATUS HISTORY ==========");

console.table(
  db.prepare(`
    SELECT
      h.id,
      h.from_status_id,
      fs.code AS from_status,
      h.to_status_id,
      ts.code AS to_status,
      h.changed_at,
      h.reason
    FROM pim_status_history h
    LEFT JOIN status_master fs
      ON fs.id = h.from_status_id
    LEFT JOIN status_master ts
      ON ts.id = h.to_status_id
    WHERE h.case_id = ?
    ORDER BY h.id
  `).all(caseId)
);

console.log("\n========== DOCKET ==========");

console.table(
  db.prepare(`
    SELECT
      d.id,
      d.docket_date,
      e.code AS event_code,
      e.name AS event_name,
      d.entry_text,
      d.action_required,
      d.next_date
    FROM pim_docket d
    LEFT JOIN event_types e
      ON e.id = d.event_type_id
    WHERE d.case_id = ?
    ORDER BY d.id
  `).all(caseId)
);

console.log("\n========== TASKS ==========");

console.table(
  db.prepare(`
    SELECT
      id,
      task_type_code,
      description,
      status,
      created_date,
      due_date,
      completed_date,
      auto_generated
    FROM pim_tasks
    WHERE case_id = ?
    ORDER BY id
  `).all(caseId)
);

db.close();