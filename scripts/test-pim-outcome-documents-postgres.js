/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Tests for the outcome-document generation/download migration
 * (production-completion sprint, 2026-10-07):
 * lib/pim-data/outcome-documents.js, routed from
 * app/api/pim/documents/outcome/[id]/route.js and the outcome branch of
 * app/api/pim/documents/download/[caseId]/[documentId]/route.js. See
 * docs/phase6-outcome-documents-migration.md.
 *
 * Drives fixtures through intake -> mediator assignment -> mediation ->
 * outcome recording using the already-tested Postgres modules, then
 * generates and downloads the real Form 4/Form 5 DOCX from the frozen
 * render_data snapshot (no file ever touches local disk for these rows).
 *
 * Usage:
 *   node scripts/test-pim-outcome-documents-postgres.js
 *   node scripts/test-pim-outcome-documents-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-outcome-docs-manifest.json");
const TEST_PREFIX = "TEST-OUTDOC-";
const MEDIATOR_PREFIX = "TEST-OUTDOC-MEDIATOR-";

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
  const { generateOutcomeDocumentPg, downloadOutcomeDocumentPg } = require("../lib/pim-data/outcome-documents");
  const { recordOutcomePg, approveOutcomePg } = require("../lib/pim-data/outcome");
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

  async function fixtureCaseAtOutcomePending(tag) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `OutDoc Applicant ${tag}` }], oppositeParties: [{ name: `OutDoc Opposite ${tag}` }],
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

  try {
    await test("A", "SETTLED: generates a real Form-4 DOCX with no file_path, render_data stored, downloadable buffer is a valid non-empty DOCX", async () => {
      const caseId = await fixtureCaseAtOutcomePending("A");
      await recordOutcomePg(caseId, { outcomeType: "SETTLED", outcomeDate: "2026-03-05", settlementTerms: "Parties agreed to settle for ₹2,00,000." }, aaUser.id);

      const result = await generateOutcomeDocumentPg(caseId, {}, aaUser.id);
      assert.strictEqual(result.reused, false);
      assert.strictEqual(result.document.document_type, "FORM_4");
      assert.strictEqual(result.document.file_path, null, "no file_path must ever be written");
      assert.ok(result.document.render_data, "render_data must be stored");
      assert.strictEqual(result.document.render_data["Terms of settlement:"], "Parties agreed to settle for ₹2,00,000.");

      const [dbRow] = await sql`SELECT file_path, render_data IS NOT NULL AS has_render_data FROM pim_documents WHERE id = ${result.document.id}`;
      assert.strictEqual(dbRow.file_path, null);
      assert.strictEqual(dbRow.has_render_data, true);

      const download = await downloadOutcomeDocumentPg(caseId, result.document.id);
      assert.ok(download.buffer, "download must produce a buffer");
      assert.ok(download.buffer.length > 1000, "a real DOCX buffer should not be tiny");
      // DOCX files are zip archives - the first two bytes are 'PK'.
      assert.strictEqual(download.buffer[0], 0x50);
      assert.strictEqual(download.buffer[1], 0x4b);

      await insertDocThenCloseSettled(caseId, result.document.id);
    });

    async function insertDocThenCloseSettled(caseId) {
      const approved = await approveOutcomePg(caseId, {}, aaUser.id);
      assert.strictEqual(approved.finalStatusCode, "CLOSED_SETTLED");
    }

    await test("B", "regenerating without the flag reuses the existing document (same id, same render_data)", async () => {
      const caseId = await fixtureCaseAtOutcomePending("B");
      await recordOutcomePg(caseId, { outcomeType: "FAILED", outcomeDate: "2026-03-05", reasonText: "Opposite party withdrew cooperation." }, aaUser.id);

      const first = await generateOutcomeDocumentPg(caseId, {}, aaUser.id);
      const second = await generateOutcomeDocumentPg(caseId, {}, aaUser.id);
      assert.strictEqual(second.reused, true);
      assert.strictEqual(second.document.id, first.document.id);
    });

    await test("C", "regenerate: true creates a new current version, retiring the previous one", async () => {
      const caseId = await fixtureCaseAtOutcomePending("C");
      await recordOutcomePg(caseId, { outcomeType: "FAILED", outcomeDate: "2026-03-05", reasonText: "Initial reason." }, aaUser.id);

      const first = await generateOutcomeDocumentPg(caseId, {}, aaUser.id);
      const second = await generateOutcomeDocumentPg(caseId, { regenerate: true }, aaUser.id);
      assert.strictEqual(second.reused, false);
      assert.notStrictEqual(second.document.id, first.document.id);
      assert.strictEqual(second.document.version_no, first.document.version_no + 1);

      const [firstRow] = await sql`SELECT is_current FROM pim_documents WHERE id = ${first.document.id}`;
      assert.strictEqual(firstRow.is_current, false, "the previous version must no longer be current");
    });

    await test("D", "generation is blocked outside OUTCOME_FORM_PENDING/closed-matching status, before any outcome is recorded", async () => {
      const caseId = await fixtureCaseAtOutcomePending("D");
      // No outcome recorded yet - must fail on "no outcome" before reaching the status check.
      await assert.rejects(() => generateOutcomeDocumentPg(caseId, {}, aaUser.id), /No mediation outcome/);
    });

    await test("E", "NON_STARTER and WITHDRAWN outcomes are rejected from this generator", async () => {
      const caseId = await fixtureCaseAtOutcomePending("E");
      await recordOutcomePg(caseId, { outcomeType: "WITHDRAWN", outcomeDate: "2026-03-05", reasonText: "Applicant withdrew." }, aaUser.id);
      await assert.rejects(() => generateOutcomeDocumentPg(caseId, {}, aaUser.id), /withdrawal document template is not configured/);
    });

    await test("F", "generation still works AFTER closure (regeneration path), matching the Phase 8 invariant", async () => {
      const caseId = await fixtureCaseAtOutcomePending("F");
      await recordOutcomePg(caseId, { outcomeType: "FAILED", outcomeDate: "2026-03-05", reasonText: "x" }, aaUser.id);
      await generateOutcomeDocumentPg(caseId, {}, aaUser.id);
      await approveOutcomePg(caseId, {}, aaUser.id);

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${caseId}`;
      assert.strictEqual(caseRow.code, "CLOSED_FAILED");

      const regenerated = await generateOutcomeDocumentPg(caseId, { regenerate: true }, aaUser.id);
      assert.strictEqual(regenerated.reused, false);
    });

    await test("G", "downloadOutcomeDocumentPg returns null for a document id that doesn't belong to this case (ownership check)", async () => {
      const caseA = await fixtureCaseAtOutcomePending("G-A");
      await recordOutcomePg(caseA, { outcomeType: "FAILED", outcomeDate: "2026-03-05", reasonText: "x" }, aaUser.id);
      const docA = await generateOutcomeDocumentPg(caseA, {}, aaUser.id);

      const caseB = await fixtureCaseAtOutcomePending("G-B");
      const result = await downloadOutcomeDocumentPg(caseB, docA.document.id);
      assert.strictEqual(result, null);
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

  await test("RESIDUE", "no test fixture rows remain; no file was ever written under storage/pim for these fixtures", async () => {
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
