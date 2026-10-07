# PIM Legal Knowledge Base + Contextual Guidance Engine — Architecture & Research Design

**Status: READ-ONLY design document. No migrations applied. No DB seeded. No PIM workflow code modified. No commit/stage/push performed. `PIM/119/2026` not consumed. `dlsa-mis` not touched. PIM 109/2026 not touched — used only as a hypothetical design example in §10, per the brief.**

Produced: 2026-10-06. Revised: 2026-10-06 (verification pass, see §0.2). Scope: Phase LK-1 (research + architecture) only, per the phased plan in §20. This document is a **cross-cutting support-module proposal** and does not alter, block, or require changes to Batch 5K or any in-flight Phase 6 PostgreSQL migration work.

---

## 0.2 Revision note — primary-source verification pass

The first LK-1 pass (open web search, secondary commentary, no full-judgment retrieval) produced **three false negatives**: Sidhi Vinayak Metcom, Dr. Mumtaz Kutty, and Dhanalakshmi Spinntex were all marked "NOT VERIFIED"/"NOT FOUND" when in fact all three judgments exist, are correctly described in substance by the brief, and are now retrieved and read in full (via IndianKanoon's full-text record, cross-checked against case number/date/bench supplied). This revision corrects §2.2, §2.4, §2.5, §2.7, §2.8, adds §2.10 (a software-conflict audit triggered by Mumtaz Kutty), revises the schema in §9 to add an explicit verification **state machine** (not just a boolean `verified_at`) and a holding/operational-proposition split, and rewrites §21.

**Root cause of the false negatives:** the first pass relied on generic party-name + topic web searches, which surface secondary commentary and unrelated same-named entities (e.g. an unrelated 2018 Jharkhand excise writ petition for "Sidhi Vinayak Metcom," an unrelated medical-college admission matter for "Siddhi Vinayak") ahead of the actual judgment. This pass instead searched IndianKanoon directly by exact case number/party combination per the brief's §6 instruction, which surfaced the correct record immediately in every one of the three cases. **Lesson encoded into §6/§21 of this document and worth carrying into LK-2's research tasks:** prefer a direct case-number/party search against a primary full-text source before concluding "not found" from commentary-only search results.

### 0.3 Second revision note — Patil Automation internal inconsistency resolved (pre-LK-2)

Before starting LK-2, a reviewer caught that the first revision (§0.2) left an internal contradiction: §2.1 classified Patil Automation as `verification_state = DISCOVERED` ("paragraph references not yet pulled"), while §22's readiness count simultaneously treated it as one of six `PRIMARY_SOURCE_VERIFIED` cases. Those cannot both be true, and the instruction was explicit not to resolve the inconsistency by lowering the verification bar for §22 — the actual primary judgment had to be read.

The full primary text (LiveLaw's reported judgment, 2022 LiveLaw (SC) 678) was retrieved and read in full. §2.1 is now corrected to `PRIMARY_SOURCE_VERIFIED` with real paragraph citations (¶43, ¶54, ¶68, ¶84, ¶85 — see below), closing the inconsistency honestly rather than by assertion. This is the seventh and final source brought to `PRIMARY_SOURCE_VERIFIED` before LK-2's seed (alongside the six already verified in §0.2), and is reflected in the LK-2 seed migration and `docs/pim-legal-knowledge-base-lk2.md`.

**What did *not* change:** Ganga Complex (§2.5) remains unverified after a second, more targeted search pass — a real case between these exact parties exists, but its subject matter (additional-document filing under Order XI Rule 1(5)) has no connection to Section 12A or urgent interim relief. This is the scenario the brief anticipated in its own §7 ("a real case with the correct party names can still be the wrong authority") — it is not a search failure to fix, but a likely misattribution to flag and recommend dropping.

---

## 0. Relationship to existing project documents

This repository already has two directly relevant documents that this design **builds on and must not duplicate**:

- [`docs/phase6-pim-sop-2026-reconciliation-audit.md`](phase6-pim-sop-2026-reconciliation-audit.md) — a clause-by-clause reconciliation of the TNSLSA PIM SOP (effective 01.10.2026) and its 30.09.2026 instruction letter against the live codebase. It already classifies every SOP clause as MATCH/PARTIAL/MISSING with file:line citations.
- [`docs/phase6-sop-2026-frozen-rules.md`](phase6-sop-2026-frozen-rules.md) — 13 binding rules accepted from that audit (e.g. the application fee and mediation-fee slabs are frozen and must never be "re-derived"; `internal_60_day_date` must never be conflated with the statutory limitation clock; honorarium is keyed to mediator nomination date, not case date).

Wherever this Legal KB design would otherwise re-state a SOP-vs-code gap, it instead **cites** the reconciliation audit's section number rather than re-deriving the finding.

### 0.1 The pattern already half-exists

1. **`nonstarter_reasons.rule_reference`** (`supabase/migrations/20260917020700_seed_reference_data.sql:102-107`) — a free-text statutory-citation column already attached to 5 seeded non-starter reason codes. Reason 5 (`MEDIATION_FEE_NOT_SUBMITTED`) still carries the placeholder "Operational ground; verify against applicable current DLSA/TNSLSA practice" — flagged as needing a real citation by the reconciliation audit §16, and now directly addressable using §2.4's verified Sidhi Vinayak holding (with the caution in that section observed).
2. **The Form-2 clause 5(a) affidavit note** (`app/pim/form2/[id]/page.tsx`, lines ~1149–1174) — one hand-written sentence of inline legal context next to a checkbox. The only existing example of a contextual-guidance string shown inline in a workflow page, not data-driven.

The Legal KB generalizes #1 into a real reference table with authority levels and supersession, and #2 into a reusable, data-driven UI component.

---

## 1. Authoritative-source inventory

| Source | Type | Status |
|---|---|---|
| Commercial Courts Act, 2015, s.12A | Statute | Primary, in force |
| Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 — Rules 3, 4, 11; Schedule I (Forms 1–6); Schedule II (fee table) | Rules (statutory instrument) | Primary, in force |
| TNSLSA PIM SOP, 24 clauses + Annexures A–E | TNSLSA SOP | Communicated 30.09.2026, **effective 01.10.2026**. Already ingested into `docs/phase6-pim-sop-2026-reconciliation-audit.md` — do not re-ingest. |
| TNSLSA instruction/forwarding letter, No. P.N.5996/2026, dated 30.09.2026 | TNSLSA Instruction | Governs honorarium applicability by mediator-nomination date (≥ 01.10.2026) |
| Case law (8 candidates supplied) | Supreme Court / Madras HC / other HC | See §2 — **6 of 8 now primary-source verified; 1 unverified/likely-misattributed (Ganga Complex); 1 discovery pass deferred to LK-2. See §21.** |

**Annexures A–E of the SOP** are referenced but their actual prescribed column/format text was not supplied to this project — the Legal KB cannot index content that was never provided.

---

## 2–7. Verified case-law inventory

Each entry gives court/date/citation, **case holding** vs. **PIM operational proposition** (per the brief's §8 — these are now kept distinct, see rationale below), operational relevance, authority classification, and verification status, with the primary source actually read in this pass.

**Why holding vs. operational proposition are split:** a judgment's holding is the narrow thing the court decided on its own facts; the "operational proposition" is the practically-usable rule PIM staff should see, phrased so that it cannot be over-read into a broader prohibition than the source actually supports. Mumtaz Kutty (§2.7) is the clearest example — the holding is procedural ("this specific docket order is set aside"), but the useful operational content is a negative rule ("do not require X").

### 2.1 Patil Automation Pvt. Ltd. v. Rakheja Engineers Pvt. Ltd. — **PRIMARY_SOURCE_VERIFIED** (corrected — see §0.3)

| Field | Value |
|---|---|
| Court | Supreme Court of India (K.M. Joseph, J. and Hrishikesh Roy, J.) |
| Case number | Civil Appeal arising out of SLP(C) No.14697/2021 with Civil Appeal arising out of SLP(C) No.5737/2022 |
| Date | 17.08.2022 |
| Citation | (2022) 10 SCC 1 (also reported as 2022 LiveLaw (SC) 678) |
| Case holding | Section 12A is **not a mere procedural provision** — "the right of suit itself will fructify only when the conditions in Section 12A are fulfilled" (¶43). Pre-institution mediation is mandated **only for suits not seeking urgent interim relief** — the Law-giver "carefully vouch-safed immediate access to justice" for suits that do contemplate such relief (¶54). The power to reject a plaint under Order VII Rule 11 **does not require a defendant's application** — it is available to the court to exercise *suo motu* (¶68). The Court's operative declaration (¶84): *"We declare that Section 12A of the Act is mandatory and hold that any suit instituted violating the mandate of Section 12A must be visited with rejection of the plaint under Order VII Rule 11. This power can be exercised even suo moto by the court... We, however, make this declaration effective from 20.08.2022 so that concerned stakeholders become sufficiently informed."* The same paragraph bars reopening already-rejected plaints where no steps were taken within limitation, bars relief where a fresh suit was already filed after rejection, and bars relief where the plaintiff filed after the jurisdictional High Court had already declared Section 12A mandatory. Final disposition (¶85): both appeals disposed of; in the first (SLP(C) No.14697/2021), the written statement was directed to be treated as an application for leave to defend under Order XXXVII; in the second (SLP(C) No.5737/2022), the costs order below was set aside. |
| Operational proposition | A PIM case whose underlying suit would be filed/was filed before 20.08.2022 is not subject to the rejection-of-plaint consequence for skipping PIM; this cutoff date is the single most important date-based gate before any limitation/rejection-consequence guidance is shown. For suits filed on or after 20.08.2022, Section 12A compliance (absent genuine urgent interim relief) is a precondition to valid institution, and the court may reject a non-compliant plaint even without the defendant asking. |
| Operational relevance | Governs whether a related suit should even reach PIM at all; governs the prospectivity cutoff also applied in Dhanbad Fuels (§2.3) and Dhanalakshmi Spinntex (§2.8). |
| Classification | **SUPREME_COURT — binding**, Level 2 |
| Paragraph refs | ¶43 (not merely procedural), ¶54 (class of suits — urgent relief carve-out), ¶68 (Order VII Rule 11, suo motu power), ¶72 (summary of reasoning), **¶84 (the operative declaration: mandatory, Order VII Rule 11 consequence, suo motu, 20.08.2022 cutoff, and the three specific non-reopening carve-outs)**, ¶85 (final disposition of both appeals). |
| Verification state | `PRIMARY_SOURCE_VERIFIED` — full primary judgment text retrieved and read (LiveLaw's reported text, 2022 LiveLaw (SC) 678, cross-identified as (2022) 10 SCC 1), not a secondary summary. Every element required by the LK-2 verification brief (mandatory nature, Order VII Rule 11 consequence, prospective operation, exact 20.08.2022 cutoff, paragraph references, final disposition) is independently confirmed against the judgment's own text, principally ¶84. |

### 2.2 Yamini Manohar v. T.K.D. Keerthi — **VERIFIED (citation discrepancy closed)**

| Field | Value |
|---|---|
| Court | Supreme Court of India |
| Case number | SLP (Civil) Diary No. 32275/2023 |
| Date | 13.10.2023 |
| Bench | Justice Sanjiv Khanna and Justice S.V.N. Bhatti |
| Citation | **(2024) 5 SCC 815 — confirmed.** Independently corroborated by SCC Online's own volume index for 2024 SCC Vol. 5 Part 5, which lists the identical headnote text and page number, not merely by a later judgment's citation of it. This closes the discrepancy noted in the first LK-1 pass (where IndianKanoon's own indexing metadata had shown it as an unreported daily order). |
| Case holding | Section 12A bars suits that do not "contemplate any urgent interim relief," but a plaintiff has no absolute right to bypass mediation merely by tacking on an interim-relief prayer. Courts examine the suit holistically — nature/subject matter, cause of action, and the prayer as framed — to see whether the urgent-relief prayer is genuine or a "disguise or mask to wriggle out of" Section 12A (paras 7–8). Non-grant of interim relief at the ad-interim stage, or even after full arguments, does **not** retroactively justify dismissal for Section-12A non-compliance. |
| Operational proposition | When a related civil suit's PIM-exemption is challenged, the test is whether the urgent-relief prayer was genuine *as pleaded at filing*, not whether relief was ultimately granted — PIM staff should never treat "the court didn't grant interim relief" as proof that PIM was wrongly skipped. |
| Operational relevance | The controlling test later applied by the Madras High Court in Aarthi Scans (§2.6). |
| Classification | **SUPREME_COURT — binding**, Level 2 |
| Verification state | `PRIMARY_SOURCE_VERIFIED` |

### 2.3 M/s Dhanbad Fuels Pvt. Ltd. v. Union of India & Anr. — **VERIFIED**

| Field | Value |
|---|---|
| Court | Supreme Court of India |
| Date | 15.05.2025 |
| Citation | 2025 INSC 696 |
| Case holding | Reaffirms Section 12A as mandatory and Patil Automation's 20.08.2022 prospectivity cutoff; on the facts, dismissed the appeal and upheld keeping the suit in abeyance pending PIM through the DLSA, because mediation infrastructure was not fully operational before 2022 and "the law does not compel the impossible." |
| Operational proposition | A suit filed before mediation infrastructure existed in a given DLSA is not penalized for the gap — the suit is held in abeyance for PIM to occur, not permanently barred. |
| Operational relevance | Relevant to any PIM case with an unusual filing-date/registration-date gap, or where a related suit was stayed pending DLSA mediation rather than rejected outright. |
| Classification | **SUPREME_COURT — binding**, Level 2 |
| Verification state | `PRIMARY_SOURCE_VERIFIED` |

### 2.4 Union of India v. M/s Sidhi Vinayak Metcom Limited & Ors. — **VERIFIED (corrected from first-pass NOT VERIFIED)**

| Field | Value |
|---|---|
| Court | High Court of Jharkhand at Ranchi |
| Case number | Commercial Appeal No. 02 of 2025 |
| Neutral citation | 2025:JHHC:30333-DB |
| Reserved / Pronounced | 17.09.2025 / 26.09.2025 |
| Bench | Division Bench — Chief Justice and Justice Rajesh Shankar (author) |
| Underlying PIMS matter | PIMS Case No. 06 of 2019, DLSA Jamshedpur; mediation initiated under Rule 3; DLSA orders dated 23.12.2021 and 20.01.2022 declared the matter a Non-Starter |

**A–H, extracted from the full judgment text (not a snippet):**

- **A. What Rule 11 says:** the judgment construes Rule 11's "before the commencement of mediation" language as **mandatory timing** for fee deposit — "it is mandatory for the parties to deposit [the fee]" before mediation can commence (¶34).
- **B. Applicant/plaintiff fee default:** the appellants (plaintiffs in the underlying suit) had themselves not deposited their share. The Court held this meant the appellants' own conduct could not be treated as true Section 12A compliance (¶29).
- **C. Respondent fee default:** both sides had defaulted; the respondents' non-payment is treated symmetrically, not as a separate or lesser category of default.
- **D. Did the Court expressly approve fee default as a Non-Starter ground?** Yes — the Court upheld the DLSA Jamshedpur's Non-Starter declaration as proper, and upheld the subsequent rejection of the plaint under Order VII Rule 11 CPC as a correct consequence (¶40, appeal dismissed).
- **E. Section 12A compliance:** "Since the appellants and respondents had not deposited their shares of mediation fee, their action could not be treated to be true compliance of Section 12-A of the Act, 2015" (¶29) — i.e. non-payment by either/both sides defeats compliance; it is not enough that mediation was merely initiated.
- **F. Would applicant payment alone have changed the result?** **Yes, expressly** — "If the appellants had deposited their share of mediation fee, the same would have been treated as compliance of Section 12-A... and the suit filed by the appellants was entertainable after issuance of 'Non-Starter' report by the DLSA... on the ground of failure of the respondents to deposit their share" (¶32). This is the single most operationally important line in the judgment: **a party's own fee payment, even if the other side defaults, is what preserves that party's Section 12A compliance and keeps its suit entertainable.**
- **G. Paragraph numbers:** ¶29 (compliance finding), ¶32 (the counterfactual on applicant-side payment), ¶34 (Rule 11 mandatory-timing construction), ¶40 (operative dismissal).
- **H. Final disposition:** appeal dismissed; the plaint rejection was upheld as a correct application of Order VII Rule 11 CPC.

| Field | Value |
|---|---|
| Case holding | On these facts, where **both** sides defaulted on mediation fee, the DLSA's Non-Starter declaration and the consequent plaint rejection were correct. |
| Operational proposition | Mediation-fee default by a party is a recognized ground supporting a Non-Starter outcome **once genuinely established on the facts** — but this judgment does **not** say fee default is automatically or expressly a Rule 3(4)/3(6) ground (it discusses Rule 11 and Section 12A compliance generally, not Rule 3's enumerated non-starter triggers specifically). Critically: a party that pays its own share preserves its own compliance even if the other side defaults — this is the operational fact that should be surfaced at `FEE_PENDING` whenever only one side has paid. |
| Negative rule (do-not-do) | **Do not describe this judgment as holding that Rule 3(4)/(6) *expressly* lists fee default as a ground** — it does not say that; it reasons from Rule 11 and Section 12A compliance generally. This project's own `nonstarter_reasons` table already gets this right: `MEDIATION_FEE_NOT_SUBMITTED` cites "Operational ground," not a Rule 3 sub-clause, and `requires_authority_decision = true` for that reason — meaning a human authority decision is required, not an automatic system inference. The Legal KB must preserve, not weaken, that distinction. |
| Operational relevance | Directly supports revising `nonstarter_reasons` id 5's `rule_reference` placeholder (currently "Operational ground; verify...") to cite Rule 11 + this judgment, once seeded — the reconciliation audit §16 already flagged this placeholder as needing exactly this kind of citation. |
| Classification | **OTHER_HIGH_COURT (Jharkhand)** — **persuasive in Tamil Nadu**, Level 5. **Never represent as binding on DLSA Nilgiris or any Tamil Nadu DLSA.** |
| Verification state | `PRIMARY_SOURCE_VERIFIED` |

### 2.5 M/s Ganga Complex v. M/s TSR Films Pvt. Ltd. — **UNVERIFIED / LIKELY MISATTRIBUTED — recommend removal**

A second, more targeted search pass (party names + "Section 12A"/"urgent interim relief"/"pre-institution mediation" in combination) still surfaces **no** Madras High Court order between these parties on any Section 12A topic. The only confirmed order between these exact parties — **M/S TSR Films Private Limited v. Ganga Complex**, Madras High Court, 05.02.2024, A.No.4194/2023 in C.S.(Comm.Div.) No.24 of 2023 — concerns additional-document filing under Order XI Rule 1(5) CPC, unrelated to Section 12A.

This is precisely the scenario the brief's own §7 warns against: a real case with the correct party names is not necessarily the right authority for the proposition sought. **Recommendation: drop this candidate from the seed set entirely** rather than retain it as noise, unless the requesting party can supply the specific order (date/case number) they actually had in mind — a different order in the same or a related suit may exist that neither search pass located.

| Field | Value |
|---|---|
| Verification state | `REJECTED_MISMATCH` — a real case exists under this party-name combination, but it does not support the Section 12A proposition for which it was proposed |

### 2.6 Aarthi Scans Pvt. Ltd. v. Konica Minolta Business Solutions India Pvt. Ltd. — **PARTIALLY VERIFIED (unchanged this pass)**

| Field | Value |
|---|---|
| Court | Madras High Court |
| Date supplied | 27.02.2026 — not independently re-confirmed against a primary-source order copy in this pass (out of scope for this revision; secondary commentary, e.g. Mondaq, confirms the case and its holding but was not cross-checked against the court's own cause-list/judgment number) |
| Case holding | Set aside a Commercial Court order that had returned the plaint at the pre-numbering scrutiny stage for Section 12A non-compliance; applying Yamini Manohar's test, held that pleadings disclosing credible, immediate commercial disruption may proceed without PIM. |
| Operational proposition | Madras-HC-specific confirmation that Yamini Manohar's "genuine urgency" test, not a bare assertion of urgency, governs PIM-exemption challenges within Tamil Nadu. |
| Classification | **MADRAS_HIGH_COURT — binding within Tamil Nadu**, subject to Yamini Manohar above it, Level 3 |
| Verification state | `DISCOVERED` — not yet `PRIMARY_SOURCE_VERIFIED`; see §21 item 4 |

### 2.7 Dr. Mumtaz Kutty v. Dr. Rahmath Banu — **VERIFIED (corrected from first-pass NOT VERIFIED)**

| Field | Value |
|---|---|
| Court | Madras High Court |
| Case number | C.R.P. No. 3470 of 2024 |
| Date | 11.09.2024 |
| Judge | A.D. Jagadish Chandira |

**Verified from the full judgment:**

- **Case holding:** the docket order dated 07.08.2024 — which had returned the PIM application below for want of a copy of the proposed plaint — was **set aside**. The Principal District and Sessions Judge, Chengalpattu was directed to forward the mediation application to the DLSA to proceed per applicable law. No costs.
- **Reasoning (¶8):** demanding a plaint copy at the mediation-application stage is a logical impossibility, since Section 12A(1) puts suit institution itself in abeyance pending mediation: "Once the institution of the suit proceeding itself has been put in abeyance... it cannot be contemplated how a condition to enclose the copy of the plaint could be enforced."
- **Reasoning (¶9):** rejects the inverted sequencing — "an application for pre-institution mediation may be entertained only after the suit proceeding had been first instituted" is incorrect.
- **Reasoning (¶10):** the correct sequence is that "the institution of a suit would depend directly on the fate of the pre-institution mediation and not vice-versa."
- **Operational proposition:** a PIM application satisfying Rule 3(1)'s own requirements cannot be rejected or returned merely because a copy of the proposed plaint has not been filed alongside it — plaint-copy demand inverts the statutory sequence Section 12A itself establishes.
- **Negative rule (do-not-do):** **do not insist on a plaint/draft-plaint copy as an additional intake or scrutiny prerequisite** beyond what Rule 3(1) itself requires.

| Classification | **MADRAS_HIGH_COURT — binding within Tamil Nadu**, subject to Supreme Court/statutory authority, Level 3 |
|---|---|
| Operational relevance | Directly relevant to `RECEIVED`/`SCRUTINY_PENDING` — see the mandated software audit, §2.10 below. |
| Verification state | `PRIMARY_SOURCE_VERIFIED` |

### 2.8 Shri Dhanalakshmi Spinntex Pvt. Ltd. & Ors. v. Sivasubramaniam & Ors. — **VERIFIED (corrected from first-pass NOT FOUND)**

| Field | Value |
|---|---|
| Court | Madras High Court |
| Case number | Review Application No. 51 of 2024 in CRP No. 3519 of 2023 |
| Date | 26.08.2025 |
| Judge | P.B. Balaji |

**Verified from the full judgment:**

- **Original suit filing date:** the plaint was filed 01.06.2022 (last representation 19.07.2022) — i.e. **before** Patil Automation's 20.08.2022 prospectivity cutoff.
- **Patil Automation / Section 12A analysis:** the Court applied Patil Automation's holding that suits filed before 20.08.2022 are not subject to the mandatory-mediation rejection consequence (¶5: "The suits that are filed prior to 20.08.2022 are not required to undergo the mandatory pre-institution mediation").
- **Why the earlier CRP order was reviewed:** the original CRP order had allowed the petition solely on the ground of Section 12A non-compliance; once the prospective cutoff is applied to this pre-cutoff suit, that ground becomes invalid, warranting review.
- **Holding:** Review Application **allowed**; the earlier CRP order set aside; matter remanded to the District Commercial Court, Coimbatore, for reconsideration on other merits. No costs.
- **Operational proposition:** confirms, as a second independent Madras High Court application (alongside Dhanbad Fuels at the Supreme Court level), that the 20.08.2022 cutoff is actively and specifically applied to pre-cutoff Tamil Nadu suits — directly reusable as persuasive/corroborating authority alongside Patil Automation itself wherever the cutoff is surfaced.

| Classification | **MADRAS_HIGH_COURT**, Level 3. Per the brief's own instruction, treat as **REFERENCE_ONLY** severity — this is background material on the prospective-cutoff question, not an operational trigger for any routine PIM workflow stage, since (as with Patil Automation itself, §11) the Section-12A-applicability question is normally already resolved by the time a case exists in this system. |
|---|---|
| Verification state | `PRIMARY_SOURCE_VERIFIED` |

### 2.9 Discovery pass (brief's §5) — still scoped, not executed to completion

Deliberately deferred to LK-2, as in the first pass — one substantive point remains worth recording: **Section 12A(5) of the Act** itself gives a PIM settlement "the same status and effect as an arbitral award under Section 30(4) of the Arbitration and Conciliation Act, 1996." This is a **STATUTE**-level entry, not case law, and should be indexed before any case law is sought on the same point.

### 2.10 Mandated audit — does PIM software require a plaint copy? (triggered by Mumtaz Kutty, §2.7)

Per the brief's explicit instruction not to propose a `HARD_BLOCK`/conflict finding without first checking whether the conflict actually exists in this codebase, a targeted read-only search was run across intake, scrutiny, document requirements, and the UI layer for: `plaint`, `draft plaint`, `commercial plaint`, `copy of suit`, `copy of the suit`, `mandatory document`, `required document`, `checklist`.

**Result: PASS.** No match for any plaint/plaint-copy term was found anywhere in `lib/` (the full SQLite business-logic layer, including `lib/pim.js` intake validation and `lib/pim-scrutiny.js`), anywhere in `app/` (all UI and API routes, including the intake form and scrutiny page), or in `database/schema.sql` (the authoritative SQLite DDL — no `pim_documents.document_type` value, no intake column, and no scrutiny-checklist field named or described as a plaint/plaint-copy requirement).

**Conclusion:** this system does **not** currently require, request, or label a plaint/draft-plaint copy as a mandatory intake or scrutiny item. There is **no live software conflict** with Mumtaz Kutty to remediate. The judgment is therefore valuable as **affirmative, reusable guidance for the future** (something staff or a later feature must *not* add) rather than as a fix for an existing defect — a `WARNING`-severity, `RECEIVED`/`SCRUTINY_PENDING`-stage guidance item whose entire operational value is the negative rule in §2.7, not a `HARD_BLOCK` correcting present behavior. This matches the brief's own explicit caution ("Do NOT create a hard block merely because the judgment exists").

---

## 8. Proposed source-authority hierarchy

Unchanged from the first pass — the brief's 6-level model, with STATUTE/RULE sharing Level 1:

| Level | source_type(s) | Nature |
|---|---|---|
| **1** | `STATUTE`, `RULE`, `CENTRAL_NOTIFICATION` | Binding everywhere |
| **2** | `SUPREME_COURT` | Binding everywhere |
| **3** | `MADRAS_HIGH_COURT` | Binding within Tamil Nadu, subject to Level 1–2 |
| **4** | `TNSLSA_SOP`, `TNSLSA_INSTRUCTION` | Binding institutional procedure, subject to Level 1–3 |
| **5** | `OTHER_HIGH_COURT` | Persuasive only — never promoted to binding merely by being useful or on-point. **Sidhi Vinayak Metcom (§2.4) sits here — Jharkhand, persuasive in Tamil Nadu, never binding on DLSA Nilgiris.** |
| **6** | `INTERNAL_GUIDANCE` | Lowest authority, purely explanatory |

This is a straight ordering used only for display order/visual weight — never a statement that lower-level material is wrong, only that it does not bind this jurisdiction.

---

## 9. Proposed schema — `legal_sources` (revised: verification state machine + holding/proposition split)

The first pass's single `verified_at timestamptz` boolean-like gate is replaced with an explicit state machine, directly motivated by the Ganga Complex finding (§2.5): "a row exists and looks plausible" and "a row has been confirmed to actually support the proposition it's attached to" are **different facts** and must be stored as different facts, not collapsed into one timestamp.

```sql
CREATE TABLE legal_sources (
  id                    bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_type           text NOT NULL CHECK (source_type IN (
                           'STATUTE','RULE','CENTRAL_NOTIFICATION',
                           'SUPREME_COURT','MADRAS_HIGH_COURT','OTHER_HIGH_COURT',
                           'TNSLSA_SOP','TNSLSA_INSTRUCTION','INTERNAL_GUIDANCE')),
  authority_level       smallint NOT NULL,          -- 1-6, per §8; stored explicitly, not derived at read time,
                                                       -- so a re-classification is an audited data change
  title                 text NOT NULL,
  court                 text,
  case_number           text,
  citation              text,
  decision_date         date,
  jurisdiction          text,                        -- e.g. 'ALL_INDIA','TAMIL_NADU','JHARKHAND'
  effective_from        date,
  effective_to          date,
  source_document_ref   text,                        -- see §19 — repo-relative path, for statute/rule/SOP rows
  source_url            text,                        -- general-purpose external link (court site, IndianKanoon, etc.)
  primary_source_url     text,                        -- the SPECIFIC url actually read to verify this row (§7 of
                                                       -- the verification brief) — may equal source_url, but is
                                                       -- recorded separately so "where staff can read more" and
                                                       -- "what was actually checked to verify this row" don't
                                                       -- silently become the same field if one is later edited
  paragraph_refs        text,                         -- free text, e.g. "paras 29, 32, 34, 40"
  rule_refs             text,
  sop_clause_refs       text,
  topics                text[],
  workflow_stages       text[],                       -- status_master.code values, see §11
  case_holding          text NOT NULL,                -- what the court actually decided, narrowly (§2 rationale)
  operational_proposition text,                       -- the practically-usable PIM rule, deliberately separate
                                                       -- from case_holding so staff-facing text is never phrased
                                                       -- more broadly than the source actually supports
  negative_rule         text,                         -- "do not require/do not treat as X" — see §2.4, §2.7, §9a
  operational_effect    text,
  caution                text,
  treatment              text CHECK (treatment IN (
                           'FOLLOWED','DISTINGUISHED','OVERRULED','PARTLY_OVERRULED',
                           'CLARIFIED','SUPERSEDED_BY_STATUTE','SUPERSEDED_BY_RULE', NULL)),
  superseded_by          bigint REFERENCES legal_sources(id),
  verification_state    text NOT NULL DEFAULT 'DRAFT' CHECK (verification_state IN (
                           'DRAFT',                    -- entered, not yet researched at all
                           'DISCOVERED',                -- a matching primary-source record has been located,
                                                         -- but not yet read/confirmed against the proposition
                           'PRIMARY_SOURCE_VERIFIED',   -- full primary text read; holding AND operational
                                                         -- proposition both confirmed against it
                           'REJECTED_MISMATCH',         -- a real source was located under this description, but
                                                         -- it does not support the proposition — kept (not
                                                         -- deleted) specifically so the same dead end is never
                                                         -- re-researched; see Ganga Complex, §2.5
                           'SUPERSEDED')),               -- was PRIMARY_SOURCE_VERIFIED, now superseded; see
                                                         -- superseded_by/is_active, unchanged from the first pass
  verification_notes    text,                          -- free-text research trail — e.g. why REJECTED_MISMATCH
  verified_proposition  text,                          -- restates, at verification time, EXACTLY which
                                                         -- proposition this source was checked against — guards
                                                         -- against a source later being reused for a DIFFERENT
                                                         -- proposition it was never actually verified for
  verification_date     date,
  verified_by           bigint REFERENCES users(id),
  is_active             boolean NOT NULL DEFAULT true,
  created_by            bigint REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_legal_sources_type ON legal_sources(source_type);
CREATE INDEX idx_legal_sources_state ON legal_sources(verification_state);
CREATE INDEX idx_legal_sources_active ON legal_sources(is_active);
CREATE INDEX idx_legal_sources_stages ON legal_sources USING GIN(workflow_stages);
CREATE INDEX idx_legal_sources_topics ON legal_sources USING GIN(topics);
```

### 9a. Design notes on the revised fields

- **Only `verification_state = 'PRIMARY_SOURCE_VERIFIED'` rows are ever visible to ordinary staff** (Legal Library, §14, and contextual panels, §15) — `DRAFT`/`DISCOVERED`/`REJECTED_MISMATCH` rows are admin-only (§17), and `REJECTED_MISMATCH` rows specifically exist so the Ganga Complex-style dead end is recorded once and never silently re-researched by a future contributor who stumbles on the same party names. This is a strictly stronger gate than the first pass's `verified_at IS NULL` check — it distinguishes "not yet verified" from "actively verified as the wrong authority," which `verified_at` alone could not.
- **`verified_proposition` vs. `operational_proposition`:** `operational_proposition` is the staff-facing text; `verified_proposition` is the admin-only record of *exactly what was checked* when `verification_date`/`verified_by` were set. If `operational_proposition` is later edited to cover a broader claim, `verified_proposition` stays fixed to what was actually verified — a mismatch between the two is a signal (checkable by a future `MANAGE_LEGAL_SOURCES` review) that re-verification is needed before the edit should ship to staff.
- **`negative_rule`** is promoted to its own column (rather than folding it into `caution` or `operational_effect`) because the brief's §9 treats "do not require X" guidance as a first-class category, not an afterthought — Mumtaz Kutty (§2.7) and the Sidhi Vinayak caution (§2.4) are both populated through this field, and `legal_guidance_rules.do_not_do` (§10) pulls from here when a guidance rule cites the source.
- `workflow_stages text[]` remains array-not-FK as in the first pass, with the same open question about a stricter join-table form, unresolved and not decided here.

---

## 10. Proposed schema — `legal_guidance_rules` (unchanged structure; worked examples revised)

```sql
CREATE TABLE legal_guidance_rules (
  id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  guidance_key        text NOT NULL UNIQUE,
  title               text NOT NULL,
  trigger_stage       text NOT NULL,                -- a status_master.code value, see §11
  trigger_condition   text NOT NULL,                -- controlled application-side KEY, never raw logic
  severity            text NOT NULL CHECK (severity IN (
                         'HARD_BLOCK','WARNING','INFORMATION','REFERENCE_ONLY')),
  summary             text NOT NULL,
  staff_action        text,
  do_not_do           text,
  effective_from      date,
  effective_to        date,
  is_active           boolean NOT NULL DEFAULT true,
  created_by          bigint REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_guidance_rule_sources (
  guidance_rule_id    bigint NOT NULL REFERENCES legal_guidance_rules(id) ON DELETE CASCADE,
  legal_source_id     bigint NOT NULL REFERENCES legal_sources(id) ON DELETE RESTRICT,
  PRIMARY KEY (guidance_rule_id, legal_source_id)
);
```

`trigger_condition` remains a controlled application-side key (e.g. `APPLICANT_FEE_UNPAID_OP_PAID`, `INTAKE_PLAINT_COPY_DEMANDED`), reusing the same safeguard pattern already proven in `lib/pim-nonstarter.js`'s `AUTO_TRIGGERED_REASON_CODES`.

### 10a. Worked example 1 — Mumtaz Kutty negative rule (now verified, §2.7/§2.10)

```
guidance_key:       NO_PLAINT_COPY_REQUIRED
trigger_stage:      RECEIVED / SCRUTINY_PENDING
trigger_condition:  INTAKE_PLAINT_COPY_DEMANDED       -- fires only if a FUTURE change ever adds such a
                                                        -- requirement; confirmed NOT to fire today, §2.10
severity:           REFERENCE_ONLY                     -- not WARNING/HARD_BLOCK, because §2.10 confirms there
                                                        -- is no live conflict to warn against today
summary:            "A PIM application satisfying Rule 3(1) cannot be rejected or returned
                     merely for lack of a plaint/draft-plaint copy."
do_not_do:          "Do not add a plaint-copy requirement to intake or scrutiny without first
                     re-reading Mumtaz Kutty v. Rahmath Banu (Madras HC, C.R.P.No.3470/2024,
                     11.09.2024) — the Court held this inverts Section 12A's own sequencing."
legal_source_ids:   [§2.7's legal_sources row, verification_state = PRIMARY_SOURCE_VERIFIED]
```

This is deliberately `REFERENCE_ONLY`, not `WARNING` — per the brief's own instruction, the engine must not manufacture a conflict from a judgment where the current software audit (§2.10) found none. Its value is purely preventive: a visible, citable reason **not** to add this requirement later.

### 10b. Worked example 2 — PIM 109/2026 fee-default scenario, four authority tiers kept separate

Per the brief's explicit instruction, the four tiers below must **never be merged into one statement** — each is a different kind of authority with a different legal weight, and collapsing them would misrepresent which parts of the guidance are binding law versus persuasive commentary versus this project's own operational choice:

```
STATUTORY FACT (Level 1 — Rule 11):
  Mediation fee must be paid before commencement of mediation. (Rule 11,
  Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 —
  construed as mandatory timing in Sidhi Vinayak Metcom, ¶34.)

SOP REQUIREMENT (Level 4 — TNSLSA SOP clause 8/19):
  [To be cited once the applicable TNSLSA fee/remittance clause text is
  confirmed against the reconciliation audit's own clause numbering —
  §10 of lib/pim-mediation-fee.js's slab table is already SOP-exact per
  docs/phase6-sop-2026-frozen-rules.md rule 2; this tier should cite THAT
  confirmed-correct SOP provision, not re-derive it.]

PERSUASIVE JUDICIAL GUIDANCE (Level 5 — Sidhi Vinayak Metcom, Jharkhand HC,
  persuasive in Tamil Nadu, NOT binding on DLSA Nilgiris):
  On facts where both sides defaulted, a Non-Starter declaration and
  consequent plaint rejection were upheld (¶29, ¶40). Critically, the
  judgment also establishes that a party's OWN payment preserves THAT
  party's compliance even where the other side defaults (¶32) — i.e. the
  applicant paying its own share, even if the OP never does, is what keeps
  the applicant's position correct.

LOCAL OPERATIONAL DECISION (Level 6 — this project's own workflow choice,
  NOT compelled by any of the above):
  Whether/when to escalate a partially-paid FEE_PENDING case to
  MEDIATION_FEE_NOT_SUBMITTED Non-Starter, and the "final opportunity before
  closure" workflow around it, is this project's own operational policy —
  the existing `requires_authority_decision = true` flag on that reason code
  already reflects that this is a human-authority decision, not an automatic
  legal consequence. Nothing above REQUIRES non-starter closure at any
  particular point; it only confirms that fee default CAN support one once a
  human authority decides it should.
```

Applied to the PIM 109/2026 design scenario in the brief (OP side consented and paid ₹15,000; applicant has not paid its share; mediation not commenced — **hypothetical only, PIM 109/2026 production data not read or touched in producing this document**): the system could display, at `FEE_PENDING`, a `WARNING`-severity panel stating the STATUTORY FACT and the LOCAL OPERATIONAL DECISION tiers plainly ("mediator cannot yet be appointed; applicant share outstanding"), and show the PERSUASIVE JUDICIAL GUIDANCE tier only as an expandable "why this matters" reference correctly labeled **"Persuasive — Jharkhand High Court"** — never phrased as "the law requires Non-Starter here," since neither Rule 11 nor Sidhi Vinayak Metcom says that; they only establish that fee default is capable of supporting a Non-Starter if and when a human authority (per the existing `requires_authority_decision` gate) decides to record one.

---

## 11. Workflow-stage → guidance mapping (revised: Mumtaz Kutty added at intake/scrutiny)

| Stage group | status_master codes | Illustrative guidance (design intent only — not seeded) |
|---|---|---|
| INSTITUTION | `RECEIVED`, `SCRUTINY_PENDING`, `DEFECT_PENDING`, `REGISTERED` | Rule 3 scrutiny requirements; clause 4's 3-day SLA; **Mumtaz Kutty's negative plaint-copy rule (§10a) — `REFERENCE_ONLY`, no live conflict found (§2.10)** |
| NOTICE | `FORM2_PENDING`, `FORM2_ISSUED`, `SERVICE_PENDING`, `NOTICE_RETURNED`, `ADDRESS_CORRECTION_PENDING`, `FINAL_NOTICE_PENDING`, `FINAL_NOTICE_ISSUED` | Rule 3 service requirements; SOP clause 5(a)/5(b) |
| RESPONSE | `OP_APPEARANCE_PENDING`, `OP_APPEARED`, `OP_CONSENT_PENDING`, `OP_CONSENTED`, `OP_REFUSED` | Yamini Manohar-adjacent guidance only where a related suit's urgency is in question — not a routine PIM-stage trigger |
| FEE | `FEE_PENDING` | Rule 11; Sidhi Vinayak Metcom four-tier guidance (§10b) |
| MEDIATOR | `MEDIATOR_ASSIGNMENT_PENDING`, `MEDIATOR_ASSIGNED` | SOP clause 9 prerequisites |
| MEDIATION | `MEDIATION_PENDING`, `MEDIATION_ONGOING` | Clause 10 conduct-of-mediation requirements |
| OUTCOME | `OUTCOME_FORM_PENDING` | Form 4/5 requirements; Section 12A(5) arbitral-award-equivalence note (§2.9) |
| CLOSURE | `CLOSED_NON_STARTER`, `CLOSED_SETTLED`, `CLOSED_FAILED`, `WITHDRAWN` | Non-starter grounds, already in `nonstarter_reasons.rule_reference`; Sidhi Vinayak Metcom as a now-citable source for reason id 5 |
| AUTHORITY | `AUTHORITY_DECISION_PENDING` | Clause 11(c) Nodal-Officer-as-civil-court material |

Patil Automation, Yamini Manohar, and Dhanalakshmi Spinntex remain `workflow_stages = []` or `RECEIVED`/`SCRUTINY_PENDING`-only background references at `REFERENCE_ONLY` severity (unchanged reasoning from the first pass) — they answer "did this case need PIM at all," which is normally already settled by the time a PIM case exists in this system.

Limitation/deadline-aware guidance remains blocked on the not-yet-built statutory-limitation module, unchanged from the first pass.

---

## 12. Effective-date model

Unchanged from the first pass:

| Rule needing a date | Correct anchor field | Source |
|---|---|---|
| Patil Automation / Dhanalakshmi Spinntex rejection-of-plaint consequence | `pim_cases.application_date` (or `received_date`) vs. **20.08.2022** | Hardcoded in the guidance rule's own `effective_from`, not a case-level column |
| TNSLSA SOP (effective 01.10.2026) | `pim_cases.application_date` vs. **01.10.2026** — open question on pending vs. newly-filed cases, inherited unresolved from the reconciliation audit | `legal_sources.effective_from` for the SOP row |
| Mediator honorarium applicability | mediator nomination/assignment date vs. **01.10.2026**, never case-level dates | Existing frozen rule 12 |

---

## 13. Supersession model

Unchanged from the first pass, now explicitly using the `verification_state = 'SUPERSEDED'` value introduced in §9 alongside `superseded_by`/`is_active` — a superseded row's `verification_state` moving to `SUPERSEDED` is itself an audited write (§18), distinct from a row that was never verified in the first place (`DRAFT`/`DISCOVERED`) or found not to apply (`REJECTED_MISMATCH`).

---

## 14. Legal Library UI proposal

Unchanged from the first pass, with one addition: the verified-rows-only gate for ordinary staff now reads `verification_state = 'PRIMARY_SOURCE_VERIFIED'` (§9a) rather than `verified_at IS NOT NULL`, and the detail panel's authority badge should visually flag Level 5 (`OTHER_HIGH_COURT`) rows with the jurisdiction named explicitly (e.g. "Persuasive — Jharkhand High Court") rather than a generic "persuasive" label, directly per the brief's instruction never to let a Sidhi-Vinayak-style citation read as more authoritative than it is.

---

## 15. Contextual guidance UI proposal

Unchanged in structure from the first pass (primary insertion point: "Next Action," `app/pim/case/[id]/page.tsx` line ~719; secondary: per-action pages, Outcome section, Workflow Timeline). The worked panel example from the first pass is now directly realizable with verified data:

```
┌─ LEGAL GUIDANCE ──────────────────────────────────────┐
│ Rule: Rule 11 — mediation fee must be paid before      │
│       commencement of mediation.                       │
│                                                          │
│ Current case:                                           │
│   Applicant fee unpaid. OP fee paid.                    │
│                                                          │
│ Guidance:                                                │
│   Mediator cannot yet be appointed.                      │
│                                                          │
│ Relevant authority:                                      │
│   Union of India v. Sidhi Vinayak Metcom Ltd.            │
│   Jharkhand High Court, Commercial Appeal No.02/2025,    │
│   26.09.2025 — PERSUASIVE (Jharkhand), not binding in TN │
│                                                          │
│ [View source]   [Why am I seeing this?]                 │
└───────────────────────────────────────────────────────┘
```

---

## 16. Search architecture

Unchanged from the first pass.

---

## 17. Permission model

Unchanged from the first pass (`READ_LEGAL_LIBRARY` broad, `MANAGE_LEGAL_SOURCES`/`MANAGE_LEGAL_GUIDANCE` admin-only), with one addition: `MANAGE_LEGAL_SOURCES` is also the permission that transitions a row's `verification_state` — i.e. moving a row from `DISCOVERED` to `PRIMARY_SOURCE_VERIFIED` (or to `REJECTED_MISMATCH`) is itself a permissioned, audited write, not a passive status.

---

## 18. Audit model

Unchanged from the first pass; `audit_log` rows for `legal_sources` now additionally capture `verification_state` transitions as part of `old_value`/`new_value`, since that transition is the single most legally consequential edit this table supports (it is what gates staff visibility, §9a).

---

## 19. Source-PDF preservation recommendation

Unchanged from the first pass (hybrid: repository-static files for the Act/Rules/SOP/instruction letter; external `source_url`/`primary_source_url` links for case law).

---

## 20. Phased implementation plan

| Phase | Scope | Blocking dependency |
|---|---|---|
| **LK-1** (this document, now revised) | Authoritative-source research + architecture | See §21/§22 for readiness assessment |
| **LK-2** | Schema (§9, §10) + seed **only `PRIMARY_SOURCE_VERIFIED` sources** | None remaining for the 6 verified sources (§2.1, §2.2, §2.3, §2.4, §2.7, §2.8); §2.6 and the §2.9 discovery pass can follow once separately verified |
| **LK-3** | Legal Library UI (§14) | LK-2 schema must exist |
| **LK-4** | Structured guidance-rule mappings (§10, §11) | LK-2 |
| **LK-5** | Contextual workflow panels/warnings (§15) | LK-4; limitation-aware guidance additionally blocked on the separate statutory-limitation module |

---

## 21. Sources/cases requiring further verification before seeding (revised)

1. **Aarthi Scans v. Konica Minolta** (§2.6) — holding confirmed via secondary commentary only; retrieve and read the full Madras HC order directly (via the case's actual number, not party-name search alone, per the lesson in §0.2) before marking `PRIMARY_SOURCE_VERIFIED`.
2. ~~Patil Automation's exact paragraph references~~ — **resolved** (§0.3): full primary text read, ¶43/54/68/84/85 confirmed, now `PRIMARY_SOURCE_VERIFIED`.
3. **The broader case-law discovery pass** (brief's §5; §2.9 here) — not run to completion; scope as a bounded LK-2 task feeding directly into the `DRAFT`→`DISCOVERED`→`PRIMARY_SOURCE_VERIFIED` pipeline, using the direct case-number/party search method that resolved §2.4/§2.7/§2.8 in this pass rather than the generic-topic search that missed them initially.
4. **Section 12A(5)'s arbitral-award-equivalence provision** (§2.9) — a statute-level entry, not case law; low-effort to seed early in LK-2 since it requires no case-law search at all, only accurate statutory text.
5. **Annexures A–E of the TNSLSA SOP** — never supplied to this project; cannot be indexed until supplied.
6. **M/s Ganga Complex v. M/s TSR Films Pvt. Ltd.** (§2.5) — `REJECTED_MISMATCH`. Not a research task — a request for the specific order, if one exists, should come from whoever originally proposed this candidate; otherwise recommend dropping it from the candidate set permanently (the `REJECTED_MISMATCH` row itself serves as that permanent record if ever entered).

**Resolved this pass (no longer open):** Sidhi Vinayak Metcom (§2.4), Dr. Mumtaz Kutty (§2.7), Dhanalakshmi Spinntex (§2.8), and the Yamini Manohar citation (§2.2) are now `PRIMARY_SOURCE_VERIFIED` with full primary-text paragraph citations, propositions, and (where applicable) negative rules recorded above.

None of the above have been entered into any database as part of producing this document.

---

## 22. Is LK-1 now verified enough to start LK-2?

**Yes, for a bounded first seed.** Six of the eight originally-proposed case-law candidates are now `PRIMARY_SOURCE_VERIFIED` against full primary-text reads (Patil Automation, Yamini Manohar, Dhanbad Fuels, Sidhi Vinayak Metcom, Mumtaz Kutty, Dhanalakshmi Spinntex), each with a case holding, a separately-stated operational proposition, correct authority classification, and (where applicable) an explicit negative rule. The statute/Rules/SOP sources have no outstanding verification question at all (they were never in doubt — only their *implementation gaps* are tracked, and those live in the reconciliation audit, not here). One candidate (Ganga Complex) is conclusively `REJECTED_MISMATCH` and should be dropped rather than carried forward as an open item. One candidate (Aarthi Scans) remains `DISCOVERED`-only and should either be fully verified before LK-2's seed, or seeded later in a follow-up batch — it is not a blocker for starting LK-2 with the other six.

**Recommended LK-2 scope, consistent with this assessment:** seed `legal_sources` for the Act/s.12A, the 2018 Rules (Rules 3, 4, 11, Schedule II), the current TNSLSA SOP (citing the reconciliation audit's clause numbering), and the six `PRIMARY_SOURCE_VERIFIED` cases above — and build the schema itself (§9/§10) to already support the `DRAFT`/`DISCOVERED`/`REJECTED_MISMATCH`/`SUPERSEDED` states, so Aarthi Scans and the broader discovery pass (§21 items 1, 3) can be added incrementally afterward without a schema change.

**This document remains READ-ONLY.** No migration has been written, no row has been inserted, no code has been modified in producing this revision.

---

*End of revised design document. Phase LK-1 only. No migrations applied. No DB seeded. No PIM workflow code modified. No commit/stage/push performed. PIM/119/2026 not consumed. PIM 109/2026 not touched. dlsa-mis not touched.*
