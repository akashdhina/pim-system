/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Schedule II statutory mediation-fee slabs. Shared by the fee
 * route (which collects payment) and the OP-response consent
 * flow (which creates the case-level MEDIATION_FEE row as soon
 * as an OP consents, before staff ever visits the fee page) so
 * amount_due is always the FULL statutory fee from the moment
 * the row exists - never left null, never halved.
 *
 * Claim amounts above ₹1,00,00,000 are unreachable through
 * normal intake today (lib/pim.js caps at MAX_PIM_CLAIM_AMOUNT),
 * but the two higher slabs are kept complete per the statute in
 * case a legacy-imported case carries a higher claim amount.
 */
function calculateMediationFee(claimAmount) {
  const amount = Number(claimAmount);

  if (!Number.isFinite(amount)) {
    return null;
  }

  if (amount > 300000 && amount <= 1000000) {
    return 15000;
  }

  if (amount > 1000000 && amount <= 5000000) {
    return 30000;
  }

  if (amount > 5000000 && amount <= 10000000) {
    return 40000;
  }

  if (amount > 10000000 && amount <= 30000000) {
    return 50000;
  }

  if (amount > 30000000) {
    return 75000;
  }

  return null;
}

module.exports = {
  calculateMediationFee,
};
