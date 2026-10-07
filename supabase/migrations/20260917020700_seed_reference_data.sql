-- Phase 2: reference/master seed data (separate from structural migration).
--
-- Scope: ONLY the pure lookup/reference tables that had rows in the live
-- database/pim.db at audit time (status_master, event_types, task_types,
-- nonstarter_reasons, mediators, system_settings). dispute_categories had
-- zero rows and is left empty.
--
-- Deliberately NOT included here:
--   - users: real accounts with password hashes. Provisioning real user
--     identities is a Phase 3 decision (Supabase Auth + pim_profiles),
--     not seeded as inert reference data now.
--   - pim_user_sessions: live session tokens - test/runtime data, never seeded.
--   - all pim_cases-and-below workflow tables: production pim_cases has
--     zero rows (verified via read-only inspection); there is no case
--     data to migrate in this phase.
--
-- IDs are preserved exactly as in SQLite (source: database/pim.db) so that
-- any future reference (e.g. legacy import scripts) can rely on the same
-- codes/ids. Identity sequences are re-synced at the end of this file.

insert into status_master (id, code, name, stage, is_active, is_terminal) overriding system value values
  (1, 'RECEIVED', 'Received', 'INSTITUTION', true, false),
  (2, 'SCRUTINY_PENDING', 'Scrutiny Pending', 'INSTITUTION', true, false),
  (3, 'DEFECT_PENDING', 'Defect / Rectification Pending', 'INSTITUTION', true, false),
  (4, 'SECRETARY_APPROVAL_PENDING', 'Secretary Approval Pending', 'INSTITUTION', true, false),
  (5, 'REGISTERED', 'PIM Registered', 'INSTITUTION', true, false),
  (6, 'FORM2_PENDING', 'Form-2 Pending', 'NOTICE', true, false),
  (7, 'FORM2_ISSUED', 'Form-2 Issued', 'NOTICE', true, false),
  (8, 'SERVICE_PENDING', 'Service Pending', 'NOTICE', true, false),
  (9, 'NOTICE_RETURNED', 'Notice Returned', 'NOTICE', true, false),
  (10, 'ADDRESS_CORRECTION_PENDING', 'Address Correction Pending', 'NOTICE', true, false),
  (11, 'FINAL_NOTICE_PENDING', 'Final Notice Pending', 'NOTICE', true, false),
  (12, 'FINAL_NOTICE_ISSUED', 'Final Notice Issued', 'NOTICE', true, false),
  (13, 'OP_APPEARANCE_PENDING', 'OP Appearance Pending', 'RESPONSE', true, false),
  (14, 'OP_APPEARED', 'OP Appeared', 'RESPONSE', true, false),
  (15, 'OP_CONSENT_PENDING', 'OP Consent Pending', 'RESPONSE', true, false),
  (16, 'OP_CONSENTED', 'OP Consented', 'RESPONSE', true, false),
  (17, 'OP_REFUSED', 'OP Refused', 'RESPONSE', true, false),
  (18, 'FEE_PENDING', 'Mediation Fee Pending', 'FEE', true, false),
  (19, 'MEDIATOR_ASSIGNMENT_PENDING', 'Mediator Assignment Pending', 'MEDIATOR', true, false),
  (20, 'MEDIATOR_ASSIGNED', 'Mediator Assigned', 'MEDIATOR', true, false),
  (21, 'MEDIATION_PENDING', 'First Mediation Pending', 'MEDIATION', true, false),
  (22, 'MEDIATION_ONGOING', 'Mediation Ongoing', 'MEDIATION', true, false),
  (23, 'OUTCOME_FORM_PENDING', 'Outcome Form Pending', 'OUTCOME', true, false),
  (24, 'CLOSED_NON_STARTER', 'Closed - Non-Starter', 'CLOSURE', true, true),
  (25, 'CLOSED_SETTLED', 'Closed - Settled', 'CLOSURE', true, true),
  (26, 'CLOSED_FAILED', 'Closed - Failed', 'CLOSURE', true, true),
  (27, 'WITHDRAWN', 'Withdrawn', 'CLOSURE', true, true),
  (28, 'AUTHORITY_DECISION_PENDING', 'Authority Decision Pending', 'AUTHORITY', true, false);

