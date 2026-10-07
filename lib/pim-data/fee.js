/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of the mediation-fee workflow (production-
 * completion sprint, 2026-10-07). See
 * docs/phase6-mediation-fee-migration.md.
 *
 * Replaces app/api/pim/fee/[id]/route.js's SQLite implementation, which
 * kept ONE mutable pim_fees row per case and simply added each new
 * payment's amount onto a single amount_received total - with no way to
 * tell how much either side had actually paid, and with the second
 * payer's DD details overwriting the first's (COALESCE only protected a
 * field the new submission left blank, not a field a different side's
 * payment had already set).
 *
 * PAYMENTS ARE TRANSACTIONS, NOT MUTABLE CASE ATTRIBUTES: every payment
 * is an INSERT into the new, additive pim_fee_payments table and is never
 * updated or deleted by normal staff workflow. The per-side/total summary
 * is always DERIVED from these rows (deriveFeeSummaryTx), never stored as
 * a cached total.
 *
 * paying_side is exactly APPLICANT or OP_SIDE - multiple opposite parties
 * jointly constitute the OP_SIDE half; no OP is ever modeled as owing an
 * individual share. (Schedule II's fee is split equally between the two
 * SIDES, matching the pre-existing SQLite route's "shared equally between
 * both sides" behavior - preserved, not changed, by this migration.)
 *
 * The legacy pim_fees MEDIATION_FEE row (created by
 * lib/pim-data/response.js's ensureMediationFeeTx as a PENDING skeleton)
 * is left untouched by this module - it is never read or written here.
 * It remains visible as historical/compatibility context only.
 */

const { withTransaction, getSql } = require("../pim-postgres");
const { officeDate } = require("../pim-time");
const { calculateMediationFee } = require("../pim-mediation-fee");
const {
  getStatusId, addStatusHistory, addDocket, createPendingTaskIfNotExists,
} = require("./workflow-helpers");

const PAYING_SIDES = new Set(["APPLICANT", "OP_SIDE"]);
const FEE_ENTRY_STATUSES = new Set(["FEE_PENDING"]);

function getTotalFee(claimAmount) {
  const totalFee = calculateMediationFee(claimAmount);
  if (totalFee === null) {
    throw new Error(
      "Mediation fee cannot be calculated. Claim amount must be above ₹3,00,000 and below ₹1,00,00,000."
    );
  }
  return totalFee;
}

/*
 * Derived, never persisted. Reads every payment row for the case and
 * folds them by side - this is the ONLY source of truth for how much
 * each side has paid. Usable inside a locked transaction (`tx`) or
 * against the plain read-only client (`sql`), same tagged-template API.
 */
async function deriveFeeSummaryTx(client, caseId) {
  const [caseRow] = await client`SELECT claim_amount FROM pim_cases WHERE id = ${caseId}`;
  if (!caseRow) throw new Error("PIM case not found.");

  const totalFee = calculateMediationFee(caseRow.claim_amount);
  const shareAmount = totalFee === null ? null : totalFee / 2;

  const totals = await client`
    SELECT paying_side, COALESCE(SUM(amount), 0) AS paid
    FROM pim_fee_payments
    WHERE case_id = ${caseId}
    GROUP BY paying_side
  `;
  const paidBySide = Object.fromEntries(totals.map((r) => [r.paying_side, Number(r.paid)]));
  const applicantPaid = paidBySide.APPLICANT || 0;
  const opSidePaid = paidBySide.OP_SIDE || 0;

  const applicantOutstanding = shareAmount == null ? null : Math.max(shareAmount - applicantPaid, 0);
  const opSideOutstanding = shareAmount == null ? null : Math.max(shareAmount - opSidePaid, 0);
  const applicantOverpaid = shareAmount != null && applicantPaid > shareAmount ? applicantPaid - shareAmount : 0;
  const opSideOverpaid = shareAmount != null && opSidePaid > shareAmount ? opSidePaid - shareAmount : 0;

  const fullyPaid = shareAmount != null && applicantPaid >= shareAmount && opSidePaid >= shareAmount;

  return {
    totalFee,
    shareAmount,
    applicantPaid,
    applicantOutstanding,
    applicantOverpaid,
    opSidePaid,
    opSideOutstanding,
    opSideOverpaid,
    totalPaid: applicantPaid + opSidePaid,
    totalOutstanding: totalFee == null ? null : Math.max(totalFee - (applicantPaid + opSidePaid), 0),
    fullyPaid,
    // Explicit reason codes for the not-yet-implemented fee-default
    // workflow (sprint sections 4/9) to key off later - never collapsed
    // into one boolean. Neither side's non-payment is ever labeled an
    // express Rule 3(4)/(6) ground here; that classification belongs to
    // the fee-default batch, not this one.
    applicantFeeNotPaid: shareAmount != null && applicantPaid < shareAmount,
    opSideFeeNotPaid: shareAmount != null && opSidePaid < shareAmount,
  };
}

async function getPaymentsTx(client, caseId) {
  return client`
    SELECT id, case_id, paying_side, amount, payment_date, payment_mode,
           dd_number, dd_date, bank_name, reference_number, remarks, recorded_by, created_at
    FROM pim_fee_payments
    WHERE case_id = ${caseId}
    ORDER BY id
  `;
}

/*
 * Records exactly ONE immutable payment row and, only if that payment
 * completes BOTH sides' required share, transitions FEE_PENDING ->
 * MEDIATOR_ASSIGNMENT_PENDING and creates the mediator-assignment task
 * exactly once. Case row is locked first, matching every other Batch 5D+
 * module's concurrency pattern - two concurrent final payments for the
 * same case serialize on this lock, so the transition and its task can
 * never double-fire.
 */
async function recordFeePaymentTx(tx, caseId, input, userId) {
  const {
    payingSide, amount, paymentDate = officeDate(), paymentMode = "DD",
    ddNumber = null, ddDate = null, bankName = null, referenceNumber = null, remarks = null,
  } = input;

  if (!PAYING_SIDES.has(payingSide)) {
    throw new Error('payingSide must be "APPLICANT" or "OP_SIDE".');
  }

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Payment amount must be a positive number.");
  }

  const [caseRow] = await tx`
    SELECT c.id, c.claim_amount, c.current_status_id, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  if (!FEE_ENTRY_STATUSES.has(caseRow.status_code)) {
    throw new Error(
      `This case is not currently available for mediation fee collection. Current status: ${caseRow.status_name}`
    );
  }

  const totalFee = getTotalFee(caseRow.claim_amount);

  const [payment] = await tx`
    INSERT INTO pim_fee_payments
      (case_id, paying_side, amount, payment_date, payment_mode, dd_number, dd_date, bank_name, reference_number, remarks, recorded_by)
    VALUES
      (${caseId}, ${payingSide}, ${numericAmount}, ${paymentDate}, ${paymentMode}, ${ddNumber}, ${ddDate}, ${bankName}, ${referenceNumber}, ${remarks}, ${userId})
    RETURNING id
  `;

  const summary = await deriveFeeSummaryTx(tx, caseId);

  const sideLabel = payingSide === "APPLICANT" ? "Applicant" : "Opposite party side";
  await addDocket(
    tx, caseId, "MEDIATION_FEE_RECEIVED",
    `${sideLabel} paid ₹${numericAmount.toLocaleString("en-IN")} mediation fee` +
      (ddNumber ? ` via DD ${ddNumber}${ddDate ? ` dated ${ddDate}` : ""}${bankName ? ` (${bankName})` : ""}.` : "."),
    null, null, userId
  );

  if (!summary.fullyPaid) {
    return { paymentId: payment.id, caseId, summary, statusCode: caseRow.status_code };
  }

  const fromStatusId = await getStatusId(tx, "FEE_PENDING");
  const toStatusId = await getStatusId(tx, "MEDIATOR_ASSIGNMENT_PENDING");

  await addStatusHistory(
    tx, caseId, fromStatusId, toStatusId,
    `Mediation fee received in full from both sides (₹${totalFee.toLocaleString("en-IN")} total, ₹${(totalFee / 2).toLocaleString("en-IN")} each).`,
    userId
  );

  await tx`UPDATE pim_cases SET current_status_id = ${toStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

  const taskId = await createPendingTaskIfNotExists(
    tx, caseId, "MEDIATOR_ASSIGNMENT",
    "Assign mediator after mediation fee receipt.", officeDate(),
    "Mediation fee received in full from both sides; mediator assignment pending."
  );

  return { paymentId: payment.id, caseId, summary, statusCode: "MEDIATOR_ASSIGNMENT_PENDING", taskId };
}

async function recordFeePaymentPg(caseId, input, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) {
    throw new Error("Valid case ID is required.");
  }
  return withTransaction((tx) => recordFeePaymentTx(tx, numericCaseId, input, userId));
}

async function getFeeDataPg(caseId) {
  const sql = getSql();

  const [caseRow] = await sql`
    SELECT c.id, c.claim_amount, s.code AS status_code, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;
  if (!caseRow) return null;

  const [summary, payments] = await Promise.all([
    deriveFeeSummaryTx(sql, caseId),
    getPaymentsTx(sql, caseId),
  ]);

  return { case: caseRow, summary, payments };
}

module.exports = {
  deriveFeeSummaryTx,
  recordFeePaymentTx,
  recordFeePaymentPg,
  getFeeDataPg,
};
