/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const {
  createBackup,
  getBackup,
  verifyBackup,
} = require("../lib/pim-backup");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const backupId = arg("--backup-id");
  const confirmed = process.argv.includes("--confirm-restore");

  if (!backupId || !confirmed) {
    throw new Error(
      "Usage: node scripts/restore-sqlite.js --backup-id <backup-id> --confirm-restore"
    );
  }

  const root = process.cwd();
  const activeDatabase = path.join(root, "database", "pim.db");
  const restoredCheck = verifyBackup(backupId);

  if (restoredCheck.status !== "SUCCESS") {
    throw new Error("Selected backup failed verification.");
  }

  const safety = await createBackup({
    createdBy: "pre-restore",
  });
  const rollbackPath = path.join(
    root,
    "database",
    `pim.db.before-restore-${Date.now()}`
  );

  fs.copyFileSync(activeDatabase, rollbackPath);

  const { target } = getBackup(backupId);
  fs.copyFileSync(target.databasePath, activeDatabase);

  const db = new Database(activeDatabase, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    const integrityOk = integrity.every((row) => Object.values(row)[0] === "ok");

    if (!integrityOk || foreignKeys.length) {
      fs.copyFileSync(rollbackPath, activeDatabase);
      throw new Error(
        "Restored database failed verification. Rollback copy was restored."
      );
    }
  } finally {
    db.close();
  }

  console.log("Restore complete.");
  console.log(`Restored backup ID: ${backupId}`);
  console.log(`Pre-restore backup ID: ${safety.id}`);
  console.log(`Rollback copy: ${rollbackPath}`);
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Restore failed."
  );
  process.exitCode = 1;
});
