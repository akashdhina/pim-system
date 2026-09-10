const db = require("../lib/db");

const existing = db.prepare(`
  SELECT id
  FROM mediators
  WHERE name = ?
`).get("TEST MEDIATOR");

if (existing) {
  console.log("Test mediator already exists:", existing.id);
} else {
  const result = db.prepare(`
    INSERT INTO mediators
    (
      name,
      category,
      enrollment_no,
      contact_phone,
      email,
      empanelment_order_no,
      empanelment_date,
      panel_valid_until,
      active,
      rotation_order,
      conflict_declaration_date,
      remarks
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "TEST MEDIATOR",
    "ADVOCATE MEDIATOR",
    "TEST-ENROL-001",
    "9000000000",
    "test@example.com",
    "TEST-ORDER-001",
    "2026-08-01",
    "2027-07-31",
    1,
    1,
    "2026-08-01",
    "Test mediator for PIM workflow testing."
  );

  console.log(
    "Test mediator created:",
    Number(result.lastInsertRowid)
  );
}

console.table(
  db.prepare(`
    SELECT
      id,
      name,
      category,
      enrollment_no,
      active,
      rotation_order
    FROM mediators
    ORDER BY rotation_order, id
  `).all()
);

db.close();