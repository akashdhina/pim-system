/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Tests for the 2026-10-07 numbering-policy reversal: manual PIM-number
 * entry (lib/pim-data/pim-numbering.js: assignPimNumberManualTx/Pg,
 * correctPimNumberTx/Pg, getLastRegisteredNumber), routed from
 * app/api/pim/pim-number/route.js and
 * app/api/pim/pim-number/correct/[id]/route.js. See
 * docs/phase6-manual-pim-numbering.md.
 *
 * Every test uses a disposable test year (>= 800000, same convention as
 * scripts/test-pim-numbering-postgres.js) so this suite can never collide
 * with or consume the real 2026/118 sequence row or any genuine PIM
 * number. RESIDUE confirms that invariant explicitly.
 *
 * Usage:
 *   node scripts/test-pim-manual-numbering-postgres.js
 *   node scripts/test-pim-manual-numbering-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-manual-numbering-manifest.json");
const RUN_ID = Date.now();
const TEST_YEAR_BASE = 800000 + (RUN_ID % 90000);
const TEST_PREFIX = "TEST-MANUALNUM-";

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
    persist() {
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ caseIds: [...this.caseIds] }, null, 2));
    },
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
    await del("pim_number_corrections", "case_id", caseIds);
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
  console.log(`cleanup: removing stale fixtures from a previous run: cases=${JSON.stringify(stale.caseIds)}`);
  await cleanupCasesByIds(sql, stale.caseIds || []);
  for (const id of stale.caseIds || []) tracker.caseIds.add(id);
  fs.rmSync(MANIFEST_PATH, { force: true });
}

