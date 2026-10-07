/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Tests for the mediation-fee migration (production-completion sprint,
 * 2026-10-07): lib/pim-data/fee.js, routed from app/api/pim/fee/[id]/route.js.
 * See docs/phase6-mediation-fee-migration.md.
 *
 * Isolated fixtures only. Never touches PIM 109/2026 or any real case.
 *
 * Usage:
 *   node scripts/test-pim-fee-postgres.js
 *   node scripts/test-pim-fee-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-fee-manifest.json");
const TEST_PREFIX = "TEST-FEE-";

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
    await del("pim_fee_payments", "case_id", caseIds);
    await del("pim_task_history", "task_id", (await tx`SELECT id FROM pim_tasks WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id));
    await del("pim_tasks", "case_id", caseIds);
    await del("pim_docket", "case_id", caseIds);
    await del("pim_status_history", "case_id", caseIds);
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

async function main() {
  const { getSql } = require("../lib/pim-postgres");
  const { recordFeePaymentPg, getFeeDataPg } = require("../lib/pim-data/fee");
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

  const [feePendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'FEE_PENDING'`;
  const [mediatorPendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'MEDIATOR_ASSIGNMENT_PENDING'`;

  // Claim amount 500000 -> Schedule II slab -> totalFee 15000, share 7500 each.
  async function fixtureCase(tag, { claimAmount = 500000 } = {}) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `Fee Applicant ${tag}` }], oppositeParties: [{ name: `Fee Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      claimAmount,
    }, aaUser.id);
    tracker.addCase(caseId);
    await sql`UPDATE pim_cases SET current_status_id = ${feePendingStatus.id}, claim_amount = ${claimAmount} WHERE id = ${caseId}`;
    return caseId;
  }

  try {
    await test("A", "applicant unpaid, OP side paid in full: FEE_PENDING, OP payment preserved, applicant outstanding", async () => {
      const caseId = await fixtureCase("A");
      const result = await recordFeePaymentPg(caseId, { payingSide: "OP_SIDE", amount: 7500, ddNumber: "DD-OP-1", ddDate: "2026-02-01", bankName: "Bank A" }, aaUser.id);
      assert.strictEqual(result.statusCode, "FEE_PENDING");
      assert.strictEqual(result.summary.opSidePaid, 7500);
      assert.strictEqual(result.summary.applicantPaid, 0);
      assert.strictEqual(result.summary.applicantOutstanding, 7500);
      assert.strictEqual(result.summary.fullyPaid, false);

      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, feePendingStatus.id, "must remain FEE_PENDING");
    });

    await test("B", "applicant paid in full, OP side unpaid: FEE_PENDING, applicant payment preserved, OP outstanding", async () => {
      const caseId = await fixtureCase("B");
      const result = await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 7500, ddNumber: "DD-APP-1", ddDate: "2026-02-01", bankName: "Bank B" }, aaUser.id);
      assert.strictEqual(result.statusCode, "FEE_PENDING");
      assert.strictEqual(result.summary.applicantPaid, 7500);
      assert.strictEqual(result.summary.opSideOutstanding, 7500);
    });

    await test("C", "partial payment on one side: FEE_PENDING", async () => {
      const caseId = await fixtureCase("C");
      const result = await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 3000, ddNumber: "DD-C-1", ddDate: "2026-02-01", bankName: "Bank C" }, aaUser.id);
      assert.strictEqual(result.statusCode, "FEE_PENDING");
      assert.strictEqual(result.summary.applicantOutstanding, 4500);
    });

    await test("D", "partial payment on the other side after the first is already full: still FEE_PENDING", async () => {
      const caseId = await fixtureCase("D");
      await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 7500, ddNumber: "DD-D-1", ddDate: "2026-02-01", bankName: "Bank D" }, aaUser.id);
      const result = await recordFeePaymentPg(caseId, { payingSide: "OP_SIDE", amount: 2000, ddNumber: "DD-D-2", ddDate: "2026-02-02", bankName: "Bank D" }, aaUser.id);
      assert.strictEqual(result.statusCode, "FEE_PENDING");
      assert.strictEqual(result.summary.opSideOutstanding, 5500);
    });

    await test("E", "both sides fully paid: exactly one transition to MEDIATOR_ASSIGNMENT_PENDING, exactly one mediator-assignment task", async () => {
      const caseId = await fixtureCase("E");
      await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 7500, ddNumber: "DD-E-1", ddDate: "2026-02-01", bankName: "Bank E" }, aaUser.id);
      const result = await recordFeePaymentPg(caseId, { payingSide: "OP_SIDE", amount: 7500, ddNumber: "DD-E-2", ddDate: "2026-02-02", bankName: "Bank E" }, aaUser.id);

      assert.strictEqual(result.statusCode, "MEDIATOR_ASSIGNMENT_PENDING");
      assert.strictEqual(result.summary.fullyPaid, true);

      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.current_status_id, mediatorPendingStatus.id);

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'MEDIATOR_ASSIGNMENT'`;
      assert.strictEqual(n, 1, "exactly one mediator-assignment task");
    });

    await test("F", "payment attempted once both sides already fully paid is rejected (case no longer at FEE_PENDING)", async () => {
      const caseId = await fixtureCase("F");
      await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 7500, ddNumber: "DD-F-1", ddDate: "2026-02-01", bankName: "Bank F" }, aaUser.id);
      await recordFeePaymentPg(caseId, { payingSide: "OP_SIDE", amount: 7500, ddNumber: "DD-F-2", ddDate: "2026-02-02", bankName: "Bank F" }, aaUser.id);

      await assert.rejects(
        () => recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 100, ddNumber: "DD-F-3", ddDate: "2026-02-03", bankName: "Bank F" }, aaUser.id),
        /not currently available for mediation fee collection/
      );
    });

    await test("G", "overpayment is reported, not silently ignored", async () => {
      const caseId = await fixtureCase("G");
      const result = await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 9000, ddNumber: "DD-G-1", ddDate: "2026-02-01", bankName: "Bank G" }, aaUser.id);
      assert.strictEqual(result.summary.applicantOverpaid, 1500);
      assert.strictEqual(result.summary.applicantOutstanding, 0);
    });

    await test("H", "concurrent final payments for the same case: no double transition, no duplicate task", async () => {
      const caseId = await fixtureCase("H");
      await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 7500, ddNumber: "DD-H-1", ddDate: "2026-02-01", bankName: "Bank H" }, aaUser.id);

      const settled = await Promise.allSettled([
        recordFeePaymentPg(caseId, { payingSide: "OP_SIDE", amount: 4000, ddNumber: "DD-H-2a", ddDate: "2026-02-02", bankName: "Bank H" }, aaUser.id),
        recordFeePaymentPg(caseId, { payingSide: "OP_SIDE", amount: 3500, ddNumber: "DD-H-2b", ddDate: "2026-02-02", bankName: "Bank H" }, aaUser.id),
      ]);
      assert.ok(settled.every((s) => s.status === "fulfilled"), "both concurrent payments must still be recorded (serialized, not rejected)");

      const [{ n: paymentCount }] = await sql`SELECT COUNT(*)::int AS n FROM pim_fee_payments WHERE case_id = ${caseId}`;
      assert.strictEqual(paymentCount, 3, "all three payments (1 applicant + 2 OP) must be recorded, none lost");

      const [{ n: taskCount }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'MEDIATOR_ASSIGNMENT'`;
      assert.strictEqual(taskCount, 1, "exactly one mediator-assignment task, even with two concurrent completing payments");

      const [{ n: transitionCount }] = await sql`
        SELECT COUNT(*)::int AS n FROM pim_status_history
        WHERE case_id = ${caseId} AND to_status_id = ${mediatorPendingStatus.id}`;
      assert.strictEqual(transitionCount, 1, "exactly one transition to MEDIATOR_ASSIGNMENT_PENDING");
    });

    await test("I", "payment rows are immutable: a later, smaller payment never reduces or overwrites an earlier one", async () => {
      const caseId = await fixtureCase("I");
      await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 5000, ddNumber: "DD-I-1", ddDate: "2026-02-01", bankName: "Bank I-1" }, aaUser.id);
      await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 1000, ddNumber: "DD-I-2", ddDate: "2026-02-05", bankName: "Bank I-2" }, aaUser.id);

      const rows = await sql`SELECT amount, dd_number, bank_name FROM pim_fee_payments WHERE case_id = ${caseId} ORDER BY id`;
      assert.strictEqual(rows.length, 2, "both payments must exist as separate rows");
      assert.strictEqual(Number(rows[0].amount), 5000);
      assert.strictEqual(rows[0].dd_number, "DD-I-1");
      assert.strictEqual(rows[0].bank_name, "Bank I-1", "the first payment's own DD/bank details must never be overwritten by the second");
      assert.strictEqual(Number(rows[1].amount), 1000);
    });

    await test("J", "getFeeDataPg returns the same derived summary and the full payment list", async () => {
      const caseId = await fixtureCase("J");
      await recordFeePaymentPg(caseId, { payingSide: "OP_SIDE", amount: 2000, ddNumber: "DD-J-1", ddDate: "2026-02-01", bankName: "Bank J" }, aaUser.id);

      const data = await getFeeDataPg(caseId);
      assert.strictEqual(data.summary.opSidePaid, 2000);
      assert.strictEqual(data.payments.length, 1);
      assert.strictEqual(data.payments[0].dd_number, "DD-J-1");
    });

    await test("K", "invalid inputs are rejected and never written", async () => {
      const caseId = await fixtureCase("K");
      await assert.rejects(() => recordFeePaymentPg(caseId, { payingSide: "BOTH", amount: 100 }, aaUser.id), /payingSide/);
      await assert.rejects(() => recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 0 }, aaUser.id), /positive number/);
      await assert.rejects(() => recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: -5 }, aaUser.id), /positive number/);
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_fee_payments WHERE case_id = ${caseId}`;
      assert.strictEqual(n, 0);
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

  await test("RESIDUE", "no test fixture rows remain in pim_fee_payments or pim_cases", async () => {
    const remainingCases = await sql`SELECT COUNT(*)::int AS n FROM pim_cases WHERE id IN ${sql([...tracker.caseIds, 0])}`;
    assert.strictEqual(remainingCases[0].n, 0);
    const remainingPayments = await sql`SELECT COUNT(*)::int AS n FROM pim_fee_payments WHERE case_id IN ${sql([...tracker.caseIds, 0])}`;
    assert.strictEqual(remainingPayments[0].n, 0);
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
