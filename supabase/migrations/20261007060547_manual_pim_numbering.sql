-- Phase 6 production-completion sprint: PIM numbering policy reversal.
--
-- The PIM number is no longer auto-allocated from pim_number_sequences in
-- normal staff workflow. Staff now enters the official running number from
-- the physical PIM/Assignment Register; the system validates and stores it.
-- pim_number_sequences is kept (not dropped) for historical/compatibility
-- reference only - see lib/pim-data/pim-numbering.js.
--
-- Additive only: no existing column is dropped or retyped, no existing row
-- is rewritten destructively. running_number/pim_year are backfilled from
-- the existing pim_number string on a best-effort basis; any row that
-- cannot be parsed is left NULL rather than guessed.

alter table pim_cases add column if not exists running_number integer;
alter table pim_cases add column if not exists pim_year integer;

-- Best-effort backfill from the existing "PREFIX/NUMBER/YEAR" pim_number
-- string (e.g. "PIM/109/2026"). Rows with an unexpected format are left
-- NULL - never guessed - and remain assignable for manual correction later.
update pim_cases
set
  running_number = split_part(pim_number, '/', 2)::integer,
  pim_year = split_part(pim_number, '/', 3)::integer
where
  pim_number is not null
  and running_number is null
  and pim_number ~ '^[A-Za-z]+/[0-9]+/[0-9]{4}$';

-- Hard-block duplicates: one running number per year, system-wide.
-- Partial (running_number IS NOT NULL) so unassigned cases are unaffected.
create unique index if not exists uq_pim_cases_year_running_number
  on pim_cases (pim_year, running_number)
  where running_number is not null;

-- Controlled-correction audit trail. A normal staff user cannot silently
-- edit pim_number/running_number once assigned (enforced in application
-- code, not a DB trigger) - every change must go through this table.
create table if not exists pim_number_corrections (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  old_pim_number text,
  new_pim_number text not null,
  old_running_number integer,
  new_running_number integer not null,
  year integer not null,
  reason text not null,
  corrected_by bigint references users (id),
  corrected_at timestamptz not null default now()
);
create index if not exists idx_number_corrections_case on pim_number_corrections (case_id);
