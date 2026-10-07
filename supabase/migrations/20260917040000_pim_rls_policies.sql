-- Phase 4: deliberate RLS policies.
--
-- ============================================================================
-- DESIGN SUMMARY (see the Phase 4 report for the full table-by-table reasoning)
-- ============================================================================
--
-- Every PIM permission in lib/pim-auth.js's PERMISSIONS map that gates a
-- *read* is granted uniformly to all four roles (aa, secretary, chairman,
-- admin) EXCEPT: VIEW_SETTINGS (excludes aa) and VIEW_AUDIT (secretary/admin
-- only). That is the one place the read side of RLS needed per-table
-- precision rather than a single blanket rule; the rest reuse one clean
-- "has an active pim_profiles row" check.
--
-- No INSERT/UPDATE/DELETE policy is created for `authenticated` or `anon`
-- on ANY PIM table in this migration - deliberately, not by oversight.
-- Every write in this application currently happens inside a multi-table
-- transaction with side effects RLS cannot see or enforce: docket entries,
-- status_history rows, task completion, and - critically - audit_log
-- entries written in the SAME transaction as the business change (verified
-- for pim_cases, mediators, system_settings, pim_users). A role-only RLS
-- write policy (e.g. "secretary/admin can update mediators") would be
-- technically well-scoped by role but would let that role bypass the
-- accompanying audit trail and business invariants (e.g.
-- ensureLastAdminSafe() for user changes) by writing directly instead of
-- through the transaction. That is a real integrity gap, not a theoretical
-- one, so writes stay where the transaction lives: the Next.js server
-- layer, using a privileged (service-role) connection once Phase 6 ports
-- that layer to Supabase. RLS here is the read-side safety boundary; it is
-- not asked to re-implement the write-side business logic.
--
-- `users` and `pim_user_sessions` (the legacy custom-auth tables, holding
-- password_hash and session_token_hash respectively) are NOT given any
-- policy here and stay fully deny-all. Nothing should ever read them
-- through a Supabase client - only the legacy SQLite connection touches
-- them, and that stops entirely once Phase 6 retires the custom session
-- system. Exposing password_hash rows to any authenticated Supabase client,
-- even scrypt-hashed, would be a regression, not a migration step.

-- ============================================================================
-- HELPER: public.current_pim_role()
-- ============================================================================
-- Why this exists: RLS policies on every other PIM table need to know the
-- calling user's PIM role without re-reading pim_profiles under that same
-- table's own RLS (pim_profiles has RLS enabled too - see Phase 3). A plain
-- (non-SECURITY DEFINER) function would run with the caller's own
-- privileges, so its internal "select ... from pim_profiles" would itself
-- be subject to pim_profiles' policies. SECURITY DEFINER makes the function
-- run with the privileges of its owner (the migration role, which owns the
-- table and therefore bypasses RLS on it by default, since FORCE ROW LEVEL
-- SECURITY is not set anywhere in this schema) - so the lookup always
-- succeeds regardless of what policies exist on pim_profiles, with no
-- recursion.
--
-- Kept deliberately narrow to stay safe as SECURITY DEFINER:
--   - no parameters: it can only ever resolve auth.uid()'s OWN role, never
--     an arbitrary user_id passed in - it cannot be used to probe other
--     users' roles.
--   - returns a single text value (the role code, or null) - no other
--     profile columns are exposed through it.
--   - folds in `active = true`, so an inactive profile transparently
--     resolves to null everywhere this function is used - one place
--     enforces "inactive profiles get nothing", not every policy
--     individually.
--   - `set search_path = public, pg_temp` pins name resolution so it can't
--     be hijacked by a malicious search_path, and every identifier inside
--     is schema-qualified regardless.
--   - STABLE (not VOLATILE): it doesn't modify the database and returns a
--     consistent result within one statement, which is both correct and
--     lets the planner cache/inline it.
--   - EXECUTE is revoked from PUBLIC and granted only to `authenticated` -
--     the anonymous role has no reason to ever call it.

create or replace function public.current_pim_role()
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select role_code
  from public.pim_profiles
  where user_id = auth.uid()
    and active = true
  limit 1
$$;

revoke all on function public.current_pim_role() from public;
grant execute on function public.current_pim_role() to authenticated;

-- ============================================================================
-- pim_profiles
-- ============================================================================
-- 1. a user can always read their own profile (needed to resolve their own
--    role/display name - and does not depend on current_pim_role(), which
--    is what keeps this policy non-recursive).
-- 2. admin can read all profiles, matching VIEW_USERS (admin only).
-- No write policy: profile writes (including role_code) are not available
-- to any authenticated/anon client - provisioning and management stay
-- service-role-only (scripts/provision-pim-auth-user.js today; the ported
-- equivalent of lib/pim-users.js's ensureLastAdminSafe()-guarded logic in a
-- later phase). This is what makes "a user cannot change their own
-- role_code" and "a user cannot modify another user's profile" true by
-- construction, not by a narrower check.

