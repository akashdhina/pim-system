const db = require("../lib/db");

console.log(
  db.prepare(`
    SELECT
      id,
      code,
      name,
      rule_reference,
      requires_authority_decision,
      active,
      remarks
    FROM nonstarter_reasons
    ORDER BY id
  `).all()
);

db.close();