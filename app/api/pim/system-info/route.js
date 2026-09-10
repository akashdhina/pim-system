/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const packageJson = require("../../../../package.json");
const db = require("../../../../lib/db");
const {
  requireUser,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");
const {
  listBackups,
  SOURCE_DATABASE,
} = require("../../../../lib/pim-backup");

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;

  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
      } else if (entry.isFile()) {
        total += fs.statSync(next).size;
      }
    }
  }
  return total;
}

export async function GET(request) {
  try {
    const user = requireUser(request);
    const integrity = db.prepare("PRAGMA integrity_check").all();
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    const latestBackup = listBackups()[0] || null;
    const totalCases = db.prepare(`
      SELECT COUNT(*) AS total
      FROM pim_cases
    `).get().total;

    return Response.json({
      success: true,
      data: {
        applicationName: "DLSA Nilgiris PIM Case Management System",
        version: packageJson.version || null,
        buildDate:
          process.env.NEXT_PUBLIC_BUILD_DATE ||
          process.env.BUILD_DATE ||
          null,
        databaseReachable: true,
        sqliteIntegrity: integrity,
        foreignKeyIssues: foreignKeys.length,
        databaseFileSize: fs.existsSync(SOURCE_DATABASE)
          ? fs.statSync(SOURCE_DATABASE).size
          : 0,
        documentStorageSize: directorySize(
          path.join(process.cwd(), "storage")
        ),
        totalCases: totalCases || 0,
        latestBackup: latestBackup
          ? {
              id: latestBackup.id,
              created_at: latestBackup.created_at,
              status: latestBackup.status,
              integrity_result: latestBackup.integrity_result,
            }
          : null,
        currentUser: {
          id: user.id,
          username: user.username,
          display_name: user.display_name,
          designation: user.designation,
          role: user.role,
        },
        environment: process.env.NODE_ENV || "development",
        timezone: "Asia/Kolkata",
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load system information.",
      },
      { status: 500 }
    );
  }
}