drop policy if exists pim_profiles_select_own on pim_profiles;
create policy pim_profiles_select_own
  on pim_profiles for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists pim_profiles_select_admin on pim_profiles;
create policy pim_profiles_select_admin
  on pim_profiles for select
  to authenticated
  using (public.current_pim_role() = 'admin');

-- ============================================================================
-- Reference / master data
-- ============================================================================
-- dispute_categories / status_master / event_types / task_types /
-- nonstarter_reasons: no dedicated permission gates these in PERMISSIONS -
-- they are workflow-definition lookups every case screen needs regardless
-- of role (the same audience as READ_CASE). Readable by any active profile.

drop policy if exists pim_read_active_profile on dispute_categories;
create policy pim_read_active_profile
  on dispute_categories for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on status_master;
create policy pim_read_active_profile
  on status_master for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on event_types;
create policy pim_read_active_profile
  on event_types for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on task_types;
create policy pim_read_active_profile
  on task_types for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on nonstarter_reasons;
create policy pim_read_active_profile
  on nonstarter_reasons for select
  to authenticated
  using (public.current_pim_role() is not null);

-- mediators: READ_MEDIATOR is granted to all four roles.
drop policy if exists pim_read_active_profile on mediators;
create policy pim_read_active_profile
  on mediators for select
  to authenticated
  using (public.current_pim_role() is not null);

-- system_settings: VIEW_SETTINGS is secretary/chairman/admin - aa is
-- deliberately excluded, unlike every other reference table above.
drop policy if exists pim_settings_select on system_settings;
create policy pim_settings_select
  on system_settings for select
  to authenticated
  using (public.current_pim_role() in ('secretary', 'chairman', 'admin'));

-- ============================================================================
-- Case core, workflow, notice/response/fee, mediation/outcome, pim_documents
-- ============================================================================
-- All of these are sub-data of a case (or, for pim_documents, its generated/
-- uploaded files' metadata) and share the same read audience as READ_CASE /
-- DOWNLOAD_DOCUMENT / GENERATE_DOCUMENT: all four roles, uniformly. Any
-- active profile can read; see the top-of-file note for why none of these
-- get a write policy.

drop policy if exists pim_read_active_profile on pim_cases;
create policy pim_read_active_profile
  on pim_cases for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_parties;
create policy pim_read_active_profile
  on pim_parties for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_addresses;
create policy pim_read_active_profile
  on pim_addresses for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_advocates;
create policy pim_read_active_profile
  on pim_advocates for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_case_parties;
create policy pim_read_active_profile
  on pim_case_parties for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_case_advocates;
create policy pim_read_active_profile
  on pim_case_advocates for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_scrutiny;
create policy pim_read_active_profile
  on pim_scrutiny for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_scrutiny_attempts;
create policy pim_read_active_profile
  on pim_scrutiny_attempts for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_docket;
create policy pim_read_active_profile
  on pim_docket for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_status_history;
create policy pim_read_active_profile
  on pim_status_history for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_tasks;
create policy pim_read_active_profile
  on pim_tasks for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_task_history;
create policy pim_read_active_profile
  on pim_task_history for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_notices;
create policy pim_read_active_profile
  on pim_notices for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_service_attempts;
create policy pim_read_active_profile
  on pim_service_attempts for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_responses;
create policy pim_read_active_profile
  on pim_responses for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_fees;
create policy pim_read_active_profile
  on pim_fees for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_mediator_assignments;
create policy pim_read_active_profile
  on pim_mediator_assignments for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on mediation_sessions;
create policy pim_read_active_profile
  on mediation_sessions for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_outcomes;
create policy pim_read_active_profile
  on pim_outcomes for select
  to authenticated
  using (public.current_pim_role() is not null);

drop policy if exists pim_read_active_profile on pim_documents;
create policy pim_read_active_profile
  on pim_documents for select
  to authenticated
  using (public.current_pim_role() is not null);

-- ============================================================================
-- audit_log - especially sensitive (explicit instruction).
-- ============================================================================
-- VIEW_AUDIT is secretary/admin only - narrower than the case-data default
-- (aa and chairman are both excluded). No write policy at all: every
-- audit_log insert in the current application happens server-side, inside
-- the same transaction as the change it records, using the session's own
-- resolved user id as changed_by - never a client-supplied value. Allowing
-- direct authenticated inserts would let a client impersonate changed_by or
-- write audit entries unlinked from any real change; allowing update/delete
-- would let a change and its own audit trail disagree. Neither is available
-- to any authenticated/anon client - only a service-role connection can
-- write here, same as every other table in this migration.

drop policy if exists pim_audit_select on audit_log;
create policy pim_audit_select
  on audit_log for select
  to authenticated
  using (public.current_pim_role() in ('secretary', 'admin'));
