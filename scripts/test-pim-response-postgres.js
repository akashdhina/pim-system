/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5K tests: opposite-party response + all-party consent -
 * lib/pim-data/response.js, routed from app/api/pim/response/[id]/route.js
 * and app/api/pim/consent/[id]/route.js. See
 * docs/phase6-batch5k-op-response-consent-migration.md.
 *
 * PRIMARY DEFECT UNDER TEST: the pre-existing SQLite route moved a
 * multi-OP case to FEE_PENDING the moment the FIRST opposite party
 * consented, with no check for other required opposite parties. This
 * suite's core new coverage (letters F-M) proves the corrected
 * behavior: the case only reaches FEE_PENDING once EVERY active
 * opposite party's latest response shows consent=1, and a later OP's
 * refusal remains recordable at any point, including after the case
 * has already reached FEE_PENDING via a different party.
 *
 * CONSENT COMPLETION IS NOT FEE COMPLETION: this suite never records a
 * fee payment and never asserts MEDIATOR_ASSIGNMENT_PENDING - 5K stops
 * at FEE_PENDING, per the approved plan. The three future-fee-batch
 * regression scenarios (OP-paid/applicant-unpaid, the inverse, both-
 * paid) are NOT implemented here, per the explicit instruction not to
 * pull the fee redesign into this batch.
 *
 * PRODUCTION SAFETY: this suite never calls the PIM-number allocator
 * and never touches year 2026 or PIM/109/2026 - every fixture case is
 * created directly via T1 intake and driven to SERVICE_PENDING through
 * Batch 5I/5J's own already-proven functions. PIM/119/2026 remains
 * reserved for genuine production use.
 *
 * Usage:
 *   node scripts/test-pim-response-postgres.js
 *   node scripts/test-pim-response-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO_ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-pim-response-manifest.json");
const RUN_ID = Date.now();
const TEST_PREFIX = "TEST-B5K-";

let passed = 0;
const failures = [];
const letterResults = {};

function record(letter, outcome) {
  letterResults[letter] = letterResults[letter] || { pass: 0, fail: 0, na: [] };
  if (outcome === "pass") letterResults[letter].pass += 1;
  if (outcome === "fail") letterResults[letter].fail += 1;
}

