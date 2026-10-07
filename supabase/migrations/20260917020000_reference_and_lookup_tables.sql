-- Phase 2: structural migration (1 of 7)
-- Reference/lookup tables with no foreign keys to case data.
-- Mirrors database/schema.sql; verified against the live pim.db schema
-- via PRAGMA table_info / foreign_key_list / index_list.
--
-- Type mapping notes (see accompanying report for full rationale):
--   INTEGER PRIMARY KEY AUTOINCREMENT -> bigint generated always as identity
--   INTEGER CHECK (col IN (0,1))      -> boolean (constraint becomes redundant)
--   all other TEXT columns            -> text (unchanged)

create table dispute_categories (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  active boolean not null default true,
  remarks text
);

create table status_master (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  stage text not null,
  is_active boolean not null default true,
  is_terminal boolean not null default false
);

create table event_types (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  category text not null,
  active boolean not null default true
);

create table task_types (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  default_priority text not null default 'NORMAL',
  active boolean not null default true
);

create table nonstarter_reasons (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  rule_reference text,
  requires_authority_decision boolean not null default true,
  active boolean not null default true,
  remarks text
);

create table mediators (
  id bigint generated always as identity primary key,
  name text not null,
  category text not null default 'ADVOCATE MEDIATOR',
  enrollment_no text,
  contact_phone text,
  email text,
  empanelment_order_no text,
  -- business dates (staff-entered), not audit timestamps
  empanelment_date date,
  panel_valid_until date,
  active boolean not null default true,
  rotation_order integer,
  conflict_declaration_date date,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_mediators_valid_until on mediators (panel_valid_until);

-- Key-value settings table; setting_key is the primary key (not an id column).
create table system_settings (
  setting_key text primary key,
  setting_value text not null,
  description text
);
