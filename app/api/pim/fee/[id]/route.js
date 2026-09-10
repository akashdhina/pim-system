const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  calculateMediationFee,
} = require("../../../../../lib/pim-mediation-fee");

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getStatusId(code) {
  const row = db.prepare(`
    SELECT id
    FROM status_master
    WHERE code = ?
  `).get(code);

  if (!row) {
    throw new Error(`Status not found: ${code}`);
  }

  return row.id;
}

function getEventId(code) {
  const row = db.prepare(`
    SELECT id
    FROM event_types
    WHERE code = ?
  `).get(code);

  if (!row) {
    throw new Error(`Event not found: ${code}`);
  }

  return row.id;
}

function getTotalFee(claimAmount) {
  const totalFee = calculateMediationFee(claimAmount);

  if (totalFee === null) {
    throw new Error(
      "Mediation fee cannot be calculated. Claim amount must be above ₹3,00,000 and below ₹1,00,00,000."
    );
  }

  return totalFee;
}

function getCase(caseId) {
  return db.prepare(`
    SELECT
      c.*,
      s.code AS status_code,
      s.name AS status_name
    FROM pim_cases c
    JOIN status_master s
      ON s.id = c.current_status_id
    WHERE c.id = ?
  `).get(caseId);
}

/*
 * Rule 11's mediation fee is ONE statutory obligation for the
 * single PIM proceeding. Deduplication is by case_id alone -
 * never by case+party, and never one row per side. party_id on
 * the row is informational only (whichever party's payment
 * first created it) and is never re-checked on later payments.
 */
function getPrimaryParty(caseId, role) {
  return db.prepare(`
    SELECT cp.party_id, p.name AS party_name
    FROM pim_case_parties cp
    JOIN pim_parties p
      ON p.id = cp.party_id
    WHERE cp.case_id = ?
      AND cp.role = ?
      AND cp.is_primary = 1
      AND cp.active_to IS NULL
  `).get(caseId, role);
}

function getMediationFeeRow(caseId) {
  return db.prepare(`
    SELECT
      f.*,
      p.name AS party_name,
      cp.role AS party_role
    FROM pim_fees f
    LEFT JOIN pim_parties p
      ON p.id = f.party_id
    LEFT JOIN pim_case_parties cp
      ON cp.case_id = f.case_id
     AND cp.party_id = f.party_id
    WHERE f.case_id = ?
      AND f.fee_type = 'MEDIATION_FEE'
    LIMIT 1
  `).get(caseId);
}

function getFees(caseId) {
  const row = getMediationFeeRow(caseId);
  return row ? [row] : [];
}

/*
 * Creates the single case-level MEDIATION_FEE row if one does
 * not already exist (e.g. via the Phase 4.1 consent-time
 * skeleton). amount_due is always the FULL statutory fee, never
 * halved - it is never duplicated for a second side or for
 * additional opposite parties.
 */
function ensureMediationFeeRow(caseId, totalFee) {
  const existing = getMediationFeeRow(caseId);

  if (existing) {
    if (existing.amount_due == null) {
      db.prepare(`
        UPDATE pim_fees
        SET amount_due = ?
        WHERE id = ?
      `).run(totalFee, existing.id);
    }

    return getMediationFeeRow(caseId);
  }

  const triggeringParty =
    getPrimaryParty(caseId, "OPPOSITE_PARTY") ||
    getPrimaryParty(caseId, "APPLICANT");

  db.prepare(`
    INSERT INTO pim_fees
    (
      case_id,
      party_id,
      fee_type,
      amount_due,
      amount_received,
      status,
      remarks
    )
    VALUES (?, ?, 'MEDIATION_FEE', ?, 0, 'PENDING', ?)
  `).run(
    caseId,
    triggeringParty ? triggeringParty.party_id : null,
    totalFee,
    "Mediation fee pending."
  );

  return getMediationFeeRow(caseId);
}

