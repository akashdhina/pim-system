/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase 3 focused tests for the Supabase Auth + pim_profiles resolver.
 * Follows this repo's existing plain-script + assert() convention (see
 * scripts/test-auth-lan-http.js) rather than introducing a test framework.
 *
 * Tests 9 and 10 need no Supabase credentials and always run.
 * Tests 1-8 need SUPABASE_SERVICE_ROLE_KEY (server-only; get it from the
 * Supabase dashboard, never commit it) to create/sign in/clean up a
 * throwaway auth user. If it is not set, those tests are SKIPPED and
 * clearly reported as such - never silently treated as passing.
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const db = require("../lib/db");
const { getCurrentUser } = require("../lib/pim-auth");

const REPO_ROOT = path.join(__dirname, "..");

let passed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${error instanceof Error ? error.message : error}`);
    failures.push(name);
  }
}

async function asyncTest(name, fn) {
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
  skipped += 1;
}

// ---------------------------------------------------------------------
// Test 9: development backdoor cannot operate in production.
// ---------------------------------------------------------------------

function devHeaderRequest(userId) {
  return new Request("http://localhost:3000/api/pim/auth/me", {
    headers: { "x-pim-user-id": String(userId) },
  });
}

test("9. dev backdoor (via getCurrentUser, no session cookie) is inert when NODE_ENV=production", () => {
  const activeUser = db
    .prepare(`SELECT id FROM users WHERE active = 1 LIMIT 1`)
    .get();
  assert.ok(activeUser, "fixture requires at least one active legacy user");

  const previousNodeEnv = process.env.NODE_ENV;
  try {
    // getDevelopmentUser() itself is not exported (intentionally internal
    // to lib/pim-auth.js) - exercised the same way the app does, through
    // getCurrentUser() with no session cookie so it falls through to the
    // backdoor path.
    process.env.NODE_ENV = "development";
    const devResolved = getCurrentUser(devHeaderRequest(activeUser.id));
    assert.ok(
      devResolved,
      "sanity check: the backdoor should resolve a real user outside production"
    );

    process.env.NODE_ENV = "production";
    const prodResolved = getCurrentUser(devHeaderRequest(activeUser.id));
    assert.strictEqual(
      prodResolved,
      null,
      "getCurrentUser() must not honor x-pim-user-id when NODE_ENV=production"
    );
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

// ---------------------------------------------------------------------
// Test 10: service-role credentials never reach client code or responses.
// ---------------------------------------------------------------------

const ALLOWED_SERVICE_ROLE_REFERENCES = new Set(
  [
    ".env.local",
    "lib/supabase-service.js",
    "scripts/provision-pim-auth-user.js",
    "scripts/test-supabase-auth.js",
    "scripts/test-pim-rls.js",
    "scripts/test-pim-intake-postgres.js",
    "docs/phase6-migration-design.md",
  ].map((p) => path.join(REPO_ROOT, p))
);

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "backups",
  "storage",
  "documents",
  "logs",
]);

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.local") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

test("10a. SUPABASE_SERVICE_ROLE_KEY only appears in server-only files", () => {
  const offenders = [];
  walk(REPO_ROOT, (file) => {
    if (!/\.(js|jsx|ts|tsx|env\.local|md)$/i.test(file) && !file.endsWith(".env.local")) {
      return;
    }
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    if (text.includes("SUPABASE_SERVICE_ROLE_KEY") && !ALLOWED_SERVICE_ROLE_REFERENCES.has(file)) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  });
  assert.deepStrictEqual(
    offenders,
    [],
    `unexpected references to SUPABASE_SERVICE_ROLE_KEY: ${offenders.join(", ")}`
  );
});

test("10b. no NEXT_PUBLIC_* env var name embeds the service-role key", () => {
  const envPath = path.join(REPO_ROOT, ".env.local");
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const offendingLines = text
    .split("\n")
    .filter((line) => /^NEXT_PUBLIC_.*SERVICE_ROLE/i.test(line.trim()));
  assert.deepStrictEqual(offendingLines, []);
});

test("10c. no \"use client\" file imports the service-role client", () => {
  const offenders = [];
  const appDir = path.join(REPO_ROOT, "app");
  if (fs.existsSync(appDir)) {
    walk(appDir, (file) => {
      if (!/\.(jsx?|tsx?)$/.test(file)) return;
      const text = fs.readFileSync(file, "utf8");
      const isClientFile = /^\s*["']use client["'];?/.test(text);
      if (isClientFile && /supabase-service/.test(text)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    });
  }
  assert.deepStrictEqual(offenders, []);
});

// ---------------------------------------------------------------------
// Tests 1-8: require SUPABASE_SERVICE_ROLE_KEY to create/sign in/clean up
// a throwaway Supabase Auth user against the real pim-system project.
// ---------------------------------------------------------------------

async function runCredentialDependentTests() {
  const { getSupabaseServiceRoleClient } = require("../lib/supabase-service");
  const { getSupabaseServerClient } = require("../lib/supabase-server");
  const {
    resolveSupabaseAuthUser,
    resolvePimIdentity,
    canPim,
  } = require("../lib/pim-supabase-auth");

  const admin = getSupabaseServiceRoleClient();
  const anon = getSupabaseServerClient();

  const testEmail = `pim-phase3-test-${Date.now()}@example.invalid`;
  const testPassword = crypto.randomBytes(24).toString("base64url");

  let authUserId = null;
  let accessToken = null;

  try {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    });
    if (createError) throw new Error(`fixture setup failed: ${createError.message}`);
    authUserId = created.user.id;

    const { data: signedIn, error: signInError } = await anon.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    if (signInError) throw new Error(`fixture sign-in failed: ${signInError.message}`);
    accessToken = signedIn.session.access_token;

    await asyncTest("1. Supabase Auth user resolves server-side from a valid access token", async () => {
      const resolved = await resolveSupabaseAuthUser(accessToken);
      assert.ok(resolved, "expected a resolved auth user");
      assert.strictEqual(resolved.id, authUserId);
    });

    await asyncTest("7. user without a pim_profiles record is denied", async () => {
      const identity = await resolvePimIdentity(accessToken);
      assert.strictEqual(identity, null);
    });

    async function setProfile(fields) {
      const { error } = await admin.from("pim_profiles").upsert({
        user_id: authUserId,
        display_name: "Phase 3 Test User",
        designation: "Automated Test",
        active: true,
        ...fields,
      });
      if (error) throw new Error(`test fixture profile upsert failed: ${error.message}`);
    }

    await setProfile({ role_code: "aa" });
    await asyncTest("2. role_code='aa' resolves as PIM AA operator", async () => {
      const identity = await resolvePimIdentity(accessToken);
      assert.ok(identity);
      assert.strictEqual(identity.role, "aa");
    });
    test("8a. permission mapping holds for aa (ENTER_APPLICATION yes / MANAGE_USERS no)", () => {
      const identity = { role: "aa" };
      assert.strictEqual(canPim(identity, "ENTER_APPLICATION"), true);
      assert.strictEqual(canPim(identity, "MANAGE_USERS"), false);
    });

    await setProfile({ role_code: "secretary" });
    await asyncTest("3. role_code='secretary' resolves correctly", async () => {
      const identity = await resolvePimIdentity(accessToken);
      assert.ok(identity);
      assert.strictEqual(identity.role, "secretary");
    });
    test("8b. permission mapping holds for secretary (APPROVE_REGISTRATION yes / MANAGE_USERS no)", () => {
      const identity = { role: "secretary" };
      assert.strictEqual(canPim(identity, "APPROVE_REGISTRATION"), true);
      assert.strictEqual(canPim(identity, "MANAGE_USERS"), false);
    });

    await setProfile({ role_code: "chairman" });
    await asyncTest("4. role_code='chairman' resolves correctly", async () => {
      const identity = await resolvePimIdentity(accessToken);
      assert.ok(identity);
      assert.strictEqual(identity.role, "chairman");
    });
    test("8c. permission mapping holds for chairman (APPROVE_NONSTARTER_AUTHORITY yes / ENTER_APPLICATION no)", () => {
      const identity = { role: "chairman" };
      assert.strictEqual(canPim(identity, "APPROVE_NONSTARTER_AUTHORITY"), true);
      assert.strictEqual(canPim(identity, "ENTER_APPLICATION"), false);
    });

    await setProfile({ role_code: "admin" });
    await asyncTest("5. role_code='admin' resolves correctly", async () => {
      const identity = await resolvePimIdentity(accessToken);
      assert.ok(identity);
      assert.strictEqual(identity.role, "admin");
    });
    test("8d. permission mapping holds for admin (MANAGE_USERS yes / MANAGE_SETTINGS yes)", () => {
      const identity = { role: "admin" };
      assert.strictEqual(canPim(identity, "MANAGE_USERS"), true);
      assert.strictEqual(canPim(identity, "MANAGE_SETTINGS"), true);
    });

    await setProfile({ role_code: "admin", active: false });
    await asyncTest("6. inactive profile is denied even with a valid token", async () => {
      const identity = await resolvePimIdentity(accessToken);
      assert.strictEqual(identity, null);
    });
  } finally {
    if (authUserId) {
      const { error: deleteError } = await admin.auth.admin.deleteUser(authUserId);
      if (deleteError) {
        console.error(
          `WARNING: failed to clean up test auth user ${authUserId}: ${deleteError.message}`
        );
        console.error(
          "Delete it manually from the Supabase dashboard (Authentication > Users)."
        );
      }
    }
  }
}

async function main() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    for (const name of [
      "1. Supabase Auth user resolves server-side from a valid access token",
      "2. role_code='aa' resolves as PIM AA operator",
      "3. role_code='secretary' resolves correctly",
      "4. role_code='chairman' resolves correctly",
      "5. role_code='admin' resolves correctly",
      "6. inactive profile is denied even with a valid token",
      "7. user without a pim_profiles record is denied",
      "8. existing permission checks still map correctly",
    ]) {
      skip(name, "SUPABASE_SERVICE_ROLE_KEY not set in this environment");
    }
  } else {
    await runCredentialDependentTests();
  }

  console.log(`\n${passed} passed, ${failures.length} failed, ${skipped} skipped.`);
  if (failures.length) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Test run crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
