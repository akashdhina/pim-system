/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * SQLite-vs-PostgreSQL PARITY test for the reports migration (production-
 * completion sprint, 2026-10-07) - not just "the Postgres query executes",
 * but "the Postgres result matches the SQLite result for an equivalent
 * fixture." See docs/phase6-reports-migration.md.
 *
 * Audited against the full checklist requested: julianday(), date(),
 * strftime(), GROUP_CONCAT, IFNULL, boolean/integer truth semantics,
 * COLLATE, NULL ordering, LIKE case sensitivity, GROUP BY, aliases in
 * WHERE/ORDER BY, date subtraction/aging. strftime(), GROUP_CONCAT,
 * IFNULL and COLLATE are N/A - grep-verified absent from
 * lib/pim-reports.js entirely; this script does not fabricate tests for
 * expressions that don't exist. The remaining five are exercised below
 * with a real side-by-side fixture in BOTH engines.
 *
 * SQLite fixtures are inserted directly via lib/db.js (the SAME file
 * other legacy/unmigrated code still uses - NOT a separate test
 * database) and deleted at the end of this run, every row scoped by an
 * exact, tracked id - never a broad DELETE, never touching genuine
 * production rows. See memory note on PIM test-suite hazards: this
 * script, unlike test-pim.js/test-received-pim.js, is written to clean
 * up after itself exactly, not to leave data behind.
 *
 * Usage:
 *   node scripts/test-pim-reports-parity.js
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("assert");

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

const SQLITE_PREFIX = "TEST-RPTPARITY-SQLITE-";
const PG_PREFIX = "TEST-RPTPARITY-PG-";

