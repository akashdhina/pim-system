/* eslint-disable @typescript-eslint/no-require-imports */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client = null;

/*
 * Server-side Supabase client for the PIM Postgres project.
 * Uses the anon key only - no privileged/service-role operations
 * exist yet. This file must never be imported from a "use client"
 * component; API routes and server modules only.
 */
function getSupabaseServerClient() {
  if (client) return client;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return client;
}

module.exports = {
  getSupabaseServerClient,
};
