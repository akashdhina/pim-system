/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5K's opposite-party
 * response / all-party consent workflow - SERVICE_PENDING through the
 * FEE_PENDING handoff. See
 * docs/phase6-batch5k-op-response-consent-migration.md.
 *
 * Scope (approved plan): recordResponseTx (APPEARED / SOUGHT_TIME /
 * REFUSED / DID_NOT_APPEAR) and recordConsentDecisionTx (the deferred
 * CONSENTED/REFUSED decision). Mediation fee PAYMENT, mediator
 * assignment, mediation sessions, outcomes and honorarium are
 * explicitly NOT part of this batch.
 *
 * THE CORRECTED RULE (the primary defect this batch fixes): the
 * pre-existing SQLite route transitioned the case to FEE_PENDING the
 * moment the FIRST opposite party consented, with no check for how
 * many other required opposite parties existed or had themselves
 * responded - a real, confirmed violation of the SOP's "no referral to
 * mediation without all-party consent" (clause 6(e)). This module
 * instead derives ALL_REQUIRED_PARTIES_CONSENTED live, from source
 * facts (deriveConsentAggregateTx, below - never a persisted boolean),
 * and only transitions to FEE_PENDING once every active opposite party
 * has its own latest response showing consent=1. A party's own express
 * refusal is still immediately decisive (OP_REFUSED + non-starter
 * handoff fires regardless of other parties' state) - consent-gating
 * applies only to the FEE_PENDING transition, never to refusal, which
 * the SOP treats as dispositive on its own.
 *
 * CONSENT COMPLETION IS NOT FEE COMPLETION: FEE_PENDING means "the
 * required consent prerequisite is satisfied, but mediation-fee
 * obligations are not yet satisfied" - never "ready for referral."
 * This module never reads or writes pim_fees.amount_received, and
 * never implies the fee itself has been paid. See
 * docs/phase6-batch5k-op-response-consent-planning.md §0/§12/§18.
 *
 * Applicant consent: per the planning document's §24 determination,
 * the applicant's consent is already established by the PIMS
 * application itself (continued by participation, most concretely fee
 * remittance - a later, separate batch's concern) - the SOP's clause 6
 * procedural sequence is written exclusively around the OPPOSITE
 * PARTY's appearance/response/consent. No applicant-consent schema was
 * added; the consent aggregate below is scoped to required opposite
 * parties only, by design, not by omission.
 *
 * Concurrency: every mutating function locks the case row FIRST
 * (SELECT ... FOR UPDATE OF c) and performs every read/write for that
 * call inside that single lock - no notice-row or party-row lock is
 * taken, because (per the planning document's §16 analysis) nothing in
 * this module writes pim_notices or pim_case_parties, and the
 * consent-aggregate derivation itself is scoped to case_id and reads
 * only committed data once the case lock is held. This was checked
 * against the actual access pattern, not assumed.
 */

const { withTransaction, getSql } = require("../pim-postgres");
const { officeDate, officeTime, addDays } = require("../pim-time");
const { calculateMediationFee } = require("../pim-mediation-fee");
const {
  getStatusId, addStatusHistory, addDocket, getPendingTask, createPendingTaskIfNotExists,
} = require("./workflow-helpers");
const { toWire } = require("./wire-compat");

const CASE_WIRE = { timestamps: ["updated_at", "created_at"] };
const PARTY_WIRE = { flags: ["is_primary"] };

const RESPONSE_ENTRY_STATUSES = new Set(["SERVICE_PENDING", "OP_APPEARANCE_PENDING", "OP_APPEARED", "FEE_PENDING"]);
const CONSENT_ENTRY_STATUSES = new Set(["OP_APPEARED", "FEE_PENDING"]);
const MAX_ALTERNATE_DATE_WINDOW_DAYS = 10;

// ---------------------------------------------------------------------
// Small pure/local helpers (mirroring lib/pim-op-response.js's own,
// re-implemented here because a PostgreSQL tx has no shared default
// client to thread them through, same reasoning as every other
// Batch 5D+ module).
// ---------------------------------------------------------------------

function assertNotPremature(dateString, label) {
  if (!dateString) throw new Error(`Unable to determine the ${label} date for this case.`);
  if (officeDate() < dateString) throw new Error(`Cannot record ${label} before ${dateString}.`);
}

function assertAlternateDateWithinWindow(requestDate, alternateDate) {
  const maxDate = addDays(requestDate, MAX_ALTERNATE_DATE_WINDOW_DAYS);
  if (alternateDate > maxDate) {
    throw new Error(
      `The alternate appearance date cannot be more than ${MAX_ALTERNATE_DATE_WINDOW_DAYS} days after the request date (${requestDate}).`
    );
  }
}

/*
 * Guarded completion - same invariant as every other Batch 5D+ module's
 * own local copy (scrutiny.js, form2.js, service.js): WHERE
 * status='PENDING' + a row-count check, so this can never
 * double-complete even under a race.
 */
async function completeTaskTx(tx, task, userId, remarks) {
  const updated = await tx`
    UPDATE pim_tasks
    SET status = 'COMPLETED', completed_date = ${officeDate()}, completed_time = ${officeTime()}, completed_by = ${userId}
    WHERE id = ${task.id} AND status = 'PENDING'
    RETURNING id
  `;
  if (updated.length === 1) {
    await tx`
      INSERT INTO pim_task_history (task_id, old_status, new_status, changed_by, remarks)
      VALUES (${task.id}, 'PENDING', 'COMPLETED', ${userId}, ${remarks})
    `;
  }
  return updated.length === 1;
}

async function completeTaskIfPendingTx(tx, caseId, taskTypeCode, userId, remarks) {
  const task = await getPendingTask(tx, caseId, taskTypeCode);
  if (task) await completeTaskTx(tx, task, userId, remarks);
  return Boolean(task);
}

async function createNonStarterHandoffTx(tx, caseId, partyName, reasonText, userId) {
  return createPendingTaskIfNotExists(
    tx, caseId, "NONSTARTER_FORM3",
    `Non-starter handoff: ${reasonText} (${partyName || "opposite party"}).`,
    officeDate(), reasonText
  );
}

async function insertResponseTx(tx, {
  caseId, partyId, noticeId, responseDate, appearanceMode, responseType,
  timeRequestedUntil, consent, mediationFeeRequested, remarks, userId,
}) {
  const [row] = await tx`
    INSERT INTO pim_responses
      (case_id, party_id, notice_id, response_date, appearance_mode, response_type,
       time_requested_until, consent, mediation_fee_requested, remarks, entered_by)
    VALUES
      (${caseId}, ${partyId}, ${noticeId}, ${responseDate}, ${appearanceMode}, ${responseType},
       ${timeRequestedUntil}, ${consent}, ${mediationFeeRequested}, ${remarks}, ${userId})
    RETURNING id
  `;
  return row.id;
}

async function getLatestResponseTx(tx, caseId, partyId, responseType) {
  const [row] = await tx`
    SELECT * FROM pim_responses
    WHERE case_id = ${caseId} AND party_id = ${partyId} AND response_type = ${responseType}
    ORDER BY id DESC LIMIT 1
  `;
  return row || null;
}

async function requireIssuedNoticeForPartyTx(tx, caseId, partyId, noticeId) {
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    throw new Error("A specific notice must be identified for this OP response.");
  }

  const [notice] = await tx`
    SELECT n.*, p.name AS recipient_name
    FROM pim_notices n LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    WHERE n.id = ${noticeId} AND n.case_id = ${caseId}
  `;
  if (!notice) throw new Error("Notice not found for this case.");

  if (notice.recipient_party_id !== partyId) {
    throw new Error("Selected notice does not belong to the selected opposite party.");
  }

  if (!["DISPATCHED", "SERVED"].includes(notice.status)) {
    throw new Error(
      `This notice has not been issued/served. Current notice status: ${notice.status}. An OP response cannot be recorded against an unissued notice.`
    );
  }

  const [serviceAttempt] = await tx`
    SELECT id FROM pim_service_attempts WHERE notice_id = ${noticeId} ORDER BY id DESC LIMIT 1
  `;
  if (!serviceAttempt) {
    throw new Error("No service record exists for this notice. Record service before recording an OP response.");
  }

  return notice;
}

/*
 * Case-level mediation fee - full statutory amount, deduped by
 * case_id alone (never per-party), exactly matching
 * lib/pim-op-response.js's ensureMediationFee. This creates the
 * PENDING fee row; it never reads or implies amount_received status -
 * payment itself belongs to the (unmigrated, future) fee module.
 */
async function ensureMediationFeeTx(tx, caseId, partyId, remarksText) {
  const [existingFee] = await tx`
    SELECT id, amount_due FROM pim_fees WHERE case_id = ${caseId} AND fee_type = 'MEDIATION_FEE' LIMIT 1
  `;
  const [caseRow] = await tx`SELECT claim_amount FROM pim_cases WHERE id = ${caseId}`;
  const totalFee = caseRow ? calculateMediationFee(caseRow.claim_amount) : null;

  if (existingFee) {
    if (existingFee.amount_due == null && totalFee != null) {
      await tx`UPDATE pim_fees SET amount_due = ${totalFee} WHERE id = ${existingFee.id}`;
    }
    return existingFee.id;
  }

  const [fee] = await tx`
    INSERT INTO pim_fees (case_id, party_id, fee_type, amount_due, amount_received, status, remarks)
    VALUES (${caseId}, ${partyId}, 'MEDIATION_FEE', ${totalFee}, 0, 'PENDING', ${remarksText})
    RETURNING id
  `;
  return fee.id;
}

// ---------------------------------------------------------------------
// The source-fact consent aggregate - never persisted, always derived.
// Usable both inside a locked transaction (the `tx` client) and for the
// read-only GET loader (the plain `sql` client - same tagged-template
// API, see lib/pim-data/form2.js's getCasePg for the same pattern).
// ---------------------------------------------------------------------

async function deriveConsentAggregateTx(client, caseId) {
  const requiredParties = await client`
    SELECT cp.party_id, p.name
    FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseId} AND cp.role = 'OPPOSITE_PARTY' AND cp.active_to IS NULL
    ORDER BY cp.sequence_no, cp.id
  `;

  if (requiredParties.length === 0) {
    return { requiredParties: [], consentedParties: [], unresolvedParties: [], refusedParties: [], gateSatisfied: false };
  }

  const partyIds = requiredParties.map((p) => p.party_id);
  const latestResponses = await client`
    SELECT DISTINCT ON (party_id) party_id, response_type, consent
    FROM pim_responses
    WHERE case_id = ${caseId} AND party_id IN ${client(partyIds)}
    ORDER BY party_id, id DESC
  `;
  const latestByParty = new Map(latestResponses.map((r) => [r.party_id, r]));

  const consentedParties = [];
  const unresolvedParties = [];
  const refusedParties = [];

  for (const party of requiredParties) {
    const latest = latestByParty.get(party.party_id);
    if (latest && latest.consent === 1) {
      consentedParties.push(party);
    } else if (latest && (latest.response_type === "REFUSED" || latest.consent === 0)) {
      refusedParties.push(party);
    } else {
      unresolvedParties.push(party);
    }
  }

  const gateSatisfied =
    refusedParties.length === 0 &&
    unresolvedParties.length === 0 &&
    consentedParties.length === requiredParties.length;

  return { requiredParties, consentedParties, unresolvedParties, refusedParties, gateSatisfied };
}

// ---------------------------------------------------------------------
// Shared consequence handlers - used by both recordResponseTx's fast
// path (APPEARED + consent decided immediately) and
// recordConsentDecisionTx (the deferred path), so the two routes can
// never drift in what "consented" or "refused" actually does.
// ---------------------------------------------------------------------

async function handleConsentedTx(tx, caseId, caseRow, oppositeParty, noticeLabel, responseId, userId) {
  await completeTaskIfPendingTx(tx, caseId, "OP_APPEARANCE_FOLLOWUP", userId, "OP appeared and consented to mediation.");

  const aggregate = await deriveConsentAggregateTx(tx, caseId);

  if (!aggregate.gateSatisfied) {
    await addDocket(
      tx, caseId, "OP_CONSENT",
      `Opposite party ${oppositeParty.name} consented to mediation after ${noticeLabel}. Awaiting ${aggregate.unresolvedParties.length} other required opposite part${aggregate.unresolvedParties.length === 1 ? "y" : "ies"} before mediation fee can be requested.`,
      "Await remaining opposite parties", null, userId
    );

    return {
      responseId, caseId, partyId: oppositeParty.party_id,
      statusCode: caseRow.status_code, consentGate: aggregate,
    };
  }

  const fromStatusId = await getStatusId(tx, caseRow.status_code);
  const feePendingStatusId = await getStatusId(tx, "FEE_PENDING");

  await addStatusHistory(
    tx, caseId, fromStatusId, feePendingStatusId,
    `Opposite party ${oppositeParty.name} consented to mediation after ${noticeLabel}; all required opposite parties have now consented. Mediation fee pending.`,
    userId
  );

  await tx`
    UPDATE pim_cases SET current_status_id = ${feePendingStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}
  `;

  const feeId = await ensureMediationFeeTx(tx, caseId, oppositeParty.party_id, "Mediation fee pending after all required parties' consent.");

  // The fee-stage task, created exactly once (dedup'd by
  // createPendingTaskIfNotExists) - OP_CONSENT_FEE already existed as
  // master data and as an action-link target with no real creator
  // anywhere in the codebase until now.
  await createPendingTaskIfNotExists(tx, caseId, "OP_CONSENT_FEE", "Collect mediation fee from both sides.", officeDate());

  await addDocket(
    tx, caseId, "OP_CONSENT",
    `Opposite party ${oppositeParty.name} consented to mediation after ${noticeLabel}. All required opposite parties have now consented; mediation fee is pending.`,
    "Mediation fee", null, userId
  );

  return {
    responseId, caseId, partyId: oppositeParty.party_id,
    statusCode: "FEE_PENDING", feeId, consentGate: aggregate,
  };
}

async function handleRefusedTx(tx, caseId, caseRow, oppositeParty, noticeLabel, responseId, userId, verbPhrase) {
  // Refusal is decisive regardless of the case's current status -
  // including FEE_PENDING (reached via a DIFFERENT, already-consented
  // party) - so a later-discovered refusal from a required party
  // remains recordable and correctly overrides a premature advance,
  // rather than being a dead end the way the pre-existing SQLite
  // route's narrow isAdditionalConsentAfterFeePending carve-out left it.
  const fromStatusId = await getStatusId(tx, caseRow.status_code);
  const refusedStatusId = await getStatusId(tx, "OP_REFUSED");

  await addStatusHistory(
    tx, caseId, fromStatusId, refusedStatusId,
    `Opposite party ${oppositeParty.name} ${verbPhrase} mediation after ${noticeLabel}.`, userId
  );

  await tx`UPDATE pim_cases SET current_status_id = ${refusedStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

  await completeTaskIfPendingTx(tx, caseId, "OP_APPEARANCE_FOLLOWUP", userId, `OP ${verbPhrase} mediation.`);

  await createNonStarterHandoffTx(tx, caseId, oppositeParty.name, `OP ${verbPhrase} mediation after ${noticeLabel}.`, userId);

  await addDocket(
    tx, caseId, "OP_REFUSAL",
    `Opposite party ${oppositeParty.name} ${verbPhrase} mediation after ${noticeLabel}.`,
    "Non-starter handoff (Phase 5)", null, userId
  );

  return { responseId, caseId, partyId: oppositeParty.party_id, statusCode: "OP_REFUSED" };
}

// ---------------------------------------------------------------------
// recordResponseTx - the four response types
// ---------------------------------------------------------------------

async function recordResponseTx(tx, caseId, input, userId) {
  const {
    partyId, noticeId, responseType, appearanceMode = null, responseDate,
    timeRequestedUntil = null, consent = null, mediationFeeRequested = null, remarks = null,
  } = input;

  // Lock the case row FIRST - every other read/write in this call
  // happens inside this single lock (planning doc §16: no separate
  // notice/party lock is needed, since this module never writes
  // pim_notices/pim_case_parties, and the consent aggregate itself is
  // scoped to case_id and reads committed data once this lock is held).
  const [caseRow] = await tx`
    SELECT c.id, c.current_status_id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (!RESPONSE_ENTRY_STATUSES.has(caseRow.status_code)) {
    throw new Error(
      `This case is not currently available for recording an OP response. Current status: ${caseRow.status_name}`
    );
  }

  const [oppositeParty] = await tx`
    SELECT cp.id AS case_party_id, p.id AS party_id, p.name
    FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseId} AND cp.party_id = ${partyId}
      AND cp.role = 'OPPOSITE_PARTY' AND cp.active_to IS NULL
  `;
  if (!oppositeParty) throw new Error("Selected party is not an active opposite party in this case.");

  const notice = await requireIssuedNoticeForPartyTx(tx, caseId, partyId, noticeId);
  const isFinal = notice.notice_type === "FORM_2_FINAL";
  const noticeLabel = isFinal ? "Final Notice" : "Initial Notice";

  if (responseType === "APPEARED") {
    const responseId = await insertResponseTx(tx, {
      caseId, partyId, noticeId, responseDate, appearanceMode, responseType,
      timeRequestedUntil: null, consent, mediationFeeRequested, remarks, userId,
    });

    if (consent === 1 && mediationFeeRequested === 1) {
      return handleConsentedTx(tx, caseId, caseRow, oppositeParty, noticeLabel, responseId, userId);
    }

    if (consent === 0) {
      return handleRefusedTx(tx, caseId, caseRow, oppositeParty, noticeLabel, responseId, userId, "appeared and refused");
    }

    // Appearance recorded, consent not yet decided. Transition to
    // OP_APPEARED exactly as the SQLite original does - UNLESS the
    // case has already reached FEE_PENDING (via a different, already-
    // consented party) or is already OP_APPEARED, in which case this
    // party's own undecided appearance must never regress a case that
    // has already progressed further. This is the multi-OP-safe
    // generalization of a transition that, in the single-OP original,
    // never had another party's state to accidentally overwrite.
    let resultStatusCode = caseRow.status_code;
    if (caseRow.status_code !== "OP_APPEARED" && caseRow.status_code !== "FEE_PENDING") {
      const fromStatusId = await getStatusId(tx, caseRow.status_code);
      const toStatusId = await getStatusId(tx, "OP_APPEARED");
      await addStatusHistory(
        tx, caseId, fromStatusId, toStatusId,
        `Opposite party ${oppositeParty.name} appeared after ${noticeLabel}.`, userId
      );
      await tx`UPDATE pim_cases SET current_status_id = ${toStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;
      resultStatusCode = "OP_APPEARED";
    }

    await completeTaskIfPendingTx(tx, caseId, "OP_APPEARANCE_FOLLOWUP", userId, "OP appeared; consent decision pending.");

    await addDocket(
      tx, caseId, "OP_APPEARED",
      `Opposite party ${oppositeParty.name} appeared before the authority after ${noticeLabel}.`,
      "Record mediation consent", null, userId
    );

    return { responseId, caseId, partyId, noticeId, statusCode: resultStatusCode };
  }

  if (responseType === "SOUGHT_TIME") {
    // FEE_PENDING is deliberately excluded here (unlike the broader
    // RESPONSE_ENTRY_STATUSES): reaching FEE_PENDING means every
    // required party already shows consent=1 (the gate is only ever
    // satisfied once that is true), so no party can legitimately still
    // be seeking time from that state - allowing it would risk
    // regressing an already-fee-pending case back to
    // OP_APPEARANCE_PENDING, exactly the regression this batch exists
    // to prevent on the consent side too.
    if (!["SERVICE_PENDING", "OP_APPEARED"].includes(caseRow.status_code)) {
      throw new Error(
        `This case is not currently available for an OP time request. Current status: ${caseRow.status_name}`
      );
    }
    if (!timeRequestedUntil) throw new Error("Alternate appearance date is required.");
    assertAlternateDateWithinWindow(responseDate, timeRequestedUntil);

    const responseId = await insertResponseTx(tx, {
      caseId, partyId, noticeId, responseDate, appearanceMode, responseType,
      timeRequestedUntil, consent: null, mediationFeeRequested: null, remarks, userId,
    });

    const fromStatusId = await getStatusId(tx, caseRow.status_code);
    const toStatusId = await getStatusId(tx, "OP_APPEARANCE_PENDING");

    await addStatusHistory(
      tx, caseId, fromStatusId, toStatusId,
      `Opposite party ${oppositeParty.name} sought time to appear after ${noticeLabel}. Alternate date: ${timeRequestedUntil}.`,
      userId
    );

    await tx`UPDATE pim_cases SET current_status_id = ${toStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

    await createPendingTaskIfNotExists(
      tx, caseId, "OP_APPEARANCE_FOLLOWUP",
      `OP appearance follow-up for ${oppositeParty.name} (${noticeLabel}).`, timeRequestedUntil
    );

    await addDocket(
      tx, caseId, "OP_TIME_REQUESTED",
      `Opposite party ${oppositeParty.name} sought time to appear after ${noticeLabel}.`,
      "Await opposite party appearance", timeRequestedUntil, userId
    );

    return { responseId, caseId, partyId, noticeId, statusCode: "OP_APPEARANCE_PENDING", nextDate: timeRequestedUntil };
  }

  if (responseType === "REFUSED") {
    const responseId = await insertResponseTx(tx, {
      caseId, partyId, noticeId, responseDate, appearanceMode, responseType,
      timeRequestedUntil: null, consent: 0, mediationFeeRequested: null, remarks, userId,
    });

    return handleRefusedTx(tx, caseId, caseRow, oppositeParty, noticeLabel, responseId, userId, "refused");
  }

  if (responseType === "DID_NOT_APPEAR") {
    const onAlternateDate = caseRow.status_code === "OP_APPEARANCE_PENDING";
    let thresholdDate;

    if (onAlternateDate) {
      const soughtTime = await getLatestResponseTx(tx, caseId, partyId, "SOUGHT_TIME");
      if (!soughtTime || !soughtTime.time_requested_until) {
        throw new Error("No alternate appearance date is on record for this opposite party.");
      }
      thresholdDate = soughtTime.time_requested_until;
    } else {
      thresholdDate = notice.appearance_date;
    }

    assertNotPremature(thresholdDate, "OP absence");

    const responseId = await insertResponseTx(tx, {
      caseId, partyId, noticeId, responseDate, appearanceMode, responseType,
      timeRequestedUntil: null, consent: null, mediationFeeRequested: null, remarks, userId,
    });

    if (!onAlternateDate && !isFinal) {
      // caseRow.status_code, not a hard-coded SERVICE_PENDING: in a
      // multi-OP case a DIFFERENT party may already have moved the
      // case to OP_APPEARED by the time this party's own Initial
      // Notice appearance date passes unanswered.
      const fromStatusId = await getStatusId(tx, caseRow.status_code);
      const toStatusId = await getStatusId(tx, "FINAL_NOTICE_PENDING");

      await addStatusHistory(
        tx, caseId, fromStatusId, toStatusId,
        `Opposite party ${oppositeParty.name} did not appear / no response received after Initial Notice.`, userId
      );

      await tx`UPDATE pim_cases SET current_status_id = ${toStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

      await createPendingTaskIfNotExists(
        tx, caseId, "FINAL_NOTICE_FOLLOWUP", `Prepare Final Notice for ${oppositeParty.name}.`, officeDate()
      );

      await addDocket(
        tx, caseId, "OP_NO_RESPONSE",
        `Opposite party ${oppositeParty.name} did not appear / no response after Initial Notice.`,
        "Prepare Final Notice", null, userId
      );

      return { responseId, caseId, partyId, noticeId, statusCode: "FINAL_NOTICE_PENDING" };
    }

    await completeTaskIfPendingTx(tx, caseId, "OP_APPEARANCE_FOLLOWUP", userId, "OP did not appear on the alternate date.");

    await createNonStarterHandoffTx(
      tx, caseId, oppositeParty.name,
      onAlternateDate
        ? "OP did not appear on the alternate appearance date."
        : "OP did not appear / no response after Final Notice.",
      userId
    );

    await addDocket(
      tx, caseId, "OP_NO_RESPONSE",
      onAlternateDate
        ? `Opposite party ${oppositeParty.name} did not appear on the alternate date.`
        : `Opposite party ${oppositeParty.name} did not appear / no response after Final Notice.`,
      "Non-starter handoff (Phase 5)", null, userId
    );

    return { responseId, caseId, partyId, noticeId, statusCode: caseRow.status_code };
  }

  throw new Error("Unsupported response type.");
}

async function recordResponsePg(caseId, input, userId) {
  return withTransaction((tx) => recordResponseTx(tx, caseId, input, userId));
}

// ---------------------------------------------------------------------
// recordConsentDecisionTx - the deferred CONSENTED/REFUSED decision
// ---------------------------------------------------------------------

async function recordConsentDecisionTx(tx, caseId, input, userId) {
  const { partyId, decision } = input;

  const [caseRow] = await tx`
    SELECT c.id, c.current_status_id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (!CONSENT_ENTRY_STATUSES.has(caseRow.status_code)) {
    throw new Error(`Consent cannot be recorded at the current stage. Current status: ${caseRow.status_name}`);
  }

  // Scoped by party, not just case - a multi-OP case may have more
  // than one APPEARED response on record; a consent decision must
  // resolve the specific party's own pending appearance.
  const [latestResponse] = await tx`
    SELECT r.*, p.name AS party_name, n.notice_type
    FROM pim_responses r
    JOIN pim_parties p ON p.id = r.party_id
    LEFT JOIN pim_notices n ON n.id = r.notice_id
    WHERE r.case_id = ${caseId} AND r.party_id = ${partyId} AND r.response_type = 'APPEARED'
    ORDER BY r.id DESC LIMIT 1
  `;
  if (!latestResponse) {
    throw new Error("No OP appearance record exists for this opposite party in this case.");
  }
  if (latestResponse.consent !== null) {
    throw new Error("A consent decision has already been recorded for this appearance.");
  }

  const noticeLabel = latestResponse.notice_type === "FORM_2_FINAL" ? "Final Notice" : "Initial Notice";

  await tx`
    UPDATE pim_responses SET consent = ${decision === "CONSENTED" ? 1 : 0} WHERE id = ${latestResponse.id}
  `;

  const oppositeParty = { party_id: latestResponse.party_id, name: latestResponse.party_name };

  if (decision === "CONSENTED") {
    return handleConsentedTx(tx, caseId, caseRow, oppositeParty, noticeLabel, latestResponse.id, userId);
  }

  return handleRefusedTx(tx, caseId, caseRow, oppositeParty, noticeLabel, latestResponse.id, userId, "refused");
}

async function recordConsentDecisionPg(caseId, input, userId) {
  return withTransaction((tx) => recordConsentDecisionTx(tx, caseId, input, userId));
}

// ---------------------------------------------------------------------
// GET loader
// ---------------------------------------------------------------------

async function getCasePg(client, caseId) {
  const [row] = await client`
    SELECT c.*, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;
  return row ? toWire(row, CASE_WIRE) : null;
}

async function getOppositePartiesWithNoticesPg(client, caseId) {
  const parties = await client`
    SELECT cp.id AS case_party_id, p.id AS party_id, p.name, p.entity_type, cp.role, cp.sequence_no, cp.is_primary
    FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseId} AND cp.role = 'OPPOSITE_PARTY' AND cp.active_to IS NULL
    ORDER BY cp.sequence_no, cp.id
  `;

  const out = [];
  for (const party of parties) {
    const notices = await client`
      SELECT
        n.id AS notice_id, n.notice_type, n.notice_date, n.appearance_date, n.appearance_time,
        n.status AS notice_status,
        sa.id AS service_attempt_id, sa.dispatch_date, sa.tracking_no, sa.tracking_status,
        sa.postal_endorsement, sa.delivered_date, sa.returned_date, sa.remarks AS service_remarks
      FROM pim_notices n
      LEFT JOIN LATERAL (
        SELECT * FROM pim_service_attempts WHERE notice_id = n.id ORDER BY id DESC LIMIT 1
      ) sa ON true
      WHERE n.case_id = ${caseId} AND n.recipient_party_id = ${party.party_id}
        AND n.status IN ('DISPATCHED', 'SERVED')
      ORDER BY n.id DESC
    `;
    out.push({ ...toWire(party, PARTY_WIRE), notices });
  }
  return out;
}

async function getResponsesPg(client, caseId) {
  return client`
    SELECT r.*, p.name AS party_name, n.notice_type
    FROM pim_responses r
    JOIN pim_parties p ON p.id = r.party_id
    LEFT JOIN pim_notices n ON n.id = r.notice_id
    WHERE r.case_id = ${caseId}
    ORDER BY r.id DESC
  `;
}

async function getResponseDataPg(caseId) {
  const sql = getSql();
  const caseData = await getCasePg(sql, caseId);
  if (!caseData) return null;

  const [oppositeParties, responses, consentGate] = await Promise.all([
    getOppositePartiesWithNoticesPg(sql, caseId),
    getResponsesPg(sql, caseId),
    deriveConsentAggregateTx(sql, caseId),
  ]);

  return {
    case: caseData,
    oppositeParties,
    responses,
    today: officeDate(),
    maxAlternateDate: addDays(officeDate(), MAX_ALTERNATE_DATE_WINDOW_DAYS),
    consentGate,
  };
}

module.exports = {
  deriveConsentAggregateTx,
  getResponseDataPg,
  recordResponseTx,
  recordResponsePg,
  recordConsentDecisionTx,
  recordConsentDecisionPg,
};
