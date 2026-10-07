-- Phase 2: RLS decision (deliberately minimal - see instructions).
--
-- Supabase exposes every table in the `public` schema over PostgREST using
-- the anon key by default. Leaving RLS disabled on these tables would make
-- them world-readable/writable to anyone holding the (public, client-side)
-- anon key as soon as this migration lands - before any authorization
-- model exists. Leaving RLS enabled with policies designed here would risk
-- inventing authorization rules ahead of Phase 3/4's deliberate design.
--
-- The interim choice: enable RLS on every table now with ZERO policies.
-- This is default-deny, not a permissive policy - no client (anon or
-- authenticated) can read or write any row via the API until Phase 3/4
-- adds real policies. Server-side code using a service-role key (added in
-- a later phase, if genuinely needed) bypasses RLS entirely, as usual.

alter table dispute_categories enable row level security;
alter table status_master enable row level security;
alter table event_types enable row level security;
alter table task_types enable row level security;
alter table nonstarter_reasons enable row level security;
alter table mediators enable row level security;
alter table system_settings enable row level security;

alter table users enable row level security;
alter table pim_user_sessions enable row level security;

alter table pim_cases enable row level security;
alter table pim_parties enable row level security;
alter table pim_case_parties enable row level security;
alter table pim_addresses enable row level security;
alter table pim_advocates enable row level security;
alter table pim_case_advocates enable row level security;

alter table pim_scrutiny enable row level security;
alter table pim_scrutiny_attempts enable row level security;
alter table pim_docket enable row level security;
alter table pim_status_history enable row level security;
alter table pim_tasks enable row level security;
alter table pim_task_history enable row level security;

alter table pim_notices enable row level security;
alter table pim_service_attempts enable row level security;
alter table pim_responses enable row level security;
alter table pim_fees enable row level security;

alter table pim_mediator_assignments enable row level security;
alter table mediation_sessions enable row level security;
alter table pim_outcomes enable row level security;

alter table pim_documents enable row level security;
alter table audit_log enable row level security;
