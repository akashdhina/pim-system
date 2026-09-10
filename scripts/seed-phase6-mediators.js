/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Phase 6 mediator master-data seed.
 * Additive/non-destructive. Safe to re-run (idempotent).
 *
 * Adds exactly the two named mediators through the existing
 * `mediators` table. No personal details (phone, email, panel
 * dates, enrolment number) are guessed - those columns are left
 * NULL, which the schema permits (only name/category/active are
 * NOT NULL, and category/active already have safe defaults).
 *
 * There is no UNIQUE constraint on mediators.name in the current
 * schema, so idempotency here is enforced by an explicit
 * name-based existence check rather than INSERT OR IGNORE.
 */

const db = require("../lib/db");

const MEDIATOR_NAMES = ["Mr.R.Ravikumar", "Mr.H.Rajesh"];

const report = {
  existingBefore: [],
  alreadyPresent: [],
  inserted: [],
};

const seed = db.transaction(() => {
  report.existingBefore = db
    .prepare("SELECT id, name, active FROM mediators ORDER BY id")
    .all();

  for (const name of MEDIATOR_NAMES) {
    const existing = db
      .prepare("SELECT id FROM mediators WHERE name = ?")
      .get(name);

    if (existing) {
      report.alreadyPresent.push({ name, id: existing.id });
      continue;
    }

    const result = db
      .prepare(`
        INSERT INTO mediators (name, category, active)
        VALUES (?, 'ADVOCATE MEDIATOR', 1)
      `)
      .run(name);

    report.inserted.push({ name, id: Number(result.lastInsertRowid) });
  }
});

seed();

console.log(JSON.stringify(report, null, 2));
