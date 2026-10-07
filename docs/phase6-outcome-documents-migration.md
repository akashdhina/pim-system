# Outcome Documents (Form IV / Form V) — PostgreSQL Port

Status: **code-complete, tested (8/8)**. 2026-10-07, production-completion sprint.

## The real gap this closes

`app/api/pim/outcome/approve/[id]/route.js` (ported earlier the same day,
see `docs/phase6-outcome-closure-migration.md`) requires a current Form IV
(SETTLED) or Form V (FAILED) document to already exist before a case can
close. But `app/api/pim/documents/outcome/[id]/route.js` — the route that
*generates* that document — had no PostgreSQL module at all and was still
writing an actual `.docx` file to local disk via SQLite
(`lib/pim-document.js`'s `generateOutcomeDocument`, reading/writing
`lib/db.js`). A Postgres-authoritative case reaching `OUTCOME_FORM_PENDING`
had **no way to generate the document its own closure gate required** —
not a cleanup item, a genuine dead end in the critical path.

## The fix: reuse Batch 5I's no-storage model, not a new one

`lib/pim-data/outcome-documents.js` follows the exact pattern
`lib/pim-data/form2.js` already established for Form-2: generation
resolves `render_data` (a label→value object) **once** and stores it in
`pim_documents.render_data` (jsonb) with `file_path` always `NULL`. No
DOCX buffer is produced and no file is ever written to local disk at
generation time — rendering is deferred entirely to download, re-created
fresh from the frozen `render_data` snapshot every time. This is
deliberate (a shared local filesystem can't be relied on across
instances), not a shortcut — continued from Batch 5I's decision, not
re-decided here.

`renderOutcomeTemplate` (`lib/pim-document.js`) — the regex-based
XML-label-replacement renderer already used by the SQLite path — is reused
unchanged: it's a pure function (template path + label→value object in, a
DOCX buffer out) with no database coupling, so it works identically
against PostgreSQL-sourced `render_data`.

`generateOutcomeDocumentTx` mirrors `lib/pim-document.js`'s
`generateOutcomeDocument`/`getOutcomeDocumentData` field-for-field: same
required facts (primary applicant, primary opposite party, active
mediator assignment, at least one completed session), same render-value
labels, same generation-allowed window (`OUTCOME_FORM_PENDING` **or** the
outcome's own closed status — generation must work both before and after
closure, matching the existing "Phase 8" invariant that a case must be
able to generate its required document before it can ever close, and
regeneration must remain possible afterward).

## Two real bugs found while testing, both fixed in production code

1. **Missing export.** `renderOutcomeTemplate` existed in
   `lib/pim-document.js` but was never added to `module.exports` (only
   `getOutcomeDocumentType` was). Fixed by adding it alongside the other
   Batch 5I pure-function exports.
2. **A genuine model conflict in `approveOutcomeTx`.** Its closure gate
   (`lib/pim-data/outcome.js`) checked `currentDocument.file_path`
   truthiness as proof a document had been generated — correct for the
   old local-file model, but outcome documents generated through this
   new Postgres path *never* set `file_path` by design. Left unfixed,
   every real Postgres SETTLED/FAILED case would generate its document
   successfully and then be wrongly blocked from closing. Fixed by
   widening the check to accept **either** `file_path` **or**
   `render_data` as proof of generation — verified with a full
   generate → approve → regenerate-after-closure cycle, and confirmed no
   regression against the earlier outcome/closure suite (still 10/10,
   since its fixtures use `file_path`-bearing rows).

## Verified (`scripts/test-pim-outcome-documents-postgres.js`, 8/8 passing)

Real Form-4 DOCX generated with `file_path = NULL` and `render_data`
populated; the downloaded buffer is a genuine non-empty DOCX (verified by
its `PK` zip-magic-number header, not just "no error"); regeneration
without the flag reuses the same document id; `regenerate: true` creates
a new current version and retires the previous one; generation before any
outcome exists, and for `NON_STARTER`/`WITHDRAWN`, is rejected; generation
and approval both still work in sequence after closure (regeneration
path); download returns `null` (not a throw) for a document id that
belongs to a different case.

## Also found this session, no work needed

While auditing the surrounding routes before this batch, three items the
original sprint audit flagged as SQLite-authoritative turned out to
already be fully PostgreSQL-wired — the audit had seen a leftover
`require("lib/db")` kept only as an inert rollback reference (same
convention used throughout this migration) without checking which
function the live route actually calls:

- Form II issue (`app/api/pim/form2/issue/[id]/route.js` →
  `issueForm2NoticePg`).
- Address correction (`app/api/pim/address-correction/[id]/route.js` →
  `recordCorrectedAddressPg`/`recordNoCorrectedAddressPg`).
- The task list route (`app/api/pim/tasks/route.js` → `getPimTasksPg`;
  there is no separate task-write route at all — task mutations happen
  inline inside each workflow's own transaction, all of which this
  sprint has now ported).
