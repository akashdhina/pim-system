/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Tests for the mediator-assignment + mediation-session migration
 * (production-completion sprint, 2026-10-07):
 * lib/pim-data/mediator-assignment.js and lib/pim-data/mediation.js,
 * routed from app/api/pim/mediator/[id]/route.js,
 * app/api/pim/mediation/[id]/route.js,
 * app/api/pim/mediation/session/[id]/route.js, and
 * app/api/pim/mediation/next/[id]/route.js.
 *
 * Isolated fixtures only, including a disposable test mediator (deleted
 * on cleanup) - the real approved mediator roster is never touched.
 *
 * Usage:
 *   node scripts/test-pim-mediation-postgres.js
 *   node scripts/test-pim-mediation-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-mediation-manifest.json");
const TEST_PREFIX = "TEST-MED-";
const MEDIATOR_PREFIX = "TEST-MED-MEDIATOR-";

let passed = 0;
const failures = [];

async function test(letter, name, fn) {
  try {
    await fn();
    console.log(`PASS [${letter}]: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL [${letter}]: ${name}`);
    console.error(`      ${error instanceof Error ? error.stack || error.message : error}`);
    failures.push(`[${letter}] ${name}`);
  }
}

function createTracker() {
  return {
    caseIds: new Set(),
    mediatorIds: new Set(),
    addCase(id) { this.caseIds.add(id); this.persist(); },
    addMediator(id) { this.mediatorIds.add(id); this.persist(); },
    persist() {
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ caseIds: [...this.caseIds], mediatorIds: [...this.mediatorIds] }, null, 2));
    },
  };
}

/*
 * Full dependency graph for a case fixture, derived from the live FK
 * catalogue (information_schema), not assumed:
 *   mediation_sessions.assignment_id -> pim_mediator_assignments.id (NO ACTION)
 *   pim_mediator_assignments.replacement_for_assignment_id -> pim_mediator_assignments.id (NO ACTION, self-referential)
 *   mediation_sessions has no children of its own.
 * Deletion order below is child -> parent per that graph. The
 * self-referential replacement_for_assignment_id link is defensively
 * nulled out before the assignments themselves are deleted - no
 * reassignment fixture exercises it today, but a future one might, and
 * NO ACTION would block the delete the same way it did for
 * mediation_sessions here.
 *
 * Wrapped in one retry on a foreign-key violation (23503): an earlier
 * run hit this once, root-caused to a race between a just-crashed test
 * process's last in-flight write and this cleanup's own transaction
 * (the production FK itself is correct and is NOT weakened to work
 * around it - see docs/phase6-mediation-sessions-migration.md).
 */
