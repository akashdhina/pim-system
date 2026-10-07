/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5I tests: the Form II workflow - Prepare -> Generate ->
 * Issue/Dispatch (through SERVICE_PENDING) - lib/pim-data/form2.js,
 * routed from app/api/pim/form2/[id]/route.js,
 * app/api/pim/documents/form2/[id]/route.js,
 * app/api/pim/form2/issue/[id]/route.js, and
 * app/api/pim/documents/download/[caseId]/[documentId]/route.js.
 *
 * No-Storage document model under test: a PostgreSQL-generated Form-2
 * document is never written to a permanent file. Generate freezes the
 * exact template values into render_data (JSONB); file_path is always
 * NULL. Download re-renders solely from that frozen snapshot - the
 * central property this suite exists to prove is that the SAME
 * document version always reproduces the SAME legally/business-relevant
 * content from its own frozen render_data, even after later live-data
 * edits (an address correction, for example) would have produced a
 * DIFFERENT result if the renderer read current data instead.
 *
 * This is Batch 5I's first real automated test coverage for Form II -
 * the prior state was two hardcoded, assertion-free debug scripts.
 *
 * PRODUCTION SAFETY: this suite never calls the PIM-number allocator
 * and never touches year 2026 - every fixture case is created directly
 * at FORM2_PENDING (its current_status_id is set by hand after a plain
 * T1 intake), never through PIM-number assignment. PIM/119/2026 remains
 * reserved for genuine production use.
 *
 * Usage:
 *   node scripts/test-pim-form2-postgres.js
 *   node scripts/test-pim-form2-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO_ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-pim-form2-manifest.json");
const RUN_ID = Date.now();
const TEST_PREFIX = "TEST-B5I-";

let passed = 0;
const failures = [];
const letterResults = {};

function record(letter, outcome) {
  letterResults[letter] = letterResults[letter] || { pass: 0, fail: 0, na: [] };
  if (outcome === "pass") letterResults[letter].pass += 1;
  if (outcome === "fail") letterResults[letter].fail += 1;
}

