# PIM SOP 2026 → Existing System Reconciliation Audit

**READ-ONLY.** No code, schema, data, or migrations were touched to produce this document. No PIM number was consumed. No commit/stage/push was performed.

Sources:
- `PIM Instruction.pdf` — TNSLSA Member Secretary communication, T.N.S.L.S.A. No. P.N.5996/2026, dated **30.09.2026**.
- `PIM SOP.pdf` — "Draft Standard Operating Procedure for Pre-Institution Mediation and Settlement" (Section 12A, Commercial Courts Act, 2015), 24 numbered clauses + 5 Annexures (A–E, text not reproduced in the supplied copy).
- Current repo state as of 2026-10-06, `main` branch, working tree mid-way through Phase 6 (Postgres migration), batches 1–5H-b complete, **5I not started**.

---

## 1. Executive Summary

The existing PIM system already implements the great majority of the SOP's operative content with unexpected accuracy — the **application fee (₹1,000, clause 3)** and the **full mediation-fee slab table (clause 19, columns 2–3)** are already hard-coded to the exact statutory figures. The workflow state machine (`status_master`, 29+ statuses) maps cleanly onto the SOP's filing → scrutiny → notice → service → response/consent → fee → mediator → mediation → outcome sequence, and the staff-operated model (no Secretary/Judge login gate) that this project deliberately adopted is **consistent with, not contradicted by, the SOP** — see §9.

Three genuine gaps stand out, all **MISSING**, none **CONFLICT**:

1. **Mediator honorarium (clause 19, columns 4–5) is not implemented anywhere in the codebase** — no table, no column, no calculation function. `grep -ri honorarium` across `lib/` returns zero hits.
2. **The statutory limitation period (clause 13: 3 months + 2-month consent extension, clause 4: rectification-period exclusion) has schema support but zero business logic.** `pim_cases.statutory_due_date`, `extension_date`, `extended_due_date` exist as columns but are never computed at intake — only read by reports and set by legacy import. Only the **internal 60-day operational target** (`internal_60_day_date`, `INTERNAL_NONSTARTER_TARGET_DAYS` setting, default 60) is actually live, and it is explicitly *not* the SOP's statutory clock.
3. **The affidavit/30-day-currency declaration (clause 5a) and the "private notice with Authority permission" mechanism (clause 5b) have no schema representation** — no affidavit flag, no private-notice record, no permission-decision field anywhere in `pim_notices`, `pim_addresses`, or `pim_service_attempts`.

Everything else is **MATCH** or **PARTIAL** (terminology differs, behavior satisfies the rule), detailed below.

**Batch 5I decision (§21): proceed with option (A)** — the already-designed Form-2 PostgreSQL migration should continue unchanged. None of the three gaps above are Form-2/service-data gaps that block 5I; they are additive fields/logic that can be layered onto the existing `pim_notices`/`pim_addresses`/`pim_service_attempts` shape without altering the migration already designed. See §21 for the full reasoning.

---

## 2. Effective Date / Versioning

| | |
|---|---|
| Communication date | 30.09.2026 (TNSLSA No. P.N.5996/2026) |
| Effective date | **01.10.2026**, per Hon'ble TNSLSA Committee direction |
| Honorarium effective-date rule | Instruction letter, para 4: *"the enhancement of honorarium to the mediators, is applicable to the cases where mediator(s) is/are nominated from 01.10.2026."* — i.e. keyed to **mediator nomination date**, not case filing date, registration date, or any other case-level date. |
| Judicial Officer-Mediator list | Not yet received — instruction letter states TNMCC's list "will be communicated to you, after obtaining the same from TNMCC." Clause 9(b) of the SOP already contemplates this category; the panel itself is pending from TNSLSA. |

**System implication.** The system has **no effective-date-aware rule model at all** today — fee/honorarium logic is a single hard-coded function (`calculateMediationFee`), not keyed to any date. Since the mediation-fee slabs (clause 19 cols 2–3) are unchanged by this SOP revision (only honorarium, cols 4–5, is new), **no retroactive redesign of the existing fee calculation is needed**. What *is* needed, once honorarium is implemented (§15), is that the honorarium calculation be keyed to `pim_mediator_assignments.assigned_date` (or equivalent "nomination date" field — needs confirming against the actual assignment schema) ≥ 2026-10-01, not to `received_date`/`application_date`/`registration_date`. This is a forward design note, not a current conflict: no honorarium exists yet to be versioned.

Old vs. new cases should **not** be assumed to need identical rules — the instruction letter is explicit that only mediator-nomination date governs the honorarium split; nothing in the SOP or instruction suggests application-fee or mediation-fee figures differ by case vintage.

---

## 3. Filing of Application (SOP Clause 2)