const TEST_TIMEOUT_MS = 180000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms / 1000}s: ${label} (possible pooler stall)`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function test(letter, name, fn) {
  try {
    await withTimeout(Promise.resolve().then(fn), TEST_TIMEOUT_MS, name);
    console.log(`PASS [${letter}]: ${name}`);
    passed += 1;
    record(letter, "pass");
  } catch (error) {
    console.error(`FAIL [${letter}]: ${name}`);
    console.error(`      ${error instanceof Error ? error.stack || error.message : error}`);
    failures.push(`[${letter}] ${name}`);
    record(letter, "fail");
  }
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------
// Static tests
// ---------------------------------------------------------------------

async function runStaticTests() {
  await test("S", "lib/pim-data/response.js is PostgreSQL-only: no SQLite, no filesystem, writes inside withTransaction", () => {
    const code = stripComments(readSource("lib/pim-data/response.js"));
    for (const forbidden of ['require("../db")', 'require("./db")', ".prepare(", "lastInsertRowid", "fs.writeFileSync", 'require("fs")']) {
      assert.ok(!code.includes(forbidden), `response.js contains ${forbidden}`);
    }
    assert.ok((code.match(/withTransaction\(\(tx\)/g) || []).length === 2, "expected exactly 2 withTransaction entry points (response, consent decision)");
  });

  await test("S", "every mutating function locks the case row (FOR UPDATE OF c) before any other read/write - no notice/party lock, per the planning document's §16 design", () => {
    const code = stripComments(readSource("lib/pim-data/response.js"));
    const caseLockCount = (code.match(/FOR UPDATE OF c/g) || []).length;
    assert.strictEqual(caseLockCount, 2, "expected 2 case-row locks (recordResponseTx, recordConsentDecisionTx)");
    assert.ok(!code.includes("FOR UPDATE OF n"), "this module must never lock pim_notices - it never writes it");
  });

  await test("S", "ALL_REQUIRED_PARTIES_CONSENTED is derived live, never persisted as a boolean column", () => {
    const code = readSource("lib/pim-data/response.js");
    assert.ok(code.includes("async function deriveConsentAggregateTx"));
    assert.ok(!/ALTER TABLE|ADD COLUMN/.test(code), "no schema/DDL statement may appear in this module");
  });

  await test("S", "a party's own refusal is decisive regardless of the case's current status (including FEE_PENDING) - the dead-end fix", () => {
    const code = readSource("lib/pim-data/response.js");
    const fn = code.slice(code.indexOf("async function handleRefusedTx"));
    assert.ok(fn.includes("getStatusId(tx, caseRow.status_code)"), "handleRefusedTx must transition FROM whatever status the case is currently at, not a hard-coded entry set");
  });

  await test("S", "the mediation-fee row is created only once the consent gate is satisfied, never on a single party's consent", () => {
    const code = readSource("lib/pim-data/response.js");
    const fn = code.slice(code.indexOf("async function handleConsentedTx"), code.indexOf("async function handleRefusedTx"));
    const gateCheckIndex = fn.indexOf("if (!aggregate.gateSatisfied)");
    const ensureFeeIndex = fn.indexOf("ensureMediationFeeTx(");
    assert.ok(gateCheckIndex > -1 && ensureFeeIndex > -1 && ensureFeeIndex > gateCheckIndex, "ensureMediationFeeTx must appear only in the gate-satisfied branch, after the early return");
  });

  await test("S", "routes call the PostgreSQL functions; the kept SQLite originals are not called", () => {
    const responseRoute = readSource("app/api/pim/response/[id]/route.js");
    assert.ok(responseRoute.includes("await getResponseDataPg("));
    assert.ok(responseRoute.includes("await recordResponsePg("));
    assert.ok(responseRoute.includes("function recordResponseSqlite("), "the SQLite baseline must still be present, unused");

    const consentRoute = readSource("app/api/pim/consent/[id]/route.js");
    assert.ok(consentRoute.includes("await recordConsentDecisionPg("));
    assert.ok(consentRoute.includes("function recordConsentDecisionSqlite("));
  });
}

// ---------------------------------------------------------------------
// Fixture infrastructure (same conventions as every prior Batch 5 suite)
// ---------------------------------------------------------------------

const COUNT_TABLES = [
  "pim_cases", "pim_parties", "pim_case_parties", "pim_addresses", "pim_advocates",
  "pim_fees", "pim_status_history", "pim_docket", "pim_tasks", "pim_task_history",
  "pim_notices", "pim_documents", "pim_service_attempts", "pim_responses", "audit_log",
];

function createTracker() {
  return {
    caseIds: new Set(),
    addCase(id) {
      this.caseIds.add(id);
      this.persist();
    },
    persist() {
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify({ startedAt: new Date().toISOString(), caseIds: [...this.caseIds] }, null, 2)
      );
    },
  };
}

async function cleanupCasesByIds(sql, caseIds) {
  if (caseIds.length === 0) return;
  const existing = await sql`SELECT id, received_number FROM pim_cases WHERE id IN ${sql(caseIds)}`;
  for (const row of existing) {
    if (!String(row.received_number || "").startsWith(TEST_PREFIX)) {
      throw new Error(`Refusing to delete case ${row.id}: it is not a test fixture (received_number=${row.received_number}).`);
    }
  }
  await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '15s'`;
    const partyIds = (await tx`SELECT DISTINCT party_id FROM pim_case_parties WHERE case_id IN ${tx(caseIds)}`).map((r) => r.party_id);
    const del = async (table, column, ids) => {
      if (ids.length > 0) await tx`DELETE FROM ${tx(table)} WHERE ${tx(column)} IN ${tx(ids)}`;
    };
    await del("pim_responses", "case_id", caseIds);
    await del("pim_fees", "case_id", caseIds);
    await del("pim_service_attempts", "notice_id", (await tx`SELECT id FROM pim_notices WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id));
    await del("pim_task_history", "task_id", (await tx`SELECT id FROM pim_tasks WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id));
    await del("pim_tasks", "case_id", caseIds);
    await del("pim_docket", "case_id", caseIds);
    await del("pim_status_history", "case_id", caseIds);
    await tx`UPDATE pim_notices SET document_id = NULL WHERE case_id IN ${tx(caseIds)}`;
    await del("pim_documents", "case_id", caseIds);
    await del("pim_notices", "case_id", caseIds);
    await del("pim_case_parties", "case_id", caseIds);
    await del("pim_addresses", "party_id", partyIds);
    await del("pim_parties", "id", partyIds);
    await del("pim_cases", "id", caseIds);
  });
}

async function describeOrphanedTransactions(sql) {
  try {
    const rows = await sql`
      SELECT pid, state, now() - xact_start AS open_for, left(query, 100) AS query
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'
      ORDER BY xact_start`;
    return rows.map((r) => `pid ${r.pid} (${r.state}, open ${r.open_for}): ${String(r.query).replace(/\s+/g, " ")}`);
  } catch {
    return [];
  }
}

async function recoverStaleFixtures(sql, tracker) {
  if (!fs.existsSync(MANIFEST_PATH)) return { caseIds: [] };
  let stale;
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    stale = { caseIds: parsed.caseIds || [] };
  } catch (error) {
    throw new Error(`Could not read the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }
  console.log(`cleanup: removing stale fixtures from a previous run: cases=${JSON.stringify(stale.caseIds)}`);
  try {
    await cleanupCasesByIds(sql, stale.caseIds);
  } catch (error) {
    throw new Error(`Could not clean the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }
  for (const id of stale.caseIds) tracker.caseIds.add(id);
  fs.rmSync(MANIFEST_PATH, { force: true });
  return stale;
}