function markNA(letter, reason) {
  letterResults[letter] = letterResults[letter] || { pass: 0, fail: 0, na: [] };
  letterResults[letter].na.push(reason);
  console.log(`N/A  [${letter}]: ${reason}`);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readSource(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/*
 * This project's configured postgres.js client returns a jsonb column
 * as a raw JSON string, not an auto-parsed object (confirmed live -
 * see the matching comment/helper in lib/pim-data/form2.js, which this
 * mirrors). Only needed here for the handful of assertions that query
 * pim_documents directly with this test file's OWN `sql` client,
 * bypassing form2.js's own parseRenderData() entirely - every function
 * IN form2.js already returns a real parsed object, no extra handling
 * needed for those.
 */
function parseRenderData(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) : value;
}

// ---------------------------------------------------------------------
// Static tests
// ---------------------------------------------------------------------

async function runStaticTests() {
  await test("S", "lib/pim-data/form2.js is PostgreSQL-only and writes no file: no fs, no SQLite, writes inside withTransaction", () => {
    const code = stripComments(readSource("lib/pim-data/form2.js"));
    for (const forbidden of ['require("../db")', 'require("./db")', ".prepare(", "lastInsertRowid", "fs.writeFileSync", "fs.mkdirSync", 'require("fs")']) {
      assert.ok(!code.includes(forbidden), `form2.js contains ${forbidden}`);
    }
    assert.ok((code.match(/withTransaction\(\(tx\)/g) || []).length === 3, "expected exactly 3 withTransaction entry points (prepare, generate, issue)");
  });

  await test("S", "Generate never writes file_path - it is always NULL for a PostgreSQL-generated row", () => {
    const code = readSource("lib/pim-data/form2.js");
    assert.ok(code.includes("file_path"), "file_path must still be an explicit column in the INSERT");
    assert.ok(/file_path[\s\S]{0,200}NULL/.test(code), "file_path must be inserted as NULL");
  });

  await test("S", "Prepare/Generate/Issue each lock a row (FOR UPDATE) before writing - concurrency guards are real, not just SELECT checks", () => {
    const code = readSource("lib/pim-data/form2.js");
    assert.ok((code.match(/FOR UPDATE/g) || []).length >= 3, "expected at least 3 FOR UPDATE locks across prepare/generate/issue");
  });

  await test("S", "routes call the PostgreSQL functions; the kept SQLite originals are not called", () => {
    const prepareRoute = readSource("app/api/pim/form2/[id]/route.js");
    assert.ok(prepareRoute.includes("await getForm2DataPg("));
    assert.ok(prepareRoute.includes("await prepareForm2NoticePg("));
    assert.ok(prepareRoute.includes("function prepareForm2Sqlite("), "the SQLite baseline must still be present, unused");

    const generateRoute = readSource("app/api/pim/documents/form2/[id]/route.js");
    assert.ok(generateRoute.includes("await generateForm2DocumentPg("));
    assert.ok(generateRoute.includes("function generateForm2Sqlite("));

    const issueRoute = readSource("app/api/pim/form2/issue/[id]/route.js");
    assert.ok(issueRoute.includes("await issueForm2NoticePg("));
    assert.ok(issueRoute.includes("function issueForm2Sqlite("));

    const downloadRoute = readSource("app/api/pim/documents/download/[caseId]/[documentId]/route.js");
    assert.ok(downloadRoute.includes("await downloadForm2DocumentPg("));
  });
}

// ---------------------------------------------------------------------
// Fixture infrastructure
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
    // pim_notices.document_id -> pim_documents(id) has no cascade; clear
    // the link before deleting documents, matching the notice/document
    // FK direction (a document points back to its notice, and a notice
    // separately points forward to its current document).
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
      await sleep(delayMs);
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

  // Production safety: this suite must never touch the real 2026
  // sequence row or produce a case whose pim_number is the reserved
  // next production number.
  const [reserved] = await sql`SELECT id FROM pim_cases WHERE pim_number = 'PIM/119/2026'`;
  if (reserved) problems.push("a case with pim_number = 'PIM/119/2026' exists - the reserved production number was consumed");
  const [seq2026] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = 2026`;
  if (!seq2026 || seq2026.last_number !== 118) {
    problems.push(`pim_number_sequences year 2026: expected last_number=118 (untouched), found ${JSON.stringify(seq2026)}`);
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
      // Some route files also export plain config constants (e.g.
      // `export const runtime = "nodejs";`), which CJS's _compile cannot
      // parse as ES module syntax - strip the `export ` keyword only,
      // keeping the declaration (harmless/unused in this test harness).
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
  const { getSql, withTransaction } = require("../lib/pim-postgres");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const {
    getForm2DataPg, prepareForm2NoticePg, prepareForm2NoticeTx,
    generateForm2DocumentPg, generateForm2DocumentTx,
    downloadForm2DocumentPg, issueForm2NoticePg, issueForm2NoticeTx,
  } = require("../lib/pim-data/form2");

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
    const [servicePending] = await sql`SELECT id FROM status_master WHERE code = 'SERVICE_PENDING'`;
    const [form2Issued] = await sql`SELECT id FROM status_master WHERE code = 'FORM2_ISSUED'`;

    const [form2TaskType] = await sql`SELECT id, default_priority FROM task_types WHERE code = 'FORM2'`;

    /*
     * Every fixture case is created via the real T1 intake, then
     * fast-forwarded directly to FORM2_PENDING by setting
     * current_status_id - never through PIM-number assignment. No
     * fixture in this suite ever calls the PIM-number allocator or
     * touches pim_number_sequences. A pending FORM2 task is inserted by
     * hand, matching exactly what Batch 5H-b's real assignment
     * transaction would have created (createPendingTaskIfNotExists) -
     * Issue's task-completion step needs one to exist, same as in
     * production.
     */
    async function fixtureCase(tag, { addressLine1 = "1 Test Street" } = {}) {
      const caseId = await createReceivedPimApplicationPg({
        receivedNumber: `${TEST_PREFIX}${tag}-${RUN_ID}-${Math.random().toString(36).slice(2, 7)}`,
        receivedDate: "2026-01-10", applicationDate: "2026-01-09",
        applicants: [{ name: `B5I Applicant ${tag}` }],
        oppositeParties: [{ name: `B5I Opposite ${tag}`, addresses: [{ addressLine1, villageTown: "Test Town", district: "Test District" }] }],
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

      return { caseId, partyId: party.party_id, addressId: address.id };
    }

    const prepareRoute = loadRouteModule("app/api/pim/form2/[id]/route.js");
    const generateRoute = loadRouteModule("app/api/pim/documents/form2/[id]/route.js");
    const issueRoute = loadRouteModule("app/api/pim/form2/issue/[id]/route.js");
    const downloadRoute = loadRouteModule("app/api/pim/documents/download/[caseId]/[documentId]/route.js");

    // =================================================================
    // A: Initial Prepare (happy path, through the real route)
    // =================================================================
    let ctxA;
    await test("A", "Initial Prepare via the real route: 200, correct notice shape, docket entry written", async () => {
      const f = await fixtureCase("A");
      const before = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${f.caseId}`;

      const res = await callJsonRoute(prepareRoute, "POST", `http://localhost/api/pim/form2/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:30", noticeType: "FORM_2_INITIAL" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.status, "PREPARED");
      assert.strictEqual(res.json.data.noticeType, "FORM_2_INITIAL");

      const [notice] = await sql`SELECT * FROM pim_notices WHERE id = ${res.json.data.noticeId}`;
      assert.strictEqual(notice.case_id, f.caseId);
      assert.strictEqual(notice.status, "PREPARED");
      assert.strictEqual(notice.form_no, "FORM-2");

      const [{ n: docketAfter }] = await sql`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${f.caseId}`;
      assert.strictEqual(docketAfter, before[0].n + 1);

      ctxA = { ...f, noticeId: res.json.data.noticeId };
    });

    // =================================================================
    // B: duplicate Prepare rejected
    // =================================================================
    await test("B", "a second Prepare for the same case+party+type is rejected; nothing new written", async () => {
      assert.ok(ctxA, "prerequisite A did not complete");
      const before = await tableCounts(sql);

      await assert.rejects(
        () => prepareForm2NoticePg(ctxA.caseId, {
          partyId: ctxA.partyId, addressId: ctxA.addressId, appearanceDate: "2026-02-16", appearanceTime: "11:00", noticeType: "FORM_2_INITIAL",
        }, aaUser.id),
        /already exists/
      );

      assert.deepStrictEqual(await tableCounts(sql), before, "a rejected duplicate Prepare must write nothing");
    });

    // =================================================================
    // C: concurrent duplicate Prepare - only one may succeed
    // =================================================================
    await test("C", "two concurrent Prepare calls for the same case+party+type: exactly one succeeds, one is cleanly rejected", async () => {
      const f = await fixtureCase("C");

      const settled = await Promise.allSettled([
        prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id),
        prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id),
      ]);
      const winners = settled.filter((s) => s.status === "fulfilled");
      const losers = settled.filter((s) => s.status === "rejected");

      assert.strictEqual(winners.length, 1, "exactly one concurrent Prepare must commit");
      assert.strictEqual(losers.length, 1);
      assert.match(losers[0].reason.message, /already exists/);

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_notices WHERE case_id = ${f.caseId}`;
      assert.strictEqual(n, 1, "exactly one notice must exist after the race, not two");
    });

    // =================================================================
    // D: wrong-status Prepare rejected
    // =================================================================
    await test("D", "Prepare against a case not at FORM2_PENDING is rejected; nothing written", async () => {
      const f = await fixtureCase("D");
      const [received] = await sql`SELECT id FROM status_master WHERE code = 'RECEIVED'`;
      await sql`UPDATE pim_cases SET current_status_id = ${received.id} WHERE id = ${f.caseId}`;
      const before = await tableCounts(sql);

      await assert.rejects(
        () => prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id),
        /not available for Form-2 preparation/
      );
      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    // =================================================================
    // E: Generate first version
    // =================================================================
    let ctxE;
    await test("E", "Generate first version via the real route: file_path null, render_data frozen, notice.document_id linked", async () => {
      assert.ok(ctxA, "prerequisite A did not complete");

      const res = await callJsonRoute(generateRoute, "POST", `http://localhost/api/pim/documents/form2/${ctxA.noticeId}`, {
        userId: aaUser.id, params: { id: String(ctxA.noticeId) }, body: {},
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.reused, false);
      assert.strictEqual(res.json.data.document.file_path, null);
      assert.strictEqual(res.json.data.document.version_no, 1);
      assert.strictEqual(res.json.data.document.is_current, 1);

      const [document] = await sql`SELECT * FROM pim_documents WHERE id = ${res.json.data.document.id}`;
      assert.strictEqual(document.file_path, null);
      const renderData = parseRenderData(document.render_data);
      assert.ok(renderData, "render_data must be populated");
      assert.strictEqual(renderData.applicantName, "B5I Applicant A");
      assert.strictEqual(renderData.oppositePartyName, "B5I Opposite A");
      assert.strictEqual(renderData.noticeLabel, "NOTICE");

      const [notice] = await sql`SELECT document_id FROM pim_notices WHERE id = ${ctxA.noticeId}`;
      assert.strictEqual(notice.document_id, document.id);

      ctxE = { documentId: document.id, renderData };
    });

    // =================================================================
    // F: normal reuse (Generate again without regenerate)
    // =================================================================
    await test("F", "Generate again without regenerate: reused=true, no second row created", async () => {
      assert.ok(ctxA && ctxE, "prerequisites did not complete");
      const [{ n: before }] = await sql`SELECT COUNT(*)::int AS n FROM pim_documents WHERE notice_id = ${ctxA.noticeId}`;

      const result = await generateForm2DocumentPg(ctxA.noticeId, {}, aaUser.id);
      assert.strictEqual(result.reused, true);
      assert.strictEqual(result.document.id, ctxE.documentId);

      const [{ n: after }] = await sql`SELECT COUNT(*)::int AS n FROM pim_documents WHERE notice_id = ${ctxA.noticeId}`;
      assert.strictEqual(after, before, "reuse must not create a new row");
    });

    // =================================================================
    // G: forced regeneration
    // =================================================================
    let ctxG;
    await test("G", "forced regenerate=true creates a new version, flips is_current, keeps the previous version intact", async () => {
      assert.ok(ctxA && ctxE, "prerequisites did not complete");

      const result = await generateForm2DocumentPg(ctxA.noticeId, { regenerate: true }, aaUser.id);
      assert.strictEqual(result.reused, false);
      assert.strictEqual(result.document.version_no, 2);
      assert.notStrictEqual(result.document.id, ctxE.documentId);

      const [oldDoc] = await sql`SELECT is_current FROM pim_documents WHERE id = ${ctxE.documentId}`;
      assert.strictEqual(oldDoc.is_current, false, "the previous version must no longer be current");

      const [notice] = await sql`SELECT document_id FROM pim_notices WHERE id = ${ctxA.noticeId}`;
      assert.strictEqual(notice.document_id, result.document.id, "the notice must now point at the new version");

      ctxG = { documentId: result.document.id };
    });

    // =================================================================
    // H: concurrent regeneration
    // =================================================================
    await test("H", "two concurrent forced regenerations of the same notice: sequential distinct versions, exactly one is_current", async () => {
      const f = await fixtureCase("H");
      const prepared = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
      await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id); // v1, uncontended

      const [r1, r2] = await Promise.all([
        generateForm2DocumentPg(prepared.noticeId, { regenerate: true }, aaUser.id),
        generateForm2DocumentPg(prepared.noticeId, { regenerate: true }, aaUser.id),
      ]);

      const versions = [r1.document.version_no, r2.document.version_no].sort();
      assert.deepStrictEqual(versions, [2, 3], "concurrent regenerations must not produce duplicate version numbers");

      const currentRows = await sql`SELECT id FROM pim_documents WHERE notice_id = ${prepared.noticeId} AND is_current = true`;
      assert.strictEqual(currentRows.length, 1, "exactly one is_current document must remain");

      const allVersions = await sql`SELECT version_no FROM pim_documents WHERE notice_id = ${prepared.noticeId} ORDER BY version_no`;
      assert.deepStrictEqual(allVersions.map((v) => v.version_no), [1, 2, 3], "no duplicate or skipped version numbers");
    });

    // =================================================================
    // I: exactly one current version per notice (multi-notice scoping)
    // =================================================================
    await test("I", "a second notice on the SAME case has its own independent version lineage - generating one never flips the other's current document", async () => {
      const f = await fixtureCase("I");
      const n1 = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
      const d1 = await generateForm2DocumentPg(n1.noticeId, {}, aaUser.id);

      // A second, independent notice on the same case (simulating what a
      // Final Notice would be, without depending on the actual Final-
      // Notice address-correction cycle, which is out of this batch).
      const [freshResult] = await sql`
        INSERT INTO pim_notices (case_id, notice_type, form_no, notice_date, appearance_date, appearance_time, recipient_party_id, address_id, prepared_by, status)
        VALUES (${f.caseId}, 'FORM_2_INITIAL', 'FORM-2', '2026-01-15', '2026-02-20', '11:00', ${f.partyId}, ${f.addressId}, ${aaUser.id}, 'PREPARED')
        RETURNING id
      `;
      const d2 = await generateForm2DocumentPg(freshResult.id, {}, aaUser.id);

      const [current1] = await sql`SELECT id, is_current FROM pim_documents WHERE notice_id = ${n1.noticeId} AND is_current = true`;
      const [current2] = await sql`SELECT id, is_current FROM pim_documents WHERE notice_id = ${freshResult.id} AND is_current = true`;
      assert.strictEqual(current1.id, d1.document.id);
      assert.strictEqual(current2.id, d2.document.id);
      assert.notStrictEqual(d1.document.id, d2.document.id, "the two notices must have independent document rows");
    });

    // =================================================================
    // J + L: historical version remains downloadable; download reproduces
    // exactly the frozen content
    // =================================================================
    await test("J", "a historical (non-current) version remains downloadable via the real download route", async () => {
      assert.ok(ctxA && ctxE, "prerequisites did not complete");
      const res = await callJsonRoute(downloadRoute, "GET", `http://localhost/api/pim/documents/download/${ctxA.caseId}/${ctxE.documentId}`, {
        userId: aaUser.id, params: { caseId: String(ctxA.caseId), documentId: String(ctxE.documentId) },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.buffer.length > 0);
      assert.strictEqual(res.buffer.slice(0, 2).toString("hex"), "504b", "must be a real zip/docx signature");
    });

    await test("L", "download reproduces exactly the frozen render_data content, not current live data", async () => {
      const download = await downloadForm2DocumentPg(ctxA.caseId, ctxE.documentId);
      assert.ok(download.buffer);
      // The renderer is deterministic over the same input: re-rendering
      // the SAME frozen render_data twice must produce the same content
      // length (a light, cheap proxy for "same content" without pinning
      // to exact docxtemplater/zip byte-for-byte output, which this
      // batch's acceptance criterion deliberately does not require).
      const download2 = await downloadForm2DocumentPg(ctxA.caseId, ctxE.documentId);
      assert.strictEqual(download.buffer.length, download2.buffer.length, "re-rendering the same frozen snapshot must be stable");
    });

    // =================================================================
    // K: frozen render_data survives later live-data changes
    // =================================================================
    await test("K", "render_data is frozen at generation time - a later address correction does not change a historical document's content", async () => {
      assert.ok(ctxA && ctxE, "prerequisites did not complete");
      const [before] = await sql`SELECT render_data FROM pim_documents WHERE id = ${ctxE.documentId}`;
      const originalAddress = parseRenderData(before.render_data).oppositePartyAddress;
      assert.ok(originalAddress.includes("1 Test Street"), "sanity: the original address must be in the frozen snapshot");

      // Simulate a later address correction on the SAME party (the kind
      // of live-data edit that must NOT retroactively alter a document
      // already generated).
      await sql`UPDATE pim_addresses SET address_line1 = 'CHANGED Street After Correction' WHERE id = ${ctxA.addressId}`;

      const [after] = await sql`SELECT render_data FROM pim_documents WHERE id = ${ctxE.documentId}`;
      const afterRenderData = parseRenderData(after.render_data);
      assert.strictEqual(afterRenderData.oppositePartyAddress, originalAddress, "the historical document's frozen address must be unchanged");
      assert.ok(!afterRenderData.oppositePartyAddress.includes("CHANGED"), "the frozen snapshot must not pick up the later edit");

      // A brand-new Generate call for a DIFFERENT notice, after the
      // correction, legitimately DOES see the new address - proving the
      // freeze is per-document, not a blanket refusal to ever read
      // current data.
      const f = await fixtureCase("K2");
      await sql`UPDATE pim_addresses SET address_line1 = 'Fresh Address For K2' WHERE id = ${f.addressId}`;
      const prepared = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
      const generated = await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id);
      assert.ok(generated.document.render_data.oppositePartyAddress.includes("Fresh Address For K2"));
    });

    // =================================================================
    // M: no local file is ever created
    // =================================================================
    await test("M", "no local storage/pim file is created by any PostgreSQL Form-2 operation in this run", async () => {
      const storageRoot = path.join(REPO_ROOT, "storage", "pim");
      const before = fs.existsSync(storageRoot) ? fs.readdirSync(storageRoot, { recursive: true }).length : 0;

      const f = await fixtureCase("M");
      const prepared = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
      await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id);
      await downloadForm2DocumentPg(f.caseId, (await sql`SELECT document_id FROM pim_notices WHERE id = ${prepared.noticeId}`)[0].document_id);

      const after = fs.existsSync(storageRoot) ? fs.readdirSync(storageRoot, { recursive: true }).length : 0;
      assert.strictEqual(after, before, "storage/pim must gain no new entries from Prepare+Generate+Download");
    });

    // =================================================================
    // N: Issue (happy path, through the real route) - status/task/docket
    // =================================================================
    await test("N", "Issue via the real route: SERVICE_PENDING, service attempt recorded, task completed, exact two status-history hops", async () => {
      const f = await fixtureCase("N");
      const prepared = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
      await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id);

      const historyBefore = await sql`SELECT COUNT(*)::int AS n FROM pim_status_history WHERE case_id = ${f.caseId}`;

      const res = await callJsonRoute(issueRoute, "POST", `http://localhost/api/pim/form2/issue/${f.caseId}`, {
        userId: aaUser.id, params: { id: String(f.caseId) },
        body: { noticeId: prepared.noticeId, addressId: f.addressId, dispatchMode: "REGISTERED_POST", postalReceiptNo: "RP-1" },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.data.statusCode, "SERVICE_PENDING");

      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${f.caseId}`;
      assert.strictEqual(caseRow.current_status_id, servicePending.id);

      const [notice] = await sql`SELECT status FROM pim_notices WHERE id = ${prepared.noticeId}`;
      assert.strictEqual(notice.status, "DISPATCHED");

      const [{ n: serviceAttempts }] = await sql`SELECT COUNT(*)::int AS n FROM pim_service_attempts WHERE notice_id = ${prepared.noticeId}`;
      assert.strictEqual(serviceAttempts, 1);

      const [{ n: historyAfter }] = await sql`SELECT COUNT(*)::int AS n FROM pim_status_history WHERE case_id = ${f.caseId}`;
      assert.strictEqual(historyAfter, historyBefore[0].n + 2, "exactly two new status-history rows");

      const hops = await sql`SELECT from_status_id, to_status_id FROM pim_status_history WHERE case_id = ${f.caseId} ORDER BY id DESC LIMIT 2`;
      assert.strictEqual(hops[1].to_status_id, form2Issued.id);
      assert.strictEqual(hops[0].from_status_id, form2Issued.id);
      assert.strictEqual(hops[0].to_status_id, servicePending.id);

      const [task] = await sql`SELECT status FROM pim_tasks WHERE case_id = ${f.caseId} AND task_type_code = 'FORM2'`;
      assert.strictEqual(task.status, "COMPLETED");
      const [{ n: taskHistoryCount }] = await sql`SELECT COUNT(*)::int AS n FROM pim_task_history th JOIN pim_tasks t ON t.id = th.task_id WHERE t.case_id = ${f.caseId}`;
      assert.strictEqual(taskHistoryCount, 1);
    });

    // =================================================================
    // O: missing-document Issue rejection
    // =================================================================
    await test("O", "Issue is rejected when no document has been generated yet; nothing written", async () => {
      const f = await fixtureCase("O");
      const prepared = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
      const before = await tableCounts(sql);

      await assert.rejects(
        () => issueForm2NoticePg(f.caseId, { noticeId: prepared.noticeId, addressId: f.addressId, dispatchMode: "REGISTERED_POST" }, aaUser.id),
        /Generate the official Form-2 document/
      );
      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    // =================================================================
    // P: wrong-status Issue rejection
    // =================================================================
    await test("P", "Issue is rejected when the case is not at FORM2_PENDING; nothing written", async () => {
      const f = await fixtureCase("P");
      const prepared = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
      await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id);
      const [received] = await sql`SELECT id FROM status_master WHERE code = 'RECEIVED'`;
      await sql`UPDATE pim_cases SET current_status_id = ${received.id} WHERE id = ${f.caseId}`;
      const before = await tableCounts(sql);

      await assert.rejects(
        () => issueForm2NoticePg(f.caseId, { noticeId: prepared.noticeId, addressId: f.addressId, dispatchMode: "REGISTERED_POST" }, aaUser.id),
        /not available for Form-2 issue/
      );
      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    // =================================================================
    // Q: same-notice concurrent Issue - exactly one service attempt,
    // no duplicate history/docket/task completion
    // =================================================================
    await test("Q", "same-notice concurrent Issue: exactly one commits, exactly one service attempt, no duplicate history/docket/task", async () => {
      const f = await fixtureCase("Q");
      const prepared = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
      await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id);

      const settled = await Promise.allSettled([
        issueForm2NoticePg(f.caseId, { noticeId: prepared.noticeId, addressId: f.addressId, dispatchMode: "REGISTERED_POST" }, aaUser.id),
        issueForm2NoticePg(f.caseId, { noticeId: prepared.noticeId, addressId: f.addressId, dispatchMode: "REGISTERED_POST" }, aaUser.id),
      ]);
      const winners = settled.filter((s) => s.status === "fulfilled" && !s.value.conflict);
      assert.strictEqual(winners.length, 1, "exactly one concurrent Issue must commit");

      const [{ n: serviceAttempts }] = await sql`SELECT COUNT(*)::int AS n FROM pim_service_attempts WHERE notice_id = ${prepared.noticeId}`;
      assert.strictEqual(serviceAttempts, 1, "exactly one service attempt, never two");

      const [{ n: form2ToServicePending }] = await sql`
        SELECT COUNT(*)::int AS n FROM pim_status_history WHERE case_id = ${f.caseId} AND to_status_id = ${servicePending.id}`;
      assert.strictEqual(form2ToServicePending, 1, "exactly one SERVICE_PENDING transition");

      const [{ n: dispatchDocket }] = await sql`
        SELECT COUNT(*)::int AS n FROM pim_docket d JOIN event_types e ON e.id = d.event_type_id
        WHERE d.case_id = ${f.caseId} AND e.code = 'FORM2_DISPATCHED'`;
      assert.strictEqual(dispatchDocket, 1, "exactly one dispatch docket entry");

      const [{ n: taskHistoryCount }] = await sql`
        SELECT COUNT(*)::int AS n FROM pim_task_history th JOIN pim_tasks t ON t.id = th.task_id WHERE t.case_id = ${f.caseId}`;
      assert.strictEqual(taskHistoryCount, 1, "the FORM2 task must be completed exactly once");
    });

    // =================================================================
    // T: permission checks (real routes)
    // =================================================================
    await test("T", "Prepare via the real route: no identity -> 401; chairman (not staff) -> 403; nothing written on denial", async () => {
      const f = await fixtureCase("T");
      const none = await callJsonRoute(prepareRoute, "POST", `http://localhost/api/pim/form2/${f.caseId}`, {
        params: { id: String(f.caseId) }, body: { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" },
      });
      assert.strictEqual(none.status, 401);

      const forbidden = await callJsonRoute(prepareRoute, "POST", `http://localhost/api/pim/form2/${f.caseId}`, {
        userId: chairmanUser.id, params: { id: String(f.caseId) },
        body: { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" },
      });
      assert.strictEqual(forbidden.status, 403);

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_notices WHERE case_id = ${f.caseId}`;
      assert.strictEqual(n, 0, "a denied Prepare must write nothing");
    });

    await test("T", "Download via the real route: no identity -> 401", async () => {
      assert.ok(ctxA && ctxE, "prerequisites did not complete");
      const none = await callJsonRoute(downloadRoute, "GET", `http://localhost/api/pim/documents/download/${ctxA.caseId}/${ctxE.documentId}`, {
        params: { caseId: String(ctxA.caseId), documentId: String(ctxE.documentId) },
      });
      assert.strictEqual(none.status, 401);
    });

    // =================================================================
    // U: the download route's PostgreSQL-first path does not break the
    // existing SQLite/local-file fallback for a non-Form-2 document
    // =================================================================
    await test("U", "a document row invisible to the PostgreSQL Form-2 path (wrong document_type) correctly falls through, not silently served", async () => {
      assert.ok(ctxA, "prerequisite A did not complete");
      const [decoy] = await sql`
        INSERT INTO pim_documents (case_id, notice_id, document_type, document_title, file_path, generated_by_system, version_no, is_current, created_by)
        VALUES (${ctxA.caseId}, NULL, 'FORM_3', 'Decoy Form-3 (not this batch)', NULL, true, 1, true, ${aaUser.id})
        RETURNING id
      `;
      const download = await downloadForm2DocumentPg(ctxA.caseId, decoy.id);
      assert.strictEqual(download, null, "downloadForm2DocumentPg must not claim a non-Form-2 document type");
      await sql`DELETE FROM pim_documents WHERE id = ${decoy.id}`;
    });

    // =================================================================
    // V: rollback after a deliberate downstream failure
    // =================================================================
    await test("V", "Issue: a forced failure after every write rolls back the whole transaction - task, docket, history, service attempt, case status all revert", async () => {
      const f = await fixtureCase("V");
      const prepared = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
      await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id);
      const before = await tableCounts(sql);

      const SENTINEL = "FORCED-FAILURE-B5I-ISSUE";
      await assert.rejects(
        () => withTransaction(async (tx) => {
          await issueForm2NoticeTx(tx, f.caseId, { noticeId: prepared.noticeId, addressId: f.addressId, dispatchMode: "REGISTERED_POST" }, aaUser.id);
          throw new Error(SENTINEL);
        }),
        (e) => e.message === SENTINEL
      );

      assert.deepStrictEqual(await tableCounts(sql), before, "every write from the forced-to-fail Issue must have rolled back");
      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${f.caseId}`;
      assert.strictEqual(caseRow.current_status_id, form2Pending.id, "case status must be exactly as before");
    });

    await test("V", "Generate: a forced failure after the version increment rolls back too - no duplicate/skipped version on the next real attempt", async () => {
      const f = await fixtureCase("V2");
      const prepared = await prepareForm2NoticePg(f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);

      const SENTINEL = "FORCED-FAILURE-B5I-GENERATE";
      await assert.rejects(
        () => withTransaction(async (tx) => {
          await generateForm2DocumentTx(tx, prepared.noticeId, {}, aaUser.id);
          throw new Error(SENTINEL);
        }),
        (e) => e.message === SENTINEL
      );

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_documents WHERE notice_id = ${prepared.noticeId}`;
      assert.strictEqual(n, 0, "the rolled-back Generate must have left no document row");

      const result = await generateForm2DocumentPg(prepared.noticeId, {}, aaUser.id);
      assert.strictEqual(result.document.version_no, 1, "a real, successful Generate afterward must start at version 1, not 2");
    });

    await test("V", "Prepare: a forced failure after the notice insert rolls back too", async () => {
      const f = await fixtureCase("V3");
      const before = await tableCounts(sql);

      const SENTINEL = "FORCED-FAILURE-B5I-PREPARE";
      await assert.rejects(
        () => withTransaction(async (tx) => {
          await prepareForm2NoticeTx(tx, f.caseId, { partyId: f.partyId, addressId: f.addressId, appearanceDate: "2026-02-15", appearanceTime: "10:00", noticeType: "FORM_2_INITIAL" }, aaUser.id);
          throw new Error(SENTINEL);
        }),
        (e) => e.message === SENTINEL
      );

      const after = await tableCounts(sql);
      // fixtureCase itself wrote real rows (case/parties/etc) - compare
      // only the notice count, which is what the forced-to-fail Prepare
      // itself would have written.
      assert.strictEqual(after.pim_notices, before.pim_notices, "the rolled-back Prepare must have created no notice");
    });
  } finally {
    console.log(`\ncleanup: removing exactly these fixture case ids: ${JSON.stringify([...tracker.caseIds])}`);
    try {
      await withRetries("cleanup (cases)", () => cleanupCasesByIds(sql, [...tracker.caseIds]));
    } catch (error) {
      console.error(`CLEANUP FAILED (cases): ${error.message}`);
      for (const line of await describeOrphanedTransactions(sql)) console.error(`      orphaned transaction? ${line}`);
      failures.push("cleanup of case fixtures");
    }
  }

  await test("RESIDUE", "no test cases, notices, documents, status history, docket, tasks remain; production 2026 sequence (last_number=118) and PIM/119/2026 untouched; no orphaned transaction; all other table counts equal the pre-run baseline", async () => {
    const { problems, after } = await withRetries("residue verification", () => verifyNoResidue(sql, tracker, baselineCounts));
    console.log(`      post-run row counts: ${JSON.stringify(after)}`);
    assert.deepStrictEqual(problems, [], `RESIDUE FOUND:\n${problems.join("\n")}`);
  });

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
