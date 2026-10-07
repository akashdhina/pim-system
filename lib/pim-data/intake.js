/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5C's first migrated
 * mutation: new PIM application intake (transaction T1 in
 * docs/phase6-transaction-readiness.md). Matches
 * lib/pim.js's createReceivedPimApplication() exactly: same
 * validation (reused directly, not duplicated), same statement
 * order, same response shape (a plain numeric case id). See
 * docs/phase6-batch5c-intake-migration.md for the full
 * statement-by-statement SQLite -> PostgreSQL mapping this file
 * implements.
 *
 * Runs entirely inside one withTransaction(...) callback - every
 * statement uses the transaction-scoped `tx` client, never a second,
 * un-transacted getSql() call and never the SQLite `db` singleton.
 * Nothing in this file reads or writes SQLite. The acting user's
 * identity is resolved via SQLite (auth) BEFORE this function is
 * invoked - unchanged, see app/api/pim/received/route.js - and only
 * the already-resolved numeric userId crosses that boundary as a
 * plain value, never a live SQLite read/write.
 *
 * Intake does not generate a PIM number (pim_number is inserted as
 * NULL, exactly like the SQLite version - registration/numbering
 * happens only at Secretary approval, a different, not-yet-migrated
 * transaction). The MAX+1-over-LIKE-scan concurrency hazard the
 * readiness audit flagged for generatePimNumber() therefore does not
 * apply to this transaction at all - see the Batch 5C report.
 */

const { withTransaction } = require("../pim-postgres");
const { validateReceivedApplication } = require("../pim");

async function addPartiesPg(tx, caseId, parties, role) {
  if (!Array.isArray(parties) || parties.length === 0) {
    throw new Error(`${role}: at least one party is required.`);
  }

  for (let index = 0; index < parties.length; index += 1) {
    const party = parties[index];

    if (!party.name || !party.name.trim()) {
      throw new Error(`${role} ${index + 1}: party name is required.`);
    }

    const [partyRow] = await tx`
      INSERT INTO pim_parties (name, entity_type)
      VALUES (${party.name.trim()}, ${party.entityType || "INDIVIDUAL"})
      RETURNING id
    `;
    const partyId = partyRow.id;

    // is_primary is a native PostgreSQL boolean (Phase 2) - the first
    // party in each role's array is primary, exactly like SQLite's
    // `index === 0 ? 1 : 0`.
    await tx`
      INSERT INTO pim_case_parties (case_id, party_id, role, sequence_no, is_primary)
      VALUES (${caseId}, ${partyId}, ${role}, ${index + 1}, ${index === 0})
    `;

    if (Array.isArray(party.addresses)) {
      for (const address of party.addresses) {
        if (!address.addressLine1) {
          continue;
        }

        await tx`
          INSERT INTO pim_addresses (
            party_id,
            address_type,
            address_line1,
            address_line2,
            village_town,
            district,
            state,
            pincode,
            is_current,
            source
          )
          VALUES (
            ${partyId},
            ${address.addressType || "POSTAL"},
            ${address.addressLine1},
            ${address.addressLine2 || null},
            ${address.villageTown || null},
            ${address.district || null},
            ${address.state || null},
            ${address.pincode || null},
            true,
            'RECEIVED_APPLICATION'
          )
        `;
      }
    }

    if (party.advocate && party.advocate.name) {
      const advocate = party.advocate;

      const [advocateRow] = await tx`
        INSERT INTO pim_advocates (name, enrollment_no, phone, email, address)
        VALUES (
          ${advocate.name.trim()},
          ${advocate.enrollmentNo || null},
          ${advocate.phone || null},
          ${advocate.email || null},
          ${advocate.address || null}
        )
        RETURNING id
      `;
      const advocateId = advocateRow.id;

      /*
       * SQLite's version writes new Date().toISOString().slice(0, 10)
       * here - a raw UTC calendar date, not officeDate() - a
       * pre-existing inconsistency documented in
       * docs/phase6-transaction-readiness.md section H. Preserved
       * verbatim (not "fixed") per this batch's explicit scope: only
       * dependency injection/engine translation, no behavior changes.
       */
      const fromDate = new Date().toISOString().slice(0, 10);

      await tx`
        INSERT INTO pim_case_advocates (case_id, party_id, advocate_id, role, from_date)
        VALUES (${caseId}, ${partyId}, ${advocateId}, 'COUNSEL', ${fromDate})
      `;
    }
  }
}

async function getPrimaryPartyIdPg(tx, caseId, role) {
  const [row] = await tx`
    SELECT party_id
    FROM pim_case_parties
    WHERE case_id = ${caseId}
      AND role = ${role}
      AND is_primary = true
    LIMIT 1
  `;

  return row ? row.party_id : null;
}