| Source rule | Current system | Status | Required change | Priority | Affected modules |
|---|---|---|---|---|---|
| 2(a) Territorial + pecuniary jurisdiction | `pim_cases` has no explicit jurisdiction fields; `territorial_jurisdiction_status` column exists (free text) but is set only by scrutiny checkboxes (`territorial_jurisdiction_checked`), not by intake. Pecuniary jurisdiction is implicit in `claim_amount` / `MAX_PIM_CLAIM_AMOUNT = 10,000,000` cap in `lib/pim.js`. | PARTIAL | None urgent — territorial jurisdiction is a scrutiny-stage check (clause 4 also lists "territorial jurisdiction" as a scrutiny item, consistent). Confirm the ₹1,00,00,000 intake cap is still the correct pecuniary ceiling under current DLSA practice (not sourced from this SOP, which has no pecuniary ceiling clause). | Low | `lib/pim.js`, `lib/pim-scrutiny.js` |
| 2(b) Online / by hand / by post filing | No channel field on `pim_cases`; intake form doesn't distinguish how the application arrived. | MISSING (minor) | A `filing_mode` enum (`ONLINE`/`HAND`/`POST`) would satisfy the Filing Register's likely column set once Annexure-A's actual format is reviewed. | Medium | `pim_cases` schema, intake form |
| 2(b) Filing Register (Annexure-A format) | No "Filing Register" artifact exists; closest equivalent is the `cases` list view + `pim_docket`. Register generation is already a stated long-term preference (source-data → generated register, §19 below). | MISSING | Defer until Annexure-A's actual prescribed columns are available (not included in the supplied PDF — only referenced). Do not redesign intake now. | Medium | reports module |

No redesign of Annexure-A is appropriate without its actual prescribed format, which the supplied SOP copy does not contain (only "annexed hereto as Annexure-A," page content not provided).

---

## 4. Application Fee (SOP Clause 3)

| Source rule | Current system | Status | Required change | Priority | Affected modules |
|---|---|---|---|---|---|
| 3(a) Fixed ₹1,000 fee | `lib/pim.js:447` — `if (Number(data.applicationFee.amount) !== 1000) throw`; `lib/pim.js:155-156` and `lib/pim-data/intake.js:222-224` hard-code `1000`/`1000` for `amount_due`/`amount_received`. | **MATCH** | None. | — | `lib/pim.js`, `lib/pim-data/intake.js` |
| 3(b) DD payable to Member Secretary/Chairman | `pim_fees.payee`, `dd_number`, `dd_bank`, `dd_date` columns exist and are collected at intake/scrutiny (`pim_scrutiny.dd_payee_correct` is an explicit scrutiny checklist item). | MATCH | None. | — | `pim_fees`, `pim_scrutiny` |
| 3(c) Online payment, transaction completed same day as presentation, proof in writing | `pim_fees` has `fee_type`, `amount_received`, `received_date` but no explicit "online transaction reference/proof" field distinct from the DD fields, and no same-day validation. | PARTIAL | Low-priority: add an optional `payment_mode` (`DD`/`ONLINE`) + `transaction_ref` pair if online fee collection becomes a real intake path (currently DD-shaped fields dominate the schema). | Low | `pim_fees` schema |

Application-fee handling is the single cleanest MATCH in the whole audit — figures, payee convention, and receipt/register intent all line up.

---

## 5. Scrutiny (SOP Clause 4)

| Source rule | Current system | Status | Required change | Priority | Affected modules |
|---|---|---|---|---|---|
| Verify contents/form **within 3 days** of presentation | No 3-day timer exists anywhere — `grep` for any 3-day scrutiny SLA found nothing. Scrutiny can be completed at any time after `RECEIVED`/`SCRUTINY_PENDING`. | **MISSING** | Add a non-blocking **monitoring** field (e.g. `pim_cases.scrutiny_due_date = received_date + 3 days`, surfaced on the dashboard like `internal_60_day_date` already is) — not a hard gate, since neither clause 4 nor any other clause prescribes a consequence for missing it. | Medium | `lib/pim-data/dashboard.js`, `lib/pim-reports.js`, intake |
| If in order → assign case number (PIMS No.) | T2 (`saveScrutinyPg`, COMPLETE branch) now targets `PIM_NUMBER_PENDING` (Batch 5H-b), and the separate `ASSIGN_PIM_NUMBER` action (`lib/pim-data/pim-numbering.js`) issues `PIM/{n}/{year}` immediately after. | **MATCH** | None — this is exactly clause 4's sequence: verify → (if in order) → assign number. | — | `lib/pim-data/scrutiny.js`, `lib/pim-data/pim-numbering.js` |
| If defective → return for rectification, specify re-submission time, rectification period excluded from limitation, Assignment Register entries | DEFECT branch sets status `DEFECT_PENDING`, records `defect_details`, `rectification_date` on `pim_scrutiny`. **No actual exclusion-from-limitation arithmetic exists** because no statutory limitation clock is computed at all yet (§14). "Assignment Register" is not a literal register but `pim_status_history`/`pim_docket` function as its de facto source data. | PARTIAL | Rectification-period exclusion can only be implemented once §14's statutory-due-date logic exists; design it to subtract `rectification_date − defect_noted_date` from the eventual 3-month clock when that clock is built. | High (blocks a correct clause-13 implementation) | `lib/pim-data/scrutiny.js`, future limitation module |

**On the specific questions A–E posed:**

