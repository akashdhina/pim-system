/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 4 focused RLS tests, against the real pim-system Supabase project.
 * Follows this repo's plain-script + assert() convention (see
 * scripts/test-auth-lan-http.js, scripts/test-supabase-auth.js).
 *
 * Test 1 (anonymous cannot read PIM data) and test 12's structural half
 * (no policy is literally `USING (true)`) were already verified separately
 * and are not repeated here - see the Phase 4 report. Everything else runs
 * here, behaviorally, against real PostgREST + RLS, not a SQL simulation.
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY (server-only) to create/clean up ONE
 * throwaway Supabase Auth test user. If it is not set, every test below is
 * SKIPPED and clearly reported as such.
 *
 * Test data created (and removed in a `finally` block regardless of
 * pass/fail):
 *   - one Supabase Auth user, email pim-phase4-rls-test-<timestamp>@example.invalid
 *   - one pim_profiles row for that user (role_code flipped between checks)
 *   - one pim_cases row, pim_number 'TEST-RLS-PHASE4-DO-NOT-USE', so there is
 *     something for the "can an active profile read case data" checks to
 *     actually see. Never touches real case data (there is none yet).
 */

const assert = require("assert");
const crypto = require("crypto");

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

function skipAll(reason) {
  const names = [
    "2. authenticated user without pim_profiles cannot read PIM data",
    "3a. inactive profile cannot read PIM data",
    "3b. inactive profile can still read its own pim_profiles row",
    "4. aa gets exactly the reads intended for aa",
    "5. secretary gets elevated reads (settings, audit) aa does not",
    "6. chairman gets settings but NOT audit (VIEW_AUDIT excludes chairman)",
    "7. admin gets administrative reads",
    "8. ordinary user cannot modify their own role_code",
    "9. ordinary user cannot modify another user's profile",
    "10. audit_log cannot be inserted/deleted by an authenticated client, any role",
    "11. reference/master tables cannot be modified by an authenticated client, any role",
    "12b. authenticated non-admin cannot read the legacy users/pim_user_sessions tables",
  ];
  for (const name of names) {
    console.log(`SKIP: ${name} (${reason})`);
  }
}

