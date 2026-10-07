/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 6 Batch 5E tests: PostgreSQL implementation of scrutiny save
 * (T2) - lib/pim-data/scrutiny.js, routed from
 * app/api/pim/scrutiny/[id]/route.js.
 *
 * Environment: SUPABASE_DB_URL is loaded via @next/env's loadEnvConfig
 * BEFORE anything that reads it (lib/pim-postgres.js captures it at
 * require time). Live tests use the real synced users - no fabricated
 * identity.
 *
 * Fixtures: every live test builds its case with the already-verified
 * Batch 5C createReceivedPimApplicationPg (a real T1 case, not a
 * hand-crafted INSERT), then runs T2 against it. Every case id is
 * recorded in a manifest file the moment it is created, and cleanup is
 * ID-driven only (never a name/prefix DELETE) inside try/finally, so a
 * failing assertion cannot skip it and a hard-killed run can be cleaned
 * by exact id on the next start. The run ends with an explicit residue
 * verification of every affected table.
 *
 * Lettering follows the Batch 5E brief:
 *   A success  B rollback  C id linkage  D repeated scrutiny
 *   E permission  F dates  G status transitions  H tasks  I docket
 *   J T2-specific invariants (concurrency backstops, validation, ...)
 * plus "P" for SQLite/PostgreSQL parity and "S" for static checks.
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO_ROOT = path.join(__dirname, "..");
const SCRATCH_DB_PATH = path.join(REPO_ROOT, "database", "test-pim-scrutiny.scratch.db");
const TEST_PREFIX = "TEST-B5E-";
const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-pim-scrutiny-manifest.json");
const SENTINEL_INVALID_USER_ID = 999999999; // cannot exist; not a real or fabricated user

/*
 * Scratch SQLite for the parity baseline and for route-level auth. It
 * is deleted and rebuilt every run so no stale state can leak in, and
 * lib/pim-test-guard refuses to run if it ever resolves to production.
 */
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

/*
 * Runs one test body once and records the outcome under every listed
 * letter (used where a single scenario genuinely proves two brief items,
 * e.g. a natural late failure is both a rollback proof and a
 * concurrency-invariant proof).
 */
