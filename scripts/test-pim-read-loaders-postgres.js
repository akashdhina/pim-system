/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5F tests: the two PostgreSQL read loaders that close the
 * SQLite-read / PostgreSQL-write split for Scrutiny and Non-Starter:
 *   GET /api/pim/scrutiny/[id]    -> lib/pim-data/scrutiny-read.js
 *   GET /api/pim/nonstarter/[id]  -> lib/pim-data/nonstarter-read.js
 *
 * Usage:
 *   node scripts/test-pim-read-loaders-postgres.js
 *   node scripts/test-pim-read-loaders-postgres.js --cleanup-only
 *
 * Environment: the DB connection setting is loaded via @next/env's
 * loadEnvConfig BEFORE anything reads it. Live tests use the real synced
 * users - no fabricated identity.
 *
 * Strategy:
 *  - The SQLite BASELINE is the ORIGINAL code, not a re-implementation:
 *    lib/pim-scrutiny.js's getScrutinyCase, and the original non-starter
 *    GET body, which the route keeps verbatim as getNonStarterViewSqlite
 *    (loaded here from the real route file). They run against an isolated
 *    scratch SQLite database (never production), seeded with the same
 *    reference rows PostgreSQL has, so names/order compare like for like.
 *  - "Twin" cases: the same logical case is built on BOTH engines (T1
 *    intake, then T2 / T7 / fixture rows) and the two loader outputs are
 *    compared after a JSON round trip (the real wire format), with only
 *    engine-generated values (ids, clock instants) tokenized. Their
 *    FORMAT is asserted separately.
 *  - Real PostgreSQL T1 cases are then driven through the REAL route
 *    handlers (real requirePermission): T1 -> GET -> T2 and T1 -> GET -> T7,
 *    proving the read/write split is actually closed.
 *  - Cleanup is ID-driven only, inside try/finally. Every created case id
 *    is written to a manifest immediately, so a killed run / lost network
 *    can be cleaned by exact id (--cleanup-only).
 *
 * Lettering follows the Batch 5F brief:
 *   A-J  scrutiny GET      K-R  non-starter GET
 *   P    SQLite parity (aggregate)   X   extra invariants   S  static
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO_ROOT = path.join(__dirname, "..");
const SCRATCH_DB_PATH = path.join(REPO_ROOT, "database", "test-pim-read-loaders.scratch.db");
const TEST_PREFIX = "TEST-B5F-";
const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-pim-read-loaders-manifest.json");
const RUN_ID = Date.now();

/* Fresh scratch SQLite every run; lib/pim-test-guard refuses production. */
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  fs.rmSync(SCRATCH_DB_PATH + suffix, { force: true });
}
process.env.PIM_DB_PATH = SCRATCH_DB_PATH;
delete process.env.PIM_DEV_USER_ID;

// ---------------------------------------------------------------------
// Reporting
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
// Payloads
// ---------------------------------------------------------------------

const FEE = {
  amount: 1000,
  ddNumber: "DD-1",
  ddDate: "2026-02-01",
  bankName: "Test Bank",
  payee: "Chairman, DLSA",
};

function richPayload(receivedNumber) {
  return {
    receivedNumber,
    receivedDate: "2026-02-01",
    applicationDate: "2026-01-30",
    claimAmount: 500000,
    disputeDescription: "Fixture dispute",
    applicants: [
      {
        name: "B5F Applicant One",
        entityType: "COMPANY",
        addresses: [
          {
            addressType: "POSTAL",
            addressLine1: "1 Main Road",
            addressLine2: "Ward 2",
            villageTown: "Coonoor",
            district: "The Nilgiris",
            state: "Tamil Nadu",
            pincode: "643101",
          },
          { addressType: "OFFICE", addressLine1: "2 Market Street" },
        ],
        advocate: {
          name: "Adv One",
          enrollmentNo: "TN/1/2020",
          phone: "9000000001",
          email: "adv1@example.test",
          address: "Bar Association",
        },
      },
      { name: "B5F Applicant Two" },
    ],
    oppositeParties: [
      { name: "B5F Opposite One", addresses: [{ addressLine1: "9 Opp Lane", pincode: "643001" }] },
      { name: "B5F Opposite Two", advocate: { name: "Adv Two" } },
    ],
    applicationFee: FEE,
  };
}

function leanPayload(receivedNumber) {
  return {
    receivedNumber,
    receivedDate: "2026-02-01",
    applicationDate: "2026-01-30",
    applicants: [{ name: "B5F Lean Applicant", addresses: [{ addressLine1: "5 Lean Street", district: "The Nilgiris" }] }],
    oppositeParties: [{ name: "B5F Lean Opposite", advocate: { name: "Lean Adv", enrollmentNo: "TN/9/2019" } }],
    applicationFee: FEE,
  };
}

const COMPLETE_DATA = {
  scrutinyResult: "COMPLETE",
  applicationFeeReceived: true,
  ddNumber: "  DD-778899  ",
  ddDate: "2026-02-01",
  ddBank: "  State Bank of India  ",
  ddAmount: "1000",
  ddPayeeCorrect: true,
  ddValid: true,
  oppositePartyAddressAvailable: true,
  commercialDisputeChecked: true,
  territorialJurisdictionChecked: true,
  supportingDocumentsChecked: true,
  rectificationDate: "",
};

const DEFECT_DATA = {
  scrutinyResult: "DEFECT",
  applicationFeeReceived: true,
  ddNumber: "DD-1",
  ddDate: "2026-02-01",
  ddBank: "Test Bank",
  ddAmount: 500.5,
  ddPayeeCorrect: false,
  ddValid: true,
  oppositePartyAddressAvailable: false,
  commercialDisputeChecked: true,
  territorialJurisdictionChecked: true,
  supportingDocumentsChecked: false,
  defectDetails: "  Opposite party address incomplete.  ",
  rectificationDate: "2026-02-20",
};

const DOCS = [
  {
    documentType: "FORM_3",
    title: "Form-3 (superseded)",
    documentDate: "2026-02-06",
    filePath: "TEST-B5F/none-1.docx",
    generatedBySystem: true,
    versionNo: 1,
    isCurrent: false,
    remarks: "old version",
  },
  {
    documentType: "FORM_3",
    title: "Form-3 (current)",
    documentDate: "2026-02-07",
    filePath: "TEST-B5F/none-2.docx",
    generatedBySystem: true,
    versionNo: 2,
    isCurrent: true,
    remarks: null,
  },
];

/*
 * The twin cases. Each is built identically on both engines. `steps` run
 * in order; ctx names a non-starter context branch fixture.
 */
const TWIN_DEFS = [
  { key: "rich", payload: richPayload, steps: [{ docs: DOCS }] },
  { key: "status", payload: leanPayload, steps: [] },
  { key: "complete", payload: leanPayload, steps: [{ t2: COMPLETE_DATA }] },
  { key: "defect", payload: leanPayload, steps: [{ t2: DEFECT_DATA }] },
  { key: "nsmanual", payload: leanPayload, steps: [{ t7: "BOTH_PARTIES_NOT_WILLING" }] },
  { key: "ctxrefusal", payload: leanPayload, steps: [{ ctx: "refusal" }] },
  { key: "ctxrefusalapp", payload: leanPayload, steps: [{ ctx: "refusalApp" }] },
  { key: "ctxabsence", payload: leanPayload, steps: [{ ctx: "absence" }] },
  { key: "ctxabsenceafter", payload: leanPayload, steps: [{ ctx: "absenceAfterTime" }] },
  { key: "ctxreturned", payload: leanPayload, steps: [{ ctx: "returnedFinal" }] },
];

// ---------------------------------------------------------------------
// Static tests - no database needed, always run.
// ---------------------------------------------------------------------

function functionBody(source, header) {
  const start = source.indexOf(header);
  assert.ok(start !== -1, `${header} not found`);
  const rest = source.slice(start + header.length);
  const end = rest.indexOf("\n}");
  assert.ok(end !== -1, `end of ${header} not found`);
  return rest.slice(0, end);
}