insert into event_types (id, code, name, category, active) overriding system value values
  (1, 'APPLICATION_RECEIVED', 'Application Received', 'INSTITUTION', true),
  (2, 'SCRUTINY_COMPLETED', 'Scrutiny Completed', 'INSTITUTION', true),
  (3, 'DEFECT_NOTED', 'Defect / Rectification Noted', 'INSTITUTION', true),
  (4, 'RECTIFICATION_RECEIVED', 'Rectification Received', 'INSTITUTION', true),
  (5, 'SECRETARY_APPROVAL', 'Secretary Approval', 'AUTHORITY', true),
  (6, 'PIM_REGISTERED', 'PIM Registered', 'INSTITUTION', true),
  (7, 'FORM2_PREPARED', 'Form-2 Prepared', 'NOTICE', true),
  (8, 'FORM2_DISPATCHED', 'Form-2 Dispatched', 'NOTICE', true),
  (9, 'NOTICE_DELIVERED', 'Notice Delivered', 'NOTICE', true),
  (10, 'NOTICE_RETURNED', 'Notice Returned', 'NOTICE', true),
  (11, 'ADDRESS_REQUESTED', 'Corrected Address Requested', 'NOTICE', true),
  (12, 'CORRECTED_ADDRESS_RECEIVED', 'Corrected Address Received', 'NOTICE', true),
  (13, 'FRESH_FORM2', 'Fresh Form-2 Issued', 'NOTICE', true),
  (14, 'FINAL_NOTICE', 'Final Notice Issued', 'NOTICE', true),
  (15, 'OP_APPEARED', 'OP Appeared', 'RESPONSE', true),
  (16, 'OP_TIME_REQUESTED', 'OP Sought Time', 'RESPONSE', true),
  (17, 'OP_CONSENT', 'OP Consent Recorded', 'RESPONSE', true),
  (18, 'OP_REFUSAL', 'OP Refused Mediation', 'RESPONSE', true),
  (19, 'MEDIATION_FEE_REQUESTED', 'Mediation Fee Requested', 'FEE', true),
  (20, 'MEDIATION_FEE_RECEIVED', 'Mediation Fee Received', 'FEE', true),
  (21, 'MEDIATOR_ASSIGNED', 'Mediator Assigned', 'MEDIATOR', true),
  (22, 'MEDIATION_DATE_FIXED', 'Mediation Date Fixed', 'MEDIATION', true),
  (23, 'MEDIATION_SESSION', 'Mediation Session', 'MEDIATION', true),
  (24, 'EXTENSION', 'Extension Recorded', 'MEDIATION', true),
  (25, 'FORM3', 'Form-3 Issued', 'OUTCOME', true),
  (26, 'FORM4', 'Form-4 Received', 'OUTCOME', true),
  (27, 'FORM5', 'Form-5 Received', 'OUTCOME', true),
  (28, 'WITHDRAWAL', 'Withdrawal Recorded', 'OUTCOME', true),
  (29, 'CLOSURE', 'Case Closed', 'OUTCOME', true),
  (65, 'NONSTARTER_RECORDED', 'Non-Starter Recorded', 'OUTCOME', true),
  (66, 'AUTHORITY_DECISION', 'Authority Decision', 'AUTHORITY', true),
  (67, 'OP_NO_RESPONSE', 'OP Did Not Appear / No Response', 'RESPONSE', true);

