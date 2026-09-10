const db = require("../lib/db");

console.log(
  db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'event_types'
  `).get()
);

console.log("\nEXISTING EVENTS:");
console.table(
  db.prepare(`
    SELECT *
    FROM event_types
    ORDER BY id
  `).all()
);

db.close();