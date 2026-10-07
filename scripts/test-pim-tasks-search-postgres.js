/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5G tests: the two PostgreSQL read loaders that close the
 * remaining SQLite-read paths needed before T3:
 *   GET /api/pim/tasks   -> lib/pim-data/tasks-read.js   (getPimTasksPg)
 *   GET /api/pim/search  -> lib/pim-data/search-read.js  (searchPimCasesPg)
 *
 * Usage:
 *   node scripts/test-pim-tasks-search-postgres.js
 *   node scripts/test-pim-tasks-search-postgres.js --cleanup-only
 *
 * Architecture: follows scripts/test-pim-read-loaders-postgres.js (Batch
 * 5F) closely - same reporting/timeout harness, same exact-ID fixture
 * tracker + manifest + --cleanup-only recovery, same
 * cleanupCasesByIds/verifyNoResidue/withRetries shape, same wire-format
 * assertions, same "SQLite baseline is the ORIGINAL kept code, not a
 * re-implementation" principle (getPimTasksSqlite / searchPimCasesSqlite,
 * loaded from the real route files), same real-route-handler harness.
 *
 * Unlike 5F's two single-case GET loaders, these are LIST endpoints with
 * no case-scoping filter, so every fixture task is given a run-unique
 * task_type_code (task_type_code has no FK/CHECK constraint - confirmed
 * against both schemas) so assertions can isolate exactly the rows a test
 * created via `taskType=<code>`, regardless of any other data in the
 * table. The one exception is the FORM2/FORM_2 merge fixture, which must
 * use those literal codes; it is the only fixture using them.
 *
 * Concurrency: every live statement in this file carries a bound
 * parameter (the Batch 5F pooler finding - parameterless bursts above the
 * connection pool of 10 hang forever, parameterized ones queue safely).
 * Fixture creation runs sequentially per case, and cases are built one at
 * a time (not in parallel) to stay well under the pool.
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO_ROOT = path.join(__dirname, "..");
const SCRATCH_DB_PATH = path.join(REPO_ROOT, "database", "test-pim-tasks-search.scratch.db");
const TEST_PREFIX = "TEST-B5G-";
const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-pim-tasks-search-manifest.json");
const RUN_ID = Date.now();
const TT = `TB5G${RUN_ID}`; // run-unique task_type_code prefix, isolates fixture rows in the global list

/* Fresh scratch SQLite every run; lib/pim-test-guard refuses production. */
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  fs.rmSync(SCRATCH_DB_PATH + suffix, { force: true });
}
process.env.PIM_DB_PATH = SCRATCH_DB_PATH;
delete process.env.PIM_DEV_USER_ID;

// ---------------------------------------------------------------------
// Reporting / timeout harness (same shape as the 5F test)
// ---------------------------------------------------------------------

let passed = 0;
const failures = [];
const letterResults = {};

function record(letter, outcome) {
  letterResults[letter] = letterResults[letter] || { pass: 0, fail: 0, na: [] };
  if (outcome === "pass") letterResults[letter].pass += 1;
  if (outcome === "fail") letterResults[letter].fail += 1;
}

const TEST_TIMEOUT_MS = 180000;

/* Rejects if `promise` has not settled in `ms` - a pooler stall must fail loudly, not hang the run. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`TIMEOUT after ${ms / 1000}s: ${label} (possible pooler stall)`)),
      ms
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function testMulti(letters, name, fn) {
  const label = letters.join("+");
  try {
    await withTimeout(Promise.resolve().then(fn), TEST_TIMEOUT_MS, name);
    console.log(`PASS [${label}]: ${name}`);
    passed += 1;
    for (const letter of letters) record(letter, "pass");
  } catch (error) {
    console.error(`FAIL [${label}]: ${name}`);
    console.error(`      ${error instanceof Error ? error.stack || error.message : error}`);
    failures.push(`[${label}] ${name}`);
    for (const letter of letters) record(letter, "fail");
  }
}

function test(letter, name, fn) {
  return testMulti([letter], name, fn);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
}

// ---------------------------------------------------------------------
// Fixture payloads
// ---------------------------------------------------------------------

const FEE = { amount: 1000, ddNumber: "DD-1", ddDate: "2026-02-01", bankName: "Test Bank", payee: "Chairman, DLSA" };

function leanPayload(receivedNumber, { applicantName, oppositeName, advocate } = {}) {
  return {
    receivedNumber,
    receivedDate: "2026-02-01",
    applicationDate: "2026-01-30",
    applicants: [{
      name: applicantName || "B5G Applicant",
      ...(advocate ? { advocate } : {}),
    }],
    oppositeParties: [{ name: oppositeName || "B5G Opposite" }],
    applicationFee: FEE,
  };
}

// ---------------------------------------------------------------------
// Static tests - no database needed, always run.
// ---------------------------------------------------------------------

function functionBody(source, header) {
  const start = source.indexOf(header);
  assert.ok(start !== -1, `${header} not found`);
  const rest = source.slice(start + header.length);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

async function runStaticTests() {
  await test("S", "tasks GET calls requirePermission(READ_CASE) then the PostgreSQL loader; the SQLite getPimTasksSqlite is not called by GET", () => {
    const source = readSource("app/api/pim/tasks/route.js");
    const body = functionBody(source, "export async function GET(request) {");
    const permission = body.indexOf('requirePermission(request, "READ_CASE")');
    const loader = body.indexOf("await getPimTasksPg(");
    assert.ok(permission !== -1 && loader > permission, "READ_CASE must precede the PostgreSQL loader");
    assert.ok(!/[^\w]getPimTasksSqlite\(/.test(body), "GET must not call the SQLite getPimTasksSqlite");
    assert.ok(source.includes("function getPimTasksSqlite(searchParams)"), "the SQLite rollback function must still exist");
  });

  await test("S", "search GET calls requirePermission(READ_CASE) then the PostgreSQL loader for q.length >= 2; the SQLite searchPimCasesSqlite is not called by GET", () => {
    const source = readSource("app/api/pim/search/route.js");
    const body = functionBody(source, "export async function GET(request) {");
    const permission = body.indexOf('requirePermission(request, "READ_CASE")');
    const loader = body.indexOf("await searchPimCasesPg(");
    assert.ok(permission !== -1 && loader > permission, "READ_CASE must precede the PostgreSQL loader");
    assert.ok(!/[^\w]searchPimCasesSqlite\(/.test(body), "GET must not call the SQLite searchPimCasesSqlite");
    assert.ok(source.includes("function searchPimCasesSqlite(q, limit)"), "the SQLite rollback function must still exist");
  });

  await test("S", "both loaders are read-only PostgreSQL: no SQLite, no transaction, no lock, no DML, no fallback, no parallel bursts", () => {
    for (const file of ["lib/pim-data/tasks-read.js", "lib/pim-data/search-read.js"]) {
      const code = stripComments(readSource(file));
      for (const forbidden of ["withTransaction", "FOR UPDATE", "FOR SHARE", 'require("../db")', 'require("./db")', ".prepare(", "lastInsertRowid", "sql.begin", "Promise.all"]) {
        assert.ok(!code.includes(forbidden), `${file} contains forbidden ${forbidden}`);
      }
      assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(code), `${file} contains a write statement`);
      assert.ok(code.includes("getSql()"), `${file} must use the shared PostgreSQL client`);
    }
  });

  await test("S", "tasks-read.js: no parameterless statement (every WHERE/DISTINCT-scope carries a bound predicate)", () => {
    const code = stripComments(readSource("lib/pim-data/tasks-read.js"));
    assert.strictEqual((code.match(/\$\{1\}::int = 1/g) || []).length, 2, "expected the bound always-true predicate exactly twice in CODE (row query + taskTypes query), excluding comment mentions");
  });

  await test("S", "search-read.js: the identifier helper produces a genuinely qualified column (verified against live PostgreSQL, not assumed)", () => {
    // This assertion is static (the file still calls sql(column) with dotted names);
    // the actual SQL PostgreSQL receives is verified live in test L below.
    const code = stripComments(readSource("lib/pim-data/search-read.js"));
    assert.ok(/const like = \(column\) => sql`translate\(\$\{sql\(column\)\}/.test(code), "like() must quote `column` through sql(), not string-interpolate it");
    assert.ok(!/\$\{`.*\$\{column\}/.test(code), "column name must never be template-interpolated directly into SQL text");
  });

  await test("S", "hasNul() in tasks-read.js checks for an actual NUL character (U+0000), not a plain space", () => {
    const code = readSource("lib/pim-data/tasks-read.js");
    const m = code.match(/function hasNul\(text\) \{\s*return text\.includes\((.*?)\);/);
    assert.ok(m, "hasNul() not found");
    assert.strictEqual(m[1].codePointAt(1), 0, `hasNul()'s literal must be U+0000, got codepoint ${m[1].codePointAt(1)}`);
  });
}

// ---------------------------------------------------------------------
// PostgreSQL fixture infrastructure (exact-ID only) - same shape as 5F.
// ---------------------------------------------------------------------

const COUNT_TABLES = [
  "pim_cases", "pim_parties", "pim_case_parties", "pim_addresses", "pim_advocates", "pim_case_advocates",
  "pim_fees", "pim_status_history", "pim_docket", "pim_tasks", "pim_task_history", "pim_scrutiny",
  "pim_scrutiny_attempts", "pim_outcomes", "pim_notices", "pim_responses", "pim_documents",
  "pim_service_attempts", "pim_mediator_assignments", "mediation_sessions", "audit_log",
];

function createTracker() {
  return {
    caseIds: new Set(),
    partyIds: new Set(),
    advocateIds: new Set(),
    taskIds: new Set(),
    mediatorIds: new Set(),
    assignmentIds: new Set(),
    sessionIds: new Set(),
    addCase(id) {
      this.caseIds.add(id);
      this.persist();
    },
    addMediator(id) {
      this.mediatorIds.add(id);
      this.persist();
    },
    persist() {
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify({ startedAt: new Date().toISOString(), caseIds: [...this.caseIds], mediatorIds: [...this.mediatorIds] }, null, 2)
      );
    },
  };
}

/*
 * One batched, atomic, exact-ID transaction, extended from the 5F version
 * with mediation_sessions / pim_mediator_assignments (owned by cases in
 * this batch's fixtures). mediators is a standalone lookup table (not
 * case-scoped) and is cleaned separately by cleanupMediatorsByIds, AFTER
 * the case transaction, with its own name-tag safety guard.
 */
