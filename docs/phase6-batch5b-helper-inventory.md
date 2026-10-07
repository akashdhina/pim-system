# Phase 6 Batch 5B — Global-DB-Access Dependency Map

**Status: preparation only.** This inventories every function that touches the SQLite `db` singleton and could eventually run inside a (future) PostgreSQL transaction. It does not change business behavior, schema, auth, sessions, or SQL semantics. See `docs/phase6-transaction-readiness.md` for the transaction-by-transaction audit this batch builds on.

## Scope decision

Two distinct populations of "helper" exist in this codebase:

1. **Genuinely shared modules** in `lib/` — imported by more than one route (or, in the case of `lib/pim-legacy-import.js`, containing the deepest single call chain in the app). These are the ones `docs/phase6-transaction-readiness.md` §K singled out as "the single most repeated, highest-leverage prerequisite" — refactoring them once unlocks every transaction that reuses them.
2. **Route-local duplicated helpers** — every mutation route file defines its *own* private copies of small functions with the same names (`getCase`, `getStatusId`, `getEventId`, `addDocket`, `addStatusHistory`, `completeTask`, `getPendingTask`, etc.). These are not imported anywhere else; each route file's copy is used only by that route's own `db.transaction()`.

This batch refactors population (1) — the 7 shared `lib/*.js` modules plus one shared read helper in `lib/pim-settings.js` — because that is where dependency injection has real leverage (multiple transactions reuse the same function). Population (2) is inventoried below but **left unmodified**: each route-local helper set will get the identical, mechanical `dbClient` treatment when that specific route's own transaction is migrated (Batch 5C+), not now. Touching all ~16 route files in this batch would multiply the diff without adding any reusable capability, and risks exactly the kind of unrelated-caller churn the batch instructions warn against.

---

## Part 1 — Shared modules (refactored this batch)

| Module | Functions touching `db` | Called inside a `db.transaction()`? | Called outside one too? | Reads | Writes | Returns generated ID | SQLite-specific result shape |
|---|---|---|---|---|---|---|---|
| `lib/pim.js` | `createReceivedPimApplication` (owns its own transaction), `addParties`, `getPrimaryPartyId` | Yes — all 3 run inside `createReceivedPimApplication`'s own transaction | No | Yes | Yes | Yes (`lastInsertRowid` ×3: case, party×N, advocate×N) | Yes |
| `lib/pim-scrutiny.js` | `getStatusId`, `getEventId`, `getCaseForScrutiny`, `getExistingScrutiny`, `getPendingTask`, `completeTask`, `insertScrutinyAttempt`, `saveScrutiny` (owns its own transaction) | Yes — all of the above run inside `saveScrutiny`'s transaction | `getStatusId`/`getEventId`/`getCaseForScrutiny`/`getExistingScrutiny` are also called (unchanged, not exported for outside use) from `getScrutinyCase`, a read-only GET-path helper that never opens a transaction — see note below | Yes | Yes | No (no `lastInsertRowid` used in this file) | Yes |
| `lib/pim-approval.js` | `getSetting`, `getStatusId`, `getEventId`, `generatePimNumber`, `addStatusHistory`, `addDocket`, `completePendingScrutinyTask`, `createForm2Task`, `approvePimRegistration` (owns its own transaction) | Yes — all run inside `approvePimRegistration`'s transaction | Yes — `generatePimNumber` is also called from `lib/pim-legacy-import.js`'s `previewLegacyImport` (no transaction open) and from inside `importLegacyCase`'s transaction (a genuine cross-module, both-contexts call site) | Yes | Yes | Yes (`createForm2Task` returns `lastInsertRowid`, not chained further) | Yes |
| `lib/pim-nonstarter.js` | `getCase`, `getActiveNonStarterReasons`, `getReasonByCode`, `getReasonById`, `inferNonStarterContext`, `recordNonStarter` | `recordNonStarter` does **not** own a transaction — it is always called from inside the *route's* own `db.transaction(() => recordNonStarter({...}))()` (`app/api/pim/nonstarter/[id]/route.js:164-174`) | `getActiveNonStarterReasons` is also called standalone (GET listing, no transaction) — left unmodified, not on the write path | Yes | Yes | Yes (`pim_outcomes.id`, not chained further within this call) | Yes |
| `lib/pim-op-response.js` | `getStatusId`, `getEventId`, `addStatusHistory`, `transitionStatus`, `addDocket`, `getCase`, `getActiveOppositeParty`, `loadNotice`, `requireIssuedNoticeForParty`, `getLatestResponse`, `getPendingTask`, `completeTask`, `completeTaskIfPending`, `createPendingTaskIfNotExists`, `createNonStarterHandoff`, `insertResponse`, `ensureMediationFee` | Yes — reused across the response (T10), consent (T11), non-starter (T7, via re-export), and service-attempt (T12, `createPendingTaskIfNotExists` only) transactions, all of which own their transaction at the *route* level, not here | No — every function in this file is only ever called from inside one of those routes' open transactions | Yes | Yes | Yes (`insertResponse`, `ensureMediationFee`, `createPendingTaskIfNotExists` each return `lastInsertRowid`) | Yes |
| `lib/pim-fresh-notice.js` | `assertNoActiveNoticeForParty`, `createFreshNotice`, `createFreshInitialNotice` | Yes — called from inside `form2/[id]`'s (T4) and `address-correction/[id]`'s (T23) transactions | No | Yes | Yes | Yes (`lastInsertRowid`, chained into `pim_notices.address_id` at the T23 call site — see readiness doc §C) | Yes |
| `lib/pim-legacy-import.js` | `getStatusId`, `getEventId`, `getTaskType`, `addStatus`, `addDocket`, `addAudit`, `addTask`, `addParty`, `preventDuplicate`, `addBaseline`, `addScrutiny`, `addRegistration`, `addForm2`, `addResponseAndFee`, `addMediatorAssignment`, `addFirstMediation`, `addOngoingSession`, `addOutcome`, `createPendingForStage`, `importLegacyCase` (owns its own transaction) | Yes — all of the above run inside `importLegacyCase`'s transaction | `getStatusId`/`getEventId`/`getTaskType`-style lookups have no other callers; `previewLegacyImport`, `buildPreviewWarnings`, `getLegacyImportMetadata`, `validateLegacyImport` also touch `db` but run entirely outside any transaction (preview-only / metadata-listing) and are left unmodified | Yes | Yes | Yes (7 `lastInsertRowid` sites — see readiness doc §C for the full chain) | Yes |
| `lib/pim-settings.js` | `getSetting` only | Yes — called (as `getOfficeSetting`) from inside `lib/pim-approval.js`'s `generatePimNumber`, itself called inside `approvePimRegistration`'s (T3) and `importLegacyCase`'s (T25) transactions | Yes — also called standalone elsewhere (unrelated read paths) | Yes | No | No | No |

