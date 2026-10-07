/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL data-access for settings reads - Batch 4 (GET /api/pim/settings).
 * Read-only: updateSettings/validateSettings stay in lib/pim-settings.js
 * against SQLite, unchanged.
 *
 * DEFAULT_SETTINGS and LEGACY_KEYS are pure JS constants with no DB
 * dependency - reused directly from lib/pim-settings.js rather than
 * duplicated, so there is exactly one source of truth for default values,
 * descriptions, and the legacy-key fallback (e.g. pim_number_prefix ->
 * PIM_NUMBER_PREFIX) both backends share.
 */

const { getSql } = require("../pim-postgres");
const { DEFAULT_SETTINGS } = require("../pim-settings");

const LEGACY_KEYS = {
  pim_number_prefix: "PIM_NUMBER_PREFIX",
};

async function getSettings() {
  const sql = getSql();
  const rows = await sql`SELECT setting_key, setting_value, description FROM system_settings`;
  const stored = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  const settings = { ...DEFAULT_SETTINGS };

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (stored[key] !== undefined) {
      settings[key] = stored[key];
    } else if (LEGACY_KEYS[key] && stored[LEGACY_KEYS[key]] !== undefined) {
      settings[key] = stored[LEGACY_KEYS[key]];
    }
  }

  return settings;
}

module.exports = {
  getSettings,
};