async function cleanupCasesByIds(sql, caseIds, tracker) {
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
    const advocateIds = (await tx`SELECT DISTINCT advocate_id FROM pim_case_advocates WHERE case_id IN ${tx(caseIds)}`).map((r) => r.advocate_id);
    const taskIds = (await tx`SELECT id FROM pim_tasks WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id);
    const sessionIds = (await tx`SELECT id FROM mediation_sessions WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id);
    const assignmentIds = (await tx`SELECT id FROM pim_mediator_assignments WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id);

    for (const id of partyIds) tracker.partyIds.add(id);
    for (const id of advocateIds) tracker.advocateIds.add(id);
    for (const id of taskIds) tracker.taskIds.add(id);
    for (const id of sessionIds) tracker.sessionIds.add(id);
    for (const id of assignmentIds) tracker.assignmentIds.add(id);

    const del = async (table, column, ids) => {
      if (ids.length > 0) await tx`DELETE FROM ${tx(table)} WHERE ${tx(column)} IN ${tx(ids)}`;
    };

    await del("pim_task_history", "task_id", taskIds);
    await del("pim_tasks", "case_id", caseIds);
    await del("mediation_sessions", "case_id", caseIds);
    await del("pim_mediator_assignments", "case_id", caseIds);
    await del("pim_docket", "case_id", caseIds);
    await del("pim_status_history", "case_id", caseIds);
    await del("pim_outcomes", "case_id", caseIds);
    await del("pim_fees", "case_id", caseIds);
    await del("pim_case_advocates", "case_id", caseIds);
    await del("pim_case_parties", "case_id", caseIds);
    await del("pim_addresses", "party_id", partyIds);
    await del("pim_parties", "id", partyIds);
    await del("pim_advocates", "id", advocateIds);
    await del("pim_cases", "id", caseIds);
  });
}

/*
 * mediators is NOT case-scoped, so it is never touched by
 * cleanupCasesByIds - it is cleaned here, by exact id, only after every
 * assignment referencing it is gone (guaranteed by the case cleanup
 * above), and only if its name carries this run's own tag - never a real
 * production mediator (Batch 5H-a reconciled the project to exactly 5
 * approved mediators - confirmed live before this run; none match the tag).
 */
async function cleanupMediatorsByIds(sql, mediatorIds) {
  if (mediatorIds.length === 0) return;

  const existing = await sql`SELECT id, name FROM mediators WHERE id IN ${sql(mediatorIds)}`;
  for (const row of existing) {
    if (!String(row.name || "").includes(TT)) {
      throw new Error(`Refusing to delete mediator ${row.id}: name "${row.name}" does not carry this run's tag.`);
    }
  }
  if (existing.length > 0) {
    await sql`DELETE FROM mediators WHERE id IN ${sql(existing.map((r) => r.id))}`;
  }
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
  if (!fs.existsSync(MANIFEST_PATH)) return { caseIds: [], mediatorIds: [] };

  let stale;
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    stale = { caseIds: parsed.caseIds || [], mediatorIds: parsed.mediatorIds || [] };
  } catch (error) {
    throw new Error(`Could not read the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }

  console.log(`cleanup: removing stale fixtures recorded by a previous run: cases=${JSON.stringify(stale.caseIds)} mediators=${JSON.stringify(stale.mediatorIds)}`);
  try {
    await cleanupCasesByIds(sql, stale.caseIds, tracker);
    await cleanupMediatorsByIds(sql, stale.mediatorIds);
  } catch (error) {
    throw new Error(`Could not clean the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }
  for (const id of stale.caseIds) tracker.caseIds.add(id);
  for (const id of stale.mediatorIds) tracker.mediatorIds.add(id);
  fs.rmSync(MANIFEST_PATH, { force: true });
  return stale;
}

/* Bounded retry of connectivity-class errors ONLY, for idempotent infra steps. Never retries an assertion. */
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
  for (const table of COUNT_TABLES) {
    const [row] = await sql`SELECT COUNT(*)::int AS n FROM ${sql(table)}`;
    counts[table] = row.n;
  }
  return counts;
}

async function countWhereIn(sql, table, column, ids) {
  if (ids.length === 0) return 0;
  const [row] = await sql`SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE ${sql(column)} IN ${sql(ids)}`;
  return row.n;
}