- **A. Is `PIM_NUMBER_PENDING` compatible with the SOP?** Yes. The SOP says "if in order, shall assign a case number" — it does not prescribe any intermediate approval stage. `PIM_NUMBER_PENDING` is a staff work-queue state between "scrutiny passed" and "number assigned," not an approval gate; it satisfies the clause.
- **B. Should number assignment happen immediately after successful scrutiny?** The SOP's wording ("if it is found in order, shall assign...") reads as "promptly," not necessarily "same transaction." The current two-step (scrutiny COMPLETE → `PIM_NUMBER_PENDING` → staff clicks "Assign PIM Number") is a reasonable operational interpretation and is **not** a deviation — nothing in the SOP requires atomic assignment, and Batch 5H-b's design doc explicitly chose this staff-operated two-step over an automatic one for good reasons (allocator safety, no auto-rollover). No change needed.
- **C. Does the workflow introduce any unnecessary approval stage?** No — see Batch 5H-a's finding that the Secretary/Judge approval workflow (T3, `SECRETARY_APPROVAL_PENDING`) was **already deliberately set aside** in favor of staff-operated numbering. `PIM_NUMBER_PENDING` is the replacement, not an addition. §9 confirms this reading is SOP-compatible.
- **D. Does the system calculate/monitor the 3-day scrutiny period?** No — confirmed MISSING above.
- **E. Are defect/rectification periods recorded sufficiently to calculate limitation correctly?** `rectification_date` (the target re-submission date) is recorded, but there is no `defect_noted_date` distinct from `pim_scrutiny.scrutinised_at`, and — critically — no statutory clock exists yet to exclude the period from. Recording is *partially* sufficient; the consuming logic does not exist.

**Do not undo Batch 5H-b.** Confirmed: its actual behavior (verify → in-order → number; defective → return with rectification date) satisfies clause 4 regardless of the "PIM_NUMBER_PENDING" vs. "case number assignment" terminology difference.

---

## 6. PIMS Numbering (confirmed business rule vs. SOP)

Format `PIM/{running_number}/{year}`, 2026 production state `last_number = 118` (next genuine number `PIM/119/2026`), **confirmed not consumed during this audit** — verified read-only via `docs/phase6-batch5h-b-pim-numbering.md`, no `execute_sql`/write tool was called against Postgres in this session.

The SOP requires a "case number/PIMS No." assigned after successful scrutiny — it does not prescribe a *format*. The existing `PIM/{n}/{year}` convention, the `pim_number_sequences` atomic allocator, and its concurrency guarantees (§4 of the 5H-b doc) are **MATCH** — no change needed, no renumbering required, no risk of double-issuing `PIM/119/2026` from this audit (nothing here touched the sequence table).

---

## 7. Service of Notice (SOP Clause 5) — the section most important to Batch 5I

