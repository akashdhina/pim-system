const db = require("../lib/db");

const caseId = 1;
const historyId = 5;

const repair = db.transaction(() => {
  const caseRow = db.prepare(`
    SELECT
      c.id,
      c.pim_number,
      c.received_number,
      c.entry_type,
      c.outcome_type,
      s.code AS status_code
    FROM pim_cases c
    JOIN status_master s
      ON s.id = c.current_status_id
    WHERE c.id = ?
  `).get(caseId);

  if (!caseRow) {
    throw new Error("Case 1 was not found.");
  }

  if (
    caseRow.entry_type !== "LEGACY" ||
    caseRow.outcome_type !== "NON_STARTER" ||
    caseRow.status_code !== "CLOSED_NON_STARTER"
  ) {
    throw new Error(
      `Unexpected case state: ${JSON.stringify(caseRow)}`
    );
  }

  const history = db.prepare(`
    SELECT
      h.id,
      h.case_id,
      h.from_status_id,
      h.to_status_id,
      h.reason,
      (
        SELECT previous.to_status_id
        FROM pim_status_history previous
        WHERE previous.case_id = h.case_id
          AND previous.id < h.id
        ORDER BY previous.id DESC
        LIMIT 1
      ) AS expected_from_status_id
    FROM pim_status_history h
    WHERE h.id = ?
      AND h.case_id = ?
  `).get(historyId, caseId);

  if (!history) {
    throw new Error("Target status-history row was not found.");
  }

  if (!history.expected_from_status_id) {
    throw new Error(
      "Previous status-history destination could not be determined."
    );
  }

  if (
    history.from_status_id ===
    history.expected_from_status_id
  ) {
    return {
      success: true,
      repaired: false,
      message: "History is already continuous.",
      history,
    };
  }

  const update = db.prepare(`
    UPDATE pim_status_history
    SET
      from_status_id = ?,
      reason = ?
    WHERE id = ?
      AND case_id = ?
      AND from_status_id = ?
  `).run(
    history.expected_from_status_id,
    "Legacy case closed as non-starter based on the physical file; authority decision was not required.",
    historyId,
    caseId,
    history.from_status_id
  );

  if (update.changes !== 1) {
    throw new Error(
      "Status-history repair was not applied."
    );
  }

  return {
    success: true,
    repaired: true,
    caseId,
    historyId,
    oldFromStatusId: history.from_status_id,
    newFromStatusId:
      history.expected_from_status_id,
    toStatusId: history.to_status_id,
  };
});

console.log(repair());