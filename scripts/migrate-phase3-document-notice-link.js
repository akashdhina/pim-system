/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Phase 3 Final Form II migration.
 * Additive/non-destructive. Safe to re-run (idempotent).
 *
 * - pim_documents.notice_id (nullable FK -> pim_notices)
 *   Required so document version history and the is_current
 *   flag can be scoped per notice rather than per case - a case
 *   can now have more than one FORM-2 notice (Initial, Fresh
 *   Initial, Final), each with its own document lineage.
 * - deterministic backfill: for each existing notice with a
 *   document_id, set that document's notice_id to match.
 */

const db = require("../lib/db");

function columnExists(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

const report = {
  schemaChanges: [],
  backfill: {
    documentsNoticeIdBackfilled: 0,
  },
};

const migrate = db.transaction(() => {
  if (!columnExists("pim_documents", "notice_id")) {
    db.prepare(
      "ALTER TABLE pim_documents ADD COLUMN notice_id INTEGER REFERENCES pim_notices(id)"
    ).run();
    report.schemaChanges.push("pim_documents.notice_id");
  }

  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_documents_notice ON pim_documents(notice_id)"
  ).run();

  const notices = db
    .prepare(`
      SELECT id, document_id
      FROM pim_notices
      WHERE document_id IS NOT NULL
    `)
    .all();

  for (const notice of notices) {
    const result = db
      .prepare(
        `UPDATE pim_documents SET notice_id = ? WHERE id = ? AND notice_id IS NULL`
      )
      .run(notice.id, notice.document_id);

    report.backfill.documentsNoticeIdBackfilled += result.changes;
  }
});

migrate();

console.log(JSON.stringify(report, null, 2));
