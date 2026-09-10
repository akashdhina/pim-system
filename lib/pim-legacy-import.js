/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("./db");
const { officeDate, officeTime } = require("./pim-time");
const { generatePimNumber } = require("./pim-approval");

const TERMINAL_STATUS_BY_OUTCOME = {
  SETTLED: "CLOSED_SETTLED",
  FAILED: "CLOSED_FAILED",
  WITHDRAWN: "WITHDRAWN",
  NON_STARTER: "CLOSED_NON_STARTER",
};

const STAGE_MAPPINGS = [
  {
    code: "RECEIVED",
    label: "Application received",
    currentStatus: "RECEIVED",
    pendingTask: "SCRUTINY",
    requiredDates: ["receivedDate", "applicationDate"],
  },
  {
    code: "SCRUTINY_PENDING",
    label: "Scrutiny pending",
    currentStatus: "SCRUTINY_PENDING",
    pendingTask: "SCRUTINY",
    requiredDates: ["receivedDate", "applicationDate"],
  },
  {
    code: "SECRETARY_APPROVAL_PENDING",
    label: "Secretary approval pending",
    currentStatus: "SECRETARY_APPROVAL_PENDING",
    pendingTask: null,
    requiredDates: ["receivedDate", "applicationDate", "scrutinyDate"],
  },
  {
    code: "FORM2_PENDING",
    label: "Form-2 pending",
    currentStatus: "FORM2_PENDING",
    pendingTask: "FORM2",
    requiredDates: ["receivedDate", "applicationDate", "scrutinyDate", "registrationDate"],
  },
  {
    code: "SERVICE_PENDING",
    label: "Service pending",
    currentStatus: "SERVICE_PENDING",
    pendingTask: null,
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form2Date",
      "appearanceDate",
    ],
  },
  {
    code: "FEE_PENDING",
    label: "Mediation fee pending",
    currentStatus: "FEE_PENDING",
    pendingTask: null,
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form2Date",
      "responseDate",
    ],
  },
  {
    code: "MEDIATOR_ASSIGNMENT_PENDING",
    label: "Mediator assignment pending",
    currentStatus: "MEDIATOR_ASSIGNMENT_PENDING",
    pendingTask: "MEDIATOR_ASSIGNMENT",
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form2Date",
      "responseDate",
    ],
  },
  {
    code: "MEDIATOR_ASSIGNED",
    label: "Mediator assigned",
    currentStatus: "MEDIATOR_ASSIGNED",
    pendingTask: "FIRST_MEDIATION",
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form2Date",
      "responseDate",
      "assignmentDate",
    ],
    requiresMediator: true,
  },
  {
    code: "MEDIATION_PENDING",
    label: "First mediation pending",
    currentStatus: "MEDIATION_PENDING",
    pendingTask: "SESSION_RECORD",
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form2Date",
      "responseDate",
      "assignmentDate",
      "firstMediationDate",
    ],
    requiresMediator: true,
  },
  {
    code: "MEDIATION_ONGOING",
    label: "Mediation ongoing",
    currentStatus: "MEDIATION_ONGOING",
    pendingTask: "SESSION_RECORD",
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form2Date",
      "responseDate",
      "assignmentDate",
      "firstMediationDate",
      "lastSessionDate",
      "nextMediationDate",
    ],
    requiresMediator: true,
  },
  {
    code: "OUTCOME_FORM_PENDING",
    label: "Outcome form pending",
    currentStatus: "OUTCOME_FORM_PENDING",
    pendingTask: "OUTCOME_FORM",
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form2Date",
      "responseDate",
      "assignmentDate",
      "firstMediationDate",
      "lastSessionDate",
    ],
    requiresMediator: true,
  },
  {
    code: "AUTHORITY_DECISION_PENDING",
    label: "Non-starter authority pending",
    currentStatus: "AUTHORITY_DECISION_PENDING",
    pendingTask: "NONSTARTER_AUTHORITY",
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form3Date",
    ],
    outcomeType: "NON_STARTER",
  },
  {
    code: "CLOSED_SETTLED",
    label: "Closed settled",
    currentStatus: "CLOSED_SETTLED",
    pendingTask: null,
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form2Date",
      "responseDate",
      "assignmentDate",
      "firstMediationDate",
      "lastSessionDate",
      "outcomeDate",
    ],
    requiresMediator: true,
    outcomeType: "SETTLED",
  },
  {
    code: "CLOSED_FAILED",
    label: "Closed failed",
    currentStatus: "CLOSED_FAILED",
    pendingTask: null,
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form2Date",
      "responseDate",
      "assignmentDate",
      "firstMediationDate",
      "lastSessionDate",
      "outcomeDate",
    ],
    requiresMediator: true,
    outcomeType: "FAILED",
  },
  {
    code: "WITHDRAWN",
    label: "Withdrawn",
    currentStatus: "WITHDRAWN",
    pendingTask: null,
    requiredDates: ["receivedDate", "applicationDate", "outcomeDate"],
    outcomeType: "WITHDRAWN",
  },
  {
    code: "CLOSED_NON_STARTER",
    label: "Closed non-starter",
    currentStatus: "CLOSED_NON_STARTER",
    pendingTask: null,
    requiredDates: [
      "receivedDate",
      "applicationDate",
      "scrutinyDate",
      "registrationDate",
      "form3Date",
      "outcomeDate",
    ],
    outcomeType: "NON_STARTER",
  },
];

