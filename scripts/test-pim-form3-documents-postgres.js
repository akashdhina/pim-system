/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Tests for the Form-3 (Non-Starter Report) document generation/download
 * migration (production-completion sprint, 2026-10-07):
 * lib/pim-data/form3-documents.js, routed from
 * app/api/pim/documents/form3/[id]/route.js and the Form-3 branch of
 * app/api/pim/documents/download/[caseId]/[documentId]/route.js. See
 * docs/phase6-form3-documents-migration.md.
 *
 * Also exercises the real integration with lib/pim-data/nonstarter.js's
 * completeNonStarterForm3Pg - generating the ACTUAL document (not a
 * fixture row) and then completing Form-3 with it, end to end.
 *
 * Usage:
 *   node scripts/test-pim-form3-documents-postgres.js
 *   node scripts/test-pim-form3-documents-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-form3-docs-manifest.json");
const TEST_PREFIX = "TEST-F3DOC-";

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
    await del("pim_notices", "case_id", caseIds);
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
  const { generateForm3DocumentPg, downloadForm3DocumentPg } = require("../lib/pim-data/form3-documents");
  const { recordNonStarterPg, completeNonStarterForm3Pg } = require("../lib/pim-data/nonstarter");
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

  async function fixtureCaseAtOutcomeFormPending(tag, { reasonCode = "BOTH_PARTIES_NOT_WILLING" } = {}) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `F3Doc Applicant ${tag}` }], oppositeParties: [{ name: `F3Doc Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      claimAmount: 500000,
    }, aaUser.id);
    tracker.addCase(caseId);

    // A minimal fixture Form-2 notice - Form-3 render data needs a
    // notice's appearance_date; the real intake->Form2 flow is out of
    // scope for this document-rendering test.
    await sql`
      INSERT INTO pim_notices (case_id, notice_type, form_no, notice_date, appearance_date, appearance_time, status)
      VALUES (${caseId}, 'FORM_2_INITIAL', 'FORM-2', '2026-01-15', '2026-01-25', '10:30', 'DISPATCHED')
    `;

    await recordNonStarterPg({ caseId, reasonCode, outcomeDate: "2026-02-01", remarks: "fixture", userId: aaUser.id });
    return caseId;
  }

  try {
    await test("A", "generates a real Form-3 DOCX with no file_path, render_data stored, downloadable buffer is a valid non-empty DOCX", async () => {
      const caseId = await fixtureCaseAtOutcomeFormPending("A");

      const result = await generateForm3DocumentPg(caseId, { ruleReference: "3(4)" }, aaUser.id);
      assert.strictEqual(result.reused, false);
      assert.strictEqual(result.document.document_type, "FORM_3");
      assert.strictEqual(result.document.file_path, null);
      assert.ok(result.document.render_data);
      assert.strictEqual(result.document.render_data.rule_reference, "3(4)");

      const download = await downloadForm3DocumentPg(caseId, result.document.id);
      assert.ok(download.buffer);
      assert.ok(download.buffer.length > 1000);
      assert.strictEqual(download.buffer[0], 0x50);
      assert.strictEqual(download.buffer[1], 0x4b);
    });

    await test("B", "invalid rule reference is rejected before any write", async () => {
      const caseId = await fixtureCaseAtOutcomeFormPending("B");
      await assert.rejects(() => generateForm3DocumentPg(caseId, { ruleReference: "3(5)" }, aaUser.id), /Rule reference must be 3\(4\) or 3\(6\)/);
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_documents WHERE case_id = ${caseId}`;
      assert.strictEqual(n, 0);
    });

    await test("C", "missing rule reference is rejected", async () => {
      const caseId = await fixtureCaseAtOutcomeFormPending("C");
      await assert.rejects(() => generateForm3DocumentPg(caseId, {}, aaUser.id), /Rule reference is required/);
    });

    await test("D", "regenerate: true creates a new current version, retiring the previous one", async () => {
      const caseId = await fixtureCaseAtOutcomeFormPending("D");
      const first = await generateForm3DocumentPg(caseId, { ruleReference: "3(4)" }, aaUser.id);
      const second = await generateForm3DocumentPg(caseId, { ruleReference: "3(6)", regenerate: true }, aaUser.id);
      assert.notStrictEqual(second.document.id, first.document.id);
      assert.strictEqual(second.document.version_no, first.document.version_no + 1);
      assert.strictEqual(second.document.render_data.rule_reference, "3(6)");

      const [firstRow] = await sql`SELECT is_current FROM pim_documents WHERE id = ${first.document.id}`;
      assert.strictEqual(firstRow.is_current, false);
    });

    await test("E", "generation from a status outside the allowed window is rejected", async () => {
      const caseId = await fixtureCaseAtOutcomeFormPending("E");
      const [pendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'PIM_NUMBER_PENDING'`;
      await sql`UPDATE pim_cases SET current_status_id = ${pendingStatus.id} WHERE id = ${caseId}`;
      await assert.rejects(() => generateForm3DocumentPg(caseId, { ruleReference: "3(4)" }, aaUser.id), /Form-3 cannot be generated from status/);
    });

    await test("F", "end-to-end: real generated Form-3 document successfully completes the non-starter Form-3 step and closes the case", async () => {
      const caseId = await fixtureCaseAtOutcomeFormPending("F");
      const generated = await generateForm3DocumentPg(caseId, { ruleReference: "3(4)" }, aaUser.id);

      const result = await completeNonStarterForm3Pg(caseId, { documentId: generated.document.id }, aaUser.id);
      assert.strictEqual(result.statusCode, "CLOSED_NON_STARTER");

      const [caseRow] = await sql`SELECT closed_at FROM pim_cases WHERE id = ${caseId}`;
      assert.ok(caseRow.closed_at);
    });

    await test("G", "downloadForm3DocumentPg returns null for a document that doesn't belong to this case", async () => {
      const caseA = await fixtureCaseAtOutcomeFormPending("G-A");
      const docA = await generateForm3DocumentPg(caseA, { ruleReference: "3(4)" }, aaUser.id);
      const caseB = await fixtureCaseAtOutcomeFormPending("G-B");
      const result = await downloadForm3DocumentPg(caseB, docA.document.id);
      assert.strictEqual(result, null);
    });
  } finally {
    console.log(`\ncleanup: removing exactly these fixture case ids: ${JSON.stringify([...tracker.caseIds])}`);
    try {
      await cleanupCasesByIds(sql, [...tracker.caseIds]);
    } catch (error) {
      console.error(`CLEANUP FAILED: ${error.message}`);
      failures.push("cleanup of fixtures");
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
