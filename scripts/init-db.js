const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const projectRoot = path.resolve(__dirname, "..");
const schemaPath = path.join(projectRoot, "database", "schema.sql");
const databasePath =
  process.env.PIM_DB_PATH ||
  path.join(projectRoot, "database", "pim.db");

if (!fs.existsSync(schemaPath)) {
  console.error("ERROR: schema.sql was not found.");
  console.error(schemaPath);
  process.exit(1);
}

console.log("Opening database:");
console.log(databasePath);

const db = new Database(databasePath);

try {
  db.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(schemaPath, "utf8");

  db.exec(schema);

  console.log("");
  console.log("PIM database created successfully.");

  const tables = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
       ORDER BY name`
    )
    .all();

  console.log("");
  console.log(`Tables created: ${tables.length}`);

  for (const table of tables) {
    console.log(`- ${table.name}`);
  }
} catch (error) {
  console.error("");
  console.error("DATABASE INITIALIZATION FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  db.close();
}