-- Phase 2: structural migration (7 of 7)
-- Generated/uploaded document metadata and the generic audit trail.
-- audit_log.old_value/new_value stay text (JSON.stringify'd by the app),
-- not jsonb - no concrete compatibility need identified yet, and this is
-- the minimum-risk choice per instructions. Storage of the underlying
-- files themselves is Phase 5, not this migration.

create table pim_documents (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  notice_id bigint references pim_notices (id),
  document_type text not null,
  document_title text not null,
  document_date date,
  file_path text not null,
  generated_by_system boolean not null default false,
  version_no integer not null default 1,
  is_current boolean not null default true,
  remarks text,
  created_by bigint references users (id),
  created_at timestamptz not null default now()
);
create index idx_documents_case on pim_documents (case_id);
create index idx_documents_notice on pim_documents (notice_id);

create table audit_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_id bigint not null,
  action text not null,
  old_value text,
  new_value text,
  changed_by bigint references users (id),
  changed_at timestamptz not null default now(),
  reason text
);
create index idx_audit_record on audit_log (table_name, record_id, changed_at);
