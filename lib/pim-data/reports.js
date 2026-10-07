/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL port of the operational reports module (production-
 * completion sprint, 2026-10-07): lib/pim-reports.js, routed from
 * app/api/pim/reports/route.js. See docs/phase6-reports-migration.md.
 *
 * lib/pim-reports.js's 14 report definitions (columns, filters,
 * sortColumns, dateColumn, defaultSort/Direction, searchColumns,
 * tieBreaker) are dialect-neutral metadata and are REUSED directly, not
 * duplicated. Only the SQL fragments that are genuinely SQLite dialect
 * (select/baseWhere/groupBy/totalsSelect) are overridden here, report by
 * report, for the specific incompatibilities found:
 *
 *   - `julianday(a) - julianday(b)` -> `(a::date - b::date)` (PostgreSQL
 *     date subtraction already yields an integer day count).
 *   - `date(x, '+7 day')` -> `(x::date + 7)`.
 *   - `date(col)` wrapping an already-`date`-typed column (pure ORDER BY
 *     noise in the SQLite original) -> removed, not translated.
 *   - `col = 1` / `col = 0` on real PostgreSQL boolean columns
 *     (is_current, effective_session, applicant_present,
 *     opposite_party_present, report_received, active) -> `col = true`
 *     / `col = false`.
 *   - `MAX(a, b)` as SQLite's 2-argument SCALAR max -> `GREATEST(a, b)`
 *     (PostgreSQL's MAX is aggregate-only; this is a real
 *     incompatibility, not a style choice).
 *   - documents/non_starters/settlements/failures' "does a document
 *     exist" checks required `file_path IS NOT NULL` - which is now
 *     NEVER true for a Postgres-generated Form-2/3/4/5 document (the
 *     no-storage model stores render_data instead, see
 *     docs/phase6-form3-documents-migration.md and
 *     docs/phase6-outcome-documents-migration.md). Left unchanged, these
 *     reports would show ZERO documents for every case migrated through
 *     this sprint - a real regression, not a dialect nuance. Widened to
 *     accept EITHER file_path OR render_data, matching the same fix
 *     already applied to lib/pim-data/outcome.js's approveOutcomeTx.
 *   - LIKE -> ILIKE for search, matching SQLite's case-insensitive
 *     default (PostgreSQL's LIKE is case-sensitive) - a behavior
 *     preservation, not a behavior change.
 *
 * Everything else (string concatenation, CAST(...AS INTEGER), CASE,
 * GROUP BY a primary key with other same-table columns selected
 * un-aggregated - valid in PostgreSQL via functional dependency on the
 * primary key, exactly as SQLite already allowed it loosely) is
 * untouched: it is already valid, standard SQL.
 */

const { getSql } = require("../pim-postgres");
const { REPORTS, normalizedReportList, partyNameSelect } = require("../pim-reports");

const DOCUMENT_EXISTS_LEGACY = "d.file_path IS NOT NULL\n            AND TRIM(d.file_path) <> ''";
const DOCUMENT_EXISTS_PG = "(d.file_path IS NOT NULL AND TRIM(d.file_path) <> '') OR d.render_data IS NOT NULL";

const PG_OVERRIDES = {
  overdue: {
    select: REPORTS.overdue.select.replace(
      "CAST(julianday(?) - julianday(t.due_date) AS INTEGER) AS days_overdue",
      "(?::date - t.due_date) AS days_overdue"
    ),
  },
  mediators: {
    select: REPORTS.mediators.select
      .replace("CASE WHEN m.active = 1 THEN 'Yes' ELSE 'No' END", "CASE WHEN m.active = true THEN 'Yes' ELSE 'No' END")
      .replace("SUM(CASE WHEN ms.effective_session = 1 THEN 1 ELSE 0 END)", "SUM(CASE WHEN ms.effective_session = true THEN 1 ELSE 0 END)"),
  },
  sessions: {
    select: REPORTS.sessions.select
      .replace("WHEN ms.applicant_present = 1 AND ms.opposite_party_present = 1", "WHEN ms.applicant_present = true AND ms.opposite_party_present = true")
      .replace("WHEN ms.applicant_present = 1", "WHEN ms.applicant_present = true")
      .replace("WHEN ms.opposite_party_present = 1", "WHEN ms.opposite_party_present = true")
      .replace("CASE WHEN ms.effective_session = 1 THEN 'Yes' ELSE 'No' END", "CASE WHEN ms.effective_session = true THEN 'Yes' ELSE 'No' END")
      .replace("CASE WHEN ms.report_received = 1 THEN 'Received' ELSE 'Pending' END", "CASE WHEN ms.report_received = true THEN 'Received' ELSE 'Pending' END"),
    totalsSelect: REPORTS.sessions.totalsSelect
      .replace(/ms\.effective_session = 1/g, "ms.effective_session = true"),
  },
  monitoring: {
    select: REPORTS.monitoring.select
      .replace(
        "CAST(julianday(c.internal_60_day_date) - julianday(?) AS INTEGER) AS days_remaining",
        "(c.internal_60_day_date - ?::date) AS days_remaining"
      )
      .replace("date(?, '+7 day')", "(?::date + 7)"),
  },
  outcomes: {
    select: REPORTS.outcomes.select.replace(
      "ROUND(AVG(julianday(c.outcome_date) - julianday(c.registration_date)), 1)",
      "ROUND(AVG(c.outcome_date - c.registration_date), 1)"
    ),
  },
  documents: {
    baseWhere: ["(d.file_path IS NOT NULL AND TRIM(d.file_path) <> '') OR d.render_data IS NOT NULL"],
    select: REPORTS.documents.select.replace(
      "CASE WHEN d.is_current = 1 THEN 'Yes' ELSE 'No' END",
      "CASE WHEN d.is_current = true THEN 'Yes' ELSE 'No' END"
    ),
  },
  address_correction: {
    select: REPORTS.address_correction.select
      .replace(
        "CAST(julianday(?) - julianday(sa.returned_date) AS INTEGER) AS age_days",
        "(?::date - sa.returned_date) AS age_days"
      )
      .replace("ORDER BY date(t2.due_date), t2.id", "ORDER BY t2.due_date, t2.id"),
  },
  final_notice_pending: {
    select: REPORTS.final_notice_pending.select.replace("ORDER BY date(t2.due_date), t2.id", "ORDER BY t2.due_date, t2.id"),
  },
  fees_pending: {
    select: REPORTS.fees_pending.select.replace(
      "MAX(COALESCE(f.amount_due, 0) - COALESCE(f.amount_received, 0), 0) AS balance",
      "GREATEST(COALESCE(f.amount_due, 0) - COALESCE(f.amount_received, 0), 0) AS balance"
    ),
  },
  non_starters: {
    select: REPORTS.non_starters.select.replace(DOCUMENT_EXISTS_LEGACY, DOCUMENT_EXISTS_PG).replace("d.is_current = 1", "d.is_current = true"),
  },
  settlements: {
    select: REPORTS.settlements.select.replace(DOCUMENT_EXISTS_LEGACY, DOCUMENT_EXISTS_PG).replace("d.is_current = 1", "d.is_current = true"),
  },
  failures: {
    select: REPORTS.failures.select.replace(DOCUMENT_EXISTS_LEGACY, DOCUMENT_EXISTS_PG).replace("d.is_current = 1", "d.is_current = true"),
  },
  pending: {
    select: REPORTS.pending.select.replace("ORDER BY date(t2.due_date), t2.id", "ORDER BY t2.due_date, t2.id"),
  },
};

function pgReport(key) {
  const base = REPORTS[key] || REPORTS.register;
  const overrides = PG_OVERRIDES[key] || {};
  return { ...base, ...overrides };
}

function positiveInt(value, fallback, max = 100) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

function addSearchPg(report, where, params, search) {
  const text = String(search || "").trim();
  if (!text) return;

  // ILIKE, not LIKE: PostgreSQL's LIKE is case-sensitive, SQLite's is
  // not by default - this preserves the search behavior staff already
  // have, not a new one.
  const clauses = (report.searchColumns || []).map((column) => `${column} ILIKE ?`);
  const searchParams = clauses.map(() => `%${text}%`);

  if (report.searchExists) {
    clauses.push(report.searchExists.replace(/LIKE \?/, "ILIKE ?"));
    searchParams.push(`%${text}%`);
  }

  if (clauses.length) {
    where.push(`(${clauses.join(" OR ")})`);
    params.push(...searchParams);
  }
}

function addFilterPg(report, where, params, name, value) {
  const text = String(value || "").trim();
  if (!text) return;

  const filterMap = report.filterMap || {};
  const common = {
    status: "s.code", outcome: "c.outcome_type", priority: "c.priority", category: "dc.code",
    active: "m.active", documentType: "d.document_type", action: "a.action",
    sessionStatus: "ms.session_status", mediatorId: "m.id", noticeType: "n.notice_type",
    noticeStatus: "n.status", returnReason: "sa.return_reason", feeStatus: "f.status",
  };
  const column = filterMap[name] || common[name];
  if (!column) return;

  if (name === "active") {
    // m.active is a real boolean here, not SQLite's 0/1 integer.
    where.push(`${column} = ?`);
    params.push(text === "1" || text.toLowerCase() === "true");
    return;
  }

  where.push(`${column} = ?`);
  params.push(name === "mediatorId" ? Number(text) : text);
}

/*
 * Converts every `?` in a fully-assembled SQL string to sequential
 * PostgreSQL $1,$2,... placeholders, in the same left-to-right order
 * postgres.js's sql.unsafe() requires - this is exactly the same
 * positional order SQLite's `?` already relied on, so no param
 * reordering is needed, only renumbering.
 */
function toDollarPlaceholders(sqlText) {
  let i = 0;
  return sqlText.replace(/\?/g, () => `$${++i}`);
}

function buildReportQueryPg(key, searchParams) {
  const report = pgReport(key);
  const page = positiveInt(searchParams.get("page"), 1, 100000);
  const pageSize = positiveInt(searchParams.get("pageSize"), 20, 100);
  const offset = (page - 1) * pageSize;
  const where = [...(report.baseWhere || [])];
  const selectParams = report.selectParams ? report.selectParams() : [];
  const baseParamsValue = typeof report.baseParams === "function" ? report.baseParams() : report.baseParams || [];
  const params = [...baseParamsValue];

  addSearchPg(report, where, params, searchParams.get("search"));

  for (const filterName of report.filters || []) {
    addFilterPg(report, where, params, filterName, searchParams.get(filterName));
  }

  const dateFrom = String(searchParams.get("dateFrom") || "").trim();
  if (dateFrom) {
    where.push(`${report.dateColumn} >= ?`);
    params.push(dateFrom);
  }

  const dateTo = String(searchParams.get("dateTo") || "").trim();
  if (dateTo) {
    where.push(`${report.dateColumn} <= ?`);
    params.push(dateTo);
  }

  const sortKey = String(searchParams.get("sort") || report.defaultSort);
  const sortColumn = report.sortColumns[sortKey] || report.sortColumns[report.defaultSort];
  const direction = String(searchParams.get("direction") || report.defaultDirection).toLowerCase() === "asc" ? "ASC" : "DESC";
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const groupBySql = report.groupBy || "";
  const baseSql = `${report.select} ${report.from} ${whereSql} ${groupBySql}`;
  // PostgreSQL defaults to NULLS LAST for ASC and NULLS FIRST for DESC -
  // the OPPOSITE of SQLite, which treats NULL as the smallest possible
  // value (NULLS FIRST for ASC, NULLS LAST for DESC). Several sortable
  // columns here are nullable (due_date, closed_at, mediator_name, ...),
  // so left at Postgres's default this would silently reorder reports
  // staff already know the shape of. Matched explicitly, not left to
  // either engine's default.
  const nullsClause = direction === "ASC" ? "NULLS FIRST" : "NULLS LAST";
  const orderSql = `ORDER BY ${sortColumn} ${direction} ${nullsClause}, ${report.tieBreaker} DESC`;
  const queryParams = [...selectParams, ...params];

  let totalsSqlRaw = null;
  let totalsQueryParams = null;
  if (report.totalsSelect) {
    const totalsSelectParams = report.totalsSelectParams ? report.totalsSelectParams() : selectParams;
    totalsSqlRaw = `SELECT ${report.totalsSelect} ${report.from} ${whereSql}`;
    totalsQueryParams = [...totalsSelectParams, ...params];
  }

  return {
    report,
    page,
    pageSize,
    offset,
    countSql: toDollarPlaceholders(`SELECT COUNT(*) AS count FROM (${baseSql}) report_count`),
    countParams: queryParams,
    rowsSql: toDollarPlaceholders(`${baseSql} ${orderSql} LIMIT ? OFFSET ?`),
    rowsParams: [...queryParams, pageSize, offset],
    exportSqlFor: (cap) => ({
      sql: toDollarPlaceholders(`${baseSql} ${orderSql} LIMIT ?`),
      params: [...queryParams, cap],
    }),
    totalsSql: totalsSqlRaw ? toDollarPlaceholders(totalsSqlRaw) : null,
    totalsParams: totalsQueryParams,
  };
}

async function runReportPg(key, searchParams) {
  const sql = getSql();
  const built = buildReportQueryPg(key, searchParams);

  const [countRow] = await sql.unsafe(built.countSql, built.countParams);
  const rows = await sql.unsafe(built.rowsSql, built.rowsParams);
  const totals = built.totalsSql ? (await sql.unsafe(built.totalsSql, built.totalsParams))[0] : null;

  return { report: built.report, page: built.page, pageSize: built.pageSize, count: Number(countRow.count) || 0, rows, totals };
}

async function exportReportPg(key, searchParams, cap) {
  const sql = getSql();
  const built = buildReportQueryPg(key, searchParams);
  const { sql: exportSql, params } = built.exportSqlFor(cap);
  return sql.unsafe(exportSql, params);
}

module.exports = {
  buildReportQueryPg,
  runReportPg,
  exportReportPg,
  normalizedReportList,
  partyNameSelect,
};
