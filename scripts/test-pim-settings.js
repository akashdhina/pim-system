/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Batch 4 (Phase 6) focused tests for lib/pim-data/settings.js.
 *
 * Unlike users, PostgreSQL system_settings already has real data (seeded
 * in Phase 2, verified identical to SQLite's 3 stored rows at the time of
 * this batch's audit - see the Batch 4 report), so these tests run against
 * the real, already-synced table - no throwaway fixture is needed or
 * created here.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${error instanceof Error ? error.message : error}`);
    failures.push(name);
  }
}

function skip(name, reason) {
  console.log(`SKIP: ${name} (${reason})`);
}

async function testPermissionCheckStillFirst() {
  await test(
    "permission enforcement: GET /api/pim/settings still calls requirePermission(VIEW_SETTINGS) before any data access",
    () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, "app/api/pim/settings/route.js"), "utf8");
      const getBody = source.match(/export async function GET\(request\) \{([\s\S]*?)\n\}/)[1];
      assert.ok(getBody.indexOf('requirePermission(request, "VIEW_SETTINGS")') < getBody.indexOf("getSettingsPg("));
    }
  );
}

async function runConnectionDependentTests() {
  const { getSql } = require("../lib/pim-postgres");
  const { getSettings } = require("../lib/pim-data/settings");
  const { DEFAULT_SETTINGS } = require("../lib/pim-settings");
  const sql = getSql();

  try {
    await test("PostgreSQL connection works (settings module)", async () => {
      const [{ ok }] = await sql`SELECT 1 AS ok`;
      assert.strictEqual(ok, 1);
    });

    await test("settings read: getSettings() returns every DEFAULT_SETTINGS key", async () => {
      const settings = await getSettings();
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        assert.ok(Object.prototype.hasOwnProperty.call(settings, key), `missing key: ${key}`);
      }
    });

    await test("expected keys/values: stored PostgreSQL rows override defaults via the legacy-key fallback (pim_number_prefix -> PIM_NUMBER_PREFIX)", async () => {
      const settings = await getSettings();
      // PIM_NUMBER_PREFIX is the legacy-cased key actually stored (seeded
      // in Phase 2) - getSettings() must resolve it through LEGACY_KEYS to
      // populate the lowercase pim_number_prefix default key, exactly as
      // the SQLite version does.
      assert.strictEqual(settings.pim_number_prefix, "PIM");
    });

    await test("NULL/unset behavior: a key with no stored row falls back to its DEFAULT_SETTINGS value, not null/undefined", async () => {
      const settings = await getSettings();
      // authority_name has never been stored in system_settings (only the
      // 3 legacy keys are) - must resolve to its DEFAULT_SETTINGS value.
      assert.strictEqual(settings.authority_name, DEFAULT_SETTINGS.authority_name);
      assert.notStrictEqual(settings.authority_name, null);
      assert.notStrictEqual(settings.authority_name, undefined);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  await testPermissionCheckStillFirst();

  if (!process.env.SUPABASE_DB_URL) {
    for (const name of [
      "PostgreSQL connection works (settings module)",
      "settings read: getSettings() returns every DEFAULT_SETTINGS key",
      "expected keys/values: stored PostgreSQL rows override defaults via the legacy-key fallback (pim_number_prefix -> PIM_NUMBER_PREFIX)",
      "NULL/unset behavior: a key with no stored row falls back to its DEFAULT_SETTINGS value, not null/undefined",
    ]) {
      skip(name, "SUPABASE_DB_URL not set in this environment");
    }
  } else {
    await runConnectionDependentTests();
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error("Test run crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
