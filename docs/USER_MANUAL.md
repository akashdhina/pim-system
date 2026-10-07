# PIM System — User Manual for Staff

District Legal Services Authority, Nilgiris
Pre-Institution Mediation (Commercial Courts (Pre-Institution Mediation and
Settlement) Rules, 2018)

This manual explains how to use the PIM case management system for daily
work. **The physical PIM file and register remain the authoritative
record.** This system exists to make that file easier to track, act on, and
report from — never to replace it or to be "corrected" to make a report
look tidier than the paper file actually is.

A short in-app quick-reference is also available at **Help** in the top
navigation once logged in; this document is the full walkthrough.

---

## 1. Signing In

Go to the PIM system's login page and sign in with the username and
password issued to you. If you were given a **temporary password**, you
will be required to set a new one before you can do anything else — choose
a password of at least 10 characters that is not a common/weak password.

### Portal Access

**Portal URL:** http://192.168.1.13:3000/pim

**Current login IDs:**

| Login ID | Assigned to |
|---|---|
| `janani` | LADCS Staff |
| `dhinagaran` | Administrative Assistant |
| `secretary` | Secretary, DLSA |
| `admin` | System Administrator |

Temporary passwords are issued separately. Users must change the temporary
password on first login. Passwords are never written down in this manual —
if you do not know yours, ask the admin.

**DEO / Janani currently uses AA-level permissions in the system.** This
means Janani can perform data-entry and day-to-day workflow actions
permitted to the AA role (see the roles table below) — no more, no less.

### Roles

The system recognises four roles. What you can see and do depends on your
role:

| Role | Typical user | Can do |
|---|---|---|
| `aa` | Administrative Assistant | Day-to-day data entry: enter new applications, scrutiny, issue notices, record service/response/fee, record mediation sessions, record outcomes, generate/download documents |
| `secretary` | Secretary, DLSA | Everything `aa` can do, **plus** approve registration, import legacy/historical cases, assign mediators, verify and approve outcomes, view audit trail, manage backups |
| `chairman` | Chairman, DLSA | Read-only case/report access, plus approving non-starter authority decisions and outcome approvals |
| `admin` | System administrator | Everything, plus user management, settings, backup restore, password resets |

If a menu item or button is missing, it is almost always because your role
does not have that permission — this is expected, not an error.

---

## 2. First Day Checklist for Staff

Use this one-page checklist on your first day, and again for any new
staff member who joins the pilot. Do the steps in order — do not skip
ahead to bulk data entry.

**Sign in**

- [ ] Open the portal URL from the staff computer.
- [ ] Sign in with the assigned login ID.
- [ ] Change temporary password if prompted.
- [ ] Confirm the dashboard opens.

**First test entries — do these before anything else**