async function runStaticTests() {
  await test("S", "scrutiny GET: READ_CASE check precedes the PostgreSQL loader; the SQLite getScrutinyCase is not called by GET", () => {
    const body = functionBody(readSource("app/api/pim/scrutiny/[id]/route.js"), "export async function GET(request, context) {");
    const permission = body.indexOf('requirePermission(request, "READ_CASE")');
    const loader = body.indexOf("await getScrutinyCasePg(caseId)");
    assert.ok(permission !== -1 && loader > permission);
    assert.ok(!/[^\w]getScrutinyCase\(/.test(body), "GET must not call the SQLite getScrutinyCase");
  });

  await test("S", "non-starter GET: READ_CASE check precedes the PostgreSQL loader; no SQLite query remains inside GET", () => {
    const body = functionBody(readSource("app/api/pim/nonstarter/[id]/route.js"), "export async function GET(\n  request,\n  { params }\n) {");
    const permission = body.indexOf('requirePermission(request, "READ_CASE")');
    const loader = body.indexOf("await getNonStarterViewPg(caseId)");
    assert.ok(permission !== -1 && loader > permission);
    for (const forbidden of ["db.prepare", "getCase(", "inferNonStarterContext(", "getActiveNonStarterReasons("]) {
      assert.ok(!body.includes(forbidden), `GET must not contain ${forbidden}`);
    }
  });

  await test("S", "the original SQLite non-starter GET body is retained verbatim as getNonStarterViewSqlite (rollback + parity baseline)", () => {
    const source = readSource("app/api/pim/nonstarter/[id]/route.js");
    assert.ok(source.includes("function getNonStarterViewSqlite(caseId)"));
    assert.ok(source.includes("FROM pim_outcomes o") && source.includes("inferNonStarterContext(caseId)") && source.includes("getActiveNonStarterReasons()"));
  });

  await test("S", "the read modules are read-only PostgreSQL: no SQLite, no transaction, no lock, no DML, no fallback", () => {
    for (const file of ["lib/pim-data/scrutiny-read.js", "lib/pim-data/nonstarter-read.js", "lib/pim-data/wire-compat.js"]) {
      const code = stripComments(readSource(file));
      for (const forbidden of ["withTransaction", "FOR UPDATE", "FOR SHARE", 'require("../db")', 'require("./db")', ".prepare(", "lastInsertRowid", "CURRENT_DATE", "sql.begin"]) {
        assert.ok(!code.includes(forbidden), `${file} contains forbidden ${forbidden}`);
      }
      assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(code), `${file} contains a write statement`);
    }
    for (const file of ["lib/pim-data/scrutiny-read.js", "lib/pim-data/nonstarter-read.js"]) {
      assert.ok(stripComments(readSource(file)).includes("getSql()"), `${file} must use the shared PostgreSQL client`);
    }
  });

  await test("S", "the only cross-module reuse is inferNonStarterContextPg (T7's already-verified context inference)", () => {
    const code = stripComments(readSource("lib/pim-data/nonstarter-read.js"));
    assert.ok(/const \{ inferNonStarterContextPg \} = require\("\.\/nonstarter"\)/.test(code));
    assert.ok(!code.includes("recordNonStarterPg"), "the read module must not touch the T7 mutation");
  });

  await test("S", "POST handlers are still the migrated PostgreSQL mutations (T2 / T7), awaited", () => {
    assert.ok(functionBody(readSource("app/api/pim/scrutiny/[id]/route.js"), "export async function POST(request, context) {").includes("await saveScrutinyPg("));
    assert.ok(functionBody(readSource("app/api/pim/nonstarter/[id]/route.js"), "export async function POST(\n  request,\n  { params }\n) {").includes("await recordNonStarterPg("));
  });
}

// ---------------------------------------------------------------------
// PostgreSQL fixture infrastructure (exact-ID only)
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
    noticeIds: new Set(),
    addCase(id) {
      this.caseIds.add(id);
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify({ startedAt: new Date().toISOString(), caseIds: [...this.caseIds] }, null, 2)
      );
    },
  };
}

/*
 * One batched, atomic, exact-ID transaction. Refuses to touch a case
 * whose received_number lacks the test prefix; fails fast (lock_timeout)
 * if an orphaned transaction still holds a lock on a fixture row. Party /
 * advocate / task / notice ids are captured BEFORE deletion so the
 * residue check can verify them by exact id.
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
    const noticeIds = (await tx`SELECT id FROM pim_notices WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id);

    for (const id of partyIds) tracker.partyIds.add(id);
    for (const id of advocateIds) tracker.advocateIds.add(id);
    for (const id of taskIds) tracker.taskIds.add(id);
    for (const id of noticeIds) tracker.noticeIds.add(id);

    const del = async (table, column, ids) => {
      if (ids.length > 0) await tx`DELETE FROM ${tx(table)} WHERE ${tx(column)} IN ${tx(ids)}`;
    };

    await del("pim_service_attempts", "notice_id", noticeIds);
    await del("pim_responses", "case_id", caseIds);
    await del("pim_documents", "case_id", caseIds);
    await del("pim_notices", "case_id", caseIds);
    await del("pim_task_history", "task_id", taskIds);
    await del("pim_tasks", "case_id", caseIds);
    await del("pim_docket", "case_id", caseIds);
    await del("pim_status_history", "case_id", caseIds);
    await del("pim_scrutiny_attempts", "case_id", caseIds);
    await del("pim_scrutiny", "case_id", caseIds);
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
 * A client connection that drops mid-transaction can leave a server-side
 * transaction "idle in transaction" holding row locks (the pooler does
 * not always roll it back, and the idle-in-transaction timeout is
 * disabled on this project). List them so a blocked cleanup explains
 * itself.
 */
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
  if (!fs.existsSync(MANIFEST_PATH)) return [];

  let staleIds;
  try {
    staleIds = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")).caseIds || [];
  } catch (error) {
    throw new Error(`Could not read the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }

  console.log(`cleanup: removing stale fixture case ids recorded by a previous run: ${JSON.stringify(staleIds)}`);
  try {
    await cleanupCasesByIds(sql, staleIds, tracker);
  } catch (error) {
    throw new Error(`Could not clean the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }
  for (const id of staleIds) tracker.caseIds.add(id);
  fs.rmSync(MANIFEST_PATH, { force: true });
  return staleIds;
}

