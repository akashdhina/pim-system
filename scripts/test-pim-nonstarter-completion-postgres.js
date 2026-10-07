/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Tests for the Non-Starter route-wiring fix (production-completion
 * sprint, 2026-10-07): completeNonStarterForm3Pg and
 * recordNonStarterAuthorityDecisionPg in lib/pim-data/nonstarter.js,
 * routed from app/api/pim/nonstarter/form3/[id]/route.js and
 * app/api/pim/nonstarter/authority/[id]/route.js - the two follow-on
 * steps the earlier Batch 5D migration left on SQLite.
 *
 * Covers both branches: a MANUAL reason (no authority decision, closes
 * directly) and an AUTO-TRIGGERED reason requiring authority decision
 * (BOTH_PARTIES_NOT_WILLING is manual; OP_REFUSED_MEDIATION is
 * auto-triggered and requires authority decision per seed data).
 *
 * Usage:
 *   node scripts/test-pim-nonstarter-completion-postgres.js
 *   node scripts/test-pim-nonstarter-completion-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-nonstarter-completion-manifest.json");
const TEST_PREFIX = "TEST-NSCOMP-";

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
    addCase(id) { this.caseIds.add(id); this.persist(); },
    persist() { fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ caseIds: [...this.caseIds] }, null, 2)); },
  };
}