- [ ] Enter one legacy case from a physical file (see §14, "Example:
      Entering the First Legacy Case").
- [ ] Search and open the imported legacy case.
- [ ] Verify parties, dates, PIM number, stage, pending task, and warnings.
- [ ] Enter one new Form-1 case (see §4, "Example: Entering the First New
      Case").
- [ ] Confirm it appears in scrutiny/pending tasks.
- [ ] Generate or verify documents only when supported by the physical
      file.
- [ ] Do not enter bulk data until the first two test entries are checked
      by Secretary/admin.

**End of day**

- [ ] Check backup status in Settings → Backups (see §17).

---

## 3. Dashboard

The Dashboard (`/pim`) is the home screen after login. It shows, at a
glance:

- Total open/closed case counts and a breakdown by stage (scrutiny
  pending, notice pending, service pending, fee pending, mediator
  assignment, mediation ongoing, outcome pending, and so on).
- Pending and overdue task counts.
- Cases approaching or past their internal 60-day monitoring date.
- Mediator panel summary and any mediators whose empanelment is expiring.
- A short list of recent cases, recently closed cases, tasks due today,
  overdue tasks, and today's mediation sittings.

Use it as your starting point each day, then drill into a specific case or
task list from there.

---

## 4. Entering a New Case (Form-1)

Use **New Application** (`/pim/new`) only for a matter that is genuinely
being filed today. If the matter is already in progress or already closed
on paper, use **Legacy Case Import** instead (§14) — do not force a new
case through every workflow screen just to reach today's actual stage.

You will need, from the physical Form-1 application:

- Received number and received date; application date.
- Claim amount and a short dispute description.
- Application fee details: the DD number, DD date, bank name, and the DD
  must be drawn in favour of **"Chairman, DLSA"** for exactly **₹1,000**.
- Every applicant and every opposite party — name, entity type, contact
  details, and address. Enter **all** opposite parties, not just the
  first, if the case names more than one.

Submitting creates the case at status **Received** with a pending
**Scrutiny** task.

### Example: Entering the First New Case

1. Open **New Application**.
2. Use it only for a genuinely fresh Form-1 filing.
3. Enter received number, received date, and application date.
4. Enter claim amount and dispute description.
5. Enter application fee/DD details.
6. Add every applicant and every opposite party.
7. Check the postal address carefully, because notice generation depends
   on it.
8. Submit.
9. Confirm the case appears as **RECEIVED / SCRUTINY_PENDING**.
10. Open the case summary and verify the pending scrutiny task.

**Warning:** If the file already has a previous PIM number, prior notice,
prior mediation sitting, or outcome on paper, do not enter it as a new
case. Use **Legacy Import** (§14).

---

## 5. Scrutiny

Open the case (from Pending Tasks or the case file) and use **Complete
Scrutiny**. Record:

- Application fee verification (DD correctness, payee, amount).
- Vakalatnama availability.
- Opposite party address availability.
- Whether the dispute is a genuine commercial dispute.
- Territorial jurisdiction check.
- Supporting documents check.

If everything is in order, scrutiny completes and the case moves to
**Secretary Approval Pending**. If a defect is found, the case is held for
rectification instead — do not approve a defective file to "keep the
queue moving."

---

## 6. Secretary Approval & PIM Registration

Only **secretary** and **admin** roles can approve registration. Once
approved, the system assigns the **PIM number** for the year
(`PIM/<year>/<sequence>`) and the case moves to **Form-2 Pending**. The
next PIM number is always computed from existing records at the moment of
approval — it cannot collide with or run backwards past a number already
issued, including numbers brought in through Legacy Case Import.

---

## 7. Notice (Form II)

### Initial notice

From **Prepare Form-2**, the system generates the Initial Form II notice
for an opposite party (one at a time in a multi-OP case — each OP gets
their own notice and their own service record). After preparation, **issue**
the notice to record dispatch.

### Recording service

Use **Record Service** to capture what actually happened to that specific
notice:

- Dispatch mode, postal receipt/tracking number.
- **Delivered** (with date) — if the OP received it, service is complete
  and the case moves to await the OP's response.
- **Returned**, with the exact reason as endorsed by the postal
  authority: *Addressee left*, *Insufficient address*, *Unclaimed*,
  *Refused by addressee*, or *Other* (remarks required for Other).

A **postal refusal** (*Refused by addressee* on the cover) is not the same
thing as the opposite party formally refusing to mediate later in the
process — the system keeps these separate on purpose. Do not record one as
the other.

### Returned notice → address correction

If a notice comes back, the case moves to **Address Correction Pending**
with a task to obtain a corrected address. Once a corrected address is
available, a **fresh Initial notice** is issued to that address (a new
version, not an edit of the old one — the original returned notice and its
service history are preserved, never deleted).

If no corrected address can be obtained, or the case reaches the end of
that road, it proceeds to the **Final Notice**.

### Final notice

Prepared and issued the same way as the Initial notice, but as a distinct
**Final Form II** — the system never mixes Initial and Final notice text,
and both remain visible in the case's document and notice history
afterward.

---

## 8. Opposite Party Response

Use **Record OP Response** to capture what the opposite party actually did
on their appearance date:

- **Appeared and consented** to mediation → the case moves toward the
  mediation fee stage.
- **Appeared and refused** to mediate → the case is handed off toward a
  non-starter outcome (§12).
- **Sought time** → an alternate appearance date is recorded (must be
  within 10 days of the request); the case waits for that date.
- **Did not appear** → after the appearance date passes, recorded as a
  non-response, also headed toward non-starter.

In a multi-OP case, each opposite party's response is recorded and tracked
against **that** OP and **that** OP's notice — one OP's refusal does not
overwrite another OP's pending status.

---

## 9. Mediation Fee

Under Rule 11, the mediation fee is a **single, case-level obligation**
(not split per party, even though the parties share it 50/50 in practice).
Use **Record Fee** to log a payment. Partial payments accumulate — a
second payment adds to what was already received, it never replaces it.
Once the cumulative amount received meets the statutory slab amount due,
the case moves to mediator assignment.

The **Application Fee** (the ₹1,000 DD from the original filing, §4) is a
completely separate fee and is never combined with, or allowed to
substitute for, the mediation fee.

---

## 10. Mediator Assignment

Only **secretary** and **admin** can assign a mediator. Choose from the
active panel; the system shows the suggested rotation order and flags if
you are deviating from it (a reason can be recorded). A case has exactly
one **active** mediator assignment at a time.

**Reassignment**: if a mediator must be changed mid-case, use the
reassignment action rather than editing history. The old assignment is
preserved and marked ended — sittings that already happened stay
attributed to the mediator who actually conducted them; only sittings from
the reassignment date forward belong to the new mediator.

---

## 11. Mediation Sessions

- **Fix First Mediation** records the date of sitting #1 once a mediator
  is assigned.
- **Record Sitting** logs each session: whether the applicant and
  opposite party were present, start/end time (duration is computed
  automatically), and whether the sitting was **effective** (both parties
  present and mediation actually took place) or **ineffective**. An
  ineffective sitting's time is never counted toward the cumulative
  mediation duration shown on the case.
- Each sitting records a **next action**: further mediation needed, ready
  for settlement, or ready for failure. This is what routes the case
  toward the next screen — the system does not guess it from free-text
  remarks.
- The system will show you the cumulative effective mediation time so far.
  It does **not** automatically fail a case at any duration threshold —
  that decision is always a deliberate staff action.

---

## 12. Recording the Outcome

### Settlement (Form IV)

Record the settlement terms, then generate Form IV. The case cannot be
closed as settled until Form IV has actually been generated — this is
deliberate, so a case is never marked closed with no settlement document
behind it.

### Failure (Form V)

Record the reason mediation failed, then generate Form V, same rule as
above: the closure and the document go together.

### Non-Starter (Form III)

Used when mediation never got underway — e.g. final notice unacknowledged,
opposite party refused mediation, opposite party failed to appear after
seeking time, both parties unwilling, or mediation fee never submitted.
Select the actual reason from the list; some reasons require the
**Chairman's** authority decision before the case can close (the system
tells you which).

### Withdrawal

Recorded with a reason when the applicant withdraws before an outcome is
reached.

Whichever outcome applies, once the case is closed the system will not
offer a further "next action" button on it, and it should have no pending
tasks left. If you ever see a closed case with a leftover pending task or
a missing outcome document, that is a data-integrity problem to raise, not
something to click through.

---

## 13. Reading a Case — the Case Summary Page

Open any case (from Cases, a task, or search) to see everything about it
on one screen: header (PIM number, dates, claim, parties, current
mediator), the current pending action, a consolidated chronological
timeline built from the real case record, notices with their service
history, all opposite parties (not just the first), the fee position
(due/received/balance), full mediator assignment history, every mediation
sitting, the outcome, and **every version of every document** — old
versions are kept and clearly marked superseded, never hidden.

Watch for the amber **Data Integrity Warnings** box near the top of the
page. It surfaces things like: a closed case still carrying a pending
task, a settled/failed/non-starter case missing its Form IV/V/III, more
than one active mediator assignment, or a notice with no current document
on file. These are read-only flags for staff attention — the system never
auto-corrects them.

---

## 14. Legacy Case Import — Bringing In Historical / In-Progress Cases

**This section is central to the pilot.** Most cases entered during the
controlled pilot are historical or already-in-progress paper files, not
new filings — read this section carefully before importing your first
case.

Use **Legacy Case Import** (secretary/admin only) for any case that is
already partway through its life, or already closed, on paper — this is
how the physical register gets reflected in the system without pretending
the case started today.

1. Choose the **stage** that matches where the physical file actually is
   right now (received, scrutiny pending, form-2 pending, mediation
   ongoing, closed-settled, and so on).
2. Enter only the dates the physical file actually shows for the stages up
   to and including that point. Leave anything not yet known blank — never
   guess a date to complete the form.
3. Click **Review Before Import**. Nothing is saved yet. The review screen
   shows the PIM number that will be assigned, the resulting status and
   pending task, every party, the mediator (if any), the outcome (if any),
   and any warnings — for example a duplicate party name, a mediator that
   looks inactive, or a closure with no form number recorded.
4. Read the warnings, check them against the physical file, and only then
   click **Confirm & Import**.

The importer reconstructs exactly the workflow history implied by the
dates you gave it — it never invents an intermediate step you didn't
supply, and it will refuse to create a case whose PIM number or received
number already exists.

If a form (e.g. Form III) exists physically but has never been digitized,
say so and leave it undigitized — do **not** generate today's version of a
form and present it as the historical original. Digitizing an old document
later is a deliberate, separate task, not something to do automatically to
make a report look complete.

### Example: Entering the First Legacy Case

Legacy import is for cases already existing in paper records, including
cases already part-way through or already closed.

1. Open **Legacy Import**.
2. Select the stage matching the physical file, not the stage staff wish
   it had reached.
3. Enter the old PIM number/received number if available.
4. Enter only dates actually found in the physical file.
5. Add all applicants and all opposite parties.
6. Add mediator/outcome/service/fee details only if the paper file shows
   them.
7. Leave unknown fields blank rather than guessing.
8. Use **Review Before Import**.
9. Read warnings carefully.
10. Confirm import only after checking against the physical file.
11. Open the imported case summary and verify the timeline, parties,
    pending task, and documents section.

**Warning:** Never generate today's Form II/Form III/Form IV/Form V to
replace a historical document that was never digitized. Mark it as
missing/undigitized and handle archival digitization separately.

See also `docs/PILOT_CHECKLIST.md` for the day-to-day pilot checklist that
walks through this same flow operationally.

---

## 15. Documents

Every generated Form II/III/IV/V (and withdrawal record) is kept, with
every version. The current version is clearly marked; older versions stay
available and are never deleted or silently replaced. Use **Download** on
the case page to open any version. If a case shows a document's metadata
but the file itself is missing, that will surface as an integrity warning
rather than failing silently.

---

## 16. Reports & Registers

Open **Reports** for the full set of operational registers:

- **PIM Register** — one row per case, with current stage, pending
  action, mediator, outcome, and closure date.
- **Pending Action Report** / **Overdue Report** — active tasks, sorted
  overdue-first; a task with no due date is never shown as overdue.
- **Notice / Service Report** — every notice with its service/return
  outcome, filterable by notice type and result.
- **Address-Correction Pending**, **Final Notice Pending** — focused
  views of those specific situations.
- **Fee Pending Report** — the case-level mediation fee position, balance
  due; application fees are excluded.
- **Mediator Register** — current workload per mediator (based on their
  *active* assignment only — a case they were reassigned away from does
  not count against their current load).
- **Mediation Session Register** — every sitting, with a totals strip
  (total/effective/ineffective sittings and cumulative effective
  duration). A **Today's Mediation** shortcut filters this to today.
- **Non-Starter / Settlement / Failure Reports** — one register per
  outcome type; a case only ever appears in the one that matches its
  actual outcome.
- **Outcome Statistics** — settlement/failure/non-starter rates, computed
  only over cases actually closed with an outcome in the period (open
  cases are never folded into that percentage).
- **Monthly Summary** — opening balance, new cases, disposals, closing
  balance, plus a reconciliation check comparing the computed closing
  balance against the actual count of open cases at month end; a mismatch
  is shown as a warning, never silently corrected.

Every register supports search, date-range filtering (each register
states which date field it filters on), sorting, and paging. Use
**Export CSV** to download exactly the filtered/sorted rows on screen, and
**Print** for a letterhead-formatted printer view.

---

## 17. Backups

Authorized users (secretary/admin) can trigger and review backups from
Settings → Backups.

### Daily Backup Reminder

- [ ] Secretary or admin should check backup status at the end of each
      working day.
- [ ] Go to **Settings → Backups**.
- [ ] Confirm the latest backup exists.
- [ ] Confirm the backup size is non-zero.
- [ ] Confirm the integrity status is successful.
- [ ] If a backup is missing, failed, or older than one working day, stop
      bulk data entry and inform admin.

### Other end-of-day checks

- Review the Pending Action Report for anything overdue.
- Review any Data Integrity Warnings on cases touched that day.

Only an **admin** can restore a backup, and doing so is a deliberate,
rare, disaster-recovery action — never a routine one.

---

## 18. Common Mistakes to Avoid

1. Entering an old physical case as a New Application instead of Legacy
   Import.
2. Guessing missing historical dates just to complete the form.
3. Entering only the first applicant or first opposite party when the
   file has multiple parties.
4. Treating postal refusal as mediation refusal.
5. Mixing the ₹1,000 application fee with the mediation fee.
6. Generating a fresh document and presenting it as an old historical
   document.
7. Closing a case without verifying that the correct outcome document
   exists.
8. Ignoring amber data-integrity warnings on the case summary page.
9. Using the admin login for routine data entry.
10. Forgetting to check end-of-day backup status.

---

## 19. What Staff Should Never Do

- Never delete a genuine case to "start over" — flag it for a correction
  instead.
- Never renumber a genuine PIM case.
- Never record a notice, service attempt, mediation sitting, or outcome
  that the physical file does not actually show.
- Never regenerate a historical document and present it as the original.
- Never close an active genuine case, or reopen a genuinely closed case,
  to test something — testing belongs on a separate practice system, never
  on live data.

---

## Appendix A — Status Glossary (plain-language)

| You will see | It means |
|---|---|
| Received | Application logged, scrutiny not yet done |
| Scrutiny Pending | Awaiting scrutiny checklist |
| Secretary Approval Pending | Scrutiny done, awaiting registration approval |
| PIM Registered / Form-2 Pending | Registered, notice not yet prepared |
| Service Pending | Notice issued, awaiting delivery/return/response |
| Notice Returned / Address Correction Pending | Notice came back, corrected address needed |
| Final Notice Pending / Issued | On the Final Form II track |
| OP Refused | Opposite party declined mediation |
| Fee Pending | Awaiting mediation fee |
| Mediator Assignment Pending / Mediator Assigned | Awaiting / has a mediator |
| First Mediation Pending / Mediation Ongoing | Sittings in progress |
| Outcome Form Pending | Mediation concluded, outcome not yet recorded |
| Authority Decision Pending | Non-starter closure awaiting Chairman's decision |
| Closed — Settled / Failed / Non-Starter / Withdrawn | Case is closed; no further action expected |

## Appendix B — Roles & Key Permissions

| Action | aa | secretary | chairman | admin |
|---|:---:|:---:|:---:|:---:|
| Enter new application | ✔ | | | ✔ |
| Import legacy/historical case | | ✔ | | ✔ |
| Complete scrutiny | ✔ | ✔ | | ✔ |
| Approve registration | | ✔ | | ✔ |
| Issue notice / record service / response / fee | ✔ | ✔ | | ✔ |
| Assign mediator | | ✔ | | ✔ |
| Record mediation session / outcome | ✔ | ✔ | | ✔ |
| Approve non-starter authority decision | | ✔ | ✔ | ✔ |
| Approve outcome | | ✔ | ✔ | ✔ |
| View cases / reports | ✔ | ✔ | ✔ | ✔ |
| View audit trail | | ✔ | | ✔ |
| Create / view backups | | ✔ | ✔ (view) | ✔ |
| Restore backup, manage users | | | | ✔ |

*Note: the `janani` login currently operates under the `aa` role/permission
set (see §1, Portal Access).*

---

*This manual describes the system as implemented through Phase 12. For the
day-to-day pilot checklist, see `docs/PILOT_CHECKLIST.md`.*
