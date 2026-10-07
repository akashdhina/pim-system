/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Tests for the mediator-reassignment migration (production-completion
 * sprint, 2026-10-07): lib/pim-data/mediator-assignment.js's
 * reassignMediatorPg, routed from
 * app/api/pim/mediator/reassign/[id]/route.js. See
 * docs/phase6-mediator-reassignment-migration.md.
 *
 * This is the first real exercise of
 * pim_mediator_assignments.replacement_for_assignment_id - the earlier
 * mediation-session test suite only defended against it, it never
 * actually created a chain. Cleanup here handles that FK for real: the
 * self-reference is nulled out before any assignment row is deleted.
 *
 * Usage:
 *   node scripts/test-pim-mediator-reassignment-postgres.js
 *   node scripts/test-pim-mediator-reassignment-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-mediator-reassign-manifest.json");
const TEST_PREFIX = "TEST-REASSIGN-";
const MEDIATOR_PREFIX = "TEST-REASSIGN-MEDIATOR-";

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
      // The self-referential chain is real here (reassignment actually
      // sets replacement_for_assignment_id) - null it out for every
      // tracked assignment before deleting any of them, regardless of
      // which one points at which.
      const assignmentIds = (await tx`SELECT id FROM pim_mediator_assignments WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id);
      if (assignmentIds.length > 0) {
        await tx`UPDATE pim_mediator_assignments SET replacement_for_assignment_id = NULL WHERE id IN ${tx(assignmentIds)}`;
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
  const { assignMediatorPg, reassignMediatorPg } = require("../lib/pim-data/mediator-assignment");
  const { fixFirstMediationDatePg, recordMediationSessionPg } = require("../lib/pim-data/mediation");
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

  async function fixtureMediator(tag, overrides = {}) {
    const mediator = await createMediatorPg({
      name: `${MEDIATOR_PREFIX}${tag}-${Date.now()}`, category: "ADVOCATE MEDIATOR",
      enrollment_no: null, contact_phone: null, email: null, empanelment_order_no: null,
      empanelment_date: "2026-01-01", panel_valid_until: null, active: true,
      rotation_order: null, conflict_declaration_date: null, remarks: null,
      ...overrides,
    }, aaUser.id);
    tracker.addMediator(mediator.id);
    return mediator.id;
  }

  async function fixtureCaseWithActiveAssignment(tag) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `Reassign Applicant ${tag}` }], oppositeParties: [{ name: `Reassign Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      claimAmount: 500000,
    }, aaUser.id);
    tracker.addCase(caseId);

    const [pendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'MEDIATOR_ASSIGNMENT_PENDING'`;
    await sql`UPDATE pim_cases SET current_status_id = ${pendingStatus.id} WHERE id = ${caseId}`;

    const mediatorId = await fixtureMediator(tag);
    const assignResult = await assignMediatorPg(caseId, { mediatorId }, aaUser.id);
    return { caseId, mediatorId, assignmentId: assignResult.assignmentId };
  }

  try {
    await test("A", "valid reassignment: old assignment ENDED with history preserved, new one ACTIVE with correct replacement_for_assignment_id, exactly one active assignment remains", async () => {
      const { caseId, mediatorId: oldMediatorId, assignmentId: oldAssignmentId } = await fixtureCaseWithActiveAssignment("A");
      const newMediatorId = await fixtureMediator("A-new");

      const result = await reassignMediatorPg(caseId, { mediatorId: newMediatorId, reason: "Original mediator unavailable." }, aaUser.id);
      assert.strictEqual(result.oldAssignmentId, oldAssignmentId);
      assert.strictEqual(result.oldMediatorId, oldMediatorId);
      assert.strictEqual(result.newMediatorId, newMediatorId);
      assert.ok(result.newAssignmentId && result.newAssignmentId !== oldAssignmentId);

      const [oldRow] = await sql`SELECT status, replacement_for_assignment_id, remarks FROM pim_mediator_assignments WHERE id = ${oldAssignmentId}`;
      assert.strictEqual(oldRow.status, "ENDED", "the old assignment must be ENDED, never deleted");
      assert.ok(oldRow.remarks && oldRow.remarks.includes("Reassigned to"), "history/reason must be appended, not overwritten");

      const [newRow] = await sql`SELECT status, replacement_for_assignment_id, mediator_id FROM pim_mediator_assignments WHERE id = ${result.newAssignmentId}`;
      assert.strictEqual(newRow.status, "ACTIVE");
      assert.strictEqual(newRow.replacement_for_assignment_id, oldAssignmentId, "replacement_for_assignment_id must point at the old assignment");
      assert.strictEqual(newRow.mediator_id, newMediatorId);

      const activeCount = await sql`SELECT COUNT(*)::int AS n FROM pim_mediator_assignments WHERE case_id = ${caseId} AND status = 'ACTIVE'`;
      assert.strictEqual(activeCount[0].n, 1, "exactly one ACTIVE assignment must remain for the case");
    });

    await test("B", "reassigning to an inactive mediator is rejected, nothing changes", async () => {
      const { caseId, assignmentId: oldAssignmentId } = await fixtureCaseWithActiveAssignment("B");
      const inactiveMediatorId = await fixtureMediator("B-inactive", { active: false });

      await assert.rejects(
        () => reassignMediatorPg(caseId, { mediatorId: inactiveMediatorId, reason: "test" }, aaUser.id),
        /Inactive mediators cannot be newly assigned/
      );

      const [oldRow] = await sql`SELECT status FROM pim_mediator_assignments WHERE id = ${oldAssignmentId}`;
      assert.strictEqual(oldRow.status, "ACTIVE", "the original assignment must remain untouched on rejection");
    });

    await test("C", "reassigning to a mediator with an expired panel is rejected", async () => {
      const { caseId } = await fixtureCaseWithActiveAssignment("C");
      const expiredMediatorId = await fixtureMediator("C-expired", { panel_valid_until: "2020-01-01" });

      await assert.rejects(
        () => reassignMediatorPg(caseId, { mediatorId: expiredMediatorId, reason: "test" }, aaUser.id),
        /panel validity has expired/
      );
    });

    await test("D", "reassigning to the same mediator already active is rejected", async () => {
      const { caseId, mediatorId } = await fixtureCaseWithActiveAssignment("D");
      await assert.rejects(
        () => reassignMediatorPg(caseId, { mediatorId, reason: "test" }, aaUser.id),
        /Cannot reassign to the same mediator/
      );
    });

    await test("E", "existing mediation sessions are preserved and keep pointing at the OLD assignment_id after reassignment", async () => {
      const { caseId, assignmentId: oldAssignmentId } = await fixtureCaseWithActiveAssignment("E");
      const first = await fixFirstMediationDatePg(caseId, { scheduledDate: "2026-03-01" }, aaUser.id);
      await recordMediationSessionPg(first.sessionId, {
        actualDate: "2026-03-01", applicantPresent: true, oppositePartyPresent: false, nextDate: "2026-03-10",
      }, aaUser.id);

      const newMediatorId = await fixtureMediator("E-new");
      await reassignMediatorPg(caseId, { mediatorId: newMediatorId, reason: "mid-mediation swap" }, aaUser.id);

      const [sessionRow] = await sql`SELECT assignment_id FROM mediation_sessions WHERE id = ${first.sessionId}`;
      assert.strictEqual(sessionRow.assignment_id, oldAssignmentId, "a sitting already recorded under the old mediator must never be re-attributed");

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM mediation_sessions WHERE case_id = ${caseId}`;
      assert.strictEqual(n, 2, "no session must be orphaned or lost - both the recorded sitting and the next scheduled one remain");
    });

    await test("F", "pending tasks are left completely untouched by reassignment (no stage transition)", async () => {
      const { caseId } = await fixtureCaseWithActiveAssignment("F");
      const [beforeTask] = await sql`SELECT id, status FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'FIRST_MEDIATION' AND status = 'PENDING'`;
      assert.ok(beforeTask, "a FIRST_MEDIATION task must exist from the initial assignment");
      // The case also carries intake's own auto-generated task (e.g.
      // SCRUTINY) - createReceivedPimApplicationPg creates it as a side
      // effect of intake itself, unrelated to mediator assignment. The
      // point of this test is that reassignment creates no NEW task and
      // disturbs no EXISTING one, not that the case has exactly one task.
      const [{ n: beforeCount }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${caseId}`;

      const newMediatorId = await fixtureMediator("F-new");
      const result = await reassignMediatorPg(caseId, { mediatorId: newMediatorId, reason: "test" }, aaUser.id);
      assert.strictEqual(result.statusCode, "MEDIATOR_ASSIGNED", "case status must be unchanged by reassignment");

      const [afterTask] = await sql`SELECT id, status FROM pim_tasks WHERE id = ${beforeTask.id}`;
      assert.strictEqual(afterTask.status, "PENDING", "the existing task must remain exactly as it was - no stage transition");

      const [{ n: afterCount }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${caseId}`;
      assert.strictEqual(afterCount, beforeCount, "reassignment must create no new task and remove none");
    });

    await test("G", "rollback is atomic: a rejected reassignment (same mediator) leaves assignments, tasks, and docket completely unchanged", async () => {
      const { caseId, mediatorId, assignmentId } = await fixtureCaseWithActiveAssignment("G");
      const [beforeDocketCount] = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${caseId}`;

      await assert.rejects(() => reassignMediatorPg(caseId, { mediatorId, reason: "test" }, aaUser.id));

      const [afterDocketCount] = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${caseId}`;
      assert.strictEqual(afterDocketCount.n, beforeDocketCount.n, "no docket entry must be written on a rejected reassignment");
      const [{ n: assignmentCount }] = await sql`SELECT COUNT(*)::int AS n FROM pim_mediator_assignments WHERE case_id = ${caseId}`;
      assert.strictEqual(assignmentCount, 1, "no new assignment row must be created on a rejected reassignment");
      const [stillActive] = await sql`SELECT status FROM pim_mediator_assignments WHERE id = ${assignmentId}`;
      assert.strictEqual(stillActive.status, "ACTIVE");
    });

    await test("H", "concurrent reassignment to the SAME target mediator: exactly one commits, one is rejected (already active) after serialization, exactly one ACTIVE assignment survives", async () => {
      // Racing two DIFFERENT target mediators isn't actually a conflict:
      // serialized by the case-row lock, A -> X then X -> Y are both
      // individually valid sequential transitions - there is no reason
      // the second should fail. The real concurrency invariant is two
      // concurrent attempts at the IDENTICAL transition (A -> X twice):
      // the loser, after the lock releases and it re-reads state, must
      // see X already active and be rejected by the same-mediator guard
      // - never silently double-apply, never leave two ACTIVE rows.
      const { caseId } = await fixtureCaseWithActiveAssignment("H");
      const mediatorX = await fixtureMediator("H-x");

      const settled = await Promise.allSettled([
        reassignMediatorPg(caseId, { mediatorId: mediatorX, reason: "race A" }, aaUser.id),
        reassignMediatorPg(caseId, { mediatorId: mediatorX, reason: "race B" }, aaUser.id),
      ]);

      const winners = settled.filter((s) => s.status === "fulfilled");
      const losers = settled.filter((s) => s.status === "rejected");
      assert.strictEqual(winners.length, 1, "exactly one concurrent reassignment must commit");
      assert.strictEqual(losers.length, 1, "exactly one concurrent reassignment must fail");

      const [{ n: activeCount }] = await sql`SELECT COUNT(*)::int AS n FROM pim_mediator_assignments WHERE case_id = ${caseId} AND status = 'ACTIVE'`;
      assert.strictEqual(activeCount, 1, "exactly one ACTIVE assignment must survive the race - never zero, never two");
    });

    await test("I", "reassignment is rejected on a terminal/non-reassignable case status", async () => {
      const { caseId } = await fixtureCaseWithActiveAssignment("I");
      const [outcomePendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'OUTCOME_FORM_PENDING'`;
      await sql`UPDATE pim_cases SET current_status_id = ${outcomePendingStatus.id} WHERE id = ${caseId}`;

      const newMediatorId = await fixtureMediator("I-new");
      await assert.rejects(
        () => reassignMediatorPg(caseId, { mediatorId: newMediatorId, reason: "test" }, aaUser.id),
        /not currently available for mediator reassignment/
      );
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
