-- Phase 2: structural migration (2 of 7)
-- Custom `users` table and session store, preserved as-is.
-- Phase 3 will introduce Supabase Auth + pim_profiles; this table is NOT
-- replaced yet, per instructions. password_hash / failed_login_count /
-- locked_until / role_code are all kept.

create table users (
  id bigint generated always as identity primary key,
  username text not null unique,
  display_name text not null,
  designation text not null,
  role_code text check (role_code in ('aa','secretary','chairman','admin')),
  password_hash text,
  failed_login_count integer not null default 0,
  -- locked_until / last_login_at / password_changed_at are set from
  -- application code via new Date().toISOString() (lib/pim-auth.js) -
  -- full instants, not business dates.
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  must_change_password boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table pim_user_sessions (
  id bigint generated always as identity primary key,
  session_token_hash text not null unique,
  user_id bigint not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  user_agent text,
  ip_address text
);
create index idx_sessions_user on pim_user_sessions (user_id);
create index idx_sessions_expires on pim_user_sessions (expires_at);
