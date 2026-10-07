/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL data-access for the cases list - Batch 3 (GET /api/pim/cases).
 * Mirrors app/api/pim/cases/route.js's SQLite implementation exactly:
 * same filters, same defaults, same ordering, same pagination semantics,
 * same per-row N+1 pending-task lookup, same response shape
 * { rows, pagination: { page, pageSize, total, totalPages } }.
 *
 * One semantic fix applied throughout, not a stylistic one: SQLite's
 * default ORDER BY treats NULL as the smallest value (NULLs sort FIRST in
 * ascending order); PostgreSQL's default is the opposite (NULLs sort LAST
 * in ascending order). Every "ORDER BY date(t.due_date), t.id" in the
 * SQLite version relies on a NULL due_date sorting first (an
 * undated-therefore-most-urgent task wins the "the one pending task to
 * show" pick) - left untranslated, PostgreSQL would instead pick whichever
 * dated task sorts earliest and never surface the undated one until every
 * dated task was exhausted. Fixed with an explicit NULLS FIRST wherever
 * due_date isn't already filtered NOT NULL (see pendingTaskForCase below).
 */

const { getSql } = require("../pim-postgres");
const { getCaseAction } = require("../pim-action-link");
const { officeDate } = require("../pim-time");

const CLOSED_STATUSES = [
  "CLOSED_SETTLED",
  "CLOSED_FAILED",
  "CLOSED_NON_STARTER",
  "WITHDRAWN",
];

function today() {
  return officeDate();
}

function positiveInt(value, fallback, max = 100) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    return fallback;
  }

  return Math.min(number, max);
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

/*
 * Same 9 optional filters as the SQLite route, same parameter names, same
 * defaults (absent/empty = not applied). Every value is bound through the
 * tagged template; nothing from searchParams is ever concatenated into
 * the query text.
 */
function buildWhereClause(sql, searchParams) {
  const conditions = [];

  const pimNumber = clean(searchParams.get("pimNumber"));
  if (pimNumber) conditions.push(sql`c.pim_number LIKE ${`%${pimNumber}%`}`);

  const receivedNumber = clean(searchParams.get("receivedNumber"));
  if (receivedNumber) conditions.push(sql`c.received_number LIKE ${`%${receivedNumber}%`}`);

  const partyName = clean(searchParams.get("partyName"));
  if (partyName) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM pim_case_parties cp
      JOIN pim_parties p ON p.id = cp.party_id
      WHERE cp.case_id = c.id AND p.name LIKE ${`%${partyName}%`}
    )`);
  }

  const status = clean(searchParams.get("status"));
  if (status) conditions.push(sql`s.code = ${status}`);

  const outcome = clean(searchParams.get("outcome"));
  if (outcome) conditions.push(sql`c.outcome_type = ${outcome}`);

  const registrationFrom = clean(searchParams.get("registrationFrom"));
  if (registrationFrom) conditions.push(sql`c.registration_date >= ${registrationFrom}`);

  const registrationTo = clean(searchParams.get("registrationTo"));
  if (registrationTo) conditions.push(sql`c.registration_date <= ${registrationTo}`);

  const openClosed = clean(searchParams.get("openClosed"));
  if (openClosed === "open") {
    conditions.push(sql`s.code NOT IN ${sql(CLOSED_STATUSES)}`);
  } else if (openClosed === "closed") {
    conditions.push(sql`s.code IN ${sql(CLOSED_STATUSES)}`);
  }

  const deadline = clean(searchParams.get("deadline"));
  const todayValue = today();
  if (deadline === "overdue") {
    conditions.push(sql`c.internal_60_day_date IS NOT NULL AND c.internal_60_day_date < ${todayValue}`);
  } else if (deadline === "approaching") {
    // date(?, '+7 day') -> ::date + interval '7 day'
    conditions.push(
      sql`c.internal_60_day_date IS NOT NULL AND c.internal_60_day_date BETWEEN ${todayValue} AND (${todayValue}::date + interval '7 day')`
    );
  } else if (deadline === "due") {
    conditions.push(sql`c.internal_60_day_date IS NOT NULL`);
  }

  if (conditions.length === 0) return sql``;

  return conditions.reduce(
    (acc, condition, index) => (index === 0 ? sql`WHERE ${condition}` : sql`${acc} AND ${condition}`)
  );
}

/*
 * Same per-case lookup the SQLite route runs once per row (an N+1 query
 * pattern, preserved exactly rather than optimized away - the SQLite
 * implementation is the contract being ported, not redesigned).
 */
async function pendingTaskForCase(sql, caseId) {
  const [task] = await sql`
    SELECT
      t.id AS pending_task_id,
      t.task_type_code AS pending_task_type_code,
      t.description AS pending_task_description,
      t.due_date AS pending_task_due_date,
      t.priority AS pending_task_priority,
      (
        SELECT ms.id
        FROM mediation_sessions ms
        WHERE ms.case_id = t.case_id
          AND ms.session_status = 'SCHEDULED'
          AND (t.due_date IS NULL OR ms.scheduled_date = t.due_date)
        ORDER BY ms.sitting_number, ms.id
        LIMIT 1
      ) AS pending_session_id
    FROM pim_tasks t
    WHERE t.case_id = ${caseId}
      AND t.status = 'PENDING'
    ORDER BY t.due_date NULLS FIRST, t.id
    LIMIT 1
  `;
  return task || {};
}

async function listCases(searchParams) {
  const sql = getSql();

  const page = positiveInt(searchParams.get("page"), 1, 100000);
  const pageSize = positiveInt(searchParams.get("pageSize"), 20, 100);
  const offset = (page - 1) * pageSize;

  const whereClause = buildWhereClause(sql, searchParams);

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
    ${whereClause}
  `;

  /*
   * COALESCE(registration_date, received_date) never actually evaluates
   * NULL - received_date is NOT NULL in the schema - so no NULLS
   * modifier is needed on this ORDER BY regardless of direction.
   */
  const rows = await sql`
    SELECT
      c.id,
      c.pim_number,
      c.received_number,
      c.registration_date,
      c.internal_60_day_date,
      c.priority,
      c.outcome_type,
      s.code AS status_code,
      s.name AS status_name,
      (
        SELECT p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
        WHERE cp.case_id = c.id AND cp.role = 'APPLICANT'
        ORDER BY cp.is_primary DESC, cp.sequence_no LIMIT 1
      ) AS applicant_name,
      (
        SELECT p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
        WHERE cp.case_id = c.id AND cp.role = 'OPPOSITE_PARTY'
        ORDER BY cp.is_primary DESC, cp.sequence_no LIMIT 1
      ) AS opposite_party_name
    FROM pim_cases c
    JOIN status_master s ON s.id = c.current_status_id
    ${whereClause}
    ORDER BY COALESCE(c.registration_date, c.received_date) DESC, c.id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const data = await Promise.all(
    rows.map(async (row) => {
      const pending = await pendingTaskForCase(sql, row.id);
      const enriched = { ...row, ...pending };
      return { ...enriched, action: getCaseAction(enriched) };
    })
  );

  return {
    rows: data,
    pagination: {
      page,
      pageSize,
      total: count || 0,
      totalPages: Math.max(1, Math.ceil((count || 0) / pageSize)),
    },
  };
}

module.exports = {
  listCases,
  CLOSED_STATUSES,
};