/* Bounded retry of connectivity-class errors ONLY, for idempotent infra steps. */
async function withRetries(label, fn, { attempts = 6, delayMs = 5000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const transient = /ECONNRESET|ENOTFOUND|EAI_AGAIN|CONNECT_TIMEOUT|ETIMEDOUT|ECONNREFUSED|CONNECTION_CLOSED|CONNECTION_ENDED/.test(
        `${error.code || ""} ${error.message}`
      );
      if (!transient || attempt >= attempts) throw error;
      console.error(`      ${label}: connectivity error (${error.code || error.message}); retry ${attempt}/${attempts - 1} in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
}

/*
 * SEQUENTIAL on purpose. These are PARAMETERLESS statements, and against this
 * project's transaction pooler a burst of parameterless statements larger than
 * the pool (10) stalls forever (found in Batch 5F; parameterized bursts queue
 * fine). 21 sequential counts take ~6 s, so there is nothing to gain by
 * risking it.
 */
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
    ["pim_scrutiny", "case_id", caseIds],
    ["pim_scrutiny_attempts", "case_id", caseIds],
    ["pim_outcomes", "case_id", caseIds],
    ["pim_notices", "case_id", caseIds],
    ["pim_responses", "case_id", caseIds],
    ["pim_documents", "case_id", caseIds],
    ["pim_task_history", "task_id", [...tracker.taskIds]],
    ["pim_notices", "id", [...tracker.noticeIds]],
    ["pim_service_attempts", "notice_id", [...tracker.noticeIds]],
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

  const orphans = await describeOrphanedTransactions(sql);
  for (const line of orphans) problems.push(`orphaned transaction: ${line}`);

  return { problems, after };
}

// ---------------------------------------------------------------------
// Route harness: load the REAL route module (written with ES `export`,
// which plain Node cannot require) by rewriting only the export
// keywords, so the real requirePermission -> loader path is exercised
// without a Next server. `extraExports` also exposes retained helpers.
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

async function callRoute(route, method, { userId = null, id, body = undefined }) {
  const headers = {};
  if (userId != null) headers["x-pim-user-id"] = String(userId);
  if (body !== undefined) headers["content-type"] = "application/json";

  const request = new Request(`http://localhost/api/pim/test/${id}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await route[method](request, { params: Promise.resolve({ id: String(id) }) });
    return { status: response.status, json: await response.json() };
  } finally {
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------
// Wire comparison helpers
// ---------------------------------------------------------------------

/* What actually goes over the wire (Response.json = JSON.stringify). */
const wire = (value) => JSON.parse(JSON.stringify(value));

const SQLITE_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^\d{2}:\d{2}:\d{2}$/;
const TS_KEYS = new Set(["created_at", "updated_at", "closed_at"]);

/*
 * Batch 5H-b (Phase 6): T2's COMPLETE branch now targets PIM_NUMBER_PENDING
 * on PostgreSQL, while lib/pim-scrutiny.js's frozen SQLite baseline still
 * targets SECRETARY_APPROVAL_PENDING - a DELIBERATE business-rule
 * divergence (see the matching comment in lib/pim-data/scrutiny.js), not a
 * bug. These specific, known value pairs are collapsed to a shared
 * placeholder before comparison; nothing else is touched, so a real
 * regression anywhere else in this suite still fails loudly.
 */
const DIVERGENT_TEXT_PAIRS = [
  ["SECRETARY_APPROVAL_PENDING", "PIM_NUMBER_PENDING"],
  ["Secretary Approval Pending", "PIM Number Pending"],
  ["Scrutiny completed and file put up for Secretary approval.", "Scrutiny completed; PIM number assignment pending."],
  ["Secretary approval", "Assign PIM number"],
];

/*
 * Tokenizes ONLY engine-generated values so the two engines' payloads can
 * be deep-compared: numeric ids (each engine numbers rows itself - their
 * relationships are asserted separately), clock instants (their FORMAT is
 * asserted here, their value cannot match), and "#<id>" inside evidence
 * text. Everything else must be byte-identical.
 */
function normalizeWire(node) {
  if (Array.isArray(node)) return node.map(normalizeWire);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "number" && (key === "id" || key.endsWith("_id"))) {
        out[key] = "<id>";
      } else if (TS_KEYS.has(key) && typeof value === "string") {
        assert.ok(SQLITE_TS_RE.test(value), `${key} must be 'YYYY-MM-DD HH:MM:SS' (SQLite CURRENT_TIMESTAMP shape), got ${value}`);
        out[key] = "<ts>";
      } else if (key === "scrutinised_at" && typeof value === "string") {
        assert.ok(ISO_RE.test(value), `scrutinised_at must be ISO-8601 with ms and Z, got ${value}`);
        out[key] = "<instant>";
      } else if (key === "completed_time" && typeof value === "string") {
        // officeTime() wall clock stamped by each engine's own T2 run - the VALUE differs, the FORMAT must not.
        assert.ok(CLOCK_RE.test(value), `completed_time must be HH:MM:SS, got ${value}`);
        out[key] = "<clock>";
      } else if (key === "evidence" && typeof value === "string") {
        out[key] = value.replace(/#\d+/g, "#<id>");
      } else if (typeof value === "string" && DIVERGENT_TEXT_PAIRS.some(([a, b]) => value === a || value === b)) {
        // Batch 5H-b's known, intentional divergence (see DIVERGENT_TEXT_PAIRS above) -
        // status_code/status_name/docket text/action_required/task remarks
        // for the COMPLETE branch's post-scrutiny checkpoint.
        out[key] = "<POST_SCRUTINY_COMPLETE_PENDING>";
      } else {
        out[key] = normalizeWire(value);
      }
    }
    return out;
  }
  return node;
}

function walk(node, visit, pathParts = []) {
  visit(node, pathParts);
  if (Array.isArray(node)) node.forEach((item, i) => walk(item, visit, [...pathParts, i]));
  else if (node && typeof node === "object" && !(node instanceof Date)) {
    for (const [k, v] of Object.entries(node)) walk(v, visit, [...pathParts, k]);
  }
}

function assertNoBooleans(payload, label) {
  walk(payload, (value, p) => assert.notStrictEqual(typeof value, "boolean", `${label}: boolean at ${p.join(".")} (SQLite never returned booleans)`));
}

function assertNoDateObjects(payload, label) {
  walk(payload, (value, p) => assert.ok(!(value instanceof Date), `${label}: Date object at ${p.join(".")}`));
}

function assertWireFormats(payload, label) {
  walk(payload, (value, p) => {
    const key = p[p.length - 1];
    if (typeof value !== "string" || typeof key !== "string") return;
    if (TS_KEYS.has(key)) assert.ok(SQLITE_TS_RE.test(value), `${label}: ${p.join(".")} = ${value}`);
    if (key === "scrutinised_at") assert.ok(ISO_RE.test(value), `${label}: ${p.join(".")} = ${value}`);
    if (key === "completed_time") assert.ok(CLOCK_RE.test(value), `${label}: ${p.join(".")} = ${value}`);
    if (key.endsWith("_date") && key !== "rectification_date_text") assert.ok(DATE_RE.test(value), `${label}: ${p.join(".")} = ${value}`);
  });
}

function assertSameAsSqlite(pgWire, liteWire, label) {
  assert.deepStrictEqual(
    normalizeWire(pgWire),
    normalizeWire(liteWire),
    `${label}: PostgreSQL diverged from the SQLite baseline.\nSQLite:   ${JSON.stringify(normalizeWire(liteWire))}\nPostgres: ${JSON.stringify(normalizeWire(pgWire))}`
  );
}

// ---------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------

async function runLive() {
  const startedAt = Date.now();
  const { getSql } = require("../lib/pim-postgres");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { saveScrutinyPg } = require("../lib/pim-data/scrutiny");
  const { recordNonStarterPg } = require("../lib/pim-data/nonstarter");
  const { getScrutinyCasePg } = require("../lib/pim-data/scrutiny-read");
  const { getNonStarterViewPg } = require("../lib/pim-data/nonstarter-read");
  const db = require("../lib/db");
  const { assertScratchDatabase } = require("../lib/pim-test-guard");
  assertScratchDatabase(db);

  const sql = getSql();
  const tracker = createTracker();

  // The very first connection from a fresh process was observed to fail
  // transiently against the pooler; bounded retry, connectivity errors only.
  await withRetries("connect", () => sql`SELECT 1`);
  await withRetries("stale cleanup", () => recoverStaleFixtures(sql, tracker));

  const baselineCounts = await tableCounts(sql);
  console.log(`pre-run baseline row counts: ${JSON.stringify(baselineCounts)}`);

  try {
    // -- Real synced users. No fabricated identity. --
    const users = await sql`SELECT id, username, role_code FROM users WHERE active = true ORDER BY id`;
    const aaUser = users.find((u) => u.role_code === "aa");
    const chairmanUser = users.find((u) => u.role_code === "chairman");
    assert.ok(aaUser && chairmanUser, "expected synced 'aa' and 'chairman' users in PostgreSQL");
    const USER_ID = aaUser.id;

    const statusRows = await sql`SELECT id, code, name, stage, is_terminal FROM status_master`;
    const statusIds = Object.fromEntries(statusRows.map((r) => [r.code, r]));
    const reasonRows = await sql`SELECT id, code, name, rule_reference, requires_authority_decision, active, remarks FROM nonstarter_reasons ORDER BY id`;

    // -- Scratch SQLite: schema + the SAME reference rows PostgreSQL has. --
    const hasStatusMaster = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='status_master'`).get();
    if (!hasStatusMaster) db.exec(readSource("database/schema.sql"));

    const wantedStatuses = ["RECEIVED", "SCRUTINY_PENDING", "DEFECT_PENDING", "SECRETARY_APPROVAL_PENDING", "OUTCOME_FORM_PENDING", "CLOSED_NON_STARTER"];
    for (const code of wantedStatuses) {
      const row = statusIds[code];
      assert.ok(row, `status ${code} missing in PostgreSQL`);
      db.prepare(`INSERT INTO status_master (code, name, stage, is_terminal) VALUES (?, ?, ?, ?)`).run(row.code, row.name, row.stage, row.is_terminal ? 1 : 0);
    }
    for (const code of ["APPLICATION_RECEIVED", "SCRUTINY_COMPLETED", "DEFECT_NOTED", "NONSTARTER_RECORDED"]) {
      const [row] = await sql`SELECT code, name, category FROM event_types WHERE code = ${code}`;
      db.prepare(`INSERT INTO event_types (code, name, category) VALUES (?, ?, ?)`).run(row.code, row.name, row.category);
    }
    for (const code of ["SCRUTINY", "NONSTARTER_FORM3"]) {
      const [row] = await sql`SELECT code, name, default_priority FROM task_types WHERE code = ${code}`;
      db.prepare(`INSERT INTO task_types (code, name, default_priority) VALUES (?, ?, ?)`).run(row.code, row.name, row.default_priority);
    }
    // All reasons, in PostgreSQL id order, so list ORDER BY id compares like for like.
    for (const r of reasonRows) {
      db.prepare(
        `INSERT INTO nonstarter_reasons (code, name, rule_reference, requires_authority_decision, active, remarks) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(r.code, r.name, r.rule_reference, r.requires_authority_decision ? 1 : 0, r.active ? 1 : 0, r.remarks);
    }
    for (const u of [aaUser, chairmanUser]) {
      db.prepare(
        `INSERT INTO users (id, username, display_name, designation, role_code, active, must_change_password) VALUES (?, ?, ?, ?, ?, 1, 0)`
      ).run(u.id, u.username, u.username, u.role_code, u.role_code);
    }

    const { createReceivedPimApplication } = require("../lib/pim");
    const { getScrutinyCase, saveScrutiny } = require("../lib/pim-scrutiny");
    const { recordNonStarter } = require("../lib/pim-nonstarter");

    const routeScr = loadRouteModule("app/api/pim/scrutiny/[id]/route.js");
    const routeNs = loadRouteModule("app/api/pim/nonstarter/[id]/route.js", ["getNonStarterViewSqlite"]);

    // -----------------------------------------------------------------
    // Engine adapters: one interface, so twin cases are described once.
    // -----------------------------------------------------------------
    const lite = {
      name: "sqlite",
      async createCase(payload) {
        return createReceivedPimApplication(payload, USER_ID);
      },
      async t2(caseId, data) {
        return saveScrutiny(caseId, data, USER_ID);
      },
      async t7(caseId, reasonCode) {
        return db.transaction(() => recordNonStarter({ caseId, reasonCode, outcomeDate: "2026-02-05", userId: USER_ID }))();
      },
      async setStatus(caseId, code) {
        db.prepare(`UPDATE pim_cases SET current_status_id = (SELECT id FROM status_master WHERE code = ?) WHERE id = ?`).run(code, caseId);
      },
      async primaryPartyId(caseId, role) {
        return db.prepare(`SELECT party_id FROM pim_case_parties WHERE case_id = ? AND role = ? AND is_primary = 1`).get(caseId, role).party_id;
      },
      async insertNotice(caseId, n) {
        return Number(
          db.prepare(`INSERT INTO pim_notices (case_id, notice_type, notice_date, recipient_party_id, status) VALUES (?, ?, ?, ?, ?)`)
            .run(caseId, n.noticeType, n.noticeDate, n.recipientPartyId, n.status).lastInsertRowid
        );
      },
      async insertResponse(caseId, r) {
        return Number(
          db.prepare(`INSERT INTO pim_responses (case_id, party_id, notice_id, response_date, response_type, time_requested_until, consent) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(caseId, r.partyId, r.noticeId ?? null, r.responseDate, r.responseType, r.timeRequestedUntil ?? null, r.consent ?? null).lastInsertRowid
        );
      },
      async insertServiceAttempt(noticeId, s) {
        db.prepare(`INSERT INTO pim_service_attempts (notice_id, return_reason, returned_date) VALUES (?, ?, ?)`).run(noticeId, s.returnReason, s.returnedDate);
      },
      async insertDocument(caseId, d) {
        db.prepare(
          `INSERT INTO pim_documents (case_id, document_type, document_title, document_date, file_path, generated_by_system, version_no, is_current, remarks, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(caseId, d.documentType, d.title, d.documentDate, d.filePath, d.generatedBySystem ? 1 : 0, d.versionNo, d.isCurrent ? 1 : 0, d.remarks, USER_ID);
      },
      async scrutiny(caseId) {
        try {
          const raw = getScrutinyCase(caseId);
          return { raw, wire: wire(raw) };
        } catch (error) {
          // Only the one EXPECTED failure is data; anything else is a real error and must surface.
          if (error.message !== "PIM case not found.") throw error;
          return { error: error.message };
        }
      },
      async nonstarter(caseId) {
        const raw = routeNs.getNonStarterViewSqlite(caseId);
        return { raw, wire: wire(raw) };
      },
    };

    const pg = {
      name: "postgres",
      async createCase(payload) {
        const caseId = await createReceivedPimApplicationPg(payload, USER_ID);
        tracker.addCase(caseId);
        return caseId;
      },
      async t2(caseId, data) {
        return saveScrutinyPg(caseId, data, USER_ID);
      },
      async t7(caseId, reasonCode) {
        return recordNonStarterPg({ caseId, reasonCode, outcomeDate: "2026-02-05", userId: USER_ID });
      },
      async setStatus(caseId, code) {
        await sql`UPDATE pim_cases SET current_status_id = (SELECT id FROM status_master WHERE code = ${code}) WHERE id = ${caseId}`;
      },
      async primaryPartyId(caseId, role) {
        const [row] = await sql`SELECT party_id FROM pim_case_parties WHERE case_id = ${caseId} AND role = ${role} AND is_primary = true`;
        return row.party_id;
      },
      async insertNotice(caseId, n) {
        const [row] = await sql`
          INSERT INTO pim_notices (case_id, notice_type, notice_date, recipient_party_id, status)
          VALUES (${caseId}, ${n.noticeType}, ${n.noticeDate}, ${n.recipientPartyId}, ${n.status})
          RETURNING id`;
        return row.id;
      },
      async insertResponse(caseId, r) {
        const [row] = await sql`
          INSERT INTO pim_responses (case_id, party_id, notice_id, response_date, response_type, time_requested_until, consent)
          VALUES (${caseId}, ${r.partyId}, ${r.noticeId ?? null}, ${r.responseDate}, ${r.responseType}, ${r.timeRequestedUntil ?? null}, ${r.consent ?? null})
          RETURNING id`;
        return row.id;
      },
      async insertServiceAttempt(noticeId, s) {
        await sql`INSERT INTO pim_service_attempts (notice_id, return_reason, returned_date) VALUES (${noticeId}, ${s.returnReason}, ${s.returnedDate})`;
      },
      async insertDocument(caseId, d) {
        await sql`
          INSERT INTO pim_documents (case_id, document_type, document_title, document_date, file_path, generated_by_system, version_no, is_current, remarks, created_by)
          VALUES (${caseId}, ${d.documentType}, ${d.title}, ${d.documentDate}, ${d.filePath}, ${d.generatedBySystem}, ${d.versionNo}, ${d.isCurrent}, ${d.remarks}, ${USER_ID})`;
      },
      async scrutiny(caseId) {
        try {
          const raw = await getScrutinyCasePg(caseId);
          return { raw, wire: wire(raw) };
        } catch (error) {
          // Only the one EXPECTED failure is data; a connection error etc. must surface, not be swallowed.
          if (error.message !== "PIM case not found.") throw error;
          return { error: error.message };
        }
      },
      async nonstarter(caseId) {
        const raw = await getNonStarterViewPg(caseId);
        return { raw, wire: wire(raw) };
      },
    };

    /* Context-branch fixtures: real notice/response/service rows (direct SQL, both engines). */
    async function applyContext(adapter, caseId, kind) {
      const opId = await adapter.primaryPartyId(caseId, "OPPOSITE_PARTY");
      const info = { opId };
      const notice = (noticeType, status) =>
        adapter.insertNotice(caseId, { noticeType, status, noticeDate: "2026-02-05", recipientPartyId: opId });

      if (kind === "refusal") {
        info.noticeId = await notice("FORM_2_INITIAL", "SERVED");
        info.responseId = await adapter.insertResponse(caseId, { partyId: opId, noticeId: info.noticeId, responseType: "REFUSED", responseDate: "2026-02-10", consent: 0 });
      } else if (kind === "refusalApp") {
        info.responseId = await adapter.insertResponse(caseId, { partyId: opId, responseType: "APPEARED", responseDate: "2026-02-11", consent: 0 });
      } else if (kind === "absence") {
        info.noticeId = await notice("FORM_2_FINAL", "SERVED");
        info.responseId = await adapter.insertResponse(caseId, { partyId: opId, noticeId: info.noticeId, responseType: "DID_NOT_APPEAR", responseDate: "2026-03-01" });
      } else if (kind === "absenceAfterTime") {
        info.noticeId = await notice("FORM_2_FINAL", "SERVED");
        await adapter.insertResponse(caseId, { partyId: opId, noticeId: info.noticeId, responseType: "SOUGHT_TIME", responseDate: "2026-02-15", timeRequestedUntil: "2026-02-28" });
        info.responseId = await adapter.insertResponse(caseId, { partyId: opId, noticeId: info.noticeId, responseType: "DID_NOT_APPEAR", responseDate: "2026-03-05" });
      } else if (kind === "returnedFinal") {
        info.noticeId = await notice("FORM_2_FINAL", "RETURNED");
        await adapter.insertServiceAttempt(info.noticeId, { returnReason: "UNCLAIMED", returnedDate: "2026-03-02" });
      } else {
        throw new Error(`unknown context kind ${kind}`);
      }
      return info;
    }

    async function buildTwin(adapter, def) {
      const caseId = await adapter.createCase(def.payload(`${TEST_PREFIX}${def.key}-${RUN_ID}`));
      const info = {};
      for (const step of def.steps) {
        if (step.t2) await adapter.t2(caseId, step.t2);
        if (step.t7) await adapter.t7(caseId, step.t7);
        if (step.status) await adapter.setStatus(caseId, step.status);
        if (step.docs) for (const doc of step.docs) await adapter.insertDocument(caseId, doc);
        if (step.ctx) Object.assign(info, await applyContext(adapter, caseId, step.ctx));
      }
      return { caseId, info };
    }

    // -----------------------------------------------------------------
    // Build every twin. PostgreSQL cases are created concurrently (each
    // is an independent transaction); SQLite ones are instant. Wait for
    // ALL to settle so no transaction is in flight when cleanup starts.
    // -----------------------------------------------------------------
    console.log(`building ${TWIN_DEFS.length} twin cases on both engines...`);
    const twins = {};
    for (const def of TWIN_DEFS) twins[def.key] = { def, buildError: null };

    for (const def of TWIN_DEFS) twins[def.key].lite = await buildTwin(lite, def);

    /*
     * At most 5 twins in flight: each T1/T2/T7 holds one pooled connection for
     * its whole transaction, and the fixture inserts need free connections too.
     * Every build is bounded by a timeout and ALWAYS settles before cleanup.
     */
    const BUILD_CONCURRENCY = 5;
    const queue = [...TWIN_DEFS];
    await Promise.all(
      Array.from({ length: BUILD_CONCURRENCY }, async () => {
        while (queue.length > 0) {
          const def = queue.shift();
          try {
            twins[def.key].pg = await withTimeout(buildTwin(pg, def), 240000, `build twin ${def.key}`);
          } catch (error) {
            twins[def.key].buildError = error;
          }
        }
      })
    );
    console.log(`twin build finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);

    const twin = (key) => {
      assert.ok(!twins[key].buildError, `twin '${key}' could not be built on PostgreSQL: ${twins[key].buildError && twins[key].buildError.message}`);
      return twins[key];
    };

    /* Loader outputs per twin, computed once. */
    const cache = new Map();
    async function outputs(key) {
      if (!cache.has(key)) {
        const t = twin(key);
        // One loader at a time: each fans out to <= 7 statements; both at once would exceed the pool of 10.
        const pgScr = await pg.scrutiny(t.pg.caseId);
        const pgNs = await pg.nonstarter(t.pg.caseId);
        const liteScr = await lite.scrutiny(t.lite.caseId);
        const liteNs = await lite.nonstarter(t.lite.caseId);
        cache.set(key, { pgScr, pgNs, liteScr, liteNs });
      }
      return cache.get(key);
    }

    const rich = () => twin("rich");
    const reasonList = reasonRows.filter((r) => r.active);

    // =================================================================
    // SCRUTINY GET  (A - J)
    // =================================================================

    await test("A", "PostgreSQL case: the scrutiny loader returns the exact expected JSON (every field derived from the fixture)", async () => {
      const t = rich();
      const { pgScr } = await outputs("rich");
      const out = pgScr.wire;
      const caseId = t.pg.caseId;

      assert.deepStrictEqual(Object.keys(out).sort(), ["case", "docket", "documents", "fees", "parties"], "no `scrutiny` key for an unscrutinised case");

      const c = out.case;
      assert.strictEqual(c.id, caseId);
      assert.strictEqual(c.received_number, `${TEST_PREFIX}rich-${RUN_ID}`);
      assert.strictEqual(c.received_date, "2026-02-01");
      assert.strictEqual(c.application_date, "2026-01-30");
      assert.strictEqual(c.claim_amount, 500000);
      assert.strictEqual(c.dispute_description, "Fixture dispute");
      assert.strictEqual(c.status_code, "RECEIVED");
      assert.strictEqual(c.status_name, statusIds.RECEIVED.name);
      assert.strictEqual(c.current_status_id, statusIds.RECEIVED.id);
      assert.strictEqual(c.entry_type, "NEW");
      assert.strictEqual(c.priority, "NORMAL");
      assert.strictEqual(c.pim_number, null);
      assert.strictEqual(c.scrutiny_status, null);

      // parties: role rank, then sequence
      assert.deepStrictEqual(
        out.parties.map((p) => [p.role, p.sequence_no, p.name, p.entity_type, p.is_primary]),
        [
          ["APPLICANT", 1, "B5F Applicant One", "COMPANY", 1],
          ["APPLICANT", 2, "B5F Applicant Two", "INDIVIDUAL", 0],
          ["OPPOSITE_PARTY", 1, "B5F Opposite One", "INDIVIDUAL", 1],
          ["OPPOSITE_PARTY", 2, "B5F Opposite Two", "INDIVIDUAL", 0],
        ]
      );
      const [a1, a2, o1, o2] = out.parties;

      // addresses
      assert.deepStrictEqual(a1.addresses.map((a) => a.address_line1), ["1 Main Road", "2 Market Street"]);
      const addr = a1.addresses[0];
      assert.deepStrictEqual(
        [addr.address_type, addr.address_line2, addr.village_town, addr.district, addr.state, addr.pincode, addr.is_current, addr.source, addr.party_id],
        ["POSTAL", "Ward 2", "Coonoor", "The Nilgiris", "Tamil Nadu", "643101", 1, "RECEIVED_APPLICATION", a1.party_id]
      );
      assert.deepStrictEqual(
        [a1.addresses[1].address_type, a1.addresses[1].address_line2, a1.addresses[1].pincode, a1.addresses[1].is_current],
        ["OFFICE", null, null, 1]
      );
      assert.deepStrictEqual(o1.addresses.map((a) => [a.address_line1, a.pincode, a.address_type]), [["9 Opp Lane", "643001", "POSTAL"]]);
      assert.deepStrictEqual([a2.addresses, o2.addresses], [[], []]);

      // advocates (`id` is the case_advocates row id, as with ca.* in SQLite)
      assert.strictEqual(a1.advocates.length, 1);
      const adv = a1.advocates[0];
      assert.deepStrictEqual(
        [adv.advocate_name, adv.enrollment_no, adv.phone, adv.email, adv.advocate_address, adv.role, adv.to_date, adv.party_id, adv.case_id],
        ["Adv One", "TN/1/2020", "9000000001", "adv1@example.test", "Bar Association", "COUNSEL", null, a1.party_id, caseId]
      );
      assert.ok(DATE_RE.test(adv.from_date));
      assert.deepStrictEqual(o2.advocates.map((x) => [x.advocate_name, x.enrollment_no, x.phone, x.email, x.advocate_address]), [["Adv Two", null, null, null, null]]);
      assert.deepStrictEqual([a2.advocates, o1.advocates], [[], []]);

      // fees
      assert.strictEqual(out.fees.length, 1);
      const fee = out.fees[0];
      assert.deepStrictEqual(
        [fee.case_id, fee.party_id, fee.fee_type, fee.amount_due, fee.amount_received, fee.dd_number, fee.dd_date, fee.bank_name, fee.payee, fee.received_date, fee.status, fee.refund_amount, fee.deposited_date, fee.refund_date, fee.remarks],
        [caseId, a1.party_id, "APPLICATION_FEE", 1000, 1000, "DD-1", "2026-02-01", "Test Bank", "Chairman, DLSA", "2026-02-01", "RECEIVED", 0, null, null, null]
      );

      // documents (ascending id) with 1/0 flags
      assert.deepStrictEqual(
        out.documents.map((d) => [d.document_type, d.document_title, d.version_no, d.is_current, d.generated_by_system, d.remarks, d.created_by, d.case_id]),
        [
          ["FORM_3", "Form-3 (superseded)", 1, 0, 1, "old version", USER_ID, caseId],
          ["FORM_3", "Form-3 (current)", 2, 1, 1, null, USER_ID, caseId],
        ]
      );

      // docket: T1's single entry, event name joined
      assert.strictEqual(out.docket.length, 1);
      const dk = out.docket[0];
      assert.deepStrictEqual(
        [dk.case_id, dk.event_code, dk.event_name, dk.entry_text, dk.docket_date, dk.action_required, dk.next_date, dk.entered_by],
        [caseId, "APPLICATION_RECEIVED", dk.event_name, "PIM application received and entered for scrutiny.", "2026-02-01", null, null, USER_ID]
      );
      assert.ok(dk.event_name, "event_name must be joined from event_types");
    });

    await test("B", "missing case: same error as SQLite (route: HTTP 400 'PIM case not found.'), incl. ids that cannot be bigints; invalid ids -> 400 'Invalid case ID.'", async () => {
      for (const id of [999999999, 0, -3, 1e20]) {
        const fromPg = await pg.scrutiny(id);
        const fromLite = await lite.scrutiny(id);
        assert.deepStrictEqual(fromPg, { error: "PIM case not found." }, `postgres id=${id}`);
        assert.deepStrictEqual(fromLite, { error: "PIM case not found." }, `sqlite id=${id}`);
      }

      const missing = await callRoute(routeScr, "GET", { userId: aaUser.id, id: 999999999 });
      assert.strictEqual(missing.status, 400, "the existing behavior for a missing case is HTTP 400, not 404");
      assert.deepStrictEqual(missing.json, { success: false, message: "PIM case not found." });

      const overflow = await callRoute(routeScr, "GET", { userId: aaUser.id, id: "99999999999999999999" });
      assert.strictEqual(overflow.status, 400);
      assert.deepStrictEqual(overflow.json, { success: false, message: "PIM case not found." });

      for (const bad of ["abc", "1.5"]) {
        const res = await callRoute(routeScr, "GET", { userId: aaUser.id, id: bad });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, { success: false, message: "Invalid case ID." });
      }
    });

    await test("C", "a case in ANY status is still returned (no eligibility filtering), identical to SQLite, for every workflow status", async () => {
      const t = twin("status");
      for (const code of ["SCRUTINY_PENDING", "DEFECT_PENDING", "SECRETARY_APPROVAL_PENDING", "OUTCOME_FORM_PENDING", "CLOSED_NON_STARTER"]) {
        await Promise.all([pg.setStatus(t.pg.caseId, code), lite.setStatus(t.lite.caseId, code)]);
        const [fromPg, fromLite] = [await pg.scrutiny(t.pg.caseId), await lite.scrutiny(t.lite.caseId)];
        assert.ok(fromPg.wire, `postgres must return the case in ${code}`);
        assert.strictEqual(fromPg.wire.case.status_code, code);
        assertSameAsSqlite(fromPg.wire, fromLite.wire, `scrutiny GET in ${code}`);
      }
    });

    await test("D", "parties / addresses / advocates: identical to the SQLite baseline (rich case), and every child row belongs to the party it is nested under", async () => {
      const { pgScr, liteScr } = await outputs("rich");
      assertSameAsSqlite(pgScr.wire.parties, liteScr.wire.parties, "parties");
      for (const party of pgScr.wire.parties) {
        for (const a of party.addresses) assert.strictEqual(a.party_id, party.party_id);
        for (const adv of party.advocates) assert.strictEqual(adv.party_id, party.party_id);
      }
      const lean = await outputs("complete");
      assertSameAsSqlite(lean.pgScr.wire.parties, lean.liteScr.wire.parties, "parties (lean case)");
    });

    await test("E", "scrutiny / status / docket information: identical to SQLite for COMPLETE and DEFECT cases, with the exact scrutiny values", async () => {
      for (const key of ["complete", "defect"]) {
        const { pgScr, liteScr } = await outputs(key);
        assertSameAsSqlite(pgScr.wire, liteScr.wire, `scrutiny GET (${key})`);
      }

      const complete = (await outputs("complete")).pgScr.wire;
      assert.strictEqual(complete.case.status_code, "PIM_NUMBER_PENDING");
      assert.strictEqual(complete.case.scrutiny_status, "COMPLETE");
      const s = complete.scrutiny;
      assert.deepStrictEqual(
        [s.dd_number, s.dd_date, s.dd_bank, s.dd_amount, s.application_fee_received, s.dd_payee_correct, s.dd_valid, s.scrutiny_result, s.defect_details, s.rectification_date, s.scrutinised_by, s.form1_complete, s.vakalat_available],
        ["DD-778899", "2026-02-01", "State Bank of India", 1000, 1, 1, 1, "COMPLETE", null, null, USER_ID, null, null]
      );
      assert.ok(ISO_RE.test(s.scrutinised_at));
      assert.deepStrictEqual(complete.docket.map((d) => d.event_code), ["SCRUTINY_COMPLETED", "APPLICATION_RECEIVED"]);

      const defect = (await outputs("defect")).pgScr.wire;
      assert.strictEqual(defect.case.status_code, "DEFECT_PENDING");
      assert.strictEqual(defect.scrutiny.defect_details, "Opposite party address incomplete.");
      assert.strictEqual(defect.scrutiny.rectification_date, "2026-02-20");
      assert.strictEqual(defect.scrutiny.dd_amount, 500.5);
      assert.deepStrictEqual(defect.docket.map((d) => d.event_code), ["DEFECT_NOTED", "APPLICATION_RECEIVED"]);
      markNA("E", "tasks are not part of the scrutiny GET response (getScrutinyCase returns case/parties/fees/documents/scrutiny/docket only); task parity is covered under K-R for the non-starter GET");
    });

    await test("F", "ordering: docket newest-first (id DESC), parties by role rank then sequence, addresses/documents/fees/advocates by id ASC - identical to SQLite", async () => {
      const complete = (await outputs("complete")).pgScr.wire;
      const ids = complete.docket.map((d) => d.id);
      assert.deepStrictEqual(ids, [...ids].sort((x, y) => y - x), "docket must be strictly id DESC");

      const { pgScr, liteScr } = await outputs("rich");
      const asc = (rows) => rows.map((r) => r.id);
      assert.deepStrictEqual(asc(pgScr.wire.documents), [...asc(pgScr.wire.documents)].sort((x, y) => x - y));
      for (const party of pgScr.wire.parties) {
        assert.deepStrictEqual(asc(party.addresses), [...asc(party.addresses)].sort((x, y) => x - y));
      }
      // Sequence-level order equals SQLite's (compared on stable values, not ids).
      assert.deepStrictEqual(
        pgScr.wire.parties.map((p) => [p.role, p.sequence_no, p.name]),
        liteScr.wire.parties.map((p) => [p.role, p.sequence_no, p.name])
      );
      assert.deepStrictEqual(pgScr.wire.docket.map((d) => d.event_code), liteScr.wire.docket.map((d) => d.event_code));
    });

    await test("G", "null semantics: a case with no scrutiny row omits the `scrutiny` key (undefined, as SQLite) and every nullable column stays null", async () => {
      const { pgScr, liteScr } = await outputs("rich");
      assert.strictEqual(pgScr.raw.scrutiny, undefined, "loader must return undefined, not null");
      assert.ok(!Object.prototype.hasOwnProperty.call(pgScr.wire, "scrutiny"));
      assert.ok(!Object.prototype.hasOwnProperty.call(liteScr.wire, "scrutiny"));
      assert.strictEqual(JSON.stringify(pgScr.wire).includes('"scrutiny"'), false);

      const c = pgScr.wire.case;
      for (const key of ["pim_number", "registration_date", "secretary_decision", "secretary_decision_date", "outcome_type", "outcome_date", "statutory_due_date", "internal_60_day_date", "closed_at", "scrutiny_status", "dispute_category_id"]) {
        assert.strictEqual(c[key], null, `case.${key}`);
      }
      assertSameAsSqlite(pgScr.wire, liteScr.wire, "null fields (rich case)");
    });

    await test("H", "date/time wire representation is the existing one: plain dates, SQLite 'YYYY-MM-DD HH:MM:SS' for CURRENT_TIMESTAMP columns, ISO for scrutinised_at; 1/0 flags; no booleans, no Date objects", async () => {
      for (const key of ["rich", "complete", "defect"]) {
        const { pgScr, liteScr } = await outputs(key);
        assertNoDateObjects(pgScr.raw, `pg ${key} (loader output)`);
        assertNoBooleans(pgScr.wire, `pg ${key}`);
        assertNoBooleans(liteScr.wire, `sqlite ${key}`);
        assertWireFormats(pgScr.wire, `pg ${key}`);
        assertWireFormats(liteScr.wire, `sqlite ${key}`);
      }
      const { pgScr } = await outputs("rich");
      // The exact columns the pages depend on / that changed engine type:
      assert.ok(SQLITE_TS_RE.test(pgScr.wire.case.created_at) && SQLITE_TS_RE.test(pgScr.wire.case.updated_at));
      assert.ok(SQLITE_TS_RE.test(pgScr.wire.parties[0].addresses[0].created_at));
      assert.ok(SQLITE_TS_RE.test(pgScr.wire.documents[0].created_at));
      assert.ok(SQLITE_TS_RE.test(pgScr.wire.docket[0].created_at));
      assert.strictEqual(pgScr.wire.parties[0].is_primary, 1, "the pages test `party.is_primary === 1`");
      assert.strictEqual(pgScr.wire.parties[1].is_primary, 0);
    });

    await test("I", "auth/permission unchanged: no identity -> 401, unknown identity -> 401, an allowed role (chairman has READ_CASE) -> 200", async () => {
      const id = rich().pg.caseId;
      const none = await callRoute(routeScr, "GET", { id });
      assert.strictEqual(none.status, 401);
      assert.deepStrictEqual(none.json, { success: false, message: "Authentication required." });

      const unknown = await callRoute(routeScr, "GET", { userId: 987654, id });
      assert.strictEqual(unknown.status, 401);

      const chairman = await callRoute(routeScr, "GET", { userId: chairmanUser.id, id });
      assert.strictEqual(chairman.status, 200);
      assert.strictEqual(chairman.json.success, true);
      assert.strictEqual(chairman.json.data.case.id, id);
      // (the permission-before-loader ordering is asserted statically in S)
    });

    // -----------------------------------------------------------------
    // END-TO-END 1: T1 (PostgreSQL) -> Scrutiny GET (PostgreSQL) -> T2 (PostgreSQL)
    // through the REAL route handlers - this is the split being closed.
    // -----------------------------------------------------------------
    await test("J", "END-TO-END: a PostgreSQL T1 case loads through the real scrutiny GET, T2 then operates on it, and the GET reflects the result", async () => {
      const caseId = await pg.createCase(leanPayload(`${TEST_PREFIX}e2e-scrutiny-${RUN_ID}`));

      const [pgRow] = await sql`SELECT id, received_number FROM pim_cases WHERE id = ${caseId}`;
      assert.ok(pgRow, "1. the T1 case exists in PostgreSQL");
      const inLite = db.prepare("SELECT received_number FROM pim_cases WHERE id = ?").get(caseId);
      assert.ok(!inLite || inLite.received_number !== pgRow.received_number, "and this case does NOT exist in SQLite - so a SQLite-backed GET could never have loaded it");

      const before = await callRoute(routeScr, "GET", { userId: aaUser.id, id: caseId });
      assert.strictEqual(before.status, 200, `2. scrutiny GET must load the PostgreSQL case: ${JSON.stringify(before.json)}`);
      assert.strictEqual(before.json.data.case.received_number, pgRow.received_number);
      assert.strictEqual(before.json.data.case.status_code, "RECEIVED");
      assert.strictEqual(before.json.data.parties.length, 2);
      assert.strictEqual(before.json.data.parties[0].is_primary, 1);

      const post = await callRoute(routeScr, "POST", { userId: aaUser.id, id: caseId, body: COMPLETE_DATA });
      assert.strictEqual(post.status, 200, `3. T2 must operate on it: ${JSON.stringify(post.json)}`);
      assert.strictEqual(post.json.status, "PIM_NUMBER_PENDING");

      const after = await callRoute(routeScr, "GET", { userId: aaUser.id, id: caseId });
      assert.strictEqual(after.status, 200);
      assert.strictEqual(after.json.data.case.status_code, "PIM_NUMBER_PENDING");
      assert.strictEqual(after.json.data.case.scrutiny_status, "COMPLETE");
      assert.strictEqual(after.json.data.scrutiny.scrutiny_result, "COMPLETE");
      assert.strictEqual(after.json.data.scrutiny.scrutinised_by, aaUser.id);
      assert.deepStrictEqual(after.json.data.docket.map((d) => d.event_code), ["SCRUTINY_COMPLETED", "APPLICATION_RECEIVED"]);
      // The approval page reads the same endpoint; the fields it displays are present.
      assert.ok(ISO_RE.test(after.json.data.scrutiny.scrutinised_at));
      assert.ok("registration_date" in after.json.data.case && "secretary_decision" in after.json.data.case);
    });

    // =================================================================
    // NON-STARTER GET  (K - R)
    // =================================================================

    await test("K", "PostgreSQL case: the non-starter loader returns the exact expected JSON (no outcome yet; context all-null; reasons; the pending SCRUTINY task)", async () => {
      const t = rich();
      const { pgNs } = await outputs("rich");
      const out = pgNs.wire;

      assert.deepStrictEqual(Object.keys(out).sort(), ["case", "context", "nonstarterReasons", "outcome", "tasks"]);
      assert.strictEqual(out.case.id, t.pg.caseId);
      assert.strictEqual(out.case.status_code, "RECEIVED");
      assert.strictEqual(out.case.status_name, statusIds.RECEIVED.name);
      assert.strictEqual(out.outcome, null);
      assert.deepStrictEqual(out.context, { reasonCode: null, party: null, notice: null, evidence: null });

      assert.deepStrictEqual(
        out.nonstarterReasons,
        reasonList.map((r) => ({
          id: r.id, code: r.code, name: r.name, rule_reference: r.rule_reference,
          requires_authority_decision: r.requires_authority_decision ? 1 : 0, remarks: r.remarks,
        })),
        "the active reasons, in id order, with 1/0 flags"
      );

      assert.strictEqual(out.tasks.length, 1);
      const task = out.tasks[0];
      assert.deepStrictEqual(
        [task.case_id, task.task_type_code, task.description, task.created_date, task.due_date, task.priority, task.status, task.auto_generated, task.completed_date, task.completed_time, task.completed_by, task.remarks],
        [t.pg.caseId, "SCRUTINY", "Scrutiny of newly received PIM application", "2026-02-01", "2026-02-01", "NORMAL", "PENDING", 1, null, null, null, null]
      );

      // After T7 (manual reason): outcome present, context null, 2 tasks.
      const ns = (await outputs("nsmanual")).pgNs.wire;
      const reason = reasonRows.find((r) => r.code === "BOTH_PARTIES_NOT_WILLING");
      assert.strictEqual(ns.case.status_code, "OUTCOME_FORM_PENDING");
      assert.strictEqual(ns.context, null);
      const o = ns.outcome;
      assert.deepStrictEqual(
        [o.case_id, o.outcome_type, o.outcome_date, o.nonstarter_reason_id, o.reason_text, o.nonstarter_reason_code, o.nonstarter_reason_name, o.rule_reference, o.requires_authority_decision, o.sent_to_applicant, o.sent_to_opposite_party, o.prepared_by, o.verified_by, o.approved_by, o.document_id],
        [twin("nsmanual").pg.caseId, "NON_STARTER", "2026-02-05", reason.id, reason.name, reason.code, reason.name, reason.rule_reference, reason.requires_authority_decision ? 1 : 0, 0, 0, USER_ID, null, null, null]
      );
      assert.deepStrictEqual(ns.tasks.map((x) => [x.task_type_code, x.status]), [["SCRUTINY", "PENDING"], ["NONSTARTER_FORM3", "PENDING"]]);
    });

    await test("L", "missing case: loader returns null and the route answers HTTP 404 'PIM case not found.' (as before); invalid ids -> 400 'Invalid case ID.'; a non-bigint id is 'not found', not a database error", async () => {
      for (const id of [999999999, 1e20]) {
        assert.strictEqual(await getNonStarterViewPg(id), null, `postgres id=${id}`);
      }
      assert.strictEqual(routeNs.getNonStarterViewSqlite(999999999), null, "SQLite baseline agrees");

      const missing = await callRoute(routeNs, "GET", { userId: aaUser.id, id: 999999999 });
      assert.strictEqual(missing.status, 404);
      assert.deepStrictEqual(missing.json, { success: false, message: "PIM case not found." });

      const overflow = await callRoute(routeNs, "GET", { userId: aaUser.id, id: "99999999999999999999" });
      assert.strictEqual(overflow.status, 404);

      for (const bad of ["abc", "0", "-3", "1.5"]) {
        const res = await callRoute(routeNs, "GET", { userId: aaUser.id, id: bad });
        assert.strictEqual(res.status, 400, `id=${bad}`);
        assert.deepStrictEqual(res.json, { success: false, message: "Invalid case ID." });
      }
    });

    await test("M", "party information: the only party data this endpoint exposes (context.party {id,name}) matches SQLite for every context branch", async () => {
      for (const key of ["ctxrefusal", "ctxrefusalapp", "ctxabsence", "ctxabsenceafter", "ctxreturned"]) {
        const { pgNs, liteNs } = await outputs(key);
        assert.ok(pgNs.wire.context.party, `${key}: party present`);
        assert.deepStrictEqual(normalizeWire(pgNs.wire.context.party), normalizeWire(liteNs.wire.context.party), `${key}: party`);
        assert.strictEqual(pgNs.wire.context.party.name, "B5F Lean Opposite");
        assert.strictEqual(pgNs.wire.context.party.id, twin(key).pg.info.opId);
      }
      markNA("M", "parties / addresses / advocates are not part of the non-starter GET response (it returns case/outcome/nonstarterReasons/tasks/context only); the Form-3 and Authority pages read parties from GET /api/pim/case/[id] (Batch 2)");
    });

    await test("N", "context / reason / outcome / task / status: identical to SQLite for every state, and each context branch infers the exact reason, notice and evidence", async () => {
      for (const def of TWIN_DEFS) {
        const { pgNs, liteNs } = await outputs(def.key);
        assertSameAsSqlite(pgNs.wire, liteNs.wire, `non-starter GET (${def.key})`);
      }

      const ctx = async (key) => (await outputs(key)).pgNs.wire.context;
      const name = "B5F Lean Opposite";

      let c = await ctx("ctxrefusal");
      let info = twin("ctxrefusal").pg.info;
      assert.deepStrictEqual(c, {
        reasonCode: "OP_REFUSED_MEDIATION",
        party: { id: info.opId, name },
        notice: { id: info.noticeId, notice_type: "FORM_2_INITIAL" },
        evidence: `Opposite party ${name} refused mediation (response #${info.responseId}, 2026-02-10).`,
      });

      c = await ctx("ctxrefusalapp");
      info = twin("ctxrefusalapp").pg.info;
      assert.deepStrictEqual(c, {
        reasonCode: "OP_REFUSED_MEDIATION",
        party: { id: info.opId, name },
        notice: null,
        evidence: `Opposite party ${name} refused mediation (response #${info.responseId}, 2026-02-11).`,
      });

      c = await ctx("ctxabsence");
      info = twin("ctxabsence").pg.info;
      assert.deepStrictEqual(c, {
        reasonCode: "FINAL_NOTICE_UNACKNOWLEDGED",
        party: { id: info.opId, name },
        notice: { id: info.noticeId, notice_type: "FORM_2_FINAL" },
        evidence: `Opposite party ${name} did not appear / no response received (response #${info.responseId}, 2026-03-01).`,
      });

      c = await ctx("ctxabsenceafter");
      info = twin("ctxabsenceafter").pg.info;
      assert.deepStrictEqual(c, {
        reasonCode: "OP_FAILED_TO_APPEAR_AFTER_TIME",
        party: { id: info.opId, name },
        notice: { id: info.noticeId, notice_type: "FORM_2_FINAL" },
        evidence: `Opposite party ${name} did not appear on the alternate date (response #${info.responseId}, 2026-03-05).`,
      });

      c = await ctx("ctxreturned");
      info = twin("ctxreturned").pg.info;
      assert.deepStrictEqual(c, {
        reasonCode: "FINAL_NOTICE_UNACKNOWLEDGED",
        party: { id: info.opId, name },
        notice: { id: info.noticeId, notice_type: "FORM_2_FINAL" },
        evidence: "Final Notice returned (UNCLAIMED); remained unacknowledged.",
      });
    });

    await test("O", "ordering & null semantics: tasks by id ASC, reasons by id ASC, outcome null-vs-object, context null once an outcome exists - identical to SQLite", async () => {
      const { pgNs, liteNs } = await outputs("nsmanual");
      const ids = (rows) => rows.map((r) => r.id);
      assert.deepStrictEqual(ids(pgNs.wire.tasks), [...ids(pgNs.wire.tasks)].sort((a, b) => a - b));
      assert.deepStrictEqual(ids(pgNs.wire.nonstarterReasons), [...ids(pgNs.wire.nonstarterReasons)].sort((a, b) => a - b));
      assert.strictEqual(pgNs.wire.context, null);
      assert.strictEqual(liteNs.wire.context, null);
      assert.notStrictEqual(pgNs.wire.outcome, null);
      assert.strictEqual(pgNs.wire.outcome.verified_by, null);
      assert.strictEqual(pgNs.wire.outcome.settlement_terms, null);
      assertSameAsSqlite(pgNs.wire, liteNs.wire, "outcome-present case");

      const none = await outputs("rich");
      assert.strictEqual(none.pgNs.wire.outcome, null);
      assert.strictEqual(none.liteNs.wire.outcome, null);
    });

    await test("P", "date/time wire representation is the existing one for the non-starter payload: plain dates, SQLite timestamp shape, 1/0 flags, no booleans, no Date objects", async () => {
      for (const def of TWIN_DEFS) {
        const { pgNs, liteNs } = await outputs(def.key);
        assertNoDateObjects(pgNs.raw, `pg ${def.key} (loader output)`);
        assertNoBooleans(pgNs.wire, `pg ${def.key}`);
        assertNoBooleans(liteNs.wire, `sqlite ${def.key}`);
        assertWireFormats(pgNs.wire, `pg ${def.key}`);
      }
      const ns = (await outputs("nsmanual")).pgNs.wire;
      assert.ok(SQLITE_TS_RE.test(ns.case.created_at) && SQLITE_TS_RE.test(ns.case.updated_at));
      assert.ok(DATE_RE.test(ns.outcome.outcome_date) && DATE_RE.test(ns.case.outcome_date));
      assert.strictEqual(ns.outcome.sent_to_applicant, 0);
      assert.strictEqual(ns.tasks[0].auto_generated, 1);
      assert.ok(ns.nonstarterReasons.every((r) => r.requires_authority_decision === 0 || r.requires_authority_decision === 1));
    });

    await test("Q", "auth/permission unchanged: no identity -> 401, unknown identity -> 401, an allowed role (chairman) -> 200", async () => {
      const id = rich().pg.caseId;
      const none = await callRoute(routeNs, "GET", { id });
      assert.strictEqual(none.status, 401);
      assert.deepStrictEqual(none.json, { success: false, message: "Authentication required." });

      const unknown = await callRoute(routeNs, "GET", { userId: 987654, id });
      assert.strictEqual(unknown.status, 401);

      const chairman = await callRoute(routeNs, "GET", { userId: chairmanUser.id, id });
      assert.strictEqual(chairman.status, 200);
      assert.strictEqual(chairman.json.data.case.id, id);
    });

    // -----------------------------------------------------------------
    // END-TO-END 2: T1 (PostgreSQL) -> Non-Starter GET (PostgreSQL) -> T7 (PostgreSQL)
    // -----------------------------------------------------------------
    await test("R", "END-TO-END: a PostgreSQL T1 case loads through the real non-starter GET, T7 then operates on it (reason picked from the GET's own list, as the page does), and the GET reflects the outcome", async () => {
      const caseId = await pg.createCase(leanPayload(`${TEST_PREFIX}e2e-nonstarter-${RUN_ID}`));

      const [pgRow] = await sql`SELECT id, received_number FROM pim_cases WHERE id = ${caseId}`;
      assert.ok(pgRow, "1. the T1 case exists in PostgreSQL");
      const inLite = db.prepare("SELECT received_number FROM pim_cases WHERE id = ?").get(caseId);
      assert.ok(!inLite || inLite.received_number !== pgRow.received_number, "and this case does NOT exist in SQLite");

      const before = await callRoute(routeNs, "GET", { userId: aaUser.id, id: caseId });
      assert.strictEqual(before.status, 200, `2. non-starter GET must load the PostgreSQL case: ${JSON.stringify(before.json)}`);
      assert.strictEqual(before.json.data.case.received_number, pgRow.received_number);
      assert.strictEqual(before.json.data.outcome, null);
      assert.strictEqual(before.json.data.context.reasonCode, null);

      const reason = before.json.data.nonstarterReasons.find((r) => r.code === "BOTH_PARTIES_NOT_WILLING");
      assert.ok(reason, "the manual reason must be offered by the GET");

      const post = await callRoute(routeNs, "POST", { userId: aaUser.id, id: caseId, body: { nonstarterReasonId: reason.id, remarks: "" } });
      assert.strictEqual(post.status, 200, `3. T7 must operate on it: ${JSON.stringify(post.json)}`);
      assert.strictEqual(post.json.data.statusCode, "OUTCOME_FORM_PENDING");

      const after = await callRoute(routeNs, "GET", { userId: aaUser.id, id: caseId });
      assert.strictEqual(after.status, 200);
      assert.strictEqual(after.json.data.case.status_code, "OUTCOME_FORM_PENDING");
      assert.strictEqual(after.json.data.outcome.nonstarter_reason_code, "BOTH_PARTIES_NOT_WILLING");
      assert.strictEqual(after.json.data.outcome.prepared_by, aaUser.id);
      assert.strictEqual(after.json.data.context, null);
      assert.ok(after.json.data.tasks.some((t) => t.task_type_code === "NONSTARTER_FORM3" && t.status === "PENDING"));
      // The Form-3 page's authority label reads this flag with plain truthiness.
      assert.ok([0, 1].includes(after.json.data.outcome.requires_authority_decision));
    });

    // -----------------------------------------------------------------
    // X: extra invariants
    // -----------------------------------------------------------------
    await test("X", "PostgreSQL-authoritative: a decoy SQLite case with the SAME numeric id is never returned, and a SQLite-only id is 'not found' (no fallback, no supplementing)", async () => {
      const id = rich().pg.caseId;
      db.prepare(
        `INSERT INTO pim_cases (id, received_number, received_date, application_date, current_status_id)
         VALUES (?, 'DECOY-SQLITE-ONLY', '2000-01-01', '2000-01-01', (SELECT id FROM status_master WHERE code = 'RECEIVED'))`
      ).run(id);
      const sqliteOnlyId = 987654321;
      db.prepare(
        `INSERT INTO pim_cases (id, received_number, received_date, application_date, current_status_id)
         VALUES (?, 'DECOY-SQLITE-ONLY-2', '2000-01-01', '2000-01-01', (SELECT id FROM status_master WHERE code = 'RECEIVED'))`
      ).run(sqliteOnlyId);

      const scr = await callRoute(routeScr, "GET", { userId: aaUser.id, id });
      const ns = await callRoute(routeNs, "GET", { userId: aaUser.id, id });
      assert.strictEqual(scr.json.data.case.received_number, `${TEST_PREFIX}rich-${RUN_ID}`, "scrutiny GET returned the PostgreSQL row, not the decoy");
      assert.strictEqual(ns.json.data.case.received_number, `${TEST_PREFIX}rich-${RUN_ID}`, "non-starter GET returned the PostgreSQL row, not the decoy");
      assert.strictEqual(scr.json.data.parties.length, 4, "children come from PostgreSQL too (the decoy has none)");

      assert.strictEqual((await callRoute(routeScr, "GET", { userId: aaUser.id, id: sqliteOnlyId })).status, 400);
      assert.strictEqual((await callRoute(routeNs, "GET", { userId: aaUser.id, id: sqliteOnlyId })).status, 404);
    });

    await test("X", "the loaders are read-only: calling them repeatedly changes no PostgreSQL row count", async () => {
      const before = await tableCounts(sql);
      for (const key of ["rich", "complete", "nsmanual"]) {
        await pg.scrutiny(twin(key).pg.caseId);
        await pg.nonstarter(twin(key).pg.caseId);
      }
      assert.deepStrictEqual(await tableCounts(sql), before);
    });
  } finally {
    // -----------------------------------------------------------------
    // Unconditional, ID-driven cleanup - runs even if a test above threw.
    // -----------------------------------------------------------------
    console.log(`\ncleanup: removing exactly these fixture case ids: ${JSON.stringify([...tracker.caseIds])}`);
    try {
      await withRetries("cleanup", () => cleanupCasesByIds(sql, [...tracker.caseIds], tracker));
    } catch (error) {
      console.error(`CLEANUP FAILED: ${error.message}`);
      for (const line of await describeOrphanedTransactions(sql)) console.error(`      orphaned transaction? ${line}`);
      failures.push("cleanup of fixture cases");
    }
  }

  await test("RESIDUE", "no test cases, parties, addresses, advocates, scrutiny rows/attempts, outcomes, tasks, task history, docket, status history, notices, responses, service attempts or documents remain; no orphaned transaction; all table counts equal the pre-run baseline", async () => {
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
 * node scripts/test-pim-read-loaders-postgres.js --cleanup-only
 * Removes fixture cases left by a run that could not clean up (network
 * loss, kill), by the exact ids in the manifest, then verifies by exact
 * id that nothing remains. Runs no tests.
 */
async function runCleanupOnly() {
  const { getSql } = require("../lib/pim-postgres");
  const sql = getSql();
  const tracker = createTracker();

  try {
    let ids;
    try {
      await withRetries("connect", () => sql`SELECT 1`);
      ids = await withRetries("stale cleanup", () => recoverStaleFixtures(sql, tracker));
    } catch (error) {
      console.error(`CLEANUP FAILED: ${error.message}`);
      for (const line of await describeOrphanedTransactions(sql)) console.error(`      orphaned transaction? ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(ids.length ? `removed stale fixture case ids: ${JSON.stringify(ids)}` : "no manifest found - nothing to clean up");
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
