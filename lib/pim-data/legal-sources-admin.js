/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase LK-2: Legal Knowledge Base - verification-state transition (data
 * layer only; no API route, no UI - those are LK-3/LK-4).
 *
 * This is the ONLY function in LK-2 that writes to legal_sources, and it
 * exists specifically to satisfy the safety properties the brief requires
 * even before a management UI exists:
 *   - verification-state transitions are audited (writes audit_log in the
 *     SAME transaction as the state change - see lib/pim-settings.js's
 *     updateSettings() for the established pattern this follows);
 *   - only a legally valid transition is accepted (no jumping e.g. DRAFT
 *     straight to SUPERSEDED);
 *   - REJECTED_MISMATCH requires verification_notes (also enforced by the
 *     legal_sources_rejected_requires_notes CHECK constraint - this is the
 *     defense-in-depth application-level copy of that rule);
 *   - the actor is always recorded as verified_by - never left implicit.
 *
 * The caller (a future admin route) is responsible for calling
 * requirePermission(request, "MANAGE_LEGAL_SOURCES") before invoking this -
 * this module does not itself check permissions, matching the existing
 * lib/pim-data/*.js convention where permission checks live in the route
 * layer, not the data layer.
 */

const { withTransaction } = require("../pim-postgres");

const VALID_TRANSITIONS = {
  DRAFT: ["DISCOVERED", "REJECTED_MISMATCH"],
  DISCOVERED: ["PRIMARY_SOURCE_VERIFIED", "REJECTED_MISMATCH"],
  PRIMARY_SOURCE_VERIFIED: ["SUPERSEDED"],
  REJECTED_MISMATCH: [],
  SUPERSEDED: [],
};

class LegalSourceTransitionError extends Error {}

async function setLegalSourceVerificationState({
  legalSourceId,
  newState,
  actorUserId,
  verifiedProposition,
  verificationNotes,
  supersededBy,
}) {
  if (!legalSourceId || !Number.isInteger(legalSourceId)) {
    throw new LegalSourceTransitionError("legalSourceId must be an integer.");
  }
  if (!actorUserId) {
    throw new LegalSourceTransitionError("actorUserId is required - every verification-state transition must be attributed to an actor.");
  }
  if (newState === "REJECTED_MISMATCH" && !verificationNotes) {
    throw new LegalSourceTransitionError("verificationNotes is required when rejecting a source as a mismatch.");
  }
  if (newState === "SUPERSEDED" && !supersededBy) {
    throw new LegalSourceTransitionError("supersededBy is required when superseding a source.");
  }

  return withTransaction(async (tx) => {
    const [current] = await tx`
      select id, verification_state, operational_proposition
      from legal_sources
      where id = ${legalSourceId}
      for update
    `;

    if (!current) {
      throw new LegalSourceTransitionError(`legal_sources row ${legalSourceId} not found.`);
    }

    const allowed = VALID_TRANSITIONS[current.verification_state] || [];
    if (!allowed.includes(newState)) {
      throw new LegalSourceTransitionError(
        `Invalid verification_state transition: ${current.verification_state} -> ${newState}.`
      );
    }

    const verificationDate = newState === "PRIMARY_SOURCE_VERIFIED" ? new Date().toISOString().slice(0, 10) : null;

    const [updated] = await tx`
      update legal_sources
      set
        verification_state = ${newState},
        verified_proposition = coalesce(${verifiedProposition ?? null}, verified_proposition),
        verification_notes = coalesce(${verificationNotes ?? null}, verification_notes),
        verification_date = coalesce(${verificationDate}, verification_date),
        verified_by = ${actorUserId},
        superseded_by = coalesce(${supersededBy ?? null}, superseded_by),
        is_active = case when ${newState} in ('REJECTED_MISMATCH', 'SUPERSEDED') then false else is_active end,
        updated_at = now()
      where id = ${legalSourceId}
      returning id, verification_state, is_active
    `;

    await tx`
      insert into audit_log (table_name, record_id, action, old_value, new_value, changed_by, reason)
      values (
        'legal_sources',
        ${legalSourceId},
        'VERIFICATION_STATE_CHANGE',
        ${JSON.stringify({ verification_state: current.verification_state })},
        ${JSON.stringify({ verification_state: newState, verified_proposition: verifiedProposition ?? null })},
        ${actorUserId},
        ${`Verification state transition ${current.verification_state} -> ${newState}`}
      )
    `;

    return updated;
  });
}

module.exports = {
  setLegalSourceVerificationState,
  LegalSourceTransitionError,
  VALID_TRANSITIONS,
};