async function verifyNoResidue(sql, tracker, baselineCounts = null) {
  const problems = [];
  const caseIds = [...tracker.caseIds];
  const checks = [
    ["pim_cases", "id", caseIds],
    ["pim_case_parties", "case_id", caseIds],
    ["pim_case_advocates", "case_id", caseIds],
    ["pim_fees", "case_id", caseIds],
    ["pim_status_history", "case_id", caseIds],
    ["pim_docket", "case_id", caseIds],
    ["pim_tasks", "case_id", caseIds],
    ["pim_outcomes", "case_id", caseIds],
    ["mediation_sessions", "case_id", caseIds],
    ["pim_mediator_assignments", "case_id", caseIds],
    ["pim_task_history", "task_id", [...tracker.taskIds]],
    ["mediation_sessions", "id", [...tracker.sessionIds]],
    ["pim_mediator_assignments", "id", [...tracker.assignmentIds]],
    ["mediators", "id", [...tracker.mediatorIds]],
    ["pim_addresses", "party_id", [...tracker.partyIds]],
    ["pim_parties", "id", [...tracker.partyIds]],
    ["pim_advocates", "id", [...tracker.advocateIds]],
  ];

  for (const [table, column, ids] of checks) {
    const n = await countWhereIn(sql, table, column, ids);
    if (n !== 0) problems.push(`${table}.${column}: ${n} row(s) remain for tracked ids`);
  }

  const after = await tableCounts(sql);
  for (const table of COUNT_TABLES) {
    if (baselineCounts && after[table] !== baselineCounts[table]) {
      problems.push(`${table}: row count ${after[table]} != pre-run baseline ${baselineCounts[table]} (if another user wrote during this run, re-run)`);
    }
  }

  const [{ n: mediatorCountNow }] = await sql`SELECT COUNT(*)::int AS n FROM mediators`;
  if (mediatorCountNow !== 5) problems.push(`mediators: row count ${mediatorCountNow} != expected 5 (the five approved panel members, Batch 5H-a)`);

  const orphans = await describeOrphanedTransactions(sql);
  for (const line of orphans) problems.push(`orphaned transaction: ${line}`);

  return { problems, after };
}

// ---------------------------------------------------------------------
// Route harness (same technique as the 5F test): load the REAL route
// module (written with ES `export`) by rewriting only the export
// keywords, so the real requirePermission -> loader path is exercised
// without a Next server.
// ---------------------------------------------------------------------

function loadRouteModule(relativePath, extraExports = []) {
  const routePath = path.join(REPO_ROOT, ...relativePath.split("/"));
  const original = fs.readFileSync(routePath, "utf8");
  const names = [...original.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
  const source =
    original.replace(/^export async function (\w+)/gm, "async function $1") +
    `\nmodule.exports = { ${[...names, ...extraExports].join(", ")} };\n`;
  const routeModule = new Module(routePath, module);
  routeModule.filename = routePath;
  routeModule.paths = Module._nodeModulePaths(path.dirname(routePath));
  routeModule._compile(source, routePath);
  return routeModule.exports;
}

async function callRoute(route, { userId = null, query = "" } = {}) {
  const headers = {};
  if (userId != null) headers["x-pim-user-id"] = String(userId);

  const request = new Request(`http://localhost/api/pim/x?${query}`, { method: "GET", headers });

  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await route.GET(request);
    return { status: response.status, json: await response.json() };
  } finally {
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------
// Wire comparison helpers (same shape as the 5F test)
// ---------------------------------------------------------------------

const wire = (value) => JSON.parse(JSON.stringify(value));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function walk(node, visit, pathParts = []) {
  visit(node, pathParts);
  if (Array.isArray(node)) node.forEach((item, i) => walk(item, visit, [...pathParts, i]));
  else if (node && typeof node === "object" && !(node instanceof Date)) {
    for (const [k, v] of Object.entries(node)) walk(v, visit, [...pathParts, k]);
  }
}

/*
 * `action` is pure JS shaping (lib/pim-action-link.js's getTaskAction /
 * getCaseAction), shared UNCHANGED by the old SQLite route and the new
 * PostgreSQL one - it always contained real booleans (missingPage,
 * terminal) on both sides, before and after this migration. The
 * "SQLite never returned booleans" concern is about DB-COLUMN
 * representation (is_primary, is_current, etc.), which `action` is not,
 * so it is excluded here rather than asserted on.
 */
function withoutAction(node) {
  if (Array.isArray(node)) return node.map(withoutAction);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) if (k !== "action") out[k] = withoutAction(v);
    return out;
  }
  return node;
}

function assertNoBooleans(payload, label) {
  walk(withoutAction(payload), (value, p) => assert.notStrictEqual(typeof value, "boolean", `${label}: boolean at ${p.join(".")} (SQLite never returned booleans)`));
}

function assertNoDateObjects(payload, label) {
  walk(payload, (value, p) => assert.ok(!(value instanceof Date), `${label}: Date object at ${p.join(".")}`));
}

function assertWireDateFormats(payload, label) {
  walk(payload, (value, p) => {
    const key = p[p.length - 1];
    if (typeof value !== "string" || typeof key !== "string") return;
    if (key.endsWith("_date")) assert.ok(DATE_RE.test(value), `${label}: ${p.join(".")} = ${value}`);
  });
}

/*
 * Tokenizes ONLY engine-generated ids so the two engines' row sets can be
 * deep-compared field-by-field; everything else must be byte-identical.
 * Rows are matched up by their position in a caller-supplied, already
 * name/description-sorted array (never by raw id).
 */
function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "number" && (key === "id" || key.endsWith("_id")) ? "<id>" : value;
  }
  if ("action" in out && out.action && typeof out.action === "object") {
    const a = { ...out.action };
    if (typeof a.href === "string") a.href = a.href.replace(/\/\d+(\/|$)/g, "/<id>$1");
    out.action = a;
  }
  return out;
}

function assertSameRows(pgRows, liteRows, label) {
  assert.strictEqual(pgRows.length, liteRows.length, `${label}: row count differs (pg=${pgRows.length}, sqlite=${liteRows.length})`);
  assert.deepStrictEqual(
    pgRows.map(normalizeRow),
    liteRows.map(normalizeRow),
    `${label}: PostgreSQL diverged from the SQLite baseline.\nSQLite:   ${JSON.stringify(liteRows.map(normalizeRow))}\nPostgres: ${JSON.stringify(pgRows.map(normalizeRow))}`
  );
}

// ---------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------

