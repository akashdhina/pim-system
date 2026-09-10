const Database = require("better-sqlite3");
const path = require("path");

const dbPath =
  process.env.PIM_DB_PATH ||
  path.join(__dirname, "..", "database", "pim.db");
const db = new Database(dbPath);

db.pragma("foreign_keys = ON");

const statuses = [
  ["RECEIVED", "Received", "INSTITUTION", 0],
  ["SCRUTINY_PENDING", "Scrutiny Pending", "INSTITUTION", 0],
  ["DEFECT_PENDING", "Defect / Rectification Pending", "INSTITUTION", 0],
  ["SECRETARY_APPROVAL_PENDING", "Secretary Approval Pending", "INSTITUTION", 0],
  ["REGISTERED", "PIM Registered", "INSTITUTION", 0],
  ["FORM2_PENDING", "Form-2 Pending", "NOTICE", 0],
  ["FORM2_ISSUED", "Form-2 Issued", "NOTICE", 0],
  ["SERVICE_PENDING", "Service Pending", "NOTICE", 0],
  ["NOTICE_RETURNED", "Notice Returned", "NOTICE", 0],
  ["ADDRESS_CORRECTION_PENDING", "Address Correction Pending", "NOTICE", 0],
  ["FINAL_NOTICE_PENDING", "Final Notice Pending", "NOTICE", 0],
  ["FINAL_NOTICE_ISSUED", "Final Notice Issued", "NOTICE", 0],
  ["OP_APPEARANCE_PENDING", "OP Appearance Pending", "RESPONSE", 0],
  ["OP_APPEARED", "OP Appeared", "RESPONSE", 0],
  ["OP_CONSENT_PENDING", "OP Consent Pending", "RESPONSE", 0],
  ["OP_CONSENTED", "OP Consented", "RESPONSE", 0],
  ["OP_REFUSED", "OP Refused", "RESPONSE", 0],
  ["FEE_PENDING", "Mediation Fee Pending", "FEE", 0],
  ["MEDIATOR_ASSIGNMENT_PENDING", "Mediator Assignment Pending", "MEDIATOR", 0],
  ["MEDIATOR_ASSIGNED", "Mediator Assigned", "MEDIATOR", 0],
  ["MEDIATION_PENDING", "First Mediation Pending", "MEDIATION", 0],
  ["MEDIATION_ONGOING", "Mediation Ongoing", "MEDIATION", 0],
  ["OUTCOME_FORM_PENDING", "Outcome Form Pending", "OUTCOME", 0],
  ["CLOSED_NON_STARTER", "Closed - Non-Starter", "CLOSURE", 1],
  ["CLOSED_SETTLED", "Closed - Settled", "CLOSURE", 1],
  ["CLOSED_FAILED", "Closed - Failed", "CLOSURE", 1],
  ["WITHDRAWN", "Withdrawn", "CLOSURE", 1],
  ["AUTHORITY_DECISION_PENDING", "Authority Decision Pending", "AUTHORITY", 0],
];

const events = [
  ["APPLICATION_RECEIVED", "Application Received", "INSTITUTION"],
  ["SCRUTINY_COMPLETED", "Scrutiny Completed", "INSTITUTION"],
  ["DEFECT_NOTED", "Defect / Rectification Noted", "INSTITUTION"],
  ["RECTIFICATION_RECEIVED", "Rectification Received", "INSTITUTION"],
  ["SECRETARY_APPROVAL", "Secretary Approval", "AUTHORITY"],
  ["PIM_REGISTERED", "PIM Registered", "INSTITUTION"],
  ["FORM2_PREPARED", "Form-2 Prepared", "NOTICE"],
  ["FORM2_DISPATCHED", "Form-2 Dispatched", "NOTICE"],
  ["NOTICE_DELIVERED", "Notice Delivered", "NOTICE"],
  ["NOTICE_RETURNED", "Notice Returned", "NOTICE"],
  ["ADDRESS_REQUESTED", "Corrected Address Requested", "NOTICE"],
  ["CORRECTED_ADDRESS_RECEIVED", "Corrected Address Received", "NOTICE"],
  ["NO_CORRECTED_ADDRESS", "No Corrected Address Available", "NOTICE"],
  ["FRESH_FORM2", "Fresh Form-2 Issued", "NOTICE"],
  ["FINAL_NOTICE", "Final Notice Issued", "NOTICE"],
  ["OP_APPEARED", "OP Appeared", "RESPONSE"],
  ["OP_TIME_REQUESTED", "OP Sought Time", "RESPONSE"],
  ["OP_CONSENT", "OP Consent Recorded", "RESPONSE"],
  ["OP_REFUSAL", "OP Refused Mediation", "RESPONSE"],
  ["OP_NO_RESPONSE", "OP Did Not Appear / No Response", "RESPONSE"],
  ["MEDIATION_FEE_REQUESTED", "Mediation Fee Requested", "FEE"],
  ["MEDIATION_FEE_RECEIVED", "Mediation Fee Received", "FEE"],
  ["MEDIATOR_ASSIGNED", "Mediator Assigned", "MEDIATOR"],
  ["MEDIATION_DATE_FIXED", "Mediation Date Fixed", "MEDIATION"],
  ["MEDIATION_SESSION", "Mediation Session", "MEDIATION"],
  ["EXTENSION", "Extension Recorded", "MEDIATION"],
  ["FORM3", "Form-3 Issued", "OUTCOME"],
  ["FORM4", "Form-4 Received", "OUTCOME"],
  ["FORM5", "Form-5 Received", "OUTCOME"],
  ["WITHDRAWAL", "Withdrawal Recorded", "OUTCOME"],
  ["CLOSURE", "Case Closed", "OUTCOME"],
];