async function testMulti(letters, name, fn) {
  const label = letters.join("+");
  try {
    await fn();
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

function intakePayload(tag) {
  return {
    receivedNumber: `${TEST_PREFIX}${tag}-${Date.now()}`,
    receivedDate: "2026-02-01",
    applicationDate: "2026-01-30",
    applicants: [{ name: "B5E Fixture Applicant" }],
    oppositeParties: [{ name: "B5E Fixture Opposite Party" }],
    applicationFee: {
      amount: 1000,
      ddNumber: "DD-1",
      ddDate: "2026-02-01",
      bankName: "Test Bank",
      payee: "Chairman, DLSA",
    },
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

// SQLite baseline text (lib/pim-scrutiny.js) - frozen, pre-Batch-5H-b.
const COMPLETE_ENTRY_TEXT = "Scrutiny completed and file put up for Secretary approval.";
const COMPLETE_REASON = "Scrutiny completed; file put up for Secretary approval.";
const COMPLETE_ACTION_REQUIRED = "Secretary approval";
// PostgreSQL text (lib/pim-data/scrutiny.js) - Batch 5H-b: staff-operated
// PIM-number assignment replaces Secretary approval as the checkpoint
// after scrutiny. This is a DELIBERATE, intentional divergence from the
// frozen SQLite baseline above, not a bug - see the parity-normalization
// helper below, used only in the P (parity) test loop.
const PG_COMPLETE_ENTRY_TEXT = "Scrutiny completed; PIM number assignment pending.";
const PG_COMPLETE_REASON = "Scrutiny completed; PIM number assignment pending.";
const PG_COMPLETE_ACTION_REQUIRED = "Assign PIM number";
const DEFECT_ENTRY_TEXT = "Defect / rectification required during scrutiny.";
const DEFECT_TASK_REMARKS = "Scrutiny completed with defects requiring rectification.";

// ---------------------------------------------------------------------
// Static tests - no database needed, always run.
// ---------------------------------------------------------------------

function postBody(routeSource) {
  const match = routeSource.match(/export async function POST\(request, context\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "POST handler not found in the scrutiny route");
  return match[1];
}

async function runStaticTests() {
  await test("S", "route POST calls requirePermission(COMPLETE_SCRUTINY) before saveScrutinyPg, and awaits it", () => {
    const body = postBody(readSource("app/api/pim/scrutiny/[id]/route.js"));
    const permissionIndex = body.indexOf("requirePermission(");
    const argIndex = body.indexOf('"COMPLETE_SCRUTINY"');
    const callIndex = body.indexOf("await saveScrutinyPg(");
    assert.ok(permissionIndex !== -1, "requirePermission call not found");
    assert.ok(argIndex > permissionIndex, "COMPLETE_SCRUTINY permission argument not found after requirePermission");
    assert.ok(callIndex !== -1, "`await saveScrutinyPg(` not found");
    assert.ok(permissionIndex < callIndex, "requirePermission must run before the PostgreSQL call");
    assert.ok(argIndex < callIndex, "permission argument must precede the PostgreSQL call");
  });

  await test("S", "the SQLite saveScrutiny is still imported (instant rollback), clearly marked, and not called by POST", () => {
    const source = readSource("app/api/pim/scrutiny/[id]/route.js");
    assert.ok(source.includes("saveScrutiny, // SQLite version"), "SQLite version must remain imported and marked");
    assert.ok(!/[^\w]saveScrutiny\(/.test(postBody(source)), "POST must not call the SQLite saveScrutiny");
  });

  // Updated in Batch 5F: this used to assert that GET was still SQLite-backed
  // (5E risk R1). 5F closed that split on purpose, so the assertion now pins
  // the new state: GET reads PostgreSQL and still checks READ_CASE first.
  await test("S", "GET reads PostgreSQL (Batch 5F closed risk R1) and still checks READ_CASE before any data access", () => {
    const source = readSource("app/api/pim/scrutiny/[id]/route.js");
    const getBody = source.match(/export async function GET\(request, context\) \{([\s\S]*?)\n\}/)[1];
    const permissionIndex = getBody.indexOf('requirePermission(request, "READ_CASE")');
    const loaderIndex = getBody.indexOf("await getScrutinyCasePg(caseId)");
    assert.ok(permissionIndex !== -1, "READ_CASE check not found");
    assert.ok(loaderIndex > permissionIndex, "the PostgreSQL loader must be called after the permission check");
    assert.ok(!/[^\w]getScrutinyCase\(/.test(getBody), "GET must not call the SQLite getScrutinyCase");
  });

  await test("S", "lib/pim-data/scrutiny.js never touches SQLite, never re-acquires a client, and uses only the tx it is given", () => {
    const code = stripComments(readSource("lib/pim-data/scrutiny.js"));
    assert.ok(code.includes("withTransaction("), "must use withTransaction");
    for (const forbidden of [
      "getSql(",
      'require("../db")',
      'require("./db")',
      ".prepare(",
      "lastInsertRowid",
      "MAX(id)",
      "CURRENT_DATE",
      "generatePimNumber",
      "dbClient",
      "audit_log",
    ]) {
      assert.ok(!code.includes(forbidden), `forbidden construct present: ${forbidden}`);
    }
    assert.ok(!/\bsql\s*`/.test(code), "no bare sql`...` (only the transaction-scoped tx`...`)");
    assert.ok(code.includes("officeDate()") && code.includes("officeTime()"), "office date/time helpers must be used");
    assert.ok(code.includes("RETURNING id"), "the task-completion UPDATE must use RETURNING id for its row-count check");
  });

  await test("S", "helper reuse is exactly addStatusHistory; workflow-helpers.js is not imported for anything else", () => {
    const code = stripComments(readSource("lib/pim-data/scrutiny.js"));
    const match = code.match(/const \{([^}]*)\} = require\("\.\/workflow-helpers"\)/);
    assert.ok(match, "workflow-helpers import not found");
    assert.deepStrictEqual(
      match[1].split(",").map((s) => s.trim()).filter(Boolean),
      ["addStatusHistory"]
    );
  });

  await test("S", "T2 has no generated-ID dependency in SQLite (no lastInsertRowid in lib/pim-scrutiny.js)", () => {
    assert.ok(!readSource("lib/pim-scrutiny.js").includes("lastInsertRowid"));
  });
}

// ---------------------------------------------------------------------
// Live PostgreSQL work
// ---------------------------------------------------------------------

/*
 * Cleanup is keyed by exact ids only, in ONE transaction (all-or-nothing,
 * ~17 statements total regardless of how many fixtures exist). Before
 * deleting anything it re-checks that every case id that still exists is
 * really a test fixture (received_number carries the test prefix) - a
 * guard on the ids, never a broad prefix DELETE. Party / advocate / task
 * ids are captured BEFORE deletion so the residue check can verify them
 * by exact id afterwards.
 */
async function cleanupCasesByIds(sql, caseIds, tracker) {
  if (caseIds.length === 0) return;

  /*
   * IN ${sql(ids)} (postgres.js list expansion) rather than
   * = ANY(${sql.array(ids)}): sql.array resolves the element->array type
   * from a map postgres.js loads lazily after the first connection, so on
   * a cold client it can bind as text[] and fail. List expansion has no
   * such dependency. Empty lists are guarded (IN () is a syntax error).
   */
  const existing = await sql`SELECT id, received_number FROM pim_cases WHERE id IN ${sql(caseIds)}`;
  for (const row of existing) {
    if (!String(row.received_number || "").startsWith(TEST_PREFIX)) {
      throw new Error(`Refusing to delete case ${row.id}: it is not a test fixture (received_number=${row.received_number}).`);
    }
  }

  await sql.begin(async (tx) => {
    // Fail fast (and diagnosably) if an orphaned transaction still holds a lock on a fixture row.
    await tx`SET LOCAL lock_timeout = '15s'`;

    const partyIds = (await tx`SELECT DISTINCT party_id FROM pim_case_parties WHERE case_id IN ${tx(caseIds)}`).map((r) => r.party_id);
    const advocateIds = (await tx`SELECT DISTINCT advocate_id FROM pim_case_advocates WHERE case_id IN ${tx(caseIds)}`).map((r) => r.advocate_id);
    const taskIds = (await tx`SELECT id FROM pim_tasks WHERE case_id IN ${tx(caseIds)}`).map((r) => r.id);

    for (const id of partyIds) tracker.partyIds.add(id);
    for (const id of advocateIds) tracker.advocateIds.add(id);
    for (const id of taskIds) tracker.taskIds.add(id);

    const del = async (table, column, ids) => {
      if (ids.length > 0) await tx`DELETE FROM ${tx(table)} WHERE ${tx(column)} IN ${tx(ids)}`;
    };

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
 * transaction "idle in transaction" holding row locks (the pooler does not
 * always roll it back, and idle_in_transaction_session_timeout is disabled
 * on this project). List them so a blocked cleanup is self-explaining.
 */
async function describeOrphanedTransactions(sql) {
  try {
    const rows = await sql`
      SELECT pid, state, now() - xact_start AS open_for, left(query, 100) AS query
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'
      ORDER BY xact_start`;
    return rows.map((r) => `pid ${r.pid} (${r.state}, open ${r.open_for}): ${String(r.query).replace(/s+/g, " ")}`);
  } catch {
    return [];
  }
}

function createTracker() {
  return {
    caseIds: new Set(),
    partyIds: new Set(),
    advocateIds: new Set(),
    taskIds: new Set(),
    /*
     * Every created case id is written to the manifest immediately, so a
     * run that is killed (or loses the network) mid-way can be cleaned
     * by exact id afterwards: node scripts/test-pim-scrutiny-postgres.js --cleanup-only
     */
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
 * Removes fixture cases recorded by a previous run that did not get to
 * clean up (killed, or the network dropped). Exact ids only, from the
 * manifest; the prefix guard inside cleanupCasesByIds still applies.
 * Ids are added to tracker.caseIds so the residue check covers them.
 */
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

/*
 * Bounded retry for the two steps whose failure would leave residue in a
 * shared database (cleanup and its verification). Both are idempotent.
 * Only connectivity-class errors are retried; anything else fails
 * immediately so a real defect is never masked.
 */
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

const COUNT_TABLES = [
  "pim_cases",
  "pim_parties",
  "pim_case_parties",
  "pim_addresses",
  "pim_advocates",
  "pim_case_advocates",
  "pim_fees",
  "pim_status_history",
  "pim_docket",
  "pim_tasks",
  "pim_task_history",
  "pim_scrutiny",
  "pim_scrutiny_attempts",
  "pim_outcomes",
  "pim_notices",
  "pim_responses",
  "pim_documents",
  "pim_service_attempts",
  "pim_mediator_assignments",
  "mediation_sessions",
  "audit_log",
];

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
  const [row] = await sql`
    SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE ${sql(column)} IN ${sql(ids)}
  `;
  return row.n;
}

async function verifyNoResidue(sql, tracker, baselineCounts = null) {
  const problems = [];
  const caseIds = [...tracker.caseIds];
  const partyIds = [...tracker.partyIds];
  const advocateIds = [...tracker.advocateIds];
  const taskIds = [...tracker.taskIds];

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
    ["pim_task_history", "task_id", taskIds],
    ["pim_addresses", "party_id", partyIds],
    ["pim_parties", "id", partyIds],
    ["pim_advocates", "id", advocateIds],
  ];

  for (const [table, column, ids] of checks) {
    const n = await countWhereIn(sql, table, column, ids);
    if (n !== 0) problems.push(`${table}.${column}: ${n} row(s) remain for tracked ids`);
  }

  const after = await tableCounts(sql);
  for (const table of COUNT_TABLES) {
    if (baselineCounts && after[table] !== baselineCounts[table]) {
      problems.push(
        `${table}: row count ${after[table]} != pre-run baseline ${baselineCounts[table]} (if another user wrote during this run, re-run)`
      );
    }
  }

  return { problems, after };
}

// ---------------------------------------------------------------------
// Parity machinery: one snapshot definition, two engines.
// ---------------------------------------------------------------------

const SCRUTINY_FIELDS = [
  "form1_complete",
  "application_fee_received",
  "dd_number",
  "dd_date",
  "dd_bank",
  "dd_amount",
  "dd_payee_correct",
  "dd_valid",
  "vakalat_available",
  "opposite_party_address_available",
  "commercial_dispute_checked",
  "territorial_jurisdiction_checked",
  "supporting_documents_checked",
  "scrutiny_result",
  "defect_details",
  "rectification_date",
  "scrutinised_by",
  "scrutinised_at",
];

const SNAPSHOT_QUERIES = {
  caseRow: `
    SELECT sm.code AS status, c.scrutiny_status, c.pim_number
    FROM pim_cases c
    LEFT JOIN status_master sm ON sm.id = c.current_status_id
    WHERE c.id = ?`,
  scrutiny: `SELECT * FROM pim_scrutiny WHERE case_id = ?`,
  attempts: `SELECT * FROM pim_scrutiny_attempts WHERE case_id = ? ORDER BY attempt_no`,
  statusHistory: `
    SELECT f.code AS from_code, t.code AS to_code, h.reason, h.changed_by
    FROM pim_status_history h
    LEFT JOIN status_master f ON f.id = h.from_status_id
    JOIN status_master t ON t.id = h.to_status_id
    WHERE h.case_id = ? ORDER BY h.id`,
  docket: `
    SELECT e.code AS event, d.docket_date, d.entry_text, d.action_required, d.next_date, d.entered_by
    FROM pim_docket d
    LEFT JOIN event_types e ON e.id = d.event_type_id
    WHERE d.case_id = ? ORDER BY d.id`,
  tasks: `
    SELECT task_type_code, description, created_date, due_date, priority, status,
           completed_date, completed_time, completed_by, auto_generated, remarks
    FROM pim_tasks WHERE case_id = ? ORDER BY id`,
  taskHistory: `
    SELECT t.task_type_code AS task, h.old_status, h.new_status, h.changed_by, h.remarks
    FROM pim_task_history h
    JOIN pim_tasks t ON t.id = h.task_id
    WHERE t.case_id = ? ORDER BY h.id`,
};

function isRecentInstant(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) && Math.abs(Date.now() - time) < 10 * 60 * 1000;
}

function normalizeSnapshot(raw, userId, today) {
  const user = (v) => (v === userId ? "USER" : v);
  const day = (v) => (v === today ? "TODAY" : v);
  const clock = (v) => (typeof v === "string" && /^\d{2}:\d{2}:\d{2}$/.test(v) ? "HH:MM:SS" : v);
  const scrutinyRow = (r, extra = []) => {
    if (!r) return null;
    const out = {};
    for (const key of [...extra, ...SCRUTINY_FIELDS]) out[key] = r[key] === undefined ? null : r[key];
    out.scrutinised_by = user(out.scrutinised_by);
    out.scrutinised_at = isRecentInstant(out.scrutinised_at) ? "INSTANT" : out.scrutinised_at;
    return out;
  };

  return {
    case: raw.caseRow,
    scrutiny: scrutinyRow(raw.scrutiny[0]),
    attempts: raw.attempts.map((r) => scrutinyRow(r, ["attempt_no"])),
    statusHistory: raw.statusHistory.map((r) => ({ ...r, changed_by: user(r.changed_by) })),
    docket: raw.docket.map((r) => ({ ...r, docket_date: day(r.docket_date), entered_by: user(r.entered_by) })),
    tasks: raw.tasks.map((r) => ({
      ...r,
      auto_generated: Boolean(r.auto_generated),
      completed_date: day(r.completed_date),
      completed_time: clock(r.completed_time),
      completed_by: user(r.completed_by),
    })),
    taskHistory: raw.taskHistory.map((r) => ({ ...r, changed_by: user(r.changed_by) })),
  };
}

/*
 * Runs a scenario and captures either its value or the exact error
 * message + statusCode tag - error text/tag parity is part of the
 * contract.
 */
async function attempt(fn) {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: { message: error.message, statusCode: error.statusCode ?? null } };
  }
}

function shapeResult(result, caseId, taskId) {
  return {
    keys: Object.keys(result).sort(),
    status: result.status,
    scrutinyResult: result.scrutinyResult,
    nextTaskId: result.nextTaskId,
    caseIdIsInput: result.caseId === caseId,
    completedTaskIdIsThePendingTask: result.completedTaskId === taskId,
  };
}

const SCENARIOS = {
  async complete(a) {
    const caseId = await a.createCase("P-COMPLETE");
    const [taskId] = await a.scrutinyTaskIds(caseId);
    const before = await a.snapshot(caseId);
    const result = await a.save(caseId, COMPLETE_DATA);
    return { before, result: shapeResult(result, caseId, taskId), after: await a.snapshot(caseId) };
  },

  async defect(a) {
    const caseId = await a.createCase("P-DEFECT");
    const [taskId] = await a.scrutinyTaskIds(caseId);
    const result = await a.save(caseId, DEFECT_DATA);
    return { result: shapeResult(result, caseId, taskId), after: await a.snapshot(caseId) };
  },

  async completeWithRectificationDate(a) {
    const caseId = await a.createCase("P-COMPLETE-RECT");
    const [taskId] = await a.scrutinyTaskIds(caseId);
    const result = await a.save(caseId, { ...COMPLETE_DATA, rectificationDate: "2026-03-01" });
    return { result: shapeResult(result, caseId, taskId), after: await a.snapshot(caseId) };
  },

  async fromScrutinyPending(a) {
    const caseId = await a.createCase("P-SCRUTINY-PENDING");
    await a.setStatus(caseId, "SCRUTINY_PENDING");
    const [taskId] = await a.scrutinyTaskIds(caseId);
    const result = await a.save(caseId, DEFECT_DATA);
    return { result: shapeResult(result, caseId, taskId), after: await a.snapshot(caseId) };
  },

  async repeatAfterComplete(a) {
    const caseId = await a.createCase("P-REPEAT");
    await a.save(caseId, COMPLETE_DATA);
    const afterFirst = await a.snapshot(caseId);
    const second = await attempt(() => a.save(caseId, COMPLETE_DATA));
    const afterSecond = await a.snapshot(caseId);
    return { second, unchangedByRepeat: JSON.stringify(afterFirst) === JSON.stringify(afterSecond), afterSecond };
  },

  async repeatAfterDefect(a) {
    const caseId = await a.createCase("P-REPEAT-DEFECT");
    await a.save(caseId, DEFECT_DATA);
    const second = await attempt(() => a.save(caseId, DEFECT_DATA));
    return { second, after: await a.snapshot(caseId) };
  },

  async rescrutinyExistingRow(a) {
    const caseId = await a.createCase("P-RESCRUTINY");
    await a.save(caseId, DEFECT_DATA);
    // No workflow route moves a case back to scrutiny today; this
    // reproduces the data state (SCRUTINY_PENDING + a new pending
    // SCRUTINY task) that reaches the "existing pim_scrutiny row" branch.
    await a.setStatus(caseId, "SCRUTINY_PENDING");
    await a.addPendingScrutinyTask(caseId);
    const result = await a.save(caseId, COMPLETE_DATA);
    return { status: result.status, after: await a.snapshot(caseId) };
  },

  async noPendingTask(a) {
    const caseId = await a.createCase("P-NO-TASK");
    await a.completeScrutinyTaskDirect(caseId);
    const before = await a.snapshot(caseId);
    const outcome = await attempt(() => a.save(caseId, COMPLETE_DATA));
    return { outcome, unchanged: JSON.stringify(before) === JSON.stringify(await a.snapshot(caseId)) };
  },

  async duplicatePendingTasksCompleteOldestFirst(a) {
    const caseId = await a.createCase("P-DUP-TASKS");
    await a.addPendingScrutinyTask(caseId);
    const ids = await a.scrutinyTaskIds(caseId);
    const result = await a.save(caseId, COMPLETE_DATA);
    return {
      completedTheOldest: result.completedTaskId === ids[0],
      completedTheNewest: result.completedTaskId === ids[ids.length - 1],
      after: await a.snapshot(caseId),
    };
  },

  async caseNotFound(a) {
    return attempt(() => a.save(999999999, COMPLETE_DATA));
  },

  async validation(a) {
    const caseId = await a.createCase("P-VALIDATION");
    const before = await a.snapshot(caseId);
    const cases = {
      idAbc: () => a.save("abc", COMPLETE_DATA),
      idZero: () => a.save(0, COMPLETE_DATA),
      idNegative: () => a.save(-3, COMPLETE_DATA),
      idFraction: () => a.save(1.5, COMPLETE_DATA),
      dataNull: () => a.save(caseId, null),
      dataString: () => a.save(caseId, "text"),
      resultMissing: () => a.save(caseId, {}),
      resultInvalid: () => a.save(caseId, { scrutinyResult: "MAYBE" }),
      ddAmountNegative: () => a.save(caseId, { ...COMPLETE_DATA, ddAmount: "-5" }),
      ddAmountNaN: () => a.save(caseId, { ...COMPLETE_DATA, ddAmount: "abc" }),
      defectWithoutDetails: () => a.save(caseId, { ...DEFECT_DATA, defectDetails: undefined }),
      defectWhitespaceDetails: () => a.save(caseId, { ...DEFECT_DATA, defectDetails: "   " }),
    };
    const outcomes = {};
    for (const [name, fn] of Object.entries(cases)) outcomes[name] = await attempt(fn);
    return { outcomes, unchanged: JSON.stringify(before) === JSON.stringify(await a.snapshot(caseId)) };
  },

  async statusGuardBeforeAmountCheck(a) {
    const caseId = await a.createCase("P-PRECEDENCE");
    await a.save(caseId, DEFECT_DATA);
    return attempt(() => a.save(caseId, { ...COMPLETE_DATA, ddAmount: -5 }));
  },

  async ddAmountHandling(a) {
    const out = {};
    for (const [label, value] of [
      ["zero", 0],
      ["emptyString", ""],
      ["null", null],
      ["undefined", undefined],
      ["decimalString", "250.75"],
      ["decimalNumber", 500.5],
    ]) {
      const caseId = await a.createCase(`P-AMT-${label}`);
      const data = { ...COMPLETE_DATA };
      if (value === undefined) delete data.ddAmount;
      else data.ddAmount = value;
      await a.save(caseId, data);
      const snap = await a.snapshot(caseId);
      out[label] = { scrutiny: snap.scrutiny.dd_amount, attempt: snap.attempts[0].dd_amount };
    }
    return out;
  },
};

// ---------------------------------------------------------------------
// Route harness: load the REAL route module (it is written with ES
// `export`, which plain Node cannot require) by rewriting only the
// export keywords, so the real requirePermission -> saveScrutinyPg path
// is exercised without a Next server.
// ---------------------------------------------------------------------

function loadRouteModule() {
  const routePath = path.join(REPO_ROOT, "app", "api", "pim", "scrutiny", "[id]", "route.js");
  const source =
    fs.readFileSync(routePath, "utf8").replace(/^export async function (\w+)/gm, "async function $1") +
    "\nmodule.exports = { GET, POST };\n";
  const routeModule = new Module(routePath, module);
  routeModule.filename = routePath;
  routeModule.paths = Module._nodeModulePaths(path.dirname(routePath));
  routeModule._compile(source, routePath);
  return routeModule.exports;
}

async function callRoutePost(route, { userId, caseId, body }) {
  const headers = { "content-type": "application/json" };
  if (userId != null) headers["x-pim-user-id"] = String(userId);

  const request = new Request(`http://localhost/api/pim/scrutiny/${caseId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await route.POST(request, { params: Promise.resolve({ id: String(caseId) }) });
    return { status: response.status, json: await response.json() };
  } finally {
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------

async function runLive() {
  const { getSql, withTransaction } = require("../lib/pim-postgres");
  const { officeDate, officeTime } = require("../lib/pim-time");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");
  const { saveScrutinyPg, saveScrutinyTx } = require("../lib/pim-data/scrutiny");
  const db = require("../lib/db");
  const { assertScratchDatabase } = require("../lib/pim-test-guard");
  assertScratchDatabase(db);

  const sql = getSql();

  const tracker = createTracker();

  // Warm the connection first: the very first connection from a fresh
  // process was observed to fail transiently (ECONNRESET / CONNECT_TIMEOUT)
  // against the pooler. Bounded retry, connectivity errors only.
  await withRetries("connect", () => sql`SELECT 1`);

  // -- Recover from a previous run that could not clean up, by exact id only. --
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

    const statusIds = {};
    for (const row of await sql`SELECT id, code, name FROM status_master`) statusIds[row.code] = row;
    const eventIds = {};
    for (const row of await sql`SELECT id, code FROM event_types`) eventIds[row.code] = row.id;

    // -- Scratch SQLite: schema + the SAME reference rows PostgreSQL has,
    //    so guard messages built from status names compare like for like. --
    const hasStatusMaster = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='status_master'`).get();
    if (!hasStatusMaster) db.exec(readSource("database/schema.sql"));

    const wantedStatuses = ["RECEIVED", "SCRUTINY_PENDING", "DEFECT_PENDING", "SECRETARY_APPROVAL_PENDING"];
    for (const code of wantedStatuses) {
      const [row] = await sql`SELECT code, name, stage, is_terminal FROM status_master WHERE code = ${code}`;
      db.prepare(`INSERT INTO status_master (code, name, stage, is_terminal) VALUES (?, ?, ?, ?)`).run(
        row.code, row.name, row.stage, row.is_terminal ? 1 : 0
      );
    }
    for (const code of ["APPLICATION_RECEIVED", "SCRUTINY_COMPLETED", "DEFECT_NOTED"]) {
      const [row] = await sql`SELECT code, name, category FROM event_types WHERE code = ${code}`;
      db.prepare(`INSERT INTO event_types (code, name, category) VALUES (?, ?, ?)`).run(row.code, row.name, row.category);
    }
    {
      const [row] = await sql`SELECT code, name, default_priority FROM task_types WHERE code = 'SCRUTINY'`;
      db.prepare(`INSERT INTO task_types (code, name, default_priority) VALUES (?, ?, ?)`).run(row.code, row.name, row.default_priority);
    }
    for (const u of [aaUser, chairmanUser]) {
      db.prepare(
        `INSERT INTO users (id, username, display_name, designation, role_code, active, must_change_password) VALUES (?, ?, ?, ?, ?, 1, 0)`
      ).run(u.id, u.username, u.username, u.role_code, u.role_code);
    }

    const { createReceivedPimApplication } = require("../lib/pim");
    const { saveScrutiny } = require("../lib/pim-scrutiny");

    // -- Adapters: identical interface, so scenarios are written once. --
    const sqliteAdapter = {
      name: "sqlite",
      async createCase(tag) {
        return createReceivedPimApplication(intakePayload(tag), USER_ID);
      },
      async save(caseId, data) {
        return saveScrutiny(caseId, data, USER_ID);
      },
      async snapshot(caseId) {
        const raw = {
          caseRow: db.prepare(SNAPSHOT_QUERIES.caseRow).get(caseId),
          scrutiny: db.prepare(SNAPSHOT_QUERIES.scrutiny).all(caseId),
          attempts: db.prepare(SNAPSHOT_QUERIES.attempts).all(caseId),
          statusHistory: db.prepare(SNAPSHOT_QUERIES.statusHistory).all(caseId),
          docket: db.prepare(SNAPSHOT_QUERIES.docket).all(caseId),
          tasks: db.prepare(SNAPSHOT_QUERIES.tasks).all(caseId),
          taskHistory: db.prepare(SNAPSHOT_QUERIES.taskHistory).all(caseId),
        };
        return normalizeSnapshot(raw, USER_ID, officeDate());
      },
      async scrutinyTaskIds(caseId) {
        return db
          .prepare(`SELECT id FROM pim_tasks WHERE case_id = ? AND task_type_code = 'SCRUTINY' AND status = 'PENDING' ORDER BY id`)
          .all(caseId)
          .map((r) => r.id);
      },
      async setStatus(caseId, code) {
        db.prepare(`UPDATE pim_cases SET current_status_id = (SELECT id FROM status_master WHERE code = ?) WHERE id = ?`).run(code, caseId);
      },
      async addPendingScrutinyTask(caseId) {
        db.prepare(`
          INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
          VALUES (?, (SELECT id FROM task_types WHERE code = 'SCRUTINY'), 'SCRUTINY', 'Re-scrutiny (test fixture)', '2026-02-10', '2026-02-10', 'NORMAL', 'PENDING', 1)
        `).run(caseId);
      },
      async completeScrutinyTaskDirect(caseId) {
        db.prepare(`UPDATE pim_tasks SET status = 'COMPLETED' WHERE case_id = ? AND task_type_code = 'SCRUTINY' AND status = 'PENDING'`).run(caseId);
      },
    };

    const pgAdapter = {
      name: "postgres",
      async createCase(tag) {
        const caseId = await createReceivedPimApplicationPg(intakePayload(tag), USER_ID);
        tracker.addCase(caseId);
        return caseId;
      },
      async save(caseId, data) {
        return saveScrutinyPg(caseId, data, USER_ID);
      },
      async snapshot(caseId) {
        // Read-only queries, issued concurrently (one round-trip of latency, not seven).
        const run = (text) => sql.unsafe(text.replace("?", "$1"), [caseId]);
        const [caseRows, scrutiny, attempts, statusHistory, docket, tasks, taskHistory] = await Promise.all([
          run(SNAPSHOT_QUERIES.caseRow),
          run(SNAPSHOT_QUERIES.scrutiny),
          run(SNAPSHOT_QUERIES.attempts),
          run(SNAPSHOT_QUERIES.statusHistory),
          run(SNAPSHOT_QUERIES.docket),
          run(SNAPSHOT_QUERIES.tasks),
          run(SNAPSHOT_QUERIES.taskHistory),
        ]);
        const raw = { caseRow: caseRows[0], scrutiny, attempts, statusHistory, docket, tasks, taskHistory };
        // PostgreSQL returns timestamptz as Date and Row objects; plain-ify.
        return normalizeSnapshot(JSON.parse(JSON.stringify(raw)), USER_ID, officeDate());
      },
      async scrutinyTaskIds(caseId) {
        const rows = await sql`SELECT id FROM pim_tasks WHERE case_id = ${caseId} AND task_type_code = 'SCRUTINY' AND status = 'PENDING' ORDER BY id`;
        return rows.map((r) => r.id);
      },
      async setStatus(caseId, code) {
        await sql`UPDATE pim_cases SET current_status_id = (SELECT id FROM status_master WHERE code = ${code}) WHERE id = ${caseId}`;
      },
      async addPendingScrutinyTask(caseId) {
        await sql`
          INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
          VALUES (${caseId}, (SELECT id FROM task_types WHERE code = 'SCRUTINY'), 'SCRUTINY', 'Re-scrutiny (test fixture)', '2026-02-10', '2026-02-10', 'NORMAL', 'PENDING', true)
        `;
      },
      async completeScrutinyTaskDirect(caseId) {
        await sql`UPDATE pim_tasks SET status = 'COMPLETED' WHERE case_id = ${caseId} AND task_type_code = 'SCRUTINY' AND status = 'PENDING'`;
      },
    };

    /*
     * Batch 5H-b (Phase 6): the COMPLETE branch's post-scrutiny checkpoint
     * is a DELIBERATE business-rule divergence between the frozen SQLite
     * baseline (still SECRETARY_APPROVAL_PENDING) and the real PostgreSQL
     * path (now PIM_NUMBER_PENDING) - see the matching comment in
     * lib/pim-data/scrutiny.js. Parity testing everywhere else in this
     * suite must stay exact; only these specific, known value pairs are
     * collapsed to a shared placeholder before the cross-engine
     * deepStrictEqual, so a real regression anywhere else still fails
     * loudly. Applied as a deep walk since the six divergent values
     * (status code, status id, docket text, docket action, history
     * reason, task/task-history remarks) surface at different paths
     * depending on which SCENARIO produced the snapshot.
     */
    // Long, specific phrases/codes - safe to match by value anywhere in the
    // tree (negligible collision risk with unrelated data).
    const DIVERGENT_TEXT_PAIRS = [
      ["SECRETARY_APPROVAL_PENDING", "PIM_NUMBER_PENDING"],
      [COMPLETE_ENTRY_TEXT, PG_COMPLETE_ENTRY_TEXT],
      [COMPLETE_REASON, PG_COMPLETE_REASON],
      [COMPLETE_ACTION_REQUIRED, PG_COMPLETE_ACTION_REQUIRED],
    ];
    // The status's human-readable NAME (not code) turns up as a SUBSTRING
    // inside a full error sentence ("...Current status: Secretary Approval
    // Pending"), not as a standalone value - needs a replace, not an
    // exact-match check.
    const DIVERGENT_NAME_PAIRS = [
      [statusIds.SECRETARY_APPROVAL_PENDING.name, statusIds.PIM_NUMBER_PENDING.name],
    ];
    // The numeric status ids (4 vs 29) are NOT safe to match by value alone -
    // small integers like these could coincidentally equal an unrelated case
    // id, task id, or attempt number elsewhere in the same snapshot. Only
    // normalized when the enclosing key is specifically a status-id field.
    const STATUS_ID_KEYS = new Set(["current_status_id", "to_status_id"]);
    const DIVERGENT_STATUS_IDS = new Set([statusIds.SECRETARY_APPROVAL_PENDING.id, statusIds.PIM_NUMBER_PENDING.id]);

    function normalizeIntentionalDivergence(node, key = null) {
      if (Array.isArray(node)) return node.map((item) => normalizeIntentionalDivergence(item));
      if (node && typeof node === "object") {
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = normalizeIntentionalDivergence(v, k);
        return out;
      }
      for (const [sqliteValue, pgValue] of DIVERGENT_TEXT_PAIRS) {
        if (node === sqliteValue || node === pgValue) return "<POST_SCRUTINY_COMPLETE_PENDING>";
      }
      if (STATUS_ID_KEYS.has(key) && DIVERGENT_STATUS_IDS.has(node)) {
        return "<POST_SCRUTINY_COMPLETE_PENDING>";
      }
      if (typeof node === "string") {
        for (const [sqliteName, pgName] of DIVERGENT_NAME_PAIRS) {
          if (node.includes(sqliteName) || node.includes(pgName)) {
            return node.split(sqliteName).join("<POST_SCRUTINY_COMPLETE_PENDING_NAME>").split(pgName).join("<POST_SCRUTINY_COMPLETE_PENDING_NAME>");
          }
        }
      }
      return node;
    }

    // =================================================================
    // P: SQLite <-> PostgreSQL parity (same scenario, both engines,
    // deep-equal normalized transcripts incl. error text + statusCode).
    // =================================================================
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      await test("P", `parity: ${name}`, async () => {
        const fromSqlite = normalizeIntentionalDivergence(await scenario(sqliteAdapter));
        const fromPostgres = normalizeIntentionalDivergence(await scenario(pgAdapter));
        assert.deepStrictEqual(
          fromPostgres,
          fromSqlite,
          `PostgreSQL diverged from SQLite.\nSQLite:   ${JSON.stringify(fromSqlite)}\nPostgres: ${JSON.stringify(fromPostgres)}`
        );
      });
    }

    // =================================================================
    // Detailed PostgreSQL row-level state, read straight from tables.
    // =================================================================
    async function pgState(caseId) {
      // Read-only queries, issued concurrently.
      const [caseRows, scrutiny, attempts, statusHistory, docket, tasks, taskHistory] = await Promise.all([
        sql`
          SELECT c.*, sm.code AS status_code
          FROM pim_cases c LEFT JOIN status_master sm ON sm.id = c.current_status_id
          WHERE c.id = ${caseId}`,
        sql`SELECT * FROM pim_scrutiny WHERE case_id = ${caseId}`,
        sql`SELECT * FROM pim_scrutiny_attempts WHERE case_id = ${caseId} ORDER BY attempt_no`,
        sql`SELECT * FROM pim_status_history WHERE case_id = ${caseId} ORDER BY id`,
        sql`
          SELECT d.*, e.code AS event_code
          FROM pim_docket d LEFT JOIN event_types e ON e.id = d.event_type_id
          WHERE d.case_id = ${caseId} ORDER BY d.id`,
        sql`SELECT * FROM pim_tasks WHERE case_id = ${caseId} ORDER BY id`,
        sql`
          SELECT h.* FROM pim_task_history h JOIN pim_tasks t ON t.id = h.task_id
          WHERE t.case_id = ${caseId} ORDER BY h.id`,
      ]);
      return { caseRow: caseRows[0], scrutiny, attempts, statusHistory, docket, tasks, taskHistory };
    }

    // -----------------------------------------------------------------
    // A. Successful T2
    // -----------------------------------------------------------------
    const ctx = {};

    await test("A", "COMPLETE: status, scrutiny row, attempt, status history, docket, task, task history and every FK/attribution are correct", async () => {
      const caseId = await pgAdapter.createCase("A1");
      const [pendingBefore] = await pgAdapter.scrutinyTaskIds(caseId);
      const auditCount = async () => (await sql`SELECT COUNT(*)::int AS n FROM audit_log`)[0].n;
      const auditBefore = await auditCount();
      const before = await pgState(caseId);

      // Pre-conditions from the real T1 fixture.
      assert.strictEqual(before.caseRow.status_code, "RECEIVED");
      assert.strictEqual(before.caseRow.scrutiny_status, null);
      assert.strictEqual(before.scrutiny.length, 0);
      assert.strictEqual(before.attempts.length, 0);
      assert.strictEqual(before.statusHistory.length, 1);
      assert.strictEqual(before.docket.length, 1);
      assert.strictEqual(before.tasks.length, 1);
      assert.strictEqual(before.tasks[0].status, "PENDING");

      const dayBefore = officeDate();
      const result = await saveScrutinyPg(caseId, COMPLETE_DATA, USER_ID);
      const dayAfter = officeDate();

      ctx.a1 = { caseId, result, pendingBefore, before, dayBefore, dayAfter };

      assert.deepStrictEqual(Object.keys(result).sort(), ["caseId", "completedTaskId", "nextTaskId", "scrutinyResult", "status"]);
      assert.strictEqual(result.caseId, caseId);
      assert.strictEqual(result.status, "PIM_NUMBER_PENDING");
      assert.strictEqual(result.scrutinyResult, "COMPLETE");
      assert.strictEqual(result.completedTaskId, pendingBefore);
      assert.strictEqual(result.nextTaskId, null);

      const after = await pgState(caseId);
      ctx.a1.after = after;

      // case
      assert.strictEqual(after.caseRow.status_code, "PIM_NUMBER_PENDING");
      assert.strictEqual(after.caseRow.current_status_id, statusIds.PIM_NUMBER_PENDING.id);
      assert.strictEqual(after.caseRow.scrutiny_status, "COMPLETE");
      assert.strictEqual(after.caseRow.pim_number, null, "T2 must not assign a PIM number");
      assert.ok(after.caseRow.updated_at > before.caseRow.updated_at, "updated_at must advance");

      // pim_scrutiny (one current-state row)
      assert.strictEqual(after.scrutiny.length, 1);
      const s = after.scrutiny[0];
      assert.strictEqual(s.case_id, caseId);
      assert.strictEqual(s.form1_complete, null);
      assert.strictEqual(s.vakalat_available, null);
      assert.strictEqual(s.application_fee_received, 1);
      assert.strictEqual(s.dd_number, "DD-778899", "dd_number must be trimmed");
      assert.strictEqual(s.dd_date, "2026-02-01");
      assert.strictEqual(s.dd_bank, "State Bank of India", "dd_bank must be trimmed");
      assert.strictEqual(s.dd_amount, 1000);
      for (const flag of [
        "dd_payee_correct", "dd_valid", "opposite_party_address_available",
        "commercial_dispute_checked", "territorial_jurisdiction_checked", "supporting_documents_checked",
      ]) assert.strictEqual(s[flag], 1, flag);
      assert.strictEqual(s.scrutiny_result, "COMPLETE");
      assert.strictEqual(s.defect_details, null);
      assert.strictEqual(s.rectification_date, null);
      assert.strictEqual(s.scrutinised_by, USER_ID);

      // pim_scrutiny_attempts (exactly one, attempt_no 1, same content)
      assert.strictEqual(after.attempts.length, 1);
      const at = after.attempts[0];
      assert.strictEqual(at.case_id, caseId);
      assert.strictEqual(at.attempt_no, 1);
      for (const field of SCRUTINY_FIELDS) {
        if (field === "scrutinised_at") continue;
        assert.deepStrictEqual(at[field], s[field], `attempt.${field} must equal pim_scrutiny.${field}`);
      }
      assert.strictEqual(at.scrutinised_at.getTime(), s.scrutinised_at.getTime(), "both rows carry the same instant");

      // status history: T1's row + exactly one T2 row
      assert.strictEqual(after.statusHistory.length, 2);
      const sh = after.statusHistory[1];
      assert.strictEqual(sh.case_id, caseId);
      assert.strictEqual(sh.from_status_id, statusIds.RECEIVED.id);
      assert.strictEqual(sh.to_status_id, statusIds.PIM_NUMBER_PENDING.id);
      assert.strictEqual(sh.reason, PG_COMPLETE_REASON);
      assert.strictEqual(sh.changed_by, USER_ID);

      // docket: T1's row + exactly one T2 row
      assert.strictEqual(after.docket.length, 2);
      const dk = after.docket[1];
      assert.strictEqual(dk.case_id, caseId);
      assert.strictEqual(dk.event_code, "SCRUTINY_COMPLETED");
      assert.strictEqual(dk.event_type_id, eventIds.SCRUTINY_COMPLETED);
      assert.strictEqual(dk.entry_text, PG_COMPLETE_ENTRY_TEXT);
      assert.strictEqual(dk.action_required, PG_COMPLETE_ACTION_REQUIRED);
      assert.strictEqual(dk.next_date, null);
      assert.strictEqual(dk.entered_by, USER_ID);

      // task: completed in place, none created
      assert.strictEqual(after.tasks.length, 1, "T2 must not create a task");
      const tk = after.tasks[0];
      assert.strictEqual(tk.id, pendingBefore);
      assert.strictEqual(tk.status, "COMPLETED");
      assert.strictEqual(tk.completed_by, USER_ID);
      assert.strictEqual(tk.remarks, PG_COMPLETE_ENTRY_TEXT);

      // task history: exactly one PENDING -> COMPLETED row
      assert.strictEqual(after.taskHistory.length, 1);
      const th = after.taskHistory[0];
      assert.strictEqual(th.task_id, pendingBefore);
      assert.strictEqual(th.old_status, "PENDING");
      assert.strictEqual(th.new_status, "COMPLETED");
      assert.strictEqual(th.changed_by, USER_ID);
      assert.strictEqual(th.remarks, PG_COMPLETE_ENTRY_TEXT);

      // user attribution: every one of the six FK columns is the acting user
      assert.deepStrictEqual(
        [s.scrutinised_by, at.scrutinised_by, sh.changed_by, dk.entered_by, tk.completed_by, th.changed_by],
        Array(6).fill(USER_ID)
      );

      // T2 has no audit_log write (trail = status history/docket/task history)
      assert.strictEqual(await auditCount(), auditBefore);
    });

    await test("A", "DEFECT: DEFECT_PENDING, trimmed defect details, rectification date carried to docket next_date, no task created", async () => {
      const caseId = await pgAdapter.createCase("A2");
      const [pendingBefore] = await pgAdapter.scrutinyTaskIds(caseId);
      const result = await saveScrutinyPg(caseId, DEFECT_DATA, USER_ID);
      ctx.a2 = { caseId, result, pendingBefore };

      assert.strictEqual(result.status, "DEFECT_PENDING");
      assert.strictEqual(result.scrutinyResult, "DEFECT");
      assert.strictEqual(result.nextTaskId, null);
      assert.strictEqual(result.completedTaskId, pendingBefore);

      const st = await pgState(caseId);
      ctx.a2.state = st;
      assert.strictEqual(st.caseRow.status_code, "DEFECT_PENDING");
      assert.strictEqual(st.caseRow.scrutiny_status, "DEFECT");
      assert.strictEqual(st.scrutiny.length, 1);
      assert.strictEqual(st.scrutiny[0].defect_details, "Opposite party address incomplete.");
      assert.strictEqual(st.scrutiny[0].rectification_date, "2026-02-20");
      assert.strictEqual(st.scrutiny[0].dd_amount, 500.5);
      assert.strictEqual(st.scrutiny[0].dd_payee_correct, 0);
      assert.strictEqual(st.attempts.length, 1);
      assert.strictEqual(st.attempts[0].attempt_no, 1);
      assert.strictEqual(st.statusHistory[1].reason, "Opposite party address incomplete.");
      assert.strictEqual(st.docket[1].event_code, "DEFECT_NOTED");
      assert.strictEqual(st.docket[1].next_date, "2026-02-20");
      assert.strictEqual(st.tasks.length, 1);
      assert.strictEqual(st.tasks[0].status, "COMPLETED");
      assert.strictEqual(st.tasks[0].remarks, DEFECT_TASK_REMARKS);
    });

    // -----------------------------------------------------------------
    // C. ID linkage
    // -----------------------------------------------------------------
    await test("C", "every child row references the exact case id / task id / status id / event id (T2 has no generated-ID chain to convert)", async () => {
      assert.ok(ctx.a1, "prerequisite A1 did not complete");
      const { caseId, pendingBefore, after } = ctx.a1;

      // The task id T2 completed is the id read from the DB before the
      // call - never inferred (no MAX(id), no latest-row lookup) - and
      // the task-history row points at that exact id.
      assert.strictEqual(after.taskHistory[0].task_id, pendingBefore);
      assert.strictEqual(after.tasks[0].id, pendingBefore);

      for (const [label, rows] of [
        ["pim_scrutiny", after.scrutiny],
        ["pim_scrutiny_attempts", after.attempts],
        ["pim_status_history", after.statusHistory],
        ["pim_docket", after.docket],
        ["pim_tasks", after.tasks],
      ]) {
        for (const row of rows) assert.strictEqual(row.case_id, caseId, `${label}.case_id`);
      }

      // Status/event FKs resolve to the exact reference rows.
      assert.strictEqual(after.statusHistory[1].to_status_id, statusIds.PIM_NUMBER_PENDING.id);
      assert.strictEqual(after.docket[1].event_type_id, eventIds.SCRUTINY_COMPLETED);

      // Zero lastInsertRowid uses on either side => zero RETURNING id
      // conversions were required for T2 (asserted statically in S).
      assert.ok(!readSource("lib/pim-scrutiny.js").includes("lastInsertRowid"));
    });

    // -----------------------------------------------------------------
    // G. Status transitions
    // -----------------------------------------------------------------
    await test("G", "RECEIVED -> PIM_NUMBER_PENDING on COMPLETE, exact before/after ids in history", async () => {
      assert.ok(ctx.a1, "prerequisite A1 did not complete");
      assert.strictEqual(ctx.a1.before.caseRow.current_status_id, statusIds.RECEIVED.id);
      assert.strictEqual(ctx.a1.after.caseRow.current_status_id, statusIds.PIM_NUMBER_PENDING.id);
      assert.strictEqual(ctx.a1.after.statusHistory[1].from_status_id, statusIds.RECEIVED.id);
      assert.strictEqual(ctx.a1.after.statusHistory[1].to_status_id, statusIds.PIM_NUMBER_PENDING.id);
    });

    await test("G", "SCRUTINY_PENDING -> DEFECT_PENDING on DEFECT (SCRUTINY_PENDING is an accepted starting status)", async () => {
      const caseId = await pgAdapter.createCase("G2");
      await pgAdapter.setStatus(caseId, "SCRUTINY_PENDING");
      const result = await saveScrutinyPg(caseId, DEFECT_DATA, USER_ID);
      assert.strictEqual(result.status, "DEFECT_PENDING");
      const st = await pgState(caseId);
      assert.strictEqual(st.caseRow.current_status_id, statusIds.DEFECT_PENDING.id);
      assert.strictEqual(st.statusHistory[1].from_status_id, statusIds.SCRUTINY_PENDING.id);
      assert.strictEqual(st.statusHistory[1].to_status_id, statusIds.DEFECT_PENDING.id);
    });

    await test("G", "statuses other than RECEIVED/SCRUTINY_PENDING are rejected with the exact SQLite message and no write", async () => {
      assert.ok(ctx.a1 && ctx.a2, "prerequisites A1/A2 did not complete");
      const beforeA1 = JSON.stringify(await pgAdapter.snapshot(ctx.a1.caseId));
      const beforeA2 = JSON.stringify(await pgAdapter.snapshot(ctx.a2.caseId));

      await assert.rejects(
        () => saveScrutinyPg(ctx.a1.caseId, COMPLETE_DATA, USER_ID),
        (e) =>
          e.message === `This case is not available for scrutiny. Current status: ${statusIds.PIM_NUMBER_PENDING.name}` &&
          e.statusCode === 409
      );
      await assert.rejects(
        () => saveScrutinyPg(ctx.a2.caseId, DEFECT_DATA, USER_ID),
        (e) =>
          e.message === `This case is not available for scrutiny. Current status: ${statusIds.DEFECT_PENDING.name}` &&
          e.statusCode === 409
      );

      assert.strictEqual(JSON.stringify(await pgAdapter.snapshot(ctx.a1.caseId)), beforeA1);
      assert.strictEqual(JSON.stringify(await pgAdapter.snapshot(ctx.a2.caseId)), beforeA2);
    });

    // -----------------------------------------------------------------
    // D. Repeated scrutiny (exact existing SQLite behavior: rejected by
    //    the in-transaction status guard, nothing written)
    // -----------------------------------------------------------------
    await test("D", "repeated submission after COMPLETE is rejected (status guard), leaves exactly one attempt/docket/history/task-history", async () => {
      assert.ok(ctx.a1, "prerequisite A1 did not complete");
      await assert.rejects(() => saveScrutinyPg(ctx.a1.caseId, COMPLETE_DATA, USER_ID), /This case is not available for scrutiny/);
      await assert.rejects(() => saveScrutinyPg(ctx.a1.caseId, DEFECT_DATA, USER_ID), /This case is not available for scrutiny/);

      const st = await pgState(ctx.a1.caseId);
      assert.strictEqual(st.attempts.length, 1);
      assert.strictEqual(st.scrutiny.length, 1);
      assert.strictEqual(st.statusHistory.length, 2);
      assert.strictEqual(st.docket.length, 2);
      assert.strictEqual(st.taskHistory.length, 1);
      assert.strictEqual(st.scrutiny[0].scrutiny_result, "COMPLETE", "the rejected DEFECT resubmission must not overwrite the recorded result");
    });

    // -----------------------------------------------------------------
    // H. Tasks
    // -----------------------------------------------------------------
    await test("H", "completes the pending SCRUTINY task (PENDING->COMPLETED + one history row), creates none, nextTaskId null", async () => {
      assert.ok(ctx.a1, "prerequisite A1 did not complete");
      const tk = ctx.a1.after.tasks[0];
      assert.strictEqual(ctx.a1.after.tasks.length, 1);
      assert.strictEqual(tk.task_type_code, "SCRUTINY");
      assert.strictEqual(tk.status, "COMPLETED");
      assert.strictEqual(tk.completed_by, USER_ID);
      assert.strictEqual(ctx.a1.after.taskHistory.length, 1);
      assert.strictEqual(ctx.a1.result.nextTaskId, null);
    });

    await test("H", "a case with no pending SCRUTINY task is rejected with the exact message and nothing is written", async () => {
      const caseId = await pgAdapter.createCase("H2");
      await pgAdapter.completeScrutinyTaskDirect(caseId);
      const before = JSON.stringify(await pgAdapter.snapshot(caseId));

      await assert.rejects(
        () => saveScrutinyPg(caseId, COMPLETE_DATA, USER_ID),
        (e) => e.message === "Pending SCRUTINY task was not found." && e.statusCode === 409
      );

      assert.strictEqual(JSON.stringify(await pgAdapter.snapshot(caseId)), before);
      const st = await pgState(caseId);
      assert.strictEqual(st.scrutiny.length, 0);
      assert.strictEqual(st.attempts.length, 0);
    });

    await test("H", "with duplicate pending SCRUTINY tasks the OLDEST is completed (why workflow-helpers.getPendingTask, which is newest-first, was not reused)", async () => {
      const caseId = await pgAdapter.createCase("H3");
      await pgAdapter.addPendingScrutinyTask(caseId);
      const [oldest, newest] = await pgAdapter.scrutinyTaskIds(caseId);
      assert.ok(oldest < newest);

      const result = await saveScrutinyPg(caseId, COMPLETE_DATA, USER_ID);
      assert.strictEqual(result.completedTaskId, oldest);

      const st = await pgState(caseId);
      assert.strictEqual(st.tasks.find((t) => t.id === oldest).status, "COMPLETED");
      assert.strictEqual(st.tasks.find((t) => t.id === newest).status, "PENDING", "the newer duplicate must be left untouched");
      assert.strictEqual(st.taskHistory.length, 1);
      assert.strictEqual(st.taskHistory[0].task_id, oldest);
    });

    // -----------------------------------------------------------------
    // I. Docket
    // -----------------------------------------------------------------
    await test("I", "exactly one docket entry per call with the exact event/text/action semantics (COMPLETE and DEFECT)", async () => {
      assert.ok(ctx.a1 && ctx.a2, "prerequisites A1/A2 did not complete");
      // T1 wrote 1; T2 adds exactly 1.
      assert.strictEqual(ctx.a1.after.docket.length, ctx.a1.before.docket.length + 1);
      assert.strictEqual(ctx.a2.state.docket.length, 2);

      const complete = ctx.a1.after.docket[1];
      assert.deepStrictEqual(
        [complete.event_code, complete.entry_text, complete.action_required, complete.next_date, complete.entered_by],
        ["SCRUTINY_COMPLETED", PG_COMPLETE_ENTRY_TEXT, PG_COMPLETE_ACTION_REQUIRED, null, USER_ID]
      );

      const defect = ctx.a2.state.docket[1];
      assert.deepStrictEqual(
        [defect.event_code, defect.entry_text, defect.action_required, defect.next_date, defect.entered_by],
        ["DEFECT_NOTED", DEFECT_ENTRY_TEXT, "Rectification required", "2026-02-20", USER_ID]
      );
    });

    // -----------------------------------------------------------------
    // F. Dates / time
    // -----------------------------------------------------------------
    await test("F", "business dates are plain 'YYYY-MM-DD' strings from officeDate(), completed_time is HH:MM:SS, scrutinised_at is a real instant", async () => {
      assert.ok(ctx.a1, "prerequisite A1 did not complete");
      const { after, dayBefore, dayAfter } = ctx.a1;
      const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
      const okToday = (v) => v === dayBefore || v === dayAfter; // tolerates an IST-midnight crossing

      assert.ok(isDay(after.docket[1].docket_date) && okToday(after.docket[1].docket_date), "docket_date must be officeDate()");
      assert.ok(isDay(after.tasks[0].completed_date) && okToday(after.tasks[0].completed_date), "completed_date must be officeDate()");
      assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(after.tasks[0].completed_time), "completed_time must be officeTime()-shaped");
      assert.ok(isDay(after.scrutiny[0].dd_date), "dd_date must round-trip as a plain date string");
      assert.ok(after.scrutiny[0].scrutinised_at instanceof Date && isRecentInstant(after.scrutiny[0].scrutinised_at));
      assert.ok(after.caseRow.updated_at instanceof Date);

      // The user-supplied business dates are passed through untouched.
      assert.strictEqual(ctx.a2.state.scrutiny[0].rectification_date, "2026-02-20");
      assert.strictEqual(ctx.a2.state.scrutiny[0].dd_date, "2026-02-01");

      // officeTime() format sanity (same helper the SQLite path uses).
      assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(officeTime()));
    });

    // -----------------------------------------------------------------
    // B. Rollback
    // -----------------------------------------------------------------
    await test("B", "forced failure AFTER every T2 write: the writes were visible in the transaction, then ALL are rolled back; T1's rows are untouched", async () => {
      const caseId = await pgAdapter.createCase("B1");
      const before = await pgState(caseId);
      const beforeSnapshot = JSON.stringify(await pgAdapter.snapshot(caseId));

      const SENTINEL = "FORCED-FAILURE-AFTER-ALL-T2-WRITES";
      let visibleInsideTx = null;

      await assert.rejects(
        () =>
          withTransaction(async (tx) => {
            const result = await saveScrutinyTx(tx, caseId, COMPLETE_DATA, USER_ID);
            assert.strictEqual(result.status, "PIM_NUMBER_PENDING");

            // Prove the T2 writes really happened inside this transaction.
            const [{ n: scrutinyN }] = await tx`SELECT COUNT(*)::int AS n FROM pim_scrutiny WHERE case_id = ${caseId}`;
            const [{ n: attemptN }] = await tx`SELECT COUNT(*)::int AS n FROM pim_scrutiny_attempts WHERE case_id = ${caseId}`;
            const [{ n: historyN }] = await tx`SELECT COUNT(*)::int AS n FROM pim_status_history WHERE case_id = ${caseId}`;
            const [{ n: docketN }] = await tx`SELECT COUNT(*)::int AS n FROM pim_docket WHERE case_id = ${caseId}`;
            const [{ n: taskHistN }] = await tx`
              SELECT COUNT(*)::int AS n FROM pim_task_history h JOIN pim_tasks t ON t.id = h.task_id WHERE t.case_id = ${caseId}`;
            const [{ status }] = await tx`SELECT status FROM pim_tasks WHERE case_id = ${caseId}`;
            const [{ code }] = await tx`
              SELECT sm.code FROM pim_cases c JOIN status_master sm ON sm.id = c.current_status_id WHERE c.id = ${caseId}`;
            visibleInsideTx = { scrutinyN, attemptN, historyN, docketN, taskHistN, status, code };

            throw new Error(SENTINEL);
          }),
        (e) => e.message === SENTINEL
      );

      assert.deepStrictEqual(visibleInsideTx, {
        scrutinyN: 1, attemptN: 1, historyN: 2, docketN: 2, taskHistN: 1,
        status: "COMPLETED", code: "PIM_NUMBER_PENDING",
      }, "all seven T2 writes must have happened before the forced failure");

      const after = await pgState(caseId);
      // T2-specific rows: gone.
      assert.strictEqual(after.scrutiny.length, 0, "pim_scrutiny");
      assert.strictEqual(after.attempts.length, 0, "pim_scrutiny_attempts");
      assert.strictEqual(after.taskHistory.length, 0, "pim_task_history");
      assert.strictEqual(after.docket.filter((d) => d.event_code === "SCRUTINY_COMPLETED").length, 0, "T2 docket row");
      assert.strictEqual(after.statusHistory.filter((h) => h.to_status_id === statusIds.PIM_NUMBER_PENDING.id).length, 0, "T2 status-history row");
      // Pre-existing T1 rows: still exactly as they were (NOT asserted zero).
      assert.strictEqual(after.statusHistory.length, before.statusHistory.length);
      assert.strictEqual(after.docket.length, before.docket.length);
      assert.strictEqual(after.tasks.length, 1);
      assert.strictEqual(after.tasks[0].status, "PENDING");
      assert.strictEqual(after.tasks[0].completed_by, null);
      assert.strictEqual(after.tasks[0].completed_date, null);
      assert.strictEqual(after.caseRow.status_code, "RECEIVED");
      assert.strictEqual(after.caseRow.scrutiny_status, null);
      // Strongest form: the whole case is identical to before.
      assert.strictEqual(JSON.stringify(await pgAdapter.snapshot(caseId)), beforeSnapshot);
    });

    await test("B", "invalid (sentinel, non-existent) userId fails on the FK and leaves the case exactly as before", async () => {
      const caseId = await pgAdapter.createCase("B2");
      const before = JSON.stringify(await pgAdapter.snapshot(caseId));

      await assert.rejects(
        () => saveScrutinyPg(caseId, COMPLETE_DATA, SENTINEL_INVALID_USER_ID),
        /violates foreign key constraint|foreign key/i
      );

      assert.strictEqual(JSON.stringify(await pgAdapter.snapshot(caseId)), before);
    });

    // -----------------------------------------------------------------
    // J. T2-specific invariants
    // -----------------------------------------------------------------
    await test("J", "catalog: the DB-level backstops T2 relies on exist, and every user-attribution column is an FK to users(id)", async () => {
      const rows = await sql`
        SELECT conrelid::regclass::text AS tbl, conname, contype, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid::regclass::text IN ('pim_scrutiny','pim_scrutiny_attempts','pim_tasks','pim_task_history','pim_docket','pim_status_history')`;
      const byName = Object.fromEntries(rows.map((r) => [r.conname, r]));

      assert.strictEqual(byName.pim_scrutiny_case_id_key?.contype, "u");
      assert.match(byName.pim_scrutiny_case_id_key.def, /UNIQUE \(case_id\)/);
      assert.strictEqual(byName.pim_scrutiny_attempts_case_id_attempt_no_key?.contype, "u");
      assert.match(byName.pim_scrutiny_attempts_case_id_attempt_no_key.def, /UNIQUE \(case_id, attempt_no\)/);

      for (const [name, column] of [
        ["pim_scrutiny_scrutinised_by_fkey", "scrutinised_by"],
        ["pim_scrutiny_attempts_scrutinised_by_fkey", "scrutinised_by"],
        ["pim_status_history_changed_by_fkey", "changed_by"],
        ["pim_docket_entered_by_fkey", "entered_by"],
        ["pim_tasks_completed_by_fkey", "completed_by"],
        ["pim_task_history_changed_by_fkey", "changed_by"],
      ]) {
        assert.ok(byName[name], `missing FK ${name}`);
        assert.match(byName[name].def, new RegExp(`FOREIGN KEY \\(${column}\\) REFERENCES users\\(id\\)`));
      }
    });

    /*
     * J: deterministic reproduction of the real race, no mocking. A
     * second connection holds the pending task's row lock (it "is the
     * other T2 completing that task"). T2 reads the task as PENDING,
     * performs ALL its writes, then blocks on the final guarded task
     * UPDATE; when the holder commits, T2's WHERE no longer matches,
     * it matches 0 rows, throws, and rolls back EVERYTHING. This is the
     * backstop that replaces SQLite's serialization - and also a
     * genuine "late natural failure" rollback (B).
     */
    await testMulti(["J", "B"], "late natural failure under real concurrency: a competing commit on the task makes the guarded UPDATE match 0 rows; T2 throws and rolls back every earlier write", async () => {
      const caseId = await pgAdapter.createCase("J1");
      const [taskId] = await pgAdapter.scrutinyTaskIds(caseId);

      let releaseHolder;
      const gate = new Promise((resolve) => { releaseHolder = resolve; });
      let holderHasLock;
      const holderReady = new Promise((resolve) => { holderHasLock = resolve; });

      const holder = sql.begin(async (h) => {
        await h`
          UPDATE pim_tasks
          SET status = 'COMPLETED', completed_date = ${officeDate()}, completed_by = ${USER_ID}
          WHERE id = ${taskId} AND status = 'PENDING'`;
        holderHasLock();
        await gate;
      });
      holder.catch(() => {});

      // Fail loudly (rather than hang) if the holder cannot take the lock.
      await Promise.race([
        holderReady,
        holder.then(() => { throw new Error("lock-holder transaction ended before taking the row lock"); }),
      ]);

      const racer = saveScrutinyPg(caseId, COMPLETE_DATA, USER_ID);
      racer.catch(() => {});

      // Wait until PostgreSQL reports a backend blocked on a lock, i.e.
      // the racer has done all its earlier writes and is parked on the
      // guarded task UPDATE.
      let lockWaitObserved = false;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !lockWaitObserved) {
        const waiting = await sql`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
        if (waiting.length > 0) lockWaitObserved = true;
        else await sleep(100);
      }
      console.log(`      lock wait observed via pg_stat_activity: ${lockWaitObserved}`);

      releaseHolder();
      await holder;

      let outcome;
      try {
        outcome = { fulfilled: await racer };
      } catch (error) {
        outcome = { rejected: error };
      }

      assert.ok(outcome.rejected, "the racing T2 must NOT commit once another transaction completed the task");
      if (lockWaitObserved) {
        assert.strictEqual(outcome.rejected.message, "The pending scrutiny task could not be completed.");
        assert.strictEqual(outcome.rejected.statusCode, 409);
      } else {
        // Could not prove where the racer was parked; either guard is a
        // correct rejection (nothing may have committed regardless).
        assert.match(outcome.rejected.message, /could not be completed|Pending SCRUTINY task was not found/);
      }

      const st = await pgState(caseId);
      assert.strictEqual(st.scrutiny.length, 0, "pim_scrutiny must have rolled back");
      assert.strictEqual(st.attempts.length, 0, "pim_scrutiny_attempts must have rolled back");
      assert.strictEqual(st.docket.filter((d) => d.event_code === "SCRUTINY_COMPLETED").length, 0, "T2 docket must have rolled back");
      assert.strictEqual(st.statusHistory.length, 1, "only T1's status-history row may remain");
      assert.strictEqual(st.taskHistory.length, 0);
      assert.strictEqual(st.caseRow.status_code, "RECEIVED", "case status must be unchanged");
      assert.strictEqual(st.caseRow.scrutiny_status, null);
      assert.strictEqual(st.tasks[0].completed_by, USER_ID, "only the lock-holder's own completion may remain on the task");
    });

    await test("J", "simultaneous double-submit (x5): exactly one commits, the loser rolls back cleanly, final state is a single T2", async () => {
      const losers = [];

      for (let i = 0; i < 5; i += 1) {
        const caseId = await pgAdapter.createCase(`J2-${i}`);
        const [taskId] = await pgAdapter.scrutinyTaskIds(caseId);

        const settled = await Promise.allSettled([
          saveScrutinyPg(caseId, COMPLETE_DATA, USER_ID),
          saveScrutinyPg(caseId, COMPLETE_DATA, USER_ID),
        ]);
        const winners = settled.filter((s) => s.status === "fulfilled");
        const rejected = settled.filter((s) => s.status === "rejected");

        assert.strictEqual(winners.length, 1, `iteration ${i}: exactly one submission must commit (got ${winners.length})`);
        assert.strictEqual(rejected.length, 1);
        losers.push(rejected[0].reason.message);

        const st = await pgState(caseId);
        assert.strictEqual(st.scrutiny.length, 1, "one pim_scrutiny row");
        assert.strictEqual(st.attempts.length, 1, "one attempt row");
        assert.strictEqual(st.attempts[0].attempt_no, 1);
        assert.strictEqual(st.statusHistory.length, 2, "T1 row + exactly one T2 row");
        assert.strictEqual(st.docket.length, 2, "T1 row + exactly one T2 row");
        assert.strictEqual(st.taskHistory.length, 1, "exactly one task-history row");
        assert.strictEqual(st.tasks.length, 1);
        assert.strictEqual(st.tasks[0].id, taskId);
        assert.strictEqual(st.tasks[0].status, "COMPLETED");
        assert.strictEqual(st.caseRow.status_code, "PIM_NUMBER_PENDING");
      }

      console.log(`      race losers' messages: ${JSON.stringify([...new Set(losers)])}`);
    });

    await test("J", "validation failures write nothing and match SQLite messages (pre-transaction and in-transaction)", async () => {
      const caseId = await pgAdapter.createCase("J4");
      const before = JSON.stringify(await pgAdapter.snapshot(caseId));

      await assert.rejects(() => saveScrutinyPg("abc", COMPLETE_DATA, USER_ID), /^Error: Valid case ID is required\.$/);
      await assert.rejects(() => saveScrutinyPg(caseId, null, USER_ID), /^Error: Scrutiny data is required\.$/);
      await assert.rejects(() => saveScrutinyPg(caseId, { scrutinyResult: "MAYBE" }, USER_ID), /^Error: Scrutiny result must be COMPLETE or DEFECT\.$/);
      await assert.rejects(() => saveScrutinyPg(caseId, { ...COMPLETE_DATA, ddAmount: "-5" }, USER_ID), /^Error: DD amount must be a valid non-negative number\.$/);
      await assert.rejects(() => saveScrutinyPg(caseId, { ...DEFECT_DATA, defectDetails: "  " }, USER_ID), /^Error: Defect details are required when scrutiny result is DEFECT\.$/);
      await assert.rejects(() => saveScrutinyPg(999999999, COMPLETE_DATA, USER_ID), /^Error: PIM case not found\.$/);

      assert.strictEqual(JSON.stringify(await pgAdapter.snapshot(caseId)), before);
    });

    await test("J", "re-scrutiny (existing pim_scrutiny row): row UPDATED not duplicated, attempt_no advances 1 -> 2, both attempts retained", async () => {
      const caseId = await pgAdapter.createCase("J5");
      await saveScrutinyPg(caseId, DEFECT_DATA, USER_ID);
      await pgAdapter.setStatus(caseId, "SCRUTINY_PENDING");
      await pgAdapter.addPendingScrutinyTask(caseId);
      await saveScrutinyPg(caseId, COMPLETE_DATA, USER_ID);

      const st = await pgState(caseId);
      assert.strictEqual(st.scrutiny.length, 1, "UNIQUE(case_id): still one pim_scrutiny row");
      assert.strictEqual(st.scrutiny[0].scrutiny_result, "COMPLETE", "current-state row reflects the latest attempt");
      assert.strictEqual(st.scrutiny[0].defect_details, null);
      assert.deepStrictEqual(st.attempts.map((a) => [a.attempt_no, a.scrutiny_result]), [[1, "DEFECT"], [2, "COMPLETE"]]);
      assert.strictEqual(st.caseRow.status_code, "PIM_NUMBER_PENDING");
    });

    await test("J", "T2 introduces no PIM number, no new task type/row, and no audit_log write", async () => {
      assert.ok(ctx.a1, "prerequisite A1 did not complete");
      assert.strictEqual(ctx.a1.after.caseRow.pim_number, null);
      assert.strictEqual(ctx.a1.after.tasks.length, ctx.a1.before.tasks.length);
      const code = stripComments(readSource("lib/pim-data/scrutiny.js"));
      assert.ok(!code.includes("pim_number") && !code.includes("audit_log"));
    });

    // -----------------------------------------------------------------
    // E. Permission denial - the REAL route handler, real auth, real
    //    PostgreSQL; unauthorized calls must not mutate anything.
    // -----------------------------------------------------------------
    const route = loadRouteModule();

    await test("E", "no session/identity -> 401 and nothing is written", async () => {
      const caseId = await pgAdapter.createCase("E1");
      const before = JSON.stringify(await pgAdapter.snapshot(caseId));
      const res = await callRoutePost(route, { userId: null, caseId, body: COMPLETE_DATA });
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(res.json, { success: false, message: "Authentication required." });
      assert.strictEqual(JSON.stringify(await pgAdapter.snapshot(caseId)), before);
    });

    await test("E", "authenticated but role without COMPLETE_SCRUTINY (chairman) -> 403 and nothing is written", async () => {
      const caseId = await pgAdapter.createCase("E2");
      const before = JSON.stringify(await pgAdapter.snapshot(caseId));
      const res = await callRoutePost(route, { userId: chairmanUser.id, caseId, body: COMPLETE_DATA });
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(res.json, { success: false, message: "You do not have permission to perform this action." });
      assert.strictEqual(JSON.stringify(await pgAdapter.snapshot(caseId)), before);
      const st = await pgState(caseId);
      assert.strictEqual(st.tasks[0].status, "PENDING");
      assert.strictEqual(st.attempts.length, 0);
    });

    await test("E", "authorized role -> 200 with the unchanged response shape; the SQLite-resolved user.id is what lands in every PostgreSQL FK column", async () => {
      const caseId = await pgAdapter.createCase("E3");
      const [taskId] = await pgAdapter.scrutinyTaskIds(caseId);
      const res = await callRoutePost(route, { userId: aaUser.id, caseId, body: COMPLETE_DATA });

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.json, {
        success: true,
        caseId,
        status: "PIM_NUMBER_PENDING",
        scrutinyResult: "COMPLETE",
        completedTaskId: taskId,
        nextTaskId: null,
      });

      const st = await pgState(caseId);
      assert.deepStrictEqual(
        [
          st.scrutiny[0].scrutinised_by, st.attempts[0].scrutinised_by, st.statusHistory[1].changed_by,
          st.docket[1].entered_by, st.tasks[0].completed_by, st.taskHistory[0].changed_by,
        ],
        Array(6).fill(aaUser.id)
      );
    });

    await test("E", "route error contract unchanged: bad id -> 400 'Invalid case ID.'; business guard -> 400 {success:false,message}; unknown case -> 400", async () => {
      const bad = await callRoutePost(route, { userId: aaUser.id, caseId: "abc", body: COMPLETE_DATA });
      assert.strictEqual(bad.status, 400);
      assert.deepStrictEqual(bad.json, { success: false, message: "Invalid case ID." });

      assert.ok(ctx.a1, "prerequisite A1 did not complete");
      const repeat = await callRoutePost(route, { userId: aaUser.id, caseId: ctx.a1.caseId, body: COMPLETE_DATA });
      assert.strictEqual(repeat.status, 400, "409-tagged errors still return HTTP 400 today (unchanged)");
      assert.strictEqual(repeat.json.success, false);
      assert.match(repeat.json.message, /^This case is not available for scrutiny\. Current status: /);

      const unknown = await callRoutePost(route, { userId: aaUser.id, caseId: 999999999, body: COMPLETE_DATA });
      assert.strictEqual(unknown.status, 400);
      assert.deepStrictEqual(unknown.json, { success: false, message: "PIM case not found." });
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

  await test("RESIDUE", "no test cases, scrutiny rows/attempts, outcomes, status history, docket, tasks, task history, parties, addresses or advocates remain; all table counts equal the pre-run baseline", async () => {
    const { problems, after } = await withRetries("residue verification", () => verifyNoResidue(sql, tracker, baselineCounts));
    console.log(`      post-run row counts: ${JSON.stringify(after)}`);
    assert.deepStrictEqual(problems, [], `RESIDUE FOUND:\n${problems.join("\n")}`);
  });

  if (!failures.some((f) => f.startsWith("cleanup") || f.includes("RESIDUE"))) {
    fs.rmSync(MANIFEST_PATH, { force: true });
  }

  await sql.end({ timeout: 5 });
  db.close();
}

/*
 * node scripts/test-pim-scrutiny-postgres.js --cleanup-only
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
    if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is not set");
    await runCleanupOnly();
    return;
  }

  await runStaticTests();

  if (!process.env.SUPABASE_DB_URL) {
    console.log("SKIP: all live PostgreSQL tests (SUPABASE_DB_URL not set in this environment)");
  } else {
    await runLive();
  }

  console.log("\n=== Result matrix ===");
  for (const letter of Object.keys(letterResults).sort()) {
    const r = letterResults[letter];
    const status = r.fail > 0 ? "FAIL" : r.pass > 0 ? "PASS" : r.na.length > 0 ? "N/A" : "-";
    console.log(`${letter}: ${status} (${r.pass} passed, ${r.fail} failed${r.na.length ? `, N/A: ${r.na.join("; ")}` : ""})`);
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
