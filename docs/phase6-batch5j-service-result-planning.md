# Phase 6 Batch 5J — Service Result / Notice Escalation: READ-ONLY Planning

**Status: planning only. No code, schema, or data was changed to produce this document. No migration was applied. No PIM number was consumed (`pim_number_sequences.last_number` remains 118 for 2026; `PIM/119/2026` remains reserved). `dlsa-mis` was never queried.**

Scope boundary for this document: everything from the **5I boundary** (`SERVICE_PENDING`, reached by `issueForm2NoticePg`) forward to the point a case reaches one of: opposite party served / response awaited, fresh Initial notice required, Final Notice required, address correction required, non-starter eligibility, or the participation/consent workflow's own entry point. OP response/consent itself is audited only to the extent it is a direct dependency — it is not planned for migration here.

---

## 1. Current service state machine (as implemented today, SQLite, unmigrated)

All of the following live in `app/api/pim/service/[id]/route.js`, `app/api/pim/address-correction/[id]/route.js`, `lib/pim-fresh-notice.js`, and (for the Final-Notice-returned short-circuit) `lib/pim-op-response.js`'s `createNonStarterHandoff`. None of this code is PostgreSQL-backed yet.

```
SERVICE_PENDING  (case status; notice.status = 'DISPATCHED', set by 5I's issueForm2NoticePg)
   │
   │  POST /api/pim/service/[id]  { serviceAttemptId, result }
   │
   ├─ result = TRACKING_UPDATE ──────────────────────────────────────────────
   │     notice.status unchanged ('DISPATCHED'); case status unchanged.
   │     Only tracking_status/postal_endorsement updated on the attempt row.
   │
   ├─ result = DELIVERED ────────────────────────────────────────────────────
   │     notice.status → 'SERVED'
   │     case status UNCHANGED (stays SERVICE_PENDING — the next business
   │     step is OP response/appearance, not a case-status transition)
   │     docket: NOTICE_DELIVERED
   │
   └─ result = RETURNED  (requires returnReason ∈ {ADDRESSEE_LEFT,
       INSUFFICIENT_ADDRESS, UNCLAIMED, REFUSED_BY_ADDRESSEE, OTHER};
       OTHER additionally requires remarks + administrativeAction ∈
       {SEEK_CORRECTED_ADDRESS, PROCEED_TO_FINAL_NOTICE})
         notice.status → 'RETURNED'
         status_history row written: SERVICE_PENDING → NOTICE_RETURNED
           (see §22 — this is a TRANSIENT hop: pim_cases.current_status_id
           is NOT updated to NOTICE_RETURNED in two of the three branches
           below; only status_history records it, the same "never rests"
           pattern Batch 5H-b uses deliberately for REGISTERED — except
           here it is not called out anywhere in the code's own comments)
         docket: NOTICE_RETURNED
         │
         ├─ notice.notice_type = FORM_2_FINAL  ───────────────────────────
         │     case status LEFT UNCHANGED (stays SERVICE_PENDING; the
         │     response payload even says so: caseStatus: "SERVICE_PENDING")
         │     createNonStarterHandoff(...) → ensures a pending
         │     NONSTARTER_FORM3 task exists (dedup'd, Phase 4/op-response
         │     helper). This is the ONLY place in the whole service/
         │     address-correction surface that reaches toward Non-Starter
         │     directly from a service fact alone, with no OP-response
         │     dependency.
         │
         ├─ returnReason ∈ {ADDRESSEE_LEFT, INSUFFICIENT_ADDRESS}
         │  OR (OTHER + administrativeAction = SEEK_CORRECTED_ADDRESS) ──
         │     case status → ADDRESS_CORRECTION_PENDING
         │     task created: ADDRESS_CORRECTION (dedup'd)
         │     docket: ADDRESS_REQUESTED
         │
         └─ returnReason ∈ {UNCLAIMED, REFUSED_BY_ADDRESSEE}
            OR (OTHER + administrativeAction = PROCEED_TO_FINAL_NOTICE) ─
               case status → FINAL_NOTICE_PENDING
               task created: FINAL_NOTICE_FOLLOWUP (dedup'd)
               (no docket call in this specific branch — confirmed by
               direct re-read; every OTHER branch above and below writes
               one, this one does not)

ADDRESS_CORRECTION_PENDING
   │
   │  POST /api/pim/address-correction/[id]  { serviceAttemptId, decision }
   │
   ├─ decision = CORRECTED_ADDRESS_RECEIVED ────────────────────────────────
   │     new pim_addresses row inserted (old same-type address flipped to
   │     is_current=0, never deleted — history preserved)
   │     pending ADDRESS_CORRECTION task completed, if one exists
   │     docket: CORRECTED_ADDRESS_RECEIVED, then FRESH_FORM2
   │     createFreshInitialNotice(...) → new pim_notices row
   │       (FORM_2_INITIAL, status=PREPARED, new address_id) — the
   │       ORIGINAL returned notice row is untouched, never overwritten
   │     case status → FORM2_PENDING  (loops back into 5I's
   │       prepareForm2NoticePg/generateForm2DocumentPg/issueForm2NoticePg
   │       for the fresh notice — already PostgreSQL)
   │
   └─ decision = NO_CORRECTED_ADDRESS  (requires confirmed=true + remarks)
         pending ADDRESS_CORRECTION task completed, if one exists
         docket: NO_CORRECTED_ADDRESS
         case status → FINAL_NOTICE_PENDING
         task created: FINAL_NOTICE_FOLLOWUP (dedup'd)

FINAL_NOTICE_PENDING
   │  (reached from: service RETURNED+UNCLAIMED/REFUSED_BY_ADDRESSEE/OTHER,
   │   OR address-correction NO_CORRECTED_ADDRESS)
   │
   │  Converges on 5I's ALREADY-MIGRATED PostgreSQL Prepare/Generate/Issue
   │  (prepareForm2NoticeTx with noticeType='FORM_2_FINAL', which internally
   │  calls the Postgres-ported createFreshNoticeTx) → FINAL_NOTICE_ISSUED
   │  → SERVICE_PENDING again (the Final Notice gets its own service cycle
   │  through the exact same state machine above — a Final Notice RETURNED
   │  always routes to the non-starter handoff branch, never back to
   │  address correction or a second Final Notice).
```