**Not refactored, confirmed out of scope by direct inspection:**
- `lib/pim-settings.js`'s `getSettings`, `validateSettings`, `updateSettings` — `updateSettings` owns its own `db.transaction()` (settings PATCH) which is not one of the 26 workflow transactions and is never called from inside any of them.
- `lib/pim-auth.js` — every `db.prepare` in this file (login, session, audit) runs as part of `requirePermission()`/`requireUser()`, which the readiness audit already confirmed always completes **before** any workflow transaction opens, in every one of the 26 routes, with zero exceptions found. No thread-through is needed because auth is never called *inside* a transaction.
- `lib/pim-users.js` — user CRUD, not called from any of the 26 workflow transactions; user mutations remain out of migration scope per standing instructions.
- `lib/pim-document.js` — all of its `db.prepare` calls are read-only data-gathering for `.docx` template rendering, and (confirmed in the readiness audit, §J) they run entirely **before** the DB transaction opens for T21/T22, and **inside but read-before-write** for T6 (a pre-existing pattern flagged, not changed, in that audit). None of its reads currently need to be transaction-consistent with a concurrent write, so no `dbClient` threading was added; this is a candidate for the Batch 5E document-generation batch the readiness audit recommended, not for this one.
- `lib/pim-action-link.js` — confirmed via grep: no `db` access at all.
- `lib/pim-scrutiny.js`'s `getScrutinyCase` — a GET-path read helper, never opens or participates in a transaction. Left unmodified to keep this batch's diff limited to genuinely transaction-relevant code, per the batch's own "do not modify unrelated callers unnecessarily" instruction.
- `lib/pim-nonstarter.js`'s `getActiveNonStarterReasons` — same reasoning, a GET-listing helper.

---

## Part 2 — Route-local duplicated helpers (inventoried, not refactored this batch)

Every one of these 16 route files defines its own private copies of small helpers (`getCase`/`getStatusId`/`getEventId`/`addDocket`/`addStatusHistory`/`completeTask`/`getPendingTask`, or a subset) that are used only by that file's own `db.transaction()` and imported nowhere else:

`app/api/pim/case/[id]/route.js` (GET only, no transaction — listed by the grep but not a mutation route), `app/api/pim/outcome/[id]/route.js` (T19), `app/api/pim/outcome/approve/[id]/route.js` (T20), `app/api/pim/mediator/[id]/route.js` (T13), `app/api/pim/mediator/reassign/[id]/route.js` (T14), `app/api/pim/mediation/[id]/route.js` (T15), `app/api/pim/mediation/next/[id]/route.js` (T16), `app/api/pim/mediation/session/[id]/route.js` (T17), `app/api/pim/fee/[id]/route.js` (T18), `app/api/pim/service/[id]/route.js` (T12), `app/api/pim/form2/[id]/route.js` (T4), `app/api/pim/form2/issue/[id]/route.js` (T5), `app/api/pim/documents/outcome/[id]/route.js` (T21), `app/api/pim/nonstarter/form3/[id]/route.js` (T8), `app/api/pim/nonstarter/authority/[id]/route.js` (T9), `app/api/pim/address-correction/[id]/route.js` (T23, T24).

