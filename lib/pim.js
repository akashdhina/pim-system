const db = require("./db");

const MIN_PIM_CLAIM_AMOUNT = 300000;
const MAX_PIM_CLAIM_AMOUNT = 10000000;
const PIM_CLAIM_AMOUNT_MESSAGE =
  "For filing PIM before DLSA, claim amount must be above ₹3,00,000 and below ₹1,00,00,000.";
/**
 * Create a newly received PIM application.
 *
 * Important:
 * - No PIM number is assigned here.
 * - The application remains in RECEIVED status.
 * - Registration/PIM numbering happens only after Secretary approval.
 *
 * Expected data:
 *
 * {
 *   receivedNumber,
 *   receivedDate,
 *   applicationDate,
 *   claimAmount,
 *   disputeDescription,
 *   applicants: [
 *     {
 *       name,
 *       entityType,
 *       addresses: [
 *         {
 *           addressType,
 *           addressLine1,
 *           addressLine2,
 *           villageTown,
 *           district,
 *           state,
 *           pincode
 *         }
 *       ],
 *       advocate: {
 *         name,
 *         enrollmentNo,
 *         phone,
 *         email,
 *         address
 *       }
 *     }
 *   ],
 *   oppositeParties: [
 *     {
 *       name,
 *       entityType,
 *       addresses: [...],
 *       advocate: {...}
 *     }
 *   ],
 *   applicationFee: {
 *     amount,
 *     ddNumber,
 *     ddDate,
 *     bankName,
 *     payee
 *   }
 * }
 */

