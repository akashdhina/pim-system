/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../lib/db");
const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");
const {
  getCaseAction,
  getTaskAction,
} = require("../../../../lib/pim-action-link");
const {
  officeDate,
} = require("../../../../lib/pim-time");
const {
  listBackups,
} = require("../../../../lib/pim-backup");
const {
  getDashboard,
} = require("../../../../lib/pim-data/dashboard");

/*
 * Batch 3 (Phase 6): GET below now calls lib/pim-data/dashboard.js
 * (PostgreSQL). Everything below is kept, unused by GET, purely as an
 * instant rollback - see app/api/pim/mediators/route.js for the pattern
 * established in Batch 1.
 */
function today() {
  return officeDate();
}

function withAction(row) {
  return {
    ...row,
    action: getCaseAction(row),
  };
}

export async function GET(request) {
  try {
    requirePermission(request, "READ_CASE");

    // Batch 3 (Phase 6): migrated to PostgreSQL via lib/pim-data/dashboard.js.
    // The permission check above is unchanged - still the SQLite-backed
    // lib/pim-auth.js session/user resolution, run before any data access.
    const data = await getDashboard();

    return Response.json({
      success: true,
      data,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error("PIM dashboard error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load PIM dashboard.",
      },
      { status: 500 }
    );
  }
}

/*
 * Kept below, unused, as the SQLite rollback path for GET (Batch 3).
 */
async function sqliteGetDashboardRollbackReference(request) {
  try {
    requirePermission(request, "READ_CASE");

    const todayValue = today();

    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total_cases,
        SUM(CASE WHEN s.code NOT IN (
          'CLOSED_SETTLED',
          'CLOSED_FAILED',
          'CLOSED_NON_STARTER',
          'WITHDRAWN'
        ) THEN 1 ELSE 0 END) AS open_cases,
        SUM(CASE WHEN s.code IN (
          'CLOSED_SETTLED',
          'CLOSED_FAILED',
          'CLOSED_NON_STARTER',
          'WITHDRAWN'
        ) THEN 1 ELSE 0 END) AS closed_cases
      FROM pim_cases c
      JOIN status_master s
        ON s.id = c.current_status_id
    `).get();

    const taskTotals = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END)
          AS pending_tasks,
        SUM(CASE
          WHEN status = 'PENDING'
            AND due_date IS NOT NULL
            AND due_date < ?
          THEN 1 ELSE 0 END) AS overdue_tasks
      FROM pim_tasks
    `).get(todayValue);

    const deadline = db.prepare(`
      SELECT
        SUM(CASE
          WHEN s.code NOT IN (
            'CLOSED_SETTLED',
            'CLOSED_FAILED',
            'CLOSED_NON_STARTER',
            'WITHDRAWN'
          )
          AND c.internal_60_day_date IS NOT NULL
          AND c.internal_60_day_date BETWEEN ? AND date(?, '+7 day')
          THEN 1 ELSE 0 END) AS approaching_60_day,
        SUM(CASE
          WHEN s.code NOT IN (
            'CLOSED_SETTLED',
            'CLOSED_FAILED',
            'CLOSED_NON_STARTER',
            'WITHDRAWN'
          )
          AND c.internal_60_day_date IS NOT NULL
          AND c.internal_60_day_date < ?
          THEN 1 ELSE 0 END) AS overdue_60_day
      FROM pim_cases c
      JOIN status_master s
        ON s.id = c.current_status_id
    `).get(todayValue, todayValue, todayValue);

    const mediatorTotals = db.prepare(`
      SELECT
        COUNT(*) AS total_mediators,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_mediators
      FROM mediators
    `).get();
    const backups = listBackups();

    const statusCounts = db.prepare(`
      SELECT
        s.code,
        s.name,
        COUNT(c.id) AS count
      FROM status_master s
      LEFT JOIN pim_cases c
        ON c.current_status_id = s.id
      GROUP BY s.id, s.code, s.name
      ORDER BY s.id
    `).all();

    const taskTypeCounts = db.prepare(`
      SELECT
        COALESCE(t.task_type_code, 'UNSPECIFIED') AS code,
        COALESCE(tt.name, t.task_type_code, 'Unspecified') AS name,
        COUNT(*) AS count
      FROM pim_tasks t
      LEFT JOIN task_types tt
        ON tt.code = t.task_type_code
      WHERE t.status = 'PENDING'
      GROUP BY COALESCE(t.task_type_code, 'UNSPECIFIED'),
        COALESCE(tt.name, t.task_type_code, 'Unspecified')
      ORDER BY count DESC, code
    `).all();

    const cardCounts = db.prepare(`
      SELECT
        SUM(CASE WHEN s.code = 'SCRUTINY_PENDING' THEN 1 ELSE 0 END)
          AS pending_scrutiny,
        SUM(CASE WHEN s.code = 'SECRETARY_APPROVAL_PENDING' THEN 1 ELSE 0 END)
          AS secretary_approval,
        SUM(CASE WHEN s.code = 'FORM2_PENDING' THEN 1 ELSE 0 END)
          AS form2_pending,
        SUM(CASE WHEN s.code IN ('SERVICE_PENDING','NOTICE_RETURNED','ADDRESS_CORRECTION_PENDING','FINAL_NOTICE_PENDING','FINAL_NOTICE_ISSUED') THEN 1 ELSE 0 END)
          AS service_pending,
        SUM(CASE WHEN s.code IN ('OP_APPEARANCE_PENDING','OP_APPEARED','OP_CONSENT_PENDING','OP_CONSENTED','OP_REFUSED') THEN 1 ELSE 0 END)
          AS op_response_pending,
        SUM(CASE WHEN s.code = 'FEE_PENDING' THEN 1 ELSE 0 END)
          AS fee_pending,
        SUM(CASE WHEN s.code = 'MEDIATOR_ASSIGNMENT_PENDING' THEN 1 ELSE 0 END)
          AS mediator_assignment,
        SUM(CASE WHEN s.code IN ('MEDIATOR_ASSIGNED','MEDIATION_PENDING') THEN 1 ELSE 0 END)
          AS first_mediation,
        SUM(CASE WHEN s.code = 'MEDIATION_ONGOING' THEN 1 ELSE 0 END)
          AS session_recording,
        SUM(CASE WHEN s.code = 'OUTCOME_FORM_PENDING' THEN 1 ELSE 0 END)
          AS outcome_form,
        SUM(CASE WHEN s.code = 'AUTHORITY_DECISION_PENDING' THEN 1 ELSE 0 END)
          AS authority_decision,
        SUM(CASE WHEN s.code = 'CLOSED_SETTLED' THEN 1 ELSE 0 END)
          AS closed_settled,
        SUM(CASE WHEN s.code = 'CLOSED_FAILED' THEN 1 ELSE 0 END)
          AS closed_failed,
        SUM(CASE WHEN s.code = 'WITHDRAWN' THEN 1 ELSE 0 END)
          AS withdrawn,
        SUM(CASE WHEN s.code = 'CLOSED_NON_STARTER' THEN 1 ELSE 0 END)
          AS closed_non_starter
      FROM pim_cases c
      JOIN status_master s
        ON s.id = c.current_status_id
    `).get();

    const recentCases = db.prepare(`
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.registration_date,
        c.internal_60_day_date,
        c.priority,
        s.code AS status_code,
        s.name AS status_name,
        (
          SELECT p.name
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND cp.role = 'APPLICANT'
          ORDER BY cp.is_primary DESC, cp.sequence_no
          LIMIT 1
        ) AS applicant_name,
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
        ) AS pending_task_type_code
      FROM pim_cases c
      JOIN status_master s
        ON s.id = c.current_status_id
      ORDER BY COALESCE(c.registration_date, c.received_date) DESC,
        c.id DESC
      LIMIT 8
    `).all().map(withAction);

    const recentClosedCases = db.prepare(`
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.outcome_type,
        c.outcome_date,
        c.closed_at,
        s.code AS status_code,
        s.name AS status_name,
        (
          SELECT p.name
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND cp.role = 'APPLICANT'
          ORDER BY cp.is_primary DESC, cp.sequence_no
          LIMIT 1
        ) AS applicant_name
      FROM pim_cases c
      JOIN status_master s
        ON s.id = c.current_status_id
      WHERE s.code IN (
        'CLOSED_SETTLED',
        'CLOSED_FAILED',
        'CLOSED_NON_STARTER',
        'WITHDRAWN'
      )
      ORDER BY COALESCE(c.closed_at, c.outcome_date, c.updated_at) DESC,
        c.id DESC
      LIMIT 8
    `).all().map(withAction);

    const pendingTasks = db.prepare(`
      SELECT
        t.*,
        c.pim_number,
        c.received_number,
        s.code AS case_status_code,
        s.name AS case_status_name,
        (
          SELECT ms.id
          FROM mediation_sessions ms
          WHERE ms.case_id = t.case_id
            AND ms.session_status = 'SCHEDULED'
            AND (
              t.due_date IS NULL
              OR ms.scheduled_date = t.due_date
            )
          ORDER BY ms.sitting_number, ms.id
          LIMIT 1
        ) AS session_id
      FROM pim_tasks t
      JOIN pim_cases c ON c.id = t.case_id
      JOIN status_master s ON s.id = c.current_status_id
      WHERE t.status = 'PENDING'
      ORDER BY date(t.due_date), t.id
      LIMIT 8
    `).all().map((task) => ({
      ...task,
      action: getTaskAction(task),
    }));

    const taskBaseSelect = `
      SELECT
        t.id,
        t.case_id,
        t.task_type_code,
        COALESCE(tt.name, t.description) AS task_name,
        t.description,
        t.status,
        t.due_date,
        t.priority,
        c.pim_number,
        c.received_number,
        s.code AS case_status_code,
        s.name AS case_status_name,
        (
          SELECT p.name
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND cp.role = 'APPLICANT'
          ORDER BY cp.is_primary DESC, cp.sequence_no
          LIMIT 1
        ) AS applicant_name,
        (
          SELECT ms.id
          FROM mediation_sessions ms
          WHERE ms.case_id = t.case_id
            AND ms.session_status = 'SCHEDULED'
            AND (
              t.due_date IS NULL
              OR ms.scheduled_date = t.due_date
            )
          ORDER BY ms.sitting_number, ms.id
          LIMIT 1
        ) AS session_id
      FROM pim_tasks t
      JOIN pim_cases c ON c.id = t.case_id
      JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN task_types tt ON tt.code = t.task_type_code
    `;

    const dueToday = db.prepare(`
      ${taskBaseSelect}
      WHERE t.status = 'PENDING'
        AND t.due_date = ?
      ORDER BY t.priority DESC, t.id
      LIMIT 8
    `).all(todayValue).map((task) => ({
      ...task,
      overdue: 0,
      action: getTaskAction(task),
    }));

    const overdueTasks = db.prepare(`
      ${taskBaseSelect}
      WHERE t.status = 'PENDING'
        AND t.due_date IS NOT NULL
        AND t.due_date < ?
      ORDER BY date(t.due_date), t.id
      LIMIT 8
    `).all(todayValue).map((task) => ({
      ...task,
      overdue: 1,
      action: getTaskAction(task),
    }));

    const approachingCases = db.prepare(`
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.internal_60_day_date,
        c.priority,
        s.code AS status_code,
        s.name AS status_name,
        (
          SELECT p.name
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND cp.role = 'APPLICANT'
          ORDER BY cp.is_primary DESC, cp.sequence_no
          LIMIT 1
        ) AS applicant_name,
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
          SELECT t.description
          FROM pim_tasks t
          WHERE t.case_id = c.id
            AND t.status = 'PENDING'
          ORDER BY date(t.due_date), t.id
          LIMIT 1
        ) AS pending_task_description
      FROM pim_cases c
      JOIN status_master s ON s.id = c.current_status_id
      WHERE s.code NOT IN (
        'CLOSED_SETTLED',
        'CLOSED_FAILED',
        'CLOSED_NON_STARTER',
        'WITHDRAWN'
      )
        AND c.internal_60_day_date IS NOT NULL
        AND c.internal_60_day_date BETWEEN ? AND date(?, '+7 day')
      ORDER BY date(c.internal_60_day_date), c.id
      LIMIT 8
    `).all(todayValue, todayValue).map(withAction);

    const sittingsToday = db.prepare(`
      SELECT
        ms.id,
        ms.case_id,
        ms.sitting_number,
        ms.scheduled_date,
        ms.actual_date,
        ms.session_status,
        c.pim_number,
        c.received_number,
        m.name AS mediator_name,
        (
          SELECT p.name
          FROM pim_case_parties cp
          JOIN pim_parties p ON p.id = cp.party_id
          WHERE cp.case_id = c.id
            AND cp.role = 'APPLICANT'
          ORDER BY cp.is_primary DESC, cp.sequence_no
          LIMIT 1
        ) AS applicant_name
      FROM mediation_sessions ms
      JOIN pim_cases c ON c.id = ms.case_id
      JOIN pim_mediator_assignments ma ON ma.id = ms.assignment_id
      JOIN mediators m ON m.id = ma.mediator_id
      WHERE COALESCE(ms.actual_date, ms.scheduled_date) = ?
      ORDER BY ms.sitting_number, ms.id
      LIMIT 8
    `).all(todayValue);

    const expiringMediators = db.prepare(`
      SELECT
        id,
        name,
        category,
        panel_valid_until,
        contact_phone
      FROM mediators
      WHERE active = 1
        AND panel_valid_until IS NOT NULL
        AND panel_valid_until BETWEEN ? AND date(?, '+30 day')
      ORDER BY date(panel_valid_until), name
      LIMIT 8
    `).all(todayValue, todayValue);

    const recentActivity = db.prepare(`
      SELECT
        a.id,
        a.table_name,
        a.record_id,
        a.action,
        a.changed_at,
        a.reason,
        u.display_name AS user_name,
        u.designation AS user_designation,
        c.pim_number,
        c.received_number
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.changed_by
      LEFT JOIN pim_cases c
        ON (
          (a.table_name = 'pim_cases' AND c.id = a.record_id)
          OR (
            a.table_name <> 'pim_cases'
            AND c.id = (
              SELECT case_id
              FROM pim_tasks
              WHERE a.table_name = 'pim_tasks'
                AND id = a.record_id
              LIMIT 1
            )
          )
        )
      ORDER BY a.id DESC
      LIMIT 10
    `).all();

    return Response.json({
      success: true,
      data: {
        totals: {
          totalCases: totals.total_cases || 0,
          openCases: totals.open_cases || 0,
          closedCases: totals.closed_cases || 0,
          pendingTasks: taskTotals.pending_tasks || 0,
          overdueTasks: taskTotals.overdue_tasks || 0,
          approaching60Day:
            deadline.approaching_60_day || 0,
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
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error("PIM dashboard error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load PIM dashboard.",
      },
      { status: 500 }
    );
  }
}