**Separately, OP response** (`pim_responses`, `app/api/pim/response/[id]`, `consent/[id]` — not audited line-by-line here, out of scope) is reachable once a notice reaches `SERVED` (delivered) or, per `requireIssuedNoticeForParty`, `DISPATCHED`/`SERVED` generally — this is the "opposite party served / response awaited" meaningful downstream state named in the task, and it is a **dependency of T7's auto-inference** (§16), not something 5J mutates.

## 2. SOP-required service state machine (clauses 5–6)

Per `docs/phase6-pim-sop-2026-reconciliation-audit.md` §7–8, the SOP's own sequence is coarser than the implementation's:

```
Notice served by post or email
  → if OP fails to appear / no response → final notice (clause 6)
  → if notice undelivered / returned → [implementation detail not prescribed
     by the SOP text itself — clause 5(b) only says updated contact details
     "shall be considered for effecting service," and private notice "may
     be permitted... for sufficient reasons"]
  → if OP refuses/unwilling → non-starter eligible
  → if service impossible despite reasonable attempts → non-starter eligible
```

The SOP describes **outcomes and permitted channels**, not a detailed state machine — it leaves the "how many attempts, what counts as a reasonable attempt, what the intermediate workflow looks like" entirely to implementation. This matters directly for §3: the existing implementation is **more granular than the SOP requires**, not less — nothing here is a conflict, only places where the SOP is silent and the implementation has already made a reasonable choice.

## 3. Difference / reconciliation table

| SOP concept | Existing implementation | Status |
|---|---|---|
| Service by post | Full state machine above (§1) | MATCH, and more granular than the SOP prescribes |
| Service by email | No channel distinction anywhere (§8) | MISSING — genuinely new, not a gap in existing logic |
| Private notice, Authority permission | No representation at all (§7, also flagged in the earlier SOP audit) | MISSING |
| "Updated communication details... considered for effecting service" | Address-correction workflow (§1, §9) | MATCH |
| OP fails to appear/no response → final notice | `DID_NOT_APPEAR`/absence response type feeds `inferNonStarterContext`, which is reachable only via T7, which is OP-response-dependent — but the **direct** "undelivered → escalate toward final notice" path (service RETURNED + UNCLAIMED/REFUSED_BY_ADDRESSEE/OTHER→PROCEED_TO_FINAL_NOTICE) exists independently of OP response | MATCH, via two independent paths (see §16) |
| Service impossible despite reasonable attempts → non-starter eligible | Final-Notice-RETURNED branch calls `createNonStarterHandoff` directly; Initial-Notice-RETURNED routes to address correction first (one more "reasonable attempt") before ever reaching Final Notice | MATCH — this already *is* the "reasonable attempts" sequencing the SOP gestures at |
| OP refuses/unwilling → non-starter eligible | `REFUSED_BY_ADDRESSEE` (postal refusal, a **service** fact) is explicitly and correctly kept distinct from `OP_REFUSED` (an **OP response** fact, a different later workflow) — see the code's own comment at `service/[id]/route.js` lines 689–695 | MATCH, and notably more careful than a naive reading of the SOP might produce |

## 4. Existing tables/columns involved

