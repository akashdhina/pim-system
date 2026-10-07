-- Phase 2: structural migration (4 of 7)
-- Scrutiny, docket, status history, tasks - the workflow/audit trail.
-- No triggers are created: status/docket/task cascading logic lives in
-- application code (db.transaction blocks) today and stays there; Phase 2
-- only reproduces structure, per instructions.

-- pim_scrutiny / pim_scrutiny_attempts checklist columns (form1_complete,
-- application_fee_received, dd_payee_correct, dd_valid, vakalat_available,
-- opposite_party_address_available, commercial_dispute_checked,
-- territorial_jurisdiction_checked, supporting_documents_checked) have no
-- CHECK(0,1) constraint in SQLite and application code elsewhere performs
-- strict integer comparisons on similarly-shaped columns (see pim_responses
-- below) - kept as smallint (nullable tri-state: NULL/0/1), not boolean,
-- to preserve exact current semantics rather than assume.

create table pim_scrutiny (
  id bigint generated always as identity primary key,
  case_id bigint not null unique references pim_cases (id) on delete cascade,
  form1_complete smallint,
  application_fee_received smallint,
  dd_number text,
  dd_date date,
  dd_bank text,
  dd_amount numeric,
  dd_payee_correct smallint,
  dd_valid smallint,
  vakalat_available smallint,
  opposite_party_address_available smallint,
  commercial_dispute_checked smallint,
  territorial_jurisdiction_checked smallint,
  supporting_documents_checked smallint,
  scrutiny_result text,
  defect_details text,
  rectification_date date,
  scrutinised_by bigint references users (id),
  -- written via literal SQL CURRENT_TIMESTAMP (lib/pim-legacy-import.js) - an instant, not a date.
  scrutinised_at timestamptz
);

create table pim_scrutiny_attempts (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  attempt_no integer not null,
  form1_complete smallint,
  application_fee_received smallint,
  dd_number text,
  dd_date date,
  dd_bank text,
  dd_amount numeric,
  dd_payee_correct smallint,
  dd_valid smallint,
  vakalat_available smallint,
  opposite_party_address_available smallint,
  commercial_dispute_checked smallint,
  territorial_jurisdiction_checked smallint,
  supporting_documents_checked smallint,
  scrutiny_result text,
  defect_details text,
  rectification_date date,
  scrutinised_by bigint references users (id),
  scrutinised_at timestamptz,
  created_at timestamptz not null default now(),
  unique (case_id, attempt_no)
);
create index idx_scrutiny_attempts_case on pim_scrutiny_attempts (case_id);

create table pim_docket (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  docket_date date not null,
  event_type_id bigint references event_types (id),
  entry_text text not null,
  action_required text,
  next_date date,
  entered_by bigint references users (id),
  created_at timestamptz not null default now()
);
create index idx_docket_case_date on pim_docket (case_id, docket_date);

create table pim_status_history (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  from_status_id bigint references status_master (id),
  to_status_id bigint not null references status_master (id),
  changed_at timestamptz not null default now(),
  reason text,
  changed_by bigint references users (id)
);
create index idx_status_history_case on pim_status_history (case_id, changed_at);

create table pim_tasks (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  task_type_id bigint references task_types (id),
  task_type_code text,
  description text not null,
  created_date date not null,
  due_date date,
  priority text not null default 'NORMAL',
  status text not null default 'PENDING',
  completed_date date,
  -- free-text time-of-day (not consistently HH:MM:SS across all write sites); kept as text.
  completed_time text,
  completed_by bigint references users (id),
  auto_generated boolean not null default true,
  remarks text
);
create index idx_tasks_due_status on pim_tasks (due_date, status);

create table pim_task_history (
  id bigint generated always as identity primary key,
  task_id bigint not null references pim_tasks (id) on delete cascade,
  old_status text,
  new_status text not null,
  changed_at timestamptz not null default now(),
  changed_by bigint references users (id),
  remarks text
);
