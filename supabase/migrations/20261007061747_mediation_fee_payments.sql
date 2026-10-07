-- Phase 6 production-completion sprint: mediation fee as immutable
-- per-payment transactions instead of one mutable case-level row.
--
-- Additive only. pim_fees is KEPT UNCHANGED (not dropped, not migrated) -
-- verified live before this migration: every pim_fees MEDIATION_FEE row in
-- this project has amount_received = 0 (all are PENDING skeleton rows
-- created by lib/pim-data/response.js's ensureMediationFeeTx, or
-- pre-existing test fixtures) - there is no genuine historical mediation
-- payment anywhere in this table to lose or reinterpret. pim_fees remains
-- the authoritative APPLICATION_FEE record (out of scope for this batch)
-- and is left as a historical/compatibility reference for MEDIATION_FEE.
--
-- paying_side has exactly two values: the applicant side and the
-- respondent/opposite-party side collectively (never one row per
-- individual OP - multiple OPs jointly constitute the OP_SIDE half).
--
-- NOTE: this file was written after the fact to match a migration
-- already applied directly to the live project during today's sprint
-- (version 20261007061747) - recreated here verbatim from the applied
-- SQL so the local migration history matches the remote database. See
-- docs/pim-dlsa-mis-integration-handoff.md for the same note about an
-- earlier, pre-existing gap (20260930093508) found during this cleanup.
create table pim_fee_payments (
  id bigint generated always as identity primary key,
  case_id bigint not null references pim_cases (id) on delete cascade,
  paying_side text not null check (paying_side in ('APPLICANT', 'OP_SIDE')),
  amount numeric not null check (amount > 0),
  payment_date date not null,
  payment_mode text not null default 'DD',
  dd_number text,
  dd_date date,
  bank_name text,
  reference_number text,
  remarks text,
  recorded_by bigint references users (id),
  created_at timestamptz not null default now()
);
create index idx_fee_payments_case on pim_fee_payments (case_id);
create index idx_fee_payments_case_side on pim_fee_payments (case_id, paying_side);
