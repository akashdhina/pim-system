/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5H's mediator-registry read:
 * GET /api/pim/mediators/[id] (single-mediator detail - assignments,
 * sessions, aggregate counts). Completes the mediator roster's PostgreSQL
 * migration that Batch 1 started with the list endpoint
 * (lib/pim-data/mediators.js, unchanged, not touched here) and explicitly
 * deferred for POST/single-record GET/PATCH ("POST ... is NOT migrated in
 * Batch 1" - app/api/pim/mediators/route.js's own comment). See
 * docs/phase6-batch5h-mediator-registry-migration.md for the mapping.
 *
 * READ-ONLY and PostgreSQL-authoritative: shared getSql() client, no
 * transaction, no lock, no write, no SQLite, no fallback. Not gated by
 * case workflow status at all - a mediator is a standalone roster entity,
 * independent of T3/PIM-number.
 *
 * Faithful translations:
 *  - The mediator aggregate query is the SAME shape already proven in
 *    lib/pim-data/mediators.js's listMediators() (Batch 1) - same joins,
 *    same COUNT(DISTINCT ...) columns, same GROUP BY m.id functional-
 *    dependency pattern - just scoped to one id instead of a page.
 *  - assignments ORDER BY: CASE WHEN status='ACTIVE' THEN 0 ELSE 1 END,
 *    assignment_date DESC, id DESC - assignment_date is NOT NULL in both
 *    schemas, so no NULL-ordering divergence.
 *  - sessions ORDER BY: COALESCE(actual_date, scheduled_date) DESC, id DESC
 *    LIMIT 50 - BOTH date columns are nullable, so if a session somehow has
 *    neither set, SQLite's DESC puts NULLs LAST while PostgreSQL's default
 *    DESC puts NULLs FIRST (the opposite default from SQLite - the inverse
 *    of the NULLS-FIRST-in-ASC fix used elsewhere in this migration) ->
 *    explicit `NULLS LAST` preserves the SQLite order exactly.
 *
 * Wire compatibility (lib/pim-data/wire-compat.js, reused unchanged):
 * mediators.active, pim_mediator_assignments.deviation_from_rotation, and
 * mediation_sessions.{applicant_present,opposite_party_present,
 * effective_session,report_received} are native PostgreSQL booleans;
 * app/pim/mediators/[id]/page.tsx reads `mediator.active === 1` strictly,
 * so these are converted back to 1/0. created_at/updated_at are converted
 * to the SQLite CURRENT_TIMESTAMP text shape.
 */

const { getSql } = require("../pim-postgres");
const { toWire } = require("./wire-compat");

const MEDIATOR_WIRE = { flags: ["active"], timestamps: ["created_at", "updated_at"] };
const ASSIGNMENT_WIRE = { flags: ["deviation_from_rotation"] };
const SESSION_WIRE = {
  flags: ["applicant_present", "opposite_party_present", "effective_session", "report_received"],
  timestamps: ["created_at"],
};

async function getMediatorAggregatePg(sql, id) {
  const [row] = await sql`
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
    WHERE m.id = ${id}
    GROUP BY m.id
  `;

  return row ? toWire(row, MEDIATOR_WIRE) : null;
}

/*
 * Public: the aggregate mediator row alone (id, roster fields, and the
 * same COUNT(...) columns as listMediators()), with no assignments/
 * sessions. Used both by getMediatorDetailPg below and by
 * lib/pim-data/mediator-registry.js's PATCH, which re-fetches this exact
 * shape after an update - matching the SQLite route's own
 * `getMediator(id)` re-fetch-after-write pattern.
 */
async function getMediatorPg(id) {
  return getMediatorAggregatePg(getSql(), id);
}

/*
 * Returns { mediator, assignments, sessions } exactly as the SQLite GET
 * handler assembles it (the route derives `activeAssignments` itself, by
 * filtering `assignments` in JS - unchanged, not duplicated here).
 * Returns null when the mediator does not exist (route maps that to 404).
 */
async function getMediatorDetailPg(id) {
  const sql = getSql();

  const mediator = await getMediatorAggregatePg(sql, id);
  if (!mediator) return null;

  const [assignments, sessions] = await Promise.all([
    sql`
      SELECT
        a.*,
        c.pim_number,
        c.received_number,
        c.outcome_type,
        s.name AS status_name
      FROM pim_mediator_assignments a
      JOIN pim_cases c ON c.id = a.case_id
      LEFT JOIN status_master s ON s.id = c.current_status_id
      WHERE a.mediator_id = ${id}
      ORDER BY
        CASE WHEN a.status = 'ACTIVE' THEN 0 ELSE 1 END,
        a.assignment_date DESC,
        a.id DESC
    `,
    sql`
      SELECT
        ms.*,
        c.pim_number,
        c.received_number
      FROM mediation_sessions ms
      JOIN pim_mediator_assignments a ON a.id = ms.assignment_id
      JOIN pim_cases c ON c.id = ms.case_id
      WHERE a.mediator_id = ${id}
      ORDER BY COALESCE(ms.actual_date, ms.scheduled_date) DESC NULLS LAST, ms.id DESC
      LIMIT 50
    `,
  ]);

  return {
    mediator,
    assignments: assignments.map((row) => toWire(row, ASSIGNMENT_WIRE)),
    sessions: sessions.map((row) => toWire(row, SESSION_WIRE)),
  };
}

module.exports = {
  getMediatorPg,
  getMediatorDetailPg,
};
