/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL data-access for the dashboard - Batch 3 (GET /api/pim/dashboard).
 * 15 queries, ported 1:1 from app/api/pim/dashboard/route.js, same response
 * shape: { totals, cardCounts, statusCounts, taskTypeCounts, recentCases,
 * recentClosedCases, pendingTasks, dueToday, overdueTasks, approachingCases,
 * sittingsToday, expiringMediators, recentActivity, latestBackup }.
 *
 * "today" is computed once via lib/pim-time.js's officeDate() (Asia/Kolkata),
 * exactly as the SQLite route does, and passed as a bound parameter into
 * every query that needs it - never PostgreSQL's CURRENT_DATE/now(), which
 * would depend on the database connection's own TimeZone setting instead
 * of the office's fixed IST calendar date. No server-side timezone
 * behavior is introduced.
 *
 * mediators.active is a native boolean in PostgreSQL (Phase 2), not
 * SQLite's INTEGER CHECK(0,1) - `active = 1` -> `active = true`.
 *
 * NULLS FIRST fix (see lib/pim-data/cases.js for the full explanation):
 * applied to every "ORDER BY date(t.due_date), t.id"-style ordering below
 * that has no due_date IS NOT NULL filter already excluding NULLs
 * (pendingTasks, and the nested pending-task subqueries in recentCases
 * and approachingCases - 6 occurrences total in this file). Queries whose
 * WHERE clause already filters due_date/internal_60_day_date/
 * panel_valid_until NOT NULL (overdueTasks, approachingCases' own
 * ordering, expiringMediators) need no fix - no NULL can reach the
 * ordering there, in either database.
 */

const { getSql } = require("../pim-postgres");
const { getCaseAction, getTaskAction } = require("../pim-action-link");
const { officeDate } = require("../pim-time");
const { listBackups } = require("../pim-backup");

function today() {
  return officeDate();
}

function withAction(row) {
  return { ...row, action: getCaseAction(row) };
}