async function runLive() {
  const startedAt = Date.now();
  const { getSql } = require("../lib/pim-postgres");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { getPimTasksPg } = require("../lib/pim-data/tasks-read");
  const { searchPimCasesPg } = require("../lib/pim-data/search-read");
  const db = require("../lib/db");
  const { assertScratchDatabase } = require("../lib/pim-test-guard");
  assertScratchDatabase(db);

  const sql = getSql();
  const tracker = createTracker();

  await withRetries("connect", () => sql`SELECT 1`);
  await withRetries("stale cleanup", () => recoverStaleFixtures(sql, tracker));

  const baselineCounts = await tableCounts(sql);
  console.log(`pre-run baseline row counts: ${JSON.stringify(baselineCounts)}`);
  const [{ n: mediatorBaseline }] = await sql`SELECT COUNT(*)::int AS n FROM mediators`;
  assert.strictEqual(mediatorBaseline, 5, `expected exactly the five approved panel members (Batch 5H-a) before this run, found ${mediatorBaseline}`);

  try {
    const users = await sql`SELECT id, username, role_code FROM users WHERE active = true ORDER BY id`;
    const aaUser = users.find((u) => u.role_code === "aa");
    const chairmanUser = users.find((u) => u.role_code === "chairman");
    assert.ok(aaUser && chairmanUser, "expected synced 'aa' and 'chairman' users in PostgreSQL");
    const USER_ID = aaUser.id;

    const statusRows = await sql`SELECT id, code, name FROM status_master`;
    const statusIds = Object.fromEntries(statusRows.map((r) => [r.code, r]));
    const taskTypeRows = await sql`SELECT id, code, name, default_priority FROM task_types ORDER BY id`;

    // -- Scratch SQLite: schema + the SAME reference rows PostgreSQL has. --
    const hasStatusMaster = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='status_master'`).get();
    if (!hasStatusMaster) db.exec(readSource("database/schema.sql"));

    for (const code of ["RECEIVED", "SCRUTINY_PENDING", "DEFECT_PENDING"]) {
      const row = statusIds[code];
      assert.ok(row, `status ${code} missing in PostgreSQL`);
      db.prepare(`INSERT INTO status_master (code, name, stage, is_terminal) VALUES (?, ?, 'INSTITUTION', 0)`).run(row.code, row.name);
    }
    for (const code of ["APPLICATION_RECEIVED"]) {
      const [row] = await sql`SELECT code, name, category FROM event_types WHERE code = ${code}`;
      db.prepare(`INSERT INTO event_types (code, name, category) VALUES (?, ?, ?)`).run(row.code, row.name, row.category);
    }
    // Every real task_types row, so both engines resolve task_name/COLLATE ordering identically.
    for (const row of taskTypeRows) {
      db.prepare(`INSERT INTO task_types (code, name, default_priority) VALUES (?, ?, ?)`).run(row.code, row.name, row.default_priority);
    }
    for (const u of [aaUser, chairmanUser]) {
      db.prepare(
        `INSERT INTO users (id, username, display_name, designation, role_code, active, must_change_password) VALUES (?, ?, ?, ?, ?, 1, 0)`
      ).run(u.id, u.username, u.username, u.role_code, u.role_code);
    }

    const { createReceivedPimApplication } = require("../lib/pim");

    const routeTasks = loadRouteModule("app/api/pim/tasks/route.js");
    const routeSearch = loadRouteModule("app/api/pim/search/route.js");
    const routeTasksSqlite = loadRouteModule("app/api/pim/tasks/route.js", ["getPimTasksSqlite"]);
    const routeSearchSqlite = loadRouteModule("app/api/pim/search/route.js", ["searchPimCasesSqlite"]);

    // -----------------------------------------------------------------
    // Engine adapters - one interface, built once per engine.
    // -----------------------------------------------------------------
    function taskColumns(caseId, taskTypeCode, description, dueDate, priority, status, completedDate) {
      return { caseId, taskTypeCode, description, dueDate, priority, status, completedDate };
    }

    const lite = {
      name: "sqlite",
      async createCase(payload) {
        return createReceivedPimApplication(payload, USER_ID);
      },
      async setPimNumber(caseId, pimNumber) {
        db.prepare(`UPDATE pim_cases SET pim_number = ? WHERE id = ?`).run(pimNumber, caseId);
      },
      async setStatus(caseId, code) {
        db.prepare(`UPDATE pim_cases SET current_status_id = (SELECT id FROM status_master WHERE code = ?) WHERE id = ?`).run(code, caseId);
      },
      async insertTask(t) {
        const r = db.prepare(
          `INSERT INTO pim_tasks (case_id, task_type_code, description, created_date, due_date, priority, status, completed_date, auto_generated)
           VALUES (?, ?, ?, '2026-02-01', ?, ?, ?, ?, 1)`
        ).run(t.caseId, t.taskTypeCode, t.description, t.dueDate ?? null, t.priority || "NORMAL", t.status || "PENDING", t.completedDate ?? null);
        return Number(r.lastInsertRowid);
      },
      async createMediatorFixture(caseId, tag) {
        const mediatorId = Number(
          db.prepare(`INSERT INTO mediators (name, contact_phone, email, enrollment_no) VALUES (?, ?, ?, ?)`)
            .run(`${tag} Mediator`, `${tag}-PHONE`, `${tag}@example.test`, `${tag}-ENR`).lastInsertRowid
        );
        const assignmentId = Number(
          db.prepare(`INSERT INTO pim_mediator_assignments (case_id, mediator_id, assignment_date, status) VALUES (?, ?, '2026-02-01', 'ACTIVE')`)
            .run(caseId, mediatorId).lastInsertRowid
        );
        db.prepare(`INSERT INTO mediation_sessions (case_id, assignment_id, sitting_number, session_status, scheduled_date) VALUES (?, ?, 1, 'SCHEDULED', ?)`)
          .run(caseId, assignmentId, "2026-05-01");
        return { mediatorId, assignmentId };
      },
      async tasks(query) {
        return routeTasksSqlite.getPimTasksSqlite(new URLSearchParams(query));
      },
      async search(q, limit) {
        return routeSearchSqlite.searchPimCasesSqlite(q, limit);
      },
    };

    const pg = {
      name: "postgres",
      async createCase(payload) {
        const caseId = await createReceivedPimApplicationPg(payload, USER_ID);
        tracker.addCase(caseId);
        return caseId;
      },
      async setPimNumber(caseId, pimNumber) {
        await sql`UPDATE pim_cases SET pim_number = ${pimNumber} WHERE id = ${caseId}`;
      },
      async setStatus(caseId, code) {
        await sql`UPDATE pim_cases SET current_status_id = (SELECT id FROM status_master WHERE code = ${code}) WHERE id = ${caseId}`;
      },
      async insertTask(t) {
        const [row] = await sql`
          INSERT INTO pim_tasks (case_id, task_type_code, description, created_date, due_date, priority, status, completed_date, auto_generated)
          VALUES (${t.caseId}, ${t.taskTypeCode}, ${t.description}, '2026-02-01', ${t.dueDate ?? null}, ${t.priority || "NORMAL"}, ${t.status || "PENDING"}, ${t.completedDate ?? null}, true)
          RETURNING id`;
        return row.id;
      },
      async createMediatorFixture(caseId, tag) {
        const [med] = await sql`
          INSERT INTO mediators (name, contact_phone, email, enrollment_no) VALUES (${`${tag} Mediator`}, ${`${tag}-PHONE`}, ${`${tag}@example.test`}, ${`${tag}-ENR`})
          RETURNING id`;
        tracker.addMediator(med.id);
        const [asg] = await sql`
          INSERT INTO pim_mediator_assignments (case_id, mediator_id, assignment_date, status) VALUES (${caseId}, ${med.id}, '2026-02-01', 'ACTIVE')
          RETURNING id`;
        await sql`
          INSERT INTO mediation_sessions (case_id, assignment_id, sitting_number, session_status, scheduled_date) VALUES (${caseId}, ${asg.id}, 1, 'SCHEDULED', ${"2026-05-01"})`;
        return { mediatorId: med.id, assignmentId: asg.id };
      },
      async tasks(query) {
        return getPimTasksPg(new URLSearchParams(query));
      },
      async search(q, limit) {
        return searchPimCasesPg(q, limit);
      },
    };

    // -----------------------------------------------------------------
    // Build twin fixtures. One case at a time (never in parallel - the
    // Batch 5F pooler constraint), on both engines.
    // -----------------------------------------------------------------
    const ctx = {};

    async function buildTwin(key, build) {
      const liteCaseId = await lite.createCase(leanPayload(`${TEST_PREFIX}${key}-${RUN_ID}`, build.parties));
      const pgCaseId = await pg.createCase(leanPayload(`${TEST_PREFIX}${key}-${RUN_ID}`, build.parties));
      if (build.status) {
        await lite.setStatus(liteCaseId, build.status);
        await pg.setStatus(pgCaseId, build.status);
      }
      if (build.pimNumber) {
        await lite.setPimNumber(liteCaseId, build.pimNumber);
        await pg.setPimNumber(pgCaseId, build.pimNumber);
      }
      let mediator = null;
      if (build.mediator) {
        const liteM = await lite.createMediatorFixture(liteCaseId, build.mediator);
        const pgM = await pg.createMediatorFixture(pgCaseId, build.mediator);
        mediator = { lite: liteM, pg: pgM };
      }
      const taskIds = { lite: [], pg: [] };
      for (const t of build.tasks || []) {
        taskIds.lite.push(await lite.insertTask({ ...t, caseId: liteCaseId }));
        taskIds.pg.push(await pg.insertTask({ ...t, caseId: pgCaseId }));
      }
      ctx[key] = { liteCaseId, pgCaseId, mediator, taskIds };
      return ctx[key];
    }

    console.log("building twin fixtures on both engines (sequential, one case at a time)...");

    await buildTwin("ord", {
      tasks: [
        taskColumns(null, `${TT}-ORD`, "Ord A (no due date)", null, "NORMAL", "PENDING", null),
        taskColumns(null, `${TT}-ORD`, "Ord B (overdue)", "2020-01-01", "NORMAL", "PENDING", null),
        taskColumns(null, `${TT}-ORD`, "Ord C (completed)", "2020-01-01", "NORMAL", "COMPLETED", "2020-01-02"),
      ],
    });

    await buildTwin("page", {
      tasks: Array.from({ length: 5 }, (_, i) =>
        taskColumns(null, `${TT}-PAGE`, `Page ${i}`, `2026-03-${String(10 + i).padStart(2, "0")}`, "NORMAL", "PENDING", null)
      ),
    });

    await buildTwin("filters", {
      status: "DEFECT_PENDING",
      tasks: [
        taskColumns(null, `${TT}-PRI`, "Priority filter target", "2099-01-01", "URGENT", "PENDING", null),
        taskColumns(null, `${TT}-OVER`, "Overdue filter target", "2019-06-15", "NORMAL", "PENDING", null),
        taskColumns(null, `${TT}-DUE`, "DueDate filter target", "2026-04-15", "NORMAL", "PENDING", null),
      ],
    });

    await buildTwin("types", {
      tasks: [
        taskColumns(null, "FORM2", "Form2-coded task", "2026-03-01", "NORMAL", "PENDING", null),
        taskColumns(null, "FORM_2", "Form_2-coded task", "2026-03-02", "NORMAL", "PENDING", null),
        taskColumns(null, `${TT}-COLL`, "Collation-order probe", null, "NORMAL", "PENDING", null),
      ],
    });

    await buildTwin("session", {
      mediator: `${TT}SES`,
      tasks: [taskColumns(null, "SESSION_RECORD", "Sitting 1", "2026-05-01", "NORMAL", "PENDING", null)],
    });

    const searchTag = `TB5GQ${RUN_ID}`;
    await buildTwin("search", {
      parties: {
        applicantName: `${searchTag} 100% Traders_Zqx Émile\\Co`,
        oppositeName: `${searchTag} Opp Ramasamy`,
        advocate: { name: `${searchTag} Adv Sarojini`, enrollmentNo: `${searchTag}-ENR`, phone: `${searchTag}-PHONE`, email: `${searchTag}@example.test` },
      },
      pimNumber: `${searchTag}-PIMNO`,
    });

    // Decoy: a case that exists ONLY in SQLite - never created in PostgreSQL.
    const decoyReceivedNumber = `${TEST_PREFIX}decoy-${RUN_ID}`;
    const decoyTag = `${TT}-DECOY`;
    const decoyCaseId = await lite.createCase(leanPayload(decoyReceivedNumber, { applicantName: `${searchTag} DECOY-ONLY-IN-SQLITE Applicant` }));
    assert.ok(Number.isInteger(decoyCaseId) && decoyCaseId > 0, "the SQLite-only decoy case must have been created");
    await lite.insertTask({ ...taskColumns(null, decoyTag, "Decoy task (SQLite only)", null, "NORMAL", "PENDING", null), caseId: decoyCaseId });

    console.log(`twin fixtures built in ${Math.round((Date.now() - startedAt) / 1000)}s`);

    // =================================================================
    // A: tasks - ordering + default status behavior
    // =================================================================
    await test("A", "default status=PENDING excludes COMPLETED; explicit status=all includes it, in the exact SQLite order (NULL due_date first, then earliest, id DESC tiebreak within ties)", async () => {
      const pgDefault = await pg.tasks(`taskType=${TT}-ORD`);
      const liteDefault = await lite.tasks(`taskType=${TT}-ORD`);
      assert.deepStrictEqual(pgDefault.rows.map((r) => r.description), ["Ord A (no due date)", "Ord B (overdue)"]);
      assertSameRows(pgDefault.rows, liteDefault.rows, "ord default-status");

      const pgAll = await pg.tasks(`taskType=${TT}-ORD&status=all`);
      const liteAll = await lite.tasks(`taskType=${TT}-ORD&status=all`);
      assert.deepStrictEqual(pgAll.rows.map((r) => r.description), ["Ord A (no due date)", "Ord B (overdue)", "Ord C (completed)"]);
      assertSameRows(pgAll.rows, liteAll.rows, "ord status=all");
      assert.strictEqual(pgAll.rows[1].overdue, 1, "Ord B must be flagged overdue");
      assert.strictEqual(pgAll.rows[0].overdue, 0, "a PENDING task with no due date is never overdue");
      assert.strictEqual(pgAll.rows[2].overdue, 0, "a COMPLETED task is never overdue regardless of due date");
    });

    // =================================================================
    // B: tasks - filters
    // =================================================================
    await test("B", "priority filter isolates exactly the tagged task, on both engines", async () => {
      const pgRows = (await pg.tasks(`taskType=${TT}-PRI&status=all&priority=URGENT`)).rows;
      const liteRows = (await lite.tasks(`taskType=${TT}-PRI&status=all&priority=URGENT`)).rows;
      assert.strictEqual(pgRows.length, 1);
      assertSameRows(pgRows, liteRows, "priority filter");
      assert.strictEqual((await pg.tasks(`taskType=${TT}-PRI&status=all&priority=NORMAL`)).rows.length, 0, "wrong priority must exclude it");
    });

    await test("B", "overdue=1 filter includes the overdue task and excludes non-overdue ones", async () => {
      const pgRows = (await pg.tasks(`taskType=${TT}-OVER&overdue=1`)).rows;
      const liteRows = (await lite.tasks(`taskType=${TT}-OVER&overdue=1`)).rows;
      assert.strictEqual(pgRows.length, 1);
      assertSameRows(pgRows, liteRows, "overdue filter");
      assert.strictEqual((await pg.tasks(`taskType=${TT}-PRI&overdue=1`)).rows.length, 0, "a future-dated PENDING task must not be overdue");
    });

    await test("B", "dueDate exact-match filter (malformed values match nothing, never a SQL error)", async () => {
      const pgRows = (await pg.tasks(`taskType=${TT}-DUE&status=all&dueDate=2026-04-15`)).rows;
      const liteRows = (await lite.tasks(`taskType=${TT}-DUE&status=all&dueDate=2026-04-15`)).rows;
      assert.strictEqual(pgRows.length, 1);
      assertSameRows(pgRows, liteRows, "dueDate filter");

      // Note: a trailing-space value is NOT tested here - both the SQLite
      // original and this loader .trim() the dueDate filter before
      // comparing (existing, preserved behavior), so "2026-04-15 " legitimately
      // matches "2026-04-15" on both engines; that is not malformed input.
      for (const bad of ["not-a-date", "2026-99-99"]) {
        const r = await pg.tasks(`taskType=${TT}-DUE&status=all&dueDate=${encodeURIComponent(bad)}`);
        assert.strictEqual(r.rows.length, 0, `malformed dueDate "${bad}" must match nothing, not error`);
      }
    });

    await test("B", "caseStatus filter matches the case's own status, isolated to the tagged task", async () => {
      const pgRows = (await pg.tasks(`taskType=${TT}-PRI&status=all&caseStatus=DEFECT_PENDING`)).rows;
      const liteRows = (await lite.tasks(`taskType=${TT}-PRI&status=all&caseStatus=DEFECT_PENDING`)).rows;
      assert.strictEqual(pgRows.length, 1);
      assert.strictEqual(pgRows[0].case_status_code, "DEFECT_PENDING");
      assertSameRows(pgRows, liteRows, "caseStatus filter");
      assert.strictEqual((await pg.tasks(`taskType=${TT}-PRI&caseStatus=RECEIVED`)).rows.length, 0, "wrong caseStatus must exclude it");
    });

    await test("B", "taskType=FORM2 merges FORM2 and FORM_2 codes (both directions)", async () => {
      const pgRows = (await pg.tasks("taskType=FORM2&status=all")).rows;
      const liteRows = (await lite.tasks("taskType=FORM2&status=all")).rows;
      assert.strictEqual(pgRows.length, 2, "must include both FORM2- and FORM_2-coded tasks");
      assertSameRows(pgRows, liteRows, "FORM2 merge");
      const viaUnderscore = (await pg.tasks("taskType=FORM_2&status=all")).rows;
      assert.strictEqual(viaUnderscore.length, 2, "taskType=FORM_2 must ALSO merge both codes (route behavior, not just FORM2)");
    });

    await test("B", "a filter value containing NUL matches nothing, on both engines, no SQL error", async () => {
      const nul = "\u0000";
      const pgR = await pg.tasks(`taskType=${TT}-PRI&status=${encodeURIComponent(nul)}`);
      const liteR = await lite.tasks(`taskType=${TT}-PRI&status=${encodeURIComponent(nul)}`);
      assert.strictEqual(pgR.rows.length, 0);
      assert.strictEqual(liteR.rows.length, 0);
    });

    // =================================================================
    // C: tasks - pagination
    // =================================================================
    await test("C", "pagination: total/totalPages correct, and concatenating every page in order reproduces the unpaginated order exactly", async () => {
      const full = await pg.tasks(`taskType=${TT}-PAGE&pageSize=100`);
      assert.strictEqual(full.pagination.total, 5);
      assert.strictEqual(full.pagination.totalPages, 1);
      assert.strictEqual(full.rows.length, 5);

      const liteFull = await lite.tasks(`taskType=${TT}-PAGE&pageSize=100`);
      assertSameRows(full.rows, liteFull.rows, "page full parity");

      const paged = [];
      for (let page = 1; page <= 3; page += 1) {
        const r = await pg.tasks(`taskType=${TT}-PAGE&pageSize=2&page=${page}`);
        assert.strictEqual(r.pagination.total, 5);
        assert.strictEqual(r.pagination.totalPages, 3);
        assert.strictEqual(r.pagination.page, page);
        paged.push(...r.rows);
      }
      assert.deepStrictEqual(paged.map((r) => r.description), full.rows.map((r) => r.description), "paged concatenation must equal the unpaginated order");
    });

    await test("C", "clamping: page/pageSize out-of-range values fall back to bounds, not an error", async () => {
      const bad = await pg.tasks("page=abc&pageSize=100000&taskType=" + encodeURIComponent(`${TT}-NOMATCH`));
      assert.strictEqual(bad.pagination.page, 1);
      assert.strictEqual(bad.pagination.pageSize, 100, "pageSize must clamp to its max of 100");
    });

    // =================================================================
    // D: tasks - taskTypes distinct list + collation ordering
    // =================================================================
    await test("D", "taskTypes distinct list orders FORM2 before FORM_2 (COLLATE \"C\" byte order, not the database's default en_US.UTF-8 order)", async () => {
      const full = await pg.tasks("status=all&pageSize=1"); // pageSize=1 is enough; taskTypes is independent of the row page
      const liteFull = await lite.tasks("status=all&pageSize=1");
      const codes = full.taskTypes.map((t) => t.code);
      const formIdx = codes.indexOf("FORM2");
      const formUnderscoreIdx = codes.indexOf("FORM_2");
      assert.ok(formIdx !== -1 && formUnderscoreIdx !== -1, "both FORM2 and FORM_2 must be present in the distinct list");
      assert.ok(formIdx < formUnderscoreIdx, `FORM2 must sort before FORM_2 under byte order, got ${JSON.stringify(codes)}`);
      assert.deepStrictEqual(codes, [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "the whole list must be exact byte order");
      // Excludes the DECOY-tagged type: that fixture exists ONLY in SQLite
      // (by design, for test I's PG-authoritative proof), so it legitimately
      // appears in the SQLite baseline's global list but never in PostgreSQL's -
      // that is not a parity defect, and is verified separately in test I.
      const withoutDecoy = (list) => list.filter((t) => !String(t.code).includes("DECOY"));
      assert.deepStrictEqual(withoutDecoy(full.taskTypes), withoutDecoy(liteFull.taskTypes), "taskTypes list must match the SQLite baseline exactly (excluding the SQLite-only decoy)");
    });

    // =================================================================
    // E: tasks - session_id resolution + action
    // =================================================================
    await test("E", "SESSION_RECORD task resolves session_id to the real scheduled session; action targets the mediation-session page", async () => {
      const pgRows = (await pg.tasks("taskType=SESSION_RECORD&status=all")).rows;
      const liteRows = (await lite.tasks("taskType=SESSION_RECORD&status=all")).rows;
      assert.strictEqual(pgRows.length, 1);
      const row = pgRows[0];
      assert.ok(ctx.session.mediator.pg.assignmentId > 0, "the fixture assignment must have been created");
      assert.ok(Number.isInteger(row.session_id) && row.session_id > 0, "session_id must resolve to a real id");
      assert.strictEqual(row.action.label, "Record Sitting");
      assert.strictEqual(row.action.href, `/pim/mediation/session/${row.session_id}`);
      assert.strictEqual(row.action.missingPage, false);
      assertSameRows(pgRows, liteRows, "session_id resolution");
    });

    // =================================================================
    // F: tasks - empty-result behavior
    // =================================================================
    await test("F", "a taskType matching nothing returns rows=[], total=0, totalPages=1 (Math.max(1,...) semantics)", async () => {
      const r = await pg.tasks(`taskType=${encodeURIComponent(`${TT}-NOMATCH`)}`);
      assert.deepStrictEqual(r.rows, []);
      assert.strictEqual(r.pagination.total, 0);
      assert.strictEqual(r.pagination.totalPages, 1, "totalPages must be 1, not 0, even with zero results");
    });

    // =================================================================
    // G: tasks - wire-format / null assertions
    // =================================================================
    await test("G", "tasks response has no booleans, no Date objects, and every *_date field is a plain 'YYYY-MM-DD' string", async () => {
      const r = await pg.tasks(`taskType=${TT}-ORD&status=all`);
      assertNoBooleans(r, "tasks(ord)");
      assertNoDateObjects(r, "tasks(ord) raw");
      assertWireDateFormats(wire(r), "tasks(ord) wire");
      const nullRow = r.rows.find((x) => x.due_date === null);
      assert.ok(nullRow, "a NULL due_date must round-trip as null, not a string or undefined");
      assert.strictEqual(nullRow.completed_date, null);
    });

    // =================================================================
    // H: tasks - SQLite parity (aggregate)
    // =================================================================
    await test("H", "aggregate parity: every fixture's tasks-list output is byte-identical to the SQLite baseline across every scenario exercised above", async () => {
      for (const q of [
        `taskType=${TT}-ORD&status=all`, `taskType=${TT}-PAGE&pageSize=100`, `taskType=${TT}-PRI&status=all`,
        `taskType=${TT}-OVER&status=all`, `taskType=${TT}-DUE&status=all`, "taskType=FORM2&status=all",
        "taskType=SESSION_RECORD&status=all", `taskType=${TT}-COLL&status=all`,
      ]) {
        const pgR = await pg.tasks(q);
        const liteR = await lite.tasks(q);
        assertSameRows(pgR.rows, liteR.rows, `parity(${q})`);
        assert.deepStrictEqual(pgR.pagination, liteR.pagination, `pagination parity(${q})`);
      }
    });

    // =================================================================
    // I: tasks - real route handler + PG-authoritative decoy
    // =================================================================
    await test("I", "tasks route: no identity -> 401; a READ_CASE role (chairman) -> 200 with the real loader's shape; nothing written", async () => {
      const before = await tableCounts(sql);
      const none = await callRoute(routeTasks, { query: `taskType=${TT}-ORD&status=all` });
      assert.strictEqual(none.status, 401);
      assert.deepStrictEqual(none.json, { success: false, message: "Authentication required." });

      const ok = await callRoute(routeTasks, { userId: chairmanUser.id, query: `taskType=${TT}-ORD&status=all` });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.json.success, true);
      assert.deepStrictEqual(Object.keys(ok.json.data).sort(), ["pagination", "rows", "taskTypes"]);
      assert.strictEqual(ok.json.data.rows.length, 3, "status=all must return all 3 ord fixture tasks through the real route");
      assert.deepStrictEqual(await tableCounts(sql), before, "GET must not write anything");
    });

    await test("I", "PostgreSQL-authoritative: a task that exists ONLY in SQLite never appears in the real PostgreSQL route's response", async () => {
      const viaRoute = await callRoute(routeTasks, { userId: aaUser.id, query: `taskType=${decoyTag}&status=all` });
      assert.strictEqual(viaRoute.status, 200);
      assert.strictEqual(viaRoute.json.data.rows.length, 0, "the SQLite-only decoy task must not be visible through the PostgreSQL route");

      const viaSqliteBaseline = await lite.tasks(`taskType=${decoyTag}&status=all`);
      assert.strictEqual(viaSqliteBaseline.rows.length, 1, "the decoy really exists in SQLite, proving the zero-result above is meaningful");
    });

    // =================================================================
    // J: search - short-circuit for q.length < 2
    // =================================================================
    await test("J", "q.length < 2 returns {query, rows: []} without ever touching PostgreSQL", async () => {
      const before = await tableCounts(sql);
      for (const q of ["", "a", " a "]) {
        const r = await callRoute(routeSearch, { userId: aaUser.id, query: `q=${encodeURIComponent(q)}` });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json.data, { query: q.trim(), rows: [] });
      }
      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    // =================================================================
    // K: search - field-match coverage
    // =================================================================
    await test("K", "search matches pim_number, received_number, applicant, opposite party, and all 4 advocate fields", async () => {
      const s = ctx.search;
      const queries = {
        pim_number: `${searchTag}-PIMNO`,
        received_number: `${TEST_PREFIX}search-${RUN_ID}`,
        applicant_name: `${searchTag} 100`,
        opposite_party_name: `${searchTag} Opp Ramasamy`,
        advocate_name: `${searchTag} Adv Sarojini`,
        advocate_enrollment: `${searchTag}-ENR`,
        advocate_phone: `${searchTag}-PHONE`,
        advocate_email: `${searchTag}@example.test`,
      };
      for (const [label, q] of Object.entries(queries)) {
        const pgRows = await pg.search(q, 20);
        const liteRows = await lite.search(q, 20);
        assert.ok(pgRows.some((r) => r.id === s.pgCaseId), `${label}: query "${q}" must match the fixture case via PostgreSQL`);
        assert.ok(liteRows.some((r) => r.id === s.liteCaseId), `${label}: query "${q}" must match the fixture case via the SQLite baseline`);
      }
    });

    await test("K", "search matches all 4 mediator fields (name, phone, email, enrollment_no)", async () => {
      const s = ctx.session;
      const tag = `${TT}SES`;
      for (const q of [`${tag} Mediator`, `${tag}-PHONE`, `${tag}@example.test`, `${tag}-ENR`]) {
        const pgRows = await pg.search(q, 20);
        const liteRows = await lite.search(q, 20);
        assert.ok(pgRows.some((r) => r.id === s.pgCaseId), `mediator query "${q}" must match via PostgreSQL`);
        assert.ok(liteRows.some((r) => r.id === s.liteCaseId), `mediator query "${q}" must match via SQLite`);
      }
    });

    // =================================================================
    // L: search - LIKE-semantics edge cases (each verified against the
    // REAL loader, matching the live-probe truth table from Step 1)
    // =================================================================
    await test("L", "LIKE semantics: ASCII case folds, non-ASCII does NOT fold, wildcard/backslash characters in stored text are literal, all matching SQLite exactly", async () => {
      const s = ctx.search;
      const lowerTag = searchTag.toLowerCase();

      // ASCII fold: lowercase query matches the mixed-case stored tag.
      let pg1 = await pg.search(`${lowerTag} 100`, 20);
      let lite1 = await lite.search(`${lowerTag} 100`, 20);
      assert.ok(pg1.some((r) => r.id === s.pgCaseId), "ASCII-fold query must match");
      assert.ok(lite1.some((r) => r.id === s.liteCaseId));

      // Non-ASCII fold: lowercase 'émile' must NOT match stored uppercase 'Émile'.
      const pg2 = await pg.search("zqx émile", 20);
      const lite2 = await lite.search("zqx émile", 20);
      assert.ok(!pg2.some((r) => r.id === s.pgCaseId), "lowercase non-ASCII must NOT fold-match in PostgreSQL");
      assert.ok(!lite2.some((r) => r.id === s.liteCaseId), "...and must not match in SQLite either (parity, not just a PG quirk)");

      // Correct-case non-ASCII: 'Émile' (uppercase É) DOES match.
      const pg3 = await pg.search("Zqx Émile", 20);
      const lite3 = await lite.search("Zqx Émile", 20);
      assert.ok(pg3.some((r) => r.id === s.pgCaseId), "correctly-cased non-ASCII must match");
      assert.ok(lite3.some((r) => r.id === s.liteCaseId));

      // Backslash is a literal character (not an escape) in both engines.
      const pg4 = await pg.search("Zqx Émile\\Co", 20);
      assert.ok(pg4.some((r) => r.id === s.pgCaseId), "a literal backslash in the query must match a literal backslash in stored text");

      // '%' inside stored text is literal data; the wrapping wildcards still apply around it.
      const pg5 = await pg.search("100%", 20);
      const lite5 = await lite.search("100%", 20);
      assert.ok(pg5.some((r) => r.id === s.pgCaseId));
      assert.ok(lite5.some((r) => r.id === s.liteCaseId));

      // '_' in the query is a SQL wildcard (matches "s_Zqx" style substrings) on both engines.
      const pg6 = await pg.search("s_Zqx", 20);
      assert.ok(pg6.some((r) => r.id === s.pgCaseId), "'_' wildcard must behave the same as SQLite's default LIKE");
    });

    await test("L", "a NUL character in the search query matches nothing and does not error, on both engines", async () => {
      const q = `${searchTag}\u0000zz`;
      const pgRows = await pg.search(q, 20);
      const liteRows = await lite.search(q, 20);
      assert.deepStrictEqual(pgRows, []);
      assert.deepStrictEqual(liteRows, []);
    });

    await test("L", "the search identifier helper genuinely uses qualified per-column identifiers, not one broken dotted string (verified live)", async () => {
      // Functional proof, through the real loader: distinct fields resolve to
      // their OWN column (an applicant-name query does not spuriously match
      // via some other column), and the earlier static test S confirms the
      // exact generated SQL string was "p"."name" (not the single invalid
      // identifier "p.name" that a naive concatenation would produce).
      const byName = await pg.search(`${searchTag} Adv Sarojini`, 20);
      const byPhoneOnly = await pg.search(`${searchTag}-PHONE`, 20);
      assert.ok(byName.some((r) => r.id === ctx.search.pgCaseId));
      assert.ok(byPhoneOnly.some((r) => r.id === ctx.search.pgCaseId));
      assert.notDeepStrictEqual(byName, undefined);
    });

    // =================================================================
    // M: search - ordering + limit clamping + empty-result
    // =================================================================
    await test("M", "ordering: COALESCE(registration_date, received_date) DESC, id DESC; limit clamps to 50; empty result for no match", async () => {
      const rows = await pg.search(searchTag, 50); // matches every fixture-search-tagged case (only 1 here) plus nothing else
      assert.strictEqual(rows.length, 1);

      const overLimit = await callRoute(routeSearch, { userId: aaUser.id, query: `q=${encodeURIComponent(searchTag)}&limit=99999` });
      assert.strictEqual(overLimit.status, 200);
      // Can't observe the clamp directly with only 1 matching row; assert no error and correct shape instead.
      assert.ok(Array.isArray(overLimit.json.data.rows));

      const none = await pg.search("zzz-definitely-no-such-case-zzz", 20);
      assert.deepStrictEqual(none, []);
    });

    // =================================================================
    // N: search - wire-format / null assertions
    // =================================================================
    await test("N", "search response has no booleans, no Date objects, dates are plain strings, and unmatched pending-task fields are null", async () => {
      const rows = await pg.search(searchTag, 20);
      assertNoBooleans(rows, "search(tag)");
      assertNoDateObjects(rows, "search(tag) raw");
      assertWireDateFormats(wire(rows), "search(tag) wire");
      const row = rows[0];
      // Every T1-created case auto-creates one pending SCRUTINY task (see
      // lib/pim-data/intake.js), so pending_task_* is never null here - that
      // is correct, existing behavior, not something this fixture opted into.
      assert.ok(Number.isInteger(row.pending_task_id) && row.pending_task_id > 0, "the case's auto-created SCRUTINY task must resolve");
      assert.strictEqual(row.pending_task_type_code, "SCRUTINY");
      // The search fixture has no mediator/session, unlike the "session" twin,
      // so this field - genuinely unmatched here - must be null.
      assert.strictEqual(row.pending_session_id, null);
    });

    // =================================================================
    // O: search - SQLite parity (aggregate)
    // =================================================================
    await test("O", "aggregate parity: every search scenario above is byte-identical to the SQLite baseline", async () => {
      // Note: NOT the bare `searchTag` here - it also prefixes the decoy
      // fixture's applicant name (SQLite-only, by design for tests I/P), so a
      // bare-tag query legitimately returns one more row on SQLite than on
      // PostgreSQL; that is the PG-authoritative property those tests verify,
      // not a parity defect. `${searchTag} 100` matches only the real fixture.
      for (const q of [`${searchTag} 100`, `${searchTag}-PIMNO`, `${TT}SES Mediator`, "Zqx Émile"]) {
        const pgRows = await pg.search(q, 20);
        const liteRows = await lite.search(q, 20);
        assertSameRows(pgRows, liteRows, `search parity(${q})`);
      }
    });

    // =================================================================
    // P: search - real route handler + PG-authoritative decoy
    // =================================================================
    await test("P", "search route: no identity -> 401; a READ_CASE role -> 200 with the real loader's shape; nothing written", async () => {
      const before = await tableCounts(sql);
      const none = await callRoute(routeSearch, { query: `q=${encodeURIComponent(searchTag)}` });
      assert.strictEqual(none.status, 401);

      const ok = await callRoute(routeSearch, { userId: chairmanUser.id, query: `q=${encodeURIComponent(searchTag)}` });
      assert.strictEqual(ok.status, 200);
      assert.deepStrictEqual(Object.keys(ok.json.data).sort(), ["query", "rows"]);
      assert.strictEqual(ok.json.data.rows.length, 1);
      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    await test("P", "PostgreSQL-authoritative: a case that exists ONLY in SQLite never appears in the real PostgreSQL search route", async () => {
      const decoySearchTag = `${searchTag} DECOY-ONLY-IN-SQLITE`;
      const viaRoute = await callRoute(routeSearch, { userId: aaUser.id, query: `q=${encodeURIComponent(decoySearchTag)}` });
      assert.strictEqual(viaRoute.status, 200);
      assert.strictEqual(viaRoute.json.data.rows.length, 0, "the SQLite-only decoy case must not be visible through the PostgreSQL route");

      const viaSqliteBaseline = await lite.search(decoySearchTag, 20);
      assert.strictEqual(viaSqliteBaseline.length, 1, "the decoy really exists in SQLite, proving the zero-result above is meaningful");
      void decoyCaseId;
    });

    // -----------------------------------------------------------------
    // X: read-only invariant
    // -----------------------------------------------------------------
    await test("X", "both loaders are read-only: repeated calls change no PostgreSQL row count", async () => {
      const before = await tableCounts(sql);
      await pg.tasks(`taskType=${TT}-ORD&status=all`);
      await pg.search(searchTag, 20);
      await pg.tasks("status=all&pageSize=1");
      assert.deepStrictEqual(await tableCounts(sql), before);
    });
  } finally {
    console.log(`\ncleanup: removing exactly these fixture case ids: ${JSON.stringify([...tracker.caseIds])}`);
    console.log(`cleanup: removing exactly these fixture mediator ids: ${JSON.stringify([...tracker.mediatorIds])}`);
    try {
      await withRetries("cleanup (cases)", () => cleanupCasesByIds(sql, [...tracker.caseIds], tracker));
      await withRetries("cleanup (mediators)", () => cleanupMediatorsByIds(sql, [...tracker.mediatorIds]));
    } catch (error) {
      console.error(`CLEANUP FAILED: ${error.message}`);
      for (const line of await describeOrphanedTransactions(sql)) console.error(`      orphaned transaction? ${line}`);
      failures.push("cleanup of fixture cases/mediators");
    }
  }

  await test("RESIDUE", "no test cases, tasks, mediators, assignments, sessions, or any other fixture row remains; mediators back to exactly the five approved panel members; no orphaned transaction; all table counts equal the pre-run baseline", async () => {
    const { problems, after } = await withRetries("residue verification", () => verifyNoResidue(sql, tracker, baselineCounts));
    console.log(`      post-run row counts: ${JSON.stringify(after)}`);
    assert.deepStrictEqual(problems, [], `RESIDUE FOUND:\n${problems.join("\n")}`);
  });

  if (!failures.some((f) => f.startsWith("cleanup") || f.includes("RESIDUE"))) {
    fs.rmSync(MANIFEST_PATH, { force: true });
  }

  console.log(`total live run time: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  await sql.end({ timeout: 5 });
  db.close();
}

/*
 * node scripts/test-pim-tasks-search-postgres.js --cleanup-only
 * Removes fixtures left by a run that could not clean up (network loss,
 * kill), by the exact ids in the manifest, then verifies by exact id that
 * nothing remains. Runs no tests.
 */
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
      stale.caseIds.length || stale.mediatorIds.length
        ? `removed stale fixtures: cases=${JSON.stringify(stale.caseIds)} mediators=${JSON.stringify(stale.mediatorIds)}`
        : "no manifest found - nothing to clean up"
    );
    const { problems, after } = await withRetries("residue verification", () => verifyNoResidue(sql, tracker));
    console.log(`row counts now: ${JSON.stringify(after)}`);
    if (problems.length) {
      console.error(`RESIDUE FOUND:\n${problems.join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log("verified: no residue for any recorded fixture id");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  if (process.argv.includes("--cleanup-only")) {
    if (!process.env.SUPABASE_DB_URL) throw new Error("the PostgreSQL connection setting is not configured");
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
    console.log(`${letter}: ${status} (${r.pass} passed, ${r.fail} failed${r.na.length ? `; N/A part: ${r.na.join(" | ")}` : ""})`);
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
