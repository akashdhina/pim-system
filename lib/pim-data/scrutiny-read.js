/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5F's first migrated read
 * loader: the scrutiny page/approval page case loader -
 * lib/pim-scrutiny.js's getScrutinyCase(), behind
 * GET /api/pim/scrutiny/[id]. Matches it query-for-query, ordering-for-
 * ordering and response-field-for-response-field. See
 * docs/phase6-batch5f-read-loaders-migration.md for the mapping.
 *
 * READ-ONLY: plain getSql() reads, no transaction, no locks, no writes,
 * and no SQLite of any kind - this loader is PostgreSQL-authoritative for
 * everything it returns. (SQLite's version also opens no transaction.)
 *
 * Deliberate, output-neutral differences from the SQLite version:
 *  - The SQLite version runs one query per party for addresses and one per
 *    party for advocates (N+1). Here each is ONE query for the whole case
 *    (`party_id` restricted to the case's parties / `case_id = ?`), grouped
 *    by party in JS with the same per-party ORDER BY. Each party still gets
 *    exactly the rows its own query would have returned, in the same
 *    order - just without 2N round-trips (which matter against a remote
 *    pooler).
 *  - The independent reads run concurrently (Promise.all). The case is
 *    read first, and a missing case throws before anything else is
 *    queried, exactly like SQLite.
 *  - The parties ORDER BY gains `cp.id` as a final tiebreaker. SQLite's
 *    ORDER BY (role rank, sequence_no) has no tiebreaker, so rows tied on
 *    both were returned in scan (rowid) order in practice; PostgreSQL
 *    guarantees no order among ties, so `cp.id` pins the same order. It
 *    changes nothing where SQLite's order was well defined.
 *
 * Wire compatibility (see lib/pim-data/wire-compat.js): booleans are
 * returned as 1/0 and instants as SQLite's text shapes, because the pages
 * compare `party.is_primary === 1` strictly.
 */

const { getSql } = require("../pim-postgres");
const { toWire } = require("./wire-compat");

const CASE_WIRE = { timestamps: ["created_at", "updated_at", "closed_at"] };
const PARTY_WIRE = { flags: ["is_primary"] };
const ADDRESS_WIRE = { flags: ["is_current"], timestamps: ["created_at"] };
const DOCUMENT_WIRE = {
  flags: ["generated_by_system", "is_current"],
  timestamps: ["created_at"],
};
const SCRUTINY_WIRE = { instants: ["scrutinised_at"] };
const DOCKET_WIRE = { timestamps: ["created_at"] };

/*
 * SQLite: throws Error("PIM case not found.") when the row is missing;
 * the route's generic catch turns that into HTTP 400 (NOT 404) - that
 * existing behavior is preserved, not "fixed".
 */
async function getCaseForScrutinyPg(sql, caseId) {
  const [row] = await sql`
    SELECT
      c.*,
      sm.code AS status_code,
      sm.name AS status_name
    FROM pim_cases c
    LEFT JOIN status_master sm
      ON sm.id = c.current_status_id
    WHERE c.id = ${caseId}
    LIMIT 1
  `;

  if (!row) {
    throw new Error("PIM case not found.");
  }

  return toWire(row, CASE_WIRE);
}

function groupBy(rows, key) {
  const groups = new Map();

  for (const row of rows) {
    const list = groups.get(row[key]);
    if (list) list.push(row);
    else groups.set(row[key], [row]);
  }

  return groups;
}

async function getScrutinyCasePg(caseId) {
  /*
   * Any id that cannot be a real bigint key (e.g. 1e20 from a long digit
   * string) is simply "not found", as it is in SQLite - never a PostgreSQL
   * "out of range for type bigint" error surfaced to the user.
   */
  if (!Number.isSafeInteger(caseId)) {
    throw new Error("PIM case not found.");
  }

  const sql = getSql();

  const caseRow = await getCaseForScrutinyPg(sql, caseId);

  const [
    partyRows,
    addressRows,
    advocateRows,
    feeRows,
    documentRows,
    scrutinyRows,
    docketRows,
  ] = await Promise.all([
    sql`
      SELECT
        cp.id AS case_party_id,
        cp.party_id,
        cp.role,
        cp.sequence_no,
        cp.is_primary,
        p.name,
        p.entity_type
      FROM pim_case_parties cp
      JOIN pim_parties p
        ON p.id = cp.party_id
      WHERE cp.case_id = ${caseId}
      ORDER BY
        CASE
          WHEN cp.role = 'APPLICANT' THEN 1
          WHEN cp.role = 'OPPOSITE_PARTY' THEN 2
          ELSE 3
        END,
        cp.sequence_no,
        cp.id
    `,

    // Per-party `SELECT * FROM pim_addresses WHERE party_id = ? ORDER BY id`,
    // fetched once for every party on the case, ordered party_id, id.
    sql`
      SELECT a.*
      FROM pim_addresses a
      WHERE a.party_id IN (
        SELECT cp.party_id
        FROM pim_case_parties cp
        WHERE cp.case_id = ${caseId}
      )
      ORDER BY a.party_id, a.id
    `,

    // Per-party advocates (case_id = ? AND party_id = ? AND to_date IS NULL
    // ORDER BY ca.id), fetched once for the case and grouped by party_id.
    sql`
      SELECT
        ca.*,
        a.name AS advocate_name,
        a.enrollment_no,
        a.phone,
        a.email,
        a.address AS advocate_address
      FROM pim_case_advocates ca
      JOIN pim_advocates a
        ON a.id = ca.advocate_id
      WHERE ca.case_id = ${caseId}
        AND ca.to_date IS NULL
      ORDER BY ca.id
    `,

    sql`
      SELECT *
      FROM pim_fees
      WHERE case_id = ${caseId}
      ORDER BY id
    `,

    sql`
      SELECT
        id, case_id, notice_id, document_type, document_title, document_date,
        file_path, generated_by_system, version_no, is_current, remarks,
        created_by, created_at
      FROM pim_documents
      WHERE case_id = ${caseId}
      ORDER BY id
    `,

    sql`
      SELECT *
      FROM pim_scrutiny
      WHERE case_id = ${caseId}
      LIMIT 1
    `,

    sql`
      SELECT
        d.*,
        e.code AS event_code,
        e.name AS event_name
      FROM pim_docket d
      LEFT JOIN event_types e
        ON e.id = d.event_type_id
      WHERE d.case_id = ${caseId}
      ORDER BY d.id DESC
    `,
  ]);

  const addressesByParty = groupBy(addressRows, "party_id");
  const advocatesByParty = groupBy(advocateRows, "party_id");

  const parties = partyRows.map((row) => ({
    ...toWire(row, PARTY_WIRE),
    addresses: (addressesByParty.get(row.party_id) || []).map((address) =>
      toWire(address, ADDRESS_WIRE)
    ),
    advocates: (advocatesByParty.get(row.party_id) || []).map((advocate) => ({
      ...advocate,
    })),
  }));

  return {
    case: caseRow,
    parties,
    fees: feeRows.map((fee) => ({ ...fee })),
    documents: documentRows.map((document) => toWire(document, DOCUMENT_WIRE)),
    /*
     * SQLite's getExistingScrutiny() returns `undefined` (not null) when
     * there is no row, so the key is OMITTED from the JSON response. That
     * is preserved exactly: `undefined`, not null.
     */
    scrutiny: scrutinyRows[0]
      ? toWire(scrutinyRows[0], SCRUTINY_WIRE)
      : undefined,
    docket: docketRows.map((entry) => toWire(entry, DOCKET_WIRE)),
  };
}

module.exports = {
  getScrutinyCasePg,
};