Each of these will need the identical mechanical treatment — add a trailing `dbClient = db` parameter, replace `db.prepare`/`db.exec` with `dbClient.prepare`/`dbClient.exec`, thread `dbClient` through nested calls — at the point its own transaction is actually migrated. No code in this population was touched in Batch 5B.

---

## Part 3 — Generated-ID dependencies (batch item 6)

Restating, from `docs/phase6-transaction-readiness.md` §C, the specific occurrences inside the 7 refactored modules (the only 3 genuine same-transaction insert-chains in the whole app, plus every other occurrence which is a simple insert-then-return):

```
SQLite (current, unchanged by this batch):
  lib/pim.js:               INSERT pim_cases    -> lastInsertRowid -> feeds pim_case_parties/pim_addresses/pim_case_advocates/pim_fees/pim_status_history/pim_docket/pim_tasks (case_id)
  lib/pim.js:                INSERT pim_parties  -> lastInsertRowid -> feeds pim_case_parties/pim_addresses/pim_case_advocates (party_id)
  lib/pim.js:                INSERT pim_advocates -> lastInsertRowid -> feeds pim_case_advocates (advocate_id)
  lib/pim-approval.js:       INSERT pim_tasks (Form2 task) -> lastInsertRowid -> return-value only
  lib/pim-nonstarter.js:     INSERT pim_outcomes -> lastInsertRowid -> return-value only
  lib/pim-op-response.js:    INSERT pim_responses -> lastInsertRowid -> return-value only
  lib/pim-op-response.js:    INSERT pim_fees (ensureMediationFee) -> lastInsertRowid -> return-value only
  lib/pim-op-response.js:    INSERT pim_tasks (createPendingTaskIfNotExists) -> lastInsertRowid -> return-value only
  lib/pim-fresh-notice.js:   INSERT pim_notices -> lastInsertRowid -> return-value only (except at the T23 route call site, where the *caller's* new pim_addresses id feeds this INSERT's address_id param - the chain crosses a lib/pim.js-adjacent route boundary, not internal to this file)
  lib/pim-legacy-import.js:  INSERT pim_cases -> lastInsertRowid -> feeds every subsequent insert in the same import (deepest chain in the app)
  lib/pim-legacy-import.js:  INSERT pim_parties (addParty) -> lastInsertRowid -> feeds pim_case_parties/pim_addresses, and (for the primary opposite party) pim_notices/pim_responses/pim_fees
  lib/pim-legacy-import.js:  INSERT pim_tasks (addTask) -> lastInsertRowid -> feeds pim_task_history only when status='COMPLETED'
  lib/pim-legacy-import.js:  INSERT pim_notices (addForm2) -> lastInsertRowid -> feeds pim_service_attempts.notice_id
  lib/pim-legacy-import.js:  INSERT pim_mediator_assignments -> lastInsertRowid -> feeds mediation_sessions.assignment_id (both sittings)
  lib/pim-legacy-import.js:  INSERT mediation_sessions (x2) -> lastInsertRowid -> return-value only

Future PostgreSQL (not implemented in this batch):
  every one of the above -> INSERT ... RETURNING id -> same consuming statement, awaited before use
```

No `lastInsertRowid` call site was changed in this batch. This section exists purely as the required preparation note per batch item 6.

---

## Part 4 — Cross-cutting notes carried forward unchanged (batch items 10-12)

- **Concurrency risks** (PIM-number `MAX+1`, one-active-assignment, one-scheduled-session, fee dedup, and every other guard-read-then-write invariant catalogued in `docs/phase6-transaction-readiness.md` §I) are **not** addressed by this batch. Adding `dbClient` parameters does not change whether two concurrent callers could race — SQLite's single-writer serialization is still what makes every one of these safe today, and that property is not affected by this refactor either way. These remain pending PostgreSQL-concurrency-design work for a future batch.
- **Date/time findings** (UTC-vs-IST `today()` inconsistency across roughly half the transactions) are **not** touched by this batch. Every helper's date/time source (`officeDate()`, `officeTime()`, `todayLocal()`, raw `new Date()`) is unchanged, verbatim, in every refactored function.
- **Audit logging**: `lib/pim-legacy-import.js`'s `addAudit` now accepts a `dbClient` parameter like every other helper in that file, and `importLegacyCase` threads the same `dbClient` into it that it uses for every other statement — preserving the existing guarantee that the `audit_log` write commits/rolls back atomically with the rest of the import. No other module's helpers write `audit_log` (confirmed in the readiness audit), so no other change was needed here.
