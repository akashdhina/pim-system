-- Phase 3: pim_profiles - PIM role/identity tied to Supabase Auth.
--
-- Ties into auth.users (Supabase-managed), which is why this migration
-- comes after all of Phase 2's structural migrations rather than editing
-- them. Does NOT touch the existing `users` table (lib/pim-auth.js's
-- custom login system keeps using it unchanged in this phase).
--
-- Columns intentionally NOT carried over from `users`:
--   password_hash, failed_login_count, locked_until - credential/lockout
--     state now belongs to Supabase Auth itself, not application data.
--   must_change_password - Supabase Auth's invite/recovery flow already
--     forces a password to be set before the account is usable, making a
--     separate flag redundant ("do not create duplicate authentication
--     state unnecessarily").
--
-- role_code is NOT NULL here (unlike the legacy `users.role_code`, which
-- is nullable with an application-level inference fallback in
-- normalizeRole() for legacy rows). Every profile provisioned going
-- forward is created deliberately (see scripts/provision-pim-auth-user.js)
-- and should always carry an explicit role - the inference fallback was a
-- legacy-data compatibility shim, not a business rule worth repeating here.

create table pim_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role_code text not null check (role_code in ('aa','secretary','chairman','admin')),
  display_name text not null,
  designation text not null,
  active boolean not null default true,
  -- Transition mapping back to the legacy SQLite `users` row, so Phase 7's
  -- legacy data migration can resolve old integer changed_by/entered_by/
  -- etc. references to the right Supabase Auth identity. Nullable: staff
  -- provisioned after the SQLite system is retired won't have either.
  legacy_username text unique,
  legacy_user_id bigint unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Phase 2-style default-deny: RLS enabled, zero policies. No route reads
-- pim_profiles through the authenticated/anon Supabase client yet (see
-- lib/pim-supabase-auth.js, which deliberately uses the service-role
-- client to bypass this until real policies exist), so there is nothing
-- for a permissive policy to unlock prematurely.
--
-- Policies Phase 4 will need to design (not created now):
--   - a user can select their own row (user_id = auth.uid())
--   - secretary/admin can select all rows (for user management screens)
--   - insert/update stays service-role-only (provisioning is a privileged
--     operation - see scripts/provision-pim-auth-user.js); no client-side
--     self-service role changes, ever.
alter table pim_profiles enable row level security;
