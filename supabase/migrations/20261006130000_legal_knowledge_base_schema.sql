-- Phase LK-2: Legal Knowledge Base + Contextual Guidance Engine - schema.
--
-- Cross-cutting support module. Does NOT touch pim_cases, pim_fees,
-- pim_mediator_assignments, pim_outcomes, nonstarter_reasons, or any other
-- existing workflow table - this migration is purely additive.
--
-- Governing design: docs/pim-legal-knowledge-base-design.md (LK-1, revised
-- after primary-source verification) and docs/pim-legal-knowledge-base-lk2.md
-- (this phase's own record). Authority hierarchy, verification-state model,
-- and the case_holding/operational_proposition/negative_rule split are
-- explained there - this file implements, not redesigns, that document.
--
-- Final schema-quality decisions made in this pass (see lk2 doc for the
-- full reasoning):
--   1. Workflow-stage mapping is NORMALIZED (legal_source_workflow_stages /
--      legal_guidance_rule_stages join tables, FK'd to status_master.code)
--      rather than a text[] column, because status_master is already the
--      authoritative enum for every other part of this schema and the join
--      table costs little.
--   2. case_holding is NULLABLE at the column level (statutes/Rules/SOPs
--      have no judicial "holding") but a CHECK constraint requires it -
--      along with court/case_number/decision_date - on judgment-type rows
--      (SUPREME_COURT/MADRAS_HIGH_COURT/OTHER_HIGH_COURT). No "N/A" text is
--      ever an acceptable value.
--   3. authority_level is CHECK-constrained to the single value its
--      source_type is allowed to carry, so "SUPREME_COURT + level 5" is a
--      database-level impossibility, not just an application convention.
--   4. verification_state replaces a bare verified_at boolean: DRAFT /
--      DISCOVERED / PRIMARY_SOURCE_VERIFIED / REJECTED_MISMATCH /
--      SUPERSEDED. Only PRIMARY_SOURCE_VERIFIED rows are visible to the
--      ordinary read path - enforced both in RLS (this file) and in the
--      server-side loader (lib/pim-data/legal-sources-read.js), per the
--      explicit "do not rely only on UI filtering" instruction.

-- ============================================================================
-- legal_sources
-- ============================================================================

create table legal_sources (
  id bigint generated always as identity primary key,

  source_type text not null check (source_type in (
    'STATUTE', 'RULE', 'CENTRAL_NOTIFICATION',
    'SUPREME_COURT', 'MADRAS_HIGH_COURT', 'OTHER_HIGH_COURT',
    'TNSLSA_SOP', 'TNSLSA_INSTRUCTION', 'INTERNAL_GUIDANCE'
  )),

  -- Authority level is derived from source_type by definition (see the
  -- design doc's hierarchy, section 8) but stored explicitly so a future
  -- re-classification is an audited data change, not a silent code change.
  -- The CHECK constraint below is the single source of truth binding the
  -- two together - never add a source_type without extending it.
  authority_level smallint not null,

  title text not null,

  -- Judgment-only fields (nullable at the column level; required by the
  -- CHECK constraint below when source_type is a judgment type).
  court text,
  case_number text,
  citation text,
  decision_date date,
  jurisdiction text,

  effective_from date,
  effective_to date,

  -- Hybrid source-document model (design doc section 19): a repo-relative
  -- path for the small, fixed set of foundational documents (Act/Rules/
  -- SOP/instruction letter); source_url/primary_source_url for everything
  -- else, especially case law, which is not duplicated into Storage here.
  source_document_ref text,
  source_url text,
  primary_source_url text,

  paragraph_refs text,
  rule_refs text,
  sop_clause_refs text,

  topics text[] not null default '{}',

  -- Case holding vs. operational proposition vs. negative rule are kept as
  -- separate columns deliberately (design doc section 2's rationale,
  -- reaffirmed by the verification-pass brief's item 8/9) - never collapse
  -- these into one summary field. case_holding is what the court actually
  -- decided, narrowly; operational_proposition is the practically-usable
  -- PIM rule, phrased so it is never broader than case_holding supports;
  -- negative_rule is an explicit "do not require/do not treat as X"
  -- constraint, promoted to its own column because it is a first-class
  -- guidance category, not an afterthought.
  case_holding text,
  operational_proposition text,
  negative_rule text,
  operational_effect text,
  caution text,

  treatment text check (treatment in (
    'FOLLOWED', 'DISTINGUISHED', 'OVERRULED', 'PARTLY_OVERRULED',
    'CLARIFIED', 'SUPERSEDED_BY_STATUTE', 'SUPERSEDED_BY_RULE'
  )),
  superseded_by bigint references legal_sources (id),

  verification_state text not null default 'DRAFT' check (verification_state in (
    'DRAFT',                  -- entered, not yet researched at all
    'DISCOVERED',             -- a matching primary-source record located,
                               -- not yet read/confirmed against the
                               -- proposition it was proposed for
    'PRIMARY_SOURCE_VERIFIED',-- full primary text read; case_holding AND
                               -- operational_proposition both confirmed
    'REJECTED_MISMATCH',      -- a real source exists under this
                               -- description, but it does not support the
                               -- proposition - kept, not deleted, so the
                               -- same dead end is never re-researched
    'SUPERSEDED'               -- was PRIMARY_SOURCE_VERIFIED, now replaced;
                               -- see superseded_by / is_active
  )),
  -- Restates, at verification time, exactly which proposition this source
  -- was checked against - guards against the source later being reused for
  -- a DIFFERENT proposition it was never actually verified for. If
  -- operational_proposition is later edited to cover a broader claim than
  -- verified_proposition records, that mismatch is a signal a
  -- MANAGE_LEGAL_SOURCES reviewer should re-verify before the edit ships.
  verified_proposition text,
  verification_notes text,
  verification_date date,
  verified_by bigint references users (id),

  is_active boolean not null default true,

  created_by bigint references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Authority-level integrity: a source_type can carry exactly one
  -- authority_level (design doc section 8's hierarchy). This makes
  -- "SUPREME_COURT + authority_level 5" or "OTHER_HIGH_COURT + level 2" a
  -- constraint violation, not merely an application-level convention.
  constraint legal_sources_authority_level_matches_type check (
    (source_type in ('STATUTE', 'RULE', 'CENTRAL_NOTIFICATION') and authority_level = 1)
    or (source_type = 'SUPREME_COURT' and authority_level = 2)
    or (source_type = 'MADRAS_HIGH_COURT' and authority_level = 3)
    or (source_type in ('TNSLSA_SOP', 'TNSLSA_INSTRUCTION') and authority_level = 4)
    or (source_type = 'OTHER_HIGH_COURT' and authority_level = 5)
    or (source_type = 'INTERNAL_GUIDANCE' and authority_level = 6)
  ),

  -- Judgment rows require judgment metadata; case_holding is required only
  -- for judgment source_types. Never satisfied with placeholder/"N/A" text -
  -- that is a review-time convention enforced by MANAGE_LEGAL_SOURCES, not
  -- something this constraint can check, but the constraint at least
  -- guarantees the fields are not silently left NULL for a judgment row.
  constraint legal_sources_judgment_metadata_required check (
    source_type not in ('SUPREME_COURT', 'MADRAS_HIGH_COURT', 'OTHER_HIGH_COURT')
    or (court is not null and case_number is not null and decision_date is not null and case_holding is not null)
  ),

  -- A REJECTED_MISMATCH row's entire purpose is the research trail - never
  -- allow one to carry an empty explanation.
  constraint legal_sources_rejected_requires_notes check (
    verification_state <> 'REJECTED_MISMATCH' or verification_notes is not null
  )
);

create index idx_legal_sources_type on legal_sources (source_type);
create index idx_legal_sources_state on legal_sources (verification_state);
create index idx_legal_sources_active on legal_sources (is_active);
create index idx_legal_sources_topics on legal_sources using gin (topics);

-- Full-text search preparation (design doc section 16): no embeddings, no
-- vector DB - plain Postgres full-text search over the staff-facing text
-- fields. Generated column kept narrow (title + case_holding +
-- operational_proposition + negative_rule), matching the verification
-- brief's item 18 list exactly.
alter table legal_sources
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(case_holding, '')), 'B')
    || setweight(to_tsvector('english', coalesce(operational_proposition, '')), 'B')
    || setweight(to_tsvector('english', coalesce(negative_rule, '')), 'C')
  ) stored;

create index idx_legal_sources_search on legal_sources using gin (search_vector);

-- ============================================================================
-- legal_source_workflow_stages (normalized, per LK-2 item 4)
-- ============================================================================

create table legal_source_workflow_stages (
  legal_source_id bigint not null references legal_sources (id) on delete cascade,
  status_code text not null references status_master (code),
  primary key (legal_source_id, status_code)
);

create index idx_legal_source_workflow_stages_status on legal_source_workflow_stages (status_code);

-- ============================================================================
-- legal_guidance_rules
-- ============================================================================

create table legal_guidance_rules (
  id bigint generated always as identity primary key,
  guidance_key text not null unique,
  title text not null,

  -- trigger_condition is a controlled, application-side KEY (e.g.
  -- 'APPLICANT_FEE_UNPAID_OP_PAID', 'INTAKE_PLAINT_COPY_DEMANDED') - never
  -- executable JavaScript/SQL. The application code owns a fixed, reviewed
  -- lookup mapping each key to the actual case-state check, mirroring the
  -- safeguard already proven in lib/pim-nonstarter.js's
  -- AUTO_TRIGGERED_REASON_CODES / inferNonStarterContext. Admins can add or
  -- edit guidance TEXT and SOURCE LINKS freely; a new trigger_condition
  -- requires a code change and review.
  trigger_condition text not null,

  severity text not null check (severity in ('HARD_BLOCK', 'WARNING', 'INFORMATION', 'REFERENCE_ONLY')),
  summary text not null,
  staff_action text,
  do_not_do text,

  effective_from date,
  effective_to date,
  is_active boolean not null default true,

  created_by bigint references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_legal_guidance_rules_severity on legal_guidance_rules (severity);
create index idx_legal_guidance_rules_active on legal_guidance_rules (is_active);

alter table legal_guidance_rules
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(summary, '')), 'B')
    || setweight(to_tsvector('english', coalesce(do_not_do, '')), 'C')
  ) stored;

