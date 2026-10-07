/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5H-b tests: the PIM-number allocator -
 * lib/pim-data/pim-numbering.js, routed from app/api/pim/pim-number/route.js
 * and app/api/pim/pim-number/initialize/route.js. Replaces T3
 * (lib/pim-approval.js's approvePimRegistration/generatePimNumber, left
 * completely unchanged as a historical/rollback reference - not called
 * anywhere in this batch).
 *
 * Entirely PostgreSQL-only, like Batches 5F/T1/5H-a - there is no SQLite
 * counterpart to this transaction at all (unlike T1/T2's frozen SQLite
 * baselines), so this suite has no parity ("P") letter.
 *
 * EXTREME care around test-year isolation: every test uses a disposable,
 * clearly-not-a-real-calendar-year test year (derived from RUN_ID, never
 * touching 2026 or any other real year). This is load-bearing - a bug
 * here could corrupt the real production sequence this batch's whole
 * design exists to protect. Every test year used is tracked in the
 * fixture manifest exactly like a case id, and RESIDUE explicitly
 * confirms the real current year's sequence row (if any) was untouched.
 *
 * Usage:
 *   node scripts/test-pim-numbering-postgres.js
 *   node scripts/test-pim-numbering-postgres.js --cleanup-only
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO_ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-pim-numbering-manifest.json");
const RUN_ID = Date.now();
// A disposable, obviously-not-a-real-calendar-year base. Never 2026 (or any
// plausible real year) under any circumstances.
const TEST_YEAR_BASE = 900000 + (RUN_ID % 90000);

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
  await test("S", "POST /api/pim/pim-number calls requirePermission(ASSIGN_PIM_NUMBER) then assignPimNumberPg", () => {
    const source = readSource("app/api/pim/pim-number/route.js");
    const body = functionBody(source, "export async function POST(request) {");
    const permission = body.indexOf('requirePermission(request, "ASSIGN_PIM_NUMBER")');
    const call = body.indexOf("await assignPimNumberPg(");
    assert.ok(permission !== -1 && call > permission);
  });

  await test("S", "GET /api/pim/pim-number calls requirePermission(ASSIGN_PIM_NUMBER) then previewNextPimNumber", () => {
    const source = readSource("app/api/pim/pim-number/route.js");
    const body = functionBody(source, "export async function GET(request) {");
    const permission = body.indexOf('requirePermission(request, "ASSIGN_PIM_NUMBER")');
    const call = body.indexOf("await previewNextPimNumber(");
    assert.ok(permission !== -1 && call > permission);
  });

  await test("S", "POST /api/pim/pim-number/initialize calls requirePermission(INITIALIZE_PIM_SEQUENCE), a more restricted permission", () => {
    const source = readSource("app/api/pim/pim-number/initialize/route.js");
    const body = functionBody(source, "export async function POST(request) {");
    assert.ok(body.includes('requirePermission(request, "INITIALIZE_PIM_SEQUENCE")'));
    const { permissionSummary } = require("../lib/pim-auth");
    const permissions = permissionSummary();
    assert.ok(
      permissions.INITIALIZE_PIM_SEQUENCE.length < permissions.ASSIGN_PIM_NUMBER.length,
      "INITIALIZE_PIM_SEQUENCE must be granted to fewer roles than ASSIGN_PIM_NUMBER"
    );
  });

  await test("S", "lib/pim-data/pim-numbering.js is PostgreSQL-only: no SQLite, writes run inside withTransaction, formatPimNumber has no zero-padding", () => {
    const code = stripComments(readSource("lib/pim-data/pim-numbering.js"));
    for (const forbidden of ['require("../db")', 'require("./db")', ".prepare(", "lastInsertRowid", "padStart"]) {
      assert.ok(!code.includes(forbidden), `pim-numbering.js contains ${forbidden}`);
    }
    assert.ok(code.includes("withTransaction((tx) => assignPimNumberTx"));

    const { formatPimNumber } = require("../lib/pim-data/pim-numbering");
    assert.strictEqual(formatPimNumber("PIM", 1, 2026), "PIM/1/2026");
    assert.strictEqual(formatPimNumber("PIM", 119, 2026), "PIM/119/2026");
    assert.notStrictEqual(formatPimNumber("PIM", 5, 2026), "PIM/0005/2026", "must never zero-pad");
  });

  await test("S", "assignPimNumberTx locks the case row (FOR UPDATE) before it ever touches pim_number_sequences", () => {
    const code = readSource("lib/pim-data/pim-numbering.js");
    const forUpdateIndex = code.indexOf("FOR UPDATE");
    const sequenceIndex = code.indexOf("UPDATE pim_number_sequences");
    assert.ok(forUpdateIndex !== -1 && sequenceIndex !== -1 && forUpdateIndex < sequenceIndex);
  });

  await test("S", "generatePimNumber() is never CALLED from pim-numbering.js or the new routes (T3's allocator is not reused) - comments may still mention it by name for context", () => {
    for (const file of [
      "lib/pim-data/pim-numbering.js",
      "app/api/pim/pim-number/route.js",
      "app/api/pim/pim-number/initialize/route.js",
    ]) {
      assert.ok(!stripComments(readSource(file)).includes("generatePimNumber"), `${file} must not call generatePimNumber outside a comment`);
    }
  });

  await test("S", "lib/pim-legacy-import.js no longer calls generatePimNumber() as a fallback", () => {
    assert.ok(!readSource("lib/pim-legacy-import.js").includes("generatePimNumber"));
    assert.ok(
      readSource("lib/pim-legacy-import.js").includes("PIM number is required for this legacy stage"),
      "the explicit validation guard replacing the fallback must be present"
    );
  });
}

