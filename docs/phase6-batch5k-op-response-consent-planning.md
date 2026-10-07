# Phase 6 Batch 5K — Opposite-Party Response + All-Party Consent: READ-ONLY Planning

**Status: planning only. No code, schema, or data was changed to produce this document. No migration was applied — the two `execute_sql` calls made were read-only `SELECT`s against `pim_responses`' live constraints. No PIM number was consumed. `dlsa-mis` was never queried.**

Frozen baseline reaffirmed at the start of this batch (per the prior turn's freeze): service-result and address-correction PostgreSQL migrations complete; NOTICE_RETURNED correction complete; contact-affidavit fields implemented; lint 160/107/53; 2026 sequence `last_number=118`; next genuine number `PIM/119/2026`; five-mediator panel intact.

---

## 0. REVISION — CONSENT COMPLETION ≠ FEE COMPLETION (added after a real DLSA case was raised, before any implementation)

**A real case was raised that this document's original §6/§12/§18 did not yet account for**: applicant and opposite party both consent → `FEE_PENDING` → opposite party pays their required share → **applicant does not pay theirs**. Under the original draft of this document, nothing distinguished "the consent gate is satisfied" from "the fee obligation is satisfied" — `FEE_PENDING` was treated, implicitly, as a single waypoint on the way to mediator assignment, without separately modeling that fee completion is its own gate with its own per-party state. That is wrong, and this revision corrects it before any code is written.

**The corrected model, binding on 5K and on whatever batch implements fee tracking after it:**

```
required parties consent (5K's own scope, ends here)
   → FEE_PENDING
   → [NOT 5K — a later, separate batch] individual fee obligations tracked per
     required paying side (applicant; opposite-party side, collectively if
     multiple)
   → ALL REQUIRED FEE SHARES PAID
   → MEDIATOR_ASSIGNMENT_PENDING
```

**`FEE_PENDING` is redefined, precisely, as of this revision**: *"the required consent prerequisite is satisfied, but mediation-fee obligations are not yet fully satisfied."* It is **not** "ready for referral," and it must never be read or coded as if reaching it means mediation can proceed — only that consent, specifically, is no longer the blocking condition. This redefinition changes nothing about what 5K itself implements (5K already only ever transitions a case *into* `FEE_PENDING`, never out of it — see §12/§18 below, revised) — it changes what every *future* reader of this document and of `FEE_PENDING` must understand that status to mean.

**Consequences for this document's existing sections**, applied below rather than rewriting them from scratch:
- §6 (All-Party Consent Gate) is unchanged in substance — it already only concerned itself with deriving consent completion, never fee completion. It is clarified, not redesigned.
- §12 (Mediation-Fee Handoff) is revised to state explicitly that 5K stops *before* any fee-obligation modeling, and that the future fee batch's data model must be per-paying-side, not a single boolean.
- §18 (Clean 5K Boundary) is revised to state the corrected pipeline above as the binding target shape, and to explicitly forbid folding fee payment into 5K's own consent aggregate.
- §19 (Test Matrix) gains the exact real-world regression fixture the task specified, scoped to the **future fee batch**, not to 5K's own suite (since 5K records no fee payments at all).
- A new §22 (below) reports the legal-classification finding this task required **before** any fee-non-payment closure branch is coded — STOP-and-report, not implemented.

**Partial-payment preservation, stated as a binding requirement for the future fee batch** (not implemented now, no code exists yet to preserve anything against): if one required side pays and another does not, the paying side's payment, receipt/evidence, and FK attribution must remain intact and queryable regardless of whatever happens to the case afterward — never rewritten, never silently refunded, never presented as if it were the whole statutory fee. The SOP's own refund policy (clause 22, quoted in §22 below) already states paid fees are non-refundable; nothing in this revision proposes an exception to that.

---

## 1. Starting States

Per the Batch 5J audit (confirmed again here, not re-guessed): **`OP_RESPONSE_PENDING` does not exist** as a status code. The actual live statuses an opposite-party response can legitimately be recorded from, read directly from `app/api/pim/response/[id]/route.js`'s own `RESPONSE_ENTRY_STATUSES` constant and its code paths:

| Entry status | How a case reaches it | Response types acceptable from here |
|---|---|---|
| `SERVICE_PENDING` | A notice reaches `DELIVERED` (5J's `recordServiceResultTx`) — the case itself never transitions away from `SERVICE_PENDING` on delivery, so this is genuinely where a served case sits awaiting response | `APPEARED`, `SOUGHT_TIME`, `REFUSED`, `DID_NOT_APPEAR` |
| `OP_APPEARANCE_PENDING` | `SOUGHT_TIME` response recorded from `SERVICE_PENDING` (an alternate date was granted) | `DID_NOT_APPEAR` (on the alternate date) — the code does not restrict `APPEARED`/`REFUSED` from this status via `RESPONSE_ENTRY_STATUSES`, since both are in the array; in practice the UI would record an appearance against this status too |
| `FEE_PENDING` (narrow exception) | One OP already consented (§6) | Only `APPEARED` + `consent=1` + `mediationFeeRequested=1` from a **different** opposite party — `isAdditionalConsentAfterFeePending`, a deliberate narrow carve-out, not a general re-entry |

**5J hands a served case forward by doing nothing further** — `recordServiceResultTx`'s `DELIVERED` branch leaves `pim_cases.current_status_id` unchanged at `SERVICE_PENDING` (confirmed in the 5J code and its own test 2, which exists specifically to assert this). 5K's job starts exactly there: the handoff is a no-op status, not a dedicated pending state, and no task is created by 5J to flag it — the only live signal that a case needs a response is its status (`SERVICE_PENDING` with a `SERVED` notice) and the absence of any pending task, which the worklist's `getCaseAction` already falls through to its `SERVICE_PENDING` branch for (currently mislabeled "Record Service" — a second, independent worklist-accuracy gap from 5J's own, since a `SERVED` notice case is not actually awaiting another service POST; flagged here, not fixed).

---

## 2. Existing Response Module — Full Audit

### `lib/pim-op-response.js` (SQLite, unmigrated)

Already fully read in a prior turn of this session; re-confirmed against the current (post-5J) file, unchanged by Batch 5J. Exports: `getStatusId`, `getEventId`, `addStatusHistory`, `transitionStatus` (status-history insert + case update, combined), `addDocket`, `getCase`, `getActiveOppositeParty` (scoped to `role='OPPOSITE_PARTY' AND active_to IS NULL`), `loadNotice`, `requireIssuedNoticeForParty`, `assertNotPremature`, `assertAlternateDateWithinWindow` (10-day ceiling on an alternate date), `getLatestResponse`, `getPendingTask`, `completeTask`, `completeTaskIfPending`, `createPendingTaskIfNotExists`, `createNonStarterHandoff` (thin wrapper around `createPendingTaskIfNotExists` targeting `NONSTARTER_FORM3`), `insertResponse`, `ensureMediationFee` (case-level dedup, full statutory fee, never halved).

### Routes

- `app/api/pim/response/[id]/route.js` — GET (case + opposite parties with their DISPATCHED/SERVED notices + all responses + `maxAlternateDate`) and POST (the four response types). Fully traced in §3–§9 below.
- `app/api/pim/consent/[id]/route.js` — POST only, for the **deferred** consent decision (an OP appeared without deciding consent at that moment; this route resolves it later). Gated strictly to `status_code === 'OP_APPEARED'`.

### UI / case-detail / worklist integration

- `lib/pim-action-link.js`: task-level `OP_CONSENT_FEE` → "Record Consent" / `/pim/response/[id]`; case-level `OP_APPEARANCE_PENDING`/`OP_APPEARED`/`OP_CONSENT_PENDING`/`OP_CONSENTED`/`OP_REFUSED` → "Record OP Response" / `/pim/response/[id]`. **Note**: `OP_CONSENT_PENDING` and `OP_CONSENTED` are listed status codes in this switch but **neither is ever the target of any `transitionStatus` call anywhere in the response/consent code** — confirmed by grep across `lib/pim-op-response.js` and both routes. They appear to be vestigial/aspirational status codes from the original status_master seed that the actual implementation bypassed in favor of going straight to `FEE_PENDING`. Flagged as a discrepancy (§3 of the output), not assumed to be load-bearing.
- `app/pim/case/[id]/page.tsx`'s progress stepper already groups `OP_APPEARANCE_PENDING`/`OP_APPEARED`/`OP_CONSENT_PENDING`/`OP_CONSENTED`/`OP_REFUSED` under an "OP Response" stage (confirmed in this session's earlier read) — compatible with the live code's actual status usage even though two of those five codes are never actually reached.
- Dashboard (`lib/pim-data/dashboard.js`): no dedicated bucket groups the response-stage statuses the way it does for `service_pending` — not independently verified further in this pass; flagged as a follow-up read if 5K's implementation wants a dashboard card.