- `pim_notices` — `status` (free text, no CHECK constraint: `PREPARED`/`SIGNED`/`DISPATCHED`/`SERVED`/`RETURNED` observed in code, never enumerated at the schema level), `notice_type` (CHECK-constrained: `FORM_2_INITIAL`/`FORM_2_FINAL`/`OTHER`), `address_id`, `document_id`, `recipient_party_id`.
- `pim_service_attempts` — `notice_id`, `address_id`, `dispatch_mode` (free text, default `'REGISTERED_POST'`, **no CHECK constraint** — confirmed by direct schema re-read, not assumed), `dispatch_date`, `postal_receipt_no`, `tracking_no`, `tracking_status`, `postal_endorsement`, `return_reason` (CHECK-constrained: `ADDRESSEE_LEFT`/`INSUFFICIENT_ADDRESS`/`UNCLAIMED`/`REFUSED_BY_ADDRESSEE`/`OTHER`), `delivered_date`, `returned_date`, `proof_document_id`, `remarks`.
- `pim_addresses` — `is_current` flip-not-delete pattern (already proven by the address-correction route).
- `pim_tasks`/`pim_task_history` — `ADDRESS_CORRECTION`, `FINAL_NOTICE_FOLLOWUP`, `NONSTARTER_FORM3` task types, all using the existing `createPendingTaskIfNotExists`/`completeTask` dedup pattern.
- `pim_docket`/`pim_status_history` — `NOTICE_DELIVERED`, `NOTICE_RETURNED`, `ADDRESS_REQUESTED`, `CORRECTED_ADDRESS_RECEIVED`, `FRESH_FORM2`, `FINAL_NOTICE`, plus the additively-seeded `NO_CORRECTED_ADDRESS` event (inserted via `INSERT OR IGNORE` at first use — the one place in this whole surface that writes master data as a side effect of a business transaction, worth deciding whether to keep that pattern or pre-seed it in the Postgres port, §14).
- `status_master` — `SERVICE_PENDING`(8), `NOTICE_RETURNED`(9), `ADDRESS_CORRECTION_PENDING`(10), `FINAL_NOTICE_PENDING`(11), `FINAL_NOTICE_ISSUED`(12) are the live codes/ids (re-verified against the seed file, not assumed).
- `pim_responses` — read-only dependency for T7's inference (§16), not written by anything in this batch's scope.

## 5. Missing SOP data

Exactly the two items the earlier audit already flagged, confirmed again from the code side in this pass:

1. **Email-service representation** — no column anywhere distinguishes a postal attempt from an email attempt; `dispatch_mode` is free text with no enum, so this is additive, not a conflict.
2. **Private-notice Authority-permission record** — no table/column anywhere records a decision, a decider, or a reason distinct from the ordinary staff action that would record it.

Everything else audited in this pass (affidavit, discussed next) is intake/Form-2-preparation-stage, not strictly a 5J-stage gap, but is addressed here because the task asked for a recommendation.

## 6. Affidavit design recommendation

**Smallest auditable representation**: two columns —

```
contact_affidavit_received   boolean (or smallint, matching this project's
                              existing tri-state convention elsewhere)
contact_affidavit_date       date
```

**Where it belongs**: **per opposite party, at Form-2 preparation time (Prepare), not at intake and not per-address.**

Reasoning:
- The SOP's own wording (clause 5(a)) ties the affidavit to the specific postal address/phone/email **being used to serve notice on a specific opposite party right now** — "correct and in use during the preceding 30 days" is a claim about currency at the moment of service, not a one-time fact about the case. An address correction (§9) genuinely changes what is being attested to; the original affidavit does not retroactively cover a corrected address.
- Intake (`lib/pim.js`/`lib/pim-data/intake.js`, already migrated, Batch 5C) records opposite-party contact details but has no per-opposite-party "service is about to happen" moment — multiple opposite parties can exist, and not all are necessarily served at once. Attaching the affidavit requirement to the Prepare step (which is already per-opposite-party, per-notice-type, in `prepareForm2NoticeTx`) is the natural point where "we are about to serve this specific party at this specific address" is already being decided.
- A per-address-and-contact-set model (a column on `pim_addresses`) would be more granular than needed and would multiply awkwardly when a party has several address rows only one of which is actually being used for this notice.