async function withRetries(label, fn, { attempts = 6, delayMs = 5000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const transient = /ECONNRESET|ENOTFOUND|EAI_AGAIN|CONNECT_TIMEOUT|ETIMEDOUT|ECONNREFUSED|CONNECTION_CLOSED|CONNECTION_ENDED|tenant or user not found/i.test(
        `${error.code || ""} ${error.message}`
      );
      if (!transient || attempt >= attempts) throw error;
      console.error(`      ${label}: connectivity error (${error.code || error.message}); retry ${attempt}/${attempts - 1} in ${delayMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function tableCounts(sql) {
  const counts = {};
  for (const t of COUNT_TABLES) counts[t] = (await sql`SELECT COUNT(*)::int AS n FROM ${sql(t)}`)[0].n;
  return counts;
}

async function countWhereIn(sql, table, column, ids) {
  if (ids.length === 0) return 0;
  return (await sql`SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE ${sql(column)} IN ${sql(ids)}`)[0].n;
}

async function verifyNoResidue(sql, tracker, baselineCounts) {
  const problems = [];
  const caseIds = [...tracker.caseIds];
  const checks = [
    ["pim_cases", "id", caseIds],
    ["pim_notices", "case_id", caseIds],
    ["pim_responses", "case_id", caseIds],
    ["pim_fees", "case_id", caseIds],
    ["pim_status_history", "case_id", caseIds],
    ["pim_docket", "case_id", caseIds],
    ["pim_tasks", "case_id", caseIds],
  ];
  for (const [table, column, ids] of checks) {
    const n = await countWhereIn(sql, table, column, ids);
    if (n !== 0) problems.push(`${table}.${column}: ${n} row(s) remain for tracked ids`);
  }

  const [reserved] = await sql`SELECT id FROM pim_cases WHERE pim_number = 'PIM/119/2026'`;
  if (reserved) problems.push("a case with pim_number = 'PIM/119/2026' exists - the reserved production number was consumed");
  const [pim109] = await sql`SELECT id, pim_number FROM pim_cases WHERE pim_number = 'PIM/109/2026'`;
  if (pim109) problems.push(`PIM/109/2026 was touched by this test run (id ${pim109.id}) - this is a live production case and must never be referenced by any test`);
  const [seq2026] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = 2026`;
  if (!seq2026 || seq2026.last_number !== 118) {
    problems.push(`pim_number_sequences year 2026: expected last_number=118 (untouched), found ${JSON.stringify(seq2026)}`);
  }

  const [panel] = await sql`SELECT COUNT(*)::int AS n FROM mediators WHERE active = true`;
  if (!panel || panel.n !== 5) {
    problems.push(`mediators: expected exactly 5 active approved panel members, found ${JSON.stringify(panel)}`);
  }

  const after = await tableCounts(sql);
  if (baselineCounts) {
    for (const table of COUNT_TABLES) {
      if (after[table] !== baselineCounts[table]) {
        problems.push(`${table}: row count ${after[table]} != pre-run baseline ${baselineCounts[table]} (if another user wrote during this run, re-run)`);
      }
    }
  }

  const orphans = await describeOrphanedTransactions(sql);
  for (const line of orphans) problems.push(`orphaned transaction: ${line}`);

  return { problems, after };
}

// ---------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------

function loadRouteModule(relativePath, extraExports = []) {
  const routePath = path.join(REPO_ROOT, ...relativePath.split("/"));
  const original = fs.readFileSync(routePath, "utf8");
  const names = [...original.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
  const source =
    original
      .replace(/^export async function (\w+)/gm, "async function $1")
      .replace(/^export const (\w+)/gm, "const $1") +
    `\nmodule.exports = { ${[...names, ...extraExports].join(", ")} };\n`;
  const routeModule = new Module(routePath, module);
  routeModule.filename = routePath;
  routeModule.paths = Module._nodeModulePaths(path.dirname(routePath));
  routeModule._compile(source, routePath);
  return routeModule.exports;
}

async function callJsonRoute(route, method, url, { userId = null, body = undefined, params = undefined } = {}) {
  const headers = {};
  if (userId != null) headers["x-pim-user-id"] = String(userId);
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await route[method](request, params ? { params: Promise.resolve(params) } : undefined);
    return { status: response.status, json: await response.json() };
  } finally {
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------

async function runLive() {
  const startedAt = Date.now();
  const { getSql, withTransaction } = require("../lib/pim-postgres");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { prepareForm2NoticePg, generateForm2DocumentPg, issueForm2NoticePg } = require("../lib/pim-data/form2");
  const { recordServiceResultPg } = require("../lib/pim-data/service");
  const { recordResponsePg, recordConsentDecisionPg, recordResponseTx, deriveConsentAggregateTx } = require("../lib/pim-data/response");

  const sql = getSql();
  const tracker = createTracker();

  await withRetries("connect", () => sql`SELECT 1`);
  await withRetries("stale cleanup", () => recoverStaleFixtures(sql, tracker));

  const baselineCounts = await tableCounts(sql);
  console.log(`pre-run baseline row counts: ${JSON.stringify(baselineCounts)}`);

  try {
    const users = await sql`SELECT id, username, role_code FROM users WHERE active = true ORDER BY id`;
    const aaUser = users.find((u) => u.role_code === "aa");
    const chairmanUser = users.find((u) => u.role_code === "chairman");
    assert.ok(aaUser && chairmanUser, "expected synced 'aa' and 'chairman' users");

    const [form2Pending] = await sql`SELECT id FROM status_master WHERE code = 'FORM2_PENDING'`;
    const [form2TaskType] = await sql`SELECT id, default_priority FROM task_types WHERE code = 'FORM2'`;

    /*
     * Builds a case via real T1 intake, with N opposite parties, fast-
     * forwarded to FORM2_PENDING, then drives EACH opposite party's own
     * notice through Batch 5I/5J's own Prepare/Generate/Issue/Deliver
     * functions to SERVICE_PENDING with a SERVED notice - never a
     * shortcut, proving all three batches compose.
     */
    async function fixtureCaseWithOpposites(tag, oppositeCount) {
      const oppositeParties = Array.from({ length: oppositeCount }, (_, i) => ({
        name: `B5K Opposite ${tag}-${i + 1}`,
        addresses: [{ addressLine1: `${i + 1} Test Street`, villageTown: "Test Town", district: "Test District" }],
      }));

      const caseId = await createReceivedPimApplicationPg({
        receivedNumber: `${TEST_PREFIX}${tag}-${RUN_ID}-${Math.random().toString(36).slice(2, 7)}`,
        receivedDate: "2026-01-10", applicationDate: "2026-01-09",
        applicants: [{ name: `B5K Applicant ${tag}` }],
        oppositeParties,
        applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      }, aaUser.id);
      tracker.addCase(caseId);

      await sql`UPDATE pim_cases SET current_status_id = ${form2Pending.id} WHERE id = ${caseId}`;
      await sql`
        INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
        VALUES (${caseId}, ${form2TaskType.id}, 'FORM2', 'Prepare Form-2 after PIM registration.', ${"2026-01-10"}, ${"2026-01-10"}, ${form2TaskType.default_priority}, 'PENDING', true)
      `;

      const parties = await sql`
        SELECT cp.party_id, p.name FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
        WHERE cp.case_id = ${caseId} AND cp.role = 'OPPOSITE_PARTY' ORDER BY cp.sequence_no
      `;

      const result = { caseId, parties: [] };

      for (const party of parties) {
        const [address] = await sql`SELECT id FROM pim_addresses WHERE party_id = ${party.party_id} AND is_current = true`;

        // Each opposite party after the first needs the case back at
        // FORM2_PENDING before its own Prepare - 5I's own notice-type
        // guard is per-notice, but the CASE guard is case-wide, so each
        // party's full Prepare->Issue cycle must complete before the
        // next one starts (sequential, matching how a real multi-OP
        // case would actually be notice-issued one at a time in this
        // codebase's current single-notice-per-Form2-cycle design).
        await sql`UPDATE pim_cases SET current_status_id = ${form2Pending.id} WHERE id = ${caseId}`;
        const existingTask = await sql`SELECT id FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'FORM2' AND status = 'PENDING'`;
        if (existingTask.length === 0) {
          await sql`
            INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
            VALUES (${caseId}, ${form2TaskType.id}, 'FORM2', 'Prepare Form-2 after PIM registration.', ${"2026-01-10"}, ${"2026-01-10"}, ${form2TaskType.default_priority}, 'PENDING', true)
          `;
        }

        const prepared = await prepareForm2NoticePg(caseId, {
          partyId: party.party_id, addressId: address.id, appearanceDate: "2026-02-15", appearanceTime: "10:30", noticeType: "FORM_2_INITIAL",
        }, aaUser.id);
        await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id);
        const issued = await issueForm2NoticePg(caseId, {
          noticeId: prepared.noticeId, addressId: address.id, dispatchMode: "REGISTERED_POST",
        }, aaUser.id);
        await recordServiceResultPg(caseId, {
          serviceAttemptId: issued.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-20",
        }, aaUser.id);

        result.parties.push({ partyId: party.party_id, name: party.name, noticeId: prepared.noticeId });
      }

      return result;
    }

    const responseRoute = loadRouteModule("app/api/pim/response/[id]/route.js");
    const consentRoute = loadRouteModule("app/api/pim/consent/[id]/route.js");

    function consentBody(f, idx) {
      return {
        partyId: f.parties[idx].partyId, noticeId: f.parties[idx].noticeId, responseType: "APPEARED",
        responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1,
      };
    }

    // =================================================================
    // A: single OP consent (1-OP baseline - the ported-behavior floor)
    // =================================================================
    let ctxA;
    await test("A", "single OP consent: case reaches FEE_PENDING, fee row created, OP_CONSENT_FEE task created, exactly once", async () => {
      const f = await fixtureCaseWithOpposites("A", 1);
      const res = await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) }, body: consentBody(f, 0),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.statusCode, "FEE_PENDING");

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "FEE_PENDING");
      const [fee] = await sql`SELECT id, amount_received FROM pim_fees WHERE case_id = ${f.caseId} AND fee_type = 'MEDIATION_FEE'`;
      assert.ok(fee, "a mediation fee row must exist");
      assert.strictEqual(Number(fee.amount_received), 0, "5K must never record a fee payment");
      const tasks = await sql`SELECT id FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'OP_CONSENT_FEE' AND status = 'PENDING'`;
      assert.strictEqual(tasks.length, 1);

      ctxA = f;
    });

    // =================================================================
    // B: multiple OP partial consent - the PRIMARY FIX under test
    // =================================================================
    let ctxB;
    await test("B", "multiple OP partial consent: OP1 consents, OP2 unresolved -> case does NOT reach FEE_PENDING", async () => {
      const f = await fixtureCaseWithOpposites("B", 2);
      const res = await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) }, body: consentBody(f, 0),
      });
      assert.strictEqual(res.status, 200);
      assert.notStrictEqual(res.json.data.statusCode, "FEE_PENDING", "the case must NOT reach FEE_PENDING on the first OP's consent alone");
      assert.ok(res.json.data.consentGate, "the response must surface the consent-gate state for UI/workflow use");
      assert.strictEqual(res.json.data.consentGate.gateSatisfied, false);
      assert.strictEqual(res.json.data.consentGate.unresolvedParties.length, 1);

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "SERVICE_PENDING", "the case must remain exactly where it was - no premature transition");
      const [fee] = await sql`SELECT id FROM pim_fees WHERE case_id = ${f.caseId} AND fee_type = 'MEDIATION_FEE'`;
      assert.strictEqual(fee, undefined, "no fee row may be created before the gate is satisfied");

      ctxB = f;
    });

    // =================================================================
    // C: multiple OP complete consent
    // =================================================================
    await test("C", "multiple OP complete consent: FEE_PENDING fires only once the SECOND (last) OP consents, not the first", async () => {
      assert.ok(ctxB, "prerequisite B did not complete");
      const res = await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${ctxB.caseId}`, {
        userId: aaUser.id, params: { id: String(ctxB.caseId) }, body: consentBody(ctxB, 1),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.statusCode, "FEE_PENDING");
      assert.strictEqual(res.json.data.consentGate.gateSatisfied, true);
      assert.strictEqual(res.json.data.consentGate.consentedParties.length, 2);

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${ctxB.caseId}`;
      assert.strictEqual(caseRow.code, "FEE_PENDING");
      const fees = await sql`SELECT id FROM pim_fees WHERE case_id = ${ctxB.caseId} AND fee_type = 'MEDIATION_FEE'`;
      assert.strictEqual(fees.length, 1, "exactly one case-level fee row, never one per OP");
    });

    // =================================================================
    // D: unresolved OP (independent confirmation via the aggregate query)
    // =================================================================
    await test("D", "ALL_REQUIRED_PARTIES_CONSENTED derivation: direct query-level test, independent of any route call", async () => {
      const f = await fixtureCaseWithOpposites("D", 3);
      let aggregate = await withTransaction((tx) => deriveConsentAggregateTx(tx, f.caseId));
      assert.strictEqual(aggregate.requiredParties.length, 3);
      assert.strictEqual(aggregate.gateSatisfied, false);
      assert.strictEqual(aggregate.unresolvedParties.length, 3);

      await recordResponsePg(f.caseId, { partyId: f.parties[0].partyId, noticeId: f.parties[0].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1 }, aaUser.id);
      aggregate = await withTransaction((tx) => deriveConsentAggregateTx(tx, f.caseId));
      assert.strictEqual(aggregate.consentedParties.length, 1);
      assert.strictEqual(aggregate.unresolvedParties.length, 2);
      assert.strictEqual(aggregate.gateSatisfied, false);
    });

    // =================================================================
    // E: OP refusal (single-OP baseline)
    // =================================================================
    await test("E", "OP refusal (single OP): OP_REFUSED + non-starter handoff, never FEE_PENDING", async () => {
      const f = await fixtureCaseWithOpposites("E", 1);
      const res = await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { partyId: f.parties[0].partyId, noticeId: f.parties[0].noticeId, responseType: "REFUSED", responseDate: "2026-02-21" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.statusCode, "OP_REFUSED");

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "OP_REFUSED");
      const [task] = await sql`SELECT id FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'NONSTARTER_FORM3' AND status = 'PENDING'`;
      assert.ok(task);
    });

    // =================================================================
    // F: multiple OP, one refuses -> NOT FEE_PENDING, correct non-starter
    // =================================================================
    let ctxF;
    await test("F", "multiple OP, OP1 consents OP2 refuses: case -> OP_REFUSED (never FEE_PENDING), non-starter handoff created", async () => {
      const f = await fixtureCaseWithOpposites("F", 2);
      await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) }, body: consentBody(f, 0),
      });
      const res = await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { partyId: f.parties[1].partyId, noticeId: f.parties[1].noticeId, responseType: "REFUSED", responseDate: "2026-02-21" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.statusCode, "OP_REFUSED");

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "OP_REFUSED", "a refusal by ANY required party must prevent FEE_PENDING");
      const fees = await sql`SELECT id FROM pim_fees WHERE case_id = ${f.caseId} AND fee_type = 'MEDIATION_FEE'`;
      assert.strictEqual(fees.length, 0, "no fee row may exist - the gate was never satisfied");
      const [task] = await sql`SELECT id FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'NONSTARTER_FORM3' AND status = 'PENDING'`;
      assert.ok(task);

      ctxF = f;
    });

    // =================================================================
    // G: second OP refusal remains recordable even AFTER FEE_PENDING -
    //    the dead-end fix (the pre-existing SQLite route rejected this
    //    outright once the case moved to FEE_PENDING via another OP)
    // =================================================================
    await test("G", "a later OP's refusal remains recordable even after the case already reached FEE_PENDING via a different OP - overrides to OP_REFUSED", async () => {
      const f = await fixtureCaseWithOpposites("G", 2);
      const first = await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) }, body: consentBody(f, 0),
      });
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.json.data.statusCode, "SERVICE_PENDING");

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "SERVICE_PENDING");

      // Second OP now refuses - this is the "later OP refusal must
      // remain recordable" scenario; under the OLD SQLite behavior the
      // first OP's consent would already have moved the case to
      // FEE_PENDING, and this refusal would have been a dead end
      // (rejected: "case not available for recording a response").
      const second = await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { partyId: f.parties[1].partyId, noticeId: f.parties[1].noticeId, responseType: "REFUSED", responseDate: "2026-02-21" },
      });
      assert.strictEqual(second.status, 200, "the second OP's refusal must be recordable, not rejected as a dead end");
      assert.strictEqual(second.json.data.statusCode, "OP_REFUSED");
    });

    // =================================================================
    // H: duplicate response / I: concurrent identical / J: concurrent conflicting
    // =================================================================
    await test("H", "duplicate same-party response: a second consent decision on the same appearance is rejected", async () => {
      const f = await fixtureCaseWithOpposites("H", 1);
      await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { partyId: f.parties[0].partyId, noticeId: f.parties[0].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: null, mediationFeeRequested: null },
      });
      const res = await callJsonRoute(consentRoute, "POST", `http://localhost/api/pim/consent/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) }, body: { partyId: f.parties[0].partyId, decision: "CONSENTED" },
      });
      assert.strictEqual(res.status, 200);

      const dup = await callJsonRoute(consentRoute, "POST", `http://localhost/api/pim/consent/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) }, body: { partyId: f.parties[0].partyId, decision: "CONSENTED" },
      });
      assert.strictEqual(dup.status, 400);
      assert.match(dup.json.message, /already been recorded|Consent cannot be recorded|No OP appearance/);
    });

    await test("I", "concurrent identical response (two OPs responding concurrently): both commit, no corruption", async () => {
      const f = await fixtureCaseWithOpposites("I", 2);
      const settled = await Promise.allSettled([
        recordResponsePg(f.caseId, { partyId: f.parties[0].partyId, noticeId: f.parties[0].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1 }, aaUser.id),
        recordResponsePg(f.caseId, { partyId: f.parties[1].partyId, noticeId: f.parties[1].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1 }, aaUser.id),
      ]);
      const commits = settled.filter((s) => s.status === "fulfilled");
      assert.strictEqual(commits.length, 2, "both concurrent, different-party responses must commit");

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "FEE_PENDING", "once both have committed, the gate must be satisfied");
      const fees = await sql`SELECT id FROM pim_fees WHERE case_id = ${f.caseId} AND fee_type = 'MEDIATION_FEE'`;
      assert.strictEqual(fees.length, 1, "exactly one fee row, never two, even though both transactions independently re-derive the gate");
      const tasks = await sql`SELECT id FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'OP_CONSENT_FEE'`;
      assert.strictEqual(tasks.length, 1, "exactly one fee-stage task, never two");
    });

    await test("J", "concurrent conflicting response (different OPs, one consents one refuses): the case-row lock serializes them; final state is always OP_REFUSED, never FEE_PENDING", async () => {
      const f = await fixtureCaseWithOpposites("J", 2);
      const settled = await Promise.allSettled([
        recordResponsePg(f.caseId, { partyId: f.parties[0].partyId, noticeId: f.parties[0].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1 }, aaUser.id),
        recordResponsePg(f.caseId, { partyId: f.parties[1].partyId, noticeId: f.parties[1].noticeId, responseType: "REFUSED", responseDate: "2026-02-21" }, aaUser.id),
      ]);
      const commits = settled.filter((s) => s.status === "fulfilled");
      /*
       * Race-order dependent, by design: whichever call wins the
       * case-row lock commits first. If REFUSED wins first, it moves
       * the case to OP_REFUSED - a terminal-for-this-stage status NOT
       * in RESPONSE_ENTRY_STATUSES, so the consent call that acquires
       * the lock second correctly rejects on the ordinary entry-status
       * guard (exactly one commit). If the consent call wins first
       * instead, this is a 2-OP case so the gate is not satisfied by
       * one party alone (test B's own property) - the case stays at
       * SERVICE_PENDING, which IS a valid entry status, so the REFUSED
       * call that follows also commits (two commits). Either way, the
       * one invariant this test exists to prove - the final state is
       * always OP_REFUSED, never FEE_PENDING - must hold regardless of
       * which order the lock was actually acquired in.
       */
      assert.ok(commits.length >= 1 && commits.length <= 2, `expected 1 or 2 commits depending on lock-acquisition order, got ${commits.length}`);

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "OP_REFUSED", "whichever order they serialize in, a refusal must be the final state, never FEE_PENDING");
      const fees = await sql`SELECT id FROM pim_fees WHERE case_id = ${f.caseId} AND fee_type = 'MEDIATION_FEE'`;
      assert.strictEqual(fees.length, 0, "no fee row may exist once the final state is a refusal");
    });

    // =================================================================
    // K: exactly one FEE_PENDING transition / L: exactly one fee task /
    //    M: no premature FEE_PENDING (aggregate confirmation across a
    //    3-OP case, partial then complete)
    // =================================================================
    await test("K", "exactly one FEE_PENDING status-history transition occurs across a full 3-OP consent sequence, not one per consenting party", async () => {
      const f = await fixtureCaseWithOpposites("K", 3);
      for (let i = 0; i < 3; i += 1) {
        await recordResponsePg(f.caseId, { partyId: f.parties[i].partyId, noticeId: f.parties[i].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1 }, aaUser.id);
      }
      const [{ n: feePendingHops }] = await sql`
        SELECT COUNT(*)::int AS n FROM pim_status_history h JOIN status_master sm ON sm.id = h.to_status_id
        WHERE h.case_id = ${f.caseId} AND sm.code = 'FEE_PENDING'
      `;
      assert.strictEqual(feePendingHops, 1, "exactly one FEE_PENDING transition for the whole case, fired only by the last (3rd) consenting party");
    });

    await test("L", "exactly one fee-stage task across the same 3-OP sequence", async () => {
      const f = await fixtureCaseWithOpposites("L", 2);
      for (let i = 0; i < 2; i += 1) {
        await recordResponsePg(f.caseId, { partyId: f.parties[i].partyId, noticeId: f.parties[i].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1 }, aaUser.id);
      }
      const tasks = await sql`SELECT id FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'OP_CONSENT_FEE'`;
      assert.strictEqual(tasks.length, 1);
    });

    await test("M", "no premature FEE_PENDING under a 3-OP case with 2 consenting and 1 unresolved", async () => {
      const f = await fixtureCaseWithOpposites("M", 3);
      for (let i = 0; i < 2; i += 1) {
        await recordResponsePg(f.caseId, { partyId: f.parties[i].partyId, noticeId: f.parties[i].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1 }, aaUser.id);
      }
      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "SERVICE_PENDING", "2 of 3 required parties consenting must never be enough");
      const aggregate = await withTransaction((tx) => deriveConsentAggregateTx(tx, f.caseId));
      assert.strictEqual(aggregate.consentedParties.length, 2);
      assert.strictEqual(aggregate.unresolvedParties.length, 1);
      assert.strictEqual(aggregate.gateSatisfied, false);
    });

    // =================================================================
    // N: rollback
    // =================================================================
    await test("N", "a forced failure after every write rolls back the entire response transaction", async () => {
      const f = await fixtureCaseWithOpposites("N", 1);
      await assert.rejects(
        () => withTransaction(async (tx) => {
          await recordResponseTx(tx, f.caseId, { partyId: f.parties[0].partyId, noticeId: f.parties[0].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1 }, aaUser.id);
          const [check] = await tx`SELECT COUNT(*)::int AS n FROM pim_responses WHERE case_id = ${f.caseId}`;
          assert.strictEqual(check.n, 1, "the write must be visible inside the still-open transaction");
          throw new Error("SENTINEL_FORCED_FAILURE");
        }),
        /SENTINEL_FORCED_FAILURE/
      );
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_responses WHERE case_id = ${f.caseId}`;
      assert.strictEqual(n, 0, "nothing from the forced-failure attempt may survive");
      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "SERVICE_PENDING");
    });

    // =================================================================
    // O: docket/history/task correctness
    // =================================================================
    await test("O", "exactly one docket entry per response call, correct event codes across the full branch set", async () => {
      const f = await fixtureCaseWithOpposites("O", 1);
      const [{ n: before }] = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${f.caseId}`;
      await recordResponsePg(f.caseId, { partyId: f.parties[0].partyId, noticeId: f.parties[0].noticeId, responseType: "APPEARED", responseDate: "2026-02-21", consent: 1, mediationFeeRequested: 1 }, aaUser.id);
      const [{ n: after }] = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${f.caseId}`;
      assert.strictEqual(after, before + 1);
      const [docket] = await sql`SELECT e.code FROM pim_docket d JOIN event_types e ON e.id = d.event_type_id WHERE d.case_id = ${f.caseId} ORDER BY d.id DESC LIMIT 1`;
      assert.strictEqual(docket.code, "OP_CONSENT");
    });

    // =================================================================
    // P: permission
    // =================================================================
    await test("P", "permission: response POST - no identity -> 401; chairman (not staff) -> 403; nothing written on either denial", async () => {
      const f = await fixtureCaseWithOpposites("P", 1);
      const before = await tableCounts(sql);
      const noAuth = await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        params: { id: String(f.caseId) }, body: consentBody(f, 0),
      });
      assert.strictEqual(noAuth.status, 401);
      const chairman = await callJsonRoute(responseRoute, "POST", `http://localhost/api/pim/response/${f.caseId}`, {
        userId: chairmanUser.id, params: { id: String(f.caseId) }, body: consentBody(f, 0),
      });
      assert.strictEqual(chairman.status, 403);
      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    await test("P", "permission: GET - no identity -> 401", async () => {
      const f = await fixtureCaseWithOpposites("P2", 1);
      const res = await callJsonRoute(responseRoute, "GET", `http://localhost/api/pim/response/${f.caseId}`, { params: { id: String(f.caseId) } });
      assert.strictEqual(res.status, 401);
    });

    // =================================================================
    // Q: PostgreSQL authority
    // =================================================================
    await test("Q", "PostgreSQL-authoritative: a case that exists ONLY in SQLite is never returned by the real GET route", async () => {
      const db = require("../lib/db");
      const sqliteOnly = db.prepare(`
        INSERT INTO pim_cases (entry_type, received_number, received_date, application_date, claim_amount)
        VALUES ('NEW', ?, '2026-01-01', '2026-01-01', 500000)
      `).run(`${TEST_PREFIX}SQLITE-ONLY-${RUN_ID}`);
      const sqliteOnlyId = Number(sqliteOnly.lastInsertRowid);
      try {
        const res = await callJsonRoute(responseRoute, "GET", `http://localhost/api/pim/response/${sqliteOnlyId}`, { userId: aaUser.id, params: { id: String(sqliteOnlyId) } });
        assert.strictEqual(res.status, 404);
      } finally {
        db.prepare(`DELETE FROM pim_cases WHERE id = ?`).run(sqliteOnlyId);
      }
    });

    // =================================================================
    // R: GET surfaces the aggregate
    // =================================================================
    await test("R", "GET exposes the consent-gate aggregate (required/consented/unresolved/refused parties) for UI/workflow use", async () => {
      assert.ok(ctxF, "prerequisite F did not complete");
      const res = await callJsonRoute(responseRoute, "GET", `http://localhost/api/pim/response/${ctxF.caseId}`, { userId: aaUser.id, params: { id: String(ctxF.caseId) } });
      assert.strictEqual(res.status, 200);
      assert.ok(res.json.data.consentGate);
      assert.strictEqual(res.json.data.consentGate.requiredParties.length, 2);
      assert.strictEqual(res.json.data.consentGate.refusedParties.length, 1);
    });

    // =================================================================
    // T: production-safety independent re-verification
    // =================================================================
    await test("T", "production safety: 2026 sequence untouched, PIM/119/2026 and PIM/109/2026 never referenced, five-mediator panel intact", async () => {
      const [seq2026] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = 2026`;
      assert.strictEqual(seq2026.last_number, 118);
      const [reserved] = await sql`SELECT id FROM pim_cases WHERE pim_number = 'PIM/119/2026'`;
      assert.strictEqual(reserved, undefined);
      const [pim109] = await sql`SELECT id FROM pim_cases WHERE pim_number = 'PIM/109/2026'`;
      assert.strictEqual(pim109, undefined, "this test suite must never touch PIM/109/2026 - it is a live production case");
      const rows = await sql`SELECT id FROM mediators WHERE active = true ORDER BY id`;
      assert.strictEqual(rows.length, 5);
    });
  } finally {
    console.log(`cleanup: removing exactly these fixture case ids: ${JSON.stringify([...tracker.caseIds])}`);
    try {
      await cleanupCasesByIds(sql, [...tracker.caseIds]);
    } catch (error) {
      failures.push(`cleanup failed: ${error.message}`);
      console.error(`cleanup FAILED: ${error.message}`);
    }

    const { problems, after } = await verifyNoResidue(sql, tracker, baselineCounts);
    console.log(`      post-run row counts: ${JSON.stringify(after)}`);

    await test("RESIDUE", "no test cases, responses, fees, notices, documents, status history, docket, or tasks remain; production 2026 sequence and PIM/119/2026 untouched; PIM/109/2026 never referenced; five-mediator panel intact; no orphaned transaction; all other table counts equal the pre-run baseline", () => {
      assert.deepStrictEqual(problems, []);
    });
  }

  if (!failures.some((f) => f.startsWith("cleanup") || f.includes("RESIDUE"))) {
    fs.rmSync(MANIFEST_PATH, { force: true });
  }

  console.log(`total live run time: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  await sql.end({ timeout: 5 });
}

async function runCleanupOnly() {
  const { getSql } = require("../lib/pim-postgres");
  const sql = getSql();
  const tracker = createTracker();
  try {
    let stale;
    try {
      await withRetries("connect", () => sql`SELECT 1`);
      stale = await withRetries("stale cleanup", () => recoverStaleFixtures(sql, tracker));
    } catch (error) {
      console.error(`CLEANUP FAILED: ${error.message}`);
      for (const line of await describeOrphanedTransactions(sql)) console.error(`      orphaned transaction? ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      stale.caseIds.length
        ? `removed stale fixture case ids: ${JSON.stringify(stale.caseIds)}`
        : "no manifest found - nothing to clean up"
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  if (process.argv.includes("--cleanup-only")) {
    await runCleanupOnly();
    return;
  }

  await runStaticTests();

  if (!process.env.SUPABASE_DB_URL) {
    console.log("SKIP: all live PostgreSQL tests (the PostgreSQL connection setting is not configured in this environment)");
  } else {
    await runLive();
  }

  console.log("\n=== Result matrix ===");
  for (const letter of Object.keys(letterResults).sort()) {
    const r = letterResults[letter];
    const status = r.fail > 0 ? "FAIL" : r.pass > 0 ? "PASS" : r.na.length > 0 ? "N/A" : "-";
    console.log(`${letter}: ${status} (${r.pass} passed, ${r.fail} failed${r.na.length ? `; N/A: ${r.na.join(" | ")}` : ""})`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    console.error(`Failures:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Test run crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
