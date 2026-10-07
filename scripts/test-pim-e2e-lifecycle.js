/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Controlled end-to-end PostgreSQL lifecycle test (production-completion
 * sprint, 2026-10-07). Drives ONE synthetic case through the full
 * operational chain this sprint built/verified, using real
 * application/data-layer handlers (not hand-inserted shortcut rows)
 * wherever this sprint's own batches are responsible for the
 * transition: manual PIM-number entry -> mediation fee (both sides,
 * partial then full) -> mediator assignment -> first mediation ->
 * mediation session (effective, concludes) -> outcome (SETTLED) ->
 * Form IV document generation (no-storage) -> approval/closure.
 *
 * Also exercises the two major alternative branches this sprint owns:
 * a FAILED outcome with Form V, and a full NON_STARTER path with Form
 * III, authority decision, and closure.
 *
 * CRITICAL: uses a disposable, obviously-not-a-real-calendar-year test
 * year (>= 800000, same convention as the other numbering tests) for
 * PIM-number assignment - the real 2026 sequence (last_number=118) and
 * every real PIM number are never read or written by this script.
 *
 * Usage: node scripts/test-pim-e2e-lifecycle.js
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-e2e-lifecycle-manifest.json");
const TEST_PREFIX = "TEST-E2E-";
const MEDIATOR_PREFIX = "TEST-E2E-MEDIATOR-";
const TEST_YEAR = 900001 + (Date.now() % 50000);

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
      await del("pim_documents", "case_id", caseIds);
      await del("mediation_sessions", "case_id", caseIds);
      const assignmentIds = (await tx`SELECT id FROM pim_mediator_assignments WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id);
      if (assignmentIds.length > 0) {
        await tx`UPDATE pim_mediator_assignments SET replacement_for_assignment_id = NULL WHERE replacement_for_assignment_id IN ${tx(assignmentIds)}`;
      }
      await del("pim_mediator_assignments", "case_id", caseIds);
      await del("pim_notices", "case_id", caseIds);
      await del("pim_responses", "case_id", caseIds);
      await del("pim_number_corrections", "case_id", caseIds);
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
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { assignPimNumberManualPg } = require("../lib/pim-data/pim-numbering");
  const { recordFeePaymentPg } = require("../lib/pim-data/fee");
  const { createMediatorPg } = require("../lib/pim-data/mediator-registry");
  const { assignMediatorPg } = require("../lib/pim-data/mediator-assignment");
  const { fixFirstMediationDatePg, recordMediationSessionPg } = require("../lib/pim-data/mediation");
  const { recordOutcomePg, approveOutcomePg } = require("../lib/pim-data/outcome");
  const { generateOutcomeDocumentPg } = require("../lib/pim-data/outcome-documents");
  const { recordNonStarterPg, completeNonStarterForm3Pg, recordNonStarterAuthorityDecisionPg } = require("../lib/pim-data/nonstarter");
  const { generateForm3DocumentPg } = require("../lib/pim-data/form3-documents");

  const sql = getSql();
  const tracker = createTracker();
  await sql`SELECT 1`;
  await recoverStaleFixtures(sql, tracker);

  const [aaUser] = await sql`SELECT id FROM users WHERE role_code = 'aa' AND active = true LIMIT 1`;
  assert.ok(aaUser, "expected a synced 'aa' user");

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

  async function newCase(tag) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `E2E Applicant ${tag}` }], oppositeParties: [{ name: `E2E Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      claimAmount: 500000,
    }, aaUser.id);
    tracker.addCase(caseId);
    return caseId;
  }

  let settledCaseId;

  try {
    await test("1", "GOLDEN PATH: intake -> manual PIM number (disposable test year) -> fee (applicant then OP) -> mediator assignment -> first mediation -> effective session concludes -> SETTLED outcome -> Form IV generated -> approved/closed", async () => {
      const caseId = await newCase("golden");

      // -- Scrutiny / PIM number assignment --
      const [scrutinyPendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'PIM_NUMBER_PENDING'`;
      await sql`UPDATE pim_cases SET current_status_id = ${scrutinyPendingStatus.id} WHERE id = ${caseId}`;

      const numberResult = await assignPimNumberManualPg(caseId, 1, TEST_YEAR, aaUser.id);
      assert.strictEqual(numberResult.requiresConfirmation, false);
      assert.strictEqual(numberResult.pimNumber, `PIM/1/${TEST_YEAR}`);
      assert.strictEqual(numberResult.currentStatusCode, "FORM2_PENDING");

      // -- Fast-forward to FEE_PENDING (Form II/service/response are
      // pre-existing, already-migrated batches outside this sprint's
      // scope - jump the status directly, matching how this sprint's
      // other tests already treat that boundary). --
      const [feePendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'FEE_PENDING'`;
      await sql`UPDATE pim_cases SET current_status_id = ${feePendingStatus.id} WHERE id = ${caseId}`;

      // -- Mediation fee: applicant partial, then OP full, then
      // applicant completes - exactly the FEE_PENDING invariants this
      // sprint's fee batch exists to enforce. --
      let feeResult = await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 5000, ddNumber: "DD-E2E-1", ddDate: "2026-02-01", bankName: "Bank E2E" }, aaUser.id);
      assert.strictEqual(feeResult.statusCode, "FEE_PENDING");
      feeResult = await recordFeePaymentPg(caseId, { payingSide: "OP_SIDE", amount: 7500, ddNumber: "DD-E2E-2", ddDate: "2026-02-02", bankName: "Bank E2E" }, aaUser.id);
      assert.strictEqual(feeResult.statusCode, "FEE_PENDING", "must remain pending until BOTH sides' full share is in");
      feeResult = await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 2500, ddNumber: "DD-E2E-3", ddDate: "2026-02-03", bankName: "Bank E2E" }, aaUser.id);
      assert.strictEqual(feeResult.statusCode, "MEDIATOR_ASSIGNMENT_PENDING", "both sides now fully paid (7500 each)");

      // -- Mediator assignment --
      const mediatorId = await fixtureMediator("golden");
      const assignResult = await assignMediatorPg(caseId, { mediatorId }, aaUser.id);
      assert.strictEqual(assignResult.statusCode, "MEDIATOR_ASSIGNED");

      // -- First mediation date --
      const first = await fixFirstMediationDatePg(caseId, { scheduledDate: "2026-03-01" }, aaUser.id);
      assert.strictEqual(first.statusCode, "MEDIATION_PENDING");

      // -- Effective session, concludes mediation (no next date) --
      const session = await recordMediationSessionPg(first.sessionId, {
        actualDate: "2026-03-01", applicantPresent: true, oppositePartyPresent: true, actualStartTime: "10:00", actualEndTime: "11:30",
      }, aaUser.id);
      assert.strictEqual(session.statusCode, "OUTCOME_FORM_PENDING");

      // -- Outcome: SETTLED --
      const outcome = await recordOutcomePg(caseId, { outcomeType: "SETTLED", outcomeDate: "2026-03-01", settlementTerms: "E2E golden-path settlement." }, aaUser.id);
      assert.strictEqual(outcome.statusCode, "OUTCOME_FORM_PENDING");

      // -- Form IV document (no-storage) --
      const doc = await generateOutcomeDocumentPg(caseId, {}, aaUser.id);
      assert.strictEqual(doc.document.document_type, "FORM_4");
      assert.strictEqual(doc.document.file_path, null);
      assert.ok(doc.document.render_data);

      // -- Approval / closure --
      const approved = await approveOutcomePg(caseId, { remarks: "E2E golden path." }, aaUser.id);
      assert.strictEqual(approved.finalStatusCode, "CLOSED_SETTLED");

      const [finalRow] = await sql`SELECT current_status_id, closed_at, pim_number, running_number, pim_year FROM pim_cases WHERE id = ${caseId}`;
      const [closedStatus] = await sql`SELECT id FROM status_master WHERE code = 'CLOSED_SETTLED'`;
      assert.strictEqual(finalRow.current_status_id, closedStatus.id);
      assert.ok(finalRow.closed_at);
      assert.strictEqual(finalRow.pim_number, `PIM/1/${TEST_YEAR}`);
      assert.strictEqual(finalRow.running_number, 1);
      assert.strictEqual(finalRow.pim_year, TEST_YEAR);

      settledCaseId = caseId;
    });

    await test("2", "ALTERNATIVE BRANCH: FAILED outcome with Form V, full lifecycle", async () => {
      const caseId = await newCase("failed-branch");
      const [feePendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'FEE_PENDING'`;
      await sql`UPDATE pim_cases SET current_status_id = ${feePendingStatus.id} WHERE id = ${caseId}`;
      await recordFeePaymentPg(caseId, { payingSide: "APPLICANT", amount: 7500, ddNumber: "DD-F-1", ddDate: "2026-02-01", bankName: "Bank F" }, aaUser.id);
      await recordFeePaymentPg(caseId, { payingSide: "OP_SIDE", amount: 7500, ddNumber: "DD-F-2", ddDate: "2026-02-02", bankName: "Bank F" }, aaUser.id);

      const mediatorId = await fixtureMediator("failed-branch");
      await assignMediatorPg(caseId, { mediatorId }, aaUser.id);
      const first = await fixFirstMediationDatePg(caseId, { scheduledDate: "2026-03-01" }, aaUser.id);
      await recordMediationSessionPg(first.sessionId, {
        actualDate: "2026-03-01", applicantPresent: true, oppositePartyPresent: true, actualStartTime: "09:00", actualEndTime: "09:30",
      }, aaUser.id);

      await recordOutcomePg(caseId, { outcomeType: "FAILED", outcomeDate: "2026-03-01", reasonText: "E2E branch: mediation failed." }, aaUser.id);
      const doc = await generateOutcomeDocumentPg(caseId, {}, aaUser.id);
      assert.strictEqual(doc.document.document_type, "FORM_5");
      const approved = await approveOutcomePg(caseId, {}, aaUser.id);
      assert.strictEqual(approved.finalStatusCode, "CLOSED_FAILED");
    });

    await test("3", "ALTERNATIVE BRANCH: full NON_STARTER lifecycle with Form III, authority decision, closure", async () => {
      const caseId = await newCase("nonstarter-branch");
      await sql`
        INSERT INTO pim_notices (case_id, notice_type, form_no, notice_date, appearance_date, appearance_time, status)
        VALUES (${caseId}, 'FORM_2_INITIAL', 'FORM-2', '2026-01-15', '2026-01-25', '10:30', 'DISPATCHED')
      `;
      await recordNonStarterPg({ caseId, reasonCode: "MEDIATION_FEE_NOT_SUBMITTED", outcomeDate: "2026-02-01", remarks: "E2E branch", userId: aaUser.id });
      const doc = await generateForm3DocumentPg(caseId, { ruleReference: "3(4)" }, aaUser.id);
      assert.strictEqual(doc.document.document_type, "FORM_3");

      const form3Result = await completeNonStarterForm3Pg(caseId, { documentId: doc.document.id }, aaUser.id);
      assert.strictEqual(form3Result.statusCode, "AUTHORITY_DECISION_PENDING", "MEDIATION_FEE_NOT_SUBMITTED requires authority decision");

      const authorityResult = await recordNonStarterAuthorityDecisionPg(caseId, { remarks: "E2E branch approved." }, aaUser.id);
      assert.strictEqual(authorityResult.statusCode, "CLOSED_NON_STARTER");

      const [finalRow] = await sql`SELECT closed_at FROM pim_cases WHERE id = ${caseId}`;
      assert.ok(finalRow.closed_at);
    });

    await test("4", "production invariant: the real 2026 sequence and PIM numbers 109/119 were never touched by this E2E run", async () => {
      const [seqRow] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = 2026`;
      assert.strictEqual(seqRow.last_number, 118, "2026 sequence must remain exactly 118");
      const protectedNumbers = await sql`SELECT id FROM pim_cases WHERE pim_number LIKE 'PIM/109/%' OR pim_number LIKE 'PIM/119/%'`;
      assert.strictEqual(protectedNumbers.length, 0, "no real production PIM number may exist as a side effect of this test");
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

  await test("RESIDUE", "no test fixture rows remain anywhere; test year was never near the real 2026 sequence", async () => {
    const remainingCases = await sql`SELECT COUNT(*)::int AS n FROM pim_cases WHERE id IN ${sql([...tracker.caseIds, 0])}`;
    assert.strictEqual(remainingCases[0].n, 0);
    const remainingMediators = await sql`SELECT COUNT(*)::int AS n FROM mediators WHERE id IN ${sql([...tracker.mediatorIds, 0])}`;
    assert.strictEqual(remainingMediators[0].n, 0);
    assert.ok(TEST_YEAR >= 800000, "sanity: the test year used must be disposable, never a real calendar year");
  });

  if (!failures.some((f) => f.includes("cleanup") || f.includes("RESIDUE"))) {
    fs.rmSync(MANIFEST_PATH, { force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed. Test year used: ${TEST_YEAR} (settledCaseId: ${settledCaseId})`);
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