**Concretely**: add the two columns to `pim_notices` (not a new table — this is a fact about *this specific notice's* preparation, exactly parallel to how `pim_notices.prepared_by`/`signed_by` already record who-did-what-when for this notice, not a case-level or party-level fact). `prepareForm2NoticeTx` would accept and store them alongside the existing fields it already writes.

**Do not build document-management machinery.** No separate affidavit-document table, no file upload requirement — a boolean + date, optionally backed by the *existing* `pim_documents` table if a scanned affidavit is ever actually uploaded (reusing the general document model, not inventing a parallel one), is sufficient. This mirrors the audit's own instruction not to invent excessive machinery.

## 7. Private-notice authority-decision design

**What is actually necessary** — four fields, not more:

```
decision          text   (e.g. 'PERMITTED' / 'DECLINED' — small enough
                          that a CHECK-constrained enum is reasonable)
decision_date     date
decided_by        bigint references users(id)   -- the Nodal Officer/
                                                    Authority responsible,
                                                    per the frozen rule 8
                                                    distinction
reason            text   (the SOP's own "sufficient reasons" requirement —
                          without this, "permission" is not auditable)
```

`recorded_by` is **not a separate column** — it is already implicit as whichever `userId` the enclosing transaction's caller is (every write in this codebase already attributes `entered_by`/`changed_by`/`created_by` to the acting session's user). Adding a fifth field to duplicate that would be redundant: the distinction the frozen rules actually require is **decided_by** (the Authority responsible, which may not be the staff member physically clicking) **vs.** the ambient `userId` every table already carries (who operated the software) — not a third "recorded_by" on top of both.

