const db = require("../lib/db");

const events = [
  {
    code: "NONSTARTER_RECORDED",
    name: "Non-Starter Recorded",
    category: "OUTCOME",
  },
  {
    code: "AUTHORITY_DECISION",
    name: "Authority Decision",
    category: "AUTHORITY",
  },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO event_types
  (
    code,
    name,
    category,
    active
  )
  VALUES (?, ?, ?, 1)
`);

const seed = db.transaction(() => {
  for (const event of events) {
    insert.run(
      event.code,
      event.name,
      event.category
    );
  }
});

seed();

console.log("NON-STARTER EVENTS SEEDED");

console.table(
  db.prepare(`
    SELECT
      id,
      code,
      name,
      category,
      active
    FROM event_types
    WHERE code IN (
      'NONSTARTER_RECORDED',
      'AUTHORITY_DECISION',
      'FORM3'
    )
    ORDER BY id
  `).all()
);

db.close();