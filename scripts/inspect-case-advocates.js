const db = require("../lib/db");

console.log("\n========== PIM CASE ADVOCATES SCHEMA ==========");

console.log(
  db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'pim_case_advocates'
  `).get()
);

console.log("\n========== COLUMNS ==========");

console.table(
  db.prepare(`
    PRAGMA table_info(pim_case_advocates)
  `).all()
);

console.log("\n========== SAMPLE DATA ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM pim_case_advocates
    ORDER BY id
    LIMIT 10
  `).all()
);

console.log("\n========== ADVOCATES SCHEMA ==========");

console.table(
  db.prepare(`
    PRAGMA table_info(pim_advocates)
  `).all()
);

db.close();