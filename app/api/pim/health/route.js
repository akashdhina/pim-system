/* eslint-disable @typescript-eslint/no-require-imports */

const packageJson = require("../../../../package.json");
const db = require("../../../../lib/db");

export async function GET() {
  let databaseReachable = false;

  try {
    db.prepare("SELECT 1 AS ok").get();
    databaseReachable = true;
  } catch {
    databaseReachable = false;
  }

  return Response.json({
    success: databaseReachable,
    status: databaseReachable ? "ok" : "database_unreachable",
    database: databaseReachable ? "reachable" : "unreachable",
    version: packageJson.version || null,
  }, {
    status: databaseReachable ? 200 : 503,
  });
}
