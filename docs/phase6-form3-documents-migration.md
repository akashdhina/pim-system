# Form-3 (Non-Starter Report) Document — PostgreSQL Port

Status: **code-complete, tested (8/8)**. 2026-10-07, production-completion sprint.

## What this closes

`app/api/pim/documents/form3/[id]/route.js` had no PostgreSQL module at
all and was still writing an actual `.docx` file to local disk via
SQLite. `lib/pim-data/nonstarter.js`'s `completeNonStarterForm3Pg`
(migrated earlier the same day — see
`docs/phase6-nonstarter-completion-migration.md`) requires a current
`FORM_3` document to already exist before it can be called. Together
with the Form IV/V gap closed just before this one
(`docs/phase6-outcome-documents-migration.md`), this was the last
remaining document-generation hole in the critical path: every terminal
outcome (SETTLED, FAILED, NON_STARTER) now has a real way to produce its
required document against PostgreSQL.

## The fix: same no-storage model as Form IV/V and Form-2

`lib/pim-data/form3-documents.js` follows the identical pattern. A new
pure renderer, `renderForm3Template` (added to `lib/pim-document.js`,
extracted from the SQLite route's inline Docxtemplater call — same
`{{field}}` delimiter configuration), is reused unchanged. Generation
resolves a flat render-values object once
(`applicant_name`, `application_date`, `opposite_party_name`,
`appearance_date`, `rule_reference`, `nonstarter_reason`, `outcome_date`)
and stores it in `pim_documents.render_data` — `file_path` always `NULL`.
Download re-renders from that frozen snapshot.

`generateForm3DocumentTx` mirrors `lib/pim-document.js`'s
`generateForm3`/`getForm3Data` field-for-field: `ruleReference` must be
exactly `3(4)` or `3(6)`; generation is only allowed from
`CLOSED_NON_STARTER`, `OUTCOME_FORM_PENDING`, or
`AUTHORITY_DECISION_PENDING` (the same three statuses the SQLite original
allows); the same required facts (primary applicant, primary opposite
party, a Form-2 notice on record for its appearance date) are enforced
with the same error messages.

## Verified (`scripts/test-pim-form3-documents-postgres.js`, 8/8 passing)

A real Form-3 DOCX generated with `file_path = NULL` and `render_data`
populated, verified as a genuine non-empty DOCX by its zip-magic-number
header; invalid/missing rule reference rejected before any write;
regeneration creates a new current version and retires the previous one;
generation outside the allowed status window is rejected; and — the one
that actually proves the gap is closed, not just that generation
"succeeds" — an **end-to-end test** that generates a real document and
then calls `completeNonStarterForm3Pg` with it, successfully closing the
case as `CLOSED_NON_STARTER`, exactly the real production sequence.

## Document generation: now fully closed

With this batch, every PIMS form the operational lifecycle requires has
a working PostgreSQL generation path:

- **Form 2** (Initial and Final Notice) — `lib/pim-data/form2.js`,
  Batch 5I. Final Notice is the *same* generator (`notice_type =
  'FORM_2_FINAL'`), not a separate document type — confirmed by
  inspection, no additional work needed.
- **Form 3** (Non-Starter Report) — this batch.
- **Form 4 / Form 5** (Settlement / Failure Report) — the batch
  immediately before this one.

All three follow the same no-storage, render-on-demand model; none of
them write to local disk or any object storage.
