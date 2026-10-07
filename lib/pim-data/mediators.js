/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL data-access for mediator listing - Batch 1's first migrated
 * read-only route (GET /api/pim/mediators). Mirrors the response shape of
 * the SQLite mediatorListQuery()/GET handler in
 * app/api/pim/mediators/route.js exactly, so the route change is a
 * one-line swap rather than a rewrite.
 *
 * Mutations (POST /api/pim/mediators) stay on SQLite in Batch 1 - not
 * ported here.
 */

const { getSql } = require("../pim-postgres");

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
 * Whitelisted ORDER BY targets only - never derived from raw user input.
 * sortKey is looked up against this fixed map before use, exactly like the
 * SQLite version's sortColumns map; the resulting string is one of these
 * 12 fixed literals, never user-supplied text, which is what makes
 * interpolating it via sql.unsafe() below safe (Postgres has no way to
 * parameterize a column/alias name, only values).
 */
const SORT_COLUMNS = {
  name: "m.name",
  category: "m.category",
  enrollment_no: "m.enrollment_no",
  empanelment_date: "m.empanelment_date",
  panel_valid_until: "m.panel_valid_until",
  active: "m.active",
  active_assignments: "active_assignments",
  total_assignments: "total_assignments",
  total_sessions: "total_sessions",
  effective_sessions: "effective_sessions",
  settled_cases: "settled_cases",
  failed_cases: "failed_cases",
};

/*
 * Builds the dynamic WHERE clause as a single composed, fully-parameterized
 * postgres.js fragment. Every value (search text, dates, the active flag)
 * is bound through the tagged template - never string-concatenated into
 * the query text.
 */
function buildWhereClause(sql, searchParams) {
  const conditions = [];

  const search = clean(searchParams.get("search"));
  if (search) {
    const like = `%${search}%`;
    conditions.push(
      sql`(m.name LIKE ${like} OR m.enrollment_no LIKE ${like} OR m.category LIKE ${like} OR m.contact_phone LIKE ${like} OR m.email LIKE ${like})`
    );
  }

  const enrollmentNo = clean(searchParams.get("enrollmentNo"));
  if (enrollmentNo) {
    conditions.push(sql`m.enrollment_no LIKE ${`%${enrollmentNo}%`}`);
  }

  const category = clean(searchParams.get("category"));
  if (category) {
    conditions.push(sql`m.category = ${category}`);
  }

  // mediators.active is boolean in PostgreSQL (Phase 2), unlike SQLite's
  // INTEGER CHECK(0,1) - the "1"/"0" query-string value maps to true/false.
  const active = clean(searchParams.get("active"));
  if (active === "1" || active === "0") {
    conditions.push(sql`m.active = ${active === "1"}`);
  }

  const empanelmentFrom = clean(searchParams.get("empanelmentFrom"));
  if (empanelmentFrom) {
    conditions.push(sql`m.empanelment_date >= ${empanelmentFrom}`);
  }

  const empanelmentTo = clean(searchParams.get("empanelmentTo"));
  if (empanelmentTo) {
    conditions.push(sql`m.empanelment_date <= ${empanelmentTo}`);
  }

  const validFrom = clean(searchParams.get("validFrom"));
  if (validFrom) {
    conditions.push(sql`m.panel_valid_until >= ${validFrom}`);
  }

  const validTo = clean(searchParams.get("validTo"));
  if (validTo) {
    conditions.push(sql`m.panel_valid_until <= ${validTo}`);
  }

  const officeToday = new Date().toISOString().slice(0, 10);
  const validity = clean(searchParams.get("validity"));
  if (validity === "expired") {
    conditions.push(
      sql`m.panel_valid_until IS NOT NULL AND m.panel_valid_until < ${officeToday}`
    );
  } else if (validity === "expiring") {
    // date(?, '+30 day') -> date + interval '30 day'
    conditions.push(
      sql`m.panel_valid_until IS NOT NULL AND m.panel_valid_until BETWEEN ${officeToday} AND (${officeToday}::date + interval '30 day')`
    );
  } else if (validity === "valid") {
    conditions.push(
      sql`(m.panel_valid_until IS NULL OR m.panel_valid_until >= ${officeToday})`
    );
  }

  if (conditions.length === 0) return sql``;

  return conditions.reduce(
    (acc, condition, index) =>
      index === 0 ? sql`WHERE ${condition}` : sql`${acc} AND ${condition}`
  );
}

async function listMediators(searchParams) {
  const sql = getSql();

  const page = positiveInt(searchParams.get("page"), 1, 100000);
  const pageSize = positiveInt(searchParams.get("pageSize"), 20, 100);
  const offset = (page - 1) * pageSize;

  const whereClause = buildWhereClause(sql, searchParams);

  const sortKey = clean(searchParams.get("sort")) || "name";
  const sortColumn = SORT_COLUMNS[sortKey] || SORT_COLUMNS.name;
  const directionSql =
    String(searchParams.get("direction") || "asc").toLowerCase() === "desc"
      ? sql`DESC`
      : sql`ASC`;

  /*
   * GROUP BY m.id (not every selected m.* column) is valid PostgreSQL: it
   * recognizes m.id as mediators' primary key and allows other columns
   * from the same table via functional dependency, the same way SQLite's
   * (looser) GROUP BY already permitted.
   */
  const baseSelect = (extraOrder) => sql`
    SELECT
      m.id,
      m.name,
      m.enrollment_no,
      m.category,
      m.contact_phone,
      m.email,
      m.empanelment_order_no,
      m.empanelment_date,
      m.panel_valid_until,
      m.active,
      m.rotation_order,
      m.conflict_declaration_date,
      m.remarks,
      m.created_at,
      m.updated_at,
      COUNT(DISTINCT a.id) AS total_assignments,
      COUNT(DISTINCT CASE WHEN a.status = 'ACTIVE' THEN a.id END) AS active_assignments,
      COUNT(DISTINCT ms.id) AS total_sessions,
      COUNT(DISTINCT CASE WHEN ms.effective_session THEN ms.id END) AS effective_sessions,
      COUNT(DISTINCT CASE WHEN c.outcome_type = 'SETTLED' THEN c.id END) AS settled_cases,
      COUNT(DISTINCT CASE WHEN c.outcome_type = 'FAILED' THEN c.id END) AS failed_cases
    FROM mediators m
    LEFT JOIN pim_mediator_assignments a ON a.mediator_id = m.id
    LEFT JOIN mediation_sessions ms ON ms.assignment_id = a.id
    LEFT JOIN pim_cases c ON c.id = a.case_id
    ${whereClause}
    GROUP BY m.id
    ${extraOrder || sql``}
  `;

  const [{ count: total }] = await sql`
    SELECT COUNT(*)::int AS count FROM (${baseSelect()}) AS mediator_count
  `;

  const rows = await baseSelect(
    sql`ORDER BY ${sql.unsafe(sortColumn)} ${directionSql}, m.id DESC LIMIT ${pageSize} OFFSET ${offset}`
  );

  const categories = await sql`
    SELECT DISTINCT category
    FROM mediators
    WHERE category IS NOT NULL
      AND TRIM(category) <> ''
    ORDER BY category
  `;

  return {
    rows,
    categories: categories.map((row) => row.category),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

module.exports = {
  listMediators,
};
