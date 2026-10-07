/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Tests for the outcome/closure migration (production-completion sprint,
 * 2026-10-07): lib/pim-data/outcome.js, routed from
 * app/api/pim/outcome/[id]/route.js and
 * app/api/pim/outcome/approve/[id]/route.js. See
 * docs/phase6-outcome-closure-migration.md.
 *
 * Isolated fixtures only, driven through intake -> mediator assignment ->
 * first mediation -> one completed session -> OUTCOME_FORM_PENDING using
 * the already-tested lib/pim-data/mediator-assignment.js and
 * lib/pim-data/mediation.js modules, then exercises SETTLED/FAILED/
 * WITHDRAWN recording and closure.
 *
 * Usage:
 *   node scripts/test-pim-outcome-postgres.js
 *   node scripts/test-pim-outcome-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-outcome-manifest.json");
const TEST_PREFIX = "TEST-OUT-";
const MEDIATOR_PREFIX = "TEST-OUT-MEDIATOR-";

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
      const assignmentIds = (await tx`SELECT id FROM pim_mediator_assignments WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id);
      if (assignmentIds.length > 0) {
        await tx`UPDATE pim_mediator_assignments SET replacement_for_assignment_id = NULL WHERE replacement_for_assignment_id IN ${tx(assignmentIds)}`;
      }
      await del("pim_mediator_assignments", "case_id", caseIds);
      await del("pim_documents", "case_id", caseIds);
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
  const { recordOutcomePg, approveOutcomePg, getOutcomeDataPg } = require("../lib/pim-data/outcome");
  const { assignMediatorPg } = require("../lib/pim-data/mediator-assignment");
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

  const [outcomeFormPendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'OUTCOME_FORM_PENDING'`;
  const [closedSettledStatus] = await sql`SELECT id FROM status_master WHERE code = 'CLOSED_SETTLED'`;
  const [closedFailedStatus] = await sql`SELECT id FROM status_master WHERE code = 'CLOSED_FAILED'`;
  const [withdrawnStatus] = await sql`SELECT id FROM status_master WHERE code = 'WITHDRAWN'`;

  async function fixtureMediator(tag) {
    const mediator = await createMediatorPg({
      name: `${MEDIATOR_PREFIX}${tag}-${Date.now()}`, category: "ADVOCATE MEDIATOR",
      enrollment_no: null, contact_phone: null, email: null, empanelment_order_no: null,
      empanelment_date: "2026-01-01", panel_valid_until: null, active: true,
      rotation_order: null, conflict_declaration_date: null, remarks: null,
    }, aaUser.id);
    tracker.addMediator(mediator.id);
    return mediator.id;
  }

  // Drives a fresh case all the way to OUTCOME_FORM_PENDING with exactly
  // one completed, effective session - the real precondition for
  // recordOutcomePg, using the already-tested mediator-assignment and
  // mediation modules rather than hand-crafting status/session rows.
  async function fixtureCaseAtOutcomePending(tag) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `Outcome Applicant ${tag}` }], oppositeParties: [{ name: `Outcome Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      claimAmount: 500000,
    }, aaUser.id);
    tracker.addCase(caseId);

    const [pendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'MEDIATOR_ASSIGNMENT_PENDING'`;
    await sql`UPDATE pim_cases SET current_status_id = ${pendingStatus.id} WHERE id = ${caseId}`;

    const mediatorId = await fixtureMediator(tag);
    await assignMediatorPg(caseId, { mediatorId }, aaUser.id);
    const first = await fixFirstMediationDatePg(caseId, { scheduledDate: "2026-03-01" }, aaUser.id);
    await recordMediationSessionPg(first.sessionId, {
      actualDate: "2026-03-01", applicantPresent: true, oppositePartyPresent: true, actualStartTime: "10:00", actualEndTime: "11:00",
    }, aaUser.id);

    return caseId;
  }

  async function insertFixtureDocument(caseId, documentType) {
    const [doc] = await sql`
      INSERT INTO pim_documents (case_id, document_type, document_title, document_date, file_path, generated_by_system, is_current, created_by)
      VALUES (${caseId}, ${documentType}, ${documentType}, CURRENT_DATE, 'test://fixture/doc.pdf', false, true, ${aaUser.id})
      RETURNING id
    `;
    return doc.id;
  }

  try {
    await test("A", "SETTLED: outcome recorded, stays OUTCOME_FORM_PENDING; approval without Form IV is blocked; with Form IV, closes CLOSED_SETTLED with task completed", async () => {
      const caseId = await fixtureCaseAtOutcomePending("A");

      const recorded = await recordOutcomePg(caseId, { outcomeType: "SETTLED", outcomeDate: "2026-03-05", settlementTerms: "Parties agreed to settle for ₹2,00,000." }, aaUser.id);
      assert.strictEqual(recorded.statusCode, "OUTCOME_FORM_PENDING");
      assert.strictEqual(recorded.outcomeType, "SETTLED");

      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, outcomeFormPendingStatus.id, "must stay at OUTCOME_FORM_PENDING, not jump to closed");

      await assert.rejects(() => approveOutcomePg(caseId, {}, aaUser.id), /Form IV \(Settlement\) must be generated/);

      await insertFixtureDocument(caseId, "FORM_4");
      const approved = await approveOutcomePg(caseId, { remarks: "Approved by registrar." }, aaUser.id);
      assert.strictEqual(approved.finalStatusCode, "CLOSED_SETTLED");

      const [closedRow] = await sql`SELECT current_status_id, closed_at FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(closedRow.current_status_id, closedSettledStatus.id);
      assert.ok(closedRow.closed_at);

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'OUTCOME_FORM' AND status = 'PENDING'`;
      assert.strictEqual(n, 0, "no pending OUTCOME_FORM task must remain");
    });

    await test("B", "FAILED: requires reasonText, requires Form V before closing CLOSED_FAILED", async () => {
      const caseId = await fixtureCaseAtOutcomePending("B");
      await assert.rejects(() => recordOutcomePg(caseId, { outcomeType: "FAILED", outcomeDate: "2026-03-05" }, aaUser.id), /Failure reason/);

      const recorded = await recordOutcomePg(caseId, { outcomeType: "FAILED", outcomeDate: "2026-03-05", reasonText: "Opposite party withdrew cooperation." }, aaUser.id);
      assert.strictEqual(recorded.outcomeType, "FAILED");

      await assert.rejects(() => approveOutcomePg(caseId, {}, aaUser.id), /Form V \(Failure Report\) must be generated/);

      await insertFixtureDocument(caseId, "FORM_5");
      const approved = await approveOutcomePg(caseId, {}, aaUser.id);
      assert.strictEqual(approved.finalStatusCode, "CLOSED_FAILED");

      const [closedRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(closedRow.current_status_id, closedFailedStatus.id);
    });

    await test("C", "WITHDRAWN: requires reasonText, closes WITHDRAWN with no document requirement", async () => {
      const caseId = await fixtureCaseAtOutcomePending("C");
      await assert.rejects(() => recordOutcomePg(caseId, { outcomeType: "WITHDRAWN", outcomeDate: "2026-03-05" }, aaUser.id), /Withdrawal party\/source/);

      await recordOutcomePg(caseId, { outcomeType: "WITHDRAWN", outcomeDate: "2026-03-05", reasonText: "Applicant withdrew the claim." }, aaUser.id);
      const approved = await approveOutcomePg(caseId, {}, aaUser.id);
      assert.strictEqual(approved.finalStatusCode, "WITHDRAWN");

      const [closedRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(closedRow.current_status_id, withdrawnStatus.id);
    });

    await test("D", "NON_STARTER is rejected from this route entirely", async () => {
      const caseId = await fixtureCaseAtOutcomePending("D");
      await assert.rejects(() => recordOutcomePg(caseId, { outcomeType: "NON_STARTER", outcomeDate: "2026-03-05" }, aaUser.id), /Invalid outcome type/);
    });

    await test("E", "a second outcome on the same case is rejected", async () => {
      const caseId = await fixtureCaseAtOutcomePending("E");
      await recordOutcomePg(caseId, { outcomeType: "WITHDRAWN", outcomeDate: "2026-03-05", reasonText: "duplicate test" }, aaUser.id);
      await assert.rejects(() => recordOutcomePg(caseId, { outcomeType: "FAILED", outcomeDate: "2026-03-05", reasonText: "x" }, aaUser.id), /already been recorded/);
    });

    await test("F", "outcome date before the last completed session date is rejected", async () => {
      const caseId = await fixtureCaseAtOutcomePending("F");
      await assert.rejects(
        () => recordOutcomePg(caseId, { outcomeType: "WITHDRAWN", outcomeDate: "2026-02-01", reasonText: "too early" }, aaUser.id),
        /cannot be before the last recorded actual mediation date/
      );
    });

    await test("G", "approving an already-closed case is a conflict (409-style), not a thrown error", async () => {
      const caseId = await fixtureCaseAtOutcomePending("G");
      await recordOutcomePg(caseId, { outcomeType: "WITHDRAWN", outcomeDate: "2026-03-05", reasonText: "x" }, aaUser.id);
      await approveOutcomePg(caseId, {}, aaUser.id);

      const result = await approveOutcomePg(caseId, {}, aaUser.id);
      assert.strictEqual(result.conflict, true);
      assert.match(result.message, /not currently pending outcome approval/);
    });

    await test("H", "getOutcomeDataPg returns the recorded outcome, session summary, and phase7Signal", async () => {
      const caseId = await fixtureCaseAtOutcomePending("H");
      const data = await getOutcomeDataPg(caseId);
      assert.strictEqual(data.sessionSummary.total_sittings, 1);
      assert.strictEqual(data.sessionSummary.effective_sittings, 1);
      assert.strictEqual(data.outcome, null);

      await recordOutcomePg(caseId, { outcomeType: "FAILED", outcomeDate: "2026-03-05", reasonText: "x" }, aaUser.id);
      const afterData = await getOutcomeDataPg(caseId);
      assert.strictEqual(afterData.outcome.outcome_type, "FAILED");
    });

    await test("I", "rollback is atomic: a failed approval (missing document) leaves the outcome row and case status completely unchanged", async () => {
      const caseId = await fixtureCaseAtOutcomePending("I");
      await recordOutcomePg(caseId, { outcomeType: "SETTLED", outcomeDate: "2026-03-05", settlementTerms: "terms" }, aaUser.id);

      const [before] = await sql`SELECT verified_by, approved_by FROM pim_outcomes WHERE case_id = ${caseId}`;
      await assert.rejects(() => approveOutcomePg(caseId, {}, aaUser.id), /Form IV/);

      const [after] = await sql`SELECT verified_by, approved_by FROM pim_outcomes WHERE case_id = ${caseId}`;
      assert.deepStrictEqual(after, before, "the outcome row must be completely unchanged after a rejected approval");

      const [caseRow] = await sql`SELECT current_status_id, closed_at FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, outcomeFormPendingStatus.id);
      assert.strictEqual(caseRow.closed_at, null);
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
