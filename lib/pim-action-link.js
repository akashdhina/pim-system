const TERMINAL_STATUSES = new Set([
  "CLOSED_SETTLED",
  "CLOSED_FAILED",
  "CLOSED_NON_STARTER",
  "WITHDRAWN",
]);

function normalizeTaskCode(code) {
  return String(code || "").trim().toUpperCase();
}

function getTaskAction(task) {
  const code = normalizeTaskCode(
    task?.task_type_code || task?.taskTypeCode
  );
  const caseId = task?.case_id || task?.caseId;
  const sessionId =
    task?.session_id || task?.sessionId || null;

  switch (code) {
    case "SCRUTINY":
      return {
        label: "Complete Scrutiny",
        href: caseId ? `/pim/scrutiny/${caseId}` : null,
        missingPage: false,
      };
    case "FORM2":
    case "FORM_2":
      return {
        label: "Prepare Form-2",
        href: caseId ? `/pim/form2/${caseId}` : null,
        missingPage: false,
      };
    case "NOTICE_RETURNED":
      return {
        label: "Record Service",
        href: caseId ? `/pim/service/${caseId}` : null,
        missingPage: false,
      };
    case "ADDRESS_CORRECTION":
      return {
        label: "Resolve Address Correction",
        href: caseId ? `/pim/address-correction/${caseId}` : null,
        missingPage: false,
      };
    case "FINAL_NOTICE_FOLLOWUP":
      return {
        label: "Prepare Final Notice",
        href: caseId ? `/pim/form2/${caseId}` : null,
        missingPage: false,
      };
    case "OP_CONSENT_FEE":
      return {
        label: "Record Consent",
        href: caseId ? `/pim/response/${caseId}` : null,
        missingPage: false,
      };
    case "OP_APPEARANCE_FOLLOWUP":
      return {
        label: "Record OP Appearance (Alternate Date)",
        href: caseId ? `/pim/response/${caseId}` : null,
        missingPage: false,
      };
    case "MEDIATOR_ASSIGNMENT":
      return {
        label: "Assign Mediator",
        href: caseId ? `/pim/mediator/${caseId}` : null,
        missingPage: false,
      };
    case "FIRST_MEDIATION":
      return {
        label: "Fix First Mediation",
        href: caseId ? `/pim/mediation/${caseId}` : null,
        missingPage: false,
      };
    case "SESSION_RECORD":
      return {
        label: "Record Sitting",
        href: sessionId
          ? `/pim/mediation/session/${sessionId}`
          : null,
        missingPage: !sessionId,
      };
    case "OUTCOME_FORM":
      return {
        label: "Record Outcome",
        href: caseId ? `/pim/outcome/${caseId}` : null,
        missingPage: false,
      };
    case "NONSTARTER_FORM3":
      return {
        label: "Complete Form-3",
        href: caseId ? `/pim/nonstarter/form3/${caseId}` : null,
        missingPage: !caseId,
      };
    case "NONSTARTER_AUTHORITY":
      return {
        label: "Authority Decision",
        href: caseId ? `/pim/nonstarter/authority/${caseId}` : null,
        missingPage: !caseId,
      };
    default:
      return {
        label: "View Case",
        href: caseId ? `/pim/case/${caseId}` : null,
        missingPage: false,
      };
  }
}

function getCaseAction(caseRow) {
  if (
    !caseRow ||
    TERMINAL_STATUSES.has(
      String(caseRow.status_code || "")
    )
  ) {
    return {
      label: "No further workflow action",
      href: caseRow?.id
        ? `/pim/case/${caseRow.id}`
        : null,
      missingPage: false,
      terminal: true,
    };
  }

  if (caseRow.pending_task_id) {
    return getTaskAction({
      case_id: caseRow.id,
      task_type_code: caseRow.pending_task_type_code,
      session_id: caseRow.pending_session_id,
    });
  }

  const caseId = caseRow.id;
  const statusCode = String(
    caseRow.status_code || ""
  ).toUpperCase();

  switch (statusCode) {
    case "SCRUTINY_PENDING":
    case "DEFECT_PENDING":
      return {
        label: "Complete Scrutiny",
        href: caseId ? `/pim/scrutiny/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "SECRETARY_APPROVAL_PENDING":
      // Legacy status - no case reaches this through the live workflow any
      // more (Batch 5H-b replaced it with PIM_NUMBER_PENDING below), but a
      // legacy-imported case could still carry it historically.
      return {
        label: "Approve Registration",
        href: caseId ? `/pim/approval/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "PIM_NUMBER_PENDING":
      return {
        label: "Assign PIM Number",
        href: caseId ? `/pim/pim-number/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "REGISTERED":
    case "FORM2_PENDING":
    case "FORM2_ISSUED":
      return {
        label: "Prepare Form-2",
        href: caseId ? `/pim/form2/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "SERVICE_PENDING":
    case "FINAL_NOTICE_ISSUED":
      return {
        label: "Record Service",
        href: caseId ? `/pim/service/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "NOTICE_RETURNED":
      /*
       * Batch 5J: a case now genuinely rests here only when a Final
       * Notice was returned (the pre-existing SQLite behavior silently
       * left the case at SERVICE_PENDING instead - this fallback branch
       * was unreachable before, since current_status_id never actually
       * became NOTICE_RETURNED). The real next action is recording the
       * non-starter outcome, not another service POST (which would now
       * correctly reject - the case is no longer at SERVICE_PENDING).
       * In practice the pending NONSTARTER_FORM3 task this status
       * always comes with is resolved above via pending_task_id before
       * this switch is ever reached; this is the defensive fallback
       * for the rare case where that task is somehow missing.
       */
      return {
        label: "Record Non-Starter",
        href: caseId ? `/pim/nonstarter/form3/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "ADDRESS_CORRECTION_PENDING":
      return {
        label: "Resolve Address Correction",
        href: caseId ? `/pim/address-correction/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "FINAL_NOTICE_PENDING":
      return {
        label: "Prepare Final Notice",
        href: caseId ? `/pim/form2/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "OP_APPEARANCE_PENDING":
    case "OP_APPEARED":
    case "OP_CONSENT_PENDING":
    case "OP_CONSENTED":
    case "OP_REFUSED":
      return {
        label: "Record OP Response",
        href: caseId ? `/pim/response/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "FEE_PENDING":
      return {
        label: "Record Fee",
        href: caseId ? `/pim/fee/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "MEDIATOR_ASSIGNMENT_PENDING":
      return {
        label: "Assign Mediator",
        href: caseId ? `/pim/mediator/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "MEDIATOR_ASSIGNED":
    case "MEDIATION_PENDING":
      return {
        label: "Fix First Mediation",
        href: caseId ? `/pim/mediation/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "MEDIATION_ONGOING":
      return {
        label: "Open Mediation",
        href: caseId ? `/pim/mediation/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "OUTCOME_FORM_PENDING":
      return {
        label: "Record Outcome",
        href: caseId ? `/pim/outcome/${caseId}` : null,
        missingPage: false,
        terminal: false,
      };
    case "AUTHORITY_DECISION_PENDING":
      return {
        label: "Authority Decision",
        href: caseId ? `/pim/nonstarter/authority/${caseId}` : null,
        missingPage: !caseId,
        terminal: false,
      };
    default:
      break;
  }

  return {
    label: "View Case",
    href: caseRow.id ? `/pim/case/${caseRow.id}` : null,
    missingPage: false,
    terminal: false,
  };
}

module.exports = {
  TERMINAL_STATUSES,
  getCaseAction,
  getTaskAction,
  normalizeTaskCode,
};
