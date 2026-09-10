/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Phase 4 OP-response migration.
 * Additive/non-destructive. Safe to re-run (idempotent).
 *
 * - pim_responses.notice_id (nullable FK -> pim_notices)
 *   Required so an OP response can be tied to the specific
 *   notice (Initial or Final) it answers, instead of only the
 *   case - a case can now have more than one Form-2 notice.
 * - OP_NO_RESPONSE event type (additive master data): no
 *   existing seeded event correctly describes "OP did not
 *   appear / no response received" as a historical fact.
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
  eventsAdded: [],
};

const migrate = db.transaction(() => {
  if (!columnExists("pim_responses", "notice_id")) {
    db.prepare(
      "ALTER TABLE pim_responses ADD COLUMN notice_id INTEGER REFERENCES pim_notices(id)"
    ).run();
    report.schemaChanges.push("pim_responses.notice_id");
  }

  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_responses_notice ON pim_responses(notice_id)"
  ).run();

  const result = db
    .prepare(`
      INSERT OR IGNORE INTO event_types (code, name, category)
      VALUES ('OP_NO_RESPONSE', 'OP Did Not Appear / No Response', 'RESPONSE')
    `)
    .run();

  if (result.changes > 0) {
    report.eventsAdded.push("OP_NO_RESPONSE");
  }
});

migrate();

console.log(JSON.stringify(report, null, 2));
