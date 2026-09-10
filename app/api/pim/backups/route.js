/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../lib/db");
const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");
const {
  createBackup,
  databaseStatus,
  enforceRetention,
  listBackups,
} = require("../../../../lib/pim-backup");

function audit(action, backupId, userId, reason) {
  db.prepare(`
    INSERT INTO audit_log (
      table_name,
      record_id,
      action,
      new_value,
      changed_by,
      reason
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "sqlite_backups",
    0,
    action,
    backupId ? JSON.stringify({ backup_id: backupId }) : null,
    userId || null,
    reason
  );
}

export async function GET(request) {
  try {
    requirePermission(request, "VIEW_BACKUP");
    const backups = listBackups();

    return Response.json({
      success: true,
      data: {
        backups,
        latest: backups[0] || null,
        database: databaseStatus(),
        retention: enforceRetention(),
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Backups GET error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load backups.",
      },
      { status: error && error.status ? error.status : 500 }
    );
  }
}

export async function POST(request) {
  try {
    const user = requirePermission(request, "CREATE_BACKUP");
    const backup = await createBackup({ createdBy: user.id });
    const retention = enforceRetention();

    audit(
      "INSERT",
      backup.id,
      user.id,
      "SQLite backup created from Backup & Recovery page."
    );

    return Response.json(
      {
        success: true,
        message: "Backup created and verified successfully.",
        data: {
          backup,
          retention,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Backups POST error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to create backup.",
        data: error && error.metadata ? error.metadata : null,
      },
      { status: error && error.status ? error.status : 500 }
    );
  }
}