create index idx_legal_guidance_rules_search on legal_guidance_rules using gin (search_vector);

-- ============================================================================
-- legal_guidance_rule_stages (normalized trigger stage(s))
-- ============================================================================
-- A guidance rule's trigger_stage is normalized into its own join table,
-- not a single column, because a rule may genuinely apply at more than one
-- stage (e.g. NO_PLAINT_COPY_REQUIRED applies at both RECEIVED and
-- SCRUTINY_PENDING - see the lk2 seed). FK'd to status_master.code for the
-- same referential-integrity reason as legal_source_workflow_stages.

create table legal_guidance_rule_stages (
  guidance_rule_id bigint not null references legal_guidance_rules (id) on delete cascade,
  status_code text not null references status_master (code),
  primary key (guidance_rule_id, status_code)
);

create index idx_legal_guidance_rule_stages_status on legal_guidance_rule_stages (status_code);

-- ============================================================================
-- legal_guidance_rule_sources
-- ============================================================================
-- Separates SOURCE from GUIDANCE RULE (design doc section 10 / brief's own
-- section 7): one judgment can support multiple contextual rules, and a
-- guidance rule can cite multiple sources. ON DELETE RESTRICT on
-- legal_source_id - a cited source must be explicitly superseded/deactivated
-- (never silently deleted) while a guidance rule still cites it.

