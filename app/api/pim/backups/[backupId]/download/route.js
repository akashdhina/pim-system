/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const db = require("../../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  getBackup,
} = require("../../../../../../lib/pim-backup");

export async function GET(request, { params }) {
  try {
    const user = requirePermission(request, "DOWNLOAD_BACKUP");
    const { backupId } = await params;
    const { target, metadata } = getBackup(backupId);
    const file = fs.readFileSync(target.databasePath);

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
      "DOWNLOAD",
      JSON.stringify({ backup_id: backupId }),
      user.id,
      "SQLite backup downloaded."
    );

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename=\"pim-${metadata.id}.db\"`,
        "Content-Length": String(file.length),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Backup download error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to download backup.",
      },
      { status: error && error.status ? error.status : 500 }
    );
  }
}