const STAGE_MAP = new Map(STAGE_MAPPINGS.map((stage) => [stage.code, stage]));
const DATE_ORDER = [
  "applicationDate",
  "receivedDate",
  "scrutinyDate",
  "registrationDate",
  "form2Date",
  "appearanceDate",
  "responseDate",
  "assignmentDate",
  "firstMediationDate",
  "lastSessionDate",
  "nextMediationDate",
  "form3Date",
  "outcomeDate",
];

function today() {
  return officeDate();
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function getStatusId(code) {
  const row = db.prepare("SELECT id FROM status_master WHERE code = ?").get(code);
  if (!row) throw new Error(`Status not found: ${code}`);
  return row.id;
}

function getEventId(code) {
  const row = db.prepare("SELECT id FROM event_types WHERE code = ?").get(code);
  if (!row) throw new Error(`Event not found: ${code}`);
  return row.id;
}

function getTaskType(code) {
  return db
    .prepare("SELECT id, code, default_priority FROM task_types WHERE code = ? AND active = 1")
    .get(code);
}

function addStatus(caseId, fromCode, toCode, reason, userId) {
  db.prepare(`
    INSERT INTO pim_status_history
      (case_id, from_status_id, to_status_id, reason, changed_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    caseId,
    fromCode ? getStatusId(fromCode) : null,
    getStatusId(toCode),
    reason,
    userId || null
  );
}

function addDocket(caseId, date, eventCode, text, action, nextDate, userId) {
  db.prepare(`
    INSERT INTO pim_docket
      (case_id, docket_date, event_type_id, entry_text, action_required, next_date, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(caseId, date, getEventId(eventCode), text, action || null, nextDate || null, userId || null);
}

function addAudit(caseId, newValue, userId) {
  db.prepare(`
    INSERT INTO audit_log
      (table_name, record_id, action, old_value, new_value, changed_by, reason)
    VALUES ('pim_cases', ?, 'LEGACY_IMPORT', NULL, ?, ?, ?)
  `).run(
    caseId,
    JSON.stringify(newValue),
    userId || null,
    "Legacy case imported; workflow was reconstructed from the physical file."
  );
}

function addTask(caseId, code, description, createdDate, dueDate, status, userId, completedDate = null) {
  const taskType = getTaskType(code);
  if (!taskType && code !== "FORM2") {
    throw new Error(`Active task type not found: ${code}`);
  }

  const result = db.prepare(`
    INSERT INTO pim_tasks
      (
        case_id, task_type_id, task_type_code, description, created_date, due_date,
        priority, status, completed_date, completed_time, completed_by, auto_generated, remarks
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    caseId,
    taskType ? taskType.id : null,
    taskType ? taskType.code : code,
    description,
    createdDate,
    dueDate || createdDate,
    taskType ? taskType.default_priority || "NORMAL" : "NORMAL",
    status,
    completedDate,
    completedDate ? officeTime() : null,
    completedDate ? userId || null : null,
    status === "COMPLETED"
      ? "Reconstructed from physical file during legacy import."
      : "Current pending task created by legacy import."
  );

  const taskId = Number(result.lastInsertRowid);
  if (status === "COMPLETED") {
    db.prepare(`
      INSERT INTO pim_task_history
        (task_id, old_status, new_status, changed_by, remarks)
      VALUES (?, 'PENDING', 'COMPLETED', ?, ?)
    `).run(taskId, userId || null, "Completed workflow task reconstructed from the physical file.");
  }
  return taskId;
}

function addParty(caseId, role, party, index) {
  const name = clean(party?.name);
  if (!name) throw new Error(`${role} ${index + 1}: party name is required.`);

  const partyRow = db.prepare(`
    INSERT INTO pim_parties (name, entity_type, contact_phone, email)
    VALUES (?, ?, ?, ?)
  `).run(name, clean(party.entityType) || "INDIVIDUAL", clean(party.phone), clean(party.email));

  const partyId = Number(partyRow.lastInsertRowid);
  db.prepare(`
    INSERT INTO pim_case_parties
      (case_id, party_id, role, sequence_no, is_primary, active_from, remarks)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(caseId, partyId, role, index + 1, index === 0 ? 1 : 0, party.activeFrom || null, "Legacy import");

  if (clean(party.addressLine1)) {
    db.prepare(`
      INSERT INTO pim_addresses
        (party_id, address_type, address_line1, address_line2, village_town, district, state, pincode, source)
      VALUES (?, 'POSTAL', ?, ?, ?, ?, ?, ?, 'LEGACY_PHYSICAL_FILE')
    `).run(
      partyId,
      clean(party.addressLine1),
      clean(party.addressLine2),
      clean(party.villageTown),
      clean(party.district),
      clean(party.state),
      clean(party.pincode)
    );
  }

  return partyId;
}

function validateChronology(data, stage) {
  const required = new Set(stage.requiredDates);
  const supplied = DATE_ORDER
    .map((key) => [key, clean(data[key])])
    .filter(([, value]) => value);

  for (const key of required) {
    if (!clean(data[key])) throw new Error(`${key} is required for ${stage.label}.`);
  }

  for (const [key, value] of supplied) {
    if (!isIsoDate(value)) throw new Error(`${key} must be in YYYY-MM-DD format.`);
    if (value > today()) throw new Error(`${key} cannot be in the future.`);
  }

  let previous = null;
  let previousKey = null;
  for (const [key, value] of supplied) {
    if (previous && value < previous) {
      throw new Error(`${key} cannot be earlier than ${previousKey}.`);
    }
    previous = value;
    previousKey = key;
  }
}

function validateLegacyImport(data) {
  if (!data || typeof data !== "object") throw new Error("Legacy import data is required.");
  const stage = STAGE_MAP.get(String(data.stageCode || "").toUpperCase());
  if (!stage) throw new Error("Current physical-file stage is required.");

  if (!clean(data.receivedNumber) && !clean(data.pimNumber)) {
    throw new Error("Received number or PIM number is required to prevent duplicate import.");
  }

  if (!Array.isArray(data.applicants) || data.applicants.length === 0) {
    throw new Error("At least one applicant is required.");
  }
  if (!Array.isArray(data.oppositeParties) || data.oppositeParties.length === 0) {
    throw new Error("At least one opposite party is required.");
  }

  validateChronology(data, stage);

  if (stage.requiresMediator) {
    const mediatorId = Number(data.mediatorId);
    if (!Number.isInteger(mediatorId) || mediatorId <= 0) {
      throw new Error("Mediator is required for this legacy stage.");
    }
  }

  if (
  stage.outcomeType === "SETTLED" &&
  !clean(data.settlementTerms)
) {
  throw new Error(
    "Settlement terms are required for settled legacy imports."
  );
}

if (
  ["FAILED", "WITHDRAWN"].includes(stage.outcomeType) &&
  !clean(data.outcomeReason)
) {
  throw new Error(
    "Outcome reason is required for this legacy stage."
  );
}

if (stage.outcomeType === "NON_STARTER") {
  if (!Number(data.nonstarterReasonId)) {
    throw new Error("Select a non-starter reason.");
  }
}

return stage;
}

function preventDuplicate(data) {
  const pimNumber = clean(data.pimNumber);
  const receivedNumber = clean(data.receivedNumber);
  const duplicate = db.prepare(`
    SELECT id, pim_number, received_number
    FROM pim_cases
    WHERE (? IS NOT NULL AND pim_number = ?)
       OR (? IS NOT NULL AND received_number = ?)
    LIMIT 1
  `).get(pimNumber, pimNumber, receivedNumber, receivedNumber);

  if (duplicate) {
    throw new Error(
      `Duplicate import blocked. Matching case ID ${duplicate.id} already exists.`
    );
  }
}

function buildPreviewWarnings(data, stage) {
  const warnings = [];

  const allNames = [
    ...data.applicants.map((party) => clean(party?.name)?.toUpperCase()),
    ...data.oppositeParties.map((party) => clean(party?.name)?.toUpperCase()),
  ].filter(Boolean);
  const duplicateNames = allNames.filter(
    (name, index) => allNames.indexOf(name) !== index
  );
  if (duplicateNames.length) {
    warnings.push(
      `Duplicate party name in this submission: ${[...new Set(duplicateNames)].join(", ")}. Confirm these are not meant to be the same party entered twice.`
    );
  }

  if (
    stage.outcomeType &&
    !clean(data.formNo) &&
    stage.outcomeType !== "WITHDRAWN"
  ) {
    warnings.push(
      `No form number was supplied for this ${stage.outcomeType} outcome. If the physical file shows a Form ${
        { NON_STARTER: "III", SETTLED: "IV", FAILED: "V" }[stage.outcomeType] || ""
      } was issued but it has not been digitized, record that as a deliberate archival task rather than leaving it unrecorded.`
    );
  }

  if (stage.requiresMediator) {
    const mediator = db.prepare(`SELECT name, active, panel_valid_until FROM mediators WHERE id = ?`).get(Number(data.mediatorId));
    if (mediator && mediator.active !== 1) {
      warnings.push(`Selected mediator "${mediator.name}" is marked inactive.`);
    }
    if (mediator?.panel_valid_until && clean(data.assignmentDate) > mediator.panel_valid_until) {
      warnings.push(`Selected mediator's panel validity (${mediator.panel_valid_until}) is earlier than the assignment date.`);
    }
  }

  if (stage.currentStatus.startsWith("CLOSED") || stage.currentStatus === "WITHDRAWN") {
    if (!data.outcomeDate && stage.code !== "AUTHORITY_DECISION_PENDING") {
      warnings.push("This stage is terminal but no outcome date was supplied.");
    }
  }

  return warnings;
}

function previewLegacyImport(data, userId = null) {
  const stage = validateLegacyImport(data);
  preventDuplicate(data);

  const pimNumber =
    clean(data.pimNumber) ||
    (stage.requiredDates.includes("registrationDate") ? generatePimNumber() : null);

  const mediator = stage.requiresMediator
    ? db.prepare(`SELECT id, name, enrollment_no FROM mediators WHERE id = ?`).get(Number(data.mediatorId))
    : null;

  const nonstarterReason =
    stage.outcomeType === "NON_STARTER"
      ? db.prepare(`SELECT id, name, rule_reference FROM nonstarter_reasons WHERE id = ?`).get(Number(data.nonstarterReasonId))
      : null;

  return {
    preview: true,
    pimNumber,
    receivedNumber: clean(data.receivedNumber),
    stage: stage.code,
    stageLabel: stage.label,
    currentStatus: stage.currentStatus,
    pendingTask: stage.pendingTask,
    claimAmount: data.claimAmount ? Number(data.claimAmount) : null,
    applicants: data.applicants.map((party) => clean(party?.name)),
    oppositeParties: data.oppositeParties.map((party) => clean(party?.name)),
    dates: Object.fromEntries(
      DATE_ORDER.map((key) => [key, clean(data[key])]).filter(([, value]) => value)
    ),
    mediator: mediator ? { id: mediator.id, name: mediator.name, enrollmentNo: mediator.enrollment_no } : null,
    outcomeType: stage.outcomeType || null,
    nonstarterReason: nonstarterReason
      ? { id: nonstarterReason.id, name: nonstarterReason.name, ruleReference: nonstarterReason.rule_reference }
      : null,
    settlementTerms: clean(data.settlementTerms),
    formNo: clean(data.formNo),
    warnings: buildPreviewWarnings(data, stage),
    preparedBy: userId,
  };
}

function addBaseline(caseId, data, userId) {
  addStatus(caseId, null, "RECEIVED", "Legacy physical file shows application received.", userId);
  addDocket(
    caseId,
    data.receivedDate,
    "APPLICATION_RECEIVED",
    "Legacy application received as per physical file.",
    "Scrutiny",
    null,
    userId
  );
}

function addScrutiny(caseId, data, userId) {
  if (!data.scrutinyDate) return;
  addTask(
    caseId,
    "SCRUTINY",
    "Scrutiny of received PIM application.",
    data.receivedDate,
    data.scrutinyDate,
    "COMPLETED",
    userId,
    data.scrutinyDate
  );
  db.prepare(`
    INSERT INTO pim_scrutiny
      (
        case_id, application_fee_received, dd_number, dd_date, dd_bank, dd_amount,
        dd_payee_correct, dd_valid, opposite_party_address_available,
        commercial_dispute_checked, territorial_jurisdiction_checked,
        supporting_documents_checked, scrutiny_result, defect_details,
        rectification_date, scrutinised_by, scrutinised_at
      )
    VALUES (?, 1, ?, ?, ?, ?, 1, 1, 1, 1, 1, 1, 'COMPLETE', NULL, NULL, ?, CURRENT_TIMESTAMP)
  `).run(
    caseId,
    clean(data.applicationFeeDdNumber),
    clean(data.applicationFeeDdDate),
    clean(data.applicationFeeBank),
    data.applicationFeeAmount ? Number(data.applicationFeeAmount) : null,
    userId || null
  );
  addStatus(caseId, "RECEIVED", "SECRETARY_APPROVAL_PENDING", "Legacy scrutiny completed; file put up for Secretary approval.", userId);
  addDocket(caseId, data.scrutinyDate, "SCRUTINY_COMPLETED", "Scrutiny completed as per physical file.", "Secretary approval", null, userId);
}

function addRegistration(caseId, data, userId) {
  if (!data.registrationDate) return;
  addStatus(caseId, "SECRETARY_APPROVAL_PENDING", "REGISTERED", "Legacy file shows Secretary approval and registration.", userId);
  addDocket(caseId, data.registrationDate, "SECRETARY_APPROVAL", "Secretary approval reconstructed from physical file.", null, null, userId);
  addDocket(caseId, data.registrationDate, "PIM_REGISTERED", `PIM registered as ${clean(data.pimNumber)}.`, "Form-2", null, userId);
  addStatus(caseId, "REGISTERED", "FORM2_PENDING", "PIM registered; Form-2 preparation pending.", userId);
}

function addForm2(caseId, data, oppositePartyId, userId) {
  if (!data.form2Date) return null;
  addTask(caseId, "FORM2", "Prepare Form-2 after PIM registration.", data.registrationDate, data.form2Date, "COMPLETED", userId, data.form2Date);

  const notice = db.prepare(`
    INSERT INTO pim_notices
      (
        case_id, notice_type, form_no, notice_date, appearance_date, appearance_time,
        recipient_party_id, prepared_by, dispatch_date, status, remarks
      )
    VALUES (?, 'FORM_2_INITIAL', 'FORM-2', ?, ?, ?, ?, ?, ?, 'DISPATCHED', ?)
  `).run(
    caseId,
    data.form2Date,
    data.appearanceDate || null,
    clean(data.appearanceTime),
    oppositePartyId,
    userId || null,
    data.form2Date,
    "Reconstructed from physical file during legacy import."
  );

  const noticeId = Number(notice.lastInsertRowid);
  db.prepare(`
    INSERT INTO pim_service_attempts
      (notice_id, dispatch_mode, dispatch_date, tracking_no, tracking_status, remarks)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    noticeId,
    clean(data.dispatchMode) || "REGISTERED_POST",
    data.form2Date,
    clean(data.trackingNo),
    "DISPATCHED",
    "Legacy service attempt reconstructed from physical file."
  );

  addDocket(caseId, data.form2Date, "FORM2_DISPATCHED", "Form-2 issued/dispatch recorded from physical file.", "Service", data.appearanceDate || null, userId);
  addStatus(caseId, "FORM2_PENDING", "SERVICE_PENDING", "Form-2 issued; service / appearance pending.", userId);
  return noticeId;
}

function addResponseAndFee(caseId, data, oppositePartyId, userId) {
  if (!data.responseDate) return;
  db.prepare(`
    INSERT INTO pim_responses
      (
        case_id, party_id, response_date, appearance_mode, response_type,
        time_requested_until, consent, mediation_fee_requested, remarks, entered_by
      )
    VALUES (?, ?, ?, ?, 'APPEARED', NULL, 1, 1, ?, ?)
  `).run(
    caseId,
    oppositePartyId,
    data.responseDate,
    clean(data.appearanceMode) || "IN_PERSON",
    "Legacy file records OP appearance and consent.",
    userId || null
  );

  db.prepare(`
    INSERT INTO pim_fees
      (case_id, party_id, fee_type, amount_due, amount_received, received_date, status, remarks)
    VALUES (?, ?, 'MEDIATION_FEE', NULL, 0, NULL, 'PENDING', ?)
  `).run(caseId, oppositePartyId, "Mediation fee pending after legacy OP consent.");

  addDocket(caseId, data.responseDate, "OP_CONSENT", "Opposite party appearance and consent reconstructed from physical file.", "Mediation fee", null, userId);
  addStatus(caseId, "SERVICE_PENDING", "FEE_PENDING", "OP consent recorded; mediation fee pending.", userId);
}

function addMediatorAssignment(caseId, data, userId) {
  if (!data.assignmentDate) return null;
  const mediatorId = Number(data.mediatorId);
  const mediator = db.prepare("SELECT * FROM mediators WHERE id = ?").get(mediatorId);
  if (!mediator) throw new Error("Selected mediator was not found.");

  addTask(caseId, "MEDIATOR_ASSIGNMENT", "Assign mediator.", data.responseDate || data.registrationDate, data.assignmentDate, "COMPLETED", userId, data.assignmentDate);
  const assignment = db.prepare(`
    INSERT INTO pim_mediator_assignments
      (
        case_id, mediator_id, assignment_date, assignment_order_no, first_mediation_date,
        appointed_by, rotation_suggestion_no, deviation_from_rotation, deviation_reason, status, remarks
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 'ACTIVE', ?)
  `).run(
    caseId,
    mediatorId,
    data.assignmentDate,
    clean(data.assignmentOrderNo),
    data.firstMediationDate || null,
    userId || null,
    mediator.rotation_order || null,
    "Reconstructed from physical file during legacy import."
  );
  addDocket(caseId, data.assignmentDate, "MEDIATOR_ASSIGNED", `Mediator ${mediator.name} assigned as per physical file.`, "First mediation", data.firstMediationDate || null, userId);
  addStatus(caseId, "MEDIATOR_ASSIGNMENT_PENDING", "MEDIATOR_ASSIGNED", `Mediator ${mediator.name} assigned.`, userId);
  return Number(assignment.lastInsertRowid);
}

function addFirstMediation(caseId, data, assignmentId, userId) {
  if (!data.firstMediationDate) return null;
  addTask(caseId, "FIRST_MEDIATION", "Fix and conduct the first mediation session.", data.assignmentDate, data.firstMediationDate, "COMPLETED", userId, data.firstMediationDate);
  const session = db.prepare(`
    INSERT INTO mediation_sessions
      (
        case_id, assignment_id, sitting_number, scheduled_date, actual_date,
        applicant_present, opposite_party_present, effective_session, actual_start_time,
        actual_end_time, duration_minutes, next_date, session_status, administrative_remarks,
        report_received, report_date, recorded_by
      )
    VALUES (?, ?, 1, ?, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, 'SCHEDULED', ?, 0, NULL, ?)
  `).run(caseId, assignmentId, data.firstMediationDate, "Reconstructed from physical file.", userId || null);
  addDocket(caseId, data.firstMediationDate, "MEDIATION_DATE_FIXED", "First mediation date fixed as per physical file.", "Record sitting", data.firstMediationDate, userId);
  addStatus(caseId, "MEDIATOR_ASSIGNED", "MEDIATION_PENDING", "First mediation fixed.", userId);
  return Number(session.lastInsertRowid);
}

function addOngoingSession(caseId, data, assignmentId, userId) {
  if (!data.lastSessionDate) return null;
  db.prepare(`
    UPDATE mediation_sessions
    SET actual_date = ?, applicant_present = 1, opposite_party_present = 1,
        effective_session = 1, session_status = 'COMPLETED', recorded_by = ?
    WHERE case_id = ? AND sitting_number = 1
  `).run(data.lastSessionDate, userId || null, caseId);
  addDocket(caseId, data.lastSessionDate, "MEDIATION_SESSION", "Mediation sitting completed as per physical file.", data.nextMediationDate ? "Next mediation sitting" : "Outcome", data.nextMediationDate || null, userId);
  addStatus(caseId, "MEDIATION_PENDING", "MEDIATION_ONGOING", "Mediation sitting recorded from physical file.", userId);

  if (data.nextMediationDate) {
    const session = db.prepare(`
      INSERT INTO mediation_sessions
        (
          case_id, assignment_id, sitting_number, scheduled_date, actual_date,
          applicant_present, opposite_party_present, effective_session, actual_start_time,
          actual_end_time, duration_minutes, next_date, session_status, administrative_remarks,
          report_received, report_date, recorded_by
        )
      VALUES (?, ?, 2, ?, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, 'SCHEDULED', ?, 0, NULL, ?)
    `).run(caseId, assignmentId, data.nextMediationDate, "Pending sitting from legacy import.", userId || null);
    return Number(session.lastInsertRowid);
  }
  return null;
}

const DEFAULT_FORM_NO_BY_OUTCOME = {
  NON_STARTER: "FORM-3",
  SETTLED: "FORM-4",
  FAILED: "FORM-5",
};

function addOutcome(caseId, data, outcomeType, userId) {
  if (!outcomeType || !data.outcomeDate) return;

  let nonstarterReasonId = null;
  let reasonText = clean(data.outcomeReason);
  let formNo = clean(data.formNo) || DEFAULT_FORM_NO_BY_OUTCOME[outcomeType] || null;

  if (outcomeType === "NON_STARTER") {
    const reason = db.prepare(`
      SELECT
        id,
        name,
        rule_reference,
        requires_authority_decision
      FROM nonstarter_reasons
      WHERE id = ?
        AND active = 1
    `).get(Number(data.nonstarterReasonId));

    if (!reason) {
      throw new Error("Invalid non-starter reason.");
    }

    nonstarterReasonId = reason.id;

    if (!reasonText) {
      reasonText = reason.name;
    }
  }

  /*
   * case_id is UNIQUE on pim_outcomes - guard against a double
   * insert for stages (e.g. AUTHORITY_DECISION_PENDING) that
   * already recorded their own interim outcome row elsewhere in
   * this import.
   */
  const existing = db.prepare(`SELECT id FROM pim_outcomes WHERE case_id = ?`).get(caseId);
  if (!existing) {
    db.prepare(`
      INSERT INTO pim_outcomes
        (
          case_id, outcome_type, form_no, outcome_date, nonstarter_reason_id,
          reason_text, settlement_terms, prepared_by, sent_to_applicant, sent_to_opposite_party, remarks
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(
      caseId,
      outcomeType,
      formNo,
      data.outcomeDate,
      nonstarterReasonId,
      reasonText,
      outcomeType === "SETTLED" ? clean(data.settlementTerms) : null,
      userId || null,
      "Outcome reconstructed from physical file during legacy import."
    );
  }

  addDocket(
    caseId,
    data.outcomeDate,
    "CLOSURE",
    `Legacy outcome recorded: ${outcomeType}.`,
    null,
    null,
    userId
  );
}
function createPendingForStage(caseId, stage, data, userId) {
  if (!stage.pendingTask) return null;
  const dueDate =
    data.nextMediationDate ||
    data.firstMediationDate ||
    data.assignmentDate ||
    data.registrationDate ||
    data.receivedDate;
  const descriptions = {
    SCRUTINY: "Scrutiny of legacy received PIM application.",
    FORM2: "Prepare Form-2 after legacy PIM registration.",
    MEDIATOR_ASSIGNMENT: "Assign mediator for legacy case.",
    FIRST_MEDIATION: "Fix and conduct the first mediation session.",
    SESSION_RECORD: "Record pending mediation sitting.",
    OUTCOME_FORM: "Record mediation outcome and complete the PIM outcome form.",
    NONSTARTER_AUTHORITY: "Authority decision on non-starter.",
  };
  return addTask(
    caseId,
    stage.pendingTask,
    descriptions[stage.pendingTask] || "Legacy case workflow task.",
    today(),
    dueDate,
    "PENDING",
    userId
  );
}

function importLegacyCase(data, userId = null) {
  const stage = validateLegacyImport(data);

  return db.transaction(() => {
    preventDuplicate(data);

    const pimNumber =
      clean(data.pimNumber) ||
      (stage.requiredDates.includes("registrationDate") ? generatePimNumber() : null);
    const statusId = getStatusId(stage.currentStatus);

    const caseRow = db.prepare(`
      INSERT INTO pim_cases
        (
          entry_type, pim_number, received_number, received_date, application_date,
          registration_date, claim_amount, dispute_description, secretary_decision,
          secretary_decision_date, current_status_id, outcome_type, outcome_date,
          statutory_due_date, internal_60_day_date, priority, remarks, closed_at
        )
      VALUES
        ('LEGACY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pimNumber,
      clean(data.receivedNumber),
      data.receivedDate,
      data.applicationDate,
      data.registrationDate || null,
      data.claimAmount ? Number(data.claimAmount) : null,
      clean(data.disputeDescription),
      data.registrationDate ? "APPROVED" : null,
      data.registrationDate || null,
      statusId,
      stage.outcomeType || null,
      data.outcomeDate || null,
      data.statutoryDueDate || null,
      data.internal60DayDate || null,
      clean(data.priority) || "NORMAL",
      clean(data.remarks),
      stage.currentStatus.startsWith("CLOSED") || stage.currentStatus === "WITHDRAWN"
        ? today()
        : null
    );

    const caseId = Number(caseRow.lastInsertRowid);
    const applicantIds = data.applicants.map((party, index) =>
      addParty(caseId, "APPLICANT", party, index)
    );
    const oppositePartyIds = data.oppositeParties.map((party, index) =>
      addParty(caseId, "OPPOSITE_PARTY", party, index)
    );
    const primaryOppositePartyId = oppositePartyIds[0];

    addBaseline(caseId, data, userId);
    addScrutiny(caseId, data, userId);
    addRegistration(caseId, { ...data, pimNumber }, userId);
    addForm2(caseId, data, primaryOppositePartyId, userId);
    addResponseAndFee(caseId, data, primaryOppositePartyId, userId);

    if (stage.code === "MEDIATOR_ASSIGNMENT_PENDING") {
      addStatus(caseId, "FEE_PENDING", "MEDIATOR_ASSIGNMENT_PENDING", "Mediation fee received; mediator assignment pending.", userId);
      addDocket(caseId, data.responseDate, "MEDIATION_FEE_RECEIVED", "Mediation fee received as per physical file.", "Mediator assignment", null, userId);
    }

    let assignmentId = null;
    if (data.assignmentDate) {
      if (stage.code !== "MEDIATOR_ASSIGNMENT_PENDING") {
        addStatus(caseId, "FEE_PENDING", "MEDIATOR_ASSIGNMENT_PENDING", "Mediation fee received; mediator assignment pending.", userId);
      }
      assignmentId = addMediatorAssignment(caseId, data, userId);
    }

    if (data.firstMediationDate && assignmentId) {
      addFirstMediation(caseId, data, assignmentId, userId);
    }

    if (data.lastSessionDate && assignmentId) {
      addOngoingSession(caseId, data, assignmentId, userId);
    }

    if (stage.code === "OUTCOME_FORM_PENDING") {
      addStatus(caseId, "MEDIATION_ONGOING", "OUTCOME_FORM_PENDING", "Mediation concluded; outcome form pending.", userId);
      addDocket(caseId, data.lastSessionDate, "MEDIATION_SESSION", "Mediation concluded as per physical file.", "Outcome form", null, userId);
    }

    if (["CLOSED_SETTLED", "CLOSED_FAILED"].includes(stage.code)) {
      addStatus(caseId, "MEDIATION_ONGOING", "OUTCOME_FORM_PENDING", "Mediation concluded; outcome form pending.", userId);
      addDocket(caseId, data.lastSessionDate, "MEDIATION_SESSION", "Mediation concluded as per physical file.", "Outcome form", null, userId);
    }

    if (
    stage.currentStatus ===
    "AUTHORITY_DECISION_PENDING"
) {
      const authorityReason = db.prepare(`
        SELECT id, name
        FROM nonstarter_reasons
        WHERE id = ?
          AND active = 1
      `).get(Number(data.nonstarterReasonId));

      if (!authorityReason) {
        throw new Error("Invalid non-starter reason.");
      }

      db.prepare(`
        INSERT INTO pim_outcomes
          (
            case_id, outcome_type, form_no, outcome_date, nonstarter_reason_id, reason_text,
            prepared_by, sent_to_applicant, sent_to_opposite_party, remarks
          )
        VALUES (?, 'NON_STARTER', 'FORM-3', ?, ?, ?, ?, 0, 0, ?)
      `).run(
        caseId,
        data.form3Date,
        authorityReason.id,
        clean(data.outcomeReason) || authorityReason.name,
        userId || null,
        "Non-starter reconstructed from physical file during legacy import."
      );
      addDocket(caseId, data.form3Date, "FORM3", "Form-3 non-starter record reconstructed from physical file.", "Authority decision", null, userId);
      addStatus(caseId, "FORM2_PENDING", "AUTHORITY_DECISION_PENDING", "Non-starter Form-3 completed; authority decision pending.", userId);
    }

    addOutcome(caseId, data, stage.outcomeType, userId);

    if (stage.outcomeType) {

  let fromStatus;

  if (stage.outcomeType === "WITHDRAWN") {

    fromStatus = "RECEIVED";

  } else if (stage.outcomeType === "NON_STARTER") {

    if (stage.code === "AUTHORITY_DECISION_PENDING") {

      fromStatus = "AUTHORITY_DECISION_PENDING";

    } else {

      fromStatus = "FORM2_PENDING";

    }

  } else {

    fromStatus = "OUTCOME_FORM_PENDING";

  }

  addStatus(
    caseId,
    fromStatus,
    TERMINAL_STATUS_BY_OUTCOME[stage.outcomeType],
    `Legacy case closed as ${stage.outcomeType}.`,
    userId
  );
}

    const pendingTaskId = createPendingForStage(caseId, stage, data, userId);

    db.prepare(`
      UPDATE pim_cases
      SET current_status_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(statusId, caseId);

    addAudit(
      caseId,
      {
        entry_type: "LEGACY",
        stage: stage.code,
        status: stage.currentStatus,
        pendingTask: stage.pendingTask,
        applicantIds,
        oppositePartyIds,
      },
      userId
    );

    return {
      caseId,
      pimNumber,
      receivedNumber: clean(data.receivedNumber),
      stage: stage.code,
      currentStatus: stage.currentStatus,
      pendingTask: stage.pendingTask,
      pendingTaskId,
    };
  })();
}

function getLegacyImportMetadata() {
  return {
    stages: STAGE_MAPPINGS,

    mediators: db.prepare(`
      SELECT
        id,
        name,
        category,
        enrollment_no,
        rotation_order,
        panel_valid_until
      FROM mediators
      WHERE active = 1
      ORDER BY
        CASE
          WHEN rotation_order IS NULL THEN 999999
          ELSE rotation_order
        END,
        name
    `).all(),

    nonstarterReasons: db.prepare(`
      SELECT
        id,
        code,
        name,
        rule_reference,
        requires_authority_decision
      FROM nonstarter_reasons
      WHERE active = 1
      ORDER BY name
    `).all(),
  };
}

module.exports = {
  DATE_ORDER,
  STAGE_MAPPINGS,
  getLegacyImportMetadata,
  importLegacyCase,
  previewLegacyImport,
  validateLegacyImport,
};