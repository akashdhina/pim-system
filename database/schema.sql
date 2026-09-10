PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL UNIQUE,
 display_name TEXT NOT NULL,
 designation TEXT NOT NULL,
 role_code TEXT CHECK (role_code IN ('aa','secretary','chairman','admin')),
 password_hash TEXT,
 failed_login_count INTEGER NOT NULL DEFAULT 0,
 locked_until TEXT,
 last_login_at TEXT,
 password_changed_at TEXT,
 must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pim_user_sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 session_token_hash TEXT NOT NULL UNIQUE,
 user_id INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 revoked_at TEXT,
 user_agent TEXT,
 ip_address TEXT,
 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dispute_categories (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 remarks TEXT
);

CREATE TABLE IF NOT EXISTS status_master (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 stage TEXT NOT NULL,
 is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
 is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0,1))
);

CREATE TABLE IF NOT EXISTS event_types (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 category TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE IF NOT EXISTS task_types (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 default_priority TEXT NOT NULL DEFAULT 'NORMAL',
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE IF NOT EXISTS nonstarter_reasons (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 rule_reference TEXT,
 requires_authority_decision INTEGER NOT NULL DEFAULT 1 CHECK (requires_authority_decision IN (0,1)),
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 remarks TEXT
);

CREATE TABLE IF NOT EXISTS mediators (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT 'ADVOCATE MEDIATOR',
 enrollment_no TEXT,
 contact_phone TEXT,
 email TEXT,
 empanelment_order_no TEXT,
 empanelment_date TEXT,
 panel_valid_until TEXT,
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 rotation_order INTEGER,
 conflict_declaration_date TEXT,
 remarks TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pim_cases (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 entry_type TEXT NOT NULL DEFAULT 'NEW' CHECK (entry_type IN ('NEW','LEGACY')),
 pim_number TEXT UNIQUE,
 received_number TEXT,
 received_date TEXT NOT NULL,
 application_date TEXT NOT NULL,
 registration_date TEXT,
 claim_amount NUMERIC,
 dispute_description TEXT,
 dispute_category_id INTEGER,
 territorial_jurisdiction_status TEXT,
 scrutiny_status TEXT,
 secretary_decision TEXT,
 secretary_decision_date TEXT,
 current_status_id INTEGER,
 outcome_type TEXT,
 outcome_date TEXT,
 statutory_due_date TEXT,
 internal_60_day_date TEXT,
 extension_date TEXT,
 extended_due_date TEXT,
 priority TEXT NOT NULL DEFAULT 'NORMAL',
 remarks TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 closed_at TEXT,
 FOREIGN KEY (dispute_category_id) REFERENCES dispute_categories(id),
 FOREIGN KEY (current_status_id) REFERENCES status_master(id)
);

CREATE TABLE IF NOT EXISTS pim_parties (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 entity_type TEXT NOT NULL DEFAULT 'INDIVIDUAL',
 registration_no TEXT,
 contact_phone TEXT,
 email TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pim_case_parties (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 party_id INTEGER NOT NULL,
 role TEXT NOT NULL CHECK (role IN ('APPLICANT','OPPOSITE_PARTY')),
 sequence_no INTEGER NOT NULL DEFAULT 1,
 is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
 active_from TEXT,
 active_to TEXT,
 remarks TEXT,
 UNIQUE(case_id, party_id, role),
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (party_id) REFERENCES pim_parties(id)
);

CREATE TABLE IF NOT EXISTS pim_addresses (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 party_id INTEGER NOT NULL,
 address_type TEXT NOT NULL DEFAULT 'POSTAL',
 address_line1 TEXT NOT NULL,
 address_line2 TEXT,
 village_town TEXT,
 district TEXT,
 state TEXT,
 pincode TEXT,
 is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
 source TEXT,
 verified_date TEXT,
 remarks TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (party_id) REFERENCES pim_parties(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pim_advocates (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 enrollment_no TEXT,
 phone TEXT,
 email TEXT,
 address TEXT,
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 remarks TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pim_case_advocates (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 party_id INTEGER NOT NULL,
 advocate_id INTEGER NOT NULL,
 role TEXT NOT NULL DEFAULT 'COUNSEL',
 from_date TEXT,
 to_date TEXT,
 remarks TEXT,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (party_id) REFERENCES pim_parties(id),
 FOREIGN KEY (advocate_id) REFERENCES pim_advocates(id)
);

CREATE TABLE IF NOT EXISTS pim_scrutiny (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL UNIQUE,
 form1_complete INTEGER,
 application_fee_received INTEGER,
 dd_number TEXT,
 dd_date TEXT,
 dd_bank TEXT,
 dd_amount NUMERIC,
 dd_payee_correct INTEGER,
 dd_valid INTEGER,
 vakalat_available INTEGER,
 opposite_party_address_available INTEGER,
 commercial_dispute_checked INTEGER,
 territorial_jurisdiction_checked INTEGER,
 supporting_documents_checked INTEGER,
 scrutiny_result TEXT,
 defect_details TEXT,
 rectification_date TEXT,
 scrutinised_by INTEGER,
 scrutinised_at TEXT,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (scrutinised_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_scrutiny_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 attempt_no INTEGER NOT NULL,
 form1_complete INTEGER,
 application_fee_received INTEGER,
 dd_number TEXT,
 dd_date TEXT,
 dd_bank TEXT,
 dd_amount NUMERIC,
 dd_payee_correct INTEGER,
 dd_valid INTEGER,
 vakalat_available INTEGER,
 opposite_party_address_available INTEGER,
 commercial_dispute_checked INTEGER,
 territorial_jurisdiction_checked INTEGER,
 supporting_documents_checked INTEGER,
 scrutiny_result TEXT,
 defect_details TEXT,
 rectification_date TEXT,
 scrutinised_by INTEGER,
 scrutinised_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(case_id, attempt_no),
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (scrutinised_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_docket (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 docket_date TEXT NOT NULL,
 event_type_id INTEGER,
 entry_text TEXT NOT NULL,
 action_required TEXT,
 next_date TEXT,
 entered_by INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (event_type_id) REFERENCES event_types(id),
 FOREIGN KEY (entered_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_status_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 from_status_id INTEGER,
 to_status_id INTEGER NOT NULL,
 changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason TEXT,
 changed_by INTEGER,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (from_status_id) REFERENCES status_master(id),
 FOREIGN KEY (to_status_id) REFERENCES status_master(id),
 FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_notices (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 notice_type TEXT NOT NULL CHECK (notice_type IN ('FORM_2_INITIAL','FORM_2_FINAL','OTHER')),
 form_no TEXT NOT NULL DEFAULT 'FORM-2',
 notice_date TEXT NOT NULL,
 appearance_date TEXT,
 appearance_time TEXT,
 recipient_party_id INTEGER,
 address_id INTEGER,
 prepared_by INTEGER,
 signed_by INTEGER,
 signed_date TEXT,
 dispatch_date TEXT,
 status TEXT NOT NULL DEFAULT 'PREPARED',
 document_id INTEGER,
 remarks TEXT,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (recipient_party_id) REFERENCES pim_parties(id),
 FOREIGN KEY (address_id) REFERENCES pim_addresses(id),
 FOREIGN KEY (prepared_by) REFERENCES users(id),
 FOREIGN KEY (signed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_service_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 notice_id INTEGER NOT NULL,
 address_id INTEGER,
 dispatch_mode TEXT NOT NULL DEFAULT 'REGISTERED_POST',
 dispatch_date TEXT,
 postal_receipt_no TEXT,
 tracking_no TEXT,
 tracking_status TEXT,
 postal_endorsement TEXT,
 return_reason TEXT CHECK (return_reason IS NULL OR return_reason IN ('ADDRESSEE_LEFT','INSUFFICIENT_ADDRESS','UNCLAIMED','REFUSED_BY_ADDRESSEE','OTHER')),
 delivered_date TEXT,
 returned_date TEXT,
 proof_document_id INTEGER,
 remarks TEXT,
 FOREIGN KEY (notice_id) REFERENCES pim_notices(id) ON DELETE CASCADE,
 FOREIGN KEY (address_id) REFERENCES pim_addresses(id)
);

CREATE TABLE IF NOT EXISTS pim_responses (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 party_id INTEGER NOT NULL,
 notice_id INTEGER,
 response_date TEXT NOT NULL,
 appearance_mode TEXT,
 response_type TEXT NOT NULL,
 time_requested_until TEXT,
 consent INTEGER,
 mediation_fee_requested INTEGER,
 remarks TEXT,
 entered_by INTEGER,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (party_id) REFERENCES pim_parties(id),
 FOREIGN KEY (notice_id) REFERENCES pim_notices(id),
 FOREIGN KEY (entered_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_fees (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 party_id INTEGER,
 fee_type TEXT NOT NULL CHECK (fee_type IN ('APPLICATION_FEE','MEDIATION_FEE')),
 amount_due NUMERIC,
 amount_received NUMERIC,
 dd_number TEXT,
 dd_date TEXT,
 bank_name TEXT,
 payee TEXT,
 received_date TEXT,
 deposited_date TEXT,
 refund_amount NUMERIC DEFAULT 0,
 refund_date TEXT,
 status TEXT NOT NULL DEFAULT 'PENDING',
 remarks TEXT,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (party_id) REFERENCES pim_parties(id)
);

CREATE TABLE IF NOT EXISTS pim_mediator_assignments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 mediator_id INTEGER NOT NULL,
 assignment_date TEXT NOT NULL,
 assignment_order_no TEXT,
 first_mediation_date TEXT,
 appointed_by INTEGER,
 rotation_suggestion_no INTEGER,
 deviation_from_rotation INTEGER NOT NULL DEFAULT 0 CHECK (deviation_from_rotation IN (0,1)),
 deviation_reason TEXT,
 status TEXT NOT NULL DEFAULT 'ACTIVE',
 replacement_for_assignment_id INTEGER,
 remarks TEXT,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (mediator_id) REFERENCES mediators(id),
 FOREIGN KEY (appointed_by) REFERENCES users(id),
 FOREIGN KEY (replacement_for_assignment_id) REFERENCES pim_mediator_assignments(id)
);

CREATE TABLE IF NOT EXISTS mediation_sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 assignment_id INTEGER NOT NULL,
 sitting_number INTEGER NOT NULL,
 scheduled_date TEXT,
 actual_date TEXT,
 applicant_present INTEGER NOT NULL DEFAULT 0 CHECK (applicant_present IN (0,1)),
 opposite_party_present INTEGER NOT NULL DEFAULT 0 CHECK (opposite_party_present IN (0,1)),
 effective_session INTEGER NOT NULL DEFAULT 0 CHECK (effective_session IN (0,1)),
 actual_start_time TEXT,
 actual_end_time TEXT,
 duration_minutes INTEGER,
 next_date TEXT,
 session_status TEXT NOT NULL DEFAULT 'SCHEDULED',
 next_action TEXT CHECK (next_action IS NULL OR next_action IN ('FURTHER_MEDIATION','READY_FOR_SETTLEMENT','READY_FOR_FAILURE')),
 administrative_remarks TEXT,
 report_received INTEGER NOT NULL DEFAULT 0 CHECK (report_received IN (0,1)),
 report_date TEXT,
 recorded_by INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (assignment_id) REFERENCES pim_mediator_assignments(id),
 FOREIGN KEY (recorded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_outcomes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL UNIQUE,
 outcome_type TEXT NOT NULL CHECK (outcome_type IN ('NON_STARTER','SETTLED','FAILED','WITHDRAWN')),
 form_no TEXT,
 outcome_date TEXT NOT NULL,
 nonstarter_reason_id INTEGER,
 reason_text TEXT,
 settlement_terms TEXT,
 prepared_by INTEGER,
 verified_by INTEGER,
 approved_by INTEGER,
 document_id INTEGER,
 sent_to_applicant INTEGER NOT NULL DEFAULT 0 CHECK (sent_to_applicant IN (0,1)),
 sent_to_opposite_party INTEGER NOT NULL DEFAULT 0 CHECK (sent_to_opposite_party IN (0,1)),
 remarks TEXT,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (nonstarter_reason_id) REFERENCES nonstarter_reasons(id),
 FOREIGN KEY (prepared_by) REFERENCES users(id),
 FOREIGN KEY (verified_by) REFERENCES users(id),
 FOREIGN KEY (approved_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_documents (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 notice_id INTEGER,
 document_type TEXT NOT NULL,
 document_title TEXT NOT NULL,
 document_date TEXT,
 file_path TEXT NOT NULL,
 generated_by_system INTEGER NOT NULL DEFAULT 0 CHECK (generated_by_system IN (0,1)),
 version_no INTEGER NOT NULL DEFAULT 1,
 is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
 remarks TEXT,
 created_by INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (notice_id) REFERENCES pim_notices(id),
 FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL,
 task_type_id INTEGER,
 task_type_code TEXT,
 description TEXT NOT NULL,
 created_date TEXT NOT NULL,
 due_date TEXT,
 priority TEXT NOT NULL DEFAULT 'NORMAL',
 status TEXT NOT NULL DEFAULT 'PENDING',
 completed_date TEXT,
 completed_time TEXT,
 completed_by INTEGER,
 auto_generated INTEGER NOT NULL DEFAULT 1 CHECK (auto_generated IN (0,1)),
 remarks TEXT,
 FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
 FOREIGN KEY (task_type_id) REFERENCES task_types(id),
 FOREIGN KEY (completed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pim_task_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id INTEGER NOT NULL,
 old_status TEXT,
 new_status TEXT NOT NULL,
 changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 changed_by INTEGER,
 remarks TEXT,
 FOREIGN KEY (task_id) REFERENCES pim_tasks(id) ON DELETE CASCADE,
 FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 table_name TEXT NOT NULL,
 record_id INTEGER NOT NULL,
 action TEXT NOT NULL,
 old_value TEXT,
 new_value TEXT,
 changed_by INTEGER,
 changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason TEXT,
 FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS system_settings (
 setting_key TEXT PRIMARY KEY,
 setting_value TEXT NOT NULL,
 description TEXT
);

CREATE INDEX IF NOT EXISTS idx_cases_received_date ON pim_cases(received_date);
CREATE INDEX IF NOT EXISTS idx_cases_application_date ON pim_cases(application_date);
CREATE INDEX IF NOT EXISTS idx_cases_status ON pim_cases(current_status_id);
CREATE INDEX IF NOT EXISTS idx_case_parties_case ON pim_case_parties(case_id);
CREATE INDEX IF NOT EXISTS idx_case_parties_party ON pim_case_parties(party_id);
CREATE INDEX IF NOT EXISTS idx_addresses_party ON pim_addresses(party_id);
CREATE INDEX IF NOT EXISTS idx_docket_case_date ON pim_docket(case_id, docket_date);
CREATE INDEX IF NOT EXISTS idx_status_history_case ON pim_status_history(case_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_notices_case ON pim_notices(case_id);
CREATE INDEX IF NOT EXISTS idx_notices_address ON pim_notices(address_id);
CREATE INDEX IF NOT EXISTS idx_service_notice ON pim_service_attempts(notice_id);
CREATE INDEX IF NOT EXISTS idx_scrutiny_attempts_case ON pim_scrutiny_attempts(case_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_parties_one_primary_per_role ON pim_case_parties(case_id, role) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_responses_case ON pim_responses(case_id, response_date);
CREATE INDEX IF NOT EXISTS idx_responses_notice ON pim_responses(notice_id);
CREATE INDEX IF NOT EXISTS idx_fees_case ON pim_fees(case_id);
CREATE INDEX IF NOT EXISTS idx_assignments_case ON pim_mediator_assignments(case_id);
CREATE INDEX IF NOT EXISTS idx_assignments_mediator ON pim_mediator_assignments(mediator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_case ON mediation_sessions(case_id, sitting_number);
CREATE INDEX IF NOT EXISTS idx_tasks_due_status ON pim_tasks(due_date, status);
CREATE INDEX IF NOT EXISTS idx_documents_case ON pim_documents(case_id);
CREATE INDEX IF NOT EXISTS idx_documents_notice ON pim_documents(notice_id);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_log(table_name, record_id, changed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON pim_user_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON pim_user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON pim_user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_cases_registration_date ON pim_cases(registration_date);
CREATE INDEX IF NOT EXISTS idx_cases_internal_60_day_date ON pim_cases(internal_60_day_date);
CREATE INDEX IF NOT EXISTS idx_cases_outcome ON pim_cases(outcome_type, outcome_date);
CREATE INDEX IF NOT EXISTS idx_cases_closed_at ON pim_cases(closed_at);
CREATE INDEX IF NOT EXISTS idx_mediators_valid_until ON mediators(panel_valid_until);
CREATE INDEX IF NOT EXISTS idx_assignments_status ON pim_mediator_assignments(status);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON mediation_sessions(actual_date, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_fees_type ON pim_fees(fee_type);

COMMIT;