// ---------------------------------------------------------------------
// Fixture infrastructure
// ---------------------------------------------------------------------

const COUNT_TABLES = [
  "pim_cases", "pim_parties", "pim_case_parties", "pim_addresses", "pim_advocates", "pim_case_advocates",
  "pim_fees", "pim_status_history", "pim_docket", "pim_tasks", "pim_number_sequences", "audit_log",
];

function createTracker() {
  return {
    caseIds: new Set(),
    years: new Set(),
    addCase(id) {
      this.caseIds.add(id);
      this.persist();
    },
    addYear(year) {
      this.years.add(year);
      this.persist();
    },
    persist() {
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify({ startedAt: new Date().toISOString(), caseIds: [...this.caseIds], years: [...this.years] }, null, 2)
      );
    },
  };
}

function assertDisposableYear(year) {
  if (year < 800000) {
    throw new Error(`Refusing to touch year ${year}: not a disposable test year (must be >= 800000).`);
  }
}

async function cleanupYears(sql, years) {
  if (years.length === 0) return;
  for (const year of years) assertDisposableYear(year);
  await sql`DELETE FROM pim_number_sequences WHERE year IN ${sql(years)}`;
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

const TEST_PREFIX = "TEST-B5Hb-";

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
  if (!fs.existsSync(MANIFEST_PATH)) return { caseIds: [], years: [] };
  let stale;
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    stale = { caseIds: parsed.caseIds || [], years: parsed.years || [] };
  } catch (error) {
    throw new Error(`Could not read the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }
  console.log(`cleanup: removing stale fixtures from a previous run: cases=${JSON.stringify(stale.caseIds)} years=${JSON.stringify(stale.years)}`);
  try {
    await cleanupCasesByIds(sql, stale.caseIds);
    await cleanupYears(sql, stale.years);
  } catch (error) {
    throw new Error(`Could not clean the stale manifest ${MANIFEST_PATH}: ${error.message}. Resolve manually.`);
  }
  for (const id of stale.caseIds) tracker.caseIds.add(id);
  for (const year of stale.years) tracker.years.add(year);
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
    ["pim_status_history", "case_id", caseIds],
    ["pim_docket", "case_id", caseIds],
    ["pim_tasks", "case_id", caseIds],
  ];
  for (const [table, column, ids] of checks) {
    const n = await countWhereIn(sql, table, column, ids);
    if (n !== 0) problems.push(`${table}.${column}: ${n} row(s) remain for tracked ids`);
  }

  for (const year of tracker.years) {
    const n = await countWhereIn(sql, "pim_number_sequences", "year", [year]);
    if (n !== 0) problems.push(`pim_number_sequences: test year ${year} still has a row`);
  }

  // Defense in depth: this suite must NEVER leave a row for the real
  // current year or any plausible real calendar year - EXCEPT the one
  // legitimate production row this whole batch exists to protect: 2026,
  // initialized at last_number=118 (Batch 5H-b, approved and applied
  // this session, verified live as PIM/119/2026). Any OTHER real-year
  // row, or a 2026 row with a different last_number than expected, is
  // still flagged.
  const realYearRows = await sql`SELECT year, last_number FROM pim_number_sequences WHERE year < 800000`;
  const unexpectedRealYearRows = realYearRows.filter((r) => !(r.year === 2026 && r.last_number === 118));
  if (unexpectedRealYearRows.length > 0) {
    problems.push(`pim_number_sequences: unexpected real-year row(s) present: ${JSON.stringify(unexpectedRealYearRows)} - this suite must never touch a real year`);
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

function loadRouteModule(relativePath) {
  const routePath = path.join(REPO_ROOT, ...relativePath.split("/"));
  const original = fs.readFileSync(routePath, "utf8");
  const names = [...original.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
  const source =
    original.replace(/^export async function (\w+)/gm, "async function $1") +
    `\nmodule.exports = { ${names.join(", ")} };\n`;
  const routeModule = new Module(routePath, module);
  routeModule.filename = routePath;
  routeModule.paths = Module._nodeModulePaths(path.dirname(routePath));
  routeModule._compile(source, routePath);
  return routeModule.exports;
}

async function callRoute(route, method, { userId = null, body = undefined, query = "" } = {}) {
  const headers = {};
  if (userId != null) headers["x-pim-user-id"] = String(userId);
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = `http://localhost/api/pim/pim-number${query}`;
  const request = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await route[method](request);
    return { status: response.status, json: await response.json() };
  } finally {
    console.error = originalError;
  }
}

