-- Phase 2: structural migration (5 of 7)
-- Form-2 notices, service attempts, OP responses, fees.

create table pim_notices (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  notice_type text not null check (notice_type in ('FORM_2_INITIAL','FORM_2_FINAL','OTHER')),
  form_no text not null default 'FORM-2',
  notice_date date not null,
  appearance_date date,
  -- free-text time-of-day; kept as text (see pim_tasks.completed_time note).
  appearance_time text,
  recipient_party_id bigint references pim_parties (id),
  address_id bigint references pim_addresses (id),
  prepared_by bigint references users (id),
  signed_by bigint references users (id),
  signed_date date,
  dispatch_date date,
  status text not null default 'PREPARED',
  -- No FK in SQLite (document_id was never constrained to pim_documents.id
  -- there); preserved as an unconstrained reference, not upgraded here.
  document_id bigint,
  remarks text
);
create index idx_notices_case on pim_notices (case_id);
create index idx_notices_address on pim_notices (address_id);

create table pim_service_attempts (
  id bigint generated always as identity primary key,
  notice_id bigint not null references pim_notices (id) on delete cascade,
  address_id bigint references pim_addresses (id),
  dispatch_mode text not null default 'REGISTERED_POST',
  dispatch_date date,
  postal_receipt_no text,
  tracking_no text,
  tracking_status text,
  postal_endorsement text,
  return_reason text check (
    return_reason is null or return_reason in (
      'ADDRESSEE_LEFT','INSUFFICIENT_ADDRESS','UNCLAIMED','REFUSED_BY_ADDRESSEE','OTHER'
    )
  ),
  delivered_date date,
  returned_date date,
  -- No FK in SQLite; preserved as an unconstrained reference.
  proof_document_id bigint,
  remarks text
);
create index idx_service_notice on pim_service_attempts (notice_id);

-- pim_responses.consent / mediation_fee_requested: no CHECK(0,1) in SQLite,
-- and app/api/pim/response/[id]/route.js performs strict integer
-- comparisons (consent === 1, [0,1].includes(consent)) - kept as smallint,
-- not boolean, per the same reasoning as the scrutiny checklist columns.
create table pim_responses (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  party_id bigint not null references pim_parties (id),
  notice_id bigint references pim_notices (id),
  response_date date not null,
  appearance_mode text,
  response_type text not null,
  -- date the OP sought time until (see app/pim/response/[id]/page.tsx date() formatter); not free text.
  time_requested_until date,
  consent smallint,
  mediation_fee_requested smallint,
  remarks text,
  entered_by bigint references users (id)
);
create index idx_responses_case on pim_responses (case_id, response_date);
create index idx_responses_notice on pim_responses (notice_id);

create table pim_fees (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  party_id bigint references pim_parties (id),
  fee_type text not null check (fee_type in ('APPLICATION_FEE','MEDIATION_FEE')),
  amount_due numeric,
  amount_received numeric,
  dd_number text,
  dd_date date,
  bank_name text,
  payee text,
  received_date date,
  deposited_date date,
  refund_amount numeric default 0,
  refund_date date,
  status text not null default 'PENDING',
  remarks text
);
create index idx_fees_case on pim_fees (case_id);
create index idx_fees_type on pim_fees (fee_type);