/*
 * dbClient/tx is always the transaction-scoped postgres.js client
 * supplied by withTransaction() below - there is no default parameter
 * here (unlike the Batch 5B SQLite helpers), because postgres.js has
 * no shared "default client" concept equivalent to better-sqlite3's
 * single-connection singleton: every statement must be explicitly
 * bound to a real client, so accidental fallback is not a risk this
 * function can silently have - there is nothing to silently fall
 * back to.
 */
async function createReceivedPimApplicationPg(data, userId = null) {
  validateReceivedApplication(data);

  return withTransaction(async (tx) => {
    // ---------------------------------------------------------
    // 1. Create case header. pim_number is NULL - intake never
    // assigns one; see the module header comment above.
    // ---------------------------------------------------------

    const [caseRow] = await tx`
      INSERT INTO pim_cases (
        pim_number,
        received_number,
        received_date,
        application_date,
        claim_amount,
        dispute_description,
        priority
      )
      VALUES (
        NULL,
        ${data.receivedNumber},
        ${data.receivedDate},
        ${data.applicationDate},
        ${data.claimAmount || null},
        ${data.disputeDescription || null},
        'NORMAL'
      )
      RETURNING id
    `;

    const caseId = caseRow.id;

    // ---------------------------------------------------------
    // 2. Add applicants
    // ---------------------------------------------------------

    await addPartiesPg(tx, caseId, data.applicants, "APPLICANT");

    // ---------------------------------------------------------
    // 3. Add opposite parties
    // ---------------------------------------------------------

    await addPartiesPg(tx, caseId, data.oppositeParties, "OPPOSITE_PARTY");

    // ---------------------------------------------------------
    // 4. Application fee / DD
    // ---------------------------------------------------------

    if (data.applicationFee) {
      const applicantPartyId = await getPrimaryPartyIdPg(tx, caseId, "APPLICANT");

      await tx`
        INSERT INTO pim_fees (
          case_id,
          party_id,
          fee_type,
          amount_due,
          amount_received,
          dd_number,
          dd_date,
          bank_name,
          payee,
          received_date,
          status
        )
        VALUES (
          ${caseId},
          ${applicantPartyId},
          'APPLICATION_FEE',
          1000,
          1000,
          ${data.applicationFee.ddNumber || null},
          ${data.applicationFee.ddDate || null},
          ${data.applicationFee.bankName || null},
          ${data.applicationFee.payee || null},
          ${data.receivedDate},
          'RECEIVED'
        )
      `;
    }

    // ---------------------------------------------------------
    // 5. Set initial status
    // ---------------------------------------------------------

    const [receivedStatus] = await tx`
      SELECT id
      FROM status_master
      WHERE code = 'RECEIVED'
    `;

    if (!receivedStatus) {
      throw new Error("RECEIVED status is missing from status_master.");
    }

    await tx`
      UPDATE pim_cases
      SET current_status_id = ${receivedStatus.id}
      WHERE id = ${caseId}
    `;

    // ---------------------------------------------------------
    // 6. Status history
    // ---------------------------------------------------------

    await tx`
      INSERT INTO pim_status_history (
        case_id,
        from_status_id,
        to_status_id,
        reason,
        changed_by
      )
      VALUES (${caseId}, NULL, ${receivedStatus.id}, 'PIM application received.', ${userId})
    `;

    // ---------------------------------------------------------
    // 7. Docket entry
    // ---------------------------------------------------------

    const [receivedEvent] = await tx`
      SELECT id
      FROM event_types
      WHERE code = 'APPLICATION_RECEIVED'
    `;

    if (!receivedEvent) {
      throw new Error(
        "APPLICATION_RECEIVED event is missing from event_types."
      );
    }

    await tx`
      INSERT INTO pim_docket (
        case_id,
        docket_date,
        event_type_id,
        entry_text,
        entered_by
      )
      VALUES (
        ${caseId},
        ${data.receivedDate},
        ${receivedEvent.id},
        'PIM application received and entered for scrutiny.',
        ${userId}
      )
    `;

    // ---------------------------------------------------------
    // 8. Create scrutiny task. task_type_id missing is NOT a hard
    // guard (matches SQLite exactly - only status/event lookups
    // abort the transaction).
    // ---------------------------------------------------------

    const [scrutinyTask] = await tx`
      SELECT id
      FROM task_types
      WHERE code = 'SCRUTINY'
    `;

    await tx`
      INSERT INTO pim_tasks (
        case_id,
        task_type_id,
        task_type_code,
        description,
        created_date,
        due_date,
        priority,
        status,
        auto_generated
      )
      VALUES (
        ${caseId},
        ${scrutinyTask ? scrutinyTask.id : null},
        'SCRUTINY',
        'Scrutiny of newly received PIM application',
        ${data.receivedDate},
        ${data.receivedDate},
        'NORMAL',
        'PENDING',
        true
      )
    `;

    return caseId;
  });
}

module.exports = {
  createReceivedPimApplicationPg,
};
