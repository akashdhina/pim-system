/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5H-b's PIM-number allocator -
 * the staff-operated replacement for T3 (lib/pim-approval.js's
 * approvePimRegistration/generatePimNumber). See
 * docs/phase6-batch5h-b-pim-numbering.md.
 *
 * generatePimNumber()'s MAX+1-over-LIKE-scan is replaced by an atomic
 * PostgreSQL row-state table (pim_number_sequences: one row per year,
 * last_number is the sole authoritative allocation state - the last
 * number already consumed, never the next number to issue).
 *
 * Same-case concurrency (not just different-case concurrency) is the
 * property this module is built around: the case row is locked with
 * SELECT ... FOR UPDATE BEFORE the sequence table is ever touched, so two
 * concurrent requests for the SAME case serialize there - the loser only
 * proceeds after the winner commits, sees pim_number already set, and
 * fails on the ordinary business guard without ever reaching the
 * sequence UPDATE. Two DIFFERENT cases lock different rows and instead
 * race for the same year's sequence row, which UPDATE ... SET
 * last_number = last_number + 1 ... RETURNING serializes atomically
 * under PostgreSQL's own MVCC row-level locking - the same "guarded
 * UPDATE" property lib/pim-data/scrutiny.js's task-completion guard
 * already relies on.
 *
 * Entirely PostgreSQL-only, like every other Phase 6 mutation: no SQLite
 * read or write anywhere in this file. T3's SQLite original is left
 * completely unchanged as a historical/rollback reference - restoring it
 * would reintroduce the retired Secretary/Judge workflow model, which is
 * not a state this migration should make easy to fall back into by
 * accident.
 */

const { withTransaction, getSql } = require("../pim-postgres");
const { officeDate, officeYear, addDays } = require("../pim-time");
const {
  getStatusId,
  addStatusHistory,
  addDocket,
  createPendingTaskIfNotExists,
} = require("./workflow-helpers");

const DEFAULT_PREFIX = "PIM";
const DEFAULT_INTERNAL_TARGET_DAYS = 60;

/*
 * Confirmed official format (Phase 6 Batch 5H-b business-rule update):
 * PIM/{running_number}/{year}, no zero-padding. NOT the legacy
 * generatePimNumber() format (PIM/{year}/{padded number}).
 */
function formatPimNumber(prefix, number, year) {
  return `${prefix}/${number}/${year}`;
}

async function getPrefix(client) {
  const [row] = await client`
    SELECT setting_value FROM system_settings WHERE setting_key = 'PIM_NUMBER_PREFIX'
  `;
  return row ? row.setting_value : DEFAULT_PREFIX;
}

async function getInternalTargetDays(client) {
  const [row] = await client`
    SELECT setting_value FROM system_settings WHERE setting_key = 'INTERNAL_NONSTARTER_TARGET_DAYS'
  `;
  const parsed = Number(row ? row.setting_value : DEFAULT_INTERNAL_TARGET_DAYS);
  return Number.isFinite(parsed) ? parsed : DEFAULT_INTERNAL_TARGET_DAYS;
}

/*
 * Read-only. Never increments last_number - previewing the next number
 * must never reserve it. Returns initialized: false (not an error) when
 * the year has no sequence row yet, so callers can tell "not initialized"
 * apart from "next is 1".
 */
async function previewNextPimNumber(year) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) {
    throw new Error("Valid year is required.");
  }

  const sql = getSql();
  const [row] = await sql`
    SELECT last_number FROM pim_number_sequences WHERE year = ${numericYear}
  `;

  if (!row) {
    return { year: numericYear, initialized: false, lastNumber: null, nextNumber: null, preview: null };
  }

  const prefix = await getPrefix(sql);
  const nextNumber = row.last_number + 1;

  return {
    year: numericYear,
    initialized: true,
    lastNumber: row.last_number,
    nextNumber,
    preview: formatPimNumber(prefix, nextNumber, numericYear),
  };
}

