/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5H's mediator-registry
 * mutations: POST /api/pim/mediators (create) and
 * PATCH /api/pim/mediators/[id] (update). Completes the mediator roster's
 * PostgreSQL migration Batch 1 explicitly deferred - see
 * app/api/pim/mediators/route.js's own header comment ("POST ... is NOT
 * migrated in Batch 1") and
 * docs/phase6-batch5h-mediator-registry-migration.md.
 *
 * Not gated by case workflow status, T3, or PIM-number allocation at all -
 * a mediator is a standalone roster entity.
 *
 * Pure JS validation (parseMediatorBody/validateMediatorInput/
 * validatePatch/validateEmail/validatePhone) stays in the routes,
 * UNCHANGED - it never touched the database in the SQLite version either,
 * so duplicating it here would only risk the two copies drifting. Only the
 * DB-touching operations (duplicate-enrollment check, insert, update,
 * audit_log) live here.
 *
 * Each mutation runs inside ONE withTransaction(...): INSERT/UPDATE the
 * mediator row and INSERT its audit_log row atomically. The SQLite
 * originals did NOT wrap these two statements in a transaction at all
 * (confirmed by re-reading app/api/pim/mediators/route.js and
 * mediators/[id]/route.js) - a pre-existing gap where a failed audit_log
 * insert could leave the mediator write committed with no audit trail.
 * Wrapping both writes in a real transaction here is strictly safer and
 * changes no observable success-path behavior (same rows, same values);
 * it only makes the failure path atomic instead of silently partial,
 * which is the kind of small, non-behavior-changing correctness
 * improvement this migration's own precedent already established
 * (Batch 5E's task-completion guard, Batch 1's read-only foundation).
 *
 * No PostgreSQL/SQLite mixing: every statement uses either the shared
 * getSql() client (for the duplicate-enrollment/current-row reads, which
 * do not need to be inside the write transaction) or the transaction-
 * scoped tx client - never both in the same statement, and SQLite is
 * never touched.
 */

const { getSql, withTransaction } = require("../pim-postgres");
const { getMediatorPg } = require("./mediator-registry-read");
const { toWire } = require("./wire-compat");

const MEDIATOR_ROW_WIRE = { flags: ["active"], timestamps: ["created_at", "updated_at"] };

/*
 * Matches SQLite's two call shapes exactly:
 *  - create:  WHERE active=1 AND enrollment_no=? AND (?IS NULL OR id<>?)  (exceptId = null)
 *  - update:  WHERE active=1 AND enrollment_no=? AND id<>?                (exceptId = the mediator's own id)
 * A falsy enrollmentNo short-circuits to null without a query, like both originals.
 */
async function checkDuplicateActiveEnrollmentPg(enrollmentNo, exceptId = null) {
  if (!enrollmentNo) return null;

  const sql = getSql();
  const [row] = exceptId === null
    ? await sql`SELECT id, name FROM mediators WHERE active = true AND enrollment_no = ${enrollmentNo} LIMIT 1`
    : await sql`SELECT id, name FROM mediators WHERE active = true AND enrollment_no = ${enrollmentNo} AND id <> ${exceptId} LIMIT 1`;

  return row || null;
}

/*
 * The raw (non-aggregate) row, for PATCH's pre-validation "current" lookup
 * - exactly what SQLite's `db.prepare('SELECT * FROM mediators WHERE id=?').get(id)`
 * returned, not the aggregate-with-counts shape.
 */
async function getMediatorRawPg(id) {
  const sql = getSql();
  const [row] = await sql`SELECT * FROM mediators WHERE id = ${id}`;
  return row ? toWire(row, MEDIATOR_ROW_WIRE) : null;
}

/*
 * `input` is the ALREADY-VALIDATED, already-defaulted object the route's
 * existing parseMediatorBody()/validateMediatorInput() produced - column
 * names, not camelCase (name, category, enrollment_no, contact_phone,
 * email, empanelment_order_no, empanelment_date, panel_valid_until,
 * active (1/0), rotation_order, conflict_declaration_date, remarks).
 * Returns the raw inserted row (RETURNING *), matching the SQLite POST's
 * own simple re-select (no aggregate counts - a brand-new mediator has
 * none to show).
 */
async function createMediatorPg(input, userId) {
  return withTransaction(async (tx) => {
    const [row] = await tx`
      INSERT INTO mediators (
        name, category, enrollment_no, contact_phone, email,
        empanelment_order_no, empanelment_date, panel_valid_until,
        active, rotation_order, conflict_declaration_date, remarks
      )
      VALUES (
        ${input.name}, ${input.category}, ${input.enrollment_no}, ${input.contact_phone}, ${input.email},
        ${input.empanelment_order_no}, ${input.empanelment_date}, ${input.panel_valid_until},
        ${Boolean(input.active)}, ${input.rotation_order}, ${input.conflict_declaration_date}, ${input.remarks}
      )
      RETURNING *
    `;

    await tx`
      INSERT INTO audit_log (table_name, record_id, action, new_value, changed_by, reason)
      VALUES (
        'mediators', ${row.id}, 'INSERT',
        ${JSON.stringify({ name: input.name, enrollment_no: input.enrollment_no, category: input.category, active: Boolean(input.active) })},
        ${userId}, 'Mediator added through mediator register.'
      )
    `;

    return toWire(row, MEDIATOR_ROW_WIRE);
  });
}

/*
 * `updates` is a { db_column: value } object built by the route from
 * ONLY the fields the caller actually supplied (matches SQLite's dynamic
 * `SET col = ?, col = ?, ...` - only touches supplied columns; every other
 * column is left exactly as stored). `oldValues`/`newValues` are the
 * plain objects the route already builds for the audit_log JSON (same
 * shape as the SQLite version). Returns the aggregate mediator row
 * (matching the SQLite route's own `getMediator(id)` re-fetch after PATCH).
 */
async function updateMediatorPg(id, updates, { oldValues, newValues, userId, reason }) {
  const columns = Object.keys(updates);

  await withTransaction(async (tx) => {
    // One combined UPDATE (matching the SQLite original's single dynamic
    // `SET col=?, col=?, ...` statement), built as one composed fragment -
    // the same "reduce over sql`` fragments" technique this codebase
    // already uses for dynamic WHERE clauses (lib/pim-data/mediators.js,
    // lib/pim-data/cases.js), applied here to a dynamic SET list instead.
    let setClause = columns.reduce((acc, column, index) => {
      const value = column === "active" ? Boolean(updates[column]) : updates[column];
      const assignment = tx`${tx(column)} = ${value}`;
      return index === 0 ? assignment : tx`${acc}, ${assignment}`;
    }, tx``);
    setClause = tx`${setClause}, updated_at = CURRENT_TIMESTAMP`;

    await tx`UPDATE mediators SET ${setClause} WHERE id = ${id}`;

    await tx`
      INSERT INTO audit_log (table_name, record_id, action, old_value, new_value, changed_by, reason)
      VALUES ('mediators', ${id}, 'UPDATE', ${JSON.stringify(oldValues)}, ${JSON.stringify(newValues)}, ${userId}, ${reason})
    `;
  });

  return getMediatorPg(id);
}

module.exports = {
  checkDuplicateActiveEnrollmentPg,
  getMediatorRawPg,
  createMediatorPg,
  updateMediatorPg,
};
