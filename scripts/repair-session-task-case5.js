const db = require("../lib/db");

const caseId = 5;
const completedTaskId = 14;
const nextDate = "2026-09-09";

const result = db.transaction(() => {
  const task = db.prepare(`
    SELECT *
    FROM pim_tasks
    WHERE id = ?
      AND case_id = ?
  `).get(completedTaskId, caseId);

  if (!task) {
    throw new Error(
      "Task 14 was not found for Case 5."
    );
  }

  if (task.status !== "COMPLETED") {
    db.prepare(`
      UPDATE pim_tasks
      SET
        status = 'COMPLETED',
        completed_date = ?,
        completed_time = ?,
        completed_by = ?,
        remarks = ?
      WHERE id = ?
    `).run(
      "2026-08-12",
      new Date().toISOString().slice(11, 19),
      null,
      "Sitting 2 already recorded; task repaired.",
      completedTaskId
    );

    db.prepare(`
      INSERT INTO pim_task_history
      (
        task_id,
        old_status,
        new_status,
        changed_by,
        remarks
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(
      completedTaskId,
      task.status,
      "COMPLETED",
      null,
      "Sitting 2 already recorded; task repaired."
    );
  }

  const existingNextTask = db.prepare(`
    SELECT id
    FROM pim_tasks
    WHERE case_id = ?
      AND task_type_code = 'SESSION_RECORD'
      AND status = 'PENDING'
      AND due_date = ?
    LIMIT 1
  `).get(caseId, nextDate);

  let nextTaskId =
    existingNextTask?.id || null;

  if (!nextTaskId) {
    const taskType = db.prepare(`
      SELECT
        id,
        code,
        default_priority
      FROM task_types
      WHERE code = 'SESSION_RECORD'
        AND active = 1
      LIMIT 1
    `).get();

    if (!taskType) {
      throw new Error(
        "Active SESSION_RECORD task type not found."
      );
    }

    const nextTask = db.prepare(`
      INSERT INTO pim_tasks
      (
        case_id,
        task_type_id,
        task_type_code,
        description,
        created_date,
        due_date,
        priority,
        status,
        auto_generated,
        remarks
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)
    `).run(
      caseId,
      taskType.id,
      taskType.code,
      "Record mediation sitting 3.",
      "2026-08-12",
      nextDate,
      taskType.default_priority || "NORMAL",
      "Next mediation sitting fixed for 2026-09-09."
    );

    nextTaskId =
      Number(nextTask.lastInsertRowid);
  }

  return {
    completedTaskId,
    nextTaskId,
  };
})();

console.log("REPAIR COMPLETE");
console.log(result);

console.log("\nTASKS:");
console.table(
  db.prepare(`
    SELECT
      id,
      task_type_code,
      description,
      status,
      due_date,
      completed_date,
      remarks
    FROM pim_tasks
    WHERE case_id = 5
    ORDER BY id
  `).all()
);

db.close();