async function getDashboard() {
  const sql = getSql();
  const todayValue = today();

  const [totals] = await sql`
    SELECT
      COUNT(*)::int AS total_cases,
      SUM(CASE WHEN s.code NOT IN ('CLOSED_SETTLED','CLOSED_FAILED','CLOSED_NON_STARTER','WITHDRAWN') THEN 1 ELSE 0 END) AS open_cases,
      SUM(CASE WHEN s.code IN ('CLOSED_SETTLED','CLOSED_FAILED','CLOSED_NON_STARTER','WITHDRAWN') THEN 1 ELSE 0 END) AS closed_cases
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
  `;

  const [taskTotals] = await sql`
    SELECT
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_tasks,
      SUM(CASE WHEN status = 'PENDING' AND due_date IS NOT NULL AND due_date < ${todayValue} THEN 1 ELSE 0 END) AS overdue_tasks
    FROM pim_tasks
  `;

  const [deadline] = await sql`
    SELECT
      SUM(CASE
        WHEN s.code NOT IN ('CLOSED_SETTLED','CLOSED_FAILED','CLOSED_NON_STARTER','WITHDRAWN')
          AND c.internal_60_day_date IS NOT NULL
          AND c.internal_60_day_date BETWEEN ${todayValue} AND (${todayValue}::date + interval '7 day')
        THEN 1 ELSE 0 END) AS approaching_60_day,
      SUM(CASE
        WHEN s.code NOT IN ('CLOSED_SETTLED','CLOSED_FAILED','CLOSED_NON_STARTER','WITHDRAWN')
          AND c.internal_60_day_date IS NOT NULL
          AND c.internal_60_day_date < ${todayValue}
        THEN 1 ELSE 0 END) AS overdue_60_day
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
  `;

  const [mediatorTotals] = await sql`
    SELECT
      COUNT(*)::int AS total_mediators,
      SUM(CASE WHEN active = true THEN 1 ELSE 0 END) AS active_mediators
    FROM mediators
  `;

  const backups = listBackups();

  const statusCounts = await sql`
    SELECT s.code, s.name, COUNT(c.id)::int AS count
    FROM status_master s
    LEFT JOIN pim_cases c ON c.current_status_id = s.id
    GROUP BY s.id, s.code, s.name
    ORDER BY s.id
  `;

  const taskTypeCounts = await sql`
    SELECT
      COALESCE(t.task_type_code, 'UNSPECIFIED') AS code,
      COALESCE(tt.name, t.task_type_code, 'Unspecified') AS name,
      COUNT(*)::int AS count
    FROM pim_tasks t
    LEFT JOIN task_types tt ON tt.code = t.task_type_code
    WHERE t.status = 'PENDING'
    GROUP BY COALESCE(t.task_type_code, 'UNSPECIFIED'), COALESCE(tt.name, t.task_type_code, 'Unspecified')
    ORDER BY count DESC, code
  `;

  const [cardCounts] = await sql`
    SELECT
      SUM(CASE WHEN s.code = 'SCRUTINY_PENDING' THEN 1 ELSE 0 END) AS pending_scrutiny,
      SUM(CASE WHEN s.code = 'SECRETARY_APPROVAL_PENDING' THEN 1 ELSE 0 END) AS secretary_approval,
      SUM(CASE WHEN s.code = 'PIM_NUMBER_PENDING' THEN 1 ELSE 0 END) AS pim_number_pending,
      SUM(CASE WHEN s.code = 'FORM2_PENDING' THEN 1 ELSE 0 END) AS form2_pending,
      SUM(CASE WHEN s.code IN ('SERVICE_PENDING','NOTICE_RETURNED','ADDRESS_CORRECTION_PENDING','FINAL_NOTICE_PENDING','FINAL_NOTICE_ISSUED') THEN 1 ELSE 0 END) AS service_pending,
      SUM(CASE WHEN s.code IN ('OP_APPEARANCE_PENDING','OP_APPEARED','OP_CONSENT_PENDING','OP_CONSENTED','OP_REFUSED') THEN 1 ELSE 0 END) AS op_response_pending,
      SUM(CASE WHEN s.code = 'FEE_PENDING' THEN 1 ELSE 0 END) AS fee_pending,
      SUM(CASE WHEN s.code = 'MEDIATOR_ASSIGNMENT_PENDING' THEN 1 ELSE 0 END) AS mediator_assignment,
      SUM(CASE WHEN s.code IN ('MEDIATOR_ASSIGNED','MEDIATION_PENDING') THEN 1 ELSE 0 END) AS first_mediation,
      SUM(CASE WHEN s.code = 'MEDIATION_ONGOING' THEN 1 ELSE 0 END) AS session_recording,
      SUM(CASE WHEN s.code = 'OUTCOME_FORM_PENDING' THEN 1 ELSE 0 END) AS outcome_form,
      SUM(CASE WHEN s.code = 'AUTHORITY_DECISION_PENDING' THEN 1 ELSE 0 END) AS authority_decision,
      SUM(CASE WHEN s.code = 'CLOSED_SETTLED' THEN 1 ELSE 0 END) AS closed_settled,
      SUM(CASE WHEN s.code = 'CLOSED_FAILED' THEN 1 ELSE 0 END) AS closed_failed,
      SUM(CASE WHEN s.code = 'WITHDRAWN' THEN 1 ELSE 0 END) AS withdrawn,
      SUM(CASE WHEN s.code = 'CLOSED_NON_STARTER' THEN 1 ELSE 0 END) AS closed_non_starter
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
  `;

  const recentCasesRaw = await sql`
    SELECT
      c.id, c.pim_number, c.received_number, c.registration_date, c.internal_60_day_date, c.priority,
      s.code AS status_code, s.name AS status_name,
      (
        SELECT p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
        WHERE cp.case_id = c.id AND cp.role = 'APPLICANT'
        ORDER BY cp.is_primary DESC, cp.sequence_no LIMIT 1
      ) AS applicant_name,
      (
        SELECT t.id FROM pim_tasks t WHERE t.case_id = c.id AND t.status = 'PENDING'
        ORDER BY t.due_date NULLS FIRST, t.id LIMIT 1
      ) AS pending_task_id,
      (
        SELECT t.task_type_code FROM pim_tasks t WHERE t.case_id = c.id AND t.status = 'PENDING'
        ORDER BY t.due_date NULLS FIRST, t.id LIMIT 1
      ) AS pending_task_type_code
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
    ORDER BY COALESCE(c.registration_date, c.received_date) DESC, c.id DESC
    LIMIT 8
  `;
  const recentCases = recentCasesRaw.map(withAction);

  const recentClosedCasesRaw = await sql`
    SELECT
      c.id, c.pim_number, c.received_number, c.outcome_type, c.outcome_date, c.closed_at,
      s.code AS status_code, s.name AS status_name,
      (
        SELECT p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
        WHERE cp.case_id = c.id AND cp.role = 'APPLICANT'
        ORDER BY cp.is_primary DESC, cp.sequence_no LIMIT 1
      ) AS applicant_name
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
    WHERE s.code IN ('CLOSED_SETTLED','CLOSED_FAILED','CLOSED_NON_STARTER','WITHDRAWN')
    ORDER BY COALESCE(c.closed_at, c.outcome_date, c.updated_at) DESC, c.id DESC
    LIMIT 8
  `;
  const recentClosedCases = recentClosedCasesRaw.map(withAction);

  const pendingTasksRaw = await sql`
    SELECT
      t.*, c.pim_number, c.received_number, s.code AS case_status_code, s.name AS case_status_name,
      (
        SELECT ms.id FROM mediation_sessions ms
        WHERE ms.case_id = t.case_id AND ms.session_status = 'SCHEDULED'
          AND (t.due_date IS NULL OR ms.scheduled_date = t.due_date)
        ORDER BY ms.sitting_number, ms.id LIMIT 1
      ) AS session_id
    FROM pim_tasks t
    JOIN pim_cases c ON c.id = t.case_id
    JOIN status_master s ON s.id = c.current_status_id
    WHERE t.status = 'PENDING'
    ORDER BY t.due_date NULLS FIRST, t.id
    LIMIT 8
  `;
  const pendingTasks = pendingTasksRaw.map((task) => ({ ...task, action: getTaskAction(task) }));

  function taskBaseSelect(whereFragment, orderFragment) {
    return sql`
      SELECT
        t.id, t.case_id, t.task_type_code,
        COALESCE(tt.name, t.description) AS task_name,
        t.description, t.status, t.due_date, t.priority,
        c.pim_number, c.received_number,
        s.code AS case_status_code, s.name AS case_status_name,
        (
          SELECT p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id AND cp.role = 'APPLICANT'
          ORDER BY cp.is_primary DESC, cp.sequence_no LIMIT 1
        ) AS applicant_name,
        (
          SELECT ms.id FROM mediation_sessions ms
          WHERE ms.case_id = t.case_id AND ms.session_status = 'SCHEDULED'
            AND (t.due_date IS NULL OR ms.scheduled_date = t.due_date)
          ORDER BY ms.sitting_number, ms.id LIMIT 1
        ) AS session_id
      FROM pim_tasks t
      JOIN pim_cases c ON c.id = t.case_id
      JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN task_types tt ON tt.code = t.task_type_code
      ${whereFragment}
      ${orderFragment}
    `;
  }

  const dueTodayRaw = await taskBaseSelect(
    sql`WHERE t.status = 'PENDING' AND t.due_date = ${todayValue}`,
    sql`ORDER BY t.priority DESC, t.id LIMIT 8`
  );
  const dueToday = dueTodayRaw.map((task) => ({ ...task, overdue: 0, action: getTaskAction(task) }));

  // due_date IS NOT NULL already excludes NULLs here - no NULLS FIRST needed.
  const overdueTasksRaw = await taskBaseSelect(
    sql`WHERE t.status = 'PENDING' AND t.due_date IS NOT NULL AND t.due_date < ${todayValue}`,
    sql`ORDER BY t.due_date, t.id LIMIT 8`
  );
  const overdueTasks = overdueTasksRaw.map((task) => ({ ...task, overdue: 1, action: getTaskAction(task) }));

  // internal_60_day_date IS NOT NULL already excludes NULLs from this
  // query's own ORDER BY; the 3 nested pending-task subqueries below have
  // no such filter and do need NULLS FIRST.
  const approachingCasesRaw = await sql`
    SELECT
      c.id, c.pim_number, c.received_number, c.internal_60_day_date, c.priority,
      s.code AS status_code, s.name AS status_name,
      (
        SELECT p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
        WHERE cp.case_id = c.id AND cp.role = 'APPLICANT'
        ORDER BY cp.is_primary DESC, cp.sequence_no LIMIT 1
      ) AS applicant_name,
      (
        SELECT t.id FROM pim_tasks t WHERE t.case_id = c.id AND t.status = 'PENDING'
        ORDER BY t.due_date NULLS FIRST, t.id LIMIT 1
      ) AS pending_task_id,
      (
        SELECT t.task_type_code FROM pim_tasks t WHERE t.case_id = c.id AND t.status = 'PENDING'
        ORDER BY t.due_date NULLS FIRST, t.id LIMIT 1
      ) AS pending_task_type_code,
      (
        SELECT t.description FROM pim_tasks t WHERE t.case_id = c.id AND t.status = 'PENDING'
        ORDER BY t.due_date NULLS FIRST, t.id LIMIT 1
      ) AS pending_task_description
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
    WHERE s.code NOT IN ('CLOSED_SETTLED','CLOSED_FAILED','CLOSED_NON_STARTER','WITHDRAWN')
      AND c.internal_60_day_date IS NOT NULL
      AND c.internal_60_day_date BETWEEN ${todayValue} AND (${todayValue}::date + interval '7 day')
    ORDER BY c.internal_60_day_date, c.id
    LIMIT 8
  `;
  const approachingCases = approachingCasesRaw.map(withAction);

  const sittingsToday = await sql`
    SELECT
      ms.id, ms.case_id, ms.sitting_number, ms.scheduled_date, ms.actual_date, ms.session_status,
      c.pim_number, c.received_number, m.name AS mediator_name,
      (
        SELECT p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
        WHERE cp.case_id = c.id AND cp.role = 'APPLICANT'
        ORDER BY cp.is_primary DESC, cp.sequence_no LIMIT 1
      ) AS applicant_name
    FROM mediation_sessions ms
    JOIN pim_cases c ON c.id = ms.case_id
    JOIN pim_mediator_assignments ma ON ma.id = ms.assignment_id
    JOIN mediators m ON m.id = ma.mediator_id
    WHERE COALESCE(ms.actual_date, ms.scheduled_date) = ${todayValue}
    ORDER BY ms.sitting_number, ms.id
    LIMIT 8
  `;

  // panel_valid_until IS NOT NULL + BETWEEN already excludes NULLs - no fix needed.
  const expiringMediators = await sql`
    SELECT id, name, category, panel_valid_until, contact_phone
    FROM mediators
    WHERE active = true
      AND panel_valid_until IS NOT NULL
      AND panel_valid_until BETWEEN ${todayValue} AND (${todayValue}::date + interval '30 day')
    ORDER BY panel_valid_until, name
    LIMIT 8
  `;

  const recentActivity = await sql`
    SELECT
      a.id, a.table_name, a.record_id, a.action, a.changed_at, a.reason,
      u.display_name AS user_name, u.designation AS user_designation,
      c.pim_number, c.received_number
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.changed_by
    LEFT JOIN pim_cases c ON (
      (a.table_name = 'pim_cases' AND c.id = a.record_id)
      OR (
        a.table_name <> 'pim_cases'
        AND c.id = (
          SELECT case_id FROM pim_tasks WHERE a.table_name = 'pim_tasks' AND id = a.record_id LIMIT 1
        )
      )
    )
    ORDER BY a.id DESC
    LIMIT 10
  `;

  return {
    totals: {
      totalCases: totals.total_cases || 0,
      openCases: totals.open_cases || 0,
      closedCases: totals.closed_cases || 0,
      pendingTasks: taskTotals.pending_tasks || 0,
      overdueTasks: taskTotals.overdue_tasks || 0,
      approaching60Day: deadline.approaching_60_day || 0,
      overdue60Day: deadline.overdue_60_day || 0,
      totalMediators: mediatorTotals.total_mediators || 0,
      activeMediators: mediatorTotals.active_mediators || 0,
    },
    cardCounts,
    statusCounts,
    taskTypeCounts,
    recentCases,
    recentClosedCases,
    pendingTasks,
    dueToday,
    overdueTasks,
    approachingCases,
    sittingsToday,
    expiringMediators,
    recentActivity,
    latestBackup: backups[0] || null,
  };
}

module.exports = {
  getDashboard,
};
