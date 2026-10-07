/* eslint-disable @typescript-eslint/no-require-imports */

const { getSupabaseServerClient } = require("./supabase-server");
const { getSupabaseServiceRoleClient } = require("./supabase-service");
const { can, permissionSummary } = require("./pim-auth");

/*
 * Phase 3 infrastructure only: NOT wired into any route yet. The existing
 * cookie/pim_user_sessions system in lib/pim-auth.js remains the live auth
 * path. This module exists so it can be tested in isolation and adopted by
 * routes in a later phase, per instructions ("do not rewrite every route
 * yet").
 *
 * Target flow this module implements:
 *   Supabase Auth access token -> auth.users row -> pim_profiles row
 *   -> normalized PIM identity (same shape lib/pim-auth.js's sanitizeUser
 *      produces) -> lib/pim-auth.js's existing can()/PERMISSIONS map.
 *
 * No permission logic is duplicated here: role -> allowed-permissions
 * stays defined exactly once, in lib/pim-auth.js.
 */

async function resolveSupabaseAuthUser(accessToken) {
  if (!accessToken) return null;

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser(accessToken);

  if (error || !data?.user) return null;

  return data.user;
}

async function getPimProfile(userId) {
  if (!userId) return null;

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from("pim_profiles")
    .select(
      "user_id, role_code, display_name, designation, active, legacy_username, legacy_user_id"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to resolve pim_profiles row: ${error.message}`);
  }

  return data || null;
}

function sanitizePimIdentity(authUser, profile) {
  return {
    id: profile.user_id,
    role: profile.role_code,
    role_code: profile.role_code,
    display_name: profile.display_name,
    designation: profile.designation,
    active: profile.active,
    email: authUser.email || null,
    legacy_username: profile.legacy_username,
    legacy_user_id: profile.legacy_user_id,
  };
}

/*
 * Resolves a Supabase Auth access token all the way to a PIM identity, or
 * null if the token is invalid, the user has no pim_profiles row, or the
 * profile is inactive. Mirrors lib/pim-auth.js's getCurrentUser() return
 * shape closely enough that can(identity, permission) works unchanged.
 */
async function resolvePimIdentity(accessToken) {
  const authUser = await resolveSupabaseAuthUser(accessToken);
  if (!authUser) return null;

  const profile = await getPimProfile(authUser.id);
  if (!profile) return null;
  if (!profile.active) return null;

  return sanitizePimIdentity(authUser, profile);
}

function canPim(identity, permission) {
  return can(identity, permission);
}

module.exports = {
  resolveSupabaseAuthUser,
  getPimProfile,
  resolvePimIdentity,
  canPim,
  permissionSummary,
};
