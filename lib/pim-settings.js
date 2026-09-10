/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("./db");

const DEFAULT_SETTINGS = {
  authority_name: "District Legal Services Authority, The Nilgiris",
  authority_short_name: "DLSA Nilgiris",
  authority_address_line_1: "ADR Building, Combined Court Buildings",
  authority_address_line_2: "Fingerpost, Udhagamandalam",
  district_name: "The Nilgiris",
  state_name: "Tamil Nadu",
  pin_code: "",
  phone: "",
  email: "",
  default_mediation_venue:
    "Office of this Authority, ADR Building, Combined Court Buildings, Fingerpost, Udhagamandalam",
  chairman_name: "Chairman",
  chairman_designation: "Chairman, DLSA",
  secretary_name: "Secretary",
  secretary_designation: "Secretary, DLSA",
  document_footer: "",
  pim_number_prefix: "PIM",
  received_number_prefix: "",
  timezone: "Asia/Kolkata",
  backup_retention_days: "0",
  backup_retention_count: "30",
};

const LEGACY_KEYS = {
  pim_number_prefix: "PIM_NUMBER_PREFIX",
};

const DESCRIPTIONS = {
  authority_name: "Full authority name for future documents and screens",
  authority_short_name: "Short authority name",
  authority_address_line_1: "Authority address line 1",
  authority_address_line_2: "Authority address line 2",
  district_name: "District name",
  state_name: "State name",
  pin_code: "Postal PIN code",
  phone: "Office phone",
  email: "Office email",
  default_mediation_venue: "Default mediation venue for future generated documents",
  chairman_name: "Chairman name",
  chairman_designation: "Chairman designation",
  secretary_name: "Secretary name",
  secretary_designation: "Secretary designation",
  document_footer: "Optional future document footer",
  pim_number_prefix: "Prefix used for PIM numbers",
  received_number_prefix: "Prefix used for received numbers",
  timezone: "Office timezone",
  backup_retention_days: "Delete successful backups older than this many days; 0 disables age retention",
  backup_retention_count: "Minimum/latest successful backups to retain",
};

function normalizeKey(key) {
  return String(key || "").trim();
}

function getSetting(key) {
  const normalized = normalizeKey(key);
  const row = db.prepare(`
    SELECT setting_value
    FROM system_settings
    WHERE setting_key = ?
  `).get(normalized);

  if (row) return row.setting_value;

  const legacyKey = LEGACY_KEYS[normalized];
  if (legacyKey) {
    const legacy = db.prepare(`
      SELECT setting_value
      FROM system_settings
      WHERE setting_key = ?
    `).get(legacyKey);

    if (legacy) return legacy.setting_value;
  }

  return DEFAULT_SETTINGS[normalized] ?? null;
}

function getSettings() {
  const rows = db.prepare(`
    SELECT setting_key, setting_value, description
    FROM system_settings
  `).all();
  const stored = Object.fromEntries(
    rows.map((row) => [row.setting_key, row.setting_value])
  );
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

function validateSettings(input) {
  const errors = {};
  const allowed = Object.keys(DEFAULT_SETTINGS);

  for (const key of Object.keys(input || {})) {
    if (!allowed.includes(key)) {
      errors[key] = "Unknown setting.";
    }
  }

  const email = input.email;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    errors.email = "Email address is not valid.";
  }

  const phone = input.phone;
  if (phone && !/^[0-9+\-\s()]{6,20}$/.test(String(phone))) {
    errors.phone = "Phone number is not valid.";
  }

  const pinCode = input.pin_code;
  if (pinCode && !/^[0-9]{6}$/.test(String(pinCode))) {
    errors.pin_code = "PIN code must be 6 digits.";
  }

  for (const key of ["backup_retention_days", "backup_retention_count"]) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < 0) {
      errors[key] = "Retention value must be a whole number.";
    }
  }

  if (
    input.backup_retention_count !== undefined &&
    Number(input.backup_retention_count) < 1
  ) {
    errors.backup_retention_count = "At least one backup must be retained.";
  }

  if (
    input.timezone &&
    String(input.timezone).trim() !== "Asia/Kolkata"
  ) {
    errors.timezone = "Only Asia/Kolkata is supported for this pilot.";
  }

  return errors;
}

function updateSettings(input, userId) {
  const errors = validateSettings(input);
  if (Object.keys(errors).length) {
    const error = new Error("Settings validation failed.");
    error.status = 400;
    error.details = errors;
    throw error;
  }

  const updates = Object.entries(input)
    .filter(([key]) => Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key))
    .map(([key, value]) => [key, String(value ?? "").trim()]);

  if (!updates.length) {
    const error = new Error("No settings were supplied.");
    error.status = 400;
    throw error;
  }

  const before = getSettings();

  const transaction = db.transaction(() => {
    for (const [key, value] of updates) {
      db.prepare(`
        INSERT INTO system_settings (
          setting_key,
          setting_value,
          description
        )
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
          setting_value = excluded.setting_value,
          description = excluded.description
      `).run(key, value, DESCRIPTIONS[key] || key);
    }

    db.prepare(`
      INSERT INTO audit_log (
        table_name,
        record_id,
        action,
        old_value,
        new_value,
        changed_by,
        reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "system_settings",
      0,
      "UPDATE",
      JSON.stringify(
        Object.fromEntries(updates.map(([key]) => [key, before[key]]))
      ),
      JSON.stringify(Object.fromEntries(updates)),
      userId || null,
      "Office settings updated."
    );
  });

  transaction();
  return getSettings();
}

module.exports = {
  DEFAULT_SETTINGS,
  getSetting,
  getSettings,
  updateSettings,
  validateSettings,
};
