/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../lib/db");

db.pragma("foreign_keys = ON");

db.transaction(() => {

  db.prepare("DELETE FROM mediation_sessions").run();

  db.prepare("DELETE FROM pim_mediator_assignments").run();

  db.prepare("DELETE FROM pim_service_attempts").run();

  db.prepare("DELETE FROM pim_notices").run();

  db.prepare("DELETE FROM pim_responses").run();

  db.prepare("DELETE FROM pim_fees").run();

  db.prepare("DELETE FROM pim_outcomes").run();

  db.prepare("DELETE FROM pim_documents").run();

  db.prepare("DELETE FROM pim_tasks").run();

  db.prepare("DELETE FROM pim_docket").run();

  db.prepare("DELETE FROM pim_status_history").run();

  db.prepare("DELETE FROM pim_scrutiny").run();

  db.prepare("DELETE FROM pim_case_advocates").run();

  db.prepare("DELETE FROM pim_case_parties").run();

  db.prepare("DELETE FROM pim_cases").run();

  /*
   * Optional:
   * Only if these were created solely for testing.
   */
  db.prepare("DELETE FROM pim_addresses").run();

  db.prepare("DELETE FROM pim_parties").run();

  db.prepare("DELETE FROM pim_advocates").run();

  /*
   * Reset AUTOINCREMENT counters
   */
  db.prepare("DELETE FROM sqlite_sequence").run();

  /*
   * Reset PIM numbering if stored in settings
   */
  db.prepare(`
    UPDATE system_settings
    SET setting_value = '0'
    WHERE setting_key IN
    (
      'LAST_PIM_NUMBER',
      'PIM_LAST_NUMBER',
      'CURRENT_PIM_NUMBER'
    )
  `).run();

})();

console.log("=================================");
console.log("Test PIM data deleted successfully.");
console.log("Users, mediators and settings kept.");
console.log("=================================");