create table legal_guidance_rule_sources (
  guidance_rule_id bigint not null references legal_guidance_rules (id) on delete cascade,
  legal_source_id bigint not null references legal_sources (id) on delete restrict,
  primary key (guidance_rule_id, legal_source_id)
);

create index idx_legal_guidance_rule_sources_source on legal_guidance_rule_sources (legal_source_id);

-- ============================================================================
-- RLS - same default-deny-then-explicit-policy pattern as every other PIM
-- table (see 20260917020800_enable_rls_default_deny.sql /
-- 20260917040000_pim_rls_policies.sql). Reads in this application currently
-- go through a privileged direct connection (lib/pim-postgres.js) that
-- bypasses RLS, same as every other table - RLS here is defense in depth
-- for a future Supabase-Auth-scoped read path, not the only enforcement
-- layer. The ACTUAL server-side enforcement for "only
-- PRIMARY_SOURCE_VERIFIED is visible to ordinary staff" lives in the query
-- itself (lib/pim-data/legal-sources-read.js), per the explicit instruction
-- not to rely on UI filtering alone - this policy is the second,
-- independent layer, not a substitute for that loader.
-- ============================================================================

alter table legal_sources enable row level security;
alter table legal_source_workflow_stages enable row level security;
alter table legal_guidance_rules enable row level security;
alter table legal_guidance_rule_stages enable row level security;
alter table legal_guidance_rule_sources enable row level security;