const tasks = [
  ["SCRUTINY", "Scrutiny of Received Application", "NORMAL"],
  ["FORM2", "Prepare Form-2 after PIM Registration", "NORMAL"],
  ["NOTICE_RETURNED", "Notice Returned", "URGENT"],
  ["ADDRESS_CORRECTION", "Obtain Corrected Address", "URGENT"],
  ["FINAL_NOTICE_FOLLOWUP", "Final Notice Follow-up", "NORMAL"],
  ["OP_CONSENT_FEE", "OP Consent + Mediation Fee", "NORMAL"],
  ["OP_APPEARANCE_FOLLOWUP", "OP Appearance Follow-up (Alternate Date)", "NORMAL"],
  ["MEDIATOR_ASSIGNMENT", "Mediator Assignment", "NORMAL"],
  ["FIRST_MEDIATION", "First Mediation", "NORMAL"],
  ["SESSION_RECORD", "Mediation Session Record", "NORMAL"],
  ["OUTCOME_FORM", "Outcome Form", "URGENT"],
  ["NONSTARTER_FORM3", "Prepare Form-3 Non-Starter Report", "NORMAL"],
  ["NONSTARTER_AUTHORITY", "Authority Decision on Non-Starter", "NORMAL"],
  ["STATUTORY_DEADLINE", "Statutory Deadline", "URGENT"],
  ["MANUAL", "Manual Task", "NORMAL"],
];

const users = [
  ["aa", "Administrative Assistant", "Junior Administrative Assistant"],
  ["secretary", "Secretary", "Secretary, DLSA"],
  ["chairman", "Chairman", "Chairman, DLSA"],
  ["admin", "System Administrator", "System Administrator"],
];

const settings = [
  ["PIM_NUMBER_PREFIX", "PIM", "Prefix used for PIM file numbers"],
  ["INTERNAL_NONSTARTER_TARGET_DAYS", "60", "Internal management target for non-starter stage"],
  ["PIM_HEARING_WEEKDAY", "WEDNESDAY", "Ordinary PIM appearance/mediation weekday"],
];

const insertStatus = db.prepare(`
  INSERT OR IGNORE INTO status_master
  (code, name, stage, is_terminal)
  VALUES (?, ?, ?, ?)
`);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO event_types
  (code, name, category)
  VALUES (?, ?, ?)
`);

const insertTask = db.prepare(`
  INSERT OR IGNORE INTO task_types
  (code, name, default_priority)
  VALUES (?, ?, ?)
`);

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users
  (username, display_name, designation)
  VALUES (?, ?, ?)
`);

const insertSetting = db.prepare(`
  INSERT OR IGNORE INTO system_settings
  (setting_key, setting_value, description)
  VALUES (?, ?, ?)
`);

const seed = db.transaction(() => {
  for (const row of statuses) insertStatus.run(...row);
  for (const row of events) insertEvent.run(...row);
  for (const row of tasks) insertTask.run(...row);
  for (const row of users) insertUser.run(...row);
  for (const row of settings) insertSetting.run(...row);
});

try {
  seed();

  console.log("Master data seeded successfully.");

  console.log(
    "Statuses:",
    db.prepare("SELECT COUNT(*) AS count FROM status_master").get().count
  );

  console.log(
    "Events:",
    db.prepare("SELECT COUNT(*) AS count FROM event_types").get().count
  );

  console.log(
    "Task types:",
    db.prepare("SELECT COUNT(*) AS count FROM task_types").get().count
  );

  console.log(
    "Users:",
    db.prepare("SELECT COUNT(*) AS count FROM users").get().count
  );

  console.log(
    "Settings:",
    db.prepare("SELECT COUNT(*) AS count FROM system_settings").get().count
  );
} finally {
  db.close();
}