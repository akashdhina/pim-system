/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Phase 1 data-model foundations migration.
 * Additive/non-destructive. Safe to re-run (idempotent).
 *
 * - pim_notices.address_id (nullable FK -> pim_addresses)
 * - pim_service_attempts.return_reason (nullable controlled value)
 * - pim_scrutiny_attempts (append-only scrutiny history)
 * - deterministic backfill of both from existing data, where unambiguous
 * - partial unique index enforcing at most one primary party per case_id+role
 *   (only created if a read-only audit finds no existing violation)
 * - FORM2 / OP_APPEARANCE_FOLLOWUP task_types (additive)
 */

const db = require("../lib/db");

function columnExists(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function tableExists(table) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
}

function indexExists(index) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(index);
}

const report = {
  schemaChanges: [],
  backfill: {
    scrutinyAttemptsInserted: 0,
    noticesAddressBackfilled: 0,
    noticesAddressLeftNull: [],
  },
  op1Audit: {
    zeroPrimary: [],
    multiPrimary: [],
    indexCreated: false,
  },
  taskTypesAdded: [],
};

const migrate = db.transaction(() => {
  // A. pim_notices.address_id
  if (!columnExists("pim_notices", "address_id")) {
    db.prepare(
      "ALTER TABLE pim_notices ADD COLUMN address_id INTEGER REFERENCES pim_addresses(id)"
    ).run();
    report.schemaChanges.push("pim_notices.address_id");
  }
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_notices_address ON pim_notices(address_id)"
  ).run();

  // B. pim_service_attempts.return_reason
  if (!columnExists("pim_service_attempts", "return_reason")) {
    db.prepare(
      `ALTER TABLE pim_service_attempts ADD COLUMN return_reason TEXT
       CHECK (return_reason IS NULL OR return_reason IN (
         'ADDRESSEE_LEFT','INSUFFICIENT_ADDRESS','UNCLAIMED','REFUSED_BY_ADDRESSEE','OTHER'
       ))`
    ).run();
    report.schemaChanges.push("pim_service_attempts.return_reason");
  }

  // C. pim_scrutiny_attempts (append-only history)
  if (!tableExists("pim_scrutiny_attempts")) {
    db.prepare(`
      CREATE TABLE pim_scrutiny_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL,
        attempt_no INTEGER NOT NULL,
        form1_complete INTEGER,
        application_fee_received INTEGER,
        dd_number TEXT,
        dd_date TEXT,
        dd_bank TEXT,
        dd_amount NUMERIC,
        dd_payee_correct INTEGER,
        dd_valid INTEGER,
        vakalat_available INTEGER,
        opposite_party_address_available INTEGER,
        commercial_dispute_checked INTEGER,
        territorial_jurisdiction_checked INTEGER,
        supporting_documents_checked INTEGER,
        scrutiny_result TEXT,
        defect_details TEXT,
        rectification_date TEXT,
        scrutinised_by INTEGER,
        scrutinised_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(case_id, attempt_no),
        FOREIGN KEY (case_id) REFERENCES pim_cases(id) ON DELETE CASCADE,
        FOREIGN KEY (scrutinised_by) REFERENCES users(id)
      )
    `).run();
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_scrutiny_attempts_case ON pim_scrutiny_attempts(case_id)"
    ).run();
    report.schemaChanges.push("pim_scrutiny_attempts (table + index)");
  }

  // Backfill: represent every existing pim_scrutiny row as attempt 1,
  // unless an attempt already exists for that case (idempotent, non-destructive).
  const existingScrutiny = db.prepare("SELECT * FROM pim_scrutiny").all();
  const insertAttempt = db.prepare(`
    INSERT INTO pim_scrutiny_attempts (
      case_id, attempt_no, form1_complete, application_fee_received,
      dd_number, dd_date, dd_bank, dd_amount, dd_payee_correct, dd_valid,
      vakalat_available, opposite_party_address_available,
      commercial_dispute_checked, territorial_jurisdiction_checked,
      supporting_documents_checked, scrutiny_result, defect_details,
      rectification_date, scrutinised_by, scrutinised_at
    ) VALUES (
      @case_id, @attempt_no, @form1_complete, @application_fee_received,
      @dd_number, @dd_date, @dd_bank, @dd_amount, @dd_payee_correct, @dd_valid,
      @vakalat_available, @opposite_party_address_available,
      @commercial_dispute_checked, @territorial_jurisdiction_checked,
      @supporting_documents_checked, @scrutiny_result, @defect_details,
      @rectification_date, @scrutinised_by, @scrutinised_at
    )
  `);
  const attemptCountForCase = db.prepare(
    "SELECT COUNT(*) AS c FROM pim_scrutiny_attempts WHERE case_id = ?"
  );

  for (const row of existingScrutiny) {
    const existingCount = attemptCountForCase.get(row.case_id).c;
    if (existingCount > 0) continue; // already represented, do not duplicate

    insertAttempt.run({
      case_id: row.case_id,
      attempt_no: 1,
      form1_complete: row.form1_complete,
      application_fee_received: row.application_fee_received,
      dd_number: row.dd_number,
      dd_date: row.dd_date,
      dd_bank: row.dd_bank,
      dd_amount: row.dd_amount,
      dd_payee_correct: row.dd_payee_correct,
      dd_valid: row.dd_valid,
      vakalat_available: row.vakalat_available,
      opposite_party_address_available: row.opposite_party_address_available,
      commercial_dispute_checked: row.commercial_dispute_checked,
      territorial_jurisdiction_checked: row.territorial_jurisdiction_checked,
      supporting_documents_checked: row.supporting_documents_checked,
      scrutiny_result: row.scrutiny_result,
      defect_details: row.defect_details,
      rectification_date: row.rectification_date,
      scrutinised_by: row.scrutinised_by,
      scrutinised_at: row.scrutinised_at,
    });
    report.backfill.scrutinyAttemptsInserted += 1;
  }

  // Backfill pim_notices.address_id only where unambiguous:
  // exactly one distinct non-null address_id across that notice's service attempts.
  const notices = db.prepare(
    "SELECT id, address_id FROM pim_notices"
  ).all();
  const addressesForNotice = db.prepare(`
    SELECT DISTINCT address_id
    FROM pim_service_attempts
    WHERE notice_id = ? AND address_id IS NOT NULL
  `);
  const setNoticeAddress = db.prepare(
    "UPDATE pim_notices SET address_id = ? WHERE id = ?"
  );

  for (const notice of notices) {
    if (notice.address_id !== null) continue; // already set, do not overwrite

    const distinctAddresses = addressesForNotice.all(notice.id);
    if (distinctAddresses.length === 1) {
      setNoticeAddress.run(distinctAddresses[0].address_id, notice.id);
      report.backfill.noticesAddressBackfilled += 1;
    } else {
      report.backfill.noticesAddressLeftNull.push({
        notice_id: notice.id,
        distinct_addresses: distinctAddresses.length,
      });
    }
  }

  // D. OP1 / principal-party integrity: read-only audit, then conditionally
  // create a partial unique index. Never repair data automatically.
  const roleCounts = db.prepare(`
    SELECT case_id, role, COUNT(*) AS total, SUM(is_primary) AS primaries
    FROM pim_case_parties
    GROUP BY case_id, role
  `).all();

  report.op1Audit.zeroPrimary = roleCounts.filter((r) => r.primaries === 0);
  report.op1Audit.multiPrimary = roleCounts.filter((r) => r.primaries > 1);

  const opAnomalies =
    report.op1Audit.zeroPrimary.length + report.op1Audit.multiPrimary.length;

  if (opAnomalies === 0 && !indexExists("idx_case_parties_one_primary_per_role")) {
    db.prepare(
      "CREATE UNIQUE INDEX idx_case_parties_one_primary_per_role ON pim_case_parties(case_id, role) WHERE is_primary = 1"
    ).run();
    report.op1Audit.indexCreated = true;
    report.schemaChanges.push("idx_case_parties_one_primary_per_role (partial unique index)");
  } else if (opAnomalies > 0) {
    report.op1Audit.indexCreated = false;
  } else {
    report.op1Audit.indexCreated = "already-present";
  }

  // E. Task/master-data normalization (additive, idempotent)
  const insertTaskType = db.prepare(`
    INSERT OR IGNORE INTO task_types (code, name, default_priority)
    VALUES (?, ?, ?)
  `);
  const canonicalTasks = [
    ["FORM2", "Prepare Form-2 after PIM Registration", "NORMAL"],
    ["OP_APPEARANCE_FOLLOWUP", "OP Appearance Follow-up (Alternate Date)", "NORMAL"],
    ["NONSTARTER_FORM3", "Prepare Form-3 Non-Starter Report", "NORMAL"],
    ["NONSTARTER_AUTHORITY", "Authority Decision on Non-Starter", "NORMAL"],
  ];
  for (const [code, name, priority] of canonicalTasks) {
    const before = db.prepare("SELECT id FROM task_types WHERE code = ?").get(code);
    if (!before) {
      insertTaskType.run(code, name, priority);
      report.taskTypesAdded.push(code);
    }
  }
});

try {
  migrate();
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
