/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  officeDate,
} = require("../../../../../../lib/pim-time");

function today() {
  return officeDate();
}

function getEventId(code) {
  const row = db
    .prepare("SELECT id FROM event_types WHERE code = ?")
    .get(code);

  if (!row) {
    throw new Error(`Event not found: ${code}`);
  }

  return row.id;
}

function addDocket(caseId, entryText, enteredBy = null) {
  const eventId = getEventId("MEDIATOR_ASSIGNED");

  db.prepare(`
    INSERT INTO pim_docket
    (case_id, docket_date, event_type_id, entry_text, action_required, next_date, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(caseId, today(), eventId, entryText, null, null, enteredBy);
}

const REASSIGNABLE_STATUSES = new Set([
  "MEDIATOR_ASSIGNED",
  "MEDIATION_PENDING",
  "MEDIATION_ONGOING",
]);

export async function POST(request, { params }) {
  try {
    const user = requirePermission(request, "ASSIGN_MEDIATOR");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json(
        { success: false, message: "Invalid case ID." },
        { status: 400 }
      );
    }

    const body = await request.json();

    const newMediatorId = Number(body.mediatorId);

    const reason = body.reason
      ? String(body.reason).trim()
      : null;

    if (!Number.isInteger(newMediatorId) || newMediatorId <= 0) {
      return Response.json(
        { success: false, message: "A valid mediator must be selected." },
        { status: 400 }
      );
    }

    if (!reason) {
      return Response.json(
        { success: false, message: "A reason for reassignment is required." },
        { status: 400 }
      );
    }

    const result = db.transaction(() => {
      const caseData = db.prepare(`
        SELECT c.*, s.code AS status_code, s.name AS status_name
        FROM pim_cases c
        JOIN status_master s ON s.id = c.current_status_id
        WHERE c.id = ?
      `).get(caseId);

      if (!caseData) {
        throw new Error("PIM case not found.");
      }

      /*
       * Rule 5: no reassignment on terminal cases (this also
       * covers CLOSED_NON_STARTER - non-starter cases never had
       * an active mediation-stage assignment to reassign anyway).
       */
      if (!REASSIGNABLE_STATUSES.has(caseData.status_code)) {
        throw new Error(
          `This case is not currently available for mediator reassignment. Current status: ${caseData.status_name}`
        );
      }

      const currentAssignment = db.prepare(`
        SELECT a.*, m.name AS mediator_name
        FROM pim_mediator_assignments a
        JOIN mediators m ON m.id = a.mediator_id
        WHERE a.case_id = ?
          AND a.status = 'ACTIVE'
        ORDER BY a.id DESC
        LIMIT 1
      `).get(caseId);

      if (!currentAssignment) {
        throw new Error(
          "No active mediator assignment exists for this case to reassign."
        );
      }

      if (currentAssignment.mediator_id === newMediatorId) {
        throw new Error(
          "Cannot reassign to the same mediator that is already active on this case."
        );
      }

      const newMediator = db.prepare(`
        SELECT * FROM mediators WHERE id = ?
      `).get(newMediatorId);

      if (!newMediator) {
        throw new Error("Selected mediator does not exist.");
      }

      if (newMediator.active !== 1) {
        throw new Error(
          "Inactive mediators cannot be newly assigned."
        );
      }

      if (
        newMediator.panel_valid_until &&
        newMediator.panel_valid_until < today()
      ) {
        throw new Error(
          "Mediator panel validity has expired; assignment is blocked."
        );
      }

      /*
       * End the current assignment (never deleted/overwritten -
       * it stays as a preserved, inactive historical record).
       * Existing mediation_sessions rows keep pointing at this
       * assignment_id, so who actually conducted each past
       * sitting remains reconstructable.
       */
      db.prepare(`
        UPDATE pim_mediator_assignments
        SET status = 'ENDED', remarks = COALESCE(remarks || char(10), '') || ?
        WHERE id = ?
      `).run(
        `Reassigned to ${newMediator.name} on ${today()}: ${reason}`,
        currentAssignment.id
      );

      const inserted = db.prepare(`
        INSERT INTO pim_mediator_assignments
        (
          case_id, mediator_id, assignment_date, appointed_by,
          status, replacement_for_assignment_id, remarks
        )
        VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
      `).run(
        caseId,
        newMediatorId,
        today(),
        user.id,
        currentAssignment.id,
        `Reassigned from ${currentAssignment.mediator_name}: ${reason}`
      );

      const newAssignmentId = Number(inserted.lastInsertRowid);

      /*
       * Case status is intentionally unchanged - reassignment
       * swaps who is handling the case at its current stage; it
       * is not a stage transition. No task is touched either:
       * whichever FIRST_MEDIATION/SESSION_RECORD/OUTCOME_FORM
       * task is already pending remains exactly as it was.
       */
      addDocket(
        caseId,
        `Mediator reassigned from ${currentAssignment.mediator_name} to ${newMediator.name}. Reason: ${reason}`,
        user.id
      );

      return {
        caseId,
        oldAssignmentId: currentAssignment.id,
        oldMediatorId: currentAssignment.mediator_id,
        oldMediatorName: currentAssignment.mediator_name,
        newAssignmentId,
        newMediatorId,
        newMediatorName: newMediator.name,
        statusCode: caseData.status_code,
      };
    })();

    return Response.json({
      success: true,
      message: `Mediator reassigned from ${result.oldMediatorName} to ${result.newMediatorName}.`,
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediator reassignment error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to reassign mediator.",
      },
      { status: 400 }
    );
  }
}