async function callInitRoute(route, { userId = null, body = undefined } = {}) {
  const headers = {};
  if (userId != null) headers["x-pim-user-id"] = String(userId);
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = new Request("http://localhost/api/pim/pim-number/initialize", {
    method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await route.POST(request);
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
  const {
    previewNextPimNumber, initializePimSequencePg, assignPimNumberTx, assignPimNumberPg,
  } = require("../lib/pim-data/pim-numbering");

  const sql = getSql();
  const tracker = createTracker();

  await withRetries("connect", () => sql`SELECT 1`);
  await withRetries("stale cleanup", () => recoverStaleFixtures(sql, tracker));

  const baselineCounts = await tableCounts(sql);
  console.log(`pre-run baseline row counts: ${JSON.stringify(baselineCounts)}`);
  console.log(`test year base: ${TEST_YEAR_BASE}`);

  try {
    const users = await sql`SELECT id, username, role_code FROM users WHERE active = true ORDER BY id`;
    const aaUser = users.find((u) => u.role_code === "aa");
    const chairmanUser = users.find((u) => u.role_code === "chairman");
    const adminUser = users.find((u) => u.role_code === "admin");
    assert.ok(aaUser && chairmanUser && adminUser, "expected synced 'aa', 'chairman', 'admin' users");

    const [pendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'PIM_NUMBER_PENDING'`;
    const [form2PendingStatus] = await sql`SELECT id FROM status_master WHERE code = 'FORM2_PENDING'`;
    const [registeredStatus] = await sql`SELECT id FROM status_master WHERE code = 'REGISTERED'`;

    async function fixtureCase(tag) {
      const caseId = await createReceivedPimApplicationPg({
        receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        receivedDate: "2026-01-10", applicationDate: "2026-01-09",
        applicants: [{ name: `B5Hb Applicant ${tag}` }], oppositeParties: [{ name: `B5Hb Opposite ${tag}` }],
        applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      }, aaUser.id);
      tracker.addCase(caseId);
      return caseId;
    }

    async function movePending(caseId) {
      await sql`UPDATE pim_cases SET current_status_id = ${pendingStatus.id} WHERE id = ${caseId}`;
    }

    async function initYear(year, lastNumber, userId = aaUser.id) {
      tracker.addYear(year);
      return initializePimSequencePg(year, lastNumber, userId);
    }

    let nextTestYear = TEST_YEAR_BASE;
    const freshYear = () => (nextTestYear += 1);

    // =================================================================
    // A: normal assignment (happy path)
    // =================================================================
    let ctxA;
    await test("A", "normal assignment: correct number format, correct final status, correct returned shape", async () => {
      const year = freshYear();
      await initYear(year, 118);
      const caseId = await fixtureCase("A");
      await movePending(caseId);

      const result = await assignPimNumberPg(caseId, aaUser.id, year);
      ctxA = { caseId, result, year };

      assert.strictEqual(result.pimNumber, `PIM/119/${year}`);
      assert.strictEqual(result.currentStatusCode, "FORM2_PENDING");
      assert.strictEqual(result.registeredStatusCode, "REGISTERED");
      assert.deepStrictEqual(
        Object.keys(result).sort(),
        ["applicationDate", "caseId", "currentStatusCode", "form2TaskId", "internal60DayDate", "pimNumber", "receivedDate", "registeredStatusCode", "registrationDate"]
      );

      const [caseRow] = await sql`SELECT pim_number, current_status_id, registration_date, internal_60_day_date, secretary_decision, secretary_decision_date FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.pim_number, `PIM/119/${year}`);
      assert.strictEqual(caseRow.current_status_id, form2PendingStatus.id);
    });

    // =================================================================
    // B: mid-year sequence continuation
    // =================================================================
    await test("B", "mid-year sequence continuation: init last_number=50, three sequential assignments produce 51,52,53", async () => {
      const year = freshYear();
      await initYear(year, 50);

      const numbers = [];
      for (const tag of ["B1", "B2", "B3"]) {
        const caseId = await fixtureCase(tag);
        await movePending(caseId);
        const result = await assignPimNumberPg(caseId, aaUser.id, year);
        numbers.push(result.pimNumber);
      }

      assert.deepStrictEqual(numbers, [`PIM/51/${year}`, `PIM/52/${year}`, `PIM/53/${year}`]);
    });

    // =================================================================
    // C: preview never consumes a number
    // =================================================================
    await test("C", "preview never consumes: last_number=118, repeated preview calls all show 119 and never mutate the row", async () => {
      const year = freshYear();
      await initYear(year, 118);

      for (let i = 0; i < 5; i += 1) {
        const preview = await previewNextPimNumber(year);
        assert.strictEqual(preview.initialized, true);
        assert.strictEqual(preview.lastNumber, 118);
        assert.strictEqual(preview.nextNumber, 119);
        assert.strictEqual(preview.preview, `PIM/119/${year}`);
      }

      const [row] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(row.last_number, 118, "preview must never have advanced last_number");
    });

    await test("C", "preview on an uninitialized year: initialized false, no row created as a side effect", async () => {
      const year = freshYear();
      const preview = await previewNextPimNumber(year);
      assert.deepStrictEqual(preview, { year, initialized: false, lastNumber: null, nextNumber: null, preview: null });
      const [row] = await sql`SELECT year FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(row, undefined, "preview must never create a sequence row");
    });

    // =================================================================
    // D: same-case double submission
    // =================================================================
    await test("D", "same-case concurrent double submission: exactly one commits, exactly one number is consumed (not two)", async () => {
      const year = freshYear();
      await initYear(year, 200);
      const caseId = await fixtureCase("D");
      await movePending(caseId);

      const settled = await Promise.allSettled([
        assignPimNumberPg(caseId, aaUser.id, year),
        assignPimNumberPg(caseId, aaUser.id, year),
      ]);
      const winners = settled.filter((s) => s.status === "fulfilled");
      const losers = settled.filter((s) => s.status === "rejected");

      assert.strictEqual(winners.length, 1, "exactly one submission must commit");
      assert.strictEqual(losers.length, 1);
      // The winner's FULL transaction (ending at FORM2_PENDING) commits and
      // releases the case-row lock before the loser's SELECT ... FOR UPDATE
      // unblocks, so the loser re-reads current_status_id = FORM2_PENDING
      // and trips the STATUS guard (checked first) rather than the
      // pim_number guard (checked second) - both are the same underlying
      // "this case has already moved on" rejection, just via the earlier
      // of the two checks.
      assert.match(losers[0].reason.message, /not available for PIM number assignment/);

      const [seqRow] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(seqRow.last_number, 201, "exactly one number must have been consumed, not two");

      const [caseRow] = await sql`SELECT pim_number FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.pim_number, `PIM/201/${year}`);
    });

    // =================================================================
    // E: two different cases assigned simultaneously
    // =================================================================
    await test("E", "different-case concurrent assignment: both succeed with consecutive, unique numbers", async () => {
      const year = freshYear();
      await initYear(year, 300);
      const caseA = await fixtureCase("E-A");
      const caseB = await fixtureCase("E-B");
      await movePending(caseA);
      await movePending(caseB);

      const [resultA, resultB] = await Promise.all([
        assignPimNumberPg(caseA, aaUser.id, year),
        assignPimNumberPg(caseB, aaUser.id, year),
      ]);

      const numbers = [resultA.pimNumber, resultB.pimNumber].sort();
      assert.deepStrictEqual(numbers, [`PIM/301/${year}`, `PIM/302/${year}`]);

      const [seqRow] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(seqRow.last_number, 302);
    });

    // =================================================================
    // F: transaction failure after the sequence increment rolls back
    // =================================================================
    await test("F", "a downstream failure after the sequence UPDATE rolls back the increment too - no number is burned", async () => {
      const year = freshYear();
      await initYear(year, 400);
      const caseId = await fixtureCase("F");
      await movePending(caseId);

      const SENTINEL_INVALID_USER = 999999999;
      await assert.rejects(
        () => withTransaction((tx) => assignPimNumberTx(tx, caseId, SENTINEL_INVALID_USER, year)),
        /violates foreign key constraint|foreign key/i
      );

      const [seqRow] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(seqRow.last_number, 400, "the sequence increment must have rolled back with everything else");

      const [caseRow] = await sql`SELECT pim_number, current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.pim_number, null);
      assert.strictEqual(caseRow.current_status_id, pendingStatus.id, "case must remain exactly as before");
    });

    // =================================================================
    // G: case already has a PIM number
    // =================================================================
    await test("G", "a case that already has a PIM number is rejected, and no number is consumed", async () => {
      const year = freshYear();
      await initYear(year, 500);
      const caseId = await fixtureCase("G");
      await movePending(caseId);
      await sql`UPDATE pim_cases SET pim_number = 'PIM/999/PRE-EXISTING' WHERE id = ${caseId}`;

      await assert.rejects(
        () => assignPimNumberPg(caseId, aaUser.id, year),
        /already has a PIM number/
      );

      const [seqRow] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(seqRow.last_number, 500, "no number may be consumed when the guard rejects up front");
    });

    // =================================================================
    // H: wrong status
    // =================================================================
    await test("H", "a case not at PIM_NUMBER_PENDING is rejected, and no number is consumed", async () => {
      const year = freshYear();
      await initYear(year, 600);
      const caseId = await fixtureCase("H"); // left at RECEIVED, never moved to PIM_NUMBER_PENDING

      await assert.rejects(
        () => assignPimNumberPg(caseId, aaUser.id, year),
        /not available for PIM number assignment/
      );

      const [seqRow] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(seqRow.last_number, 600);
    });

    // =================================================================
    // I: unauthorized user (real route)
    // =================================================================
    const numberRoute = loadRouteModule("app/api/pim/pim-number/route.js");
    const initRoute = loadRouteModule("app/api/pim/pim-number/initialize/route.js");

    /*
     * POST /api/pim/pim-number never accepts a caller-supplied year -
     * deliberately, for production safety (assignPimNumberPg's `year`
     * parameter always defaults to the real officeYear() in production
     * code; only assignPimNumberPg/assignPimNumberTx called DIRECTLY, as
     * tests A/B/D/E/F/G/H/J/K/L/M all do, can inject a disposable test
     * year). That means a genuine 200-success run through the raw HTTP
     * route would have to allocate against the REAL current year - which
     * this suite must never do. So this test proves auth denial only
     * (401/403, nothing written); the route's successful wiring to
     * assignPimNumberPg is proven statically (test S), and the
     * transaction's own correctness is proven by the direct-call tests
     * above.
     */
    await test("I", "POST via the real route: no identity -> 401; chairman (not staff) -> 403; nothing is written on either denial", async () => {
      const year = freshYear();
      await initYear(year, 700);
      const caseId = await fixtureCase("I");
      await movePending(caseId);

      const none = await callRoute(numberRoute, "POST", { body: { caseId } });
      assert.strictEqual(none.status, 401);

      const forbidden = await callRoute(numberRoute, "POST", { userId: chairmanUser.id, body: { caseId } });
      assert.strictEqual(forbidden.status, 403);
      const [afterDenied] = await sql`SELECT pim_number, current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(afterDenied.pim_number, null, "a denied POST must write nothing");
      assert.strictEqual(afterDenied.current_status_id, pendingStatus.id);
      const [seqRow] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(seqRow.last_number, 700, "a denied POST must not consume a number either");
    });

    await test("I", "GET preview via the real route: no identity -> 401; aa -> 200", async () => {
      const year = freshYear();
      await initYear(year, 800);
      const none = await callRoute(numberRoute, "GET", { query: `?year=${year}` });
      assert.strictEqual(none.status, 401);
      const ok = await callRoute(numberRoute, "GET", { userId: aaUser.id, query: `?year=${year}` });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.json.data.preview, `PIM/801/${year}`);
    });

    await test("I", "initialize via the real route: no identity -> 401; aa (ASSIGN_PIM_NUMBER but not INITIALIZE_PIM_SEQUENCE) -> 403; admin -> 200; a second attempt on the same year -> 400", async () => {
      const year = freshYear();
      const none = await callInitRoute(initRoute, { body: { year, lastNumber: 10 } });
      assert.strictEqual(none.status, 401);

      const forbidden = await callInitRoute(initRoute, { userId: aaUser.id, body: { year, lastNumber: 10 } });
      assert.strictEqual(forbidden.status, 403, "ordinary staff must NOT be able to initialize a sequence");

      const allowed = await callInitRoute(initRoute, { userId: adminUser.id, body: { year, lastNumber: 10 } });
      assert.strictEqual(allowed.status, 200);
      tracker.addYear(year);

      const duplicate = await callInitRoute(initRoute, { userId: adminUser.id, body: { year, lastNumber: 20 } });
      assert.strictEqual(duplicate.status, 400);
      assert.match(duplicate.json.message, /already initialized/);

      const [row] = await sql`SELECT last_number FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(row.last_number, 10, "the rejected second initialization must not have overwritten the first");
    });

    // =================================================================
    // J: year boundary - an uninitialized year fails cleanly
    // =================================================================
    await test("J", "assigning against an uninitialized year fails cleanly, with no fallback and nothing written", async () => {
      const year = freshYear(); // deliberately never initialized
      const caseId = await fixtureCase("J");
      await movePending(caseId);

      await assert.rejects(
        () => assignPimNumberPg(caseId, aaUser.id, year),
        /has not been initialized/
      );

      const [caseRow] = await sql`SELECT pim_number, current_status_id FROM pim_cases WHERE id = ${caseId}`;
      assert.strictEqual(caseRow.pim_number, null);
      assert.strictEqual(caseRow.current_status_id, pendingStatus.id);
      const [seqRow] = await sql`SELECT year FROM pim_number_sequences WHERE year = ${year}`;
      assert.strictEqual(seqRow, undefined, "an uninitialized year must never be silently auto-created");
    });

    // =================================================================
    // K: a malformed/historical pim_number elsewhere never affects the allocator
    // =================================================================
    await test("K", "a free-text/malformed historical pim_number on an unrelated case never perturbs the numeric allocator", async () => {
      const year = freshYear();
      await initYear(year, 900);

      // An unrelated case carrying a non-conforming, free-text historical
      // number (as a real legacy-imported case's pim_number might look) -
      // the allocator must never scan pim_number strings at all.
      const decoyCaseId = await fixtureCase("K-DECOY");
      await sql`UPDATE pim_cases SET pim_number = 'REGISTER-PAGE-14-ENTRY-3 (malformed)' WHERE id = ${decoyCaseId}`;

      const caseId = await fixtureCase("K");
      await movePending(caseId);
      const result = await assignPimNumberPg(caseId, aaUser.id, year);

      assert.strictEqual(result.pimNumber, `PIM/901/${year}`, "the decoy's malformed number must not shift the allocated number");
    });

    // =================================================================
    // L: exact docket/history/task effects
    // =================================================================
    await test("L", "exactly two new docket rows (PIM_NUMBER_ASSIGNED, PIM_REGISTERED) and two status-history hops (PENDING->REGISTERED->FORM2_PENDING)", async () => {
      assert.ok(ctxA, "prerequisite A did not complete");
      const { caseId, result } = ctxA;

      const docket = await sql`
        SELECT et.code AS event_code, d.entry_text
        FROM pim_docket d JOIN event_types et ON et.id = d.event_type_id
        WHERE d.case_id = ${caseId} ORDER BY d.id`;
      const newDocket = docket.slice(-2);
      assert.deepStrictEqual(newDocket.map((d) => d.event_code), ["PIM_NUMBER_ASSIGNED", "PIM_REGISTERED"]);
      assert.strictEqual(newDocket[0].entry_text, `PIM number ${result.pimNumber} assigned.`);
      assert.strictEqual(newDocket[1].entry_text, `PIM registered as ${result.pimNumber}.`);

      const history = await sql`SELECT from_status_id, to_status_id, reason FROM pim_status_history WHERE case_id = ${caseId} ORDER BY id`;
      const newHistory = history.slice(-2);
      assert.strictEqual(newHistory[0].from_status_id, pendingStatus.id);
      assert.strictEqual(newHistory[0].to_status_id, registeredStatus.id);
      assert.strictEqual(newHistory[1].from_status_id, registeredStatus.id);
      assert.strictEqual(newHistory[1].to_status_id, form2PendingStatus.id);

      const [task] = await sql`SELECT task_type_code, status FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'FORM2'`;
      assert.strictEqual(task.status, "PENDING");
      const [taskById] = await sql`SELECT id FROM pim_tasks WHERE id = ${result.form2TaskId}`;
      assert.ok(taskById, "form2TaskId must reference a real row");
    });

    await test("L", "createPendingTaskIfNotExists dedup: a case that already has a pending FORM2 task does not get a second one", async () => {
      const year = freshYear();
      await initYear(year, 1000);
      const caseId = await fixtureCase("L2");
      await movePending(caseId);

      const [taskType] = await sql`SELECT id, default_priority FROM task_types WHERE code = 'FORM2'`;
      const [existingTask] = await sql`
        INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
        VALUES (${caseId}, ${taskType.id}, 'FORM2', 'Pre-existing FORM2 task', '2026-01-01', '2026-01-01', ${taskType.default_priority}, 'PENDING', true)
        RETURNING id`;

      const result = await assignPimNumberPg(caseId, aaUser.id, year);
      assert.strictEqual(result.form2TaskId, existingTask.id, "the pre-existing pending task must be reused, not duplicated");

      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'FORM2'`;
      assert.strictEqual(n, 1);
    });

    // =================================================================
    // M: final status is FORM2_PENDING, REGISTERED never a resting state
    // =================================================================
    await test("M", "REGISTERED is never the final resting current_status_id - the case ends at FORM2_PENDING", async () => {
      assert.ok(ctxA, "prerequisite A did not complete");
      const [caseRow] = await sql`SELECT current_status_id FROM pim_cases WHERE id = ${ctxA.caseId}`;
      assert.strictEqual(caseRow.current_status_id, form2PendingStatus.id);
      assert.notStrictEqual(caseRow.current_status_id, registeredStatus.id);
    });

    // =================================================================
    // N: N/A - no SQLite counterpart to be PostgreSQL-authoritative against
    // =================================================================
    markNA(
      "N",
      "unlike T1/T2, this transaction has no SQLite counterpart at all (T3's SQLite generatePimNumber/approvePimRegistration are a frozen historical rollback reference, never read or written by this module) - there is no SQLite-only fixture for a PostgreSQL path to correctly ignore."
    );

    // =================================================================
    // O: explicit non-parity with the retired Secretary-approval model
    // =================================================================
    await test("O", "the new path writes no secretary_decision/secretary_decision_date and produces no SECRETARY_APPROVAL_PENDING/SECRETARY_APPROVAL reference", async () => {
      assert.ok(ctxA, "prerequisite A did not complete");
      const [caseRow] = await sql`SELECT secretary_decision, secretary_decision_date FROM pim_cases WHERE id = ${ctxA.caseId}`;
      assert.strictEqual(caseRow.secretary_decision, null, "the new path must never write secretary_decision - see decision 20, no fake software approval");
      assert.strictEqual(caseRow.secretary_decision_date, null);

      const docket = await sql`
        SELECT et.code FROM pim_docket d JOIN event_types et ON et.id = d.event_type_id WHERE d.case_id = ${ctxA.caseId}`;
      assert.ok(!docket.some((d) => d.code === "SECRETARY_APPROVAL"), "no SECRETARY_APPROVAL docket event may be written");
    });
  } finally {
    console.log(`\ncleanup: removing exactly these fixture case ids: ${JSON.stringify([...tracker.caseIds])}`);
    console.log(`cleanup: removing exactly these test-year sequence rows: ${JSON.stringify([...tracker.years])}`);
    try {
      await withRetries("cleanup (years)", () => cleanupYears(sql, [...tracker.years]));
    } catch (error) {
      console.error(`CLEANUP FAILED (years): ${error.message}`);
      for (const line of await describeOrphanedTransactions(sql)) console.error(`      orphaned transaction? ${line}`);
      failures.push("cleanup of test-year sequence rows");
    }
    try {
      await withRetries("cleanup (cases)", () => cleanupCasesByIds(sql, [...tracker.caseIds]));
    } catch (error) {
      console.error(`CLEANUP FAILED (cases): ${error.message}`);
      for (const line of await describeOrphanedTransactions(sql)) console.error(`      orphaned transaction? ${line}`);
      failures.push("cleanup of case fixtures");
    }
  }

  await test("RESIDUE", "no test cases, status history, docket, tasks, or test-year sequence rows remain; no orphaned transaction; the real current year's sequence row (if any) was never touched; all other table counts equal the pre-run baseline", async () => {
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
      stale.caseIds.length || stale.years.length
        ? `removed stale fixtures: cases=${JSON.stringify(stale.caseIds)} years=${JSON.stringify(stale.years)}`
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
