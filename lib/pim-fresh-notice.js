/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Shared helper for creating a brand-new Initial Form-2 notice
 * (case_id/address_id pair never reused from an existing row).
 *
 * This is intentionally separate from the document "regenerate"
 * mechanism (lib/pim-document.js) - a fresh notice after an
 * address correction is a new pim_notices row with its own
 * future document and service attempt, not a new version of an
 * existing document attached to the old notice.
 */

const db = require("./db");
const { addDays } = require("./pim-time");

const FRESH_NOTICE_APPEARANCE_WINDOW_DAYS = 10;

function assertAppearanceDateWithinWindow(noticeDate, appearanceDate) {
  const maxAppearanceDate = addDays(
    noticeDate,
    FRESH_NOTICE_APPEARANCE_WINDOW_DAYS
  );

  if (appearanceDate > maxAppearanceDate) {
    throw new Error(
      `Appearance date for a fresh Initial Form-2 notice cannot be more than ${FRESH_NOTICE_APPEARANCE_WINDOW_DAYS} days after the notice date (${noticeDate}).`
    );
  }
}

/*
 * dbClient defaults to the module-level SQLite singleton (unchanged
 * behavior for every existing caller). See
 * docs/phase6-batch5b-helper-inventory.md - this function never opens
 * its own transaction, it is always called from inside the caller's
 * open db.transaction(...).
 */
function assertNoActiveNoticeForParty(caseId, recipientPartyId, noticeType, dbClient = db) {
  const existing = dbClient
    .prepare(`
      SELECT id
      FROM pim_notices
      WHERE case_id = ?
        AND recipient_party_id = ?
        AND notice_type = ?
        AND status IN ('PREPARED', 'SIGNED', 'DISPATCHED')
      LIMIT 1
    `)
    .get(caseId, recipientPartyId, noticeType);

  if (existing) {
    throw new Error(
      "An active Form-2 notice for this opposite party already exists."
    );
  }
}

const VALID_NOTICE_TYPES = new Set(["FORM_2_INITIAL", "FORM_2_FINAL"]);

/*
 * Creates a fresh Form-2 notice row (Initial or Final). Must be
 * called inside the caller's db.transaction().
 *
 * This is the single place that inserts a brand-new pim_notices
 * row for both the Phase 2 "fresh Initial notice after address
 * correction" flow and the Phase 3 Final Notice flow - it never
 * reuses or overwrites an existing notice row.
 *
 * dbClient defaults to the module-level SQLite singleton (unchanged
 * behavior for every existing caller); pass the same client the
 * surrounding transaction is using to keep this insert part of it.
 */
function createFreshNotice({
  caseId,
  recipientPartyId,
  addressId,
  noticeType,
  noticeDate,
  appearanceDate,
  appearanceTime,
  preparedBy = null,
  remarks = null,
}, dbClient = db) {
  if (!caseId || !recipientPartyId || !addressId) {
    throw new Error(
      "caseId, recipientPartyId and addressId are required to create a fresh notice."
    );
  }

  if (!VALID_NOTICE_TYPES.has(noticeType)) {
    throw new Error(`Invalid notice type for a fresh notice: ${noticeType}`);
  }

  if (!noticeDate) {
    throw new Error("noticeDate is required to create a fresh notice.");
  }

  if (!appearanceDate) {
    throw new Error("Appearance date is required for the fresh notice.");
  }

  if (!appearanceTime) {
    throw new Error("Appearance time is required for the fresh notice.");
  }

  assertAppearanceDateWithinWindow(noticeDate, appearanceDate);
  assertNoActiveNoticeForParty(caseId, recipientPartyId, noticeType, dbClient);

  const result = dbClient
    .prepare(`
      INSERT INTO pim_notices
      (
        case_id,
        notice_type,
        form_no,
        notice_date,
        appearance_date,
        appearance_time,
        recipient_party_id,
        address_id,
        prepared_by,
        status,
        remarks
      )
      VALUES (?, ?, 'FORM-2', ?, ?, ?, ?, ?, ?, 'PREPARED', ?)
    `)
    .run(
      caseId,
      noticeType,
      noticeDate,
      appearanceDate,
      appearanceTime,
      recipientPartyId,
      addressId,
      preparedBy,
      remarks
    );

  return Number(result.lastInsertRowid);
}

/*
 * Backwards-compatible wrapper for the Phase 2 call site.
 */
function createFreshInitialNotice(options, dbClient = db) {
  return createFreshNotice(
    {
      ...options,
      noticeType: "FORM_2_INITIAL",
    },
    dbClient
  );
}

module.exports = {
  FRESH_NOTICE_APPEARANCE_WINDOW_DAYS,
  createFreshNotice,
  createFreshInitialNotice,
};
