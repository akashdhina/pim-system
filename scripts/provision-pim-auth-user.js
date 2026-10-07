/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Provisions ONE Supabase Auth user + matching pim_profiles row for an
 * existing legacy SQLite `users` account, and sends that person a real
 * Supabase invite email so they set their own password.
 *
 * Deliberately NOT automatic and NOT bulk: the legacy `users` table has no
 * email column (verified - it only has username/display_name/designation/
 * role_code/password_hash/etc.), so there is no safe source for the email
 * address each of the 6 real accounts needs in Supabase Auth. This script
 * never fabricates one and never sets a password - Supabase's own invite
 * flow issues the credential.
 *
 * Usage:
 *   node scripts/provision-pim-auth-user.js <legacy-username> <real-email>
 *
 * Requires (server-only, never commit):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const db = require("../lib/db");
const { getSupabaseServiceRoleClient } = require("../lib/supabase-service");

const legacyUsername = String(process.argv[2] || "").trim().toLowerCase();
const email = String(process.argv[3] || "").trim().toLowerCase();

if (!legacyUsername || !email) {
  console.error(
    "Usage: node scripts/provision-pim-auth-user.js <legacy-username> <real-email>"
  );
  process.exit(1);
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("That does not look like a valid email address.");
  process.exit(1);
}

async function main() {
  const legacyUser = db
    .prepare(
      `SELECT id, username, display_name, designation, role_code, active
       FROM users
       WHERE lower(username) = ?`
    )
    .get(legacyUsername);

  if (!legacyUser) {
    console.error(`No legacy user found for username "${legacyUsername}".`);
    process.exit(1);
  }

  if (!legacyUser.role_code) {
    console.error(
      `Legacy user "${legacyUsername}" has no role_code set - resolve that in SQLite first; pim_profiles.role_code is NOT NULL by design.`
    );
    process.exit(1);
  }

  const supabase = getSupabaseServiceRoleClient();

  const { data: existingProfiles, error: lookupError } = await supabase
    .from("pim_profiles")
    .select("user_id, legacy_username")
    .eq("legacy_username", legacyUser.username);

  if (lookupError) {
    console.error(`Failed to check for an existing profile: ${lookupError.message}`);
    process.exit(1);
  }

  if (existingProfiles && existingProfiles.length > 0) {
    console.error(
      `"${legacyUser.username}" is already provisioned (auth user_id ${existingProfiles[0].user_id}). Refusing to create a duplicate.`
    );
    process.exit(1);
  }

  const { data: inviteData, error: inviteError } =
    await supabase.auth.admin.inviteUserByEmail(email, {
      data: {
        legacy_username: legacyUser.username,
        display_name: legacyUser.display_name,
      },
    });

  if (inviteError || !inviteData?.user) {
    console.error(`Failed to invite ${email}: ${inviteError?.message || "unknown error"}`);
    process.exit(1);
  }

  const authUserId = inviteData.user.id;

  const { error: profileError } = await supabase.from("pim_profiles").insert({
    user_id: authUserId,
    role_code: legacyUser.role_code,
    display_name: legacyUser.display_name,
    designation: legacyUser.designation,
    active: Boolean(legacyUser.active),
    legacy_username: legacyUser.username,
    legacy_user_id: legacyUser.id,
  });

  if (profileError) {
    console.error(
      `Auth user was created (id ${authUserId}) but the pim_profiles insert failed: ${profileError.message}`
    );
    console.error(
      "Fix the pim_profiles row manually or delete the orphaned auth user before retrying."
    );
    process.exit(1);
  }

  console.log(`Invited ${email} as Supabase Auth user ${authUserId}.`);
  console.log(
    `pim_profiles created: role_code=${legacyUser.role_code}, legacy_username=${legacyUser.username}.`
  );
  console.log("The invite email lets them set their own password - none was set here.");
}

main().catch((error) => {
  console.error("Provisioning failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
