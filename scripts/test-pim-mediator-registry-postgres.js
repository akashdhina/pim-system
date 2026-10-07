/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5H tests: the mediator-registry PostgreSQL migration -
 * POST /api/pim/mediators (create) and GET/PATCH /api/pim/mediators/[id]
 * (single-record view/edit), via lib/pim-data/mediator-registry.js and
 * lib/pim-data/mediator-registry-read.js. Completes the mediator roster's
 * PostgreSQL migration Batch 1 started with the list endpoint (unchanged,
 * not touched here) and explicitly deferred for these three operations.
 *
 * Usage:
 *   node scripts/test-pim-mediator-registry-postgres.js
 *   node scripts/test-pim-mediator-registry-postgres.js --cleanup-only
 *
 * Architecture follows Batches 5F/5G closely: SQLite baseline is the
 * ORIGINAL kept code (getMediatorSqlite / getMediatorDetailSqlite /
 * duplicateActiveEnrollmentSqlite / postMediatorSqlite, loaded from the
 * real route files, not re-implemented), exact-ID fixture tracking with a
 * recovery manifest and --cleanup-only, real route handlers driven
 * through requirePermission, per-test timeout so a pooler stall fails
 * loudly rather than hanging the run, bounded retries only for
 * connectivity-class errors.
 *
 * Unlike 5F/5G, this resource is NOT gated by case workflow status or T3 -
 * a mediator is a standalone roster entity - so no T1 case fixtures are
 * needed for the core CRUD tests. One small case + assignment + session
 * fixture (built via the already-verified T1 PG intake, matching the 5G
 * pattern) is used only for the aggregate-counts/ordering test (I).
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO_ROOT = path.join(__dirname, "..");
const SCRATCH_DB_PATH = path.join(REPO_ROOT, "database", "test-pim-mediator-registry.scratch.db");
const TEST_PREFIX = "TEST-B5H-";
const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-pim-mediator-registry-manifest.json");
const RUN_ID = Date.now();
const TAG = `TB5H${RUN_ID}`;
// Stable across every run/process invocation of this script (unlike TAG,
// which is unique PER RUN so fixture names/enrollment numbers never collide
// with leftovers) - used only for the cleanup safety check, which must
// still recognize a fixture created by a DIFFERENT run when recovering a
// stale manifest via --cleanup-only. Confirmed not a substring of either
// real mediator's name ("Mr.R.Ravikumar", "Mr.H.Rajesh").
const MEDIATOR_TAG_PREFIX = "TB5H";

for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  fs.rmSync(SCRATCH_DB_PATH + suffix, { force: true });
}
process.env.PIM_DB_PATH = SCRATCH_DB_PATH;
delete process.env.PIM_DEV_USER_ID;

// ---------------------------------------------------------------------
// Reporting / timeout harness
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Static tests
// ---------------------------------------------------------------------

