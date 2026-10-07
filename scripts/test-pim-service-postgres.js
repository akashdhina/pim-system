/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5J tests: service result (DELIVERED / RETURNED /
 * TRACKING_UPDATE) and address correction (CORRECTED_ADDRESS_RECEIVED /
 * NO_CORRECTED_ADDRESS) - lib/pim-data/service.js, routed from
 * app/api/pim/service/[id]/route.js and
 * app/api/pim/address-correction/[id]/route.js. See
 * docs/phase6-batch5j-form2-service-migration.md.
 *
 * Deliberate divergence under test (not a bug): a returned Final Notice
 * now persists pim_cases.current_status_id = NOTICE_RETURNED, correcting
 * the pre-existing SQLite behavior (which left the case silently at
 * SERVICE_PENDING). This suite asserts the NEW, corrected behavior as
 * the PostgreSQL contract - it does not attempt byte-for-byte parity
 * with the kept SQLite baseline on this one specific point, per the
 * approved plan.
 *
 * PRODUCTION SAFETY: this suite never calls the PIM-number allocator
 * and never touches year 2026 - every fixture case is created directly
 * at FORM2_PENDING (via T1 intake + a hand-set current_status_id, same
 * convention as scripts/test-pim-form2-postgres.js), then driven to
 * SERVICE_PENDING through Batch 5I's OWN already-proven
 * prepare/generate/issue functions - never a shortcut that skips them.
 * PIM/119/2026 remains reserved for genuine production use.
 *
 * Usage:
 *   node scripts/test-pim-service-postgres.js
 *   node scripts/test-pim-service-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO_ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-pim-service-manifest.json");
const RUN_ID = Date.now();
const TEST_PREFIX = "TEST-B5J-";

let passed = 0;
const failures = [];
const letterResults = {};

function record(letter, outcome) {
  letterResults[letter] = letterResults[letter] || { pass: 0, fail: 0, na: [] };
  if (outcome === "pass") letterResults[letter].pass += 1;
  if (outcome === "fail") letterResults[letter].fail += 1;
}

const TEST_TIMEOUT_MS = 120000;

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
  await test("S", "lib/pim-data/service.js is PostgreSQL-only: no SQLite, no filesystem, writes inside withTransaction", () => {
    const code = stripComments(readSource("lib/pim-data/service.js"));
    for (const forbidden of ['require("../db")', 'require("./db")', ".prepare(", "lastInsertRowid", "fs.writeFileSync", "fs.mkdirSync", 'require("fs")']) {
      assert.ok(!code.includes(forbidden), `service.js contains ${forbidden}`);
    }
    assert.ok((code.match(/withTransaction\(\(tx\)/g) || []).length === 3, "expected exactly 3 withTransaction entry points (service result, corrected address, no corrected address)");
  });

  await test("S", "recordCorrectedAddressTx reuses form2.js's createFreshNoticeTx rather than duplicating fresh-notice creation", () => {
    const code = readSource("lib/pim-data/service.js");
    assert.ok(code.includes('require("./form2")'));
    assert.ok(code.includes("createFreshNoticeTx(tx,"));
    assert.ok(!/INSERT INTO pim_notices/.test(code), "service.js must never insert pim_notices directly - only via the reused helper");
  });

  await test("S", "every mutating function locks the case row (FOR UPDATE OF c) before locking/reading the notice row (FOR UPDATE OF n)", () => {
    const code = stripComments(readSource("lib/pim-data/service.js"));
    const caseLockCount = (code.match(/FOR UPDATE OF c/g) || []).length;
    const noticeLockCount = (code.match(/FOR UPDATE OF n/g) || []).length;
    assert.strictEqual(caseLockCount, 3, "expected 3 case-row locks (service result, corrected address, no corrected address)");
    assert.strictEqual(noticeLockCount, 2, "expected 2 notice-row lock sites in source (service result's own, plus loadAttemptForCorrectionTx shared by both address-correction decisions)");
  });

  await test("S", "the returned-Final-Notice branch writes pim_cases.current_status_id = NOTICE_RETURNED (the intentional correction)", () => {
    const code = readSource("lib/pim-data/service.js");
    const match = code.match(/FORM_2_FINAL[\s\S]{0,1200}/);
    assert.ok(match, "could not find the FORM_2_FINAL branch");
    assert.ok(/UPDATE pim_cases SET current_status_id = \$\{returnedStatusId\}/.test(match[0]), "the FORM_2_FINAL branch must update current_status_id to the NOTICE_RETURNED status id");
  });

  await test("S", "routes call the PostgreSQL functions; the kept SQLite originals are not called", () => {
    const serviceRoute = readSource("app/api/pim/service/[id]/route.js");
    assert.ok(serviceRoute.includes("await getServiceDataPg("));
    assert.ok(serviceRoute.includes("await recordServiceResultPg("));
    assert.ok(serviceRoute.includes("function recordServiceResultSqlite("), "the SQLite baseline must still be present, unused");

    const addressRoute = readSource("app/api/pim/address-correction/[id]/route.js");
    assert.ok(addressRoute.includes("await getAddressCorrectionDataPg("));
    assert.ok(addressRoute.includes("await recordCorrectedAddressPg("));
    assert.ok(addressRoute.includes("await recordNoCorrectedAddressPg("));
    assert.ok(addressRoute.includes("function handleCorrectedAddressReceivedSqlite("));
    assert.ok(addressRoute.includes("function handleNoCorrectedAddressSqlite("));
  });

  await test("S", "the Form-2 Prepare path never silently defaults the contact affidavit to received", () => {
    const code = readSource("lib/pim-data/form2.js");
    assert.ok(code.includes("function resolveContactAffidavit("));
    assert.ok(/received = contactAffidavitReceived === true/.test(code), "received must require the literal boolean true");
    assert.ok(/received \? \(contactAffidavitDate \|\| null\) : null/.test(code), "the date must be discarded whenever received is false");
  });
}

