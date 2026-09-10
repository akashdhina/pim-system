const db = require("../lib/db");

const row = db.prepare(`
  SELECT sql
  FROM sqlite_master
  WHERE type = 'table'
    AND name = 'pim_cases'
`).get();

console.log(row.sql);

db.close();