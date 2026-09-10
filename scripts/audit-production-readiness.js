/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const db = require("../lib/db");
const {
  getCaseAction,
  getTaskAction,
  TERMINAL_STATUSES,
} = require("../lib/pim-action-link");

const root = process.cwd();
const findings = [];

function add(severity, code, message, rows = []) {
  findings.push({
    severity,
    code,
    message,
    count: rows.length,
    rows,
  });
}

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
}

function existingTables() {
  return all(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name
  `).map((row) => row.name);
}

function fileExists(filePath) {
  if (!filePath) return false;
  return fs.existsSync(
    path.isAbsolute(filePath)
      ? filePath
      : path.join(root, filePath)
  );
}

function auditDatabase() {
  const foreignKeys = all("PRAGMA foreign_key_check");
  add(
    foreignKeys.length ? "critical" : "info",
    "foreign-key-check",
    "SQLite foreign key validation",
    foreignKeys
  );

  add(
    "critical",
    "case-missing-current-status",
    "Cases with missing current_status_id",
    all(`
      SELECT id, pim_number, received_number
      FROM pim_cases
      WHERE current_status_id IS NULL
    `)
  );

  const terminalList = Array.from(TERMINAL_STATUSES);
  const terminalPlaceholders = terminalList.map(() => "?").join(",");

  add(
    "high",
    "terminal-case-pending-task",
    "Terminal cases with pending tasks",
    all(
      `
      SELECT c.id, c.pim_number, s.code AS status_code, COUNT(t.id) AS pending_tasks
      FROM pim_cases c
      JOIN status_master s ON s.id = c.current_status_id
      JOIN pim_tasks t ON t.case_id = c.id AND t.status = 'PENDING'
      WHERE s.code IN (${terminalPlaceholders})
      GROUP BY c.id
    `,
      ...terminalList
    )
  );

  add(
    "medium",
    "open-case-no-pending-task",
    "Open cases with no pending task",
    all(
      `
      SELECT c.id, c.pim_number, c.received_number, s.code AS status_code
      FROM pim_cases c
      JOIN status_master s ON s.id = c.current_status_id
      WHERE s.code NOT IN (${terminalPlaceholders})
        AND NOT EXISTS (
          SELECT 1
          FROM pim_tasks t
          WHERE t.case_id = c.id
            AND t.status = 'PENDING'
        )
      ORDER BY c.id
    `,
      ...terminalList
    )
  );

  add(
    "high",
    "duplicate-pending-task",
    "Duplicate pending tasks of the same type",
    all(`
      SELECT case_id, task_type_code, COUNT(*) AS count
      FROM pim_tasks
      WHERE status = 'PENDING'
      GROUP BY case_id, task_type_code
      HAVING COUNT(*) > 1
    `)
  );

  add(
    "high",
    "duplicate-current-document",
    "Multiple current documents of the same type for one case",
    all(`
      SELECT case_id, document_type, COUNT(*) AS count
      FROM pim_documents
      WHERE is_current = 1
      GROUP BY case_id, document_type
      HAVING COUNT(*) > 1
    `)
  );

  add(
    "high",
    "outcome-document-wrong-case",
    "Outcome document_id points to a missing or different-case document",
    all(`
      SELECT o.id AS outcome_id, o.case_id, o.document_id, d.case_id AS document_case_id
      FROM pim_outcomes o
      LEFT JOIN pim_documents d ON d.id = o.document_id
      WHERE o.document_id IS NOT NULL
        AND (d.id IS NULL OR d.case_id <> o.case_id)
    `)
  );

  add(
    "high",
    "notice-document-wrong-case",
    "Notice document_id points to a missing or different-case document",
    all(`
      SELECT n.id AS notice_id, n.case_id, n.document_id, d.case_id AS document_case_id
      FROM pim_notices n
      LEFT JOIN pim_documents d ON d.id = n.document_id
      WHERE n.document_id IS NOT NULL
        AND (d.id IS NULL OR d.case_id <> n.case_id)
    `)
  );

  add(
    "high",
    "document-missing-file-path",
    "Documents with missing file_path",
    all(`
      SELECT id, case_id, document_type, document_title
      FROM pim_documents
      WHERE file_path IS NULL OR TRIM(file_path) = ''
    `)
  );

  const missingFiles = all(`
    SELECT id, case_id, document_type, document_title, file_path
    FROM pim_documents
    WHERE file_path IS NOT NULL AND TRIM(file_path) <> ''
  `).filter((row) => !fileExists(row.file_path));
  add(
    "high",
    "document-file-not-found",
    "Documents whose physical file does not exist",
    missingFiles
  );

  add(
    "medium",
    "completed-session-missing-actual-date",
    "Completed mediation sessions with missing actual date",
    all(`
      SELECT id, case_id, scheduled_date, actual_date
      FROM mediation_sessions
      WHERE session_status = 'COMPLETED'
        AND actual_date IS NULL
    `)
  );

  add(
    "medium",
    "effective-session-missing-time",
    "Effective sessions without start/end/duration",
    all(`
      SELECT id, case_id, actual_start_time, actual_end_time, duration_minutes
      FROM mediation_sessions
      WHERE effective_session = 1
        AND (
          actual_start_time IS NULL
          OR actual_end_time IS NULL
          OR duration_minutes IS NULL
          OR duration_minutes <= 0
        )
    `)
  );

  add(
    "medium",
    "ineffective-session-with-duration",
    "Ineffective sessions with duration",
    all(`
      SELECT id, case_id, duration_minutes
      FROM mediation_sessions
      WHERE effective_session = 0
        AND COALESCE(duration_minutes, 0) > 0
    `)
  );

  add(
    "medium",
    "actual-before-scheduled",
    "Sessions with actual date earlier than scheduled date",
    all(`
      SELECT id, case_id, scheduled_date, actual_date
      FROM mediation_sessions
      WHERE scheduled_date IS NOT NULL
        AND actual_date IS NOT NULL
        AND actual_date < scheduled_date
    `)
  );

  add(
    "high",
    "closed-case-without-outcome",
    "Closed cases without outcome",
    all(
      `
      SELECT c.id, c.pim_number, s.code AS status_code, c.outcome_type
      FROM pim_cases c
      JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN pim_outcomes o ON o.case_id = c.id
      WHERE s.code IN (${terminalPlaceholders})
        AND (c.outcome_type IS NULL OR o.id IS NULL)
    `,
      ...terminalList
    )
  );

  add(
    "high",
    "outcome-terminal-mismatch",
    "Outcome records inconsistent with terminal status",
    all(`
      SELECT c.id, c.pim_number, s.code AS status_code, o.outcome_type, c.outcome_type AS case_outcome_type
      FROM pim_outcomes o
      JOIN pim_cases c ON c.id = o.case_id
      LEFT JOIN status_master s ON s.id = c.current_status_id
      WHERE (
          o.outcome_type = 'SETTLED'
          AND s.code NOT IN ('CLOSED_SETTLED', 'OUTCOME_FORM_PENDING')
        )
        OR (
          o.outcome_type = 'FAILED'
          AND s.code NOT IN ('CLOSED_FAILED', 'OUTCOME_FORM_PENDING')
        )
        OR (
          o.outcome_type = 'WITHDRAWN'
          AND s.code <> 'WITHDRAWN'
        )
        OR (
          o.outcome_type = 'NON_STARTER'
          AND s.code NOT IN ('CLOSED_NON_STARTER', 'AUTHORITY_DECISION_PENDING', 'OUTCOME_FORM_PENDING')
        )
        OR c.outcome_type <> o.outcome_type
    `)
  );

  add(
    "medium",
    "status-history-gap",
    "Status-history entries where from_status_id does not match previous status",
    all(`
      WITH ordered AS (
        SELECT
          h.*,
          LAG(h.to_status_id) OVER (
            PARTITION BY h.case_id
            ORDER BY h.changed_at, h.id
          ) AS previous_to_status_id
        FROM pim_status_history h
      )
      SELECT id, case_id, from_status_id, previous_to_status_id, to_status_id, changed_at
      FROM ordered
      WHERE previous_to_status_id IS NOT NULL
        AND from_status_id IS NOT NULL
        AND from_status_id <> previous_to_status_id
    `)
  );

  add(
    "high",
    "duplicate-current-mediator-assignment",
    "Duplicate active mediator assignments",
    all(`
      SELECT case_id, COUNT(*) AS active_assignments
      FROM pim_mediator_assignments
      WHERE status = 'ACTIVE'
      GROUP BY case_id
      HAVING COUNT(*) > 1
    `)
  );

  add(
    "medium",
    "notice-invalid-service-state",
    "Notices with invalid service state combinations",
    all(`
      SELECT
        n.id AS notice_id,
        n.case_id,
        n.status AS notice_status,
        COUNT(sa.id) AS attempts,
        SUM(CASE WHEN sa.delivered_date IS NOT NULL THEN 1 ELSE 0 END) AS delivered_attempts,
        SUM(CASE WHEN sa.returned_date IS NOT NULL THEN 1 ELSE 0 END) AS returned_attempts
      FROM pim_notices n
      LEFT JOIN pim_service_attempts sa ON sa.notice_id = n.id
      GROUP BY n.id
      HAVING (
          n.status IN ('DISPATCHED', 'SERVED', 'RETURNED')
          AND attempts = 0
        )
        OR (
          delivered_attempts > 0
          AND returned_attempts > 0
        )
        OR (
          n.status = 'SERVED'
          AND delivered_attempts = 0
        )
        OR (
          n.status = 'RETURNED'
          AND returned_attempts = 0
        )
    `)
  );

  const openCases = all(
    `
    SELECT
      c.id,
      c.pim_number,
      s.code AS status_code,
      (
        SELECT t.id
        FROM pim_tasks t
        WHERE t.case_id = c.id
          AND t.status = 'PENDING'
        ORDER BY date(t.due_date), t.id
        LIMIT 1
      ) AS pending_task_id,
      (
        SELECT t.task_type_code
        FROM pim_tasks t
        WHERE t.case_id = c.id
          AND t.status = 'PENDING'
        ORDER BY date(t.due_date), t.id
        LIMIT 1
      ) AS pending_task_type_code,
      (
        SELECT ms.id
        FROM mediation_sessions ms
        WHERE ms.case_id = c.id
          AND ms.session_status = 'SCHEDULED'
        ORDER BY ms.sitting_number, ms.id
        LIMIT 1
      ) AS pending_session_id
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
    WHERE s.code NOT IN (${terminalPlaceholders})
  `,
    ...terminalList
  );

  add(
    "medium",
    "open-case-missing-action",
    "Open cases whose next action resolves to a missing page or no href",
    openCases
      .map((row) => ({
        ...row,
        action: getCaseAction(row),
      }))
      .filter((row) => !row.action.href || row.action.missingPage)
  );

  const pendingTasks = all(`
    SELECT
      t.id,
      t.case_id,
      t.task_type_code,
      (
        SELECT ms.id
        FROM mediation_sessions ms
        WHERE ms.case_id = t.case_id
          AND ms.session_status = 'SCHEDULED'
        ORDER BY ms.sitting_number, ms.id
        LIMIT 1
      ) AS session_id
    FROM pim_tasks t
    WHERE t.status = 'PENDING'
  `);

  add(
    "medium",
    "pending-task-missing-action",
    "Pending tasks whose action resolves to a missing page or no href",
    pendingTasks
      .map((row) => ({
        ...row,
        action: getTaskAction(row),
      }))
      .filter((row) => !row.action.href || row.action.missingPage)
  );

  add(
    "info",
    "table-counts",
    "Database table row counts",
    existingTables().map((table) => ({
      table,
      count: scalar(`SELECT COUNT(*) AS count FROM ${table}`),
    }))
  );
}

function printReport() {
  const order = {
    critical: 1,
    high: 2,
    medium: 3,
    low: 4,
    info: 5,
  };

  console.log("DLSA Nilgiris PIM production readiness audit");
  console.log(`Database: ${path.join(root, "database", "pim.db")}`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log("");

  for (const finding of findings.sort(
    (a, b) => order[a.severity] - order[b.severity]
  )) {
    console.log(
      `[${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message}`
    );
    console.log(`Count: ${finding.count}`);

    if (finding.rows.length) {
      console.table(finding.rows.slice(0, 25));
      if (finding.rows.length > 25) {
        console.log(`... ${finding.rows.length - 25} more row(s) not shown`);
      }
    }

    console.log("");
  }
}

auditDatabase();
printReport();

const blocking = findings.filter(
  (finding) =>
    ["critical", "high"].includes(finding.severity) &&
    finding.count > 0
);

process.exitCode = blocking.length ? 1 : 0;
