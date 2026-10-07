-- Phase LK-2: Legal Knowledge Base - bounded initial seed.
--
-- Seeds ONLY PRIMARY_SOURCE_VERIFIED sources (per docs/pim-legal-knowledge-base-design.md
-- section 22's readiness assessment) plus the foundational statute/Rules/
-- SOP/instruction letter, and a small, deliberately minimal set of guidance
-- rules to prove the architecture - not a comprehensive contextual-guidance
-- rollout (that is LK-4/LK-5).
--
-- Explicitly NOT seeded, and why:
--   - Ganga Complex v. TSR Films: REJECTED_MISMATCH after two independent
--     search passes found no Section 12A content between these parties.
--     Per instruction, rejected research candidates do not get a
--     production legal_sources row in this batch at all - the research
--     trail lives in docs/pim-legal-knowledge-base-design.md section 2.5
--     and docs/pim-legal-knowledge-base-lk2.md, not here.
--   - Aarthi Scans v. Konica Minolta: remains DISCOVERED (holding confirmed
--     only via secondary commentary, not a primary-text read in this
--     pass) - deferred to a later batch once independently verified.
--   - The broader case-law discovery pass (design doc section 2.9/21 item 3)
--     was not run to completion - deferred to LK-2's follow-up / LK-4.
--
-- Verification provenance: every PRIMARY_SOURCE_VERIFIED row below was
-- confirmed against the actual judgment/statutory text during this LK-1/LK-2
-- research pass (see docs/pim-legal-knowledge-base-design.md for the
-- case-by-case record and docs/pim-legal-knowledge-base-lk2.md for this
-- migration's own summary) - not from a secondary-commentary summary alone.
-- verified_by is left NULL (no specific staff account performed this
-- research; it was this development pass) - verification_notes records the
-- provenance instead of attributing it to a placeholder user id.

-- ============================================================================
-- STATUTE / RULE (Level 1)
-- ============================================================================

insert into legal_sources (
  source_type, authority_level, title, jurisdiction,
  effective_from, source_document_ref, rule_refs, topics,
  operational_proposition, operational_effect,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'STATUTE', 1, 'Commercial Courts Act, 2015 - Section 12A (Pre-Institution Mediation and Settlement)', 'ALL_INDIA',
  '2018-05-03', 'legal-sources/statute/commercial-courts-act-2015-section-12a.pdf', null,
  array['section 12a', 'pre-institution mediation', 'mandatory mediation', 'urgent interim relief', 'limitation', 'settlement', 'arbitral award'],
  'A suit which does not contemplate any urgent interim relief shall not be instituted unless the plaintiff first exhausts pre-institution mediation. The mediation period (3 months, extendable by 2 months by consent) is excluded from limitation. A settlement reached has the same status and effect as an arbitral award on agreed terms under Arbitration and Conciliation Act, 1996, s.30(4).',
  'Governs whether a commercial suit may be instituted without first exhausting PIM, and gives a PIM settlement the force of an arbitral award.',
  'PRIMARY_SOURCE_VERIFIED', 'Text of Section 12A, sub-sections (1)-(5), as reproduced and construed in Patil Automation v. Rakheja Engineers, (2022) 10 SCC 1, para 24.',
  'Statutory text verified against the quotation in Patil Automation (2022) 10 SCC 1, para 24, which reproduces Section 12A in full. No separate primary gazette copy retrieved in this pass; the Supreme Court''s own quotation is treated as authoritative for this seed.',
  '2026-10-06'
);

insert into legal_sources (
  source_type, authority_level, title, jurisdiction,
  effective_from, source_document_ref, rule_refs, topics,
  operational_proposition, operational_effect,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'RULE', 1, 'Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 - Rule 3 (Initiation of mediation process)', 'ALL_INDIA',
  '2018-07-03', 'legal-sources/rules/pim-rules-2018.pdf', 'Rule 3',
  array['rule 3', 'form 1', 'form 2', 'form 3', 'non starter', 'opposite party absent', 'territorial jurisdiction', 'pecuniary jurisdiction'],
  'A party applies on Form-1 with a Rs.1,000 fee; the Authority issues notice (Form-2) to the opposite party to appear and consent within 10 days; non-response or refusal after a final notice, or non-appearance on an extended date, makes the process a Non-Starter recorded on Form-3; mediation must complete within 3 months (extendable by 2 months by consent of both parties).',
  'Governs the entire PIM intake-to-mediator-assignment sequence: application, notice, consent, and the conditions under which a Non-Starter report is issued.',
  'PRIMARY_SOURCE_VERIFIED', 'Rule 3(1)-(8) full text, quoted in Patil Automation v. Rakheja Engineers, (2022) 10 SCC 1, para 28, and relied on for the Rule 3(1)/plaint-copy question in Mumtaz Kutty v. Rahmath Banu, Madras HC, C.R.P.No.3470/2024.',
  'Rule 3 text verified against its full quotation in Patil Automation, para 28. Cross-checked against Mumtaz Kutty''s discussion of Rule 3(1)''s own requirements (paras 8-10 of that judgment).',
  '2026-10-06'
);

insert into legal_sources (
  source_type, authority_level, title, jurisdiction,
  effective_from, source_document_ref, rule_refs, topics,
  operational_proposition, operational_effect,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'RULE', 1, 'Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 - Rule 11 and Schedule II (Mediation fee)', 'ALL_INDIA',
  '2018-07-03', 'legal-sources/rules/pim-rules-2018.pdf', 'Rule 11; Schedule II',
  array['mediator fee', 'fee not paid', 'rule 11', 'schedule ii', 'mediation fee'],
  'A one-time mediation fee, shared equally between the parties, must be paid before commencement of mediation, in the amount fixed by Schedule II''s claim-quantum slabs (Rs.15,000 for claims of Rs.3,00,000-10,00,000, rising to Rs.75,000 above Rs.3,00,00,000).',
  'Governs mediation-fee quantum and timing; non-payment before commencement is capable of supporting a Non-Starter outcome once established on the facts (see Sidhi Vinayak Metcom, below, for persuasive judicial treatment).',
  'PRIMARY_SOURCE_VERIFIED', 'Rule 11''s "before the commencement of mediation" timing language and the Schedule II fee table, both quoted in full in Patil Automation, (2022) 10 SCC 1, paras 20, 52; Rule 11''s mandatory-timing construction confirmed in Sidhi Vinayak Metcom, Jharkhand HC, Commercial Appeal No.02/2025, para 34.',
  'Schedule II figures cross-checked against lib/pim-mediation-fee.js''s calculateMediationFee() slab table (already confirmed SOP-exact per docs/phase6-sop-2026-frozen-rules.md rule 2) - all five slabs match exactly.',
  '2026-10-06'
);

-- ============================================================================
-- TNSLSA SOP / INSTRUCTION (Level 4)
-- ============================================================================
-- Per the LK-2 instruction: do not independently reinterpret SOP provisions
-- already frozen in docs/phase6-pim-sop-2026-reconciliation-audit.md and
-- docs/phase6-sop-2026-frozen-rules.md. This row cites that audit's own
-- clause numbering rather than re-deriving SOP content.

insert into legal_sources (
  source_type, authority_level, title, jurisdiction,
  effective_from, source_document_ref, sop_clause_refs, topics,
  operational_proposition, operational_effect, caution,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'TNSLSA_SOP', 4, 'TNSLSA Standard Operating Procedure for Pre-Institution Mediation and Settlement (effective 01.10.2026)', 'TAMIL_NADU',
  '2026-10-01', 'legal-sources/sop/tnslsa-pim-sop-2026.pdf', '24 clauses + Annexures A-E',
  array['sop', 'tnslsa', 'filing', 'scrutiny', 'service', 'non starter', 'mediation fee', 'mediator panel', 'nodal officer', 'limitation', 'honorarium'],
  'Institutional procedure for DLSA-administered PIM in Tamil Nadu, reconciled clause-by-clause against this codebase in docs/phase6-pim-sop-2026-reconciliation-audit.md. This Legal KB row is a pointer to that audit, not a re-statement of its content - see that document for which clauses are MATCH/PARTIAL/MISSING against the live system.',
  'Governs institutional procedure for every PIM workflow stage; see docs/phase6-pim-sop-2026-reconciliation-audit.md for the authoritative clause-by-clause mapping to this system''s actual behavior.',
  'Subject to Section 12A, the 2018 Rules, and binding precedent - an SOP clause cannot override statute or binding case law. Annexures A-E text was never supplied to this project and is not indexed.',
  'PRIMARY_SOURCE_VERIFIED', 'SOP existence, effective date (01.10.2026), and clause structure (24 clauses + Annexures A-E) as already confirmed in docs/phase6-pim-sop-2026-reconciliation-audit.md, produced from the project''s own copies of "PIM Instruction.pdf" and "PIM SOP.pdf".',
  'Not re-verified independently in this pass - relies on, and cites, the already-completed reconciliation audit per the LK-2 instruction not to re-interpret frozen SOP provisions. Treated as verified because that audit itself was a direct read of the source PDFs, not secondary commentary.',
  '2026-10-06'
);

insert into legal_sources (
  source_type, authority_level, title, jurisdiction,
  effective_from, source_document_ref, topics,
  operational_proposition, operational_effect,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'TNSLSA_INSTRUCTION', 4, 'TNSLSA instruction letter No. P.N.5996/2026, dated 30.09.2026 (forwarding the PIM SOP; honorarium applicability)', 'TAMIL_NADU',
  '2026-09-30', 'legal-sources/instructions/tnslsa-pn-5996-2026.pdf', array['honorarium', 'mediator nomination', 'sop effective date'],
  'Forwards the PIM SOP with effective date 01.10.2026; mediator honorarium enhancement (SOP clause 19 cols 4-5) applies to cases where the mediator is nominated on or after 01.10.2026 - keyed to mediator nomination date, never case filing/received/registration date.',
  'Governs the honorarium effective-date gate; a honorarium calculation module (not yet built per docs/phase6-sop-2026-frozen-rules.md rule 11) must key off mediator-assignment/nomination date.',
  'PRIMARY_SOURCE_VERIFIED', 'Honorarium nomination-date rule as quoted in docs/phase6-pim-sop-2026-reconciliation-audit.md section 2 ("the enhancement of honorarium to the mediators, is applicable to the cases where mediator(s) is/are nominated from 01.10.2026").',
  'Same provenance note as the SOP row above - relies on the already-completed reconciliation audit''s direct read of the source letter.',
  '2026-10-06'
);

-- ============================================================================
-- CASE LAW (6 PRIMARY_SOURCE_VERIFIED judgments)
-- ============================================================================

-- 1. Patil Automation v. Rakheja Engineers - SC, binding, Level 2.
insert into legal_sources (
  source_type, authority_level, title, court, case_number, citation, decision_date, jurisdiction,
  effective_from, source_url, paragraph_refs, rule_refs, topics,
  case_holding, operational_proposition, operational_effect,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'SUPREME_COURT', 2, 'Patil Automation Pvt. Ltd. & Ors. v. Rakheja Engineers Pvt. Ltd.',
  'Supreme Court of India', 'Civil Appeal arising out of SLP(C) No.14697/2021 with Civil Appeal arising out of SLP(C) No.5737/2022', '(2022) 10 SCC 1', '2022-08-17', 'ALL_INDIA',
  '2022-08-20', 'https://indiankanoon.org/doc/164693074/', 'paras 43, 54, 68, 72, 84, 85', 'Section 12A; Order VII Rule 11 CPC',
  array['section 12a', 'mandatory mediation', 'order vii rule 11', 'prospective operation', '20.08.2022 cutoff', 'rejection of plaint'],
  'Section 12A of the Commercial Courts Act is mandatory, not a mere procedural provision (para 43); pre-institution mediation is contemplated only for suits not seeking urgent interim relief (para 54); Order VII Rule 11''s power to reject a plaint is available even suo motu, without a defendant''s application (para 68); the Court declared Section 12A mandatory and held that a suit instituted in violation must be visited with rejection of the plaint under Order VII Rule 11, this declaration made effective from 20.08.2022 so stakeholders become sufficiently informed, with no reopening of already-rejected plaints or already-filed fresh suits (para 84). Both appeals disposed of accordingly; in the first, the written statement was directed to be treated as an application for leave to defend (para 85).',
  'A PIM case whose underlying suit would be filed/was filed before 20.08.2022 is not subject to the rejection-of-plaint consequence for skipping PIM; this cutoff date is the single most important date-based gate before any limitation/rejection-consequence guidance is shown. For suits filed on or after 20.08.2022, Section 12A compliance is a precondition to a validly instituted suit, except where urgent interim relief is genuinely contemplated.',
  'Governs whether a related suit should even reach PIM at all; governs the prospectivity cutoff also applied in Dhanbad Fuels and Dhanalakshmi Spinntex (both seeded below).',
  'PRIMARY_SOURCE_VERIFIED', 'All of: mandatory nature (para 43), Order VII Rule 11 consequence including suo motu power (para 68), prospective-only operation (para 84), and the specific 20.08.2022 cutoff (para 84) - confirmed against the full primary judgment text (LiveLaw-reported, 2022 LiveLaw (SC) 678, cross-identified as (2022) 10 SCC 1), not a secondary summary.',
  'Full judgment retrieved and read in this pass (not merely a snippet/summary). Para 84 is the operative declaration paragraph and contains both the mandatory holding and the exact 20.08.2022 cutoff language. Para 85 is the final disposition for both appeals.',
  '2026-10-06'
);

-- 2. Yamini Manohar v. T.K.D. Keerthi - SC, binding, Level 2.
insert into legal_sources (
  source_type, authority_level, title, court, case_number, citation, decision_date, jurisdiction,
  source_url, paragraph_refs, topics,
  case_holding, operational_proposition, operational_effect,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'SUPREME_COURT', 2, 'Yamini Manohar v. T.K.D. Keerthi',
  'Supreme Court of India', 'Special Leave Petition (Civil) Diary No.32275/2023', '(2024) 5 SCC 815', '2023-10-13', 'ALL_INDIA',
  'https://indiankanoon.org/doc/65175185/', 'paras 7-8', array['urgent interim relief', 'section 12a', 'camouflage', 'contemplate'],
  'Section 12A bars suits that do not "contemplate any urgent interim relief," but a plaintiff has no absolute right to bypass mediation merely by tacking on an interim-relief prayer. Courts examine the suit holistically - nature/subject matter, cause of action, and the prayer as framed - to see whether the urgent-relief prayer is genuine or a "disguise or mask to wriggle out of" Section 12A (paras 7-8). Non-grant of interim relief at the ad-interim stage, or even after full arguments, does not retroactively justify dismissal for Section 12A non-compliance.',
  'When a related civil suit''s PIM-exemption is challenged, the test is whether the urgent-relief prayer was genuine as pleaded at filing, not whether relief was ultimately granted - PIM staff should never treat "the court did not grant interim relief" as proof that PIM was wrongly skipped.',
  'The controlling test later applied by the Madras High Court in Aarthi Scans v. Konica Minolta (not yet seeded - remains DISCOVERED, see docs/pim-legal-knowledge-base-design.md section 2.6).',
  'PRIMARY_SOURCE_VERIFIED', 'Case number, date, bench (Sanjiv Khanna J. and S.V.N. Bhatti J.), the multi-factor "contemplate urgent interim relief" test (paras 7-8), and final disposition (petition dismissed, delay condoned, Delhi HC order upheld) all confirmed against the primary judgment text.',
  'Citation (2024) 5 SCC 815 independently confirmed via SCC Online''s own 2024 SCC Vol.5 Part 5 index entry (not merely a later judgment citing it), closing the discrepancy flagged in the first LK-1 research pass.',
  '2026-10-06'
);

-- 3. Dhanbad Fuels v. Union of India - SC, binding, Level 2.
insert into legal_sources (
  source_type, authority_level, title, court, case_number, citation, decision_date, jurisdiction,
  effective_from, source_url, topics,
  case_holding, operational_proposition, operational_effect,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'SUPREME_COURT', 2, 'M/s Dhanbad Fuels Pvt. Ltd. v. Union of India & Anr.',
  'Supreme Court of India', '2025 INSC 696', '2025 INSC 696', '2025-05-15', 'ALL_INDIA',
  '2022-08-20', 'https://indiankanoon.org/doc/95036503/', array['section 12a', 'prospective operation', '20.08.2022 cutoff', 'urgent interim relief', 'abeyance'],
  'Reaffirms Section 12A as mandatory and Patil Automation''s 20.08.2022 prospectivity cutoff. On the facts, the Court dismissed the appeal and upheld keeping the suit in abeyance pending pre-institution mediation through the DLSA, reasoning that mediation infrastructure was not fully operational before 2022 and the law does not compel the impossible.',
  'A suit filed before mediation infrastructure existed in a given DLSA is not penalized for the gap - the suit is held in abeyance for PIM to occur, not permanently barred.',
  'Relevant to any PIM case with an unusual filing-date/registration-date gap, or where a related suit was stayed pending DLSA mediation rather than rejected outright.',
  'PRIMARY_SOURCE_VERIFIED', 'Holding (mandatory Section 12A, 20.08.2022 cutoff reaffirmed, abeyance-pending-mediation disposition) confirmed via the official Supreme Court judgment PDF (api.sci.gov.in) and corroborating secondary summary.',
  'Full official PDF located (api.sci.gov.in/supremecourt/2021/7937/7937_2021_12_1501_61801_Judgement_15-May-2025.pdf) and cross-checked against secondary case-law commentary for the disposition; not re-read paragraph-by-paragraph line in this pass to the same depth as Patil Automation.',
  '2026-10-06'
);

-- 4. Sidhi Vinayak Metcom - Jharkhand HC, PERSUASIVE ONLY, Level 5.
insert into legal_sources (
  source_type, authority_level, title, court, case_number, citation, decision_date, jurisdiction,
  source_url, paragraph_refs, rule_refs, topics,
  case_holding, operational_proposition, negative_rule, operational_effect, caution,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'OTHER_HIGH_COURT', 5, 'Union of India v. M/s Sidhi Vinayak Metcom Limited & Ors.',
  'High Court of Jharkhand at Ranchi', 'Commercial Appeal No.02 of 2025', '2025:JHHC:30333-DB', '2025-09-26', 'JHARKHAND',
  'https://indiankanoon.org/doc/55162554/', 'paras 29, 32, 34, 40', 'Rule 11',
  array['mediator fee', 'fee not paid', 'non starter', 'rule 11', 'section 12a compliance'],
  'On facts where BOTH the applicant and the opposite party had defaulted on their shares of mediation fee (PIMS Case No.06/2019, DLSA Jamshedpur), the Court upheld the DLSA''s Non-Starter declaration and the consequent rejection of the plaint under Order VII Rule 11 CPC as a correct application of Section 12A. Rule 11''s "before the commencement of mediation" language was construed as mandatory timing for fee deposit (para 34). The Court held that non-deposit by either/both sides defeats true Section 12A compliance (para 29) - critically, it was expressly stated that if the appellants (applicant side) had deposited their own share, that alone would have been treated as compliance of Section 12A and their suit would have remained entertainable on the ground of the respondents'' own failure to pay (para 32). Appeal dismissed (para 40).',
  'Mediation-fee default by a party is capable of supporting a Non-Starter outcome once genuinely established on the facts - but critically, a party''s OWN payment of its own share preserves THAT party''s Section 12A compliance even if the other side defaults (para 32). This should be surfaced whenever only one side of a PIM case has paid: the paying side''s position is not automatically compromised by the other side''s default.',
  'Do not describe this judgment as holding that Rule 3(4)/(6) expressly enumerates mediation-fee default as a ground - it does not say that. It reasons from Rule 11''s mandatory fee-timing language and Section 12A compliance generally, not from Rule 3''s enumerated non-starter triggers. This project''s own nonstarter_reasons table already gets this right: MEDIATION_FEE_NOT_SUBMITTED cites "Operational ground," not a Rule 3 sub-clause, and requires_authority_decision = true for that reason, meaning a human authority decision is required, not an automatic system inference.',
  'Directly supports revising nonstarter_reasons id 5''s rule_reference placeholder (currently "Operational ground; verify...") to cite Rule 11 and this judgment, once that revision is separately made (not done by this migration - nonstarter_reasons is untouched here).',
  'PERSUASIVE ONLY in Tamil Nadu - Jharkhand High Court, never binding on DLSA Nilgiris or any Tamil Nadu DLSA. Never present as controlling or as Madras High Court authority.',
  'PRIMARY_SOURCE_VERIFIED', 'Rule 11 timing/payment requirement (para 34), both-side fee-default facts (para 29), applicant''s-own-compliance-preserved counterfactual (para 32), and final disposition (para 40) - all confirmed against the primary judgment text.',
  'Full judgment retrieved and read (not a snippet). Correctly located on the second, targeted verification pass (exact case number + neutral citation search) after the first LK-1 pass failed to locate it. PIMS Case No.06/2019, DLSA Jamshedpur, and the 23.12.2021/20.01.2022 DLSA order dates are all confirmed as recorded in the judgment.',
  '2026-10-06'
);

-- 5. Mumtaz Kutty v. Rahmath Banu - Madras HC, binding within TN, Level 3.
insert into legal_sources (
  source_type, authority_level, title, court, case_number, citation, decision_date, jurisdiction,
  source_url, paragraph_refs, rule_refs, topics,
  case_holding, operational_proposition, negative_rule, operational_effect,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'MADRAS_HIGH_COURT', 3, 'Dr. Mumtaz Kutty v. Dr. Rahmath Banu',
  'Madras High Court', 'C.R.P.No.3470 of 2024', null, '2024-09-11', 'TAMIL_NADU',
  'https://indiankanoon.org/doc/51091849/', 'paras 8, 9, 10', 'Rule 3(1)',
  array['plaint copy', 'rule 3', 'scrutiny', 'pim application'],
  'A docket order that had returned the PIM application below for want of a copy of the proposed plaint was set aside. The Court reasoned that demanding a plaint copy at the mediation-application stage is a logical impossibility, since Section 12A(1) puts suit institution itself in abeyance pending mediation (para 8); rejected the inverted sequencing that a mediation application may be entertained only after the suit is first instituted (para 9); and held the correct sequence is that institution of a suit depends on the fate of pre-institution mediation, not vice-versa (para 10). The Principal District and Sessions Judge, Chengalpattu was directed to forward the mediation application to the DLSA. No costs.',
  'A PIM application satisfying Rule 3(1)''s own requirements cannot be rejected or returned merely because a copy of the proposed plaint has not been filed alongside it - plaint-copy demand inverts the statutory sequence Section 12A itself establishes.',
  'Do not insist on a plaint/draft-plaint copy as an additional intake or scrutiny prerequisite beyond what Rule 3(1) itself requires.',
  'Directly relevant to RECEIVED/SCRUTINY_PENDING - see the software-conflict audit recorded in docs/pim-legal-knowledge-base-design.md section 2.10 and docs/pim-legal-knowledge-base-lk2.md: confirmed PASS, this codebase does not currently require a plaint copy, so this source is preventive/reference guidance, not a fix for a live defect.',
  'PRIMARY_SOURCE_VERIFIED', 'Holding (docket order set aside, para-8/9/10 reasoning on Section 12A sequencing, final disposition) confirmed against the full primary judgment text.',
  'Full judgment retrieved and read (not a snippet). Correctly located on the second, targeted verification pass (exact case number search) after the first LK-1 pass failed to locate it.',
  '2026-10-06'
);

-- 6. Dhanalakshmi Spinntex v. Sivasubramaniam - Madras HC, binding within TN, Level 3, REFERENCE_ONLY.
insert into legal_sources (
  source_type, authority_level, title, court, case_number, decision_date, jurisdiction,
  effective_from, source_url, paragraph_refs, topics,
  case_holding, operational_proposition, operational_effect,
  verification_state, verified_proposition, verification_notes, verification_date
) values (
  'MADRAS_HIGH_COURT', 3, 'Shri Dhanalakshmi Spinntex Pvt. Ltd. & Ors. v. Sivasubramaniam & Ors.',
  'Madras High Court', 'Review Application No.51 of 2024 in CRP No.3519 of 2023', '2025-08-26', 'TAMIL_NADU',
  '2022-08-20', 'https://indiankanoon.org/doc/16342051/', 'para 5', array['section 12a', 'prospective operation', '20.08.2022 cutoff', 'review'],
  'The original plaint was filed 01.06.2022, before Patil Automation''s 20.08.2022 cutoff. The earlier CRP order had allowed the petition solely on the ground of Section 12A non-compliance; applying the Supreme Court''s prospective cutoff to this pre-cutoff suit, that ground became invalid (para 5: "the suits that are filed prior to 20.08.2022 are not required to undergo the mandatory pre-institution mediation"). Review Application allowed; earlier CRP order set aside; matter remanded to the District Commercial Court, Coimbatore for reconsideration on other merits. No costs.',
  'Confirms, as a second independent Madras High Court application alongside Dhanbad Fuels at the Supreme Court level, that the 20.08.2022 cutoff is actively and specifically applied to pre-cutoff Tamil Nadu suits.',
  'Background/reference material on the prospective-cutoff question - the Section-12A-applicability question is normally already resolved by the time a PIM case exists in this system, so this is not an operational trigger for any routine PIM workflow stage.',
  'PRIMARY_SOURCE_VERIFIED', 'Original suit filing date (01.06.2022), Patil Automation cutoff application (para 5), reason for review, and final disposition (review allowed, remanded) all confirmed against the primary judgment text.',
  'Full judgment retrieved and read (not a snippet). Correctly located on the second, targeted verification pass (case number + judge name search) after the first LK-1 pass failed to locate it.',
  '2026-10-06'
);

-- ============================================================================
-- Workflow-stage mappings (normalized join table)
-- ============================================================================
-- Patil Automation / Yamini Manohar / Dhanalakshmi Spinntex are deliberately
-- given NO workflow-stage rows (general/background reference, per design
-- doc section 11's caution - they answer "did this case need PIM at all,"
-- which is normally already settled by the time a PIM case exists here).

insert into legal_source_workflow_stages (legal_source_id, status_code)
select s.id, 'FEE_PENDING' from legal_sources s
where s.title = 'Union of India v. M/s Sidhi Vinayak Metcom Limited & Ors.';

insert into legal_source_workflow_stages (legal_source_id, status_code)
select s.id, 'RECEIVED' from legal_sources s
where s.title = 'Dr. Mumtaz Kutty v. Dr. Rahmath Banu';
insert into legal_source_workflow_stages (legal_source_id, status_code)
select s.id, 'SCRUTINY_PENDING' from legal_sources s
where s.title = 'Dr. Mumtaz Kutty v. Dr. Rahmath Banu';

insert into legal_source_workflow_stages (legal_source_id, status_code)
select s.id, 'FEE_PENDING' from legal_sources s
where s.title = 'Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 - Rule 11 and Schedule II (Mediation fee)';

insert into legal_source_workflow_stages (legal_source_id, status_code)
select s.id, 'RECEIVED' from legal_sources s
where s.title = 'Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 - Rule 3 (Initiation of mediation process)';
insert into legal_source_workflow_stages (legal_source_id, status_code)
select s.id, 'SCRUTINY_PENDING' from legal_sources s
where s.title = 'Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 - Rule 3 (Initiation of mediation process)';
insert into legal_source_workflow_stages (legal_source_id, status_code)
select s.id, 'CLOSED_NON_STARTER' from legal_sources s
where s.title = 'Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 - Rule 3 (Initiation of mediation process)';

-- ============================================================================
-- Guidance rules (minimal set - 4 rules, per LK-2 instruction item 13)
-- ============================================================================

-- A. FEE_FULL_PAYMENT_REQUIRED_BEFORE_MEDIATOR - Rule 11 / SOP, no case law
--    needed as the primary authority (persuasive case law attached only as
--    supporting context, not the basis of the rule itself).
insert into legal_guidance_rules (guidance_key, title, trigger_condition, severity, summary, staff_action, do_not_do)
values (
  'FEE_FULL_PAYMENT_REQUIRED_BEFORE_MEDIATOR',
  'Mediation fee must be fully remitted before mediator assignment',
  'FEE_NOT_FULLY_PAID',
  'WARNING',
  'Rule 11 requires the one-time mediation fee to be paid, by both sides, before commencement of mediation. Mediator assignment should not proceed while the required fee remains outstanding.',
  'Confirm both applicant and opposite-party fee shares are recorded as received before assigning a mediator.',
  'Do not treat partial payment (one side only) as sufficient to proceed to mediator assignment.'
);
insert into legal_guidance_rule_stages (guidance_rule_id, status_code)
select g.id, 'FEE_PENDING' from legal_guidance_rules g where g.guidance_key = 'FEE_FULL_PAYMENT_REQUIRED_BEFORE_MEDIATOR';
insert into legal_guidance_rule_sources (guidance_rule_id, legal_source_id)
select g.id, s.id from legal_guidance_rules g, legal_sources s
where g.guidance_key = 'FEE_FULL_PAYMENT_REQUIRED_BEFORE_MEDIATOR'
  and s.title = 'Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 - Rule 11 and Schedule II (Mediation fee)';

-- B. FEE_PARTIAL_APPLICANT_UNPAID - WARNING, Sidhi Vinayak cited only as
--    PERSUASIVE supporting authority, never the sole/hard basis of the rule.
insert into legal_guidance_rules (guidance_key, title, trigger_condition, severity, summary, staff_action, do_not_do)
values (
  'FEE_PARTIAL_APPLICANT_UNPAID',
  'Applicant mediation fee share outstanding while opposite party has paid',
  'APPLICANT_FEE_UNPAID_OP_PAID',
  'WARNING',
  'Opposite-party-side mediation fee has been received. The applicant''s share remains unpaid. Mediator assignment is not presently available because the required mediation fee has not been fully remitted.',
  'Follow up with the applicant for the outstanding fee share.',
  'Do not record this as a Rule-3 Non-Starter solely because of partial non-payment - fee default is a distinct manual ground (MEDIATION_FEE_NOT_SUBMITTED, requires_authority_decision = true in nonstarter_reasons), not an automatic Rule 3 consequence. Do not state that Rule 3(4)/(6) expressly lists mediation-fee default as a ground.'
);
insert into legal_guidance_rule_stages (guidance_rule_id, status_code)
select g.id, 'FEE_PENDING' from legal_guidance_rules g where g.guidance_key = 'FEE_PARTIAL_APPLICANT_UNPAID';
insert into legal_guidance_rule_sources (guidance_rule_id, legal_source_id)
select g.id, s.id from legal_guidance_rules g, legal_sources s
where g.guidance_key = 'FEE_PARTIAL_APPLICANT_UNPAID'
  and s.title = 'Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018 - Rule 11 and Schedule II (Mediation fee)';
insert into legal_guidance_rule_sources (guidance_rule_id, legal_source_id)
select g.id, s.id from legal_guidance_rules g, legal_sources s
where g.guidance_key = 'FEE_PARTIAL_APPLICANT_UNPAID'
  and s.title = 'Union of India v. M/s Sidhi Vinayak Metcom Limited & Ors.';

-- C. NO_PLAINT_COPY_REQUIRED - REFERENCE_ONLY (confirmed PASS, no live
--    conflict - see docs/pim-legal-knowledge-base-lk2.md's software audit).
insert into legal_guidance_rules (guidance_key, title, trigger_condition, severity, summary, staff_action, do_not_do)
values (
  'NO_PLAINT_COPY_REQUIRED',
  'A plaint/draft-plaint copy is not a prerequisite for a PIM application',
  'INTAKE_PLAINT_COPY_DEMANDED',
  'REFERENCE_ONLY',
  'A PIM application satisfying Rule 3(1) cannot be rejected or returned merely for lack of a plaint/draft-plaint copy. This system does not currently require one (confirmed by a read-only audit of intake, scrutiny, and document-requirement code - see docs/pim-legal-knowledge-base-lk2.md).',
  null,
  'Do not add a plaint-copy requirement to intake or scrutiny without first re-reading Mumtaz Kutty v. Rahmath Banu (Madras HC, C.R.P.No.3470/2024, 11.09.2024) - the Court held this inverts Section 12A''s own sequencing.'
);
insert into legal_guidance_rule_stages (guidance_rule_id, status_code)
select g.id, 'RECEIVED' from legal_guidance_rules g where g.guidance_key = 'NO_PLAINT_COPY_REQUIRED';
insert into legal_guidance_rule_stages (guidance_rule_id, status_code)
select g.id, 'SCRUTINY_PENDING' from legal_guidance_rules g where g.guidance_key = 'NO_PLAINT_COPY_REQUIRED';
insert into legal_guidance_rule_sources (guidance_rule_id, legal_source_id)
select g.id, s.id from legal_guidance_rules g, legal_sources s
where g.guidance_key = 'NO_PLAINT_COPY_REQUIRED'
  and s.title = 'Dr. Mumtaz Kutty v. Dr. Rahmath Banu';

-- D. SECTION12A_MANDATORY - REFERENCE_ONLY, Section 12A + Patil Automation.
insert into legal_guidance_rules (guidance_key, title, trigger_condition, severity, summary, staff_action, do_not_do)
values (
  'SECTION12A_MANDATORY',
  'Section 12A pre-institution mediation is mandatory (background reference)',
  'NONE_BACKGROUND_REFERENCE',
  'REFERENCE_ONLY',
  'Section 12A of the Commercial Courts Act is mandatory for commercial suits that do not contemplate urgent interim relief; non-compliant suits (filed on or after 20.08.2022) are liable to rejection under Order VII Rule 11 CPC. Background reference only - by the time a PIM case exists in this system, the question of whether PIM was required has normally already been settled.',
  null,
  'Do not wire this as a WARNING/HARD_BLOCK at any PIM-internal workflow stage - it answers "did this case need PIM," not a question any PIM-internal transition depends on.'
);
insert into legal_guidance_rule_stages (guidance_rule_id, status_code)
select g.id, 'RECEIVED' from legal_guidance_rules g where g.guidance_key = 'SECTION12A_MANDATORY';
insert into legal_guidance_rule_sources (guidance_rule_id, legal_source_id)
select g.id, s.id from legal_guidance_rules g, legal_sources s
where g.guidance_key = 'SECTION12A_MANDATORY'
  and s.title = 'Commercial Courts Act, 2015 - Section 12A (Pre-Institution Mediation and Settlement)';
insert into legal_guidance_rule_sources (guidance_rule_id, legal_source_id)
select g.id, s.id from legal_guidance_rules g, legal_sources s
where g.guidance_key = 'SECTION12A_MANDATORY'
  and s.title = 'Patil Automation Pvt. Ltd. & Ors. v. Rakheja Engineers Pvt. Ltd.';

-- No HARD_BLOCK guidance rule is seeded in LK-2, per instruction item 14:
-- conservative by default, and none of the four rules above is backed
-- solely by OTHER_HIGH_COURT/INTERNAL_GUIDANCE material in a way that would
-- justify one. Contextual enforcement is LK-5's scope, not LK-2's.
