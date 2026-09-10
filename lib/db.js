const Database = require("better-sqlite3");
const path = require("path");

const databasePath =
  process.env.PIM_DB_PATH ||
  path.join(
    process.cwd(),
    "database",
    "pim.db"
  );

const isProductionPath =
  path.resolve(databasePath) ===
  path.resolve(path.join(process.cwd(), "database", "pim.db"));

if (process.env.PIM_DB_LOG !== "0") {
  console.log(
    `[pim-db] Using ${isProductionPath ? "PRODUCTION" : "non-production"} database: ${databasePath}`
  );
}

const db = new Database(databasePath);

db.pragma("foreign_keys = ON");

module.exports = db;