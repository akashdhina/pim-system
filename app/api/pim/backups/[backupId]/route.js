/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  deleteBackup,
  verifyBackup,
} = require("../../../../../lib/pim-backup");

function audit(action, backupId, userId, reason) {
  db.prepare(`
    INSERT INTO audit_log (
      table_name,
      record_id,
      action,
      old_value,
      changed_by,
      reason
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "sqlite_backups",
    0,
    action,
    JSON.stringify({ backup_id: backupId }),
    userId || null,
    reason
  );
}

export async function GET(request, { params }) {
  try {
    requirePermission(request, "VIEW_BACKUP");

    const { backupId } = await params;
    const verified = verifyBackup(backupId);

    return Response.json({
      success: true,
      data: {
        backup: verified,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Backup detail GET error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load backup.",
      },
      { status: error && error.status ? error.status : 500 }
    );
  }
}

export async function DELETE(request, { params }) {
  try {
    const user = requirePermission(request, "DELETE_BACKUP");
    const { backupId } = await params;
    const result = deleteBackup(backupId);

    audit(
      "DELETE",
      backupId,
      user.id,
      "SQLite backup deleted from Backup & Recovery page."
    );

    return Response.json({
      success: true,
      message: "Backup deleted successfully.",
      data: result,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Backup DELETE error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to delete backup.",
      },
      { status: error && error.status ? error.status : 500 }
    );
  }
}
