# PIM SOP 2026 — Frozen Business Rules

**Status: frozen project rules, accepted 2026-10-06, following review of `docs/phase6-pim-sop-2026-reconciliation-audit.md`.** These are binding constraints on all subsequent batches until explicitly revisited — not a new audit, not an implementation record. Implementation work resulting from these rules is tracked in its own batch documents (e.g. the SOP limitation module, the Nodal Officer model) as each is actually built.

1. **The existing overall PIM workflow architecture remains valid.** No batch should treat the SOP as grounds for a structural redesign of the `status_master` pipeline or the module boundaries established through Phase 6.

2. **The ₹1,000 application fee and the mediation-fee slab table remain unchanged.** Both were confirmed exact SOP conformity in the audit (clauses 3 and 19 cols 2–3). No batch should "re-verify by replacing" either with a re-derived table.

3. **`internal_60_day_date` is an internal operational / non-starter-escalation target. It is NOT the SOP limitation/completion period.** The two must never be conflated, merged, or have one repurposed to stand in for the other.

4. **A separate SOP limitation module will later implement:**
   - 3 months from application date;
   - exclusion of the defect-rectification period (clause 4);
   - a possible further 2 months with the consent of both parties (clause 13).
   This module is **not yet built**. `pim_cases.statutory_due_date`, `extension_date`, `extended_due_date` already exist as columns for it. Do not repurpose `internal_60_day_date` for this when it is built.

5. **The clause 5(a) affidavit/contact-verification requirement is a genuine additional requirement**, not already satisfied by existing `pim_parties.contact_phone`/`email`. It will be implemented in the appropriate intake/service slice — not yet scheduled as of this freeze.

6. **Clause 5(b) private notice requires an Authority-permission decision model.** When built, it must record who decided, when, and the stated sufficient reason — never represented as a plain staff checkbox/flag with no underlying decision record.

7. **Do not restore Secretary/Judge software approval gates.** The staff-operated model (no `SECRETARY_APPROVAL_PENDING`-style blocking login/approve step) is confirmed SOP-compatible and stays as-is.

8. **A configurable Nodal Officer model will later be introduced**, distinguishing:
   - legal/administrative responsibility (the SOP's "Nodal Officer," a designation of accountability for the proceeding);
   - the software data-entry operator (whichever staff account actually performs an action).
   These are deliberately different concepts; the model must not collapse them back into a single login-gated role.

9. **The existing five Advocate-Mediators (Ravikumar, Rajesh, Narayanan Kutty, Latha Subramaniam, K. Viswanath) remain unchanged** — no record, name, or classification is to be altered absent a source document that specifically disputes one of them.

10. **The mediator registry must eventually be able to add retired, TNMCC-empanelled Judicial Officer-Mediators** once TNSLSA communicates the official list. `mediators.category` is already free-text (not an enum), so no schema change is anticipated when that list arrives — only new rows.

11. **Mediator honorarium (SOP clause 19, cols 4–5) is separate from mediation fee and is new functionality.** It does not exist in the codebase today (confirmed: zero occurrences of "honorarium" anywhere in `lib/`). Do not conflate its implementation with `lib/pim-mediation-fee.js`'s existing, already-correct mediation-fee calculation.

12. **Honorarium applicability is determined from the mediator's nomination date, not the case filing date.** Per the TNSLSA instruction letter (P.N.5996/2026, 30.09.2026): nomination on/after 2026-10-01 → new SOP honorarium rules apply. Nomination before that date → the prior (pre-SOP) rate, which is not recoverable from the two source documents on file and would need to be sourced separately if ever required for old cases. When the honorarium module is eventually built, it must key off mediator-assignment/nomination date, never `received_date`, `application_date`, or `registration_date`.

13. **`PIM/119/2026` (current `pim_number_sequences.last_number = 118` for year 2026) is not to be consumed by anything other than genuine production PIM-number assignment.** Every test suite in this project follows the established doctrine of never calling the PIM-number allocator against the real current year.

---

## Provenance

These rules were accepted as stated, without modification, following the reconciliation audit. They are referenced by, but intentionally kept separate from, `docs/phase6-batch5i-form2-migration.md` and any future SOP-driven implementation batch, so that "what was decided" (this document) stays distinct from "what was built and when" (each batch's own document).