insert into task_types (id, code, name, default_priority, active) overriding system value values
  (1, 'NOTICE_RETURNED', 'Notice Returned', 'URGENT', true),
  (2, 'ADDRESS_CORRECTION', 'Obtain Corrected Address', 'URGENT', true),
  (3, 'FINAL_NOTICE_FOLLOWUP', 'Final Notice Follow-up', 'NORMAL', true),
  (4, 'OP_CONSENT_FEE', 'OP Consent + Mediation Fee', 'NORMAL', true),
  (5, 'MEDIATOR_ASSIGNMENT', 'Mediator Assignment', 'NORMAL', true),
  (6, 'FIRST_MEDIATION', 'First Mediation', 'NORMAL', true),
  (7, 'SESSION_RECORD', 'Mediation Session Record', 'NORMAL', true),
  (8, 'OUTCOME_FORM', 'Outcome Form', 'URGENT', true),
  (9, 'STATUTORY_DEADLINE', 'Statutory Deadline', 'URGENT', true),
  (10, 'MANUAL', 'Manual Task', 'NORMAL', true),
  (11, 'SCRUTINY', 'Scrutiny of Received Application', 'NORMAL', true),
  (22, 'NONSTARTER_FORM3', 'Prepare Form-3 Non-Starter Report', 'NORMAL', true),
  (23, 'NONSTARTER_AUTHORITY', 'Authority Decision on Non-Starter', 'NORMAL', true),
  (24, 'FORM2', 'Prepare Form-2 after PIM Registration', 'NORMAL', true),
  (25, 'OP_APPEARANCE_FOLLOWUP', 'OP Appearance Follow-up (Alternate Date)', 'NORMAL', true);

insert into nonstarter_reasons (id, code, name, rule_reference, requires_authority_decision, active, remarks) overriding system value values
  (1, 'FINAL_NOTICE_UNACKNOWLEDGED', 'Final notice remained unacknowledged / no response received', 'Rule 3(3)-(4), Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018', false, true, 'Use after final notice remains unacknowledged.'),
  (2, 'OP_REFUSED_MEDIATION', 'Opposite party refused to participate in mediation', 'Rule 3(4), Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018', false, true, 'Use where refusal to participate is recorded.'),
  (3, 'OP_FAILED_TO_APPEAR_AFTER_TIME', 'Opposite party failed to appear on the alternate date fixed after seeking time', 'Rule 3(5)-(6), Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018', false, true, 'Use only after an alternate date was actually granted.'),
  (4, 'BOTH_PARTIES_NOT_WILLING', 'Both parties expressed unwillingness to proceed with mediation', 'Rule 3(4), Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018', false, true, 'Use where unwillingness/non-participation is documented.'),
  (5, 'MEDIATION_FEE_NOT_SUBMITTED', 'Required mediation fee was not submitted and the process could not proceed', 'Operational ground; verify against applicable current DLSA/TNSLSA practice', true, true, 'Keep authority review enabled until local practice is confirmed.');

insert into mediators (id, name, category, enrollment_no, contact_phone, email, empanelment_order_no, empanelment_date, panel_valid_until, active, rotation_order, conflict_declaration_date, remarks, created_at, updated_at) overriding system value values
  (12, 'Mr.R.Ravikumar', 'ADVOCATE MEDIATOR', null, null, null, null, null, null, true, null, null, null, '2026-09-09T11:35:04Z', '2026-09-09T11:35:04Z'),
  (13, 'Mr.H.Rajesh', 'ADVOCATE MEDIATOR', null, null, null, null, null, null, true, null, null, null, '2026-09-09T11:35:04Z', '2026-09-09T11:35:04Z');

insert into system_settings (setting_key, setting_value, description) values
  ('INTERNAL_NONSTARTER_TARGET_DAYS', '60', 'Internal management target for non-starter stage'),
  ('PIM_HEARING_WEEKDAY', 'WEDNESDAY', 'Ordinary PIM appearance/mediation weekday'),
  ('PIM_NUMBER_PREFIX', 'PIM', 'Prefix used for PIM file numbers');

-- Re-sync identity sequences past the explicit IDs inserted above so that
-- future inserts (without an explicit id) continue correctly.
select setval(pg_get_serial_sequence('status_master', 'id'), (select max(id) from status_master));
select setval(pg_get_serial_sequence('event_types', 'id'), (select max(id) from event_types));
select setval(pg_get_serial_sequence('task_types', 'id'), (select max(id) from task_types));
select setval(pg_get_serial_sequence('nonstarter_reasons', 'id'), (select max(id) from nonstarter_reasons));
select setval(pg_get_serial_sequence('mediators', 'id'), (select max(id) from mediators));
