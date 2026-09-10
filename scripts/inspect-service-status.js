const db = require("../lib/db");

console.log("\n========== NOTICE STATUSES ==========");

console.table(
  db.prepare(`
    SELECT
      id,
      case_id,
      notice_type,
      form_no,
      status,
      dispatch_date
    FROM pim_notices
    WHERE case_id = 4
    ORDER BY id
  `).all()
);

console.log("\n========== SERVICE ATTEMPTS ==========");

console.table(
  db.prepare(`
    SELECT *
    FROM pim_service_attempts
    WHERE notice_id IN (
      SELECT id
      FROM pim_notices
      WHERE case_id = 4
    )
    ORDER BY id
  `).all()
);

db.close();