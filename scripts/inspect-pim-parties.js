const db = require("../lib/db");

console.log("\n========== PIM PARTIES SCHEMA ==========");

console.log(
  db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'pim_parties'
  `).get()
);

console.log("\n========== COLUMNS ==========");

console.table(
  db.prepare(`
    PRAGMA table_info(pim_parties)
  `).all()
);

console.log("\n========== SAMPLE DATA ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM pim_parties
    ORDER BY id
    LIMIT 10
  `).all()
);

db.close();