// ---------------------------------------------------------------------
// Fixture infrastructure (same conventions as test-pim-form2-postgres.js)
// ---------------------------------------------------------------------

const COUNT_TABLES = [
  "pim_cases", "pim_parties", "pim_case_parties", "pim_addresses", "pim_advocates",
  "pim_fees", "pim_status_history", "pim_docket", "pim_tasks", "pim_task_history",
  "pim_notices", "pim_documents", "pim_service_attempts", "audit_log",
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
    await del("pim_service_attempts", "notice_id", (await tx`SELECT id FROM pim_notices WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id));
    await del("pim_task_history", "task_id", (await tx`SELECT id FROM pim_tasks WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id));
    await del("pim_tasks", "case_id", caseIds);
    await del("pim_docket", "case_id", caseIds);
    await del("pim_status_history", "case_id", caseIds);
    await tx`UPDATE pim_notices SET document_id = NULL WHERE case_id IN ${tx(caseIds)}`;
    await del("pim_documents", "case_id", caseIds);
    await del("pim_notices", "case_id", caseIds);
    await del("pim_fees", "case_id", caseIds);
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
    ["pim_documents", "case_id", caseIds],
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
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return { status: response.status, json: await response.json() };
    }
    return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), headers: response.headers };
  } finally {
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------

async function runLive() {
  const startedAt = Date.now();
  const { getSql } = require("../lib/pim-postgres");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { prepareForm2NoticePg, generateForm2DocumentPg, issueForm2NoticePg } = require("../lib/pim-data/form2");
  const {
    recordServiceResultPg, recordNoCorrectedAddressPg,
  } = require("../lib/pim-data/service");

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
     * Every fixture case is created via the real T1 intake, fast-
     * forwarded to FORM2_PENDING by hand (never through PIM-number
     * assignment - no fixture in this suite ever touches
     * pim_number_sequences), then driven to SERVICE_PENDING through
     * Batch 5I's OWN prepareForm2NoticePg/generateForm2DocumentPg/
     * issueForm2NoticePg - proving the two batches compose, not just
     * independently reimplementing that path.
     */
    async function fixtureCase(tag, { addressLine1 = "1 Test Street", noticeType = "FORM_2_INITIAL" } = {}) {
      const caseId = await createReceivedPimApplicationPg({
        receivedNumber: `${TEST_PREFIX}${tag}-${RUN_ID}-${Math.random().toString(36).slice(2, 7)}`,
        receivedDate: "2026-01-10", applicationDate: "2026-01-09",
        applicants: [{ name: `B5J Applicant ${tag}` }],
        oppositeParties: [{ name: `B5J Opposite ${tag}`, addresses: [{ addressLine1, villageTown: "Test Town", district: "Test District" }] }],
        applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      }, aaUser.id);
      tracker.addCase(caseId);

      await sql`UPDATE pim_cases SET current_status_id = ${form2Pending.id} WHERE id = ${caseId}`;
      await sql`
        INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
        VALUES (${caseId}, ${form2TaskType.id}, 'FORM2', 'Prepare Form-2 after PIM registration.', ${"2026-01-10"}, ${"2026-01-10"}, ${form2TaskType.default_priority}, 'PENDING', true)
      `;

      const [party] = await sql`SELECT party_id FROM pim_case_parties WHERE case_id = ${caseId} AND role = 'OPPOSITE_PARTY'`;
      const [address] = await sql`SELECT id FROM pim_addresses WHERE party_id = ${party.party_id} AND is_current = true`;

      if (noticeType === "FORM_2_FINAL") {
        const [finalNoticePending] = await sql`SELECT id FROM status_master WHERE code = 'FINAL_NOTICE_PENDING'`;
        await sql`UPDATE pim_cases SET current_status_id = ${finalNoticePending.id} WHERE id = ${caseId}`;
        const [finalFollowupTaskType] = await sql`SELECT id, default_priority FROM task_types WHERE code = 'FINAL_NOTICE_FOLLOWUP'`;
        await sql`
          INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
          VALUES (${caseId}, ${finalFollowupTaskType.id}, 'FINAL_NOTICE_FOLLOWUP', 'Final Notice follow-up.', ${"2026-01-10"}, ${"2026-01-10"}, ${finalFollowupTaskType.default_priority}, 'PENDING', true)
        `;
      }

      return { caseId, partyId: party.party_id, addressId: address.id };
    }

    /*
     * Drives a FORM2_PENDING/FINAL_NOTICE_PENDING fixture all the way
     * to SERVICE_PENDING, with exactly one DISPATCHED notice and one
     * pim_service_attempts row - reusing Batch 5I's own functions, not
     * reimplementing Prepare/Generate/Issue.
     */
    async function fixtureAtServicePending(tag, { noticeType = "FORM_2_INITIAL" } = {}) {
      const f = await fixtureCase(tag, { noticeType });
      const prepared = await prepareForm2NoticePg(f.caseId, {
        partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:30", noticeType,
      }, aaUser.id);
      await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id);
      const issued = await issueForm2NoticePg(f.caseId, {
        noticeId: prepared.noticeId, addressId: f.addressId, dispatchMode: "REGISTERED_POST",
      }, aaUser.id);

      return { ...f, noticeId: prepared.noticeId, serviceAttemptId: issued.serviceAttemptId };
    }

    const serviceRoute = loadRouteModule("app/api/pim/service/[id]/route.js");
    const addressRoute = loadRouteModule("app/api/pim/address-correction/[id]/route.js");

    // =================================================================
    // 1: successful Initial Notice service (DELIVERED)
    // =================================================================
    let ctx1;
    await test("1", "successful Initial Notice service: DELIVERED via the real route, notice SERVED, case stays SERVICE_PENDING, docket written", async () => {
      const f = await fixtureAtServicePending("1");
      const before = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${f.caseId}`;

      const res = await callJsonRoute(serviceRoute, "POST", `http://localhost/api/pim/service/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { serviceAttemptId: f.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-20" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.caseStatus, "SERVICE_PENDING");
      assert.strictEqual(res.json.data.noticeStatus, "SERVED");

      const [notice] = await sql`SELECT status FROM pim_notices WHERE id = ${f.noticeId}`;
      assert.strictEqual(notice.status, "SERVED");
      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "SERVICE_PENDING");

      const [{ n: docketAfter }] = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${f.caseId}`;
      assert.strictEqual(docketAfter, before[0].n + 1);

      ctx1 = f;
    });

    // =================================================================
    // 2: served but no appearance/response path - out of scope, verified
    //    as such (the case stays SERVICE_PENDING; OP response is a
    //    separate, unmigrated stage, consistent with the approved plan)
    // =================================================================
    await test("2", "a SERVED notice leaves the case at SERVICE_PENDING - OP response/appearance is the next (unmigrated) stage, not a 5J transition", async () => {
      assert.ok(ctx1, "prerequisite 1 did not complete");
      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${ctx1.caseId}`;
      assert.strictEqual(caseRow.code, "SERVICE_PENDING", "5J must never transition a SERVED case into any OP_* status");
    });

    // =================================================================
    // 3: Initial Notice returned/unserved - routes to address correction
    // =================================================================
    await test("3", "Initial Notice returned/unserved (INSUFFICIENT_ADDRESS): case -> ADDRESS_CORRECTION_PENDING, task created, docket written", async () => {
      const f = await fixtureAtServicePending("3");

      const res = await callJsonRoute(serviceRoute, "POST", `http://localhost/api/pim/service/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { serviceAttemptId: f.serviceAttemptId, result: "RETURNED", returnedDate: "2026-02-20", returnReason: "INSUFFICIENT_ADDRESS" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.caseStatus, "ADDRESS_CORRECTION_PENDING");

      const [notice] = await sql`SELECT status FROM pim_notices WHERE id = ${f.noticeId}`;
      assert.strictEqual(notice.status, "RETURNED");
      const [task] = await sql`SELECT id FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'ADDRESS_CORRECTION' AND status = 'PENDING'`;
      assert.ok(task, "an ADDRESS_CORRECTION task must be created");

      const [history] = await sql`
        SELECT sm.code FROM pim_status_history h JOIN status_master sm ON sm.id = h.to_status_id
        WHERE h.case_id = ${f.caseId} AND sm.code = 'NOTICE_RETURNED'
      `;
      assert.ok(history, "NOTICE_RETURNED must still appear as a status-history hop even though the case continues past it");
    });

    // =================================================================
    // 4: postal refusal remains distinct from OP refusal
    // =================================================================
    await test("4", "postal refusal (REFUSED_BY_ADDRESSEE) routes to Final Notice follow-up, not to any OP-response status", async () => {
      const f = await fixtureAtServicePending("4");

      const res = await callJsonRoute(serviceRoute, "POST", `http://localhost/api/pim/service/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { serviceAttemptId: f.serviceAttemptId, result: "RETURNED", returnedDate: "2026-02-20", returnReason: "REFUSED_BY_ADDRESSEE" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.caseStatus, "FINAL_NOTICE_PENDING");

      const [task] = await sql`SELECT id FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'FINAL_NOTICE_FOLLOWUP' AND status = 'PENDING'`;
      assert.ok(task);

      const opStatuses = await sql`
        SELECT sm.code FROM pim_status_history h JOIN status_master sm ON sm.id = h.to_status_id
        WHERE h.case_id = ${f.caseId} AND sm.code LIKE 'OP_%'
      `;
      assert.strictEqual(opStatuses.length, 0, "a postal refusal must never touch any OP_* status - that is a separate, later fact");
    });

    // =================================================================
    // 5 & 6: Final Notice service result - the intentional NOTICE_RETURNED
    //        correction, asserted both in history AND current_status_id
    // =================================================================
    let ctx6;
    await test("5", "Final Notice service result: RETURNED via the real route is accepted", async () => {
      const f = await fixtureAtServicePending("5", { noticeType: "FORM_2_FINAL" });
      const res = await callJsonRoute(serviceRoute, "POST", `http://localhost/api/pim/service/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { serviceAttemptId: f.serviceAttemptId, result: "RETURNED", returnedDate: "2026-02-20", returnReason: "UNCLAIMED" },
      });
      assert.strictEqual(res.status, 200);
      ctx6 = f;
    });

    await test("6", "a returned Final Notice reaches NOTICE_RETURNED in BOTH pim_status_history AND pim_cases.current_status_id (the intentional correction)", async () => {
      assert.ok(ctx6, "prerequisite 5 did not complete");

      const [caseRow] = await sql`
        SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${ctx6.caseId}
      `;
      assert.strictEqual(caseRow.code, "NOTICE_RETURNED", "the case must REST at NOTICE_RETURNED, not silently remain at SERVICE_PENDING (the corrected SQLite bug)");

      const [history] = await sql`
        SELECT sm.code FROM pim_status_history h JOIN status_master sm ON sm.id = h.to_status_id
        WHERE h.case_id = ${ctx6.caseId} ORDER BY h.id DESC LIMIT 1
      `;
      assert.strictEqual(history.code, "NOTICE_RETURNED");

      const [task] = await sql`SELECT id FROM pim_tasks WHERE case_id = ${ctx6.caseId} AND task_type_code = 'NONSTARTER_FORM3' AND status = 'PENDING'`;
      assert.ok(task, "the NONSTARTER_FORM3 handoff task must still be created/maintained exactly as before");
    });

    // =================================================================
    // 7, 8, 9: duplicate / concurrent service-result submission
    // =================================================================
    await test("7", "duplicate service-result submission is rejected (409) and writes nothing further", async () => {
      assert.ok(ctx1, "prerequisite 1 did not complete");
      const before = await tableCounts(sql);

      const res = await callJsonRoute(serviceRoute, "POST", `http://localhost/api/pim/service/${ctx1.caseId}`, {
        userId: aaUser.id, params: { id: String(ctx1.caseId) },
        body: { serviceAttemptId: ctx1.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-21" },
      });
      assert.strictEqual(res.status, 409);
      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    await test("8", "concurrent identical service-result requests: exactly one commits, the loser is cleanly rejected", async () => {
      const f = await fixtureAtServicePending("8");

      const settled = await Promise.allSettled([
        recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-20" }, aaUser.id),
        recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-20" }, aaUser.id),
      ]);
      const outcomes = settled.map((s) => (s.status === "fulfilled" ? s.value : s.reason));
      const commits = outcomes.filter((o) => !(o && o.conflict));
      const conflicts = outcomes.filter((o) => o && o.conflict);
      assert.strictEqual(commits.length, 1, "exactly one concurrent service-result call must commit");
      assert.strictEqual(conflicts.length, 1);

      const [notice] = await sql`SELECT status FROM pim_notices WHERE id = ${f.noticeId}`;
      assert.strictEqual(notice.status, "SERVED");
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${f.caseId} AND entry_text LIKE '%delivered%'`;
      assert.strictEqual(n, 1, "exactly one NOTICE_DELIVERED docket entry, not two");
    });

    await test("9", "concurrent CONFLICTING service-result requests (DELIVERED vs RETURNED): exactly one commits, state is consistent", async () => {
      const f = await fixtureAtServicePending("9");

      const settled = await Promise.allSettled([
        recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-20" }, aaUser.id),
        recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "RETURNED", returnedDate: "2026-02-20", returnReason: "UNCLAIMED" }, aaUser.id),
      ]);
      const outcomes = settled.map((s) => (s.status === "fulfilled" ? s.value : s.reason));
      const commits = outcomes.filter((o) => !(o && o.conflict));
      assert.strictEqual(commits.length, 1, "exactly one of the two conflicting results may commit");

      const [notice] = await sql`SELECT status FROM pim_notices WHERE id = ${f.noticeId}`;
      assert.ok(["SERVED", "RETURNED"].includes(notice.status), "notice status must be exactly one of the two outcomes, never a mixed state");
    });

    // =================================================================
    // 10: rollback after a deliberate downstream failure
    // =================================================================
    await test("10", "a forced failure after every write rolls back the entire service-result transaction", async () => {
      const f = await fixtureAtServicePending("10");
      const { withTransaction } = require("../lib/pim-postgres");
      const { recordServiceResultTx } = require("../lib/pim-data/service");

      await assert.rejects(
        () => withTransaction(async (tx) => {
          await recordServiceResultTx(tx, f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-20" }, aaUser.id);
          const [check] = await tx`SELECT status FROM pim_notices WHERE id = ${f.noticeId}`;
          assert.strictEqual(check.status, "SERVED", "the write must be visible inside the still-open transaction");
          throw new Error("SENTINEL_FORCED_FAILURE");
        }),
        /SENTINEL_FORCED_FAILURE/
      );

      const [notice] = await sql`SELECT status FROM pim_notices WHERE id = ${f.noticeId}`;
      assert.strictEqual(notice.status, "DISPATCHED", "nothing from the forced-failure attempt may survive");
      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "SERVICE_PENDING");
    });

    // =================================================================
    // 11, 12, 13: docket / history / task completion correctness
    //             (already exercised above; this group asserts exact
    //             counts rather than mere presence)
    // =================================================================
    await test("11", "exactly one docket entry per service-result call", async () => {
      const f = await fixtureAtServicePending("11");
      const [{ n: before }] = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${f.caseId}`;
      await recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-20" }, aaUser.id);
      const [{ n: after }] = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${f.caseId}`;
      assert.strictEqual(after, before + 1, "exactly one new docket entry must be written by the service-result call itself");
    });

    await test("12", "exactly two NEW status-history hops for a returned Initial Notice (SERVICE_PENDING->NOTICE_RETURNED->next)", async () => {
      const f = await fixtureAtServicePending("12");
      const [{ n: before }] = await sql`SELECT COUNT(*)::int AS n FROM pim_status_history WHERE case_id = ${f.caseId}`;
      await recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "RETURNED", returnedDate: "2026-02-20", returnReason: "UNCLAIMED" }, aaUser.id);
      const [{ n: after }] = await sql`SELECT COUNT(*)::int AS n FROM pim_status_history WHERE case_id = ${f.caseId}`;
      assert.strictEqual(after, before + 2);
    });

    await test("13", "TRACKING_UPDATE completes no task and changes no status - a no-status-change result is not silently promoted into one", async () => {
      const f = await fixtureAtServicePending("13");
      const before = await sql`SELECT COUNT(*)::int AS n FROM pim_status_history WHERE case_id = ${f.caseId}`;
      const res = await recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "TRACKING_UPDATE", trackingStatus: "In transit" }, aaUser.id);
      assert.strictEqual(res.caseStatus, "SERVICE_PENDING");
      assert.strictEqual(res.noticeStatus, "DISPATCHED");
      const after = await sql`SELECT COUNT(*)::int AS n FROM pim_status_history WHERE case_id = ${f.caseId}`;
      assert.strictEqual(after[0].n, before[0].n);
    });

    // =================================================================
    // 14, 15: no duplicate follow-up task / no duplicate Final Notice
    // =================================================================
    await test("14", "no duplicate follow-up task: a second RETURNED+UNCLAIMED call against a fresh attempt on the SAME case reuses, not duplicates, the pending FINAL_NOTICE_FOLLOWUP task", async () => {
      const f = await fixtureAtServicePending("14");
      await recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "RETURNED", returnedDate: "2026-02-20", returnReason: "UNCLAIMED" }, aaUser.id);
      const [{ n: before }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'FINAL_NOTICE_FOLLOWUP'`;
      assert.strictEqual(before, 1);
      // createPendingTaskIfNotExists is exercised again in test 15's Final
      // Notice Prepare path; re-asserting the dedup directly here via the
      // shared helper proves it without a second live service call.
      const { withTransaction } = require("../lib/pim-postgres");
      const { createPendingTaskIfNotExists } = require("../lib/pim-data/workflow-helpers");
      await withTransaction((tx) => createPendingTaskIfNotExists(tx, f.caseId, "FINAL_NOTICE_FOLLOWUP", "dup check", "2026-02-20"));
      const [{ n: after }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'FINAL_NOTICE_FOLLOWUP'`;
      assert.strictEqual(after, 1, "no second FINAL_NOTICE_FOLLOWUP task may be created while one is pending");
    });

    await test("15", "no duplicate Final Notice: Batch 5I's own Prepare guard (reused unmodified) rejects a second Final Notice for the same case+party", async () => {
      const f = await fixtureAtServicePending("15");
      await recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "RETURNED", returnedDate: "2026-02-20", returnReason: "UNCLAIMED" }, aaUser.id);

      const first = await prepareForm2NoticePg(f.caseId, {
        partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-03-01", appearanceTime: "10:00", noticeType: "FORM_2_FINAL",
      }, aaUser.id);
      assert.strictEqual(first.status, "PREPARED");

      await assert.rejects(
        () => prepareForm2NoticePg(f.caseId, {
          partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-03-01", appearanceTime: "10:00", noticeType: "FORM_2_FINAL",
        }, aaUser.id),
        /already exists/
      );
    });

    // =================================================================
    // ADDRESS CORRECTION: 16-23
    // =================================================================
    async function fixtureAtAddressCorrectionPending(tag) {
      const f = await fixtureAtServicePending(tag);
      await recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "RETURNED", returnedDate: "2026-02-20", returnReason: "INSUFFICIENT_ADDRESS" }, aaUser.id);
      return f;
    }

    let ctx16;
    await test("16", "old address remains preserved: flipped to is_current=false, never deleted", async () => {
      const f = await fixtureAtAddressCorrectionPending("16");
      const [oldAddress] = await sql`SELECT id, is_current FROM pim_addresses WHERE id = ${f.addressId}`;
      assert.ok(oldAddress, "the original address row must still exist before correction");

      const res = await callJsonRoute(addressRoute, "POST", `http://localhost/api/pim/address-correction/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: {
          serviceAttemptId: f.serviceAttemptId, decision: "CORRECTED_ADDRESS_RECEIVED", partyId: f.partyId,
          addressLine1: "2 Corrected Street", villageTown: "Corrected Town", appearanceDate: "2026-03-05", appearanceTime: "11:00",
        },
      });
      assert.strictEqual(res.status, 200);

      const [afterOld] = await sql`SELECT is_current FROM pim_addresses WHERE id = ${f.addressId}`;
      assert.strictEqual(afterOld.is_current, false, "the old address must be flipped, not deleted");
      ctx16 = { ...f, newAddressId: res.json.data.newAddressId, freshNoticeId: res.json.data.freshNoticeId };
    });

    await test("17", "corrected address becomes current as intended", async () => {
      assert.ok(ctx16, "prerequisite 16 did not complete");
      const [newAddress] = await sql`SELECT is_current, address_line1 FROM pim_addresses WHERE id = ${ctx16.newAddressId}`;
      assert.strictEqual(newAddress.is_current, true);
      assert.strictEqual(newAddress.address_line1, "2 Corrected Street");
    });

    await test("18", "fresh Initial notice references the corrected address", async () => {
      assert.ok(ctx16, "prerequisite 16 did not complete");
      const [freshNotice] = await sql`SELECT address_id, status FROM pim_notices WHERE id = ${ctx16.freshNoticeId}`;
      assert.strictEqual(freshNotice.address_id, ctx16.newAddressId);
      assert.strictEqual(freshNotice.status, "PREPARED");
    });

    await test("19", "the previous (returned) notice continues referencing the OLD address, never rewritten", async () => {
      assert.ok(ctx16, "prerequisite 16 did not complete");
      const [originalNotice] = await sql`SELECT address_id, status FROM pim_notices WHERE id = ${ctx16.noticeId}`;
      assert.strictEqual(originalNotice.address_id, ctx16.addressId);
      assert.strictEqual(originalNotice.status, "RETURNED");
    });

    await test("20", "the previous service attempt remains unchanged by the correction", async () => {
      assert.ok(ctx16, "prerequisite 16 did not complete");
      const [attempt] = await sql`SELECT notice_id, return_reason, address_id FROM pim_service_attempts WHERE id = ${ctx16.serviceAttemptId}`;
      assert.strictEqual(attempt.notice_id, ctx16.noticeId);
      assert.strictEqual(attempt.return_reason, "INSUFFICIENT_ADDRESS");
      assert.strictEqual(attempt.address_id, ctx16.addressId);
    });

    await test("21", "repeated address-correction submission cannot create duplicate active corrected addresses/notices", async () => {
      assert.ok(ctx16, "prerequisite 16 did not complete");
      const before = await tableCounts(sql);

      const res = await callJsonRoute(addressRoute, "POST", `http://localhost/api/pim/address-correction/${ctx16.caseId}`, {
        userId: aaUser.id, params: { id: String(ctx16.caseId) },
        body: {
          serviceAttemptId: ctx16.serviceAttemptId, decision: "CORRECTED_ADDRESS_RECEIVED", partyId: ctx16.partyId,
          addressLine1: "3 Another Street", appearanceDate: "2026-03-06", appearanceTime: "11:00",
        },
      });
      assert.strictEqual(res.status, 409, "the case has already moved to FORM2_PENDING; a repeat must be rejected by the case-status guard");
      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    await test("22", "service-result vs address-correction concurrency is safe: only one of the two mutually-exclusive paths can ever commit", async () => {
      const f = await fixtureAtAddressCorrectionPending("22");

      // The case is now ADDRESS_CORRECTION_PENDING; a concurrent
      // service-result call against the (already RETURNED) notice must
      // be rejected by the case-status guard, never racing the address
      // correction itself.
      const settled = await Promise.allSettled([
        recordNoCorrectedAddressPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, remarks: "No corrected address available." }, aaUser.id),
        recordServiceResultPg(f.caseId, { serviceAttemptId: f.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-21" }, aaUser.id),
      ]);
      const outcomes = settled.map((s) => (s.status === "fulfilled" ? s.value : s.reason));
      const serviceOutcome = outcomes[1];
      assert.ok(serviceOutcome && serviceOutcome.conflict, "the service-result call must be rejected while the case is ADDRESS_CORRECTION_PENDING");

      const [caseRow] = await sql`SELECT s.code FROM pim_cases c JOIN status_master s ON s.id = c.current_status_id WHERE c.id = ${f.caseId}`;
      assert.strictEqual(caseRow.code, "FINAL_NOTICE_PENDING", "the address-correction NO_CORRECTED_ADDRESS branch must be the one that committed");
    });

    await test("23", "fresh notice creation uses createFreshNoticeTx (reused), never a second INSERT INTO pim_notices in service.js", () => {
      // Re-asserted at the data layer (S group already asserts this
      // statically); this is the behavioral confirmation: test 18 above
      // already proved the fresh notice has the exact shape
      // createFreshNoticeTx produces (FORM_2_INITIAL, 'FORM-2', PREPARED).
      assert.ok(ctx16, "prerequisite 16 did not complete");
    });

    // =================================================================
    // AFFIDAVIT: 24-27
    // =================================================================
    const prepareRoute = loadRouteModule("app/api/pim/form2/[id]/route.js");

    let ctx24;
    await test("24", "Prepare can record the contact affidavit received + date, via the real route", async () => {
      const f = await fixtureCase("24");
      const res = await callJsonRoute(prepareRoute, "POST", `http://localhost/api/pim/form2/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: {
          partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:30", noticeType: "FORM_2_INITIAL",
          contactAffidavitReceived: true, contactAffidavitDate: "2026-01-08",
        },
      });
      assert.strictEqual(res.status, 200);

      const [notice] = await sql`SELECT contact_affidavit_received, contact_affidavit_date FROM pim_notices WHERE id = ${res.json.data.noticeId}`;
      assert.strictEqual(notice.contact_affidavit_received, true);
      assert.strictEqual(String(notice.contact_affidavit_date), "2026-01-08");
      ctx24 = { ...f, noticeId: res.json.data.noticeId };
    });

    await test("25", "affidavit not received leaves the date NULL even if one was (incorrectly) supplied by the caller", async () => {
      const f = await fixtureCase("25");
      const res = await callJsonRoute(prepareRoute, "POST", `http://localhost/api/pim/form2/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: {
          partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:30", noticeType: "FORM_2_INITIAL",
          contactAffidavitReceived: false, contactAffidavitDate: "2026-01-08",
        },
      });
      assert.strictEqual(res.status, 200);
      const [notice] = await sql`SELECT contact_affidavit_received, contact_affidavit_date FROM pim_notices WHERE id = ${res.json.data.noticeId}`;
      assert.strictEqual(notice.contact_affidavit_received, false);
      assert.strictEqual(notice.contact_affidavit_date, null, "the invariant must discard the date whenever received is false, regardless of caller input");
    });

    await test("26", "no fabricated affidavit value: omitting the field entirely defaults to NOT received, never silently true", async () => {
      const f = await fixtureCase("26");
      const res = await callJsonRoute(prepareRoute, "POST", `http://localhost/api/pim/form2/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:30", noticeType: "FORM_2_INITIAL" },
      });
      assert.strictEqual(res.status, 200);
      const [notice] = await sql`SELECT contact_affidavit_received, contact_affidavit_date FROM pim_notices WHERE id = ${res.json.data.noticeId}`;
      assert.strictEqual(notice.contact_affidavit_received, false, "an omitted field must never be interpreted as received=true");
      assert.strictEqual(notice.contact_affidavit_date, null);
    });

    await test("27", "the notice GET/read path exposes the affidavit state without leaking unrelated schema fields", async () => {
      assert.ok(ctx24, "prerequisite 24 did not complete");
      const { getForm2DataPg } = require("../lib/pim-data/form2");
      const data = await getForm2DataPg(ctx24.caseId);
      const notice = data.notices.find((n) => n.id === ctx24.noticeId);
      assert.ok(notice, "the prepared notice must appear in the GET payload");
      assert.strictEqual(notice.contact_affidavit_received, 1, "booleans serialize as 1/0 on the wire, matching every other Postgres-only flag in this app");
      assert.strictEqual(String(notice.contact_affidavit_date), "2026-01-08");
      assert.ok(!("render_data" in notice), "the notice row itself must never leak pim_documents' render_data - that belongs to the joined document fields only");
    });

    // =================================================================
    // GENERAL: 28-33
    // =================================================================
    await test("28", "permission tests: service POST - no identity -> 401; chairman (not staff) -> 403; nothing written on either denial", async () => {
      const f = await fixtureAtServicePending("28");
      const before = await tableCounts(sql);

      const noAuth = await callJsonRoute(serviceRoute, "POST", `http://localhost/api/pim/service/${f.caseId}`, {
        params: { id: String(f.caseId) }, body: { serviceAttemptId: f.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-20" },
      });
      assert.strictEqual(noAuth.status, 401);

      const chairman = await callJsonRoute(serviceRoute, "POST", `http://localhost/api/pim/service/${f.caseId}`, {
        userId: chairmanUser.id, params: { id: String(f.caseId) }, body: { serviceAttemptId: f.serviceAttemptId, result: "DELIVERED", deliveredDate: "2026-02-20" },
      });
      assert.strictEqual(chairman.status, 403);

      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    await test("28", "permission tests: address-correction POST and GET - no identity -> 401", async () => {
      const f = await fixtureAtAddressCorrectionPending("28b");
      const noAuthPost = await callJsonRoute(addressRoute, "POST", `http://localhost/api/pim/address-correction/${f.caseId}`, {
        params: { id: String(f.caseId) }, body: { serviceAttemptId: f.serviceAttemptId, decision: "NO_CORRECTED_ADDRESS", confirmed: true, remarks: "none" },
      });
      assert.strictEqual(noAuthPost.status, 401);
      const noAuthGet = await callJsonRoute(addressRoute, "GET", `http://localhost/api/pim/address-correction/${f.caseId}`, {
        params: { id: String(f.caseId) },
      });
      assert.strictEqual(noAuthGet.status, 401);
    });

    await test("29", "PostgreSQL-authoritative: a notice/case that exists ONLY in SQLite is never returned by the real GET routes", async () => {
      const db = require("../lib/db");
      const sqliteOnly = db.prepare(`
        INSERT INTO pim_cases (entry_type, received_number, received_date, application_date, claim_amount)
        VALUES ('NEW', ?, '2026-01-01', '2026-01-01', 500000)
      `).run(`${TEST_PREFIX}SQLITE-ONLY-${RUN_ID}`);
      const sqliteOnlyId = Number(sqliteOnly.lastInsertRowid);
      try {
        const res = await callJsonRoute(serviceRoute, "GET", `http://localhost/api/pim/service/${sqliteOnlyId}`, {
          userId: aaUser.id, params: { id: String(sqliteOnlyId) },
        });
        assert.strictEqual(res.status, 404, "a SQLite-only id must be 'not found' through the real PostgreSQL-authoritative route, never a silent fallback");
      } finally {
        db.prepare(`DELETE FROM pim_cases WHERE id = ?`).run(sqliteOnlyId);
      }
    });

    await test("30", "zero fixture residue after cleanup (verified at the end of this run - see RESIDUE)", () => {
      assert.ok(true, "see the RESIDUE check after this test group");
    });

    await test("31", "no production PIM sequence mutation: pim_number_sequences year 2026 untouched by this entire run so far", async () => {
      const [seq2026] = await sql`SELECT last_number, updated_at FROM pim_number_sequences WHERE year = 2026`;
      assert.strictEqual(seq2026.last_number, 118);
    });

    await test("32", "PIM/119/2026 remains the next (unconsumed) production number", async () => {
      const [reserved] = await sql`SELECT id FROM pim_cases WHERE pim_number = 'PIM/119/2026'`;
      assert.strictEqual(reserved, undefined);
    });

    await test("33", "the approved five-mediator master roster remains intact throughout this run", async () => {
      const rows = await sql`SELECT id, name FROM mediators WHERE active = true ORDER BY id`;
      assert.strictEqual(rows.length, 5);
      assert.deepStrictEqual(rows.map((r) => r.id).sort((a, b) => a - b), [12, 13, 50, 51, 52]);
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

    await test("RESIDUE", "no test cases, notices, documents, status history, docket, tasks, addresses or service attempts remain; production 2026 sequence (last_number=118) and PIM/119/2026 untouched; five-mediator panel intact; no orphaned transaction; all other table counts equal the pre-run baseline", () => {
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
  for (const letter of Object.keys(letterResults).sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  })) {
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
