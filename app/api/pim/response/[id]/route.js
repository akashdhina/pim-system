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
const {
  getResponseDataPg,
  recordResponsePg,
} = require("../../../../../lib/pim-data/response");

const ALLOWED_RESPONSE_TYPES = [
  "APPEARED",
  "SOUGHT_TIME",
  "REFUSED",
  "DID_NOT_APPEAR",
];

/*
 * The ORIGINAL SQLite entry-status set, kept unused as part of the
 * instant-rollback baseline below. Batch 5K's PostgreSQL module uses a
 * BROADER set (adds FEE_PENDING unconditionally, replacing this file's
 * old narrow isAdditionalConsentAfterFeePending carve-out) - see
 * lib/pim-data/response.js's own header comment and
 * docs/phase6-batch5k-op-response-consent-migration.md.
 */
const RESPONSE_ENTRY_STATUSES = [
  "SERVICE_PENDING",
  "OP_APPEARANCE_PENDING",
];

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

    // Batch 5K (Phase 6): migrated to PostgreSQL via lib/pim-data/response.js.
    const data = await getResponseDataPg(caseId);

    if (!data) {
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
      data,
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

/*
 * The ORIGINAL SQLite POST body, kept unused as an instant rollback and
 * as the authentic SQLite baseline for scripts/test-pim-response-postgres.js
 * (same convention as every prior batch's kept -Sqlite function). Not
 * called by POST. Pre-existing behavior preserved verbatim, INCLUDING
 * the latent multi-OP defect Batch 5K's audit identified and the
 * approved plan corrected in the PostgreSQL path only (the first
 * consenting opposite party no longer prematurely moves a multi-OP
 * case to FEE_PENDING - see lib/pim-data/response.js).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function recordResponseSqlite(caseId, body, userId) {
  const partyId = Number(body.partyId);
  const noticeId = Number(body.noticeId);
  const responseType = String(body.responseType || "").trim();
  const appearanceMode = body.appearanceMode ? String(body.appearanceMode).trim() : null;
  const responseDate = body.responseDate ? String(body.responseDate).trim() : today();
  const timeRequestedUntil = body.timeRequestedUntil ? String(body.timeRequestedUntil).trim() : null;
  const consent = body.consent === null || body.consent === undefined ? null : Number(body.consent);
  const mediationFeeRequested =
    body.mediationFeeRequested === null || body.mediationFeeRequested === undefined
      ? null
      : Number(body.mediationFeeRequested);
  const remarks = body.remarks ? String(body.remarks).trim() : null;

  return db.transaction(() => {
    const caseData = getCase(caseId);
    if (!caseData) throw new Error("PIM case not found.");

    const oppositeParty = getActiveOppositeParty(caseId, partyId);
    if (!oppositeParty) throw new Error("Selected party is not an active opposite party in this case.");

    const { notice } = requireIssuedNoticeForParty(caseId, partyId, noticeId);
    const isFinal = notice.notice_type === "FORM_2_FINAL";
    const noticeLabel = isFinal ? "Final Notice" : "Initial Notice";

    const isAdditionalConsentAfterFeePending =
      caseData.status_code === "FEE_PENDING" &&
      responseType === "APPEARED" &&
      consent === 1 &&
      mediationFeeRequested === 1;

    if (!RESPONSE_ENTRY_STATUSES.includes(caseData.status_code) && !isAdditionalConsentAfterFeePending) {
      throw new Error(
        `This case is not currently available for recording an OP response. Current status: ${caseData.status_name}`
      );
    }

    if (responseType === "APPEARED") {
      const responseId = insertResponse({
        caseId, partyId, noticeId, responseDate, appearanceMode, responseType,
        timeRequestedUntil: null, consent, mediationFeeRequested, remarks, userId,
      });

      if (consent === 1 && mediationFeeRequested === 1) {
        if (!isAdditionalConsentAfterFeePending) {
          transitionStatus(
            caseId, caseData.status_code, "FEE_PENDING",
            `Opposite party ${oppositeParty.name} appeared and consented to mediation after ${noticeLabel}. Mediation fee requested.`,
            userId
          );
        }

        ensureMediationFee(caseId, partyId, "Mediation fee pending after OP consent.");
        completeTaskIfPending(caseId, "OP_APPEARANCE_FOLLOWUP", userId, "OP appeared and consented to mediation.");
        addDocket(
          caseId, "OP_CONSENT",
          `Opposite party ${oppositeParty.name} appeared and consented to mediation after ${noticeLabel}.`,
          "Mediation fee", null, userId
        );

        return { responseId, caseId, partyId, noticeId, statusCode: "FEE_PENDING", message: "OP consent recorded. Mediation fee is now pending." };
      }

      if (consent === 0) {
        transitionStatus(
          caseId, caseData.status_code, "OP_REFUSED",
          `Opposite party ${oppositeParty.name} appeared and refused mediation after ${noticeLabel}.`, userId
        );
        completeTaskIfPending(caseId, "OP_APPEARANCE_FOLLOWUP", userId, "OP appeared and refused mediation.");
        createNonStarterHandoff(caseId, oppositeParty.name, `OP refused mediation after appearing (${noticeLabel}).`, userId);
        addDocket(
          caseId, "OP_REFUSAL",
          `Opposite party ${oppositeParty.name} appeared and refused mediation after ${noticeLabel}.`,
          "Non-starter handoff (Phase 5)", null, userId
        );
        return { responseId, caseId, partyId, noticeId, statusCode: "OP_REFUSED", message: "OP refusal recorded." };
      }

      transitionStatus(
        caseId, caseData.status_code, "OP_APPEARED",
        `Opposite party ${oppositeParty.name} appeared after ${noticeLabel}.`, userId
      );
      completeTaskIfPending(caseId, "OP_APPEARANCE_FOLLOWUP", userId, "OP appeared; consent decision pending.");
      addDocket(
        caseId, "OP_APPEARED",
        `Opposite party ${oppositeParty.name} appeared before the authority after ${noticeLabel}.`,
        "Record mediation consent", null, userId
      );
      return { responseId, caseId, partyId, noticeId, statusCode: "OP_APPEARED" };
    }

    if (responseType === "SOUGHT_TIME") {
      if (caseData.status_code !== "SERVICE_PENDING") {
        throw new Error(`This case is not currently available for an OP time request. Current status: ${caseData.status_name}`);
      }
      if (!timeRequestedUntil) throw new Error("Alternate appearance date is required.");
      assertAlternateDateWithinWindow(responseDate, timeRequestedUntil);

      const responseId = insertResponse({
        caseId, partyId, noticeId, responseDate, appearanceMode, responseType,
        timeRequestedUntil, consent: null, mediationFeeRequested: null, remarks, userId,
      });

      transitionStatus(
        caseId, "SERVICE_PENDING", "OP_APPEARANCE_PENDING",
        `Opposite party ${oppositeParty.name} sought time to appear after ${noticeLabel}. Alternate date: ${timeRequestedUntil}.`,
        userId
      );
      createPendingTaskIfNotExists(
        caseId, "OP_APPEARANCE_FOLLOWUP", `OP appearance follow-up for ${oppositeParty.name} (${noticeLabel}).`, timeRequestedUntil
      );
      addDocket(
        caseId, "OP_TIME_REQUESTED",
        `Opposite party ${oppositeParty.name} sought time to appear after ${noticeLabel}.`,
        "Await opposite party appearance", timeRequestedUntil, userId
      );
      return { responseId, caseId, partyId, noticeId, statusCode: "OP_APPEARANCE_PENDING", nextDate: timeRequestedUntil };
    }

    if (responseType === "REFUSED") {
      const responseId = insertResponse({
        caseId, partyId, noticeId, responseDate, appearanceMode, responseType,
        timeRequestedUntil: null, consent: 0, mediationFeeRequested: null, remarks, userId,
      });
      transitionStatus(
        caseId, caseData.status_code, "OP_REFUSED",
        `Opposite party ${oppositeParty.name} refused mediation after ${noticeLabel}.`, userId
      );
      completeTaskIfPending(caseId, "OP_APPEARANCE_FOLLOWUP", userId, "OP refused mediation.");
      createNonStarterHandoff(caseId, oppositeParty.name, `OP refused mediation after ${noticeLabel}.`, userId);
      addDocket(
        caseId, "OP_REFUSAL",
        `Opposite party ${oppositeParty.name} refused mediation after ${noticeLabel}.`,
        "Non-starter handoff (Phase 5)", null, userId
      );
      return { responseId, caseId, partyId, noticeId, statusCode: "OP_REFUSED" };
    }

    if (responseType === "DID_NOT_APPEAR") {
      const onAlternateDate = caseData.status_code === "OP_APPEARANCE_PENDING";
      let thresholdDate;

      if (onAlternateDate) {
        const soughtTime = getLatestResponse(caseId, partyId, "SOUGHT_TIME");
        if (!soughtTime || !soughtTime.time_requested_until) {
          throw new Error("No alternate appearance date is on record for this opposite party.");
        }
        thresholdDate = soughtTime.time_requested_until;
      } else {
        thresholdDate = notice.appearance_date;
      }

      assertNotPremature(thresholdDate, "OP absence");

      const responseId = insertResponse({
        caseId, partyId, noticeId, responseDate, appearanceMode, responseType,
        timeRequestedUntil: null, consent: null, mediationFeeRequested: null, remarks, userId,
      });

      if (!onAlternateDate && !isFinal) {
        transitionStatus(
          caseId, "SERVICE_PENDING", "FINAL_NOTICE_PENDING",
          `Opposite party ${oppositeParty.name} did not appear / no response received after Initial Notice.`, userId
        );
        createPendingTaskIfNotExists(caseId, "FINAL_NOTICE_FOLLOWUP", `Prepare Final Notice for ${oppositeParty.name}.`, today());
        addDocket(
          caseId, "OP_NO_RESPONSE",
          `Opposite party ${oppositeParty.name} did not appear / no response after Initial Notice.`,
          "Prepare Final Notice", null, userId
        );
        return { responseId, caseId, partyId, noticeId, statusCode: "FINAL_NOTICE_PENDING" };
      }

      completeTaskIfPending(caseId, "OP_APPEARANCE_FOLLOWUP", userId, "OP did not appear on the alternate date.");
      createNonStarterHandoff(
        caseId, oppositeParty.name,
        onAlternateDate ? "OP did not appear on the alternate appearance date." : "OP did not appear / no response after Final Notice.",
        userId
      );
      addDocket(
        caseId, "OP_NO_RESPONSE",
        onAlternateDate
          ? `Opposite party ${oppositeParty.name} did not appear on the alternate date.`
          : `Opposite party ${oppositeParty.name} did not appear / no response after Final Notice.`,
        "Non-starter handoff (Phase 5)", null, userId
      );
      return { responseId, caseId, partyId, noticeId, statusCode: caseData.status_code };
    }

    throw new Error("Unsupported response type.");
  })();
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
          message: "A specific notice must be identified for this OP response.",
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
          message: "Mediation fee requested must be 0, 1, or null.",
        },
        { status: 400 }
      );
    }

    // Batch 5K (Phase 6): migrated to PostgreSQL via lib/pim-data/response.js.
    // Corrected: the case no longer advances to FEE_PENDING until every
    // active opposite party's latest response shows consent=1 (the
    // all-party consent gate, see lib/pim-data/response.js).
    const result = await recordResponsePg(caseId, {
      partyId, noticeId, responseType, appearanceMode, responseDate,
      timeRequestedUntil, consent, mediationFeeRequested, remarks,
    }, user.id);

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
