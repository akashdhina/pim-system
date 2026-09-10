/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  today,
  getCase,
  getActiveOppositeParty,
  requireIssuedNoticeForParty,
  assertNotPremature,
  assertAlternateDateWithinWindow,
  getLatestResponse,
  transitionStatus,
  addDocket,
  completeTaskIfPending,
  createPendingTaskIfNotExists,
  createNonStarterHandoff,
  insertResponse,
  ensureMediationFee,
} = require("../../../../../lib/pim-op-response");
const { addDays } = require("../../../../../lib/pim-time");

const ALLOWED_RESPONSE_TYPES = [
  "APPEARED",
  "SOUGHT_TIME",
  "REFUSED",
  "DID_NOT_APPEAR",
];

const RESPONSE_ENTRY_STATUSES = [
  "SERVICE_PENDING",
  "OP_APPEARANCE_PENDING",
];

function getOppositePartiesWithNotices(caseId) {
  const parties = db
    .prepare(`
      SELECT
        cp.id AS case_party_id,
        p.id AS party_id,
        p.name,
        p.entity_type,
        cp.role,
        cp.sequence_no,
        cp.is_primary
      FROM pim_case_parties cp
      JOIN pim_parties p
        ON p.id = cp.party_id
      WHERE cp.case_id = ?
        AND cp.role = 'OPPOSITE_PARTY'
        AND cp.active_to IS NULL
      ORDER BY cp.sequence_no, cp.id
    `)
    .all(caseId);

  return parties.map((party) => {
    const notices = db
      .prepare(`
        SELECT
          n.id AS notice_id,
          n.notice_type,
          n.notice_date,
          n.appearance_date,
          n.appearance_time,
          n.status AS notice_status,
          sa.id AS service_attempt_id,
          sa.dispatch_date,
          sa.tracking_no,
          sa.tracking_status,
          sa.postal_endorsement,
          sa.delivered_date,
          sa.returned_date,
          sa.remarks AS service_remarks
        FROM pim_notices n
        LEFT JOIN pim_service_attempts sa
          ON sa.id = (
            SELECT id
            FROM pim_service_attempts
            WHERE notice_id = n.id
            ORDER BY id DESC
            LIMIT 1
          )
        WHERE n.case_id = ?
          AND n.recipient_party_id = ?
          AND n.status IN ('DISPATCHED', 'SERVED')
        ORDER BY n.id DESC
      `)
      .all(caseId, party.party_id);

    return { ...party, notices };
  });
}

function getResponses(caseId) {
  return db
    .prepare(`
      SELECT
        r.*,
        p.name AS party_name,
        n.notice_type
      FROM pim_responses r
      JOIN pim_parties p
        ON p.id = r.party_id
      LEFT JOIN pim_notices n
        ON n.id = r.notice_id
      WHERE r.case_id = ?
      ORDER BY r.id DESC
    `)
    .all(caseId);
}

export async function GET(
  request,
  { params }
) {
  try {
    requirePermission(request, "READ_CASE");

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

    return Response.json({
      success: true,
      data: {
        case: caseData,
        oppositeParties: getOppositePartiesWithNotices(caseId),
        responses: getResponses(caseId),
        today: today(),
        maxAlternateDate: addDays(today(), 10),
      },
    });
  } catch (error) {
    console.error("Response GET error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load response data.",
      },
      { status: 500 }
    );
  }
}