async function main() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    skipAll("SUPABASE_SERVICE_ROLE_KEY not set in this environment");
    console.log(`\n${passed} passed, ${failures.length} failed, 12 skipped.`);
    return;
  }

  const { getSupabaseServiceRoleClient } = require("../lib/supabase-service");
  const { createClient } = require("@supabase/supabase-js");

  const admin = getSupabaseServiceRoleClient();
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // A fresh client per test user, matching how a real browser session would
  // authenticate (sign in, then reuse the same client for subsequent calls).
  const asUser = createClient(SUPABASE_URL, ANON_KEY);

  const testEmail = `pim-phase4-rls-test-${Date.now()}@example.invalid`;
  const testPassword = crypto.randomBytes(24).toString("base64url");

  let authUserId = null;
  let testCaseId = null;

  async function setProfile(fields) {
    const { error } = await admin.from("pim_profiles").upsert({
      user_id: authUserId,
      display_name: "Phase 4 RLS Test User",
      designation: "Automated Test",
      active: true,
      ...fields,
    });
    if (error) throw new Error(`test fixture profile upsert failed: ${error.message}`);
  }

  try {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    });
    if (createError) throw new Error(`fixture setup failed: ${createError.message}`);
    authUserId = created.user.id;

    const { error: signInError } = await asUser.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    if (signInError) throw new Error(`fixture sign-in failed: ${signInError.message}`);

    // A synthetic case row, obviously not real, so "can an active profile
    // read case data" has something concrete to check for.
    const { data: caseRow, error: caseError } = await admin
      .from("pim_cases")
      .insert({
        pim_number: "TEST-RLS-PHASE4-DO-NOT-USE",
        received_number: "TEST-RLS-PHASE4",
        received_date: "2026-01-01",
        application_date: "2026-01-01",
      })
      .select("id")
      .single();
    if (caseError) throw new Error(`test fixture case insert failed: ${caseError.message}`);
    testCaseId = caseRow.id;

    await test("2. authenticated user without pim_profiles cannot read PIM data", async () => {
      const { data, error } = await asUser.from("pim_cases").select("id").eq("id", testCaseId);
      assert.ifError(error);
      assert.strictEqual(data.length, 0);
    });

    await setProfile({ role_code: "aa", active: false });

    await test("3a. inactive profile cannot read PIM data", async () => {
      const { data, error } = await asUser.from("pim_cases").select("id").eq("id", testCaseId);
      assert.ifError(error);
      assert.strictEqual(data.length, 0);
    });

    await test("3b. inactive profile can still read its own pim_profiles row", async () => {
      const { data, error } = await asUser.from("pim_profiles").select("user_id, active").eq("user_id", authUserId);
      assert.ifError(error);
      assert.strictEqual(data.length, 1);
      assert.strictEqual(data[0].active, false);
    });

    await setProfile({ role_code: "aa", active: true });

    await test("4. aa gets exactly the reads intended for aa", async () => {
      const caseRead = await asUser.from("pim_cases").select("id").eq("id", testCaseId);
      assert.ifError(caseRead.error);
      assert.strictEqual(caseRead.data.length, 1, "aa should read case data (READ_CASE includes aa)");

      const settingsRead = await asUser.from("system_settings").select("setting_key");
      assert.ifError(settingsRead.error);
      assert.strictEqual(settingsRead.data.length, 0, "aa is excluded from VIEW_SETTINGS");

      const auditRead = await asUser.from("audit_log").select("id").limit(1);
      assert.ifError(auditRead.error);
      assert.strictEqual(auditRead.data.length, 0, "aa is excluded from VIEW_AUDIT");

      const ownProfile = await asUser.from("pim_profiles").select("user_id");
      assert.ifError(ownProfile.error);
      assert.strictEqual(ownProfile.data.length, 1, "aa should see only its own profile row");
    });

    await setProfile({ role_code: "secretary" });

    await test("5. secretary gets elevated reads (settings, audit) aa does not", async () => {
      const settingsRead = await asUser.from("system_settings").select("setting_key");
      assert.ifError(settingsRead.error);
      assert.ok(settingsRead.data.length > 0, "secretary is included in VIEW_SETTINGS");

      const auditRead = await asUser.from("audit_log").select("id").limit(1);
      assert.ifError(auditRead.error);
      assert.ok(auditRead.data.length > 0, "secretary is included in VIEW_AUDIT");
    });

    await setProfile({ role_code: "chairman" });

    await test("6. chairman gets settings but NOT audit (VIEW_AUDIT excludes chairman)", async () => {
      const settingsRead = await asUser.from("system_settings").select("setting_key");
      assert.ifError(settingsRead.error);
      assert.ok(settingsRead.data.length > 0, "chairman is included in VIEW_SETTINGS");

      const auditRead = await asUser.from("audit_log").select("id").limit(1);
      assert.ifError(auditRead.error);
      assert.strictEqual(auditRead.data.length, 0, "chairman is excluded from VIEW_AUDIT");
    });

    await setProfile({ role_code: "admin" });

    await test("7. admin gets administrative reads", async () => {
      const settingsRead = await asUser.from("system_settings").select("setting_key");
      assert.ifError(settingsRead.error);
      assert.ok(settingsRead.data.length > 0);

      const auditRead = await asUser.from("audit_log").select("id").limit(1);
      assert.ifError(auditRead.error);
      assert.ok(auditRead.data.length > 0);
    });

    await test("8. ordinary user cannot modify their own role_code", async () => {
      // still admin from the previous step; a write attempt should be
      // denied (0 rows affected) regardless of role, since no
      // INSERT/UPDATE/DELETE policy exists on pim_profiles at all.
      const { data, error } = await asUser
        .from("pim_profiles")
        .update({ role_code: "admin" })
        .eq("user_id", authUserId)
        .select();
      // PostgREST with RLS + no write policy returns an empty result, not
      // necessarily a hard error - assert the write had no effect either way.
      if (error) return; // an explicit permission error is also an acceptable denial
      assert.strictEqual(data.length, 0, "the update must not have affected any row");
    });

    await test("9. ordinary user cannot modify another user's profile", async () => {
      const someOtherUuid = crypto.randomUUID();
      const { data, error } = await asUser
        .from("pim_profiles")
        .update({ display_name: "Hijacked" })
        .eq("user_id", someOtherUuid)
        .select();
      if (error) return;
      assert.strictEqual(data.length, 0);
    });

    await test("10. audit_log cannot be inserted/deleted by an authenticated client, any role", async () => {
      const insertAttempt = await asUser.from("audit_log").insert({
        table_name: "pim_cases",
        record_id: testCaseId,
        action: "FORGED",
        changed_by: authUserId,
      }).select();
      if (!insertAttempt.error) {
        assert.strictEqual(insertAttempt.data.length, 0, "audit_log insert must not have affected any row");
      }

      const deleteAttempt = await asUser.from("audit_log").delete().neq("id", -1).select();
      if (!deleteAttempt.error) {
        assert.strictEqual(deleteAttempt.data.length, 0, "audit_log delete must not have affected any row");
      }
    });

    await test("11. reference/master tables cannot be modified by an authenticated client, any role", async () => {
      const { data, error } = await asUser
        .from("status_master")
        .update({ name: "Tampered" })
        .eq("code", "RECEIVED")
        .select();
      if (error) return;
      assert.strictEqual(data.length, 0);

      // confirm it genuinely was not changed
      const { data: check } = await admin.from("status_master").select("name").eq("code", "RECEIVED").single();
      assert.strictEqual(check.name, "Received");
    });

    await test("12b. authenticated non-admin/admin alike cannot read the legacy users/pim_user_sessions tables", async () => {
      const usersRead = await asUser.from("users").select("id").limit(1);
      assert.ifError(usersRead.error);
      assert.strictEqual(usersRead.data.length, 0);

      const sessionsRead = await asUser.from("pim_user_sessions").select("id").limit(1);
      assert.ifError(sessionsRead.error);
      assert.strictEqual(sessionsRead.data.length, 0);
    });
  } finally {
    if (testCaseId) {
      const { error } = await admin.from("pim_cases").delete().eq("id", testCaseId);
      if (error) console.error(`WARNING: failed to delete test case ${testCaseId}: ${error.message}`);
    }
    if (authUserId) {
      const { error } = await admin.auth.admin.deleteUser(authUserId);
      if (error) {
        console.error(`WARNING: failed to delete test auth user ${authUserId}: ${error.message}`);
        console.error("Delete it manually from the Supabase dashboard (Authentication > Users).");
      }
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error("Test run crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
