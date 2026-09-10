/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  getCase,
  transitionStatus,
  addDocket,
  completeTaskIfPending,
  createNonStarterHandoff,
  ensureMediationFee,
} = require("../../../../../lib/pim-op-response");

export async function POST(
  request,
  { params }
) {
  try {
    const user = requirePermission(
      request,
      "RECORD_CONSENT"
    );

    const { id } = await params;
    const caseId = Number(id);

    if (
      !Number.isInteger(caseId) ||
      caseId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    const body = await request.json();

    const decision = String(
      body.decision || ""
    ).trim();

    const partyId = Number(body.partyId);

    if (!Number.isInteger(partyId) || partyId <= 0) {
      return Response.json(
        {
          success: false,
          message:
            "Opposite party is required to record a deferred consent decision.",
        },
        { status: 400 }
      );
    }

    const caseData = getCase(caseId);

    if (!caseData) {
      return Response.json(
        {
          success: false,
          message: "PIM case not found.",
        },
        { status: 404 }
      );
    }

    if (caseData.status_code !== "OP_APPEARED") {
      return Response.json(
        {
          success: false,
          message: `Consent cannot be recorded at the current stage. Current status: ${caseData.status_name}`,
        },
        { status: 400 }
      );
    }

    if (!["CONSENTED", "REFUSED"].includes(decision)) {
      return Response.json(
        {
          success: false,
          message: "Decision must be CONSENTED or REFUSED.",
        },
        { status: 400 }
      );
    }

    const result = db.transaction(() => {
      /*
       * Scoped by party, not just case: a multi-OP case may have
       * more than one APPEARED response on record, and a consent
       * decision must resolve the specific party's own pending
       * appearance - never whichever response happens to be the
       * most recent across all opposite parties.
       */
      const latestResponse = db
        .prepare(`
          SELECT r.*, p.name AS party_name, n.notice_type
          FROM pim_responses r
          JOIN pim_parties p ON p.id = r.party_id
          LEFT JOIN pim_notices n ON n.id = r.notice_id
          WHERE r.case_id = ?
            AND r.party_id = ?
            AND r.response_type = 'APPEARED'
          ORDER BY r.id DESC
          LIMIT 1
        `)
        .get(caseId, partyId);

      if (!latestResponse) {
        throw new Error(
          "No OP appearance record exists for this opposite party in this case."
        );
      }

      if (
        latestResponse.consent !== null &&
        latestResponse.consent !== undefined
      ) {
        throw new Error(
          "A consent decision has already been recorded for this appearance."
        );
      }

      const noticeLabel =
        latestResponse.notice_type === "FORM_2_FINAL"
          ? "Final Notice"
          : "Initial Notice";

      /*
       * Update the original appearance record with the final
       * consent decision, so response history stays accurate
       * rather than leaving consent permanently null.
       */
      db.prepare(`
        UPDATE pim_responses
        SET consent = ?
        WHERE id = ?
      `).run(
        decision === "CONSENTED" ? 1 : 0,
        latestResponse.id
      );

      if (decision === "CONSENTED") {
        transitionStatus(
          caseId,
          "OP_APPEARED",
          "FEE_PENDING",
          `Opposite party ${latestResponse.party_name} consented to mediation after ${noticeLabel}; mediation fee pending.`,
          user.id
        );

        const feeId = ensureMediationFee(
          caseId,
          latestResponse.party_id,
          "Mediation fee pending after OP consent."
        );

        completeTaskIfPending(
          caseId,
          "OP_APPEARANCE_FOLLOWUP",
          user.id,
          "OP consented to mediation."
        );

        addDocket(
          caseId,
          "OP_CONSENT",
          `Opposite party ${latestResponse.party_name} consented to mediation after ${noticeLabel}.`,
          "Mediation fee",
          null,
          user.id
        );

        return {
          caseId,
          partyId: latestResponse.party_id,
          statusCode: "FEE_PENDING",
          responseId: latestResponse.id,
          feeId,
        };
      }

      transitionStatus(
        caseId,
        "OP_APPEARED",
        "OP_REFUSED",
        `Opposite party ${latestResponse.party_name} refused mediation after ${noticeLabel}.`,
        user.id
      );

      completeTaskIfPending(
        caseId,
        "OP_APPEARANCE_FOLLOWUP",
        user.id,
        "OP refused mediation."
      );

      createNonStarterHandoff(
        caseId,
        latestResponse.party_name,
        `OP refused mediation after ${noticeLabel}.`,
        user.id
      );

      addDocket(
        caseId,
        "OP_REFUSAL",
        `Opposite party ${latestResponse.party_name} refused mediation after ${noticeLabel}.`,
        "Non-starter handoff (Phase 5)",
        null,
        user.id
      );

      return {
        caseId,
        partyId: latestResponse.party_id,
        statusCode: "OP_REFUSED",
        responseId: latestResponse.id,
        feeId: null,
      };
    })();

    return Response.json({
      success: true,
      message:
        decision === "CONSENTED"
          ? "OP consent recorded. Mediation fee is now pending."
          : "OP refusal recorded successfully.",
      data: result,
    });
  } catch (error) {
    console.error("Consent API error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to record consent.",
      },
      { status: 400 }
    );
  }
}