export async function POST(
  request,
  { params }
) {
  try {
    const user = requirePermission(
      request,
      "RECORD_RESPONSE"
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

    const partyId = Number(body.partyId);
    const noticeId = Number(body.noticeId);

    const responseType = String(
      body.responseType || ""
    ).trim();

    const appearanceMode = body.appearanceMode
      ? String(body.appearanceMode).trim()
      : null;

    const responseDate = body.responseDate
      ? String(body.responseDate).trim()
      : today();

    const timeRequestedUntil = body.timeRequestedUntil
      ? String(body.timeRequestedUntil).trim()
      : null;

    const consent =
      body.consent === null || body.consent === undefined
        ? null
        : Number(body.consent);

    const mediationFeeRequested =
      body.mediationFeeRequested === null ||
      body.mediationFeeRequested === undefined
        ? null
        : Number(body.mediationFeeRequested);

    const remarks = body.remarks
      ? String(body.remarks).trim()
      : null;

    if (!Number.isInteger(partyId) || partyId <= 0) {
      return Response.json(
        {
          success: false,
          message: "Opposite party is required.",
        },
        { status: 400 }
      );
    }

    if (!Number.isInteger(noticeId) || noticeId <= 0) {
      return Response.json(
        {
          success: false,
          message:
            "A specific notice must be identified for this OP response.",
        },
        { status: 400 }
      );
    }

    if (!ALLOWED_RESPONSE_TYPES.includes(responseType)) {
      return Response.json(
        {
          success: false,
          message: "Invalid response type.",
        },
        { status: 400 }
      );
    }

    if (!responseDate) {
      return Response.json(
        {
          success: false,
          message: "Response date is required.",
        },
        { status: 400 }
      );
    }

    if (consent !== null && ![0, 1].includes(consent)) {
      return Response.json(
        {
          success: false,
          message: "Consent must be 0, 1, or null.",
        },
        { status: 400 }
      );
    }

    if (
      mediationFeeRequested !== null &&
      ![0, 1].includes(mediationFeeRequested)
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Mediation fee requested must be 0, 1, or null.",
        },
        { status: 400 }
      );
    }

    const result = db.transaction(() => {
      const caseData = getCase(caseId);

      if (!caseData) {
        throw new Error("PIM case not found.");
      }

      const oppositeParty = getActiveOppositeParty(
        caseId,
        partyId
      );

      if (!oppositeParty) {
        throw new Error(
          "Selected party is not an active opposite party in this case."
        );
      }

      /*
       * Notice/service validation (rule 8): never allow a
       * response to be recorded against an unissued notice or
       * a notice belonging to a different opposite party.
       */
      const { notice } = requireIssuedNoticeForParty(
        caseId,
        partyId,
        noticeId
      );

      const isFinal = notice.notice_type === "FORM_2_FINAL";
      const noticeLabel = isFinal ? "Final Notice" : "Initial Notice";

      /*
       * One case-level statutory mediation fee requirement is
       * shared between all opposite parties (rule 11) - it is
       * never multiplied because another OP also consents. So a
       * second (or later) OP's own consent must still be
       * recordable once the case has already reached
       * FEE_PENDING through a different OP, without re-running
       * the status transition or creating another fee row.
       * Any other response type/decision combination while
       * already at FEE_PENDING is a mixed-party consent policy
       * question deferred out of this scope, so it is rejected.
       */
      const isAdditionalConsentAfterFeePending =
        caseData.status_code === "FEE_PENDING" &&
        responseType === "APPEARED" &&
        consent === 1 &&
        mediationFeeRequested === 1;

      if (
        !RESPONSE_ENTRY_STATUSES.includes(caseData.status_code) &&
        !isAdditionalConsentAfterFeePending
      ) {
        throw new Error(
          `This case is not currently available for recording an OP response. Current status: ${caseData.status_name}`
        );
      }

      /*
       * APPEARED
       *
       * The UI may record appearance and the consent decision
       * together (fast path) or appearance alone, to be decided
       * later via the consent route.
       */
      if (responseType === "APPEARED") {
        const responseId = insertResponse({
          caseId,
          partyId,
          noticeId,
          responseDate,
          appearanceMode,
          responseType,
          timeRequestedUntil: null,
          consent,
          mediationFeeRequested,
          remarks,
          userId: user.id,
        });

        if (consent === 1 && mediationFeeRequested === 1) {
          if (!isAdditionalConsentAfterFeePending) {
            transitionStatus(
              caseId,
              caseData.status_code,
              "FEE_PENDING",
              `Opposite party ${oppositeParty.name} appeared and consented to mediation after ${noticeLabel}. Mediation fee requested.`,
              user.id
            );
          }

          /*
           * Case-level dedup: reuses the existing mediation fee
           * row if the case already has one (e.g. another OP's
           * consent already created it) rather than creating a
           * second one for this OP.
           */
          ensureMediationFee(
            caseId,
            partyId,
            "Mediation fee pending after OP consent."
          );

          completeTaskIfPending(
            caseId,
            "OP_APPEARANCE_FOLLOWUP",
            user.id,
            "OP appeared and consented to mediation."
          );

          addDocket(
            caseId,
            "OP_CONSENT",
            `Opposite party ${oppositeParty.name} appeared and consented to mediation after ${noticeLabel}.`,
            "Mediation fee",
            null,
            user.id
          );

          return {
            responseId,
            caseId,
            partyId,
            noticeId,
            statusCode: "FEE_PENDING",
            message:
              "OP consent recorded. Mediation fee is now pending.",
          };
        }

        if (consent === 0) {
          transitionStatus(
            caseId,
            caseData.status_code,
            "OP_REFUSED",
            `Opposite party ${oppositeParty.name} appeared and refused mediation after ${noticeLabel}.`,
            user.id
          );

          completeTaskIfPending(
            caseId,
            "OP_APPEARANCE_FOLLOWUP",
            user.id,
            "OP appeared and refused mediation."
          );

          createNonStarterHandoff(
            caseId,
            oppositeParty.name,
            `OP refused mediation after appearing (${noticeLabel}).`,
            user.id
          );

          addDocket(
            caseId,
            "OP_REFUSAL",
            `Opposite party ${oppositeParty.name} appeared and refused mediation after ${noticeLabel}.`,
            "Non-starter handoff (Phase 5)",
            null,
            user.id
          );

          return {
            responseId,
            caseId,
            partyId,
            noticeId,
            statusCode: "OP_REFUSED",
            message: "OP refusal recorded.",
          };
        }

        /*
         * Appearance recorded, consent not yet decided. Stay at
         * OP_APPEARED until the dedicated consent route is used.
         */
        transitionStatus(
          caseId,
          caseData.status_code,
          "OP_APPEARED",
          `Opposite party ${oppositeParty.name} appeared after ${noticeLabel}.`,
          user.id
        );

        completeTaskIfPending(
          caseId,
          "OP_APPEARANCE_FOLLOWUP",
          user.id,
          "OP appeared; consent decision pending."
        );

        addDocket(
          caseId,
          "OP_APPEARED",
          `Opposite party ${oppositeParty.name} appeared before the authority after ${noticeLabel}.`,
          "Record mediation consent",
          null,
          user.id
        );

        return {
          responseId,
          caseId,
          partyId,
          noticeId,
          statusCode: "OP_APPEARED",
        };
      }

      /*
       * SOUGHT TIME
       */
      if (responseType === "SOUGHT_TIME") {
        if (caseData.status_code !== "SERVICE_PENDING") {
          throw new Error(
            `This case is not currently available for an OP time request. Current status: ${caseData.status_name}`
          );
        }

        if (!timeRequestedUntil) {
          throw new Error(
            "Alternate appearance date is required."
          );
        }

        assertAlternateDateWithinWindow(
          responseDate,
          timeRequestedUntil
        );

        const responseId = insertResponse({
          caseId,
          partyId,
          noticeId,
          responseDate,
          appearanceMode,
          responseType,
          timeRequestedUntil,
          consent: null,
          mediationFeeRequested: null,
          remarks,
          userId: user.id,
        });

        transitionStatus(
          caseId,
          "SERVICE_PENDING",
          "OP_APPEARANCE_PENDING",
          `Opposite party ${oppositeParty.name} sought time to appear after ${noticeLabel}. Alternate date: ${timeRequestedUntil}.`,
          user.id
        );

        createPendingTaskIfNotExists(
          caseId,
          "OP_APPEARANCE_FOLLOWUP",
          `OP appearance follow-up for ${oppositeParty.name} (${noticeLabel}).`,
          timeRequestedUntil
        );

        addDocket(
          caseId,
          "OP_TIME_REQUESTED",
          `Opposite party ${oppositeParty.name} sought time to appear after ${noticeLabel}.`,
          "Await opposite party appearance",
          timeRequestedUntil,
          user.id
        );

        return {
          responseId,
          caseId,
          partyId,
          noticeId,
          statusCode: "OP_APPEARANCE_PENDING",
          nextDate: timeRequestedUntil,
        };
      }

      /*
       * REFUSED (direct refusal, without a separate APPEARED
       * step - e.g. refusal communicated in writing/through
       * counsel and recorded directly).
       */
      if (responseType === "REFUSED") {
        const responseId = insertResponse({
          caseId,
          partyId,
          noticeId,
          responseDate,
          appearanceMode,
          responseType,
          timeRequestedUntil: null,
          consent: 0,
          mediationFeeRequested: null,
          remarks,
          userId: user.id,
        });

        transitionStatus(
          caseId,
          caseData.status_code,
          "OP_REFUSED",
          `Opposite party ${oppositeParty.name} refused mediation after ${noticeLabel}.`,
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
          oppositeParty.name,
          `OP refused mediation after ${noticeLabel}.`,
          user.id
        );

        addDocket(
          caseId,
          "OP_REFUSAL",
          `Opposite party ${oppositeParty.name} refused mediation after ${noticeLabel}.`,
          "Non-starter handoff (Phase 5)",
          null,
          user.id
        );

        return {
          responseId,
          caseId,
          partyId,
          noticeId,
          statusCode: "OP_REFUSED",
        };
      }

      /*
       * DID NOT APPEAR / NO RESPONSE
       *
       * Context-aware: the consequence depends on whether this
       * is the Initial notice's original appearance date, the
       * Final notice's original appearance date, or an alternate
       * date fixed after a time request.
       */
      if (responseType === "DID_NOT_APPEAR") {
        const onAlternateDate =
          caseData.status_code === "OP_APPEARANCE_PENDING";

        let thresholdDate;

        if (onAlternateDate) {
          const soughtTime = getLatestResponse(
            caseId,
            partyId,
            "SOUGHT_TIME"
          );

          if (!soughtTime || !soughtTime.time_requested_until) {
            throw new Error(
              "No alternate appearance date is on record for this opposite party."
            );
          }

          thresholdDate = soughtTime.time_requested_until;
        } else {
          thresholdDate = notice.appearance_date;
        }

        assertNotPremature(thresholdDate, "OP absence");

        const responseId = insertResponse({
          caseId,
          partyId,
          noticeId,
          responseDate,
          appearanceMode,
          responseType,
          timeRequestedUntil: null,
          consent: null,
          mediationFeeRequested: null,
          remarks,
          userId: user.id,
        });

        /*
         * Initial notice, original appearance date, no response:
         * route to Final Notice - never OP_REFUSED, never a
         * non-starter at this stage.
         */
        if (!onAlternateDate && !isFinal) {
          transitionStatus(
            caseId,
            "SERVICE_PENDING",
            "FINAL_NOTICE_PENDING",
            `Opposite party ${oppositeParty.name} did not appear / no response received after Initial Notice.`,
            user.id
          );

          createPendingTaskIfNotExists(
            caseId,
            "FINAL_NOTICE_FOLLOWUP",
            `Prepare Final Notice for ${oppositeParty.name}.`,
            today()
          );

          addDocket(
            caseId,
            "OP_NO_RESPONSE",
            `Opposite party ${oppositeParty.name} did not appear / no response after Initial Notice.`,
            "Prepare Final Notice",
            null,
            user.id
          );

          return {
            responseId,
            caseId,
            partyId,
            noticeId,
            statusCode: "FINAL_NOTICE_PENDING",
          };
        }

        /*
         * Final notice absence, or alternate-date absence
         * (Initial or Final): Phase 5 non-starter handoff. Case
         * status is intentionally left unchanged - no dedicated
         * status exists for this fact; the pending
         * NONSTARTER_FORM3 task is the next-action signal.
         */
        completeTaskIfPending(
          caseId,
          "OP_APPEARANCE_FOLLOWUP",
          user.id,
          "OP did not appear on the alternate date."
        );

        createNonStarterHandoff(
          caseId,
          oppositeParty.name,
          onAlternateDate
            ? "OP did not appear on the alternate appearance date."
            : "OP did not appear / no response after Final Notice.",
          user.id
        );

        addDocket(
          caseId,
          "OP_NO_RESPONSE",
          onAlternateDate
            ? `Opposite party ${oppositeParty.name} did not appear on the alternate date.`
            : `Opposite party ${oppositeParty.name} did not appear / no response after Final Notice.`,
          "Non-starter handoff (Phase 5)",
          null,
          user.id
        );

        return {
          responseId,
          caseId,
          partyId,
          noticeId,
          statusCode: caseData.status_code,
        };
      }

      throw new Error("Unsupported response type.");
    })();

    return Response.json({
      success: true,
      message:
        result.message ||
        "Opposite party response recorded successfully.",
      data: result,
    });
  } catch (error) {
    console.error("Response POST error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to record OP response.",
      },
      { status: 400 }
    );
  }
}
