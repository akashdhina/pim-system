/* eslint-disable @typescript-eslint/no-require-imports */

const { createClient } = require("@supabase/supabase-js");

/*
 * SERVER-ONLY. This client uses the Supabase service-role key, which
 * bypasses Row Level Security entirely. It must NEVER be imported from a
 * "use client" component, NEVER referenced via a NEXT_PUBLIC_* env var,
 * and its key must never be echoed in an API response or log line.
 *
 * Used only for privileged operations Phase 3 genuinely needs:
 *   - resolving a caller's pim_profiles row (pim_profiles has RLS enabled
 *     with zero policies right now - see the Phase 3 migration - so an
 *     anon/authenticated client would get zero rows back, not the row it
 *     needs; Phase 4 will design real policies and this may narrow)
 *   - the provisioning script (scripts/provision-pim-auth-user.js), which
 *     creates Supabase Auth users and their pim_profiles row.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client = null;

function getSupabaseServiceRoleClient() {
  if (client) return client;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase service-role client is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-only - get it from the Supabase dashboard, never commit it)."
    );
  }

  client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return client;
}

module.exports = {
  getSupabaseServiceRoleClient,
};