/*
 * Opens (or mid-year-onboards) a year's sequence. Deliberately a plain
 * INSERT with no ON CONFLICT clause: the year's primary key means a
 * second initialization attempt fails with a unique-violation, mapped to
 * a clear business error rather than silently overwriting an
 * already-initialized year's last_number - initialization is a one-time
 * event per year, not a routine "change the setting" action (a future,
 * separately-authorized correction feature is documented, not built,
 * here - see the Batch 5H-b design report).
 */
async function initializePimSequencePg(year, lastNumber, userId) {
  const numericYear = Number(year);
  const numericLastNumber = Number(lastNumber);

  if (!Number.isInteger(numericYear)) {
    throw new Error("Valid year is required.");
  }
  if (!Number.isInteger(numericLastNumber) || numericLastNumber < 0) {
    throw new Error("last_number must be a whole number, zero or greater.");
  }

  const sql = getSql();

  try {
    const [row] = await sql`
      INSERT INTO pim_number_sequences (year, last_number, initialized_by, initialized_at, updated_by, updated_at)
      VALUES (${numericYear}, ${numericLastNumber}, ${userId}, now(), ${userId}, now())
      RETURNING year, last_number, initialized_by, initialized_at
    `;
    return row;
  } catch (error) {
    if (error.code === "23505") {
      throw new Error(`The PIM-number sequence for year ${numericYear} is already initialized.`);
    }
    throw error;
  }
}

/*
 * The T3-replacement transaction body. `tx` MUST be a transaction-scoped
 * client (from withTransaction). Guard order: lock case row -> re-check
 * status/pim_number (AFTER the lock, not before - a check-then-lock
 * ordering would be a TOCTOU race) -> atomically consume the year's next
 * number -> write case/history/docket/task.
 */
/*
 * `year` defaults to the real current office year and should be omitted
 * in production code. It exists only so tests can exercise the full
 * assignment transaction against a disposable test year's sequence row
 * without ever touching the real current year's row - the same
 * "explicit override, defaults to the real thing" pattern already used
 * throughout this codebase's dbClient parameters, applied here to avoid
 * any test ever needing to initialize/mutate the actual production year.
 */
async function assignPimNumberTx(tx, caseId, userId, year = Number(officeYear())) {
  const [caseRow] = await tx`
    SELECT id, pim_number, current_status_id, received_date, application_date
    FROM pim_cases
    WHERE id = ${caseId}
    FOR UPDATE
  `;

  if (!caseRow) {
    throw new Error("PIM case not found.");
  }

  const pendingStatusId = await getStatusId(tx, "PIM_NUMBER_PENDING");

  if (caseRow.current_status_id !== pendingStatusId) {
    throw new Error(
      `This case is not available for PIM number assignment. Current status ID: ${caseRow.current_status_id}`
    );
  }

  if (caseRow.pim_number) {
    throw new Error("This case already has a PIM number.");
  }

  const registeredStatusId = await getStatusId(tx, "REGISTERED");
  const form2PendingStatusId = await getStatusId(tx, "FORM2_PENDING");

  const [seqRow] = await tx`
    UPDATE pim_number_sequences
    SET last_number = last_number + 1, updated_by = ${userId}, updated_at = now()
    WHERE year = ${year}
    RETURNING last_number
  `;

  if (!seqRow) {
    throw new Error(
      `The PIM-number sequence for year ${year} has not been initialized. Ask an administrator to initialize it before assigning numbers this year.`
    );
  }

  const prefix = await getPrefix(tx);
  const pimNumber = formatPimNumber(prefix, seqRow.last_number, year);

  const currentLocalDate = officeDate();
  const registrationDate = [currentLocalDate, caseRow.received_date, caseRow.application_date]
    .filter(Boolean)
    .sort()
    .at(-1);

  const internalTargetDays = await getInternalTargetDays(tx);
  const internal60DayDate = addDays(registrationDate, internalTargetDays);

  /*
   * First record actual registration - REGISTERED is written and
   * immediately superseded by FORM2_PENDING below, preserved purely as
   * transient historical/status-history evidence, exactly like T3
   * already did (REGISTERED is never a resting current_status_id in the
   * normal flow - lib/pim-action-link.js's worklist switch already folds
   * it into the same bucket as FORM2_PENDING).
   */
  await tx`
    UPDATE pim_cases
    SET
      pim_number = ${pimNumber},
      registration_date = ${registrationDate},
      current_status_id = ${registeredStatusId},
      internal_60_day_date = ${internal60DayDate},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${caseId}
  `;

  await addStatusHistory(
    tx,
    caseId,
    pendingStatusId,
    registeredStatusId,
    "PIM number assigned; case registered.",
    userId
  );

  await addDocket(
    tx,
    caseId,
    "PIM_NUMBER_ASSIGNED",
    `PIM number ${pimNumber} assigned.`,
    null,
    null,
    userId
  );

  await addDocket(
    tx,
    caseId,
    "PIM_REGISTERED",
    `PIM registered as ${pimNumber}.`,
    null,
    null,
    userId
  );

  const form2TaskId = await createPendingTaskIfNotExists(
    tx,
    caseId,
    "FORM2",
    "Prepare Form-2 after PIM registration.",
    officeDate(),
    "Automatically generated after PIM number assignment."
  );

  await addStatusHistory(
    tx,
    caseId,
    registeredStatusId,
    form2PendingStatusId,
    "PIM registered; Form-2 preparation pending.",
    userId
  );

  await tx`
    UPDATE pim_cases
    SET current_status_id = ${form2PendingStatusId}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${caseId}
  `;

  return {
    caseId,
    pimNumber,
    registrationDate,
    receivedDate: caseRow.received_date,
    applicationDate: caseRow.application_date,
    internal60DayDate,
    registeredStatusCode: "REGISTERED",
    currentStatusCode: "FORM2_PENDING",
    form2TaskId,
  };
}

