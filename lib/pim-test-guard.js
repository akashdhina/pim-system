/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");

function productionDatabasePath() {
  return path.resolve(path.join(process.cwd(), "database", "pim.db"));
}

/*
 * Refuses to continue if the given better-sqlite3 connection is open
 * against the production database file - whether PIM_DB_PATH was left
 * unset (lib/db.js's own fallback) or was explicitly pointed at the
 * production path by mistake. Call this before any mutating operation
 * in a script that is meant to run only against a scratch database.
 */
function assertScratchDatabase(db) {
  const resolved = path.resolve(db.name);
  const production = productionDatabasePath();

  if (resolved === production) {
    throw new Error(
      `Refusing to run: this script would mutate the production database (${resolved}). ` +
        `Set PIM_DB_PATH to a scratch database file before running it.`
    );
  }
}

module.exports = {
  productionDatabasePath,
  assertScratchDatabase,
};
