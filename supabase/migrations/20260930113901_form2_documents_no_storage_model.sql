-- Phase 6 Batch 5I: no-Storage Form II document model.
--
-- file_path becomes nullable: a PostgreSQL-generated document is never
-- written to a permanent file (no Supabase Storage, no local filesystem
-- persistence) - file_path stays NULL for every row this batch's code
-- writes, never a fabricated path.
--
-- render_data (jsonb) freezes the exact template values resolved at
-- Generate time. Download re-renders the DOCX buffer on demand solely
-- from this snapshot, never from current (possibly since-changed) live
-- party/case/address data, so a historical version always reproduces
-- the same content it had when generated.
--
-- Already applied live to this project (qqjmmxfvfrrzxirxtgtc) via
-- apply_migration on 2026-09-30 (name: form2_documents_no_storage_model,
-- version 20260930113901) before this file was committed to the repo;
-- this file documents that already-applied state so a fresh clone / a
-- local dev database can reach the same schema. Re-running it is safe
-- (idempotent: DROP NOT NULL on an already-nullable column and
-- ADD COLUMN IF NOT EXISTS are both no-ops on a second run).

alter table pim_documents
  alter column file_path drop not null;

alter table pim_documents
  add column if not exists render_data jsonb;