**Where it lives**: a `pim_notices`-scoped record, same reasoning as §6 — private notice is a decision about *how this specific notice is served*, not a case-level fact. Candidate shape: either four new nullable columns on `pim_notices` (cheapest, consistent with §6's choice) or, if the Nodal Officer model (frozen rule 8, not yet built) ends up needing a general "authority decision" table reused by private notice *and* the nonstarter-authority-decision branch *and* future SOP-driven decisions, a small shared `pim_authority_decisions` table keyed by `(decision_type, case_id or notice_id)` would avoid duplicating the same four columns across multiple tables later. **This batch does not decide between those two** — it is exactly the kind of decision that belongs with the Nodal Officer model's own design pass (frozen rule 8), not bolted on ad hoc here. Flagged, not resolved.

**Explicitly not a login-gated approval workflow.** The decision fields describe a fact that was decided (by whoever is the Nodal Officer/Authority for this DLSA — a `system_settings`-configured identity per the earlier audit's §14 recommendation, not necessarily someone who logs into this software at all), recorded by whichever staff account performs the data entry. No new permission needs to gate on "is this user logged in as the Nodal Officer" — `decided_by` is an attribution field, not an authorization check.

## 8. Email-service representation

Per the task's explicit instruction, **no sending mechanism is designed here** — only the case-management representation, and only if an existing sending mechanism doesn't already exist. Confirmed by grep: no email-sending library, SMTP config, or `nodemailer`-style dependency exists anywhere in `package.json` or `lib/`. None is proposed.

**What the workflow needs to make meaningful decisions**, matching the task's own checklist:

| Need | Representation |
|---|---|
| Notice delivery/sent timestamp | Reuse `pim_service_attempts.dispatch_date` (already generic — "when this attempt was made," not postal-specific by meaning, only by current usage) |
| Destination email | New nullable `pim_service_attempts.dispatch_email` — `pim_parties.email` already exists, but the attempt should freeze *which* email address was actually used at dispatch time, the same reasoning `pim_notices.address_id` already applies to postal address (never trust "look it up from the live party row" for a historical fact) |
| Delivery evidence | Reuse `delivered_date` (generic) |
| Bounce/failure evidence | Reuse `returned_date` + `return_reason` — **but `return_reason`'s existing CHECK enum is postal-shaped** (`ADDRESSEE_LEFT`, `INSUFFICIENT_ADDRESS`, `UNCLAIMED`, `REFUSED_BY_ADDRESSEE`, `OTHER`). A bounce isn't natively any of these. `OTHER` technically fits today (with `remarks` carrying the real reason), but a cleaner long-term fit would widen the enum with an email-shaped value (e.g. `BOUNCED`) **when email service is actually built** — not now. |
| Response evidence | Out of scope — "response" is `pim_responses`, a different table/workflow entirely, already correctly separated from service facts (§3's refusal-vs-OP_REFUSED distinction already proves this separation is deliberate and should stay) |

**Minimum-necessary addition if/when email is built**: `dispatch_mode = 'EMAIL'` (already representable, free text) + one new nullable column (`dispatch_email`) + one new `return_reason` enum value. Nothing else.

## 9. Address-correction compatibility analysis

The task asks whether the current model preserves `original address used for notice → failed attempt → updated address → new notice` without overwriting historical evidence. **Yes, confirmed by direct re-read, and this is exactly the model 5J should build on, not replace:**

- The **original** returned notice row (`pim_notices`) is never updated to point at the new address — `notice.address_id` stays whatever it was when prepared. `createFreshInitialNotice` always inserts a **new** `pim_notices` row.
- The **original** `pim_service_attempts` row (the failed attempt) is never deleted or overwritten by the correction — it remains linked to the original notice, its `return_reason`/`returned_date`/`postal_endorsement` intact.
- The **original** `pim_addresses` row is never deleted — only `is_current` is flipped to `0` for same-type rows before the new one is inserted with `is_current = 1`. Every historical address remains queryable (already exercised by the existing `allAddresses` query in `form2/[id]/route.js`'s kept SQLite GET helper and `lib/pim-data/form2.js`'s `getOppositePartiesPg`, which both expose `addresses` (current) and `allAddresses` (full history) separately — Batch 5I already deliberately built this distinction, per its own comment: *"Final Notice may legitimately need a superseded address... Current-only `addresses` above remains the Initial-notice default; `allAddresses` lets the Final Notice UI offer every address on record."*).
- **This is exactly the `notice.address_id` + notice-scoped-documents model Batch 5I already established and the task explicitly says to build on.** No redesign is indicated; 5J's address-correction port should reuse `createFreshNoticeTx` (already PostgreSQL, already proven by 5I's own test suite) rather than reimplementing fresh-notice creation.

## 10. Final Notice rules — four distinct conditions, not one generic ABSENT

| | Condition | Current trigger |
|---|---|---|
| A | Initial notice successfully served, OP does not appear/respond | **Not a 5J-stage trigger at all** — this is `pim_responses.response_type = 'DID_NOT_APPEAR'` (OP-response stage, out of scope), feeding `inferNonStarterContext`'s tier 2, which produces `FINAL_NOTICE_UNACKNOWLEDGED`/`OP_FAILED_TO_APPEAR_AFTER_TIME` directly as a **non-starter** reason — it does **not** route through a second Final Notice at all. (A served-but-silent OP does not get re-noticed by this implementation; it goes straight to non-starter eligibility once OP-response recording establishes the absence fact.) |
| B | Initial notice returned/unserved (routine postal failure, first attempt) | `ADDRESSEE_LEFT`/`INSUFFICIENT_ADDRESS` → address correction first (§9), **not** Final Notice directly; only after `NO_CORRECTED_ADDRESS` does it reach `FINAL_NOTICE_PENDING` |
| C | Service impossible despite reasonable attempts | `UNCLAIMED`/`REFUSED_BY_ADDRESSEE` (postal refusal — treated as "attempted, failed definitively," not worth a correction cycle) → `FINAL_NOTICE_PENDING` directly; **or** the address-correction `NO_CORRECTED_ADDRESS` path (B's natural continuation after a failed correction attempt) |
| D | OP expressly refuses/unwilling to participate | **Not a Final Notice trigger** — this is an OP-response fact (`OP_REFUSED`), explicitly and deliberately kept separate from any service fact (§3). A refusal does not need a Final Notice; it is already final. |

**These four are correctly NOT collapsed into one generic ABSENT outcome in the existing implementation** — the task's instruction not to collapse them is already satisfied by the current design, confirmed by this trace. The one gap is that **A has no "re-notice" step at all** (by design — a served notice that produces silence doesn't need a second notice attempt, only an eventual non-starter determination once OP-response recording confirms the silence), which is worth stating explicitly since it could otherwise look like a missing Final-Notice path rather than a deliberate one.

## 11. Non-starter eligibility matrix (T7 prerequisites, not modified)

| Reason code | Auto/manual | Eligibility fact required | Where that fact comes from |
|---|---|---|---|
| `OP_REFUSED_MEDIATION` | Auto | A `pim_responses` row with `response_type='REFUSED'` or `APPEARED` with `consent=0` | OP-response stage (out of scope for 5J) |
| `OP_FAILED_TO_APPEAR_AFTER_TIME` | Auto | A `pim_responses` row with `response_type='DID_NOT_APPEAR'` AND a prior `SOUGHT_TIME` response for the same party | OP-response stage |
| `FINAL_NOTICE_UNACKNOWLEDGED` | Auto | Either a `DID_NOT_APPEAR` response with no prior `SOUGHT_TIME` (OP-response stage), **or** a `pim_service_attempts`/`pim_notices` row showing a Final Notice `RETURNED` (service stage — **this is 5J's own direct dependency**, already live in `service/[id]/route.js`'s FORM_2_FINAL-returned branch) | Both service stage and OP-response stage, independently |
| `BOTH_PARTIES_NOT_WILLING` | Manual | None (staff-asserted) | n/a |
| `MEDIATION_FEE_NOT_SUBMITTED` | Manual | None (staff-asserted); seed `remarks` still says "Operational ground; verify" — per the earlier audit's §8 recommendation, this should eventually cite SOP clause 6(f)/9, a metadata-only fix, not in 5J's scope | n/a |

**All five `MANUAL_REASON_CODES`/`AUTO_TRIGGERED_REASON_CODES` remain valid** — nothing in this trace found a reason that no longer corresponds to a real workflow path, and nothing found a workflow path with no corresponding reason. T7 itself is unmodified, per the task's instruction.

## 12. Concurrency / locking analysis

Every current SQLite route in this surface uses a single `db.transaction(() => {...})()` with **check-then-write, no explicit row lock** — safe only because SQLite serializes all writers against the whole database file. Five concrete races, each checked against what a Postgres port needs:

1. **Recording the same service result twice** (double-click / retry on the same `serviceAttemptId`). Current guard: `attempt.notice_status !== 'DISPATCHED'` → conflict. **Race window**: two concurrent POSTs both read `notice_status = 'DISPATCHED'` before either writes. **Fix for the port**: lock the **notice** row (`SELECT ... FOR UPDATE`) before reading `notice_status`, exactly as `issueForm2NoticeTx` (5I) already does for its own "already dispatched" guard — same pattern, not a new one.

2. **Two users recording conflicting outcomes** (e.g. one submits DELIVERED while another submits RETURNED for the same attempt). Same lock as #1 closes this — the loser re-reads post-lock and hits the status guard.

3. **Simultaneous address correction and service-result recording on the same case.** These two routes gate on mutually exclusive case statuses (`SERVICE_PENDING` vs. `ADDRESS_CORRECTION_PENDING`) — genuine overlap requires one request to be mid-transition while another reads stale case status. **Fix**: lock the **case** row (`SELECT ... FOR UPDATE`) first in both routes, before checking `current_status_id`, exactly as `prepareForm2NoticeTx` (5I) already does. This closes the case-level race the same way 5I already closed it for Prepare.

4. **Final Notice creation twice** (e.g. two concurrent "no corrected address" / "proceed to final notice" submissions for the same case). The case-row lock from #3 closes this too — whichever request commits first advances `current_status_id` away from the status the loser's guard requires, so the loser's re-read after acquiring the lock fails cleanly.

5. **Service-result recording while another request advances the case** (e.g. a stale client retries a service POST after the case already moved to `ADDRESS_CORRECTION_PENDING` via another path). Closed by the same case-row lock — the notice-level lock (#1) is necessary but not sufficient here, since the case's own status also needs re-checking post-lock, exactly as `issueForm2NoticeTx` locks **both** the notice and the case for this reason.

**Recommended locking order, generalized from 5I's own precedent**: lock the **case** row first, then the **notice** row (`FOR UPDATE OF c`, then `FOR UPDATE OF n`, matching `issueForm2NoticeTx`'s existing `FOR UPDATE OF n` / `FOR UPDATE OF c` ordering — case before notice is the established convention in this codebase's one already-ported example of a two-row lock, and reversing the order anywhere would be a genuine new deadlock risk against 5I's own code, not just a style preference). **Do not reproduce the current SQLite check-then-write pattern blindly** — every mutating function in the 5J port needs its own `FOR UPDATE` before any guard read, exactly as 5I's `form2.js` module-level comment already states as the governing principle for this codebase's Postgres transactions.

No new unique constraint appears necessary for any of these five races — as with 5I (§4 of that batch's own document) and 5E/T2 before it, row-level locking that serializes every actual write path makes an additional backstop constraint a defense-in-depth nicety, not a correctness requirement. This should be re-verified against the live schema (`pg_constraint`/`pg_indexes` on `pim_service_attempts`, `pim_addresses`, `pim_notices`) at actual implementation time, the same way it was checked for 5I.

## 13. Proposed PostgreSQL transaction boundaries

Following 5I's established one-function-per-mutation shape in `lib/pim-data/form2.js`:

- **`recordServiceResultTx`** — the `DELIVERED`/`RETURNED`/`TRACKING_UPDATE` POST. Locks case then notice. Internally branches exactly as §1 describes, including the direct `createNonStarterHandoff` call for a returned Final Notice (reusing the Postgres `createPendingTaskIfNotExists`-equivalent already in `lib/pim-data/workflow-helpers.js`, not reinventing it).
- **`recordAddressCorrectionTx`** (two decisions, `CORRECTED_ADDRESS_RECEIVED` / `NO_CORRECTED_ADDRESS`) — locks case then the target service-attempt's notice. The `CORRECTED_ADDRESS_RECEIVED` branch calls the **already-PostgreSQL** `createFreshNoticeTx` from `lib/pim-data/form2.js` directly — this is the one place 5J's design should explicitly depend on 5I's code, not duplicate it.
- Each is its own `withTransaction(...)` call, matching the "one function, one transaction" shape every prior batch (5D, 5E, 5I) already uses — no cross-function transaction sharing.

## 14. Required schema changes (not applied — recommendation only)

Minimal, additive, nothing destructive:

1. `pim_notices.contact_affidavit_received boolean`, `pim_notices.contact_affidavit_date date` (§6) — **only if the affidavit requirement is being built in the same pass as 5J; otherwise defer entirely**, since 5J's own boundary (service result, not intake/Prepare) does not strictly require it. Flagged as a scheduling decision, same as the earlier SOP audit's §22 noted for Batch 5I.
2. Private-notice fields (§7) — **not recommended for 5J itself**; this depends on the not-yet-designed Nodal Officer model (frozen rule 8) and should wait for that design pass rather than being bolted onto 5J ad hoc.
3. `NO_CORRECTED_ADDRESS` event type — already exists as master data (seeded via the SQLite route's own `INSERT OR IGNORE` the first time it runs). The Postgres port should **pre-seed it as a proper migration row** (matching the other 83+ seeded `event_types` rows) rather than reproducing the SQLite route's "insert master data as a side effect of a business transaction" pattern, which is a style this codebase does not use anywhere else.
4. Email-service columns (§8) — **not recommended for 5J**; defer until email service is actually being built, per the task's explicit instruction not to build it now.

**If 5J is scoped to service-result + address-correction only (recommended, §17), no schema change is required at all** — every column it needs already exists.

## 15. Route/data-layer migration plan (outline only)

```
app/api/pim/service/[id]/route.js            → lib/pim-data/service.js  (new)
app/api/pim/address-correction/[id]/route.js → lib/pim-data/service.js  (same module —
                                                 these two routes are tightly coupled,
                                                 sharing the candidate-service-attempt
                                                 query shape and the fresh-notice
                                                 dependency; splitting them into two
                                                 modules would duplicate helpers for
                                                 no benefit)
```

Kept-as-rollback pattern: both SQLite route bodies renamed/kept-unused, exactly as every prior batch (`prepareForm2Sqlite`, `issueForm2Sqlite`, etc.).

`lib/pim-data/service.js` would depend on: `lib/pim-postgres.js` (`withTransaction`/`getSql`), `lib/pim-data/workflow-helpers.js` (`getStatusId`/`addStatusHistory`/`addDocket`), and `lib/pim-data/form2.js`'s exported `createFreshNoticeTx` (§9, §13) — the first batch in this migration series to explicitly depend on another already-ported batch's own transaction helper, which is a natural and low-risk coupling given both modules already live in `lib/pim-data/`.

## 16. Dedicated test matrix (design only, not written)

Modeled on `scripts/test-pim-form2-postgres.js`'s own letter scheme:

- **Static**: routes call the Postgres functions, not the kept SQLite originals; no file/Storage writes anywhere in this surface (there never were any — service/address-correction write no documents); both mutations lock case-then-notice before any guard read.
- **A–D (service result)**: DELIVERED success; RETURNED success for each of the 5 return reasons × both OTHER sub-actions; TRACKING_UPDATE no-status-change; wrong-case-status rejection; wrong-notice-status rejection (already SERVED/RETURNED).
- **E (Final-Notice-returned)**: confirms `createNonStarterHandoff` fires exactly once, case status stays SERVICE_PENDING, a pending NONSTARTER_FORM3 task exists and is dedup'd on a second attempt.
- **F–H (address correction)**: CORRECTED_ADDRESS_RECEIVED creates a new address (old one flipped, not deleted) + a new notice (original untouched) + case → FORM2_PENDING; NO_CORRECTED_ADDRESS → FINAL_NOTICE_PENDING + task; wrong-decision/wrong-case-status rejections.
- **I (concurrency)**: same-attempt concurrent service-result double-submit (exactly one commits); same-case concurrent address-correction double-submit; a service-result POST racing an address-correction POST for the same case (only one case-status transition survives).
- **J (end-to-end)**: a 5I-created case (Prepare→Generate→Issue, already proven) carried through RETURNED→address-correction→fresh notice→Prepare/Generate/Issue again (reusing 5I's own functions)→SERVICE_PENDING a second time — proving the two batches compose correctly, not just independently.
- **RESIDUE**: exact-id fixture cleanup; `pim_number_sequences` untouched; PIM/119/2026 confirmed untouched (same doctrine as every prior suite).

## 17. Exact recommended Batch 5J boundary

**`SERVICE_PENDING → record service result → determine next workflow state → create required follow-up task/state`, exactly as the task's own preferred shape — confirmed technically coherent by this trace, with one adjustment stated explicitly:**

Include **both** `recordServiceResultTx` (service result) **and** `recordAddressCorrectionTx` (address correction) in the same batch, not service-result alone. Reasoning: address correction is not a separable downstream batch — it is the direct, single continuation of the `ADDRESS_CORRECTION_PENDING` state that only `recordServiceResultTx` itself can produce (§1), it reuses 5I's `createFreshNoticeTx` directly (§9, §13), and leaving it for a later batch would leave a case stuck at `ADDRESS_CORRECTION_PENDING` with no PostgreSQL path forward — a dead end, not a clean stopping point. This mirrors 5I's own reasoning for including the first `pim_service_attempts` row atomically with Issue rather than treating it as a separate batch.

**Resulting states this batch's mutations can produce** (confirmed against the live `status_master`, not assumed):

- `SERVICE_PENDING` (DELIVERED, or TRACKING_UPDATE — unchanged)
- `ADDRESS_CORRECTION_PENDING` (RETURNED + ADDRESSEE_LEFT/INSUFFICIENT_ADDRESS/OTHER-seek-address)
- `FINAL_NOTICE_PENDING` (RETURNED + UNCLAIMED/REFUSED_BY_ADDRESSEE/OTHER-proceed, or NO_CORRECTED_ADDRESS)
- `FORM2_PENDING` (CORRECTED_ADDRESS_RECEIVED — looping back into 5I's own already-migrated states)

**Note, per the task's own caution**: `OP_RESPONSE_PENDING` does **not exist** as a status code in the live `status_master` — there is no status by that name. The actual OP-response-adjacent states are `OP_APPEARANCE_PENDING`/`OP_APPEARED`/`OP_CONSENT_PENDING`/`OP_CONSENTED`/`OP_REFUSED`, none of which this batch's mutations ever set (a `SERVED` notice leaves the case at `SERVICE_PENDING`, per §1 — the OP-response stage reads that state but 5J does not transition into any `OP_*` status itself). This is stated explicitly because the task flagged it as something to verify rather than assume, and the assumption would have been wrong.

**5J does NOT migrate OP response/consent.** Confirmed separable: nothing in `recordServiceResultTx`/`recordAddressCorrectionTx` writes `pim_responses` or reads it for a guard (T7's `inferNonStarterContext` reads it, but T7 itself is out of scope and unmodified).

## 18. Impact on T7 and future OP-response migration

- **T7 impact**: none to its code (unmodified, per instruction). Its **data dependency surface** is partially satisfied by 5J (the `pim_service_attempts`/`pim_notices` half of `inferNonStarterContext`'s three tiers) and partially not (the `pim_responses` half, tiers 1–2). Once 5J ships, T7 running against a PostgreSQL-only case will work correctly for the Final-Notice-returned tier (tier 3) but tier 1–2 (refusal, absence) will still require a future OP-response migration batch before a PostgreSQL case can reach those non-starter reasons through inference — the **manual** reasons remain available regardless, since they don't depend on inference.
- **Future OP-response migration**: 5J's `recordServiceResultTx` is a **prerequisite** for it, not the reverse — `requireIssuedNoticeForParty` (the OP-response stage's own entry guard) requires a `pim_service_attempts` row to exist for the notice before any response can be recorded at all. A future OP-response batch can assume 5J's `pim_service_attempts` rows are already PostgreSQL-resident and build directly on them, the same way 5J itself builds on 5I's `pim_notices`/`pim_documents`.

## 19. Things that should explicitly remain unchanged

- **T7 (`lib/pim-nonstarter.js`, `lib/pim-data/nonstarter.js`)** — not touched, per instruction, and per §16/§18 its reason codes remain valid as-is.
- **The four-way Final Notice distinction (§10)** — already correctly un-collapsed; no redesign needed.
- **The refusal-vs-service-failure separation** (`OP_REFUSED` vs. `REFUSED_BY_ADDRESSEE`, §3/§10) — already correct, deliberate, and should be preserved exactly as-is in the port.
- **`notice.address_id` + notice-scoped history model** (§9) — already correct; 5J builds on it, does not redesign it.
- **5I's `createFreshNoticeTx`/`prepareForm2NoticeTx`/`issueForm2NoticeTx`** — reused by 5J, not reimplemented or forked.
- **The existing `return_reason` enum values** — correct as-is for postal service; only widen (additively) if/when email service is actually built, not now.
- **`MANUAL_REASON_CODES`/`AUTO_TRIGGERED_REASON_CODES`** (§11) — confirmed still valid; no change recommended.
- **Lint baseline**: 160 problems / 107 errors / 53 warnings (frozen by the prior turn) remains the baseline to compare any future 5J implementation against — not the older 154/104/50 figure.
- **`PIM/119/2026`** — not consumed; `pim_number_sequences.last_number = 118` for 2026, unchanged by this planning pass (no write of any kind was issued against Postgres in this session — only `SELECT`/`information_schema` reads in the prior turn, and no database tool was called at all in this turn).

---

*End of planning document. No migrations applied, no code modified, no data modified, no commit/stage/push performed, no PIM number consumed, `dlsa-mis` not touched. OP-response/consent/fee/mediator-assignment migration not started.*