### `pim_responses` (live PostgreSQL schema, confirmed via direct query, not assumed)

Columns: `id, case_id, party_id, notice_id, response_date, appearance_mode, response_type, time_requested_until, consent, mediation_fee_requested, remarks, entered_by`. **No unique constraint beyond the primary key** — confirmed live via `pg_constraint`/`pg_indexes`: only `pim_responses_pkey` and two non-unique indexes (`idx_responses_case` on `(case_id, response_date)`, `idx_responses_notice` on `notice_id`). Every FK (`case_id`, `notice_id`, `party_id`, `entered_by`) is present and correctly typed. This table was created structurally in Phase 2 and has never been written to by any Postgres-side code — Batch 5K would be its first writer.

### Notice/service prerequisites

`requireIssuedNoticeForParty` is the single gate standing between "a notice exists" and "a response can be recorded against it": the notice must belong to the named party, and its status must be `DISPATCHED` or `SERVED` — **not** `PREPARED` (unissued) and **not** `RETURNED` (a returned notice has no response; it has a service outcome, handled entirely by 5J). It also requires at least one `pim_service_attempts` row to exist for the notice. This is a real, enforced dependency on 5J's own output (the Issue step creates the first service attempt) — confirmed, not assumed.

### Non-starter interaction

Every refusal/absence branch calls `createNonStarterHandoff` directly — the exact same dedup'd `createPendingTaskIfNotExists(..., "NONSTARTER_FORM3", ...)` pattern 5J's own Final-Notice-returned branch uses. This module and 5J's `service.js` independently converge on the same handoff mechanism without either depending on the other's code.

---

## 3. Response Facts vs. Workflow Decisions

The task asks these to be kept distinct. Mapped against the actual code:

| | Concept | Where it lives in the code |
|---|---|---|
| A | Factual response received | A `pim_responses` row exists (any `response_type`) |
| B | Appearance / non-appearance | `response_type IN ('APPEARED','DID_NOT_APPEAR')` — these are the two "did the OP show up" facts |
| C | Willingness to participate | `consent = 1` on an `APPEARED` row (either recorded at appearance time or later via the consent route) |
| D | Unwillingness / refusal | `response_type = 'REFUSED'` (direct) **or** `response_type = 'APPEARED' AND consent = 0` (appeared-then-refused) — **two distinct code paths that both mean the same business fact**, confirmed in both `response/[id]/route.js` (the `REFUSED` branch and the `APPEARED`+`consent===0` branch) and `consent/[id]/route.js` (the `decision === 'REFUSED'` branch) |
| E | Consent to mediation | `consent = 1` — the same field as C; the code does not distinguish "willing to engage" from "formally consents to mediation" as separate facts, and nothing in the supplied SOP text asks it to |
| F | Workflow consequence | The `transitionStatus`/`createNonStarterHandoff`/`ensureMediationFee` calls that follow each fact |