async function main() {
  const { getSql } = require("../lib/pim-postgres");
  const {
    assignPimNumberManualPg, correctPimNumberPg, getLastRegisteredNumber,
  } = require("../lib/pim-data/pim-numbering");
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

  const [pendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'PIM_NUMBER_PENDING'`;

  let yearCounter = TEST_YEAR_BASE;
  const freshYear = () => (yearCounter += 1);

  async function fixtureCase(tag) {
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `Manual-Num Applicant ${tag}` }], oppositeParties: [{ name: `Manual-Num Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
    }, aaUser.id);
    tracker.addCase(caseId);
    await sql`UPDATE pim_cases SET current_status_id = ${pendingStatus.id} WHERE id = ${caseId}`;
    return caseId;
  }

  try {
    await test("A", "normal manual entry: running number 119 -> PIM/119/<year>, FORM2_PENDING", async () => {
      const year = freshYear();
      const caseId = await fixtureCase("A");
      const result = await assignPimNumberManualPg(caseId, 119, year, aaUser.id);
      assert.strictEqual(result.requiresConfirmation, false);
      assert.strictEqual(result.pimNumber, `PIM/119/${year}`);
      assert.strictEqual(result.currentStatusCode, "FORM2_PENDING");

      const [row] = await sql`SELECT pim_number, running_number, pim_year FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(row.pim_number, `PIM/119/${year}`);
      assert.strictEqual(row.running_number, 119);
      assert.strictEqual(row.pim_year, year);
    });

    await test("B", "duplicate running number in the same year is hard-blocked, no second case can take it", async () => {
      const year = freshYear();
      const caseA = await fixtureCase("B-A");
      await assignPimNumberManualPg(caseA, 50, year, aaUser.id);

      const caseB = await fixtureCase("B-B");
      await assert.rejects(
        () => assignPimNumberManualPg(caseB, 50, year, aaUser.id),
        /already registered against another case/
      );
      const [row] = await sql`SELECT pim_number FROM pim_cases WHERE id = ${caseB}`;
      assert.strictEqual(row.pim_number, null);
    });

    await test("C", "invalid running numbers (zero, negative, non-integer) are hard-blocked", async () => {
      const year = freshYear();
      const caseId = await fixtureCase("C");
      for (const bad of [0, -5, 1.5, NaN]) {
        await assert.rejects(() => assignPimNumberManualPg(caseId, bad, year, aaUser.id), /positive whole number/);
      }
      const [row] = await sql`SELECT pim_number FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(row.pim_number, null);
    });

    await test("D", "a gap after the last registered number returns a warning and writes nothing until confirmed", async () => {
      const year = freshYear();
      const caseA = await fixtureCase("D-A");
      await assignPimNumberManualPg(caseA, 119, year, aaUser.id);

      const caseB = await fixtureCase("D-B");
      const warned = await assignPimNumberManualPg(caseB, 121, year, aaUser.id);
      assert.strictEqual(warned.requiresConfirmation, true);
      assert.strictEqual(warned.warningType, "GAP");
      assert.match(warned.message, /Previous registered number is 119/);
      assert.match(warned.message, /PIM\/120\/.*not recorded/);

      const [unwritten] = await sql`SELECT pim_number FROM pim_cases WHERE id = ${caseB}`;
      assert.strictEqual(unwritten.pim_number, null, "a warning must never write the case");

      const confirmed = await assignPimNumberManualPg(caseB, 121, year, aaUser.id, { confirmGap: true });
      assert.strictEqual(confirmed.requiresConfirmation, false);
      assert.strictEqual(confirmed.pimNumber, `PIM/121/${year}`);
    });

    await test("E", "a lower/out-of-sequence (but unused) number returns a warning and writes nothing until confirmed", async () => {
      const year = freshYear();
      const caseA = await fixtureCase("E-A");
      await assignPimNumberManualPg(caseA, 50, year, aaUser.id);

      const caseB = await fixtureCase("E-B");
      const warned = await assignPimNumberManualPg(caseB, 30, year, aaUser.id);
      assert.strictEqual(warned.requiresConfirmation, true);
      assert.strictEqual(warned.warningType, "LOWER_OR_OUT_OF_SEQUENCE");

      const confirmed = await assignPimNumberManualPg(caseB, 30, year, aaUser.id, { confirmLower: true });
      assert.strictEqual(confirmed.pimNumber, `PIM/30/${year}`);
    });

    await test("F", "concurrent attempts to assign the SAME running number: exactly one succeeds, one fails", async () => {
      const year = freshYear();
      const caseA = await fixtureCase("F-A");
      const caseB = await fixtureCase("F-B");

      const settled = await Promise.allSettled([
        assignPimNumberManualPg(caseA, 77, year, aaUser.id),
        assignPimNumberManualPg(caseB, 77, year, aaUser.id),
      ]);
      const winners = settled.filter((s) => s.status === "fulfilled" && !s.value.requiresConfirmation);
      const losers = settled.filter((s) => s.status === "rejected");
      assert.strictEqual(winners.length, 1, "exactly one must commit");
      assert.strictEqual(losers.length, 1, "exactly one must fail");
      assert.match(losers[0].reason.message, /registered against another case/);
    });

    await test("G", "no automatic sequence increment occurs: pim_number_sequences is never touched by manual assignment", async () => {
      const year = freshYear();
      const before = await sql`SELECT COUNT(*)::int AS n FROM pim_number_sequences WHERE year = ${year}`;
      const caseId = await fixtureCase("G");
      await assignPimNumberManualPg(caseId, 5, year, aaUser.id);
      const after = await sql`SELECT COUNT(*)::int AS n FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(before[0].n, 0);
      assert.strictEqual(after[0].n, 0, "manual assignment must never create/touch a pim_number_sequences row");
    });

    await test("H", "correction is audited: old/new number, reason, corrected_by all recorded; duplicate target still blocked", async () => {
      const year = freshYear();
      const caseA = await fixtureCase("H-A");
      await assignPimNumberManualPg(caseA, 10, year, aaUser.id);

      const result = await correctPimNumberPg(caseA, 11, year, "Typo in register entry", aaUser.id);
      assert.strictEqual(result.newPimNumber, `PIM/11/${year}`);

      const [row] = await sql`SELECT pim_number, running_number FROM pim_cases WHERE id = ${caseA}`;
      assert.strictEqual(row.pim_number, `PIM/11/${year}`);
      assert.strictEqual(row.running_number, 11);

      const [audit] = await sql`SELECT old_pim_number, new_pim_number, reason, corrected_by FROM pim_number_corrections WHERE case_id = ${caseA}`;
      assert.strictEqual(audit.old_pim_number, `PIM/10/${year}`);
      assert.strictEqual(audit.new_pim_number, `PIM/11/${year}`);
      assert.strictEqual(audit.reason, "Typo in register entry");
      assert.strictEqual(audit.corrected_by, aaUser.id);

      const caseB = await fixtureCase("H-B");
      await assignPimNumberManualPg(caseB, 12, year, aaUser.id);
      await assert.rejects(
        () => correctPimNumberPg(caseA, 12, year, "attempted collision", aaUser.id),
        /already registered against another case/
      );
    });

    await test("I", "closed/non-starter case numbers are never reused: the running number stays reserved after the case terminates", async () => {
      const year = freshYear();
      const caseId = await fixtureCase("I");
      await assignPimNumberManualPg(caseId, 88, year, aaUser.id);
      // Simulate the case later terminating (non-starter) - nothing in this
      // module frees the number; a second case still cannot take it.
      const caseB = await fixtureCase("I-B");
      await assert.rejects(
        () => assignPimNumberManualPg(caseB, 88, year, aaUser.id),
        /already registered/
      );
    });

    await test("J", "getLastRegisteredNumber reflects the highest running_number for the year, ignoring other years", async () => {
      const year = freshYear();
      const otherYear = freshYear();
      const caseA = await fixtureCase("J-A");
      const caseB = await fixtureCase("J-B");
      const caseOther = await fixtureCase("J-OTHER");
      await assignPimNumberManualPg(caseA, 5, year, aaUser.id);
      // 9 after 5 is a gap (9 > 5+1) - must be explicitly confirmed, exactly
      // like real staff usage, or nothing is written.
      await assignPimNumberManualPg(caseB, 9, year, aaUser.id, { confirmGap: true });
      await assignPimNumberManualPg(caseOther, 999, otherYear, aaUser.id);

      const lastRegistered = await getLastRegisteredNumber(year);
      assert.strictEqual(lastRegistered.lastRunningNumber, 9);
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

  await test("RESIDUE", "no test fixtures remain; the real 2026 sequence row (118) is untouched; no 2026/119 pim_number exists", async () => {
    const remaining = await sql`SELECT COUNT(*)::int AS n FROM pim_cases WHERE id IN ${sql([...tracker.caseIds, 0])}`;
    assert.strictEqual(remaining[0].n, 0);
    const [seqRow] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = 2026`;
    assert.ok(seqRow, "the real 2026 sequence row must still exist");
    assert.strictEqual(seqRow.last_number, 118, "the real 2026 sequence row must remain untouched at 118");
    const [reserved] = await sql`SELECT id FROM pim_cases WHERE pim_number = 'PIM/119/2026'`;
    assert.strictEqual(reserved, undefined, "this suite must never create a real PIM/119/2026 case");
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
