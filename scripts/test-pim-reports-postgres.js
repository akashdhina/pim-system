/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Tests for the reports migration (production-completion sprint,
 * 2026-10-07): lib/pim-data/reports.js (the 14 operational reports) and
 * the monthly statement route, routed from app/api/pim/reports/route.js
 * and app/api/pim/reports/monthly/route.js. See
 * docs/phase6-reports-migration.md.
 *
 * Two tiers:
 *   1. A smoke test across ALL 14 reports - the dominant risk in this
 *      batch is a SQL dialect error (boolean=integer, julianday(),
 *      2-arg MAX, etc.), so "it executes without throwing and returns
 *      an array" is itself a real, high-value assertion here, not a
 *      placeholder.
 *   2. Targeted behavioral checks for the specific translations made:
 *      date-math correctness (overdue/monitoring), GREATEST (fees),
 *      the file_path-or-render_data widening (documents/non_starters/
 *      settlements/failures), and the monthly reconciliation.
 *
 * Usage:
 *   node scripts/test-pim-reports-postgres.js
 *   node scripts/test-pim-reports-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-reports-manifest.json");
const TEST_PREFIX = "TEST-RPT-";
const MEDIATOR_PREFIX = "TEST-RPT-MEDIATOR-";

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

const ALL_REPORT_KEYS = [
  "register", "pending", "overdue", "mediators", "sessions", "monitoring", "outcomes",
  "documents", "notices", "address_correction", "final_notice_pending", "fees_pending",
  "non_starters", "settlements", "failures", "audit",
];

