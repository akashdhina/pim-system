-- Phase 2: structural migration (3 of 7)
-- Case aggregate root, parties, addresses, advocates.
--
-- Date/timestamp notes:
--   received_date/application_date/registration_date/secretary_decision_date/
--   outcome_date/statutory_due_date/internal_60_day_date/extension_date/
--   extended_due_date are business dates produced by lib/pim-time.js
--   officeDate() ('YYYY-MM-DD', Asia/Kolkata) -> date.
--   closed_at is set inconsistently by the current application: legacy
--   import writes officeDate() (a date), but three live routes
--   (outcome/approve, nonstarter/form3, nonstarter/authority) write the
--   literal SQL CURRENT_TIMESTAMP (a full instant). To avoid losing
--   information from the latter, closed_at is kept as timestamptz here
--   rather than downgraded to date. This pre-existing inconsistency is
--   an application-code concern for a later phase, not fixed here.

create table pim_cases (
  id bigint generated always as identity primary key,
  entry_type text not null default 'NEW' check (entry_type in ('NEW','LEGACY')),
  pim_number text unique,
  received_number text,
  received_date date not null,
  application_date date not null,
  registration_date date,
  claim_amount numeric,
  dispute_description text,
  dispute_category_id bigint references dispute_categories (id),
  territorial_jurisdiction_status text,
  scrutiny_status text,
  secretary_decision text,
  secretary_decision_date date,
  current_status_id bigint references status_master (id),
  outcome_type text,
  outcome_date date,
  statutory_due_date date,
  internal_60_day_date date,
  extension_date date,
  extended_due_date date,
  priority text not null default 'NORMAL',
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index idx_cases_received_date on pim_cases (received_date);
create index idx_cases_application_date on pim_cases (application_date);
create index idx_cases_status on pim_cases (current_status_id);
create index idx_cases_registration_date on pim_cases (registration_date);
create index idx_cases_internal_60_day_date on pim_cases (internal_60_day_date);
create index idx_cases_outcome on pim_cases (outcome_type, outcome_date);
create index idx_cases_closed_at on pim_cases (closed_at);

create table pim_parties (
  id bigint generated always as identity primary key,
  name text not null,
  entity_type text not null default 'INDIVIDUAL',
  registration_no text,
  contact_phone text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table pim_case_parties (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  party_id bigint not null references pim_parties (id),
  role text not null check (role in ('APPLICANT','OPPOSITE_PARTY')),
  sequence_no integer not null default 1,
  is_primary boolean not null default false,
  -- active_from/active_to are business dates (party's active window on a case)
  active_from date,
  active_to date,
  remarks text,
  unique (case_id, party_id, role)
);
create index idx_case_parties_case on pim_case_parties (case_id);
create index idx_case_parties_party on pim_case_parties (party_id);
-- Preserves: one primary applicant and one primary opposite party per case.
create unique index idx_case_parties_one_primary_per_role
  on pim_case_parties (case_id, role)
  where is_primary = true;

create table pim_addresses (
  id bigint generated always as identity primary key,
  party_id bigint not null references pim_parties (id) on delete cascade,
  address_type text not null default 'POSTAL',
  address_line1 text not null,
  address_line2 text,
  village_town text,
  district text,
  state text,
  pincode text,
  is_current boolean not null default true,
  source text,
  verified_date date,
  remarks text,
  created_at timestamptz not null default now()
);
create index idx_addresses_party on pim_addresses (party_id);

create table pim_advocates (
  id bigint generated always as identity primary key,
  name text not null,
  enrollment_no text,
  phone text,
  email text,
  address text,
  active boolean not null default true,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table pim_case_advocates (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  party_id bigint not null references pim_parties (id),
  advocate_id bigint not null references pim_advocates (id),
  role text not null default 'COUNSEL',
  from_date date,
  to_date date,
  remarks text
);