function functionBody(source, header) {
  const start = source.indexOf(header);
  assert.ok(start !== -1, `${header} not found`);
  const rest = source.slice(start + header.length);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

async function runStaticTests() {
  await test("S", "POST /api/pim/mediators calls requirePermission(MANAGE_MEDIATOR) then the PostgreSQL create; the SQLite postMediatorSqlite is not called", () => {
    const source = readSource("app/api/pim/mediators/route.js");
    const body = functionBody(source, "export async function POST(request) {");
    const permission = body.indexOf('requirePermission(request, "MANAGE_MEDIATOR")');
    const call = body.indexOf("await createMediatorPg(");
    assert.ok(permission !== -1 && call > permission);
    assert.ok(!/[^\w]postMediatorSqlite\(/.test(body));
    assert.ok(source.includes("function postMediatorSqlite(input, userId)"));
  });

  await test("S", "GET/PATCH /api/pim/mediators/[id] call the PostgreSQL functions; the SQLite originals are not called", () => {
    const source = readSource("app/api/pim/mediators/[id]/route.js");
    const getBody = functionBody(source, "export async function GET(request, { params }) {");
    const patchBody = functionBody(source, "export async function PATCH(request, { params }) {");
    assert.ok(getBody.includes("await getMediatorDetailPg(id)"));
    assert.ok(!/[^\w]getMediatorDetailSqlite\(/.test(getBody));
    assert.ok(patchBody.includes("await getMediatorRawPg(id)"));
    assert.ok(patchBody.includes("await checkDuplicateActiveEnrollmentPg("));
    assert.ok(patchBody.includes("await updateMediatorPg("));
    assert.ok(!/[^\w]duplicateActiveEnrollmentSqlite\(/.test(patchBody));
    assert.ok(source.includes("function getMediatorDetailSqlite(id)"));
    assert.ok(source.includes("function duplicateActiveEnrollmentSqlite(enrollmentNo, id)"));
  });

  await test("S", "the registry modules are PostgreSQL-only: no SQLite, no fallback; writes are inside withTransaction; reads use getSql() directly", () => {
    const write = stripComments(readSource("lib/pim-data/mediator-registry.js"));
    const read = stripComments(readSource("lib/pim-data/mediator-registry-read.js"));
    for (const forbidden of ['require("../db")', 'require("./db")', ".prepare(", "lastInsertRowid"]) {
      assert.ok(!write.includes(forbidden), `mediator-registry.js contains ${forbidden}`);
      assert.ok(!read.includes(forbidden), `mediator-registry-read.js contains ${forbidden}`);
    }
    assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(read), "the read module must contain no write statement");
    assert.ok(write.includes("withTransaction(async (tx)"), "createMediatorPg/updateMediatorPg must each run inside withTransaction");
    assert.ok((write.match(/withTransaction\(async \(tx\)/g) || []).length === 2, "expected exactly 2 withTransaction blocks (create, update)");
    assert.ok(read.includes("getSql()"), "the read module must use the shared client");
  });

  await test("S", "lib/pim-data/mediators.js (Batch 1 list endpoint) is untouched by this batch", () => {
    assert.ok(readSource("lib/pim-data/mediators.js").includes("async function listMediators(searchParams) {"));
  });
}

// ---------------------------------------------------------------------
// Fixture infrastructure
// ---------------------------------------------------------------------

const COUNT_TABLES = [
  "pim_cases", "pim_parties", "pim_case_parties", "pim_addresses", "pim_advocates", "pim_case_advocates",
  "pim_fees", "pim_status_history", "pim_docket", "pim_tasks", "mediators", "pim_mediator_assignments",
  "mediation_sessions", "audit_log",
];

function createTracker() {
  return {
    mediatorIds: new Set(),
    caseIds: new Set(),
    addMediator(id) {
      this.mediatorIds.add(id);
      this.persist();
    },
    addCase(id) {
      this.caseIds.add(id);
      this.persist();
    },
    persist() {
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify({ startedAt: new Date().toISOString(), mediatorIds: [...this.mediatorIds], caseIds: [...this.caseIds] }, null, 2)
      );
    },
  };
}

/*
 * mediators are cleaned first (name-tag guarded - never a real production
 * mediator), then cases (received_number-prefix guarded, cascades their
 * own assignments/sessions/tasks), all by exact tracked id, in one
 * transaction each.
 */
async function cleanupMediatorsByIds(sql, mediatorIds) {
  if (mediatorIds.length === 0) return;
  const existing = await sql`SELECT id, name FROM mediators WHERE id IN ${sql(mediatorIds)}`;
  for (const row of existing) {
    if (!String(row.name || "").includes(MEDIATOR_TAG_PREFIX)) {
      throw new Error(`Refusing to delete mediator ${row.id}: name "${row.name}" does not carry this run's tag.`);
    }
  }
  if (existing.length === 0) return;
  const ids = existing.map((r) => r.id);
  await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '15s'`;
    // mediation_sessions.assignment_id -> pim_mediator_assignments(id) has NO
    // cascade (confirmed in the schema), so any session recorded against one
    // of this mediator's assignments (e.g. the ordering-test fixture) must be
    // deleted before the assignment itself, or the assignment DELETE fails
    // with a foreign-key violation - found live in this batch's first run,
    // which stranded every tracked mediator (the whole transaction rolled
    // back) and, because it threw before the case cleanup below ever ran,
    // the case fixtures too. Fixed here.
    await tx`
      DELETE FROM mediation_sessions
      WHERE assignment_id IN (
        SELECT id FROM pim_mediator_assignments WHERE mediator_id IN ${tx(ids)}
      )
    `;
    await tx`DELETE FROM pim_mediator_assignments WHERE mediator_id IN ${tx(ids)}`;
    await tx`DELETE FROM audit_log WHERE table_name = 'mediators' AND record_id IN ${tx(ids)}`;
    await tx`DELETE FROM mediators WHERE id IN ${tx(ids)}`;
  });
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
    await del("mediation_sessions", "case_id", caseIds);
    await del("pim_mediator_assignments", "case_id", caseIds);
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
  if (!fs.existsSync(MANIFEST_PATH)) return { mediatorIds: [], caseIds: [] };
  let stale;
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    stale = { mediatorIds: parsed.mediatorIds || [], caseIds: parsed.caseIds || [] };
  } catch (error) {
    throw new Error(`Could not read the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }
  console.log(`cleanup: removing stale fixtures from a previous run: mediators=${JSON.stringify(stale.mediatorIds)} cases=${JSON.stringify(stale.caseIds)}`);
  try {
    await cleanupMediatorsByIds(sql, stale.mediatorIds);
    await cleanupCasesByIds(sql, stale.caseIds);
  } catch (error) {
    throw new Error(`Could not clean the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }
  for (const id of stale.mediatorIds) tracker.mediatorIds.add(id);
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

async function verifyNoResidue(sql, tracker, baselineCounts = null) {
  const problems = [];
  const mediatorIds = [...tracker.mediatorIds];
  const caseIds = [...tracker.caseIds];
  const checks = [
    ["mediators", "id", mediatorIds],
    ["audit_log", "record_id", mediatorIds],
    ["pim_mediator_assignments", "mediator_id", mediatorIds],
    ["pim_cases", "id", caseIds],
    ["pim_mediator_assignments", "case_id", caseIds],
    ["mediation_sessions", "case_id", caseIds],
    ["pim_tasks", "case_id", caseIds],
  ];
  for (const [table, column, ids] of checks) {
    const n = await countWhereIn(sql, table, column, ids);
    if (n !== 0) problems.push(`${table}.${column}: ${n} row(s) remain for tracked ids`);
  }

  const realMediatorRows = await sql`SELECT id, name FROM mediators ORDER BY id`;
  if (realMediatorRows.length !== 5) {
    problems.push(`mediators: row count ${realMediatorRows.length} != expected 5 (the five approved panel members)`);
  }
  const approvedNames = ["Mr.R.Ravikumar", "Mr.H.Rajesh", "Mr. Narayanan Kutty", "Mrs. Latha Subramaniam", "Mr. K. Viswanath"];
  const realNames = realMediatorRows.map((r) => r.name).sort();
  if (JSON.stringify(realNames) !== JSON.stringify([...approvedNames].sort())) {
    problems.push(`mediators: real roster is ${JSON.stringify(realNames)}, expected exactly ${JSON.stringify(approvedNames.sort())}`);
  }

  const after = await tableCounts(sql);
  if (baselineCounts) {
    for (const table of COUNT_TABLES) {
      if (table === "mediators") continue; // checked above by exact expected count, not baseline-equality
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
    original.replace(/^export async function (\w+)/gm, "async function $1") +
    `\nmodule.exports = { ${[...names, ...extraExports].join(", ")} };\n`;
  const routeModule = new Module(routePath, module);
  routeModule.filename = routePath;
  routeModule.paths = Module._nodeModulePaths(path.dirname(routePath));
  routeModule._compile(source, routePath);
  return routeModule.exports;
}

async function callRoute(route, method, { userId = null, id, body = undefined } = {}) {
  const headers = {};
  if (userId != null) headers["x-pim-user-id"] = String(userId);
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = id === undefined ? "http://localhost/api/pim/mediators" : `http://localhost/api/pim/mediators/${id}`;
  const request = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const originalError = console.error;
  console.error = () => {};
  try {
    const params = id === undefined ? undefined : { params: Promise.resolve({ id: String(id) }) };
    const response = await route[method](request, params);
    return { status: response.status, json: await response.json() };
  } finally {
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------

const wire = (value) => JSON.parse(JSON.stringify(value));
const SQLITE_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function walk(node, visit, p = []) {
  visit(node, p);
  if (Array.isArray(node)) node.forEach((item, i) => walk(item, visit, [...p, i]));
  else if (node && typeof node === "object" && !(node instanceof Date)) {
    for (const [k, v] of Object.entries(node)) walk(v, visit, [...p, k]);
  }
}

function assertNoBooleans(payload, label) {
  walk(payload, (v, p) => assert.notStrictEqual(typeof v, "boolean", `${label}: boolean at ${p.join(".")}`));
}

function assertNoDateObjects(payload, label) {
  walk(payload, (v, p) => assert.ok(!(v instanceof Date), `${label}: Date object at ${p.join(".")}`));
}

function assertWireFormats(payload, label) {
  walk(payload, (v, p) => {
    const key = p[p.length - 1];
    if (typeof v !== "string" || typeof key !== "string") return;
    if (key === "created_at" || key === "updated_at") assert.ok(SQLITE_TS_RE.test(v), `${label}: ${p.join(".")} = ${v}`);
    if (key.endsWith("_date")) assert.ok(DATE_RE.test(v), `${label}: ${p.join(".")} = ${v}`);
  });
}

/* Tokenizes engine-generated ids/timestamps so a fixture built on both engines can be compared. */
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "number" && (k === "id" || k.endsWith("_id"))) out[k] = "<id>";
      else if ((k === "created_at" || k === "updated_at") && typeof v === "string") out[k] = "<ts>";
      else out[k] = normalize(v);
    }
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------

async function runLive() {
  const startedAt = Date.now();
  const { getSql } = require("../lib/pim-postgres");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { checkDuplicateActiveEnrollmentPg, getMediatorRawPg, createMediatorPg, updateMediatorPg } = require("../lib/pim-data/mediator-registry");
  const { getMediatorPg, getMediatorDetailPg } = require("../lib/pim-data/mediator-registry-read");
  const db = require("../lib/db");
  const { assertScratchDatabase } = require("../lib/pim-test-guard");
  assertScratchDatabase(db);

  const sql = getSql();
  const tracker = createTracker();

  await withRetries("connect", () => sql`SELECT 1`);
  await withRetries("stale cleanup", () => recoverStaleFixtures(sql, tracker));

  const baselineCounts = await tableCounts(sql);
  console.log(`pre-run baseline row counts: ${JSON.stringify(baselineCounts)}`);
  // Batch 5H-a mediator-panel reconciliation: the real mediator master now
  // holds the five approved panel members (Rajesh id 13, Ravikumar id 12,
  // plus Kutty/Subramaniam/Viswanath added through the real POST route -
  // see docs/phase6-batch5h-mediator-registry-migration.md), not the
  // original two.
  assert.strictEqual(baselineCounts.mediators, 5, `expected exactly the five approved mediators before this run, found ${baselineCounts.mediators}`);

  try {
    // =================================================================
    // PANEL: the finalized five-member approved mediator roster
    // (Batch 5H-a mediator-panel reconciliation, run against the real
    // production mediator table - not a fixture, never cleaned up here)
    // =================================================================
    await test("PANEL", "exactly the five approved mediators are active, no duplicates, ids 12/13 preserved, the three newly added have null/default optional fields", async () => {
      const rows = await sql`SELECT * FROM mediators ORDER BY id`;
      assert.strictEqual(rows.length, 5, `expected exactly 5 real mediators, found ${rows.length}`);

      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      assert.strictEqual(byId[12]?.name, "Mr.R.Ravikumar", "existing id 12 must be unchanged");
      assert.strictEqual(byId[13]?.name, "Mr.H.Rajesh", "existing id 13 must be unchanged");

      const names = rows.map((r) => r.name);
      assert.strictEqual(new Set(names).size, names.length, "no duplicate mediator names");

      const approved = ["Mr.R.Ravikumar", "Mr.H.Rajesh", "Mr. Narayanan Kutty", "Mrs. Latha Subramaniam", "Mr. K. Viswanath"];
      assert.deepStrictEqual([...names].sort(), [...approved].sort(), "the active roster must be exactly the five approved mediators");

      for (const row of rows) {
        assert.strictEqual(row.category, "ADVOCATE MEDIATOR", `${row.name}: category must be ADVOCATE MEDIATOR`);
        assert.strictEqual(row.active, true, `${row.name}: must be active`);
      }

      const newThree = rows.filter((r) => r.id !== 12 && r.id !== 13);
      assert.strictEqual(newThree.length, 3, "expected exactly 3 newly reconciled mediators besides ids 12/13");
      for (const row of newThree) {
        for (const key of ["enrollment_no", "contact_phone", "email", "empanelment_order_no", "empanelment_date", "panel_valid_until", "rotation_order", "conflict_declaration_date"]) {
          assert.strictEqual(row[key], null, `${row.name}.${key} must be null - no fabricated data`);
        }
      }
    });

    const users = await sql`SELECT id, username, role_code FROM users WHERE active = true ORDER BY id`;
    const aaUser = users.find((u) => u.role_code === "aa");
    const chairmanUser = users.find((u) => u.role_code === "chairman");
    const adminUser = users.find((u) => u.role_code === "admin");
    assert.ok(aaUser && chairmanUser && adminUser, "expected synced 'aa', 'chairman', 'admin' users");

    // -- Scratch SQLite: schema only, plus the minimal reference rows a T1 fixture needs for test I. --
    const hasStatusMaster = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='status_master'`).get();
    if (!hasStatusMaster) db.exec(readSource("database/schema.sql"));
    const [received] = await sql`SELECT code, name, stage, is_terminal FROM status_master WHERE code = 'RECEIVED'`;
    db.prepare(`INSERT OR IGNORE INTO status_master (code, name, stage, is_terminal) VALUES (?, ?, ?, ?)`).run(received.code, received.name, received.stage, received.is_terminal ? 1 : 0);
    const [event] = await sql`SELECT code, name, category FROM event_types WHERE code = 'APPLICATION_RECEIVED'`;
    db.prepare(`INSERT OR IGNORE INTO event_types (code, name, category) VALUES (?, ?, ?)`).run(event.code, event.name, event.category);
    const [taskType] = await sql`SELECT code, name, default_priority FROM task_types WHERE code = 'SCRUTINY'`;
    db.prepare(`INSERT OR IGNORE INTO task_types (code, name, default_priority) VALUES (?, ?, ?)`).run(taskType.code, taskType.name, taskType.default_priority);
    for (const u of [aaUser, chairmanUser, adminUser]) {
      db.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, designation, role_code, active, must_change_password) VALUES (?, ?, ?, ?, ?, 1, 0)`)
        .run(u.id, u.username, u.username, u.role_code, u.role_code);
    }

    const routeList = loadRouteModule("app/api/pim/mediators/route.js", ["postMediatorSqlite", "duplicateActiveEnrollmentSqlite", "validateMediatorInput", "parseMediatorBody"]);
    const routeDetail = loadRouteModule("app/api/pim/mediators/[id]/route.js", ["getMediatorSqlite", "getMediatorDetailSqlite", "duplicateActiveEnrollmentSqlite"]);

    function fixtureInput(suffix, overrides = {}) {
      return {
        name: `${TAG} ${suffix}`,
        category: "ADVOCATE MEDIATOR",
        enrollment_no: `${TAG}-${suffix}-ENR`,
        contact_phone: "9000000001",
        email: `${TAG}-${suffix}@example.test`.toLowerCase(),
        empanelment_order_no: null,
        empanelment_date: "2020-01-01",
        panel_valid_until: "2030-01-01",
        active: 1,
        rotation_order: 5,
        conflict_declaration_date: null,
        remarks: "5H fixture",
        ...overrides,
      };
    }

    // =================================================================
    // A: happy path (create -> view -> edit), through the direct functions
    // =================================================================
    let fixtureId;
    await test("A", "successful create: correct row, wire types, and exactly one INSERT audit_log row", async () => {
      const before = await tableCounts(sql);
      const created = await createMediatorPg(fixtureInput("A"), aaUser.id);
      fixtureId = created.id;
      tracker.addMediator(fixtureId);

      assert.strictEqual(created.name, `${TAG} A`);
      assert.strictEqual(created.active, 1, "active must be 1, not true");
      assert.ok(SQLITE_TS_RE.test(created.created_at));
      assert.strictEqual(created.created_at, created.updated_at);

      const [audit] = await sql`SELECT * FROM audit_log WHERE table_name='mediators' AND record_id=${fixtureId}`;
      assert.strictEqual(audit.action, "INSERT");
      assert.strictEqual(audit.changed_by, aaUser.id);
      assert.strictEqual(audit.old_value, null);
      assert.deepStrictEqual(JSON.parse(audit.new_value), {
        name: `${TAG} A`, enrollment_no: `${TAG}-A-ENR`, category: "ADVOCATE MEDIATOR", active: true,
      });

      const after = await tableCounts(sql);
      assert.strictEqual(after.mediators, before.mediators + 1);
      assert.strictEqual(after.audit_log, before.audit_log + 1);
    });

    await test("A", "successful view: detail shape, aggregate counts all zero for a fresh mediator with no assignments", async () => {
      const detail = await getMediatorDetailPg(fixtureId);
      assert.deepStrictEqual(Object.keys(detail).sort(), ["assignments", "mediator", "sessions"]);
      assert.deepStrictEqual(detail.assignments, []);
      assert.deepStrictEqual(detail.sessions, []);
      assert.deepStrictEqual(
        [detail.mediator.total_assignments, detail.mediator.active_assignments, detail.mediator.total_sessions, detail.mediator.effective_sessions, detail.mediator.settled_cases, detail.mediator.failed_cases],
        [0, 0, 0, 0, 0, 0]
      );
    });

    await test("A", "successful edit: only supplied columns change, updated_at advances, exactly one UPDATE audit_log row with old/new values", async () => {
      await sleep(1100); // ensure a real, observable second-precision updated_at advance
      const updated = await updateMediatorPg(fixtureId, { remarks: "edited", active: 0 }, {
        oldValues: { remarks: "5H fixture", active: 1 },
        newValues: { remarks: "edited", active: 0 },
        userId: chairmanUser.id,
        reason: "test edit",
      });

      assert.strictEqual(updated.remarks, "edited");
      assert.strictEqual(updated.active, 0);
      assert.strictEqual(updated.name, `${TAG} A`, "unsupplied columns must be unchanged");
      assert.strictEqual(updated.enrollment_no, `${TAG}-A-ENR`);
      assert.ok(updated.updated_at > updated.created_at, "updated_at must advance past created_at");

      const auditRows = await sql`SELECT * FROM audit_log WHERE table_name='mediators' AND record_id=${fixtureId} AND action='UPDATE'`;
      assert.strictEqual(auditRows.length, 1);
      assert.strictEqual(auditRows[0].changed_by, chairmanUser.id);
      assert.deepStrictEqual(JSON.parse(auditRows[0].old_value), { remarks: "5H fixture", active: 1 });
      assert.deepStrictEqual(JSON.parse(auditRows[0].new_value), { remarks: "edited", active: 0 });
    });

    // =================================================================
    // B: not-found
    // =================================================================
    await test("B", "getMediatorDetailPg / getMediatorRawPg return null for a nonexistent id (no error)", async () => {
      assert.strictEqual(await getMediatorDetailPg(999999999), null);
      assert.strictEqual(await getMediatorRawPg(999999999), null);
      assert.strictEqual(await getMediatorPg(999999999), null);
    });

    // =================================================================
    // C + real route handler: permission/auth
    // =================================================================
    await test("C", "POST: no identity -> 401; ordinary staff (aa) is ALLOWED under the staff-operated model (Batch 5H-a); chairman (not staff) -> 403, nothing written", async () => {
      const before = await tableCounts(sql);
      const none = await callRoute(routeList, "POST", { body: fixtureInput("UNAUTH") });
      assert.strictEqual(none.status, 401);

      const forbidden = await callRoute(routeList, "POST", { userId: chairmanUser.id, body: { name: `${TAG} Forbidden`, enrollmentNo: `${TAG}-FORBID-ENR` } });
      assert.strictEqual(forbidden.status, 403);
      assert.deepStrictEqual(await tableCounts(sql), before, "a denied POST must write nothing");

      const allowed = await callRoute(routeList, "POST", { userId: aaUser.id, body: { name: `${TAG} StaffCreated`, enrollmentNo: `${TAG}-STAFF-ENR` } });
      assert.strictEqual(allowed.status, 201, "ordinary staff (aa) must be able to create a mediator directly");
      tracker.addMediator(allowed.json.data.mediator.id);
    });

    await test("C", "GET: no identity -> 401; a READ_MEDIATOR role (aa) -> 200", async () => {
      const none = await callRoute(routeDetail, "GET", { id: fixtureId });
      assert.strictEqual(none.status, 401);
      const ok = await callRoute(routeDetail, "GET", { userId: aaUser.id, id: fixtureId });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.json.data.mediator.id, fixtureId);
    });

    await test("C", "PATCH: no identity -> 401; ordinary staff (aa) is ALLOWED; chairman (not staff) -> 403, nothing written", async () => {
      const before = await tableCounts(sql);
      const none = await callRoute(routeDetail, "PATCH", { id: fixtureId, body: { remarks: "should not apply" } });
      assert.strictEqual(none.status, 401);

      const forbidden = await callRoute(routeDetail, "PATCH", { userId: chairmanUser.id, id: fixtureId, body: { remarks: "should not apply" } });
      assert.strictEqual(forbidden.status, 403);
      assert.deepStrictEqual(await tableCounts(sql), before);
      const stillEdited = await getMediatorRawPg(fixtureId);
      assert.strictEqual(stillEdited.remarks, "edited", "the earlier legitimate edit must be unaffected");

      const allowed = await callRoute(routeDetail, "PATCH", { userId: aaUser.id, id: fixtureId, body: { remarks: "staff-edited" } });
      assert.strictEqual(allowed.status, 200, "ordinary staff (aa) must be able to edit a mediator directly");
      assert.strictEqual(allowed.json.data.mediator.remarks, "staff-edited");
    });

    // =================================================================
    // D: exact response contract, through the real route handlers
    // =================================================================
    let createdViaRoute;
    await test("D", "POST via the real route: 201, exact response shape, and the row is immediately visible", async () => {
      const res = await callRoute(routeList, "POST", { userId: adminUser.id, body: {
        name: `${TAG} RouteCreated`, enrollmentNo: `${TAG}-ROUTE-ENR`, category: "ADVOCATE MEDIATOR",
        contactPhone: "9000000002", email: `${TAG.toLowerCase()}-route@example.test`, active: true, rotationOrder: 3,
      } });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.json.success, true);
      assert.strictEqual(res.json.message, "Mediator added successfully.");
      assert.deepStrictEqual(Object.keys(res.json.data), ["mediator"]);
      assert.strictEqual(res.json.data.mediator.active, 1);
      assert.ok(res.json.data.mediator.remarks.includes(`Created by user ${adminUser.id}.`));
      createdViaRoute = res.json.data.mediator.id;
      tracker.addMediator(createdViaRoute);
    });

    await test("D", "GET via the real route: exact response shape (mediator, activeAssignments, assignments, sessions)", async () => {
      const res = await callRoute(routeDetail, "GET", { userId: aaUser.id, id: createdViaRoute });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(Object.keys(res.json.data).sort(), ["activeAssignments", "assignments", "mediator", "sessions"]);
      assert.deepStrictEqual(res.json.data.activeAssignments, []);
    });

    await test("D", "GET via the real route: unknown id -> 404 with the exact message; invalid id -> 400", async () => {
      const missing = await callRoute(routeDetail, "GET", { userId: aaUser.id, id: 999999999 });
      assert.strictEqual(missing.status, 404);
      assert.deepStrictEqual(missing.json, { success: false, message: "Mediator not found." });
      const invalid = await callRoute(routeDetail, "GET", { userId: aaUser.id, id: "abc" });
      assert.strictEqual(invalid.status, 400);
      assert.deepStrictEqual(invalid.json, { success: false, message: "Invalid mediator ID." });
    });

    await test("D", "PATCH via the real route: 200, exact response shape, and 409 on a genuine active-enrollment conflict", async () => {
      const res = await callRoute(routeDetail, "PATCH", { userId: adminUser.id, id: createdViaRoute, body: { remarks: "route-edited" } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.message, "Mediator updated successfully.");
      assert.deepStrictEqual(Object.keys(res.json.data).sort(), ["mediator", "updatedBy"]);
      assert.strictEqual(res.json.data.updatedBy, adminUser.id);

      // fixtureId (still active=0 from test A's edit) is reactivated with A's own enrollment number first,
      // then createdViaRoute attempts to steal that SAME enrollment number while active - must conflict.
      await callRoute(routeDetail, "PATCH", { userId: adminUser.id, id: fixtureId, body: { active: true } });
      const conflict = await callRoute(routeDetail, "PATCH", { userId: adminUser.id, id: createdViaRoute, body: { enrollmentNo: `${TAG}-A-ENR` } });
      assert.strictEqual(conflict.status, 409);
      assert.match(conflict.json.message, /already exists/);
    });

    // =================================================================
    // E: SQLite/PostgreSQL parity
    // =================================================================
    await test("E", "aggregate parity: create + edit on both engines produce byte-identical shapes (ids/timestamps tokenized)", async () => {
      // Both postMediatorSqlite and the real POST route append "Created by
      // user N." to remarks - postMediatorSqlite does this INTERNALLY
      // (bundling the whole original inline POST body, append included),
      // while createMediatorPg does NOT (the real PG route builds the final
      // remarks string itself before calling createMediatorPg - see
      // app/api/pim/mediators/route.js). So calling createMediatorPg
      // directly (bypassing the route, as this test does) must pre-apply
      // that same append itself, to compare each function against its own
      // real contract rather than a mismatched one.
      const baseInput = fixtureInput("PARITY");
      const input = { ...baseInput, remarks: `${baseInput.remarks}\nCreated by user ${aaUser.id}.` };
      const inputSqlite = { ...baseInput, enrollmentNo: baseInput.enrollment_no, contactPhone: baseInput.contact_phone, email: baseInput.email,
        empanelmentOrderNo: baseInput.empanelment_order_no, empanelmentDate: baseInput.empanelment_date, panelValidUntil: baseInput.panel_valid_until,
        rotationOrder: baseInput.rotation_order, conflictDeclarationDate: baseInput.conflict_declaration_date };

      const pgCreated = await createMediatorPg(input, aaUser.id);
      tracker.addMediator(pgCreated.id);
      const liteCreated = routeList.postMediatorSqlite(inputSqlite, aaUser.id);

      assert.deepStrictEqual(normalize(pgCreated), normalize(liteCreated), "create() must match the SQLite baseline");

      const pgUpdated = await updateMediatorPg(pgCreated.id, { active: 0, remarks: "parity edit" }, {
        oldValues: { active: 1, remarks: "5H fixture" }, newValues: { active: 0, remarks: "parity edit" }, userId: aaUser.id, reason: "r",
      });
      db.prepare(`UPDATE mediators SET active=0, remarks='parity edit', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(liteCreated.id);
      db.prepare(`INSERT INTO audit_log (table_name, record_id, action, old_value, new_value, changed_by, reason) VALUES ('mediators', ?, 'UPDATE', ?, ?, ?, ?)`)
        .run(liteCreated.id, JSON.stringify({ active: 1, remarks: "5H fixture" }), JSON.stringify({ active: 0, remarks: "parity edit" }), aaUser.id, "r");
      const liteUpdated = routeDetail.getMediatorSqlite(liteCreated.id);

      assert.deepStrictEqual(normalize(pgUpdated), normalize(liteUpdated), "update() must match the SQLite baseline");
    });

    // =================================================================
    // F: null semantics
    // =================================================================
    await test("F", "optional fields left null round-trip as null, never undefined or an empty string", async () => {
      const minimal = await createMediatorPg({
        name: `${TAG} Minimal`, category: "ADVOCATE MEDIATOR", enrollment_no: `${TAG}-MIN-ENR`,
        contact_phone: null, email: null, empanelment_order_no: null, empanelment_date: null,
        panel_valid_until: null, active: 1, rotation_order: null, conflict_declaration_date: null, remarks: null,
      }, aaUser.id);
      tracker.addMediator(minimal.id);

      for (const key of ["contact_phone", "email", "empanelment_order_no", "empanelment_date", "panel_valid_until", "rotation_order", "conflict_declaration_date", "remarks"]) {
        assert.strictEqual(minimal[key], null, `${key} must be null`);
      }
      const audit = (await sql`SELECT old_value FROM audit_log WHERE table_name='mediators' AND record_id=${minimal.id} AND action='INSERT'`)[0];
      assert.strictEqual(audit.old_value, null, "an INSERT audit row must have no old_value");
    });

    // =================================================================
    // G: boolean semantics
    // =================================================================
    await test("G", "no booleans anywhere in the create/view/edit responses (active/deviation_from_rotation/effective_session all 1/0)", async () => {
      const created = await createMediatorPg(fixtureInput("BOOL"), aaUser.id);
      tracker.addMediator(created.id);
      assertNoBooleans(created, "createMediatorPg");
      assertNoDateObjects(created, "createMediatorPg");

      const detail = await getMediatorDetailPg(created.id);
      assertNoBooleans(detail, "getMediatorDetailPg");
      assertNoDateObjects(detail, "getMediatorDetailPg");

      const updated = await updateMediatorPg(created.id, { active: 0 }, { oldValues: { active: 1 }, newValues: { active: 0 }, userId: aaUser.id, reason: "r" });
      assertNoBooleans(updated, "updateMediatorPg");
      assert.strictEqual(updated.active, 0);
    });

    // =================================================================
    // H: timestamps/dates
    // =================================================================
    await test("H", "wire formats: created_at/updated_at are 'YYYY-MM-DD HH:MM:SS'; date columns are plain 'YYYY-MM-DD' strings", async () => {
      const created = await createMediatorPg(fixtureInput("DATES", { empanelment_date: "2021-06-15", panel_valid_until: "2031-06-15" }), aaUser.id);
      tracker.addMediator(created.id);
      assertWireFormats(wire(created), "createMediatorPg");
      assert.strictEqual(created.empanelment_date, "2021-06-15");
      assert.strictEqual(created.panel_valid_until, "2031-06-15");
    });

    // =================================================================
    // I: ordering (assignments/sessions), using a real T1 case + assignment + session
    // =================================================================
    await test("I", "assignments ordered ACTIVE-first then assignment_date DESC; sessions ordered COALESCE(actual,scheduled) DESC NULLS LAST; aggregate counts correct", async () => {
      const orderedMediator = await createMediatorPg(fixtureInput("ORDER"), aaUser.id);
      tracker.addMediator(orderedMediator.id);

      const caseA = await createReceivedPimApplicationPg({
        receivedNumber: `${TEST_PREFIX}i-a-${RUN_ID}`, receivedDate: "2026-01-10", applicationDate: "2026-01-09",
        applicants: [{ name: "B5H Applicant A" }], oppositeParties: [{ name: "B5H Opposite A" }],
        applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      }, aaUser.id);
      tracker.addCase(caseA);
      const caseB = await createReceivedPimApplicationPg({
        receivedNumber: `${TEST_PREFIX}i-b-${RUN_ID}`, receivedDate: "2026-01-20", applicationDate: "2026-01-19",
        applicants: [{ name: "B5H Applicant B" }], oppositeParties: [{ name: "B5H Opposite B" }],
        applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-20", bankName: "Test Bank", payee: "Chairman, DLSA" },
      }, aaUser.id);
      tracker.addCase(caseB);

      const [assignA] = await sql`INSERT INTO pim_mediator_assignments (case_id, mediator_id, assignment_date, status) VALUES (${caseA}, ${orderedMediator.id}, '2026-01-11', 'CLOSED') RETURNING id`;
      const [assignB] = await sql`INSERT INTO pim_mediator_assignments (case_id, mediator_id, assignment_date, status) VALUES (${caseB}, ${orderedMediator.id}, '2026-01-21', 'ACTIVE') RETURNING id`;
      await sql`INSERT INTO mediation_sessions (case_id, assignment_id, sitting_number, session_status, actual_date, effective_session) VALUES (${caseA}, ${assignA.id}, 1, 'HELD', '2026-01-15', true)`;
      await sql`INSERT INTO mediation_sessions (case_id, assignment_id, sitting_number, session_status, scheduled_date) VALUES (${caseB}, ${assignB.id}, 1, 'SCHEDULED', '2026-01-25')`;
      await sql`INSERT INTO mediation_sessions (case_id, assignment_id, sitting_number, session_status) VALUES (${caseA}, ${assignA.id}, 2, 'SCHEDULED')`; // both dates NULL

      const detail = await getMediatorDetailPg(orderedMediator.id);
      assert.deepStrictEqual(detail.assignments.map((a) => a.status), ["ACTIVE", "CLOSED"], "ACTIVE must sort before CLOSED regardless of date");
      assert.strictEqual(detail.assignments[0].case_id, caseB);

      const sessionDates = detail.sessions.map((s) => s.actual_date || s.scheduled_date || null);
      assert.deepStrictEqual(sessionDates, ["2026-01-25", "2026-01-15", null], "DESC with the null-dated session LAST, matching SQLite (not PostgreSQL's default NULLS FIRST)");

      assert.deepStrictEqual(
        [detail.mediator.total_assignments, detail.mediator.active_assignments, detail.mediator.total_sessions, detail.mediator.effective_sessions],
        [2, 1, 3, 1]
      );
    });

    // =================================================================
    // J: N/A - not a case-workflow operation
    // =================================================================
    markNA("J", "mediators are a standalone roster entity, not a case task - there is no status/task/docket behavior for this slice to preserve");

    // =================================================================
    // K: rollback after a genuine mid-operation failure
    // =================================================================
    await test("K", "create rollback: an invalid changed_by fails the audit_log FK after the mediator INSERT already ran in the same transaction - the whole thing rolls back", async () => {
      const before = await tableCounts(sql);
      const SENTINEL_INVALID_USER = 999999999;
      await assert.rejects(
        () => createMediatorPg(fixtureInput("ROLLBACK"), SENTINEL_INVALID_USER),
        /violates foreign key constraint|foreign key/i
      );
      const leftover = await sql`SELECT id FROM mediators WHERE enrollment_no = ${`${TAG}-ROLLBACK-ENR`}`;
      assert.strictEqual(leftover.length, 0, "the mediator row must not remain after the audit_log insert fails");
      assert.deepStrictEqual(await tableCounts(sql), before);
    });

    await test("K", "update rollback: an invalid changed_by fails the audit_log FK after the mediator UPDATE already ran - the update itself rolls back", async () => {
      const target = await createMediatorPg(fixtureInput("ROLLBACK2"), aaUser.id);
      tracker.addMediator(target.id);
      const before = await getMediatorRawPg(target.id);

      const SENTINEL_INVALID_USER = 999999999;
      await assert.rejects(
        () => updateMediatorPg(target.id, { remarks: "should not persist" }, {
          oldValues: { remarks: "5H fixture" }, newValues: { remarks: "should not persist" }, userId: SENTINEL_INVALID_USER, reason: "r",
        }),
        /violates foreign key constraint|foreign key/i
      );

      const after = await getMediatorRawPg(target.id);
      assert.strictEqual(after.remarks, before.remarks, "the UPDATE must have rolled back with the INSERT");
      assert.strictEqual(after.updated_at, before.updated_at, "updated_at must not have advanced either");
    });

    // =================================================================
    // L: PostgreSQL-authoritativeness via a SQLite-only decoy
    // =================================================================
    await test("L", "a mediator created ONLY in SQLite is invisible to every PostgreSQL path, including the real GET route (404, not a silent SQLite fallback)", async () => {
      const decoy = routeList.postMediatorSqlite({
        name: `${TAG} DECOY-SQLITE-ONLY`, category: "ADVOCATE MEDIATOR", enrollmentNo: `${TAG}-DECOY-ENR`,
        contactPhone: null, email: null, empanelmentOrderNo: null, empanelmentDate: null, panelValidUntil: null,
        active: 1, rotationOrder: null, conflictDeclarationDate: null, remarks: null,
      }, aaUser.id);
      assert.ok(decoy.id > 0, "the decoy must really exist in SQLite");

      assert.strictEqual(await getMediatorDetailPg(decoy.id), null, "getMediatorDetailPg must not see the SQLite-only row");
      const viaRoute = await callRoute(routeDetail, "GET", { userId: aaUser.id, id: decoy.id });
      assert.strictEqual(viaRoute.status, 404, "the real PostgreSQL-backed route must 404, never silently read SQLite");

      const dup = await checkDuplicateActiveEnrollmentPg(`${TAG}-DECOY-ENR`);
      assert.strictEqual(dup, null, "the duplicate-enrollment check must not see the SQLite-only row either (no cross-engine leakage)");
    });

    // =================================================================
    // M: workflow predecessor/successor compatibility
    // =================================================================
    markNA(
      "M",
      "no case-workflow predecessor: a mediator is created before, and independent of, any case. Successor note (documented, not tested here): case-level mediator ASSIGNMENT " +
      "(POST /api/pim/mediator/[id], distinct from this slice's /mediators registry) still reads/writes SQLite's OWN `mediators` table, so a mediator created via this " +
      "batch's PostgreSQL POST cannot yet be assigned to a case through that unmigrated route - case-level assignment is itself downstream of T3 anyway (see the Batch 5H doc §6)."
    );

    // =================================================================
    // N: enrollment number is optional (Batch 5H-a validation correction)
    // =================================================================
    await test("N", "createMediatorPg (direct) succeeds with enrollment_no null", async () => {
      const created = await createMediatorPg({
        name: `${TAG} NoEnrollDirect`, category: "ADVOCATE MEDIATOR", enrollment_no: null,
        contact_phone: null, email: null, empanelment_order_no: null, empanelment_date: null,
        panel_valid_until: null, active: 1, rotation_order: null, conflict_declaration_date: null, remarks: null,
      }, aaUser.id);
      tracker.addMediator(created.id);
      assert.strictEqual(created.enrollment_no, null);
    });

    await test("N", "POST via the real route: no enrollment number supplied -> 201, enrollment_no stored as null", async () => {
      const res = await callRoute(routeList, "POST", { userId: aaUser.id, body: { name: `${TAG} NoEnroll`, category: "ADVOCATE MEDIATOR", active: true } });
      assert.strictEqual(res.status, 201, "a create with no enrollment number must succeed after the validation correction");
      assert.strictEqual(res.json.data.mediator.enrollment_no, null);
      tracker.addMediator(res.json.data.mediator.id);
    });

    // =================================================================
    // O: a supplied enrollment number is still validated (duplicate-active check)
    // =================================================================
    await test("O", "a supplied enrollment number still triggers the active-duplicate conflict (unchanged from before this correction)", async () => {
      const first = await callRoute(routeList, "POST", { userId: aaUser.id, body: { name: `${TAG} EnrollA`, category: "ADVOCATE MEDIATOR", enrollmentNo: `${TAG}-SUPPLIED-ENR`, active: true } });
      assert.strictEqual(first.status, 201);
      tracker.addMediator(first.json.data.mediator.id);

      const second = await callRoute(routeList, "POST", { userId: aaUser.id, body: { name: `${TAG} EnrollB`, category: "ADVOCATE MEDIATOR", enrollmentNo: `${TAG}-SUPPLIED-ENR`, active: true } });
      assert.strictEqual(second.status, 409, "an active duplicate enrollment number must still be rejected when one is actually supplied");
      assert.match(second.json.message, /already exists/);
    });

    // =================================================================
    // P: missing name is still rejected (unchanged)
    // =================================================================
    await test("P", "POST via the real route: missing name -> 400, nothing written", async () => {
      const before = await tableCounts(sql);
      const res = await callRoute(routeList, "POST", { userId: aaUser.id, body: { category: "ADVOCATE MEDIATOR", active: true } });
      assert.strictEqual(res.status, 400);
      assert.match(res.json.message, /name is required/i);
      assert.deepStrictEqual(await tableCounts(sql), before, "a rejected create must write nothing");
    });

    // =================================================================
    // Q: category is required (new guard added by this correction)
    // =================================================================
    await test("Q", "validateMediatorInput rejects an explicitly empty category (defensive guard - the real POST route always defaults category via parseMediatorBody, so this path can't be reached over HTTP, but the validator itself must still enforce it)", () => {
      assert.strictEqual(routeList.validateMediatorInput({ name: "x", category: null }), "Category is required.");
      assert.strictEqual(routeList.validateMediatorInput({ name: "x", category: "" }), "Category is required.");
      assert.strictEqual(routeList.parseMediatorBody({ name: "x" }).category, "ADVOCATE MEDIATOR", "parseMediatorBody's own default is why the empty-category path is unreachable via the real route");
    });
  } finally {
    console.log(`\ncleanup: removing exactly these fixture mediator ids: ${JSON.stringify([...tracker.mediatorIds])}`);
    console.log(`cleanup: removing exactly these fixture case ids: ${JSON.stringify([...tracker.caseIds])}`);
    // Independent try/catch per tracker type: a failure cleaning up one must
    // never prevent an attempt at the other (found necessary live in this
    // batch's first run).
    try {
      await withRetries("cleanup (mediators)", () => cleanupMediatorsByIds(sql, [...tracker.mediatorIds]));
    } catch (error) {
      console.error(`CLEANUP FAILED (mediators): ${error.message}`);
      for (const line of await describeOrphanedTransactions(sql)) console.error(`      orphaned transaction? ${line}`);
      failures.push("cleanup of mediator fixtures");
    }
    try {
      await withRetries("cleanup (cases)", () => cleanupCasesByIds(sql, [...tracker.caseIds]));
    } catch (error) {
      console.error(`CLEANUP FAILED (cases): ${error.message}`);
      for (const line of await describeOrphanedTransactions(sql)) console.error(`      orphaned transaction? ${line}`);
      failures.push("cleanup of case fixtures");
    }
  }

  await test("RESIDUE", "no test mediators, assignments, sessions, cases, tasks, or audit_log rows remain; mediators back to exactly the five approved panel members; no orphaned transaction; all other table counts equal the pre-run baseline", async () => {
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
      stale.mediatorIds.length || stale.caseIds.length
        ? `removed stale fixtures: mediators=${JSON.stringify(stale.mediatorIds)} cases=${JSON.stringify(stale.caseIds)}`
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