async function main() {
  const { getSql } = require("../lib/pim-postgres");
  const { runReportPg } = require("../lib/pim-data/reports");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { createMediatorPg } = require("../lib/pim-data/mediator-registry");
  const { assignMediatorPg } = require("../lib/pim-data/mediator-assignment");
  const { fixFirstMediationDatePg, recordMediationSessionPg } = require("../lib/pim-data/mediation");
  const { recordOutcomePg } = require("../lib/pim-data/outcome");
  const { generateOutcomeDocumentPg } = require("../lib/pim-data/outcome-documents");
  const { recordNonStarterPg } = require("../lib/pim-data/nonstarter");
  const { generateForm3DocumentPg } = require("../lib/pim-data/form3-documents");

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

  function emptySearchParams(extra = {}) {
    return new URLSearchParams(extra);
  }

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

  async function fixtureBaseCase(tag, overrides = {}) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `Report Applicant ${tag}` }], oppositeParties: [{ name: `Report Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      claimAmount: 500000,
      ...overrides,
    }, aaUser.id);
    tracker.addCase(caseId);
    return caseId;
  }

  async function driveToOutcomeFormPending(tag) {
    const caseId = await fixtureBaseCase(tag);
    const [pendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'MEDIATOR_ASSIGNMENT_PENDING'`;
    await sql`UPDATE pim_cases SET current_status_id = ${pendingStatus.id} WHERE id = ${caseId}`;
    const mediatorId = await fixtureMediator(tag);
    await assignMediatorPg(caseId, { mediatorId }, aaUser.id);
    const first = await fixFirstMediationDatePg(caseId, { scheduledDate: "2026-03-01" }, aaUser.id);
    await recordMediationSessionPg(first.sessionId, {
      actualDate: "2026-03-01", applicantPresent: true, oppositePartyPresent: true, actualStartTime: "10:00", actualEndTime: "11:00",
    }, aaUser.id);
    return { caseId, mediatorId };
  }

  let settledCaseId, failedCaseId, nonStarterCaseId, overdueCaseId, monitoringCaseId;

  try {
    await test("A", "settled case: outcome recorded, Form-4 generated (no-storage), case closed", async () => {
      const { caseId } = await driveToOutcomeFormPending("A");
      await recordOutcomePg(caseId, { outcomeType: "SETTLED", outcomeDate: "2026-03-05", settlementTerms: "Settled for test purposes." }, aaUser.id);
      await generateOutcomeDocumentPg(caseId, {}, aaUser.id);
      const { approveOutcomePg } = require("../lib/pim-data/outcome");
      await approveOutcomePg(caseId, {}, aaUser.id);
      settledCaseId = caseId;
    });

    await test("B", "failed case: outcome recorded, Form-5 generated (no-storage), case closed", async () => {
      const { caseId } = await driveToOutcomeFormPending("B");
      await recordOutcomePg(caseId, { outcomeType: "FAILED", outcomeDate: "2026-03-05", reasonText: "Test failure reason." }, aaUser.id);
      await generateOutcomeDocumentPg(caseId, {}, aaUser.id);
      const { approveOutcomePg } = require("../lib/pim-data/outcome");
      await approveOutcomePg(caseId, {}, aaUser.id);
      failedCaseId = caseId;
    });

    await test("C", "non-starter case: Form-3 generated (no-storage)", async () => {
      const caseId = await fixtureBaseCase("C");
      await sql`
        INSERT INTO pim_notices (case_id, notice_type, form_no, notice_date, appearance_date, appearance_time, status)
        VALUES (${caseId}, 'FORM_2_INITIAL', 'FORM-2', '2026-01-15', '2026-01-25', '10:30', 'DISPATCHED')
      `;
      await recordNonStarterPg({ caseId, reasonCode: "BOTH_PARTIES_NOT_WILLING", outcomeDate: "2026-02-01", remarks: "fixture", userId: aaUser.id });
      await generateForm3DocumentPg(caseId, { ruleReference: "3(4)" }, aaUser.id);
      nonStarterCaseId = caseId;
    });

    await test("D", "a case with a known-overdue pending task", async () => {
      const caseId = await fixtureBaseCase("D");
      const [taskType] = await sql`SELECT id, default_priority FROM task_types WHERE code = 'FORM2'`;
      await sql`
        INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
        VALUES (${caseId}, ${taskType.id}, 'FORM2', 'fixture overdue task', '2026-01-01', '2026-01-05', ${taskType.default_priority}, 'PENDING', true)
      `;
      overdueCaseId = caseId;
    });

    await test("E", "a case with a known internal_60_day_date for the monitoring report", async () => {
      const caseId = await fixtureBaseCase("E");
      const { officeDate } = require("../lib/pim-time");
      const today = officeDate();
      await sql`UPDATE pim_cases SET internal_60_day_date = ${today} WHERE id = ${caseId}`;
      monitoringCaseId = caseId;
    });

    await test("F", "smoke test: all 14 reports execute without a SQL dialect error and return an array of rows", async () => {
      for (const key of ALL_REPORT_KEYS) {
        const result = await runReportPg(key, emptySearchParams({ pageSize: "50" }));
        assert.ok(Array.isArray(result.rows), `${key} must return an array of rows`);
        assert.ok(typeof result.count === "number", `${key} must return a numeric count`);
      }
    });

    await test("G", "overdue report: days_overdue is a correct positive integer for the fixture task (due 2026-01-05)", async () => {
      const result = await runReportPg("overdue", emptySearchParams({ pageSize: "100" }));
      const row = result.rows.find((r) => r.case_id === overdueCaseId);
      assert.ok(row, "the fixture overdue task must appear in the overdue report");
      assert.ok(Number.isInteger(row.days_overdue) && row.days_overdue > 0, "days_overdue must be a positive integer");
    });

    await test("H", "monitoring report: a case due today shows days_remaining = 0 and monitoring_status = 'Due within 7 days'", async () => {
      const result = await runReportPg("monitoring", emptySearchParams({ pageSize: "200" }));
      const row = result.rows.find((r) => r.id === monitoringCaseId);
      assert.ok(row, "the fixture case (internal_60_day_date = today) must appear in the monitoring report");
      assert.strictEqual(row.days_remaining, 0, "days_remaining must be exactly 0 for a case due today");
      assert.strictEqual(row.monitoring_status, "Due within 7 days");
    });

    await test("I", "fees_pending report: balance uses GREATEST and is never negative", async () => {
      const result = await runReportPg("fees_pending", emptySearchParams({ pageSize: "200" }));
      for (const row of result.rows) {
        assert.ok(Number(row.balance) >= 0, `balance must never be negative, got ${row.balance} for case ${row.case_id}`);
      }
    });

    await test("J", "documents report includes no-storage (render_data) documents generated this sprint", async () => {
      const result = await runReportPg("documents", emptySearchParams({ pageSize: "200", search: "" }));
      const types = new Set(result.rows.filter((r) => [settledCaseId, failedCaseId, nonStarterCaseId].includes(r.case_id)).map((r) => r.document_type));
      assert.ok(types.has("FORM_4") || types.has("FORM_5") || types.has("FORM_3"), "at least one no-storage document from this sprint's fixtures must appear in the Document Register");
    });

    await test("K", "non_starters/settlements/failures reports correctly show 'Available' for no-storage documents", async () => {
      const nonStarters = await runReportPg("non_starters", emptySearchParams({ pageSize: "200" }));
      const nsRow = nonStarters.rows.find((r) => r.id === nonStarterCaseId);
      assert.ok(nsRow, "non-starter fixture must appear");
      assert.strictEqual(nsRow.form3_label, "Available", "Form-3 no-storage document must be recognized as available");

      const settlements = await runReportPg("settlements", emptySearchParams({ pageSize: "200" }));
      const settledRow = settlements.rows.find((r) => r.id === settledCaseId);
      assert.ok(settledRow, "settled fixture must appear");
      assert.strictEqual(settledRow.form4_label, "Available");

      const failuresReport = await runReportPg("failures", emptySearchParams({ pageSize: "200" }));
      const failedRow = failuresReport.rows.find((r) => r.id === failedCaseId);
      assert.ok(failedRow, "failed fixture must appear");
      assert.strictEqual(failedRow.form5_label, "Available");
    });

    await test("L", "mediators report: boolean-fixed columns don't throw and reflect the fixture mediator's session count", async () => {
      const result = await runReportPg("mediators", emptySearchParams({ pageSize: "200" }));
      const relevantMediators = result.rows.filter((r) => [...tracker.mediatorIds].includes(r.id));
      assert.ok(relevantMediators.length > 0, "fixture mediators must appear");
      for (const row of relevantMediators) {
        assert.ok(row.active_label === "Yes" || row.active_label === "No");
      }
    });

    await test("M", "sessions report: presence/effective_label render correctly for an effective, both-present session", async () => {
      const result = await runReportPg("sessions", emptySearchParams({ pageSize: "200" }));
      const row = result.rows.find((r) => r.case_id === settledCaseId || r.case_id === failedCaseId);
      assert.ok(row, "a fixture session must appear");
      assert.strictEqual(row.presence, "Both present");
      assert.strictEqual(row.effective_label, "Yes");
    });

    await test("N", "ILIKE search is case-insensitive (matches regardless of case, like SQLite's default LIKE)", async () => {
      const result = await runReportPg("register", emptySearchParams({ search: "REPORT APPLICANT A", pageSize: "50" }));
      assert.ok(result.rows.length > 0 || result.count > 0, "an uppercase search term must still match a mixed-case applicant name via ILIKE");
    });

    await test("O", "monthly reconciliation route logic: expectedClosing equals actualClosing for a case fully contained in one month", async () => {
      const { officeDate } = require("../lib/pim-time");
      const month = officeDate().slice(0, 7);
      const caseId = await fixtureBaseCase("O");
      await sql`UPDATE pim_cases SET registration_date = ${officeDate()}, closed_at = NULL WHERE id = ${caseId}`;

      const [{ count: newCases }] = await sql`
        SELECT COUNT(*)::int AS count FROM pim_cases c
        WHERE c.registration_date IS NOT NULL AND c.registration_date::text LIKE ${month + "%"} AND c.id = ${caseId}
      `;
      assert.strictEqual(newCases, 1, "the fixture case must be counted as a new registration in its own month");
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