function createReceivedPimApplication(data, userId = null) {
  validateReceivedApplication(data);

  const transaction = db.transaction(() => {
    // ---------------------------------------------------------
    // 1. Create case header
    // ---------------------------------------------------------

    const caseResult = db.prepare(`
      INSERT INTO pim_cases (
        pim_number,
        received_number,
        received_date,
        application_date,
        claim_amount,
        dispute_description,
        priority
      )
      VALUES (NULL, ?, ?, ?, ?, ?, 'NORMAL')
    `).run(
      data.receivedNumber,
      data.receivedDate,
      data.applicationDate,
      data.claimAmount || null,
      data.disputeDescription || null
    );

    const caseId = Number(caseResult.lastInsertRowid);

    // ---------------------------------------------------------
    // 2. Add applicants
    // ---------------------------------------------------------

    addParties(
      caseId,
      data.applicants,
      "APPLICANT"
    );

    // ---------------------------------------------------------
    // 3. Add opposite parties
    // ---------------------------------------------------------

    addParties(
      caseId,
      data.oppositeParties,
      "OPPOSITE_PARTY"
    );

    // ---------------------------------------------------------
    // 4. Application fee / DD
    // ---------------------------------------------------------

    if (data.applicationFee) {
      const applicantPartyId = getPrimaryPartyId(
        caseId,
        "APPLICANT"
      );

      db.prepare(`
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
          ?, ?, 'APPLICATION_FEE', ?, ?, ?, ?, ?, ?, ?, 'RECEIVED'
        )
      `).run(
        caseId,
        applicantPartyId,
        1000,
        1000,
        data.applicationFee.ddNumber || null,
        data.applicationFee.ddDate || null,
        data.applicationFee.bankName || null,
        data.applicationFee.payee || null,
        data.receivedDate
      );
    }

    // ---------------------------------------------------------
    // 5. Set initial status
    // ---------------------------------------------------------

    const receivedStatus = db.prepare(`
      SELECT id
      FROM status_master
      WHERE code = 'RECEIVED'
    `).get();

    if (!receivedStatus) {
      throw new Error("RECEIVED status is missing from status_master.");
    }

    db.prepare(`
      UPDATE pim_cases
      SET current_status_id = ?
      WHERE id = ?
    `).run(
      receivedStatus.id,
      caseId
    );

    // ---------------------------------------------------------
    // 6. Status history
    // ---------------------------------------------------------

    db.prepare(`
      INSERT INTO pim_status_history (
        case_id,
        from_status_id,
        to_status_id,
        reason,
        changed_by
      )
      VALUES (?, NULL, ?, ?, ?)
    `).run(
      caseId,
      receivedStatus.id,
      "PIM application received.",
      userId
    );

    // ---------------------------------------------------------
    // 7. Docket entry
    // ---------------------------------------------------------

    const receivedEvent = db.prepare(`
      SELECT id
      FROM event_types
      WHERE code = 'APPLICATION_RECEIVED'
    `).get();

    if (!receivedEvent) {
      throw new Error(
        "APPLICATION_RECEIVED event is missing from event_types."
      );
    }

    db.prepare(`
      INSERT INTO pim_docket (
        case_id,
        docket_date,
        event_type_id,
        entry_text,
        entered_by
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(
      caseId,
      data.receivedDate,
      receivedEvent.id,
      "PIM application received and entered for scrutiny.",
      userId
    );

    // ---------------------------------------------------------
    // 8. Create scrutiny task
    // ---------------------------------------------------------

    const scrutinyTask = db.prepare(`
  SELECT id
  FROM task_types
  WHERE code = 'SCRUTINY'
  `).get();

    db.prepare(`
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
      VALUES (?, ?, 'SCRUTINY', ?, ?, ?, 'NORMAL', 'PENDING', 1)
    `).run(
      caseId,
      scrutinyTask ? scrutinyTask.id : null,
      "Scrutiny of newly received PIM application",
      data.receivedDate,
      data.receivedDate
    );

    return caseId;
  });

  return transaction();
}


// ============================================================
// Party handling
// ============================================================

function addParties(caseId, parties, role) {
  if (!Array.isArray(parties) || parties.length === 0) {
    throw new Error(`${role}: at least one party is required.`);
  }

  parties.forEach((party, index) => {
    if (!party.name || !party.name.trim()) {
      throw new Error(
        `${role} ${index + 1}: party name is required.`
      );
    }

    const partyResult = db.prepare(`
      INSERT INTO pim_parties (
        name,
        entity_type
      )
      VALUES (?, ?)
    `).run(
      party.name.trim(),
      party.entityType || "INDIVIDUAL"
    );

    const partyId = Number(partyResult.lastInsertRowid);

    db.prepare(`
      INSERT INTO pim_case_parties (
        case_id,
        party_id,
        role,
        sequence_no,
        is_primary
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(
      caseId,
      partyId,
      role,
      index + 1,
      index === 0 ? 1 : 0
    );

    // Addresses
    if (Array.isArray(party.addresses)) {
      party.addresses.forEach((address) => {
        if (!address.addressLine1) {
          return;
        }

        db.prepare(`
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'RECEIVED_APPLICATION')
        `).run(
          partyId,
          address.addressType || "POSTAL",
          address.addressLine1,
          address.addressLine2 || null,
          address.villageTown || null,
          address.district || null,
          address.state || null,
          address.pincode || null
        );
      });
    }

    // Advocate
    if (party.advocate && party.advocate.name) {
      const advocate = party.advocate;

      const advocateResult = db.prepare(`
        INSERT INTO pim_advocates (
          name,
          enrollment_no,
          phone,
          email,
          address
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(
        advocate.name.trim(),
        advocate.enrollmentNo || null,
        advocate.phone || null,
        advocate.email || null,
        advocate.address || null
      );

      const advocateId = Number(
        advocateResult.lastInsertRowid
      );

      db.prepare(`
        INSERT INTO pim_case_advocates (
          case_id,
          party_id,
          advocate_id,
          role,
          from_date
        )
        VALUES (?, ?, ?, 'COUNSEL', ?)
      `).run(
        caseId,
        partyId,
        advocateId,
        new Date().toISOString().slice(0, 10)
      );
    }
  });
}


// ============================================================
// Helpers
// ============================================================

function getPrimaryPartyId(caseId, role) {
  const row = db.prepare(`
    SELECT party_id
    FROM pim_case_parties
    WHERE case_id = ?
      AND role = ?
      AND is_primary = 1
    LIMIT 1
  `).get(caseId, role);

  return row ? row.party_id : null;
}


function validateReceivedApplication(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Application data is required.");
  }

  if (!data.receivedNumber) {
    throw new Error("Received Number is required.");
  }

  if (!data.receivedDate) {
    throw new Error("Received Date is required.");
  }

  if (!data.applicationDate) {
    throw new Error("Application Date is required.");
  }
if (
  !data.applicationFee ||
  typeof data.applicationFee !== "object"
) {
  throw new Error(
    "Application fee DD is required."
  );
}

if (Number(data.applicationFee.amount) !== 1000) {
  throw new Error(
    "Application fee must be ₹1,000."
  );
}

if (!data.applicationFee.ddNumber) {
  throw new Error(
    "Application fee DD Number is required."
  );
}

if (!data.applicationFee.ddDate) {
  throw new Error(
    "Application fee DD Date is required."
  );
}

if (!data.applicationFee.bankName) {
  throw new Error(
    "Application fee bank name is required."
  );
}

if (
  data.applicationFee.payee &&
  data.applicationFee.payee.trim() !==
    "Chairman, DLSA"
) {
  throw new Error(
    "Application fee DD must be drawn in favour of Chairman, DLSA."
  );
}
  if (
    !Array.isArray(data.applicants) ||
    data.applicants.length === 0
  ) {
    throw new Error("At least one applicant is required.");
  }

  if (
    !Array.isArray(data.oppositeParties) ||
    data.oppositeParties.length === 0
  ) {
    throw new Error(
      "At least one opposite party is required."
    );
  }
}


module.exports = {
  createReceivedPimApplication,
};