-- READ_LEGAL_LIBRARY: all four roles (aa/secretary/chairman/admin), same
-- broad grant as READ_CASE - but structurally restricted to active,
-- PRIMARY_SOURCE_VERIFIED rows only. DRAFT / DISCOVERED / REJECTED_MISMATCH
-- / SUPERSEDED rows are never selectable through this policy, for any role
-- including admin - admin's broader access (MANAGE_LEGAL_SOURCES) is a
-- server-side, service-role-connection capability (same pattern as every
-- PIM write today), not a wider RLS SELECT policy, so there is no
-- authenticated-role path to a non-verified row at all.
drop policy if exists pim_read_verified_legal_sources on legal_sources;
create policy pim_read_verified_legal_sources
  on legal_sources for select
  to authenticated
  using (
    public.current_pim_role() is not null
    and verification_state = 'PRIMARY_SOURCE_VERIFIED'
    and is_active = true
  );

drop policy if exists pim_read_legal_source_workflow_stages on legal_source_workflow_stages;
create policy pim_read_legal_source_workflow_stages
  on legal_source_workflow_stages for select
  to authenticated
  using (
    public.current_pim_role() is not null
    and exists (
      select 1 from legal_sources s
      where s.id = legal_source_workflow_stages.legal_source_id
        and s.verification_state = 'PRIMARY_SOURCE_VERIFIED'
        and s.is_active = true
    )
  );

drop policy if exists pim_read_active_legal_guidance_rules on legal_guidance_rules;
create policy pim_read_active_legal_guidance_rules
  on legal_guidance_rules for select
  to authenticated
  using (
    public.current_pim_role() is not null
    and is_active = true
  );

drop policy if exists pim_read_legal_guidance_rule_stages on legal_guidance_rule_stages;
create policy pim_read_legal_guidance_rule_stages
  on legal_guidance_rule_stages for select
  to authenticated
  using (
    public.current_pim_role() is not null
    and exists (
      select 1 from legal_guidance_rules g
      where g.id = legal_guidance_rule_stages.guidance_rule_id
        and g.is_active = true
    )
  );

drop policy if exists pim_read_legal_guidance_rule_sources on legal_guidance_rule_sources;
create policy pim_read_legal_guidance_rule_sources
  on legal_guidance_rule_sources for select
  to authenticated
  using (
    public.current_pim_role() is not null
    and exists (
      select 1 from legal_guidance_rules g
      where g.id = legal_guidance_rule_sources.guidance_rule_id
        and g.is_active = true
    )
    and exists (
      select 1 from legal_sources s
      where s.id = legal_guidance_rule_sources.legal_source_id
        and s.verification_state = 'PRIMARY_SOURCE_VERIFIED'
        and s.is_active = true
    )
  );

-- No INSERT/UPDATE/DELETE policy for authenticated/anon on any of the five
-- tables above - identical reasoning to every other PIM table (see the
-- header comment in 20260917040000_pim_rls_policies.sql): writes, including
-- verification-state transitions, belong in a server-side transaction that
-- also writes audit_log in the same commit (lib/pim-data/legal-sources-admin.js),
-- never as a direct client-side RLS-gated write.