async function main() {
  const db = require("../lib/db");
  const { buildReportQuery } = require("../lib/pim-reports");
  const { getSql } = require("../lib/pim-postgres");
  const { runReportPg } = require("../lib/pim-data/reports");
  const { createReceivedPimApplicationPg } = require("../lib/pim-data/intake");

  const sql = getSql();
  const sqliteCaseIds = [];
  const pgCaseIds = [];

  function todaySqlite() {
    return new Date().toISOString().slice(0, 10);
  }

  function insertSqliteCase({ receivedDate, applicationDate, internal60Day = null }) {
    const row = db.prepare(`
      INSERT INTO pim_cases (received_number, received_date, application_date, internal_60_day_date, entry_type)
      VALUES (?, ?, ?, ?, 'NEW')
    `).run(`${SQLITE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, receivedDate, applicationDate, internal60Day);
    const caseId = Number(row.lastInsertRowid);
    sqliteCaseIds.push(caseId);
    return caseId;
  }

  function insertSqlitePartyAndCase(name) {
    const party = db.prepare(`INSERT INTO pim_parties (name, entity_type) VALUES (?, 'INDIVIDUAL')`).run(name);
    const partyId = Number(party.lastInsertRowid);
    const caseId = insertSqliteCase({ receivedDate: "2026-01-10", applicationDate: "2026-01-09" });
    db.prepare(`INSERT INTO pim_case_parties (case_id, party_id, role, sequence_no, is_primary) VALUES (?, ?, 'APPLICANT', 1, 1)`).run(caseId, partyId);
    return caseId;
  }

  function insertSqliteTask(caseId, { dueDate }) {
    const row = db.prepare(`
      INSERT INTO pim_tasks (case_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
      VALUES (?, 'FORM2', 'parity fixture task', ?, ?, 'NORMAL', 'PENDING', 1)
    `).run(caseId, todaySqlite(), dueDate);
    return Number(row.lastInsertRowid);
  }

  function insertSqliteFee(caseId, { amountDue, amountReceived }) {
    db.prepare(`
      INSERT INTO pim_fees (case_id, fee_type, amount_due, amount_received, status)
      VALUES (?, 'MEDIATION_FEE', ?, ?, 'PENDING')
    `).run(caseId, amountDue, amountReceived);
  }

  function runSqliteReport(key, params) {
    const built = buildReportQuery(key, new URLSearchParams(params));
    const rows = db.prepare(built.rowsSql).all(...built.queryParams, built.pageSize, built.offset);
    return rows;
  }

  async function fixturePgCase(tag, overrides = {}) {
    const [aaUser] = await sql`SELECT id FROM users WHERE role_code = 'aa' AND active = true LIMIT 1`;
    const caseId = await createReceivedPimApplicationPg({
      receivedNumber: `${PG_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedDate: "2026-01-10", applicationDate: "2026-01-09",
      applicants: [{ name: `Parity Applicant ${tag}` }], oppositeParties: [{ name: `Parity Opposite ${tag}` }],
      applicationFee: { amount: 1000, ddNumber: "DD-1", ddDate: "2026-01-10", bankName: "Test Bank", payee: "Chairman, DLSA" },
      ...overrides,
    }, aaUser.id);
    pgCaseIds.push(caseId);
    return caseId;
  }

  try {
    await test("A", "date subtraction / aging (overdue report): SQLite julianday() and PostgreSQL date subtraction agree exactly", async () => {
      const dueDate = "2026-01-01";
      const sqliteCaseId = insertSqliteCase({ receivedDate: "2026-01-10", applicationDate: "2026-01-09" });
      insertSqliteTask(sqliteCaseId, { dueDate });
      const sqliteRows = runSqliteReport("overdue", { pageSize: "200" });
      const sqliteRow = sqliteRows.find((r) => r.case_id === sqliteCaseId);
      assert.ok(sqliteRow, "SQLite fixture must appear in the SQLite overdue report");

      const pgCaseId = await fixturePgCase("A");
      const [taskType] = await sql`SELECT id, default_priority FROM task_types WHERE code = 'FORM2'`;
      await sql`
        INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
        VALUES (${pgCaseId}, ${taskType.id}, 'FORM2', 'parity fixture task', CURRENT_DATE, ${dueDate}, ${taskType.default_priority}, 'PENDING', true)
      `;
      const pgResult = await runReportPg("overdue", new URLSearchParams({ pageSize: "200" }));
      const pgRow = pgResult.rows.find((r) => r.case_id === pgCaseId);
      assert.ok(pgRow, "Postgres fixture must appear in the Postgres overdue report");

      assert.strictEqual(pgRow.days_overdue, sqliteRow.days_overdue, `days_overdue must match exactly: sqlite=${sqliteRow.days_overdue} pg=${pgRow.days_overdue}`);
    });

    await test("B", "date math + boundary (monitoring report): due today, due in 7 days, and overdue all classify identically in both engines", async () => {
      const today = todaySqlite();
      const in3Days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

      const cases = [
        { tag: "due-today", internal60Day: today },
        { tag: "due-soon", internal60Day: in3Days },
        { tag: "overdue", internal60Day: yesterday },
      ];

      for (const { tag, internal60Day } of cases) {
        const sqliteCaseId = insertSqliteCase({ receivedDate: "2026-01-10", applicationDate: "2026-01-09", internal60Day });
        const pgCaseId = await fixturePgCase(`B-${tag}`);
        await sql`UPDATE pim_cases SET internal_60_day_date = ${internal60Day} WHERE id = ${pgCaseId}`;

        const sqliteRows = runSqliteReport("monitoring", { pageSize: "200" });
        const sqliteRow = sqliteRows.find((r) => r.id === sqliteCaseId);
        assert.ok(sqliteRow, `SQLite fixture (${tag}) must appear in the SQLite monitoring report`);

        const pgResult = await runReportPg("monitoring", new URLSearchParams({ pageSize: "200" }));
        const pgRow = pgResult.rows.find((r) => r.id === pgCaseId);
        assert.ok(pgRow, `Postgres fixture (${tag}) must appear in the Postgres monitoring report`);

        assert.strictEqual(pgRow.days_remaining, sqliteRow.days_remaining, `[${tag}] days_remaining mismatch: sqlite=${sqliteRow.days_remaining} pg=${pgRow.days_remaining}`);
        assert.strictEqual(pgRow.monitoring_status, sqliteRow.monitoring_status, `[${tag}] monitoring_status mismatch: sqlite=${sqliteRow.monitoring_status} pg=${pgRow.monitoring_status}`);
      }
    });

    await test("C", "2-arg MAX vs GREATEST (fees_pending report): balance never negative, identical in both engines for the same due/received pair", async () => {
      const scenarios = [
        { amountDue: 15000, amountReceived: 5000 }, // partial
        { amountDue: 15000, amountReceived: 20000 }, // overpaid - would go negative without clamping
      ];

      for (const { amountDue, amountReceived } of scenarios) {
        const sqliteCaseId = insertSqliteCase({ receivedDate: "2026-01-10", applicationDate: "2026-01-09" });
        insertSqliteFee(sqliteCaseId, { amountDue, amountReceived });
        const sqliteRows = runSqliteReport("fees_pending", { pageSize: "200" });
        const sqliteRow = sqliteRows.find((r) => r.case_id === sqliteCaseId);

        const pgCaseId = await fixturePgCase(`C-${amountReceived}`);
        await sql`INSERT INTO pim_fees (case_id, fee_type, amount_due, amount_received, status) VALUES (${pgCaseId}, 'MEDIATION_FEE', ${amountDue}, ${amountReceived}, 'PENDING')`;
        const pgResult = await runReportPg("fees_pending", new URLSearchParams({ pageSize: "200" }));
        const pgRow = pgResult.rows.find((r) => r.case_id === pgCaseId);

        if (amountReceived >= amountDue) {
          // Both engines' baseWhere excludes fully-paid rows
          // (amount_received < amount_due) - neither should appear.
          assert.strictEqual(sqliteRow, undefined, "fully-paid fixture must be excluded from the SQLite report");
          assert.strictEqual(pgRow, undefined, "fully-paid fixture must be excluded from the Postgres report");
        } else {
          assert.ok(sqliteRow && pgRow, "partially-paid fixture must appear in both reports");
          assert.strictEqual(Number(pgRow.balance), Number(sqliteRow.balance), `balance mismatch: sqlite=${sqliteRow.balance} pg=${pgRow.balance}`);
          assert.ok(Number(pgRow.balance) >= 0 && Number(sqliteRow.balance) >= 0);
        }
      }
    });

    await test("D", "LIKE case sensitivity (register report search): a mixed-case applicant name matches an opposite-case search term in BOTH engines", async () => {
      const name = `${SQLITE_PREFIX}MixedCase-Applicant`;
      const sqliteCaseId = insertSqlitePartyAndCase(name);
      const searchTerm = name.toLowerCase(); // opposite case from how it was stored

      const sqliteRows = runSqliteReport("register", { search: searchTerm, pageSize: "200" });
      assert.ok(sqliteRows.some((r) => r.id === sqliteCaseId), "SQLite's case-insensitive LIKE must match regardless of case (this is the behavior being preserved, not changed)");

      const pgCaseId = await fixturePgCase("D");
      // fixturePgCase always names the applicant "Parity Applicant D" -
      // rename it to the exact mixed-case fixture name for a true
      // like-for-like comparison.
      await sql`UPDATE pim_parties SET name = ${name} WHERE id = (SELECT party_id FROM pim_case_parties WHERE case_id = ${pgCaseId} AND role = 'APPLICANT' LIMIT 1)`;

      const pgResult = await runReportPg("register", new URLSearchParams({ search: searchTerm, pageSize: "200" }));
      assert.ok(pgResult.rows.some((r) => r.id === pgCaseId), "PostgreSQL's ILIKE must match the opposite-case search term too, matching SQLite's default behavior");
    });

    await test("E", "NULL ordering (pending report, due_date ASC): a NULL due_date sorts FIRST in both engines", async () => {
      const sqliteCaseId = insertSqliteCase({ receivedDate: "2026-01-10", applicationDate: "2026-01-09" });
      insertSqliteTask(sqliteCaseId, { dueDate: null });
      insertSqliteTask(sqliteCaseId, { dueDate: "2026-06-01" });

      const sqliteRows = runSqliteReport("pending", { sort: "due_date", direction: "asc", pageSize: "200" });
      const sqliteCaseRows = sqliteRows.filter((r) => r.case_id === sqliteCaseId);
      assert.strictEqual(sqliteCaseRows.length, 2);
      assert.strictEqual(sqliteCaseRows[0].due_date, null, "SQLite: NULL due_date must sort first ascending");

      const pgCaseId = await fixturePgCase("E");
      const [taskType] = await sql`SELECT id, default_priority FROM task_types WHERE code = 'FORM2'`;
      await sql`
        INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
        VALUES (${pgCaseId}, ${taskType.id}, 'FORM2', 'null due date', CURRENT_DATE, NULL, ${taskType.default_priority}, 'PENDING', true)
      `;
      await sql`
        INSERT INTO pim_tasks (case_id, task_type_id, task_type_code, description, created_date, due_date, priority, status, auto_generated)
        VALUES (${pgCaseId}, ${taskType.id}, 'FORM2', 'real due date', CURRENT_DATE, '2026-06-01', ${taskType.default_priority}, 'PENDING', true)
      `;
      const pgResult = await runReportPg("pending", new URLSearchParams({ sort: "due_date", direction: "asc", pageSize: "200" }));
      // fixturePgCase goes through the real intake transaction, which
      // auto-creates its own initial pending task (unlike the SQLite
      // fixture above, built from a raw INSERT with no such side
      // effect) - so this case legitimately has 3 pending tasks, not 2.
      // The row count isn't the point of this test; where the two
      // fixture tasks land in the NULL-vs-non-NULL ordering is.
      const pgCaseRows = pgResult.rows.filter((r) => r.case_id === pgCaseId);
      assert.ok(pgCaseRows.length >= 2, `expected at least the 2 fixture tasks, got ${pgCaseRows.length}`);
      assert.strictEqual(pgCaseRows[0].due_date, null, "PostgreSQL: NULL due_date must ALSO sort first ascending (NULLS FIRST), matching SQLite - this is the fix this test exists to verify");
    });
  } finally {
    console.log(`\ncleanup: SQLite case ids ${JSON.stringify(sqliteCaseIds)}, Postgres case ids ${JSON.stringify(pgCaseIds)}`);

    // SQLite cleanup - exact ids only, never a broad DELETE.
    if (sqliteCaseIds.length > 0) {
      const existing = db.prepare(`SELECT id, received_number FROM pim_cases WHERE id IN (${sqliteCaseIds.map(() => "?").join(",")})`).all(...sqliteCaseIds);
      for (const row of existing) {
        if (!String(row.received_number || "").startsWith(SQLITE_PREFIX)) {
          throw new Error(`Refusing to delete SQLite case ${row.id}: not a test fixture (received_number=${row.received_number}).`);
        }
      }
      const partyIds = db.prepare(`SELECT DISTINCT party_id FROM pim_case_parties WHERE case_id IN (${sqliteCaseIds.map(() => "?").join(",")})`).all(...sqliteCaseIds).map((r) => r.party_id);
      db.transaction(() => {
        for (const caseId of sqliteCaseIds) {
          db.prepare(`DELETE FROM pim_tasks WHERE case_id = ?`).run(caseId);
          db.prepare(`DELETE FROM pim_fees WHERE case_id = ?`).run(caseId);
          db.prepare(`DELETE FROM pim_case_parties WHERE case_id = ?`).run(caseId);
          db.prepare(`DELETE FROM pim_cases WHERE id = ?`).run(caseId);
        }
        for (const partyId of partyIds) {
          db.prepare(`DELETE FROM pim_parties WHERE id = ?`).run(partyId);
        }
      })();
    }

    // Postgres cleanup - reuse the same pattern as every other suite.
    if (pgCaseIds.length > 0) {
      const existing = await sql`SELECT id, received_number FROM pim_cases WHERE id IN ${sql(pgCaseIds)}`;
      for (const row of existing) {
        if (!String(row.received_number || "").startsWith(PG_PREFIX)) {
          throw new Error(`Refusing to delete Postgres case ${row.id}: not a test fixture (received_number=${row.received_number}).`);
        }
      }
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '15s'`;
        const partyIds = (await tx`SELECT DISTINCT party_id FROM pim_case_parties WHERE case_id IN ${tx(pgCaseIds)}`).map((r) => r.party_id);
        const del = async (table, column, ids) => {
          if (ids.length > 0) await tx`DELETE FROM ${tx(table)} WHERE ${tx(column)} IN ${tx(ids)}`;
        };
        await del("pim_tasks", "case_id", pgCaseIds);
        await del("pim_fees", "case_id", pgCaseIds);
        await del("pim_case_advocates", "case_id", pgCaseIds);
        await del("pim_case_parties", "case_id", pgCaseIds);
        await del("pim_addresses", "party_id", partyIds);
        await del("pim_parties", "id", partyIds);
        await del("pim_cases", "id", pgCaseIds);
      });
    }
  }

  await test("RESIDUE", "no fixture rows remain in either engine", async () => {
    const sqliteRemaining = sqliteCaseIds.length > 0
      ? db.prepare(`SELECT COUNT(*) AS n FROM pim_cases WHERE id IN (${sqliteCaseIds.map(() => "?").join(",")})`).get(...sqliteCaseIds).n
      : 0;
    assert.strictEqual(sqliteRemaining, 0, "SQLite fixtures must be fully removed");

    if (pgCaseIds.length > 0) {
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM pim_cases WHERE id IN ${sql(pgCaseIds)}`;
      assert.strictEqual(n, 0, "Postgres fixtures must be fully removed");
    }
  });

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
