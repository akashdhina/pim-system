/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("./db");
const {
  getSetting: getOfficeSetting,
} = require("./pim-settings");

function todayLocal() {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(
    now.getMonth() + 1
  ).padStart(2, "0");
  const day = String(
    now.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function maxDate(...dates) {
  const validDates = dates
    .filter(Boolean)
    .map(String)
    .sort();

  return validDates.length
    ? validDates[validDates.length - 1]
    : todayLocal();
}

function addDays(dateString, days) {
  const date = new Date(
    `${dateString}T00:00:00`
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid date: ${dateString}`
    );
  }

  date.setDate(
    date.getDate() + days
  );

  const year = date.getFullYear();
  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");
  const day = String(
    date.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getSetting(key) {
  const row = db
    .prepare(
      "SELECT setting_value FROM system_settings WHERE setting_key = ?"
    )
    .get(key);

  return row
    ? row.setting_value
    : null;
}

function getStatusId(code) {
  const row = db
    .prepare(
      "SELECT id FROM status_master WHERE code = ?"
    )
    .get(code);

  if (!row) {
    throw new Error(
      `Status not found: ${code}`
    );
  }

  return row.id;
}

function getEventId(code) {
  const row = db
    .prepare(
      "SELECT id FROM event_types WHERE code = ?"
    )
    .get(code);

  if (!row) {
    throw new Error(
      `Event not found: ${code}`
    );
  }

  return row.id;
}

function escapeRegex(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function generatePimNumber() {
  const prefix =
    getOfficeSetting("pim_number_prefix") ||
    getSetting("PIM_NUMBER_PREFIX") ||
    "PIM";

  const year = new Date()
    .getFullYear()
    .toString();

  const existing = db
    .prepare(
      `
      SELECT pim_number
      FROM pim_cases
      WHERE pim_number IS NOT NULL
        AND pim_number LIKE ?
      ORDER BY id DESC
      `
    )
    .all(
      `${prefix}/${year}/%`
    );

  let maxNumber = 0;

  for (const row of existing) {
    const match = String(
      row.pim_number
    ).match(
      new RegExp(
        `^${escapeRegex(
          prefix
        )}/${year}/(\\d+)$`
      )
    );

    if (match) {
      const number = Number(
        match[1]
      );

      if (Number.isFinite(number)) {
        maxNumber = Math.max(
          maxNumber,
          number
        );
      }
    }
  }

  const nextNumber =
    maxNumber + 1;

  return `${prefix}/${year}/${String(
    nextNumber
  ).padStart(4, "0")}`;
}

function addStatusHistory(
  caseId,
  fromStatusId,
  toStatusId,
  reason,
  changedBy
) {
  db.prepare(
    `
    INSERT INTO pim_status_history
    (
      case_id,
      from_status_id,
      to_status_id,
      reason,
      changed_by
    )
    VALUES (?, ?, ?, ?, ?)
    `
  ).run(
    caseId,
    fromStatusId,
    toStatusId,
    reason,
    changedBy || null
  );
}

function addDocket(
  caseId,
  eventTypeId,
  entryText,
  enteredBy,
  nextDate = null,
  actionRequired = null
) {
  db.prepare(
    `
    INSERT INTO pim_docket
    (
      case_id,
      docket_date,
      event_type_id,
      entry_text,
      action_required,
      next_date,
      entered_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    caseId,
    todayLocal(),
    eventTypeId,
    entryText,
    actionRequired,
    nextDate,
    enteredBy || null
  );
}

function completePendingScrutinyTask(
  caseId,
  completedBy
) {
  const tasks = db
    .prepare(
      `
      SELECT id, status
      FROM pim_tasks
      WHERE case_id = ?
        AND task_type_code = 'SCRUTINY'
        AND status = 'PENDING'
      ORDER BY id
      `
    )
    .all(caseId);

  for (const task of tasks) {
    db.prepare(
      `
      UPDATE pim_tasks
      SET
        status = 'COMPLETED',
        completed_date = ?,
        completed_time = time('now'),
        completed_by = ?
      WHERE id = ?
      `
    ).run(
      todayLocal(),
      completedBy || null,
      task.id
    );

    db.prepare(
      `
      INSERT INTO pim_task_history
      (
        task_id,
        old_status,
        new_status,
        changed_by,
        remarks
      )
      VALUES (?, ?, ?, ?, ?)
      `
    ).run(
      task.id,
      task.status,
      "COMPLETED",
      completedBy || null,
      "Scrutiny completed and file put up for Secretary approval."
    );
  }
}

function createForm2Task(caseId) {
  const taskType =
    db
      .prepare(
        `
        SELECT id, code
        FROM task_types
        WHERE code IN (
          'FORM2',
          'FORM2_PREPARATION',
          'FORM2_PENDING'
        )
        ORDER BY
          CASE code
            WHEN 'FORM2' THEN 1
            WHEN 'FORM2_PREPARATION' THEN 2
            WHEN 'FORM2_PENDING' THEN 3
            ELSE 4
          END
        LIMIT 1
        `
      )
      .get();

  const taskTypeId =
    taskType
      ? taskType.id
      : null;

  const taskTypeCode =
    taskType
      ? taskType.code
      : "FORM2";

  const existing =
    db
      .prepare(
        `
        SELECT id
        FROM pim_tasks
        WHERE case_id = ?
          AND task_type_code = ?
          AND status = 'PENDING'
        LIMIT 1
        `
      )
      .get(
        caseId,
        taskTypeCode
      );

  if (existing) {
    return existing.id;
  }

  const result =
    db
      .prepare(
        `
        INSERT INTO pim_tasks
        (
          case_id,
          task_type_id,
          task_type_code,
          description,
          created_date,
          due_date,
          priority,
          status,
          auto_generated,
          remarks
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        caseId,
        taskTypeId,
        taskTypeCode,
        "Prepare Form-2 after PIM registration.",
        todayLocal(),
        todayLocal(),
        "NORMAL",
        "PENDING",
        1,
        "Automatically generated after PIM registration."
      );

  return result.lastInsertRowid;
}

function approvePimRegistration(
  caseId,
  approvedBy = null,
  remarks = null
) {
  const transaction =
    db.transaction(() => {
      const caseRow =
        db
          .prepare(
            `
            SELECT *
            FROM pim_cases
            WHERE id = ?
            `
          )
          .get(caseId);

      if (!caseRow) {
        throw new Error(
          "PIM case not found."
        );
      }

      const pendingStatusId =
        getStatusId(
          "SECRETARY_APPROVAL_PENDING"
        );

      const registeredStatusId =
        getStatusId("REGISTERED");

      const form2PendingStatusId =
        getStatusId(
          "FORM2_PENDING"
        );

      const approvalEventId =
        getEventId(
          "SECRETARY_APPROVAL"
        );

      const registeredEventId =
        getEventId(
          "PIM_REGISTERED"
        );

      if (
        caseRow.current_status_id !==
        pendingStatusId
      ) {
        throw new Error(
          `This case is not available for Secretary approval. Current status ID: ${caseRow.current_status_id}`
        );
      }

      if (caseRow.pim_number) {
        throw new Error(
          "This case already has a PIM number."
        );
      }

      /*
       * Registration cannot predate either
       * the received date or application date.
       *
       * Also use local business date rather
       * than UTC date.
       */
      const currentLocalDate =
        todayLocal();

      const registrationDate =
        maxDate(
          currentLocalDate,
          caseRow.received_date,
          caseRow.application_date
        );

      const pimNumber =
        generatePimNumber();

      const internalTargetDays =
        Number(
          getSetting(
            "INTERNAL_NONSTARTER_TARGET_DAYS"
          ) || 60
        );

      const internal60DayDate =
        addDays(
          registrationDate,
          internalTargetDays
        );

      /*
       * First record actual registration.
       */
      db.prepare(
        `
        UPDATE pim_cases
        SET
          pim_number = ?,
          registration_date = ?,
          secretary_decision = 'APPROVED',
          secretary_decision_date = ?,
          current_status_id = ?,
          internal_60_day_date = ?,
          remarks = COALESCE(?, remarks),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `
      ).run(
        pimNumber,
        registrationDate,
        registrationDate,
        registeredStatusId,
        internal60DayDate,
        remarks || null,
        caseId
      );

      addStatusHistory(
        caseId,
        pendingStatusId,
        registeredStatusId,
        "Secretary approved PIM registration.",
        approvedBy
      );

      addDocket(
        caseId,
        approvalEventId,
        "Secretary approved the PIM application for registration.",
        approvedBy
      );

      addDocket(
        caseId,
        registeredEventId,
        `PIM registered as ${pimNumber}.`,
        approvedBy
      );

      completePendingScrutinyTask(
        caseId,
        approvedBy
      );

      const form2TaskId =
        createForm2Task(caseId);

      addStatusHistory(
        caseId,
        registeredStatusId,
        form2PendingStatusId,
        "PIM registered; Form-2 preparation pending.",
        approvedBy
      );

      db.prepare(
        `
        UPDATE pim_cases
        SET
          current_status_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `
      ).run(
        form2PendingStatusId,
        caseId
      );

      return {
        caseId,
        pimNumber,
        registrationDate,
        receivedDate:
          caseRow.received_date,
        applicationDate:
          caseRow.application_date,
        internal60DayDate,
        registeredStatusCode:
          "REGISTERED",
        currentStatusCode:
          "FORM2_PENDING",
        form2TaskId,
      };
    });

  return transaction();
}

module.exports = {
  approvePimRegistration,
  generatePimNumber,
};