**Postal refusal, non-appearance, unwillingness and refusal-to-participate are NOT collapsed in the current code** — confirmed:
- Postal refusal (`REFUSED_BY_ADDRESSEE`, a 5J service fact) never touches `pim_responses` or any `OP_*` status (verified by 5J's own test 4).
- Non-appearance (`DID_NOT_APPEAR`) is its own `response_type`, context-branched three ways (§7).
- Unwillingness/refusal (`REFUSED`, or `APPEARED`+`consent=0`) is its own `response_type`/field combination, routed to `OP_REFUSED` + non-starter handoff, never conflated with non-appearance.

This is a genuine strength of the existing design to preserve, not redesign.

---

## 4. Applicant Consent

**No mechanism exists.** Confirmed by direct code search: `insertResponse`/`pim_responses` are only ever called with the **opposite party's** `partyId` (via `getActiveOppositeParty`, which is hard-scoped to `role = 'OPPOSITE_PARTY'`). No code path ever creates a `pim_responses` row — or any other row — for the applicant's own consent.

**The SOP's own text** (clause 6(e), per the earlier reconciliation audit) requires "no referral to mediation without all parties expressly consenting" — "all parties" textually includes the applicant, not only the opposite party. **Filing the PIM application is not currently treated as applicant consent anywhere in the code** — there is no field, no flag, no derived value that reads "applicant has consented." It is simply absent, not implicitly assumed. Per the task's explicit caution, this document does **not** recommend treating filing-as-consent; it reports the gap as a gap. Whether applicant consent needs its own explicit capture step (e.g., at intake, or at a dedicated point in this workflow) is a genuine open design question for 5K's implementation phase, not resolved here.

---

## 5. Multiple Opposite Parties — the critical section

**Storage**: responses/consent are stored **per party, per notice** — `pim_responses.party_id` and `pim_responses.notice_id` are both always populated (confirmed: `insertResponse` never omits either), and `pim_case_parties` already supports multiple `OPPOSITE_PARTY` rows per case (confirmed in the schema and exercised by 5J's own fixture-building code, which creates a single OP per test case but the schema itself has no cardinality limit). This is the correct granularity — not case-level, not a mixture.

**Can each OP independently respond?** Yes, mechanically — each response row is scoped to its own `party_id`/`notice_id`, and `requireIssuedNoticeForParty` validates the notice belongs to the named party. Nothing prevents two different OPs from each having their own response history.

**Can one response incorrectly advance the whole case? YES — this is the central finding.** `transitionStatus` operates on `pim_cases.current_status_id` directly, with **zero check anywhere in `response/[id]/route.js` or `consent/[id]/route.js` for how many active opposite parties exist, or whether any of them besides the one responding have themselves consented.** The first opposite party to appear-and-consent (or to have a deferred consent recorded) immediately moves the **entire case** to `FEE_PENDING`, regardless of whether a second, third, or further required opposite party has responded at all. This is confirmed by direct re-read, not inferred: `response/[id]/route.js` lines ~389–437 fire `transitionStatus(..., "FEE_PENDING", ...)` on the first `APPEARED`+`consent=1`+`mediationFeeRequested=1` response with no multi-party check, and `consent/[id]/route.js` lines ~152–165 do the same for the deferred path.

**Partial, narrow accommodation already exists**: `isAdditionalConsentAfterFeePending` lets a **second** OP's consent be recorded *after* the case has already reached `FEE_PENDING` (from a *different* OP's earlier consent) without re-running the transition or duplicating the fee row. This prevents an outright error for the second consenting OP, but it does **not** gate the *first* transition on anything — it only cleans up after the fact. It is damage control, not a consent gate.

**What happens if a second OP instead refuses, after the case is already at `FEE_PENDING`?** Checked directly: `RESPONSE_ENTRY_STATUSES = ['SERVICE_PENDING', 'OP_APPEARANCE_PENDING']` does not include `FEE_PENDING`, and `isAdditionalConsentAfterFeePending` only matches `APPEARED`+`consent===1`+`mediationFeeRequested===1`. A `REFUSED` (or `APPEARED`+`consent=0`) submission against a case already at `FEE_PENDING` hits the generic guard and is rejected with "This case is not currently available for recording an OP response" — **a dead end**: the case has already moved toward mediation fee/mediator assignment based on one OP's consent, and the system provides no way to record that a *different* required OP has, in fact, refused. This is a genuine correctness gap relative to the SOP's "no referral without all-party consent," not a hypothetical — confirmed by tracing the actual guard logic, not assumed.

**How duplicate responses are prevented**: not by any database constraint (confirmed, §2) — only by the consent route's own application-level guard (`latestResponse.consent !== null` → reject a second consent decision on the *same* appearance record) and by the general case-status guard. A second `APPEARED` response for the *same* party+notice is not explicitly blocked by `response/[id]/route.js` itself (it would simply insert another row and attempt another transition, which the status guard would then reject once the case has already moved past `SERVICE_PENDING`/`OP_APPEARANCE_PENDING` — but only once the case *as a whole* has moved, not per-party).

**Historical traceability across different notices**: yes — `pim_responses.notice_id` is always populated and never reused/overwritten; a fresh notice after address correction (5J) gets its own, separate response history once served. Confirmed structurally sound.

### Designing `ALL_REQUIRED_PARTIES_CONSENTED` (design only, not implemented)

Per the task's instruction, prefer deriving this from source facts rather than persisting a duplicated boolean. The derivation, as a read query (not yet written as code):

```sql
-- "required" opposite parties: active (not withdrawn/excluded)
WITH required_parties AS (
  SELECT party_id FROM pim_case_parties
  WHERE case_id = :caseId AND role = 'OPPOSITE_PARTY' AND active_to IS NULL
),
-- latest response per required party (by id, matching getLatestResponse's
-- own ORDER BY id DESC convention elsewhere in this module)
latest_per_party AS (
  SELECT DISTINCT ON (party_id) party_id, response_type, consent
  FROM pim_responses
  WHERE case_id = :caseId AND party_id IN (SELECT party_id FROM required_parties)
  ORDER BY party_id, id DESC
)
SELECT
  (SELECT COUNT(*) FROM required_parties) AS required_count,
  (SELECT COUNT(*) FROM latest_per_party WHERE consent = 1) AS consented_count,
  (SELECT COUNT(*) FROM latest_per_party WHERE response_type = 'REFUSED' OR consent = 0) AS refused_count
```

`ALL_REQUIRED_PARTIES_CONSENTED` = `required_count > 0 AND consented_count = required_count AND refused_count = 0`. Excluded/withdrawn parties (`active_to IS NOT NULL`, the existing mechanism — confirmed live in the schema, already used by `getActiveOppositeParty`) are correctly excluded from `required_parties` by construction, no new column needed. This derivation needs no new table or column — `pim_case_parties.active_to` and `pim_responses` already carry everything required. **Not implemented in this pass.**

---

## 6. All-Party Consent Gate — the exact rule and transaction needed

**Rule**: the case may only transition to `FEE_PENDING` once `ALL_REQUIRED_PARTIES_CONSENTED` (§5) is true for every active opposite party **and** (per §4's unresolved gap) whatever applicant-consent representation 5K's implementation settles on.

**What the transaction needs to check, in order**:
1. Lock the case row (`FOR UPDATE`) — same precedent as 5I/5J.
2. Identify every required opposite party (`pim_case_parties` where `role='OPPOSITE_PARTY' AND active_to IS NULL`) for this case.
3. Record (or re-read) the party's own latest response/consent.
4. If this response makes every required party's latest status `consent=1`: transition to `FEE_PENDING`.
5. If this response makes any required party's latest status a refusal: that party's own refusal is independently non-starter-eligible (§7) — but whether **one** refusal should also foreclose the **whole case** (since mediation is presumably joint) or only remove that party from a still-possible partial referral is a genuine SOP-reading question this document does not resolve from the supplied source text (the SOP speaks of "all parties" consenting but does not explicitly state what happens to the proceeding when some consent and others refuse) — flagged as an open question for the implementation/business-rule decision, not guessed at here.
6. If neither (some parties still unresponded, none refused): record the fact, advance no case status, leave it exactly where it is (analogous to 5J's `DELIVERED` branch, which also records a fact with no case-status change).

**Not implemented in this pass**, per instruction.

---

## 7. Unwillingness / Refusal — reaching T7

**Both refusal paths reach `createNonStarterHandoff` immediately and directly** — `REFUSED` (direct) and `APPEARED`+`consent=0` (appeared-then-refused via either the fast-path in `response/[id]/route.js` or the deferred path in `consent/[id]/route.js`) all call it in the same transaction as the status transition to `OP_REFUSED`. **No further notice or follow-up is required** by the current implementation once a refusal is recorded — this matches `inferNonStarterContext`'s tier-1 check (a `REFUSED` row, or `APPEARED`+`consent=0`, found via `ORDER BY id DESC LIMIT 1`) immediately producing `OP_REFUSED_MEDIATION` as T7's reason. The code's behavior is: **OP expressly unwilling/refuses → immediately eligible for non-starter**, consistent across both the response module and T7's own inference. This is read from the code, not assumed from the SOP — nothing in the supplied SOP text requires an additional notice after an express refusal, and the implementation does not add one.

**Preserved distinctions, confirmed**: no response (§8) / absence (`DID_NOT_APPEAR`, routed through the Initial-vs-Final-vs-alternate-date branching, §8) / service failure (5J's postal facts, never touching `pim_responses`) / express unwillingness (`REFUSED`/`APPEARED`+`consent=0`) are four genuinely distinct code paths, never conflated.

---

## 8. No Response — the 5J/5K boundary for this branch

**Confirmed: absence is never recorded as an express unwilling response.** `DID_NOT_APPEAR` is its own `response_type`, entirely distinct from `REFUSED`. The three-way branch (`response/[id]/route.js`'s `DID_NOT_APPEAR` handler):

1. **Initial notice, original appearance date, no response** → `FINAL_NOTICE_PENDING` + a `FINAL_NOTICE_FOLLOWUP` task (re-enters 5I's own Prepare/Generate/Issue for the Final Notice — never touches non-starter at this stage).
2. **Final notice absence, or alternate-date absence (either notice type)** → non-starter handoff directly (no further notice contemplated).

**Where 5J ends and 5K begins for this branch, exactly**: 5J's `recordServiceResultTx` only ever records a **postal** fact (delivered/returned) about a **notice** — it has no concept of "the OP didn't show up to respond." The moment a `SERVED` notice's appearance date passes with silence, that is **entirely a 5K-owned fact** (`DID_NOT_APPEAR`), recorded by staff through the response route, not inferred automatically by any 5J code or any scheduled job. There is no overlap and no shared state to reconcile — confirmed, not assumed, by the fact that `response/[id]/route.js` never reads `pim_service_attempts` at all (it reads `pim_notices.status`, which is 5J's own output, but never the service-attempt row itself).

---

## 9. Response History

**Current model, confirmed**:
- `insertResponse` always **inserts** a new row — `pim_responses` rows are, in that sense, append-only/immutable events, matching the task's "prefer preserving historical evidence."
- **One mutation exception exists**: `consent/[id]/route.js`'s deferred-consent path **updates** the original `APPEARED` row's `consent` column in place (`UPDATE pim_responses SET consent = ? WHERE id = ?`), rather than inserting a new row — justified in the code's own comment ("so response history stays accurate rather than leaving consent permanently null"). This is a genuine, deliberate mutation of an existing row, not a bug — but it does mean "the appearance happened" and "the consent decision" are represented as one evolving row in this one specific path, while every other response type is a pure insert.
- **A later change of willingness** (e.g., recorded `consent=0`, later wants to say `consent=1`) has **no code path at all** — the consent route explicitly rejects recording a decision if one already exists (`latestResponse.consent !== null` → throw). There is no "correction" or "supersede" mechanism anywhere in this module.
- **Response after Final Notice**: fully supported — the `DID_NOT_APPEAR` branch explicitly checks `notice.notice_type === 'FORM_2_FINAL'` via the `isFinal` flag and branches accordingly; `APPEARED`/`REFUSED` responses carry no notice-type restriction at all in the entry-status guard beyond the general `RESPONSE_ENTRY_STATUSES` check.
- **Responses from multiple opposite parties**: structurally supported (§5), but the *consequences* are not multi-party-aware (§5's central finding).

**Recommendation for 5K**: keep `pim_responses` rows immutable events for every response type except where the existing deferred-consent update pattern already exists (do not redesign that one working path merely for theoretical purity) — this is a "do not redesign unless required" situation, and nothing in this audit found a requirement to change it.

---

## 10. Consent Evidence

**Currently stored** (confirmed from the schema + `insertResponse`'s parameter list): `response_date`, `appearance_mode` (free text — "IN_PERSON"/"WRITTEN" etc., not enum-constrained), `response_type`, `time_requested_until` (SOUGHT_TIME only), `consent` (0/1/null), `mediation_fee_requested` (0/1/null), `remarks`, `entered_by` (the attribution FK), `party_id`, `notice_id`.

**Minimum missing evidence**: none identified as *structurally* missing for what the current workflow actually does — every field the existing branches read or write already has a column. The one evidentiary gap is **applicant consent** (§4), which is a missing *fact*, not a missing *column* on an existing table (whatever representation is chosen would need its own place, not an addition to `pim_responses`, since that table is opposite-party-scoped by every current usage).

**No document storage recommended for consent**, consistent with the task's instruction — nothing in the current implementation stores a document reference for a response, and nothing in the SOP text (per the earlier audit) requires one.

---

## 11. Response Channels

**Currently supported**: `appearance_mode` is free text, unconstrained by any `CHECK` (confirmed: no constraint found on this column in schema.sql or the live migrations). The actual UI likely offers a fixed set of values (not independently verified in this pass — a UI read was out of scope for this planning document's time budget), but the **data model** places no restriction on in-person, written/post, or email appearance modes — all representable today without a schema change, same conclusion as 5J's planning document reached for `dispatch_mode`.

**Advocate/authorized representation**: `pim_case_advocates` already exists and is populated at intake (Batch 5C) — an opposite party's advocate is already a modeled relationship. Nothing in the response module currently *reads* `pim_case_advocates` to validate that a response recorded "through counsel" corresponds to a real advocate-of-record, but the underlying data to do so already exists.

**Nodal Officer dependency, flagged not built**: the SOP audit's clause-11(b) "consideration of legal representations by the Nodal Officer" is a different concept from "which channel did the response arrive through" — it is a decision a responsible officer makes, not a response-recording detail. This document does not build the Nodal Officer module (per instruction); it notes that if 5K's implementation wants to record "a legal representation was considered," that decision-record shape should follow whatever the Nodal Officer design (frozen rule 8, not yet built) establishes — the same dependency relationship 5J's planning document already identified for private notice.

---

## 12. Mediation-Fee Handoff

**Traced exactly, from the current code**:

- **Target status**: `FEE_PENDING` (reached either via `response/[id]/route.js`'s fast path or `consent/[id]/route.js`'s deferred path — both call the same `ensureMediationFee`).
- **Fee task**: none is created by the response/consent module itself — no `pim_tasks` row is inserted for the fee stage by this code. (The `OP_CONSENT_FEE` task type exists in `task_types` and `lib/pim-action-link.js` already maps it to `/pim/response/[id]`, but nothing in the audited code ever creates a task with that code — same vestigial-code-path pattern as `OP_CONSENT_PENDING`/`OP_CONSENTED` statuses, §2.)
- **Fee calculation trigger**: `ensureMediationFee` calls `calculateMediationFee(claimAmount)` (Schedule-II slabs, already confirmed correct in the earlier SOP audit) the moment the first OP consents — **before** the case even reaches `MEDIATOR_ASSIGNMENT_PENDING`, so the fee amount is known immediately at consent time, not deferred to the fee-payment route.
- **Applicant/OP shares**: not computed anywhere in this module — `pim_fees.amount_due` is the full statutory amount; the 50/50 split (confirmed correct in the SOP audit) is handled entirely by `app/api/pim/fee/[id]/route.js` at payment-recording time, a different, unmigrated route this batch does not touch.
- **Multiple-OP handling**: `ensureMediationFee` is deliberately **case-level deduped** (by `case_id` alone, not `case_id`+`party_id`) — confirmed by its own code comment ("Rule 11's mediation fee is ONE statutory, case-level fee... never multiplied"). This is already correct and requires no change.
- **Can mediator assignment occur too early (on the fee side)?** See §13 — re-audited in full depth as part of this revision, not the shallow read the original draft of this section flagged.

**§0's redefinition applies here directly**: `FEE_PENDING` is where 5K's own scope ends. Everything from fee-obligation tracking onward (§13, §17's revision) belongs to a **separate, later, not-yet-scoped batch** — referred to throughout this document as "the future fee batch." 5K itself creates no per-side fee-obligation state of any kind; it only ever calls the existing `ensureMediationFee` (case-level, full-amount, already correct as described above) to ensure the one `pim_fees` row exists once consent is reached.

**5K's clean stop point, confirmed technically coherent**: the handoff to `FEE_PENDING` (once properly gated on all-party consent, §6) is the natural boundary — `ensureMediationFee`/the fee route/the mediator route are a separate, already-identifiable unit of work with its own status gates (`FEE_PENDING` and `MEDIATOR_ASSIGNMENT_PENDING` respectively), confirmed **not** atomically bound to the response/consent transaction (the fee row is created once by `ensureMediationFee` but actual payment recording happens later, in a wholly separate route/request). **No atomic dependency was found that would force 5K to also migrate the fee module** — recommend stopping at the `FEE_PENDING` handoff, per the task's stated preference.

---

## 13. Mediator Assignment Safety (re-audited in full depth for this revision)

**Checked directly against the live route code — the entire `fee/[id]/route.js` POST handler was read line-by-line for this revision, correcting the original draft's shallower pass:**

**Good news, confirmed by deep re-read**: the existing SQLite fee route **already correctly implements cumulative, not-fully-paid-blocks-advancement accounting** — it does **not** have the naive "OP paid → treat whole fee as paid" bug the real-world case warned against:

- `pim_fees` is a single case-level row (one row per case, `fee_type='MEDIATION_FEE'`, confirmed in §12) with one `amount_received` column.
- Each POST submission accepts `applicantAmountReceived`/`oppositePartyAmountReceived` independently (either, both, or — across separate calls — one now and the other later: "partial payments can be recorded in separate calls," the code's own comment).
- The submitted amount(s) are **added** to whatever `amount_received` already held (`newAmountReceived = Number(feeRow.amount_received || 0) + increment`) — **never replaced**, so an earlier payment can never be lost or shrunk by a later, smaller submission.
- `fullyPaid = newAmountReceived >= totalFee` (the full statutory amount, not half) — **only when the cumulative total meets or exceeds the full fee** does the transaction transition the case to `MEDIATOR_ASSIGNMENT_PENDING` and create the `MEDIATOR_ASSIGNMENT` task. If only one side has paid (`newAmountReceived` = half of `totalFee`), `fullyPaid` is `false`, the function returns early with `statusCode: "FEE_PENDING"` unchanged, and **no status transition, no task, no mediator-assignment path of any kind fires.**

**So, for the exact real-world scenario raised (OP pays their half, applicant does not): the existing code already keeps the case at `FEE_PENDING` and does not advance it to `MEDIATOR_ASSIGNMENT_PENDING`.** This is good news the original draft of this document did not establish with enough depth — corrected here.

**A real, separate gap does exist, found only by this deeper re-read**: `pim_fees` has exactly **one** `dd_number`/`dd_date`/`bank_name`/`payee` set of columns, not one per side. When a second side's payment is recorded in a later call, the `UPDATE ... SET dd_number = COALESCE(?, dd_number), ...` **overwrites** the first side's structured DD/bank details with the second side's — the first side's DD number/date/bank are no longer independently queryable from the structured columns once a second payment is recorded. **Partial textual preservation exists**: each payment appends a human-readable line to `pim_fees.remarks` (`"${label} paid ₹... via DD ${ddNumber} dated ${ddDate} (${bankName})."`, accumulated with `TRIM(COALESCE(remarks || char(10), '') || ?)`), so the fact and detail of both payments is **not lost**, but it is only recoverable as free text, not as structured, independently queryable per-side data. **This is exactly the gap the task's "future fee batch" requirement (§0, §17) describes** — confirmed now by code-level evidence, not assumed from the task's own framing alone.

**Mediator-assignment gate itself**: `app/api/pim/mediator/[id]/route.js` gates assignment on `status_code !== 'MEDIATOR_ASSIGNMENT_PENDING'` → reject (confirmed at line ~354) — and, per the above, a case cannot reach that status without the cumulative fee check passing. **So the fee-side ordering is sound, corrected from this document's original (shallower) finding.**

**The upstream violation (§5's finding) remains the real, confirmed one**: because `FEE_PENDING` can currently be reached after only **one** opposite party has consented (no all-party gate exists at all, §5), a case can reach `FEE_PENDING` — and therefore become eligible to start collecting a fee that will eventually unlock `MEDIATOR_ASSIGNMENT_PENDING` — before every required party has actually consented. The fee-tracking code itself is sound; the **consent** gate upstream of it is the actual, confirmed gap. This remains the single most important finding of this planning document and the primary reason §6's all-party consent gate is necessary before (or as part of) 5K.

**Not migrated, per instruction** — both findings (the consent gate gap, and the per-side fee-evidence gap) are reported, not fixed.

---

## 14. T7 Interaction Matrix

| Service/Response fact | Consent state | Non-starter eligible? | Next action/status |
|---|---|---|---|
| Notice `SERVED`, no response yet | n/a | No | Stays `SERVICE_PENDING`; staff records a response |
| `APPEARED`, `consent=1`, `feeRequested=1` | Willing | No | `FEE_PENDING` (today: **immediately**, regardless of other OPs — §5/§13's finding) |
| `APPEARED`, `consent=1`, `feeRequested` null/0 | Willing, fee decision deferred | No | Stays at whatever status it was (no transition fires unless both `consent=1` AND `feeRequested=1`) — a sub-case not independently traced further in this pass |
| `APPEARED`, consent undecided | Pending | No | `OP_APPEARED` (awaiting the deferred consent route) |
| `APPEARED`, `consent=0` (consent route `REFUSED`, or fast-path) | Unwilling | **Yes — `OP_REFUSED_MEDIATION`** | `OP_REFUSED` + `NONSTARTER_FORM3` handoff, immediately |
| `REFUSED` (direct) | Unwilling | **Yes — `OP_REFUSED_MEDIATION`** | `OP_REFUSED` + `NONSTARTER_FORM3` handoff, immediately |
| `SOUGHT_TIME` | Pending | No | `OP_APPEARANCE_PENDING` + `OP_APPEARANCE_FOLLOWUP` task, alternate date |
| `DID_NOT_APPEAR`, Initial notice, original date | n/a (no response) | No | `FINAL_NOTICE_PENDING` + `FINAL_NOTICE_FOLLOWUP` task — re-enters 5I |
| `DID_NOT_APPEAR`, Final notice OR alternate date | n/a (no response) | **Yes — `FINAL_NOTICE_UNACKNOWLEDGED` or `OP_FAILED_TO_APPEAR_AFTER_TIME`** (the latter only if a prior `SOUGHT_TIME` row for the same party exists and is older than this absence row, per `inferNonStarterContext`'s own tie-break logic) | Non-starter handoff, case status left unchanged |
| Postal `RETURNED` (5J, Final notice) | n/a — no response ever possible | **Yes — `FINAL_NOTICE_UNACKNOWLEDGED`** (5J's own direct handoff) | `NOTICE_RETURNED` (5J's corrected resting state) |

All reason codes used above (`OP_REFUSED_MEDIATION`, `FINAL_NOTICE_UNACKNOWLEDGED`, `OP_FAILED_TO_APPEAR_AFTER_TIME`) are the actual live `nonstarter_reasons` rows, re-confirmed against `inferNonStarterContext`'s own three-tier priority order (refusal → absence → returned-Final) in this session's earlier reading of `lib/pim-nonstarter.js`. T7 is not modified by this document, per instruction.

---

## 15. Transaction Inventory (re-audited from scratch, post-5J)

### `response/[id]/route.js` POST

Pre-transaction: body parsing + shape validation only (no DB read) — consistent with the pattern every other migrated route already uses.

Inside `db.transaction(() => {...})()`:

| # | Statement | Branch | Notes |
|---|---|---|---|
| 1 | `getCase(caseId)` (SELECT) | all | |
| 2 | `getActiveOppositeParty(caseId, partyId)` (SELECT) | all | |
| 3 | `requireIssuedNoticeForParty` → `loadNotice` (SELECT) + `pim_service_attempts` latest-row SELECT | all | two reads |
| 4 | (JS) `isAdditionalConsentAfterFeePending` computation, entry-status guard | all | no DB access |
| 5 | `insertResponse` (INSERT, `lastInsertRowid`) | all four response types | the only generated id in this transaction |
| 6+ | `transitionStatus` (SELECT `status_master` ×2 inside `getStatusId` calls, INSERT `pim_status_history`, UPDATE `pim_cases`) | APPEARED+consent decided, REFUSED, DID_NOT_APPEAR (Initial-notice branch only skips `isAdditionalConsentAfterFeePending`) | |
| | `ensureMediationFee` (SELECT `pim_fees`, SELECT `pim_cases.claim_amount`, INSERT or UPDATE `pim_fees`) | APPEARED+consent=1+fee=1 only | |
| | `completeTaskIfPending` → `getPendingTask` (SELECT) + conditional `completeTask` (UPDATE `pim_tasks`, INSERT `pim_task_history`) | most branches | |
| | `createPendingTaskIfNotExists` (SELECT + conditional INSERT `pim_tasks`) | SOUGHT_TIME, DID_NOT_APPEAR (Initial branch) | |
| | `createNonStarterHandoff` → `createPendingTaskIfNotExists` (same as above, targeting `NONSTARTER_FORM3`) | REFUSED, APPEARED+consent=0, DID_NOT_APPEAR (Final/alternate branch) | |
| | `addDocket` (SELECT `event_types`, INSERT `pim_docket`) | every branch, exactly once | |

**`lastInsertRowid` usage**: exactly one per call — `insertResponse`'s own INSERT. No insert-to-insert chain within this transaction (the response id is never consumed by a later statement in the same call).

**Pre-transaction reads**: none beyond body validation (JS-only). Matches every other migrated route's pattern.

**Read-then-write races**: the entry-status guard (`caseData.status_code` read at step 1, acted on with no re-read before the eventual `transitionStatus` call) is a genuine SQLite-serialization-dependent TOCTOU — under PostgreSQL's real concurrency this needs the case row locked (`FOR UPDATE`) before step 1's effective check, exactly as 5I/5J already established. This module was flagged in the original Phase 6 readiness audit as "branch-heavy with potential TOCTOU risk" — re-confirmed here, now with the exact statement list to design locking around (§16).

**Global `db` helper usage**: `lib/pim-op-response.js`'s functions already take an optional trailing `dbClient = db` parameter (Batch 5B's preparatory work, confirmed unchanged) — the same preparation pattern every other now-migrated module had before its own Postgres port.

**SQLite-specific SQL/date/time**: `officeDate()`/`officeTime()` (Asia/Kolkata, not `CURRENT_DATE`) — consistent with every other module; no `julianday()`, no `datetime('now')` found in this module.

### `consent/[id]/route.js` POST

Pre-transaction: body validation **and** a case-status read (`getCase(caseId)`, checked for `status_code !== 'OP_APPEARED'` **before** the transaction opens) — a genuine, pre-existing TOCTOU window distinct from `response/[id]/route.js`'s pattern: the status is read once outside the transaction and never re-checked inside it.

Inside `db.transaction(() => {...})()`:

| # | Statement | Notes |
|---|---|---|
| 1 | `pim_responses` latest-`APPEARED`-for-this-party SELECT (inline, not via `getLatestResponse`) | scoped by `case_id`+`party_id`+`response_type='APPEARED'` |
| 2 | (JS) `latestResponse.consent !== null` guard | already-decided check |
| 3 | `UPDATE pim_responses SET consent = ? WHERE id = ?` | the one mutation-in-place pattern (§9) |
| 4+ | `transitionStatus`, `ensureMediationFee` (CONSENTED only), `completeTaskIfPending`, `createNonStarterHandoff` (REFUSED only), `addDocket` | same shapes as above |

**No `lastInsertRowid` chain** (the one INSERT, inside `createNonStarterHandoff`'s `createPendingTaskIfNotExists`, is return-value-only).

**The pre-transaction case-status read is this route's own, additional TOCTOU exposure** beyond what `response/[id]/route.js` has — a locking design for 5K must move this check inside the locked transaction, not leave it as a pre-check (§16).

---

## 16. Concurrency Analysis

| Race | Current (SQLite) protection | What a PostgreSQL port needs |
|---|---|---|
| Same party's response submitted twice | Whole-DB serialization only | Lock the **case** row first (`FOR UPDATE`), re-check `status_code` after acquiring it, before any `pim_responses` read — the loser's post-lock re-read fails the entry-status guard once the winner has already transitioned the case |
| Conflicting responses for the same party, concurrently | Same | Same case-row lock closes this — only one of the two can win the status-guard race |
| Two different OPs responding simultaneously | Same (but today each would just race to write its own response/transition independently) | **This is where the design differs from 5I/5J's simple case-lock**: once §6's all-party gate exists, two different OPs consenting concurrently must both be able to record their own fact without colliding, but the *aggregate* check (`ALL_REQUIRED_PARTIES_CONSENTED`) must be computed **after** each individual write, inside the same lock, so the second committer (not the first) is the one whose transaction correctly observes "now all required parties have consented" and fires the `FEE_PENDING` transition. A case-row lock still serializes this correctly — the second OP's transaction, once it acquires the case lock (after the first committed and released it), re-derives the aggregate from the now-current `pim_responses` state and sees the first OP's committed row. No response-row-level lock is needed in addition to the case lock, because the aggregate derivation itself is scoped to `case_id` and reads committed data |
| Final service result racing with response recording | Not currently possible to race in the literal sense — a response can only be recorded against a `SERVED` notice, and 5J's `recordServiceResultTx` already locks the case row before writing, so a concurrent response-recording transaction attempting to lock the same case row simply waits | Case-row lock, consistent ordering (case before notice, matching 5I/5J's established convention) |
| Response racing with non-starter recording (T7) | T7's `recordNonStarter` (unmigrated, SQLite) independently re-reads case status and checks for an existing pending `NONSTARTER_FORM3` task before proceeding — today's whole-DB serialization protects this; under Postgres, both T7's eventual port and 5K's response module would need to lock the same case row, in the same order, for this to remain safe. **Not resolved here** — T7 is out of scope for this batch, but the case-lock convention needs to be the same one T7 eventually adopts |
| Final consent racing with fee-stage transition | The consent route's pre-transaction status read (§15) is the live TOCTOU here even under current SQLite semantics in principle, though whole-DB serialization currently masks it | Move the status check inside the locked transaction (§15's finding) |

**Recommended lock order**: **case → party/relationship is not actually needed as a separate lock** — `pim_case_parties` rows are read-only in every response/consent code path (never written by this module; `active_to` is only ever set by case-level party-management code outside this module's scope), so locking them would add no safety and isn't warranted. **Case → relevant notice is also not needed as a separate lock for every operation** — unlike 5J's service-result/address-correction functions (which mutate `pim_notices.status`), nothing in the response/consent module writes to `pim_notices` at all; it only reads notice state via `requireIssuedNoticeForParty`. **The correct, simpler order for this module is: lock the case row only**, then perform every other read/write (responses, fee, tasks, docket, status history) inside that single lock — consistent with 5I's `prepareForm2NoticeTx` (which also locks only the case row, not a notice row, because its own guard is case-status-based). This was checked against the actual schema/access pattern, not guessed.

---

## 17. PostgreSQL Data Model

**Existing tables are sufficient for the response/consent facts themselves** — `pim_responses` already has every column every current code branch needs (§10), and `pim_case_parties.active_to` already supports the excluded/withdrawn-party concept §5's derivation needs. **No schema change is required** for the per-party response/consent recording itself.

**One genuinely open schema question, not resolved here**: if 5K's implementation decides applicant consent (§4) needs explicit representation, that is new — either a new nullable column set on an existing table (least invasive: on `pim_cases`, since there is exactly one applicant-consent fact per case, unlike opposite-party responses which are inherently multi-row) or a new row type reusing `pim_responses` with the primary applicant's `party_id` (the table's `party_id` FK already points at `pim_parties` generically, so an applicant row would not violate any constraint — but every current *reader* of this table implicitly assumes `role='OPPOSITE_PARTY'` via `getActiveOppositeParty`, so reusing the table would need every consuming function re-audited for that assumption). **This document does not recommend one over the other** — it is a genuine design decision for the implementation phase, flagged per the task's own instruction to report before implementing, not decided unilaterally.

**No new uniqueness constraint is identified as strictly necessary for correctness** — the case-row locking design (§16) fully serializes every write path this module needs, the same conclusion reached for 5I/5J's own concurrency analyses. This was checked against the live schema (§2's `pg_constraint` query), not assumed.

**No DDL applied in this pass.**

### 17a. Data model for the future fee batch (NOT 5K — recorded here per §0/§12's cross-reference, not to be built now)

Per §13's deep re-audit, the concrete gap is: `pim_fees` is a single case-level row with one `amount_received`/`dd_number`/`dd_date`/`bank_name`/`payee` set of columns, shared cumulatively across both sides, with only free-text `remarks` distinguishing who paid what. The task requires the future fee batch to model obligations **per required paying side** — at minimum:

```
Applicant:        PAID / UNPAID  (+ its own evidence: amount, DD/reference, date)
Opposite-party side: PAID / UNPAID  (+ its own evidence — collectively, per the SOP's
                      own "jointly pay... or share it equally" rule for multiple OPs,
                      clause 6(d), already correctly understood by the existing
                      ensureMediationFee design as ONE shared obligation, not one
                      per OP)
```

The minimal shape consistent with the rest of this schema's conventions would be **two rows** per case under `fee_type='MEDIATION_FEE'` instead of one — one `party_id`-scoped row per required side (applicant-side, opposite-party-side), each with its own `amount_due` (half the statutory total each, not the full amount duplicated), `amount_received`, and its own `dd_number`/`dd_date`/`bank_name`/`payee`/`received_date` — rather than widening `pim_fees` with new side-specific columns, which would not generalize if a future rule ever needs more than two sides. This is **not decided here** — it is the shape this audit's evidence points toward, offered for the future fee batch's own design pass, consistent with every other "report before implementing" instruction in this document.

**Only complete fee satisfaction (both sides' `PAID`) may permit `MEDIATOR_ASSIGNMENT_PENDING`** — restating the task's own requirement as a binding constraint on that future batch's design, not 5K's.

**Full obligation model, revised to separate the obligation from its payment transactions** (payment transactions are themselves events, not a single mutable balance — correcting the structural weakness §13 found in the current single-row design):

```
CASE
  → required total mediation fee (unchanged: calculateMediationFee(claimAmount))

PAYING SIDE / OBLIGATION (one row per required side, per §17a above)
  → applicant share: amount_due, cumulative amount_received, status
  → opposite-party-side share: amount_due, cumulative amount_received, status

PAYMENT TRANSACTIONS (one row per actual payment event, not merged into the
obligation row — so a second payment never overwrites a first payment's own
DD number/date/bank, the exact defect §13 found)
  → amount
  → date
  → payment mode (DD / online — already a free-text-safe distinction, no
    enum change needed, same conclusion as every other channel field in
    this project)
  → DD/reference number
  → bank
  → paying side (FK to the obligation row, or the party_id directly)
  → recorded_by (the existing attribution convention every table in this
    project already uses)
  → remarks/evidence as appropriate — kept as free text, no document-upload
    machinery invented, consistent with the contact-affidavit precedent (5J)
```

**Explicitly not `fee_paid = true/false`** — the task's own instruction, restated as a binding constraint: the future batch's model must support partial compliance by either side independently, at all times, not collapse to one boolean.

**Future fee-default reasons** (not implemented now; recorded for that batch's own master-data design): a single `MEDIATION_FEE_NOT_SUBMITTED` reason is inadequate once this ground is actually implemented, because — per §22's own judicial authority — **applicant default** and **opposite-party-side default** are legally and evidentially distinct facts (different consequences, different evidence, and the *Sidhi Vinayak Metcom* judgment itself draws this exact distinction). The future batch should plan **two** distinct reasons, provisionally named `APPLICANT_MEDIATION_FEE_NOT_PAID` and `OP_MEDIATION_FEE_NOT_PAID` (subject to final naming consistency with the existing `nonstarter_reasons` convention — the existing five reasons use `OP_`-prefixed and unprefixed names inconsistently, so the future batch should reconcile the naming convention itself, not something decided here). **Neither reason may be mapped to Rule 3(4) or Rule 3(6)** — both must cite Rule 11 + the judicial authority, per §22's resolved position, never an invented or borrowed express-ground citation.

**Payment-opportunity / default evidence** (not implemented now): per the task's explicit instruction, a fee-default closure must not depend merely on "fee balance > 0." The future model must be capable of proving, not merely asserting:
- the required fee/share amount;
- the amount actually paid (from the Payment Transactions above, summed per side);
- which side remains outstanding;
- that payment was formally requested/directed (a documented event, not informal follow-up);
- the opportunity/final-opportunity date given;
- any applicable due date;
- the expiry/default itself (the date the opportunity lapsed without compliance);
- the closure reason ultimately recorded.

**Informal telephone follow-up must never be the authoritative workflow evidence** — the system must ultimately support a **documented** final-payment opportunity (a docket entry, a generated notice, or an equivalent recorded artifact), exactly as PIM/109/2026's own operational handling already describes ("a final written opportunity will be given"). This is a requirement on the future batch's design, not implemented here.

**Non-refund, preserved explicitly**: per clause 22 of the SOP (already confirmed in the earlier reconciliation audit and restated here for this specific scenario) — mediation fee once paid is non-refundable. The future fee batch must **never**, as a consequence of a fee-default Non-Starter closure: delete a payment transaction, mark a paid side as unpaid, automatically refund, or otherwise rewrite the financial history. A payment transaction, once recorded, is an **immutable financial fact** — exactly the PIM/109/2026 scenario's own requirement that the respondents' ₹15,000 "must remain permanently recorded."

---

## 18. Clean 5K Batch Boundary

**Recommended boundary, using actual live status/task names (not `OP_RESPONSE_PENDING`, which does not exist):**

```
SERVICE_PENDING (SERVED notice, no response yet)
   → record per-party response (APPEARED / SOUGHT_TIME / REFUSED / DID_NOT_APPEAR)
   → derive all-party consent (§5/§6, new logic — not a persisted boolean)
   → either:
       A. OP_REFUSED (+ NONSTARTER_FORM3 handoff) — any required party's express refusal
       B. FINAL_NOTICE_PENDING (+ FINAL_NOTICE_FOLLOWUP) — Initial-notice absence
       C. non-starter handoff, case status unchanged — Final-notice/alternate-date absence
       D. OP_APPEARANCE_PENDING (+ OP_APPEARANCE_FOLLOWUP) — time sought
       E. FEE_PENDING (+ mediation-fee row via ensureMediationFee) — ONLY once
          ALL_REQUIRED_PARTIES_CONSENTED is genuinely true, correcting §5/§13's
          finding — this is the one behavioral change 5K's implementation would
          need to make versus directly porting the existing SQLite logic verbatim
```

**Per §0's redefinition**: reaching `FEE_PENDING` means *consent is satisfied, fee is not* — it is 5K's own terminal state, not a claim that mediation is ready to proceed. **5K's consent aggregate (§5/§6) must never include fee-payment facts of any kind** — `ALL_REQUIRED_PARTIES_CONSENTED` is derived purely from `pim_responses.consent`/`response_type` (§5's query), and nothing in 5K's own transaction reads or writes `pim_fees.amount_received`. The one existing call 5K's transition makes into the fee module (`ensureMediationFee`) only *creates the row if absent* — it does not, and must not, be extended in 5K to check or imply payment completion.

**Stop at `FEE_PENDING`** — the fee-payment route (`app/api/pim/fee/[id]/route.js`) and mediator assignment (`app/api/pim/mediator/[id]/route.js`) are confirmed separable (§12), not atomically dependent on the response/consent transaction. 5K should not migrate them.

**The one place this boundary requires a genuine behavior change, not just a straight port**: the all-party consent gate (§6) does not exist in the current code at all. Porting the existing logic verbatim would faithfully reproduce the SOP violation identified in §13. **Decision (b) is confirmed**: the gate is implemented as part of 5K itself, the same way 5J's NOTICE_RETURNED fix was folded into that batch rather than deferred.

**Full conceptual pipeline, frozen as of this revision** (spanning 5K and the future fee batch — not all of it is 5K's own scope, stated explicitly at each stage):

```
SERVICE COMPLETED (5J's own output — a SERVED notice)
   → RESPONSE / PARTICIPATION                         [5K]
   → REQUIRED CONSENT SATISFIED (opposite parties only,
     per §24 — applicant consent is not a separate fact)  [5K]
   → FEE_PENDING  (§0: consent satisfied, fee is not)     [5K's terminal state]
   → PER-SIDE FEE OBLIGATIONS / PAYMENTS                  [future fee batch, NOT 5K]
   →
   BRANCH A: all required fee satisfied
      → MEDIATOR_ASSIGNMENT_PENDING                       [future fee batch]
   BRANCH B: required fee remains unpaid after a documented
             opportunity (§17a's payment-opportunity model)
      → FEE DEFAULT
      → appropriate Non-Starter action (§22's resolved ground,
        Rule 11 + judicial authority, never Rule 3(4)/(6))
      → T7 / future fee-default closure integration          [future fee batch]
```

**Never allow partial fee payment → `MEDIATOR_ASSIGNMENT_PENDING`** — already true today per §13's re-audit of the existing cumulative `fullyPaid` check, and restated here as a binding constraint the future fee batch must preserve, not merely inherit by accident.

---

## 19. Dedicated Test Matrix (design only)

Modeled on 5J's own letter/number scheme:

**Single-OP baseline** (1 OP case, establishing the ported-behavior floor): one OP willing (→ FEE_PENDING); one OP unwilling (→ OP_REFUSED + non-starter handoff); no-response distinction (DID_NOT_APPEAR on Initial → FINAL_NOTICE_PENDING, never treated as REFUSED); response after Initial Notice; response after Final Notice (absence → non-starter; refusal → non-starter, same as Initial).

**Duplicate/concurrency**: duplicate same-party response rejected; concurrent identical response (exactly one commits); concurrent conflicting response (APPEARED+consent=1 vs. REFUSED for the same party) — exactly one commits, state consistent.

**Multi-OP** (the batch's core new coverage, 2+ OP fixtures): two OPs responding concurrently (both commit, no corruption); one of multiple OPs willing while another remains unresolved (no premature FEE_PENDING transition — the central regression test for §13's finding); all multiple OPs consent (FEE_PENDING fires only on the **last** one, not the first); one of multiple OPs refuses (that party's own non-starter eligibility, §6's open question about whole-case effect resolved by whatever the implementation decides — the test matrix itself should assert whichever rule is actually chosen, not guess); `ALL_REQUIRED_PARTIES_CONSENTED` derivation (direct query-level test, independent of any specific route call); no premature fee-stage transition under every multi-OP combination above.

**Non-starter/task/docket/history**: non-starter handoff for every eligible branch (§14's matrix, each row as its own test); exact docket entry per call; exact status-history hop count; task completion/creation correctness (`OP_APPEARANCE_FOLLOWUP`, `NONSTARTER_FORM3`); no duplicate follow-up task across repeated/concurrent calls.

**Rollback**: a forced failure after every write rolls back the complete transaction (response row, fee row, task, docket, history, case status) — same pattern as every prior batch's test J/V/10.

**Permission**: no identity → 401; non-staff role → 403; nothing written on denial, for both the response and consent routes.

**PostgreSQL-authoritative**: a SQLite-only case/response is never visible through the real Postgres-backed route.

**Residue**: exact-id fixture cleanup; production 2026 sequence and `PIM/119/2026` independently re-verified untouched at the end; five-mediator panel intact (same doctrine as every prior suite in this project).

### 19a. Required regression fixtures for the future fee batch (NOT 5K's own suite — recorded here per the task's exact instruction)

The task specifies an exact real-world fixture that must be asserted once the future fee batch exists. Recorded here verbatim against this document's own evidence (§13), for that batch's test design to pick up directly:

**Primary fixture — "OP paid, applicant unpaid":**
- Setup: applicant consent = YES, OP consent = YES (case at `FEE_PENDING`, reached correctly via 5K's own gate); OP fee share recorded as PAID; applicant fee share remains UNPAID.
- Assert: the case does **not** reach `MEDIATOR_ASSIGNMENT_PENDING` (already true today per §13's re-audit of the cumulative `fullyPaid` check — this fixture, run against the *current* SQLite code, should already pass; the future batch's job is to make the OP's payment and the applicant's non-payment independently queryable, not to fix a premature-advance bug that doesn't exist at the fee-cumulative level).
- Assert: no mediator can be assigned (the downstream gate, §13, already correctly blocks this).
- Assert: the OP's payment remains recorded and queryable **per side** (the actual new capability this fixture exists to prove, closing the structured-evidence gap §13 found).
- Assert: the applicant's obligation remains outstanding, independently visible (not merely inferable from `amount_received < amount_due`).
- Assert: the correct closure/non-starter action becomes available **only according to whatever classification §22 below (or its eventual follow-up) establishes** — this fixture must not assert a specific reason code until that classification is actually confirmed; asserting one now would be exactly the kind of guess the task instructed against.

**Inverse fixture — "applicant paid, OP unpaid":** same assertions, roles reversed. Confirms the per-side model isn't accidentally asymmetric (e.g. hard-coded to only track the opposite-party side, since historically the opposite party has been the module's primary focus).

**Both-paid fixture — control case:** applicant PAID, OP PAID → case reaches `MEDIATOR_ASSIGNMENT_PENDING`, exactly as today's cumulative check already allows. This is the regression-safety control proving the future batch's per-side model doesn't accidentally make the ordinary, fully-paid path stricter or looser than it is today.

These three fixtures are **not part of 5K's own dedicated test suite** (§19's main list above) — 5K writes no fee-payment data at all. They are recorded here so the future fee batch's planning inherits them verbatim rather than re-deriving them.

---

## 20. Completed-Batch Safety

| Batch | Impact |
|---|---|
| 5J (service) | None expected — 5K reads `pim_notices.status`/`pim_service_attempts` existence only (via `requireIssuedNoticeForParty`), never writes either table. The `SERVICE_PENDING`→response handoff (§1) is a pure read dependency, already proven stable by 5J's own test suite. |
| 5I (Form II) | None expected — 5K's `DID_NOT_APPEAR`-on-Initial branch re-enters 5I's `prepareForm2NoticeTx` for the Final Notice exactly the way 5J's address-correction already does (reusing, not duplicating); no change to 5I's own code anticipated. |
| 5H-b (numbering) | None — this batch has no PIM-number involvement of any kind (confirmed: no code path in `lib/pim-op-response.js` or either route references `pim_number_sequences` or any numbering function). |
| 5H-a (mediator registry) | None — mediator *assignment* (§13) is explicitly out of scope; the mediator *roster* is untouched by anything in this module. |
| T7 (non-starter) | No code change, per instruction. **Behavioral dependency only**: once 5K is implemented, T7 operating against a PostgreSQL-only case will correctly see the `pim_responses` rows 5K writes, closing the gap the 5J planning document (§18) flagged — T7's tier-1/tier-2 inference (refusal, absence) becomes usable against Postgres-resident cases for the first time. This is a capability T7 gains, not a regression risk to it. |

---

## 21. Explicit Things Not to Change

- **The four-way response-type separation** (APPEARED / SOUGHT_TIME / REFUSED / DID_NOT_APPEAR) and the strict non-conflation of postal refusal vs. OP refusal vs. absence vs. service failure (§3) — already correct, already SOP-compatible per the earlier audit.
- **`ensureMediationFee`'s case-level (not per-party) dedup** — already correct per Rule 11/clause 8.
- **The Initial-notice-absence → Final-Notice routing** (never straight to non-starter) — already correct, matches the four-way Final Notice distinction 5J preserved.
- **T7 and its reason codes** — not modified, per instruction; no contradiction was discovered between T7's current reason set and the SOP in this pass (§14's matrix uses the existing codes without needing new ones).
- **`pim_case_parties.active_to`** as the exclusion/withdrawal mechanism — already sufficient for §5's derivation; no new "excluded" flag needed.
- **The fee/mediator routes themselves** — not migrated, not redesigned; only their *status-gate entry points* were read to confirm §12/§13's findings.
- **Lint baseline (160/107/53), 2026 sequence (`last_number=118`), `PIM/119/2026`, the five-mediator panel** — all reaffirmed unchanged at the top of this document and untouched by this read-only pass.

---

## 22. Legal Classification Finding — "consented but required fee share unpaid" (RESOLVED — externally verified and recorded here)

**Original question**: is a required party's failure to remit their mediation-fee share, after having already consented, formally (A) a Form-3 non-starter ground, (B) another named closure/disposal category, or (C) a scenario requiring a specific procedural step before closure.

**Revised position, externally verified against the Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018, Form 3, and judicial authority (none of which were available to this audit at the time §22 was first written — this is new source material, not a reversal based on guesswork):**

1. **Rule 3 / Form 3 does not expressly enumerate "failure to pay mediation fee" as a standalone textual Non-Starter ground**, in the way the Rule 3 non-participation/non-appearance grounds are expressly enumerated. This confirms, rather than contradicts, the original finding that no *express* Rule 3(4)/(6)-style ground exists in the Rules' own text for fee non-payment.

2. **However, Rule 11 requires the prescribed mediation fee to be paid before commencement of mediation.** This is a real, textual requirement — mediation cannot lawfully commence while a required fee share remains unpaid.

3. **Judicial authority directly on point**: *Union of India v. M/s Sidhi Vinayak Metcom Limited*, Jharkhand High Court, decided 26.09.2025. The judgment considered a PIMS proceeding in which a Non-Starter Report was issued because mediation fees were not deposited, and supports the proposition that required fee payment is part of compliance with the Section 12A PIMS procedure. The judgment also distinguishes **the applicant failing to deposit its required share** from **the applicant complying but the respondent failing to deposit its required share** — i.e., the judicial treatment itself does not collapse these into one undifferentiated fact, consistent with §17a's "future fee-default reasons" subsection below.

**Resolved position, to be recorded as the authoritative statement going forward**:

> Fee non-payment is not an express standalone Rule 3(4)/(6) ground in the text of the 2018 Rules/Form 3. However, judicial authority supports a Non-Starter Report where mediation cannot commence because the required mediation-fee share has not been deposited. The software may therefore support fee-default Non-Starter as a separately identified operational/judicially-supported ground, without falsely describing it as an express Rule 3(4) or Rule 3(6) ground.

**What this changes, and what it does not**:

- **It does not change 5K's own scope.** 5K still stops at the `FEE_PENDING` handoff (§18) and writes no fee-default closure logic of any kind — that remains the future fee batch's job, same as before this revision.
- **It does change the future fee batch's design freedom.** That batch may now implement a fee-default Non-Starter path with a documented, defensible basis — but it must **never cite Rule 3(4) or Rule 3(6)** for that ground (those sub-rules govern the express non-participation/non-appearance grounds only), and must instead cite **Rule 11** (the fee-before-commencement requirement) together with the *Sidhi Vinayak Metcom* authority, exactly as stated above. **No rule citation is invented beyond what was actually verified** — Rule 11's substance (fee-before-commencement) is what licenses this ground, not a textual non-starter enumeration that does not exist.
- **The existing `MEDIATION_FEE_NOT_SUBMITTED` reason's `rule_reference`** ("Operational ground; verify against applicable current DLSA/TNSLSA practice") should, in the future fee batch, be updated to cite Rule 11 + the judicial authority above — **this update is not made now**, since it is schema/master-data work belonging to that batch, not 5K. Recorded here so that batch does not have to re-research it.
- **§17a's "future fee-default reasons" subsection** (added per this revision) records why a single `MEDIATION_FEE_NOT_SUBMITTED` reason is no longer adequate once this ground is actually implemented, given the judgment's own applicant-vs-respondent distinction.

---

## 23. PIM 109/2026 — Real-World Business Regression Scenario (preserve, do not manipulate)

**This is a live production case, not a test fixture.** No part of this batch's implementation or testing may read, write, or otherwise touch PIM/109/2026 in the production database. It is recorded here purely as the authoritative shape for a future regression test (the future fee batch's own test suite, once per-side fee tracking exists — §17a/§19a) and as a concrete illustration of §22's resolved ground.

**Chronology, as reported**:

| Date | Event |
|---|---|
| 19.08.2026 | PIM No. 109/2026 filed |
| 09.09.2026 | Respondents 4 and 5 appeared, representing the other respondents; respondent side consented to mediation; sought time to pay the mediation fee |
| 16.09.2026 | Respondent side paid ₹15,000 as their mediation-fee share |
| Thereafter | Applicant (Canara Bank, Thummanatty Branch) has not paid its corresponding share; more than 20 days have elapsed since the respondent's payment; the Bank/counsel has not meaningfully responded to follow-up; mediation has not commenced |

**Operational decision (recorded, not automated by this batch)**: a final written opportunity will be given to the applicant Bank to pay its required mediation-fee share. If the applicant still defaults after that documented opportunity, the case must be capable of **fee-default Non-Starter closure** (per §22's resolved ground) **without falsely recording that the respondents refused mediation** — the respondents did not refuse; they consented and paid. The respondent's ₹15,000 payment must remain permanently recorded regardless of how the case is eventually closed.

**Why this scenario matters to 5K specifically, even though 5K does not implement fee tracking**: it is the real-world proof of §5/§6's central finding — a multi-party case where one required side (the respondents, collectively) has fully satisfied its obligations (consent *and*, eventually, fee) while another required side (the applicant) has not, and the case must not advance, and must not be mischaracterized as if the satisfied side were the defaulting one. 5K's own consent gate (§5/§6, corrected per §J below) is the first of two gates this scenario needs — the respondents' *consent* was never in question here; what blocks the case is *fee*, a different gate 5K does not implement but whose correct eventual behavior this scenario defines.

**This scenario must not be used to seed, modify, or clean up any test fixture.** 5K's own test suite (§19, revised) uses only disposable `TEST-B5K-`-prefixed fixtures, exactly as every prior batch's suite does — PIM/109/2026 is never referenced by any test code.

---

## 24. Applicant-Consent Determination (resolved before implementation, per instruction — schema not added speculatively)

**Question**: does the authoritative source actually require a distinct, separate "applicant expressly consents" recording event — analogous to the opposite party's appearance-and-consent step — or is the applicant's consent already established by some other already-modeled fact?

**Re-checked directly against the SOP text and the current workflow, not assumed from the earlier planning draft's framing**:

- **Clause 6's entire procedural sequence (6(a)–6(f)) is written exclusively around the *opposite party's* appearance, response, willingness, and fee remittance.** Nowhere in clause 6, or anywhere else in the 24-clause SOP, is a distinct "applicant appears and consents" step described. The applicant is not summoned, does not "appear," and has no analogous response-recording event in the SOP's own procedural text.
- **Section 12A of the Commercial Courts Act itself (quoted in the SOP's own background section, already read in full earlier in this session) frames the entire mechanism around the applicant**: *"A suit... shall not be instituted unless the applicant exhausts the remedy of pre-institution mediation... under sub-section (1)."* The applicant's **filing of the PIMS application** is not incidental to their willingness to mediate — filing it is the statutorily-required act that **is** their engagement with the mediation remedy. There is no textual basis for requiring a *second*, separate consent act from the applicant on top of having filed.
- **Clause 6(d)**'s fee-remittance requirement ("the applicant and the opposite party shall each remit one-half of the mediation fee") already names the applicant as a participant whose continued engagement is evidenced by **paying their fee share**, not by a separate consent recording. Continued participation (fee remittance) is the applicant-side analogue of the opposite party's consent — not a new consent event, but the existing fee-stage gate itself (owned by the future fee batch, not 5K).
- **The current live workflow has never recorded applicant consent as a distinct fact** (confirmed in §4 of this document) and nothing about implementing 5K's opposite-party consent gate correctly requires inventing one — 5K's own gate (§5/§6) is scoped to opposite parties because that is the only side the SOP's clause 6 procedural text ever asks to "consent."

**Determination**: the required business fact is **the applicant's original PIMS application, continued by their participation in the proceeding (most concretely, fee remittance when due) — not a separate, distinct "applicant consents again" recording event.** The source does not clearly require one, and per the task's own instruction, this document does **not** recommend adding an applicant-consent table/field/schema change in 5K or in this revision. §17's "genuinely open schema question" from the original draft is now **closed, in the negative**: no new applicant-consent representation is added. If a future authoritative source (TNSLSA guidance, an amendment, or a judicial ruling analogous to §22's) later establishes a distinct applicant-consent requirement, that would need its own fresh determination at that time — this is not a permanent foreclosure, only a finding based on what is actually available now.

**Consequence for 5K's implementation**: the all-party consent gate (§5/§6, §K below) is scoped to **required opposite parties only** — `ALL_REQUIRED_PARTIES_CONSENTED` never includes an applicant-side term, because no applicant-side consent fact exists to include. This is implemented exactly as determined here, not as a simplification of convenience.

---

*End of planning document (revised a second time). §22 resolved via externally supplied authority; §23 records PIM/109/2026 as a preserved business scenario, never a test fixture; §24 resolves the applicant-consent question in the negative, closing §17's open question without adding schema. Implementation proceeds under a separate "IMPLEMENTATION" heading below this document's original planning content — see `docs/phase6-batch5k-op-response-consent-migration.md` for what was actually built, verified, and tested.*