function addStatusHistory(
  caseId,
  fromStatusId,
  toStatusId,
  reason,
  userId = null
) {
  db.prepare(`
    INSERT INTO pim_status_history
    (
      case_id,
      from_status_id,
      to_status_id,
      reason,
      changed_by
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    caseId,
    fromStatusId,
    toStatusId,
    reason,
    userId
  );
}

function addDocket(
  caseId,
  eventCode,
  entryText,
  actionRequired = null,
  userId = null
) {
  const eventId = getEventId(eventCode);

  db.prepare(`
    INSERT INTO pim_docket
    (
      case_id,
      docket_date,
      event_type_id,
      entry_text,
      action_required,
      next_date,
      entered_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    caseId,
    today(),
    eventId,
    entryText,
    actionRequired,
    null,
    userId
  );
}

export async function GET(
  request,
  { params }
) {
  try {
    requirePermission(request, "READ_CASE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json(
        { success: false, message: "Invalid case ID." },
        { status: 400 }
      );
    }

    const caseData = getCase(caseId);

    if (!caseData) {
      return Response.json(
        { success: false, message: "PIM case not found." },
        { status: 404 }
      );
    }

    const totalFee = calculateMediationFee(caseData.claim_amount);
    // Display-only: the statutory fee is shared equally between
    // the two sides, but this is informational - amount_due on
    // the single MEDIATION_FEE row is always the FULL totalFee.
    const shareAmount = totalFee === null ? null : totalFee / 2;
    const fees = getFees(caseId);

    return Response.json({
      success: true,
      data: {
        case: caseData,
        fee: fees[0] || null,
        fees,
        feeSchedule: {
          totalFee,
          shareAmount,
          applicantShare: shareAmount,
          oppositePartyShare: shareAmount,
        },
      },
    });
  } catch (error) {
    console.error("Fee GET error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load fee data.",
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
      "RECORD_FEE"
    );

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json(
        { success: false, message: "Invalid case ID." },
        { status: 400 }
      );
    }

    const body = await request.json();
    const receivedDate = body.receivedDate
      ? String(body.receivedDate).trim()
      : today();
    const depositedDate = body.depositedDate
      ? String(body.depositedDate).trim()
      : null;
    const remarks = body.remarks
      ? String(body.remarks).trim()
      : null;

    const result = db.transaction(() => {
      const caseData = getCase(caseId);

      if (!caseData) {
        throw new Error("PIM case not found.");
      }

      if (caseData.status_code !== "FEE_PENDING") {
        throw new Error(
          `This case is not currently available for mediation fee collection. Current status: ${caseData.status_name}`
        );
      }

      const totalFee = getTotalFee(caseData.claim_amount);
      const shareAmount = totalFee / 2;
      const feeRow = ensureMediationFeeRow(caseId, totalFee);

      let increment = 0;
      const paymentNotes = [];
      let latestDd = null;

      for (const [key, label] of [
        ["applicant", "Applicant"],
        ["oppositeParty", "Opposite party"],
      ]) {
        const rawAmount = body[`${key}AmountReceived`];

        if (
          rawAmount === undefined ||
          rawAmount === null ||
          rawAmount === ""
        ) {
          // This side's payment was not part of this submission -
          // partial payments can be recorded in separate calls.
          continue;
        }

        const ddNumber = body[`${key}DdNumber`]
          ? String(body[`${key}DdNumber`]).trim()
          : null;
        const ddDate = body[`${key}DdDate`]
          ? String(body[`${key}DdDate`]).trim()
          : null;
        const bankName = body[`${key}BankName`]
          ? String(body[`${key}BankName`]).trim()
          : null;
        const payee = body[`${key}Payee`]
          ? String(body[`${key}Payee`]).trim()
          : "Chairman, DLSA";
        const amountReceived = Number(rawAmount);

        if (
          !Number.isFinite(amountReceived) ||
          amountReceived <= 0
        ) {
          throw new Error(
            `${label} mediation fee received amount is invalid.`
          );
        }

        if (!ddNumber) {
          throw new Error(`${label} DD number is required.`);
        }

        if (!ddDate) {
          throw new Error(`${label} DD date is required.`);
        }

        if (!bankName) {
          throw new Error(`${label} bank name is required.`);
        }

        if (payee !== "Chairman, DLSA") {
          throw new Error(
            `${label} DD must be drawn in favour of Chairman, DLSA.`
          );
        }

        increment += amountReceived;
        latestDd = { ddNumber, ddDate, bankName, payee };
        paymentNotes.push(
          `${label} paid ₹${amountReceived.toLocaleString("en-IN")} via DD ${ddNumber} dated ${ddDate} (${bankName}).`
        );
      }

      if (increment === 0) {
        throw new Error(
          "At least one side's mediation fee payment must be submitted."
        );
      }

      /*
       * Cumulative accounting (rule 6): this submission's amount
       * is ADDED to whatever has already been recorded - never
       * replaces it, so an earlier receipt can never be lost or
       * reduced by a later, smaller submission.
       */
      const newAmountReceived =
        Number(feeRow.amount_received || 0) + increment;
      const fullyPaid = newAmountReceived >= totalFee;

      db.prepare(`
        UPDATE pim_fees
        SET
          amount_received = ?,
          dd_number = COALESCE(?, dd_number),
          dd_date = COALESCE(?, dd_date),
          bank_name = COALESCE(?, bank_name),
          payee = COALESCE(?, payee),
          received_date = ?,
          deposited_date = COALESCE(?, deposited_date),
          status = ?,
          remarks = TRIM(
            COALESCE(remarks || char(10), '') || ?
          )
        WHERE id = ?
      `).run(
        newAmountReceived,
        latestDd ? latestDd.ddNumber : null,
        latestDd ? latestDd.ddDate : null,
        latestDd ? latestDd.bankName : null,
        latestDd ? latestDd.payee : null,
        receivedDate,
        depositedDate,
        fullyPaid ? "RECEIVED" : "PENDING",
        [remarks, ...paymentNotes].filter(Boolean).join("\n"),
        feeRow.id
      );

      if (!fullyPaid) {
        return {
          caseId,
          totalFee,
          shareAmount,
          amountReceived: newAmountReceived,
          taskId: null,
          statusCode: "FEE_PENDING",
          fullyPaid: false,
        };
      }

      const fromStatusId = getStatusId("FEE_PENDING");
      const toStatusId = getStatusId("MEDIATOR_ASSIGNMENT_PENDING");

      addStatusHistory(
        caseId,
        fromStatusId,
        toStatusId,
        "Mediation fee received in full.",
        user.id
      );

      db.prepare(`
        UPDATE pim_cases
        SET
          current_status_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(toStatusId, caseId);

      addDocket(
        caseId,
        "MEDIATION_FEE_RECEIVED",
        `Mediation fee ₹${totalFee.toLocaleString("en-IN")} received in full (shared equally between both sides at ₹${shareAmount.toLocaleString("en-IN")} each).`,
        "Mediator assignment",
        user.id
      );

      const existingTask = db.prepare(`
        SELECT id
        FROM pim_tasks
        WHERE case_id = ?
          AND task_type_code = 'MEDIATOR_ASSIGNMENT'
          AND status = 'PENDING'
        LIMIT 1
      `).get(caseId);

      let taskId = existingTask ? existingTask.id : null;

      if (!existingTask) {
        const taskType = db.prepare(`
          SELECT
            id,
            code,
            default_priority
          FROM task_types
          WHERE code = 'MEDIATOR_ASSIGNMENT'
            AND active = 1
          LIMIT 1
        `).get();

        if (!taskType) {
          throw new Error(
            "Active MEDIATOR_ASSIGNMENT task type not found."
          );
        }

        const task = db.prepare(`
          INSERT INTO pim_tasks
          (
            case_id,
            task_type_id,
            task_type_code,
            description,
            created_date,
            due_date,
            priority,
            status,
            auto_generated,
            remarks
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)
        `).run(
          caseId,
          taskType.id,
          taskType.code,
          "Assign mediator after mediation fee receipt.",
          today(),
          today(),
          taskType.default_priority || "NORMAL",
          "Mediation fee received; mediator assignment pending."
        );

        taskId = Number(task.lastInsertRowid);
      }

      return {
        caseId,
        totalFee,
        shareAmount,
        amountReceived: newAmountReceived,
        taskId,
        statusCode: "MEDIATOR_ASSIGNMENT_PENDING",
        fullyPaid: true,
      };
    })();

    return Response.json({
      success: true,
      message: result.fullyPaid
        ? "Mediation fee recorded equally from both sides. Mediator assignment is now pending."
        : "Mediation fee payment recorded. Case remains pending until the full fee is received from both sides.",
      data: result,
    });
  } catch (error) {
    console.error("Fee POST error:", error);

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to record mediation fee.",
      },
      { status: 400 }
    );
  }
}
