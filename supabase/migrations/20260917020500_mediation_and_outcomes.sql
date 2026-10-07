-- Phase 2: structural migration (6 of 7)
-- Mediator assignments, mediation sittings, case outcomes.

create table pim_mediator_assignments (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  mediator_id bigint not null references mediators (id),
  assignment_date date not null,
  assignment_order_no text,
  first_mediation_date date,
  appointed_by bigint references users (id),
  rotation_suggestion_no integer,
  deviation_from_rotation boolean not null default false,
  deviation_reason text,
  status text not null default 'ACTIVE',
  replacement_for_assignment_id bigint references pim_mediator_assignments (id),
  remarks text
);
create index idx_assignments_case on pim_mediator_assignments (case_id);
create index idx_assignments_mediator on pim_mediator_assignments (mediator_id);
create index idx_assignments_status on pim_mediator_assignments (status);

create table mediation_sessions (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  assignment_id bigint not null references pim_mediator_assignments (id),
  sitting_number integer not null,
  scheduled_date date,
  actual_date date,
  applicant_present boolean not null default false,
  opposite_party_present boolean not null default false,
  effective_session boolean not null default false,
  -- free-text time-of-day; kept as text (see pim_tasks.completed_time note).
  actual_start_time text,
  actual_end_time text,
  duration_minutes integer,
  next_date date,
  session_status text not null default 'SCHEDULED',
  next_action text check (
    next_action is null or next_action in (
      'FURTHER_MEDIATION', 'READY_FOR_SETTLEMENT', 'READY_FOR_FAILURE'
    )
  ),
  administrative_remarks text,
  report_received boolean not null default false,
  report_date date,
  recorded_by bigint references users (id),
  created_at timestamptz not null default now()
);
create index idx_sessions_case on mediation_sessions (case_id, sitting_number);
create index idx_sessions_date on mediation_sessions (actual_date, scheduled_date);

create table pim_outcomes (
  id bigint generated always as identity primary key,
  case_id bigint not null unique references pim_cases (id) on delete cascade,
  outcome_type text not null check (outcome_type in ('NON_STARTER','SETTLED','FAILED','WITHDRAWN')),
  form_no text,
  outcome_date date not null,
  nonstarter_reason_id bigint references nonstarter_reasons (id),
  reason_text text,
  settlement_terms text,
  prepared_by bigint references users (id),
  verified_by bigint references users (id),
  approved_by bigint references users (id),
  -- No FK in SQLite; preserved as an unconstrained reference.
  document_id bigint,
  sent_to_applicant boolean not null default false,
  sent_to_opposite_party boolean not null default false,
  remarks text
);