async function cleanupCasesByIds(sql, caseIds) {
  if (caseIds.length === 0) return;
  const existing = await sql`SELECT id, received_number FROM pim_cases WHERE id IN ${sql(caseIds)}`;
  for (const row of existing) {
    if (!String(row.received_number || "").startsWith(TEST_PREFIX)) {
      throw new Error(`Refusing to delete case ${row.id}: not a test fixture (received_number=${row.received_number}).`);
    }
  }
  await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '15s'`;
    const partyIds = (await tx`SELECT DISTINCT party_id FROM pim_case_parties WHERE case_id IN ${tx(caseIds)}`).map((r) => r.party_id);
    const del = async (table, column, ids) => {
      if (ids.length > 0) await tx`DELETE FROM ${tx(table)} WHERE ${tx(column)} IN ${tx(ids)}`;
    };
    await del("pim_outcomes", "case_id", caseIds);
    await del("pim_documents", "case_id", caseIds);
    await del("pim_task_history", "task_id", (await tx`SELECT id FROM pim_tasks WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id));
    await del("pim_tasks", "case_id", caseIds);
    await del("pim_docket", "case_id", caseIds);
    await del("pim_status_history", "case_id", caseIds);
    await del("pim_responses", "case_id", caseIds);
    await del("pim_service_attempts", "notice_id", (await tx`SELECT id FROM pim_notices WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id));
    await del("pim_notices", "case_id", caseIds);
    await del("pim_fees", "case_id", caseIds);
    await del("pim_case_advocates", "case_id", caseIds);
    await del("pim_case_parties", "case_id", caseIds);
    await del("pim_addresses", "party_id", partyIds);
    await del("pim_parties", "id", partyIds);
    await del("pim_cases", "id", caseIds);
  });
}

async function recoverStaleFixtures(sql, tracker) {
  if (!fs.existsSync(MANIFEST_PATH)) return;
  const stale = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  console.log(`cleanup: removing stale fixtures: cases=${JSON.stringify(stale.caseIds)}`);
  await cleanupCasesByIds(sql, stale.caseIds || []);
  for (const id of stale.caseIds || []) tracker.caseIds.add(id);
  fs.rmSync(MANIFEST_PATH, { force: true });
}

async function insertFakeForm3Document(sql, caseId, userId) {
  const [doc] = await sql`
    INSERT INTO pim_documents (case_id, document_type, document_title, document_date, file_path, generated_by_system, is_current, created_by)
    VALUES (${caseId}, 'FORM_3', 'Form-3 Non-Starter Report', CURRENT_DATE, 'test://fixture/form3.pdf', false, true, ${userId})
    RETURNING id
  `;
  return doc.id;
}

async function main() {
  const { getSql } = require("../lib/pim-postgres");
  const { recordNonStarterPg, completeNonStarterForm3Pg, recordNonStarterAuthorityDecisionPg } = require("../lib/pim-data/nonstarter");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");

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
  const [authorityPendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'AUTHORITY_DECISION_PENDING'`;
  const [closedNonStarterStatus] = await sql`SELECT id FROM status_master WHERE code = 'CLOSED_NON_STARTER'`;

  async function fixtureCase(tag) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `NS Applicant ${tag}` }], oppositeParties: [{ name: `NS Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      claimAmount: 500000,
    }, aaUser.id);
    tracker.addCase(caseId);
    return caseId;
  }

  // BOTH_PARTIES_NOT_WILLING is a MANUAL reason, requires_authority_decision = false (per seed data).
  async function setupManualNonStarter(tag) {
    const caseId = await fixtureCase(tag);
    await recordNonStarterPg({ caseId, reasonCode: "BOTH_PARTIES_NOT_WILLING", outcomeDate: "2026-02-01", remarks: "fixture", userId: aaUser.id });
    return caseId;
  }

  // MEDIATION_FEE_NOT_SUBMITTED is the only reason with
  // requires_authority_decision = true per live seed data (verified
  // directly against the pim-system project before writing this test -
  // OP_REFUSED_MEDIATION, FINAL_NOTICE_UNACKNOWLEDGED, and
  // OP_FAILED_TO_APPEAR_AFTER_TIME are all false). It is also a MANUAL
  // reason, so no auto-triggered handoff-task/response setup is needed.
  async function setupAuthorityNonStarter(tag) {
    const caseId = await fixtureCase(tag);
    await recordNonStarterPg({ caseId, reasonCode: "MEDIATION_FEE_NOT_SUBMITTED", outcomeDate: "2026-02-01", remarks: "fixture", userId: aaUser.id });
    return caseId;
  }

  try {
    await test("A", "manual reason (no authority decision): Form-3 completion closes the case directly as CLOSED_NON_STARTER", async () => {
      const caseId = await setupManualNonStarter("A");
      const documentId = await insertFakeForm3Document(sql, caseId, aaUser.id);

      const result = await completeNonStarterForm3Pg(caseId, { documentId, remarks: "done" }, aaUser.id);
      assert.strictEqual(result.statusCode, "CLOSED_NON_STARTER");
      assert.strictEqual(result.authorityTaskId, null);

      const [caseRow] = await sql`SELECT current_status_id, closed_at FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, closedNonStarterStatus.id);
      assert.ok(caseRow.closed_at, "closed_at must be set");

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'NONSTARTER_FORM3' AND status = 'PENDING'`;
      assert.strictEqual(n, 0, "no pending Form-3 task must remain");
    });

    await test("B", "Form-3 completion without a current document is rejected", async () => {
      const caseId = await setupManualNonStarter("B");
      await assert.rejects(
        () => completeNonStarterForm3Pg(caseId, {}, aaUser.id),
        /current Form-3 document must be generated/
      );
      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, outcomeFormPendingStatus.id, "must remain unchanged");
    });

    await test("C", "auto-triggered reason requiring authority decision: Form-3 completion moves to AUTHORITY_DECISION_PENDING, not closed yet", async () => {
      const caseId = await setupAuthorityNonStarter("C");
      const documentId = await insertFakeForm3Document(sql, caseId, aaUser.id);

      const result = await completeNonStarterForm3Pg(caseId, { documentId }, aaUser.id);
      assert.strictEqual(result.statusCode, "AUTHORITY_DECISION_PENDING");
      assert.ok(result.authorityTaskId, "an authority task must be created");

      const [caseRow] = await sql`SELECT current_status_id, closed_at FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, authorityPendingStatus.id);
      assert.strictEqual(caseRow.closed_at, null, "must not be closed yet");
      return { caseId, result };
    });

    let ctxD;
    await test("D", "authority decision then closes the case as CLOSED_NON_STARTER, exactly once, task completed", async () => {
      const caseId = await setupAuthorityNonStarter("D");
      const documentId = await insertFakeForm3Document(sql, caseId, aaUser.id);
      await completeNonStarterForm3Pg(caseId, { documentId }, aaUser.id);

      const result = await recordNonStarterAuthorityDecisionPg(caseId, { remarks: "Approved by committee" }, aaUser.id);
      assert.strictEqual(result.statusCode, "CLOSED_NON_STARTER");
      ctxD = { caseId };

      const [caseRow] = await sql`SELECT current_status_id, closed_at FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, closedNonStarterStatus.id);
      assert.ok(caseRow.closed_at);

      const [{ n: pendingAuthority }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'NONSTARTER_AUTHORITY' AND status = 'PENDING'`;
      assert.strictEqual(pendingAuthority, 0);
    });

    await test("E", "a second authority decision on the same case is rejected (already recorded)", async () => {
      assert.ok(ctxD, "prerequisite D did not complete");
      await assert.rejects(
        () => recordNonStarterAuthorityDecisionPg(ctxD.caseId, { remarks: "second attempt" }, aaUser.id),
        /not pending authority decision/
      );
    });

    await test("F", "authority decision before Form-3 is attached is rejected", async () => {
      const caseId = await setupAuthorityNonStarter("F");
      await assert.rejects(
        () => recordNonStarterAuthorityDecisionPg(caseId, {}, aaUser.id),
        /not pending authority decision/
      );
    });
  } finally {
    console.log(`\ncleanup: removing exactly these fixture case ids: ${JSON.stringify([...tracker.caseIds])}`);
    try {
      await cleanupCasesByIds(sql, [...tracker.caseIds]);
    } catch (error) {
      console.error(`CLEANUP FAILED: ${error.message}`);
      failures.push("cleanup of case fixtures");
    }
  }

  await test("RESIDUE", "no test fixture rows remain", async () => {
    const remaining = await sql`SELECT COUNT(*)::int AS n FROM pim_cases WHERE id IN ${sql([...tracker.caseIds, 0])}`;
    assert.strictEqual(remaining[0].n, 0);
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