async function assignPimNumberPg(caseId, userId, year = Number(officeYear())) {
  const numericCaseId = Number(caseId);

  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) {
    throw new Error("Valid case ID is required.");
  }

  return withTransaction((tx) => assignPimNumberTx(tx, numericCaseId, userId, year));
}

/*
 * 2026-10-07 production-completion sprint: numbering policy reversal.
 *
 * assignPimNumberTx/assignPimNumberPg (above) auto-allocate from
 * pim_number_sequences and are LEFT UNCHANGED for historical/rollback
 * reference, but are no longer called from the normal staff route
 * (app/api/pim/pim-number/route.js) - see
 * docs/phase6-manual-pim-numbering.md.
 *
 * Staff now reads the official running number off the physical
 * PIM/Assignment Register and types it in. This function validates and
 * stores it; pim_number_sequences.last_number is never read or
 * incremented by this path.
 *
 * Returned shape on success: { requiresConfirmation: false, ...result }.
 * Returned shape when a warning needs staff confirmation before writing
 * anything: { requiresConfirmation: true, warningType, message } - no
 * database write happens in this case; the caller must re-submit with
 * confirmGap/confirmLower set once staff has confirmed.
 */
async function assignPimNumberManualTx(
  tx,
  caseId,
  runningNumber,
  year,
  userId,
  { confirmGap = false, confirmLower = false } = {}
) {
  const numericRunningNumber = Number(runningNumber);
  const numericYear = Number(year);

  if (!Number.isInteger(numericRunningNumber) || numericRunningNumber <= 0) {
    throw new Error("The PIM running number must be a positive whole number.");
  }
  if (!Number.isInteger(numericYear) || numericYear < 2000) {
    throw new Error("A valid year is required.");
  }

  const [caseRow] = await tx`
    SELECT id, pim_number, running_number, pim_year, current_status_id, received_date, application_date
    FROM pim_cases
    WHERE id = ${caseId}
    FOR UPDATE
  `;

  if (!caseRow) {
    throw new Error("PIM case not found.");
  }

  const pendingStatusId = await getStatusId(tx, "PIM_NUMBER_PENDING");

  if (caseRow.current_status_id !== pendingStatusId) {
    throw new Error(
      `This case is not available for PIM number assignment. Current status ID: ${caseRow.current_status_id}`
    );
  }

  if (caseRow.pim_number) {
    throw new Error("This case already has a PIM number. Use the correction action to change it.");
  }

  // Hard block: duplicate (year, running_number) - checked explicitly
  // (clear business error) in addition to the unique index, which is the
  // real backstop under concurrency (two staff submitting the same
  // number at once: one succeeds, the other fails on the unique
  // violation caught below, never both).
  const [duplicate] = await tx`
    SELECT id FROM pim_cases WHERE pim_year = ${numericYear} AND running_number = ${numericRunningNumber}
  `;
  if (duplicate) {
    throw new Error(
      `PIM number ${numericRunningNumber}/${numericYear} is already registered against another case. Duplicate PIM numbers are not permitted.`
    );
  }

  const [maxRow] = await tx`
    SELECT MAX(running_number) AS max_running_number
    FROM pim_cases
    WHERE pim_year = ${numericYear} AND running_number IS NOT NULL
  `;
  const maxRunningNumber = maxRow ? maxRow.max_running_number : null;

  if (maxRunningNumber != null) {
    if (numericRunningNumber > maxRunningNumber + 1 && !confirmGap) {
      return {
        requiresConfirmation: true,
        warningType: "GAP",
        message:
          `Previous registered number is ${maxRunningNumber}. ` +
          `PIM/${maxRunningNumber + 1}/${numericYear} is not recorded. Please verify the official register.`,
      };
    }

    if (numericRunningNumber <= maxRunningNumber && !confirmLower) {
      return {
        requiresConfirmation: true,
        warningType: "LOWER_OR_OUT_OF_SEQUENCE",
        message:
          `PIM/${numericRunningNumber}/${numericYear} is lower than the last registered number ` +
          `(${maxRunningNumber}). Please verify this is correct before continuing.`,
      };
    }
  }

  const prefix = await getPrefix(tx);
  const pimNumber = formatPimNumber(prefix, numericRunningNumber, numericYear);

  const registeredStatusId = await getStatusId(tx, "REGISTERED");
  const form2PendingStatusId = await getStatusId(tx, "FORM2_PENDING");

  const currentLocalDate = officeDate();
  const registrationDate = [currentLocalDate, caseRow.received_date, caseRow.application_date]
    .filter(Boolean)
    .sort()
    .at(-1);

  const internalTargetDays = await getInternalTargetDays(tx);
  const internal60DayDate = addDays(registrationDate, internalTargetDays);

  try {
    await tx`
      UPDATE pim_cases
      SET
        pim_number = ${pimNumber},
        running_number = ${numericRunningNumber},
        pim_year = ${numericYear},
        registration_date = ${registrationDate},
        current_status_id = ${registeredStatusId},
        internal_60_day_date = ${internal60DayDate},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${caseId}
    `;
  } catch (error) {
    if (error.code === "23505") {
      throw new Error(
        `PIM number ${numericRunningNumber}/${numericYear} was just registered against another case. Duplicate PIM numbers are not permitted.`
      );
    }
    throw error;
  }

  await addStatusHistory(
    tx, caseId, pendingStatusId, registeredStatusId,
    `PIM number ${pimNumber} entered by staff from the official register; case registered.`, userId
  );

  await addDocket(tx, caseId, "PIM_NUMBER_ASSIGNED", `PIM number ${pimNumber} assigned (manually entered from register).`, null, null, userId);
  await addDocket(tx, caseId, "PIM_REGISTERED", `PIM registered as ${pimNumber}.`, null, null, userId);

  const form2TaskId = await createPendingTaskIfNotExists(
    tx, caseId, "FORM2", "Prepare Form-2 after PIM registration.", officeDate(),
    "Automatically generated after PIM number assignment."
  );

  await addStatusHistory(tx, caseId, registeredStatusId, form2PendingStatusId, "PIM registered; Form-2 preparation pending.", userId);

  await tx`UPDATE pim_cases SET current_status_id = ${form2PendingStatusId}, updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}`;

  return {
    requiresConfirmation: false,
    caseId,
    pimNumber,
    runningNumber: numericRunningNumber,
    year: numericYear,
    registrationDate,
    receivedDate: caseRow.received_date,
    applicationDate: caseRow.application_date,
    internal60DayDate,
    registeredStatusCode: "REGISTERED",
    currentStatusCode: "FORM2_PENDING",
    form2TaskId,
  };
}