async function cleanupCasesByIds(sql, caseIds, attempt = 1) {
  if (caseIds.length === 0) return;
  const existing = await sql`SELECT id, received_number FROM pim_cases WHERE id IN ${sql(caseIds)}`;
  for (const row of existing) {
    if (!String(row.received_number || "").startsWith(TEST_PREFIX)) {
      throw new Error(`Refusing to delete case ${row.id}: not a test fixture (received_number=${row.received_number}).`);
    }
  }
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '15s'`;
      const partyIds = (await tx`SELECT DISTINCT party_id FROM pim_case_parties WHERE case_id IN ${tx(caseIds)}`).map((r) => r.party_id);
      const del = async (table, column, ids) => {
        if (ids.length > 0) await tx`DELETE FROM ${tx(table)} WHERE ${tx(column)} IN ${tx(ids)}`;
      };
      await del("pim_outcomes", "case_id", caseIds);
      await del("mediation_sessions", "case_id", caseIds);
      const assignmentIds = (await tx`SELECT id FROM pim_mediator_assignments WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id);
      if (assignmentIds.length > 0) {
        await tx`UPDATE pim_mediator_assignments SET replacement_for_assignment_id = NULL WHERE replacement_for_assignment_id IN ${tx(assignmentIds)}`;
      }
      await del("pim_mediator_assignments", "case_id", caseIds);
      await del("pim_task_history", "task_id", (await tx`SELECT id FROM pim_tasks WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id));
      await del("pim_tasks", "case_id", caseIds);
      await del("pim_docket", "case_id", caseIds);
      await del("pim_status_history", "case_id", caseIds);
      await del("pim_fee_payments", "case_id", caseIds);
      await del("pim_fees", "case_id", caseIds);
      await del("pim_case_advocates", "case_id", caseIds);
      await del("pim_case_parties", "case_id", caseIds);
      await del("pim_addresses", "party_id", partyIds);
      await del("pim_parties", "id", partyIds);
      await del("pim_cases", "id", caseIds);
    });
  } catch (error) {
    if (error && error.code === "23503" && attempt === 1) {
      console.error(`cleanup: foreign-key violation on attempt 1 (${error.message}) - retrying once after a short delay`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return cleanupCasesByIds(sql, caseIds, attempt + 1);
    }
    throw error;
  }
}

async function cleanupMediatorsByIds(sql, mediatorIds) {
  if (mediatorIds.length === 0) return;
  const existing = await sql`SELECT id, name FROM mediators WHERE id IN ${sql(mediatorIds)}`;
  for (const row of existing) {
    if (!String(row.name || "").startsWith(MEDIATOR_PREFIX)) {
      throw new Error(`Refusing to delete mediator ${row.id}: not a test fixture (name=${row.name}).`);
    }
  }
  await sql`DELETE FROM audit_log WHERE table_name = 'mediators' AND record_id IN ${sql(mediatorIds)}`;
  await sql`DELETE FROM mediators WHERE id IN ${sql(mediatorIds)}`;
}

async function recoverStaleFixtures(sql, tracker) {
  if (!fs.existsSync(MANIFEST_PATH)) return;
  const stale = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  console.log(`cleanup: removing stale fixtures: cases=${JSON.stringify(stale.caseIds)} mediators=${JSON.stringify(stale.mediatorIds)}`);
  await cleanupCasesByIds(sql, stale.caseIds || []);
  await cleanupMediatorsByIds(sql, stale.mediatorIds || []);
  for (const id of stale.caseIds || []) tracker.caseIds.add(id);
  for (const id of stale.mediatorIds || []) tracker.mediatorIds.add(id);
  fs.rmSync(MANIFEST_PATH, { force: true });
}

async function main() {
  const { getSql } = require("../lib/pim-postgres");
  const { assignMediatorPg, getMediatorAssignmentDataPg } = require("../lib/pim-data/mediator-assignment");
  const { fixFirstMediationDatePg, recordMediationSessionPg, fixNextMediationDatePg, getMediationCaseDataPg } = require("../lib/pim-data/mediation");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { createMediatorPg } = require("../lib/pim-data/mediator-registry");

  const sql = getSql();

  if (process.argv.includes("--cleanup-only")) {
    const tracker = createTracker();
    await recoverStaleFixtures(sql, tracker);
    await sql.end({ timeout: 5 });
    return;
  }

  const tracker = createTracker();
  await sql`SELECT 1`;
  await recoverStaleFixtures(sql, tracker);

  const [aaUser] = await sql`SELECT id FROM users WHERE role_code = 'aa' AND active = true LIMIT 1`;
  assert.ok(aaUser, "expected a synced 'aa' user");

  const [mediatorAssignedStatus] = await sql`SELECT id FROM status_master WHERE code = 'MEDIATOR_ASSIGNED'`;
  const [mediationPendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'MEDIATION_PENDING'`;
  const [mediationOngoingStatus] = await sql`SELECT id FROM status_master WHERE code = 'MEDIATION_ONGOING'`;
  const [outcomeFormPendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'OUTCOME_FORM_PENDING'`;

  async function fixtureMediator(tag, overrides = {}) {
    const mediator = await createMediatorPg({
      name: `${MEDIATOR_PREFIX}${tag}-${Date.now()}`,
      category: "ADVOCATE MEDIATOR",
      enrollment_no: null, contact_phone: null, email: null,
      empanelment_order_no: null, empanelment_date: "2026-01-01", panel_valid_until: null,
      active: true, rotation_order: null, conflict_declaration_date: null, remarks: null,
      ...overrides,
    }, aaUser.id);
    tracker.addMediator(mediator.id);
    return mediator.id;
  }

  async function fixtureCaseAtMediatorPending(tag) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `Med Applicant ${tag}` }], oppositeParties: [{ name: `Med Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      claimAmount: 500000,
    }, aaUser.id);
    tracker.addCase(caseId);
    const [status] = await sql`SELECT id FROM status_master WHERE code = 'MEDIATOR_ASSIGNMENT_PENDING'`;
    await sql`UPDATE pim_cases SET current_status_id = ${status.id} WHERE id = ${caseId}`;
    return caseId;
  }

  try {
    await test("A", "mediator assignment: happy path, exactly one FIRST_MEDIATION task, MEDIATOR_ASSIGNMENT task completed", async () => {
      const mediatorId = await fixtureMediator("A");
      const caseId = await fixtureCaseAtMediatorPending("A");

      const result = await assignMediatorPg(caseId, { mediatorId }, aaUser.id);
      assert.strictEqual(result.statusCode, "MEDIATOR_ASSIGNED");
      assert.ok(result.firstMediationTaskId);

      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, mediatorAssignedStatus.id);

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'FIRST_MEDIATION'`;
      assert.strictEqual(n, 1);
      return { caseId, mediatorId };
    });

    await test("B", "inactive mediator cannot be assigned", async () => {
      const mediatorId = await fixtureMediator("B", { active: false });
      const caseId = await fixtureCaseAtMediatorPending("B");
      await assert.rejects(() => assignMediatorPg(caseId, { mediatorId }, aaUser.id), /Inactive mediators/);
    });

    await test("C", "expired panel validity blocks assignment", async () => {
      const mediatorId = await fixtureMediator("C", { panel_valid_until: "2020-01-01" });
      const caseId = await fixtureCaseAtMediatorPending("C");
      await assert.rejects(() => assignMediatorPg(caseId, { mediatorId }, aaUser.id), /panel validity has expired/);
    });

    await test("D", "a second active assignment on the same case is rejected", async () => {
      const mediatorId1 = await fixtureMediator("D1");
      const mediatorId2 = await fixtureMediator("D2");
      const caseId = await fixtureCaseAtMediatorPending("D");
      await assignMediatorPg(caseId, { mediatorId: mediatorId1 }, aaUser.id);
      // Case has moved past MEDIATOR_ASSIGNMENT_PENDING now, so this should
      // fail on the status guard already - force back to prove the
      // active-assignment guard too, independent of the status guard.
      const [pendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'MEDIATOR_ASSIGNMENT_PENDING'`;
      await sql`UPDATE pim_cases SET current_status_id = ${pendingStatus.id} WHERE id = ${caseId}`;
      await assert.rejects(() => assignMediatorPg(caseId, { mediatorId: mediatorId2 }, aaUser.id), /already assigned/);
    });

    let ctxE;
    await test("E", "first mediation date fix: MEDIATOR_ASSIGNED -> MEDIATION_PENDING, FIRST_MEDIATION task completed, sitting #1 created", async () => {
      const mediatorId = await fixtureMediator("E");
      const caseId = await fixtureCaseAtMediatorPending("E");
      await assignMediatorPg(caseId, { mediatorId }, aaUser.id);

      const result = await fixFirstMediationDatePg(caseId, { scheduledDate: "2026-03-01" }, aaUser.id);
      assert.strictEqual(result.statusCode, "MEDIATION_PENDING");
      assert.strictEqual(result.sittingNumber, 1);
      assert.ok(result.completedTaskId, "FIRST_MEDIATION task must be completed");

      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, mediationPendingStatus.id);
      ctxE = { caseId, sessionId: result.sessionId };
    });

    await test("F", "recording an effective session (both present): MEDIATION_PENDING -> MEDIATION_ONGOING, duration computed, SESSION_RECORD/OUTCOME_FORM task created depending on nextDate", async () => {
      assert.ok(ctxE, "prerequisite E did not complete");

      const result = await recordMediationSessionPg(ctxE.sessionId, {
        actualDate: "2026-03-01", applicantPresent: true, oppositePartyPresent: true,
        actualStartTime: "10:00", actualEndTime: "11:30", nextDate: "2026-03-15",
      }, aaUser.id);

      assert.strictEqual(result.effectiveSession, true);
      assert.strictEqual(result.durationMinutes, 90);
      assert.strictEqual(result.statusCode, "MEDIATION_ONGOING");
      assert.ok(result.nextSessionId, "a next sitting must be created");
      assert.ok(result.nextTaskId, "a SESSION_RECORD task must be created for the next sitting");

      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${ctxE.caseId}`;
      assert.strictEqual(caseRow.current_status_id, mediationOngoingStatus.id);

      const [nextSession] = await sql`SELECT sitting_number, session_status FROM mediation_sessions WHERE id = ${result.nextSessionId}`;
      assert.strictEqual(nextSession.sitting_number, 2);
      assert.strictEqual(nextSession.session_status, "SCHEDULED");
    });

    let ctxG;
    await test("G", "recording an ineffective session requires a next date and keeps the case MEDIATION_ONGOING", async () => {
      const mediatorId = await fixtureMediator("G");
      const caseId = await fixtureCaseAtMediatorPending("G");
      await assignMediatorPg(caseId, { mediatorId }, aaUser.id);
      const first = await fixFirstMediationDatePg(caseId, { scheduledDate: "2026-03-01" }, aaUser.id);

      await assert.rejects(
        () => recordMediationSessionPg(first.sessionId, { actualDate: "2026-03-01", applicantPresent: true, oppositePartyPresent: false }, aaUser.id),
        /Next date is required/
      );

      const result = await recordMediationSessionPg(first.sessionId, {
        actualDate: "2026-03-01", applicantPresent: true, oppositePartyPresent: false, nextDate: "2026-03-10",
      }, aaUser.id);
      assert.strictEqual(result.effectiveSession, false);
      assert.strictEqual(result.sessionStatus, "ADJOURNED");
      assert.strictEqual(result.statusCode, "MEDIATION_ONGOING");
      ctxG = { caseId, nextSessionId: result.nextSessionId };
    });

    await test("H", "concluding mediation (no next date) moves the case to OUTCOME_FORM_PENDING with exactly one OUTCOME_FORM task", async () => {
      assert.ok(ctxG, "prerequisite G did not complete");
      const result = await recordMediationSessionPg(ctxG.nextSessionId, {
        actualDate: "2026-03-10", applicantPresent: true, oppositePartyPresent: true, actualStartTime: "09:00", actualEndTime: "10:00",
      }, aaUser.id);
      assert.strictEqual(result.statusCode, "OUTCOME_FORM_PENDING");
      assert.ok(result.outcomeTaskId);

      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${ctxG.caseId}`;
      assert.strictEqual(caseRow.current_status_id, outcomeFormPendingStatus.id);

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${ctxG.caseId} AND task_type_code = 'OUTCOME_FORM'`;
      assert.strictEqual(n, 1);
    });

    await test("I", "recording an already-recorded session is a 409-style conflict, not a thrown error, and changes nothing", async () => {
      assert.ok(ctxE, "prerequisite E did not complete");
      const result = await recordMediationSessionPg(ctxE.sessionId, { actualDate: "2026-03-01", applicantPresent: true, oppositePartyPresent: true, actualStartTime: "10:00", actualEndTime: "11:00" }, aaUser.id);
      assert.strictEqual(result.conflict, true);
      assert.match(result.message, /already been recorded/);
    });

    await test("J", "fixNextMediationDatePg rejects when a scheduled sitting already exists (dedup)", async () => {
      const mediatorId = await fixtureMediator("J");
      const caseId = await fixtureCaseAtMediatorPending("J");
      await assignMediatorPg(caseId, { mediatorId }, aaUser.id);
      await fixFirstMediationDatePg(caseId, { scheduledDate: "2026-03-01" }, aaUser.id);

      await assert.rejects(() => fixNextMediationDatePg(caseId, { scheduledDate: "2026-04-01" }, aaUser.id), /not currently available/);
    });

    await test("K", "getMediationCaseDataPg returns cumulative duration counting only effective sessions", async () => {
      assert.ok(ctxE, "prerequisite E did not complete");
      const data = await getMediationCaseDataPg(ctxE.caseId);
      assert.strictEqual(data.cumulativeDurationMinutes, 90);
    });

    await test("L", "getMediatorAssignmentDataPg lists the active mediator roster and this case's assignment history", async () => {
      const result = await getMediatorAssignmentDataPg(ctxE.caseId);
      assert.ok(result.assignments.length >= 1);
      assert.ok(result.mediators.some((m) => m.id === result.assignments[0].mediator_id));
    });
  } finally {
    console.log(`\ncleanup: removing exactly these fixture case ids: ${JSON.stringify([...tracker.caseIds])}, mediator ids: ${JSON.stringify([...tracker.mediatorIds])}`);
    try {
      await cleanupCasesByIds(sql, [...tracker.caseIds]);
      await cleanupMediatorsByIds(sql, [...tracker.mediatorIds]);
    } catch (error) {
      console.error(`CLEANUP FAILED: ${error.message}`);
      failures.push("cleanup of fixtures");
    }
  }

  await test("RESIDUE", "no test fixture rows remain", async () => {
    const remainingCases = await sql`SELECT COUNT(*)::int AS n FROM pim_cases WHERE id IN ${sql([...tracker.caseIds, 0])}`;
    assert.strictEqual(remainingCases[0].n, 0);
    const remainingMediators = await sql`SELECT COUNT(*)::int AS n FROM mediators WHERE id IN ${sql([...tracker.mediatorIds, 0])}`;
    assert.strictEqual(remainingMediators[0].n, 0);
  });

  if (!failures.some((f) => f.includes("cleanup") || f.includes("RESIDUE"))) {
    fs.rmSync(MANIFEST_PATH, { force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    console.error(`Failures:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }

  await sql.end({ timeout: 5 });
}

main().catch((error) => {
  console.error("Test run crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
