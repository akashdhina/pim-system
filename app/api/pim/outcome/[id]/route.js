const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");

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
  entryText,
  actionRequired = null,
  eventCode = "MEDIATION_SESSION",
  userId = null
) {
  const eventId =
    getEventId(eventCode);

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

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getCompletedSessionSummary(caseId) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total_sittings,
      SUM(CASE WHEN effective_session = 1 THEN 1 ELSE 0 END) AS effective_sittings,
      COALESCE(
        SUM(
          CASE
            WHEN effective_session = 1
            THEN COALESCE(duration_minutes, 0)
            ELSE 0
          END
        ),
        0
      ) AS effective_duration_minutes,
      MAX(actual_date) AS last_actual_date
    FROM mediation_sessions
    WHERE case_id = ?
      AND session_status = 'COMPLETED'
  `).get(caseId);
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

    const outcome =
      db.prepare(`
        SELECT
          o.*,
          vu.display_name AS verified_by_name,
          vu.designation AS verified_by_designation,
          au.display_name AS approved_by_name,
          au.designation AS approved_by_designation,
          d.document_title,
          d.document_type,
          d.document_date,
          d.version_no AS document_version_no,
          CASE
            WHEN d.file_path IS NOT NULL
              AND d.file_path <> ''
            THEN 1
            ELSE 0
          END AS document_has_file
        FROM pim_outcomes o
        LEFT JOIN users vu
          ON vu.id = o.verified_by
        LEFT JOIN users au
          ON au.id = o.approved_by
        LEFT JOIN pim_documents d
          ON d.id = o.document_id
        WHERE o.case_id = ?
      `).get(caseId);

    const parties =
      db.prepare(`
        SELECT
          cp.role,
          cp.is_primary,
          p.id AS party_id,
          p.name
        FROM pim_case_parties cp
        JOIN pim_parties p
          ON p.id = cp.party_id
        WHERE cp.case_id = ?
        ORDER BY
          CASE cp.role
            WHEN 'APPLICANT' THEN 1
            WHEN 'OPPOSITE_PARTY' THEN 2
            ELSE 3
          END,
          cp.is_primary DESC,
          cp.id
      `).all(caseId);

    const assignment =
      db.prepare(`
        SELECT
          a.*,
          m.name AS mediator_name,
          m.category AS mediator_category,
          m.enrollment_no
        FROM pim_mediator_assignments a
        JOIN mediators m
          ON m.id = a.mediator_id
        WHERE a.case_id = ?
          AND a.status = 'ACTIVE'
        ORDER BY a.id DESC
        LIMIT 1
      `).get(caseId);

    const sessions =
      db.prepare(`
        SELECT *
        FROM mediation_sessions
        WHERE case_id = ?
        ORDER BY sitting_number
      `).all(caseId);

    const sessionSummary =
      getCompletedSessionSummary(caseId);

    /*
     * Phase 9: next_action is now a structured column on
     * mediation_sessions and is the authoritative source. Older
     * rows recorded before that migration only carry the Phase 7
     * fixed phrase in administrative_remarks - fall back to that
     * exact-phrase match (never arbitrary prose parsing) only
     * when the structured column is null. This remains a
     * preselection signal for the UI, never an authoritative
     * lock; staff can always override.
     */
    const lastEffectiveSession =
      db.prepare(`
        SELECT next_action, administrative_remarks
        FROM mediation_sessions
        WHERE case_id = ?
          AND effective_session = 1
          AND session_status = 'COMPLETED'
        ORDER BY sitting_number DESC
        LIMIT 1
      `).get(caseId);

    let phase7Signal = null;

    if (lastEffectiveSession?.next_action === "READY_FOR_SETTLEMENT") {
      phase7Signal = "SETTLEMENT";
    } else if (lastEffectiveSession?.next_action === "READY_FOR_FAILURE") {
      phase7Signal = "FAILURE";
    } else if (
      lastEffectiveSession?.next_action == null &&
      lastEffectiveSession?.administrative_remarks
    ) {
      const remarksText = lastEffectiveSession.administrative_remarks;

      if (remarksText.includes("Ready for settlement outcome")) {
        phase7Signal = "SETTLEMENT";
      } else if (remarksText.includes("Ready for failure outcome")) {
        phase7Signal = "FAILURE";
      }
    }
    // next_action === 'FURTHER_MEDIATION' (or null with no legacy
    // phrase) correctly leaves phase7Signal null - it must never
    // expose settlement/failure as an already-decided signal.

    const activeUsers =
      db.prepare(`
        SELECT
          id,
          display_name,
          designation
        FROM users
        WHERE active = 1
        ORDER BY id
      `).all();

    const nonstarterReasons =
      db.prepare(`
        SELECT
          id,
          code,
          name,
          rule_reference,
          requires_authority_decision,
          active,
          remarks
        FROM nonstarter_reasons
        WHERE active = 1
        ORDER BY id
      `).all();

    const tasks =
      db.prepare(`
        SELECT *
        FROM pim_tasks
        WHERE case_id = ?
        ORDER BY id
      `).all(caseId);

    const documents =
      db.prepare(`
        SELECT
          id,
          case_id,
          document_type,
          document_title,
          document_date,
          CASE
            WHEN file_path IS NOT NULL
              AND file_path <> ''
            THEN 1
            ELSE 0
          END AS has_file,
          generated_by_system,
          version_no,
          is_current,
          remarks,
          created_by,
          created_at
        FROM pim_documents
        WHERE case_id = ?
          AND file_path IS NOT NULL
          AND file_path <> ''
        ORDER BY
          is_current DESC,
          document_type,
          version_no DESC,
          id DESC
      `).all(caseId);

    return Response.json({
      success: true,
      data: {
        case: caseData,
        outcome: outcome || null,
        parties,
        assignment: assignment || null,
        sessions,
        sessionSummary,
        phase7Signal,
        activeUsers,
        nonstarterReasons,
        tasks,
        documents,
      },
    });
  } catch (error) {
    console.error(
      "Outcome GET error:",
      error
    );

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load outcome data.",
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
      "RECORD_OUTCOME"
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

    const body =
      await request.json();

    const outcomeType =
      body.outcomeType
        ? String(
            body.outcomeType
          ).trim().toUpperCase()
        : "";

    const outcomeDate =
      body.outcomeDate
        ? String(
            body.outcomeDate
          ).trim()
        : today();

    const reasonText =
      body.reasonText
        ? String(
            body.reasonText
          ).trim()
        : null;

    const settlementTerms =
      body.settlementTerms
        ? String(
            body.settlementTerms
          ).trim()
        : null;

    const formNo =
      body.formNo
        ? String(
            body.formNo
          ).trim()
        : null;

    const remarks =
      body.remarks
        ? String(
            body.remarks
          ).trim()
        : null;

    if (
      ![
        "SETTLED",
        "FAILED",
        "WITHDRAWN",
      ].includes(outcomeType)
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Invalid outcome type. Allowed values: SETTLED, FAILED, WITHDRAWN.",
        },
        { status: 400 }
      );
    }

    if (
      !outcomeDate ||
      !isIsoDate(outcomeDate)
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Outcome date is required in YYYY-MM-DD format.",
        },
        { status: 400 }
      );
    }

    if (outcomeDate > today()) {
      return Response.json(
        {
          success: false,
          message:
            "Outcome date cannot be in the future.",
        },
        { status: 400 }
      );
    }

    const result =
      db.transaction(() => {
        const caseData =
          getCase(caseId);

        if (!caseData) {
          throw new Error(
            "PIM case not found."
          );
        }

        if (
          caseData.status_code !==
            "OUTCOME_FORM_PENDING"
        ) {
          throw new Error(
            `This case is not currently available for outcome recording. Current status: ${caseData.status_name}`
          );
        }

        const existingOutcome =
          db.prepare(`
            SELECT id
            FROM pim_outcomes
            WHERE case_id = ?
          `).get(caseId);

        if (existingOutcome) {
          throw new Error(
            "An outcome has already been recorded for this case."
          );
        }

        if (
          outcomeType ===
          "NON_STARTER"
        ) {
          throw new Error(
            "NON_STARTER must be recorded through the dedicated non-starter workflow."
          );
        }

        const sessionSummary =
          getCompletedSessionSummary(caseId);

        if (
          Number(
            sessionSummary.total_sittings
          ) < 1
        ) {
          throw new Error(
            "Outcome cannot be recorded before at least one mediation session is completed."
          );
        }

        if (
          sessionSummary.last_actual_date &&
          outcomeDate <
            sessionSummary.last_actual_date
        ) {
          throw new Error(
            "Outcome date cannot be before the last recorded actual mediation date."
          );
        }

        if (
          outcomeType ===
          "SETTLED" &&
          !settlementTerms
        ) {
          throw new Error(
            "Settlement terms are required for a SETTLED outcome."
          );
        }

        if (
          outcomeType ===
            "FAILED" &&
          !reasonText
        ) {
          throw new Error(
            "Failure reason/details are required for a FAILED outcome."
          );
        }

        if (
          outcomeType ===
            "WITHDRAWN" &&
          !reasonText
        ) {
          throw new Error(
            "Withdrawal party/source and reason/details are required for a WITHDRAWN outcome."
          );
        }

        const outcome =
          db.prepare(`
            INSERT INTO pim_outcomes
            (
              case_id,
              outcome_type,
              form_no,
              outcome_date,
              nonstarter_reason_id,
              reason_text,
              settlement_terms,
              prepared_by,
              verified_by,
              approved_by,
              document_id,
              sent_to_applicant,
              sent_to_opposite_party,
              remarks
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
          `).run(
            caseId,
            outcomeType,
            formNo,
            outcomeDate,
            null,
            reasonText,
            settlementTerms,
            user.id,
            null,
            null,
            null,
            remarks
          );

        const outcomeId =
          Number(
            outcome.lastInsertRowid
          );

        const fromStatusId =
          getStatusId(
            "MEDIATION_ONGOING"
          );

        const toStatusId =
          getStatusId(
            "OUTCOME_FORM_PENDING"
          );

        if (
          caseData.status_code !==
          "OUTCOME_FORM_PENDING"
        ) {
          addStatusHistory(
            caseId,
            fromStatusId,
            toStatusId,
            `Mediation outcome recorded as ${outcomeType}; outcome form pending.`,
            user.id
          );
        }

        db.prepare(`
          UPDATE pim_cases
          SET
            current_status_id = ?,
            outcome_type = ?,
            outcome_date = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          toStatusId,
          outcomeType,
          outcomeDate,
          caseId
        );

        addDocket(
            caseId,
            `Mediation outcome recorded: ${outcomeType}. Outcome form pending.`,
            "Outcome approval",
            outcomeType === "SETTLED"
              ? "FORM4"
              : outcomeType === "WITHDRAWN"
                ? "WITHDRAWAL"
                : "FORM5",
            user.id
          );

        /*
         * The pending OUTCOME_FORM task deliberately stays
         * PENDING here (Phase 8 correction): it is only completed
         * once the required Form IV/Form V document has actually
         * been generated AND the case has been closed via
         * /api/pim/outcome/approve/[id]. Completing it at this
         * step - before any document exists - previously let a
         * case sit with no actionable task while nothing enforced
         * that a document would ever be generated.
         */
        const pendingOutcomeTask =
          db.prepare(`
            SELECT id
            FROM pim_tasks
            WHERE case_id = ?
              AND status = 'PENDING'
              AND task_type_code = 'OUTCOME_FORM'
            ORDER BY id DESC
            LIMIT 1
          `).get(caseId);

        return {
          caseId,
          outcomeId,
          outcomeType,
          outcomeDate,
          formNo,
          nonstarterReasonId: null,
          taskId:
            pendingOutcomeTask?.id || null,
          statusCode:
            "OUTCOME_FORM_PENDING",
        };
      })();

    return Response.json({
      success: true,
      message:
        "Mediation outcome recorded successfully. Outcome form is now pending.",
      data: result,
    });
  } catch (error) {
    console.error(
      "Outcome POST error:",
      error
    );

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to record mediation outcome.",
      },
      { status: 400 }
    );
  }
}
