# PIM Controlled Pilot — Operational Checklist

This checklist is for DLSA Nilgiris staff entering or importing genuine PIM
cases during the controlled pilot. The physical PIM file/register remains
authoritative — this system supports it, it does not replace it.

## Before entering or importing a case

- [ ] Confirm the physical case file is in hand.
- [ ] Confirm the PIM number (or received number, if PIM number not yet
      assigned) matches the physical register exactly.
- [ ] Confirm the names of all applicants and all opposite parties as they
      appear on the physical file — including every opposite party in a
      multi-OP case, not just OP1.
- [ ] Confirm the current stage of the case as shown by the physical file
      (e.g. notice pending, service pending, mediator assigned, mediation
      ongoing, closed).

## Using Legacy Case Import (`/pim/import`) for historical/in-progress cases

- [ ] Use **Legacy Case Import**, not "New PIM Case", for any case that is
      already in progress or already closed on paper. "New PIM Case" is for
      matters genuinely being instituted today.
- [ ] Fill in only the dates/fields the physical file actually shows. Leave
      anything not yet known blank — do not guess a date to fill a field.
- [ ] Click **Review Before Import** before confirming. The review screen
      shows the PIM number that will be assigned, the current status, the
      pending task that will be created, all parties, and any warnings
      (e.g. a duplicate party name, a mediator that looks inactive, or a
      terminal outcome with no form number recorded). Nothing is saved at
      this step.
- [ ] Read every warning. A warning does not block the import — it is a
      prompt to double-check the physical file before proceeding.
- [ ] Click **Confirm & Import** only after the review matches the physical
      file.

## After entry/import

- [ ] Open the case summary page and compare it line-by-line against the
      physical file: PIM number, dates, parties, claim amount, current
      status, mediator (if any).
- [ ] Confirm the **Next Action** / pending task shown is the correct next
      step for this case — it should never be blank for a case that is
      genuinely still active, and it should be blank (with no action
      button) for a case that is genuinely closed.
- [ ] If a document (Form II/III/IV/V) was generated, confirm it appears
      under **Documents** and opens correctly. If a physical Form exists
      but has not been digitized, that is expected — do not regenerate a
      historical document to "fill the gap"; digitizing it later is a
      separate, deliberate archival task.
- [ ] Confirm the case appears in the PIM Register and in any other report
      that it should appear in given its stage (e.g. a closed non-starter
      case should appear in the Non-Starter Report, not in Settlement or
      Failure).

## At the end of the day

- [ ] Confirm a backup has run (`node scripts/backup-sqlite.js` or the
      scheduled equivalent) and check it reports a non-zero file size and
      `Integrity: SUCCESS`.
- [ ] Review the **Pending Action Report** for anything overdue.
- [ ] Review the **Data Integrity Warnings** shown on any case you touched
      today, and on `node scripts/audit-production-readiness.js` if you
      have access to run it. Zero CRITICAL/HIGH findings is expected —
      anything above zero should be looked into before the next working
      day, not silently cleared.

## What never to do during the pilot

- Do not delete a genuine case to "start over" — if an entry was made in
  error, flag it for a deliberate correction instead.
- Do not renumber a genuine PIM case.
- Do not fabricate a notice, service attempt, mediation sitting, or outcome
  that the physical file does not actually show.
- Do not regenerate a historical document and present it as the original.
- Do not close an active genuine case, or reopen a closed genuine case,
  for testing purposes. All workflow testing belongs on a scratch database
  (`PIM_DB_PATH` pointed at a test file), never on the live system.