async function assignPimNumberManualPg(caseId, runningNumber, year, userId, options = {}) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) {
    throw new Error("Valid case ID is required.");
  }
  return withTransaction((tx) => assignPimNumberManualTx(tx, numericCaseId, runningNumber, year, userId, options));
}

/*
 * Controlled correction: the only way to change a PIM number once
 * assigned. Every correction is audited in pim_number_corrections with
 * old/new number, reason, who, and when - never a silent overwrite.
 */
async function correctPimNumberTx(tx, caseId, newRunningNumber, year, reason, userId) {
  const numericRunningNumber = Number(newRunningNumber);
  const numericYear = Number(year);

  if (!Number.isInteger(numericRunningNumber) || numericRunningNumber <= 0) {
    throw new Error("The corrected PIM running number must be a positive whole number.");
  }
  if (!Number.isInteger(numericYear) || numericYear < 2000) {
    throw new Error("A valid year is required.");
  }
  if (!reason || !String(reason).trim()) {
    throw new Error("A reason is required for a PIM number correction.");
  }

  const [caseRow] = await tx`
    SELECT id, pim_number, running_number, pim_year
    FROM pim_cases
    WHERE id = ${caseId}
    FOR UPDATE
  `;
  if (!caseRow) throw new Error("PIM case not found.");
  if (!caseRow.pim_number) throw new Error("This case has no PIM number to correct.");

  const [duplicate] = await tx`
    SELECT id FROM pim_cases
    WHERE pim_year = ${numericYear} AND running_number = ${numericRunningNumber} AND id != ${caseId}
  `;
  if (duplicate) {
    throw new Error(`PIM number ${numericRunningNumber}/${numericYear} is already registered against another case.`);
  }

  const prefix = await getPrefix(tx);
  const newPimNumber = formatPimNumber(prefix, numericRunningNumber, numericYear);

  try {
    await tx`
      UPDATE pim_cases
      SET pim_number = ${newPimNumber}, running_number = ${numericRunningNumber}, pim_year = ${numericYear}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${caseId}
    `;
  } catch (error) {
    if (error.code === "23505") {
      throw new Error(`PIM number ${numericRunningNumber}/${numericYear} was just registered against another case.`);
    }
    throw error;
  }

  await tx`
    INSERT INTO pim_number_corrections
      (case_id, old_pim_number, new_pim_number, old_running_number, new_running_number, year, reason, corrected_by)
    VALUES
      (${caseId}, ${caseRow.pim_number}, ${newPimNumber}, ${caseRow.running_number}, ${numericRunningNumber}, ${numericYear}, ${reason}, ${userId})
  `;

  await addDocket(
    tx, caseId, "PIM_NUMBER_ASSIGNED",
    `PIM number corrected from ${caseRow.pim_number} to ${newPimNumber}. Reason: ${reason}`, null, null, userId
  );

  return { caseId, oldPimNumber: caseRow.pim_number, newPimNumber, runningNumber: numericRunningNumber, year: numericYear };
}

async function correctPimNumberPg(caseId, newRunningNumber, year, reason, userId) {
  const numericCaseId = Number(caseId);
  if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) {
    throw new Error("Valid case ID is required.");
  }
  return withTransaction((tx) => correctPimNumberTx(tx, numericCaseId, newRunningNumber, year, reason, userId));
}

/*
 * Read-only helper for the UI: the last registered running number for a
 * year, so staff can see what the register should say next (never used
 * to auto-fill/auto-submit a number).
 */
async function getLastRegisteredNumber(year) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) {
    throw new Error("Valid year is required.");
  }
  const sql = getSql();
  const [row] = await sql`
    SELECT MAX(running_number) AS last_running_number
    FROM pim_cases
    WHERE pim_year = ${numericYear} AND running_number IS NOT NULL
  `;
  return { year: numericYear, lastRunningNumber: row ? row.last_running_number : null };
}

module.exports = {
  formatPimNumber,
  previewNextPimNumber,
  initializePimSequencePg,
  assignPimNumberTx,
  assignPimNumberPg,
  assignPimNumberManualTx,
  assignPimNumberManualPg,
  correctPimNumberTx,
  correctPimNumberPg,
  getLastRegisteredNumber,
};