| Source rule | Current system | Status | Required change | Priority | Affected modules |
|---|---|---|---|---|---|
| 5(a) Service by post or email | `pim_service_attempts.dispatch_mode` defaults `REGISTERED_POST`; no explicit `EMAIL` value confirmed in the CHECK constraint seen (schema shows a default only, not an enumerated list — needs direct confirmation against the full CHECK clause before assuming email is already a selectable mode). | PARTIAL — needs verification | Confirm (not assume) whether `dispatch_mode` already allows `EMAIL`; if not, add it. | High | `pim_service_attempts` schema, `app/api/pim/form2/*` |
| 5(a) Applicant provides postal address, phone/mobile, email of OP | `pim_parties.contact_phone`, `pim_parties.email` exist; `pim_addresses` carries the postal address. **All three pieces of contact data the SOP requires are already captured at the party level**, satisfying the substance of this requirement. | MATCH | None structurally. | — | `pim_parties`, `pim_addresses` |
| 5(a) Affidavit declaring address/contact correctness, in use for preceding 30 days | **No affidavit field anywhere** — no boolean, no date, no document reference distinct from the general `pim_documents` table tied to this specific declaration. | **MISSING** | Add an affidavit-received flag + date (and ideally a `pim_documents` linkage) to intake or `pim_parties`/`pim_case_parties`. This is a genuine new data-capture requirement, not a terminology gap. | **High** | intake (`lib/pim.js`, `lib/pim-data/intake.js`), `pim_parties` or a new join table |
| 5(b) If service fails and applicant provides updated contact details, use them | `app/api/pim/documents/*` and a `address-correction/[id]` route exist (per the Phase 6 design doc's route inventory: `address-correction/[id]`, `service/[id]`), and `ADDRESS_CORRECTION_PENDING` is a real status. | MATCH | None — this is already a modeled workflow state, not just a field. | — | `pim-data` notice/service modules |
| 5(b) Private notice with Authority permission, for sufficient reasons | **No schema representation at all** — no `permission_granted` flag, no reason-for-permission field, no linkage of a "private notice" dispatch mode to an Authority decision record. `dispatch_mode` has no obvious `PRIVATE` value (needs confirming against the actual CHECK list). | **MISSING** | Add a `dispatch_mode` value (e.g. `PRIVATE_NOTICE`) plus an authority-permission record (who, when, reason) — this directly engages the Nodal-Officer "consideration of legal representations" duty already named in clause 11(b). Needs its own small design pass, not an ad hoc field. | **High** | `pim_service_attempts`/`pim_notices` schema, Nodal Officer role model (§13) |

**Why this section is especially important for Batch 5I:** the Form-2 PostgreSQL migration (per `docs/phase6-migration-design.md` §6 step 7) already ports `pim_notices`, `pim_service_attempts`, `pim_addresses`, `address-correction/[id]`, `service/[id]` as a single batch. The two MISSING items above (affidavit, private-notice permission) are **additive columns**, not structural changes to the tables or transactions already mapped for that batch — they do not require re-scoping 5I's statement-by-statement contract, only widening the row shape before or after. See §21.

---

## 8. Final Notice / Non-Starter (SOP Clause 6)

| Source rule | Current system | Status | Required change | Priority | Affected modules |
|---|---|---|---|---|---|
| Initial notice → failure to appear / no response → final notice | `FORM2_PENDING → FORM2_ISSUED → SERVICE_PENDING → NOTICE_RETURNED/FINAL_NOTICE_PENDING → FINAL_NOTICE_ISSUED` status chain; `FRESH_NOTICE_APPEARANCE_WINDOW_DAYS = 10` governs re-notice timing (`lib/pim-fresh-notice.js`, `lib/pim-data/form2.js`). | MATCH | None. | — | `lib/pim-fresh-notice.js`, `lib/pim-data/form2.js` |
| Unwillingness/refusal to participate → non-starter | `OP_REFUSED_MEDIATION` reason code, auto-triggered off `pim_responses`. | MATCH | None. | — | `lib/pim-nonstarter.js`, `lib/pim-data/nonstarter.js` |
| Inability to serve despite reasonable attempts → non-starter | `FINAL_NOTICE_UNACKNOWLEDGED` reason, inferred from `pim_responses`/`pim_notices`/`pim_service_attempts` context (`inferNonStarterContext`, 3-branch SELECT chain per `docs/phase6-batch5d-nonstarter-migration.md` §2). `pim_service_attempts.return_reason` enum (`ADDRESSEE_LEFT`, `INSUFFICIENT_ADDRESS`, `UNCLAIMED`, `REFUSED_BY_ADDRESSEE`, `OTHER`) feeds this. | MATCH | None. | — | `lib/pim-nonstarter.js` |
| Classification as non-starter → Form 3 | `NONSTARTER_FORM3` handoff task, `pim-nonstarter.js`'s `AUTO_TRIGGERED_REASON_CODES` set requires the task to actually exist before recording — "proof the underlying case fact was genuinely established, not merely asserted." | MATCH, and notably *more rigorous* than the SOP's bare wording. | None. | — | `lib/pim-nonstarter.js` |
| Communication to applicant/OP/counsel; Disposal Register | Form-3 document generation exists (`lib/pim-document.js`); "Disposal Register" is not a literal register but is generatable from `pim_outcomes` + `pim_status_history` (consistent with the project's stated source-data → register preference, §19). | PARTIAL | None urgent — register *generation* (not duplicate entry) is the long-term plan already. | Low | `lib/pim-reports.js` |
| `BOTH_PARTIES_NOT_WILLING`, `MEDIATION_FEE_NOT_SUBMITTED` manual reasons | Both exist (`MANUAL_REASON_CODES`), the 5th nonstarter_reasons row (`MEDIATION_FEE_NOT_SUBMITTED`) is seeded with `remarks: "Operational ground; verify against applicable current DLSA/TNSLSA practice"` — i.e. the system **itself already flags this reason as unconfirmed against the authoritative rule source**. | PARTIAL | This SOP (clause 6(f)/9, "mediator appointment only after fee remittance") is the authoritative source the seed comment asked for. Update `nonstarter_reasons.rule_reference`/`remarks` for id 5 to cite SOP clause 6(f)/9 instead of "Operational ground" — a metadata correction, not a workflow change. | Low | seed data only (no code logic change) |

**T7 is not being changed by this audit** (per the pasted instructions' explicit "Do not change T7 yet") — the table above documents fit, not a plan to modify it now.

---

## 9. Consent (SOP Clause 6(d)–(f))

| Source rule | Current system | Status |
|---|---|---|
| OP chooses to participate | `OP_APPEARED`/`OP_CONSENTED`/`OP_REFUSED` statuses; `pim_responses.consent` column | MATCH |
| All parties expressly consent before referral to mediation | `lib/pim-op-response.js` handles consent recording per response; multiple-OP handling exists (`pim_case_parties` supports multiple `OPPOSITE_PARTY` rows per case) | MATCH |
| No referral without all-party consent | Not independently verified in this pass (would require reading the mediator-assignment route's guard conditions in full) — flag as **needs a focused follow-up read** of `ASSIGN_MEDIATOR`'s preconditions, not asserted as a gap here. | **PARTIAL — unverified**, follow-up needed |
| Mediation-fee prerequisite; mediator appointment only after fee remittance | `lib/pim-op-response.js` creates the case-level `MEDIATION_FEE` row "as soon as an OP consents, before staff ever visits the fee page" (comment in `pim-mediation-fee.js`), and `MEDIATOR_ASSIGNMENT_PENDING`/`FEE_PENDING` are separate statuses in sequence. | MATCH in intent; confirm the actual `ASSIGN_MEDIATOR` route rejects assignment while `FEE_PENDING` is still open (same follow-up as above) | PARTIAL — unverified |

---

## 10. Mediation Fee (SOP Clause 8 + Clause 19 table)

**Fully reconciled and confirmed exact.** `lib/pim-mediation-fee.js`'s `calculateMediationFee()`:

| Quantum of claim (SOP) | SOP mediation fee | Code boundary | Code fee | Match |
|---|---|---|---|---|
| 3,00,000 – 10,00,000 | 15,000 | `>300000 && <=1000000` | 15000 | ✅ |
| 10,00,001 – 50,00,000 | 30,000 | `>1000000 && <=5000000` | 30000 | ✅ |
| 50,00,001 – 1,00,00,000 | 40,000 | `>5000000 && <=10000000` | 40000 | ✅ |
| 1,00,00,001 – 3,00,00,000 | 50,000 | `>10000000 && <=30000000` | 50000 | ✅ |
| Above 3,00,00,000 | 75,000 | `>30000000` | 75000 | ✅ |

The code's own comment block already explicitly cites "Schedule II statutory mediation-fee slabs" and notes the top two slabs are "unreachable through normal intake today... but kept complete per the statute in case a legacy-imported case carries a higher claim amount" — i.e. this was already built against the correct statutory source, independent of this SOP review. **No change needed.** Applicant/OP 50-50 split, multiple-OP joint/equal-share payment (`pim-data`'s mediation fee handling, per clause 6(d) "jointly pay one-half... or share it equally") — both already described in SOP clause 6(d) and consistent with the fee row's `party_id`-scoped design (nullable, supports per-party or case-level recording).

**Do not confuse** this with the application fee (§4, separate ₹1,000 flat fee, already correct) or the honorarium (§15, missing entirely).

---

## 11. Mediator Panel (SOP Clause 9)

| Source rule | Current system | Status |
|---|---|---|
| 9(a) Trained Advocate-Mediators, TNMCC-empanelled | All 5 current mediators (`Ravikumar`, `Rajesh`, `Narayanan Kutty`, `Latha Subramaniam`, `K. Viswanath`) are classified `ADVOCATE MEDIATOR`, confirmed unchanged by this audit (no write performed). | **MATCH — do not change these records**, per the instruction's explicit "unless the source documents establish that one is incorrect." Neither source document names any individual mediator or disputes this classification. |
| 9(b) Retired Judicial Officer-Mediators, TNMCC-empanelled | `mediators.category` is a free-text column (`DEFAULT 'ADVOCATE MEDIATOR'`), **not an enum** — it already structurally accepts any category string, including `'JUDICIAL OFFICER MEDIATOR'` or similar, with zero schema change. | **Schema already supports this category.** No migration needed when TNSLSA's list arrives — only new rows. |

Both the instruction letter and SOP are explicit that the Judicial Officer-Mediator list is **not yet available** ("will be communicated to you... after obtaining the same from TNMCC"). No panel data should be fabricated; none was.

---

## 12. Mediator Appointment (SOP Clause 6(f), Clause 9)

Prerequisites per SOP: all-party consent (§9 above) + mediation fee remitted. Status sequence `OP_CONSENTED → FEE_PENDING → MEDIATOR_ASSIGNMENT_PENDING → MEDIATOR_ASSIGNED` is consistent with "appointment only after those conditions," assuming the unverified guard noted in §9 does hold. This needs the same short, focused follow-up read of the `ASSIGN_MEDIATOR` route/permission gate before being called a confirmed MATCH rather than a PARTIAL.

---

## 13. Conduct of Mediation (SOP Clause 10)

| Source rule | Current system | Status |
|---|---|---|
| Physical or online mediation | `mediation_sessions` table exists (per Phase 6 design doc's route inventory: `mediation/[id]`, `mediation/next/[id]`, `mediation/session/[id]` — "the largest transaction in the app, ~640 lines"). Online-mode support not independently re-verified in this pass. | PARTIAL — plausible MATCH, not fully re-confirmed this pass |
| Settlement / failure report | Form-4 (settlement) / Form-5 (failure) document generation exists per the design doc's document-module inventory. | MATCH |
| Confidential mediator records | `lib/pim-document.js`'s mediator records are generated on demand, never persisted to Storage (Phase 6 design, §5) — arguably *more* confidential than a persisted file, not less. | MATCH / exceeds |
| Disposal Register | Same as §8 — generatable, not separately maintained. | PARTIAL, consistent with stated register strategy |

No missing modules identified — per the instruction, nothing here is being implemented regardless.

---

## 14. Nodal Officer (SOP Clause 11) — role-model recommendation

Clause 11 duties, mapped against the current `ROLES = ["aa", "secretary", "chairman", "admin"]` (`lib/pim-auth.js`) and permission map:

| Clause 11 duty | Current permission equivalent | Who can do it today |
|---|---|---|
| 11(a) Appointment of Nodal Officer (by Member Secretary/Chairman) | No `nodal_officer` concept in the role/permission model at all | N/A |
| 11(b) Scrutiny | `COMPLETE_SCRUTINY` | `aa`, `secretary`, `admin` |
| 11(b) Service of notice | `ISSUE_NOTICE`, `RECORD_SERVICE` | `aa`, `secretary`, `admin` |
| 11(b) Consideration of legal representations | No distinct permission exists (ties to the MISSING private-notice-permission field, §7) | — |
| 11(b) Recording parties' unwillingness | `RECORD_RESPONSE`, `RECORD_CONSENT` | `aa`, `secretary`, `admin` |
| 11(b) Appointment of mediators | `ASSIGN_MEDIATOR` | `secretary`, `admin` only (narrower than most permissions — notably excludes `aa`) |
| 11(c) Acting as Civil Court for condonation-of-delay / rectification re-submission | No distinct "Nodal Officer as Civil Court" authority-decision concept — closest is `APPROVE_NONSTARTER_AUTHORITY` (`secretary`, `chairman`, `admin`) | partial equivalent exists |
| 11(d) Register verification, monthly statistical reporting | No register-verification step; reporting exists (`lib/pim-reports.js`) but is not gated as a distinct "Nodal Officer" sign-off action | — |

**Recommendation — the critical distinction the instructions asked to preserve.**

The system should **not** reverse the deliberate removal of a Secretary/Judge login-and-approve gate (`docs/phase6-batch5h-a` confirms this was already a considered decision: "PIM has no operational Secretary/Judge role: the software is staff-operated throughout"). The SOP's Nodal Officer is "**the person legally responsible for the proceeding**" under the TNSLSA scheme — a designation of accountability — not necessarily "**the person physically operating the software**." These are genuinely different things, and the SOP's own clause 11(d) ("verify... submit monthly statistical reports") reads as an oversight/reporting duty, consistent with a role that reviews system output rather than clicks through every transaction.

Concretely:

1. **Ordinary staff may continue performing data entry on behalf of the Nodal Officer** — this is already the system's operating model and nothing in clause 11 requires otherwise; it only requires that *a* Nodal Officer exist and discharge the listed duties, not that every individual action be performed by them personally.
2. **A configurable Nodal Officer identity should be added** — a `system_settings` row (`NODAL_OFFICER_USER_ID` or similar, per-DLSA) or a dedicated field on `users`, so that generated registers/reports can correctly attribute "Nodal Officer: X" without requiring X to log every transaction.
3. **Actions that are genuinely decisions "by the Authority," not routine data entry — private-notice permission (clause 5(b)) and consideration of legal representations (clause 11(b)) — should record a distinct authority-decision**, separate from whichever staff account typed it in. This is the same pattern `APPROVE_NONSTARTER_AUTHORITY` already uses for the nonstarter authority-decision branch; extending that pattern to the two new clause-5(b)/11(b) decisions is low-risk and consistent with existing precedent, not a new architectural concept.

This recommendation does **not** propose reinstating `SECRETARY_APPROVAL_PENDING` or any blocking login/approval gate.

---

## 15. Limitation Period (SOP Clause 13, incorporating Clause 4)

This is the most consequential finding in the audit.

| | SOP requirement | Current system |
|---|---|---|
| Statutory limitation | 3 months from date of application | `pim_cases.statutory_due_date` **column exists** but is **never computed at intake** — confirmed by grep: it appears only in `lib/pim-reports.js` (read), `lib/pim-legacy-import.js` (accepts it as external input for legacy cases), and test/verification scripts. No `addDays(application_date, 90)` or equivalent call exists in `lib/pim.js` or `lib/pim-data/intake.js`. |
| Extension | Further 2 months, with consent of both parties | `pim_cases.extension_date`, `extended_due_date` columns exist, same non-computation status — no code path sets them for new cases. |
| Rectification exclusion | Clause 4's rectification period excluded from the limitation computation | Cannot be implemented correctly until the base statutory clock itself is computed (see §5's row E). |
| **What is actually live today** | — | Only `internal_60_day_date` (`INTERNAL_NONSTARTER_TARGET_DAYS` system setting, default 60 days from... needs confirming exactly which base date `lib/pim-approval.js`/`lib/pim-data/pim-numbering.js` anchor it to) — explicitly an **internal management target for non-starter escalation**, per its own seed description ("Internal management target for non-starter stage"), not a statutory deadline. |

**Classification of every existing deadline-shaped field, as requested:**

| Field | Classification |
|---|---|
| `internal_60_day_date` / `INTERNAL_NONSTARTER_TARGET_DAYS` | Internal operational target (non-starter escalation), **not** SOP limitation |
| `statutory_due_date` | Intended for SOP clause-13 limitation, **schema exists, logic missing** |
| `extension_date` / `extended_due_date` | Intended for clause-13's 2-month consent extension, **schema exists, logic missing** |
| `FRESH_NOTICE_APPEARANCE_WINDOW_DAYS = 10` | Notice follow-up window (clause-5-adjacent), unrelated to the 3-month clock |
| `MAX_ALTERNATE_DATE_WINDOW_DAYS = 10` | OP-response follow-up window, unrelated to the 3-month clock |
| `dashboard`'s "approaching/overdue 60-day" cards | Internal operational, same as `internal_60_day_date` |

**Do not replace every 60-day value with 90 days** — correctly, because the 60-day target and the 3-month statutory period are **different clocks serving different purposes** (internal escalation trigger vs. statutory deadline under clause 13), and conflating them would both break the existing internal-target semantics and still fail to correctly implement clause 13 (which needs 2-month extension and rectification-exclusion logic the 60-day field was never designed to carry).

**Recommended deadline model (design-only, not implemented here):** compute `statutory_due_date = application_date + 90 days` at intake (mirroring exactly how `internal_60_day_date` is already computed at `assignPimNumberPg`-equivalent time, per `pim-data/pim-numbering.js:207-208`), track rectification-exclusion days separately (e.g. a `rectification_excluded_days` accumulator updated whenever a DEFECT scrutiny cycle completes), and gate the 2-month extension behind an explicit both-parties-consent record (reusing the consent-recording pattern already proven in `pim_responses.consent`) before writing `extended_due_date`.

---

## 16. Honorarium (SOP Clause 19, columns 4–5)

**Not implemented at all.** Confirmed by direct grep (`grep -ri honorarium lib/`) returning zero results, and by `pim_mediator_assignments`/`mediation_sessions` schema containing no honorarium-amount or honorarium-paid columns in anything reviewed this pass.

| Quantum of claim (SOP) | Honorarium — settlement | Honorarium — failure report |
|---|---|---|
| 3,00,000 – 10,00,000 | 7,500 | 2,500 |
| 10,00,001 – 50,00,000 | 15,000 | 2,500 |
| 50,00,001 – 1,00,00,000 | 20,000 | 2,500 |
| 1,00,00,001 – 3,00,00,000 | 25,000 | 2,500 |
| Above 3,00,00,000 | 37,500 | 2,500 |

Note the failure-report honorarium is **flat ₹2,500 regardless of claim quantum** — only the settlement-honorarium column scales with the slabs, mirroring `calculateMediationFee`'s structure exactly (same five boundaries) but as two new output columns, not one. A `calculateMediatorHonorarium(claimAmount, outcome)` function sitting alongside `calculateMediationFee` in `lib/pim-mediation-fee.js` (or a sibling module) would be the natural implementation shape, reusing the identical boundary logic already proven correct for the fee table. **Effective-date gate per §2: only for mediators nominated ≥ 2026-10-01** — the pre-2026-10-01 honorarium figures are not in either supplied document, so a prior-rate table cannot be reconstructed from these sources; that would need the superseded SOP/communication if historical-rate honorarium is ever required for pre-01.10.2026 cases.

**Not implemented in this audit, per instruction.**

---

## 17. Online Mediation (SOP Clause 20)

`mediation_sessions` table and the online/video-conference intent already appear supported at the conceptual level (§13); a full gap check of "prior permission" recording specifically (clause 20's "must obtain prior permission") was not completed this pass — flagged as a **follow-up read**, not asserted as present or absent.

---

## 18. Copy Applications (SOP Clause 21)

`pim_documents` already tracks document type, version, and "is_current" (per the Phase 6 design doc's description of its role in Form-4/5 gating). Certified-vs-non-certified copy fee handling is not present and not assessed further than "the document metadata model could represent a new `copy_type`/`copy_fee` pair without restructuring" — a gap-identification only, no implementation.

---

## 19. Refund Policy (SOP Clause 22)

| Source rule | Current system | Status |
|---|---|---|
| No application-fee refund after registration starts | No refund-prevention logic found this pass for `APPLICATION_FEE` rows specifically — `pim_fees.refund_amount`/`refund_date` columns exist generically for both fee types with no status-based guard identified. | **Needs a focused follow-up read** of whatever route writes `refund_amount` (not located in this pass) before calling this MATCH, PARTIAL, or MISSING with confidence. |
| No mediation-fee refund after payment | Same caveat. | Follow-up needed |
| Serial number allotted regardless of fee outcome | Consistent with intake always creating a case row (`pim_number=NULL` at intake, no fee-gate on case creation per Batch 5C's T1 analysis). | MATCH |

---

## 20. Registers (SOP-wide inventory)

| Register | SOP source | Current system | Can be generated from transactional data? |
|---|---|---|---|
| Filing Register | Clause 2(b), Annexure-A | Not a literal register; `pim_cases` + `pim_docket` hold the underlying facts | Yes, pending Annexure-A's actual column list |
| Assignment Register | Clause 4 | Not literal; `pim_status_history`/scrutiny-attempt rows hold the facts | Yes |
| Disposal Register | Clauses 6(c), 10(e) | Not literal; `pim_outcomes` + non-starter recording hold the facts | Yes |
| Accounts Register | Clause 23, Annexure-D | `pim_fees` (receipt) exists; expenditure-side columns not confirmed this pass | Partial — needs an expenditure-tracking follow-up read |

**The "source data → generated register" preference is compatible with the SOP wording.** Every clause referencing a register ("Filing Register," "Assignment Register," "Disposal Register," "Accounts Register") describes *what must be recorded*, not *that a physical ledger must be separately re-keyed* — nothing in the supplied text mandates manual double-entry. This matches the project's stated long-term direction and requires no SOP-driven reversal.

---

## 21. Monthly Reporting (SOP Clause 24)

Clause 24 requires DLSAs to submit a monthly statement (Annexure-E format, not supplied) **in addition to** Form-6/Schedule-I data (Schedule-I to the Rules, external to this SOP document). `lib/pim-reports.js` has an existing reports module with a `monthly` route; whether its current output already satisfies Annexure-E's specific columns cannot be assessed without Annexure-E's actual format, which the supplied PDF does not include (referenced, not reproduced). **Gap: Annexure-E format unknown; report-column reconciliation cannot be completed from the supplied source documents.**

---

## 22. Current Batch 5I Impact — explicit decision

**Decision: (A) — proceed with the already-designed Form-2 PostgreSQL migration unchanged.**

Reasoning:
- The SOP's service-of-notice requirements that are genuinely **new data** (affidavit, private-notice Authority permission — §7) are **additive columns**, not structural changes to `pim_notices`/`pim_service_attempts`/`pim_addresses` or to the transaction shape Batch 5I was already scoped around. They widen a row; they do not change which tables are touched, how many statements run, or the transaction's guard placement.
- Nothing in the SOP changes the *existing* Form-2 fields, the fresh-notice 10-day window, the service-attempt return-reason taxonomy, or the address-correction workflow — all confirmed MATCH or PARTIAL-no-code-change above.
- The three genuine MISSING items (honorarium, statutory limitation clock, affidavit/private-notice fields) are **independent subsystems** from the Form-2 migration's actual scope (§6 step 7 of `docs/phase6-migration-design.md`): honorarium belongs to the mediation/outcome phase (step 10–11), the limitation clock is case-level (spans intake through every phase), and affidavit/private-notice are notice-level but additive.
- Postponing 5I to wait for Annexure-A/E formats or the Judicial Officer-Mediator list (both genuinely pending, per §3/§11/§21) would block unrelated, already-correct migration work on inputs that don't affect Form-2's own shape.

**What should change before or shortly after 5I, as a scoping note for whoever plans it (not decided here):** if the affidavit/private-notice fields are wanted in the *same* migrated table shape rather than retrofitted later, add them to 5I's column list now, while the `pim_notices`/`pim_service_attempts` DDL is being written — cheaper than a follow-on `ALTER TABLE` after the batch ships. This is a scheduling convenience, not a blocker.

---

## 23. Impact on Already-Completed Batches

| Batch | Classification | Reasoning |
|---|---|---|
| T1 Intake | **Remains valid** | No SOP clause conflicts with the intake contract (Batch 5C's statement-by-statement mapping); the only intake-adjacent gap (affidavit, §7) is a new field, not a correction to existing fields. |
| T2 Scrutiny | **Remains valid; requires extension** | Core scrutiny logic (COMPLETE/DEFECT, status transitions) matches clause 4 exactly. Extension needed: the 3-day SLA monitor (§5) and eventual rectification-exclusion feed into §15's limitation module — additive, not corrective. |
| T7 Non-starter | **Remains valid** | Confirmed against clause 6's full sequence; the one PARTIAL item (reason-5's seed `remarks` citing "Operational ground" instead of this SOP) is a metadata label, not a behavior change, and T7 itself was explicitly told not to change in this pass. |
| 5H-a Mediator Registry | **Remains valid; requires extension** | Panel data (5 Advocate-Mediators) confirmed correct and untouched. Extension: category field already schema-ready for Judicial Officer-Mediators (§11) — no correction needed, just new rows once TNMCC's list arrives. |
| 5H-b PIM Numbering | **Remains valid** | §6 confirms the staff-operated numbering model and `PIM/{n}/{year}` format both satisfy clause 4's "assign a case number" requirement; no correction needed. |

No batch requires a **correction** (i.e., undoing or reversing already-shipped behavior) based on anything in the two supplied source documents.

---

## 24. Recommended Implementation Sequence From This Point

1. **Limitation-period module** (§15) — highest priority, because it is both a genuine statutory gap and a prerequisite for correctly finishing the clause-4 rectification-exclusion logic (§5 row E) and for any future "statutory due date" dashboard/report card. Design the `statutory_due_date`/`extension_date` computation and the rectification-exclusion accumulator before touching intake code.
2. **Affidavit + private-notice schema additions** (§7) — needed before or alongside Batch 5I if the team wants them in the same table shape; otherwise schedule immediately after 5I as a small additive migration.
3. **Nodal Officer configurable identity + authority-decision recording for private-notice/legal-representation decisions** (§14) — depends on #2 existing first (the private-notice field it attaches an authority-decision to).
4. **Honorarium calculation module** (§16) — independent of 1–3; can proceed in parallel, scoped to the mediation/outcome phase of the Postgres migration, gated by mediator nomination date ≥ 2026-10-01.
5. **Batch 5I (Form-2 migration)** — proceed now, per §22's decision; does not need to wait for 1–4.
6. **Follow-up verification reads** (flagged throughout as "unverified," not gaps): the `ASSIGN_MEDIATOR` all-consent/fee-paid guard (§9/§12), refund-prevention logic (§19), expenditure-side Accounts Register columns (§20), online-mediation "prior permission" recording (§17) — each is a short, targeted read, not a redesign, and should happen before any of those specific areas are called confirmed MATCH.
7. **Annexure-A/D/E format reconciliation** — blocked on TNSLSA supplying the actual annexure pages; not actionable from the current source documents.

---

## 25. Explicit List of Things That Should NOT Be Changed

- **The five existing mediator records and their `ADVOCATE MEDIATOR` classification** (Ravikumar, Rajesh, Narayanan Kutty, Latha Subramaniam, K. Viswanath) — neither source document disputes this.
- **`last_number = 118` / the next number `PIM/119/2026`** — not consumed, not altered, by this audit or by anything recommended in it.
- **The staff-operated model (no Secretary/Judge login-and-approve gate)** — confirmed SOP-compatible in §14; do not reinstate `SECRETARY_APPROVAL_PENDING` as a blocking gate.
- **T7's non-starter state machine and reason codes** — per explicit instruction, and confirmed to already match clause 6.
- **The application fee (₹1,000) and mediation fee slab table** — both already exactly correct; do not "re-verify by replacing" with a re-derived table.
- **The `internal_60_day_date` / 60-day internal target mechanism** — it is a different, still-valid control from the SOP's statutory 3-month clock; do not delete or repurpose it when building the statutory-clock module (§15) — they must coexist as two distinct fields.
- **Batch 5H-b's PIM-numbering allocator and its concurrency design** — confirmed compatible with clause 4; no re-architecture needed.
- **Annexure-A's intake form shape** — not redesigned, per explicit instruction, pending the actual annexure text.

---

*End of audit. No migrations applied, no code modified, no data modified, no commit/stage/push performed, no PIM number consumed, dlsa-mis not touched.*
