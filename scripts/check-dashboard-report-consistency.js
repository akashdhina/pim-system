/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../lib/db");
const { buildReportQuery } = require("../lib/pim-reports");
const { officeDate } = require("../lib/pim-time");

function getReportTotal(report) {
  const query = buildReportQuery(
    report,
    new URLSearchParams({
      report,
      page: "1",
      pageSize: "1",
    })
  );

  return db.prepare(query.countSql).get(...query.queryParams).count || 0;
}

const dashboardTotals = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN s.code NOT IN (
      'CLOSED_SETTLED',
      'CLOSED_FAILED',
      'CLOSED_NON_STARTER',
      'WITHDRAWN'
    ) THEN 1 ELSE 0 END) AS open,
    SUM(CASE WHEN s.code IN (
      'CLOSED_SETTLED',
      'CLOSED_FAILED',
      'CLOSED_NON_STARTER',
      'WITHDRAWN'
    ) THEN 1 ELSE 0 END) AS closed
  FROM pim_cases c
  JOIN status_master s ON s.id = c.current_status_id
`).get();

const taskTotals = db.prepare(`
  SELECT
    COUNT(*) AS total_tasks,
    SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_tasks,
    SUM(CASE
      WHEN status = 'PENDING'
        AND due_date IS NOT NULL
        AND due_date < ?
      THEN 1 ELSE 0 END) AS overdue_tasks
  FROM pim_tasks
`).get(officeDate());

const documentTotals = db.prepare(`
  SELECT
    COUNT(*) AS all_documents,
    COALESCE(
  SUM(
    CASE
      WHEN file_path IS NOT NULL
        AND TRIM(file_path) <> ''
      THEN 1
      ELSE 0
    END
  ),
  0
) AS stored_documents
  FROM pim_documents
`).get();

const outcomeCounts = db.prepare(`
  SELECT outcome_type, COUNT(*) AS count
  FROM pim_cases
  WHERE outcome_type IS NOT NULL
  GROUP BY outcome_type
  ORDER BY outcome_type
`).all();

const sixtyDay = db.prepare(`
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
  JOIN status_master s ON s.id = c.current_status_id
`).get(officeDate(), officeDate(), officeDate());

const reportTotals = {
  register: getReportTotal("register"),
  pending: getReportTotal("pending"),
  mediators: getReportTotal("mediators"),
  sessions: getReportTotal("sessions"),
  monitoring: getReportTotal("monitoring"),
  outcomes: getReportTotal("outcomes"),
  documents: getReportTotal("documents"),
  audit: getReportTotal("audit"),
};

console.log(
  JSON.stringify(
    {
      officeDate: officeDate(),
      dashboardTotals,
      taskTotals,
      sixtyDay,
      documentTotals,
      outcomeCounts,
      reportTotals,
      checks: {
        registerMatchesTotalCases:
          reportTotals.register === dashboardTotals.total,
        pendingReportMatchesPendingOpenCases:
          reportTotals.pending <= taskTotals.pending_tasks,
        documentReportUsesStoredDocumentsOnly:
          reportTotals.documents === documentTotals.stored_documents,
      },
    },
    null,
    2
  )
);
