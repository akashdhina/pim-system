/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../lib/db");

function columnExists(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

const changes = [];

const migrate = db.transaction(() => {
  if (!columnExists("pim_cases", "entry_type")) {
    db.prepare(
      "ALTER TABLE pim_cases ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'NEW' CHECK (entry_type IN ('NEW','LEGACY'))"
    ).run();
    changes.push("pim_cases.entry_type");
  }

  db.prepare(`
    UPDATE pim_cases
    SET entry_type = 'NEW'
    WHERE entry_type IS NULL
       OR entry_type NOT IN ('NEW','LEGACY')
  `).run();
});

try {
  migrate();
  console.log(
    changes.length
      ? `Legacy import migration applied: ${changes.join(", ")}`
      : "Legacy import migration already applied."
  );
} finally {
  db.close();
}
